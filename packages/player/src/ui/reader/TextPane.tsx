import type { ComponentChildren } from 'preact';
import type { Mark, Paragraph, Sentence } from '@lesebuehne/core';
import { useComputed, useSignalEffect } from '@preact/signals';
import { memo } from 'preact/compat';
import { useEffect, useRef } from 'preact/hooks';
import type { ReaderSession } from '../../app/session.ts';
import { settings } from '../../app/store.ts';
import { t } from '../../i18n/i18n.ts';
import { IconTarget } from '../icons.tsx';

/** Index of the chapter that holds the sentence at `entryIndex`. */
function chapterIndexOf(session: ReaderSession, entryIndex: number): number {
  const id = session.timeline.entries[entryIndex]?.chapterId;
  return Math.max(0, session.book.chapters.findIndex((c) => c.id === id));
}

const MARK_TAG: Record<Mark['kind'], 'em' | 'strong' | 'code' | 'span'> = { em: 'em', strong: 'strong', code: 'code', link: 'span' };

/** Text of `[from, to)` with the paragraph's inline marks (emphasis can sit inside one word). */
function runs(p: Paragraph, from: number, to: number): ComponentChildren[] {
  const marks = (p.marks ?? []).filter((m) => m.start < to && m.end > from);
  if (marks.length === 0) return [p.displayText.slice(from, to)];
  const cuts = [...new Set([from, to, ...marks.flatMap((m) => [Math.max(from, m.start), Math.min(to, m.end)])])].sort((a, b) => a - b);
  const out: ComponentChildren[] = [];
  for (let k = 0; k < cuts.length - 1; k++) {
    const [a, b] = [cuts[k] ?? 0, cuts[k + 1] ?? 0];
    let node: ComponentChildren = p.displayText.slice(a, b);
    for (const m of marks.filter((x) => x.start <= a && x.end >= b)) {
      const Tag = MARK_TAG[m.kind];
      node = (
        <Tag key={`${m.kind}${a}`} class={m.kind === 'link' ? 'link' : undefined} title={m.href}>
          {node}
        </Tag>
      );
    }
    out.push(node);
  }
  return out;
}

function SentenceView({ p, s, entryIndex }: { p: Paragraph; s: Sentence; entryIndex: number | undefined }) {
  const children: ComponentChildren[] = [];
  let pos = s.start;
  const refsByToken = new Map((s.footnoteRefs ?? []).map((r) => [r.tokenId, r]));
  for (const [k, tok] of s.tokens.entries()) {
    if (tok.start > pos) children.push(p.displayText.slice(pos, tok.start));
    const ref = refsByToken.get(tok.id);
    if (tok.noteRef) {
      children.push(
        <button key={k} type="button" class="w fn-ref" data-k={k} data-fn={ref?.footnoteId} aria-label={t('reader.footnote', { label: tok.text })}>
          {tok.text}
        </button>,
      );
    } else {
      children.push(
        <span key={k} class="w" data-k={k}>
          {runs(p, tok.start, tok.end)}
        </span>,
      );
      if (ref) {
        // Markdown: the marker is drawn after its carrying token, outside the display text (D7).
        children.push(
          <button key={`fn${k}`} type="button" class="fn-ref fn-after" data-fn={ref.footnoteId} aria-label={t('reader.footnote', { label: ref.label })}>
            {ref.label}
          </button>,
        );
      }
    }
    pos = tok.end;
  }
  if (s.end > pos) children.push(p.displayText.slice(pos, s.end));
  return (
    <span class="s" data-e={entryIndex}>
      {children}
    </span>
  );
}

function sentencesIn(p: Paragraph, session: ReaderSession, from = 0, to = Number.POSITIVE_INFINITY): ComponentChildren[] {
  const out: ComponentChildren[] = [];
  const inRange = p.sentences.filter((s) => s.start >= from && s.start < to);
  let pos = Math.max(from, inRange[0]?.start ?? from);
  for (const s of inRange) {
    if (s.start > pos) out.push(p.displayText.slice(pos, s.start));
    out.push(<SentenceView key={s.id} p={p} s={s} entryIndex={session.timeline.indexOf.get(s.id)} />);
    pos = s.end;
  }
  return out;
}

function FigureView({ p, session }: { p: Paragraph; session: ReaderSession }) {
  const fig = p.figure;
  const src = fig?.asset ? session.assetUrl(fig.asset) : fig?.dataUrl;
  const caption = p.displayText || fig?.alt || '';
  return (
    <figure class="fig" data-p={p.id}>
      {src ? (
        <img src={src} alt={fig?.alt ?? ''} loading="lazy" decoding="async" />
      ) : (
        <div class="fig-placeholder" role="img" aria-label={fig?.alt || t('reader.figureUnavailable')}>
          <span class="fig-alt">{fig?.alt}</span>
          <span class="fig-missing">{t('reader.figureUnavailable')}</span>
        </div>
      )}
      {caption ? <figcaption>{caption}</figcaption> : null}
    </figure>
  );
}

function ParagraphView({ p, session }: { p: Paragraph; session: ReaderSession }) {
  switch (p.kind) {
    case 'heading': {
      const level = Math.min(6, (p.level ?? 1) + 1);
      const Tag = `h${level}` as 'h2';
      return (
        <Tag class="p p-heading" data-p={p.id}>
          {sentencesIn(p, session)}
        </Tag>
      );
    }
    case 'quote':
      return (
        <blockquote class="p p-quote" data-p={p.id}>
          <p>{sentencesIn(p, session)}</p>
        </blockquote>
      );
    case 'list': {
      const Tag = p.ordered ? 'ol' : 'ul';
      return (
        <Tag class="p p-list" data-p={p.id}>
          {(p.items ?? []).map(([a, b]) => (
            <li key={a}>{sentencesIn(p, session, a, b)}</li>
          ))}
        </Tag>
      );
    }
    case 'figure':
      return <FigureView p={p} session={session} />;
    case 'footnote':
      return null; // shown in the footnote popover (D3)
    default:
      return (
        <p class="p" data-p={p.id}>
          {sentencesIn(p, session)}
        </p>
      );
  }
}

/** One chapter of the book (rendered once per chapter; highlighting never re-renders it). */
const ChapterView = memo(function ChapterView({ session, index }: { session: ReaderSession; index: number }) {
  const chapter = session.book.chapters[index];
  if (!chapter) return null;
  return (
    <>
      {chapter.sections.map((s) => (
        <div class="section" key={s.id} data-x={s.id}>
          {s.paragraphs.map((p) => (
            <ParagraphView key={p.id} p={p} session={session} />
          ))}
        </div>
      ))}
    </>
  );
});

/**
 * The text pane (B7, B8): current chapter, current paragraph/sentence/word highlighted through
 * the highlighter (ranges or a `data-cur-*` attribute, never new nodes), click on a word to jump,
 * auto-follow with "back to current".
 */
export function TextPane({ session }: { session: ReaderSession }) {
  const article = useRef<HTMLElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const programmatic = useRef(0);
  const highlighter = useRef(session.env.highlighter());
  const chapterIndex = useComputed(() => chapterIndexOf(session, session.engine.position.value.entryIndex));
  const entryIndex = useComputed(() => session.engine.position.value.entryIndex);

  const scrollToCurrent = (smooth: boolean): void => {
    const el = article.current?.querySelector(`[data-e="${entryIndex.value}"]`);
    if (!el || typeof (el as HTMLElement).scrollIntoView !== 'function') return;
    programmatic.current = session.env.timers.now();
    (el as HTMLElement).scrollIntoView({ block: 'center', behavior: smooth && settings.value.motion !== 'none' ? 'smooth' : 'auto' });
  };

  const paint = (): void => {
    const p = session.engine.position.value;
    const root = article.current;
    if (!root) return;
    const sentence = root.querySelector(`[data-e="${p.entryIndex}"]`);
    const word = sentence?.querySelector(`[data-k="${p.tokenIndex}"]`) ?? null;
    const paragraph = sentence?.closest('[data-p]') ?? null;
    const h = highlighter.current;
    h.set('paragraph', paragraph);
    h.set('sentence', sentence ?? null);
    h.set('word', word);
  };

  // Highlight: paragraph, sentence, word on every position change (ranges only, no DOM change).
  useSignalEffect(() => {
    void session.engine.position.value;
    paint();
  });

  // Auto-follow on sentence change.
  useSignalEffect(() => {
    void entryIndex.value;
    if (session.follow.value === 'follow') queueMicrotask(() => scrollToCurrent(true));
  });

  useEffect(() => () => highlighter.current.clear(), [session]);

  // A new chapter was rendered: highlight and scroll inside it.
  useEffect(() => {
    paint();
    scrollToCurrent(false);
  }, [chapterIndex.value]);

  const onClick = (e: MouseEvent): void => {
    const target = e.target as Element | null;
    const fn = target?.closest('[data-fn]');
    if (fn) {
      const rect = fn.getBoundingClientRect();
      session.popover.value = { footnoteId: fn.getAttribute('data-fn') ?? '', x: rect.left + rect.width / 2, y: rect.bottom };
      return;
    }
    const word = target?.closest('[data-k]');
    const sentence = word?.closest('[data-e]');
    if (!word || !sentence) return;
    const entryIndex = Number(sentence.getAttribute('data-e'));
    const tokenIndex = Number(word.getAttribute('data-k'));
    if (Number.isFinite(entryIndex) && Number.isFinite(tokenIndex)) session.navigate({ entryIndex, tokenIndex });
  };

  const onUserScroll = (): void => {
    if (session.env.timers.now() - programmatic.current < 600) return;
    session.followEvent('user-scroll');
  };

  return (
    <div class="textpane" ref={scroller} onWheel={onUserScroll} onTouchMove={onUserScroll}>
      <article
        ref={article}
        class="book-text"
        lang={session.book.language}
        aria-label={t('reader.text')}
        data-native-highlight={highlighter.current.native ? '' : undefined}
        onClick={onClick}
      >
        <ChapterView session={session} index={chapterIndex.value} />
      </article>
      {session.follow.value === 'paused' ? (
        <button
          type="button"
          class="back-to-current"
          onClick={() => {
            session.followEvent('back-to-current');
            scrollToCurrent(true);
          }}
        >
          <IconTarget size={16} />
          {t('reader.backToCurrent')}
        </button>
      ) : null}
    </div>
  );
}
