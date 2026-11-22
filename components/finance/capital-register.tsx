'use client';

import { useActionState, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Label } from '@/components/ui/label';
import { Money } from '@/components/ui/money';
import {
  recordCapitalFundingAction,
  rejectCapitalFundingAction,
  reverseCapitalFundingAction,
  verifyCapitalFundingAction,
  type FinanceActionResult,
} from '@/lib/finance/actions';
import {
  CAPITAL_EVIDENCE_KIND_LABELS,
  CAPITAL_FUNDING_KIND_LABELS,
  CAPITAL_FUNDING_STATUS_LABELS,
  type CapitalFundingRow,
  type CapitalPosition,
  type LedgerAccountOption,
} from '@/lib/domain/finance';
import { cn } from '@/lib/utils/cn';

const SELECT =
  'border-border bg-surface focus-visible:ring-brand mt-1 h-11 w-full min-w-0 rounded-lg border px-3 text-sm focus-visible:ring-2 focus-visible:outline-none';

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
 * A key the browser mints, so a double submission records one funding.
 *
 * `globalThis.crypto`, not `node:crypto`, for the reason the bank deposit
 * register gives at length: importing the Node module pulls its browser
 * polyfill into the route's first load.
 */
function newKey(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * The money the business was started and funded with.
 *
 * ## Why the form asks for the kind first
 *
 * Equity and borrowing are different instruments, and the rest of the form
 * depends on which one this is: a borrowing names a lender, may carry a rate
 * and may have a due date, and credits a 2300-series liability. An equity
 * contribution has none of those and credits the 3000 series. Asking for the
 * account first and the kind afterwards is how somebody credits a bank loan
 * to the owner's capital, which the database refuses and which the form
 * should never have offered.
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
  const [key, setKey] = useState<string>(() => newKey());
  const [kind, setKind] = useState<'equity' | 'borrowing'>('equity');

  const [recordResult, record, recording] = useActionState<
    FinanceActionResult | undefined,
    FormData
  >(recordCapitalFundingAction, undefined);
  const [verifyResult, verify, verifying] = useActionState<
    FinanceActionResult | undefined,
    FormData
  >(verifyCapitalFundingAction, undefined);

  const capitalAccounts = kind === 'equity' ? equityAccounts : borrowingAccounts;
  const canOfferForm = canRecord && destinations.length > 0 && capitalAccounts.length > 0;

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

          {recordResult?.message === undefined ? null : (
            <Alert tone={recordResult.ok ? 'success' : 'danger'} className="mt-3">
              {recordResult.message}
            </Alert>
          )}

          <form
            action={(formData) => {
              record(formData);
              // A new key for the next funding, so the one just submitted
              // cannot be replayed by a second click.
              setKey(newKey());
            }}
            className="mt-3"
          >
            <input type="hidden" name="idempotencyKey" value={key} />
            <Card className="grid min-w-0 gap-4 p-4 sm:grid-cols-2">
              <div className="min-w-0 sm:col-span-2">
                <Label htmlFor="capital-kind">What kind of money is this</Label>
                <select
                  id="capital-kind"
                  name="fundingKind"
                  required
                  className={SELECT}
                  value={kind}
                  onChange={(event) => {
                    setKind(event.target.value === 'borrowing' ? 'borrowing' : 'equity');
                  }}
                >
                  <option value="equity">
                    The owner&rsquo;s own money — not repayable, no interest
                  </option>
                  <option value="borrowing">
                    Borrowed — repayable, and it may carry interest
                  </option>
                </select>
              </div>

              <Field
                label="Amount"
                name="amount"
                inputMode="numeric"
                required
                hint="Whole shillings."
              />

              <Field
                label={kind === 'equity' ? 'Contributed by' : 'Lent by'}
                name="funderName"
                required
              />

              <div className="min-w-0">
                <Label htmlFor="capital-destination">The money landed in</Label>
                <select
                  id="capital-destination"
                  name="destinationAccountId"
                  required
                  className={SELECT}
                >
                  {destinations.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.code} — {account.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="min-w-0">
                <Label htmlFor="capital-account">
                  {kind === 'equity' ? 'Credited to equity' : 'Credited to the borrowing'}
                </Label>
                <select
                  id="capital-account"
                  name="capitalAccountId"
                  required
                  className={SELECT}
                >
                  {capitalAccounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.code} — {account.name}
                    </option>
                  ))}
                </select>
              </div>

              <Field
                label="Evidence date"
                name="fundedOn"
                type="date"
                required
                hint="What the slip says. It may be years ago — that is how an opening balance is recorded. The journal entry is dated the day it is verified."
              />

              <div className="min-w-0">
                <Label htmlFor="capital-evidence-kind">Evidence</Label>
                <select
                  id="capital-evidence-kind"
                  name="evidenceKind"
                  required
                  className={SELECT}
                  defaultValue="bank_transfer"
                >
                  {Object.entries(CAPITAL_EVIDENCE_KIND_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>

              <Field
                label="Evidence reference"
                name="evidenceReference"
                required
                hint="The number on the slip, transfer or cheque. It is what the second Owner checks against."
              />

              {kind === 'borrowing' ? (
                <>
                  <Field
                    label="Interest rate"
                    name="interestRateBps"
                    inputMode="numeric"
                    hint="In basis points: 1200 is 12%. Leave blank if none is agreed."
                  />
                  <Field label="Repayable by" name="repaymentDueOn" type="date" />
                </>
              ) : null}

              <div className="sm:col-span-2">
                <Field label="Note" name="description" />
              </div>

              <div className="sm:col-span-2">
                <Button type="submit" disabled={recording}>
                  {recording ? 'Recording…' : 'Record capital'}
                </Button>
              </div>
            </Card>
          </form>
        </section>
      ) : null}

      <section aria-labelledby="capital-register-heading">
        <h2 id="capital-register-heading" className="text-text text-sm font-semibold">
          Register
        </h2>

        {verifyResult?.message === undefined ? null : (
          <Alert tone={verifyResult.ok ? 'success' : 'danger'} className="mt-3">
            {verifyResult.message}
          </Alert>
        )}

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
                  <div className="mt-3 min-w-0 space-y-2">
                    <form action={verify} className="flex flex-wrap items-end gap-2">
                      <input type="hidden" name="fundingId" value={funding.fundingId} />
                      <Field label="What you checked" name="note" />
                      <Button type="submit" disabled={verifying}>
                        {verifying ? 'Verifying…' : 'Verify and post'}
                      </Button>
                    </form>
                    <ReasonForm
                      fundingId={funding.fundingId}
                      label="Reject"
                      hint="Posts nothing, and cannot be undone: record it again if the evidence turns up."
                      action="reject"
                    />
                  </div>
                ) : null}

                {canReverse && funding.status === 'verified' ? (
                  <ReasonForm
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
    </div>
  );
}

/**
 * The two destructive acts, which differ only in which action they call.
 *
 * Both need a reason and the database requires one, so the field is required
 * here too — a form that submitted an empty reason would meet a refusal it
 * could have explained itself.
 */
function ReasonForm({
  fundingId,
  label,
  hint,
  action,
}: {
  readonly fundingId: string;
  readonly label: string;
  readonly hint: string;
  readonly action: 'reject' | 'reverse';
}) {
  const [result, submit, pending] = useActionState<
    FinanceActionResult | undefined,
    FormData
  >(
    action === 'reject' ? rejectCapitalFundingAction : reverseCapitalFundingAction,
    undefined,
  );

  return (
    <form action={submit} className="mt-3 min-w-0">
      {result?.message === undefined ? null : (
        <Alert tone={result.ok ? 'success' : 'danger'} className="mb-2">
          {result.message}
        </Alert>
      )}
      <input type="hidden" name="fundingId" value={fundingId} />
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Because" name="reason" required hint={hint} />
        <Button type="submit" variant="secondary" disabled={pending}>
          {pending ? 'Working…' : label}
        </Button>
      </div>
    </form>
  );
}
