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
 * Authorising an employee on one agent account.
 *
 * ## Why the candidate list is narrowed here and still checked there
 *
 * The select offers employees of the account's own branch who are not already
 * on its roster, because an Owner picking from a list of forty people should
 * not have to remember which eight are already authorised. But
 * `assign_agency_account_staff()` checks the branch and the duplicate itself,
 * and it is the answer that decides: this list was built when the page
 * rendered, and somebody may have been transferred since.
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
        Every employee at {account.branchName} who could be authorised already is. An
        employee from another branch cannot be: the account belongs to this branch, and
        the database refuses a mandate across one.
      </p>
    );
  }

  return (
    <form action={submit} className="min-w-0 space-y-3">
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
