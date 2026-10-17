import { primaryLanguage } from '@lesebuehne/core';
import type { ReaderSession } from '../../app/session.ts';
import { settings } from '../../app/store.ts';
import { t, type MessageKey } from '../../i18n/i18n.ts';
import { IconClose } from '../icons.tsx';

export type NoticeKind = 'silent' | 'noVoice' | 'estimated' | 'basicLanguage' | 'notSaved';

export interface NoticeView {
  kind: NoticeKind;
  text: string;
  /** Show a link to the voice setting. */
  voiceLink?: boolean;
  dismissible?: boolean;
}

/** The notices of a reader session (B3, B6, B7). */
export function readerNotices(session: ReaderSession): NoticeView[] {
  const out: NoticeView[] = [];
  const choice = session.voiceChoice.value;
  if (session.engine.silent) out.push({ kind: 'silent', text: t('notice.silent') });
  else if (choice.mode === 'voice' && !choice.matched) {
    const key = `lang.${primaryLanguage(session.book.language)}` as MessageKey;
    const language = key === 'lang.de' || key === 'lang.en' ? t(key) : session.book.language;
    out.push({ kind: 'noVoice', text: t('notice.noVoice', { language, voice: choice.voice.name }), voiceLink: true });
  }
  const voice = session.engine.currentVoice;
  if (!session.engine.silent && session.engine.estimated.value && voice && !settings.value.dismissedHints.includes(voice.voiceURI)) {
    out.push({ kind: 'estimated', text: t('notice.estimated'), voiceLink: true, dismissible: true });
  }
  if (session.basicLanguage) out.push({ kind: 'basicLanguage', text: t('notice.basicLanguage') });
  if (!session.saved) out.push({ kind: 'notSaved', text: t('notice.notSaved') });
  return out;
}

export function Notices({ session }: { session: ReaderSession }) {
  const notices = readerNotices(session);
  if (notices.length === 0) return null;
  return (
    <div class="notices" role="status">
      {notices.map((n) => (
        <div key={n.kind} class={`notice notice-${n.kind}`} data-notice={n.kind}>
          <span>{n.text}</span>
          {n.voiceLink ? (
            <button
              type="button"
              class="link-btn"
              onClick={() => {
                session.settingsTab.value = 'reading';
                session.panel.value = 'settings';
                queueMicrotask(() => document.getElementById('settings-voice')?.scrollIntoView?.({ block: 'start' }));
              }}
            >
              {t('notice.voiceSettings')}
            </button>
          ) : null}
          {n.dismissible ? (
            <button
              type="button"
              class="icon-btn small"
              aria-label={t('notice.dismiss')}
              onClick={() => {
                const v = session.engine.currentVoice;
                if (v) settings.value = { ...settings.value, dismissedHints: [...settings.value.dismissedHints, v.voiceURI] };
              }}
            >
              <IconClose size={14} />
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
