import { signal } from '@preact/signals';
import { de } from './de.ts';
import { en } from './en.ts';

export type MessageKey = keyof typeof de;
export type UiLanguage = 'de' | 'en';

/** One catalog per UI language; adding a language is adding a catalog (B8, Q7). */
export const CATALOGS: Readonly<Record<UiLanguage, Readonly<Record<MessageKey, string>>>> = { de, en };

/** Default UI language: German if the first preferred language starts with `de`, else English. */
export function defaultUiLanguage(languages: readonly string[] | undefined): UiLanguage {
  return languages?.[0]?.toLowerCase().startsWith('de') ? 'de' : 'en';
}

/** Current UI language (signal: changing it re-renders without reload). */
export const uiLanguage = signal<UiLanguage>(
  defaultUiLanguage(typeof navigator === 'undefined' ? undefined : navigator.languages),
);

/** Translate `key` in the current (or given) UI language; `{name}` placeholders are filled. */
export function t(key: MessageKey, params: Record<string, string | number> = {}, lang: UiLanguage = uiLanguage.value): string {
  const template = CATALOGS[lang][key] ?? CATALOGS.en[key] ?? key;
  return template.replace(/\{(\w+)\}/gu, (m, name: string) => (name in params ? String(params[name]) : m));
}
