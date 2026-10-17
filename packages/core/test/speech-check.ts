import { expect } from 'bun:test';
import type { SpeechResult, SpeechToken } from '../src/index.ts';

/**
 * Asserts the offset-map property of B5 for one result:
 * - every speech character lies in exactly one map entry;
 * - every entry covers a contiguous run of spoken (not `noteRef`) display tokens: its display
 *   range starts at the start of one token and ends at the end of a later (or the same) token;
 * - entries are in display order and do not overlap, in speech and in display;
 * - no entry touches a `noteRef` token.
 * Returns a list of problems (empty when the property holds).
 */
export function mapProblems(tokens: readonly SpeechToken[], result: SpeechResult): string[] {
  const problems: string[] = [];
  const { speechText, map } = result;
  const spoken = tokens.filter((t) => !t.noteRef);

  for (let c = 0; c < speechText.length; c++) {
    const n = map.filter((e) => e.speech[0] <= c && c < e.speech[1]).length;
    if (n !== 1) problems.push(`speech char ${c} (${JSON.stringify(speechText[c])}) lies in ${n} entries`);
  }
  for (const [k, e] of map.entries()) {
    const [s, t] = e.speech;
    if (!(0 <= s && s < t && t <= speechText.length)) problems.push(`entry ${k}: bad speech range ${s}..${t}`);
    const first = spoken.findIndex((tok) => tok.start === e.display[0]);
    const last = spoken.findIndex((tok) => tok.end === e.display[1]);
    if (first < 0 || last < first) problems.push(`entry ${k}: display ${e.display} is not a token range`);
    for (const tok of tokens) {
      if (tok.noteRef && tok.start < e.display[1] && e.display[0] < tok.end) {
        problems.push(`entry ${k}: display ${e.display} touches noteRef token ${tok.start}..${tok.end}`);
      }
    }
    const prev = map[k - 1];
    if (prev) {
      if (prev.speech[1] !== s) problems.push(`entry ${k}: speech does not continue entry ${k - 1}`);
      if (prev.display[1] > e.display[0]) problems.push(`entry ${k}: display overlaps entry ${k - 1}`);
    } else if (s !== 0) problems.push('first entry does not start at speech offset 0');
  }
  const lastEntry = map.at(-1);
  if ((lastEntry?.speech[1] ?? 0) !== speechText.length) problems.push('entries do not end at the end of speechText');
  // Every spoken token belongs to exactly one entry.
  for (const tok of spoken) {
    const n = map.filter((e) => e.display[0] <= tok.start && tok.end <= e.display[1]).length;
    if (n !== 1) problems.push(`token ${tok.start}..${tok.end} (${tok.text}) lies in ${n} entries`);
  }
  return problems;
}

export function expectValidMap(tokens: readonly SpeechToken[], result: SpeechResult): void {
  expect(mapProblems(tokens, result)).toEqual([]);
}
