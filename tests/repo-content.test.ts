import { describe, expect, test } from 'bun:test';
import { $ } from 'bun';

const ROOT = Bun.fileURLToPath(new URL('..', import.meta.url));

describe('16-2: repository content', () => {
  test('top level holds only config, CI, packages, samples, scripts, tests, README and LICENSE', async () => {
    const listed = (await $`git -C ${ROOT} ls-files --cached --others --exclude-standard`.text()).split('\n').filter(Boolean);
    const top = new Set(listed.map((f) => f.split('/')[0]!));
    const allowed = new Set([
      '.gitignore', '.gitattributes', '.github', 'package.json', 'bun.lock', 'bunfig.toml', 'tsconfig.json',
      'packages', 'samples', 'scripts', 'tests', 'README.md', 'LICENSE', 'lesebuehne.config.ts',
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

describe('B9: nothing personal in the repository', () => {
  const TEXT = /\.(ts|tsx|js|json|md|css|html|toml|txt|yml|yaml|gitignore|gitattributes)$/u;
  const RULES: Array<[string, RegExp]> = [
    ['absolute Windows user path', /\b[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}(?![<{$*])[^\\/\s'"`]+/u],
    ['absolute macOS user path', /(?<![\w.])\/Users\/(?![<{$*:])[A-Za-z0-9._-]+\//u],
    ['absolute Linux home path', /(?<![\w.])\/home\/(?![<{$*:])[a-z0-9._-]+\//u],
    ['JWT', /eyJ[A-Za-z0-9_-]{12,}\.eyJ[A-Za-z0-9_-]{12,}\./u],
    ['API key', /\b(?:sk-(?:or-v1-|ant-|proj-)?[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{30,}|AIza[0-9A-Za-z_-]{30,})/u],
    ['email address', /[A-Za-z0-9._%+-]+@(?!example\.|anthropic\.com|users\.noreply\.)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?:com|net|org|de|io|dev|ai)\b/u],
  ];

  test('tracked and to-be-tracked text files contain no user paths, tokens, keys or emails', async () => {
    const listed = (await $`git -C ${ROOT} ls-files --cached --others --exclude-standard`.text()).split('\n').filter((f) => f && TEXT.test(f));
    const hits: string[] = [];
    for (const f of listed) {
      const file = Bun.file(`${ROOT}${f}`);
      if (!(await file.exists())) continue;
      const lines = (await file.text()).split('\n');
      for (const [k, line] of lines.entries()) {
        for (const [name, re] of RULES) if (re.test(line)) hits.push(`${f}:${k + 1}: ${name}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
