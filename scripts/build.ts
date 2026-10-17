/**
 * `bun run build`
 * Writes the static player (Bun HTML bundler, relative ./ asset URLs) and a copy of
 * samples/** to dist/, plus manifest, icons and a service worker (installable, offline). The
 * output runs on any static HTTP server, also under a sub-path.
 */
import { $ } from 'bun';
import { contentHash } from '@lesebuehne/core';
import { ICON_SVG, iconPng, manifest, serviceWorker, THEME_COLOR } from './pwa.ts';

const ROOT = Bun.fileURLToPath(new URL('..', import.meta.url));

/** Self-hosted font packages whose LICENSE is copied to dist/licenses/fonts/. */
export const FONT_PACKAGES: ReadonlyArray<readonly [string, string]> = [
  ['literata', '@fontsource-variable/literata'],
  ['source-sans-3', '@fontsource-variable/source-sans-3'],
  ['atkinson-hyperlegible-next', '@fontsource/atkinson-hyperlegible-next'],
  ['opendyslexic', '@fontsource/opendyslexic'],
];

export interface BuildOptions {
  /** Directory copied to `<outdir>/samples` when it exists (default `<repo>/samples`). */
  samplesDir?: string;
}

export interface BuildResult {
  outdir: string;
  /** Output files relative to `outdir`. */
  files: string[];
}

/** Copies every file below `from` to the same relative path below `to`; returns the relative paths. */
async function copyTree(from: string, to: string): Promise<string[]> {
  const copied: string[] = [];
  for await (const rel of new Bun.Glob('**/*').scan({ cwd: from, dot: false, onlyFiles: true })) {
    const path = rel.replaceAll('\\', '/');
    await Bun.write(`${to}/${path}`, Bun.file(`${from}/${path}`));
    copied.push(path);
  }
  return copied;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await Bun.file(path).stat()).isDirectory();
  } catch {
    return false;
  }
}

/** Cleans `outdir`, bundles the player into it and copies the samples. */
export async function build(outdir = `${ROOT}dist`, { samplesDir = `${ROOT}samples` }: BuildOptions = {}): Promise<BuildResult> {
  const out = outdir.replace(/[\\/]+$/, '');
  // Refuse to wipe an empty path, a filesystem or drive root, or the repository itself.
  const normal = out.replaceAll('\\', '/').toLowerCase();
  const repo = ROOT.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
  if (normal === '' || /^([a-z]:)?\/?$/.test(normal) || normal === repo) {
    throw new Error(`refusing to clean output directory "${outdir}"`);
  }
  await $`rm -rf ${out}`.quiet();

  const result = await Bun.build({
    entrypoints: [`${ROOT}packages/player/index.html`],
    outdir: out,
    target: 'browser',
    minify: true,
  });
  if (!result.success) {
    throw new AggregateError(result.logs, 'bun build failed');
  }

  const files = (await Array.fromAsync(new Bun.Glob('**/*').scan({ cwd: out, onlyFiles: true }))).map((f) =>
    f.replaceAll('\\', '/'),
  );
  if (await isDirectory(samplesDir)) {
    files.push(...(await copyTree(samplesDir, `${out}/samples`)).map((f) => `samples/${f}`));
  }
  // OFL: each font's licence travels with the font files.
  for (const [name, pkg] of FONT_PACKAGES) {
    await Bun.write(`${out}/licenses/fonts/${name}.txt`, Bun.file(`${ROOT}node_modules/${pkg}/LICENSE`));
    files.push(`licenses/fonts/${name}.txt`);
  }
  files.push(...(await writePwa(out, files)));
  return { outdir: out, files: files.sort() };
}

/** Icons, manifest, the manifest/service-worker tags in index.html, and sw.js (versioned by content). */
async function writePwa(out: string, files: string[]): Promise<string[]> {
  const added: Array<[string, string | Uint8Array]> = [
    ['icons/icon.svg', ICON_SVG],
    ['icons/icon-192.png', iconPng(192)],
    ['icons/icon-512.png', iconPng(512)],
    ['icons/icon-maskable-512.png', iconPng(512, { maskable: true })],
    ['manifest.webmanifest', manifest()],
  ];
  for (const [path, data] of added) await Bun.write(`${out}/${path}`, data);
  const index = `${out}/index.html`;
  const html = await Bun.file(index).text();
  await Bun.write(
    index,
    html.replace(
      '</head>',
      `<link rel="manifest" href="./manifest.webmanifest"><link rel="apple-touch-icon" href="./icons/icon-192.png"><meta name="theme-color" content="${THEME_COLOR}"><meta name="lb-service-worker" content="./sw.js"></head>`,
    ),
  );
  const all = [...files, ...added.map(([p]) => p)].sort();
  let digest = '';
  for (const file of all) digest += contentHash(await Bun.file(`${out}/${file}`).text()) + file;
  await Bun.write(`${out}/sw.js`, serviceWorker(all, contentHash(digest).slice(0, 12)));
  return [...added.map(([p]) => p), 'sw.js'];
}

if (import.meta.main) {
  const { outdir, files } = await build();
  for (const file of files) console.log(`  ${file}`);
  console.log(`Built ${files.length} files to ${outdir}`);
}
