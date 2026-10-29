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
security invoker
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
security invoker
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

-- The displayed withdrawable amount uses the same governing terms and loan test.
create or replace function public.savings_withdrawable_amount(
  p_savings_account_id uuid,
  p_as_of date default null
)
returns bigint
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_account public.savings_accounts;
  v_policy  public.membership_policy_versions;
  v_balance bigint;
  v_pledged bigint;
  v_as_of   date;
begin
  v_as_of := coalesce(p_as_of, public.business_date());

  select * into v_account from public.savings_accounts where id = p_savings_account_id;
  if not found then
    return null;
  end if;

  select * into v_policy
  from public.membership_policy_versions where id = public.savings_account_governing_policy(v_account.id, v_as_of);

  select coalesce(pg_catalog.sum(signed_amount), 0)::bigint into v_balance
  from public.savings_transactions
  where savings_account_id = p_savings_account_id and value_date <= v_as_of;

  v_pledged := public.savings_pledged_amount(p_savings_account_id, v_as_of);

  -- Nothing securing anything and no running loan: the whole balance.
  if v_pledged = 0 and not public.client_has_outstanding_loan(v_account.client_id) then
    return v_balance;
  end if;

  if v_policy.savings_withdrawal_with_active_loan is null then
    return null;
  end if;

  if v_policy.savings_withdrawal_with_active_loan = 'allowed' then
    return v_balance;
  end if;

  if v_policy.savings_withdrawal_with_active_loan = 'blocked' then
    -- Phase 2's rule, unchanged: "while a member loan is **active**". An
    -- approved loan the business has not yet paid out does not block a
    -- withdrawal under this reading, and widening it here would be answering
    -- question 5 differently from the way Phase 2 answered it.
    return case
             when public.client_has_outstanding_loan(v_account.client_id) then 0
             else v_balance
           end;
  end if;

  -- above_pledged. Bound on the **pledge**, not on `client_has_live_loan`,
  -- and the difference is a real hole rather than a nicety: a member loan
  -- pledges savings from the moment it is approved, and `client_has_live_loan`
  -- only sees `active`. Keyed on the live-loan test instead, a member could
  -- withdraw the security out from under an approved loan in the window
  -- before it was disbursed.
  if v_pledged = 0 then
    if not public.client_has_outstanding_loan(v_account.client_id) then
      return v_balance;
    end if;

    if v_policy.savings_to_loan_multiplier_bps is null then
      -- No multiplier, so no pledged amount, so no excess over it. NULL rather
      -- than the balance: see the head of this section.
      return null;
    end if;

    return v_balance;
  end if;

  return greatest(v_balance - v_pledged, 0);
end;
$$;
create or replace function public.post_savings_withdrawal(
  p_request_id uuid,
  p_payment_method text,
  p_external_reference text,
  p_idempotency_key uuid
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_request   public.savings_withdrawal_requests;
  v_withdrawable bigint;
  v_policy_id uuid;
  v_account   public.savings_accounts;
  v_actor     uuid;
  v_label     text;
  v_reference text;
  v_txn_id    uuid;
  v_cash      uuid;
  v_liability uuid;
  v_entry_id  uuid;
  v_balance   bigint;
  v_date      date;
begin
  v_actor := public.current_profile_id();
  v_label := public.audit_actor_label();

  -- Authorisation above the replay shortcut, for the reason set out in
  -- `post_savings_deposit`: the early return reads a movement, so it has to
  -- sit behind the check that decides whether this caller may see one.
  if v_actor is null and auth.uid() is not null then
    raise exception
      'A withdrawal must be paid by a signed-in member of staff.'
      using errcode = 'P0001';
  end if;

  if auth.uid() is not null
     and not public.user_has_permission('savings:post_withdrawal') then
    raise exception
      'Paying a withdrawal requires the savings:post_withdrawal capability.'
      using errcode = 'P0001';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('savings_txn_key:' || p_idempotency_key::text)
  );

  select id into v_txn_id
  from public.savings_transactions where idempotency_key = p_idempotency_key;

  if v_txn_id is not null then
    return v_txn_id;
  end if;

  select * into v_request
  from public.savings_withdrawal_requests where id = p_request_id for update;

  if not found then
    raise exception 'No such withdrawal request.' using errcode = 'P0001';
  end if;

  if v_request.status <> 'approved' then
    raise exception
      'Withdrawal request % is %. Only an approved request is paid.',
      v_request.request_number, v_request.status using errcode = 'P0001';
  end if;

  if not public.user_can_see_branch(v_request.branch_id) then
    raise exception 'You cannot pay that branch''s withdrawal.' using errcode = '42501';
  end if;

  perform public.lock_savings_capacity(v_request.savings_account_id);

  -- The account lock. Everything below reads the balance, so it is taken
  -- before the balance is read and held until the transaction commits.
  select * into v_account
  from public.savings_accounts where id = v_request.savings_account_id for update;

  if v_account.status <> 'active' then
    raise exception
      'Savings account % is %.', v_account.account_number, v_account.status
      using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from public.memberships m
    where m.id = v_account.membership_id and m.status = 'active'
  ) then
    raise exception 'A withdrawal needs an active membership.' using errcode = 'P0001';
  end if;

  v_policy_id := public.savings_account_governing_policy(v_account.id);
  if not public.membership_policy_allows(v_policy_id, 'savings') then
    raise exception 'Savings are not open under the governing policy.' using errcode = 'P0001';
  end if;

  v_withdrawable := public.savings_withdrawable_amount(v_account.id);
  if v_withdrawable is null or v_request.amount > v_withdrawable then
    raise exception 'An outstanding loan or savings pledge now blocks this withdrawal.'
      using errcode = 'P0001';
  end if;

  -- The check that counts. The balance at request time was informative; this
  -- one is holding a lock, so a deposit withdrawn twice and two approved
  -- requests racing each other both stop here.
  select coalesce(sum(signed_amount), 0)::bigint into v_balance
  from public.savings_transactions
  where savings_account_id = v_request.savings_account_id;

  if v_request.amount > v_balance then
    raise exception
      'Savings account % now holds % shillings, which is less than the % approved. The balance moved after the decision.',
      v_account.account_number, v_balance, v_request.amount
      using errcode = 'P0001';
  end if;

  if p_payment_method not in ('cash', 'mtn_mobile_money', 'airtel_money', 'bank') then
    raise exception 'Unknown payment method "%".', p_payment_method
      using errcode = 'P0001';
  end if;

  v_reference := pg_catalog.upper(pg_catalog.btrim(coalesce(p_external_reference, '')));
  if v_reference = '' then
    v_reference := null;
  end if;

  if p_payment_method = 'cash' then
    if v_reference is not null then
      raise exception
        'A cash withdrawal has no network reference. Its transaction number is its reference.'
        using errcode = 'P0001';
    end if;
  elsif v_reference is null then
    raise exception
      'A % withdrawal needs the reference from the network or the bank.',
      p_payment_method using errcode = 'P0001';
  elsif char_length(v_reference) < 4 then
    raise exception
      'That transaction reference is too short to identify a withdrawal.'
      using errcode = 'P0001';
  end if;

  v_cash := public.branch_cash_account(
    v_account.branch_id, public.payment_method_cash_kind(p_payment_method));
  v_liability := public.ledger_account_by_code('2100');
  v_date := public.business_date();
  v_txn_id := pg_catalog.gen_random_uuid();

  v_entry_id := public.post_journal(
    v_account.branch_id,
    v_date,
    'Member savings withdrawal — ' || v_account.account_number,
    'savings_withdrawal',
    v_txn_id,
    null,
    v_account.client_id,
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'account_id', v_liability, 'debit', v_request.amount, 'credit', 0,
        'memo', 'Member savings — ' || v_account.account_number),
      pg_catalog.jsonb_build_object(
        'account_id', v_cash, 'debit', 0, 'credit', v_request.amount,
        'memo', 'Savings paid out')
    ),
    null, v_actor, v_label
  );

  insert into public.savings_transactions (
    id, savings_account_id, membership_id, client_id, branch_id,
    kind, amount, payment_method, cash_account_id, external_reference,
    idempotency_key, value_date, journal_entry_id, withdrawal_request_id,
    recorded_by, recorded_by_label
  )
  values (
    v_txn_id, v_request.savings_account_id, v_request.membership_id,
    v_request.client_id, v_request.branch_id,
    'withdrawal', v_request.amount, p_payment_method, v_cash, v_reference,
    p_idempotency_key, v_date, v_entry_id, p_request_id, v_actor, v_label
  );

  update public.savings_withdrawal_requests
     set status = 'paid',
         paid_transaction_id = v_txn_id,
         paid_at = pg_catalog.now()
   where id = p_request_id;

  return v_txn_id;
end;
$$;
create or replace function public.approve_loan(p_loan_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_capacity_account_id uuid;
  v_loan      public.loans;
  v_client    public.clients;
  v_product   public.loan_products;
  v_rate_bps  integer;
  v_method    text;
  v_basis     text;
  v_failures  text;
  v_total_interest bigint;
  v_total_expected bigint;
  v_actor     uuid;
  v_member    record;
  v_policy    public.membership_policy_versions;
  v_pledged   bigint;
  -- Held separately from `v_member` because the UPDATE below runs for every
  -- product, and PL/pgSQL substitutes a record's fields into a statement
  -- eagerly: referencing `v_member.membership_id` inside a CASE would raise
  -- "record is not assigned yet" on every ordinary loan, whichever arm of the
  -- CASE would have been taken.
  v_membership_id uuid;
begin
  v_actor := public.current_profile_id();

  select * into v_loan from public.loans where id = p_loan_id for update;

  if not found then
    raise exception 'No such loan.' using errcode = 'P0001';
  end if;

  if v_loan.status <> 'pending_approval' then
    raise exception
      'Only a loan awaiting approval can be approved; this one is %.', v_loan.status
      using errcode = 'P0001';
  end if;

  if auth.uid() is not null and not public.user_has_permission('loans:approve') then
    raise exception 'Approving a loan requires the loans:approve capability.'
      using errcode = 'P0001';
  end if;

  select * into v_client from public.clients where id = v_loan.client_id;
  select * into v_product from public.loan_products where id = v_loan.loan_product_id;

  if v_product.id is null then
    raise exception 'Loan % names no product, so it has no terms to approve.',
      v_loan.loan_number using errcode = 'P0001';
  end if;

  -- --- Polytos Phase 3: the capacity lock, before validation -------------
  --
  -- Taken here rather than after validation, which is the whole point. Two
  -- approvals that each validated against the same untouched savings balance
  -- and then each pledged it would both succeed, and the member's savings
  -- would secure twice what they can. The lock makes the second approval
  -- validate against a balance the first has already pledged against, so it
  -- is refused by `member_amount_above_ceiling` rather than by a constraint
  -- nobody can explain.
  for v_capacity_account_id in
    select sa.id from public.savings_accounts sa
    where sa.client_id = v_loan.client_id order by sa.id
  loop
    perform public.lock_savings_capacity(v_capacity_account_id);
  end loop;

  if coalesce(v_product.requires_membership, false) then
    perform public.lock_savings_capacity((
      select sa.id
      from public.savings_accounts sa
      join public.memberships m on m.id = sa.membership_id
      where m.client_id = v_loan.client_id
        and m.status in ('pending', 'active', 'suspended')
    ));
  end if;

  select pg_catalog.string_agg(failure_code, ', ' order by failure_code)
    into v_failures
  from public.validate_loan_for_approval(p_loan_id);

  if v_failures is not null then
    raise exception 'This loan cannot be approved: %', v_failures
      using errcode = 'P0001';
  end if;

  -- --- The price ----------------------------------------------------------
  if v_product.interest_source = 'membership_policy' then
    -- Polytos Phase 3. From the borrower's own frozen version. Validation has
    -- already established that the member exists, that lending is open under
    -- that version — which requires all three pricing decisions to have been
    -- made — and that the amount, term and cadence are permitted.
    select * into v_member
    from public.member_loan_eligibility_of(
      v_loan.client_id,
      v_loan.principal_amount,
      v_loan.loan_term_months,
      v_loan.repayment_frequency,
      public.business_date()
    );

    if v_member.membership_id is null or not v_member.may_proceed then
      -- Unreachable while validation runs immediately above, and asserted
      -- anyway: this is the statement that stops a future edit reordering the
      -- two and pricing a loan nobody was eligible for.
      raise exception
        'Loan % is priced from a membership policy but the borrower is not eligible. This is a defect: validation should have refused it.',
        v_loan.loan_number using errcode = 'P0001';
    end if;

    select * into v_policy
    from public.membership_policy_versions where id = v_member.policy_version_id;

    v_rate_bps      := v_policy.member_loan_interest_rate_bps;
    v_basis         := v_policy.interest_basis;
    v_method        := v_policy.interest_method;
    v_membership_id := v_member.membership_id;

    -- An override is impossible for a policy-priced product — a CHECK
    -- constraint refuses `interest_override_allowed` on one — but a proposed
    -- rate on the application would otherwise be silently ignored, and a
    -- silently ignored rate is a quote the business did not honour.
    if v_loan.proposed_interest_rate_bps is not null
       and v_loan.proposed_interest_rate_bps <> v_rate_bps then
      raise exception
        'A member loan is priced at the % bp its membership policy version sets; this application proposes % bp.',
        v_rate_bps, v_loan.proposed_interest_rate_bps
        using errcode = 'P0001';
    end if;
  else
    v_rate_bps := coalesce(v_loan.proposed_interest_rate_bps, v_product.default_interest_rate_bps);
    v_method   := v_product.interest_method;
    v_basis    := null;

    if v_rate_bps <> v_product.default_interest_rate_bps then
      if not v_product.interest_override_allowed then
        raise exception
          '% does not permit a rate other than its standard %.',
          v_product.name, v_product.default_interest_rate_bps
          using errcode = 'P0001';
      end if;

      if v_rate_bps < v_product.min_interest_rate_bps
         or v_rate_bps > v_product.max_interest_rate_bps then
        raise exception
          'A rate of % bp is outside what % permits (% to % bp).',
          v_rate_bps, v_product.name,
          v_product.min_interest_rate_bps, v_product.max_interest_rate_bps
          using errcode = 'P0001';
      end if;
    end if;
  end if;

  if v_loan.principal_amount < v_product.min_amount
     or v_loan.principal_amount > v_product.max_amount then
    raise exception
      '% lends between % and %; this application is for %.',
      v_product.name, v_product.min_amount, v_product.max_amount,
      v_loan.principal_amount
      using errcode = 'P0001';
  end if;

  if v_loan.loan_term_months < v_product.min_term_months
     or v_loan.loan_term_months > v_product.max_term_months then
    raise exception
      '% runs for % to % months; this application is for %.',
      v_product.name, v_product.min_term_months, v_product.max_term_months,
      v_loan.loan_term_months
      using errcode = 'P0001';
  end if;

  if v_product.allowed_term_months is not null
     and not (v_loan.loan_term_months = any (v_product.allowed_term_months)) then
    raise exception
      '% is not a duration % offers.', v_loan.loan_term_months, v_product.name
      using errcode = 'P0001';
  end if;

  if not (v_loan.repayment_frequency = any (v_product.allowed_repayment_frequencies)) then
    raise exception
      '% does not offer the % repayment cadence.',
      v_product.name, v_loan.repayment_frequency
      using errcode = 'P0001';
  end if;

  -- --- The breakdown ------------------------------------------------------
  -- One engine call either way. For an ordinary loan the arguments make
  -- `member_loan_interest` delegate straight to `calculate_loan_breakdown`,
  -- which is the function that produced every existing agreement — so this is
  -- the same arithmetic reached by one more frame, not a second engine.
  if v_basis is null then
    select pg_catalog.sum(b.interest) into v_total_interest
    from public.calculate_loan_breakdown(
      v_loan.principal_amount, v_rate_bps, v_loan.loan_term_months
    ) b;
  else
    select pg_catalog.sum(b.interest) into v_total_interest
    from public.member_loan_interest(
      v_loan.principal_amount, v_rate_bps, v_loan.loan_term_months,
      v_basis, v_method
    ) b;
  end if;

  v_total_expected := v_loan.principal_amount + v_total_interest;

  if v_basis is null then
    insert into public.loan_periods (
      loan_id, period_number, opening_principal,
      principal_portion, interest, total_obligation, closing_principal
    )
    select
      p_loan_id, b.period_number, b.opening_principal,
      b.principal_portion, b.interest, b.total_obligation, b.closing_principal
    from public.calculate_loan_breakdown(
      v_loan.principal_amount, v_rate_bps, v_loan.loan_term_months
    ) b;
  else
    insert into public.loan_periods (
      loan_id, period_number, opening_principal,
      principal_portion, interest, total_obligation, closing_principal
    )
    select
      p_loan_id, b.period_number, b.opening_principal,
      b.principal_portion, b.interest, b.total_obligation, b.closing_principal
    from public.member_loan_interest(
      v_loan.principal_amount, v_rate_bps, v_loan.loan_term_months,
      v_basis, v_method
    ) b;
  end if;

  insert into public.loan_client_snapshots (
    loan_id, client_id, client_number, full_name, phone, alternative_phone,
    sex, date_of_birth, occupation, business_type, village_area, district,
    client_status_at_origination
  )
  values (
    p_loan_id, v_client.id, v_client.client_number, v_client.full_name,
    v_client.phone, v_client.alternative_phone, v_client.sex,
    v_client.date_of_birth, v_client.occupation, v_client.business_type,
    v_client.village_area, v_client.district, v_client.status
  );

  -- --- The guarantors, frozen onto the application's own rows -------------
  update public.loan_guarantors lg
     set snapshot_full_name = src.full_name,
         snapshot_phone = src.phone,
         snapshot_alternative_phone = src.alternative_phone,
         snapshot_sex = src.sex,
         snapshot_date_of_birth = src.date_of_birth,
         snapshot_occupation = src.occupation,
         snapshot_location = src.location,
         snapshot_district = src.district,
         snapshot_had_photograph = src.had_photograph,
         snapshot_had_identification = src.had_identification,
         snapshot_at = pg_catalog.now()
    from (
      select
        lg2.id,
        coalesce(c.full_name, g.full_name) as full_name,
        coalesce(c.phone, g.phone) as phone,
        coalesce(c.alternative_phone, g.alternative_phone) as alternative_phone,
        coalesce(c.sex, g.sex) as sex,
        coalesce(c.date_of_birth, g.date_of_birth) as date_of_birth,
        coalesce(c.occupation, g.occupation) as occupation,
        coalesce(c.village_area, g.location) as location,
        coalesce(c.district, g.district) as district,
        coalesce(g.photo_path is not null, false) as had_photograph,
        case
          when lg2.guarantor_client_id is not null
            then exists (select 1 from public.client_identities ci
                          where ci.client_id = lg2.guarantor_client_id)
          else exists (select 1 from public.guarantor_identities gi
                        where gi.guarantor_id = lg2.guarantor_id)
        end as had_identification
      from public.loan_guarantors lg2
      left join public.clients c on c.id = lg2.guarantor_client_id
      left join public.guarantors g on g.id = lg2.guarantor_id
      where lg2.loan_id = p_loan_id and lg2.snapshot_at is null
    ) src
   where src.id = lg.id;

  -- --- The identity snapshots, into the protected table ------------------
  insert into public.loan_identity_snapshots (loan_id, subject_type, subject_id, nin)
  select p_loan_id, 'client', ci.client_id, ci.nin
  from public.client_identities ci
  where ci.client_id = v_client.id
  union all
  select p_loan_id, 'guarantor', g.id, gi.nin
  from public.loan_guarantors lg
  join public.guarantors g on g.id = lg.guarantor_id
  join public.guarantor_identities gi on gi.guarantor_id = g.id
  where lg.loan_id = p_loan_id
  union all
  select p_loan_id, 'client', ci.client_id, ci.nin
  from public.loan_guarantors lg
  join public.client_identities ci on ci.client_id = lg.guarantor_client_id
  where lg.loan_id = p_loan_id
  on conflict (loan_id, subject_type, subject_id) do nothing;

  update public.loans
     set status = 'approved',
         interest_rate_bps = v_rate_bps,
         interest_method = v_method,
         interest_basis = v_basis,
         membership_id = v_membership_id,
         total_interest = v_total_interest,
         total_expected_repayment = v_total_expected,
         min_loan_amount_applied = v_product.min_amount,
         max_loan_amount_applied = v_product.max_amount,
         grace_period_days_applied = v_product.grace_period_days,
         penalty_rate_bps_applied = v_product.penalty_rate_bps
   where id = p_loan_id;

  perform public.capture_loan_product_snapshot(p_loan_id);

  -- --- Polytos Phase 3: the evidence and the pledge ----------------------
  -- After the loan is `approved`, because the pledge's own guard reads the
  -- loan's status to decide whether the capacity is live.
  if coalesce(v_product.requires_membership, false) then
    v_pledged := coalesce(v_member.pledged_savings, 0);

    insert into public.member_loan_eligibility_snapshots (
      loan_id, membership_id, membership_number, client_id,
      policy_version_id, policy_version,
      savings_account_id, savings_account_number,
      assessed_on,
      months_required, must_be_consecutive,
      qualifying_months, consecutive_qualifying_months,
      eligible_savings, multiplier_bps, max_eligible_loan,
      interest_rate_bps, interest_basis, interest_method,
      max_term_months, required_cadence,
      amount_requested, term_requested, repayment_frequency,
      active_loan_count, outstanding_principal, pledged_savings_before,
      pending_withdrawals_before, available_savings,
      captured_by, captured_by_label
    )
    values (
      p_loan_id, v_member.membership_id, v_member.membership_number, v_loan.client_id,
      v_member.policy_version_id, v_member.policy_version,
      v_member.savings_account_id, v_member.savings_account_number,
      v_member.as_of,
      v_member.months_required, v_member.must_be_consecutive,
      v_member.qualifying_months, v_member.consecutive_qualifying_months,
      v_member.eligible_savings, v_member.multiplier_bps, v_member.max_eligible_loan,
      v_rate_bps, v_basis, v_method,
      v_member.max_term_months, v_member.required_cadence,
      v_loan.principal_amount, v_loan.loan_term_months, v_loan.repayment_frequency,
      v_member.active_loan_count, v_member.outstanding_principal, v_pledged,
      coalesce(v_member.pending_withdrawals, 0), v_member.available_savings,
      v_actor, public.audit_actor_label()
    );

    insert into public.member_loan_savings_pledges (
      loan_id, savings_account_id, membership_id, client_id, policy_version_id,
      pledged_amount, loan_principal, multiplier_bps, eligible_savings_at_pledge,
      pledged_by, pledged_by_label
    )
    values (
      p_loan_id, v_member.savings_account_id, v_member.membership_id,
      v_loan.client_id, v_member.policy_version_id,
      (v_loan.principal_amount * 10000 + v_member.multiplier_bps - 1)
        / v_member.multiplier_bps,
      v_loan.principal_amount, v_member.multiplier_bps, v_member.eligible_savings,
      v_actor, public.audit_actor_label()
    );

    -- The invariant the whole pledge mechanism exists for, asserted inside the
    -- transaction that could break it: a member's live pledges may never
    -- exceed the savings they hold. A failure rolls the approval back.
    if public.savings_pledged_amount(v_member.savings_account_id)
         > v_member.eligible_savings then
      raise exception
        'Approving this loan would pledge % of savings against a balance of %. The member''s savings cannot secure more than they hold.',
        public.savings_pledged_amount(v_member.savings_account_id),
        v_member.eligible_savings
        using errcode = 'P0001';
    end if;
  end if;

  return p_loan_id;
end;
$$;
