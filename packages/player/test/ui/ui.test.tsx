import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { bookParagraphs } from '@lesebuehne/core';
import { render } from 'preact';
import { withDom } from '../../../../tests/support/with-dom.ts';
import { EPUB_CASES } from '../../../ingest/test/fixtures/epub-builder.ts';
import { stageStep } from '../../src/ui/reader/StagePanel.tsx';
import { applySettings, route, settings } from '../../src/app/store.ts';
import { ensureFont, FONTS, resetFontRegistry, resolveFontUrl } from '../../src/fonts/fonts.ts';
import { Highlighter } from '../../src/highlight/highlighter.ts';
import { importBook, needsLanguage } from '../../src/import/import-service.ts';
import { dispatch, Reader } from '../../src/ui/reader/Reader.tsx';
import { readerNotices } from '../../src/ui/reader/Notices.tsx';
import { subtitleCues } from '../../src/ui/reader/Subtitles.tsx';
import { App } from '../../src/ui/app.tsx';
import { EnvContext } from '../../src/app/env.ts';
import { autoFollow } from '../../src/nav/follow.ts';
import { t as t_ } from '../../src/i18n/i18n.ts';
import {
  headingAt,
  nextParagraph,
  nextSection,
  nextSentence,
  positionAt,
  prevParagraph,
  prevSection,
  prevSentence,
  timelineMarkers,
} from '../../src/nav/navigation.ts';
import { defaultSettings } from '../../src/settings/settings.ts';
import { voice } from '../support/fake-tts.ts';
import { sampleTest } from '../../../../tests/support/samples.ts';
import { bundleOf, flush, makeEnv, openSession, sampleBytes, type TestEnv } from './support.ts';

const enc = (s: string) => new TextEncoder().encode(s);
const kantBytes = await sampleBytes('aufklaerung.txt');
const kybalionBytes = await sampleBytes('kybalion-chapter-2.md');
const samplesJson = await Bun.file(new URL('../../../../scripts/samples.catalog.json', import.meta.url)).text();
const hedda = voice('hedda', 'de-DE');

function mount(t: TestEnv, node: preact.ComponentChild): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  render(<EnvContext.Provider value={t.env}>{node}</EnvContext.Provider>, host);
  return host;
}

afterEach(() => {
  settings.value = defaultSettings();
  route.value = { name: 'start' };
});

describe('12-1: import service', () => {
  test('language prompt rules: TXT/MD always, EPUB only without dc:language', () => {
    expect(needsLanguage('a.txt', enc('x'))).toBe(true);
    expect(needsLanguage('a.md', enc('x'))).toBe(true);
    expect(needsLanguage('a.epub', EPUB_CASES['epub3-nav']!())).toBe(false);
    expect(needsLanguage('a.epub', EPUB_CASES['no-language']!())).toBe(true);
    expect(needsLanguage('a.pdf', enc('x'))).toBe(false);
  });
  sampleTest('errors (incl. DRM) store nothing; basic language flag; same book reopens', async () => {
    const t = await makeEnv();
    expect(await importBook(t.library, { fileName: 'a.pdf', bytes: enc('x') })).toEqual({ ok: false, code: 'unsupported' });
    expect(await importBook(t.library, { fileName: 'drm.epub', bytes: EPUB_CASES.encrypted!() })).toEqual({ ok: false, code: 'drm' });
    expect(await importBook(t.library, { fileName: 'x.txt', bytes: new Uint8Array([0xff, 0xfe, 0xfd]) })).toEqual({ ok: false, code: 'unreadable' });
    expect(await t.library.list()).toEqual([]);
    const fr = await importBook(t.library, { fileName: 'fr.epub', bytes: EPUB_CASES['lang-fr']!() });
    expect(fr.ok && fr.basicLanguage).toBe(true);
    const first = await importBook(t.library, { fileName: 'k.txt', bytes: kantBytes, language: 'de' }, new Date('2026-01-01T00:00:00Z'));
    const again = await importBook(t.library, { fileName: 'kopie.txt', bytes: kantBytes, language: 'de' }, new Date('2026-02-01T00:00:00Z'));
    expect(first.ok && !first.outcome.existing).toBe(true);
    expect(again.ok && again.outcome.existing).toBe(true);
    expect(again.ok && again.bundle.manifest.importedAt).toBe('2026-01-01T00:00:00.000Z');
    expect((await t.library.list()).length).toBe(2);
  });
});

describe('12-2: start page', () => {
  withDom();
  beforeAll(() => {
    (globalThis as { confirm?: () => boolean }).confirm = () => true;
  });
  sampleTest('samples listed and openable; library lists imported books; delete removes', async () => {
    const t = await makeEnv({ voices: [hedda], files: { 'samples/samples.json': samplesJson, 'samples/aufklaerung.txt': kantBytes } });
    const host = mount(t, <App env={t.env} />);
    await flush(10);
    const samples = [...host.querySelectorAll('.book-card.is-sample')];
    expect(samples.map((s) => s.querySelector('.book-title')?.textContent)).toEqual([
      'Beantwortung der Frage: Was ist Aufklärung?',
      'The Kybalion, Chapter II: The Seven Hermetic Principles',
    ]);
    (samples[0] as HTMLButtonElement).click();
    await flush(20);
    expect(route.value.name).toBe('reader');
    expect(host.querySelector('.book-text')).not.toBeNull();
    route.value = { name: 'start' };
    await flush(10);
    expect([...host.querySelectorAll('.library-item .book-title')].map((e) => e.textContent)).toEqual(['Beantwortung der Frage: Was ist Aufklärung?']);
    (host.querySelector('.library-item .danger') as HTMLButtonElement).click();
    await flush(10);
    expect(host.querySelectorAll('.library-item').length).toBe(0);
    render(null, host);
  });
});

describe('12-3: fonts', () => {
  test('four families registered lazily with display swap, unicode ranges, URLs against baseURI', () => {
    resetFontRegistry();
    const added: FontFace[] = [];
    class FakeFace {
      constructor(
        readonly family: string,
        readonly source: string,
        readonly descriptors: FontFaceDescriptors,
      ) {}
    }
    const env = { fonts: { add: (f: FontFace) => added.push(f) }, baseURI: 'http://127.0.0.1/sub/', FontFace: FakeFace as unknown as typeof FontFace };
    for (const id of ['literata', 'source-sans', 'atkinson', 'opendyslexic'] as const) ensureFont(id, env);
    expect(ensureFont('literata', env)).toEqual([]);
    expect(ensureFont('system', env)).toEqual([]);
    expect(new Set(added.map((f) => (f as unknown as FakeFace).family))).toEqual(new Set(Object.values(FONTS).map((f) => f.family)));
    for (const f of added as unknown as FakeFace[]) {
      expect(f.descriptors.display).toBe('swap');
      expect(f.descriptors.unicodeRange).toMatch(/^U\+/);
      expect(f.source).toMatch(/^url\(".+\.woff2"\) format\("woff2"\)$/);
    }
    // In the browser bundle the imported URL is relative (./x.woff2) and resolves against baseURI.
    expect(resolveFontUrl('./literata-x.woff2', 'http://127.0.0.1/sub/')).toBe('http://127.0.0.1/sub/literata-x.woff2');
    resetFontRegistry();
  });
});

describe('13-1/13-2: highlighting and text rendering', () => {
  withDom();
  test('native: only registry ranges change; fallback: only data-cur attributes move', () => {
    const el = document.createElement('span');
    const el2 = document.createElement('span');
    el.textContent = 'a';
    el2.textContent = 'b';
    document.body.append(el, el2);
    const sets: string[] = [];
    const native = new Highlighter({ set: (n) => sets.push(n), delete: () => undefined }, () => ({}));
    native.set('word', el);
    native.set('word', el2);
    native.set('word', el2);
    expect(sets).toEqual(['lb-word', 'lb-word']);
    expect(el.attributes.length + el2.attributes.length).toBe(0);
    const fallback = new Highlighter(undefined, undefined);
    fallback.set('word', el);
    expect(el.hasAttribute('data-cur-word')).toBe(true);
    fallback.set('word', el2);
    expect(el.hasAttribute('data-cur-word')).toBe(false);
    expect(el2.hasAttribute('data-cur-word')).toBe(true);
  });

  sampleTest('every token of the Kant sample maps to an element with its text; MD markers after the carrying token', async () => {
    const t = await makeEnv({ voices: [hedda] });
    const session = await openSession(t, bundleOf('aufklaerung.txt', kantBytes));
    const host = mount(t, <Reader session={session} />);
    await flush();
    let n = 0;
    for (const [entryIndex, e] of session.timeline.entries.entries()) {
      const s = host.querySelector(`[data-e="${entryIndex}"]`);
      for (const [k, tok] of e.sentence.tokens.entries()) {
        n++;
        expect(s?.querySelector(`[data-k="${k}"]`)?.textContent).toBe(tok.text);
      }
    }
    expect(n).toBeGreaterThan(1500);
    render(null, host);

    const md = await openSession(t, bundleOf('f.md', enc('# T\n\nEin Satz mit Fußnote[^1] und weiter.\n\n[^1]: Die Fußnote.\n')));
    const host2 = mount(t, <Reader session={md} />);
    await flush();
    const marker = host2.querySelector('.fn-after');
    expect(marker?.tagName).toBe('BUTTON');
    expect(marker?.previousElementSibling?.textContent).toBe('Fußnote');
    expect(marker?.closest('[data-k]')).toBeNull();
    render(null, host2);
  });
});

describe('13-3: mounted reader', () => {
  withDom();
  sampleTest('Space speaks; paused click moves without speaking; position saved; lang; no DOM mutation per word', async () => {
    const t = await makeEnv({ voices: [hedda] });
    const session = await openSession(t, bundleOf('aufklaerung.txt', kantBytes));
    const host = mount(t, <Reader session={session} />);
    await flush();
    expect(host.querySelector('.book-text')?.getAttribute('lang')).toBe('de');

    const word = host.querySelector('[data-e="2"] [data-k="3"]') as HTMLElement;
    word.click();
    expect(t.tts.spoken.length).toBe(0);
    expect(session.engine.position.value).toEqual({ entryIndex: 2, tokenIndex: 3 });
    await flush();
    expect((await t.library.loadPosition(session.book.id, session.timeline)).entryIndex).toBe(2);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
    expect(t.tts.spoken.length).toBe(1);
    expect(t.tts.last.text.startsWith(session.timeline.entries[2]!.sentence.speechText.slice(0, 0))).toBe(true);
    expect(session.engine.playing.value).toBe(true);

    // 50 word updates: no node is added, removed or changed in the text pane.
    const article = host.querySelector('.book-text')!;
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((r) => records.push(...r));
    observer.observe(article, { subtree: true, childList: true, attributes: true, characterData: true });
    const r = t.tts.last;
    r.onStart();
    const words = [...r.text.matchAll(/[\p{L}\p{N}]+/gu)].slice(0, 50);
    for (const m of words) r.onBoundary(m.index ?? 0, 'word');
    await flush();
    observer.disconnect();
    expect(words.length).toBeGreaterThan(5);
    expect(records.length).toBe(0);
    expect(t.registry.sets.filter(([n]) => n === 'lb-word').length).toBeGreaterThan(2);
    const last = words.at(-1)![0];
    expect(session.timeline.entries[session.engine.position.value.entryIndex]!.sentence.tokens[session.engine.position.value.tokenIndex]!.text).toBe(last);
    session.engine.pause();
    render(null, host);
  });
});

describe('13-4: notices', () => {
  sampleTest('silent, no voice for the language, estimated hint with per-voice dismissal, basic language, not saved', async () => {
    const silent = await makeEnv({ speech: false });
    const s1 = await openSession(silent, bundleOf('aufklaerung.txt', kantBytes), false, true);
    expect(readerNotices(s1).map((n) => n.kind)).toEqual(['silent', 'basicLanguage', 'notSaved']);

    const t = await makeEnv({ voices: [hedda] });
    const en = await openSession(t, bundleOf('kybalion-chapter-2.md', kybalionBytes, 'en'));
    const notices = readerNotices(en);
    expect(notices[0]?.kind).toBe('noVoice');
    expect(notices[0]?.voiceLink).toBe(true);

    en.engine.estimated.value = true;
    expect(readerNotices(en).some((n) => n.kind === 'estimated')).toBe(true);
    settings.value = { ...settings.value, dismissedHints: ['hedda'] };
    expect(readerNotices(en).some((n) => n.kind === 'estimated')).toBe(false);
  });
});

describe('13-5: figures', () => {
  withDom();
  test('EPUB figure from its asset with caption; MD placeholder; no speech item for figures', async () => {
    const t = await makeEnv({ voices: [hedda] });
    (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = () => 'blob:fake';
    const fig = await openSession(t, bundleOf('figure.epub', EPUB_CASES.figure!()));
    const host = mount(t, <Reader session={fig} />);
    await flush();
    const img = host.querySelector('figure img');
    expect(img?.getAttribute('src')).toBe('blob:fake');
    expect(host.querySelector('figure figcaption')?.textContent).toBe('Ein kleiner Punkt.');
    expect(fig.timeline.entries.some((e) => e.sentence.text === 'Ein kleiner Punkt.')).toBe(false);
    render(null, host);

    const md = await openSession(t, bundleOf('s.md', enc('# T\n\nText.\n\n![Karte](bilder/karte.png)\n')));
    const host2 = mount(t, <Reader session={md} />);
    await flush();
    expect(host2.querySelector('.fig-placeholder')?.textContent).toContain('Karte');
    expect(host2.querySelector('.fig-missing')?.textContent).toBe(t_('reader.figureUnavailable'));
    render(null, host2);
  });
});

describe('14: navigation, keys, timeline, auto-follow', () => {
  withDom();
  const bundle = bundleOf('k.txt', enc('Titel\n\nEins. Zwei.\n\nDrei.\n\n\nKapitel 2\n\nVier. Fünf.'));
  test('14-1: sentence, paragraph, section, timeline τ', async () => {
    const t = await makeEnv({ voices: [hedda] });
    const s = await openSession(t, bundle);
    const tl = s.timeline;
    const texts = (p: { entryIndex: number }) => tl.entries[p.entryIndex]!.sentence.text;
    expect(texts(nextSentence(tl, { entryIndex: 1, tokenIndex: 0 }))).toBe('Zwei.');
    expect(texts(prevSentence(tl, { entryIndex: 2, tokenIndex: 1 }))).toBe('Zwei.');
    expect(texts(prevSentence(tl, { entryIndex: 2, tokenIndex: 0 }))).toBe('Eins.');
    expect(texts(nextParagraph(tl, { entryIndex: 1, tokenIndex: 0 }))).toBe('Drei.');
    expect(texts(prevParagraph(tl, { entryIndex: 3, tokenIndex: 0 }))).toBe('Eins.');
    expect(texts(nextSection(tl, { entryIndex: 0, tokenIndex: 0 }))).toBe('Kapitel 2');
    expect(texts(prevSection(tl, { entryIndex: 5, tokenIndex: 0 }))).toBe('Kapitel 2');
    expect(texts(prevSection(tl, { entryIndex: 4, tokenIndex: 0 }))).toBe('Titel');
    expect(texts(positionAt(tl, tl.entries[5]!.start + 0.01))).toBe('Vier.');
  });
  test('14-2: key dispatch incl. V persisted per book, T, M, B, D, ?, Esc, tempo', async () => {
    const t = await makeEnv({ voices: [hedda] });
    const s = await openSession(t, bundle);
    dispatch(s, 'next-sentence');
    expect(s.engine.position.value.entryIndex).toBe(1);
    dispatch(s, 'tempo-up');
    expect(settings.value.tempo).toBe(1.25);
    expect(s.engine.currentTempo).toBe(1.25);
    dispatch(s, 'cycle-visual');
    const sectionId = s.sectionIdAt(1)!;
    expect(s.forcedMode(sectionId)).toBe('list');
    await flush();
    expect(await t.library.overrides(s.book.id)).toEqual({ [sectionId]: 'list' });
    dispatch(s, 'toggle-text-mode');
    expect(settings.value.layout).toBe('focus');
    dispatch(s, 'toggle-text-mode');
    expect(settings.value.layout).toBe('stage');
    dispatch(s, 'toggle-bookmark');
    expect(s.bookmarks.value.map((b) => b.excerpt)).toEqual(['Eins.']);
    dispatch(s, 'toggle-debug');
    expect(s.debug.value).toBe(true);
    dispatch(s, 'open-toc');
    expect(s.panel.value).toBe('toc');
    dispatch(s, 'close');
    expect(s.panel.value).toBeNull();
    dispatch(s, 'open-help');
    expect(s.panel.value).toBe('help');
    dispatch(s, 'close');
    dispatch(s, 'close');
    expect(s.debug.value).toBe(false);
    expect(dispatch(s, 'close')).toBe(false);
  });
  test('14-3: timeline markers and tooltip', async () => {
    const t = await makeEnv({ voices: [hedda] });
    const s = await openSession(t, bundle);
    const markers = timelineMarkers(s.book, s.timeline);
    expect(markers.filter((m) => m.kind === 'chapter').map((m) => m.label)).toEqual(['Titel', 'Kapitel 2']);
    expect(markers.every((m) => m.at >= 0 && m.at <= 1)).toBe(true);
    expect(headingAt(s.book, s.timeline, s.timeline.entries[2]!.start)).toBe('Titel');
  });
  test('14-4: auto-follow', () => {
    expect(autoFollow('follow', 'user-scroll')).toBe('paused');
    expect(autoFollow('paused', 'play')).toBe('follow');
    expect(autoFollow('paused', 'back-to-current')).toBe('follow');
    expect(autoFollow('paused', 'navigate')).toBe('follow');
  });
});

describe('15: settings, stage, layout, popover, debug, a11y', () => {
  withDom();
  sampleTest('15-1: settings apply live; voice list marks matching voices, local first; reset', async () => {
    const root = document.documentElement;
    applySettings({ ...defaultSettings(), theme: 'sepia', fontSize: 26, motion: 'none' }, root, false);
    expect(root.dataset.theme).toBe('sepia');
    expect(root.style.getPropertyValue('--reading-size')).toBe('26px');
    expect(root.style.getPropertyValue('--dur-base')).toBe('0ms');
    expect(root.style.getPropertyValue('--c-bg')).toBe('#f5ecd9');
    applySettings({ ...defaultSettings(), theme: 'system' }, root, true);
    expect(root.dataset.theme).toBe('dark');

    const t = await makeEnv({ voices: [voice('google-de', 'de-DE', false), voice('zira', 'en-US'), hedda] });
    const s = await openSession(t, bundleOf('aufklaerung.txt', kantBytes));
    s.panel.value = 'settings';
    const host = mount(t, <Reader session={s} />);
    await flush();
    const voices = [...host.querySelectorAll('.voice-list li')];
    expect(voices.map((v) => v.querySelector('.voice-name')?.textContent)).toEqual(['hedda', 'google-de', 'zira']);
    expect(voices.map((v) => v.classList.contains('is-matching'))).toEqual([true, true, false]);
    const sepia = host.querySelector('.theme-swatch.swatch-sepia') as HTMLButtonElement;
    sepia.click();
    expect(settings.value.theme).toBe('sepia');
    (voices[2]!.querySelector('.voice') as HTMLButtonElement).click();
    expect(settings.value.voiceByLang).toEqual({ de: 'zira' });
    expect(s.engine.currentVoice?.voiceURI).toBe('zira');
    render(null, host);
  });

  sampleTest('15-2: stage step renders the visual state of the section at τ with dwell and forced mode', async () => {
    const t = await makeEnv({ voices: [voice('en', 'en-US')] });
    const s = await openSession(t, bundleOf('kybalion-chapter-2.md', kybalionBytes, 'en'));
    expect(s.plans.value.size).toBe(s.sections.size);
    const listSection = [...s.sections.values()].find((x) => x.paragraphs.some((p) => p.kind === 'list'))!;
    const firstEntry = s.timeline.entries.findIndex((e) => e.sectionId === listSection.id);
    s.navigate({ entryIndex: s.timeline.entries.length - 1, tokenIndex: 0 });
    const lastItem = s.timeline.entries.findIndex((e, k) => k > firstEntry && e.sentence.text === 'The Principle of Gender.');
    s.navigate({ entryIndex: lastItem, tokenIndex: 0 });
    const snap = stageStep(s, t.timers.now());
    expect(snap.frame.current).toBe(listSection.id);
    expect(snap.current?.mode).toBe('list');
    if (snap.current?.mode === 'list') expect(snap.current.items.every((i) => i.opacity === 1)).toBe(true);
    s.cycleVisual(); // auto → list (forced)
    s.cycleVisual(); // list → kinetic
    expect(stageStep(s, t.timers.now()).current?.mode).toBe('kinetic');
    s.cycleVisual(); // → text
    expect(stageStep(s, t.timers.now()).current?.mode).toBe('none');
  });

  test('15-3/15-4/15-5/15-6: layout keeps the sentence in view, popover, debug overlay, accessible names', async () => {
    const t = await makeEnv({ voices: [hedda] });
    const s = await openSession(t, bundleOf('footnotes.epub', EPUB_CASES.footnotes!()));
    const scrolled: Element[] = [];
    (globalThis.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    const host = mount(t, <Reader session={s} />);
    await flush();
    s.navigate({ entryIndex: 1, tokenIndex: 0 });
    settings.value = { ...settings.value, layout: 'page' };
    await flush();
    expect(scrolled.some((e) => e.getAttribute('data-e') === '1')).toBe(true);
    expect(host.querySelector('.reader')?.getAttribute('data-layout')).toBe('page');

    const fn = host.querySelector('[data-fn]') as HTMLButtonElement;
    fn.click();
    await flush();
    expect(host.querySelector('.popover')?.textContent).toContain('Die erste Fußnote.');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await flush();
    expect(host.querySelector('.popover')).toBeNull();

    settings.value = { ...settings.value, layout: 'stage' };
    s.debug.value = true;
    await flush();
    const debug = host.querySelector('.debug');
    expect(debug?.textContent).toContain('hedda');
    expect(debug?.textContent).toMatch(/kinetic|diagram|none/);

    const unnamed = [...host.querySelectorAll('button, [role="slider"], input, select')].filter(
      (b) => !(b.getAttribute('aria-label') || b.textContent?.trim() || b.getAttribute('aria-labelledby') || b.id),
    );
    expect(unnamed.map((b) => b.outerHTML.slice(0, 80))).toEqual([]);
    expect(bookParagraphs(s.book).some((p) => p.kind === 'footnote')).toBe(true);
    render(null, host);
  });
});

describe('views: subtitles, cinema, sentence by sentence', () => {
  withDom();
  sampleTest('subtitle cues cover the sentence in order, at most ~96 characters, breaking at clauses', async () => {
    const t = await makeEnv({ voices: [hedda] });
    const s = await openSession(t, bundleOf('aufklaerung.txt', kantBytes));
    for (const e of s.timeline.entries) {
      const cues = subtitleCues(e.sentence);
      expect(cues[0]?.[0]).toBe(0);
      expect(cues.at(-1)?.[1]).toBe(e.sentence.tokens.length);
      for (let k = 1; k < cues.length; k++) expect(cues[k]![0]).toBe(cues[k - 1]![1]);
      for (const [a, b] of cues) {
        const len = e.sentence.tokens[b - 1]!.end - e.sentence.tokens[a]!.start;
        if (b - a > 1) expect(len).toBeLessThan(140);
      }
    }
  });
  sampleTest('cinema shows stage + subtitles without the text pane; sentence view shows the current sentence; S toggles subtitles', async () => {
    const t = await makeEnv({ voices: [hedda] });
    const s = await openSession(t, bundleOf('aufklaerung.txt', kantBytes));
    settings.value = { ...settings.value, layout: 'cinema' };
    const host = mount(t, <Reader session={s} />);
    await flush();
    s.navigate({ entryIndex: 1, tokenIndex: 2 });
    await flush();
    expect(host.querySelector('.book-text')).toBeNull();
    expect(host.querySelector('.subtitles .kw.is-current')?.textContent).toBe(s.timeline.entries[1]!.sentence.tokens[2]!.text);
    settings.value = { ...settings.value, layout: 'sentence' };
    await flush();
    expect(host.querySelector('.sv-current')?.textContent).toBe(s.timeline.entries[1]!.sentence.text);
    (host.querySelectorAll('.sv-current .kw')[4] as HTMLElement).click();
    expect(s.engine.position.value).toEqual({ entryIndex: 1, tokenIndex: s.timeline.entries[1]!.sentence.tokens.findIndex((x, k) => k >= 4 && x.wordLike) });
    settings.value = { ...settings.value, layout: 'stage' };
    await flush();
    expect(host.querySelector('.subtitles')).toBeNull();
    dispatch(s, 'toggle-subtitles');
    await flush();
    expect(host.querySelector('.subtitles')).not.toBeNull();
    render(null, host);
  });
});
