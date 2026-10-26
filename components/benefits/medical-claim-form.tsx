'use client';

import { useActionState, useState } from 'react';
import { useRouter } from 'next/navigation';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Money } from '@/components/ui/money';
import { ROUTES } from '@/config/app';
import { openMedicalClaimAction, type BenefitActionResult } from '@/lib/benefits/actions';
import {
  admissionLength,
  admissionVerdict,
  medicalBenefitAmount,
} from '@/lib/domain/benefits';
import { formatUgx, toUgx } from '@/lib/domain/money';
import { instantToBusinessDate } from '@/lib/domain/datetime';

/**
 * A medical support claim.
 *
 * ## The preview is a preview, and says so
 *
 * The figure beneath the bill is 5% of what has been typed, computed by the
 * same `medicalBenefitAmount` the database mirrors — but the amount that gets
 * recorded is the one `assess_benefit_claim` works out, from the policy
 * version in force at assessment, under the membership's row lock, against
 * whatever the member has already claimed this year. So this says "would be",
 * and the screen never calls it the benefit.
 *
 * ## Why the admission reading is shown as three numbers
 *
 * The client's rule is "an admission longer than one day" and does not say
 * what is counted. Monday 22:00 to Tuesday 09:00 is one night, two days on a
 * ward chart, and zero days on a clock. The form shows all three, because the
 * person entering the claim is the only one who can still go back to the
 * hospital and ask — and because a claim whose readings disagree will be
 * refused at assessment with `admission_measure_undecided`, which is far
 * better learned now than in a week.
 *
 * Nothing here blocks on it. A stay that reads short is still recordable: the
 * business should be able to write down that somebody came in and asked, and
 * the refusal that follows is a document the member can be shown.
 *
 * ## The discharge is optional
 *
 * A claim opened while the member is still in the ward is ordinary. The
 * database refuses to *submit* one without a discharge, which is the right
 * place for that refusal, so this form takes the draft.
 */
export function MedicalClaimForm({
  membershipId,
  memberName,
  membershipNumber,
  medicalRateBps,
  minimumAdmissionDays,
}: {
  readonly membershipId: string;
  readonly memberName: string;
  readonly membershipNumber: string;
  readonly medicalRateBps: number;
  readonly minimumAdmissionDays: number;
}) {
  const router = useRouter();

  const [result, submit, pending] = useActionState<
    BenefitActionResult | undefined,
    FormData
  >(async (previous, formData) => {
    const next = await openMedicalClaimAction(previous, formData);

    if (next.ok && next.claimId !== undefined) {
      router.replace(`${ROUTES.benefitClaims}/${next.claimId}?opened=1`);
    }

    return next;
  }, undefined);

  const [billText, setBillText] = useState('');
  const [admissionAt, setAdmissionAt] = useState('');
  const [dischargeAt, setDischargeAt] = useState('');

  const bill = /^\d+$/.test(billText.replace(/[\s,]/g, ''))
    ? Number(billText.replace(/[\s,]/g, ''))
    : null;

  // Tolerant of a half-typed `datetime-local` value, which fires `change` on
  // every component of the control.
  const admitted = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(admissionAt)
    ? new Date(`${admissionAt}:00+03:00`)
    : null;
  const discharged = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(dischargeAt)
    ? new Date(`${dischargeAt}:00+03:00`)
    : null;

  const length =
    admitted !== null && discharged !== null && discharged > admitted
      ? admissionLength(admitted, discharged, (instant) => instantToBusinessDate(instant))
      : null;

  const verdict = length === null ? null : admissionVerdict(length, minimumAdmissionDays);

  // The same half-up integer arithmetic the database and `medicalBenefitAmount`
  // use, through the one function that implements it — never a float multiply.
  const wouldBe =
    bill === null || bill <= 0 ? null : medicalBenefitAmount(bill, medicalRateBps);

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

        <div className="space-y-4">
          <Field
            label="Hospital or clinic"
            name="providerName"
            type="text"
            autoComplete="off"
            required
            autoFocus
            error={result?.fieldErrors?.providerName?.[0]}
            hint="As it appears on the admission record. It is not searchable from the register — a search box that matched a hospital would confirm which members had been admitted where."
          />

          <Field
            label="Admitted"
            name="admissionAt"
            type="datetime-local"
            required
            value={admissionAt}
            onChange={(event) => {
              setAdmissionAt(event.target.value);
            }}
            error={result?.fieldErrors?.admissionAt?.[0]}
            hint="The time on the admission record, in Kampala time."
          />

          <Field
            label="Discharged (optional while the member is still admitted)"
            name="dischargeAt"
            type="datetime-local"
            value={dischargeAt}
            onChange={(event) => {
              setDischargeAt(event.target.value);
            }}
            error={result?.fieldErrors?.dischargeAt?.[0]}
            hint="A claim can be opened before the member is discharged. It cannot be submitted without this."
          />

          <Field
            label="Hospital bill"
            name="billAmount"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            required
            value={billText}
            onChange={(event) => {
              setBillText(event.target.value);
            }}
            error={result?.fieldErrors?.billAmount?.[0]}
            hint="The eligible bill, in whole shillings. Ugandan shillings have no smaller unit."
          />
        </div>

        {wouldBe === null && length === null ? null : (
          <div className="border-border mt-4 min-w-0 space-y-2 rounded-lg border p-3">
            {wouldBe === null ? null : (
              <p className="text-text-muted text-sm tabular-nums">
                At {String(medicalRateBps / 100)}% of the bill, the benefit{' '}
                <span className="text-text font-semibold">
                  would be <Money amount={wouldBe} />
                </span>{' '}
                — before any annual ceiling. The amount recorded is the one the assessment
                works out.
              </p>
            )}

            {length === null || verdict === null ? null : (
              <div className="text-sm">
                <p className="text-text-muted">
                  That stay reads as {length.nights}{' '}
                  {length.nights === 1 ? 'night' : 'nights'}, {length.inclusiveDays} days
                  on a ward chart, and {length.elapsedDays} full{' '}
                  {length.elapsedDays === 1 ? 'day' : 'days'} by the clock.
                </p>
                {verdict.qualifies ? (
                  <p className="text-success mt-1 font-medium">
                    Longer than {minimumAdmissionDays}{' '}
                    {minimumAdmissionDays === 1 ? 'day' : 'days'} on every reading.
                  </p>
                ) : verdict.tooShort ? (
                  <p className="text-text mt-1 font-medium">
                    Shorter than {minimumAdmissionDays}{' '}
                    {minimumAdmissionDays === 1 ? 'day' : 'days'} on every reading, so the
                    assessment will refuse it. Record it anyway if the member has asked —
                    the refusal is a document they can be shown.
                  </p>
                ) : (
                  <p className="text-warning mt-1 font-medium">
                    The three readings disagree about whether this is longer than{' '}
                    {minimumAdmissionDays} {minimumAdmissionDays === 1 ? 'day' : 'days'}.
                    The assessment will hold the claim until the client says what is
                    counted. If the hospital can give exact times, now is the moment to
                    ask.
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        <div className="mt-4">
          <Button type="submit" disabled={pending}>
            {pending
              ? 'Opening…'
              : wouldBe === null
                ? 'Open the claim'
                : `Open a claim for a bill of ${formatUgx(toUgx(bill ?? 0))}`}
          </Button>
        </div>
      </Card>
    </form>
  );
}
