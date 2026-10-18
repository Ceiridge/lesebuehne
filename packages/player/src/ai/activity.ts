import type { QueueSnapshot } from '@lesebuehne/core';
import { signal } from '@preact/signals';

/** What the AI produced: speech clips, the book's style, section plans, animation programs, images. */
export type ActivityKind = 'speech' | 'style' | 'plan' | 'animation' | 'image';
export const ACTIVITY_KINDS: readonly ActivityKind[] = ['speech', 'style', 'plan', 'animation', 'image'];

export interface ActivityEntry {
  at: number;
  kind: ActivityKind;
  outcome: 'new' | 'cached' | 'failed';
  /** Wall time of the request in milliseconds. */
  ms: number;
  /** Section the work belongs to, if any. */
  sectionId?: string;
  /** Short description: the spoken text, or a sentence range. */
  label?: string;
  /** Speech: audio length in seconds. */
  audioSeconds?: number;
  /** Images: pictures in this result (a 2×2 sheet gives four). */
  count?: number;
}

export interface ActivityTotals {
  new: number;
  cached: number;
  failed: number;
  /** Wall time of new results, in milliseconds. */
  ms: number;
  /** Speech: audio seconds of new clips. */
  audioSeconds: number;
  /** Images: pictures of new results. */
  pictures: number;
}

export interface ActivityLog {
  since: number;
  totals: Record<ActivityKind, ActivityTotals>;
  /** Newest first. */
  recent: ActivityEntry[];
}

const RECENT = 40;
const empty = (): ActivityTotals => ({ new: 0, cached: 0, failed: 0, ms: 0, audioSeconds: 0, pictures: 0 });
const fresh = (now = Date.now()): ActivityLog => ({ since: now, totals: { speech: empty(), style: empty(), plan: empty(), animation: empty(), image: empty() }, recent: [] });

/** Everything generated since the app started (this browser tab). */
export const activity = signal<ActivityLog>(fresh());

export function recordActivity(e: Omit<ActivityEntry, 'at'> & { at?: number }): void {
  const entry: ActivityEntry = { ...e, at: e.at ?? Date.now() };
  const log = activity.peek();
  const t = { ...log.totals[entry.kind] };
  t[entry.outcome]++;
  if (entry.outcome === 'new') {
    t.ms += entry.ms;
    t.audioSeconds += entry.audioSeconds ?? 0;
    t.pictures += entry.count ?? (entry.kind === 'image' ? 1 : 0);
  }
  activity.value = { ...log, totals: { ...log.totals, [entry.kind]: t }, recent: [entry, ...log.recent].slice(0, RECENT) };
}

export function resetActivity(now = Date.now()): void {
  activity.value = fresh(now);
  activityHistory.value = [];
}

/** Kind of a planner job from its queue key (`plan:…`, `anim:…`, `img:…`, `style`). */
export function kindOfKey(key: string): ActivityKind {
  if (key === 'style') return 'style';
  if (key.startsWith('anim:')) return 'animation';
  if (key.startsWith('img:') || key.startsWith('images:')) return 'image';
  return 'plan';
}

/** One queue as shown in the info panel: what runs (with labels) and how much waits. */
export interface QueueView {
  id: 'speech' | 'plans' | 'images';
  snapshot: QueueSnapshot;
}

/** A sample of the generation pace, taken every few seconds while a book is open. */
export interface HistoryPoint {
  at: number;
  /** Generated speech seconds per wall second, divided by the tempo (1 = just keeps up). */
  speech?: number;
  /** The same for the stage. */
  stage?: number;
  /** Speech audio ready ahead of the current clip, in seconds. */
  ahead?: number;
  running: number;
  queued: number;
}

/** Ten minutes at one sample every two seconds. */
export const HISTORY_POINTS = 300;
export const activityHistory = signal<HistoryPoint[]>([]);

export function sampleActivity(point: HistoryPoint): void {
  activityHistory.value = [...activityHistory.peek(), point].slice(-HISTORY_POINTS);
}
