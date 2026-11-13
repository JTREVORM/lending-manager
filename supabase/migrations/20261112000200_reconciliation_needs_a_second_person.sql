-- ===========================================================================
-- 20261112000200_reconciliation_needs_a_second_person
--
-- A cash difference may no longer be written off by the person who counted
-- the drawer.
--
-- ## What was wrong
--
-- `approve_reconciliation` checked the `reconciliation:approve` capability
-- and nothing else, so the officer who performed a count could approve it.
-- That approval posts the variance to 5950 Cash Over and Short, which is how
-- an unexplained shortage became an expense on one person's action.
--
-- There were two routes to it, and both are closed here:
--
--   1. Count, then approve your own submission.
--   2. Count with `reconciliation_requires_review` off, and
--      `submit_reconciliation` approved it for you in the same call.
--
-- Route 2 mattered more than it looks. The setting that governed it lives on
-- `finance_settings`, which the same Owner may edit, so the control could be
-- removed by the person it constrains — and the whole write-off then happened
-- in one statement with no second party anywhere.
--
-- ## What this does
--
-- `submit_reconciliation` no longer approves anything. A count that agrees is
-- `balanced` and writes no journal, exactly as before. A count that disagrees
-- is `submitted` and waits, whatever the setting says.
--
-- `approve_reconciliation` refuses when the approver is the person recorded
-- as having performed the count, with SQLSTATE 42501.
--
-- A CHECK constraint says the same thing at the table, so it holds for
-- `service_role` and for direct SQL, not only for callers who come through
-- the function. The hosted table was inspected before writing this: 5 rows,
-- 2 approved, 0 with `reviewed_by = performed_by`, so the constraint is added
-- validated rather than NOT VALID.
--
-- ## What this deliberately does not do
--
-- No investigation workflow, no new tables, no new roles, no change to any
-- other posting path. Counting is still a one-person job; only closing a
-- difference needs a second person, which is the one place a second person is
-- genuinely load-bearing.
--
-- ## Consequence for a business with one member of staff
--
-- The Owner can count a drawer and see a difference, and cannot write it off.
-- That is intended: the variance stays visible and unposted until somebody
-- else is authorised. No ordinary lending operation is affected — registering
-- clients, creating, approving and disbursing loans, taking repayments,
-- issuing receipts and reading reports all remain available to one person.
--
-- ## One trap worth naming
--
-- `submit_reconciliation` has two prior definitions: the original in
-- 20261011000230 and a replacement in 20261016000100 that compares the count
-- against `ledger_account_balance_as_of(account, date)` rather than the
-- balance now — so a count entered for a past day is judged against that
-- day. The first draft of this migration rebuilt the function from the
-- ORIGINAL and silently reverted that, which is the standing hazard of
-- CREATE OR REPLACE. `reconciliation-as-of.test.ts` caught it. The body here
-- is the 20261016000100 one, with only the auto-approve branch removed.
--
-- Preserves every existing journal, ledger balance and borrower payment. No
-- row is created, deleted or recalculated by this migration.
-- ===========================================================================


-- --- submit_reconciliation: never approves ------------------------------
create or replace function public.submit_reconciliation(
  p_account_id uuid,
  p_business_date date,
  p_counted_balance bigint,
  p_explanation text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor   uuid;
  v_label   text;
  v_branch  uuid;
  v_system  bigint;
  v_number  text;
  v_id      uuid;
  v_review  boolean;
  v_date    date;
begin
  if auth.uid() is not null and not public.user_has_permission('reconciliation:perform') then
    raise exception 'Counting an account requires the reconciliation:perform capability.'
      using errcode = 'P0001';
  end if;

  v_actor := public.current_profile_id();
  v_label := public.audit_actor_label();
  v_date  := coalesce(p_business_date, public.business_date());

  if p_counted_balance is null or p_counted_balance < 0 then
    raise exception 'A count cannot be negative.' using errcode = 'P0001';
  end if;

  perform public.assert_cash_account(p_account_id, 'destination');

  if v_date > public.business_date() then
    raise exception 'An account cannot be counted for a date in the future.'
      using errcode = 'P0001';
  end if;

  select a.branch_id into v_branch from public.ledger_accounts a where a.id = p_account_id;

  -- As of the date counted, not as of now. A count entered a few days late
  -- is compared against the books as they stood on the day of the count;
  -- reading the current balance would fold every movement since into the
  -- variance, and `approve_reconciliation` would write that off as a loss.
  v_system := public.ledger_account_balance_as_of(p_account_id, v_date);
  v_number := public.next_reference('reconciliation');

  select fs.reconciliation_requires_review into v_review
  from public.finance_settings fs where fs.id = 1;

  insert into public.account_reconciliations (
    reconciliation_number, branch_id, account_id, business_date,
    system_balance, counted_balance, explanation, status,
    performed_by, performed_by_label, performed_at
  )
  values (
    v_number, v_branch, p_account_id, v_date,
    v_system, p_counted_balance,
    nullif(btrim(coalesce(p_explanation, '')), ''),
    -- A count that agrees needs nobody's approval; there is nothing to
    -- decide and no journal to write.
    case when p_counted_balance = v_system then 'balanced' else 'submitted' end,
    v_actor, v_label, public.business_now()
  )
  returning id into v_id;

  -- A difference is never written off at submission, whatever
  -- `reconciliation_requires_review` says. It was the one path that let the
  -- person who counted a drawer close their own variance, and the setting
  -- that governed it is editable by the same person. The count is recorded
  -- and the difference stays visible; closing it is a separate, authorised
  -- act by somebody else. See 20261112000200.
  --
  -- `v_review` is still read above: the column remains, and a later version
  -- may want it for something that is not a self-approval.

  perform public.record_audit_event(
    'reconciliation.submitted', 'account_reconciliation', v_id::text, null,
    pg_catalog.jsonb_build_object(
      'reconciliation_number', v_number,
      'system_balance', v_system,
      'counted_balance', p_counted_balance),
    null, null
  );

  return v_id;
end;
$$;

-- --- approve_reconciliation: refuses the person who counted -------------
create or replace function public.approve_reconciliation(p_reconciliation_id uuid, p_notes text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  r        record;
  v_short  uuid;
  v_entry  uuid;
  v_name   text;
begin
  if auth.uid() is not null and not public.user_has_permission('reconciliation:approve') then
    raise exception 'Approving a reconciliation difference requires the reconciliation:approve capability.'
      using errcode = 'P0001';
  end if;

  select * into r from public.account_reconciliations where id = p_reconciliation_id for update;

  if r.id is null then
    raise exception 'No such reconciliation.' using errcode = 'P0001';
  end if;

  if r.status <> 'submitted' then
    raise exception 'Reconciliation % is %, so there is nothing to approve.',
      r.reconciliation_number, r.status using errcode = 'P0001';
  end if;

  -- The approver is not the person who counted. Without this the approval
  -- step is theatre: a cash shortage becomes an expense on one person's
  -- action, with no second pair of eyes anywhere in the sequence.
  --
  -- `current_profile_id()` is null on the trusted no-JWT paths (migrations,
  -- seeds, service maintenance), and `performed_by` is null for counts taken
  -- the same way, so `null = null` is unknown and this does not fire for
  -- them. It fires exactly when a real signed-in person tries to approve
  -- their own count.
  if r.performed_by is not null
     and r.performed_by = public.current_profile_id() then
    raise exception
      'The person who recorded this count cannot approve it. A second authorised person must review the difference.'
      using errcode = '42501';
  end if;

  v_short := public.ledger_account_by_code('5950');
  select name into v_name from public.ledger_accounts where id = r.account_id;

  -- The adjustment is an explicit, authorised journal naming the difference.
  -- The alternative — moving the ledger to agree with the count — is the
  -- thing this whole module exists to make impossible.
  v_entry := public.post_journal(
    r.branch_id,
    r.business_date,
    'Reconciliation ' || r.reconciliation_number || ': ' || v_name,
    'reconciliation_adjustment', r.id, null, null,
    case when r.variance > 0 then
      pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object('account_id', r.account_id,
          'debit', r.variance, 'credit', 0, 'memo', 'Counted more than the books expected'),
        pg_catalog.jsonb_build_object('account_id', v_short,
          'debit', 0, 'credit', r.variance, 'memo', coalesce(r.explanation, 'Overage'))
      )
    else
      pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object('account_id', v_short,
          'debit', -r.variance, 'credit', 0, 'memo', coalesce(r.explanation, 'Shortage')),
        pg_catalog.jsonb_build_object('account_id', r.account_id,
          'debit', 0, 'credit', -r.variance, 'memo', 'Counted less than the books expected')
      )
    end,
    public.business_now(), public.current_profile_id(), public.audit_actor_label()
  );

  update public.account_reconciliations
     set status = 'approved',
         adjustment_entry_id = v_entry,
         reviewed_by = public.current_profile_id(),
         reviewed_by_label = public.audit_actor_label(),
         reviewed_at = public.business_now(),
         review_notes = nullif(btrim(coalesce(p_notes, '')), '')
   where id = r.id;

  perform public.record_audit_event(
    'reconciliation.approved', 'account_reconciliation', r.id::text, null,
    pg_catalog.jsonb_build_object(
      'reconciliation_number', r.reconciliation_number, 'variance', r.variance),
    null, null
  );

  return v_entry;
end;
$$;

comment on function public.submit_reconciliation(uuid, date, bigint, text) is
  'Phase 11. Records a count of a cash account. A count that agrees is balanced and writes no journal; a count that disagrees is submitted and waits for a second authorised person. As of 20261112000200 it never approves a difference itself, whatever reconciliation_requires_review says.';

comment on function public.approve_reconciliation(uuid, text) is
  'Phase 11. Posts an approved cash difference to 5950 Cash Over and Short. As of 20261112000200 it refuses the person recorded as having performed the count, with 42501: approving your own variance is the one thing the approval step exists to prevent.';


-- ---------------------------------------------------------------------------
-- The same rule at the table, so it survives a caller that is not the
-- function: service_role, a future definer path, or direct SQL.
-- ---------------------------------------------------------------------------
alter table public.account_reconciliations
  add constraint account_reconciliations_reviewer_is_not_performer
  check (
    reviewed_by is null
    or performed_by is null
    or reviewed_by <> performed_by
  );

comment on constraint account_reconciliations_reviewer_is_not_performer
  on public.account_reconciliations is
  'A cash difference is not closed by the person who counted it. Mirrors the 42501 raised by approve_reconciliation, so the rule holds for callers that never reach the function. Both sides are nullable because the trusted no-JWT maintenance paths record neither actor.';
