/** Why a file could not be imported; the player maps each code to a catalog message (B3). */
export type IngestErrorCode = 'unsupported' | 'unreadable' | 'drm' | 'empty';

export class IngestError extends Error {
  readonly code: IngestErrorCode;
  constructor(code: IngestErrorCode, message: string) {
    super(message);
    this.name = 'IngestError';
    this.code = code;
  }
}

/** Decodes UTF-8 strictly and removes a BOM; invalid bytes → `unreadable`. */
export function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new IngestError('unreadable', 'The file is not valid UTF-8 text.');
  }
}
