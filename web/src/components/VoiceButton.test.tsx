// @vitest-environment jsdom
/**
 * Tests for the VoiceButton component.
 *
 * Because MediaRecorder and AudioContext are not available in jsdom, all
 * browser APIs are mocked.  We validate:
 *  - the button renders (mic icon) when navigator.mediaDevices is available
 *  - the button is hidden when navigator.mediaDevices is unavailable
 *  - clicking starts/stops recording (state transitions via aria-label)
 *  - a successful transcription calls onTranscript with the text
 *  - a 503 "loading" response shows "Model loading…" and eventually errors
 *  - microphone denial shows an error message
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { VoiceButton } from "./VoiceButton.js";

// ─── Browser API mocks ────────────────────────────────────────────────────────

// Minimal MediaRecorder mock
class MockMediaRecorder {
  state = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;

  start() {
    this.state = "recording";
    // Simulate data available after start
    setTimeout(() => {
      this.ondataavailable?.({ data: new Blob(["audio-data"], { type: "audio/webm" }) });
    }, 10);
  }

  stop() {
    this.state = "inactive";
    setTimeout(() => this.onstop?.(), 10);
  }
}

// Minimal AudioBuffer mock
class MockAudioBuffer {
  length = 16000;
  sampleRate = 16000;
  numberOfChannels = 1;
  getChannelData() {
    return new Float32Array(this.length);
  }
}

// Minimal AudioContext mock
class MockAudioContext {
  decodeAudioData(_buf: ArrayBuffer): Promise<MockAudioBuffer> {
    return Promise.resolve(new MockAudioBuffer());
  }
  close() {}
}

let mockFetch: ReturnType<typeof vi.fn>;
let mockGetUserMedia: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // Default: MediaDevices available
  mockGetUserMedia = vi.fn().mockResolvedValue({
    getTracks: () => [{ stop: vi.fn() }],
  });

  Object.defineProperty(globalThis, "navigator", {
    value: {
      mediaDevices: {
        getUserMedia: mockGetUserMedia,
      },
    },
    writable: true,
    configurable: true,
  });

  // Stub MediaRecorder
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).MediaRecorder = MockMediaRecorder;
  // Stub AudioContext
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).AudioContext = MockAudioContext;

  // Default fetch returns a successful transcription
  mockFetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ text: "Hello world" }),
  });
  globalThis.fetch = mockFetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("VoiceButton", () => {
  describe("rendering", () => {
    it("renders the mic button when mediaDevices is available", () => {
      render(<VoiceButton onTranscript={vi.fn()} />);
      expect(screen.getByRole("button", { name: /start voice input/i })).toBeInTheDocument();
    });

    it("does not render when navigator.mediaDevices is unavailable", () => {
      Object.defineProperty(globalThis, "navigator", {
        value: { mediaDevices: undefined },
        writable: true,
        configurable: true,
      });
      const { container } = render(<VoiceButton onTranscript={vi.fn()} />);
      expect(container.firstChild).toBeNull();
    });

    it("renders as disabled when disabled prop is true", () => {
      render(<VoiceButton onTranscript={vi.fn()} disabled />);
      expect(screen.getByRole("button")).toBeDisabled();
    });
  });

  describe("recording flow", () => {
    it("transitions to recording state when clicked", async () => {
      render(<VoiceButton onTranscript={vi.fn()} />);
      const btn = screen.getByRole("button");

      await act(async () => {
        fireEvent.click(btn);
      });

      // After getUserMedia resolves, the button should be in recording state
      await waitFor(() => {
        expect(screen.getByRole("button")).toHaveAttribute(
          "aria-label",
          expect.stringMatching(/recording/i),
        );
      });
    });

    it("calls getUserMedia on click", async () => {
      render(<VoiceButton onTranscript={vi.fn()} />);
      await act(async () => {
        fireEvent.click(screen.getByRole("button"));
      });
      await waitFor(() => expect(mockGetUserMedia).toHaveBeenCalled());
    });

    it("calls onTranscript with text on successful transcription", async () => {
      const onTranscript = vi.fn();
      render(<VoiceButton onTranscript={onTranscript} />);
      const btn = screen.getByRole("button");

      // Start recording
      await act(async () => {
        fireEvent.click(btn);
      });

      // Wait for recording state
      await waitFor(() =>
        expect(btn).toHaveAttribute("aria-label", expect.stringMatching(/recording/i)),
      );

      // Stop recording
      await act(async () => {
        fireEvent.click(btn);
      });

      // Wait for transcription to complete
      await waitFor(() => expect(onTranscript).toHaveBeenCalledWith("Hello world"), {
        timeout: 2000,
      });
    });
  });

  describe("error handling", () => {
    it("shows error state when getUserMedia is denied", async () => {
      mockGetUserMedia.mockRejectedValueOnce(
        Object.assign(new Error("Permission denied"), { name: "NotAllowedError" }),
      );

      render(<VoiceButton onTranscript={vi.fn()} />);
      await act(async () => {
        fireEvent.click(screen.getByRole("button"));
      });

      await waitFor(() => {
        const btn = screen.getByRole("button");
        expect(btn).toHaveAttribute("aria-label", expect.stringMatching(/microphone access denied/i));
      });
    });

    it("shows error state when transcription request fails", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ error: "Transcription failed" }),
      });

      render(<VoiceButton onTranscript={vi.fn()} />);
      const btn = screen.getByRole("button");

      await act(async () => { fireEvent.click(btn); });
      await waitFor(() =>
        expect(btn).toHaveAttribute("aria-label", expect.stringMatching(/recording/i)),
      );
      await act(async () => { fireEvent.click(btn); });

      await waitFor(() => {
        expect(screen.getByRole("button")).toHaveAttribute(
          "aria-label",
          expect.stringMatching(/transcription failed/i),
        );
      }, { timeout: 2000 });
    });

    it("retries on 503 model-loading response", async () => {
      const onTranscript = vi.fn();
      // First fetch returns 503 loading, second returns success
      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          json: async () => ({ status: "loading" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ text: "Retried OK" }),
        });

      vi.useFakeTimers({ shouldAdvanceTime: true });

      render(<VoiceButton onTranscript={onTranscript} />);
      const btn = screen.getByRole("button");

      await act(async () => { fireEvent.click(btn); });
      await waitFor(() =>
        expect(btn).toHaveAttribute("aria-label", expect.stringMatching(/recording/i)),
      );
      await act(async () => { fireEvent.click(btn); });

      // Advance past the retry delay
      await act(async () => {
        vi.advanceTimersByTime(3000);
        await Promise.resolve();
      });

      await waitFor(() => expect(onTranscript).toHaveBeenCalledWith("Retried OK"), {
        timeout: 5000,
      });

      vi.useRealTimers();
    });
  });

  describe("accessibility", () => {
    it("has type=button to avoid form submission", () => {
      render(<VoiceButton onTranscript={vi.fn()} />);
      expect(screen.getByRole("button")).toHaveAttribute("type", "button");
    });
  });
});
