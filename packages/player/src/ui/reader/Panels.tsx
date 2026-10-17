import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import type { ReaderSession } from '../../app/session.ts';
import { t, type MessageKey } from '../../i18n/i18n.ts';
import { positionOfParagraph } from '../../nav/navigation.ts';
import { IconBookmark, IconClose, IconTrash } from '../icons.tsx';

/** A side panel (modal while open, B8: only Esc and its own keys work). */
export function Drawer({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ComponentChildren; wide?: boolean }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>('[data-autofocus], button, [href], input, select')?.focus();
    return () => before?.focus?.();
  }, []);
  return (
    <div class="drawer-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={panel} class={wide ? 'drawer is-wide' : 'drawer'} role="dialog" aria-modal="true" aria-label={title}>
        <header class="drawer-header">
          <h2>{title}</h2>
          <button type="button" class="icon-btn" aria-label={t('reader.close')} onClick={onClose}>
            <IconClose />
          </button>
        </header>
        <div class="drawer-body">{children}</div>
      </div>
    </div>
  );
}

/** Table of contents: chapters and headings, current position marked, click jumps (B8). */
export function TocPanel({ session }: { session: ReaderSession }) {
  const p = session.engine.position.value;
  const current = session.timeline.entries[p.entryIndex];
  let currentHeading: string | undefined;
  for (let k = p.entryIndex; k >= 0 && !currentHeading; k--) {
    const e = session.timeline.entries[k];
    const para = e ? session.sections.get(e.sectionId)?.paragraphs.find((x) => x.id === e.paragraphId) : undefined;
    if (para?.kind === 'heading') currentHeading = para.id;
  }
  const jump = (paragraphId: string): void => {
    const target = positionOfParagraph(session.timeline, paragraphId);
    if (target) session.navigate(target);
    session.panel.value = null;
  };
  return (
    <Drawer title={t('reader.toc')} onClose={() => (session.panel.value = null)}>
      <nav aria-label={t('reader.toc')}>
        <ol class="toc">
          {session.book.chapters.map((c, ci) => {
            const headings = c.sections.flatMap((s) => s.paragraphs.filter((x) => x.kind === 'heading'));
            const firstPara = c.sections[0]?.paragraphs.find((x) => x.kind !== 'figure' && x.kind !== 'footnote');
            const isCurrent = current?.chapterId === c.id;
            return (
              <li key={c.id} class={isCurrent ? 'toc-chapter is-current' : 'toc-chapter'}>
                <button type="button" class="toc-link" aria-current={isCurrent ? 'true' : undefined} onClick={() => firstPara && jump(firstPara.id)}>
                  <span class="toc-num">{ci + 1}</span>
                  <span>{c.title || session.book.title}</span>
                </button>
                {headings.length > 1 || (headings[0] && headings[0].displayText !== c.title) ? (
                  <ol class="toc-sub">
                    {headings
                      .filter((h) => h.displayText !== c.title)
                      .map((h) => (
                        <li key={h.id}>
                          <button type="button" class={`toc-link level-${h.level ?? 1}`} aria-current={currentHeading === h.id ? 'true' : undefined} onClick={() => jump(h.id)}>
                            {h.displayText}
                          </button>
                        </li>
                      ))}
                  </ol>
                ) : null}
              </li>
            );
          })}
        </ol>
      </nav>
    </Drawer>
  );
}

/** Bookmarks: add/remove at the current sentence, list with excerpt, jump, delete (B8). */
export function BookmarksPanel({ session }: { session: ReaderSession }) {
  const p = session.engine.position.value;
  const here = session.bookmarkAt(p.entryIndex);
  const chapterTitle = (id: string): string => session.book.chapters.find((c) => c.id === id)?.title ?? '';
  return (
    <Drawer title={t('reader.bookmarks')} onClose={() => (session.panel.value = null)}>
      <button type="button" class="btn btn-primary btn-block" data-autofocus onClick={() => session.toggleBookmark()}>
        <IconBookmark size={18} filled={!!here} />
        {here ? t('bookmarks.remove') : t('bookmarks.add')}
      </button>
      {session.bookmarks.value.length === 0 ? (
        <p class="empty">{t('bookmarks.empty')}</p>
      ) : (
        <ul class="bookmark-list">
          {session.bookmarks.value.map((b) => (
            <li key={b.id}>
              <button
                type="button"
                class="bookmark"
                onClick={() => {
                  session.jumpToBookmark(b);
                  session.panel.value = null;
                }}
              >
                <span class="bookmark-chapter">{chapterTitle(b.chapterId)}</span>
                <span class="bookmark-excerpt">{b.excerpt}</span>
              </button>
              <button type="button" class="icon-btn danger" aria-label={t('bookmarks.delete')} onClick={() => session.removeBookmark(b.id)}>
                <IconTrash size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Drawer>
  );
}

const HELP_ROWS: Array<[string[], MessageKey]> = [
  [['Space'], 'help.play'],
  [['←', '→'], 'help.sentence'],
  [['Shift', '← / →'], 'help.section'],
  [['↑ ↓', 'K J'], 'help.paragraph'],
  [['[ ]', '- +'], 'help.tempo'],
  [['V'], 'help.visual'],
  [['T'], 'help.textMode'],
  [['S'], 'help.subtitles'],
  [['M'], 'help.toc'],
  [['B'], 'help.bookmark'],
  [['D'], 'help.debug'],
  [['R'], 'help.regenerate'],
  [['?'], 'help.help'],
  [['Esc'], 'help.close'],
];

export function HelpPanel({ session }: { session: ReaderSession }) {
  return (
    <Drawer title={t('help.title')} onClose={() => (session.panel.value = null)}>
      <table class="help">
        <tbody>
          {HELP_ROWS.map(([keys, label]) => (
            <tr key={label}>
              <td>
                {keys.map((k) => (
                  <kbd key={k}>{k}</kbd>
                ))}
              </td>
              <td>{t(label)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Drawer>
  );
}

/** Footnote popover: opens on click/Enter, closes on Esc or outside click; playback continues (B8). */
export function FootnotePopover({ session }: { session: ReaderSession }) {
  const pop = session.popover.value;
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!pop) return;
    box.current?.focus();
    const outside = (e: PointerEvent): void => {
      if (box.current && !box.current.contains(e.target as Node) && !(e.target as Element).closest?.('[data-fn]')) session.popover.value = null;
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [pop?.footnoteId]);
  if (!pop) return null;
  let text = '';
  for (const c of session.book.chapters) for (const s of c.sections) for (const p of s.paragraphs) if (p.footnoteId === pop.footnoteId) text = p.displayText;
  const left = Math.min(Math.max(16, pop.x - 160), (globalThis.innerWidth ?? 1024) - 336);
  return (
    <div
      ref={box}
      class="popover"
      role="dialog"
      aria-label={t('reader.footnote', { label: '' }).trim()}
      tabIndex={-1}
      style={{ left: `${left}px`, top: `${pop.y + 8}px` }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          session.popover.value = null;
        }
      }}
    >
      <p>{text}</p>
      <button type="button" class="icon-btn small popover-close" aria-label={t('reader.close')} onClick={() => (session.popover.value = null)}>
        <IconClose size={16} />
      </button>
    </div>
  );
}
