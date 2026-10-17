/**
 * `bun run doctor`
 * Prints every provider's availability and configuration problems. Never prints secrets.
 */
import { createLocalApi } from '@lesebuehne/server';

const ROOT = Bun.fileURLToPath(new URL('..', import.meta.url));

if (import.meta.main) {
  const { loaded, context } = await createLocalApi(ROOT, () => {});
  const { registry, chain } = context.providers;
  console.log(`Config: ${loaded.files.join(', ') || 'defaults only'}`);
  console.log(`Data directory: ${loaded.dataDir}`);
  console.log(`LLM chain: ${[...chain, 'heuristic'].join(' → ')}\n`);
  let usable = 0;
  for (const p of registry.list()) {
    const a = await registry.available(p.id, true);
    if (a.ok && chain.includes(p.id)) usable++;
    const source = 'lastSource' in p && p.lastSource ? ` [token: ${String(p.lastSource)}]` : '';
    console.log(`${a.ok ? '✔' : '✘'} ${p.id.padEnd(22)} ${p.label}${source}${a.ok ? '' : `\n    → ${a.reason ?? 'unavailable'}`}`);
  }
  console.log(`✔ ${'heuristic'.padEnd(22)} Heuristic director (always available)`);
  console.log(usable ? `\n${usable} LLM provider(s) ready.` : '\nNo LLM provider ready: plans come from the heuristic director.');
}
