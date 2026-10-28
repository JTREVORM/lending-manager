-- ===========================================================================
-- Polytos business-policy update — rule 2: no savings withdrawal while the
-- member has an outstanding loan, of any kind
-- ===========================================================================
--
-- ## What the old `blocked` arm actually checked
--
-- Phase 2 implemented question 5's `blocked` reading as
-- `client_has_live_loan(client_id)`, which is `exists (... where status =
-- 'active')`. Two gaps, and the brief names both:
--
--   1. **An approved loan is not yet `active`.** A member loan pledges savings
--      from the moment it is approved — `savings_pledged_amount` reads
--      `('approved', 'active')` for exactly that reason — but the `blocked`
--      arm did not, so there was a window between approval and disbursement
--      in which the security could be withdrawn from under the loan. Phase 3
--      closed that window for the `above_pledged` arm and left it open here.
--
--   2. **The pledge is not the test.** The brief is explicit: "Do not permit a
--      withdrawal merely because an ordinary loan has no member-loan pledge."
--      A member may hold an ordinary loan taken out before they joined the
--      programme, with no pledge row anywhere, and the client's rule is about
--      the loan rather than about the security.
--
-- ## The test now
--
-- A loan is outstanding while its status is `approved` or `active`. That is
-- the loan state machine's own statement that the loan is not finished, and
-- mapping the rule onto it rather than onto an arithmetic balance answers
-- every case the brief lists without introducing a second opinion about what
-- "cleared" means:
--
--   - no loan at all              → `cleared`/`cancelled`/none → permitted
--   - outstanding member loan     → `active`   → blocked
--   - outstanding ordinary loan   → `active`   → blocked
--   - several loans, one open     → `active`   → blocked
--   - loan fully settled          → `cleared`  → permitted
--   - loan overdue                → `active`   → blocked
--
-- The alternative — blocking on `loan_outstanding(id) > 0` — would disagree
-- with the status machine on exactly the rows where it matters, and a
-- withdrawal permitted because the arithmetic said zero while the loan was
-- still open is the failure this rule exists to stop. The arithmetic is
-- *reported* so the refusal can say what is owed; it is not what decides.
--
-- ## Races
--
-- `request_savings_withdrawal` already takes `lock_savings_capacity` before it
-- reads anything, and `approve_loan` takes the same key. A repayment that
-- clears a loan and a withdrawal request prepared at the same moment
-- therefore serialise: the withdrawal either sees the loan open and refuses,
-- or sees it cleared and proceeds. Neither sees it half-way.
--
-- ## What this does not do
--
-- It does not touch a loan, a status, a balance or a pledge. A blocked
-- withdrawal posts nothing: no interest income, no penalty, no principal
-- adjustment, no movement in 2100 Member Savings. The refusal is a refusal.
-- ===========================================================================

create or replace function public.client_outstanding_loans(p_client_id uuid)
returns table (
  loan_id           uuid,
  loan_number       text,
  status            text,
  is_member_loan    boolean,
  principal         bigint,
  contractual_outstanding bigint,
  penalty_outstanding bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    l.id,
    l.loan_number,
    l.status,
    l.membership_id is not null,
    l.principal_amount,
    greatest(public.loan_outstanding(l.id), 0)::bigint,
    greatest(public.loan_penalty_outstanding(l.id), 0)::bigint
  from public.loans l
  where l.client_id = p_client_id
    and l.status in ('approved', 'active')
  order by l.loan_number;
$$;

comment on function public.client_outstanding_loans(uuid) is
  'Polytos policy update. Every loan of a client that is not finished — approved or active — whether it is a member loan or an ordinary one, with what the schedule and the penalties still owe. The rule that blocks a savings withdrawal reads the status; the figures are here so the refusal can say what is owed.';

grant execute on function public.client_outstanding_loans(uuid) to authenticated;

create or replace function public.client_has_outstanding_loan(p_client_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.loans l
    where l.client_id = p_client_id
      and l.status in ('approved', 'active')
  );
$$;

comment on function public.client_has_outstanding_loan(uuid) is
  'Polytos policy update. Whether a client holds any loan that is not finished — member or ordinary, approved or active. Wider than client_has_live_loan, which reads only "active" and so missed both an approved-but-undisbursed loan and the window Phase 3 had already closed elsewhere.';

grant execute on function public.client_has_outstanding_loan(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- The withdrawal path
-- ---------------------------------------------------------------------------

create or replace function public.request_savings_withdrawal(
  p_savings_account_id uuid,
  p_amount bigint,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account     public.savings_accounts;
  v_membership  public.memberships;
  v_policy      public.membership_policy_versions;
  v_actor       uuid;
  v_balance     bigint;
  v_pledged     bigint;
  v_request_id  uuid;
  v_loans       text;
  v_owed        bigint;
begin
  v_actor := public.current_profile_id();

  if v_actor is null and auth.uid() is not null then
    raise exception
      'A withdrawal request must be prepared by a signed-in member of staff.'
      using errcode = 'P0001';
  end if;

  if auth.uid() is not null
     and not public.user_has_permission('savings:request_withdrawal') then
    raise exception
      'Preparing a withdrawal requires the savings:request_withdrawal capability.'
      using errcode = 'P0001';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'A withdrawal must be more than zero shillings.'
      using errcode = 'P0001';
  end if;

  -- Polytos Phase 3. Before the account row is read, so an approval that is
  -- about to pledge these savings either goes first or waits. Taken by key
  -- rather than by row, because the capacity is a property of the account and
  -- the approval path does not touch the account row at all.
  perform public.lock_savings_capacity(p_savings_account_id);

  select * into v_account
  from public.savings_accounts where id = p_savings_account_id for update;

  if not found then
    raise exception 'No such savings account.' using errcode = 'P0001';
  end if;

  if v_account.status <> 'active' then
    raise exception
      'Savings account % is %. A withdrawal needs an active account.',
      v_account.account_number, v_account.status using errcode = 'P0001';
  end if;

  select * into v_membership
  from public.memberships where id = v_account.membership_id;

  if v_membership.status <> 'active' then
    raise exception
      'Membership % is %. A withdrawal needs an active membership.',
      v_membership.membership_number, v_membership.status using errcode = 'P0001';
  end if;

  -- The **governing** version, not the one frozen on the account. A member
  -- who has accepted new terms is held to the withdrawal rule in those terms,
  -- and reading the frozen column here would judge a transitioned member by a
  -- version they are no longer on.
  if not public.membership_policy_allows(
       public.savings_account_governing_policy(p_savings_account_id),
       'savings') then
    raise exception
      'Savings are not open under the policy version governing this account.'
      using errcode = 'P0001';
  end if;

  select * into v_policy
  from public.membership_policy_versions
  where id = public.savings_account_governing_policy(p_savings_account_id);

  select coalesce(sum(signed_amount), 0)::bigint into v_balance
  from public.savings_transactions
  where savings_account_id = p_savings_account_id;

  -- --- The client's rule about outstanding loans ---------------------------
  v_pledged := public.savings_pledged_amount(p_savings_account_id);

  if v_policy.savings_withdrawal_with_active_loan = 'blocked'
     and public.client_has_outstanding_loan(v_account.client_id) then
    -- Name them. "You have an outstanding loan" sends somebody to look it up;
    -- the loan numbers and what they owe is what the member is actually
    -- asking about when they are told no at a counter.
    select
      pg_catalog.string_agg(
        o.loan_number || ' (' || o.status || ', '
          || (o.contractual_outstanding + o.penalty_outstanding) || ' owed)',
        ', ' order by o.loan_number),
      coalesce(pg_catalog.sum(
        o.contractual_outstanding + o.penalty_outstanding), 0)::bigint
      into v_loans, v_owed
    from public.client_outstanding_loans(v_account.client_id) o;

    raise exception
      'This member has an outstanding loan, and the membership policy blocks savings withdrawals until it is fully cleared. Outstanding: %. Total owed: % shillings.',
      v_loans, v_owed
      using errcode = 'P0001';
  end if;

  if v_policy.savings_withdrawal_with_active_loan = 'above_pledged' then
    if v_pledged = 0 then
      if public.client_has_outstanding_loan(v_account.client_id)
         and v_policy.savings_to_loan_multiplier_bps is null then
        -- The Phase 2 refusal, kept, for the state it was written for: the
        -- policy says "only the excess over what secures a live loan" and no
        -- multiplier says what that is. Questions 3 and 5 are answered
        -- independently, so this combination is reachable.
        raise exception
          'The membership policy allows withdrawing only the excess over what secures a live loan, and how much that is has not been defined. Settle the savings-to-loan multiplier before withdrawing against a live loan.'
          using errcode = 'P0001';
      end if;

    -- Bound on the pledge rather than on the loan status, because a member
    -- loan pledges savings from the moment it is **approved**.
    elsif p_amount > greatest(v_balance - v_pledged, 0) then
      raise exception
        'Savings account % holds % shillings, of which % secures a member loan. At most % may be withdrawn.',
        v_account.account_number, v_balance, v_pledged,
        greatest(v_balance - v_pledged, 0)
        using errcode = 'P0001';
    end if;
  end if;

  if p_amount > v_balance then
    raise exception
      'Savings account % holds % shillings. A withdrawal of % cannot be prepared.',
      v_account.account_number, v_balance, p_amount
      using errcode = 'P0001';
  end if;

  insert into public.savings_withdrawal_requests (
    savings_account_id, membership_id, client_id, branch_id, policy_version_id,
    amount, reason, balance_at_request,
    requested_by, requested_by_label, business_date
  )
  values (
    p_savings_account_id, v_account.membership_id, v_account.client_id,
    v_account.branch_id, v_policy.id,
    p_amount, pg_catalog.btrim(p_reason), v_balance,
    v_actor, public.audit_actor_label(), public.business_date()
  )
  returning id into v_request_id;

  return v_request_id;
end;
$$;

comment on function public.request_savings_withdrawal(uuid, bigint, text) is
  'Polytos Phase 2, widened by the policy update. Prepares a withdrawal request after the account, the membership and the governing policy version all permit it. The "blocked" arm now reads every unfinished loan of the client — member or ordinary, approved or active — rather than only an active one, because the client''s rule is about the loan and not about the security. Posts nothing: a refusal moves no money.';


-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
--
-- PostgreSQL grants EXECUTE on a new function to PUBLIC, and a table created
-- in a schema `anon` can reach is reachable unless the grant is taken away.
-- Both defaults are wrong here: every table in this file is written only
-- through a SECURITY DEFINER function, and every function in it decides
-- something about money or about who may read a record.
--
-- The functions a session legitimately calls are granted back to
-- `authenticated` where they are defined. Triggers, numbering helpers and
-- notification hooks are granted back to nobody: they are called by the
-- database, and a session that could call one directly would be writing a
-- row the function assumes was validated elsewhere.

revoke all on function public.client_outstanding_loans(uuid) from public, anon;
revoke all on function public.client_has_outstanding_loan(uuid) from public, anon;
revoke all on function public.request_savings_withdrawal(uuid, bigint, text) from public, anon;
