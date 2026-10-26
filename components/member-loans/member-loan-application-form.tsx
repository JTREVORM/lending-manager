'use client';

import { useActionState, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Money } from '@/components/ui/money';
import { ROUTES } from '@/config/app';
import { formatUgx, parseUgx } from '@/lib/domain/money';
import { formatBps, toBps } from '@/lib/domain/rate';
import {
  MEMBER_INTEREST_BASIS_LABELS,
  MEMBER_INTEREST_METHOD_LABELS,
} from '@/lib/domain/membership';
import {
  quoteMemberLoan,
  requiredMemberCadence,
  type MemberLoanEligibility,
} from '@/lib/domain/member-loan';
import {
  createMemberLoanApplicationAction,
  type MemberLoanActionResult,
} from '@/lib/member-loans/actions';
import type { MemberLendingState } from '@/lib/data/member-loans';
import { MemberLoanRepaymentPreview } from './repayment-preview';

/**
 * A member-loan application.
 *
 * ## Every figure here is recomputed by the server
 *
 * The preview below prices the loan in the browser, from the policy terms this
 * page was rendered with. That is a **preview**. `approve_loan` reads the
 * borrower's own frozen policy version, prices from it, re-derives the
 * eligibility assessment from the loan's own figures and refuses if anything
 * moved — another deposit, a withdrawal, a suspension, a policy published.
 *
 * So nothing here is trusted. It exists so the person at the counter can tell
 * the member what the loan will cost before committing them to it, not so the
 * browser decides anything.
 *
 * ## The ceiling is shown and enforced in three places, on purpose
 *
 * The field's `max`, the live warning beneath it, and the refusal at approval.
 * The first two are courtesies; the third is the control. A form that only
 * showed the ceiling would be defeated by a POST, which is why the member
 * rules live inside `validate_loan_for_approval`.
 *
 * ## The cadence is derived, not chosen
 *
 * Weekly up to the policy's weekly boundary and calendar-monthly beyond it is
 * a confirmed rule, so the field is read-only and the sentence beside it says
 * why. Letting somebody pick would be offering a choice the approval would
 * then refuse — and where the monthly convention is still undecided, the form
 * says *that* rather than offering a cadence that cannot be scheduled.
 */
export function MemberLoanApplicationForm({
  eligibility,
  lending,
  businessDate,
}: {
  readonly eligibility: MemberLoanEligibility;
  readonly lending: MemberLendingState;
  readonly businessDate: string;
}) {
  const router = useRouter();

  const [state, formAction, pending] = useActionState<
    MemberLoanActionResult | undefined,
    FormData
  >(async (previous, formData) => {
    const result = await createMemberLoanApplicationAction(previous, formData);

    if (result.ok && result.loanId !== undefined) {
      router.push(`${ROUTES.loans}/${result.loanId}`);
    }

    return result;
  }, undefined);

  const maxTerm = lending.maxTermMonths ?? 1;
  const weeklyBoundary = lending.weeklyCadenceMaxMonths ?? 0;

  const [amountText, setAmountText] = useState('');
  const [termMonths, setTermMonths] = useState(1);

  const amount = useMemo(() => {
    try {
      return parseUgx(amountText);
    } catch {
      return null;
    }
  }, [amountText]);

  const cadence = requiredMemberCadence(termMonths, weeklyBoundary);

  // The cadence the term requires may be one the business has not opened yet.
  // Said here rather than discovered at approval.
  const cadenceUnavailable = cadence === 'monthly' && !lending.monthlyCadenceOpen;

  const quote = useMemo(() => {
    if (amount === null || amount <= 0) return null;
    if (lending.interestRateBps === null) return null;

    return quoteMemberLoan({
      principal: amount,
      interestRateBps: lending.interestRateBps,
      termMonths,
      interestBasis: lending.interestBasis,
      interestMethod: lending.interestMethod,
    });
  }, [amount, termMonths, lending]);

  const ceiling = eligibility.maxEligibleLoan;
  const overCeiling = ceiling !== null && amount !== null && amount > ceiling;

  return (
    <div className="min-w-0 space-y-6">
      {/* --- Who this is for, and what the business relied on -------------- */}
      <Card>
        <h2 className="text-text text-sm font-semibold">The member</h2>
        <dl className="mt-3 grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Figure label="Membership number">
            <span className="text-text font-mono text-sm">
              {eligibility.membershipNumber ?? '—'}
            </span>
          </Figure>
          <Figure
            label="Qualifying months"
            hint={`${String(eligibility.monthsRequired ?? 0)} required`}
          >
            <span className="text-text text-lg font-semibold tabular-nums">
              {eligibility.qualifyingMonths ?? 0}
            </span>
          </Figure>
          <Figure
            label="Available to secure a loan"
            hint="Balance less what is pledged and awaiting payment"
          >
            <Money amount={eligibility.availableSavings} weight="semibold" />
          </Figure>
          <Figure
            label="Maximum loan"
            hint={
              ceiling === null
                ? 'The savings multiplier is undecided, so no ceiling can be shown'
                : `Policy version ${eligibility.policyVersion ?? '—'}, assessed ${eligibility.asOf}`
            }
          >
            <Money amount={ceiling} weight="semibold" placeholder="Not yet decided" />
          </Figure>
        </dl>
      </Card>

      {/* --- The form ----------------------------------------------------- */}
      <form action={formAction} className="min-w-0 space-y-6" noValidate>
        <input type="hidden" name="clientId" value={eligibility.clientId} />
        <input type="hidden" name="repaymentFrequency" value={cadence} />

        {state !== undefined && !state.ok ? (
          <Alert tone="danger" title="This application was not opened">
            <div className="min-w-0 space-y-2">
              <p>{state.message}</p>
              {state.blockingReasons !== undefined && state.blockingReasons.length > 0 ? (
                <ul className="min-w-0 list-disc space-y-1 pl-5">
                  {state.blockingReasons.map((reason) => (
                    <li key={reason} className="min-w-0 break-words">
                      {reason}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </Alert>
        ) : null}

        <Card>
          <h2 className="text-text text-sm font-semibold">
            What the member is asking for
          </h2>

          <div className="mt-4 grid min-w-0 gap-4 sm:grid-cols-2">
            <Field
              label="Amount applied for"
              name="amount"
              inputMode="numeric"
              autoComplete="off"
              required
              value={amountText}
              onChange={(event) => setAmountText(event.target.value)}
              hint={
                ceiling === null
                  ? 'Whole shillings. No ceiling can be checked until the savings multiplier is decided.'
                  : `Whole shillings, up to ${formatUgx(ceiling)}.`
              }
              error={state?.fieldErrors?.amount?.[0]}
            />

            <div className="min-w-0">
              <label
                htmlFor="member-loan-term"
                className="text-text block text-sm font-medium"
              >
                Loan term
              </label>
              <select
                id="member-loan-term"
                name="termMonths"
                value={termMonths}
                onChange={(event) => setTermMonths(Number(event.target.value))}
                className="border-border bg-surface text-text focus-visible:outline-accent mt-1.5 w-full rounded-lg border px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2"
              >
                {Array.from({ length: maxTerm }, (_, index) => index + 1).map(
                  (months) => (
                    <option key={months} value={months}>
                      {months} {months === 1 ? 'month' : 'months'}
                    </option>
                  ),
                )}
              </select>
              <p className="text-text-muted mt-1.5 text-xs">
                A member loan runs for at most {maxTerm}{' '}
                {maxTerm === 1 ? 'month' : 'months'}, which the membership programme sets.
              </p>
            </div>

            <div className="min-w-0">
              <p className="text-text block text-sm font-medium">Collection cadence</p>
              <p className="text-text mt-1.5 text-sm font-semibold">
                {cadence === 'weekly' ? 'Weekly' : 'Monthly (calendar)'}
              </p>
              <p className="text-text-muted mt-1.5 text-xs">
                Weekly up to {weeklyBoundary} {weeklyBoundary === 1 ? 'month' : 'months'}{' '}
                and calendar-monthly beyond it, which the programme sets. Not a choice: an
                approval would refuse any other cadence for this term.
              </p>
            </div>

            <Field
              label="Proposed disbursement date"
              name="proposedDisbursementDate"
              type="date"
              required
              defaultValue={businessDate}
              hint="A plan. The repayment schedule is anchored on the day the money actually reaches the member."
              error={state?.fieldErrors?.proposedDisbursementDate?.[0]}
            />

            <Field
              label="Purpose"
              name="purpose"
              autoComplete="off"
              hint="Optional. What the member says the money is for."
              error={state?.fieldErrors?.purpose?.[0]}
              className="sm:col-span-2"
            />
          </div>

          {overCeiling ? (
            <div className="mt-4">
              <Alert tone="warning" title="Above what this member's savings support">
                <Money amount={amount} /> is more than the <Money amount={ceiling} /> this
                member&rsquo;s available savings support. An application can be opened,
                and the approval will be refused — so lowering the amount now saves the
                member a wasted trip.
              </Alert>
            </div>
          ) : null}

          {cadenceUnavailable ? (
            <div className="mt-4">
              <Alert tone="warning" title="A loan of this length cannot be scheduled yet">
                A {termMonths}-month member loan is collected calendar-monthly, and what a
                monthly collection does in a month that has no such day has not been
                decided. Until it is, a loan of {weeklyBoundary + 1} months or more cannot
                be approved. A loan of {weeklyBoundary}{' '}
                {weeklyBoundary === 1 ? 'month' : 'months'} or less collects weekly and is
                unaffected.
              </Alert>
            </div>
          ) : null}
        </Card>

        {/* --- The price ---------------------------------------------------- */}
        <Card>
          <h2 className="text-text text-sm font-semibold">What it would cost</h2>

          <dl className="mt-3 grid min-w-0 gap-4 sm:grid-cols-3">
            <Figure
              label="Member interest rate"
              hint="Confirmed in the programme documents"
            >
              <span className="text-text text-lg font-semibold tabular-nums">
                {lending.interestRateBps === null
                  ? '—'
                  : formatBps(toBps(lending.interestRateBps))}
              </span>
            </Figure>
            <Figure label="Charged">
              <span className="text-text text-sm font-semibold">
                {lending.interestBasis === null
                  ? 'Not yet decided'
                  : MEMBER_INTEREST_BASIS_LABELS[lending.interestBasis]}
              </span>
            </Figure>
            <Figure label="Method">
              <span className="text-text text-sm font-semibold">
                {lending.interestMethod === null
                  ? 'Not yet decided'
                  : MEMBER_INTEREST_METHOD_LABELS[lending.interestMethod]}
              </span>
            </Figure>
          </dl>

          <div className="mt-4">
            {quote === null ? (
              <p className="text-text-muted text-sm">
                Enter an amount to see the repayment schedule.
              </p>
            ) : quote.priced && quote.calculation !== null ? (
              <MemberLoanRepaymentPreview
                calculation={quote.calculation}
                cadence={cadence}
              />
            ) : (
              <Alert tone="info" title="This loan cannot be priced yet">
                {quote.blockedReason}
              </Alert>
            )}
          </div>
        </Card>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={pending}>
            {pending ? 'Opening the application…' : 'Open the application'}
          </Button>
          <p className="text-text-muted text-xs">
            This opens a <span className="font-medium">draft</span>. Submitting it for
            approval, approving it and paying it out are the same steps every loan goes
            through.
          </p>
        </div>
      </form>
    </div>
  );
}

function Figure({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-text-muted text-xs">{label}</dt>
      <dd className="text-text mt-0.5">{children}</dd>
      {hint === undefined ? null : (
        <dd className="text-text-muted mt-0.5 text-xs">{hint}</dd>
      )}
    </div>
  );
}
