-- ===========================================================================
-- 20261103000100_definer_rpc_business_identity
--
-- Defence in depth for the forced-password boundary: the financial
-- SECURITY DEFINER RPCs refuse on their own, instead of relying entirely on
-- the PostgREST `db-pre-request` hook.
--
-- ## What was wrong
--
-- `20261030180224_forced_password_authorization_boundary` closed the boundary
-- two ways: `current_profile_id()` stopped resolving for a forced account, so
-- every RLS policy and capability helper denies it; and the configured
-- `public.enforce_password_change` pre-request hook denies non-recovery
-- routes before a request reaches a relation.
--
-- The RLS half does not cover SECURITY DEFINER RPCs. A definer function runs
-- as its owner, so Row Level Security on the tables it reads does not apply
-- to the caller, and these particular functions ask nothing about who is
-- calling. Their only protection was the hook.
--
-- That was verified against the production database on 3 November 2026, in a
-- transaction that was rolled back, with the session impersonating the real
-- forced-password Manager demo account:
--
--     set local role authenticated;
--     set local "request.jwt.claims" = '{"sub":"<forced manager>", ...}';
--
--     current_profile_id()                  -> null      (no business identity)
--     user_has_permission('loans:view')     -> false
--     select count(*) from public.loans     -> 0         (RLS denies)
--     savings_withdrawable_amount(<acct>)   -> 140000    <-- real figure
--     ledger_account_balance(<acct>)        -> 0         (executed; not refused)
--     savings_pledged_amount(<acct>)        -> 0         (executed; not refused)
--     assess_meeting_fines(<absent id>)     -> 0         (executed; not refused)
--
-- So an account with no business identity at all still obtained a member's
-- withdrawable savings balance. Over the hosted Data API the hook refuses
-- these calls, which is why this is a hardening rather than a live breach.
-- But the hook is a role setting, not part of any migration:
--
--   * a project rebuilt, restored or cloned from these migrations has the
--     RLS half of the boundary and none of the RPC half, silently;
--   * `alter role authenticator reset pgrst.db_pre_request` removes the
--     entire RPC boundary with no error and nothing in the schema to notice.
--
-- A security control with one unversioned point of failure is one the next
-- environment will not have.
--
-- ## The fix
--
-- One guard, `require_business_identity()`, called as the first statement of
-- each financial definer RPC. It raises `42501` — the same SQLSTATE and the
-- same sentence as the hook, so a client sees one consistent refusal whether
-- the request was stopped before the route or inside the function.
--
-- Callers with no verified token (`service_role`, a migration, the bootstrap
-- script, a seed) are exempt, deliberately and for the same reason
-- `profiles_guard_privileged_columns()` exempts them: they already bypass Row
-- Level Security, and this guard constrains authenticated sessions.
--
-- No grant is widened, no policy is relaxed, no account, financial record,
-- role assignment or policy version is touched, and every function keeps its
-- signature, defaults, volatility, arguments and result shape.
--
-- ## Scope, and what is deliberately left alone
--
-- Guarded here: the RPCs that disclose or mutate member financial figures and
-- are directly reachable as a Data API route —
-- `ledger_account_balance`, `savings_withdrawable_amount`,
-- `savings_pledged_amount`, `assess_meeting_fines` and `client_has_live_loan`.
--
-- NOT guarded: `business_now`, `business_timezone`,
-- `active_membership_policy_id`, `membership_policy_allows`,
-- `membership_governing_policy`, `savings_account_governing_policy`,
-- `membership_terms_are_accepted`, `benefit_expense_account`,
-- `benefit_blocked_reason`, `benefits_blocked_reason`,
-- `member_lending_blocked_reason`, `membership_fee_is_posted` and
-- `redeem_membership_consent_code`. These return configuration or policy
-- metadata rather than a member's money, and several are called from trigger
-- and constraint paths where a raise would convert a silent, correct denial
-- into an error. They remain covered by the hook. They are recorded as a
-- documented residual rather than changed quietly here.
--
-- `validate_loan_for_approval` is also left to the hook, for a different
-- reason: guarding it means restating its two-hundred-line body in this
-- migration, and a transcription slip in a loan-approval rule is a worse
-- outcome than the disclosure it would close. It returns approval failure
-- codes, not a member's balance. It belongs with the residual above, to be
-- closed where the function itself is next edited.
--
-- None of the five functions below is referenced by any RLS policy or CHECK
-- constraint, so no policy evaluation can begin raising. Two are referenced
-- from views (`membership_register`, `member_loan_eligibility`); those views
-- are filtered by RLS on their base tables first, so for a caller with no
-- business identity there is no surviving row for which the function is
-- evaluated.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- The guard
-- ---------------------------------------------------------------------------
create or replace function public.require_business_identity()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_profile_id uuid;
begin
  -- No verified token reached the database: a trusted server-side path.
  if (select auth.uid()) is null then
    return null;
  end if;

  -- Active status AND a completed password change, as of
  -- 20261030180224. Null for forced, inactive, suspended and unlinked
  -- sessions alike.
  v_profile_id := (select public.current_profile_id());

  if v_profile_id is null then
    raise exception
      'Business access requires an active account with a completed password change.'
      using errcode = '42501';
  end if;

  return v_profile_id;
end;
$$;

comment on function public.require_business_identity() is
  'Refuses an authenticated session with no business identity (forced password change, inactive, suspended, unlinked) with SQLSTATE 42501. Exempts callers with no verified token, which are trusted server-side paths. Called by the financial SECURITY DEFINER RPCs so they do not depend solely on the PostgREST pre-request hook.';

-- Not a client primitive: it is called by definer functions, which run as the
-- owner and need no grant of their own.
revoke all on function public.require_business_identity() from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- public.ledger_account_balance(uuid)
-- Unchanged arithmetic; one guard added.
-- ---------------------------------------------------------------------------
create or replace function public.ledger_account_balance(p_account_id uuid)
returns bigint
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_side    text;
  v_debit   bigint;
  v_credit  bigint;
begin
  perform public.require_business_identity();

  select a.normal_side into v_side
  from public.ledger_accounts a where a.id = p_account_id;

  if v_side is null then
    raise exception 'No such ledger account.' using errcode = 'P0001';
  end if;

  select coalesce(pg_catalog.sum(l.debit), 0), coalesce(pg_catalog.sum(l.credit), 0)
    into v_debit, v_credit
  from public.journal_lines l
  where l.account_id = p_account_id;

  if v_side = 'debit' then
    return v_debit - v_credit;
  end if;

  return v_credit - v_debit;
end;
$$;


-- ---------------------------------------------------------------------------
-- public.client_has_live_loan(uuid)
--
-- Was `language sql`. plpgsql, because a guard that raises has to be a
-- statement rather than part of an expression. The consequence is that it is
-- no longer inlinable into a surrounding query; at this data volume that is
-- not a trade worth leaving a financial disclosure open for.
-- ---------------------------------------------------------------------------
create or replace function public.client_has_live_loan(p_client_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.require_business_identity();

  return exists (
    select 1 from public.loans l
    where l.client_id = p_client_id and l.status = 'active'
  );
end;
$$;


-- ---------------------------------------------------------------------------
-- public.savings_pledged_amount(uuid, date)
-- Was `language sql`; see the note on client_has_live_loan.
-- ---------------------------------------------------------------------------
create or replace function public.savings_pledged_amount(
  p_savings_account_id uuid,
  p_as_of date default null
)
returns bigint
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.require_business_identity();

  return (
    select coalesce(pg_catalog.sum(p.pledged_amount), 0)::bigint
    from public.member_loan_savings_pledges p
    join public.loans l on l.id = p.loan_id
    where p.savings_account_id = p_savings_account_id
      and p.released_at is null
      and l.status in ('approved', 'active')
      and (p.pledged_at at time zone 'Africa/Kampala')::date
            <= coalesce(p_as_of, public.business_date())
  );
end;
$$;


-- ---------------------------------------------------------------------------
-- public.savings_withdrawable_amount(uuid, date)
-- The Phase 2 / Phase 5 withdrawal rule, unchanged; one guard added.
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
  perform public.require_business_identity();

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


-- ---------------------------------------------------------------------------
-- public.assess_meeting_fines(uuid)
-- Volatile, and it posts fines. Guarded first, before any candidate is read.
-- ---------------------------------------------------------------------------
create or replace function public.assess_meeting_fines(p_meeting_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row   record;
  v_count integer := 0;
begin
  perform public.require_business_identity();

  for v_row in
    select k.membership_id
    from public.meeting_fine_candidates(p_meeting_id) k
    where k.fineable
    order by k.membership_number
  loop
    perform public.assess_meeting_fine(p_meeting_id, v_row.membership_id);
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;
