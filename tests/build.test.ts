import { afterAll, describe, expect, test } from 'bun:test';
import { $ } from 'bun';
import { build } from '../scripts/build.ts';
import { SAMPLES_PRESENT } from './support/samples.ts';

const ROOT = Bun.fileURLToPath(new URL('..', import.meta.url));
const TMP = `${ROOT}out/tmp/build-test-${crypto.randomUUID()}`;

/** Every src/href value in the HTML file, except inline `data:` URLs (the favicon). */
function assetRefs(html: string): string[] {
  return [...html.matchAll(/\s(?:src|href)\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]!).filter((r) => !r.startsWith('data:'));
}

afterAll(async () => {
  await $`rm -rf ${TMP}`.quiet();
});

describe('01-3: static build', () => {
  test('build(outdir) writes index.html that references only existing relative ./ assets', async () => {
    const outdir = `${TMP}/dist-a`;
    await build(outdir, { samplesDir: `${TMP}/no-samples-here` });

    const index = Bun.file(`${outdir}/index.html`);
    expect(await index.exists()).toBe(true);
    const refs = assetRefs(await index.text());
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.some((r) => r.endsWith('.js'))).toBe(true);
    for (const ref of refs) {
      expect(ref.startsWith('./')).toBe(true);
      expect(await Bun.file(`${outdir}/${ref.slice(2)}`).exists()).toBe(true);
    }
    // No samples dir in the source: no samples dir in the output.
    expect(await Bun.file(`${outdir}/samples/samples.json`).exists()).toBe(false);
  });

  test('build(outdir) copies samples/** when present', async () => {
    const samplesDir = `${TMP}/samples`;
    await Bun.write(`${samplesDir}/samples.json`, '{"samples":[]}');
    await Bun.write(`${samplesDir}/nested/book.txt`, 'Sapere aude!');
    const outdir = `${TMP}/dist-b`;
    await build(outdir, { samplesDir });

    expect(await Bun.file(`${outdir}/samples/samples.json`).text()).toBe('{"samples":[]}');
    expect(await Bun.file(`${outdir}/samples/nested/book.txt`).text()).toBe('Sapere aude!');
    expect(await Bun.file(`${outdir}/index.html`).exists()).toBe(true);
  });
});

describe('16-1: release build check', () => {
  test('index.html, assets, 4 font families, licences, samples, PWA files; no remote URLs', async () => {
    const outdir = `${TMP}/dist-release`;
    const { files } = await build(outdir);
    expect(files).toContain('index.html');
    expect(files.some((f) => /^chunk-.+\.js$/.test(f))).toBe(true);
    expect(files.some((f) => /^chunk-.+\.css$/.test(f))).toBe(true);
    for (const family of ['literata', 'source-sans-3', 'atkinson-hyperlegible-next', 'opendyslexic']) {
      expect(files.some((f) => f.startsWith(family) && f.endsWith('.woff2'))).toBe(true);
      expect(files).toContain(`licenses/fonts/${family}.txt`);
    }
    if (SAMPLES_PRESENT) for (const f of ['samples/samples.json', 'samples/aufklaerung.txt', 'samples/kybalion-chapter-2.md']) expect(files).toContain(f);
    const html = await Bun.file(`${outdir}/index.html`).text();
    const css = (await Promise.all(files.filter((f) => f.endsWith('.css')).map((f) => Bun.file(`${outdir}/${f}`).text()))).join('\n');
    const remote = [
      ...[...html.matchAll(/\s(?:src|href)\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]!),
      ...[...css.matchAll(/url\(\s*["']?([^"')]+)/g)].map((m) => m[1]!),
    ].filter((u) => /^https?:\/\//i.test(u));
    expect(remote).toEqual([]);
    // M6 (spec 006 B2): installable and offline.
    for (const f of ['manifest.webmanifest', 'sw.js', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png']) expect(files).toContain(f);
    expect(html).toContain('<link rel="manifest" href="./manifest.webmanifest">');
    expect(html).toContain('<meta name="lb-service-worker" content="./sw.js">');
    const m = JSON.parse(await Bun.file(`${outdir}/manifest.webmanifest`).text()) as { start_url: string; scope: string; icons: Array<{ src: string }> };
    expect([m.start_url, m.scope]).toEqual(['./', './']);
    for (const icon of m.icons) expect(files).toContain(icon.src);
    const png = new Uint8Array(await Bun.file(`${outdir}/icons/icon-512.png`).arrayBuffer());
    expect([...png.slice(1, 4)].map((c) => String.fromCharCode(c)).join('')).toBe('PNG');
    expect(new DataView(png.buffer).getUint32(16)).toBe(512);
    const sw = await Bun.file(`${outdir}/sw.js`).text();
    const precache = JSON.parse(/const PRECACHE = (\[.*\]);/u.exec(sw)![1]!) as string[];
    expect(precache).toContain('./index.html');
    expect(precache).toContain('./manifest.webmanifest');
    expect(precache.some((p) => p.includes('/api/') || p === './sw.js')).toBe(false);
    expect(sw).toContain("url.pathname.includes('/api/')");
    expect(sw).toContain('url.origin !== self.location.origin');
  });

  test('build refuses to clean a root or the repository', async () => {
    await expect(build('/')).rejects.toThrow(/refusing/);
    await expect(build(ROOT)).rejects.toThrow(/refusing/);
  });
});
