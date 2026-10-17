/** Reads the (unverified) claims of a JWT; used only for expiry and the ChatGPT account id. */
export function jwtClaims(token: string | undefined): Record<string, unknown> | undefined {
  const part = token?.split('.')[1];
  if (!part) return undefined;
  try {
    const b64 = part.replace(/-/gu, '+').replace(/_/gu, '/');
    const json = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(json, (c) => c.charCodeAt(0)))) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** `exp` of a JWT in ms since epoch. */
export function jwtExpiry(token: string | undefined): number | undefined {
  const exp = jwtClaims(token)?.exp;
  return typeof exp === 'number' ? exp * 1000 : undefined;
}

/** The ChatGPT account id from id/access token claims (same lookup order as Codex clients). */
export function accountIdFrom(...tokens: Array<string | undefined>): string | undefined {
  for (const t of tokens) {
    const c = jwtClaims(t);
    if (!c) continue;
    const auth = c['https://api.openai.com/auth'] as { chatgpt_account_id?: string } | undefined;
    const orgs = c.organizations as Array<{ id?: string }> | undefined;
    const id = (c.chatgpt_account_id as string | undefined) ?? auth?.chatgpt_account_id ?? orgs?.[0]?.id;
    if (id) return id;
  }
  return undefined;
}
