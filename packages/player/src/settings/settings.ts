import * as z from 'zod';
import { MAX_TEMPO, MIN_TEMPO, TEMPO_STEP } from '../engine/engine.ts';

export const FONT_IDS = ['literata', 'source-sans', 'atkinson', 'opendyslexic', 'system'] as const;
export type FontId = (typeof FONT_IDS)[number];

export const LIMITS = {
  fontSize: { min: 14, max: 32, step: 1 },
  lineHeight: { min: 1.2, max: 2.2, step: 0.05 },
  measure: { min: 45, max: 90, step: 1 },
  margins: { min: 0, max: 96, step: 4 },
  paragraphSpacing: { min: 0, max: 2, step: 0.1 },
  tempo: { min: MIN_TEMPO, max: MAX_TEMPO, step: TEMPO_STEP },
  rsvpWpm: { min: 150, max: 900, step: 25 },
} as const;

const num = (min: number, max: number, fallback: number) => z.number().min(min).max(max).catch(fallback);

/** All reader settings (B8, B7 tempo, Q6 footnotes, Q7 UI language), stored in localStorage. */
export function settingsSchema(reducedMotion: boolean) {
  return z.object({
    theme: z.enum(['system', 'light', 'sepia', 'dark']).catch('system'),
    font: z.enum(FONT_IDS).catch('literata'),
    fontSize: num(LIMITS.fontSize.min, LIMITS.fontSize.max, 20),
    lineHeight: num(LIMITS.lineHeight.min, LIMITS.lineHeight.max, 1.65),
    measure: num(LIMITS.measure.min, LIMITS.measure.max, 66),
    margins: num(LIMITS.margins.min, LIMITS.margins.max, 32),
    paragraphSpacing: num(LIMITS.paragraphSpacing.min, LIMITS.paragraphSpacing.max, 0.9),
    align: z.enum(['left', 'justify']).catch('left'),
    highlightStyle: z.enum(['background', 'underline']).catch('background'),
    dimming: z.enum(['off', 'light', 'strong']).catch('light'),
    motion: z.enum(['full', 'reduced', 'none']).catch(reducedMotion ? 'reduced' : 'full'),
    volume: num(0, 1, 1),
    tempo: z
      .number()
      .min(MIN_TEMPO)
      .max(MAX_TEMPO)
      .refine((t) => Number.isInteger(t / TEMPO_STEP))
      .catch(1),
    /** Chosen voice per book language (primary subtag → voiceURI). */
    voiceByLang: z.record(z.string(), z.string()).catch({}),
    footnoteMode: z.enum(['skip', 'inline', 'section-end']).catch('skip'),
    uiLanguage: z.enum(['auto', 'de', 'en']).catch('auto'),
    layout: z.enum(['stage', 'cinema', 'sentence', 'rsvp', 'page', 'focus']).catch('stage'),
    /** Subtitles at the bottom of the stage in the stage layout (always on in "cinema"). */
    subtitles: z.boolean().catch(false),
    /** Subtitles as the karaoke line or as one RSVP word (spec 007 B1). */
    subtitleStyle: z.enum(['line', 'word']).catch('line'),
    /** RSVP pace without a voice (words per minute). */
    rsvpWpm: z.number().int().min(150).max(900).refine((n) => n % 25 === 0).catch(350),
    /** RSVP layout: advance at rsvpWpm even when a voice is available. */
    rsvpSilent: z.boolean().catch(false),
    /** AI visuals: director decides, only pictures, or only animations (spec 007 B2). */
    visualKinds: z.enum(['mixed', 'images', 'animations']).catch('mixed'),
    /** Voices whose "word highlight estimated" hint was dismissed. */
    dismissedHints: z.array(z.string()).catch([]),
  });
}

export type Settings = z.infer<ReturnType<typeof settingsSchema>>;

export function defaultSettings(reducedMotion = false): Settings {
  return settingsSchema(reducedMotion).parse({});
}

/** localStorage, or anything with the same two methods. */
export interface KeyValueStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export function browserStore(): KeyValueStore {
  return {
    get(key) {
      try {
        return globalThis.localStorage?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        globalThis.localStorage?.setItem(key, value);
      } catch {
        // storage blocked or full: settings live for this session only
      }
    },
  };
}

export const SETTINGS_KEY = 'lesebuehne.settings.v1';

export class SettingsStore {
  constructor(
    private readonly kv: KeyValueStore,
    private readonly reducedMotion = false,
  ) {}

  /** Stored settings; invalid or missing JSON (or single invalid fields) fall back to defaults. */
  load(): Settings {
    const raw = this.kv.get(SETTINGS_KEY);
    let data: unknown = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      data = {};
    }
    const parsed = settingsSchema(this.reducedMotion).safeParse(typeof data === 'object' && data !== null ? data : {});
    return parsed.success ? parsed.data : defaultSettings(this.reducedMotion);
  }

  save(settings: Settings): void {
    this.kv.set(SETTINGS_KEY, JSON.stringify(settings));
  }

  reset(): Settings {
    const d = defaultSettings(this.reducedMotion);
    this.save(d);
    return d;
  }
}
