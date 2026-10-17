import { signal } from '@preact/signals';
import type { AiBackend, BackendStatus } from './backends.ts';

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

export function setBackend(b: AiBackend | undefined): void {
  aiBackend.value = b;
  aiStatus.value = { mode: b?.mode ?? 'heuristic', working: 0, limited: false };
  aiDetails.value = undefined;
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
