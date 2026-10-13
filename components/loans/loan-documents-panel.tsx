'use client';

import { useActionState, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Label } from '@/components/ui/label';
import { SelectField } from '@/components/clients/select-field';
import {
  removeLoanDocumentAction,
  uploadLoanDocumentAction,
} from '@/lib/loans/application-actions';
import {
  GUARANTOR_DOCUMENT_KINDS,
  LOAN_DOCUMENT_LABELS,
  isGuarantorDocumentKind,
  type LoanDocumentKind,
} from '@/lib/validation/loan-application';
import { formatRecordedDate } from '@/lib/domain/client';
import type { LoanDocument, LoanGuarantor } from '@/lib/data/loan-application';
import type { ActionResult } from '@/lib/auth/actions';

/**
 * The evidence filed with an application.
 *
 * ## No preview, and no link that outlives the page
 *
 * Each document is listed by kind, label and size. Opening one is a separate
 * act that mints a sixty-second signed URL server-side, because a permanent
 * URL is a credential: once it exists, anyone it is forwarded to can read the
 * document indefinitely, with no record and no way to revoke it.
 *
 * ## Which kinds are offered depends on the product
 *
 * A salary product offers a payslip and an employment letter; a business
 * product a trading licence, a bank statement and photographs. Offering all
 * nine everywhere would be a select somebody has to read to the end of to
 * find the two that apply.
 */
export function LoanDocumentsPanel({
  loanId,
  documents,
  guarantors,
  applicationProfile,
  editable,
  canUpload,
  requiresSupportingDocuments,
}: {
  readonly loanId: string;
  readonly documents: readonly LoanDocument[];
  readonly guarantors: readonly LoanGuarantor[];
  readonly applicationProfile: string;
  readonly editable: boolean;
  readonly canUpload: boolean;
  readonly requiresSupportingDocuments: boolean;
}) {
  const offered = kindsFor(applicationProfile, guarantors.length > 0);

  return (
    <div className="min-w-0 space-y-4">
      {requiresSupportingDocuments && documents.length === 0 ? (
        <Alert tone="info">
          This product expects supporting documents. Nothing has been filed yet.
        </Alert>
      ) : null}

      {documents.length === 0 ? (
        <Card>
          <p className="text-text-muted">No documents have been filed yet.</p>
        </Card>
      ) : (
        <ul className="min-w-0 space-y-2">
          {documents.map((document) => (
            <li key={document.id}>
              <DocumentRow
                loanId={loanId}
                doc={document}
                guarantors={guarantors}
                editable={editable && canUpload}
              />
            </li>
          ))}
        </ul>
      )}

      {editable && canUpload ? (
        <UploadForm loanId={loanId} kinds={offered} guarantors={guarantors} />
      ) : null}
    </div>
  );
}

/** Which kinds make sense for this product, in the order a person would file them. */
function kindsFor(
  applicationProfile: string,
  hasGuarantors: boolean,
): readonly LoanDocumentKind[] {
  const base: LoanDocumentKind[] = [];

  if (applicationProfile === 'salary') {
    base.push('payslip', 'employment_letter');
  }

  if (applicationProfile === 'business') {
    base.push('trading_licence', 'bank_statement', 'business_photo');
  }

  base.push('supporting');

  if (hasGuarantors) {
    base.push(...GUARANTOR_DOCUMENT_KINDS);
  }

  // Deduplicated in declaration order, so a product that somehow names two
  // profiles does not offer the same kind twice.
  return [...new Set(base)];
}

/**
 * One filed document.
 *
 * The prop is `doc` rather than `document`, which would shadow the DOM global
 * inside a client component — legal, and exactly the kind of shadowing that
 * makes a later `document.getElementById` read as a type error nobody
 * expects.
 */
function DocumentRow({
  loanId,
  doc,
  guarantors,
  editable,
}: {
  readonly loanId: string;
  readonly doc: LoanDocument;
  readonly guarantors: readonly LoanGuarantor[];
  readonly editable: boolean;
}) {
  const [state, formAction, pending] = useActionState<ActionResult | undefined, FormData>(
    removeLoanDocumentAction,
    undefined,
  );

  const owner =
    doc.loanGuarantorId === null
      ? null
      : (guarantors.find((guarantor) => guarantor.id === doc.loanGuarantorId) ?? null);

  return (
    <div className="border-border bg-surface min-w-0 rounded-lg border p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-text font-medium break-words">
            {LOAN_DOCUMENT_LABELS[doc.kind]}
          </p>
          <p className="text-text-muted text-sm break-words">
            {doc.label ?? 'No description'}
            {owner === null ? '' : ` · ${owner.fullName}`}
          </p>
          <p className="text-text-muted text-sm">
            {formatBytes(doc.byteSize)} · filed {formatRecordedDate(doc.createdAt)}
          </p>
        </div>

        <Badge tone="neutral">
          {doc.contentType === 'application/pdf' ? 'PDF' : 'Image'}
        </Badge>
      </div>

      {state?.message !== undefined ? (
        <Alert tone={state.ok ? 'success' : 'danger'} className="mt-2">
          {state.message}
        </Alert>
      ) : null}

      {editable ? (
        <form action={formAction} className="mt-2">
          <input type="hidden" name="loanId" value={loanId} />
          <input type="hidden" name="documentId" value={doc.id} />
          <button
            type="submit"
            disabled={pending}
            className="text-danger focus-visible:outline-accent min-h-11 text-sm font-medium underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50"
          >
            {pending ? 'Removing…' : 'Remove'}
          </button>
        </form>
      ) : null}
    </div>
  );
}

function UploadForm({
  loanId,
  kinds,
  guarantors,
}: {
  readonly loanId: string;
  readonly kinds: readonly LoanDocumentKind[];
  readonly guarantors: readonly LoanGuarantor[];
}) {
  const [state, formAction, pending] = useActionState<ActionResult | undefined, FormData>(
    uploadLoanDocumentAction,
    undefined,
  );

  const [kind, setKind] = useState<string>(kinds[0] ?? 'supporting');

  const needsGuarantor = isGuarantorDocumentKind(kind as LoanDocumentKind);

  return (
    <Card className="min-w-0 space-y-3">
      <h3 className="text-text font-medium">File a document</h3>

      <form action={formAction} className="min-w-0 space-y-4" noValidate>
        <input type="hidden" name="loanId" value={loanId} />

        {state?.message !== undefined ? (
          <Alert tone={state.ok ? 'success' : 'danger'}>{state.message}</Alert>
        ) : null}

        <div className="grid min-w-0 gap-4 sm:grid-cols-2">
          <SelectField
            label="What is it"
            name="kind"
            required
            defaultValue={kind}
            options={kinds.map((value) => ({
              value,
              label: LOAN_DOCUMENT_LABELS[value],
            }))}
            error={state?.fieldErrors?.kind?.[0]}
            onValueChange={setKind}
          />

          {needsGuarantor ? (
            <SelectField
              label="Whose"
              name="loanGuarantorId"
              required
              options={[
                { value: '', label: 'Select a guarantor…' },
                ...guarantors.map((guarantor) => ({
                  value: guarantor.id,
                  label: guarantor.fullName,
                })),
              ]}
              error={state?.fieldErrors?.loanGuarantorId?.[0]}
            />
          ) : null}

          <Field
            label="Description"
            name="label"
            hint="Optional. What this is, in a few words."
            error={state?.fieldErrors?.label?.[0]}
          />

          <div className="min-w-0 space-y-1.5">
            <Label htmlFor="loan-document-file" required>
              File
            </Label>
            <input
              id="loan-document-file"
              type="file"
              name="file"
              required
              accept="image/jpeg,image/png,image/webp,image/heic,application/pdf"
              className="border-border bg-surface text-text focus-visible:outline-accent file:bg-surface-sunken w-full rounded-lg border p-2.5 text-base file:mr-3 file:rounded file:border-0 file:px-3 file:py-1.5 file:text-sm focus-visible:outline-2 focus-visible:outline-offset-2"
            />
            <p className="text-text-muted text-sm">
              A photograph or a PDF, up to 5 MB. The file is checked against its declared
              type.
            </p>
          </div>
        </div>

        <Button type="submit" disabled={pending} className="sm:w-auto">
          {pending ? 'Uploading…' : 'File this document'}
        </Button>
      </form>
    </Card>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
