import 'server-only';

/**
 * Uploading and reading the evidence filed with a loan application.
 *
 * The same three rules `lib/storage/documents.ts` states, for the same
 * reasons, and they are worth restating rather than cross-referencing because
 * this is a second bucket and an unenforced rule here would not be caught by
 * a test of the first:
 *
 *   * the filename is **generated**, never the browser's — an uploaded name is
 *     attacker input and frequently carries the subject's name;
 *   * the type is checked by **content**, not extension — a `.jpg` beginning
 *     `MZ` is a Windows executable;
 *   * the URL handed to a page is **signed and short-lived** — a permanent URL
 *     is a credential that cannot be revoked.
 *
 * The path shape is matched by a CHECK constraint on `loan_documents` and by
 * the three storage policies on the bucket, so a path not built here cannot be
 * stored and an object not under one cannot be read.
 */

import { randomBytes } from 'node:crypto';

import { logger } from '@/lib/logger';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import {
  MAX_UPLOAD_BYTES,
  isAllowedDocumentMimeType,
  isAllowedPhotoMimeType,
} from '@/lib/validation/client';
import type { LoanDocumentKind } from '@/lib/validation/loan-application';
import {
  SIGNATURE_HEAD_BYTES,
  contentMatchesDeclaredType,
  extensionFor,
} from './file-types';

/** Created private in Phase 13, like every other bucket in this project. */
export const LOAN_BUCKET = 'loan-documents';

/** Long enough to render a page, not long enough to be worth forwarding. */
const SIGNED_URL_TTL_SECONDS = 60;

export interface LoanUploadOutcome {
  readonly ok: boolean;
  readonly path?: string;
  readonly contentType?: string;
  readonly byteSize?: number;
  readonly message?: string;
}

/**
 * The kinds that must be an image.
 *
 * A photograph and a signature are pictures of things; everything else is
 * paperwork, which is as likely to arrive as a PDF. Enforcing the narrower
 * rule where it applies means a scanned contract cannot be filed as somebody's
 * signature.
 */
const IMAGE_ONLY_KINDS: readonly LoanDocumentKind[] = [
  'guarantor_photograph',
  'guarantor_signature',
  'business_photo',
];

export function buildLoanDocumentPath(
  loanId: string,
  kind: LoanDocumentKind,
  mime: string,
): string {
  const token = randomBytes(16).toString('hex');
  return `loans/${loanId}/${kind}/${token}.${extensionFor(mime)}`;
}

/**
 * Validate and store an uploaded file.
 *
 * Runs as the caller, so the storage policies apply: a reader without
 * `loans:documents`, or a loan that has left draft, is refused by the database
 * even though this function contains no capability check of its own.
 */
export async function uploadLoanDocument(
  loanId: string,
  kind: LoanDocumentKind,
  file: File,
): Promise<LoanUploadOutcome> {
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

  const typeAllowed = IMAGE_ONLY_KINDS.includes(kind)
    ? isAllowedPhotoMimeType(declared)
    : isAllowedDocumentMimeType(declared);

  if (!typeAllowed) {
    return {
      ok: false,
      message: IMAGE_ONLY_KINDS.includes(kind)
        ? 'Upload a photograph. JPEG, PNG, WebP and HEIC are accepted.'
        : 'Upload a photograph or a PDF. Other file types are not accepted.',
    };
  }

  const head = new Uint8Array(await file.slice(0, SIGNATURE_HEAD_BYTES).arrayBuffer());

  if (!contentMatchesDeclaredType(declared, head)) {
    logger.warn('A loan document upload was refused: content did not match its type.', {
      declared,
      kind,
    });
    return {
      ok: false,
      message:
        'That file is not the type it claims to be. Try saving it again as a JPEG or PDF.',
    };
  }

  const path = buildLoanDocumentPath(loanId, kind, declared);
  const supabase = await createSupabaseServerClient();

  const { error } = await supabase.storage.from(LOAN_BUCKET).upload(path, file, {
    contentType: declared,
    // Never overwrite. A random path makes a collision essentially impossible,
    // and refusing an upsert means a bug cannot destroy an existing document.
    upsert: false,
  });

  if (error !== null) {
    logger.warn('A loan document upload failed.', { kind, message: error.message });
    return { ok: false, message: 'That file could not be saved. Please try again.' };
  }

  return { ok: true, path, contentType: declared, byteSize: file.size };
}

/** A short-lived signed URL for a filed document, or null. */
export async function signedLoanDocumentUrl(path: string): Promise<string | null> {
  if (path === '') return null;

  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase.storage
    .from(LOAN_BUCKET)
    .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);

  if (error !== null || data === null) {
    logger.debug('Could not sign a loan document URL.');
    return null;
  }

  return data.signedUrl;
}

/**
 * Remove a stored object.
 *
 * Called after the row is deleted, never before: an object with no row is
 * invisible clutter, and a row with no object is a document the screen offers
 * and the storage layer cannot produce. Of the two, the first is recoverable.
 */
export async function removeLoanDocumentObject(path: string): Promise<void> {
  const supabase = await createSupabaseServerClient();

  const { error } = await supabase.storage.from(LOAN_BUCKET).remove([path]);

  if (error !== null) {
    logger.warn('A loan document object could not be removed.', {
      message: error.message,
    });
  }
}
