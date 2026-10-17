import literataItalicExt from '@fontsource-variable/literata/files/literata-latin-ext-wght-italic.woff2';
import literataNormalExt from '@fontsource-variable/literata/files/literata-latin-ext-wght-normal.woff2';
import literataItalic from '@fontsource-variable/literata/files/literata-latin-wght-italic.woff2';
import literataNormal from '@fontsource-variable/literata/files/literata-latin-wght-normal.woff2';
import sansItalicExt from '@fontsource-variable/source-sans-3/files/source-sans-3-latin-ext-wght-italic.woff2';
import sansNormalExt from '@fontsource-variable/source-sans-3/files/source-sans-3-latin-ext-wght-normal.woff2';
import sansItalic from '@fontsource-variable/source-sans-3/files/source-sans-3-latin-wght-italic.woff2';
import sansNormal from '@fontsource-variable/source-sans-3/files/source-sans-3-latin-wght-normal.woff2';
import atkinson400ext from '@fontsource/atkinson-hyperlegible-next/files/atkinson-hyperlegible-next-latin-ext-400-normal.woff2';
import atkinson400 from '@fontsource/atkinson-hyperlegible-next/files/atkinson-hyperlegible-next-latin-400-normal.woff2';
import atkinson400iext from '@fontsource/atkinson-hyperlegible-next/files/atkinson-hyperlegible-next-latin-ext-400-italic.woff2';
import atkinson400i from '@fontsource/atkinson-hyperlegible-next/files/atkinson-hyperlegible-next-latin-400-italic.woff2';
import atkinson700ext from '@fontsource/atkinson-hyperlegible-next/files/atkinson-hyperlegible-next-latin-ext-700-normal.woff2';
import atkinson700 from '@fontsource/atkinson-hyperlegible-next/files/atkinson-hyperlegible-next-latin-700-normal.woff2';
import dyslexic400 from '@fontsource/opendyslexic/files/opendyslexic-latin-400-normal.woff2';
import dyslexic400i from '@fontsource/opendyslexic/files/opendyslexic-latin-400-italic.woff2';
import dyslexic700 from '@fontsource/opendyslexic/files/opendyslexic-latin-700-normal.woff2';
import type { FontId } from '../settings/settings.ts';

/** Unicode ranges of the Fontsource subsets (from each package's unicode.json). */
const LATIN =
  'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';
const LATIN_EXT =
  'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF';

export interface FontFile {
  url: string;
  style: 'normal' | 'italic';
  weight: string;
  unicodeRange: string;
}

export interface FontFamily {
  /** CSS family name used in `font-family`. */
  family: string;
  files: FontFile[];
  /** Fallback stack after the family. */
  fallback: string;
}

const file = (url: string, style: FontFile['style'], weight: string, unicodeRange: string): FontFile => ({ url, style, weight, unicodeRange });

/** The four self-hosted OFL families (B8). OpenDyslexic ships Latin only; other glyphs fall back. */
export const FONTS: Readonly<Record<Exclude<FontId, 'system'>, FontFamily>> = {
  literata: {
    family: 'Literata Variable',
    fallback: 'Georgia, "Times New Roman", serif',
    files: [
      file(literataNormal, 'normal', '200 900', LATIN),
      file(literataNormalExt, 'normal', '200 900', LATIN_EXT),
      file(literataItalic, 'italic', '200 900', LATIN),
      file(literataItalicExt, 'italic', '200 900', LATIN_EXT),
    ],
  },
  'source-sans': {
    family: 'Source Sans 3 Variable',
    fallback: 'system-ui, "Segoe UI", Roboto, sans-serif',
    files: [
      file(sansNormal, 'normal', '200 900', LATIN),
      file(sansNormalExt, 'normal', '200 900', LATIN_EXT),
      file(sansItalic, 'italic', '200 900', LATIN),
      file(sansItalicExt, 'italic', '200 900', LATIN_EXT),
    ],
  },
  atkinson: {
    family: 'Atkinson Hyperlegible Next',
    fallback: 'system-ui, sans-serif',
    files: [
      file(atkinson400, 'normal', '400', LATIN),
      file(atkinson400ext, 'normal', '400', LATIN_EXT),
      file(atkinson400i, 'italic', '400', LATIN),
      file(atkinson400iext, 'italic', '400', LATIN_EXT),
      file(atkinson700, 'normal', '700', LATIN),
      file(atkinson700ext, 'normal', '700', LATIN_EXT),
    ],
  },
  opendyslexic: {
    family: 'OpenDyslexic',
    fallback: 'system-ui, sans-serif',
    files: [file(dyslexic400, 'normal', '400', LATIN), file(dyslexic400i, 'italic', '400', LATIN), file(dyslexic700, 'normal', '700', LATIN)],
  },
};

export const SYSTEM_STACK = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

/** CSS `font-family` value for a font setting. */
export function fontStack(id: FontId): string {
  if (id === 'system') return SYSTEM_STACK;
  const f = FONTS[id];
  return `"${f.family}", ${f.fallback}`;
}

interface FontFaceSetLike {
  add(face: FontFace): unknown;
}

const registered = new Set<string>();

/** Font file URL resolved against the document base (works under a sub-path). */
export function resolveFontUrl(url: string, baseURI: string): string {
  return new URL(url, baseURI).href;
}

/**
 * Registers a family lazily through the FontFace API with `display: swap` and one
 * `unicodeRange` per subset, so the browser downloads only the subsets a text needs.
 * URLs are resolved against `document.baseURI`, so the player also works under a sub-path.
 */
export function ensureFont(
  id: FontId,
  env: { fonts: FontFaceSetLike; baseURI: string; FontFace: typeof FontFace } | undefined = typeof document === 'undefined' || typeof FontFace === 'undefined'
    ? undefined
    : { fonts: document.fonts as unknown as FontFaceSetLike, baseURI: document.baseURI, FontFace },
): FontFace[] {
  if (id === 'system' || !env || registered.has(id)) return [];
  registered.add(id);
  const family = FONTS[id];
  return family.files.map((f) => {
    const face = new env.FontFace(family.family, `url("${resolveFontUrl(f.url, env.baseURI)}") format("woff2")`, {
      style: f.style,
      weight: f.weight,
      display: 'swap',
      unicodeRange: f.unicodeRange,
    });
    env.fonts.add(face);
    return face;
  });
}

/** For tests: forget registrations. */
export function resetFontRegistry(): void {
  registered.clear();
}
