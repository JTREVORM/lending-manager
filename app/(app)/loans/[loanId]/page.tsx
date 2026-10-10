import { Banknote } from 'lucide-react';

import Link from 'next/link';
import { notFound } from 'next/navigation';

import { LoanBreakdownTable } from '@/components/loans/loan-breakdown-table';
import { LoanCollateralPanel } from '@/components/loans/loan-collateral-panel';
import { LoanGuaranteePanel } from '@/components/loans/loan-guarantee-panel';
import { LoanLifecyclePanel } from '@/components/loans/loan-lifecycle-panel';
import { LoanRecoveryPanel } from '@/components/loans/loan-recovery-panel';
import { LoanStatusBadge } from '@/components/loans/loan-status-badge';
import { RepaymentScheduleTable } from '@/components/loans/repayment-schedule-table';
import { SectionTabs } from '@/components/ui/section-tabs';
import { ScheduleSummary } from '@/components/loans/schedule-summary';
import { Alert } from '@/components/ui/alert';
import { Card } from '@/components/ui/card';
import { ROUTES } from '@/config/app';
import { contextCan } from '@/lib/auth/context';
import { guardPermission } from '@/lib/auth/guard';
import {
  getLoan,
  getLoanClientSnapshot,
  getLoanIdentitySnapshots,
  getLoanPeriods,
  loanApprovalFailures,
} from '@/lib/data/loans';
import {
  getLoanApplicationProfile,
  getLoanDocuments,
  getLoanGuarantorEvidence,
  getLoanGuarantors,
} from '@/lib/data/loan-application';
import {
  BusinessDetailsSummary,
  SalaryDetailsSummary,
} from '@/components/loans/application-details-form';
import {
  LOAN_CLOSURE_DESCRIPTIONS,
  LOAN_CLOSURE_LABELS,
  LOAN_STATUS_DESCRIPTIONS,
  assertLoanInvariants,
  calculationFromPeriods,
  termsAreEditable,
} from '@/lib/domain/loan';
import { LOAN_DOCUMENT_LABELS } from '@/lib/validation/loan-application';
import { getLoanSchedule, verifyStoredSchedule } from '@/lib/data/schedules';
import { getLoanPosition, listLoanPayments } from '@/lib/data/payments';
import { PaymentRegister } from '@/components/payments/payment-register';
import { LoanBalanceSummary } from '@/components/payments/loan-balance-summary';
import { DelinquencyPanel } from '@/components/delinquency/delinquency-panel';
import { PenaltyCard } from '@/components/delinquency/penalty-card';
import { Money } from '@/components/ui/money';
import { getLoanDelinquency, getLoanPenalty } from '@/lib/data/delinquency';
import {
  getLoanRecoveryStatus,
  listLoanCollateral,
  listLoanGuaranteeExposure,
  listLoanRecoveryActions,
} from '@/lib/data/security';
import { getCompanyBranding } from '@/lib/data/company';
import { businessToday } from '@/lib/domain/datetime';
import { formatCalendarDate, formatRecordedDate, maskNin } from '@/lib/domain/client';
import { toUgx } from '@/lib/domain/money';
import { formatBps, toBps } from '@/lib/domain/rate';
import { PhoneValue } from '@/components/ui/data-value';
import { ActionLink, PageHeader } from '@/components/ui/page-header';

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

  const canSeeSchedule = contextCan(context, 'schedules:view');
  const canSeePayments = contextCan(context, 'payments:view');
  const today = businessToday();

  const [
    periods,
    clientSnapshot,
    guarantorSnapshots,
    identitySnapshots,
    failures,
    schedule,
    applicationProfile,
    loanGuarantors,
    documents,
  ] = await Promise.all([
    getLoanPeriods(loanId),
    getLoanClientSnapshot(loanId),
    // Phase 13. `loan_guarantor_evidence` presents both eras as one list: the
    // loans approved from this phase onward carry their evidence on
    // `loan_guarantors`, the ones before it in `loan_guarantor_snapshots`. A
    // reader never has to know which era a loan is from.
    getLoanGuarantorEvidence(loanId),
    canSeeSensitive ? getLoanIdentitySnapshots(loanId) : Promise.resolve([]),
    // Only worth asking while a decision is outstanding.
    loan.status === 'draft' || loan.status === 'pending_approval'
      ? loanApprovalFailures(loanId)
      : Promise.resolve([]),
    // A schedule exists only once the money has moved, so asking before
    // disbursement would always come back empty. The policy would refuse a
    // caller without the capability anyway; not asking keeps the intent
    // visible here as well.
    canSeeSchedule && loan.status !== 'draft' && loan.status !== 'pending_approval'
      ? getLoanSchedule(loanId, loan.totalExpectedRepayment)
      : Promise.resolve(null),
    getLoanApplicationProfile(loanId),
    // The live guarantor rows, which is what a loan not yet approved has —
    // the evidence above is frozen at approval and is empty until then.
    getLoanGuarantors(loanId),
    getLoanDocuments(loanId),
  ]);

  // Phase 6. A balance exists only once there is a schedule to owe against, so
  // a draft or an approved loan has none — which is a different thing from
  // owing zero.
  // Phase 7. The delinquency position and any penalty, both derived in the
  // database under this reader's own policies. Read behind their own
  // capabilities rather than the payment one: somebody who may see a balance
  // is not automatically somebody who may see the collections view.
  const [position, payments, companyBranding, delinquency, penalty] = await Promise.all([
    canSeePayments ? getLoanPosition(loanId, today) : Promise.resolve(null),
    canSeePayments ? listLoanPayments(loanId) : Promise.resolve([]),
    getCompanyBranding(),
    contextCan(context, 'delinquency:view')
      ? getLoanDelinquency(loanId)
      : Promise.resolve(null),
    contextCan(context, 'penalties:view')
      ? getLoanPenalty(loanId)
      : Promise.resolve(null),
  ]);

  // Phase 14. Security, the guarantees with their exposure, and the chase.
  //
  // Each behind its own capability rather than the loan one: somebody who may
  // read a loan is not automatically somebody who may read what a collections
  // officer wrote about its borrower, and a business that wants the second
  // restricted should get that from the capability rather than from a screen
  // remembering to hide a section.
  //
  // Recovery is asked for only once money has gone out. A draft has nothing to
  // recover by definition, and the insert trigger refuses one, so asking would
  // be a round trip whose answer is always empty.
  const canSeeCollateral = contextCan(context, 'collateral:view');
  const canSeeRecovery = contextCan(context, 'recovery:view');
  const isDisbursed = !['draft', 'pending_approval', 'approved', 'cancelled'].includes(
    loan.status,
  );

  const [collateral, guarantees, recoveryStatus, recoveryActions] = await Promise.all([
    canSeeCollateral ? listLoanCollateral(loanId) : Promise.resolve([]),
    contextCan(context, 'guarantors:view')
      ? listLoanGuaranteeExposure(loanId)
      : Promise.resolve([]),
    canSeeRecovery && isDisbursed ? getLoanRecoveryStatus(loanId) : Promise.resolve(null),
    canSeeRecovery && isDisbursed ? listLoanRecoveryActions(loanId) : Promise.resolve([]),
  ]);

  // The stored schedule, verified before it is shown, on the same reasoning as
  // the breakdown below: a corrupt collection plan should announce itself
  // rather than render as a plausible table of wrong dates and amounts.
  const scheduleProblem = schedule === null ? null : await verifyStoredSchedule(loanId);

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

  /**
   * The identification recorded for a guarantor, whichever kind they are.
   *
   * Phase 13 made a guarantor either an external person or an existing client,
   * and `loan_identity_snapshots` records both under their own subject type —
   * so the lookup is by whichever id the row actually carries.
   */
  const ninForSubject = (guarantor: {
    readonly guarantorId: string | null;
    readonly guarantorClientId: string | null;
  }): string | null => {
    const subjectId = guarantor.guarantorId ?? guarantor.guarantorClientId;
    return subjectId === null ? null : ninFor(subjectId);
  };

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Lending Portfolio"
        icon={Banknote}
        back={{ href: ROUTES.loans, label: 'Loans' }}
        title={loan.clientName}
        status={<LoanStatusBadge status={loan.status} />}
        description={
          <>
            <span className="font-mono">{loan.loanNumber}</span>
            <span className="mt-1.5 block">{LOAN_STATUS_DESCRIPTIONS[loan.status]}</span>
          </>
        }
        secondaryActions={
          <>
            {/* Phase 8. A statement is a rendering of this loan, so it needs no
                capability beyond the one that opened this page — and it is the
                document staff print for a borrower who asks where they stand.
                Only offered once the loan has a schedule to state. */}
            {loan.status === 'active' || loan.status === 'cleared' ? (
              <ActionLink
                href={`${ROUTES.loans}/${loan.id}/statement`}
                variant="secondary"
              >
                Statement
              </ActionLink>
            ) : null}
            {/* Phase 13. The application — the product's own questions, the
                guarantors, the documents — is its own screen, because "where
                does this loan stand" and "what did the business collect before
                it agreed" are different jobs done at different times. */}
            <ActionLink
              href={`${ROUTES.loans}/${loan.id}/application`}
              variant="secondary"
            >
              Application
            </ActionLink>
            {termsAreEditable(loan.status) &&
            contextCan(context, 'loans:update_draft') ? (
              <ActionLink href={`${ROUTES.loans}/${loan.id}/edit`} variant="secondary">
                Edit draft
              </ActionLink>
            ) : null}
          </>
        }
      />

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

      {/* Phase 13. A refusal and a withdrawal end in the same state and are
          not the same event: one is a credit decision, the other is a change
          of mind, and only the first belongs in a report about lending
          standards. The banner says which. */}
      {loan.status === 'cancelled' ? (
        <Alert tone="danger">
          <span className="font-medium">
            {loan.closureKind === null
              ? 'Cancelled.'
              : `${LOAN_CLOSURE_LABELS[loan.closureKind]}.`}
          </span>{' '}
          {loan.closureKind === null
            ? ''
            : `${LOAN_CLOSURE_DESCRIPTIONS[loan.closureKind]} `}
          {loan.cancellationReason ?? 'No reason was recorded.'}
          {loan.cancelledAt !== null ? ` (${formatRecordedDate(loan.cancelledAt)})` : ''}
        </Alert>
      ) : null}

      {loan.status === 'draft' && loan.reviewNote !== null ? (
        <Alert tone="warning">
          <span className="font-medium">Returned for correction:</span> {loan.reviewNote}
        </Alert>
      ) : null}

      {/* A jump-nav over the sections below. Every section stays in the
          document — the schedule the browser suite reads is never hidden
          behind a click — so this reads as tabs while keeping the page whole. */}
      <SectionTabs
        label="Loan sections"
        tabs={[
          { id: 'terms-heading', label: 'Overview' },
          ...(position !== null ? [{ id: 'balance-heading', label: 'Balance' }] : []),
          ...(canSeeSchedule && schedule !== null
            ? [{ id: 'schedule-heading', label: 'Schedule' }]
            : []),
          ...(canSeePayments ? [{ id: 'payments-heading', label: 'Payments' }] : []),
          ...(delinquency !== null && contextCan(context, 'delinquency:view')
            ? [{ id: 'delinquency-heading', label: 'Delinquency' }]
            : []),
          { id: 'client-snapshot-heading', label: 'Parties' },
          { id: 'guarantor-snapshot-heading', label: 'Guarantors' },
          ...(canSeeCollateral ? [{ id: 'security-heading', label: 'Security' }] : []),
          ...(canSeeRecovery && isDisbursed
            ? [{ id: 'recovery-heading', label: 'Recovery' }]
            : []),
          ...(documents.length > 0
            ? [{ id: 'documents-heading', label: 'Documents' }]
            : []),
          { id: 'lifecycle-heading', label: 'History' },
        ]}
      />

      {/* --- Terms -------------------------------------------------------- */}
      <section aria-labelledby="terms-heading" className="min-w-0 space-y-3">
        <h2 id="terms-heading" className="text-text text-lg font-semibold">
          {termsAreEditable(loan.status) ? 'Proposed terms' : 'Agreed terms'}
        </h2>

        <Card>
          <dl className="grid min-w-0 gap-4 sm:grid-cols-2">
            <Detail label="Loan product">
              {loan.productName}
              <span className="text-text-muted ml-2 font-mono text-sm">
                {loan.productCode}
              </span>
            </Detail>
            <Detail label="Principal">
              <span className="tabular-nums">
                <Money amount={toUgx(loan.principalAmount)} />
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
                    <Money amount={toUgx(loan.totalInterest)} />
                  </span>
                </Detail>
                <Detail label="Total repayable">
                  <span className="font-semibold tabular-nums">
                    <Money amount={toUgx(loan.totalExpectedRepayment)} />
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
            This is the contractual monthly breakdown — what falls due in each month of
            the agreement. The individual collection dates below allocate it; they do not
            change it.
          </p>
        ) : null}
      </section>

      {/* --- Balance ------------------------------------------------------ */}
      {position !== null ? (
        <section aria-labelledby="balance-heading" className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="balance-heading" className="text-text text-lg font-semibold">
              Balance
            </h2>

            {contextCan(context, 'payments:create') &&
            loan.status === 'active' &&
            position.totalOutstanding > 0 ? (
              <Link
                href={`${ROUTES.payments}/new?loanId=${loan.id}`}
                className="bg-accent text-accent-contrast focus-visible:outline-accent inline-flex min-h-11 shrink-0 items-center justify-center rounded-lg px-4 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2"
              >
                Record a payment
              </Link>
            ) : null}
          </div>

          <LoanBalanceSummary
            totalExpectedRepayment={position.totalExpectedRepayment}
            totalPaid={position.totalPaid}
            outstanding={position.contractualOutstanding}
            principalPaid={position.principalPaid}
            principalRemaining={position.principalRemaining}
            interestPaid={position.interestPaid}
            interestRemaining={position.interestRemaining}
            unpaidScheduledDue={position.unpaidScheduledDue}
            penaltyAssessed={position.penaltyAssessed}
            penaltyPaid={position.penaltyPaid}
            penaltyRemaining={position.penaltyRemaining}
            totalOutstanding={position.totalOutstanding}
            postedPaymentCount={position.postedPaymentCount}
            reversedPaymentCount={position.reversedPaymentCount}
            fullyRepaid={position.fullyRepaid}
            reconciles={position.reconciles}
            reconciliationProblem={position.reconciliationProblem}
          />
        </section>
      ) : null}

      {/* --- Collection position (Phase 7) -------------------------------- */}
      {delinquency !== null && contextCan(context, 'delinquency:view') ? (
        <section aria-labelledby="delinquency-heading" className="min-w-0 space-y-3">
          <h2 id="delinquency-heading" className="text-text text-lg font-semibold">
            Collection position
          </h2>

          <DelinquencyPanel position={delinquency} />

          {penalty !== null && contextCan(context, 'penalties:view') ? (
            <PenaltyCard penalty={penalty} timeZone={companyBranding.branding.timezone} />
          ) : null}
        </section>
      ) : null}

      {/* --- Payments ----------------------------------------------------- */}
      {canSeePayments && payments.length > 0 ? (
        <section aria-labelledby="payments-heading" className="min-w-0 space-y-3">
          <h2 id="payments-heading" className="text-text text-lg font-semibold">
            Payments received
          </h2>

          <PaymentRegister
            payments={payments}
            page={1}
            hasMore={false}
            timeZone={companyBranding.branding.timezone}
            showFilters={false}
          />

          <p className="text-text-muted text-sm">
            What was collected, which is a separate record from the schedule above — that
            says what is due. A reversed payment stays listed and struck through; it no
            longer counts toward the balance.
          </p>
        </section>
      ) : null}

      {/* --- Collection schedule ------------------------------------------ */}
      {canSeeSchedule && schedule !== null ? (
        <section aria-labelledby="schedule-heading" className="min-w-0 space-y-3">
          <h2 id="schedule-heading" className="text-text text-lg font-semibold">
            Collection schedule
          </h2>

          {scheduleProblem !== null ? (
            <Alert tone="danger">
              <span className="font-medium">
                This loan&rsquo;s collection schedule is inconsistent and must not be
                collected against.
              </span>{' '}
              {scheduleProblem} Report this to your administrator.
            </Alert>
          ) : null}

          <ScheduleSummary
            installmentCount={schedule.installmentCount}
            firstDueDate={schedule.firstDueDate}
            finalDueDate={schedule.finalDueDate}
            totalScheduledPrincipal={schedule.totalScheduledPrincipal}
            totalScheduledInterest={schedule.totalScheduledInterest}
            totalScheduledAmount={schedule.totalScheduledAmount}
            frequencyLabel={schedule.header.frequencyLabel}
            intervalDays={schedule.header.intervalDays}
            disbursementDate={schedule.header.disbursementDate}
            reconciles={schedule.reconciles}
          />

          <RepaymentScheduleTable
            installments={schedule.installments}
            today={businessToday()}
          />

          <p className="text-text-muted text-sm">
            Generated when the loan was disbursed, from the day the money reached the
            borrower. It is a fixed record and cannot be edited. Payments are not yet
            recorded against it, so no collection here is marked paid or missed.
          </p>
        </section>
      ) : null}

      {canSeeSchedule && schedule === null && loan.status === 'approved' ? (
        <section aria-labelledby="schedule-pending-heading" className="min-w-0 space-y-3">
          <h2 id="schedule-pending-heading" className="text-text text-lg font-semibold">
            Collection schedule
          </h2>
          <Card>
            <p className="text-text-muted text-sm">
              No schedule yet. It is generated at disbursement, from the day the money
              actually reaches the borrower — not from the intended date above, which may
              still change.
            </p>
          </Card>
        </section>
      ) : null}

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
                <PhoneValue value={clientSnapshot.phone} />
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

      {/* --- Guarantors and security --------------------------------------
          Phase 13. One section for both eras and both kinds of subject: the
          frozen evidence once a loan is past approval, the live rows while it
          is still an application. The second is what a draft has, and showing
          nothing there would read as "nobody is backing this loan" when the
          truth is "nobody has been asked yet". */}
      <section aria-labelledby="guarantor-snapshot-heading" className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="guarantor-snapshot-heading" className="text-text text-lg font-semibold">
            {guarantorSnapshots.length > 0
              ? 'Guarantors, as recorded at approval'
              : 'Guarantors'}
          </h2>

          {contextCan(context, 'guarantors:view') ? (
            <ActionLink
              href={`${ROUTES.loans}/${loan.id}/application`}
              variant="secondary"
            >
              Open the application
            </ActionLink>
          ) : null}
        </div>

        {guarantorSnapshots.length > 0 ? (
          <ul className="space-y-3">
            {guarantorSnapshots.map((guarantor) => (
              <li
                key={`${guarantor.source}-${guarantor.guarantorId ?? guarantor.guarantorClientId ?? guarantor.fullName}`}
                className="border-border bg-surface min-w-0 rounded-lg border p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <p className="text-text font-medium break-words">
                    {guarantor.fullName}
                  </p>
                  <span className="text-text-muted shrink-0 text-sm">
                    {guarantor.subjectKind === 'client'
                      ? 'Existing client'
                      : 'External guarantor'}
                  </span>
                </div>
                <dl className="mt-2 grid min-w-0 gap-3 text-sm sm:grid-cols-2">
                  <Detail label="Relationship">{guarantor.relationshipToClient}</Detail>
                  <Detail label="Phone">
                    <PhoneValue value={guarantor.phone} />
                  </Detail>
                  <Detail label="Occupation">{guarantor.occupation ?? '—'}</Detail>
                  <Detail label="Location">
                    {guarantor.location ?? '—'}
                    {guarantor.district === null ? '' : `, ${guarantor.district}`}
                  </Detail>
                  <Detail label="Photograph on file">
                    {guarantor.hadPhotograph ? 'Yes' : 'No'}
                  </Detail>
                  <Detail label="Undertaking">
                    {guarantor.consentedAt === null
                      ? 'Signed on paper, before this was recorded'
                      : `Version ${guarantor.consentVersion ?? '—'}, signed by ${guarantor.signatureName ?? '—'} and witnessed by ${guarantor.witnessName ?? '—'} on ${formatRecordedDate(guarantor.consentedAt)}`}
                  </Detail>
                  <Detail label="Identification">
                    {!canSeeSensitive ? (
                      <span className="text-text-muted">Restricted.</span>
                    ) : ninForSubject(guarantor) === null ? (
                      '—'
                    ) : (
                      <span className="text-text font-mono">
                        {maskNin(ninForSubject(guarantor) ?? '')}
                      </span>
                    )}
                  </Detail>
                </dl>
              </li>
            ))}
          </ul>
        ) : loanGuarantors.length > 0 ? (
          <Card>
            <ul className="min-w-0 space-y-3">
              {loanGuarantors.map((guarantor) => (
                <li key={guarantor.id} className="min-w-0">
                  <p className="text-text font-medium break-words">
                    {guarantor.fullName}
                    <span className="text-text-muted ml-2 font-normal">
                      {guarantor.relationshipToClient}
                    </span>
                  </p>
                  <p className="text-text-muted text-sm">
                    {guarantor.subjectKind === 'client'
                      ? 'Existing client'
                      : 'External guarantor'}
                    {' · '}
                    {guarantor.consentSigned
                      ? `undertaking signed (version ${guarantor.consentVersion ?? '—'})`
                      : 'undertaking not yet signed'}
                  </p>
                </li>
              ))}
            </ul>
            <p className="text-text-muted mt-3 text-sm">
              These are the guarantors on the application. Their details are frozen onto
              the loan when it is approved, and later changes to a guarantor&rsquo;s own
              record will not alter what is recorded here.
            </p>
          </Card>
        ) : (
          <Card>
            <p className="text-text-muted">
              No guarantor has been recorded on this application yet.
            </p>
          </Card>
        )}
      </section>

      {/* --- The product's own answers ------------------------------------- */}
      {applicationProfile !== null &&
      (applicationProfile.applicationProfile === 'salary' ||
        applicationProfile.applicationProfile === 'business') ? (
        <section aria-labelledby="application-heading" className="min-w-0 space-y-3">
          <h2 id="application-heading" className="text-text text-lg font-semibold">
            {applicationProfile.applicationProfile === 'salary'
              ? 'Employment, as stated on the application'
              : 'The business, as stated on the application'}
          </h2>

          <Card>
            {applicationProfile.applicationProfile === 'salary' ? (
              <SalaryDetailsSummary profile={applicationProfile} />
            ) : (
              <BusinessDetailsSummary profile={applicationProfile} />
            )}
          </Card>
        </section>
      ) : null}

      {/* --- Documents ------------------------------------------------------ */}
      {documents.length > 0 ? (
        <section aria-labelledby="documents-heading" className="min-w-0 space-y-3">
          <h2 id="documents-heading" className="text-text text-lg font-semibold">
            Documents filed with this application
          </h2>

          <Card>
            <ul className="min-w-0 space-y-2">
              {documents.map((document) => (
                <li key={document.id} className="text-text min-w-0 text-sm">
                  <span className="font-medium">
                    {LOAN_DOCUMENT_LABELS[document.kind]}
                  </span>
                  {document.label === null ? '' : ` — ${document.label}`}
                  <span className="text-text-muted">
                    {' · '}
                    {formatRecordedDate(document.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </section>
      ) : null}

      {/* --- Security ------------------------------------------------------- */}
      {canSeeCollateral ? (
        <section aria-labelledby="security-heading" className="min-w-0 space-y-3">
          <h2 id="security-heading" className="text-text text-lg font-semibold">
            Security
          </h2>

          <LoanCollateralPanel
            loanId={loan.id}
            items={collateral}
            // Editable while the file is still being assembled. Afterwards the
            // identity of an item is evidence and the database refuses a
            // change — releasing and realising stay available, because those
            // are the only things security is for.
            editable={
              loan.status === 'draft' ||
              loan.status === 'pending_approval' ||
              loan.status === 'approved'
            }
            canManage={contextCan(context, 'collateral:manage')}
            collateralRequired={applicationProfile?.collateralRequired === true}
          />

          {guarantees.length > 0 ? (
            <>
              <h3 className="text-text text-base font-semibold">Who stands for it</h3>
              <LoanGuaranteePanel
                loanId={loan.id}
                guarantees={guarantees}
                // Only on a live loan: a draft's guarantors are removed from
                // the application, and a finished loan's guarantee ended with
                // it. The function refuses both, and offering a control that
                // can only fail is worse than not offering it.
                canRelease={contextCan(context, 'guarantors:release') && isDisbursed}
              />
            </>
          ) : null}
        </section>
      ) : null}

      {/* --- Recovery ------------------------------------------------------- */}
      {canSeeRecovery && isDisbursed ? (
        <section aria-labelledby="recovery-heading" className="min-w-0 space-y-3">
          <h2 id="recovery-heading" className="text-text text-lg font-semibold">
            Recovery
          </h2>

          <LoanRecoveryPanel
            loanId={loan.id}
            status={recoveryStatus}
            actions={recoveryActions}
            canRecord={contextCan(context, 'recovery:record')}
            today={today}
          />
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

      {/* Arrears, grace periods and penalties are Phase 7. No placeholder
          section: an empty "Arrears" heading would read as "this borrower is
          in arrears of nothing", and whether an unpaid collection *is* arrears
          is precisely the judgement this phase does not make. */}
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
