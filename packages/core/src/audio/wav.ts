/** Decoded PCM audio: mono samples in -1…1. */
export interface Pcm {
  samples: Float32Array;
  sampleRate: number;
}

const ascii = (v: DataView, at: number, n: number): string => String.fromCharCode(...Array.from({ length: n }, (_, k) => v.getUint8(at + k)));

/**
 * Decodes a RIFF/WAVE file (PCM 16/24/32-bit integer or 32-bit float, any channel count; channels
 * are averaged to mono). Throws on anything else.
 */
export function decodeWav(bytes: Uint8Array): Pcm {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 12 || ascii(v, 0, 4) !== 'RIFF' || ascii(v, 8, 4) !== 'WAVE') throw new Error('not a WAV file');
  let at = 12;
  let format = 0;
  let channels = 1;
  let sampleRate = 0;
  let bits = 16;
  let data: { at: number; size: number } | undefined;
  while (at + 8 <= bytes.byteLength) {
    const id = ascii(v, at, 4);
    let size = v.getUint32(at + 4, true);
    const body = at + 8;
    if (id === 'fmt ') {
      format = v.getUint16(body, true);
      channels = v.getUint16(body + 2, true);
      sampleRate = v.getUint32(body + 4, true);
      bits = v.getUint16(body + 14, true);
      if (format === 0xfffe && size >= 26) format = v.getUint16(body + 24, true); // WAVE_FORMAT_EXTENSIBLE
    } else if (id === 'data') {
      // Streaming writers leave the size at 0 or 0xFFFFFFFF: take the rest of the file.
      if (size === 0 || size === 0xffffffff || body + size > bytes.byteLength) size = bytes.byteLength - body;
      data = { at: body, size };
      break;
    }
    at = body + size + (size % 2);
  }
  if (!data || !sampleRate) throw new Error('WAV without fmt or data chunk');
  if (!(format === 1 && (bits === 16 || bits === 24 || bits === 32)) && !(format === 3 && bits === 32)) {
    throw new Error(`unsupported WAV encoding (format ${format}, ${bits} bit)`);
  }
  const bytesPer = bits / 8;
  const frames = Math.floor(data.size / (bytesPer * channels));
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      const p = data.at + (i * channels + c) * bytesPer;
      if (format === 3) sum += v.getFloat32(p, true);
      else if (bits === 16) sum += v.getInt16(p, true) / 32768;
      else if (bits === 24) sum += ((v.getUint8(p) | (v.getUint8(p + 1) << 8) | (v.getInt8(p + 2) << 16)) / 8388608);
      else sum += v.getInt32(p, true) / 2147483648;
    }
    samples[i] = sum / channels;
  }
  return { samples, sampleRate };
}

/** Encodes mono PCM as 16-bit WAV. */
export function encodeWav(pcm: Pcm): Uint8Array {
  const n = pcm.samples.length;
  const out = new Uint8Array(44 + n * 2);
  const v = new DataView(out.buffer);
  const put = (at: number, s: string): void => {
    for (let k = 0; k < s.length; k++) v.setUint8(at + k, s.charCodeAt(k));
  };
  put(0, 'RIFF');
  v.setUint32(4, 36 + n * 2, true);
  put(8, 'WAVE');
  put(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, pcm.sampleRate, true);
  v.setUint32(28, pcm.sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  put(36, 'data');
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(pcm.samples[i]! * 32767))), true);
  return out;
}

/** Wraps raw s16le mono PCM (e.g. qwentts `response_format: "pcm"`) as WAV. */
export function pcm16ToWav(raw: Uint8Array, sampleRate: number): Uint8Array {
  const v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const samples = new Float32Array(Math.floor(raw.byteLength / 2));
  for (let i = 0; i < samples.length; i++) samples[i] = v.getInt16(i * 2, true) / 32768;
  return encodeWav({ samples, sampleRate });
}

export const durationOf = (pcm: Pcm): number => pcm.samples.length / pcm.sampleRate;
