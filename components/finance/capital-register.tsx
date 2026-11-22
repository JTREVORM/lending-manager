import { Alert } from '@/components/ui/alert';
import { Card } from '@/components/ui/card';
import {
  CapitalReasonForm,
  RecordCapitalForm,
  VerifyCapitalForm,
} from '@/components/finance/capital-forms';
import { Money } from '@/components/ui/money';
import {
  CAPITAL_FUNDING_KIND_LABELS,
  CAPITAL_FUNDING_STATUS_LABELS,
  type CapitalFundingRow,
  type CapitalPosition,
  type LedgerAccountOption,
} from '@/lib/domain/finance';
import { cn } from '@/lib/utils/cn';

export interface CapitalRegisterProps {
  readonly fundings: readonly CapitalFundingRow[];
  readonly position: CapitalPosition;
  readonly destinations: readonly LedgerAccountOption[];
  readonly equityAccounts: readonly LedgerAccountOption[];
  readonly borrowingAccounts: readonly LedgerAccountOption[];
  readonly canRecord: boolean;
  readonly canVerify: boolean;
  readonly canReverse: boolean;
  readonly className?: string;
}

/**
 * The money the business was started and funded with.
 *
 * ## A Server Component, and why that is not an afterthought
 *
 * This file ships **no JavaScript**. The position, the register's rows, every
 * heading and every explanatory paragraph are rendered on the server; the
 * three things that genuinely need the browser — the record form's dependent
 * fields and each form's own result message — live in `capital-forms.tsx`
 * behind `'use client'`.
 *
 * The first version of this screen was one 467-line client component, long
 * prose included, and it cost 6 KB gzipped. `tests/integration/bundle.test.ts`
 * caps the total of every chunk the application has, and that total is what
 * caught it. The rule the codebase already follows is in the budget's own
 * notes: the daily commission report "is the largest piece of work in this
 * round by line count and it ships no JavaScript". Prose belongs on the
 * server.
 *
 * ## Why "Posted" is not the first state
 *
 * Recording writes a document and no journal. A second Owner checks it
 * against the evidence, and *that* posts. The register says so on every row,
 * because an Owner who believes the balance sheet already carries a figure
 * will reconcile against something that is not there.
 *
 * ## Why the evidence date and the entry date are both shown
 *
 * They are different dates and conflating them is how a prior-year balance
 * sheet stops reconciling. The evidence date is what the slip says and may be
 * years old — that is how an opening balance is recorded here. The entry date
 * is the accounting date, which is always the day the funding was verified,
 * because this system has no backdated posting.
 */
export function CapitalRegister({
  fundings,
  position,
  destinations,
  equityAccounts,
  borrowingAccounts,
  canRecord,
  canVerify,
  canReverse,
  className,
}: CapitalRegisterProps) {
  const canOfferForm =
    canRecord &&
    destinations.length > 0 &&
    (equityAccounts.length > 0 || borrowingAccounts.length > 0);

  return (
    <div className={cn('min-w-0 space-y-8', className)}>
      <section aria-labelledby="capital-position-heading">
        <h2 id="capital-position-heading" className="text-text text-sm font-semibold">
          What the business is funded with
        </h2>
        <p className="text-text-muted mt-1 text-xs">
          Posted entries only. A funding awaiting verification has moved nothing.
        </p>

        <Card className="mt-3 grid min-w-0 gap-4 p-4 sm:grid-cols-3">
          <div className="min-w-0">
            <p className="text-text-muted text-xs">Owner&rsquo;s capital</p>
            <p className="text-text mt-1 text-lg font-semibold tabular-nums">
              <Money amount={position.equity} />
            </p>
            <p className="text-text-muted mt-1 text-xs">
              Not repayable. Raises the business&rsquo;s net worth.
            </p>
          </div>
          <div className="min-w-0">
            <p className="text-text-muted text-xs">Borrowed</p>
            <p className="text-text mt-1 text-lg font-semibold tabular-nums">
              <Money amount={position.borrowings} />
            </p>
            <p className="text-text-muted mt-1 text-xs">
              Repayable. Net worth is unchanged: an asset and a liability arrived
              together.
            </p>
          </div>
          <div className="min-w-0">
            <p className="text-text-muted text-xs">Introduced in total</p>
            <p className="text-text mt-1 text-lg font-semibold tabular-nums">
              <Money amount={position.total} />
            </p>
            {position.awaitingVerification === 0 ? null : (
              <p className="text-warning mt-1 text-xs">
                {position.awaitingVerification} awaiting verification, and not in these
                figures.
              </p>
            )}
          </div>
        </Card>
      </section>

      {canOfferForm ? (
        <section aria-labelledby="record-capital-heading">
          <h2 id="record-capital-heading" className="text-text text-sm font-semibold">
            Record capital introduced
          </h2>
          <p className="text-text-muted mt-1 text-xs">
            This posts nothing. A second Owner checks it against the evidence, and that is
            what writes the journal entry.
          </p>

          <RecordCapitalForm
            destinations={destinations}
            equityAccounts={equityAccounts}
            borrowingAccounts={borrowingAccounts}
          />
        </section>
      ) : null}

      <section aria-labelledby="capital-register-heading">
        <h2 id="capital-register-heading" className="text-text text-sm font-semibold">
          Register
        </h2>

        {fundings.length === 0 ? (
          <Card className="mt-3 p-4">
            <p className="text-text-muted text-sm">
              No capital has been recorded yet. Until it is, the only credit to
              owner&rsquo;s capital is the opening balance the Phase 10 migration derived
              from the cash position.
            </p>
          </Card>
        ) : (
          <div className="divide-border border-border mt-3 min-w-0 divide-y rounded-md border">
            {fundings.map((funding) => (
              <article key={funding.fundingId} className="min-w-0 p-4">
                <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-2">
                  <p className="text-text text-sm font-medium tabular-nums">
                    <Money amount={funding.amount} />{' '}
                    <span className="text-text-muted font-normal">
                      · {funding.fundingNumber} ·{' '}
                      {CAPITAL_FUNDING_KIND_LABELS[funding.fundingKind]}
                    </span>
                  </p>
                  <p
                    className={cn(
                      'text-xs font-medium',
                      funding.status === 'verified'
                        ? 'text-success'
                        : funding.status === 'submitted'
                          ? 'text-warning'
                          : 'text-danger',
                    )}
                  >
                    {CAPITAL_FUNDING_STATUS_LABELS[funding.status]}
                  </p>
                </div>

                <p className="text-text-muted mt-1 text-xs">
                  {funding.fundingKind === 'equity' ? 'From' : 'Lent by'}{' '}
                  {funding.funderName} · {funding.capitalAccountCode}{' '}
                  {funding.capitalAccountName} ← {funding.destinationAccountCode}{' '}
                  {funding.destinationAccountName}
                </p>

                <p className="text-text-muted mt-1 text-xs">
                  Evidence {funding.evidenceReference} dated {funding.fundedOn} · recorded
                  by {funding.recordedByLabel}
                  {funding.verifiedByLabel === null
                    ? ''
                    : ` · verified by ${funding.verifiedByLabel}`}
                  {funding.journalEntryNumber === null
                    ? ''
                    : ` · posted as ${funding.journalEntryNumber} on ${String(funding.journalEntryDate)}`}
                </p>

                {funding.interestRateBps === null ? null : (
                  <p className="text-text-muted mt-1 text-xs">
                    Interest {(funding.interestRateBps / 100).toFixed(2)}%
                    {funding.repaymentDueOn === null
                      ? ''
                      : ` · repayable by ${funding.repaymentDueOn}`}
                  </p>
                )}

                {funding.rejectionReason === null ? null : (
                  <p className="text-danger mt-1 text-xs">
                    Rejected: {funding.rejectionReason}
                  </p>
                )}
                {funding.reversalReason === null ? null : (
                  <p className="text-danger mt-1 text-xs">
                    Reversed: {funding.reversalReason}
                  </p>
                )}

                {canVerify && funding.status === 'submitted' ? (
                  <div className="min-w-0 space-y-2">
                    <VerifyCapitalForm fundingId={funding.fundingId} />
                    <CapitalReasonForm
                      fundingId={funding.fundingId}
                      label="Reject"
                      hint="Posts nothing, and cannot be undone: record it again if the evidence turns up."
                      action="reject"
                    />
                  </div>
                ) : null}

                {canReverse && funding.status === 'verified' ? (
                  <CapitalReasonForm
                    fundingId={funding.fundingId}
                    label="Reverse"
                    hint="Posts the contra. Refused if the money has already been lent out."
                    action="reverse"
                  />
                ) : null}
              </article>
            ))}
          </div>
        )}
      </section>

      {canRecord && !canOfferForm ? (
        <Alert tone="info">
          Capital arrives as money, so it lands in a cash or bank account and credits
          either the 3000 series or a 2300-series borrowing. The chart of accounts is
          missing one of those, so there is nothing to record against yet.
        </Alert>
      ) : null}
    </div>
  );
}
