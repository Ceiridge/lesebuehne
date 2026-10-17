type Granularity = 'word' | 'sentence';

const cache = new Map<string, Intl.Segmenter>();

/**
 * A cached `Intl.Segmenter` for a BCP 47 language tag. A tag that `Intl` rejects
 * falls back to its primary subtag, then to `und` (root locale).
 */
export function segmenterFor(lang: string, granularity: Granularity): Intl.Segmenter {
  const key = `${granularity}\u0000${lang}`;
  let segmenter = cache.get(key);
  if (!segmenter) {
    segmenter = create(lang, granularity);
    cache.set(key, segmenter);
  }
  return segmenter;
}

function create(lang: string, granularity: Granularity): Intl.Segmenter {
  for (const tag of [lang, primaryLanguage(lang), 'und']) {
    try {
      return new Intl.Segmenter(tag, { granularity });
    } catch {
      // try the next tag
    }
  }
  return new Intl.Segmenter('und', { granularity });
}

/** Lowercase primary language subtag: `de-AT` → `de`, `EN_gb` → `en`. */
export function primaryLanguage(lang: string): string {
  return (lang.trim().split(/[-_]/)[0] ?? '').toLowerCase();
}
