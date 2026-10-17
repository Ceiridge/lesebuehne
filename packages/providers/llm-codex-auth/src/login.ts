import { accountIdFrom } from './jwt.ts';
import { CODEX_CLIENT_ID, CODEX_ISSUER, writeSecretFile, type OwnTokenFile } from './sources.ts';

/** The redirect the public Codex client is registered for. */
export const CODEX_CALLBACK_PORT = 1455;
export const CODEX_REDIRECT = `http://localhost:${CODEX_CALLBACK_PORT}/auth/callback`;

const b64url = (bytes: ArrayBuffer | Uint8Array): string =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=+$/u, '');

export async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return { verifier, challenge };
}

/** Authorization URL of the Codex-style sign-in (same parameters as Codex clients use). */
export function codexAuthorizeUrl(o: { challenge: string; state: string; redirectUri?: string; clientId?: string }): string {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: o.clientId ?? CODEX_CLIENT_ID,
    redirect_uri: o.redirectUri ?? CODEX_REDIRECT,
    scope: 'openid profile email offline_access',
    code_challenge: o.challenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    state: o.state,
    originator: 'lesebuehne',
  });
  return `${CODEX_ISSUER}/oauth/authorize?${q}`;
}

export interface LoginSession {
  /** Open this URL in the user's browser. */
  url: string;
  /** Resolves when the token file was written (rejects on error or timeout). */
  done: Promise<void>;
  cancel(): void;
}

/**
 * Starts the own Codex-style sign-in: a one-shot callback listener on 127.0.0.1, PKCE + state,
 * code exchange, token file written atomically. The tokens never leave the local machine.
 */
export async function startCodexLogin(o: {
  tokenFile: string;
  fetch?: typeof fetch;
  port?: number;
  timeoutMs?: number;
}): Promise<LoginSession> {
  const doFetch = o.fetch ?? fetch;
  const { verifier, challenge } = await pkce();
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const port = o.port ?? CODEX_CALLBACK_PORT;
  const redirectUri = `http://localhost:${port}/auth/callback`;
  let finish!: (e?: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    finish = (e) => (e ? reject(e) : resolve());
  });
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== '/auth/callback') return new Response('Not Found', { status: 404 });
      try {
        if (url.searchParams.get('state') !== state) throw new Error('state mismatch');
        const error = url.searchParams.get('error');
        if (error) throw new Error(`sign-in declined: ${error}`);
        const code = url.searchParams.get('code');
        if (!code) throw new Error('no authorization code');
        const res = await doFetch(`${CODEX_ISSUER}/oauth/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: CODEX_CLIENT_ID, code_verifier: verifier }).toString(),
        });
        if (!res.ok) throw new Error(`token exchange failed (${res.status})`);
        const json = (await res.json()) as { access_token: string; refresh_token: string; id_token?: string; expires_in?: number };
        const accountId = accountIdFrom(json.id_token, json.access_token);
        if (!accountId) throw new Error('no ChatGPT account id in the token');
        const file: OwnTokenFile = {
          access: json.access_token,
          refresh: json.refresh_token,
          expires: Date.now() + (json.expires_in ?? 3600) * 1000,
          accountId,
          ...(json.id_token ? { idToken: json.id_token } : {}),
        };
        await writeSecretFile(o.tokenFile, file);
        finish();
        return new Response('Signed in. You can close this tab and return to Lesebühne.', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
      } catch (e) {
        finish(e as Error);
        return new Response(`Sign-in failed: ${(e as Error).message}`, { status: 400, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      } finally {
        setTimeout(() => server.stop(), 100);
      }
    },
  });
  const timer = setTimeout(() => {
    finish(new Error('sign-in timed out'));
    server.stop();
  }, o.timeoutMs ?? 5 * 60_000);
  done.finally(() => clearTimeout(timer)).catch(() => undefined);
  return {
    url: codexAuthorizeUrl({ challenge, state, redirectUri }),
    done,
    cancel() {
      finish(new Error('sign-in cancelled'));
      server.stop();
    },
  };
}
