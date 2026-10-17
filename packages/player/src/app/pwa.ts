/** Where the service worker may run (spec 006 B2): secure contexts and loopback only. */
export function canUseServiceWorker(loc: Pick<Location, 'protocol' | 'hostname'>, hasApi: boolean): boolean {
  if (!hasApi) return false;
  return loc.protocol === 'https:' || loc.hostname === '127.0.0.1' || loc.hostname === 'localhost' || loc.hostname === '[::1]';
}

/**
 * Registers the build's service worker (announced by `<meta name="lb-service-worker">`, which only
 * the static build has — never the dev server). Calls `onUpdate` when a new version took over.
 */
export function registerServiceWorker(onUpdate: () => void, doc: Document = document): void {
  const nav = globalThis.navigator as Navigator | undefined;
  const meta = doc.querySelector<HTMLMetaElement>('meta[name="lb-service-worker"]');
  if (!meta || !nav || !canUseServiceWorker(location, 'serviceWorker' in nav)) return;
  const hadController = !!nav.serviceWorker.controller;
  nav.serviceWorker.register(meta.content, { scope: './' }).catch(() => undefined);
  nav.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) onUpdate();
  });
}
