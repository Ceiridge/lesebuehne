/**
 * Whitespace normalisation of display text (the only change ever made to source text).
 *
 * Whitespace here means exactly: ASCII tab, LF, VT, FF, CR, space, and U+0085 (NEL),
 * U+2028 (LINE SEPARATOR), U+2029 (PARAGRAPH SEPARATOR). Typographic spaces such as
 * U+00A0 (no-break space), U+202F (narrow no-break space) and U+2009 (thin space) are
 * text characters and are kept unchanged.
 *
 * Steps:
 * 1. Unify line endings to `\n` (CRLF and a lone CR become one `\n`).
 * 2. Split into blocks at blank lines: one or more lines that contain only whitespace.
 * 3. Inside each block, collapse every whitespace run (including single line breaks) to one
 *    space, and trim the block (whitespace as defined above only).
 * 4. Drop empty blocks and join the blocks with exactly `\n\n`.
 *
 * No other character is changed, removed or added.
 */

/** The characters that the normalisation treats as whitespace. */
export const NORMALIZATION_WHITESPACE: readonly string[] = Object.freeze([
  '\t',
  '\n',
  '\v',
  '\f',
  '\r',
  ' ',
  '\u0085',
  '\u2028',
  '\u2029',
]);

const WS = '\\t\\n\\v\\f\\r \\u0085\\u2028\\u2029';
const WS_NO_LF = '\\t\\v\\f\\r \\u0085\\u2028\\u2029';
const LINE_ENDING = /\r\n?/g;
const BLANK_LINES = new RegExp(`\\n(?:[${WS_NO_LF}]*\\n)+`);
const WS_RUN = new RegExp(`[${WS}]+`, 'g');
const EDGE_WS = new RegExp(`^[${WS}]+|[${WS}]+$`, 'g');

/** Returns true if `ch` is one of the normalisation whitespace characters. */
export function isNormalizationWhitespace(ch: string): boolean {
  return NORMALIZATION_WHITESPACE.includes(ch);
}

/** Steps 1–3 and the dropping of empty blocks: the normalised blocks of `source`, in order. */
export function normalizeBlocks(source: string): string[] {
  const unified = source.replace(LINE_ENDING, '\n');
  const blocks: string[] = [];
  for (const raw of unified.split(BLANK_LINES)) {
    const block = raw.replace(WS_RUN, ' ').replace(EDGE_WS, '');
    if (block !== '') blocks.push(block);
  }
  return blocks;
}

/** Steps 1–4: the normalised text, blocks joined with exactly `\n\n`. */
export function normalizeWhitespace(source: string): string {
  return normalizeBlocks(source).join('\n\n');
}
