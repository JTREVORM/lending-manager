-- ===========================================================================
-- Polytos Phase 2.11 — Row Level Security over the savings tables
--
-- This is the boundary. Everything above it — a hidden sidebar entry, a
-- guarded Server Component, a disabled button — exists to give people a
-- coherent experience and to fail early. None of it survives a caller who
-- takes their own token and queries PostgREST directly, which anybody with
-- the browser's developer tools can do in a minute. Each policy below is
-- written to be correct on its own, assuming the application has been
-- bypassed entirely.
--
-- The four conventions Phase 1 carried, all load-bearing here too:
--
--   * **Every capability call is wrapped in a scalar subquery**, so it plans
--     as an InitPlan evaluated once per statement rather than once per
--     candidate row. `tests/db/rls-hoisting.test.ts` fails the build on a
--     bare call.
--   * **The branch rule is restated, not called.** `user_can_see_branch` is
--     correlated *and* SECURITY DEFINER, so PostgreSQL can neither hoist nor
--     inline it.
--   * **`current_profile_id()` resolves only active profiles**, which is what
--     makes suspending an account take effect on the next request.
--   * **`authenticated` holds no privilege until granted here, per
--     operation.** There is no UPDATE grant on `savings_transactions` and no
--     DELETE grant anywhere, which is how append-only is enforced rather than
--     merely documented.
--
-- ## What a member may see
--
-- Their own savings account, their own transactions, their own withdrawal
-- requests and their own fee receipt — through the identity clause on
-- `clients.profile_id`, which grants exactly their own rows. They hold no
-- savings capability, so the register is closed to them by the same predicate
-- that opens it to staff.
--
-- They may **not** read `membership_consent_challenges` (nobody may: it is
-- written and consumed by definer functions) and they may not write anything
-- at all. A member cannot deposit to their own account, because the money has
-- to arrive at a counter before a record of it should exist.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Revoke first, then grant
--
-- `CREATE TABLE` in this database inherits default privileges that hand
-- `authenticated` everything — including DELETE and TRUNCATE. Granting the
-- few operations a table should allow does not take the rest away, so every
-- table here is stripped bare **before** anything is granted back. Phase 1
-- revoked from `anon, authenticated` together for exactly this reason, and
-- `tests/db/security.test.ts` asserts the resulting privilege list
-- exhaustively — which is how the omission in the first draft of this
-- migration was found rather than shipped.
-- ---------------------------------------------------------------------------

revoke all on table public.membership_fee_receipts from anon, authenticated;
revoke all on table public.savings_accounts from anon, authenticated;
revoke all on table public.savings_transactions from anon, authenticated;
revoke all on table public.savings_withdrawal_requests from anon, authenticated;
-- `membership_cards` is created in 20261020001300, which runs after this
-- file, so it strips itself there.
revoke all on public.member_savings_balances from anon, authenticated;
revoke all on public.savings_account_register from anon, authenticated;
revoke all on public.member_savings_contributions from anon, authenticated;

-- ---------------------------------------------------------------------------
-- membership_fee_receipts
--
-- Read by staff who may see membership, and by the member whose receipt it
-- is. Written only by `record_membership_fee` and `reverse_membership_fee`,
-- which are SECURITY DEFINER — so there is no INSERT or UPDATE grant at all.
-- A receipt that could be inserted directly would be a receipt with no
-- journal behind it.
-- ---------------------------------------------------------------------------

grant select on table public.membership_fee_receipts to authenticated;

alter table public.membership_fee_receipts enable row level security;

create policy membership_fee_receipts_select
  on public.membership_fee_receipts
  for select
  to authenticated
  using (
    (
      (select public.user_has_permission('membership:view'))
      or exists (
        select 1 from public.clients c
        where c.id = membership_fee_receipts.client_id
          and c.profile_id is not null
          and c.profile_id = (select public.current_profile_id())
      )
    )
    and (
      branch_id is null
      or (select public.current_user_branch_id()) is null
      or branch_id = (select public.current_user_branch_id())
    )
  );

comment on policy membership_fee_receipts_select on public.membership_fee_receipts is
  'Staff holding membership:view read receipts within their branch. A member reads their own. Nobody writes this table through a policy — record_membership_fee is the only way in.';

-- ---------------------------------------------------------------------------
-- savings_accounts
-- ---------------------------------------------------------------------------

grant select, update on table public.savings_accounts to authenticated;

alter table public.savings_accounts enable row level security;

-- No INSERT grant: an account is opened by `open_savings_account`, which
-- checks the savings gate. A directly inserted account would be one whose
-- policy version nobody checked.

create policy savings_accounts_select
  on public.savings_accounts
  for select
  to authenticated
  using (
    (
      (select public.user_has_permission('savings:view'))
      or exists (
        select 1 from public.clients c
        where c.id = savings_accounts.client_id
          and c.profile_id is not null
          and c.profile_id = (select public.current_profile_id())
      )
    )
    and (
      branch_id is null
      or (select public.current_user_branch_id()) is null
      or branch_id = (select public.current_user_branch_id())
    )
  );

comment on policy savings_accounts_select on public.savings_accounts is
  'Staff holding savings:view read the register, within their branch. A member reads their own account and no other.';

create policy savings_accounts_update
  on public.savings_accounts
  for update
  to authenticated
  using (
    (select public.user_has_permission('savings:reverse'))
    and (
      branch_id is null
      or (select public.current_user_branch_id()) is null
      or branch_id = (select public.current_user_branch_id())
    )
  )
  with check (
    (select public.user_has_permission('savings:reverse'))
    and (
      branch_id is null
      or (select public.current_user_branch_id()) is null
      or branch_id = (select public.current_user_branch_id())
    )
  );

comment on policy savings_accounts_update on public.savings_accounts is
  'Restricting or closing an account is a supervisory act. Which columns that caller may actually change is decided by savings_accounts_guard.';

-- ---------------------------------------------------------------------------
-- savings_transactions
--
-- SELECT only. There is no INSERT grant, no UPDATE grant and no DELETE
-- grant — every row is written by a SECURITY DEFINER posting function that
-- also wrote the journal. A transaction inserted directly would be money the
-- ledger does not know about.
-- ---------------------------------------------------------------------------

grant select on table public.savings_transactions to authenticated;

alter table public.savings_transactions enable row level security;

create policy savings_transactions_select
  on public.savings_transactions
  for select
  to authenticated
  using (
    (
      (select public.user_has_permission('savings:view'))
      or exists (
        select 1 from public.clients c
        where c.id = savings_transactions.client_id
          and c.profile_id is not null
          and c.profile_id = (select public.current_profile_id())
      )
    )
    and (
      branch_id is null
      or (select public.current_user_branch_id()) is null
      or branch_id = (select public.current_user_branch_id())
    )
  );

comment on policy savings_transactions_select on public.savings_transactions is
  'Staff holding savings:view read the subledger within their branch; a member reads their own statement. Nothing writes this table through a policy: the posting functions are the only way in, and each of them writes a journal in the same transaction.';

-- ---------------------------------------------------------------------------
-- savings_withdrawal_requests
--
-- SELECT for staff and the member whose request it is. No INSERT or UPDATE
-- grant: requesting, deciding, paying and cancelling are four definer
-- functions, each with its own capability check and its own refusal.
-- ---------------------------------------------------------------------------

grant select on table public.savings_withdrawal_requests to authenticated;

alter table public.savings_withdrawal_requests enable row level security;

create policy savings_withdrawal_requests_select
  on public.savings_withdrawal_requests
  for select
  to authenticated
  using (
    (
      (select public.user_has_permission('savings:view'))
      or exists (
        select 1 from public.clients c
        where c.id = savings_withdrawal_requests.client_id
          and c.profile_id is not null
          and c.profile_id = (select public.current_profile_id())
      )
    )
    and (
      branch_id is null
      or (select public.current_user_branch_id()) is null
      or branch_id = (select public.current_user_branch_id())
    )
  );

comment on policy savings_withdrawal_requests_select on public.savings_withdrawal_requests is
  'Staff holding savings:view read requests within their branch; a member reads their own. The four lifecycle functions are the only writers.';

-- ---------------------------------------------------------------------------
-- membership_terms_acceptances: the evidence columns
--
-- Phase 1 granted SELECT and INSERT. INSERT stays — `enrol_member` and
-- `accept_membership_policy_version` both write through it, and the guard
-- verifies whatever arrives — but the consent *evidence* is a different
-- sensitivity from the fact of acceptance.
--
-- A member reading their own acceptance is reading their own signature, which
-- is theirs. A staff member without `membership:view` reads nothing. That is
-- already what the Phase 1 policy says, so nothing here needs to change; what
-- does need saying is that the signature **file** is protected separately, by
-- the storage policies below, because object access does not go through this
-- table at all.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- The consent bucket
--
-- Four policies, deliberately narrow. The object path carries the membership
-- id as its second segment, which is what makes "this member's signature"
-- expressible as a predicate.
-- ---------------------------------------------------------------------------

create policy membership_consent_read_staff
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'membership-consent'
    and (select public.user_has_permission('membership:view'))
  );

create policy membership_consent_read_own
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'membership-consent'
    and exists (
      select 1
      from public.memberships m
      join public.clients c on c.id = m.client_id
      where m.id = public.storage_path_membership_id(storage.objects.name)
        and c.profile_id is not null
        and c.profile_id = (select public.current_profile_id())
    )
  );

create policy membership_consent_write_staff
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'membership-consent'
    and (select public.user_has_permission('membership:create'))
    -- The path has to name a real membership, or the read policies above
    -- would never match the object and nobody could ever see it again.
    and exists (
      select 1 from public.memberships m
      where m.id = public.storage_path_membership_id(storage.objects.name)
    )
  );

comment on policy membership_consent_write_staff on storage.objects is
  'Polytos Phase 2. A signature is uploaded by whoever may enrol, into the path of a membership that exists. There is no UPDATE or DELETE policy: a signature is evidence, and evidence is not replaced.';

-- ---------------------------------------------------------------------------
-- The views
--
-- `security_invoker = true` on each, so every policy above still applies to
-- the rows behind them. A view that ran as its owner would be a way around
-- all of it.
-- ---------------------------------------------------------------------------

grant select on public.member_savings_balances to authenticated;
grant select on public.savings_account_register to authenticated;
grant select on public.member_savings_contributions to authenticated;
