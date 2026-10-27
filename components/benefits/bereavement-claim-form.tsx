'use client';

import { useActionState } from 'react';
import { useRouter } from 'next/navigation';

import { BeneficiaryVerificationBadge } from '@/components/benefits/benefit-badges';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field, SelectField } from '@/components/ui/field';
import { Money } from '@/components/ui/money';
import { ROUTES } from '@/config/app';
import {
  openBereavementClaimAction,
  type BenefitActionResult,
} from '@/lib/benefits/actions';
import type { BeneficiarySummary } from '@/lib/data/benefits';
import type { UgxAmount } from '@/lib/domain/money';

/**
 * A member bereavement claim: the member has died, and the benefit is paid to
 * their registered next of kin.
 *
 * ## The payee is chosen here and frozen later
 *
 * The beneficiary picked on this form is a *proposal*. What the business
 * actually pays is the beneficiary recorded in the assessment snapshot, frozen
 * at assessment, and `post_benefit_payment` reads the recipient from that
 * snapshot rather than from the claim or from the beneficiary table. That is
 * what closes the substitution: a beneficiary record changed between approval
 * and payment cannot move the money, and the database refuses the change
 * outright while a bereavement claim on the membership is live.
 *
 * ## An unverified beneficiary can be proposed and cannot be paid
 *
 * The list shows every active beneficiary with its verification state, because
 * the person recording the claim on the day a member dies is usually not the
 * person who can verify one. The claim is recordable; `assess_benefit_claim`
 * refuses with `beneficiary_not_verified` until somebody has checked the
 * record against a document. "Do not automatically pay unverified
 * beneficiaries" is the client's instruction, and this is where the interface
 * makes it visible rather than surprising.
 *
 * ## No beneficiary at all is also recordable
 *
 * It has to be. A member with no registered next of kin still died, and the
 * business still has to write that down. The claim then waits with
 * `beneficiary_missing`, which is a far more useful state than a form that
 * would not submit.
 */
export function BereavementClaimForm({
  membershipId,
  memberName,
  membershipNumber,
  beneficiaries,
  benefitAmount,
}: {
  readonly membershipId: string;
  readonly memberName: string;
  readonly membershipNumber: string;
  readonly beneficiaries: readonly BeneficiarySummary[];
  readonly benefitAmount: UgxAmount;
}) {
  const router = useRouter();

  const [result, submit, pending] = useActionState<
    BenefitActionResult | undefined,
    FormData
  >(async (previous, formData) => {
    const next = await openBereavementClaimAction(previous, formData);

    if (next.ok && next.claimId !== undefined) {
      router.replace(`${ROUTES.benefitClaims}/${next.claimId}?opened=1`);
    }

    return next;
  }, undefined);

  const active = beneficiaries.filter((row) => row.status === 'active');
  const verified = active.filter((row) => row.verificationStatus === 'verified');

  if (result?.ok === true) {
    return (
      <Alert tone="success">
        <span className="font-medium">{result.message}</span> Opening the claim…
      </Alert>
    );
  }

  return (
    <form action={submit} className="min-w-0 space-y-4">
      <input type="hidden" name="membershipId" value={membershipId} />

      {result?.ok === false ? <Alert tone="danger">{result.message}</Alert> : null}

      <Card>
        <dl className="mb-4 grid min-w-0 gap-3 sm:grid-cols-3">
          <div className="min-w-0">
            <dt className="text-text-muted text-sm">Member</dt>
            <dd className="text-text font-medium break-words">{memberName}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-text-muted text-sm">Membership</dt>
            <dd className="text-text font-mono">{membershipNumber}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-text-muted text-sm">The benefit</dt>
            <dd className="text-text font-semibold tabular-nums">
              <Money amount={benefitAmount} />
            </dd>
            <dd className="text-text-muted text-xs">
              Fixed by the policy in force, payable to the registered next of kin.
            </dd>
          </div>
        </dl>

        <div className="space-y-4">
          <Field
            label="The member's name, as it appears on the death evidence"
            name="deceasedName"
            type="text"
            autoComplete="off"
            required
            autoFocus
            error={result?.fieldErrors?.deceasedName?.[0]}
            hint="Recorded on the claim so the evidence and the claim can be read against each other."
          />

          <Field
            label="Date of death"
            name="dateOfDeath"
            type="date"
            required
            error={result?.fieldErrors?.dateOfDeath?.[0]}
          />

          {active.length === 0 ? (
            // No select at all rather than an empty one: a control with
            // nothing in it invites the reader to look for the missing option.
            <div className="border-border min-w-0 rounded-lg border p-3">
              <p className="text-text text-sm font-medium">
                This member has no registered next of kin.
              </p>
              <p className="text-text-muted mt-1 text-sm">
                Record the claim anyway — it has to be on the record. It will wait at
                assessment until a beneficiary is registered and verified.
              </p>
            </div>
          ) : (
            <SelectField
              label="Who should the benefit be paid to?"
              name="beneficiaryId"
              placeholder="Decide later…"
              options={active.map((row) => ({
                value: row.id,
                label: `${row.beneficiaryNumber} · ${row.relationshipLabel}${
                  row.isPrimary ? ' (primary)' : ''
                }${row.verificationStatus === 'verified' ? '' : ' — not verified'}`,
              }))}
              error={result?.fieldErrors?.beneficiaryId?.[0]}
              hint="Listed by record number and relationship. A beneficiary's name is not shown here — it is a payment instruction, and reading one needs the sensitive-detail capability."
            />
          )}
        </div>

        {active.length > 0 ? (
          <ul className="mt-4 min-w-0 space-y-2">
            {active.map((row) => (
              <li
                key={row.id}
                className="border-border flex min-w-0 items-center justify-between gap-3 rounded-lg border p-3"
              >
                <div className="min-w-0">
                  <p className="text-text text-sm">
                    <span className="font-mono">{row.beneficiaryNumber}</span> ·{' '}
                    {row.relationshipLabel}
                    {row.isPrimary ? ' · primary' : ''}
                  </p>
                  <p className="text-text-muted text-xs">
                    Registered {row.recordedOn} by {row.recordedByLabel}
                  </p>
                </div>
                <BeneficiaryVerificationBadge status={row.verificationStatus} />
              </li>
            ))}
          </ul>
        ) : null}

        {active.length > 0 && verified.length === 0 ? (
          <Alert tone="warning" title="No verified next of kin yet">
            A beneficiary record exists and nobody has checked it against a document. The
            claim can be recorded and cannot be assessed until it is verified — an
            unverified beneficiary is never paid automatically.
          </Alert>
        ) : null}

        <div className="mt-4">
          <Button type="submit" disabled={pending}>
            {pending ? 'Opening…' : 'Open the claim'}
          </Button>
        </div>
      </Card>
    </form>
  );
}
