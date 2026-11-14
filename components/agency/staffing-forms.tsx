'use client';

import { useActionState, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Label } from '@/components/ui/label';
import {
  assignAgencyAccountStaffAction,
  revokeAgencyAccountStaffAction,
  type AgencyActionResult,
} from '@/lib/agency/actions';
import type { AgencyStaffedAccount, BankingStaffOption } from '@/lib/domain/agency';

const SELECT =
  'border-border bg-surface focus-visible:ring-brand h-11 w-full min-w-0 rounded-lg border px-3 text-sm focus-visible:ring-2 focus-visible:outline-none';

/**
 * What to call an account, for a form's accessible name.
 *
 * The same rule the page's own heading uses: its label if somebody gave it
 * one, else the till it is. Kept here rather than imported because the page is
 * a server component and this is a client one — and two different names for
 * one account would be two things to recognise it by.
 */
function accountName(account: AgencyStaffedAccount): string {
  if (account.accountLabel !== null && account.accountLabel.trim() !== '') {
    return account.accountLabel;
  }
  return account.tillName === '' ? 'Unnamed account' : `Till ${account.tillName}`;
}

/**
 * Authorising an employee on one agent account.
 *
 * ## Why the candidate list is narrowed here and still checked there
 *
 * The select offers the people the database would accept — this account's own
 * branch, plus anybody belonging to no branch — who are not already on its
 * roster, because an Owner picking from a list of forty people should not have
 * to remember which eight are already authorised. But
 * `assign_agency_account_staff()` checks the branch and the duplicate itself,
 * and it is the answer that decides: this list was built when the page
 * rendered, and somebody may have been transferred since.
 *
 * The narrowing must mirror that rule exactly and never exceed it. The first
 * version was stricter, dropping every head-office officer, and the effect was
 * an empty select with no explanation.
 *
 * ## Why there is no "authorise on all accounts"
 *
 * Client Rule 6 is that one agent may operate several banks' accounts "with
 * clear account-level transaction ownership and authorization". A control
 * that can be granted wholesale is a role, not a mandate — and the roles
 * already exist. The whole value of this list is that each row was a decision
 * somebody made about one account.
 */
export function AssignOperatorForm({
  account,
  candidates,
}: {
  readonly account: AgencyStaffedAccount;
  readonly candidates: readonly BankingStaffOption[];
}) {
  const [result, submit, pending] = useActionState<
    AgencyActionResult | undefined,
    FormData
  >(assignAgencyAccountStaffAction, undefined);

  const [profileId, setProfileId] = useState('');
  const [notes, setNotes] = useState('');

  // React clears an uncontrolled form after any action, success or refusal.
  // Keeping the typed mandate reference on a refusal is the difference between
  // correcting one field and typing it again.
  const [handled, setHandled] = useState(result);
  if (result !== handled) {
    setHandled(result);
    if (result?.ok === true) {
      setProfileId('');
      setNotes('');
    }
  }

  if (account.accountStatus === 'closed') {
    return (
      <p className="text-text-muted text-sm">
        This account is closed. Its roster is kept as it stood, and nobody new is
        authorised on an account that takes no transactions.
      </p>
    );
  }

  if (candidates.length === 0) {
    return (
      <p className="text-text-muted text-sm">
        Everybody who could be authorised on this account already is. An employee who
        belongs to another branch cannot be — the account belongs to {account.branchName},
        and the database refuses a mandate across branches. An employee who belongs to no
        branch, such as a head-office officer, can be.
      </p>
    );
  }

  return (
    <form
      action={submit}
      /*
        Named, which is what gives a `<form>` the `form` role at all — an
        unnamed one is a generic container to assistive technology and to
        `getByRole('form')`.

        And named after the *account*, not generically: this page renders one
        of these per account, so "Authorise an employee" repeated nine times
        tells somebody tabbing through it nothing about which counter they are
        granting a mandate on. The browser suite found the missing name; the
        account in it is the part that matters.
      */
      aria-label={`Authorise an employee on ${account.providerName} — ${accountName(account)}`}
      className="min-w-0 space-y-3"
    >
      <input type="hidden" name="floatAccountId" value={account.floatAccountId} />

      {result?.message === undefined ? null : (
        <Alert tone={result.ok ? 'success' : 'danger'}>{result.message}</Alert>
      )}

      <div className="min-w-0">
        <Label htmlFor={`operator-${account.floatAccountId}`}>Authorise</Label>
        <select
          id={`operator-${account.floatAccountId}`}
          name="profileId"
          required
          className={SELECT}
          value={profileId}
          onChange={(event) => {
            setProfileId(event.target.value);
          }}
        >
          <option value="">Choose an employee…</option>
          {candidates.map((person) => (
            <option key={person.profileId} value={person.profileId}>
              {person.fullName}
            </option>
          ))}
        </select>
      </div>

      <Field
        label="Mandate reference or note"
        name="notes"
        value={notes}
        onChange={(event) => {
          setNotes(event.target.value);
        }}
        hint="Optional. The bank mandate, board minute or instruction this authorisation rests on."
      />

      <Button type="submit" size="sm" variant="save" loading={pending}>
        Authorise on this account
      </Button>
    </form>
  );
}

/**
 * Withdrawing one.
 *
 * The reason is required and the hint says why: the row is kept, so a
 * transaction posted while the mandate stood can still be read against the
 * roster as it was. What the withdrawal stops is the next one.
 */
export function RevokeOperatorForm({
  floatAccountId,
  profileId,
  staffName,
}: {
  readonly floatAccountId: string;
  readonly profileId: string;
  readonly staffName: string;
}) {
  const [result, submit, pending] = useActionState<
    AgencyActionResult | undefined,
    FormData
  >(revokeAgencyAccountStaffAction, undefined);

  const [reason, setReason] = useState('');

  return (
    <form
      action={submit}
      aria-label={`Withdraw ${staffName}`}
      className="min-w-0 space-y-2"
    >
      <input type="hidden" name="floatAccountId" value={floatAccountId} />
      <input type="hidden" name="profileId" value={profileId} />

      {result?.message === undefined ? null : (
        <Alert tone={result.ok ? 'success' : 'danger'}>{result.message}</Alert>
      )}

      <div className="flex min-w-0 flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1">
          <Field
            label="Withdraw, because"
            name="reason"
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
            }}
            hint="Kept on the record. A transfer, a suspension, a resignation, a mandate the bank withdrew."
          />
        </div>
        <Button type="submit" size="sm" variant="outline" loading={pending}>
          Withdraw
        </Button>
      </div>
    </form>
  );
}
