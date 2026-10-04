-- ===========================================================================
-- Phase 7 — materialising the penalty.
--
-- ## Why a penalty has to be materialised at all
--
-- Everything else in this phase is derived, and deliberately so. A penalty is
-- the exception, for two reasons:
--
--   1. **It is a charge, not an observation.** "This borrower owes 50,000 more
--      than their contract" is a claim the business must be able to show the
--      provenance of: the balance it was calculated from, the rate that
--      applied, the date it took effect. A figure a query re-derives on
--      demand would change silently if the derivation changed; a row cannot.
--   2. **Money has to be able to reach it.** A payment is allocated to
--      obligations that exist. An obligation that is only ever a computed
--      number cannot be paid off, cannot be partly paid, and cannot appear on
--      a receipt.
--
-- ## When it is materialised, given that there is no scheduled job
--
-- The design requirement is that financial correctness must not depend on a
-- cron job that may never be configured. So eligibility is **derived
-- continuously** — `loan_delinquency.penalty_eligible` is true the moment the
-- business date passes the penalty date, with no process involved — and
-- materialisation happens at the only moment it actually matters:
--
--   * `post_payment` calls this function **before** it reads a balance, so a
--     borrower cannot settle yesterday's figure and escape a charge that was
--     already due. This is the critical path.
--   * `reverse_payment` calls it **after** the reversal, so a loan that only
--     looked settled through the grace period does not stay exempt once the
--     payment behind that appearance is withdrawn.
--   * `apply_eligible_penalties()` exists for a future scheduled job, so the
--     business can have penalties appear on reports without waiting for
--     somebody to pay. It is an optimisation, not a dependency: every path
--     that moves money already guarantees the penalty exists first.
--
-- A staff read does **not** materialise anything. A SELECT must not write —
-- it may run in a read-only transaction, under a role with no privileges on
-- `loan_penalties`, or as a borrower — so screens show the projected charge
-- from `loan_delinquency`, labelled as pending, and the materialisation
-- happens on the transaction that needs it to exist.
--
-- ## Idempotency and concurrency
--
-- The function locks the loan row **first**, then checks whether a penalty
-- already exists. Every other path that touches a loan's money
-- (`post_payment`, `reverse_payment`) locks the same row, so all of them
-- serialise on one lock taken in one order — there is no second lock to
-- deadlock against. The unique index is the backstop underneath: even if two
-- transactions somehow both reached the insert, only one could commit.
--
-- Deliberately not an advisory lock on the penalty: that would be a second
-- lock acquired in the opposite order from `post_payment`'s, which is how a
-- deadlock is built.
-- ===========================================================================

create or replace function public.ensure_penalty_applied(p_loan_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_loan       public.loans;
  v_penalty_id uuid;
  v_final_due  date;
  v_grace_end  date;
  v_effective  date;
  v_business   date;
  v_basis      bigint;
  v_amount     bigint;
begin
  -- The lock first, and on the loan row, because that is the lock every other
  -- money path on this loan already takes.
  select * into v_loan from public.loans where id = p_loan_id for update;

  if not found then
    raise exception 'No such loan.' using errcode = 'P0001';
  end if;

  -- Already charged. Returned rather than raised: callers invoke this
  -- unconditionally before posting, and "the penalty exists" is the normal
  -- answer, not an error. This is also what makes repeated processing a
  -- no-op — one penalty, one amount, one audit event, however many times
  -- anything calls it.
  select p.id into v_penalty_id
  from public.loan_penalties p
  where p.loan_id = p_loan_id
    and p.penalty_type = 'expiry_penalty';

  if v_penalty_id is not null then
    return v_penalty_id;
  end if;

  -- A penalty applies to a live loan. A cleared loan owes nothing, and a
  -- draft, pending, approved, cancelled or rejected loan has no schedule to
  -- have expired. Nothing is raised: ineligibility is an ordinary outcome.
  if v_loan.status <> 'active' then
    return null;
  end if;

  -- The contractual completion date is the final installment's due date —
  -- Phase 5's authoritative answer, never recomputed from the term.
  select max(li.due_date) into v_final_due
  from public.loan_installments li
  where li.loan_id = p_loan_id;

  if v_final_due is null then
    return null;
  end if;

  -- The loan's **own** snapshotted grace period and rate. Reading today's
  -- business settings here would let an administrator change the penalty on
  -- every historical loan by editing one row, which is precisely what
  -- ADR-023's snapshots exist to prevent.
  v_grace_end := v_final_due + v_loan.grace_period_days_applied::integer;
  v_effective := v_grace_end + 1;
  v_business  := public.business_date();

  -- Still inside the agreed window, grace included. A payment on the final
  -- due date is on time; a payment on any grace day is still not late enough
  -- to be charged.
  if v_business < v_effective then
    return null;
  end if;

  -- The balance as it stood when the grace period ran out — not today's,
  -- which a late payment may already have reduced. See
  -- `loan_outstanding_as_of`.
  v_basis := public.loan_outstanding_as_of(p_loan_id, v_grace_end);

  if v_basis is null or v_basis <= 0 then
    -- Nothing was owed at the deadline: the borrower paid inside the grace
    -- period and no charge arises, even if a later reversal has since
    -- reopened the loan for other reasons.
    return null;
  end if;

  -- Half-up to the whole shilling, in integer arithmetic. The table's CHECK
  -- re-derives this independently, so a wrong calculation here cannot be
  -- stored.
  v_amount := (v_basis * v_loan.penalty_rate_bps_applied + 5000) / 10000;

  if v_amount <= 0 then
    -- A rate of zero. The loan is overdue but the business has configured no
    -- charge, so there is nothing to record — and a penalty row of zero would
    -- be a charge that claims to exist and does not.
    return null;
  end if;

  insert into public.loan_penalties (
    loan_id, client_id, penalty_type,
    final_due_date, grace_period_days, grace_end_date, effective_date,
    basis_amount, penalty_rate_bps, penalty_amount, trigger_rule,
    applied_at
  )
  values (
    p_loan_id, v_loan.client_id, 'expiry_penalty',
    v_final_due, v_loan.grace_period_days_applied, v_grace_end, v_effective,
    v_basis, v_loan.penalty_rate_bps_applied, v_amount, 'grace_period_expired',
    -- The same clock the business date came from, so `applied_at` and
    -- `effective_date` cannot tell contradictory stories.
    public.business_now()
  )
  returning id into v_penalty_id;

  return v_penalty_id;
end;
$$;

comment on function public.ensure_penalty_applied(uuid) is
  'Materialises a loan''s one-time expiry penalty if and only if it is now eligible: past the grace deadline, still active, and owing money as at the deadline. Idempotent, takes no amount, rate, basis or date from its caller, and returns the existing penalty unchanged if there is one.';

-- No session role may call this. Like `generate_loan_schedule`, its only
-- callers are other trusted functions running as the table owner — and the
-- sweep below, for a privileged server path. `service_role` retains EXECUTE
-- through Supabase's default privileges, deliberately: that is the connection
-- a scheduled job would use.
revoke all on function public.ensure_penalty_applied(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The optional sweep
--
-- For a future scheduled job, or for an administrator who wants penalties to
-- appear on today's reports rather than on the next payment. Correctness does
-- not depend on it ever running: every money path materialises what it needs.
--
-- Eligibility is read from the derived view, so the sweep cannot apply a
-- penalty the view would not already be showing as pending.
-- ---------------------------------------------------------------------------

create or replace function public.apply_eligible_penalties()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_loan_id uuid;
  v_applied integer := 0;
begin
  for v_loan_id in
    select d.loan_id
    from public.loan_delinquency d
    where d.penalty_eligible
    order by d.penalty_effective_date, d.loan_id
  loop
    if public.ensure_penalty_applied(v_loan_id) is not null then
      v_applied := v_applied + 1;
    end if;
  end loop;

  return v_applied;
end;
$$;

comment on function public.apply_eligible_penalties() is
  'Materialises every currently eligible expiry penalty. Optional: for a scheduled job or an administrator. No financial rule depends on it having run.';

revoke all on function public.apply_eligible_penalties() from public, anon, authenticated;
