import { describe, expect, test } from 'bun:test';
import { browserFullscreen } from '../../src/ui/reader/fullscreen.ts';

describe('automatic Zen fullscreen detection', () => {
  const windowLike = (extra: Record<string, unknown> = {}) => ({
    innerWidth: 1920, innerHeight: 900, outerHeight: 1040,
    screen: { width: 1920, height: 1080 },
    matchMedia: (query: string) => ({ matches: query.includes('pointer: fine') }),
    ...extra,
  }) as unknown as Window;
  const doc = { fullscreenElement: null } as Document;
  test('normal/maximized windows are not fullscreen; F11 dimensions are', () => {
    expect(browserFullscreen(doc, windowLike())).toBe(false);
    expect(browserFullscreen(doc, windowLike({ innerHeight: 1080, outerHeight: 1080 }))).toBe(true);
    expect(browserFullscreen(doc, windowLike({ innerHeight: 900, outerHeight: 1040 }))).toBe(false);
  });
  test('uses the fullscreen API and display mode; mobile chrome hiding is not treated as F11', () => {
    expect(browserFullscreen({ fullscreenElement: {} } as Document, windowLike())).toBe(true);
    expect(browserFullscreen(doc, windowLike({ matchMedia: () => ({ matches: true }) }))).toBe(true);
    expect(browserFullscreen(doc, windowLike({ innerHeight: 1080, outerHeight: 1080, matchMedia: () => ({ matches: false }) }))).toBe(false);
  });
});
