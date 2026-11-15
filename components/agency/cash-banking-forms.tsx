'use client';

import { useActionState, useId, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Label } from '@/components/ui/label';
import { Money } from '@/components/ui/money';
import {
  recordCashBankingAction,
  rejectCashBankingAction,
  reverseCashBankingAction,
  verifyCashBankingAction,
  type AgencyActionResult,
} from '@/lib/agency/actions';
import { toUgx } from '@/lib/domain/money';
import type {
  AgencyCashBankingRow,
  BankAccountOption,
  BankingStaffOption,
  OperatingBranchOption,
} from '@/lib/domain/agency';

const SELECT =
  'border-border bg-surface focus-visible:ring-brand h-11 w-full min-w-0 rounded-lg border px-3 text-sm focus-visible:ring-2 focus-visible:outline-none';

/** A whole number of shillings typed into a text field, or null. */
function readShillings(text: string): number | null {
  const cleaned = text.replace(/[\s,]/g, '');
  if (cleaned === '' || !/^\d+$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Recording an agent's deposit of collected cash into a company bank account.
 *
 * ## Why this is its own form and not an option on another one
 *
 * Client Rule 5 says a cash banking must not be counted as a customer
 * deposit, new revenue or a float top-up, and the client's §9 is explicit
 * that these operations "must never be represented by one confusing
 * general-purpose form". The three mistakes were all available before: the
 * counter form would have made it a customer's transaction with a commission,
 * the replenishment form would have credited a float till, and a transfer
 * would have posted outside every agency control.
 *
 * So the form says in plain words what it is and what it is not, before the
 * first field. A cashier who is not sure which form they want is the person
 * this screen is for.
 *
 * ## Why the consequence is spelled out before the button
 *
 * The panel below the fields states the two movements this will make, in
 * shillings, from what has been typed. Not a validation and not a
 * pre-flight — the database computes the legs at the moment of posting, under
 * lock, from the row it reads — but the client's §9 asks for "clear financial
 * consequences before submission", and the charge is the thing people get
 * wrong: the bank keeps it, so the till loses the full amount and the bank
 * account gains less.
 *
 * ## Why every typed field is controlled
 *
 * React resets an uncontrolled form after a form action completes, whatever
 * the action returned. A refusal would leave the officer staring at a blank
 * form with the deposit slip in their hand and no way to tell whether it had
 * been recorded. These keep what was typed when a submission fails and clear
 * only when one succeeds.
 */
export function CashBankingForm({
  bankAccounts,
  staff,
  branches,
  ownBranch,
  cashOnHand,
  today,
}: {
  readonly bankAccounts: readonly BankAccountOption[];
  readonly staff: readonly BankingStaffOption[];
  /** Offered only to an officer whose profile carries no branch. */
  readonly branches: readonly OperatingBranchOption[];
  readonly ownBranch: OperatingBranchOption | null;
  /** What the branch's till holds, to inform. Never a gate: see above. */
  readonly cashOnHand: number | null;
  readonly today: string;
}) {
  const [result, submit, pending] = useActionState<
    AgencyActionResult | undefined,
    FormData
  >(recordCashBankingAction, undefined);
  const formId = useId();

  const [bankAccountId, setBankAccountId] = useState(bankAccounts[0]?.id ?? '');
  const [amount, setAmount] = useState('');
  const [charge, setCharge] = useState('0');
  const [reference, setReference] = useState('');
  const [bankedBy, setBankedBy] = useState('');
  const [bankingDate, setBankingDate] = useState(today);
  const [evidence, setEvidence] = useState('');
  const [notes, setNotes] = useState('');
  const [branchId, setBranchId] = useState(ownBranch?.id ?? branches[0]?.id ?? '');

  const [handled, setHandled] = useState(result);
  const [attempt, setAttempt] = useState(0);
  if (result !== handled) {
    setHandled(result);
    if (result?.ok === true) {
      setAttempt((n) => n + 1);
      setAmount('');
      setCharge('0');
      setReference('');
      setEvidence('');
      setNotes('');
    }
  }

  if (bankAccounts.length === 0) {
    return (
      <Alert tone="info" title="There is no bank account to bank into">
        Cash banking moves money from the branch till into one of the company&rsquo;s own
        bank accounts, and none is configured for a branch you can see. A bank account is
        added to the chart of accounts before this can be recorded.
      </Alert>
    );
  }

  const typedAmount = readShillings(amount);
  const typedCharge = readShillings(charge) ?? 0;
  const net = typedAmount === null ? null : typedAmount - typedCharge;
  const chargeTooBig = typedAmount !== null && typedCharge >= typedAmount;

  const errors = result?.ok === false ? result.fieldErrors : undefined;
  const account = bankAccounts.find((a) => a.id === bankAccountId);

  return (
    <Card>
      <h2 className="text-sm font-semibold">Bank collected cash</h2>
      <p className="text-text-muted mt-1 text-sm">
        This records that an agent took physical cash from the till to the bank. It is{' '}
        <strong>not</strong> a customer&rsquo;s deposit, it is not income, and it does not
        top up electronic float. It records nothing until a different officer checks the
        deposit slip and posts it.
      </p>

      {result?.ok === false ? (
        <Alert tone="danger" className="mt-3">
          {result.message}
        </Alert>
      ) : null}
      {result?.ok === true ? (
        <Alert tone="success" className="mt-3">
          {result.message}
        </Alert>
      ) : null}

      <form
        key={`banking-${attempt}`}
        action={submit}
        aria-label="Bank collected cash"
        className="mt-3 min-w-0 space-y-4"
      >
        {ownBranch === null && branches.length > 0 ? (
          <div className="min-w-0 space-y-1">
            <Label htmlFor={`${formId}-branch`}>Banked from branch</Label>
            <select
              id={`${formId}-branch`}
              name="branchId"
              value={branchId}
              onChange={(event) => {
                setBranchId(event.target.value);
              }}
              className={SELECT}
            >
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name} ({b.branchCode})
                </option>
              ))}
            </select>
            <p className="text-text-muted text-xs">
              Your profile carries no branch, so the branch the cash came from has to be
              named. It cannot be guessed.
            </p>
          </div>
        ) : (
          <input type="hidden" name="branchId" value="" />
        )}

        <div className="min-w-0 space-y-1">
          <Label htmlFor={`${formId}-account`}>Banked into</Label>
          <select
            id={`${formId}-account`}
            name="bankAccountId"
            value={bankAccountId}
            onChange={(event) => {
              setBankAccountId(event.target.value);
            }}
            className={SELECT}
          >
            {bankAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.institution === null ? '' : ` — ${a.institution}`} ({a.code})
              </option>
            ))}
          </select>
          {account === undefined ? null : (
            <p className="text-text-muted text-xs">
              The company&rsquo;s own account. A customer&rsquo;s bank balance is never
              recorded or shown here.
            </p>
          )}
        </div>

        <Field
          label="Amount taken to the bank"
          name="amount"
          inputMode="numeric"
          value={amount}
          onChange={(event) => {
            setAmount(event.target.value);
          }}
          required
          hint={
            cashOnHand === null ? (
              'Whole shillings.'
            ) : (
              <>
                Whole shillings. The till holds <Money amount={toUgx(cashOnHand)} /> right
                now.
              </>
            )
          }
          error={errors?.amount?.[0]}
        />

        <Field
          label="Bank charge, if any"
          name="charge"
          inputMode="numeric"
          value={charge}
          onChange={(event) => {
            setCharge(event.target.value);
          }}
          hint="What the bank kept out of the deposit. Zero if it took nothing. Posted as a bank charge, never as a commission."
          error={errors?.charge?.[0]}
        />

        <Field
          label="Bank deposit reference"
          name="depositReference"
          value={reference}
          onChange={(event) => {
            setReference(event.target.value);
          }}
          required
          hint="From the deposit slip. Required, because a banking with nothing to match against a statement cannot be reconciled. The same reference cannot be banked into the same account twice."
          error={errors?.depositReference?.[0]}
        />

        <div className="min-w-0 space-y-1">
          <Label htmlFor={`${formId}-banker`}>Banked by</Label>
          <select
            id={`${formId}-banker`}
            name="bankedBy"
            value={bankedBy}
            onChange={(event) => {
              setBankedBy(event.target.value);
            }}
            className={SELECT}
          >
            <option value="">Me</option>
            {staff.map((s) => (
              <option key={s.profileId} value={s.profileId}>
                {s.fullName}
              </option>
            ))}
          </select>
          <p className="text-text-muted text-xs">
            Who physically carried the cash, which is not always who is typing. Naming
            somebody else is what makes a supervisor-recorded banking accountable to the
            cashier who did it.
          </p>
        </div>

        <Field
          label="Date banked"
          name="bankingDate"
          type="date"
          value={bankingDate}
          onChange={(event) => {
            setBankingDate(event.target.value);
          }}
          max={today}
          hint="Cannot be in the future."
          error={errors?.bankingDate?.[0]}
        />

        <Field
          label="Supporting evidence"
          name="evidenceNote"
          value={evidence}
          onChange={(event) => {
            setEvidence(event.target.value);
          }}
          hint="Where the slip is — the teller stamp, the file, the photograph. Optional, and what a reconciliation looks for."
          error={errors?.evidenceNote?.[0]}
        />

        <Field
          label="Notes"
          name="notes"
          value={notes}
          onChange={(event) => {
            setNotes(event.target.value);
          }}
          error={errors?.notes?.[0]}
        />

        {/* The consequence, in shillings, from what has been typed. Informative
            only: the database builds the legs at the moment of posting, from
            the row it locks. */}
        {typedAmount === null ? null : (
          <div className="border-border bg-surface-sunken rounded-lg border p-3 text-xs">
            <p className="text-text font-semibold">What posting this will do</p>
            {chargeTooBig ? (
              <p className="text-danger mt-1">
                The charge is not less than the amount, so this would bank nothing. Check
                the two figures.
              </p>
            ) : (
              <ul className="text-text-muted mt-1 space-y-0.5">
                <li>
                  The branch till falls by <Money amount={toUgx(typedAmount)} /> — the
                  whole amount, because that is what leaves it.
                </li>
                <li>
                  The bank account rises by <Money amount={toUgx(net ?? 0)} />
                  {typedCharge > 0 ? ' — the amount less the charge' : ''}.
                </li>
                {typedCharge > 0 ? (
                  <li>
                    <Money amount={toUgx(typedCharge)} /> is recorded as a bank charge, an
                    expense.
                  </li>
                ) : null}
                <li>No electronic float moves and no income is recognised.</li>
              </ul>
            )}
          </div>
        )}

        <Button type="submit" variant="save" loading={pending} className="w-full">
          Record this banking — nothing moves yet
        </Button>
      </form>
    </Card>
  );
}

/**
 * The second officer's decision on a recorded banking.
 *
 * Posting and rejecting are two buttons on one row rather than two forms,
 * because they are the two halves of one decision and a control that can only
 * say yes is not a control. The revision the screen was handed travels with
 * the post, so a figure that changed between the screen and the click is
 * refused rather than posted.
 */
export function CashBankingDecision({
  row,
  canPost,
  canReverse,
}: {
  readonly row: AgencyCashBankingRow;
  readonly canPost: boolean;
  readonly canReverse: boolean;
}) {
  const [postResult, post, posting] = useActionState<
    AgencyActionResult | undefined,
    FormData
  >(verifyCashBankingAction, undefined);
  const [rejectResult, reject, rejecting] = useActionState<
    AgencyActionResult | undefined,
    FormData
  >(rejectCashBankingAction, undefined);
  const [reverseResult, reverse, reversing] = useActionState<
    AgencyActionResult | undefined,
    FormData
  >(reverseCashBankingAction, undefined);

  const [rejectReason, setRejectReason] = useState('');
  const [reverseReason, setReverseReason] = useState('');

  const message =
    postResult?.message ?? rejectResult?.message ?? reverseResult?.message ?? null;
  const failed =
    postResult?.ok === false || rejectResult?.ok === false || reverseResult?.ok === false;

  return (
    <div className="min-w-0 space-y-2">
      {message === null ? null : (
        <Alert tone={failed ? 'danger' : 'success'}>{message}</Alert>
      )}

      {row.status === 'pending' && canPost ? (
        <>
          <form action={post} aria-label="Post this cash banking">
            <input type="hidden" name="bankingId" value={row.id} />
            {/* The revision the figures were read at. The database compares it
                against the row it locks. */}
            <input type="hidden" name="reviewedRevision" value={row.revision} />
            <Button type="submit" size="sm" loading={posting}>
              Post — move the cash to the bank
            </Button>
          </form>

          <form
            action={reject}
            aria-label="Reject this cash banking"
            className="flex min-w-0 flex-wrap items-end gap-2"
          >
            <input type="hidden" name="bankingId" value={row.id} />
            <div className="min-w-0 flex-1">
              <Field
                label="Reject, because"
                name="reason"
                value={rejectReason}
                onChange={(event) => {
                  setRejectReason(event.target.value);
                }}
              />
            </div>
            <Button type="submit" size="sm" variant="outline" loading={rejecting}>
              Reject
            </Button>
          </form>
        </>
      ) : null}

      {row.status === 'posted' && canReverse ? (
        <form
          action={reverse}
          aria-label="Reverse this cash banking"
          className="flex min-w-0 flex-wrap items-end gap-2"
        >
          <input type="hidden" name="bankingId" value={row.id} />
          <div className="min-w-0 flex-1">
            <Field
              label="Reverse, because"
              name="reason"
              value={reverseReason}
              onChange={(event) => {
                setReverseReason(event.target.value);
              }}
              hint="The original posting is kept. The reversal is a second entry that undoes it."
            />
          </div>
          <Button type="submit" size="sm" variant="danger" loading={reversing}>
            Reverse
          </Button>
        </form>
      ) : null}
    </div>
  );
}
