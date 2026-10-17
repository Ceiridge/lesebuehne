import { describe, expect, test } from 'bun:test';
import { alignWords, decodeWav, encodeWav, pcm16ToWav, speechActivity, syllables, type Pcm } from '../src/index.ts';

const RATE = 24000;

/** Synthetic speech: tone bursts for voiced stretches, silence for gaps. */
function audio(parts: Array<[kind: 'tone' | 'gap', seconds: number]>): Pcm {
  const total = parts.reduce((a, [, s]) => a + s, 0);
  const samples = new Float32Array(Math.round(total * RATE));
  let at = 0;
  for (const [kind, s] of parts) {
    const n = Math.round(s * RATE);
    if (kind === 'tone') for (let i = 0; i < n; i++) samples[at + i] = 0.4 * Math.sin((2 * Math.PI * 180 * i) / RATE) * (0.7 + 0.3 * Math.sin(i / 900));
    else for (let i = 0; i < n; i++) samples[at + i] = (Math.sin(i * 12.9898) * 43758.5453) % 1 * 0.002; // faint noise
    at += n;
  }
  return { samples, sampleRate: RATE };
}

describe('M4: WAV codec', () => {
  test('round trip 16-bit, pcm wrapper, rejects non-WAV', () => {
    const pcm = audio([['tone', 0.2], ['gap', 0.1]]);
    const back = decodeWav(encodeWav(pcm));
    expect(back.sampleRate).toBe(RATE);
    expect(back.samples.length).toBe(pcm.samples.length);
    expect(Math.abs(back.samples[1000]! - pcm.samples[1000]!)).toBeLessThan(1e-4);
    const raw = encodeWav(pcm).slice(44);
    expect(decodeWav(pcm16ToWav(raw, RATE)).samples.length).toBe(pcm.samples.length);
    expect(() => decodeWav(new Uint8Array([1, 2, 3]))).toThrow('not a WAV');
  });

  test('streamed WAV with data size 0 is read to the end', () => {
    const wav = encodeWav(audio([['tone', 0.1]]));
    new DataView(wav.buffer).setUint32(40, 0, true);
    expect(decodeWav(wav).samples.length).toBe(Math.round(0.1 * RATE));
  });
});

describe('M4: aligner', () => {
  test('speech activity: start, end and inner pauses', () => {
    const a = speechActivity(audio([['gap', 0.3], ['tone', 0.6], ['gap', 0.25], ['tone', 1.8], ['gap', 0.4]]));
    expect(a.start).toBeCloseTo(0.3, 1);
    expect(a.end).toBeCloseTo(2.95, 1);
    expect(a.pauses).toHaveLength(1);
    expect(a.pauses[0]!.t0).toBeCloseTo(0.9, 1);
  });

  test('pauses snap to punctuation; words in order and inside the speech', () => {
    const text = 'Habe Mut, dich deines eigenen Verstandes zu bedienen.';
    const w = alignWords(audio([['gap', 0.3], ['tone', 0.6], ['gap', 0.25], ['tone', 1.8], ['gap', 0.4]]), text, 'de');
    expect(w.map((x) => text.slice(x.start, x.end))).toEqual(['Habe', 'Mut', 'dich', 'deines', 'eigenen', 'Verstandes', 'zu', 'bedienen']);
    expect(w[0]!.t0).toBeCloseTo(0.3, 1);
    expect(w[1]!.t1).toBeCloseTo(0.9, 1); // "Mut," ends at the pause
    expect(w[2]!.t0).toBeCloseTo(1.15, 1); // "dich" starts after it
    expect(w.at(-1)!.t1).toBeCloseTo(2.95, 1);
    for (let k = 1; k < w.length; k++) expect(w[k]!.t0).toBeGreaterThanOrEqual(w[k - 1]!.t1 - 1e-9);
    // Longer words get more time.
    expect(w[5]!.t1 - w[5]!.t0).toBeGreaterThan(w[6]!.t1 - w[6]!.t0);
  });

  test('a breath far from punctuation is ignored; silence and empty text are safe', () => {
    const text = 'Eins zwei drei vier fünf sechs sieben acht.';
    const w = alignWords(audio([['tone', 0.4], ['gap', 0.12], ['tone', 2.6]]), text, 'de');
    expect(w).toHaveLength(8);
    expect(w[0]!.t0).toBeCloseTo(0, 1);
    expect(alignWords(audio([['gap', 1]]), 'Nur Stille.', 'de')).toHaveLength(2);
    expect(alignWords(audio([['tone', 1]]), '— …', 'de')).toEqual([]);
    expect(syllables('Verstandes', 'de')).toBe(3);
    expect(syllables('1789', 'de')).toBeGreaterThan(4);
  });
});
