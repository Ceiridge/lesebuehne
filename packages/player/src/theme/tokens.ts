/** Colour tokens per theme (B8). Dimmed text colours are pre-mixed so contrast is testable. */
export interface ThemeColors {
  /** Page background. */
  bg: string;
  /** Raised surfaces: bars, panels, cards. */
  surface: string;
  /** Secondary surface (inputs, chips, hover). */
  surface2: string;
  border: string;
  /** Body text. */
  text: string;
  /** Secondary UI text (labels, meta). */
  muted: string;
  /** Surrounding text at dimming "light" / "strong". */
  dimLight: string;
  dimStrong: string;
  /** Background tint of the current sentence; its text uses `text`. */
  sentenceBg: string;
  /** Current word: highlight background and its text. */
  wordBg: string;
  wordText: string;
  /** Current word: underline style. */
  underline: string;
  /** Accent for buttons, progress and links; `onAccent` is text on it. */
  accent: string;
  onAccent: string;
  focus: string;
  /** Stage background and its text. */
  stageBg: string;
  stageText: string;
  stageAccent: string;
}

export type ThemeName = 'light' | 'sepia' | 'dark';

export const THEMES: Readonly<Record<ThemeName, ThemeColors>> = {
  light: {
    bg: '#fbfaf7',
    surface: '#ffffff',
    surface2: '#f1eee8',
    border: '#e2ddd3',
    text: '#1d1c1a',
    muted: '#5c5850',
    dimLight: '#45423c',
    dimStrong: '#68645b',
    sentenceBg: '#f2ede2',
    wordBg: '#ffd966',
    wordText: '#1d1c1a',
    underline: '#b4530a',
    accent: '#2f5d50',
    onAccent: '#ffffff',
    focus: '#2160c4',
    stageBg: '#f3f0ea',
    stageText: '#1d1c1a',
    stageAccent: '#2f5d50',
  },
  sepia: {
    bg: '#f5ecd9',
    surface: '#fbf4e4',
    surface2: '#ece0c6',
    border: '#dccdae',
    text: '#382c1d',
    muted: '#62513b',
    dimLight: '#4f4030',
    dimStrong: '#6b5940',
    sentenceBg: '#ebdec0',
    wordBg: '#f0c55a',
    wordText: '#2b2115',
    underline: '#9c4310',
    accent: '#7a4b21',
    onAccent: '#fffaf0',
    focus: '#1e55a8',
    stageBg: '#efe3c9',
    stageText: '#382c1d',
    stageAccent: '#7a4b21',
  },
  dark: {
    bg: '#141518',
    surface: '#1c1e22',
    surface2: '#26292e',
    border: '#33363c',
    text: '#e8e5dd',
    muted: '#a9a59c',
    dimLight: '#c9c5bc',
    dimStrong: '#9e9a91',
    sentenceBg: '#23262c',
    wordBg: '#6b5418',
    wordText: '#fff6da',
    underline: '#f2b84b',
    accent: '#8ec5b2',
    onAccent: '#0f1714',
    focus: '#86b4ff',
    stageBg: '#191b1f',
    stageText: '#e8e5dd',
    stageAccent: '#8ec5b2',
  },
};

/** UI transition durations (ms) per motion level: 150–300 ms, 0 for "none" (B8). */
export const DURATIONS: Readonly<Record<'full' | 'reduced' | 'none', { fast: number; base: number; slow: number }>> = {
  full: { fast: 150, base: 220, slow: 300 },
  reduced: { fast: 150, base: 200, slow: 250 },
  none: { fast: 0, base: 0, slow: 0 },
};

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance (WCAG 2.x) of `#rrggbb`. */
export function luminance(hex: string): number {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(hex);
  if (!m) throw new Error(`not a #rrggbb colour: ${hex}`);
  const [r, g, b] = [m[1], m[2], m[3]].map((x) => channel(parseInt(x ?? '0', 16))) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colours. */
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

/** Every pair the contrast criterion (B8 C13) checks, with its threshold. */
export function contrastPairs(c: ThemeColors): Array<{ name: string; fg: string; bg: string; min: number }> {
  return [
    { name: 'body text', fg: c.text, bg: c.bg, min: 4.5 },
    { name: 'dimmed light', fg: c.dimLight, bg: c.bg, min: 4.5 },
    { name: 'dimmed strong', fg: c.dimStrong, bg: c.bg, min: 4.5 },
    { name: 'current sentence', fg: c.text, bg: c.sentenceBg, min: 4.5 },
    { name: 'current word (background)', fg: c.wordText, bg: c.wordBg, min: 4.5 },
    { name: 'current word (underline)', fg: c.underline, bg: c.bg, min: 3 },
    { name: 'underline on sentence tint', fg: c.underline, bg: c.sentenceBg, min: 3 },
    { name: 'UI text on surface', fg: c.text, bg: c.surface, min: 4.5 },
    { name: 'UI text on surface 2', fg: c.text, bg: c.surface2, min: 4.5 },
    { name: 'muted UI text', fg: c.muted, bg: c.surface, min: 4.5 },
    { name: 'muted on background', fg: c.muted, bg: c.bg, min: 4.5 },
    { name: 'text on accent', fg: c.onAccent, bg: c.accent, min: 4.5 },
    { name: 'focus ring on background', fg: c.focus, bg: c.bg, min: 3 },
    { name: 'focus ring on surface', fg: c.focus, bg: c.surface, min: 3 },
    { name: 'stage text', fg: c.stageText, bg: c.stageBg, min: 4.5 },
    { name: 'stage accent', fg: c.stageAccent, bg: c.stageBg, min: 3 },
  ];
}
