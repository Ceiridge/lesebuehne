import { speechRate, type Sentence } from '@lesebuehne/core';

/** Weight of a speech span: characters plus a small bonus per syllable beyond two (long words). */
function weight(text: string): number {
  const syllables = (text.match(/[aeiouyäöüàâéèêëîïôûù]+/giu) ?? []).length;
  return text.length + Math.max(0, syllables - 2) * 0.5;
}

/**
 * Word estimate for voices without word boundaries (B7, Q4): elapsed time × calibrated speech
 * characters per second → weighted speech offset → token. Monotonic, clamped to the last word of
 * the utterance; the next sentence start resets it.
 */
export class WordEstimator {
  /** Token indexes with the cumulative weight at their start. */
  private readonly starts: Array<{ tokenIndex: number; at: number }> = [];
  private readonly total: number;
  private last = 0;

  constructor(
    sentence: Pick<Sentence, 'speechText' | 'speechMap' | 'tokens'>,
    /** Speech offset where the utterance starts. */
    private readonly offset: number,
    /** Calibrated speech characters per second (already includes tempo). */
    private readonly cps: number,
  ) {
    let acc = 0;
    for (const e of sentence.speechMap) {
      if (e.speech[1] <= offset) continue;
      const tokenIndex = sentence.tokens.findIndex((t) => t.start === e.display[0]);
      if (tokenIndex >= 0) this.starts.push({ tokenIndex, at: acc });
      acc += weight(sentence.speechText.slice(Math.max(offset, e.speech[0]), e.speech[1]));
    }
    this.total = acc;
    this.last = this.starts[0]?.tokenIndex ?? 0;
  }

  /** Estimated duration of the utterance in ms. */
  get durationMs(): number {
    return (this.total / this.cps) * 1000;
  }

  /** Token index after `elapsedMs` of speech (monotonic). */
  tokenAt(elapsedMs: number): number {
    const pos = Math.min(this.total, (Math.max(0, elapsedMs) / 1000) * this.cps);
    let index = this.starts[0]?.tokenIndex ?? 0;
    for (const s of this.starts) if (s.at <= pos) index = s.tokenIndex;
    this.last = Math.max(this.last, index);
    return this.last;
  }

  /** Offset where the utterance started (for tests and debug). */
  get startOffset(): number {
    return this.offset;
  }
}

/** Speech characters per second per (voice, tempo): exponential moving average of finished sentences. */
export class Calibration {
  private readonly rates = new Map<string, number>();
  constructor(private readonly alpha = 0.35) {}

  private key(voiceURI: string, tempo: number): string {
    return `${voiceURI}\u0000${tempo}`;
  }

  cps(voiceURI: string, tempo: number, lang: string): number {
    return this.rates.get(this.key(voiceURI, tempo)) ?? speechRate(lang) * tempo;
  }

  /** Record a fully spoken sentence. Ignores implausible samples (too short to measure). */
  update(voiceURI: string, tempo: number, lang: string, chars: number, seconds: number): void {
    if (chars < 8 || seconds < 0.2) return;
    const measured = chars / seconds;
    const key = this.key(voiceURI, tempo);
    const prev = this.rates.get(key) ?? speechRate(lang) * tempo;
    this.rates.set(key, prev + this.alpha * (measured - prev));
  }
}

/** Per-voice word-boundary support: `unknown` → `yes` on the first word boundary, or `no`. */
export type BoundarySupport = 'unknown' | 'yes' | 'no';

export class BoundaryDetector {
  private readonly states = new Map<string, BoundarySupport>();
  private sawWord = false;

  state(voiceURI: string): BoundarySupport {
    return this.states.get(voiceURI) ?? 'unknown';
  }

  sentenceStart(): void {
    this.sawWord = false;
  }

  word(voiceURI: string): void {
    this.sawWord = true;
    this.states.set(voiceURI, 'yes');
  }

  /** A finished sentence with ≥ 3 words and no word boundary marks the voice `no` (hint). */
  sentenceEnd(voiceURI: string, words: number): void {
    if (!this.sawWord && words >= 3 && this.state(voiceURI) !== 'yes') this.states.set(voiceURI, 'no');
  }

  /** Show the "Wortmarkierung geschätzt" hint. */
  hint(voiceURI: string): boolean {
    return this.state(voiceURI) === 'no';
  }
}
