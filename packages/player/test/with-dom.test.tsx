import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { render } from 'preact';
import { withDom } from '../../../tests/support/with-dom.ts';
import { App } from '../src/ui/app.tsx';

// withDom() lives in tests/support. This test sits in the player package because
// `preact` is a declared dependency of @lesebuehne/player only, not of the root package.

const KEYS = ['window', 'document', 'Node', 'HTMLElement', 'MutationObserver', 'Range', 'requestAnimationFrame'] as const;
const SENTINEL = { sentinel: true };
const g = globalThis as Record<string, unknown>;

describe('01-7: withDom() test DOM', () => {
  let before: Map<string, PropertyDescriptor | undefined>;

  beforeAll(() => {
    // A previous value that withDom() must put back.
    g.HTMLElement = SENTINEL;
    before = new Map(KEYS.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  });

  afterAll(() => {
    delete g.HTMLElement;
  });

  describe('inside withDom()', () => {
    const dom = withDom();

    test('a Preact component renders into document', () => {
      expect(globalThis.document).toBe(dom.document);
      expect(g.HTMLElement).not.toBe(SENTINEL);
      const host = document.createElement('div');
      document.body.appendChild(host);
      render(<App />, host);
      expect(host.querySelector('h1')?.textContent).toBe('Lesebühne');
      expect(host.firstElementChild).toBeInstanceOf(HTMLElement);
      expect(typeof requestAnimationFrame).toBe('function');
      expect(document.createRange()).toBeInstanceOf(Range);
      render(null, host);
    });
  });

  test('after afterAll the previous globals are restored', () => {
    expect(g.HTMLElement).toBe(SENTINEL);
    for (const k of KEYS) {
      const now = Object.getOwnPropertyDescriptor(globalThis, k);
      const was = before.get(k);
      expect(now?.value).toBe(was?.value);
      expect(now === undefined).toBe(was === undefined);
    }
  });
});
