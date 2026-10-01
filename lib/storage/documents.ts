import 'server-only';

import { randomBytes } from 'node:crypto';

import { logger } from '@/lib/logger';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import {
  MAX_UPLOAD_BYTES,
  isAllowedDocumentMimeType,
  isAllowedPhotoMimeType,
} from '@/lib/validation/client';
import {
  SIGNATURE_HEAD_BYTES,
  contentMatchesDeclaredType,
  extensionFor,
} from './file-types';

/**
 * Uploading and reading client and guarantor documents.
 *
 * ## The filename is never the browser's
 *
 * An uploaded filename is attacker input. It can contain `../`, a null byte, a
 * right-to-left override character that disguises `.exe` as `.gpj`, or simply
 * be four kilobytes long. So the name is **generated** — sixteen random bytes
 * plus an extension derived from the validated MIME type — and the original is
 * discarded entirely.
 *
 * That also removes a privacy leak nobody thinks about: people photograph
 * documents with phones, and the filename often contains the subject's name.
 * Storing `Nakato_Beatrice_ID.jpg` would put a client's name into a path that
 * appears in logs and error messages.
 *
 * ## Why the type is checked by content, not extension
 *
 * An extension is a claim; the first bytes of a file are evidence. A `.jpg`
 * beginning `MZ` is a Windows executable, and a `.png` beginning `<?xml` is
 * probably an SVG, which can carry script. The magic bytes are therefore
 * checked against the declared type, and a disagreement is a rejection.
 *
 * The bucket enforces `allowed_mime_types` and the storage policies enforce
 * who may write where. This is the third of three layers, and the only one
 * that can look inside the file. The rule itself lives in
 * `lib/storage/file-types.ts`, which is pure so that it can be driven directly
 * by tests against crafted buffers.
 */

/** Buckets created private in Phase 1. Never public. */
export const CLIENT_BUCKET = 'client-documents';
export const GUARANTOR_BUCKET = 'guarantor-documents';

/** How long a signed URL lives. Long enough to render a page, not to share. */
const SIGNED_URL_TTL_SECONDS = 60;

export type DocumentKind = 'photo' | 'id';

export interface UploadOutcome {
  readonly ok: boolean;
  readonly path?: string;
  readonly message?: string;
}

/**
 * Build a storage path.
 *
 * The shape is matched by a CHECK constraint on the database column and by the
 * storage policies, so a path not built here cannot be stored.
 *
 * The random component is what makes replacement safe: a new photograph is a
 * new object, so the database is repointed only after the upload has
 * succeeded. There is no moment at which the record names a file that does not
 * exist, and no moment at which the old file is gone before the new one
 * arrives.
 */
export function buildDocumentPath(
  scope: 'clients' | 'guarantors',
  ownerId: string,
  kind: DocumentKind,
  mime: string,
): string {
  const token = randomBytes(16).toString('hex');
  return `${scope}/${ownerId}/${kind}/${token}.${extensionFor(mime)}`;
}

/**
 * Validate and store an uploaded file.
 *
 * Runs as the caller, so the storage policies apply: a Secretary/Treasurer is
 * refused by the database even though this function contains no capability
 * check of its own.
 */
export async function uploadDocument(
  scope: 'clients' | 'guarantors',
  ownerId: string,
  kind: DocumentKind,
  file: File,
): Promise<UploadOutcome> {
  if (file.size === 0) {
    return { ok: false, message: 'That file is empty.' };
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    const limitMb = Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024));
    return {
      ok: false,
      message: `That file is too large. The limit is ${String(limitMb)} MB.`,
    };
  }

  const declared = file.type;

  const typeAllowed =
    kind === 'id'
      ? isAllowedDocumentMimeType(declared)
      : isAllowedPhotoMimeType(declared);

  if (!typeAllowed) {
    return {
      ok: false,
      message:
        kind === 'id'
          ? 'Upload a photograph or a PDF. Other file types are not accepted.'
          : 'Upload a photograph. JPEG, PNG, WebP and HEIC are accepted.',
    };
  }

  // Only the head is read. Every signature sits within the first few bytes,
  // and reading a whole file into memory to check four of them would be a way
  // to exhaust the server with a large upload.
  const head = new Uint8Array(await file.slice(0, SIGNATURE_HEAD_BYTES).arrayBuffer());

  if (!contentMatchesDeclaredType(declared, head)) {
    logger.warn('An upload was refused: content did not match its declared type.', {
      declared,
      kind,
    });
    return {
      ok: false,
      message:
        'That file is not the type it claims to be. Try saving it again as a JPEG or PNG.',
    };
  }

  const path = buildDocumentPath(scope, ownerId, kind, declared);
  const bucket = scope === 'clients' ? CLIENT_BUCKET : GUARANTOR_BUCKET;

  const supabase = await createSupabaseServerClient();

  const { error } = await supabase.storage.from(bucket).upload(path, file, {
    contentType: declared,
    // Never overwrite. A random path makes a collision essentially impossible,
    // and refusing an upsert means a bug cannot destroy an existing document.
    upsert: false,
  });

  if (error !== null) {
    logger.warn('An upload failed.', { bucket, kind, message: error.message });
    return { ok: false, message: 'That file could not be saved. Please try again.' };
  }

  return { ok: true, path };
}

/**
 * A short-lived signed URL for a stored document, or null.
 *
 * Signed rather than public, and short-lived rather than permanent. A
 * permanent URL is a credential: once it exists, anyone it is forwarded to can
 * read the document indefinitely, with no record and no way to revoke it.
 * Sixty seconds is enough for a page to render an image and not enough for the
 * address to be useful pasted into a message.
 *
 * Generated as the caller, so the storage read policy applies — a caller
 * without the capability gets null rather than a working link.
 */
export async function signedDocumentUrl(
  scope: 'clients' | 'guarantors',
  path: string | null,
): Promise<string | null> {
  if (path === null || path === '') return null;

  const bucket = scope === 'clients' ? CLIENT_BUCKET : GUARANTOR_BUCKET;
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);

  if (error !== null || data === null) {
    logger.debug('Could not sign a document URL.', { bucket });
    return null;
  }

  return data.signedUrl;
}
