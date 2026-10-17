import { describe, expect, test } from 'bun:test';
import { $ } from 'bun';

const ROOT = Bun.fileURLToPath(new URL('..', import.meta.url));

describe('16-2: repository content', () => {
  test('top level holds only config, packages, samples, scripts, tests, README and CHANGELOG', async () => {
    const listed = (await $`git -C ${ROOT} ls-files --cached --others --exclude-standard`.text()).split('\n').filter(Boolean);
    const top = new Set(listed.map((f) => f.split('/')[0]!));
    const allowed = new Set([
      '.gitignore', '.gitattributes', 'package.json', 'bun.lock', 'bunfig.toml', 'tsconfig.json',
      'packages', 'samples', 'scripts', 'tests', 'README.md', 'CHANGELOG.md',
    ]);
    expect([...top].filter((t) => !allowed.has(t))).toEqual([]);
    expect(listed).toContain('scripts/fixtures.ts');
    expect(listed.filter((f) => /(^|\/)(docs|adr)\//i.test(f) || /(^|\/)(PLAN|plan|spec)\.md$/.test(f))).toEqual([]);
    expect(listed.some((f) => f.startsWith('packages/cli/'))).toBe(false);
  });

  test('out/, dist/, specs/, node_modules/ are ignored; no Playwright dependency', async () => {
    for (const p of ['out/x', 'dist/x', 'specs/x', 'node_modules/x']) {
      expect((await $`git -C ${ROOT} check-ignore -q ${p}`.nothrow()).exitCode).toBe(0);
    }
    const manifests = (await $`git -C ${ROOT} ls-files --cached --others --exclude-standard -- package.json packages/*/package.json`.text()).split('\n').filter(Boolean);
    for (const m of manifests) expect(await Bun.file(`${ROOT}${m}`).text()).not.toMatch(/playwright/i);
  });
});
