import { describe, expect, test } from 'bun:test';
import { animationCodeProblems, type VisualPlan } from '@lesebuehne/core';
import { EXAMPLE_PROGRAM } from '@lesebuehne/director';
import { render } from 'preact';
import { withDom } from '../../../tests/support/with-dom.ts';
import { READY_TIMEOUT_MS, SANDBOX_CSP, SandboxHost, sandboxDocument, TICK_TIMEOUT_MS, Visual, visualState, type AnimationInit, type SandboxStatus } from '../src/index.ts';
import { fitTransform, LIBRARY_SOURCE, MAX_TEXT_CHARS } from '../src/animation/library.ts';

const init: AnimationInit = {
  cues: [1, 2],
  items: [{ id: 'a', label: 'A' }],
  terms: [],
  palette: { background: '#fff', ink: '#000', accent: '#a00', accent2: '#00a', muted: '#888' },
  motion: 'full',
};

describe('M7: animation bounds and text', () => {
  const dom = withDom();

  test('overflowing scenes fit inside the margin, including very large coordinates', () => {
    expect(fitTransform(null, 1600, 900, 24)).toBeNull();
    expect(fitTransform({ x: 40, y: 40, width: 1520, height: 820 }, 1600, 900, 24)).toBeNull();
    for (const box of [
      { x: 100, y: 700, width: 1200, height: 400 },
      { x: -200, y: -100, width: 2400, height: 1600 },
      { x: 0, y: 0, width: 1e7, height: 1e7 },
    ]) {
      const f = fitTransform(box, 1600, 900, 24)!;
      expect(f.s).toBeGreaterThan(0);
      expect(f.s).toBeLessThanOrEqual(1);
      expect(box.x * f.s + f.tx).toBeGreaterThanOrEqual(24 - 1e-8);
      expect(box.y * f.s + f.ty).toBeGreaterThanOrEqual(24 - 1e-8);
      expect((box.x + box.width) * f.s + f.tx).toBeLessThanOrEqual(1576 + 1e-8);
      expect((box.y + box.height) * f.s + f.ty).toBeLessThanOrEqual(876 + 1e-8);
    }
  });

  test('sandbox restores time zero if measurement fails and limits updated text too', () => {
    dom.document.body.innerHTML = '<svg id="scene"><g id="lb-fit"></g></svg>';
    const root = dom.document.getElementById('lb-fit')!;
    let measures = 0;
    Object.assign(root, { getBBox() { if (++measures > 1) throw new Error('measurement failed'); return { x: 0, y: 0, width: 10, height: 10 }; } });
    new Function('window', 'document', 'parent', LIBRARY_SOURCE)(dom.window, dom.document, dom.window);
    new Function('window', `window.__lbProgram = function(lb) {
      var text = lb.text('short', {x: 50, y: 50});
      return function(t) { text.set({text: 'x'.repeat(100), y: t}); };
    };`)(dom.window);
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window, data: { type: 'init', ...init } }));
    const text = root.querySelector('text')!;
    expect(text.getAttribute('y')).toBe('0');
    expect(text.textContent).toHaveLength(MAX_TEXT_CHARS);
    expect(text.textContent?.endsWith('…')).toBe(true);
  });

  test('label boxes obey the text limits on creation and update; crowded scenes fail for repair', () => {
    dom.document.body.innerHTML = '<svg id="scene"><g id="lb-fit"></g></svg>';
    new Function('window', 'document', 'parent', LIBRARY_SOURCE)(dom.window, dom.document, dom.window);
    const lb = (dom.window as unknown as { __lb: { label(text: string): { set(attrs: { text: string }): void }; text(text: string): void } }).__lb;
    const label = lb.label('One two three four five six seven');
    const root = dom.document.getElementById('lb-fit')!;
    expect([...root.querySelectorAll('tspan')].map((line) => line.textContent).join(' ')).toBe('One two three…');
    label.set({ text: 'New short label with far too many additional words' });
    expect(root.querySelectorAll('rect')).toHaveLength(1);
    expect(root.querySelector('text')!.textContent).toBe('New short label…');
    lb.text('Second');
    lb.label('Third');
    expect(() => lb.text('Fourth')).toThrow('at most three short labels');
    expect(root.querySelectorAll('text')).toHaveLength(3);
  });
});

describe('M3: static validation of animation programs', () => {
  test('accepts the documented example', () => {
    expect(animationCodeProblems(EXAMPLE_PROGRAM)).toEqual([]);
  });

  const bad: Array<[string, string]> = [
    ['while (true) {} return function (t) {};', 'while'],
    ['do { } while (1); return function (t) {};', 'do'],
    ['for (;;) {} return function (t) {};', 'for loops'],
    ['for (var i = 0; i < 100000; i++) {} return function (t) {};', 'for loops'],
    ['fetch("https://x"); return function (t) {};', 'fetch'],
    ['var w = window; return function (t) {};', 'window'],
    ['lb.circle({}).el.ownerDocument.defaultView.parent; return function (t) {};', 'parent'],
    ['var p = lb["par" + "ent"]; return function (t) {};', 'member access'],
    ['setTimeout(function () {}, 1); return function (t) {};', 'setTimeout'],
    ['var f = Function("x"); return function (t) {};', 'Function'],
    ['var s = `${1}`; return function (t) {};', 'template literals'],
    ['lb.circle({}); // no update function', 'return'],
    ['var a = (async function () {}); return function (t) {};', 'async'],
    ['var x = {}.constructor; return function (t) {};', 'constructor'],
  ];
  for (const [code, needle] of bad) {
    test(`rejects: ${code.slice(0, 50)}`, () => {
      const problems = animationCodeProblems(code);
      expect(problems.some((p) => p.includes(needle))).toBe(true);
    });
  }

  test('words inside strings and comments are fine; bounded loops and for…of are fine', () => {
    const ok = `// draws the window of opportunity
var title = lb.text('window, parent, fetch', { x: 800, y: 80 });
for (var i = 0; i < 12; i++) { lb.circle({ cx: 100 + i * 120, cy: 450, r: 20 }); }
for (const item of lb.items) { lb.label(item.label, { x: 800, y: 600 }); }
return function (t) { title.set({ opacity: lb.seg(t, 0, 1) }); };`;
    expect(animationCodeProblems(ok)).toEqual([]);
  });
});

describe('M3: sandbox document and host protocol', () => {
  test('document: CSP without network, program inlined, closing tags escaped', () => {
    const doc = sandboxDocument('var s = "</script><img src=x>"; return function (t) {};');
    expect(doc).toContain(`content="${SANDBOX_CSP}"`);
    expect(SANDBOX_CSP).toContain("default-src 'none'");
    expect(SANDBOX_CSP).not.toMatch(/connect-src|https?:/u);
    expect(doc.match(/<\/script>/gu)?.length).toBe(2); // library + program only
  });

  function setup() {
    let now = 0;
    const sent: Array<{ type: string; t?: number; nonce?: string }> = [];
    const statuses: SandboxStatus[] = [];
    const host = new SandboxHost({ post: (m) => sent.push(m as { type: string }) }, init, () => now, (s) => statuses.push(s));
    return { host, sent, statuses, advance: (ms: number) => (now += ms) };
  }

  test('init → ready → seek only on change → tick; foreign nonce ignored', () => {
    const { host, sent, statuses, advance } = setup();
    host.loaded();
    expect(sent[0]).toMatchObject({ type: 'init', nonce: host.nonce, cues: [1, 2] });
    host.seek(1);
    expect(sent).toHaveLength(1); // not running yet
    host.receive({ type: 'ready', nonce: 'someone-else' });
    expect(host.status.state).toBe('loading');
    host.receive({ type: 'ready', nonce: host.nonce });
    expect(statuses.at(-1)).toEqual({ state: 'running' });
    host.seek(1);
    host.seek(1);
    expect(sent.filter((m) => m.type === 'seek')).toHaveLength(1);
    host.receive({ type: 'tick', nonce: host.nonce, t: 1 });
    advance(5000);
    host.seek(2);
    expect(host.status.state).toBe('running');
  });

  test('watchdog: no ready in time, no tick in time, or an error → failed (final)', () => {
    const a = setup();
    a.host.loaded();
    a.advance(READY_TIMEOUT_MS + 1);
    a.host.seek(0);
    expect(a.host.status).toEqual({ state: 'failed', reason: 'did not start in time' });

    const b = setup();
    b.host.loaded();
    b.host.receive({ type: 'ready', nonce: b.host.nonce });
    b.host.seek(1);
    b.advance(TICK_TIMEOUT_MS + 1);
    b.host.seek(2);
    expect(b.host.status.state).toBe('failed');
    b.host.receive({ type: 'ready', nonce: b.host.nonce });
    expect(b.host.status.state).toBe('failed');

    const c = setup();
    c.host.loaded();
    c.host.receive({ type: 'error', nonce: c.host.nonce, message: 'x is not defined' });
    expect(c.host.status).toEqual({ state: 'failed', reason: 'x is not defined' });
  });
});

describe('M3: animation state and view', () => {
  withDom();
  const plan: VisualPlan = {
    version: 't',
    mode: 'animation',
    rationale: 'r',
    keyTerms: ['Mut'],
    fallback: 'kinetic',
    diagram: { template: 'cycle', items: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }] },
    animation: { brief: 'b' },
    cues: [{ anchor: { sentenceId: 's', phrase: 'x' }, action: { type: 'reveal', itemId: 'a' } }],
  };

  test('section-relative time and cues; diagram as fallback; locked-down iframe', () => {
    const s = visualState(plan, [12], 15, 'full', { animation: { key: 'k', code: EXAMPLE_PROGRAM, sectionStart: 10, palette: init.palette } });
    expect(s.mode).toBe('animation');
    if (s.mode !== 'animation') return;
    expect(s.t).toBe(5);
    expect(s.init.cues).toEqual([2]);
    expect(s.fallback.mode).toBe('diagram');
    const root = document.createElement('div');
    render(<Visual state={s} />, root);
    const frame = root.querySelector('iframe')!;
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('srcdoc')).toContain('__lbProgram');
    expect(root.querySelector('.lb-animation-fallback svg')).not.toBeNull();
    // Without a program the plan simply shows its diagram.
    expect(visualState(plan, [12], 15, 'full').mode).toBe('diagram');
  });
});
