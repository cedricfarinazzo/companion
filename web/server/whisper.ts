/**
 * Server-side Whisper transcription module.
 *
 * Wraps nodejs-whisper (whisper.cpp binding) for fully offline, CPU-only
 * speech-to-text.  The Whisper model is downloaded once on first use and
 * cached in ~/.companion/whisper/.
 *
 * Environment variables
 * ---------------------
 * WHISPER_MODEL  – model size to use (default: "base.en")
 *                  Supported: tiny, tiny.en, base, base.en, small, small.en,
 *                             medium, medium.en, large-v1, large, large-v3-turbo
 */

import { writeFile, readFile, unlink, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";

// ─── Constants ───────────────────────────────────────────────────────────────

const SUPPORTED_MODELS = [
  "tiny",
  "tiny.en",
  "base",
  "base.en",
  "small",
  "small.en",
  "medium",
  "medium.en",
  "large-v1",
  "large",
  "large-v3-turbo",
] as const;

type WhisperModel = (typeof SUPPORTED_MODELS)[number];

function resolveModel(): WhisperModel {
  const env = process.env.WHISPER_MODEL;
  if (env && (SUPPORTED_MODELS as readonly string[]).includes(env)) {
    return env as WhisperModel;
  }
  if (env) {
    console.warn(`[whisper] Unknown model "${env}", falling back to "base.en"`);
  }
  return "base.en";
}

// ─── State ────────────────────────────────────────────────────────────────────

export type WhisperStatus = "idle" | "loading" | "ready" | "unavailable";

let _status: WhisperStatus = "idle";
let _loadingPromise: Promise<void> | null = null;

export function getWhisperStatus(): WhisperStatus {
  return _status;
}

// ─── Model initialisation ─────────────────────────────────────────────────────

/**
 * Lazily import nodejs-whisper and trigger the model download so that the
 * first real transcription request is as fast as possible.
 *
 * This function is idempotent — calling it multiple times while a download is
 * in progress simply returns the same promise.
 */
export function initWhisper(): Promise<void> {
  if (_status === "ready") return Promise.resolve();
  if (_loadingPromise) return _loadingPromise;

  _status = "loading";
  _loadingPromise = (async () => {
    const model = resolveModel();
    console.log(`[whisper] Initialising model "${model}"…`);

    // Ensure the companion whisper cache directory exists so that the
    // nodewhisper module can write the downloaded model there when the
    // WHISPER_MODELS_DIR env var is set by the caller.
    const cacheDir = join(homedir(), ".companion", "whisper");
    if (!existsSync(cacheDir)) {
      await mkdir(cacheDir, { recursive: true });
    }

    // Dynamic import so the server still starts even if nodejs-whisper is not
    // yet installed (the endpoint will return 503 in that case).
    let nodewhisper: (filePath: string, opts: WhisperCallOptions) => Promise<unknown>;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = (await import("nodejs-whisper" as string)) as any;
      nodewhisper = mod.nodewhisper ?? mod.default?.nodewhisper ?? mod.default;
      if (typeof nodewhisper !== "function") throw new Error("nodewhisper export not found");
    } catch (err) {
      console.error("[whisper] nodejs-whisper is not available:", (err as Error).message);
      console.error("[whisper] Run: bun add nodejs-whisper  (in the web/ directory)");
      _status = "unavailable";
      _loadingPromise = null;
      throw err;
    }

    // Perform a zero-second silent WAV transcription to trigger the model
    // download before the first real request arrives.
    const silentWav = buildSilentWav(0.1);
    const tmpPath = join(tmpdir(), `companion-whisper-init-${Date.now()}.wav`);
    try {
      await writeFile(tmpPath, silentWav);
      await nodewhisper(tmpPath, {
        modelName: model,
        autoDownloadModelName: model,
        removeWavFileAfterTranscription: true,
        withCuda: false,
        logger: {
          log: (...args: unknown[]) => console.log("[whisper]", ...args),
          warn: (...args: unknown[]) => console.warn("[whisper]", ...args),
          error: (...args: unknown[]) => console.error("[whisper]", ...args),
        },
        whisperOptions: {
          outputInText: false,
          outputInSrt: false,
          outputInJson: false,
          outputInVtt: false,
          outputInCsv: false,
        },
      });
    } catch {
      // Silence errors from the tiny init clip — the download still succeeds.
    } finally {
      try { await unlink(tmpPath); } catch { /* ignore */ }
      // Clean up any leftover side-car files
      for (const ext of [".txt", ".srt", ".vtt", ".json", ".csv"]) {
        try { await unlink(tmpPath + ext); } catch { /* ignore */ }
      }
    }

    _status = "ready";
    console.log(`[whisper] Model "${model}" ready.`);
  })().catch((err) => {
    if (_status !== "unavailable") _status = "idle"; // allow retry
    _loadingPromise = null;
    throw err;
  });

  return _loadingPromise;
}

// ─── Transcription ────────────────────────────────────────────────────────────

export interface TranscribeResult {
  text: string;
  duration_ms: number;
}

/**
 * Transcribe a WAV audio buffer.
 *
 * @throws If the model is still loading, throws an Error with
 *         `.code === "MODEL_LOADING"`.
 * @throws If nodejs-whisper is not installed, throws an Error with
 *         `.code === "UNAVAILABLE"`.
 */
export async function transcribeAudio(audioBuffer: Buffer): Promise<TranscribeResult> {
  if (_status === "loading") {
    const err = new Error("Whisper model is still loading") as Error & { code: string };
    err.code = "MODEL_LOADING";
    throw err;
  }
  if (_status === "unavailable") {
    const err = new Error("nodejs-whisper is not installed") as Error & { code: string };
    err.code = "UNAVAILABLE";
    throw err;
  }
  if (_status === "idle") {
    // Trigger init; subsequent check will wait for it or return immediately
    initWhisper().catch(() => { /* error already logged */ });
    const err = new Error("Whisper model is still loading") as Error & { code: string };
    err.code = "MODEL_LOADING";
    throw err;
  }

  const model = resolveModel();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod = (await import("nodejs-whisper" as string)) as any;
  const nodewhisper: (filePath: string, opts: WhisperCallOptions) => Promise<unknown> =
    mod.nodewhisper ?? mod.default?.nodewhisper ?? mod.default;

  const tmpPath = join(tmpdir(), `companion-audio-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
  await writeFile(tmpPath, audioBuffer);

  const start = Date.now();
  try {
    await nodewhisper(tmpPath, {
      modelName: model,
      autoDownloadModelName: model,
      removeWavFileAfterTranscription: false,
      withCuda: false,
      whisperOptions: {
        outputInText: true,
        outputInSrt: false,
        outputInJson: false,
        outputInVtt: false,
        outputInCsv: false,
        splitOnWord: true,
      },
    });

    // Read the text output file produced by whisper.cpp
    const txtPath = `${tmpPath}.txt`;
    let text = "";
    if (existsSync(txtPath)) {
      text = (await readFile(txtPath, "utf-8")).trim();
      await unlink(txtPath).catch(() => { /* ignore */ });
    }
    return { text, duration_ms: Date.now() - start };
  } finally {
    await unlink(tmpPath).catch(() => { /* ignore */ });
    // Clean up any other side-car files
    for (const ext of [".srt", ".vtt", ".json", ".csv"]) {
      await unlink(tmpPath + ext).catch(() => { /* ignore */ });
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface WhisperCallOptions {
  modelName: string;
  autoDownloadModelName?: string;
  removeWavFileAfterTranscription?: boolean;
  withCuda?: boolean;
  logger?: { log: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
  whisperOptions?: {
    outputInText?: boolean;
    outputInSrt?: boolean;
    outputInJson?: boolean;
    outputInVtt?: boolean;
    outputInCsv?: boolean;
    splitOnWord?: boolean;
    wordTimestamps?: boolean;
    translateToEnglish?: boolean;
    timestamps_length?: number;
  };
}

/** Generate a minimal silent WAV buffer (PCM 16-bit, 16 kHz, mono). */
function buildSilentWav(durationSeconds: number): Buffer {
  const sampleRate = 16_000;
  const numSamples = Math.round(sampleRate * durationSeconds);
  const dataSize = numSamples * 2; // 16-bit = 2 bytes per sample
  const buf = Buffer.alloc(44 + dataSize, 0);
  // RIFF header
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  // fmt chunk
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);        // chunk size
  buf.writeUInt16LE(1, 20);         // PCM
  buf.writeUInt16LE(1, 22);         // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32);         // block align
  buf.writeUInt16LE(16, 34);        // bits per sample
  // data chunk
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  // samples are already zeroed (silence)
  return buf;
}
