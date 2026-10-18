import { describe, expect, test } from 'bun:test';
import { assembleBook, buildTimeline, tokenSpeechOffset, type BlockInput, type Book } from '@lesebuehne/core';
import { ingestFile } from '@lesebuehne/ingest';
import { EPUB_CASES } from '../../../ingest/test/fixtures/epub-builder.ts';
import { BoundaryDetector, Calibration, WordEstimator } from '../../src/engine/estimator.ts';
import { clampTempo, PlayerEngine, tokenAtSpeechOffset, WATCHDOG_MIN_MS } from '../../src/engine/engine.ts';
import { chunkSpeech, footnoteLookup, sentenceItems, type FootnoteMode } from '../../src/engine/queue.ts';
import { loadVoices, selectVoice, type VoiceSource } from '../../src/engine/voices.ts';
import { FakeTimers } from '../support/fake-clock.ts';
import { FakeTTS, voice } from '../support/fake-tts.ts';

const book = (blocks: BlockInput[], language = 'de'): Book => assembleBook({ language, title: 't', chapters: [{ blocks }] });
const kant = book([
  { kind: 'heading', level: 1, text: 'Was ist Aufklärung?' },
  { kind: 'text', text: 'Aufklärung ist der Ausgang des Menschen aus seiner selbstverschuldeten Unmündigkeit. Habe Mut, dich deines eigenen Verstandes zu bedienen!' },
  { kind: 'text', text: 'Faulheit und Feigheit sind die Ursachen.' },
]);
const de = voice('hedda', 'de-DE');

function setup(b: Book = kant, mode: FootnoteMode = 'skip') {
  const timers = new FakeTimers();
  const tts = new FakeTTS();
  const timeline = buildTimeline(b);
  const engine = new PlayerEngine({ book: b, timeline, port: tts, voice: de, timers, footnoteMode: mode });
  return { timers, tts, timeline, engine };
}

describe('09-1: voice selection', () => {
  const voices = [voice('google-de', 'de-DE', false, true), voice('hedda', 'de-DE', true), voice('zira', 'en-US', true)];
  test('match local, match remote, primary subtag', () => {
    expect(selectVoice(voices, 'de')).toEqual({ mode: 'voice', voice: voices[1]!, matched: true });
    expect(selectVoice([voices[0]!], 'de-AT')).toEqual({ mode: 'voice', voice: voices[0]!, matched: true });
    expect(selectVoice(voices, 'en-GB')).toEqual({ mode: 'voice', voice: voices[2]!, matched: true });
  });
  test('no match → default voice + notice flag; empty → silent; preferred voice wins', () => {
    expect(selectVoice(voices, 'fr')).toEqual({ mode: 'voice', voice: voices[0]!, matched: false });
    expect(selectVoice([], 'de')).toEqual({ mode: 'silent' });
    expect(selectVoice(voices, 'de', 'zira')).toEqual({ mode: 'voice', voice: voices[2]!, matched: false });
  });
  test('waits for voiceschanged at most 2 s', async () => {
    const timers = new FakeTimers();
    let listener: (() => void) | undefined;
    let list: ReturnType<typeof voice>[] = [];
    const source: VoiceSource = {
      getVoices: () => list,
      addEventListener: (_t, fn) => (listener = fn),
      removeEventListener: () => (listener = undefined),
    };
    const late = loadVoices(source, timers);
    list = [de];
    listener?.();
    expect(await late).toEqual([de]);
    list = [];
    const never = loadVoices(source, timers);
    timers.advance(1999);
    let settled = false;
    void never.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    timers.advance(1);
    expect(await never).toEqual([]);
    expect(await loadVoices(undefined, timers)).toEqual([]);
  });
});

describe('09-2: word estimator and calibration', () => {
  const sentence = buildTimeline(kant).entries[1]!.sentence;
  test('monotonic, within the sentence, ends on the last word', () => {
    const est = new WordEstimator(sentence, 0, 14);
    let last = -1;
    for (let ms = 0; ms <= est.durationMs + 5000; ms += 50) {
      const k = est.tokenAt(ms);
      expect(k).toBeGreaterThanOrEqual(last);
      expect(k).toBeLessThan(sentence.tokens.length);
      last = k;
    }
    const lastWord = sentence.tokens.findLastIndex((t) => t.wordLike);
    expect(last).toBeGreaterThanOrEqual(lastWord);
    expect(est.tokenAt(0)).toBeLessThanOrEqual(last);
  });
  test('snaps to the next sentence start; calibration converges for a fixed rate', () => {
    const { tts, engine, timers } = setup();
    engine.play();
    tts.last.onStart();
    timers.advance(10_000);
    engine.frame(timers.now());
    expect(engine.position.value.entryIndex).toBe(0);
    tts.last.onEnd();
    tts.last.onStart();
    expect(engine.position.value).toEqual({ entryIndex: 1, tokenIndex: 0 });

    const cal = new Calibration();
    for (let k = 0; k < 30; k++) cal.update('v', 1, 'de', 200, 200 / 18);
    expect(cal.cps('v', 1, 'de')).toBeCloseTo(18, 2);
    expect(cal.cps('other', 1.5, 'de')).toBe(14 * 1.5);
  });
});

describe('09-3: boundary detection', () => {
  test('unknown → yes on a word boundary; no after a ≥ 3-word sentence without one', () => {
    const d = new BoundaryDetector();
    expect(d.state('a')).toBe('unknown');
    d.sentenceStart();
    d.sentenceEnd('a', 2);
    expect(d.state('a')).toBe('unknown');
    d.sentenceStart();
    d.sentenceEnd('a', 3);
    expect(d.state('a')).toBe('no');
    expect(d.hint('a')).toBe(true);
    d.sentenceStart();
    d.word('b');
    d.sentenceEnd('b', 9);
    expect(d.state('b')).toBe('yes');
  });
  test('only name=word boundaries count', () => {
    const { tts, engine } = setup();
    engine.play();
    const r = tts.last;
    r.onStart();
    r.onBoundary(0, 'sentence');
    r.onEnd();
    // "Was ist Aufklärung?" has 3 words and no word boundary → no
    expect(engine.detector.state('hedda')).toBe('no');
    expect(engine.estimated.value).toBe(true);
    tts.last.onStart();
    tts.last.onBoundary(5, 'word');
    expect(engine.detector.state('hedda')).toBe('yes');
    expect(engine.estimated.value).toBe(false);
  });
});

describe('09-4: mid-sentence start and chunking', () => {
  test('utterance = speechText from the word; word timings shifted', () => {
    const { tts, engine, timeline } = setup();
    const sentence = timeline.entries[1]!.sentence;
    const k = sentence.tokens.findIndex((t) => t.text === 'Menschen');
    engine.seek({ entryIndex: 1, tokenIndex: k });
    engine.play();
    const offset = tokenSpeechOffset(sentence, k);
    expect(tts.last.text).toBe(sentence.speechText.slice(offset));
    tts.last.onStart();
    tts.last.onBoundary(tts.last.text.indexOf('seiner'), 'word');
    expect(sentence.tokens[engine.position.value.tokenIndex]!.text).toBe('seiner');
    // bookmark jump and tempo change use the same path
    engine.seek({ entryIndex: 1, tokenIndex: 2 });
    expect(tts.last.text).toBe(sentence.speechText.slice(tokenSpeechOffset(sentence, 2)));
    engine.setTempo(1.5);
    expect(tts.last.text).toBe(sentence.speechText.slice(tokenSpeechOffset(sentence, 2)));
    expect(tts.last.rate).toBe(1.5);
  });
  test('remainders over 200 characters are split at clause punctuation, offsets exact', () => {
    const long = `${'Er ging, '.repeat(30)}und blieb.`;
    const chunks = chunkSpeech(long, 7);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.text.length <= 200)).toBe(true);
    expect(chunks.map((c) => c.text).join('')).toBe(long);
    for (const c of chunks) expect(long.slice(c.offset - 7, c.offset - 7 + c.text.length)).toBe(c.text);
    expect(chunks.slice(0, -1).every((c) => /[,;:–—] ?$/u.test(c.text))).toBe(true);
    const b = book([{ kind: 'text', text: long }]);
    const tl = buildTimeline(b);
    const items = sentenceItems(0, tl.entries[0]!, 0, 'skip', footnoteLookup(b), 'de');
    expect(items.length).toBeGreaterThan(1);
    expect(items[0]).toMatchObject({ first: true, last: false, whole: true });
    expect(items.at(-1)).toMatchObject({ last: true });
    const s = tl.entries[0]!.sentence;
    for (const it of items) if (it.kind === 'sentence') expect(s.speechText.slice(it.offset, it.offset + it.text.length)).toBe(it.text);
    expect(tokenAtSpeechOffset(s, s.speechText.length - 1)).toBe(s.tokens.length - 1);
  });
});

describe('09-5: pause, play, click, tempo, stale events', () => {
  test('pause keeps the token; play resumes there', () => {
    const { tts, engine, timeline } = setup();
    engine.seek({ entryIndex: 1, tokenIndex: 0 });
    engine.play();
    tts.last.onStart();
    tts.last.onBoundary(tts.last.text.indexOf('Ausgang'), 'word');
    const at = engine.position.value;
    engine.pause();
    expect(engine.playing.value).toBe(false);
    expect(engine.position.value).toEqual(at);
    engine.play();
    expect(tts.last.text.startsWith('Ausgang')).toBe(true);
    expect(timeline.entries[1]!.sentence.tokens[at.tokenIndex]!.text).toBe('Ausgang');
  });
  test('a paused click moves without speaking', () => {
    const { tts, engine } = setup();
    engine.seek({ entryIndex: 2, tokenIndex: 1 });
    expect(tts.spoken.length).toBe(0);
    expect(engine.position.value).toEqual({ entryIndex: 2, tokenIndex: 1 });
  });
  test('stale events of cancelled utterances are ignored; tempo clamps to steps', () => {
    const { tts, engine } = setup();
    engine.play();
    const old = tts.last;
    engine.seek({ entryIndex: 2, tokenIndex: 0 });
    old.onStart();
    old.onBoundary(0, 'word');
    old.onEnd();
    expect(engine.position.value).toEqual({ entryIndex: 2, tokenIndex: 0 });
    expect(tts.spoken.length).toBe(2);
    expect([0.5, 0.8, 1.1, 2.6].map(clampTempo)).toEqual([0.75, 0.75, 1, 2.5]);
  });
  test('plays through to the end and stops', () => {
    const { tts, engine } = setup();
    engine.play();
    tts.run(10);
    expect(tts.texts.length).toBe(4);
    expect(engine.playing.value).toBe(false);
  });
});

describe('09-6: footnote speech queue', () => {
  const md = ingestFile({
    fileName: 'f.md',
    bytes: new TextEncoder().encode('# T\n\nEin Satz mit Fußnote[^1] und weiter.\n\nZweiter Absatz.\n\n[^1]: Die Fußnote.\n'),
  }).book;
  const epub = ingestFile({ fileName: 'footnotes.epub', bytes: EPUB_CASES.footnotes!() }).book;
  const en = ingestFile({ fileName: 'f.md', bytes: new TextEncoder().encode('# T\n\nA sentence with a note[^1] here.\n\n[^1]: The note.\n'), language: 'en' }).book;
  const spoken = (b: Book, mode: FootnoteMode) => {
    const { tts, engine } = setup(b, mode);
    engine.play();
    tts.run(20);
    return tts.texts;
  };
  test('skip (default): footnotes are not read; noteref labels never spoken', () => {
    expect(spoken(md, 'skip')).toEqual(['T', 'Ein Satz mit Fußnote und weiter.', 'Zweiter Absatz.']);
    expect(spoken(epub, 'skip')).toEqual(['Fußnoten', 'Ein Wort mit Fußnote.', 'Noch eine hier.']);
  });
  test('inline at the marker, German and English markers', () => {
    expect(spoken(md, 'inline')).toEqual(['T', 'Ein Satz mit Fußnote', 'Fußnote: Die Fußnote. Ende der Fußnote.', 'und weiter.', 'Zweiter Absatz.']);
    expect(spoken(en, 'inline')).toEqual(['T', 'A sentence with a note', 'Footnote: The note. End of footnote.', 'here.']);
    expect(spoken(epub, 'inline')).toEqual([
      'Fußnoten',
      'Ein Wort',
      'Fußnote: Die erste Fußnote. Ende der Fußnote.',
      'mit Fußnote.',
      'Noch eine',
      'Fußnote: Die zweite Fußnote. Ende der Fußnote.',
      'hier.',
    ]);
  });
  test('at section end', () => {
    expect(spoken(md, 'section-end')).toEqual(['T', 'Ein Satz mit Fußnote und weiter.', 'Zweiter Absatz.', 'Die Fußnote.']);
  });
  test('while a footnote is spoken the clock stays on the carrying token', () => {
    const { tts, engine, timeline } = setup(md, 'inline');
    engine.play();
    tts.speakLast();
    tts.speakLast();
    tts.last.onStart();
    expect(engine.speakingFootnote.value).toBe('fn:1');
    const s = timeline.entries[1]!.sentence;
    expect(s.tokens[engine.position.value.tokenIndex]!.id).toBe(s.footnoteRefs![0]!.tokenId);
    tts.last.onBoundary(3, 'word');
    expect(s.tokens[engine.position.value.tokenIndex]!.text).toBe('Fußnote');
  });
});

describe('09-7: watchdog', () => {
  test('a lost end event → restart at the estimated word after max(2 × estimate, 15 s)', () => {
    const { tts, engine, timers } = setup();
    engine.seek({ entryIndex: 1, tokenIndex: 0 });
    engine.play();
    const first = tts.last;
    first.onStart(); // no boundaries, no end
    timers.advance(WATCHDOG_MIN_MS - 1);
    expect(tts.spoken.length).toBe(1);
    timers.advance(1);
    expect(tts.spoken.length).toBe(2);
    expect(engine.position.value.tokenIndex).toBeGreaterThan(0);
    expect(tts.last.text.length).toBeLessThan(first.text.length);
  });

  test('waits while audio is generated; a restart stuck at the same word moves on; outside pauses pause', () => {
    const { tts, engine, timers } = setup();
    let busy = true;
    Object.assign(tts, { busy: () => busy });
    engine.play();
    timers.advance(3 * WATCHDOG_MIN_MS);
    expect(tts.spoken.length).toBe(1); // still generating: no restart
    busy = false;
    timers.advance(WATCHDOG_MIN_MS);
    expect(tts.spoken.length).toBe(2); // restart at the same word
    expect(engine.position.value).toEqual({ entryIndex: 0, tokenIndex: 0 });
    timers.advance(WATCHDOG_MIN_MS);
    expect(engine.position.value.entryIndex).toBe(0);
    expect(tts.spoken.length).toBe(3);
    tts.last.onStart();
    expect(engine.position.value.entryIndex).toBe(1); // stuck twice at the same word: next sentence
    expect(engine.playing.value).toBe(true);
    tts.last.onInterrupted?.();
    expect(engine.playing.value).toBe(false);
  });
});

describe('09-8: silent mode', () => {
  test('no port or no voice: play does nothing, seek moves the clock', () => {
    const timeline = buildTimeline(kant);
    const engine = new PlayerEngine({ book: kant, timeline, timers: new FakeTimers() });
    expect(engine.silent).toBe(true);
    engine.play();
    expect(engine.playing.value).toBe(false);
    engine.seek({ entryIndex: 2, tokenIndex: 3 });
    expect(engine.position.value).toEqual({ entryIndex: 2, tokenIndex: 3 });
    engine.seek({ entryIndex: 99, tokenIndex: 99 });
    expect(engine.position.value.entryIndex).toBe(timeline.entries.length - 1);
    expect(engine.frame(1e6)).toBe(engine.time());
  });
});
