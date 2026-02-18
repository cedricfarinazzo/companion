/**
 * Client-side WAV encoder.
 *
 * Encodes a Float32Array of PCM samples (any sample rate) to a 16-bit
 * mono WAV blob at 16 kHz — the format expected by Whisper.
 *
 * No external dependencies; uses only standard Web APIs.
 */

const TARGET_SAMPLE_RATE = 16_000;

/**
 * Resample a Float32Array from `fromRate` to `toRate` using linear
 * interpolation.  Returns a new Float32Array.
 */
function resample(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return samples;
  const ratio = fromRate / toRate;
  const outputLength = Math.round(samples.length / ratio);
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = samples[idx] ?? 0;
    const b = samples[idx + 1] ?? samples[idx] ?? 0;
    output[i] = a + frac * (b - a);
  }
  return output;
}

/**
 * Convert Float32 PCM in the range [-1, 1] to Int16 PCM.
 */
function float32ToInt16(samples: Float32Array): Int16Array {
  const output = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    output[i] = Math.round(clamped * 32_767);
  }
  return output;
}

/**
 * Write a 44-byte WAV header followed by raw 16-bit PCM samples.
 */
function buildWav(pcm16: Int16Array, sampleRate: number): ArrayBuffer {
  const numSamples = pcm16.length;
  const dataSize = numSamples * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const write4 = (offset: number, str: string) => {
    for (let i = 0; i < 4; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  write4(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  write4(8, "WAVE");
  write4(12, "fmt ");
  view.setUint32(16, 16, true);          // fmt chunk size
  view.setUint16(20, 1, true);           // PCM
  view.setUint16(22, 1, true);           // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate (rate * channels * bitsPerSample/8)
  view.setUint16(32, 2, true);           // block align
  view.setUint16(34, 16, true);          // bits per sample
  write4(36, "data");
  view.setUint32(40, dataSize, true);

  // Copy PCM samples
  const dst = new Int16Array(buffer, 44);
  dst.set(pcm16);

  return buffer;
}

/**
 * Encode a raw audio Blob (any format supported by the browser's
 * AudioContext, e.g. webm/opus) to a 16 kHz mono WAV Blob.
 *
 * This is the main function called by the voice input component.
 */
export async function encodeToWav(audioBlob: Blob): Promise<Blob> {
  const arrayBuffer = await audioBlob.arrayBuffer();

  // Decode with the browser's built-in codec
  const audioCtx = new AudioContext();
  const audioBuffer = await audioCtx
    .decodeAudioData(arrayBuffer)
    .finally(() => audioCtx.close());

  // Mix down to mono (average all channels)
  const numChannels = audioBuffer.numberOfChannels;
  const length = audioBuffer.length;
  const mono = new Float32Array(length);
  for (let ch = 0; ch < numChannels; ch++) {
    const chData = audioBuffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      mono[i] += chData[i] / numChannels;
    }
  }

  // Resample to 16 kHz
  const resampled = resample(mono, audioBuffer.sampleRate, TARGET_SAMPLE_RATE);

  // Convert to 16-bit PCM
  const pcm16 = float32ToInt16(resampled);

  // Build WAV
  const wavBuffer = buildWav(pcm16, TARGET_SAMPLE_RATE);
  return new Blob([wavBuffer], { type: "audio/wav" });
}
