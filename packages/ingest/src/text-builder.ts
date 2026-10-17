import { isNormalizationWhitespace, type Mark, type NoteRefInput } from '@lesebuehne/core';

export type Range = [number, number];

/** Display text with one source range per character, built from inline content. */
export class TextBuilder {
  text = '';
  sources: Range[] = [];
  marks: Mark[] = [];
  noteRefs: NoteRefInput[] = [];

  push(value: string, sources: Range[]): void {
    this.text += value;
    this.sources.push(...sources);
  }
  space(at = 0): void {
    this.push(' ', [[at, at]]);
  }
  /** Text without source positions (EPUB). */
  add(value: string): void {
    this.text += value;
    for (let k = 0; k < value.length; k++) this.sources.push([0, 0]);
  }
}

/** Collapses whitespace runs to one space and trims, keeping char sources, marks and refs aligned. */
export function normalized(b: TextBuilder): { text: string; sources: Range[]; marks: Mark[]; noteRefs: NoteRefInput[] } {
  const map: number[] = []; // raw offset → normalized offset
  let text = '';
  const sources: Range[] = [];
  let pendingSpace: Range | undefined;
  for (let i = 0; i < b.text.length; i++) {
    const ch = b.text.charAt(i);
    if (isNormalizationWhitespace(ch)) {
      if (text !== '' && !pendingSpace) pendingSpace = b.sources[i] ?? [0, 0];
      map.push(text.length + (pendingSpace ? 1 : 0));
      continue;
    }
    if (pendingSpace) {
      text += ' ';
      sources.push(pendingSpace);
      pendingSpace = undefined;
    }
    map.push(text.length);
    text += ch;
    sources.push(b.sources[i] ?? [0, 0]);
  }
  map.push(text.length);
  const at = (raw: number): number => Math.min(text.length, map[raw] ?? text.length);
  return {
    text,
    sources,
    marks: b.marks
      .map((m) => {
        let end = at(m.end);
        while (end > 0 && text.charAt(end - 1) === ' ') end--;
        return { ...m, start: at(m.start), end };
      })
      .filter((m) => m.end > m.start),
    noteRefs: b.noteRefs.map((r) => {
      const start = at(r.at);
      if (r.length === 0) return { ...r, at: start };
      let end = at(r.at + r.length);
      while (end > start && text.charAt(end - 1) === ' ') end--;
      return { ...r, at: start, length: end - start };
    }),
  };
}

