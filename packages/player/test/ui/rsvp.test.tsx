import { afterEach, describe, expect, test } from 'bun:test';
import { render } from 'preact';
import { withDom } from '../../../../tests/support/with-dom.ts';
import { EnvContext } from '../../src/app/env.ts';
import { settings } from '../../src/app/store.ts';
import { nextWord, orpIndex, RsvpPacer, rsvpWord, wordDelayMs } from '../../src/engine/rsvp.ts';
import { defaultSettings, settingsSchema } from '../../src/settings/settings.ts';
import { dispatch, Reader } from '../../src/ui/reader/Reader.tsx';
import { voice } from '../support/fake-tts.ts';
import { bundleOf, flush, makeEnv, openSession, type TestEnv } from './support.ts';

const md = '# Mut\n\nHabe Mut, dich deines eigenen Verstandes zu bedienen! Aufklärung ist der „Ausgang“ des Menschen.\n';
const bundle = () => bundleOf('mut.md', new TextEncoder().encode(md));

function mount(t: TestEnv, node: preact.ComponentChild): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  render(<EnvContext.Provider value={t.env}>{node}</EnvContext.Provider>, host);
  return host;
}

afterEach(() => {
  settings.value = defaultSettings();
});

describe('M7: RSVP word logic', () => {
  test('ORP letter: slightly left of the middle by word length', () => {
    expect(['a', 'zu', 'Habe', 'Mutes', 'Menschen', 'Aufklärung', 'Verstandesgebrauch', 'Selbstverschuldung'].map(orpIndex)).toEqual([0, 1, 1, 1, 2, 3, 4, 4]);
  });

  test('words keep their punctuation; non-word positions show the word before', async () => {
    const t = await makeEnv();
    const s = await openSession(t, bundle());
    const sentence = s.timeline.entries.find((e) => e.sentence.text.startsWith('Habe'))!.sentence;
    const at = (word: string) => sentence.tokens.findIndex((x) => x.text === word);
    expect(rsvpWord(sentence, at('Mut'))).toMatchObject({ before: 'M', pivot: 'u', after: 't,' });
    expect(rsvpWord(sentence, at('Verstandes'))).toMatchObject({ before: 'Ver', pivot: 's', after: 'tandes' });
    expect(rsvpWord(sentence, at('bedienen'))).toMatchObject({ before: 'be', pivot: 'd', after: 'ienen!' });
    // The comma token itself shows "Mut,".
    expect(rsvpWord(sentence, at(','))?.tokenIndex).toBe(at('Mut'));
    const second = s.timeline.entries.find((e) => e.sentence.text.startsWith('Aufklärung'))!.sentence;
    const w = rsvpWord(second, second.tokens.findIndex((x) => x.text === 'Ausgang'))!;
    expect(w.before + w.pivot + w.after).toBe('„Ausgang“');
    expect(w.pivot).toBe('s');
  });

  test('delays: base by WPM, longer words a little longer, pauses at commas and sentence ends', async () => {
    const t = await makeEnv();
    const s = await openSession(t, bundle());
    const sentence = s.timeline.entries.find((e) => e.sentence.text.startsWith('Habe'))!.sentence;
    const at = (word: string) => sentence.tokens.findIndex((x) => x.text === word);
    expect(wordDelayMs(sentence, at('Habe'), 300)).toBe(200);
    expect(wordDelayMs(sentence, at('Mut'), 300)).toBe(320);
    expect(wordDelayMs(sentence, at('Verstandes'), 300)).toBe(236);
    expect(wordDelayMs(sentence, at('bedienen'), 300)).toBe(466);
    expect(wordDelayMs(sentence, at('Habe'), 600)).toBe(100);
  });

  test('next word crosses sentences and skips punctuation; none at the end', async () => {
    const t = await makeEnv();
    const s = await openSession(t, bundle());
    const tl = s.timeline;
    const k = tl.entries.findIndex((e) => e.sentence.text.startsWith('Habe'));
    const last = tl.entries[k]!.sentence.tokens.findIndex((x) => x.text === 'bedienen');
    expect(nextWord(tl, { entryIndex: k, tokenIndex: last })).toEqual({ entryIndex: k + 1, tokenIndex: 0 });
    const end = tl.entries.length - 1;
    expect(nextWord(tl, { entryIndex: end, tokenIndex: tl.entries[end]!.sentence.tokens.length - 1 })).toBeUndefined();
  });

  test('settings: defaults, WPM on the 25 grid, RSVP layout accepted', () => {
    const d = defaultSettings();
    expect([d.subtitleStyle, d.rsvpWpm, d.rsvpSilent, d.visualKinds]).toEqual(['line', 350, false, 'mixed']);
    const p = settingsSchema(false).parse({ layout: 'rsvp', rsvpWpm: 333, subtitleStyle: 'word', visualKinds: 'images' });
    expect([p.layout, p.rsvpWpm, p.subtitleStyle, p.visualKinds]).toEqual(['rsvp', 350, 'word', 'images']);
    expect(settingsSchema(false).parse({ rsvpWpm: 2000 }).rsvpWpm).toBe(350);
  });
});

describe('M7: RSVP view and subtitles', () => {
  withDom();

  test('switching to silent RSVP pauses speech immediately', async () => {
    const t = await makeEnv({ voices: [voice('hedda', 'de-DE')] });
    const s = await openSession(t, bundle());
    s.togglePlay();
    expect(s.engine.playing.value).toBe(true);
    settings.value = { ...settings.value, layout: 'rsvp', rsvpSilent: true };
    expect(s.engine.playing.value).toBe(false);
    expect(s.rsvp.running.value).toBe(false);
    s.togglePlay();
    expect(s.rsvp.running.value).toBe(true);
    s.dispose();
    const p = s.engine.position.value;
    t.timers.advance(10000);
    expect(s.engine.position.value).toEqual(p);
  });

  test('a leading quote does not make the pacer show the first word twice; it stops at the end', async () => {
    const t = await makeEnv();
    const s = await openSession(t, bundleOf('quote.txt', new TextEncoder().encode('„Habe Mut!“')));
    const entryIndex = s.timeline.entries.findIndex((e) => e.sentence.text.includes('Habe'));
    s.engine.seek({ entryIndex, tokenIndex: 0 });
    const pacer = new RsvpPacer({ timeline: s.timeline, timers: t.timers, position: () => s.engine.position.value, seek: (p) => s.engine.seek(p), wpm: () => 300 });
    pacer.start();
    t.timers.advance(200);
    expect(rsvpWord(s.timeline.entries[entryIndex]!.sentence, s.engine.position.value.tokenIndex)?.pivot).toBe('u');
    t.timers.advance(10000);
    expect(pacer.running.value).toBe(false);
    s.dispose();
  });

  test('view: one word with its red ORP letter; without a voice Space runs the pacer at the set WPM', async () => {
    const t = await makeEnv({ voices: [] });
    const s = await openSession(t, bundle());
    expect(s.engine.silent).toBe(true);
    settings.value = { ...settings.value, layout: 'rsvp', rsvpWpm: 300 };
    const host = mount(t, <Reader session={s} />);
    const k = s.timeline.entries.findIndex((e) => e.sentence.text.startsWith('Habe'));
    s.navigate({ entryIndex: k, tokenIndex: 0 });
    await flush();
    expect(host.querySelector('.rsvp-view .rsvp-word')?.textContent).toBe('Habe');
    expect(host.querySelector('.rsvp-pivot')?.textContent).toBe('a');
    expect(s.pacerMode).toBe(true);
    const play = host.querySelector('.play-btn') as HTMLButtonElement;
    expect(play.disabled).toBe(false);
    expect(host.querySelector('.tempo-value')?.textContent).toContain('300');

    expect(dispatch(s, 'toggle-play')).toBe(true);
    expect(s.rsvp.running.value).toBe(true);
    t.timers.advance(200); // "Habe" at 300 wpm
    await flush();
    expect(host.querySelector('.rsvp-word')?.textContent).toBe('Mut,');
    t.timers.advance(320); // "Mut," with its comma pause
    await flush();
    expect(host.querySelector('.rsvp-word')?.textContent).toBe('dich');

    dispatch(s, 'tempo-up');
    expect(settings.value.rsvpWpm).toBe(325);
    dispatch(s, 'toggle-play');
    expect(s.rsvp.running.value).toBe(false);
    const before = s.engine.position.value;
    t.timers.advance(5000);
    expect(s.engine.position.value).toEqual(before);

    // Leaving the layout stops a running pacer.
    dispatch(s, 'toggle-play');
    settings.value = { ...settings.value, layout: 'stage' };
    await flush();
    expect(s.rsvp.running.value).toBe(false);
    render(null, host);
  });

  test('with a voice the word follows the reading position; the pacer only with "RSVP without voice"', async () => {
    const t = await makeEnv({ voices: [voice('hedda', 'de-DE')] });
    const s = await openSession(t, bundle());
    settings.value = { ...settings.value, layout: 'rsvp' };
    const host = mount(t, <Reader session={s} />);
    expect(s.pacerMode).toBe(false);
    const k = s.timeline.entries.findIndex((e) => e.sentence.text.startsWith('Habe'));
    const sentence = s.timeline.entries[k]!.sentence;
    s.navigate({ entryIndex: k, tokenIndex: sentence.tokens.findIndex((x) => x.text === 'Verstandes') });
    await flush();
    expect(host.querySelector('.rsvp-word')?.textContent).toBe('Verstandes');
    settings.value = { ...settings.value, rsvpSilent: true };
    await flush();
    expect(s.pacerMode).toBe(true);
    render(null, host);
  });

  test('subtitle style "word" shows the RSVP word on the stage', async () => {
    const t = await makeEnv({ voices: [voice('hedda', 'de-DE')] });
    const s = await openSession(t, bundle());
    settings.value = { ...settings.value, layout: 'cinema', subtitleStyle: 'word' };
    const host = mount(t, <Reader session={s} />);
    const k = s.timeline.entries.findIndex((e) => e.sentence.text.startsWith('Habe'));
    s.navigate({ entryIndex: k, tokenIndex: 2 });
    await flush();
    expect(host.querySelector('.subtitles.is-word .rsvp-word')?.textContent).toBe('Mut,');
    expect(host.querySelector('.subtitle-line')).toBeNull();
    settings.value = { ...settings.value, subtitleStyle: 'line' };
    await flush();
    expect(host.querySelector('.subtitle-line')).not.toBeNull();
    render(null, host);
  });
});
