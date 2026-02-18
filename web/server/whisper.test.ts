/**
 * Tests for the server-side Whisper transcription module.
 *
 * The nodejs-whisper package is mocked so the tests run without any
 * native binaries or model files.  We validate state machine transitions,
 * error handling, WAV file I/O, and the transcribeAudio helper.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// ─── Mocks ───────────────────────────────────────────────────────────────────

// Mock node:fs/promises used by the whisper module
vi.mock("node:fs/promises", () => ({
  writeFile: vi.fn(async () => {}),
  readFile: vi.fn(async () => "Hello world"),
  unlink: vi.fn(async () => {}),
  mkdir: vi.fn(async () => {}),
}));

// Mock node:fs (existsSync used for txt file check)
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(() => true),
  };
});

// Mock nodejs-whisper — the package that wraps whisper.cpp
const mockNodewhisper = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("nodejs-whisper", () => ({
  nodewhisper: mockNodewhisper,
}));

// ─── Module under test ───────────────────────────────────────────────────────

import { getWhisperStatus, initWhisper, transcribeAudio } from "./whisper.js";
import { writeFile, readFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Reset module-level state between tests by re-importing the module. */
async function freshModule() {
  vi.resetModules();
  const mod = await import("./whisper.js");
  return mod;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("getWhisperStatus", () => {
  it("starts as 'idle' before any call", async () => {
    const { getWhisperStatus: getStatus } = await freshModule();
    expect(getStatus()).toBe("idle");
  });
});

describe("initWhisper", () => {
  it("transitions from idle → loading → ready on success", async () => {
    const { getWhisperStatus: getStatus, initWhisper: init } = await freshModule();
    expect(getStatus()).toBe("idle");
    const promise = init();
    // Status should be loading immediately
    expect(getStatus()).toBe("loading");
    await promise;
    expect(getStatus()).toBe("ready");
  });

  it("returns the same promise on concurrent calls", async () => {
    const { initWhisper: init } = await freshModule();
    const p1 = init();
    const p2 = init();
    expect(p1).toBe(p2);
    await p1;
  });

  it("sets status to 'unavailable' when nodejs-whisper cannot be imported", async () => {
    // Re-mock nodejs-whisper to simulate a missing package
    vi.doMock("nodejs-whisper", () => {
      throw new Error("Cannot find module 'nodejs-whisper'");
    });
    const { getWhisperStatus: getStatus, initWhisper: init } = await freshModule();
    await expect(init()).rejects.toThrow();
    expect(getStatus()).toBe("unavailable");
    vi.doUnmock("nodejs-whisper");
  });

  it("is idempotent once the model is ready", async () => {
    const { getWhisperStatus: getStatus, initWhisper: init } = await freshModule();
    await init();
    expect(getStatus()).toBe("ready");
    // Second call should resolve immediately and not change status
    await init();
    expect(getStatus()).toBe("ready");
  });
});

describe("transcribeAudio", () => {
  it("throws MODEL_LOADING when status is 'idle'", async () => {
    const { transcribeAudio: transcribe } = await freshModule();
    const err = await transcribe(Buffer.from("wav")).catch((e) => e);
    expect(err.code).toBe("MODEL_LOADING");
  });

  it("throws MODEL_LOADING when status is 'loading'", async () => {
    const { initWhisper: init, transcribeAudio: transcribe } = await freshModule();
    // Start init but don't await — keeps status as 'loading'
    const initPromise = init();
    const err = await transcribe(Buffer.from("wav")).catch((e) => e);
    expect(err.code).toBe("MODEL_LOADING");
    await initPromise; // clean up
  });

  it("throws UNAVAILABLE when status is 'unavailable'", async () => {
    vi.doMock("nodejs-whisper", () => {
      throw new Error("Cannot find module 'nodejs-whisper'");
    });
    const { initWhisper: init, transcribeAudio: transcribe } = await freshModule();
    await expect(init()).rejects.toThrow();
    vi.doMock("nodejs-whisper", () => ({ nodewhisper: mockNodewhisper }));
    const err = await transcribe(Buffer.from("wav")).catch((e) => e);
    expect(err.code).toBe("UNAVAILABLE");
    vi.doUnmock("nodejs-whisper");
  });

  it("writes audio buffer to a temp file, calls nodewhisper, reads .txt output", async () => {
    vi.mocked(readFile).mockResolvedValueOnce("Transcribed text" as never);
    vi.mocked(existsSync).mockReturnValue(true);

    const { initWhisper: init, transcribeAudio: transcribe } = await freshModule();
    await init();

    const result = await transcribe(Buffer.from([0, 1, 2, 3]));

    // writeFile should have been called with the audio buffer
    expect(vi.mocked(writeFile)).toHaveBeenCalledWith(
      expect.stringContaining("companion-audio-"),
      expect.any(Buffer),
    );
    // The returned text should come from the .txt file
    expect(result.text).toBe("Transcribed text");
    expect(typeof result.duration_ms).toBe("number");
  });

  it("returns empty text if .txt file does not exist", async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const { initWhisper: init, transcribeAudio: transcribe } = await freshModule();
    await init();

    const result = await transcribe(Buffer.from([0, 1, 2]));
    expect(result.text).toBe("");
  });

  it("cleans up temp file even if nodewhisper throws", async () => {
    mockNodewhisper.mockRejectedValueOnce(new Error("whisper failed"));
    vi.mocked(existsSync).mockReturnValue(false);

    const { initWhisper: init, transcribeAudio: transcribe } = await freshModule();
    await init();

    await expect(transcribe(Buffer.from([0, 1, 2]))).rejects.toThrow("whisper failed");
    // unlink should have been called to clean up
    expect(vi.mocked(unlink)).toHaveBeenCalled();
  });
});

describe("buildSilentWav (via initWhisper side-effect)", () => {
  it("initWhisper writes a valid WAV to a temp path", async () => {
    const { initWhisper: init } = await freshModule();
    await init();
    // The init call should have written a WAV file
    const calls = vi.mocked(writeFile).mock.calls;
    const wavCall = calls.find(([path]) => String(path).includes("companion-whisper-init"));
    expect(wavCall).toBeDefined();
    const wavBuffer = wavCall![1] as Buffer;
    // Check RIFF header magic bytes
    expect(wavBuffer.slice(0, 4).toString("ascii")).toBe("RIFF");
    expect(wavBuffer.slice(8, 12).toString("ascii")).toBe("WAVE");
  });
});
