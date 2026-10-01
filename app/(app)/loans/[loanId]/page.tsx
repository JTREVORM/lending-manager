import Link from 'next/link';
import { notFound } from 'next/navigation';

import { LoanBreakdownTable } from '@/components/loans/loan-breakdown-table';
import { LoanLifecyclePanel } from '@/components/loans/loan-lifecycle-panel';
import { LoanStatusBadge } from '@/components/loans/loan-status-badge';
import { Alert } from '@/components/ui/alert';
import { Card } from '@/components/ui/card';
import { ROUTES } from '@/config/app';
import { contextCan } from '@/lib/auth/context';
import { guardPermission } from '@/lib/auth/guard';
import {
  getLoan,
  getLoanClientSnapshot,
  getLoanGuarantorSnapshots,
  getLoanIdentitySnapshots,
  getLoanPeriods,
  loanApprovalFailures,
} from '@/lib/data/loans';
import {
  LOAN_STATUS_DESCRIPTIONS,
  assertLoanInvariants,
  calculationFromPeriods,
  termsAreEditable,
} from '@/lib/domain/loan';
import { formatCalendarDate, formatRecordedDate, maskNin } from '@/lib/domain/client';
import { formatUgx, toUgx } from '@/lib/domain/money';
import { formatBps, toBps } from '@/lib/domain/rate';
import { formatUgandanPhoneLocal } from '@/lib/domain/phone';

export const metadata = { title: 'Loan' };

/**
 * One loan.
 *
 * ## What a given viewer sees
 *
 * Assembled from what the caller may actually read, and each absence is a
 * database decision rather than a conditional here: the identity snapshots
 * come back empty for anyone without `loans:view_sensitive`, so the page says
 * they are restricted rather than pretending there are none.
 *
 * ## The stored breakdown is checked, not trusted
 *
 * The periods are read from `loan_periods` and passed through
 * `assertLoanInvariants` before being displayed. If a stored breakdown ever
 * failed to conserve the principal, this page would say so loudly rather than
 * rendering a plausible-looking table of wrong figures. The cost is a handful
 * of additions; the alternative is a borrower being shown a corrupt
 * contractual total.
 *
 * A missing loan and an unauthorised one both render the same not-found page:
 * distinguishing them would confirm a loan exists to somebody who may not see
 * it.
 */
export default async function LoanDetailPage({
  params,
}: {
  readonly params: Promise<{ readonly loanId: string }>;
}) {
  const { loanId } = await params;
  const context = await guardPermission(`${ROUTES.loans}/${loanId}`, 'loans:view');

  const loan = await getLoan(loanId);

  if (loan === null) notFound();

  const canSeeSensitive = contextCan(context, 'loans:view_sensitive');

  const [periods, clientSnapshot, guarantorSnapshots, identitySnapshots, failures] =
    await Promise.all([
      getLoanPeriods(loanId),
      getLoanClientSnapshot(loanId),
      getLoanGuarantorSnapshots(loanId),
      canSeeSensitive ? getLoanIdentitySnapshots(loanId) : Promise.resolve([]),
      // Only worth asking while a decision is outstanding.
      loan.status === 'draft' || loan.status === 'pending_approval'
        ? loanApprovalFailures(loanId)
        : Promise.resolve([]),
    ]);

  // The stored figures, verified before they are shown.
  let breakdownProblem: string | null = null;

  if (periods.length > 0) {
    try {
      assertLoanInvariants(calculationFromPeriods(periods, loan.interestRateBps));
    } catch (error) {
      breakdownProblem =
        error instanceof Error ? error.message : 'The stored breakdown is inconsistent.';
    }
  }

  const ninFor = (subjectId: string): string | null =>
    identitySnapshots.find((snapshot) => snapshot.subjectId === subjectId)?.nin ?? null;

  return (
    <div className="min-w-0 space-y-6">
      <div className="min-w-0">
        <Link
          href={ROUTES.loans}
          className="text-accent focus-visible:outline-accent text-sm underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          ← Loans
        </Link>

        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-text text-2xl font-semibold break-words">
              {loan.clientName}
            </h1>
            <p className="text-text-muted font-mono">{loan.loanNumber}</p>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <LoanStatusBadge status={loan.status} />
            {termsAreEditable(loan.status) &&
            contextCan(context, 'loans:update_draft') ? (
              <Link
                href={`${ROUTES.loans}/${loan.id}/edit`}
                className="border-border text-text focus-visible:outline-accent inline-flex min-h-11 items-center justify-center rounded-lg border px-4 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2"
              >
                Edit draft
              </Link>
            ) : null}
          </div>
        </div>

        <p className="text-text-muted mt-2 text-sm">
          {LOAN_STATUS_DESCRIPTIONS[loan.status]}
        </p>
      </div>

      {breakdownProblem !== null ? (
        <Alert tone="danger">
          <span className="font-medium">
            This loan&rsquo;s stored calculation is inconsistent and should not be relied
            on.
          </span>{' '}
          {breakdownProblem} Report this to your administrator before collecting anything
          against it.
        </Alert>
      ) : null}

      {loan.status === 'cancelled' ? (
        <Alert tone="danger">
          <span className="font-medium">Cancelled.</span>{' '}
          {loan.cancellationReason ?? 'No reason was recorded.'}
          {loan.cancelledAt !== null ? ` (${formatRecordedDate(loan.cancelledAt)})` : ''}
        </Alert>
      ) : null}

      {loan.status === 'draft' && loan.reviewNote !== null ? (
        <Alert tone="warning">
          <span className="font-medium">Returned for correction:</span> {loan.reviewNote}
        </Alert>
      ) : null}

      {/* --- Terms -------------------------------------------------------- */}
      <section aria-labelledby="terms-heading" className="min-w-0 space-y-3">
        <h2 id="terms-heading" className="text-text text-lg font-semibold">
          {termsAreEditable(loan.status) ? 'Proposed terms' : 'Agreed terms'}
        </h2>

        <Card>
          <dl className="grid min-w-0 gap-4 sm:grid-cols-2">
            <Detail label="Principal">
              <span className="tabular-nums">
                {formatUgx(toUgx(loan.principalAmount))}
              </span>
            </Detail>
            <Detail label="Monthly interest rate">
              {loan.status === 'draft'
                ? `${formatBps(toBps(loan.interestRateBps))} (set at approval)`
                : formatBps(toBps(loan.interestRateBps))}
            </Detail>
            <Detail label="Period">
              {String(loan.loanTermMonths)}{' '}
              {loan.loanTermMonths === 1 ? 'month' : 'months'}
            </Detail>
            <Detail label="Interest method">Reducing balance, monthly</Detail>
            <Detail label="Repayment frequency">{loan.repaymentFrequency}</Detail>
            <Detail label="Intended disbursement">
              {formatCalendarDate(loan.proposedDisbursementDate)}
            </Detail>

            {loan.status !== 'draft' ? (
              <>
                <Detail label="Total interest">
                  <span className="tabular-nums">
                    {formatUgx(toUgx(loan.totalInterest))}
                  </span>
                </Detail>
                <Detail label="Total repayable">
                  <span className="font-semibold tabular-nums">
                    {formatUgx(toUgx(loan.totalExpectedRepayment))}
                  </span>
                </Detail>
              </>
            ) : null}

            {loan.submittedAt !== null ? (
              <Detail label="Submitted">{formatRecordedDate(loan.submittedAt)}</Detail>
            ) : null}
            {loan.approvedAt !== null ? (
              <Detail label="Approved">{formatRecordedDate(loan.approvedAt)}</Detail>
            ) : null}
            {loan.disbursedAt !== null ? (
              <Detail label="Disbursed">{formatRecordedDate(loan.disbursedAt)}</Detail>
            ) : null}

            {loan.notes !== null ? (
              <div className="min-w-0 sm:col-span-2">
                <dt className="text-text-muted text-sm">Notes</dt>
                <dd className="text-text mt-1 break-words whitespace-pre-wrap">
                  {loan.notes}
                </dd>
              </div>
            ) : null}
          </dl>
        </Card>

        {loan.status !== 'draft' ? (
          <p className="text-text-muted text-sm">
            Grace period {String(loan.gracePeriodDaysApplied)} days and penalty rate{' '}
            {formatBps(toBps(loan.penaltyRateBpsApplied))} were recorded with this loan
            and apply to it regardless of later changes to settings.
          </p>
        ) : null}
      </section>

      {/* --- Calculation -------------------------------------------------- */}
      <section aria-labelledby="calculation-heading" className="min-w-0 space-y-3">
        <h2 id="calculation-heading" className="text-text text-lg font-semibold">
          Monthly breakdown
        </h2>

        <LoanBreakdownTable
          periods={periods}
          principal={loan.principalAmount}
          totalInterest={loan.totalInterest}
          totalExpected={loan.totalExpectedRepayment}
        />

        {periods.length > 0 ? (
          <p className="text-text-muted text-sm">
            This is the contractual monthly breakdown. The individual collection dates are
            generated in a later phase.
          </p>
        ) : null}
      </section>

      {/* --- Snapshots ---------------------------------------------------- */}
      {clientSnapshot !== null ? (
        <section aria-labelledby="client-snapshot-heading" className="min-w-0 space-y-3">
          <h2 id="client-snapshot-heading" className="text-text text-lg font-semibold">
            Borrower, as recorded at approval
          </h2>
          <p className="text-text-muted text-sm">
            Captured {formatRecordedDate(clientSnapshot.capturedAt)}. Later changes to the
            client&rsquo;s profile do not alter this.
          </p>

          <Card>
            <dl className="grid min-w-0 gap-4 sm:grid-cols-2">
              <Detail label="Name">{clientSnapshot.fullName}</Detail>
              <Detail label="Client number">
                <span className="font-mono">{clientSnapshot.clientNumber}</span>
              </Detail>
              <Detail label="Phone">
                {formatUgandanPhoneLocal(clientSnapshot.phone)}
              </Detail>
              <Detail label="Occupation">{clientSnapshot.occupation}</Detail>
              <Detail label="Location">
                {clientSnapshot.villageArea}, {clientSnapshot.district}
              </Detail>
              <Detail label="Status at approval">
                {clientSnapshot.clientStatusAtOrigination}
              </Detail>
              <Detail label="Identification">
                {!canSeeSensitive ? (
                  <span className="text-text-muted">
                    Restricted. You do not have permission to view this.
                  </span>
                ) : ninFor(clientSnapshot.clientId) === null ? (
                  '—'
                ) : (
                  <details className="min-w-0">
                    <summary className="text-text min-h-11 cursor-pointer font-mono">
                      {maskNin(ninFor(clientSnapshot.clientId) ?? '')}
                      <span className="text-accent ml-2 font-sans text-sm">Show</span>
                    </summary>
                    <span className="text-text font-mono break-all">
                      {ninFor(clientSnapshot.clientId)}
                    </span>
                  </details>
                )}
              </Detail>
            </dl>
          </Card>
        </section>
      ) : null}

      {guarantorSnapshots.length > 0 ? (
        <section
          aria-labelledby="guarantor-snapshot-heading"
          className="min-w-0 space-y-3"
        >
          <h2 id="guarantor-snapshot-heading" className="text-text text-lg font-semibold">
            Guarantors, as recorded at approval
          </h2>

          <ul className="space-y-3">
            {guarantorSnapshots.map((guarantor) => (
              <li
                key={guarantor.id}
                className="border-border bg-surface min-w-0 rounded-xl border p-4"
              >
                <p className="text-text font-medium break-words">{guarantor.fullName}</p>
                <dl className="mt-2 grid min-w-0 gap-3 text-sm sm:grid-cols-2">
                  <Detail label="Relationship">{guarantor.relationshipToClient}</Detail>
                  <Detail label="Phone">
                    {formatUgandanPhoneLocal(guarantor.phone)}
                  </Detail>
                  <Detail label="Occupation">{guarantor.occupation}</Detail>
                  <Detail label="Location">
                    {guarantor.location}
                    {guarantor.district === null ? '' : `, ${guarantor.district}`}
                  </Detail>
                  <Detail label="Photograph on file">
                    {guarantor.hadPhotograph ? 'Yes' : 'No'}
                  </Detail>
                  <Detail label="Identification">
                    {!canSeeSensitive ? (
                      <span className="text-text-muted">Restricted.</span>
                    ) : ninFor(guarantor.guarantorId) === null ? (
                      '—'
                    ) : (
                      <span className="text-text font-mono">
                        {maskNin(ninFor(guarantor.guarantorId) ?? '')}
                      </span>
                    )}
                  </Detail>
                </dl>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* --- Lifecycle ---------------------------------------------------- */}
      <section aria-labelledby="lifecycle-heading" className="min-w-0 space-y-3">
        <h2 id="lifecycle-heading" className="text-text text-lg font-semibold">
          Next step
        </h2>

        <LoanLifecyclePanel
          loanId={loan.id}
          loanNumber={loan.loanNumber}
          status={loan.status}
          clientName={loan.clientName}
          principal={loan.principalAmount}
          totalExpected={loan.totalExpectedRepayment}
          proposedDate={formatCalendarDate(loan.proposedDisbursementDate)}
          approvalFailures={failures}
          capabilities={{
            canSubmit: contextCan(context, 'loans:submit'),
            canApprove: contextCan(context, 'loans:approve'),
            canDisburse: contextCan(context, 'loans:disburse'),
            canCancel: contextCan(context, 'loans:cancel'),
          }}
        />
      </section>

      {/* Repayments are a later phase. No placeholder section: an empty
          "Repayments" heading would read as "this loan has no repayments",
          which is not a statement this system can currently make. */}
    </div>
  );
}

function Detail({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-text-muted text-sm">{label}</dt>
      <dd className="text-text mt-0.5 break-words">{children}</dd>
    </div>
  );
}
