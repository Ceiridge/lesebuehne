/**
 * `bun run build`
 * Writes the static player (Bun HTML bundler, relative ./ asset URLs) and a copy of
 * samples/** to dist/. The output runs on any static HTTP server, also under a sub-path.
 */
import { $ } from 'bun';

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
  return { outdir: out, files: files.sort() };
}

if (import.meta.main) {
  const { outdir, files } = await build();
  for (const file of files) console.log(`  ${file}`);
  console.log(`Built ${files.length} files to ${outdir}`);
}
