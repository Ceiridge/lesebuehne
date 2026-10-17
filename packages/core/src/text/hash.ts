/**
 * cyrb53: a fast, synchronous 53-bit string hash (public domain, bryc). Pure JS, so IDs are the
 * same in the browser and in Bun.
 */
export function cyrb53(text: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** Content hash for IDs: cyrb53 with two seeds, as 2 × 14 hex digits. */
export function contentHash(text: string): string {
  return cyrb53(text, 1).toString(16).padStart(14, '0') + cyrb53(text, 2).toString(16).padStart(14, '0');
}
