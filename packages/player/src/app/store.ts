import { signal } from '@preact/signals';
import { defaultUiLanguage, uiLanguage } from '../i18n/i18n.ts';
import { ensureFont, fontStack } from '../fonts/fonts.ts';
import { defaultSettings, type Settings } from '../settings/settings.ts';
import { DURATIONS, THEMES, type ThemeName } from '../theme/tokens.ts';
import type { ReaderSession } from './session.ts';

/** Global UI state (signals): settings, route, toasts. */
export const settings = signal<Settings>(defaultSettings());

export type Route = { name: 'start' } | { name: 'reader'; session: ReaderSession };
export const route = signal<Route>({ name: 'start' });

export interface Toast {
  id: number;
  kind: 'error' | 'info';
  text: string;
}
export const toasts = signal<Toast[]>([]);
let toastSeq = 0;

export function toast(text: string, kind: Toast['kind'] = 'info', ms = 6000): void {
  const id = ++toastSeq;
  toasts.value = [...toasts.value, { id, kind, text }];
  if (ms > 0) setTimeout(() => dismissToast(id), ms);
}

export function dismissToast(id: number): void {
  toasts.value = toasts.value.filter((t) => t.id !== id);
}

export function resolvedTheme(s: Settings, prefersDark: boolean): ThemeName {
  return s.theme === 'system' ? (prefersDark ? 'dark' : 'light') : s.theme;
}

const kebab = (s: string): string => s.replace(/[A-Z0-9]/gu, (c) => `-${c.toLowerCase()}`);

/**
 * Applies settings live (B8): colour tokens and typography as CSS custom properties on `:root`,
 * modes as data attributes, fonts registered lazily, UI language as a signal. No reload.
 */
export function applySettings(s: Settings, root: HTMLElement, prefersDark: boolean, languages?: readonly string[]): void {
  const theme = resolvedTheme(s, prefersDark);
  const colors = THEMES[theme];
  for (const [key, value] of Object.entries(colors)) root.style.setProperty(`--c-${kebab(key)}`, value);
  root.dataset.theme = theme;
  root.style.colorScheme = theme === 'dark' ? 'dark' : 'light';
  ensureFont(s.font);
  ensureFont('source-sans');
  root.style.setProperty('--font-reading', fontStack(s.font));
  root.style.setProperty('--font-ui', fontStack('source-sans'));
  root.style.setProperty('--reading-size', `${s.fontSize}px`);
  root.style.setProperty('--reading-line', String(s.lineHeight));
  root.style.setProperty('--reading-measure', `${s.measure}ch`);
  root.style.setProperty('--reading-margin', `${s.margins}px`);
  root.style.setProperty('--reading-para', `${s.paragraphSpacing}em`);
  root.style.setProperty('--reading-align', s.align === 'justify' ? 'justify' : 'start');
  root.dataset.align = s.align;
  root.dataset.highlight = s.highlightStyle;
  root.dataset.dimming = s.dimming;
  root.dataset.motion = s.motion;
  const d = DURATIONS[s.motion];
  root.style.setProperty('--dur-fast', `${d.fast}ms`);
  root.style.setProperty('--dur-base', `${d.base}ms`);
  root.style.setProperty('--dur-slow', `${d.slow}ms`);
  uiLanguage.value = s.uiLanguage === 'auto' ? defaultUiLanguage(languages) : s.uiLanguage;
  root.lang = uiLanguage.value;
}
