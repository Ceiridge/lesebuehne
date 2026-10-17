import { Database } from 'bun:sqlite';
import { rename } from 'node:fs/promises';
import { accountIdFrom, jwtExpiry } from './jwt.ts';

/** A ChatGPT access token for the Codex backend. */
export interface CodexToken {
  access: string;
  accountId: string;
  /** ms since epoch. */
  expires: number;
}

export interface TokenSource {
  id: 'opencode' | 'codex-cli' | 'own';
  label: string;
  /** Read-only sources are never refreshed or written (another app owns them). */
  readOnly: boolean;
  /** The current token, or undefined when the store is missing or holds none. */
  load(): Promise<CodexToken | undefined>;
  /** Own source only: refresh an expired token. */
  refresh?(signal?: AbortSignal): Promise<CodexToken | undefined>;
}

/** Default locations, resolved at runtime from the environment (nothing personal hard-coded). */
export function defaultPaths(env: Record<string, string | undefined> = Bun.env): { opencodeData: string; codexHome: string } {
  const home = env.HOME ?? env.USERPROFILE ?? '';
  const xdgData = env.XDG_DATA_HOME ?? `${home}/.local/share`;
  return { opencodeData: env.OPENCODE_DATA_DIR ?? `${xdgData}/opencode`, codexHome: env.CODEX_HOME ?? `${home}/.codex` };
}

async function readJson(path: string): Promise<unknown> {
  const f = Bun.file(path);
  return (await f.exists()) ? f.json() : undefined;
}

interface OpenCodeOAuth {
  type?: string;
  access?: string;
  expires?: number;
  accountId?: string;
  metadata?: { accountID?: string };
}

function fromOpenCode(v: OpenCodeOAuth | undefined): CodexToken | undefined {
  if (!v || v.type !== 'oauth' || !v.access) return undefined;
  const accountId = v.metadata?.accountID ?? v.accountId ?? accountIdFrom(v.access);
  if (!accountId) return undefined;
  return { access: v.access, accountId, expires: v.expires ?? jwtExpiry(v.access) ?? 0 };
}

/**
 * OpenCode's ChatGPT credential, read-only: the current credential store (`opencode.db`, table
 * `credential`, integration `openai`) first, then the legacy `auth.json`. Never refreshed here,
 * because refreshing a rotating refresh token could log OpenCode out.
 */
export function openCodeSource(dir = defaultPaths().opencodeData): TokenSource {
  return {
    id: 'opencode',
    label: 'OpenCode (read-only)',
    readOnly: true,
    async load() {
      const dbPath = `${dir}/opencode.db`;
      if (await Bun.file(dbPath).exists()) {
        let db: Database | undefined;
        try {
          db = new Database(dbPath, { readonly: true });
          const rows = db
            .query("select value from credential where integration_id = 'openai' order by active desc, time_updated desc")
            .all() as Array<{ value: string }>;
          for (const r of rows) {
            const token = fromOpenCode(JSON.parse(r.value) as OpenCodeOAuth);
            if (token) return token;
          }
        } catch {
          // schema changed or locked: fall through to auth.json
        } finally {
          db?.close();
        }
      }
      const legacy = (await readJson(`${dir}/auth.json`).catch(() => undefined)) as { openai?: OpenCodeOAuth } | undefined;
      return fromOpenCode(legacy?.openai);
    },
  };
}

/** The Codex CLI's `auth.json` (ChatGPT sign-in), read-only. */
export function codexCliSource(home = defaultPaths().codexHome): TokenSource {
  return {
    id: 'codex-cli',
    label: 'Codex CLI (read-only)',
    readOnly: true,
    async load() {
      const json = (await readJson(`${home}/auth.json`).catch(() => undefined)) as
        | { tokens?: { access_token?: string; id_token?: string; account_id?: string } }
        | undefined;
      const t = json?.tokens;
      if (!t?.access_token) return undefined;
      const accountId = t.account_id ?? accountIdFrom(t.id_token, t.access_token);
      if (!accountId) return undefined;
      return { access: t.access_token, accountId, expires: jwtExpiry(t.access_token) ?? 0 };
    },
  };
}

/** Public OAuth client of the Codex CLI (also used by OpenCode's Codex sign-in). */
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CODEX_ISSUER = 'https://auth.openai.com';

export interface OwnTokenFile {
  access: string;
  refresh: string;
  expires: number;
  accountId: string;
  idToken?: string;
}

/** Atomic write with owner-only permissions where the OS supports them. */
export async function writeSecretFile(path: string, data: unknown): Promise<void> {
  const tmp = `${path}.${crypto.randomUUID()}.tmp`;
  await Bun.write(tmp, JSON.stringify(data), { mode: 0o600 });
  await rename(tmp, path);
}

/**
 * Our own Codex-style sign-in (like OpenCode does it), stored in our data directory and
 * refreshed by us. Refreshes are serialized so two requests never race a rotating token.
 */
export function ownSource(file: string, o: { fetch?: typeof fetch; clientId?: string } = {}): TokenSource {
  const doFetch = o.fetch ?? fetch;
  let refreshing: Promise<CodexToken | undefined> | undefined;
  const load = async (): Promise<OwnTokenFile | undefined> => (await readJson(file).catch(() => undefined)) as OwnTokenFile | undefined;
  return {
    id: 'own',
    label: 'Own ChatGPT sign-in',
    readOnly: false,
    async load() {
      const t = await load();
      return t ? { access: t.access, accountId: t.accountId, expires: t.expires } : undefined;
    },
    refresh(signal) {
      refreshing ??= (async () => {
        try {
          const t = await load();
          if (!t?.refresh) return undefined;
          const res = await doFetch(`${CODEX_ISSUER}/oauth/token`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: o.clientId ?? CODEX_CLIENT_ID }).toString(),
            ...(signal ? { signal } : {}),
          });
          if (!res.ok) return undefined;
          const json = (await res.json()) as { access_token: string; refresh_token?: string; id_token?: string; expires_in?: number };
          const next: OwnTokenFile = {
            access: json.access_token,
            refresh: json.refresh_token ?? t.refresh,
            expires: Date.now() + (json.expires_in ?? 3600) * 1000,
            accountId: accountIdFrom(json.id_token, json.access_token) ?? t.accountId,
            ...(json.id_token ? { idToken: json.id_token } : {}),
          };
          await writeSecretFile(file, next);
          return { access: next.access, accountId: next.accountId, expires: next.expires };
        } finally {
          refreshing = undefined;
        }
      })();
      return refreshing;
    },
  };
}
