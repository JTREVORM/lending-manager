-- ===========================================================================
-- Polytos Phase 3.8 — Row Level Security, the read surfaces, and the wrapper
--
-- ## The shape, following Phase 1 and Phase 2 exactly
--
-- Every policy routes through `user_has_permission()` with the capability as a
-- constant argument wrapped in a scalar subquery, because a bare function call
-- in a policy predicate is evaluated per candidate row — the Phase 18 finding
-- that turned one register read into 20,524 permission checks and 3.2 seconds.
-- `tests/db/rls-hoisting.test.ts` fails the build on a bare call.
--
-- The branch rule is **restated** with `current_user_branch_id()` hoisted
-- rather than delegated to `user_can_see_branch`, for the same reason.
--
-- ## Who reads what
--
--   `member_loan_eligibility_snapshots`  staff holding `loans:view`, within
--                                        their branch; and the borrower,
--                                        because it is the evidence behind a
--                                        decision about them
--   `member_loan_savings_pledges`        staff holding `savings:view` or
--                                        `loans:view`, within their branch;
--                                        and the member, because it is their
--                                        own savings that are restricted
--
-- A member reading their own pledge is deliberate: the figure answers "why
-- can I only take out part of my savings", and a member who cannot see it has
-- to ring the office to be told something about their own money.
--
-- A member reading their own **eligibility assessment snapshot** is likewise
-- deliberate, and is different from reading a live *assessment*: the snapshot
-- is what the business relied on when it decided, which they are entitled to;
-- a live assessment is an offer, and `member_loans:view_eligibility` governs
-- that. The two are separate surfaces for that reason.
--
-- ## No write policy on either table
--
-- Neither is granted INSERT, UPDATE or DELETE to `authenticated`, by any
-- role. Both are written only by `approve_loan` and the release trigger, both
-- SECURITY DEFINER. There is therefore no path for a session to write a
-- pledge or forge a snapshot at all — not a narrow one guarded by a
-- capability, none. That is the same arrangement `loan_periods` and
-- `loan_product_snapshots` have, and for the same reason: nobody *performs*
-- these acts, they are consequences of an approval.
-- ===========================================================================

alter table public.member_loan_eligibility_snapshots enable row level security;
alter table public.member_loan_savings_pledges enable row level security;

-- ---------------------------------------------------------------------------
-- member_loan_eligibility_snapshots
-- ---------------------------------------------------------------------------

-- Nothing beyond SELECT, to anybody. Both tables are written by
-- `approve_loan` and the release trigger, both SECURITY DEFINER, so the
-- privilege a session would need simply does not exist.
revoke all on table public.member_loan_eligibility_snapshots from anon, authenticated;
grant select on table public.member_loan_eligibility_snapshots to authenticated;

create policy member_loan_snapshots_select
  on public.member_loan_eligibility_snapshots
  for select
  to authenticated
  using (
    (
      (select public.user_has_permission('loans:view'))
      or exists (
        select 1
        from public.clients c
        where c.id = member_loan_eligibility_snapshots.client_id
          and c.profile_id is not null
          and c.profile_id = (select public.current_profile_id())
      )
    )
    and (
      -- The branch rule, restated against the loan the snapshot belongs to.
      -- A snapshot has no branch of its own: it is a fact about a loan, and
      -- the loan's branch is the one that decides who may see it.
      (select public.current_user_branch_id()) is null
      or exists (
        select 1 from public.loans l
        where l.id = member_loan_eligibility_snapshots.loan_id
          and (l.branch_id is null
               or l.branch_id = (select public.current_user_branch_id()))
      )
    )
  );

comment on policy member_loan_snapshots_select on public.member_loan_eligibility_snapshots is
  'Staff holding loans:view read the evidence behind a member loan approval, within their branch. The borrower reads their own, because it is the record of a decision about them. Nobody writes it: it is written by approve_loan alone.';

-- ---------------------------------------------------------------------------
-- member_loan_savings_pledges
-- ---------------------------------------------------------------------------

revoke all on table public.member_loan_savings_pledges from anon, authenticated;
grant select on table public.member_loan_savings_pledges to authenticated;

create policy member_loan_pledges_select
  on public.member_loan_savings_pledges
  for select
  to authenticated
  using (
    (
      (select public.user_has_permission('savings:view'))
      or (select public.user_has_permission('loans:view'))
      or exists (
        select 1
        from public.clients c
        where c.id = member_loan_savings_pledges.client_id
          and c.profile_id is not null
          and c.profile_id = (select public.current_profile_id())
      )
    )
    and (
      (select public.current_user_branch_id()) is null
      or exists (
        select 1 from public.savings_accounts sa
        where sa.id = member_loan_savings_pledges.savings_account_id
          and (sa.branch_id is null
               or sa.branch_id = (select public.current_user_branch_id()))
      )
    )
  );

comment on policy member_loan_pledges_select on public.member_loan_savings_pledges is
  'Staff holding savings:view or loans:view read what secures a member loan, within their branch. The member reads their own, because it is their savings that are restricted and they are entitled to know by how much.';

-- ===========================================================================
-- The read surfaces
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- member_loan_eligibility — the register of who may borrow
--
-- One row per live membership, with the assessment already computed, so the
-- Member Loans dashboard and the eligibility panel are one read rather than a
-- function call per member. `security_invoker = true`, so the policies on
-- `memberships`, `savings_accounts` and `savings_transactions` filter the rows
-- beneath it rather than being bypassed — which is what stops a view becoming
-- a hole under every policy it reads through.
--
-- Deliberately **not** a call to `member_loan_eligibility_of` per row: that
-- function is SECURITY DEFINER and unreachable from a session, and a view
-- that invoked it per row would both defeat the invoker filtering and make
-- the register a function call per member. The columns here are therefore the
-- same facts assembled as one grouped query — the shape `loan_balances` and
-- `member_savings_balances` already use — and `tests/db/member-loan-eligibility.test.ts`
-- asserts the view and the function agree for every member in the database.
-- ---------------------------------------------------------------------------

create view public.member_loan_eligibility with (security_invoker = true) as
with savings as (
  select
    sa.id                                                as savings_account_id,
    sa.membership_id,
    sa.account_number,
    sa.status                                            as savings_account_status,
    coalesce(pg_catalog.sum(t.signed_amount), 0)::bigint  as balance
  from public.savings_accounts sa
  left join public.savings_transactions t
    on t.savings_account_id = sa.id
   and t.value_date <= public.business_date()
  group by sa.id, sa.membership_id, sa.account_number, sa.status
),
qualifying as (
  select
    c.savings_account_id,
    pg_catalog.count(*) filter (where c.meets_minimum)::integer as qualifying_months
  from public.member_savings_contributions c
  where c.contribution_month <= pg_catalog.date_trunc('month', public.business_date())::date
  group by c.savings_account_id
),
pending_out as (
  -- What the member has asked for and a supervisor has approved but nobody
  -- has paid yet. Still in the balance, and not available to secure a loan,
  -- because it is on its way out.
  select
    r.savings_account_id,
    pg_catalog.sum(r.amount)::bigint as pending
  from public.savings_withdrawal_requests r
  where r.status in ('pending', 'approved')
  group by r.savings_account_id
),
obligations as (
  select
    l.client_id,
    pg_catalog.count(*) filter (where l.status = 'active')::integer as active_loan_count,
    pg_catalog.count(*) filter (
      where l.status in ('approved', 'active') and l.membership_id is not null
    )::integer                                                      as member_loan_count,
    coalesce(pg_catalog.sum(b.principal_remaining) filter (
      where l.status = 'active'), 0)::bigint                        as outstanding_principal
  from public.loans l
  left join public.loan_balances b on b.loan_id = l.id
  group by l.client_id
)
select
  m.id                                        as membership_id,
  m.membership_number,
  m.client_id,
  m.branch_id,
  m.status                                    as membership_status,
  cl.full_name,
  cl.client_number,
  v.id                                        as policy_version_id,
  v.version                                   as policy_version,
  v.savings_qualifying_months                 as months_required,
  v.qualifying_months_consecutive             as must_be_consecutive,
  v.savings_to_loan_multiplier_bps            as multiplier_bps,
  v.member_loan_interest_rate_bps             as interest_rate_bps,
  v.interest_basis,
  v.interest_method,
  v.member_loan_max_term_months               as max_term_months,
  v.member_loan_weekly_cadence_max_months     as weekly_cadence_max_months,
  v.is_member_lending_enabled                 as policy_lending_ready,
  public.membership_policy_allows(v.id, 'lending') as policy_lending_open,
  s.savings_account_id,
  s.account_number                            as savings_account_number,
  s.savings_account_status,
  coalesce(s.balance, 0)::bigint              as eligible_savings,
  coalesce(q.qualifying_months, 0)            as qualifying_months,
  -- The ceiling, and NULL where the multiplier is undecided. Never a default:
  -- a figure here would be an invented credit limit, and a register showing
  -- one would have staff quoting it.
  case
    when v.savings_to_loan_multiplier_bps is null then null
    else least(
      (greatest(
         coalesce(s.balance, 0)
           - coalesce(public.savings_pledged_amount(
               s.savings_account_id, public.business_date()), 0)
           - coalesce(w.pending, 0),
         0
       ) * v.savings_to_loan_multiplier_bps) / 10000,
      bs.max_loan_amount
    )
  end::bigint                                 as max_eligible_loan,
  coalesce(
    public.savings_pledged_amount(s.savings_account_id, public.business_date()), 0
  )::bigint                                   as pledged_savings,
  coalesce(w.pending, 0)::bigint              as pending_withdrawals,
  greatest(
    coalesce(s.balance, 0)
      - coalesce(public.savings_pledged_amount(
          s.savings_account_id, public.business_date()), 0)
      - coalesce(w.pending, 0),
    0
  )::bigint                                   as available_savings,
  coalesce(o.active_loan_count, 0)            as active_loan_count,
  coalesce(o.member_loan_count, 0)            as member_loan_count,
  coalesce(o.outstanding_principal, 0)::bigint as outstanding_principal,
  bs.max_active_loans_per_client              as active_loan_limit,
  -- Qualified on the savings record alone, under this member's own rule. The
  -- register's "qualified" count, which is a different question from "may
  -- borrow today" — that additionally needs the policy open and the loan
  -- limit free, and the dashboard shows both.
  case
    when v.qualifying_months_consecutive is null then false
    when s.savings_account_id is null then false
    when v.qualifying_months_consecutive
      then coalesce(q.qualifying_months, 0) >= v.savings_qualifying_months
    else coalesce(q.qualifying_months, 0) >= v.savings_qualifying_months
  end                                         as savings_months_met
from public.memberships m
join public.clients cl on cl.id = m.client_id
join public.membership_policy_versions v on v.id = m.policy_version_id
cross join public.business_settings bs
left join savings s on s.membership_id = m.id
left join pending_out w on w.savings_account_id = s.savings_account_id
left join qualifying q on q.savings_account_id = s.savings_account_id
left join obligations o on o.client_id = m.client_id
where m.status in ('pending', 'active', 'suspended')
  and bs.id = 1;

comment on view public.member_loan_eligibility is
  'Polytos Phase 3. One row per live membership: the savings evidence, the policy terms, and the ceiling their savings support — NULL while the savings-to-loan multiplier is undecided. The register the Member Loans dashboard and the eligibility panel read. security_invoker, so the policies beneath it filter the rows.';

revoke all on public.member_loan_eligibility from anon, authenticated;
grant select on public.member_loan_eligibility to authenticated;

-- ---------------------------------------------------------------------------
-- member_loan_register — member loans, with the member beside them
-- ---------------------------------------------------------------------------

create view public.member_loan_register with (security_invoker = true) as
select
  l.id                                as loan_id,
  l.loan_number,
  l.client_id,
  c.full_name,
  c.client_number,
  l.branch_id,
  l.status,
  l.principal_amount,
  l.interest_rate_bps,
  l.interest_basis,
  l.interest_method,
  l.loan_term_months,
  l.repayment_frequency,
  l.total_interest,
  l.total_expected_repayment,
  l.approved_at,
  l.disbursed_at,
  l.created_at,
  l.membership_id,
  m.membership_number,
  m.status                            as membership_status,
  s.policy_version,
  s.savings_account_id,
  s.savings_account_number,
  s.eligible_savings,
  s.multiplier_bps,
  s.max_eligible_loan,
  s.qualifying_months,
  s.months_required,
  p.pledged_amount,
  p.released_at                       as pledge_released_at,
  b.principal_remaining,
  b.interest_remaining,
  b.penalty_remaining,
  b.total_outstanding,
  b.total_paid,
  d.arrears_amount,
  d.days_past_due,
  d.delinquency_state
from public.loans l
join public.clients c on c.id = l.client_id
left join public.memberships m on m.id = l.membership_id
left join public.member_loan_eligibility_snapshots s on s.loan_id = l.id
left join public.member_loan_savings_pledges p on p.loan_id = l.id
left join public.loan_balances b on b.loan_id = l.id
left join public.loan_delinquency d on d.loan_id = l.id
where l.membership_id is not null;

comment on view public.member_loan_register is
  'Polytos Phase 3. Member loans with the membership, the frozen eligibility evidence, the savings pledge, the outstanding balance and the arrears position in one read. Keyed on loans.membership_id, which only a member loan carries.';

revoke all on public.member_loan_register from anon, authenticated;
grant select on public.member_loan_register to authenticated;

-- ---------------------------------------------------------------------------
-- The wrapper a screen calls
--
-- See 20261021000600 for why there are two functions. This is the one a
-- session may reach: it checks the capability, restates the branch rule the
-- policy on `memberships` states, and then delegates to the assessment.
--
-- The client not being visible and the client not existing are the same
-- answer, which is what it should be: a caller who may not read a row has no
-- business learning that it is there.
-- ---------------------------------------------------------------------------

create or replace function public.assess_member_loan_eligibility(
  p_client_id uuid,
  p_amount bigint default null,
  p_term_months smallint default null,
  p_repayment_frequency text default null,
  p_as_of date default null
)
returns table (
  client_id uuid,
  membership_id uuid,
  membership_number text,
  membership_status text,
  policy_version_id uuid,
  policy_version text,
  as_of date,
  savings_account_id uuid,
  savings_account_number text,
  savings_account_status text,
  months_required smallint,
  must_be_consecutive boolean,
  qualifying_months integer,
  consecutive_qualifying_months integer,
  savings_qualifies boolean,
  eligible_savings bigint,
  multiplier_bps integer,
  max_eligible_loan bigint,
  max_term_months smallint,
  required_cadence text,
  active_loan_count integer,
  active_loan_limit integer,
  outstanding_principal bigint,
  pledged_savings bigint,
  pending_withdrawals bigint,
  available_savings bigint,
  amount_requested bigint,
  term_requested smallint,
  is_eligible boolean,
  may_proceed boolean,
  blocking_reasons text[]
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_client public.clients;
begin
  if auth.uid() is not null
     and not public.user_has_permission('member_loans:view_eligibility') then
    raise exception
      'Reading a member''s loan eligibility requires the member_loans:view_eligibility capability.'
      using errcode = 'P0001';
  end if;

  select * into v_client from public.clients where id = p_client_id;

  if not found then
    raise exception 'No such client.' using errcode = 'P0001';
  end if;

  -- The branch rule, restated as the policy on `memberships` states it: a
  -- profile assigned to a branch sees that branch, and a profile with no
  -- branch is unrestricted. Restated rather than delegated, because this
  -- function is SECURITY DEFINER and the policies do not run for it — which is
  -- exactly the privilege-escalation risk a definer function carries, and the
  -- only answer to it is to say the rule here too.
  if auth.uid() is not null
     and (select public.current_user_branch_id()) is not null
     and v_client.branch_id is not null
     and v_client.branch_id <> (select public.current_user_branch_id()) then
    raise exception 'No such client.' using errcode = 'P0001';
  end if;

  return query
    select *
    from public.member_loan_eligibility_of(
      p_client_id, p_amount, p_term_months, p_repayment_frequency, p_as_of
    );
end;
$$;

comment on function public.assess_member_loan_eligibility(uuid, bigint, smallint, text, date) is
  'Polytos Phase 3. The member-loan eligibility assessment a screen reads: checks member_loans:view_eligibility and the branch rule, then delegates to the authoritative assessment. An invisible client and a nonexistent one give the same answer.';

revoke all on function public.assess_member_loan_eligibility(uuid, bigint, smallint, text, date)
  from public, anon;
grant execute on function public.assess_member_loan_eligibility(uuid, bigint, smallint, text, date)
  to authenticated;
