import { useComputed, useSignalEffect } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import type { ReaderSession } from '../../app/session.ts';
import { route, settings, toast } from '../../app/store.ts';
import { t, type MessageKey } from '../../i18n/i18n.ts';
import { focusKind, mapKey, type Action } from '../../input/keymap.ts';
import { nextParagraph, nextSection, nextSentence, prevParagraph, prevSection, prevSentence } from '../../nav/navigation.ts';
import { TEMPO_STEP } from '../../engine/engine.ts';
import type { Settings } from '../../settings/settings.ts';
import { IconBack, IconBookmark, IconCinema, IconFocus, IconHelp, IconPage, IconRsvp, IconSentence, IconSettings, IconStage, IconSubtitles, IconToc } from '../icons.tsx';
import { AiIndicator } from './AiIndicator.tsx';
import { Controls, setTempo, setWpm, WPM_STEP } from './Controls.tsx';
import { Notices } from './Notices.tsx';
import { BookmarksPanel, FootnotePopover, HelpPanel, TocPanel } from './Panels.tsx';
import { SettingsPanel } from './SettingsPanel.tsx';
import { StagePanel } from './StagePanel.tsx';
import { RsvpView, SentenceView } from './Subtitles.tsx';
import { TextPane } from './TextPane.tsx';

const LAYOUTS: Array<{ id: Settings['layout']; icon: typeof IconStage; label: MessageKey }> = [
  { id: 'stage', icon: IconStage, label: 'reader.layout.stage' },
  { id: 'cinema', icon: IconCinema, label: 'reader.layout.cinema' },
  { id: 'sentence', icon: IconSentence, label: 'reader.layout.sentence' },
  { id: 'rsvp', icon: IconRsvp, label: 'reader.layout.rsvp' },
  { id: 'page', icon: IconPage, label: 'reader.layout.page' },
  { id: 'focus', icon: IconFocus, label: 'reader.layout.focus' },
];

let lastLayout: Settings['layout'] = 'stage';

/** Runs a keyboard action (B8). Returns false when the action does not apply. */
export function dispatch(session: ReaderSession, action: Action): boolean {
  const tl = session.timeline;
  const p = session.engine.position.value;
  switch (action) {
    case 'toggle-play':
      if (session.engine.silent && !session.pacerMode) return false;
      session.togglePlay();
      return true;
    case 'prev-sentence':
      session.navigate(prevSentence(tl, p));
      return true;
    case 'next-sentence':
      session.navigate(nextSentence(tl, p));
      return true;
    case 'prev-section':
      session.navigate(prevSection(tl, p));
      return true;
    case 'next-section':
      session.navigate(nextSection(tl, p));
      return true;
    case 'prev-paragraph':
      session.navigate(prevParagraph(tl, p));
      return true;
    case 'next-paragraph':
      session.navigate(nextParagraph(tl, p));
      return true;
    case 'tempo-down':
      if (session.pacerMode) setWpm(settings.value.rsvpWpm - WPM_STEP);
      else setTempo(session, settings.value.tempo - TEMPO_STEP);
      return true;
    case 'tempo-up':
      if (session.pacerMode) setWpm(settings.value.rsvpWpm + WPM_STEP);
      else setTempo(session, settings.value.tempo + TEMPO_STEP);
      return true;
    case 'cycle-visual': {
      const mode = session.cycleVisual();
      if (mode) toast(`${t('reader.visual')}: ${t(`reader.visual.${mode}` as MessageKey)}`, 'info', 1800);
      return true;
    }
    case 'toggle-text-mode': {
      const layout = settings.value.layout;
      if (layout !== 'focus') lastLayout = layout;
      settings.value = { ...settings.value, layout: layout === 'focus' ? lastLayout : 'focus' };
      return true;
    }
    case 'toggle-subtitles':
      settings.value = { ...settings.value, subtitles: !settings.value.subtitles };
      toast(settings.value.subtitles ? t('reader.subtitlesOn') : t('reader.subtitlesOff'), 'info', 1800);
      return true;
    case 'open-toc':
      session.panel.value = 'toc';
      return true;
    case 'toggle-bookmark': {
      const added = session.toggleBookmark();
      toast(added ? t('bookmarks.add') : t('bookmarks.remove'), 'info', 1800);
      return true;
    }
    case 'toggle-debug':
      session.debug.value = !session.debug.value;
      return true;
    case 'regenerate': {
      const sectionId = session.sectionIdAt(p.entryIndex);
      if (!session.ai || !sectionId) {
        toast(t('ai.unavailable'), 'info', 2400);
        return true;
      }
      toast(t('ai.regenerating'), 'info', 1800);
      void session.ai.regenerate(sectionId);
      return true;
    }
    case 'open-help':
      session.panel.value = 'help';
      return true;
    case 'close':
      if (session.popover.value) session.popover.value = null;
      else if (session.panel.value) session.panel.value = null;
      else if (session.debug.value) session.debug.value = false;
      else return false;
      return true;
  }
}

/** The reader (B7–B9): top bar, stage, text, controls, panels. */
export function Reader({ session }: { session: ReaderSession }) {
  const layout = settings.value.layout;

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const action = mapKey(e, {
        focus: focusKind(document.activeElement),
        modalOpen: session.panel.value !== null || session.popover.value !== null,
      });
      if (action && dispatch(session, action)) e.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [session]);

  useEffect(() => () => session.dispose(), [session]);

  // One frame clock for every view: advances the estimated word for voices without word
  // boundaries even when no stage is shown (the stage samples the same engine clock).
  useEffect(() => {
    let raf = 0;
    const loop = (): void => {
      if (session.engine.playing.value) session.engine.frame(session.env.timers.now());
      session.ai?.tick();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [session]);

  // Save the position on every sentence change and when the page is hidden (B6), in every view.
  const entryIndex = useComputed(() => session.engine.position.value.entryIndex);
  useSignalEffect(() => {
    void entryIndex.value;
    void session.savePosition();
  });
  useEffect(() => {
    const save = (): void => void session.savePosition();
    addEventListener('pagehide', save);
    return () => removeEventListener('pagehide', save);
  }, [session]);

  const p = session.engine.position.value;
  const entry = session.timeline.entries[p.entryIndex];
  const chapter = session.book.chapters.find((c) => c.id === entry?.chapterId);
  const marked = !!session.bookmarkAt(p.entryIndex);
  const panel = session.panel.value;

  return (
    <div class="reader" data-layout={layout}>
      <header class="topbar">
        <button
          type="button"
          class="icon-btn"
          aria-label={t('reader.library')}
          title={t('reader.library')}
          onClick={() => {
            session.dispose();
            route.value = { name: 'start' };
          }}
        >
          <IconBack />
        </button>
        <div class="topbar-title">
          <span class="topbar-book">{session.book.title}</span>
          {chapter?.title && chapter.title !== session.book.title ? <span class="topbar-chapter">{chapter.title}</span> : null}
        </div>
        <AiIndicator session={session} />
        <div class="topbar-actions">
          <select class="layout-picker hide-narrow" aria-label={t('reader.layout')} value={layout} onChange={(e) => (settings.value = { ...settings.value, layout: e.currentTarget.value as Settings['layout'] })}>
            {LAYOUTS.map(({ id, label }) => <option key={id} value={id}>{t(label)}</option>)}
          </select>
          {layout === 'stage' ? (
            <button
              type="button"
              class={settings.value.subtitles ? 'icon-btn is-active hide-narrow' : 'icon-btn hide-narrow'}
              aria-label={t('reader.subtitles')}
              aria-pressed={settings.value.subtitles}
              title={`${t('reader.subtitles')} (S)`}
              onClick={() => dispatch(session, 'toggle-subtitles')}
            >
              <IconSubtitles />
            </button>
          ) : null}
          <button type="button" class="icon-btn" aria-label={t('reader.toc')} title={`${t('reader.toc')} (M)`} onClick={() => (session.panel.value = 'toc')}>
            <IconToc />
          </button>
          <button type="button" class={marked ? 'icon-btn is-active' : 'icon-btn'} aria-label={t('reader.bookmarks')} title={`${t('reader.bookmarks')} (B)`} onClick={() => (session.panel.value = 'bookmarks')}>
            <IconBookmark filled={marked} />
          </button>
          <button type="button" class="icon-btn" aria-label={t('reader.settings')} title={t('reader.settings')} onClick={() => (session.panel.value = 'settings')}>
            <IconSettings />
          </button>
          <button type="button" class="icon-btn hide-narrow" aria-label={t('reader.help')} title={`${t('reader.help')} (?)`} onClick={() => (session.panel.value = 'help')}>
            <IconHelp />
          </button>
        </div>
      </header>

      <Notices session={session} />

      <main class="reader-main">
        {layout === 'stage' || layout === 'cinema' ? <StagePanel session={session} subtitles={layout === 'cinema' || settings.value.subtitles} /> : null}
        {layout === 'sentence' ? <SentenceView session={session} /> : null}
        {layout === 'rsvp' ? <RsvpView session={session} variant="view" /> : null}
        {layout === 'stage' || layout === 'page' || layout === 'focus' ? <TextPane session={session} /> : null}
      </main>

      <Controls session={session} />

      {panel === 'toc' ? <TocPanel session={session} /> : null}
      {panel === 'bookmarks' ? <BookmarksPanel session={session} /> : null}
      {panel === 'settings' ? <SettingsPanel session={session} /> : null}
      {panel === 'help' ? <HelpPanel session={session} /> : null}
      <FootnotePopover session={session} />
    </div>
  );
}
