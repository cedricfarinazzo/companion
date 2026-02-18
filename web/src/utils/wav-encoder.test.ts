// @vitest-environment jsdom
/**
 * Tests for the WAV encoder utility.
 *
 * Validates that:
 * - the returned Blob has the correct MIME type
 * - the WAV header is well-formed (RIFF, WAVE, fmt , data markers present)
 * - resampling works correctly (different input sample rates → 16 kHz output)
 * - multichannel audio is mixed down to mono
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── AudioContext mock ────────────────────────────────────────────────────────

const mockGetChannelData = vi.fn();
const mockClose = vi.fn();

class MockAudioBuffer {
  constructor(
    public length: number,
    public sampleRate: number,
    public numberOfChannels: number,
    private channelData: Float32Array,
  ) {}

  getChannelData(_ch: number): Float32Array {
    mockGetChannelData(_ch);
    return this.channelData;
  }
}

class MockAudioContext {
  decodeAudioData(_buf: ArrayBuffer, ...args: unknown[]): Promise<MockAudioBuffer> {
    // Simulate 100ms of silence at 44100 Hz, mono
    const samples = new Float32Array(4410);
    return Promise.resolve(new MockAudioBuffer(4410, 44100, 1, samples));
  }
  close() {
    mockClose();
  }
}

// Install before importing the module under test
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).AudioContext = MockAudioContext;

// ─── Module under test ────────────────────────────────────────────────────────

import { encodeToWav } from "../utils/wav-encoder.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function readLittleEndianUint32(buffer: ArrayBuffer, offset: number): number {
  const view = new DataView(buffer);
  return view.getUint32(offset, true);
}

function readLittleEndianUint16(buffer: ArrayBuffer, offset: number): number {
  const view = new DataView(buffer);
  return view.getUint16(offset, true);
}

function readChars(buffer: ArrayBuffer, offset: number, length: number): string {
  const bytes = new Uint8Array(buffer, offset, length);
  return String.fromCharCode(...Array.from(bytes));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("encodeToWav", () => {
  it("returns a Blob with type audio/wav", async () => {
    const input = new Blob(["fake-webm-data"], { type: "audio/webm" });
    const result = await encodeToWav(input);
    expect(result).toBeInstanceOf(Blob);
    expect(result.type).toBe("audio/wav");
  });

  it("produces a valid WAV file with correct header markers", async () => {
    const input = new Blob(["fake-webm-data"], { type: "audio/webm" });
    const result = await encodeToWav(input);
    const buffer = await result.arrayBuffer();

    // RIFF chunk descriptor
    expect(readChars(buffer, 0, 4)).toBe("RIFF");
    expect(readChars(buffer, 8, 4)).toBe("WAVE");
    // fmt sub-chunk
    expect(readChars(buffer, 12, 4)).toBe("fmt ");
    expect(readLittleEndianUint32(buffer, 16)).toBe(16); // PCM fmt size
    expect(readLittleEndianUint16(buffer, 20)).toBe(1);  // PCM format
    expect(readLittleEndianUint16(buffer, 22)).toBe(1);  // mono
    expect(readLittleEndianUint32(buffer, 24)).toBe(16000); // 16 kHz
    expect(readLittleEndianUint16(buffer, 34)).toBe(16); // 16-bit
    // data sub-chunk
    expect(readChars(buffer, 36, 4)).toBe("data");
  });

  it("outputs the correct sample count for resampled audio (44100 → 16000 Hz)", async () => {
    const input = new Blob(["fake-webm-data"], { type: "audio/webm" });
    const result = await encodeToWav(input);
    const buffer = await result.arrayBuffer();

    // Input: 4410 samples at 44100 Hz = 0.1 s
    // Expected output: 0.1 * 16000 = 1600 samples at 16 kHz → 3200 bytes PCM data
    const dataSize = readLittleEndianUint32(buffer, 40);
    expect(dataSize).toBe(1600 * 2); // 16-bit mono
    // Total file size = 44 (header) + dataSize
    expect(buffer.byteLength).toBe(44 + dataSize);
  });

  it("closes the AudioContext after use", async () => {
    const input = new Blob(["fake-webm-data"], { type: "audio/webm" });
    await encodeToWav(input);
    expect(mockClose).toHaveBeenCalled();
  });

  it("handles stereo input by mixing down to mono", async () => {
    // Override AudioContext to return 2-channel audio
    const leftChannel = new Float32Array([0.5, 0.5, 0.5]);
    const rightChannel = new Float32Array([0.5, -0.5, 0.5]);

    class StereoAudioContext {
      decodeAudioData(): Promise<MockAudioBuffer> {
        const buf = {
          length: 3,
          sampleRate: 16000,
          numberOfChannels: 2,
          getChannelData(ch: number) {
            return ch === 0 ? leftChannel : rightChannel;
          },
        } as unknown as MockAudioBuffer;
        return Promise.resolve(buf);
      }
      close() {}
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).AudioContext = StereoAudioContext;

    const input = new Blob(["fake"], { type: "audio/webm" });
    const result = await encodeToWav(input);
    const buffer = await result.arrayBuffer();
    const view = new DataView(buffer);

    // Expected mono sample at index 0: (0.5 + 0.5) / 2 = 0.5 → ~16383 as Int16
    const firstSample = view.getInt16(44, true);
    expect(firstSample).toBeCloseTo(0.5 * 32767, -2); // within ±100

    // Expected mono sample at index 1: (0.5 + (-0.5)) / 2 = 0 → 0 as Int16
    const secondSample = view.getInt16(46, true);
    expect(secondSample).toBe(0);

    // Restore
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).AudioContext = MockAudioContext;
  });
});
