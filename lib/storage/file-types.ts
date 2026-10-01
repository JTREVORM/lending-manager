/**
 * Deciding whether an uploaded file is the type it claims to be.
 *
 * Pure, and deliberately **not** `server-only`, so the rule can be driven
 * directly by tests against crafted buffers. That matters more here than
 * usual: "an executable renamed to .jpg is refused" is a claim worth proving
 * rather than asserting, and it cannot be proven through a module that will
 * not load outside a server component.
 *
 * Nothing here touches Supabase or the filesystem. `lib/storage/documents.ts`
 * does the uploading and imports from this file.
 */

/**
 * Magic-byte signatures for the accepted types.
 *
 * HEIC and WebP sit inside containers, so their markers are at an offset:
 * `ftyp` at byte 4 for HEIC, `WEBP` at byte 8 inside a RIFF container. A RIFF
 * header alone is not a WebP — it could be an AVI — which is why WebP has two
 * entries and both must match.
 */
const SIGNATURES: readonly {
  readonly mime: string;
  readonly offset: number;
  readonly bytes: readonly number[];
}[] = [
  { mime: 'image/jpeg', offset: 0, bytes: [0xff, 0xd8, 0xff] },
  {
    mime: 'image/png',
    offset: 0,
    bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  },
  { mime: 'image/webp', offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] },
  { mime: 'image/webp', offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] },
  { mime: 'image/heic', offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] },
  { mime: 'application/pdf', offset: 0, bytes: [0x25, 0x50, 0x44, 0x46] },
];

/** How many bytes of a file need reading to check every signature. */
export const SIGNATURE_HEAD_BYTES = 16;

function matchesAt(view: Uint8Array, offset: number, bytes: readonly number[]): boolean {
  if (view.length < offset + bytes.length) return false;
  return bytes.every((byte, index) => view[offset + index] === byte);
}

/**
 * Does the file's content agree with its declared type?
 *
 * An extension is a claim; the first bytes are evidence. A `.jpg` beginning
 * `MZ` is a Windows executable, and a `.png` beginning `<?xml` is probably an
 * SVG, which can carry script.
 *
 * A type with no signature on record is **refused** rather than waved
 * through. Failing closed matters more than supporting an exotic format.
 */
export function contentMatchesDeclaredType(declared: string, head: Uint8Array): boolean {
  const expected = SIGNATURES.filter((signature) => signature.mime === declared);

  if (expected.length === 0) return false;

  return expected.every((signature) =>
    matchesAt(head, signature.offset, signature.bytes),
  );
}

/** The extension for a validated MIME type. Never taken from the upload. */
export function extensionFor(mime: string): string {
  switch (mime) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'image/heic':
      return 'heic';
    case 'application/pdf':
      return 'pdf';
    default:
      return 'bin';
  }
}
