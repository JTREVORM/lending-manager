'use client';

import { useActionState } from 'react';
import { useRouter } from 'next/navigation';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field, SelectField } from '@/components/ui/field';
import { Money } from '@/components/ui/money';
import { ROUTES } from '@/config/app';
import {
  openCondolenceClaimAction,
  type BenefitActionResult,
} from '@/lib/benefits/actions';
import type { BeneficiaryRelationship } from '@/lib/data/benefits';
import type { UgxAmount } from '@/lib/domain/money';

/**
 * A family condolence claim.
 *
 * ## The amount is fixed, so the form states it rather than asking
 *
 * UGX 100,000, from the policy version in force. There is no amount field,
 * because there is no amount to decide: a form that asked would invite a
 * number somebody had to then refuse. The figure shown comes from the policy
 * row, so it changes when a new version is approved and never because this
 * file was edited.
 *
 * ## The relationship is required, and nobody has decided which qualify
 *
 * Both are true at once, and the form says both. The claim records what the
 * member says the deceased was to them — that is a fact about the claim. Which
 * relationships *qualify* is question nine on the open list, so
 * `beneficiary_relationships.condolence_eligible` is NULL on every row and
 * `assess_benefit_claim` refuses with `relationship_eligibility_undecided`.
 *
 * Recording the claim without the relationship would make it unassessable on
 * the day the client answers, which is the worst of both outcomes. So the
 * field is required and the notice is honest.
 */
export function CondolenceClaimForm({
  membershipId,
  memberName,
  membershipNumber,
  relationships,
  benefitAmount,
  nextOfKin = [],
}: {
  readonly membershipId: string;
  readonly memberName: string;
  readonly membershipNumber: string;
  readonly relationships: readonly BeneficiaryRelationship[];
  readonly benefitAmount: UgxAmount;
  readonly nextOfKin?: readonly {
    readonly id: string;
    readonly beneficiaryNumber: string;
  }[];
}) {
  const router = useRouter();

  const [result, submit, pending] = useActionState<
    BenefitActionResult | undefined,
    FormData
  >(async (previous, formData) => {
    const next = await openCondolenceClaimAction(previous, formData);

    if (next.ok && next.claimId !== undefined) {
      router.replace(`${ROUTES.benefitClaims}/${next.claimId}?opened=1`);
    }

    return next;
  }, undefined);

  // NULL on every row, which is the undecided rule. Stated once, here, rather
  // than hidden behind a disabled option per relationship — the claim is
  // recordable for any of them and it is the assessment that waits.
  const anyDecided = relationships.some((row) => row.condolenceEligible !== null);

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
              Fixed by the policy in force. Not a figure anybody enters.
            </dd>
          </div>
        </dl>

        <div className="space-y-4">
          <SelectField
            name="deceasedBeneficiaryId"
            label="Deceased's registered next-of-kin record"
            placeholder="No prior listing available"
            options={nextOfKin.map((kin) => ({
              value: kin.id,
              label: kin.beneficiaryNumber,
            }))}
            error={result?.fieldErrors?.deceasedBeneficiaryId?.[0]}
          />
          <p className="text-text-muted text-sm">
            Choose the record that listed the deceased before the death. A claim without
            it is recorded and held for verification.
          </p>
          <Field
            label="Who died"
            name="deceasedName"
            type="text"
            autoComplete="off"
            required
            autoFocus
            error={result?.fieldErrors?.deceasedName?.[0]}
            hint="As it appears on the death evidence."
          />

          <SelectField
            label="What they were to the member"
            name="deceasedRelationship"
            required
            placeholder="Choose a relationship…"
            options={relationships.map((row) => ({
              value: row.key,
              label: row.label,
            }))}
            error={result?.fieldErrors?.deceasedRelationship?.[0]}
          />

          <Field
            label="Date of death"
            name="dateOfDeath"
            type="date"
            required
            error={result?.fieldErrors?.dateOfDeath?.[0]}
          />
        </div>

        {anyDecided ? null : (
          <Alert tone="warning" title="Which relatives qualify is not yet decided">
            The client has confirmed the amount and not who counts as an eligible family
            member. Record the claim and the relationship — the assessment will hold it
            with that exact reason until they answer, and will then be able to settle it
            without anybody re-entering anything.
          </Alert>
        )}

        <div className="mt-4">
          <Button type="submit" disabled={pending}>
            {pending ? 'Opening…' : 'Open the claim'}
          </Button>
        </div>
      </Card>
    </form>
  );
}
