'use client';

import { useActionState, useState } from 'react';
import { useRouter } from 'next/navigation';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field, SelectField } from '@/components/ui/field';
import { ROUTES } from '@/config/app';
import {
  registerBeneficiaryAction,
  type BenefitActionResult,
} from '@/lib/benefits/actions';
import type { BeneficiaryRelationship, BeneficiarySummary } from '@/lib/data/benefits';
import {
  BENEFICIARY_IDENTITY_DOCUMENT_KINDS,
  BENEFICIARY_IDENTITY_DOCUMENT_LABELS,
} from '@/lib/domain/benefits';

/**
 * Registering a member's next of kin, or recording a change to one.
 *
 * ## Why a change is a new record and not an edit
 *
 * Passing `supersedesId` makes this a change: the old record becomes
 * `superseded` with every detail intact, in the same statement, so there is
 * never a moment at which both are live. "Who was the beneficiary when that
 * claim was approved" has to be answerable years later, and an edit would
 * destroy the answer. A superseded record keeps its verification too, so a
 * historic payment stays explicable.
 *
 * The database refuses the change outright while a bereavement claim on that
 * membership is under way — the recipient the business is deciding on must not
 * move under the decision.
 *
 * ## The identity document is "what was shown", not "a national ID"
 *
 * Deliberately wider than the client record's. A beneficiary is a third party
 * who has consented to nothing, may be a minor and may hold no national ID at
 * all — and the client has not approved a procedure for identifying them. So
 * the record says which document was produced, and which documents are
 * acceptable stays the client's question. Both fields or neither: half an
 * identification identifies nobody.
 *
 * ## Nothing here verifies anything
 *
 * A registered beneficiary arrives `pending_verification`, and
 * `verify_member_beneficiary` refuses the person who recorded it. Two hands,
 * always — which is what stops a single member of staff inventing a payee.
 */
export function BeneficiaryForm({
  membershipId,
  memberName,
  membershipNumber,
  relationships,
  supersedes,
  hasPrimary,
}: {
  readonly membershipId: string;
  readonly memberName: string;
  readonly membershipNumber: string;
  readonly relationships: readonly BeneficiaryRelationship[];
  /** The record this one replaces, when it is a change. */
  readonly supersedes: BeneficiarySummary | null;
  /** Whether the member already has a primary beneficiary. */
  readonly hasPrimary: boolean;
}) {
  const router = useRouter();

  const [result, submit, pending] = useActionState<
    BenefitActionResult | undefined,
    FormData
  >(async (previous, formData) => {
    const next = await registerBeneficiaryAction(previous, formData);

    if (next.ok && next.beneficiaryId !== undefined) {
      router.replace(`${ROUTES.beneficiaries}/${next.beneficiaryId}?registered=1`);
    }

    return next;
  }, undefined);

  const [documentKind, setDocumentKind] = useState('');

  // Primary by default when the member has none, because the first registered
  // next of kin is the one the business would pay. Offered as a choice when
  // one exists, because `member_beneficiaries_one_primary` permits exactly one
  // and the form should not silently try to be the second.
  const [isPrimary, setIsPrimary] = useState(
    !hasPrimary || supersedes?.isPrimary === true,
  );

  if (result?.ok === true) {
    return (
      <Alert tone="success">
        <span className="font-medium">{result.message}</span> Opening the record…
      </Alert>
    );
  }

  return (
    <form action={submit} className="min-w-0 space-y-4">
      <input type="hidden" name="membershipId" value={membershipId} />
      {supersedes === null ? null : (
        <input type="hidden" name="supersedesId" value={supersedes.id} />
      )}

      {result?.ok === false ? <Alert tone="danger">{result.message}</Alert> : null}

      <Card>
        <dl className="mb-4 grid min-w-0 gap-3 sm:grid-cols-2">
          <div className="min-w-0">
            <dt className="text-text-muted text-sm">Member</dt>
            <dd className="text-text font-medium break-words">{memberName}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-text-muted text-sm">Membership</dt>
            <dd className="text-text font-mono">{membershipNumber}</dd>
          </div>
        </dl>

        {supersedes === null ? null : (
          <Alert tone="warning" className="mb-4" title="This replaces an existing record">
            <span className="font-mono">{supersedes.beneficiaryNumber}</span> (
            {supersedes.relationshipLabel}) becomes superseded the moment this is saved,
            with every detail and its verification intact. Nothing is deleted, and a
            payment already made against it stays explicable.
          </Alert>
        )}

        <div className="space-y-4">
          <Field
            label="The beneficiary's full name"
            name="fullName"
            type="text"
            autoComplete="off"
            required
            autoFocus
            error={result?.fieldErrors?.fullName?.[0]}
            hint="As it appears on whatever document will be shown. It is not searchable from the register."
          />

          <SelectField
            label="Relationship to the member"
            name="relationship"
            required
            placeholder="Choose a relationship…"
            options={relationships.map((row) => ({
              value: row.key,
              label: row.label,
            }))}
            error={result?.fieldErrors?.relationship?.[0]}
          />

          <Field
            label="Telephone number"
            name="phone"
            type="tel"
            inputMode="tel"
            autoComplete="off"
            required
            error={result?.fieldErrors?.phone?.[0]}
            hint="A Ugandan number, for example 0771234567. It is how the business reaches them when it matters most."
          />

          <Field
            label="Another number (optional)"
            name="alternativePhone"
            type="tel"
            inputMode="tel"
            autoComplete="off"
            error={result?.fieldErrors?.alternativePhone?.[0]}
            hint="A relative's or a neighbour's. Not the same number again."
          />

          <Field
            label="Village or area (optional)"
            name="villageArea"
            type="text"
            autoComplete="off"
            error={result?.fieldErrors?.villageArea?.[0]}
          />

          <Field
            label="District (optional)"
            name="district"
            type="text"
            autoComplete="off"
            error={result?.fieldErrors?.district?.[0]}
          />

          <SelectField
            label="What document was shown? (optional)"
            name="identityDocumentKind"
            placeholder="No document was shown"
            value={documentKind}
            onChange={(event) => {
              setDocumentKind(event.target.value);
            }}
            options={BENEFICIARY_IDENTITY_DOCUMENT_KINDS.map((kind) => ({
              value: kind,
              label: BENEFICIARY_IDENTITY_DOCUMENT_LABELS[kind],
            }))}
            error={result?.fieldErrors?.identityDocumentKind?.[0]}
            hint="What was produced, not what ought to be produced. Which documents are acceptable is the client's decision and has not been made."
          />

          {documentKind === '' ? null : (
            <Field
              label="Its reference or number"
              name="identityReference"
              type="text"
              autoComplete="off"
              autoCapitalize="characters"
              required
              error={result?.fieldErrors?.identityReference?.[0]}
              hint="Both the document and its reference, or neither."
            />
          )}

          <div className="min-w-0">
            <label className="min-h-touch flex min-w-0 cursor-pointer items-start gap-3 md:min-h-0">
              <input
                type="checkbox"
                name="isPrimary"
                value="true"
                checked={isPrimary}
                onChange={(event) => {
                  setIsPrimary(event.target.checked);
                }}
                className="accent-accent mt-1 size-4 shrink-0"
              />
              <span className="min-w-0">
                <span className="text-text block text-sm font-medium">
                  This is the member&rsquo;s primary next of kin
                </span>
                <span className="text-text-muted block text-xs">
                  The one the bereavement benefit is paid to. A member has exactly one, so
                  saving this will move it if another record holds it.
                </span>
              </span>
            </label>
            {result?.fieldErrors?.isPrimary?.[0] === undefined ? null : (
              <p className="text-danger mt-1 text-xs">
                {result.fieldErrors.isPrimary[0]}
              </p>
            )}
          </div>
        </div>

        <p className="text-text-muted mt-4 text-xs">
          The record is saved unverified. Somebody else has to check it against a document
          before a bereavement benefit can be assessed — an unverified beneficiary is
          never paid automatically.
        </p>

        <div className="mt-4">
          <Button type="submit" disabled={pending}>
            {pending
              ? 'Saving…'
              : supersedes === null
                ? 'Register this beneficiary'
                : 'Replace the existing record'}
          </Button>
        </div>
      </Card>
    </form>
  );
}
