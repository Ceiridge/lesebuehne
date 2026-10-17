import { afterAll, beforeAll } from 'bun:test';
import { Window } from 'happy-dom';

/** Globals that withDom() installs from a happy-dom Window. */
const DOM_GLOBALS = [
  'window',
  'document',
  'navigator',
  'Node',
  'Element',
  'HTMLElement',
  'Text',
  'DocumentFragment',
  'Event',
  'CustomEvent',
  'KeyboardEvent',
  'MutationObserver',
  'Range',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
] as const;

export interface DomHandle {
  /** The happy-dom window; valid between beforeAll and afterAll. */
  readonly window: Window;
  /** The window's document (same object as the global `document`). */
  readonly document: Document;
}

/**
 * Installs a happy-dom DOM as globals for the enclosing `describe` (or file):
 * `beforeAll` creates a fresh Window and sets the globals, `afterAll` closes the
 * window and puts back the previous globals exactly (value or absence).
 * Call it at describe level, not inside a test.
 */
export function withDom(): DomHandle {
  let win: Window | undefined;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const g = globalThis as Record<string, unknown>;

  beforeAll(() => {
    win = new Window({ url: 'http://127.0.0.1/' });
    const source = win as unknown as Record<string, unknown>;
    for (const key of DOM_GLOBALS) {
      saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      let value = key === 'window' ? win : source[key];
      if (typeof value === 'function' && /^[a-z]/.test(key)) value = (value as Function).bind(win);
      Object.defineProperty(globalThis, key, { value, configurable: true, writable: true, enumerable: true });
    }
  });

  afterAll(async () => {
    for (const key of DOM_GLOBALS) {
      const previous = saved.get(key);
      if (previous) Object.defineProperty(globalThis, key, previous);
      else delete g[key];
    }
    saved.clear();
    await win?.happyDOM.close();
    win = undefined;
  });

  return {
    get window() {
      if (!win) throw new Error('withDom(): window is only available between beforeAll and afterAll');
      return win;
    },
    get document() {
      return this.window.document as unknown as Document;
    },
  };
}
