import { describe, expect, test } from 'bun:test';
import { buildTimeline, type Book, type VisualPlan } from '@lesebuehne/core';
import { planBook } from '@lesebuehne/director';
import { ingestFile } from '@lesebuehne/ingest';
import { render } from 'preact';
import { withDom } from '../../../tests/support/with-dom.ts';
import { sampleBytes, sampleTest, SAMPLES_PRESENT } from '../../../tests/support/samples.ts';
import {
  cueProgress,
  REVEAL_SECONDS,
  resolveCueTimes,
  StageScheduler,
  StageView,
  Visual,
  visualState,
  type Motion,
} from '../src/index.ts';

const ROOT = new URL('../../../', import.meta.url);
const load = async (file: string, language: string): Promise<Book> =>
  ingestFile({ fileName: file, bytes: await sampleBytes(file), language }).book;
const books = SAMPLES_PRESENT ? [await load('aufklaerung.txt', 'de'), await load('kybalion-chapter-2.md', 'en')] : [];

const listPlan: VisualPlan = {
  version: 't',
  mode: 'diagram',
  rationale: 'test',
  keyTerms: [],
  cues: [1, 2, 3].map((k) => ({ anchor: { sentenceId: `s${k}`, phrase: 'x' }, action: { type: 'reveal' as const, itemId: `i${k}` } })),
  diagram: { template: 'list', items: [1, 2, 3].map((k) => ({ id: `i${k}`, label: `Punkt ${k}` })) },
  fallback: 'kinetic',
};
const kineticPlan: VisualPlan = {
  version: 't',
  mode: 'kinetic',
  rationale: 'test',
  keyTerms: ['A', 'B', 'C', 'D', 'E'],
  cues: ['A', 'B', 'C', 'D', 'E'].map((term) => ({ anchor: { sentenceId: 's', phrase: term }, action: { type: 'showTerm' as const, term } })),
  fallback: 'none',
};
const times = [2, 5, 9];

describe('08-1: cue times', () => {
  sampleTest('inside their sentence span, non-decreasing, for every director plan of both samples', () => {
    let n = 0;
    for (const book of books) {
      const timeline = buildTimeline(book);
      for (const plan of planBook(book).values()) {
        const t = resolveCueTimes(plan, timeline);
        expect(t.length).toBe(plan.cues.length);
        for (const [k, cue] of plan.cues.entries()) {
          n++;
          const entry = timeline.entries[timeline.indexOf.get(cue.anchor.sentenceId)!]!;
          expect(t[k]!).toBeGreaterThanOrEqual(entry.start);
          expect(t[k]!).toBeLessThanOrEqual(entry.end);
          if (k > 0) expect(t[k]!).toBeGreaterThanOrEqual(t[k - 1]!);
        }
      }
    }
    expect(n).toBeGreaterThan(20);
  });
});

describe('08-2: visual state is a pure function of time (seek)', () => {
  test('cues ≤ t applied; progress has the closed form', () => {
    const s = visualState(listPlan, times, 5.3, 'full');
    if (s.mode !== 'list') throw new Error('list expected');
    expect(s.items.map((i) => i.opacity)).toEqual([1, 1, 0]);
    expect(s.items.find((i) => i.current)?.id).toBe('i2');
    // the reveal runs during REVEAL_SECONDS before the cue (closed form)
    const t = 9 - REVEAL_SECONDS / 3;
    const p = 1 - (9 - t) / REVEAL_SECONDS;
    const pre = visualState(listPlan, times, t, 'full');
    if (pre.mode !== 'list') throw new Error();
    expect(pre.items[2]!.opacity).toBeCloseTo(p * p * (3 - 2 * p), 10);
    expect(pre.items[2]!.current).toBe(false);
  });
  test('a jump to t equals continuous play to t', () => {
    for (const plan of [listPlan, kineticPlan]) {
      const cue = plan === listPlan ? times : [1, 2, 3, 4, 5];
      let continuous = visualState(plan, cue, 0, 'full');
      for (let t = 0; t <= 12; t += 1 / 60) continuous = visualState(plan, cue, t, 'full');
      const t = Math.floor(12 * 60) / 60;
      expect(visualState(plan, cue, t, 'full')).toEqual(visualState(plan, cue, t, 'full'));
      expect(continuous).toEqual(visualState(plan, cue, t, 'full'));
    }
  });
  test('kinetic keeps the last four terms, the newest is current', () => {
    const s = visualState(kineticPlan, [1, 2, 3, 4, 5], 9, 'full');
    if (s.mode !== 'kinetic') throw new Error('kinetic expected');
    expect(s.terms.map((t) => t.term)).toEqual(['B', 'C', 'D', 'E']);
    expect(s.terms.map((t) => t.current)).toEqual([false, false, false, true]);
    expect(visualState({ ...kineticPlan, mode: 'none', cues: [], keyTerms: [] }, [], 3, 'full')).toEqual({ mode: 'none' });
  });
});

describe('08-3: motion levels', () => {
  const at = (motion: Motion) => visualState(listPlan, times, 8.8, motion);
  test('reduced: opacity only (no movement or scale)', () => {
    const s = at('reduced');
    if (s.mode !== 'list') throw new Error();
    expect(s.items.every((i) => i.offsetY === 0)).toBe(true);
    expect(s.items[2]!.opacity).toBeGreaterThan(0);
    expect(s.items[2]!.opacity).toBeLessThan(1);
    const k = visualState(kineticPlan, [1, 2, 3, 4, 5], 4.8, 'reduced');
    if (k.mode !== 'kinetic') throw new Error();
    expect(k.terms.every((t) => t.offsetY === 0 && t.scale === 1)).toBe(true);
  });
  test('none: final states, no interpolation', () => {
    const s = at('none');
    if (s.mode !== 'list') throw new Error();
    expect(s.items.map((i) => i.opacity)).toEqual([1, 1, 0]);
    expect(cueProgress(5, 5, 'none')).toBe(1);
    expect(cueProgress(5, 4.99, 'full')).toBeGreaterThan(0.9);
    expect(cueProgress(5, 4.99, 'none')).toBe(0);
  });
});

describe('08-4: stage dwell and crossfade', () => {
  test('the next visual waits for 8 s of wall-clock playing time; pauses do not count', () => {
    const s = new StageScheduler({ crossfadeMs: 200 });
    expect(s.tick('a', 0, true).current).toBe('a');
    expect(s.tick('b', 3000, true).current).toBe('a');
    s.tick('b', 3000, false);
    expect(s.tick('b', 20_000, false).current).toBe('a'); // paused 17 s
    s.tick('b', 20_001, true);
    expect(s.tick('b', 24_900, true).current).toBe('a'); // 3 s + 4.9 s playing
    const f = s.tick('b', 25_100, true);
    expect(f).toEqual({ current: 'b', previous: 'a', fade: 0 });
    expect(s.tick('b', 25_200, true).fade).toBeCloseTo(0.5, 5);
    expect(s.tick('b', 25_300, true)).toEqual({ current: 'b', previous: null, fade: 1 });
  });
  test('tempo does not shorten the dwell (wall clock, not book time)', () => {
    const s = new StageScheduler({ crossfadeMs: 0 });
    s.tick('a', 0, true);
    // at tempo 2.5 the playhead reaches section b after 2 s wall time; the visual still waits
    expect(s.tick('b', 2000, true).current).toBe('a');
    expect(s.tick('b', 7999, true).current).toBe('a');
    expect(s.tick('b', 8000, true)).toEqual({ current: 'b', previous: null, fade: 1 });
  });
  test('navigation switches immediately', () => {
    const s = new StageScheduler({ crossfadeMs: 300 });
    s.tick('a', 0, true);
    expect(s.navigate('c', 100)).toEqual({ current: 'c', previous: 'a', fade: 0 });
    expect(s.tick('c', 400, true).fade).toBe(1);
  });
});

describe('08-5: components render', () => {
  const dom = withDom();
  test('list, kinetic, none and the stage crossfade', () => {
    const root = dom.document.createElement('div');
    dom.document.body.appendChild(root);
    render(<Visual state={visualState(listPlan, times, 6, 'full')} />, root);
    expect(root.querySelectorAll('.lb-list-item').length).toBe(3);
    expect(root.querySelector('.is-current')?.textContent).toContain('Punkt 2');
    render(<Visual state={visualState(kineticPlan, [1, 2, 3, 4, 5], 9, 'full')} />, root);
    expect(root.querySelectorAll('.lb-term').length).toBe(4);
    render(
      <StageView current={visualState(kineticPlan, [1], 2, 'full')} previous={visualState(listPlan, times, 9, 'full')} fade={0.4} />,
      root,
    );
    expect(root.querySelectorAll('.lb-stage-layer').length).toBe(2);
    render(<Visual state={{ mode: 'none' }} />, root);
    expect(root.querySelector('.lb-none')).not.toBeNull();
    render(null, root);
  });
});
