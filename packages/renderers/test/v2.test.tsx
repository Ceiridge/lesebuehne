import { describe, expect, test } from 'bun:test';
import { glossaryIndex, type StyleBible, type VisualPlan } from '@lesebuehne/core';
import { render } from 'preact';
import { withDom } from '../../../tests/support/with-dom.ts';
import { Visual, visualState } from '../src/index.ts';

const style = {
  glossary: [{ id: 'mut', label: 'Mut', description: '', glyph: '✦', color: '#aa3300' }],
} as unknown as StyleBible;
const glossary = glossaryIndex(style);

const base = { version: 't', rationale: 'r', keyTerms: [], fallback: 'kinetic' as const };
const anchor = (k: number) => ({ sentenceId: `s${k}`, phrase: 'x' });

describe('M2 plan v2 rendering', () => {
  withDom();
  test('non-list templates render as SVG diagrams; highlight moves "current"', () => {
    const plan: VisualPlan = {
      ...base,
      mode: 'diagram',
      cues: [
        { anchor: anchor(1), action: { type: 'reveal', itemId: 'a' } },
        { anchor: anchor(2), action: { type: 'reveal', itemId: 'b' } },
        { anchor: anchor(3), action: { type: 'highlight', itemId: 'a' } },
      ],
      diagram: { template: 'causal-chain', items: [{ id: 'a', label: 'Mut', group: 'Ursache' }, { id: 'b', label: 'Freiheit', detail: 'Folge' }] },
    };
    const s2 = visualState(plan, [1, 2, 3], 2.5, 'none', { glossary });
    const s3 = visualState(plan, [1, 2, 3], 3, 'none', { glossary });
    expect(s2.mode === 'diagram' && s2.template).toBe('causal-chain');
    expect(s2.mode === 'diagram' && s2.items.find((i) => i.current)?.id).toBe('b');
    expect(s3.mode === 'diagram' && s3.items.find((i) => i.current)?.id).toBe('a');
    expect(s3.mode === 'diagram' && s3.items[0]).toMatchObject({ color: '#aa3300', glyph: '✦', group: 'Ursache' });
    {
      const root = document.createElement('div');
      render(<Visual state={s3} />, root);
      expect(root.querySelector('.lb-template-causal-chain')).not.toBeNull();
      expect(root.querySelector('.lb-d-glyph')?.textContent).toBe('✦');
      expect(root.querySelector('.lb-d-detail')?.textContent).toBe('Folge');
    }
  });

  test('quote renders verbatim; image falls back to kinetic terms; animation uses its diagram', () => {
    const quote: VisualPlan = { ...base, mode: 'quote', cues: [], quote: { sentenceId: 's1', phrase: 'Habe Mut!' } };
    {
      const root = document.createElement('div');
      render(<Visual state={visualState(quote, [], 0, 'full')} />, root);
      expect(root.querySelector('.lb-quote-text')?.textContent).toBe('Habe Mut!');
    }
    const image: VisualPlan = {
      ...base,
      mode: 'image',
      keyTerms: ['Mut'],
      cues: [{ anchor: anchor(1), action: { type: 'showTerm', term: 'Mut' } }],
      image: { prompt: 'p', aspect: '16:9', focusRegions: [] },
    };
    const s = visualState(image, [1], 2, 'none', { glossary });
    expect(s.mode).toBe('kinetic');
    expect(s.mode === 'kinetic' && s.terms[0]).toMatchObject({ term: 'Mut', color: '#aa3300' });
    const anim: VisualPlan = {
      ...base,
      mode: 'animation',
      cues: [],
      diagram: { template: 'cycle', items: [{ id: 'a', label: 'A' }] },
      animation: { brief: 'b' },
    };
    expect(visualState(anim, [], 0, 'none').mode).toBe('list');
  });
});
