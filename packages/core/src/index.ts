/** @lesebuehne/core: text model, segmentation, speech timing, visual state, bundle schema. */
export {
  NORMALIZATION_WHITESPACE,
  isNormalizationWhitespace,
  normalizeBlocks,
  normalizeWhitespace,
} from './text/whitespace.ts';
export { tokenize, type Token, type TokenizeOptions } from './text/tokens.ts';
export { primaryLanguage } from './text/segmenters.ts';
export { segmentSentences, sentenceRulesFor, type SentenceSpan } from './segment/sentences.ts';
export type { SentenceRules } from './segment/rules.ts';
export type { SpeechMapEntry, SpeechMatch, SpeechResult, SpeechRule, SpeechToken } from './speech/types.ts';
export { normalizeSpeech, speechForText, speechRulesFor, type SpeechOptions } from './speech/normalize.ts';
export {
  LexiconEntrySchema,
  LexiconSchema,
  parseLexicon,
  safeParseLexicon,
  type Lexicon,
  type LexiconEntry,
} from './speech/lexicon.ts';
export { cardinalDe, digitsDe, ordinalDe, romanValue, yearDe } from './speech/numbers-de.ts';
export { contentHash, cyrb53 } from './text/hash.ts';
export * from './model/schema.ts';
export { DEFAULT_SPEECH_RATE, SPEECH_RATES, estimateSeconds, speechRate } from './model/duration.ts';
export { MAX_SECTION_PARAGRAPHS, MAX_SECTION_SECONDS, packSections, type PackItem } from './model/sections.ts';
export {
  assembleBook,
  bookParagraphs,
  normalizeBlockText,
  rebuildDisplayText,
  type AssembleInput,
  type BlockInput,
  type ChapterInput,
  type NoteRefInput,
} from './model/assemble.ts';
export {
  buildTimeline,
  entryIndexAt,
  tokenSpeechOffset,
  tokenTime,
  type Timeline,
  type TimelineEntry,
} from './model/timeline.ts';
export * from './bundle/manifest.ts';
export * from './visual/plan.ts';
export * from './visual/style.ts';
export * from './visual/animation.ts';
export * from './providers/types.ts';
export * from './providers/errors.ts';
export * from './providers/structured.ts';
export * from './providers/http.ts';
export * from './providers/registry.ts';
export * from './providers/llm-base.ts';
export * from './providers/cache.ts';
export * from './providers/scheduler.ts';
export * from './providers/fake.ts';
