import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { VisualState } from '../state/visual-state.ts';

type ImageVisual = Extract<VisualState, { mode: 'image' }>;

/** URLs this document has already loaded and decoded: they show at once, without the fallback. */
const decoded = new Set<string>();
const decoding = new Set<string>();

/**
 * Loads and decodes an image before it is needed, so a stage change shows the picture at once
 * instead of the fallback for a few frames.
 */
export function preloadImage(url: string): void {
  if (decoded.has(url) || decoding.has(url) || typeof Image === 'undefined') return;
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  decoding.add(url);
  const done = img.decode ? img.decode() : new Promise<void>((resolve, reject) => { img.onload = () => resolve(); img.onerror = reject; });
  done.then(() => decoded.add(url), () => undefined).finally(() => decoding.delete(url));
}

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

interface Layer {
  url: string;
  status: 'loading' | 'ready' | 'failed';
  /** Camera of a picture that is fading out (frozen where it was). */
  transform?: string;
}

/** How long a replaced picture stays under the new one: longer than the CSS fade. */
const KEEP_MS = 1400;

/**
 * A generated illustration with a Ken Burns camera (CSS transform from the pure camera state). A
 * new picture loads under the current one and fades in over it once it is ready; the fallback
 * shows only while no picture is ready, and stays if none can be loaded.
 */
export function ImageView({ state, fallback }: { state: ImageVisual; fallback: ComponentChildren }) {
  const { x, y, scale } = state.camera;
  const transform = `translate(${((0.5 - x * scale) * 100).toFixed(3)}%, ${((0.5 - y * scale) * 100).toFixed(3)}%) scale(${scale.toFixed(4)})`;
  const [layers, setLayers] = useState<Layer[]>(() => [{ url: state.url, status: decoded.has(state.url) ? 'ready' : 'loading' }]);
  const live = useRef(transform);
  live.current = transform;

  useEffect(() => {
    setLayers((ls) => {
      if (ls.at(-1)?.url === state.url) return ls;
      // Keep the newest ready picture (frozen) under the incoming one; drop the rest.
      const shown = ls.filter((l) => l.status === 'ready').slice(-1).map((l) => ({ ...l, transform: l.transform ?? live.current }));
      return [...shown, { url: state.url, status: 'loading' }];
    });
  }, [state.url]);

  const top = layers.at(-1)!;
  useEffect(() => {
    if (top.status === 'loading' || layers.length < 2) return;
    // The new picture is in (or failed): remove the old ones after the fade.
    const timer = setTimeout(() => setLayers((ls) => (ls.at(-1) === top ? (top.status === 'ready' ? [top] : ls.slice(0, -1)) : ls)), top.status === 'ready' ? KEEP_MS : 0);
    return () => clearTimeout(timer);
  }, [top, layers.length]);

  const mark = (layer: Layer, status: 'ready' | 'failed'): void => {
    if (status === 'ready') decoded.add(layer.url);
    setLayers((ls) => ls.map((l) => (l.url === layer.url ? { ...l, status } : l)));
  };
  const anyReady = layers.some((l) => l.status === 'ready');
  return (
    <div class={`lb-visual lb-image is-${anyReady ? 'ready' : top.status}`} aria-hidden="true">
      {anyReady ? null : <div class="lb-image-fallback">{fallback}</div>}
      {layers.map((layer) => layer.status === 'failed' ? null : (
        <div key={layer.url} class={`lb-image-layer is-${layer.status}`}>
          <img class="lb-image-backdrop" src={layer.url} alt="" decoding="async" draggable={false} />
          <img
            class="lb-image-picture"
            src={layer.url}
            alt=""
            decoding="async"
            draggable={false}
            onLoad={() => mark(layer, 'ready')}
            onError={() => mark(layer, 'failed')}
            style={{ transform: layer.transform ?? transform }}
          />
        </div>
      ))}
    </div>
  );
}
