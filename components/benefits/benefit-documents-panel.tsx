'use client';

import { useActionState, useState } from 'react';

import { BenefitDocumentBadge } from '@/components/benefits/benefit-badges';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field, SelectField } from '@/components/ui/field';
import { Label } from '@/components/ui/label';
import {
  removeBenefitDocumentAction,
  uploadBenefitDocumentAction,
  verifyBenefitDocumentAction,
  type BenefitActionResult,
} from '@/lib/benefits/actions';
import type { BenefitDocument, BenefitDocumentKind } from '@/lib/data/benefits';
import { ALLOWED_DOCUMENT_MIME_TYPES } from '@/lib/validation/client';

/**
 * The evidence on a claim or a beneficiary record.
 *
 * ## A document existing is not a fact being established
 *
 * This is the whole design. Every attached document arrives `unchecked`, and
 * `assess_benefit_claim` counts only the **verified** ones against the kinds
 * its claim type requires. `verify_benefit_document` refuses the person who
 * attached the document, so the upload and the attestation are always two
 * hands — which is what stops an evidence workflow from being decorative.
 *
 * The panel therefore shows the verification state as prominently as the file,
 * and the progress line counts checked documents rather than attached ones.
 *
 * ## Refusing a document needs a reason and verifying one does not
 *
 * Asymmetric on purpose, and the schema enforces it. "I looked at this and it
 * is what it says it is" needs no essay. "I am not accepting this" has to
 * travel back to whoever has to produce a replacement, and a refusal with no
 * reason is a dead end for the member.
 *
 * ## The URLs are signed and expire in a minute
 *
 * They are minted by the page, as the caller, so the storage read policy
 * applies. Nothing here is a permanent address: a link to a death certificate
 * pasted into a message would otherwise outlive the conversation.
 */
export function BenefitDocumentsPanel({
  claimId,
  beneficiaryId,
  documents,
  kinds,
  urls,
  canAttach,
  canVerify,
  canRemove,
  heading = 'Evidence',
}: {
  readonly claimId: string | null;
  readonly beneficiaryId: string | null;
  readonly documents: readonly BenefitDocument[];
  readonly kinds: readonly BenefitDocumentKind[];
  /** Document id → one-minute signed URL, or absent when it could not be signed. */
  readonly urls: Readonly<Record<string, string>>;
  readonly canAttach: boolean;
  readonly canVerify: boolean;
  readonly canRemove: boolean;
  readonly heading?: string;
}) {
  const required = kinds.filter((kind) => kind.isRequiredForAssessment);
  const verifiedKinds = new Set(
    documents
      .filter((document) => document.verificationStatus === 'verified')
      .map((document) => document.kind),
  );
  const outstanding = required.filter((kind) => !verifiedKinds.has(kind.key));

  return (
    <Card>
      <h2 className="text-text text-sm font-semibold">{heading}</h2>

      {required.length === 0 ? (
        <p className="text-text-muted mt-1 text-sm">
          No particular document is required here.
        </p>
      ) : outstanding.length === 0 ? (
        <p className="text-success mt-1 text-sm font-medium">
          Every required document has been checked.
        </p>
      ) : (
        <p className="text-text-muted mt-1 text-sm">
          Still needed, checked:{' '}
          {outstanding.map((kind) => kind.label.toLowerCase()).join(', ')}. A document
          that has been attached and not checked does not count.
        </p>
      )}

      {documents.length === 0 ? (
        <p className="text-text-muted mt-4 text-sm">Nothing has been attached yet.</p>
      ) : (
        <ul className="mt-4 min-w-0 space-y-3">
          {documents.map((document) => (
            <DocumentRow
              key={document.id}
              document={document}
              url={urls[document.id]}
              canVerify={canVerify}
              canRemove={canRemove}
            />
          ))}
        </ul>
      )}

      {canAttach ? (
        <AttachForm claimId={claimId} beneficiaryId={beneficiaryId} kinds={kinds} />
      ) : null}
    </Card>
  );
}

function DocumentRow({
  document,
  url,
  canVerify,
  canRemove,
}: {
  readonly document: BenefitDocument;
  readonly url: string | undefined;
  readonly canVerify: boolean;
  readonly canRemove: boolean;
}) {
  const [verifyResult, verify, verifying] = useActionState<
    BenefitActionResult | undefined,
    FormData
  >(verifyBenefitDocumentAction, undefined);

  const [removeResult, remove, removing] = useActionState<
    BenefitActionResult | undefined,
    FormData
  >(removeBenefitDocumentAction, undefined);

  const [refusing, setRefusing] = useState(false);

  return (
    <li className="border-border min-w-0 rounded-lg border p-3">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-text text-sm font-medium">{document.kindLabel}</p>
          {document.label === null ? null : (
            <p className="text-text-muted text-sm break-words">{document.label}</p>
          )}
          <p className="text-text-muted text-xs">
            Attached by {document.uploadedByLabel} ·{' '}
            {Math.max(1, Math.round(document.byteSize / 1024))} KB
          </p>
          {document.verifiedByLabel === null ? null : (
            <p className="text-text-muted text-xs">
              {document.verificationStatus === 'verified' ? 'Checked' : 'Refused'} by{' '}
              {document.verifiedByLabel}
            </p>
          )}
          {document.verificationNote === null ? null : (
            <p className="text-text mt-1 text-sm">{document.verificationNote}</p>
          )}
        </div>
        <BenefitDocumentBadge status={document.verificationStatus} />
      </div>

      <div className="mt-2 flex min-w-0 flex-wrap items-center gap-3">
        {url === undefined ? (
          <span className="text-text-muted text-sm">
            This document could not be opened just now.
          </span>
        ) : (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="text-accent focus-visible:outline-accent inline-flex min-h-11 items-center text-sm font-medium underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 md:min-h-0"
          >
            Open the document
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        )}

        {canVerify && document.verificationStatus === 'unchecked' ? (
          <>
            <form action={verify} className="contents">
              <input type="hidden" name="documentId" value={document.id} />
              <input type="hidden" name="verified" value="true" />
              <Button type="submit" variant="secondary" disabled={verifying}>
                {verifying ? 'Recording…' : 'It is what it says'}
              </Button>
            </form>

            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setRefusing(!refusing);
              }}
            >
              {refusing ? 'Never mind' : 'Refuse it'}
            </Button>
          </>
        ) : null}

        {canRemove && document.verificationStatus === 'unchecked' ? (
          <form action={remove} className="contents">
            <input type="hidden" name="documentId" value={document.id} />
            <Button type="submit" variant="danger" disabled={removing}>
              {removing ? 'Removing…' : 'Remove'}
            </Button>
          </form>
        ) : null}
      </div>

      {refusing ? (
        <form action={verify} className="mt-3 min-w-0 space-y-2">
          <input type="hidden" name="documentId" value={document.id} />
          <input type="hidden" name="verified" value="false" />
          <Field
            label="Why is it not acceptable?"
            name="note"
            type="text"
            required
            autoFocus
            error={verifyResult?.fieldErrors?.note?.[0]}
            hint="This travels back to whoever has to produce a replacement, so say what is wrong with it."
          />
          <Button type="submit" variant="danger" disabled={verifying}>
            {verifying ? 'Recording…' : 'Refuse this document'}
          </Button>
        </form>
      ) : null}

      {verifyResult?.ok === false ? (
        <Alert tone="danger" className="mt-2">
          {verifyResult.message}
        </Alert>
      ) : null}

      {removeResult?.ok === false ? (
        <Alert tone="danger" className="mt-2">
          {removeResult.message}
        </Alert>
      ) : null}
    </li>
  );
}

function AttachForm({
  claimId,
  beneficiaryId,
  kinds,
}: {
  readonly claimId: string | null;
  readonly beneficiaryId: string | null;
  readonly kinds: readonly BenefitDocumentKind[];
}) {
  const [result, submit, pending] = useActionState<
    BenefitActionResult | undefined,
    FormData
  >(uploadBenefitDocumentAction, undefined);

  return (
    <form action={submit} className="border-border mt-4 min-w-0 space-y-3 border-t pt-4">
      {claimId === null ? null : <input type="hidden" name="claimId" value={claimId} />}
      {beneficiaryId === null ? null : (
        <input type="hidden" name="beneficiaryId" value={beneficiaryId} />
      )}

      <h3 className="text-text text-sm font-medium">Attach a document</h3>

      {result?.ok === false ? <Alert tone="danger">{result.message}</Alert> : null}
      {result?.ok === true ? <Alert tone="success">{result.message}</Alert> : null}

      <SelectField
        label="What is it?"
        name="kind"
        required
        placeholder="Choose what the document is…"
        options={kinds.map((kind) => ({
          value: kind.key,
          label: kind.isRequiredForAssessment ? `${kind.label} (required)` : kind.label,
        }))}
        error={result?.fieldErrors?.kind?.[0]}
        hint="What the document is said to be. Whether it establishes it is a separate act, by somebody else."
      />

      <Field
        label="A note about it (optional)"
        name="label"
        type="text"
        autoComplete="off"
        error={result?.fieldErrors?.label?.[0]}
      />

      <div className="min-w-0 space-y-1.5">
        <Label htmlFor="benefit-document-file" required>
          The file
        </Label>
        <input
          id="benefit-document-file"
          type="file"
          name="file"
          required
          accept={ALLOWED_DOCUMENT_MIME_TYPES.join(',')}
          className="text-text file:border-border file:bg-surface-sunken file:text-text min-h-touch w-full text-sm file:mr-3 file:rounded-lg file:border file:px-3 file:py-2 file:text-sm md:min-h-0"
        />
        <p className="text-text-muted text-xs">
          A photograph or a PDF, up to 10 MB. The file is checked against its own first
          bytes, not its extension, and is stored under a generated name — a photograph of
          a death certificate often carries the subject&rsquo;s name in its filename.
        </p>
      </div>

      <Button type="submit" disabled={pending}>
        {pending ? 'Uploading…' : 'Attach the document'}
      </Button>
    </form>
  );
}
