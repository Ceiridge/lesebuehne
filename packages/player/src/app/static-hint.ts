/** Dismissed flag of the start page's static-mode hint (spec 006 B5). */
export const STATIC_HINT_KEY = 'lesebuehne.staticHint.dismissed';

/**
 * Whether the start page explains static mode: only once the AI lookup has finished without
 * finding anything (no server, no own keys), unless AI is switched off or the hint was dismissed.
 */
export function showStaticHint(o: { known: boolean; connecting: boolean; mode: 'heuristic' | 'server' | 'browser'; aiOff: boolean; dismissed: boolean }): boolean {
  return o.known && !o.connecting && o.mode === 'heuristic' && !o.aiOff && !o.dismissed;
}
