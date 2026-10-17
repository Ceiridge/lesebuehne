import { describe, expect, test } from 'bun:test';
import { DIAGRAM_TEMPLATES, type Diagram, type DiagramTemplate, type VisualPlan } from '@lesebuehne/core';
import { render } from 'preact';
import { withDom } from '../../../tests/support/with-dom.ts';
import { effectiveTemplate, layoutDiagram, SCENE_HEIGHT, SCENE_WIDTH, Visual, visualState, wrap, type SceneNode } from '../src/index.ts';

const LABELS = [
  'Mentalism',
  'The Principle of Correspondence',
  'Vibration',
  'Polarity: everything is dual, everything has poles',
  'Rhythm',
  'Cause and Effect',
  'Gender',
  'Faulheit und Feigheit sind die Ursachen',
  'Vormünder',
  'Aufklärung',
];

function diagram(template: DiagramTemplate, n: number, o: Partial<Diagram> = {}): Diagram {
  const items = LABELS.slice(0, n).map((label, k) => ({ id: `i${k}`, label }));
  if (template === 'comparison') items.forEach((i, k) => Object.assign(i, { group: k % 2 ? 'Rechts' : 'Links' }));
  if (template === 'venn') items.forEach((i, k) => k >= 2 && Object.assign(i, { group: k % 3 === 0 ? 'i0+i1' : 'i0' }));
  if (template === 'equation') items.forEach((i, k) => Object.assign(i, { group: k % 2 ? 'right' : 'left' }));
  const edges =
    template === 'hierarchy'
      ? items.slice(1).map((i, k) => ({ from: items[Math.floor(k / 3)]!.id, to: i.id }))
      : template === 'network'
        ? items.slice(1).map((i, k) => ({ from: items[k]!.id, to: i.id, label: 'führt zu' }))
        : undefined;
  return { template, items, ...(edges ? { edges } : {}), ...o };
}

/** Box a node occupies including its label when the label sits outside the shape. */
function extent(n: SceneNode): { x0: number; y0: number; x1: number; y1: number } {
  if (n.textAt === 'center') return { x0: n.x - n.w / 2, y0: n.y - n.h / 2, x1: n.x + n.w / 2, y1: n.y + n.h / 2 };
  const textW = Math.max(...n.lines.map((l) => l.length)) * n.fontSize * 0.54;
  const textH = n.lines.length * n.fontSize * 1.22 + 22 + (n.caption ? 30 : 0);
  // Labels above/below an axis; the small dot on the axis is not part of the label box.
  return n.textAt === 'above'
    ? { x0: n.x - textW / 2, y0: n.y - n.h / 2 - textH, x1: n.x + textW / 2, y1: n.y - n.h / 2 }
    : { x0: n.x - textW / 2, y0: n.y + n.h / 2, x1: n.x + textW / 2, y1: n.y + n.h / 2 + textH };
}

const overlap = (a: ReturnType<typeof extent>, b: ReturnType<typeof extent>, tol = 4): boolean =>
  a.x0 + tol < b.x1 && b.x0 + tol < a.x1 && a.y0 + tol < b.y1 && b.y0 + tol < a.y1;

describe('M3: diagram layout', () => {
  test('wrap: lines, max lines with ellipsis', () => {
    expect(wrap('a bb ccc dddd', 6, 3)).toEqual(['a bb', 'ccc', 'dddd']);
    expect(wrap('one two three four five six', 5, 2)).toEqual(['one', 'two…']);
  });

  for (const template of DIAGRAM_TEMPLATES) {
    test(`${template}: every item inside the canvas, no overlaps, deterministic`, () => {
      for (let n = 2; n <= 10; n++) {
        const d = diagram(template, n, n % 2 ? { title: 'Die sieben Prinzipien' } : {});
        const scene = layoutDiagram(d);
        expect(JSON.stringify(layoutDiagram(d))).toBe(JSON.stringify(scene));
        expect(scene.template).toBe(effectiveTemplate(d));
        expect(scene.nodes.map((x) => x.id).sort()).toEqual((scene.template === 'matrix' ? d.items.slice(0, 4) : d.items).map((i) => i.id).sort());
        const boxes = scene.nodes.map(extent);
        for (const [k, b] of boxes.entries()) {
          const where = `${template} n=${n} ${scene.nodes[k]!.id}`;
          expect({ where, ok: b.x0 >= -1 && b.y0 >= -1 && b.x1 <= SCENE_WIDTH + 1 && b.y1 <= SCENE_HEIGHT + 1 }).toEqual({ where, ok: true });
          if (scene.template === 'venn') continue; // members sit inside set circles by design
          for (let j = k + 1; j < boxes.length; j++) {
            const pair = `${where} × ${scene.nodes[j]!.id}`;
            expect({ pair, overlap: overlap(b, boxes[j]!) }).toEqual({ pair, overlap: false });
          }
        }
        for (const node of scene.nodes) expect(node.fontSize).toBeGreaterThanOrEqual(20);
      }
    });
  }

  test('too many items fall back to the list template', () => {
    expect(effectiveTemplate(diagram('matrix', 6))).toBe('list');
    expect(effectiveTemplate(diagram('matrix', 4))).toBe('matrix');
    expect(effectiveTemplate(diagram('cycle', 10))).toBe('list');
  });
});

describe('M3: diagram state and SVG', () => {
  withDom();
  const plan = (template: DiagramTemplate): VisualPlan => ({
    version: 't',
    mode: 'diagram',
    rationale: 'r',
    keyTerms: [],
    fallback: 'kinetic',
    diagram: diagram(template, 3),
    cues: [
      { anchor: { sentenceId: 's1', phrase: 'x' }, action: { type: 'reveal', itemId: 'i0' } },
      { anchor: { sentenceId: 's2', phrase: 'x' }, action: { type: 'reveal', itemId: 'i1' } },
      { anchor: { sentenceId: 's3', phrase: 'x' }, action: { type: 'connect', from: 'i1', to: 'i2' } },
      { anchor: { sentenceId: 's4', phrase: 'x' }, action: { type: 'dim', itemId: 'i0' } },
      { anchor: { sentenceId: 's5', phrase: 'x' }, action: { type: 'highlight', itemId: 'i0' } },
    ],
  });
  const times = [1, 2, 3, 4, 5];

  test('process: edges follow their endpoints or connect cues; dim and highlight', () => {
    const at = (t: number) => visualState(plan('process'), times, t, 'none');
    const s1 = at(1);
    expect(s1.mode).toBe('diagram');
    if (s1.mode !== 'diagram') return;
    expect(s1.edges.find((e) => e.from === 'i0')?.progress).toBe(0); // i1 not yet revealed
    const s2 = at(2);
    if (s2.mode !== 'diagram') return;
    expect(s2.edges.find((e) => e.from === 'i0')?.progress).toBe(1);
    expect(s2.edges.find((e) => e.from === 'i1')?.progress).toBe(0); // waits for connect at 3
    const s4 = at(4);
    if (s4.mode !== 'diagram') return;
    expect(s4.items.find((i) => i.id === 'i0')).toMatchObject({ dimmed: true, current: false });
    const s5 = at(5);
    if (s5.mode !== 'diagram') return;
    expect(s5.items.find((i) => i.id === 'i0')).toMatchObject({ dimmed: false, current: true });
    expect(at(0).mode === 'diagram' && (at(0) as { items: Array<{ id: string; opacity: number }> }).items.find((i) => i.id === 'i2')?.opacity).toBe(1);
  });

  test('every template renders an SVG with one group per node', () => {
    for (const template of DIAGRAM_TEMPLATES) {
      const p = plan(template === 'matrix' ? 'matrix' : template);
      if (template === 'matrix') p.diagram = diagram('matrix', 4);
      const state = visualState(p, times, 9, 'full');
      const root = document.createElement('div');
      render(<Visual state={state} />, root);
      if (template === 'list') {
        expect(root.querySelector('.lb-list')).not.toBeNull();
        continue;
      }
      expect(root.querySelector(`svg`)).not.toBeNull();
      expect(root.querySelectorAll('.lb-d-node').length).toBe(p.diagram!.items.length);
      expect(root.textContent).toContain('Mentalism');
    }
  });
});
