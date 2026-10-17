import type { BlockKind } from './schema.ts';

/** Section caps (B3). */
export const MAX_SECTION_PARAGRAPHS = 4;
export const MAX_SECTION_SECONDS = 90;

export interface PackItem {
  kind: BlockKind;
  /** Estimated seconds at 1.0× (ignored for figures and footnotes, which count 0 s). */
  duration: number;
}

function countsTowardCap(kind: BlockKind): boolean {
  return kind === 'text' || kind === 'list' || kind === 'quote';
}

/**
 * Greedy section packing for one chapter (B3, D5). Returns groups of item indexes in order.
 * - A heading always starts a new section; it does not count toward the paragraph cap.
 * - Figures and footnotes join the current section with 0 s and do not count toward the cap.
 * - A text, list or quote joins the current section while the section has fewer than 4 counted
 *   paragraphs and its duration including this one stays ≤ 90 s; otherwise it starts a new
 *   section. A section without counted paragraphs takes the next one whatever its length.
 */
export function packSections(items: readonly PackItem[]): number[][] {
  const groups: number[][] = [];
  let current: number[] | undefined;
  let counted = 0;
  let seconds = 0;
  const start = (): number[] => {
    current = [];
    groups.push(current);
    counted = 0;
    seconds = 0;
    return current;
  };
  for (const [i, item] of items.entries()) {
    if (item.kind === 'heading') {
      start().push(i);
      seconds += item.duration;
      continue;
    }
    if (!countsTowardCap(item.kind)) {
      (current ?? start()).push(i);
      continue;
    }
    const fits = counted === 0 || (counted < MAX_SECTION_PARAGRAPHS && seconds + item.duration <= MAX_SECTION_SECONDS);
    const target = current && fits ? current : start();
    target.push(i);
    counted++;
    seconds += item.duration;
  }
  return groups;
}
