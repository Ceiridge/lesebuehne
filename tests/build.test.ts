import { afterAll, describe, expect, test } from 'bun:test';
import { $ } from 'bun';
import { build } from '../scripts/build.ts';

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
  test('index.html, assets, 4 font families, licences, samples; no remote URLs, no service worker or manifest', async () => {
    const outdir = `${TMP}/dist-release`;
    const { files } = await build(outdir);
    expect(files).toContain('index.html');
    expect(files.some((f) => /^chunk-.+\.js$/.test(f))).toBe(true);
    expect(files.some((f) => /^chunk-.+\.css$/.test(f))).toBe(true);
    for (const family of ['literata', 'source-sans-3', 'atkinson-hyperlegible-next', 'opendyslexic']) {
      expect(files.some((f) => f.startsWith(family) && f.endsWith('.woff2'))).toBe(true);
      expect(files).toContain(`licenses/fonts/${family}.txt`);
    }
    for (const f of ['samples/samples.json', 'samples/aufklaerung.txt', 'samples/kybalion-chapter-2.md']) expect(files).toContain(f);
    const html = await Bun.file(`${outdir}/index.html`).text();
    const css = (await Promise.all(files.filter((f) => f.endsWith('.css')).map((f) => Bun.file(`${outdir}/${f}`).text()))).join('\n');
    const remote = [
      ...[...html.matchAll(/\s(?:src|href)\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]!),
      ...[...css.matchAll(/url\(\s*["']?([^"')]+)/g)].map((m) => m[1]!),
    ].filter((u) => /^https?:\/\//i.test(u));
    expect(remote).toEqual([]);
    expect(files.some((f) => /manifest\.(json|webmanifest)$/.test(f) || /(^|\/)(sw|service-worker)\.js$/.test(f))).toBe(false);
    const js = (await Promise.all(files.filter((f) => f.endsWith('.js')).map((f) => Bun.file(`${outdir}/${f}`).text()))).join('\n');
    expect(js.includes('serviceWorker.register')).toBe(false);
  });

  test('build refuses to clean a root or the repository', async () => {
    await expect(build('/')).rejects.toThrow(/refusing/);
    await expect(build(ROOT)).rejects.toThrow(/refusing/);
  });
});
