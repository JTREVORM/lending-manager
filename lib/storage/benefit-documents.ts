import 'server-only';

import { randomBytes } from 'node:crypto';

import { logger } from '@/lib/logger';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { MAX_UPLOAD_BYTES, isAllowedDocumentMimeType } from '@/lib/validation/client';
import {
  SIGNATURE_HEAD_BYTES,
  contentMatchesDeclaredType,
  extensionFor,
} from './file-types';

/**
 * Uploading and reading benefit evidence.
 *
 * ## The most sensitive documents this system will ever hold
 *
 * Hospital admission records, invoices, death certificates, relationship
 * documents, a beneficiary's identity papers. The bucket is private, like
 * every bucket in this project, and the reason binds harder here than
 * anywhere else: a public bucket would make a leak a matter of guessing a
 * UUID.
 *
 * ## The filename is never the browser's
 *
 * An uploaded filename is attacker input — it can contain `../`, a null byte,
 * a right-to-left override that disguises `.exe` as `.gpj`, or simply be four
 * kilobytes long. So the name is **generated** and the original discarded,
 * which also closes a privacy leak nobody thinks about: people photograph
 * documents with phones, and the filename often carries the subject's name.
 * `Nakato_Beatrice_death_certificate.jpg` would put a bereavement into a path
 * that appears in logs and error messages.
 *
 * ## The path is a predicate, not a convention
 *
 *     benefits/<membership_id>/<kind>/<claim_id-or-'beneficiary'>/<object>
 *
 * Scope, then owner, then kind is what `client-documents`,
 * `guarantor-documents`, `loan-documents` and `membership-consent` all do, and
 * it is what lets the storage policies say "the membership in segment two must
 * be one the caller may see" rather than "please name your files sensibly".
 *
 * Benefits need one segment more than any earlier bucket, because evidence
 * belongs to a **claim** as well as to a membership and a claim's documents
 * must not be reachable from another claim on the same member. That is segment
 * four, and `benefit_claim_documents_guard` refuses a metadata row whose path
 * disagrees with its membership, its kind or its claim — which is what defeats
 * a forged object reference.
 *
 * ## Why the type is checked by content, not extension
 *
 * An extension is a claim; the first bytes of a file are evidence. A `.jpg`
 * beginning `MZ` is a Windows executable, and a `.png` beginning `<?xml` is
 * probably an SVG, which can carry script. The magic bytes are checked against
 * the declared type and a disagreement is a rejection.
 *
 * The bucket enforces `allowed_mime_types` and the storage policies enforce
 * who may write where. This is the third of three layers, and the only one
 * that can look inside the file.
 */

export const BENEFIT_BUCKET = 'benefit-documents';

/**
 * How long a signed URL lives.
 *
 * Sixty seconds: long enough to render a page, not long enough to share. The
 * same TTL the client and loan documents use, and the reason is sharper here —
 * a URL to a death certificate pasted into a message would outlive the
 * conversation.
 */
const SIGNED_URL_TTL_SECONDS = 60;

/**
 * Segment four of a beneficiary document's path.
 *
 * The literal the database spells in `storage_path_is_beneficiary()`, defined
 * once here so the application and the storage policies cannot disagree about
 * it. A claim's documents use the claim's id in the same position.
 */
export const BENEFICIARY_PATH_SUBJECT = 'beneficiary';

export interface BenefitUploadOutcome {
  readonly ok: boolean;
  readonly path?: string;
  readonly contentType?: string;
  readonly byteSize?: number;
  readonly message?: string;
}

/**
 * Build the storage path for a piece of benefit evidence.
 *
 * `subject` is the claim's id, or the literal `beneficiary` for evidence
 * attached to a beneficiary record rather than to a claim. The literal is
 * defined in exactly one place in the database —
 * `storage_path_is_beneficiary()` — and this is the one place in the
 * application, so the two cannot disagree about its spelling.
 *
 * The random component is what makes replacement safe: a corrected document
 * is a new object, so the record is repointed only after the upload has
 * succeeded, and there is no moment at which a row names a file that does not
 * exist.
 */
export function buildBenefitDocumentPath(
  membershipId: string,
  kind: string,
  subject: string,
  mime: string,
): string {
  const token = randomBytes(16).toString('hex');
  return `benefits/${membershipId}/${kind}/${subject}/${token}.${extensionFor(mime)}`;
}

/**
 * Validate and store an uploaded file.
 *
 * Runs as the caller, so the storage policies apply: a reader without
 * `benefits:claim` or `beneficiaries:manage`, a kind the vocabulary does not
 * recognise, a membership the caller cannot see, or an assessment working
 * paper filed by somebody who does not assess, is refused by the database even
 * though this function contains no capability check of its own.
 *
 * Images and PDFs both, with no narrower rule by kind. A medical invoice and
 * an admission record are as likely to arrive as a photograph taken on a
 * phone as a scan, and refusing one would push the work onto paper — which is
 * the opposite of what an evidence workflow is for.
 */
export async function uploadBenefitDocument(
  membershipId: string,
  kind: string,
  subject: string,
  file: File,
): Promise<BenefitUploadOutcome> {
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

  if (!isAllowedDocumentMimeType(declared)) {
    return {
      ok: false,
      message: 'Upload a photograph or a PDF. Other file types are not accepted.',
    };
  }

  const head = new Uint8Array(await file.slice(0, SIGNATURE_HEAD_BYTES).arrayBuffer());

  if (!contentMatchesDeclaredType(declared, head)) {
    // The kind is logged and the path is not: the path carries the membership,
    // and an application log is a wider audience than the bucket's policies.
    logger.warn(
      'A benefit document upload was refused: content did not match its type.',
      {
        declared,
        kind,
      },
    );

    return {
      ok: false,
      message:
        'That file is not the type it claims to be. Try saving it again as a JPEG or PDF.',
    };
  }

  const path = buildBenefitDocumentPath(membershipId, kind, subject, declared);
  const supabase = await createSupabaseServerClient();

  const { error } = await supabase.storage.from(BENEFIT_BUCKET).upload(path, file, {
    contentType: declared,
    // Never overwrite. A random path makes a collision essentially impossible,
    // and refusing an upsert means a bug cannot destroy evidence somebody has
    // already checked.
    upsert: false,
  });

  if (error !== null) {
    logger.warn('A benefit document upload failed.', { kind, message: error.message });
    return { ok: false, message: 'That file could not be saved. Please try again.' };
  }

  return { ok: true, path, contentType: declared, byteSize: file.size };
}

/**
 * A short-lived signed URL for a filed document, or `null`.
 *
 * Signed as the caller, so the read policy applies: a member may fetch their
 * own invoice and not an officer's working paper, and nobody may fetch another
 * membership's anything. A `null` here is an authorization outcome as often as
 * it is a fault, which is why it is not logged as a warning.
 */
export async function signedBenefitDocumentUrl(path: string): Promise<string | null> {
  if (path === '') return null;

  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase.storage
    .from(BENEFIT_BUCKET)
    .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);

  if (error !== null || data === null) {
    logger.debug('Could not sign a benefit document URL.');
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
 *
 * The storage policy refuses this for any object whose metadata row has been
 * checked, and so does the metadata delete guard — so deleting the file and
 * deleting the record are refused together rather than one succeeding.
 */
export async function removeBenefitDocumentObject(path: string): Promise<void> {
  const supabase = await createSupabaseServerClient();

  const { error } = await supabase.storage.from(BENEFIT_BUCKET).remove([path]);

  if (error !== null) {
    logger.warn('A benefit document object could not be removed.', {
      message: error.message,
    });
  }
}
