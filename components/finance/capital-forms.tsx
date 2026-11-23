'use client';

import { useActionState, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Label } from '@/components/ui/label';
import {
  recordCapitalFundingAction,
  rejectCapitalFundingAction,
  reverseCapitalFundingAction,
  verifyCapitalFundingAction,
  type FinanceActionResult,
} from '@/lib/finance/actions';
import {
  CAPITAL_EVIDENCE_KIND_LABELS,
  type LedgerAccountOption,
} from '@/lib/domain/finance';

/**
 * The parts of the capital register that have to run in the browser.
 *
 * Everything else — the position, the register's rows, every heading and
 * every explanatory paragraph — is a Server Component in
 * `capital-register.tsx` and ships no JavaScript. The split is not
 * cosmetic: `tests/integration/bundle.test.ts` caps the total of every chunk
 * the application has, and the first version of this screen put its whole
 * 467 lines behind `'use client'`, long prose included.
 *
 * What genuinely needs the client is state: the record form's kind selector
 * changes which fields exist, and every form needs `useActionState` to show
 * its own result. That is what is left here.
 */

const SELECT =
  'border-border bg-surface focus-visible:ring-brand mt-1 h-11 w-full min-w-0 rounded-lg border px-3 text-sm focus-visible:ring-2 focus-visible:outline-none';

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
 * Recording capital.
 *
 * The kind is asked first because the rest of the form depends on it: a
 * borrowing names a lender, may carry a rate and may have a due date, and
 * credits a 2300-series liability. Asking for the account first and the kind
 * afterwards is how somebody credits a bank loan to the owner's capital.
 */
export function RecordCapitalForm({
  destinations,
  equityAccounts,
  borrowingAccounts,
}: {
  readonly destinations: readonly LedgerAccountOption[];
  readonly equityAccounts: readonly LedgerAccountOption[];
  readonly borrowingAccounts: readonly LedgerAccountOption[];
}) {
  const [key, setKey] = useState<string>(() => newKey());
  const [kind, setKind] = useState<'equity' | 'borrowing'>('equity');

  const [result, record, recording] = useActionState<
    FinanceActionResult | undefined,
    FormData
  >(recordCapitalFundingAction, undefined);

  const capitalAccounts = kind === 'equity' ? equityAccounts : borrowingAccounts;

  return (
    <>
      {result?.message === undefined ? null : (
        <Alert tone={result.ok ? 'success' : 'danger'} className="mt-3">
          {result.message}
        </Alert>
      )}

      <form
        action={(formData) => {
          record(formData);
          // A new key for the next funding, so the one just submitted cannot
          // be replayed by a second click.
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
    </>
  );
}

/** Verifying one funding, which is what posts it. */
export function VerifyCapitalForm({ fundingId }: { readonly fundingId: string }) {
  const [result, verify, verifying] = useActionState<
    FinanceActionResult | undefined,
    FormData
  >(verifyCapitalFundingAction, undefined);

  return (
    <form action={verify} className="mt-3 min-w-0">
      {result?.message === undefined ? null : (
        <Alert tone={result.ok ? 'success' : 'danger'} className="mb-2">
          {result.message}
        </Alert>
      )}
      <input type="hidden" name="fundingId" value={fundingId} />
      <div className="flex flex-wrap items-end gap-2">
        <Field label="What you checked" name="note" />
        <Button type="submit" disabled={verifying}>
          {verifying ? 'Verifying…' : 'Verify and post'}
        </Button>
      </div>
    </form>
  );
}

/**
 * The two destructive acts, which differ only in which action they call.
 *
 * Both need a reason and the database requires one, so the field is required
 * here too — a form that submitted an empty reason would meet a refusal it
 * could have explained itself.
 */
export function CapitalReasonForm({
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
