import { afterEach, describe, expect, test } from 'bun:test';
import { render } from 'preact';
import { withDom } from '../../../../tests/support/with-dom.ts';
import { settings } from '../../src/app/store.ts';
import { defaultSettings } from '../../src/settings/settings.ts';
import { Timeline } from '../../src/ui/reader/Timeline.tsx';
import { bundleOf, flush, makeEnv, openSession } from './support.ts';

describe('timeline with tracks and zoom', () => {
  const dom = withDom();
  afterEach(() => { settings.value = defaultSettings(); });

  test('one crosshair over all lines, wheel zoom at the pointer, click anywhere jumps inside the view', async () => {
    const text = Array.from({ length: 120 }, (_, i) => `Satz Nummer ${i + 1} erzählt etwas Neues über den Fluss.`).join(' ');
    const session = await openSession(await makeEnv(), bundleOf('long.txt', new TextEncoder().encode(text)));
    const host = document.createElement('div');
    document.body.appendChild(host);
    render(<Timeline session={session} />, host);
    await flush();
    const hit = host.querySelector<HTMLElement>('.timeline-hit')!;
    hit.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1000, bottom: 40, width: 1000, height: 40, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    const win = dom.window as unknown as { PointerEvent: typeof PointerEvent; WheelEvent: typeof WheelEvent };
    const pointer = (type: string, clientX: number) => hit.dispatchEvent(new win.PointerEvent(type, { clientX, bubbles: true, button: 0 }));
    try {
      // The tracks and the main line share one grid; the legend sits in the head row.
      expect(host.querySelector('.timeline-head .generation-legend')).not.toBeNull();
      expect(host.querySelectorAll('.timeline-body .generation-row')).toHaveLength(2);

      pointer('pointermove', 500);
      await flush();
      expect(host.querySelector('.timeline-crosshair')).not.toBeNull();
      expect(host.querySelectorAll('.timeline-tooltip-lanes > span')).toHaveLength(2);
      expect(host.querySelector('.timeline-tooltip-text')!.textContent).toContain('Satz Nummer');

      expect(host.querySelector('.timeline-range')).toBeNull();
      const wheel = (): void => {
        const e = new win.WheelEvent('wheel', { deltaY: -300, bubbles: true, cancelable: true });
        Object.defineProperty(e, 'clientX', { value: 500 });
        host.querySelector('.timeline-body')!.dispatchEvent(e);
      };
      wheel();
      wheel();
      await flush();
      expect(host.querySelector('.timeline-range')).not.toBeNull();
      expect(host.querySelectorAll('.timeline-tick').length).toBeGreaterThan(0);

      // A click at the right edge of the zoomed view lands inside the view, not at the end of the book.
      pointer('pointerdown', 1000);
      pointer('pointerup', 1000);
      await flush();
      const entry = session.engine.position.value.entryIndex;
      expect(entry).toBeGreaterThan(30);
      expect(entry).toBeLessThan(session.timeline.entries.length - 20);

      [...host.querySelectorAll<HTMLButtonElement>('.timeline-zoom button')].find((b) => b.classList.contains('chip'))!.click();
      await flush();
      expect(host.querySelector('.timeline-range')).toBeNull();
    } finally {
      render(null, host);
      host.remove();
      session.dispose();
    }
  });
});
