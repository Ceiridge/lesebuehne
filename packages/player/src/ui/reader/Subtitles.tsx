import type { Sentence } from '@lesebuehne/core';
import type { ComponentChildren } from 'preact';
import type { ReaderSession } from '../../app/session.ts';

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

/** Subtitles at the bottom of the stage: the current cue of the current sentence. */
export function Subtitles({ session }: { session: ReaderSession }) {
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
