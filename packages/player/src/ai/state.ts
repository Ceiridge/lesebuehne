import { signal } from '@preact/signals';
import type { VoiceInfo } from '../engine/voices.ts';
import type { AiBackend, BackendStatus } from './backends.ts';
import { TtsBuffer } from './tts.ts';

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
  aiBackend.value = b;
  ttsBuffer.value = b?.tts ? new TtsBuffer((text, lang, voice, s) => b.tts!(text, lang, voice, s)) : undefined;
  aiStatus.value = { mode: b?.mode ?? 'heuristic', working: 0, limited: false };
  aiDetails.value = undefined;
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
    aiDetails.value = await b.status();
  } catch (e) {
    aiStatus.value = { ...aiStatus.value, lastError: e instanceof Error ? e.message : String(e) };
  }
}
