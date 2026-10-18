import { describe, expect, test } from 'bun:test';
import type { ImageSpec, VisualPlan } from '@lesebuehne/core';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { withDom } from '../../../tests/support/with-dom.ts';
import { CAMERA_MOVE_SECONDS, cameraAt, cameraFor, Visual, visualState } from '../src/index.ts';

const spec: ImageSpec = {
  prompt: 'p',
  aspect: '16:9',
  focusRegions: [
    { id: 'wall', label: 'Wall', x: 0.6, y: 0.1, w: 0.35, h: 0.4 },
    { id: 'man', label: 'Man', x: 0.05, y: 0.5, w: 0.2, h: 0.45 },
  ],
};
const focus = [
  { time: 10, regionId: 'wall' },
  { time: 20, regionId: 'man' },
];

describe('M5: Ken Burns camera', () => {
  test('still before the first cue; gentle focus stays below four percent zoom and inside the image', () => {
    const before = cameraAt(spec, focus, 5, 'full');
    expect(before.scale).toBe(1);
    const done = cameraAt(spec, focus, 10 + CAMERA_MOVE_SECONDS, 'full');
    expect(done).toEqual(cameraFor(spec.focusRegions[0]!));
    const mid = cameraAt(spec, focus, 10 + CAMERA_MOVE_SECONDS / 2, 'full');
    expect(mid.scale).toBeGreaterThan(before.scale);
    expect(mid.scale).toBeLessThan(done.scale);
    for (const t of [0, 7, 11, 15, 21, 40]) {
      const c = cameraAt(spec, focus, t, 'full');
      expect(c.scale).toBeLessThanOrEqual(1.04);
      const half = 0.5 / c.scale;
      expect(c.x - half).toBeGreaterThanOrEqual(-1e-9);
      expect(c.x + half).toBeLessThanOrEqual(1 + 1e-9);
      expect(c.y - half).toBeGreaterThanOrEqual(-1e-9);
      expect(c.y + half).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  test('pure function of t (seek = continuous playback); unknown regions ignored; no motion = whole image', () => {
    expect(cameraAt(spec, focus, 21.3, 'full')).toEqual(cameraAt(spec, focus, 21.3, 'full'));
    expect(cameraAt(spec, [{ time: 1, regionId: 'nope' }], 30, 'full').scale).toBeLessThan(1.1);
    expect(cameraAt(spec, focus, 30, 'reduced')).toEqual({ x: 0.5, y: 0.5, scale: 1 });
    expect(cameraAt(spec, focus, 30, 'none')).toEqual({ x: 0.5, y: 0.5, scale: 1 });
  });
});

describe('M5: image and placeholder views', () => {
  withDom();
  const plan: VisualPlan = {
    version: 't',
    mode: 'image',
    rationale: 'r',
    keyTerms: ['Mauer'],
    fallback: 'kinetic',
    image: spec,
    cues: [
      { anchor: { sentenceId: 's', phrase: 'x' }, action: { type: 'showTerm', term: 'Mauer' } },
      { anchor: { sentenceId: 's', phrase: 'x' }, action: { type: 'focus', regionId: 'wall' } },
    ],
  };

  test('without an image: placeholder with the terms; with one: picture over the placeholder until loaded', () => {
    const p = visualState(plan, [1, 10], 15, 'full');
    expect(p.mode).toBe('placeholder');
    const root = document.createElement('div');
    render(<Visual state={p} />, root);
    expect(root.querySelector('.lb-placeholder')).not.toBeNull();
    expect(root.textContent).toContain('Mauer');
    const s = visualState(plan, [1, 10], 15, 'full', { image: { url: 'api/images/x.png' } });
    expect(s.mode).toBe('image');
    if (s.mode !== 'image') return;
    expect(s.camera.scale).toBeGreaterThan(1);
    expect(s.camera.scale).toBeLessThanOrEqual(1.04);
    const still = visualState(plan, [1, 10], 15, 'full', { image: { url: 'api/images/x.png', animate: false } });
    expect(still.mode).toBe('image');
    if (still.mode !== 'image') return;
    expect(still.camera).toEqual({ x: 0.5, y: 0.5, scale: 1 });
    expect(still.fallback).toEqual(s.fallback);
    render(<Visual state={s} />, root);
    const img = root.querySelector('.lb-image-picture')!;
    expect(img.getAttribute('src')).toBe('api/images/x.png');
    expect(img.getAttribute('style')).toContain('scale(');
    expect(root.querySelector('.lb-image-fallback .lb-placeholder')).not.toBeNull();
  });
});

describe('image crossfade', () => {
  withDom();
  const plan = { mode: 'image', image: spec, keyTerms: ['Mauer'], cues: [] } as unknown as VisualPlan;
  const at = (url: string) => {
    const s = visualState(plan, [], 1, 'full', { image: { url } });
    if (s.mode !== 'image') throw new Error('expected an image state');
    return s;
  };

  test('a new picture loads under the current one and replaces it after the fade, without the fallback', async () => {
    const root = document.createElement('div');
    const layers = () => [...root.querySelectorAll('.lb-image-layer')].map((l) => `${l.querySelector('img')!.getAttribute('src')}:${l.className.replace('lb-image-layer is-', '')}`);
    await act(() => render(<Visual state={at('a.png')} />, root));
    expect(root.querySelector('.lb-image-fallback')).not.toBeNull();
    await act(() => void root.querySelector('.lb-image-picture')!.dispatchEvent(new Event('load')));
    expect(root.querySelector('.lb-image-fallback')).toBeNull();
    await act(() => render(<Visual state={at('b.png')} />, root));
    expect(layers()).toEqual(['a.png:ready', 'b.png:loading']);
    expect(root.querySelector('.lb-image-fallback')).toBeNull();
    await act(() => void root.querySelectorAll('.lb-image-picture')[1]!.dispatchEvent(new Event('load')));
    expect(layers()).toEqual(['a.png:ready', 'b.png:ready']);
    await act(() => new Promise((r) => setTimeout(r, 1500)));
    expect(layers()).toEqual(['b.png:ready']);
    // A picture this document has loaded before shows at once when it comes back.
    render(null, root);
    await act(() => render(<Visual state={at('b.png')} />, root));
    expect(layers()).toEqual(['b.png:ready']);
  });
});

