/**
 * `bun run fixtures [outDir]`: writes every generated EPUB fixture and every Markdown fixture to
 * `out/fixtures/` (gitignored) for the manual import checks (D8). Nothing is written to the
 * tracked tree.
 */
import { EPUB_CASES } from '../packages/ingest/test/fixtures/epub-builder.ts';

const ROOT = new URL('../', import.meta.url);
const MD_FIXTURES = ['footnotes.md', 'inline.md', 'structure.md'];

export async function writeFixtures(outDir: string): Promise<string[]> {
  const written: string[] = [];
  for (const [name, build] of Object.entries(EPUB_CASES)) {
    await Bun.write(`${outDir}/${name}.epub`, build());
    written.push(`${name}.epub`);
  }
  for (const file of MD_FIXTURES) {
    await Bun.write(`${outDir}/${file}`, Bun.file(new URL(`packages/ingest/test/fixtures/${file}`, ROOT)));
    written.push(file);
  }
  return written;
}

if (import.meta.main) {
  const outDir = Bun.argv[2] ?? Bun.fileURLToPath(new URL('out/fixtures', ROOT));
  const files = await writeFixtures(outDir);
  console.log(`Wrote ${files.length} fixtures to ${outDir}:\n  ${files.join('\n  ')}`);
}
