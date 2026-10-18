import { primaryLanguage } from '../text/segmenters.ts';
import type { WordTiming } from '../providers/types.ts';
import type { Pcm } from './wav.ts';

/** Part of TTS cache keys: change when the algorithm changes. */
export const ALIGNER_VERSION = 'energy-1';

const FRAME_SECONDS = 0.01;
const MIN_PAUSE_SECONDS = 0.09;

/** RMS energy per 10 ms frame. */
export function frameEnergy(pcm: Pcm): Float32Array {
  const size = Math.max(1, Math.round(pcm.sampleRate * FRAME_SECONDS));
  const frames = Math.ceil(pcm.samples.length / size);
  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const end = Math.min(pcm.samples.length, (f + 1) * size);
    for (let i = f * size; i < end; i++) sum += pcm.samples[i]! * pcm.samples[i]!;
    out[f] = Math.sqrt(sum / Math.max(1, end - f * size));
  }
  return out;
}

export interface SpeechActivity {
  /** Seconds where speech begins and ends. */
  start: number;
  end: number;
  /** Silent gaps inside the speech, in seconds. */
  pauses: Array<{ t0: number; t1: number }>;
}

/** Speech start/end and inner pauses from frame energy with an adaptive threshold. */
export function speechActivity(pcm: Pcm): SpeechActivity {
  const e = frameEnergy(pcm);
  const sorted = Float32Array.from(e).sort();
  const peak = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
  const floor = sorted[Math.floor(sorted.length * 0.1)] ?? 0;
  // The 10th percentile is the noise floor unless the clip is nearly all speech: cap at a share of the peak.
  const threshold = Math.max(Math.min(floor * 2.5, peak * 0.25), peak * 0.06, 1e-4);
  const voiced = Array.from(e, (x) => x > threshold);
  const first = voiced.indexOf(true);
  const last = voiced.lastIndexOf(true);
  const total = pcm.samples.length / pcm.sampleRate;
  if (first < 0) return { start: 0, end: total, pauses: [] };
  const pauses: SpeechActivity['pauses'] = [];
  let run = -1;
  for (let f = first; f <= last; f++) {
    if (!voiced[f]) {
      if (run < 0) run = f;
    } else if (run >= 0) {
      if ((f - run) * FRAME_SECONDS >= MIN_PAUSE_SECONDS) pauses.push({ t0: run * FRAME_SECONDS, t1: f * FRAME_SECONDS });
      run = -1;
    }
  }
  return { start: first * FRAME_SECONDS, end: Math.min(total, (last + 1) * FRAME_SECONDS), pauses };
}

const VOWELS: Readonly<Record<string, RegExp>> = {
  de: /[aeiouyäöü]+/giu,
  en: /[aeiouy]+/giu,
};

/** Rough syllable count (vowel groups), at least one. */
export function syllables(word: string, lang: string): number {
  const re = VOWELS[primaryLanguage(lang)] ?? VOWELS.de!;
  const n = word.match(re)?.length ?? 0;
  // Digits are read as several syllables.
  const digits = word.match(/\p{N}/gu)?.length ?? 0;
  return Math.max(1, n + digits * 1.5);
}

interface Word {
  start: number;
  end: number;
  weight: number;
  /** Expected pause after this word (0 none, 1 comma, 2 clause, 3 sentence). */
  pause: number;
}

function words(text: string, lang: string): Word[] {
  const out: Word[] = [];
  for (const m of text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}\p{M}'’\-]*/gu)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    const after = text.slice(end, end + 3);
    const pause = /^[\s"»«”“)]*[.!?…]/u.test(after) ? 3 : /^[\s"»«”“)]*[;:–—]/u.test(after) ? 2 : /^[\s"»«”“)]*[,]/u.test(after) ? 1 : 0;
    out.push({ start, end, weight: syllables(m[0], lang) + 0.4, pause });
  }
  return out;
}

/**
 * Word timings for one utterance (spec 004 B2): energy finds speech start/end and pauses;
 * detected pauses are matched in order to punctuation; time between anchors is divided by
 * syllable weight. Deterministic; the error stays inside the utterance.
 */
export function alignWords(pcm: Pcm, text: string, lang: string): WordTiming[] {
  const ws = words(text, lang);
  if (ws.length === 0) return [];
  const act = speechActivity(pcm);
  const totalWeight = ws.reduce((a, w) => a + w.weight, 0);

  // Candidate boundaries (after word i) with punctuation, and where they would fall without pauses.
  const cum: number[] = [];
  let acc = 0;
  for (const w of ws) {
    acc += w.weight;
    cum.push(acc);
  }
  const boundaries = ws.map((w, i) => ({ i, strength: w.pause, at: act.start + ((act.end - act.start) * cum[i]!) / totalWeight })).filter((b) => b.strength > 0 && b.i < ws.length - 1);

  // Monotone matching: each pause (longest first) takes the nearest free punctuation boundary
  // that keeps the order with the pauses already assigned.
  const assigned = new Map<number, { t0: number; t1: number }>();
  const byLength = [...act.pauses].sort((a, b) => b.t1 - b.t0 - (a.t1 - a.t0));
  for (const p of byLength) {
    const mid = (p.t0 + p.t1) / 2;
    let best: { i: number; cost: number } | undefined;
    for (const b of boundaries) {
      if (assigned.has(b.i)) continue;
      const ok = [...assigned.entries()].every(([j, q]) => (j < b.i ? q.t1 <= p.t0 : q.t0 >= p.t1));
      if (!ok) continue;
      const cost = Math.abs(b.at - mid) / (1 + b.strength * 0.5);
      if (!best || cost < best.cost) best = { i: b.i, cost };
    }
    // Pauses far from any punctuation are breaths inside a clause: ignore them.
    if (best && best.cost < Math.max(0.6, (act.end - act.start) * 0.25)) assigned.set(best.i, p);
  }

  // Segments between anchors; inside each, time by weight.
  const timings: WordTiming[] = [];
  const anchors = [...assigned.entries()].sort((a, b) => a[0] - b[0]);
  let segStartWord = 0;
  let segStartTime = act.start;
  const flush = (lastWord: number, endTime: number): void => {
    const seg = ws.slice(segStartWord, lastWord + 1);
    const weight = seg.reduce((a, w) => a + w.weight, 0) || 1;
    let t = segStartTime;
    for (const w of seg) {
      const d = ((endTime - segStartTime) * w.weight) / weight;
      timings.push({ start: w.start, end: w.end, t0: round(t), t1: round(t + d) });
      t += d;
    }
  };
  for (const [i, p] of anchors) {
    flush(i, p.t0);
    segStartWord = i + 1;
    segStartTime = p.t1;
  }
  flush(ws.length - 1, act.end);
  return timings;
}

const PAUSE_SECONDS = [0, 0.22, 0.32, 0.45];

/**
 * Provisional word timings before the audio is known (a clip that is still streaming): syllable
 * weight plus typical pauses at punctuation, stretched to `seconds`. Replaced by `alignWords` once
 * the whole clip has been aligned.
 */
export function estimateWordTimings(text: string, lang: string, seconds: number, lead = 0.12): WordTiming[] {
  const ws = words(text, lang);
  if (ws.length === 0) return [];
  const pauses = ws.slice(0, -1).reduce((a, w) => a + PAUSE_SECONDS[w.pause]!, 0);
  const weight = ws.reduce((a, w) => a + w.weight, 0);
  const speech = Math.max(0.2 * ws.length, seconds - lead - pauses);
  const timings: WordTiming[] = [];
  let t = lead;
  for (const [i, w] of ws.entries()) {
    const d = (speech * w.weight) / weight;
    timings.push({ start: w.start, end: w.end, t0: round(t), t1: round(t + d) });
    t += d + (i < ws.length - 1 ? PAUSE_SECONDS[w.pause]! : 0);
  }
  return timings;
}

const round = (n: number): number => Math.round(n * 1000) / 1000;
