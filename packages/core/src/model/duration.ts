import { primaryLanguage } from '../text/segmenters.ts';

/** Speech characters per second at 1.0× (B3). */
export const SPEECH_RATES: Readonly<Record<string, number>> = Object.freeze({ de: 14, en: 15 });
/** Rate for every other language. */
export const DEFAULT_SPEECH_RATE = 14;

export function speechRate(lang: string): number {
  return SPEECH_RATES[primaryLanguage(lang)] ?? DEFAULT_SPEECH_RATE;
}

/** Estimated seconds to speak `speechText` at `tempo` (1.0 = normal). */
export function estimateSeconds(speechText: string, lang: string, tempo = 1): number {
  if (!(tempo > 0)) throw new RangeError(`tempo must be > 0, got ${tempo}`);
  return speechText.length / speechRate(lang) / tempo;
}
