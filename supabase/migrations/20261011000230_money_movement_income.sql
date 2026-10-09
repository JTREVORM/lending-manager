-- ===========================================================================
-- Phase 11.2d — other income and reconciliation
--
-- Part of Phase 11.2; the design notes are at the head of
-- 20261011000200_money_movement_tables.sql.
-- ===========================================================================

-- Other income: record and reverse
--
-- No approval step. Money has already arrived; refusing to record it until
-- somebody agrees would leave cash in a drawer that the books do not know
-- about, which is the opposite of control.
-- ---------------------------------------------------------------------------

create or replace function public.record_other_income(
  p_income_account_id uuid,
  p_receiving_account_id uuid,
  p_amount bigint,
  p_income_date date,
  p_description text,
  p_payer text default null,
  p_client_id uuid default null,
  p_loan_id uuid default null,
  p_external_reference text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor  uuid;
  v_label  text;
  v_branch uuid;
  v_number text;
  v_cat    text;
  v_into   text;
  v_id     uuid;
  v_entry  uuid;
begin
  if auth.uid() is not null and not public.user_has_permission('income:create') then
    raise exception 'Recording income requires the income:create capability.'
      using errcode = 'P0001';
  end if;

  v_actor := public.current_profile_id();
  v_label := public.audit_actor_label();

  if p_amount is null or p_amount <= 0 then
    raise exception 'Income must be more than zero shillings.' using errcode = 'P0001';
  end if;

  if btrim(coalesce(p_description, '')) = '' then
    raise exception 'Income needs a description saying what it was for.'
      using errcode = 'P0001';
  end if;

  perform public.assert_postable_account(p_income_account_id, 'income', 'income category');
  perform public.assert_cash_account(p_receiving_account_id, 'destination');

  select a.branch_id into v_branch from public.ledger_accounts a where a.id = p_receiving_account_id;
  select name into v_cat  from public.ledger_accounts where id = p_income_account_id;
  select name into v_into from public.ledger_accounts where id = p_receiving_account_id;

  v_number := public.next_reference('other_income');

  insert into public.other_income (
    income_number, branch_id, income_account_id, receiving_account_id, amount,
    income_date, occurred_at, payer, client_id, loan_id, description,
    external_reference, recorded_by, recorded_by_label
  )
  values (
    v_number, v_branch, p_income_account_id, p_receiving_account_id, p_amount,
    coalesce(p_income_date, public.business_date()), public.business_now(),
    nullif(btrim(coalesce(p_payer, '')), ''), p_client_id, p_loan_id,
    btrim(p_description),
    nullif(btrim(coalesce(p_external_reference, '')), ''),
    v_actor, v_label
  )
  returning id into v_id;

  v_entry := public.post_journal(
    v_branch,
    coalesce(p_income_date, public.business_date()),
    'Income ' || v_number || ': ' || v_cat,
    'other_income', v_id, p_loan_id, p_client_id,
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('account_id', p_receiving_account_id,
        'debit', p_amount, 'credit', 0, 'memo', 'Received into ' || v_into),
      pg_catalog.jsonb_build_object('account_id', p_income_account_id,
        'debit', 0, 'credit', p_amount, 'memo', btrim(p_description))
    ),
    public.business_now(), v_actor, v_label
  );

  update public.other_income set journal_entry_id = v_entry where id = v_id;

  perform public.record_audit_event(
    'other_income.recorded', 'other_income', v_id::text, null,
    pg_catalog.jsonb_build_object('income_number', v_number, 'amount', p_amount),
    null, null
  );

  return v_id;
end;
$$;

comment on function public.record_other_income(uuid, uuid, bigint, date, text, text, uuid, uuid, text) is
  'Phase 11. Dr the receiving account, Cr the fee or income account. Interest and Penalty Income are refused here: those are written by the lending functions from a payment''s own allocation components.';

revoke all on function public.record_other_income(uuid, uuid, bigint, date, text, text, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.record_other_income(uuid, uuid, bigint, date, text, text, uuid, uuid, text)
  to authenticated;

create or replace function public.reverse_other_income(p_income_id uuid, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  i        record;
  v_contra uuid;
begin
  if auth.uid() is not null and not public.user_has_permission('income:create') then
    raise exception 'Reversing income requires the income:create capability.'
      using errcode = 'P0001';
  end if;

  if btrim(coalesce(p_reason, '')) = '' then
    raise exception 'Reversing income requires a reason.' using errcode = 'P0001';
  end if;

  select * into i from public.other_income where id = p_income_id for update;

  if i.id is null then
    raise exception 'No such income record.' using errcode = 'P0001';
  end if;

  if i.status <> 'posted' then
    raise exception 'Income % has already been reversed.', i.income_number
      using errcode = 'P0001';
  end if;

  perform public.assert_cash_available(i.receiving_account_id, i.amount);

  v_contra := public.post_journal(
    i.branch_id,
    public.business_date(),
    'Reversal of income ' || i.income_number,
    'other_income_reversal', i.id, i.loan_id, i.client_id,
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('account_id', i.income_account_id,
        'debit', i.amount, 'credit', 0, 'memo', btrim(p_reason)),
      pg_catalog.jsonb_build_object('account_id', i.receiving_account_id,
        'debit', 0, 'credit', i.amount, 'memo', 'Money returned')
    ),
    public.business_now(), public.current_profile_id(), public.audit_actor_label()
  );

  update public.other_income
     set status = 'reversed',
         reversal_entry_id = v_contra,
         reversed_at = public.business_now(),
         reversed_by = public.current_profile_id(),
         decision_reason = btrim(p_reason)
   where id = i.id;

  update public.journal_entries
     set reversed_by_entry_id = v_contra
   where id = i.journal_entry_id and reversed_by_entry_id is null;

  perform public.record_audit_event(
    'other_income.reversed', 'other_income', i.id::text, null,
    pg_catalog.jsonb_build_object('income_number', i.income_number, 'reason', btrim(p_reason)),
    null, null
  );

  return v_contra;
end;
$$;

revoke all on function public.reverse_other_income(uuid, text) from public, anon, authenticated;
grant execute on function public.reverse_other_income(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Reconciliation
-- ---------------------------------------------------------------------------

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

  v_system := public.ledger_account_balance(p_account_id);
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

  -- A difference, where the business has said a second person is not
  -- required, is written off now by whoever counted — provided they also
  -- hold the approving capability.
  if p_counted_balance <> v_system
     and not coalesce(v_review, true)
     and (auth.uid() is null or public.user_has_permission('reconciliation:approve')) then
    perform public.approve_reconciliation(v_id, 'Approved on submission; a second review is not required.');
  end if;

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

comment on function public.submit_reconciliation(uuid, date, bigint, text) is
  'Phase 11. Record what was counted against what the ledger says. A count that agrees is balanced and posts nothing; one that differs waits, visibly, until somebody approves the write-off.';

revoke all on function public.submit_reconciliation(uuid, date, bigint, text)
  from public, anon, authenticated;
grant execute on function public.submit_reconciliation(uuid, date, bigint, text) to authenticated;

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

comment on function public.approve_reconciliation(uuid, text) is
  'Phase 11. Writes an approved difference off to Cash Over and Short as an explicit journal. The ledger is adjusted by a posting that names the difference, never edited to agree with the count.';

revoke all on function public.approve_reconciliation(uuid, text) from public, anon, authenticated;
grant execute on function public.approve_reconciliation(uuid, text) to authenticated;

create or replace function public.reject_reconciliation(p_reconciliation_id uuid, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
begin
  if auth.uid() is not null and not public.user_has_permission('reconciliation:approve') then
    raise exception 'Rejecting a reconciliation requires the reconciliation:approve capability.'
      using errcode = 'P0001';
  end if;

  if btrim(coalesce(p_reason, '')) = '' then
    raise exception 'Rejecting a reconciliation requires a reason.' using errcode = 'P0001';
  end if;

  select * into r from public.account_reconciliations where id = p_reconciliation_id for update;

  if r.id is null then
    raise exception 'No such reconciliation.' using errcode = 'P0001';
  end if;

  if r.status <> 'submitted' then
    raise exception 'Reconciliation % is %, so there is nothing to reject.',
      r.reconciliation_number, r.status using errcode = 'P0001';
  end if;

  -- Rejected, not resolved: the difference is still there and still visible.
  -- Nothing is posted, so the ledger keeps saying what it said.
  update public.account_reconciliations
     set status = 'rejected',
         reviewed_by = public.current_profile_id(),
         reviewed_by_label = public.audit_actor_label(),
         reviewed_at = public.business_now(),
         review_notes = btrim(p_reason)
   where id = r.id;

  perform public.record_audit_event(
    'reconciliation.rejected', 'account_reconciliation', r.id::text, null,
    pg_catalog.jsonb_build_object(
      'reconciliation_number', r.reconciliation_number, 'reason', btrim(p_reason)),
    null, null
  );

  return r.id;
end;
$$;

revoke all on function public.reject_reconciliation(uuid, text) from public, anon, authenticated;
grant execute on function public.reject_reconciliation(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
