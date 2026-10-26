-- ===========================================================================
-- Polytos Phase 3.5 — savings pledged against a member loan
--
-- ## What a pledge is, and the three things it is not
--
-- A member loan is secured against the member's savings. A pledge records
-- **how much of a member's savings capacity a particular loan consumed**, so
-- that the same shillings cannot secure two loans and so that a withdrawal
-- cannot quietly remove the security under a loan already running.
--
-- It is **not a withdrawal.** No money moves. Nothing is debited, nothing is
-- credited, and `2100 Member Savings` does not change by one shilling. The
-- business still owes the member every shilling they saved; what changes is
-- what they may take out while a loan is running.
--
-- It is **not interest income.** A pledge earns the business nothing.
--
-- It is **not a loan repayment.** The loan is collected through
-- `loan_payments` like every other loan. A pledge is never offset against a
-- balance, and nothing here touches `loan_balances`.
--
-- Those three sentences are why this table has no journal, no ledger account
-- and no `post_*` function. A pledge is a **restriction on a liability**, not
-- a movement of one, and the moment it posted anything the savings
-- reconciliation that Phase 2 proves three ways would stop footing.
--
-- ## The pledged amount is derived from the multiplier, not invented
--
-- Phase 2 refused the `above_pledged` withdrawal rule with a message saying
-- the pledged amount "needs a definition the client's documents do not give,
-- and which depends on the savings-to-loan multiplier that is itself
-- undecided". That is still exactly right, and this migration does not
-- overturn it. What it does is state the arithmetic that follows **once the
-- multiplier exists**:
--
--     a multiplier of M means savings of S support a loan of S x M
--     so a loan of P consumed P / M of savings capacity
--
-- With M = 2, a UGX 1,000,000 loan consumed UGX 500,000 of savings. That is
-- not a new rule; it is the multiplier read in the other direction, and it is
-- the only reading under which "a loan may not use the same savings capacity
-- twice" has a meaning. Division is **rounded up**, so rounding can only ever
-- over-pledge: under-pledging by a shilling would let two loans between them
-- consume more capacity than the member has.
--
-- A pledge row therefore exists only where the multiplier does. While
-- question 3 is open no member loan can be approved at all, so there is
-- nothing to pledge and `savings_pledged_amount` returns zero — truthfully,
-- because nothing is pledged, not because the answer is unknown.
--
-- ## What this unblocks
--
-- `savings_withdrawal_with_active_loan = 'above_pledged'`, the third reading
-- of question 5, which Phase 2 built as a refusal. It becomes enforceable
-- here: the withdrawable balance is the balance less what is pledged. The
-- refusal is kept for the case where the policy says `above_pledged` and the
-- multiplier is still undecided, because then there genuinely is no pledged
-- amount — and that combination is possible, since question 5 and question 3
-- are answered independently.
--
-- ## The race this exists to lose safely
--
-- A withdrawal and a loan approval can be in flight at once, and both read the
-- balance. Without a shared lock both could succeed: the approval pledges
-- savings the withdrawal is about to remove. Both paths therefore take the
-- same advisory lock, keyed on the savings account, before they read. See the
-- lock helper below, and `tests/db/member-loan-concurrency.test.ts`.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The lock both sides take
--
-- One function, so the two call sites cannot drift onto different keys — which
-- is the failure mode of an advisory lock written out twice, and it fails
-- silently by never blocking.
-- ---------------------------------------------------------------------------

create or replace function public.lock_savings_capacity(p_savings_account_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_savings_account_id is null then
    return;
  end if;

  -- Transaction-scoped, so it is released on commit or rollback and no path
  -- has to remember to unlock. The same key shape the schedule generator and
  -- the active-loan limit already use.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('savings_capacity:' || p_savings_account_id::text)
  );
end;
$$;

comment on function public.lock_savings_capacity(uuid) is
  'Polytos Phase 3. Serialises everything that reads or consumes a savings account''s lending capacity — member loan approval and savings withdrawal — on one key, so two of them cannot both succeed against the same shillings.';

revoke all on function public.lock_savings_capacity(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The pledges
-- ---------------------------------------------------------------------------

create table public.member_loan_savings_pledges (
  -- One pledge per loan, enforced structurally. A second approval of the same
  -- loan cannot pledge twice, and the primary key says so rather than a
  -- trigger.
  loan_id uuid primary key references public.loans(id) on delete restrict,

  savings_account_id uuid not null
    references public.savings_accounts(id) on delete restrict,
  membership_id uuid not null references public.memberships(id) on delete restrict,
  client_id uuid not null references public.clients(id) on delete restrict,

  -- The policy version the pledge was computed under, so the arithmetic stays
  -- explicable after the programme moves on.
  policy_version_id uuid not null
    references public.membership_policy_versions(id) on delete restrict,

  -- The savings capacity this loan consumed: the approved principal divided by
  -- the approved multiplier, rounded up.
  pledged_amount bigint not null,

  -- The inputs, frozen, so the figure above can be re-derived by a reader
  -- rather than believed.
  loan_principal bigint not null,
  multiplier_bps integer not null,
  -- The member's savings balance when the pledge was taken. Evidence, not a
  -- constraint: the balance moves afterwards and the pledge does not.
  eligible_savings_at_pledge bigint not null,

  pledged_at timestamptz not null default pg_catalog.now(),
  pledged_by uuid references public.profiles(id) on delete set null,
  pledged_by_label text not null default 'system',

  -- Released when the loan stops being a live obligation. Write-once.
  released_at timestamptz,
  released_reason text,

  constraint member_loan_pledges_amount_positive check (pledged_amount > 0),
  constraint member_loan_pledges_principal_positive check (loan_principal > 0),
  constraint member_loan_pledges_multiplier_positive check (multiplier_bps > 0),
  constraint member_loan_pledges_savings_non_negative
    check (eligible_savings_at_pledge >= 0),
  constraint member_loan_pledges_released_has_reason
    check (
      (released_at is null and released_reason is null)
      or (released_at is not null
          and released_reason is not null
          and btrim(released_reason) <> '')
    ),
  -- The arithmetic, as a constraint rather than a comment. Ceiling division in
  -- integers: `(a + b - 1) / b`. A row whose figure does not follow from its
  -- own inputs cannot be stored, by any route.
  constraint member_loan_pledges_amount_follows
    check (
      pledged_amount
        = (loan_principal * 10000 + multiplier_bps - 1) / multiplier_bps
    )
);

comment on table public.member_loan_savings_pledges is
  'Polytos Phase 3. How much of a member''s savings capacity a member loan consumed, so the same shillings cannot secure two loans and a withdrawal cannot remove the security under a running loan. A pledge moves no money: it posts no journal and does not change the 2100 Member Savings liability.';
comment on column public.member_loan_savings_pledges.pledged_amount is
  'The approved principal divided by the approved savings-to-loan multiplier, rounded up. Derived from the multiplier, not a separately decided figure.';
comment on column public.member_loan_savings_pledges.released_at is
  'When the loan stopped being a live obligation and the capacity returned to the member. Write-once.';

create index member_loan_pledges_account_idx
  on public.member_loan_savings_pledges (savings_account_id)
  where released_at is null;
create index member_loan_pledges_client_idx
  on public.member_loan_savings_pledges (client_id);
create index member_loan_pledges_membership_idx
  on public.member_loan_savings_pledges (membership_id);

-- ---------------------------------------------------------------------------
-- Append-only, bar the release
-- ---------------------------------------------------------------------------

create or replace function public.member_loan_pledges_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception
      'A savings pledge is released, never deleted: it is the record of what secured a loan.'
      using errcode = 'P0001';
  end if;

  if new.loan_id is distinct from old.loan_id
     or new.savings_account_id is distinct from old.savings_account_id
     or new.membership_id is distinct from old.membership_id
     or new.client_id is distinct from old.client_id
     or new.policy_version_id is distinct from old.policy_version_id
     or new.pledged_amount is distinct from old.pledged_amount
     or new.loan_principal is distinct from old.loan_principal
     or new.multiplier_bps is distinct from old.multiplier_bps
     or new.eligible_savings_at_pledge is distinct from old.eligible_savings_at_pledge
     or new.pledged_at is distinct from old.pledged_at
     or new.pledged_by is distinct from old.pledged_by
     or new.pledged_by_label is distinct from old.pledged_by_label then
    raise exception
      'What a loan pledged cannot be changed. It is what the business lent against.'
      using errcode = 'P0001';
  end if;

  if old.released_at is not null
     and (new.released_at is distinct from old.released_at
       or new.released_reason is distinct from old.released_reason) then
    raise exception 'A released savings pledge cannot be released again or re-pledged.'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

comment on function public.member_loan_pledges_guard() is
  'Polytos Phase 3. BEFORE UPDATE/DELETE on member_loan_savings_pledges: every figure is immutable and the release is write-once. Binds service_role too.';

revoke all on function public.member_loan_pledges_guard() from public, anon, authenticated;

create trigger member_loan_pledges_guard
  before update on public.member_loan_savings_pledges
  for each row execute function public.member_loan_pledges_guard();

create trigger member_loan_pledges_no_delete
  before delete on public.member_loan_savings_pledges
  for each statement execute function public.member_loan_pledges_guard();

-- ---------------------------------------------------------------------------
-- How much a savings account has pledged
--
-- A pledge counts while it is unreleased **and** its loan is still a live
-- obligation. Both, deliberately: the release is the explicit act, and the
-- loan status is the fact. If a loan closes and nothing released its pledge —
-- a crash between the two, a path somebody adds later — the account should not
-- stay restricted, so the loan's own status is the backstop.
--
-- `p_as_of` filters on the pledge date, so a historical assessment is not
-- changed by a pledge taken afterwards. It is the same discipline
-- `member_savings_qualification` applies to deposits, for the same reason:
-- Phase 3 approves loans against snapshots and the snapshot has to stay the
-- snapshot it took.
-- ---------------------------------------------------------------------------

create or replace function public.savings_pledged_amount(
  p_savings_account_id uuid,
  p_as_of date default null
)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(pg_catalog.sum(p.pledged_amount), 0)::bigint
  from public.member_loan_savings_pledges p
  join public.loans l on l.id = p.loan_id
  where p.savings_account_id = p_savings_account_id
    and p.released_at is null
    and l.status in ('approved', 'active')
    and (p.pledged_at at time zone 'Africa/Kampala')::date
          <= coalesce(p_as_of, public.business_date());
$$;

comment on function public.savings_pledged_amount(uuid, date) is
  'Polytos Phase 3. How much of a savings account''s balance secures live member loans, as of a date. Zero while the savings-to-loan multiplier is undecided, because then no member loan can be approved and nothing is pledged.';

revoke all on function public.savings_pledged_amount(uuid, date) from public, anon;
grant execute on function public.savings_pledged_amount(uuid, date) to authenticated;

-- ---------------------------------------------------------------------------
-- What a member may actually take out
--
-- The balance, less what is pledged, under the policy's own rule. One
-- function, so the withdrawal form, the withdrawal function and the savings
-- panel all state the same figure.
--
-- The three readings of question 5, all three now reachable:
--
--   `allowed`        the whole balance, pledge or no pledge
--   `blocked`        nothing, while a live loan exists
--   `above_pledged`  the balance less the pledged amount
--
-- And the fourth state, which is not a reading but an absence: the policy
-- says `above_pledged` and the multiplier is undecided. Then there is no
-- pledged amount to subtract, and the honest answer is NULL — "cannot be
-- determined" — rather than the whole balance, which would be the lenient
-- reading chosen by accident.
-- ---------------------------------------------------------------------------

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
  from public.membership_policy_versions where id = v_account.policy_version_id;

  select coalesce(pg_catalog.sum(signed_amount), 0)::bigint into v_balance
  from public.savings_transactions
  where savings_account_id = p_savings_account_id and value_date <= v_as_of;

  v_pledged := public.savings_pledged_amount(p_savings_account_id, v_as_of);

  -- Nothing securing anything and no running loan: the whole balance.
  if v_pledged = 0 and not public.client_has_live_loan(v_account.client_id) then
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
             when public.client_has_live_loan(v_account.client_id) then 0
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
    if not public.client_has_live_loan(v_account.client_id) then
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

comment on function public.savings_withdrawable_amount(uuid, date) is
  'Polytos Phase 3. How much of a savings account a member may withdraw today under their own policy version''s live-loan rule. NULL where the rule cannot be applied — the policy says only the excess over the pledge, and no multiplier defines the pledge.';

revoke all on function public.savings_withdrawable_amount(uuid, date) from public, anon;
grant execute on function public.savings_withdrawable_amount(uuid, date) to authenticated;

-- ---------------------------------------------------------------------------
-- The withdrawal path, with the pledge enforced
--
-- The Phase 2 body, with the `above_pledged` arm changed from a refusal to an
-- enforcement where it can be enforced, the advisory lock added so an
-- approval cannot slip between the read and the write, and the balance check
-- restated against the withdrawable amount rather than the raw balance.
--
-- Everything else is unchanged: the capability, the account status, the
-- membership status, the savings gate, the attribution.
-- ---------------------------------------------------------------------------

create or replace function public.request_savings_withdrawal(
  p_savings_account_id uuid,
  p_amount bigint,
  p_reason text
)
returns uuid
language plpgsql
volatile
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

  if not public.membership_policy_allows(v_account.policy_version_id, 'savings') then
    raise exception
      'Savings are not open under the policy version governing this account.'
      using errcode = 'P0001';
  end if;

  select * into v_policy
  from public.membership_policy_versions where id = v_account.policy_version_id;

  select coalesce(sum(signed_amount), 0)::bigint into v_balance
  from public.savings_transactions
  where savings_account_id = p_savings_account_id;

  -- --- The client's rule about live loans ---------------------------------
  v_pledged := public.savings_pledged_amount(p_savings_account_id);

  -- Phase 2's `blocked` arm, unchanged, keyed on an **active** loan exactly as
  -- it was: that is how question 5 was answered, and widening it here would be
  -- answering it differently.
  if v_policy.savings_withdrawal_with_active_loan = 'blocked'
     and public.client_has_live_loan(v_account.client_id) then
    raise exception
      'This member holds a live loan, and the membership policy blocks withdrawals while a loan is running.'
      using errcode = 'P0001';
  end if;

  if v_policy.savings_withdrawal_with_active_loan = 'above_pledged' then
    if v_pledged = 0 then
      if public.client_has_live_loan(v_account.client_id)
         and v_policy.savings_to_loan_multiplier_bps is null then
        -- The Phase 2 refusal, kept, for the state it was written for: the
        -- policy says "only the excess over what secures the loan" and no
        -- multiplier says what that is. Questions 3 and 5 are answered
        -- independently, so this combination is reachable.
        raise exception
          'The membership policy allows withdrawing only the excess over what secures a live loan, and how much that is has not been defined. Settle the savings-to-loan multiplier before withdrawing against a live loan.'
          using errcode = 'P0001';
      end if;

    -- Bound on the pledge rather than on `client_has_live_loan`, because a
    -- member loan pledges savings from the moment it is **approved** and
    -- `client_has_live_loan` only sees `active`. Keyed on the live-loan test
    -- instead, a member could withdraw the security out from under an
    -- approved loan in the window before it was disbursed.
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
    v_account.branch_id, v_account.policy_version_id,
    p_amount, pg_catalog.btrim(p_reason), v_balance,
    v_actor, public.audit_actor_label(), public.business_date()
  )
  returning id into v_request_id;

  return v_request_id;
end;
$$;

comment on function public.request_savings_withdrawal(uuid, bigint, text) is
  'Polytos Phase 2, extended in Phase 3. Prepares a withdrawal for review: checks the account, the membership, the savings gate, the policy''s live-loan rule including the pledged amount, and the balance. Takes the savings-capacity lock, so a member loan approval cannot pledge the same shillings concurrently. Decides nothing.';

revoke all on function public.request_savings_withdrawal(uuid, bigint, text) from public, anon;
grant execute on function public.request_savings_withdrawal(uuid, bigint, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Releasing a pledge when the loan stops being live
--
-- A trigger on `loans`, not a step somebody calls. The capacity returning to
-- the member is a consequence of the loan closing, in the same way the
-- schedule is a consequence of disbursement — and a release that had to be
-- remembered is a release that would eventually be forgotten, leaving a
-- member unable to touch savings against a loan they repaid years ago.
-- ---------------------------------------------------------------------------

create or replace function public.member_loan_release_pledge()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = old.status then
    return new;
  end if;

  -- Still a live obligation. `approved` and `active` are the two states in
  -- which the business is exposed; everything else — completed, defaulted,
  -- written off, cancelled, rejected — is not.
  if new.status in ('approved', 'active') then
    return new;
  end if;

  update public.member_loan_savings_pledges
     set released_at = pg_catalog.now(),
         released_reason = 'Loan ' || new.loan_number || ' became ' || new.status || '.'
   where loan_id = new.id
     and released_at is null;

  return new;
end;
$$;

comment on function public.member_loan_release_pledge() is
  'Polytos Phase 3. AFTER UPDATE on loans: when a loan stops being a live obligation, the savings capacity it pledged returns to the member. A consequence of closure, never a step somebody has to remember.';

revoke all on function public.member_loan_release_pledge() from public, anon, authenticated;

create trigger member_loan_release_pledge
  after update of status on public.loans
  for each row execute function public.member_loan_release_pledge();
