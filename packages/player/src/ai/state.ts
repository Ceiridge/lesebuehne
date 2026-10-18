import { signal } from '@preact/signals';
import type { VoiceInfo } from '../engine/voices.ts';
import type { AiBackend, BackendStatus } from './backends.ts';
import { TtsBuffer, ttsStatus } from './tts.ts';

/** Quiet status for the top bar (B8): where plans come from and whether work is running. */
export interface AiStatus {
  /** heuristic: no AI backend (or AI off). */
  mode: 'heuristic' | 'server' | 'browser';
  /** Jobs running or queued. */
  working: number;
  /** The last attempt fell back to the heuristic (rate limit, no provider …). */
  limited: boolean;
  lastError?: string;
  lastProvider?: string;
}

export const aiBackend = signal<AiBackend | undefined>(undefined);
export const aiStatus = signal<AiStatus>({ mode: 'heuristic', working: 0, limited: false });
/** Provider details for the settings panel (refreshed when it opens). */
export const aiDetails = signal<BackendStatus | undefined>(undefined);

/** Clip buffer for server TTS voices (spec 004), when the backend can speak. */
export const ttsBuffer = signal<TtsBuffer | undefined>(undefined);

export function setBackend(b: AiBackend | undefined): void {
  ttsBuffer.value?.dispose();
  ttsStatus.value = { state: 'idle', ahead: 0, limited: false };
  aiBackend.value = b;
  ttsBuffer.value = b ? createTtsBuffer(b) : undefined;
  aiStatus.value = { mode: b?.mode ?? 'heuristic', working: 0, limited: false };
  aiDetails.value = undefined;
}

/**
 * The clip buffer for a backend that can speak. Voices of streaming server providers start
 * playing while their audio is generated.
 */
export function createTtsBuffer(b: AiBackend): TtsBuffer | undefined {
  if (!b.tts) return undefined;
  const streams = (voice: string): boolean => {
    const providerId = voice.slice(0, voice.indexOf(':'));
    return !!aiDetails.peek()?.providers.some((p) => p.id === providerId && p.kind === 'tts' && p.streaming);
  };
  return new TtsBuffer(
    (text, lang, voice, s) => b.tts!(text, lang, voice, s),
    undefined,
    undefined,
    undefined,
    b.ttsStreamUrl ? (text, lang, voice) => (streams(voice) ? b.ttsStreamUrl!(text, lang, voice) : undefined) : undefined,
  );
}

/** Server TTS voices for a book language (multilingual voices count for every language). */
export function ttsVoices(lang: string): VoiceInfo[] {
  const primary = lang.toLowerCase().split(/[-_]/u)[0] ?? lang;
  return (aiDetails.value?.providers ?? []).flatMap((p) =>
    p.kind === 'tts' && p.available && p.voices
      ? p.voices
          .filter((v) => v.languages.length === 0 || v.languages.includes(primary))
          .map((v) => ({ voiceURI: `tts:${p.id}:${v.id}`, name: `${v.name} (${p.id})`, lang, localService: true, default: false, provider: p.id }))
      : [],
  );
}

export async function refreshDetails(): Promise<void> {
  const b = aiBackend.value;
  if (!b) {
    aiDetails.value = undefined;
    return;
  }
  try {
    const details = await b.status();
    if (aiBackend.value !== b) return;
    ttsBuffer.value?.setConcurrency(Math.max(1, ...details.providers.filter((p) => p.kind === 'tts' && p.available).map((p) => p.concurrency ?? 4)));
    aiDetails.value = details;
  } catch (e) {
    if (aiBackend.value !== b) return;
    aiStatus.value = { ...aiStatus.value, lastError: e instanceof Error ? e.message : String(e) };
  }
}
