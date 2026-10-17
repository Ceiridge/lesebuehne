import { entryIndexAt, type Book, type Timeline } from '@lesebuehne/core';
import type { Position } from '../engine/engine.ts';

/** Navigation targets on the time axis (B8). Pure functions over the timeline. */

export function nextSentence(tl: Timeline, p: Position): Position {
  return { entryIndex: Math.min(tl.entries.length - 1, p.entryIndex + 1), tokenIndex: 0 };
}

/** Previous sentence; inside a sentence (past its first token) → that sentence's start. */
export function prevSentence(tl: Timeline, p: Position): Position {
  if (p.tokenIndex > 0) return { entryIndex: p.entryIndex, tokenIndex: 0 };
  return { entryIndex: Math.max(0, p.entryIndex - 1), tokenIndex: 0 };
}

function groupStart(tl: Timeline, index: number, key: 'paragraphId' | 'sectionId'): number {
  const id = tl.entries[index]?.[key];
  let k = index;
  while (k > 0 && tl.entries[k - 1]?.[key] === id) k--;
  return k;
}

function nextGroup(tl: Timeline, p: Position, key: 'paragraphId' | 'sectionId'): Position {
  const id = tl.entries[p.entryIndex]?.[key];
  let k = p.entryIndex;
  while (k < tl.entries.length - 1 && tl.entries[k]?.[key] === id) k++;
  return { entryIndex: tl.entries[k]?.[key] === id ? p.entryIndex : k, tokenIndex: 0 };
}

function prevGroup(tl: Timeline, p: Position, key: 'paragraphId' | 'sectionId'): Position {
  const start = groupStart(tl, p.entryIndex, key);
  if (start < p.entryIndex || p.tokenIndex > 0) return { entryIndex: start, tokenIndex: 0 };
  return { entryIndex: start > 0 ? groupStart(tl, start - 1, key) : 0, tokenIndex: 0 };
}

export const nextParagraph = (tl: Timeline, p: Position): Position => nextGroup(tl, p, 'paragraphId');
export const prevParagraph = (tl: Timeline, p: Position): Position => prevGroup(tl, p, 'paragraphId');
export const nextSection = (tl: Timeline, p: Position): Position => nextGroup(tl, p, 'sectionId');
export const prevSection = (tl: Timeline, p: Position): Position => prevGroup(tl, p, 'sectionId');

/** Position at book time τ (timeline click/drag). */
export function positionAt(tl: Timeline, tau: number): Position {
  return { entryIndex: Math.max(0, entryIndexAt(tl, tau)), tokenIndex: 0 };
}

/** First sentence of a paragraph (TOC jump to a heading). */
export function positionOfParagraph(tl: Timeline, paragraphId: string): Position | undefined {
  const k = tl.entries.findIndex((e) => e.paragraphId === paragraphId);
  return k < 0 ? undefined : { entryIndex: k, tokenIndex: 0 };
}

export interface TimelineMarker {
  kind: 'chapter' | 'section';
  /** Book time at 1.0×. */
  tau: number;
  /** 0 … 1 along the bar. */
  at: number;
  label: string;
}

/** Chapter and section markers of the timeline bar (B8). */
export function timelineMarkers(book: Book, tl: Timeline): TimelineMarker[] {
  const total = tl.duration || 1;
  const markers: TimelineMarker[] = [];
  const seen = new Set<string>();
  for (const e of tl.entries) {
    const chapter = !seen.has(e.chapterId);
    const section = !seen.has(e.sectionId);
    if (!chapter && !section) continue;
    seen.add(e.chapterId);
    seen.add(e.sectionId);
    markers.push({ kind: chapter ? 'chapter' : 'section', tau: e.start, at: e.start / total, label: headingAt(book, tl, e.start) });
  }
  return markers;
}

/** The nearest heading at or before τ (timeline tooltip), else the chapter title. */
export function headingAt(book: Book, tl: Timeline, tau: number): string {
  const index = entryIndexAt(tl, tau);
  if (index < 0) return '';
  const headingParagraphs = new Set<string>();
  for (const c of book.chapters) for (const s of c.sections) for (const p of s.paragraphs) if (p.kind === 'heading') headingParagraphs.add(p.id);
  for (let k = index; k >= 0; k--) {
    const e = tl.entries[k];
    if (e && headingParagraphs.has(e.paragraphId)) return e.sentence.text;
  }
  const chapterId = tl.entries[index]?.chapterId;
  return book.chapters.find((c) => c.id === chapterId)?.title ?? '';
}

/** Tooltip text at τ for the timeline. */
export const tooltipAt = headingAt;

/** "12:34" or "1:02:03". */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}
