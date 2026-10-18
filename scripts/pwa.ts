/**
 * PWA parts of the static build (spec 006 B2): app icon (SVG + PNG rasterised here, no image
 * library), web app manifest and a small generated service worker.
 */
import { deflateSync } from 'node:zlib';

export const THEME_COLOR = '#2f5d50';
const BACKGROUND = '#fbfaf7';

/** The app icon (also the favicon): an open book on the accent colour. */
export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="${THEME_COLOR}"/><path d="M12 46c7-4 13-4 20 0 7-4 13-4 20 0V18c-7-4-13-4-20 0-7-4-13-4-20 0Z" fill="none" stroke="white" stroke-width="3.5" stroke-linejoin="round"/><path d="M32 18v28" stroke="white" stroke-width="3.5"/></svg>`;

type Pt = [number, number];

/** Samples a cubic Bézier. */
function cubic(p0: Pt, p1: Pt, p2: Pt, p3: Pt, n = 16): Pt[] {
  const out: Pt[] = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    out.push([u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0], u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]]);
  }
  return out;
}

/** The book outline of ICON_SVG as polylines (64-unit space). */
function bookLines(): Pt[][] {
  const outline: Pt[] = [[12, 46], ...cubic([12, 46], [19, 42], [25, 42], [32, 46]), ...cubic([32, 46], [39, 42], [45, 42], [52, 46]), [52, 18], ...cubic([52, 18], [45, 14], [39, 14], [32, 18]), ...cubic([32, 18], [25, 14], [19, 14], [12, 18]), [12, 46]];
  return [outline, [[32, 18], [32, 46]]];
}

function segDistance(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

const hex = (c: string): [number, number, number] => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];

function crc32(bytes: Uint8Array): number {
  let c = ~0;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/** The icon as an RGBA PNG of `size`×`size` (one signed-distance sample per pixel, anti-aliased). */
export function iconPng(size: number, { maskable = false } = {}): Uint8Array {
  const [br, bg, bb] = hex(THEME_COLOR);
  const segments = bookLines().flatMap((line) => line.slice(1).map((b, i): [Pt, Pt] => [line[i]!, b]));
  const pixel = 64 / size;
  // Maskable icons need the motif inside the central 80 % safe zone and a full-bleed background.
  const motif = maskable ? 1 - 2 * 0.14 : 1;
  const radius = maskable ? 0 : 16;
  const raw = new Uint8Array(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const px = (x + 0.5) * pixel;
      const py = (y + 0.5) * pixel;
      // Rounded-square SDF (negative inside).
      const qx = Math.abs(px - 32) - (32 - radius);
      const qy = Math.abs(py - 32) - (32 - radius);
      const box = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
      const m: Pt = [32 + (px - 32) / motif, 32 + (py - 32) / motif];
      let d = Infinity;
      for (const [s0, s1] of segments) d = Math.min(d, segDistance(m, s0, s1));
      const a = clamp01(0.5 - box / pixel);
      const w = clamp01(0.5 + (1.75 - d) * motif / pixel);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = Math.round(br + (255 - br) * w);
      raw[o + 1] = Math.round(bg + (255 - bg) * w);
      raw[o + 2] = Math.round(bb + (255 - bb) * w);
      raw[o + 3] = Math.round(255 * Math.max(a, w * a));
    }
  }
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, size);
  v.setUint32(4, size);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', new Uint8Array(deflateSync(raw))), chunk('IEND', new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function manifest(): string {
  return JSON.stringify(
    {
      name: 'Lesebühne',
      short_name: 'Lesebühne',
      description: 'Bücher wortgetreu vorlesen – mit Text, Hervorhebung und ruhigen Bildern.',
      start_url: './',
      scope: './',
      display: 'standalone',
      background_color: BACKGROUND,
      theme_color: THEME_COLOR,
      icons: [
        { src: 'icons/icon.svg', sizes: 'any', type: 'image/svg+xml' },
        { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    },
    null,
    2,
  );
}

/**
 * The service worker: precaches the built files (version = content hash), serves hashed assets
 * cache-first and pages network-first, and never touches API or cross-origin requests.
 */
export function serviceWorker(files: readonly string[], version: string): string {
  const precache = ['./', ...files.filter((f) => f !== 'sw.js').map((f) => `./${f}`)];
  return `// Lesebühne service worker (generated by scripts/pwa.ts).
const VERSION = ${JSON.stringify(version)};
const CACHE = 'lesebuehne-' + VERSION;
const PRECACHE = ${JSON.stringify(precache)};

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('lesebuehne-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Only this app's own files; never API calls, provider requests or other origins.
  if (url.origin !== self.location.origin || url.pathname.includes('/api/')) return;
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('./', copy));
          return res;
        })
        .catch(() => caches.match('./').then((r) => r || caches.match('./index.html'))),
    );
    return;
  }
  event.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
});
`;
}
