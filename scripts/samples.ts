/**
 * `bun run samples [--force]`
 * Generates the local `samples/` folder (gitignored): downloads the public-domain sources listed in
 * `scripts/samples.catalog.json`, derives each sample with exactly the edits documented there,
 * verifies its SHA-256 against the reviewed version and writes `samples/samples.json` (the catalog
 * the start page reads).
 */
import { parseSamples, type Sample } from '../packages/ingest/src/samples.ts';

const ROOT = new URL('../', import.meta.url);
const SAMPLES_DIR = new URL('samples/', ROOT);

const BOM = 0xfeff;
const lines = (text: string): string[] =>
  (text.charCodeAt(0) === BOM ? text.slice(1) : text).replace(/\r\n?/gu, '\n').split('\n');

function trimEnd(list: string[]): string[] {
  const out = [...list];
  while (out.length > 0 && out.at(-1)?.trim() === '') out.pop();
  return out;
}

/** Kant: from the title line to the end of footnote [1]; transcriber markers `=` and `_` removed. */
function deriveKant(source: string): string {
  const all = lines(source);
  const title = 'Beantwortung der Frage: Was ist Aufklärung?';
  const start = all.findIndex((l, i) => i > 40 && l === title);
  const end = all.findIndex((l) => l === 'Lesarten');
  if (start < 0 || end < 0) throw new Error('Kant source: start or end marker not found');
  return `${trimEnd(all.slice(start, end)).map((l) => l.replace(/[=_]/gu, '')).join('\n')}\n`;
}

/** Kybalion: Chapter II with Markdown syntax added (headings, ordered list, block quotes). */
function deriveKybalion(source: string): string {
  const all = lines(source);
  const start = all.findIndex((l) => l === 'CHAPTER II');
  const end = all.findIndex((l) => l === 'CHAPTER III');
  if (start < 0 || end < 0) throw new Error('Kybalion source: chapter markers not found');
  const out = trimEnd(all.slice(start, end)).map((l) => {
    if (l === 'CHAPTER II') return '# CHAPTER II';
    if (l === 'THE SEVEN HERMETIC PRINCIPLES') return '## THE SEVEN HERMETIC PRINCIPLES';
    if (/^\d\. {2}The Principle of /u.test(l)) return `### ${l}`;
    if (/^ {4}\d\. The Principle of /u.test(l)) return l.slice(4);
    if (l.startsWith('    ')) return `> ${l.slice(4)}`;
    return l;
  });
  return `${out.join('\n')}\n`;
}

const DERIVE: Readonly<Record<string, (source: string) => string>> = {
  aufklaerung: deriveKant,
  'kybalion-chapter-2': deriveKybalion,
};

async function sha256(text: string): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(text);
  return hasher.digest('hex');
}

export async function makeSample(sample: Sample, fetchText: (url: string) => Promise<string>): Promise<string> {
  const derive = DERIVE[sample.id];
  if (!derive) throw new Error(`no derivation for sample ${sample.id}`);
  const text = derive(await fetchText(sample.provenance.sourceUrl));
  if (sample.sha256 && (await sha256(text)) !== sample.sha256) {
    throw new Error(`${sample.file}: derived text differs from the reviewed version (SHA-256 mismatch); the source may have changed`);
  }
  return text;
}

if (import.meta.main) {
  const force = Bun.argv.includes('--force');
  const catalog = parseSamples(await Bun.file(new URL('scripts/samples.catalog.json', ROOT)).json());
  const { samples } = catalog;
  for (const s of samples) {
    const target = Bun.fileURLToPath(new URL(s.file, SAMPLES_DIR));
    if (!force && (await Bun.file(target).exists())) {
      console.log(`  ${s.file}: present`);
      continue;
    }
    const text = await makeSample(s, async (url) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      return res.text();
    });
    await Bun.write(target, text);
    console.log(`  ${s.file}: written (${text.length} characters, SHA-256 verified)`);
  }
  await Bun.write(new URL('samples.json', SAMPLES_DIR), `${JSON.stringify(catalog, null, 2)}\n`);
  console.log('  samples.json: written');
}
