import { rename } from 'node:fs/promises';

/**
 * Official "Sign in with ChatGPT" for open-source and locally hosted apps (developers.openai.com/siwc,
 * checked 2026-10-17). Every constant below comes from that documentation.
 */
export const SIWC = {
  issuer: 'https://auth.openai.com',
  authorize: 'https://auth.openai.com/api/accounts/authorize',
  token: 'https://auth.openai.com/api/accounts/oauth/token',
  discovery: 'https://auth.openai.com/.well-known/openid-configuration',
  resource: 'https://api.openai.com/v1',
  registrationClientId: 'dynamic_agent_client',
  scopes: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
  planScope: 'chatgpt.tokens.use.direct',
  agentName: 'Lesebuehne',
} as const;

/** One registration (issued client id + verified identity) and its tokens. */
export interface SiwcCredential {
  clientId: string;
  hostId: string;
  sub: string;
  email?: string;
  idToken: string;
  access: string;
  refresh: string;
  /** ms since epoch */
  expires: number;
  scopes: string[];
}

const b64url = (bytes: ArrayBuffer | Uint8Array): string =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=+$/u, '');

export const randomToken = (n = 24): string => b64url(crypto.getRandomValues(new Uint8Array(n)));

export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomToken(32);
  return { verifier, challenge: b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))) };
}

/** Stable opaque host id (urn:uuid), generated once per installation. */
export function newHostId(): string {
  return `urn:uuid:${crypto.randomUUID()}`;
}

export interface AuthorizeParams {
  hostId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  challenge: string;
  /** Returning sign-in: the issued client id (otherwise the registration client is used). */
  clientId?: string;
  idTokenHint?: string;
  loginHint?: string;
}

/** Authorization URL: registration on first sign-in, reauthorization with the issued client id. */
export function authorizeUrl(p: AuthorizeParams): string {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/u.test(p.redirectUri)) {
    throw new Error('redirect URI must be http://127.0.0.1:<port>/auth/callback');
  }
  const q = new URLSearchParams({
    client_id: p.clientId ?? SIWC.registrationClientId,
    ...(p.clientId ? {} : { agent_name_hint: SIWC.agentName }),
    ext_agent_host_id: p.hostId,
    response_type: 'code',
    redirect_uri: p.redirectUri,
    scope: SIWC.scopes,
    resource: SIWC.resource,
    state: p.state,
    nonce: p.nonce,
    code_challenge: p.challenge,
    code_challenge_method: 'S256',
    ...(p.idTokenHint ? { id_token_hint: p.idTokenHint } : {}),
    ...(p.loginHint ? { login_hint: p.loginHint } : {}),
  });
  return `${SIWC.authorize}?${q}`;
}

export type CallbackResult = { ok: true; code: string; clientId: string } | { ok: false; error: string };

/**
 * Validates the loopback callback: state first, declined consent, the issued client id (a
 * registration must return one; a reauthorization may omit it but never change it).
 */
export function readCallback(url: URL, expected: { state: string; clientId?: string }): CallbackResult {
  if (url.searchParams.get('state') !== expected.state) return { ok: false, error: 'state mismatch' };
  const error = url.searchParams.get('error');
  if (error) return { ok: false, error: error === 'access_denied' ? 'sign-in was declined' : `sign-in failed: ${error}` };
  const code = url.searchParams.get('code');
  if (!code) return { ok: false, error: 'no authorization code' };
  const returned = url.searchParams.get('client_id') ?? undefined;
  if (expected.clientId && returned && returned !== expected.clientId) return { ok: false, error: 'client id changed during reauthorization' };
  const clientId = returned ?? expected.clientId;
  if (!clientId) return { ok: false, error: 'registration incomplete: no client id issued' };
  return { ok: true, code, clientId };
}

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  scope?: string;
}

async function tokenRequest(fetchFn: FetchFn, form: Record<string, string>): Promise<TokenResponse> {
  const res = await fetchFn(SIWC.token, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(/invalid_grant/u.test(body) ? 'invalid_grant' : `token endpoint answered ${res.status}`);
  }
  return (await res.json()) as TokenResponse;
}

export function exchangeCode(fetchFn: FetchFn, o: { clientId: string; code: string; verifier: string; redirectUri: string }): Promise<TokenResponse> {
  return tokenRequest(fetchFn, {
    grant_type: 'authorization_code',
    client_id: o.clientId,
    code: o.code,
    code_verifier: o.verifier,
    redirect_uri: o.redirectUri,
    resource: SIWC.resource,
  });
}

export function refreshTokens(fetchFn: FetchFn, o: { clientId: string; refresh: string }): Promise<TokenResponse> {
  return tokenRequest(fetchFn, { grant_type: 'refresh_token', client_id: o.clientId, refresh_token: o.refresh, resource: SIWC.resource });
}

const decodePart = (part: string): Record<string, unknown> => {
  const b64 = part.replace(/-/gu, '+').replace(/_/gu, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))) as Record<string, unknown>;
};

/** Verifies an RS256 ID token against a JWKS: signature, issuer, audience, expiry, nonce. */
export async function verifyIdToken(
  idToken: string,
  o: { jwks: { keys: Array<JsonWebKey & { kid?: string }> }; clientId: string; nonce: string; now?: number },
): Promise<{ sub: string; email?: string }> {
  const [h, p, s] = idToken.split('.');
  if (!h || !p || !s) throw new Error('malformed ID token');
  const header = decodePart(h) as { alg?: string; kid?: string };
  if (header.alg !== 'RS256') throw new Error(`unexpected ID token algorithm ${header.alg}`);
  const jwk = o.jwks.keys.find((k) => !header.kid || k.kid === header.kid);
  if (!jwk) throw new Error('no matching signing key');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const sig = Uint8Array.from(atob(s.replace(/-/gu, '+').replace(/_/gu, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, new TextEncoder().encode(`${h}.${p}`));
  if (!ok) throw new Error('ID token signature invalid');
  const claims = decodePart(p);
  const now = (o.now ?? Date.now()) / 1000;
  if (claims.iss !== SIWC.issuer) throw new Error('ID token issuer mismatch');
  const aud = claims.aud;
  if (!(aud === o.clientId || (Array.isArray(aud) && aud.includes(o.clientId)))) throw new Error('ID token audience mismatch');
  if (typeof claims.exp !== 'number' || claims.exp < now) throw new Error('ID token expired');
  if (claims.nonce !== o.nonce) throw new Error('ID token nonce mismatch');
  if (typeof claims.sub !== 'string' || !claims.sub) throw new Error('ID token has no subject');
  return { sub: claims.sub, ...(typeof claims.email === 'string' ? { email: claims.email } : {}) };
}

export async function fetchJwks(fetchFn: FetchFn): Promise<{ keys: Array<JsonWebKey & { kid?: string }> }> {
  const disco = (await (await fetchFn(SIWC.discovery)).json()) as { jwks_uri?: string };
  return (await (await fetchFn(disco.jwks_uri ?? `${SIWC.issuer}/.well-known/jwks.json`)).json()) as { keys: Array<JsonWebKey & { kid?: string }> };
}

/** Owner-only, atomic JSON file. */
export async function writeSecret(path: string, data: unknown): Promise<void> {
  const tmp = `${path}.${crypto.randomUUID()}.tmp`;
  await Bun.write(tmp, JSON.stringify(data), { mode: 0o600 });
  await rename(tmp, path);
}

/** Credential store: one file holding the host id and every registration (by client id). */
export interface SiwcStoreFile {
  hostId: string;
  active?: string;
  credentials: Record<string, SiwcCredential>;
}

export async function readStore(path: string): Promise<SiwcStoreFile | undefined> {
  const f = Bun.file(path);
  return (await f.exists()) ? ((await f.json()) as SiwcStoreFile) : undefined;
}
