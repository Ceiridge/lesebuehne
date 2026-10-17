import type { Sentence } from '@lesebuehne/core';
import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import type { ReaderSession } from '../../app/session.ts';
import { settings } from '../../app/store.ts';
import { rsvpWord } from '../../engine/rsvp.ts';

/** Longest subtitle line block (characters) before the sentence is split into cues. */
export const SUBTITLE_CHARS = 96;

/**
 * Splits a sentence into subtitle cues of at most `max` characters, preferring breaks after
 * clause punctuation, then at spaces. Returns token index ranges `[from, to)`.
 */
export function subtitleCues(sentence: Sentence, max = SUBTITLE_CHARS): Array<[number, number]> {
  const cues: Array<[number, number]> = [];
  const tokens = sentence.tokens;
  let from = 0;
  while (from < tokens.length) {
    const start = tokens[from]?.start ?? 0;
    let to = from + 1;
    let lastClause = -1;
    while (to < tokens.length && (tokens[to]?.end ?? 0) - start <= max) {
      if (/^[,;:–—]$/u.test(tokens[to]?.text ?? '')) lastClause = to + 1;
      to++;
    }
    if (to < tokens.length && lastClause > from + 2) to = lastClause;
    // Do not leave a lone punctuation token for the next cue.
    while (to < tokens.length && !tokens[to]?.wordLike) to++;
    cues.push([from, to]);
    from = to;
  }
  return cues;
}

/** A run of tokens with past / current / upcoming words (karaoke style). */
export function KaraokeText({
  session,
  entryIndex,
  sentence,
  from = 0,
  to = sentence.tokens.length,
  current,
}: {
  session: ReaderSession;
  entryIndex: number;
  sentence: Sentence;
  from?: number;
  to?: number;
  current: number;
}) {
  const out: ComponentChildren[] = [];
  const text = sentence.text;
  const base = sentence.start;
  for (let k = from; k < to; k++) {
    const t = sentence.tokens[k];
    if (!t) continue;
    const next = sentence.tokens[k + 1];
    const gap = k + 1 < to && next ? text.slice(t.end - base, next.start - base) : '';
    const state = k < current ? 'is-past' : k === current ? 'is-current' : 'is-future';
    out.push(
      <span
        key={k}
        class={`kw ${state}`}
        onClick={() => session.navigate({ entryIndex, tokenIndex: k })}
      >
        {t.text}
      </span>,
    );
    if (gap) out.push(gap);
  }
  return <>{out}</>;
}

/**
 * RSVP (spec 007 B1): the current word alone at a fixed place, its ORP letter in red on the
 * centre axis, so the eyes stay still. `view` fills the main area, `subtitle` sits on the stage.
 */
export function RsvpView({ session, variant }: { session: ReaderSession; variant: 'view' | 'subtitle' }) {
  const wordRef = useRef<HTMLParagraphElement>(null);
  const p = session.engine.position.value;
  const entry = session.timeline.entries[p.entryIndex];
  const w = entry ? rsvpWord(entry.sentence, p.tokenIndex) : undefined;
  const words = entry ? entry.sentence.tokens.filter((t) => t.wordLike).length : 0;
  const done = entry && w ? entry.sentence.tokens.slice(0, w.tokenIndex + 1).filter((t) => t.wordLike).length : 0;
  useLayoutEffect(() => {
    const word = wordRef.current;
    const frame = word?.parentElement;
    if (!word || !frame) return;
    let disposed = false;
    const fit = () => {
      if (disposed) return;
      word.style.fontSize = '';
      const [before, pivot, after] = [...word.children] as HTMLElement[];
      const needed = 2 * Math.max(before!.scrollWidth, after!.scrollWidth) + pivot!.getBoundingClientRect().width;
      if (needed > word.clientWidth && word.clientWidth > 0) {
        word.style.fontSize = `${parseFloat(getComputedStyle(frame).fontSize) * word.clientWidth / (needed + 2)}px`;
      }
    };
    fit();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(fit);
    observer?.observe(frame);
    void document.fonts?.ready.then(fit);
    return () => { disposed = true; observer?.disconnect(); };
  }, [w?.before, w?.pivot, w?.after, variant, settings.value.font]);
  return (
    <div class={`rsvp rsvp-${variant}`} lang={session.book.language} aria-live="off">
      <div class="rsvp-frame" onClick={variant === 'view' ? () => session.togglePlay() : undefined}>
        <p ref={wordRef} class="rsvp-word" aria-label={w ? w.before + w.pivot + w.after : ''}>
          <span class="rsvp-before">{w?.before}</span>
          <span class="rsvp-pivot">{w?.pivot}</span>
          <span class="rsvp-after">{w?.after}</span>
        </p>
      </div>
      {variant === 'view' && words > 0 ? (
        <div class="rsvp-progress" aria-hidden="true">
          <span style={{ width: `${Math.round((done / words) * 100)}%` }} />
        </div>
      ) : null}
    </div>
  );
}

/** Subtitles at the bottom of the stage: the current cue of the current sentence (or one RSVP word). */
export function Subtitles({ session }: { session: ReaderSession }) {
  if (settings.value.subtitleStyle === 'word') {
    return (
      <div class="subtitles is-word">
        <RsvpView session={session} variant="subtitle" />
      </div>
    );
  }
  const p = session.engine.position.value;
  const entry = session.timeline.entries[p.entryIndex];
  if (!entry) return null;
  const cues = subtitleCues(entry.sentence);
  const cue = cues.find(([a, b]) => p.tokenIndex >= a && p.tokenIndex < b) ?? cues[0];
  if (!cue) return null;
  return (
    <div class="subtitles" lang={session.book.language} aria-live="off">
      <p class="subtitle-line">
        <KaraokeText session={session} entryIndex={p.entryIndex} sentence={entry.sentence} from={cue[0]} to={cue[1]} current={p.tokenIndex} />
      </p>
    </div>
  );
}

/** "Sentence by sentence" view: the current sentence large, its neighbours dimmed. */
export function SentenceView({ session }: { session: ReaderSession }) {
  const p = session.engine.position.value;
  const tl = session.timeline;
  const entry = tl.entries[p.entryIndex];
  if (!entry) return null;
  const prev = tl.entries[p.entryIndex - 1];
  const next = tl.entries[p.entryIndex + 1];
  const len = entry.sentence.text.length;
  const size = len > 420 ? 'is-long' : len > 200 ? 'is-medium' : 'is-short';
  const go = (entryIndex: number): void => session.navigate({ entryIndex, tokenIndex: 0 });
  return (
    <section class="sentence-view" lang={session.book.language} aria-label={entry.sentence.text}>
      {prev && prev.paragraphId === entry.paragraphId ? (
        <p class="sv-neighbour sv-prev" onClick={() => go(p.entryIndex - 1)}>
          {prev.sentence.text}
        </p>
      ) : (
        <p class="sv-neighbour sv-prev" aria-hidden="true" />
      )}
      <p class={`sv-current ${size}`}>
        <KaraokeText session={session} entryIndex={p.entryIndex} sentence={entry.sentence} current={p.tokenIndex} />
      </p>
      {next ? (
        <p class="sv-neighbour sv-next" onClick={() => go(p.entryIndex + 1)}>
          {next.sentence.text}
        </p>
      ) : null}
    </section>
  );
}
