import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import type { VisualState } from '../state/visual-state.ts';

type ImageVisual = Extract<VisualState, { mode: 'image' }>;

/** Calm stand-in in the book's colours (spec 005 B3); the key terms stay on top. */
export function Placeholder({ children }: { children?: ComponentChildren }) {
  return (
    <div class="lb-visual lb-placeholder" aria-hidden="true">
      <span class="lb-placeholder-orb lb-orb-a" />
      <span class="lb-placeholder-orb lb-orb-b" />
      <div class="lb-placeholder-content">{children}</div>
    </div>
  );
}

/**
 * A generated illustration with a Ken Burns camera (CSS transform from the pure camera state). The
 * fallback shows until the image has loaded and stays if it cannot be loaded.
 */
export function ImageView({ state, fallback }: { state: ImageVisual; fallback: ComponentChildren }) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const { x, y, scale } = state.camera;
  return (
    <div class={`lb-visual lb-image is-${status}`} aria-hidden="true">
      {status !== 'ready' ? <div class="lb-image-fallback">{fallback}</div> : null}
      {status === 'failed' ? null : <>
        <img class="lb-image-backdrop" src={state.url} alt="" decoding="async" draggable={false} />
        <img
          class="lb-image-picture"
          src={state.url}
          alt=""
          decoding="async"
          draggable={false}
          onLoad={() => setStatus('ready')}
          onError={() => setStatus('failed')}
          style={{ transform: `translate(${((0.5 - x * scale) * 100).toFixed(3)}%, ${((0.5 - y * scale) * 100).toFixed(3)}%) scale(${scale.toFixed(4)})` }}
        />
      </>}
    </div>
  );
}
