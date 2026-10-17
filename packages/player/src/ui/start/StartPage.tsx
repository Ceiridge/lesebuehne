import { parseSamples, type Sample } from '@lesebuehne/ingest';
import { useSignal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import { aiConnecting, aiPrefs } from '../../ai/connect.ts';
import { aiStatus } from '../../ai/state.ts';
import { useEnv } from '../../app/env.ts';
import { showStaticHint, STATIC_HINT_KEY } from '../../app/static-hint.ts';
import { ReaderSession } from '../../app/session.ts';
import { route, settings, toast } from '../../app/store.ts';
import { fileBytes, importBook, needsLanguage, type ImportRequest } from '../../import/import-service.ts';
import { t, type MessageKey } from '../../i18n/i18n.ts';
import type { LibraryService } from '../../storage/library.ts';
import type { LibraryEntry } from '../../storage/repository.ts';
import { IconBook, IconLogo, IconTrash, IconUpload } from '../icons.tsx';
import { AiSettings } from '../reader/AiSettings.tsx';
import { Drawer } from '../reader/Panels.tsx';
import { QuickPrefs } from './QuickPrefs.tsx';

export const LAST_BOOK_KEY = 'lesebuehne.lastBook';

const LANG_KEY: Record<string, MessageKey> = { de: 'lang.de', en: 'lang.en' };
const langName = (lang: string): string => {
  const key = LANG_KEY[lang.slice(0, 2).toLowerCase()];
  return key ? t(key) : lang;
};

interface PendingFile {
  fileName: string;
  bytes: Uint8Array;
}

/** Start page (B6, B11): samples, library, import by picker or drag & drop. */
export function StartPage() {
  const env = useEnv();
  const library = useSignal<LibraryService | null>(null);
  const books = useSignal<LibraryEntry[]>([]);
  const samples = useSignal<Sample[]>([]);
  const busy = useSignal(false);
  const dragging = useSignal(false);
  const pending = useSignal<PendingFile | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const hintDismissed = useSignal(env.kv.get(STATIC_HINT_KEY) === '1');
  const aiOpen = useSignal(false);

  const refresh = async (lib: LibraryService): Promise<void> => {
    books.value = await lib.list();
  };

  useEffect(() => {
    let alive = true;
    void env.library().then(async (lib) => {
      if (!alive) return;
      library.value = lib;
      if (!lib.persistent) toast(t('notice.storageUnavailable'), 'info', 9000);
      await refresh(lib);
    });
    void env
      .fetch(new URL('samples/samples.json', env.baseURI()).href)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((json) => {
        if (alive) samples.value = parseSamples(json).samples;
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const open = async (req: ImportRequest): Promise<void> => {
    const lib = library.value ?? (await env.library());
    busy.value = true;
    try {
      const result = await importBook(lib, req);
      if (!result.ok) {
        toast(t(`error.${result.code}` as MessageKey), 'error');
        return;
      }
      if (!result.outcome.saved) toast(t('notice.notSaved'), 'info', 9000);
      const session = await ReaderSession.open(env, lib, result.bundle, { saved: result.outcome.saved, basicLanguage: result.basicLanguage });
      env.kv.set(LAST_BOOK_KEY, result.bundle.book.id);
      route.value = { name: 'reader', session };
    } finally {
      busy.value = false;
    }
  };

  const openStored = async (entry: LibraryEntry): Promise<void> => {
    const lib = library.value;
    if (!lib) return;
    const bundle = await lib.get(entry.bookId);
    if (!bundle) return;
    const session = await ReaderSession.open(env, lib, bundle, { saved: lib.persistent, basicLanguage: entry.languageSupport === 'basic' });
    env.kv.set(LAST_BOOK_KEY, entry.bookId);
    route.value = { name: 'reader', session };
  };

  const remove = async (entry: LibraryEntry): Promise<void> => {
    const lib = library.value;
    if (!lib || !confirm(t('start.deleteConfirm', { title: entry.title }))) return;
    await lib.delete(entry.bookId);
    await refresh(lib);
  };

  const openSample = async (s: Sample): Promise<void> => {
    try {
      const r = await env.fetch(new URL(`samples/${s.file}`, env.baseURI()).href);
      if (!r.ok) throw new Error(String(r.status));
      await open({ fileName: s.file, bytes: new Uint8Array(await r.arrayBuffer()), language: s.language, title: s.title });
    } catch {
      toast(t('error.generic'), 'error');
    }
  };

  const accept = async (file: File): Promise<void> => {
    const bytes = await fileBytes(file);
    if (needsLanguage(file.name, bytes)) pending.value = { fileName: file.name, bytes };
    else await open({ fileName: file.name, bytes });
  };

  const onDrop = (e: DragEvent): void => {
    e.preventDefault();
    dragging.value = false;
    const file = e.dataTransfer?.files?.[0];
    if (file) void accept(file);
  };

  const lastId = env.kv.get(LAST_BOOK_KEY);
  const last = books.value.find((b) => b.bookId === lastId);

  return (
    <div
      class={dragging.value ? 'start is-dragging' : 'start'}
      onDragOver={(e) => {
        e.preventDefault();
        dragging.value = true;
      }}
      onDragLeave={(e) => {
        if (e.relatedTarget === null) dragging.value = false;
      }}
      onDrop={onDrop}
    >
      <header class="start-header">
        <div class="brand">
          <span class="brand-mark">
            <IconLogo size={28} />
          </span>
          <h1>{t('app.title')}</h1>
        </div>
        <QuickPrefs />
      </header>

      <main class="start-main">
        <p class="tagline">{t('app.tagline')}</p>

        {showStaticHint({ known: !!aiPrefs.value, connecting: aiConnecting.value, mode: aiStatus.value.mode, aiOff: aiPrefs.value?.mode === 'off', dismissed: hintDismissed.value }) ? (
          <section class="static-hint" role="note">
            <p>{t('start.staticHint')}</p>
            <div class="static-hint-actions">
              <button type="button" class="btn btn-primary small" onClick={() => (aiOpen.value = true)}>
                {t('start.staticSetup')}
              </button>
              <button
                type="button"
                class="btn btn-ghost small"
                onClick={() => {
                  env.kv.set(STATIC_HINT_KEY, '1');
                  hintDismissed.value = true;
                }}
              >
                {t('start.staticDismiss')}
              </button>
            </div>
          </section>
        ) : null}

        {last ? (
          <section class="continue" aria-label={t('start.open')}>
            <button type="button" class="continue-card" onClick={() => void openStored(last)}>
              <span class="continue-label">{t('start.lastRead')}</span>
              <span class="continue-title">{last.title}</span>
              {last.author ? <span class="continue-author">{last.author}</span> : null}
            </button>
          </section>
        ) : null}

        <section class="start-grid">
          <div class="dropzone" role="group" aria-label={t('start.import')}>
            <IconUpload size={30} />
            <h2>{t('start.import')}</h2>
            <p>{t('start.importHint')}</p>
            <p class="dropzone-formats">{t('start.formats')}</p>
            <button type="button" class="btn btn-primary" disabled={busy.value} onClick={() => fileInput.current?.click()}>
              {busy.value ? t('start.importing') : t('start.chooseFile')}
            </button>
            <input
              ref={fileInput}
              type="file"
              class="visually-hidden"
              accept=".epub,.txt,.md,.markdown,text/plain,text/markdown,application/epub+zip"
              aria-label={t('start.chooseFile')}
              onChange={(e) => {
                const input = e.currentTarget;
                const file = input.files?.[0];
                if (file) void accept(file);
                input.value = '';
              }}
            />
          </div>

          {samples.value.length > 0 ? (
            <div class="samples">
              <h2 class="section-title">{t('start.samples')}</h2>
              <ul class="card-list">
                {samples.value.map((s) => (
                  <li key={s.id}>
                    <button type="button" class="book-card is-sample" disabled={busy.value} onClick={() => void openSample(s)}>
                      <span class="book-cover" data-lang={s.language} aria-hidden="true">
                        <IconBook size={22} />
                      </span>
                      <span class="book-meta">
                        <span class="book-title">{s.title}</span>
                        <span class="book-author">{s.author}</span>
                        <span class="book-tags">
                          <span class="tag">{t('start.sampleBadge')}</span>
                          <span class="tag">{langName(s.language)}</span>
                          <span class="tag">{s.format.toUpperCase()}</span>
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>

        <section class="library" aria-labelledby="library-title">
          <h2 id="library-title" class="section-title">
            {t('start.library')}
          </h2>
          {books.value.length === 0 ? (
            <p class="empty">{t('start.libraryEmpty')}</p>
          ) : (
            <ul class="card-list library-list">
              {books.value.map((b) => (
                <li key={b.bookId} class="library-item">
                  <button type="button" class="book-card" onClick={() => void openStored(b)}>
                    <span class="book-cover" data-lang={b.language.slice(0, 2)} aria-hidden="true">
                      <IconBook size={22} />
                    </span>
                    <span class="book-meta">
                      <span class="book-title">{b.title}</span>
                      {b.author ? <span class="book-author">{b.author}</span> : null}
                      <span class="book-tags">
                        <span class="tag">{langName(b.language)}</span>
                        <span class="tag">{b.format.toUpperCase()}</span>
                        <span class="tag tag-quiet">{new Date(b.importedAt).toLocaleDateString(settings.value.uiLanguage === 'en' ? 'en' : undefined)}</span>
                      </span>
                    </span>
                  </button>
                  <button type="button" class="icon-btn danger" aria-label={`${t('start.delete')}: ${b.title}`} title={t('start.delete')} onClick={() => void remove(b)}>
                    <IconTrash size={18} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>

      {dragging.value ? (
        <div class="drop-overlay" aria-hidden="true">
          <IconUpload size={42} />
          <span>{t('start.dropHere')}</span>
        </div>
      ) : null}

      {aiOpen.value ? <AiDialog onClose={() => (aiOpen.value = false)} /> : null}

      {pending.value ? (
        <LanguagePrompt
          fileName={pending.value.fileName}
          onCancel={() => (pending.value = null)}
          onChoose={(language) => {
            const p = pending.value;
            pending.value = null;
            if (p) void open({ ...p, language });
          }}
        />
      ) : null}
    </div>
  );
}

/** AI settings without an open book (spec 006 B5). */
function AiDialog({ onClose }: { onClose: () => void }) {
  return (
    <Drawer title={t('start.aiTitle')} onClose={onClose} wide><div class="standalone-ai"><AiSettings /></div></Drawer>
  );
}

/** Language choice at import (B3): German / English, default German. */
function LanguagePrompt({ fileName, onChoose, onCancel }: { fileName: string; onChoose: (lang: string) => void; onCancel: () => void }) {
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => first.current?.focus(), []);
  return (
    <div class="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onCancel()}>
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="lang-title" onKeyDown={(e) => e.key === 'Escape' && onCancel()}>
        <h2 id="lang-title">{t('start.languagePrompt', { file: fileName })}</h2>
        <div class="modal-actions">
          <button ref={first} type="button" class="btn btn-primary" onClick={() => onChoose('de')}>
            {t('start.languageDe')}
          </button>
          <button type="button" class="btn" onClick={() => onChoose('en')}>
            {t('start.languageEn')}
          </button>
          <button type="button" class="btn btn-ghost" onClick={onCancel}>
            {t('start.cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}
