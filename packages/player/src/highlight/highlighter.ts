/** The parts of `CSS.highlights` (HighlightRegistry) the controller uses. */
export interface HighlightRegistryLike {
  set(name: string, highlight: unknown): unknown;
  delete(name: string): unknown;
}

export type HighlightFactory = (...ranges: Range[]) => { priority?: number };

export type Level = 'paragraph' | 'sentence' | 'word';

const NAMES: Readonly<Record<Level, string>> = { paragraph: 'lb-paragraph', sentence: 'lb-sentence', word: 'lb-word' };
const PRIORITY: Readonly<Record<Level, number>> = { paragraph: 1, sentence: 2, word: 3 };

/**
 * Highlights the current paragraph, sentence and word (B7) without changing the DOM per word:
 * with the CSS Custom Highlight API it only replaces ranges in the registry; without it (fallback)
 * it moves a `data-cur` attribute between existing elements. Never adds or removes nodes.
 */
export class Highlighter {
  private readonly current: Partial<Record<Level, Element>> = {};

  constructor(
    private readonly registry: HighlightRegistryLike | undefined,
    private readonly makeHighlight: HighlightFactory | undefined,
  ) {}

  /** Uses `CSS.highlights` when the engine has it, else the attribute fallback. */
  static forDocument(): Highlighter {
    const css = (globalThis as { CSS?: { highlights?: HighlightRegistryLike } }).CSS;
    const H = (globalThis as { Highlight?: new (...r: Range[]) => { priority: number } }).Highlight;
    return css?.highlights && H ? new Highlighter(css.highlights, (...r) => new H(...r)) : new Highlighter(undefined, undefined);
  }

  get native(): boolean {
    return this.registry !== undefined;
  }

  /** Highlights `el` at `level` (or clears it with `null`). */
  set(level: Level, el: Element | null): void {
    if (this.current[level] === el) return;
    const before = this.current[level];
    if (el) this.current[level] = el;
    else delete this.current[level];
    if (this.registry && this.makeHighlight) {
      if (!el) {
        this.registry.delete(NAMES[level]);
        return;
      }
      const range = el.ownerDocument.createRange();
      range.selectNodeContents(el);
      const h = this.makeHighlight(range);
      h.priority = PRIORITY[level];
      this.registry.set(NAMES[level], h);
      return;
    }
    before?.removeAttribute(`data-cur-${level}`);
    el?.setAttribute(`data-cur-${level}`, '');
  }

  clear(): void {
    for (const level of Object.keys(NAMES) as Level[]) this.set(level, null);
  }
}
