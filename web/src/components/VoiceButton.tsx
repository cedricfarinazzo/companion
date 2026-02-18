/**
 * VoiceButton — push-to-talk microphone button for the Composer.
 *
 * States
 * ------
 * idle        — microphone icon, click to start recording
 * requesting  — waiting for microphone permission
 * recording   — pulsing red indicator, click again to stop
 * transcribing — spinner while the server transcribes
 * error       — brief error message, then resets to idle
 *
 * The component records audio via the MediaRecorder API, encodes it to
 * WAV client-side (see utils/wav-encoder.ts), POSTs to POST /api/transcribe,
 * and calls `onTranscript` with the returned text.
 *
 * Hidden entirely when `navigator.mediaDevices` is unavailable (e.g. non-HTTPS
 * or old browsers).
 */

import { useState, useRef, useEffect, useCallback } from "react";
import { encodeToWav } from "../utils/wav-encoder.js";

type VoiceState = "idle" | "requesting" | "recording" | "transcribing" | "error";

interface VoiceButtonProps {
  /** Called with the transcribed text when a transcription succeeds. */
  onTranscript: (text: string) => void;
  /** Disable the button (e.g. when the session is not connected). */
  disabled?: boolean;
}

/** How long (ms) to show the error state before resetting to idle. */
const ERROR_RESET_MS = 3_000;

/** How long (ms) to wait before retrying after a 503 (model loading). */
const LOADING_RETRY_MS = 2_000;

/** Maximum number of 503 retries before giving up. */
const MAX_LOADING_RETRIES = 10;

export function VoiceButton({ onTranscript, disabled = false }: VoiceButtonProps) {
  const [state, setState] = useState<VoiceState>("idle");
  const [errorMsg, setErrorMsg] = useState<string>("");
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Check for MediaDevices availability
  const hasMicSupport =
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices !== "undefined" &&
    typeof navigator.mediaDevices.getUserMedia === "function";

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
      stopRecording();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const showError = useCallback((msg: string) => {
    setState("error");
    setErrorMsg(msg);
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    errorTimerRef.current = setTimeout(() => {
      setState("idle");
      setErrorMsg("");
    }, ERROR_RESET_MS);
  }, []);

  function stopRecording() {
    const mr = mediaRecorderRef.current;
    if (mr && mr.state !== "inactive") {
      mr.stop();
    }
    mediaRecorderRef.current = null;
  }

  async function sendForTranscription(audioBlob: Blob, retriesLeft = MAX_LOADING_RETRIES): Promise<void> {
    setState("transcribing");

    let wavBlob: Blob;
    try {
      wavBlob = await encodeToWav(audioBlob);
    } catch {
      showError("Failed to encode audio");
      return;
    }

    const formData = new FormData();
    formData.append("audio", wavBlob, "audio.wav");

    let res: Response;
    try {
      res = await fetch("/api/transcribe", { method: "POST", body: formData });
    } catch {
      showError("Network error");
      return;
    }

    if (res.status === 503) {
      // Model still loading
      const data = await res.json().catch(() => ({})) as { status?: string };
      if (data.status === "loading" && retriesLeft > 0) {
        setState("transcribing"); // keep spinner, show "Model loading…" via label
        setErrorMsg("Model loading…");
        await delay(LOADING_RETRY_MS);
        setErrorMsg("");
        return sendForTranscription(audioBlob, retriesLeft - 1);
      }
      showError("Model not ready, please try again");
      return;
    }

    if (!res.ok) {
      const data = await res.json().catch(() => ({})) as { error?: string };
      showError(data.error || "Transcription failed");
      return;
    }

    const data = await res.json() as { text?: string };
    const text = (data.text ?? "").trim();
    if (!text) {
      showError("No speech detected");
      return;
    }

    setState("idle");
    onTranscript(text);
  }

  async function startRecording() {
    if (disabled || !hasMicSupport) return;
    setState("requesting");
    chunksRef.current = [];

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      const msg =
        err instanceof Error && err.name === "NotAllowedError"
          ? "Microphone access denied. Please allow microphone in browser settings."
          : "Could not access microphone";
      showError(msg);
      return;
    }

    const mr = new MediaRecorder(stream);
    mediaRecorderRef.current = mr;

    mr.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };

    mr.onstop = async () => {
      // Stop all microphone tracks to release the hardware indicator
      for (const track of stream.getTracks()) track.stop();

      const audioBlob = new Blob(chunksRef.current, { type: mr.mimeType || "audio/webm" });
      chunksRef.current = [];

      if (audioBlob.size < 1000) {
        showError("Recording too short");
        return;
      }

      await sendForTranscription(audioBlob);
    };

    mr.start();
    setState("recording");
  }

  function handleClick() {
    if (disabled) return;
    if (state === "recording") {
      stopRecording();
      return;
    }
    if (state === "idle") {
      startRecording();
    }
  }

  // Don't render at all if MediaDevices API is not available
  if (!hasMicSupport) {
    return null;
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled || state === "requesting" || state === "transcribing"}
      title={getTitle(state, errorMsg)}
      aria-label={getTitle(state, errorMsg)}
      className={getButtonClass(state, disabled)}
    >
      <ButtonContent state={state} />
    </button>
  );
}

function getTitle(state: VoiceState, errorMsg: string): string {
  switch (state) {
    case "idle": return "Start voice input";
    case "requesting": return "Requesting microphone access…";
    case "recording": return "Recording — click to stop";
    case "transcribing": return errorMsg || "Transcribing…";
    case "error": return errorMsg;
  }
}

function getButtonClass(state: VoiceState, disabled: boolean): string {
  const base = "flex items-center justify-center w-8 h-8 rounded-lg transition-colors";
  if (disabled) return `${base} text-cc-muted opacity-30 cursor-not-allowed`;
  switch (state) {
    case "idle":
    case "requesting":
      return `${base} text-cc-muted hover:text-cc-fg hover:bg-cc-hover cursor-pointer`;
    case "recording":
      return `${base} text-red-500 bg-red-500/10 hover:bg-red-500/20 cursor-pointer`;
    case "transcribing":
      return `${base} text-cc-muted opacity-70 cursor-not-allowed`;
    case "error":
      return `${base} text-cc-error bg-cc-error/10 cursor-pointer`;
  }
}

function ButtonContent({ state }: { state: VoiceState }) {
  switch (state) {
    case "recording":
      return (
        // Pulsing red dot while recording
        <span className="relative flex items-center justify-center">
          <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" />
        </span>
      );
    case "transcribing":
      return (
        // Spinner while transcribing
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className="w-4 h-4 animate-spin"
        >
          <circle cx="8" cy="8" r="6" strokeDasharray="28 10" />
        </svg>
      );
    case "error":
      return (
        // X icon for error state
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
          <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
        </svg>
      );
    default:
      return (
        // Microphone icon (idle / requesting)
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4">
          <rect x="5" y="1" width="6" height="9" rx="3" />
          <path d="M2 8a6 6 0 0 0 12 0" strokeLinecap="round" />
          <line x1="8" y1="14" x2="8" y2="11" strokeLinecap="round" />
          <line x1="5.5" y1="14" x2="10.5" y2="14" strokeLinecap="round" />
        </svg>
      );
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
