import { settings } from '../../app/store.ts';
import { t } from '../../i18n/i18n.ts';
import { IconSpeaker } from '../icons.tsx';
import { useEffect, useRef } from 'preact/hooks';

export function VolumeSlider({ id = 'reader-volume' }: { id?: string }) {
  const volume = settings.value.volume;
  return <div class="field volume-field">
    <label class="field-label" for={id}>{t('settings.volume')}<output for={id}>{Math.round(volume * 100)}%</output></label>
    <input id={id} type="range" min="0" max="100" step="1" value={Math.round(volume * 100)} onInput={(e) => (settings.value = { ...settings.value, volume: Number(e.currentTarget.value) / 100 })} />
  </div>;
}

export function VolumeControl() {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const outside = (e: PointerEvent) => { if (ref.current?.open && !ref.current.contains(e.target as Node)) ref.current.open = false; };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, []);
  return <details ref={ref} class="volume-control" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); e.currentTarget.open = false; e.currentTarget.querySelector('summary')?.focus(); } }}>
    <summary aria-label={t('settings.volume')} title={`${t('settings.volume')}: ${Math.round(settings.value.volume * 100)}%`}><IconSpeaker size={19} /><span class="volume-value">{Math.round(settings.value.volume * 100)}%</span></summary>
    <div class="volume-popover"><VolumeSlider /></div>
  </details>;
}
