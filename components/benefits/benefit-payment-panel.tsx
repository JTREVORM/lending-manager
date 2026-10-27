'use client';

import { useActionState, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { DateValue } from '@/components/ui/data-value';
import { Money } from '@/components/ui/money';
import {
  payBenefitAction,
  reverseBenefitPaymentAction,
  type BenefitActionResult,
} from '@/lib/benefits/actions';
import type { BenefitClaimSummary, BenefitPaymentSummary } from '@/lib/data/benefits';
import type { UgxAmount } from '@/lib/domain/money';
import {
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  isMobileMoney,
  requiresExternalReference,
  type PaymentMethod,
} from '@/lib/domain/payment';
import { BENEFIT_RECIPIENT_KIND_LABELS } from '@/lib/domain/benefits';

/**
 * Paying an approved benefit, and reversing a payment.
 *
 * ## The recipient is not on this form
 *
 * There is no payee field, and that is the control. `post_benefit_payment`
 * reads the recipient from the assessment snapshot the approver agreed to, so
 * a payment cannot be redirected by whoever happens to be paying — which is
 * the substitution fraud §11 of the brief names. The panel shows who will be
 * paid; it does not offer to change it.
 *
 * ## The amount is not on this form either
 *
 * Same reason. The approved figure is the figure, checked again against the
 * snapshot inside the posting function. A payer who thinks it is wrong does
 * not adjust it here — the claim goes back, which needs an approver.
 *
 * ## The idempotency key
 *
 * Minted server-side when this panel renders and carried as a hidden field.
 * A double tap, a lost response or a back-button resubmission all send the
 * same key, and `post_benefit_payment` returns the payment that already
 * exists instead of paying twice. The disabled button is a courtesy; the key
 * is the guarantee. See ADR-030, and ADR-056 for why the capability check
 * sits above the replay.
 *
 * ## Reversal is the Owner's, and it is not an undo
 *
 * It posts a contra entry and leaves the original standing, because a ledger
 * is not editable. The claim moves to `reversed`, which is terminal — there
 * is no edge back to `approved`, so an erroneous reversal cannot make a paid
 * claim payable a second time.
 */
export function BenefitPaymentPanel({
  claim,
  payment,
  idempotencyKey,
  canPay,
  canReverse,
  recipientName,
  recipientKindLabel,
}: {
  readonly claim: BenefitClaimSummary;
  readonly payment: BenefitPaymentSummary | null;
  readonly idempotencyKey: string;
  readonly canPay: boolean;
  readonly canReverse: boolean;
  /** From the assessment snapshot, or `null` when the reader may not see it. */
  readonly recipientName: string | null;
  readonly recipientKindLabel: string | null;
}) {
  if (payment !== null) {
    return <PaidPanel payment={payment} canReverse={canReverse} />;
  }

  if (!canPay || claim.status !== 'approved' || claim.approvedAmount === null) {
    return null;
  }

  return (
    <PayForm
      claimId={claim.id}
      amount={claim.approvedAmount}
      idempotencyKey={idempotencyKey}
      recipientName={recipientName}
      recipientKindLabel={recipientKindLabel}
    />
  );
}

function PayForm({
  claimId,
  amount,
  idempotencyKey,
  recipientName,
  recipientKindLabel,
}: {
  readonly claimId: string;
  readonly amount: UgxAmount;
  readonly idempotencyKey: string;
  readonly recipientName: string | null;
  readonly recipientKindLabel: string | null;
}) {
  const [result, submit, pending] = useActionState<
    BenefitActionResult | undefined,
    FormData
  >(payBenefitAction, undefined);

  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [reference, setReference] = useState('');

  const referenceMissing = requiresExternalReference(method) && reference.trim() === '';

  return (
    <Card>
      <h2 className="text-text text-sm font-semibold">Pay this benefit</h2>

      <dl className="mt-3 grid min-w-0 gap-3 sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="text-text-muted text-xs">Approved amount</dt>
          <dd className="text-text mt-0.5">
            <Money amount={amount} weight="semibold" size="lg" />
          </dd>
          <dd className="text-text-muted text-xs">
            Not editable here. The posting function checks it against the assessment
            again.
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-text-muted text-xs">Who gets paid</dt>
          <dd className="text-text mt-0.5 break-words">
            {recipientName ?? 'The payee frozen in the assessment'}
          </dd>
          <dd className="text-text-muted text-xs">
            {recipientKindLabel === null
              ? 'Read from the assessment, not from this form.'
              : `${recipientKindLabel}. Read from the assessment, not from this form.`}
          </dd>
        </div>
      </dl>

      <form action={submit} className="mt-4 min-w-0 space-y-4">
        <input type="hidden" name="claimId" value={claimId} />
        <input type="hidden" name="idempotencyKey" value={idempotencyKey} />

        {result?.ok === false ? <Alert tone="danger">{result.message}</Alert> : null}
        {result?.ok === true ? <Alert tone="success">{result.message}</Alert> : null}

        <fieldset className="min-w-0">
          <legend className="text-text mb-2 text-sm font-medium">How was it paid?</legend>
          <div className="flex min-w-0 flex-wrap gap-2">
            {PAYMENT_METHODS.map((candidate) => (
              <label
                key={candidate}
                className={`focus-within:outline-accent inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3 text-sm focus-within:outline-2 focus-within:outline-offset-2 ${
                  method === candidate
                    ? 'border-accent bg-accent-surface text-accent'
                    : 'border-border text-text'
                }`}
              >
                <input
                  type="radio"
                  name="paymentMethod"
                  value={candidate}
                  checked={method === candidate}
                  onChange={() => {
                    setMethod(candidate);
                  }}
                  className="sr-only"
                />
                {PAYMENT_METHOD_LABELS[candidate]}
              </label>
            ))}
          </div>
        </fieldset>

        {requiresExternalReference(method) ? (
          <Field
            label={isMobileMoney(method) ? 'Transaction reference' : 'Transfer reference'}
            name="externalReference"
            type="text"
            autoComplete="off"
            autoCapitalize="characters"
            required
            value={reference}
            onChange={(event) => {
              setReference(event.target.value);
            }}
            error={result?.fieldErrors?.externalReference?.[0]}
            hint={
              isMobileMoney(method)
                ? 'From the Mobile Money message. It is what makes the line findable when the account is reconciled.'
                : 'From the bank statement or the payment slip.'
            }
          />
        ) : (
          // Not rendered for cash rather than rendered and ignored: the
          // database refuses a reference on a cash payment.
          <p className="text-text-muted text-sm">
            A cash payment has no network reference. Its payment number is its reference.
          </p>
        )}

        <Button type="submit" disabled={pending || referenceMissing}>
          {pending ? 'Paying…' : 'Record the payment'}
        </Button>
      </form>
    </Card>
  );
}

function PaidPanel({
  payment,
  canReverse,
}: {
  readonly payment: BenefitPaymentSummary;
  readonly canReverse: boolean;
}) {
  const [result, submit, pending] = useActionState<
    BenefitActionResult | undefined,
    FormData
  >(reverseBenefitPaymentAction, undefined);

  const [reversing, setReversing] = useState(false);

  return (
    <Card>
      <h2 className="text-text text-sm font-semibold">
        {payment.isLive ? 'This benefit has been paid' : 'This payment was reversed'}
      </h2>

      <dl className="mt-3 grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Line label="Payment">
          <span className="font-mono">{payment.paymentNumber}</span>
        </Line>
        <Line label="Amount">
          <Money amount={payment.amount} weight="semibold" />
        </Line>
        <Line label="Paid to">
          <span className="break-words">{payment.recipientName}</span>
          <span className="text-text-muted block text-xs">
            {BENEFIT_RECIPIENT_KIND_LABELS[payment.recipientKind]}
            {payment.recipientBeneficiaryNumber === null
              ? ''
              : ` · ${payment.recipientBeneficiaryNumber}`}
          </span>
        </Line>
        <Line label="Method">
          {PAYMENT_METHOD_LABELS[payment.paymentMethod]}
          {payment.externalReference === null ? null : (
            <span className="text-text-muted block font-mono text-xs">
              {payment.externalReference}
            </span>
          )}
        </Line>
        <Line label="Value date">
          <DateValue value={payment.valueDate} />
          <span className="text-text-muted block text-xs">by {payment.paidByLabel}</span>
        </Line>
        <Line label="Posted to">
          <span className="font-mono">{payment.expenseAccountCode}</span>{' '}
          {payment.expenseAccountName}
          <span className="text-text-muted block text-xs">
            against <span className="font-mono">{payment.cashAccountCode}</span>{' '}
            {payment.cashAccountName}
          </span>
        </Line>
      </dl>

      {payment.reversedAt === null ? null : (
        <Alert tone="danger" className="mt-4" title="Reversed">
          {payment.reversalReason ?? 'No reason was recorded.'}{' '}
          <span className="block">
            Reversed by {payment.reversedByLabel ?? 'an archived account'}. The original
            entry and its contra are both on the ledger — a ledger is not editable, so a
            reversal is an entry rather than a deletion.
          </span>
        </Alert>
      )}

      {canReverse && payment.isLive ? (
        reversing ? (
          <form
            action={submit}
            className="border-border mt-4 min-w-0 space-y-3 rounded-lg border p-3"
          >
            <input type="hidden" name="paymentId" value={payment.id} />

            {result?.ok === false ? <Alert tone="danger">{result.message}</Alert> : null}

            <Field
              label="Why is this payment being reversed?"
              name="reason"
              type="text"
              required
              autoFocus
              error={result?.fieldErrors?.reason?.[0]}
              hint="It stays on the record beside both journal entries. The claim becomes terminally reversed — it cannot be paid again without a new claim."
            />

            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="danger" disabled={pending}>
                {pending ? 'Reversing…' : 'Reverse this payment'}
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={pending}
                onClick={() => {
                  setReversing(false);
                }}
              >
                Never mind
              </Button>
            </div>
          </form>
        ) : (
          <div className="mt-4">
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setReversing(true);
              }}
            >
              Reverse this payment
            </Button>
          </div>
        )
      ) : null}
    </Card>
  );
}

function Line({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-text-muted text-xs">{label}</dt>
      <dd className="text-text mt-0.5 text-sm">{children}</dd>
    </div>
  );
}
