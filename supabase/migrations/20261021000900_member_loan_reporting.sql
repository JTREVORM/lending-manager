-- ===========================================================================
-- Polytos Phase 3.9 — the figures the Member Loans dashboard reads
--
-- ## One function, one round trip
--
-- Every figure on the dashboard comes from one call. The alternative — a
-- query per tile — is how a register read came to invoke `user_has_permission`
-- 20,524 times in Phase 18, and the Supabase free tier is the constraint this
-- system is actually under.
--
-- ## Why this asks for a capability in so many words
--
-- `savings_summary` is the precedent, and the reason is the same: these are
-- business-wide aggregates, so there is no *row* for a policy to filter.
-- `member_loan_register` and `member_loan_eligibility` are `security_invoker`
-- views and the policies beneath them decide who sees which member; a total
-- across every member has nothing to filter, so the function names the
-- capability instead.
--
-- It asks for `loans:view` rather than `member_loans:view_eligibility`,
-- because what it reports is a loan book: how much is out, how much is
-- overdue, how much is awaiting approval. The two member-shaped figures —
-- qualified and not yet qualified — are counts rather than ceilings, and a
-- count of how many members have served six months discloses nothing about
-- what any one of them may borrow.
--
-- ## What it deliberately does not report
--
-- No total ceiling across members. Summing what the business *could* lend is a
-- figure nobody asked for and one that would be read as a commitment, and
-- while the multiplier is undecided every one of its terms is NULL anyway.
-- ===========================================================================

create or replace function public.member_loan_summary()
returns table (
  -- The pipeline.
  applications_draft integer,
  applications_pending integer,
  loans_approved integer,
  loans_active integer,
  loans_cleared integer,

  -- The money.
  principal_disbursed bigint,
  principal_outstanding bigint,
  interest_outstanding bigint,
  total_outstanding bigint,
  total_collected bigint,

  -- The collection position.
  due_today bigint,
  overdue_loans integer,
  arrears_amount bigint,

  -- The membership position.
  live_memberships integer,
  members_qualified integer,
  members_not_yet_qualified integer,
  members_with_member_loan integer,

  -- The savings securing it all.
  savings_pledged bigint,

  -- Whether any of this can happen today, and why not.
  lending_open boolean,
  blocked_reason text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_policy public.membership_policy_versions;
begin
  if auth.uid() is not null and not public.user_has_permission('loans:view') then
    raise exception 'Seeing the member loan position requires the loans:view capability.'
      using errcode = 'P0001';
  end if;

  -- --- The pipeline -------------------------------------------------------
  -- Keyed on the **product**, not on `loans.membership_id`: a member-loan
  -- application that has not been approved yet carries no membership, because
  -- the membership is frozen onto the loan at approval. Counting drafts by
  -- membership would report zero applications however many were waiting.
  select
    pg_catalog.count(*) filter (where l.status = 'draft')::integer,
    pg_catalog.count(*) filter (where l.status = 'pending_approval')::integer,
    pg_catalog.count(*) filter (where l.status = 'approved')::integer,
    pg_catalog.count(*) filter (where l.status = 'active')::integer,
    pg_catalog.count(*) filter (where l.status = 'cleared')::integer
  into
    applications_draft, applications_pending, loans_approved, loans_active,
    loans_cleared
  from public.loans l
  join public.loan_products p on p.id = l.loan_product_id
  where p.requires_membership;

  -- --- The money ----------------------------------------------------------
  select
    coalesce(pg_catalog.sum(l.principal_amount) filter (
      where l.status in ('active', 'cleared')), 0)::bigint,
    coalesce(pg_catalog.sum(b.principal_remaining) filter (
      where l.status = 'active'), 0)::bigint,
    coalesce(pg_catalog.sum(b.interest_remaining) filter (
      where l.status = 'active'), 0)::bigint,
    coalesce(pg_catalog.sum(b.total_outstanding) filter (
      where l.status = 'active'), 0)::bigint,
    coalesce(pg_catalog.sum(b.total_paid), 0)::bigint
  into
    principal_disbursed, principal_outstanding, interest_outstanding,
    total_outstanding, total_collected
  from public.loans l
  join public.loan_products p on p.id = l.loan_product_id
  left join public.loan_balances b on b.loan_id = l.id
  where p.requires_membership;

  -- --- The collection position -------------------------------------------
  -- From `loan_delinquency`, which is a view over the payment ledger, so a
  -- reversal moves these figures the instant it commits.
  select
    coalesce(pg_catalog.sum(d.due_today_amount), 0)::bigint,
    pg_catalog.count(*) filter (where d.days_past_due > 0)::integer,
    coalesce(pg_catalog.sum(d.arrears_amount), 0)::bigint
  into due_today, overdue_loans, arrears_amount
  from public.loan_delinquency d
  join public.loans l on l.id = d.loan_id
  join public.loan_products p on p.id = l.loan_product_id
  where p.requires_membership and l.status = 'active';

  -- --- The membership position -------------------------------------------
  select
    pg_catalog.count(*)::integer,
    pg_catalog.count(*) filter (
      where e.savings_months_met and e.membership_status = 'active')::integer,
    pg_catalog.count(*) filter (
      where not e.savings_months_met or e.membership_status <> 'active')::integer,
    pg_catalog.count(*) filter (where e.member_loan_count > 0)::integer
  into
    live_memberships, members_qualified, members_not_yet_qualified,
    members_with_member_loan
  from public.member_loan_eligibility e;

  -- --- The savings securing it -------------------------------------------
  select coalesce(pg_catalog.sum(pl.pledged_amount), 0)::bigint
  into savings_pledged
  from public.member_loan_savings_pledges pl
  join public.loans l on l.id = pl.loan_id
  where pl.released_at is null and l.status in ('approved', 'active');

  -- --- Whether any of it can happen today --------------------------------
  select * into v_policy
  from public.membership_policy_versions
  where status = 'active'
  order by effective_from desc
  limit 1;

  if not found then
    lending_open := false;
    blocked_reason :=
      'No membership policy version is in force, so there are no member lending terms at all.';
  else
    lending_open := public.membership_policy_allows(v_policy.id, 'lending')
      and exists (
        select 1 from public.loan_products p
        where p.product_code = 'ML' and p.status = 'active'
      );

    blocked_reason := case
      when not public.membership_policy_allows(v_policy.id, 'lending')
        then public.member_lending_blocked_reason(v_policy.id)
      when not exists (
        select 1 from public.loan_products p
        where p.product_code = 'ML' and p.status = 'active'
      )
        then 'The member loan product is not active, so it cannot be applied for.'
      else null
    end;
  end if;

  return next;
end;
$$;

comment on function public.member_loan_summary() is
  'Polytos Phase 3. The Member Loans dashboard in one round trip: the application pipeline, the money out and collected, the arrears position, how many members qualify, what savings secure it, and whether member lending is open today. Reports no total ceiling across members: a figure for what the business could lend reads as a commitment nobody made.';

revoke all on function public.member_loan_summary() from public, anon;
grant execute on function public.member_loan_summary() to authenticated;

-- ---------------------------------------------------------------------------
-- The reporting index
--
-- Every figure above filters member loans by their product, so the join is
-- the query. Indexed on exactly that, and on nothing else: the Phase 8 rule is
-- to index what is filtered.
-- ---------------------------------------------------------------------------

create index loans_product_status_idx on public.loans (loan_product_id, status);
