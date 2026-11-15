import { query } from './db';

/**
 * Put every staff profile on an agent account's roster.
 *
 * ## Why the fixtures need this now
 *
 * Client Rule 6 became a real control: `agency_account_staff` decides who may
 * record or post against an agent account, enforced by a trigger on
 * `agency_transactions` and another on `agency_float_trades`. Before it, any
 * officer holding the capability could use any account at a branch they could
 * see, and every fixture in the database suite was written in that world — a
 * secretary recording against a till nobody had staffed.
 *
 * Those fixtures are not asserting anything about the roster; they are
 * setting up a counter so that commission, posting, reversal and concurrency
 * can be asserted. So the honest fix is to make the fixture's world match the
 * product's: an account that has been opened has somebody on it.
 *
 * ## Why it writes the table directly
 *
 * `assign_agency_account_staff()` is the product's path and is tested on its
 * own terms in `tests/db/agency-account-staff.test.ts`. Using it here would
 * mean every suite's fixture also depended on its capability checks, its
 * branch rule and its refusals — so a change to any of those would break
 * twenty unrelated tests for a reason none of them is about. `query()` runs
 * as the table owner, which is what a fixture should be.
 *
 * ## What it deliberately does not do
 *
 * It assigns staff only — anybody holding a role other than `client`. A
 * borrower is left off, because `assign_agency_account_staff()` refuses one
 * and a fixture that created a state the product forbids would be a fixture
 * that proves nothing.
 */
export async function staffAgentAccount(floatAccountId: string): Promise<void> {
  await query(
    `insert into public.agency_account_staff
       (float_account_id, profile_id, assigned_by, notes)
     select $1, p.id, p.id, 'fixture'
       from public.profiles p
      where p.status = 'active'
        and exists (
          select 1 from public.user_roles ur
           where ur.profile_id = p.id and ur.role_key <> 'client')
     on conflict (float_account_id, profile_id) where status = 'active'
     do nothing`,
    [floatAccountId],
  );
}

/**
 * The same, for a suite that creates its people after its tills.
 *
 * Re-running `staffAgentAccount` picks up anybody added since, because the
 * insert is a select over the current profiles and conflicts are ignored.
 */
export async function restaffAgentAccounts(
  floatAccountIds: readonly string[],
): Promise<void> {
  for (const id of floatAccountIds) await staffAgentAccount(id);
}
