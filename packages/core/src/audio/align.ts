import { primaryLanguage } from '../text/segmenters.ts';
import type { WordTiming } from '../providers/types.ts';
import type { Pcm } from './wav.ts';

/** Version of the word timings: cached timings from another version are recomputed from the audio. */
export const ALIGNER_VERSION = 'energy-2';

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

/** Frame energy (lightly smoothed against flicker) and which frames are voiced, by an adaptive threshold. */
function voicing(pcm: Pcm): { energy: Float32Array; peak: number; voiced: boolean[] } {
  const raw = frameEnergy(pcm);
  const energy = raw.map((x, i) => (raw[Math.max(0, i - 1)]! + 2 * x + raw[Math.min(raw.length - 1, i + 1)]!) / 4);
  const sorted = Float32Array.from(energy).sort();
  const peak = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
  const floor = sorted[Math.floor(sorted.length * 0.1)] ?? 0;
  // The 10th percentile is the noise floor unless the clip is nearly all speech: cap at a share of the peak.
  const threshold = Math.max(Math.min(floor * 2.5, peak * 0.25), peak * 0.06, 1e-4);
  return { energy, peak, voiced: Array.from(energy, (x) => x > threshold) };
}

function activity(voiced: boolean[], total: number, minPause: number): SpeechActivity {
  const first = voiced.indexOf(true);
  const last = voiced.lastIndexOf(true);
  if (first < 0) return { start: 0, end: total, pauses: [] };
  const pauses: SpeechActivity['pauses'] = [];
  let run = -1;
  for (let f = first; f <= last; f++) {
    if (!voiced[f]) {
      if (run < 0) run = f;
    } else if (run >= 0) {
      if ((f - run) * FRAME_SECONDS >= minPause - 1e-9) pauses.push({ t0: run * FRAME_SECONDS, t1: f * FRAME_SECONDS });
      run = -1;
    }
  }
  return { start: first * FRAME_SECONDS, end: Math.min(total, (last + 1) * FRAME_SECONDS), pauses };
}

/** Speech start/end and inner pauses from frame energy with an adaptive threshold. */
export function speechActivity(pcm: Pcm): SpeechActivity {
  return activity(voicing(pcm).voiced, pcm.samples.length / pcm.sampleRate, MIN_PAUSE_SECONDS);
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
  /** Expected speaking time in relative units. */
  weight: number;
  /** Expected pause after this word (0 none, 1 comma, 2 clause, 3 sentence). */
  pause: number;
}

/** Relative speaking time of a word: letters (about one sound each) count most, syllables add vowel length. */
function wordWeight(word: string, lang: string): number {
  const digits = word.match(/\p{N}/gu)?.length ?? 0;
  return 0.7 * syllables(word, lang) + 0.45 * (word.length + 4 * digits);
}

function words(text: string, lang: string): Word[] {
  const out: Word[] = [];
  for (const m of text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}\p{M}'’\-]*/gu)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    const after = text.slice(end, end + 3);
    const pause = /^[\s"»«”“)]*[.!?…]/u.test(after) ? 3 : /^[\s"»«”“)]*[;:–—]/u.test(after) ? 2 : /^[\s"»«”“)]*[,]/u.test(after) ? 1 : 0;
    out.push({ start, end, weight: wordWeight(m[0], lang), pause });
  }
  return out;
}

/**
 * Alignment costs (log-odds style). Fitted on reference voices with known word times: 270 German
 * clips at three speaking rates, also with shortened pauses for fluent voices.
 */
const ALIGN = {
  /** Shortest silence that can separate words. */
  minPause: 0.05,
  /** Variance of the log speaking rate per weight unit. */
  rateVariance: 0.5,
  /** A pause after a word, by punctuation strength (negative favours it), and per second of pause. */
  pauseAfter: [1, -1.5, -2, -3],
  pauseAfterPerSecond: [1, 2, 3, 4],
  /** A pause inside a word (a stop consonant or a breath): base, and per second beyond 80 ms. */
  pauseInside: 0.6,
  pauseInsidePerSecond: 6,
  /** Punctuation without a pause. */
  noPause: [0, 0.4, 1, 2.5],
  /** How far a free word start may move to an energy dip, and the cost per second of moving. */
  snap: 0.05,
  snapPerSecond: 1,
  /** Longest run of words between two anchors, and most pauses considered (long footnotes). */
  maxRun: 60,
  maxPauses: 40,
} as const;

/**
 * Word timings for one utterance (spec 004 B2). Energy finds speech start, end and pauses. A
 * dynamic program then decides which pauses fall after which words: it favours pauses at
 * punctuation, penalizes silence inside words and keeps the speaking rate steady between pauses.
 * Between those anchors, time is divided by word weight over voiced time only, and free word
 * starts move to a nearby energy dip. Deterministic; the error stays inside the utterance.
 */
export function alignWords(pcm: Pcm, text: string, lang: string): WordTiming[] {
  const ws = words(text, lang);
  if (ws.length === 0) return [];
  const { energy, peak, voiced } = voicing(pcm);
  const act = activity(voiced, pcm.samples.length / pcm.sampleRate, ALIGN.minPause);
  const pauses = act.pauses
    .map((p) => ({ ...p, len: p.t1 - p.t0 }))
    .sort((a, b) => b.len - a.len)
    .slice(0, ALIGN.maxPauses)
    .sort((a, b) => a.t0 - b.t0);
  const n = ws.length;
  const m = pauses.length;
  const prefix = (values: number[]): number[] => {
    const out = [0];
    for (const v of values) out.push(out.at(-1)! + v);
    return out;
  };
  const cumWeight = prefix(ws.map((w) => w.weight));
  const cumPause = prefix(pauses.map((p) => p.len));
  const cumInside = prefix(pauses.map((p) => ALIGN.pauseInside + ALIGN.pauseInsidePerSecond * Math.max(0, p.len - 0.08)));
  const cumNoPause = prefix(ws.map((w, b) => (b < n - 1 ? ALIGN.noPause[w.pause]! : 0)));
  const speech = act.end - act.start;
  const rate = Math.max(0.02, (speech - cumPause[m]!) / cumWeight[n]!);

  // An anchor pairs boundary b (after word b) with pause j, stored at (b + 1) * width + (j + 1).
  // The start is (-1, -1) and the end (n - 1, m).
  const width = m + 2;
  const cost = new Float64Array((n + 1) * width).fill(Infinity);
  const back = new Int32Array((n + 1) * width).fill(-1);
  cost[0] = 0;
  const run = (b1: number, j1: number, b2: number, j2: number): number => {
    const t1 = j1 < 0 ? act.start : pauses[j1]!.t1;
    const t2 = j2 >= m ? act.end : pauses[j2]!.t0;
    const voicedTime = t2 - t1 - (cumPause[j2]! - cumPause[j1 + 1]!);
    if (voicedTime <= 0.04 * (b2 - b1)) return Infinity;
    const weight = cumWeight[b2 + 1]! - cumWeight[b1 + 1]!;
    const lr = Math.log(voicedTime / weight / rate);
    return (weight * lr * lr) / ALIGN.rateVariance + (cumInside[j2]! - cumInside[j1 + 1]!) + (cumNoPause[b2]! - cumNoPause[b1 + 1]!);
  };
  const relax = (b2: number, j2: number, own: number): void => {
    const at = (b2 + 1) * width + (j2 + 1);
    for (let b1 = Math.max(-1, b2 - ALIGN.maxRun); b1 < b2; b1++) {
      for (let j1 = -1; j1 < j2; j1++) {
        if ((b1 < 0) !== (j1 < 0)) continue;
        const prev = cost[(b1 + 1) * width + (j1 + 1)]!;
        if (prev === Infinity) continue;
        const c = prev + run(b1, j1, b2, j2) + own;
        if (c < cost[at]!) {
          cost[at] = c;
          back[at] = (b1 + 1) * width + (j1 + 1);
        }
      }
    }
  };
  for (let b = 0; b < n - 1; b++) {
    const s = ws[b]!.pause;
    for (let j = 0; j < m; j++) relax(b, j, ALIGN.pauseAfter[s]! - ALIGN.pauseAfterPerSecond[s]! * Math.min(0.8, pauses[j]!.len));
  }
  relax(n - 1, m, 0);
  const anchors: Array<[number, number]> = [];
  for (let k = back[n * width + m + 1]!; k > 0; k = back[k]!) anchors.unshift([Math.floor(k / width) - 1, (k % width) - 1]);

  // Between anchors, weight advances over voiced time; pauses inside words are skipped.
  const t0 = new Array<number>(n).fill(act.start);
  const t1 = new Array<number>(n).fill(act.end);
  let firstWord = 0;
  let from = act.start;
  let firstPause = 0;
  const flush = (lastWord: number, to: number, endPause: number): void => {
    const inside = pauses.slice(firstPause, endPause);
    const voicedTime = to - from - inside.reduce((a, p) => a + p.len, 0);
    const weight = cumWeight[lastWord + 1]! - cumWeight[firstWord]!;
    const wall = (v: number): number => {
      let t = from;
      let left = v;
      for (const p of inside) {
        if (t + left <= p.t0) break;
        left -= p.t0 - t;
        t = p.t1;
      }
      return t + left;
    };
    for (let i = firstWord; i <= lastWord; i++) {
      t0[i] = wall(((cumWeight[i]! - cumWeight[firstWord]!) / weight) * voicedTime);
      t1[i] = wall(((cumWeight[i + 1]! - cumWeight[firstWord]!) / weight) * voicedTime);
    }
    t0[firstWord] = from;
    t1[lastWord] = to;
  };
  for (const [b, j] of anchors) {
    flush(b, pauses[j]!.t0, j);
    firstWord = b + 1;
    from = pauses[j]!.t1;
    firstPause = j + 1;
  }
  flush(n - 1, act.end, m);

  // Word starts not fixed by a pause move to the quietest frame nearby.
  const fixed = new Set(anchors.map(([b]) => b + 1));
  for (let i = 1; i < n; i++) {
    if (fixed.has(i)) continue;
    const reach = Math.floor(Math.min(ALIGN.snap, 0.35 * (t1[i]! - t0[i]!), 0.35 * (t1[i - 1]! - t0[i - 1]!)) / FRAME_SECONDS);
    if (reach < 1) continue;
    const center = Math.round(t0[i]! / FRAME_SECONDS);
    let best = center;
    let bestScore = Infinity;
    for (let f = Math.max(0, center - reach); f <= Math.min(energy.length - 1, center + reach); f++) {
      const score = energy[f]! / (peak || 1) + ALIGN.snapPerSecond * Math.abs(f - center) * FRAME_SECONDS;
      if (score < bestScore) {
        bestScore = score;
        best = f;
      }
    }
    t0[i] = best * FRAME_SECONDS;
    t1[i - 1] = Math.min(t1[i - 1]!, t0[i]!);
  }
  return ws.map((w, i) => ({ start: w.start, end: w.end, t0: round(t0[i]!), t1: round(Math.max(t0[i]!, t1[i]!)) }));
}

const PAUSE_SECONDS = [0, 0.22, 0.32, 0.45];

/**
 * Provisional word timings before the audio is known (a clip that is still streaming): word
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
