import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { SandboxHost, type SandboxStatus } from '../animation/host.ts';
import { sandboxDocument } from '../animation/library.ts';
import type { VisualState } from '../state/visual-state.ts';

type AnimationVisual = Extract<VisualState, { mode: 'animation' }>;

export type AnimationStatusListener = (key: string, status: SandboxStatus) => void;

/**
 * An LLM-written animation in a locked-down iframe (spec 003 B4): opaque origin
 * (`sandbox="allow-scripts"` without same-origin), CSP without network. The diagram fallback shows
 * until the program runs, and stays when it fails.
 */
export function AnimationView({
  state,
  fallback,
  onStatus,
}: {
  state: AnimationVisual;
  fallback: ComponentChildren;
  onStatus?: AnimationStatusListener | undefined;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [status, setStatus] = useState<SandboxStatus>({ state: 'loading' });
  const srcdoc = useMemo(() => sandboxDocument(state.code), [state.key]);
  const host = useMemo(
    () =>
      new SandboxHost(
        { post: (m) => frame.current?.contentWindow?.postMessage(m, '*') },
        state.init,
        () => performance.now(),
        (s) => {
          setStatus(s);
          onStatus?.(state.key, s);
        },
      ),
    [state.key],
  );

  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      if (frame.current && e.source === frame.current.contentWindow) host.receive(e.data);
    };
    addEventListener('message', onMessage);
    return () => removeEventListener('message', onMessage);
  }, [host]);

  host.seek(state.t);
  // The watchdog also needs time to pass while nothing re-renders (e.g. paused).
  useEffect(() => {
    const id = setInterval(() => host.seek(state.t), 500);
    return () => clearInterval(id);
  });

  const failed = status.state === 'failed';
  return (
    <div class={`lb-visual lb-animation is-${status.state}`} aria-hidden="true">
      {status.state !== 'running' ? <div class="lb-animation-fallback">{fallback}</div> : null}
      {failed ? null : (
        <iframe
          ref={frame}
          class="lb-animation-frame"
          title="animation"
          sandbox="allow-scripts"
          referrerpolicy="no-referrer"
          srcdoc={srcdoc}
          tabIndex={-1}
          onLoad={() => host.loaded()}
        />
      )}
    </div>
  );
}
