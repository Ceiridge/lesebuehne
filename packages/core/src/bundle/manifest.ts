import * as z from 'zod';
import { BookSchema } from '../model/schema.ts';

export const BUNDLE_SCHEMA_VERSION = 1;

export const AssetRefSchema = z.strictObject({ path: z.string().min(1), mediaType: z.string().min(1) });

/**
 * `manifest.json` of a book bundle (B6). Strict objects: unknown keys (an `apiKey`, a token) are
 * rejected, so no secret can travel in a bundle.
 */
export const ManifestSchema = z.strictObject({
  schemaVersion: z.literal(BUNDLE_SCHEMA_VERSION),
  bookId: z.string().min(1),
  title: z.string(),
  author: z.string().optional(),
  language: z.string().min(1),
  languageSupport: z.enum(['full', 'basic']),
  format: z.enum(['txt', 'md', 'epub']),
  source: z.strictObject({ fileName: z.string(), size: z.number().int().nonnegative() }),
  /** ISO 8601 time of the import. */
  importedAt: z.iso.datetime(),
  assets: z.array(AssetRefSchema),
});

export const AssetSchema = z.strictObject({
  path: z.string().min(1),
  mediaType: z.string().min(1),
  bytes: z.instanceof(Uint8Array),
});

export const BookBundleSchema = z
  .strictObject({ manifest: ManifestSchema, book: BookSchema, assets: z.array(AssetSchema) })
  .superRefine((bundle, ctx) => {
    if (bundle.manifest.bookId !== bundle.book.id) {
      ctx.addIssue({ code: 'custom', path: ['manifest', 'bookId'], message: 'bookId does not match book.id' });
    }
    const listed = new Set(bundle.manifest.assets.map((a) => a.path));
    for (const [k, a] of bundle.assets.entries()) {
      if (!listed.has(a.path)) ctx.addIssue({ code: 'custom', path: ['assets', k, 'path'], message: 'asset not in manifest' });
    }
  });

export type AssetRef = z.infer<typeof AssetRefSchema>;
export type Manifest = z.infer<typeof ManifestSchema>;
export type Asset = z.infer<typeof AssetSchema>;
export type BookBundle = z.infer<typeof BookBundleSchema>;
