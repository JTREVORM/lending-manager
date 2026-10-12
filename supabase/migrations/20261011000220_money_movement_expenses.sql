-- ===========================================================================
-- Phase 11.2c — the expense path
--
-- Part of Phase 11.2; the design notes are at the head of
-- 20261011000200_money_movement_tables.sql.
-- ===========================================================================

-- Expenses: record, approve, reject, reverse
-- ---------------------------------------------------------------------------

create or replace function public.post_expense_journal(p_expense_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  e        record;
  v_cat    text;
  v_paid   text;
  v_id     uuid;
begin
  select * into e from public.expenses where id = p_expense_id for update;

  if e.id is null then
    raise exception 'No such expense.' using errcode = 'P0001';
  end if;

  if e.journal_entry_id is not null then
    return null;
  end if;

  select name into v_cat  from public.ledger_accounts where id = e.expense_account_id;
  select name into v_paid from public.ledger_accounts where id = e.payment_account_id;

  perform public.assert_cash_available(e.payment_account_id, e.amount);

  v_id := public.post_journal(
    e.branch_id,
    e.expense_date,
    'Expense ' || e.expense_number || ': ' || v_cat,
    'expense', e.id, null, null,
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('account_id', e.expense_account_id,
        'debit', e.amount, 'credit', 0, 'memo', e.description),
      pg_catalog.jsonb_build_object('account_id', e.payment_account_id,
        'debit', 0, 'credit', e.amount, 'memo', 'Paid from ' || v_paid)
    ),
    e.occurred_at, e.recorded_by, e.recorded_by_label
  );

  update public.expenses set journal_entry_id = v_id, status = 'posted' where id = e.id;

  return v_id;
end;
$$;

revoke all on function public.post_expense_journal(uuid) from public, anon, authenticated;

create or replace function public.record_expense(
  p_expense_account_id uuid,
  p_payment_account_id uuid,
  p_amount bigint,
  p_expense_date date,
  p_description text,
  p_payee text default null,
  p_external_reference text default null,
  p_receipt_path text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor     uuid;
  v_label     text;
  v_branch    uuid;
  v_threshold bigint;
  v_number    text;
  v_status    text;
  v_id        uuid;
begin
  if auth.uid() is not null and not public.user_has_permission('expenses:create') then
    raise exception 'Recording an expense requires the expenses:create capability.'
      using errcode = 'P0001';
  end if;

  v_actor := public.current_profile_id();
  v_label := public.audit_actor_label();

  if p_amount is null or p_amount <= 0 then
    raise exception 'An expense must be more than zero shillings.' using errcode = 'P0001';
  end if;

  if btrim(coalesce(p_description, '')) = '' then
    raise exception 'An expense needs a description saying what it was for.'
      using errcode = 'P0001';
  end if;

  perform public.assert_postable_account(p_expense_account_id, 'expense', 'expense category');
  perform public.assert_cash_account(p_payment_account_id, 'source');

  select a.branch_id into v_branch from public.ledger_accounts a where a.id = p_payment_account_id;

  select fs.expense_approval_threshold into v_threshold
  from public.finance_settings fs where fs.id = 1;

  v_status := case
    when v_threshold is not null and p_amount > v_threshold then 'pending_approval'
    else 'posted'
  end;

  v_number := public.next_reference('expense');

  insert into public.expenses (
    expense_number, branch_id, expense_account_id, payment_account_id, amount,
    expense_date, occurred_at, payee, description, external_reference, receipt_path,
    status, recorded_by, recorded_by_label
  )
  values (
    v_number, v_branch, p_expense_account_id, p_payment_account_id, p_amount,
    coalesce(p_expense_date, public.business_date()), public.business_now(),
    nullif(btrim(coalesce(p_payee, '')), ''),
    btrim(p_description),
    nullif(btrim(coalesce(p_external_reference, '')), ''),
    nullif(btrim(coalesce(p_receipt_path, '')), ''),
    'pending_approval', v_actor, v_label
  )
  returning id into v_id;

  if v_status = 'posted' then
    perform public.post_expense_journal(v_id);
  end if;

  perform public.record_audit_event(
    'expense.recorded', 'expense', v_id::text, null,
    pg_catalog.jsonb_build_object(
      'expense_number', v_number, 'amount', p_amount, 'status', v_status),
    null, null
  );

  return v_id;
end;
$$;

comment on function public.record_expense(uuid, uuid, bigint, date, text, text, text, text) is
  'Phase 11. Dr the expense category, Cr the account it was paid from. Waits for approval above the configured threshold, in which case no journal is written until somebody approves.';

revoke all on function public.record_expense(uuid, uuid, bigint, date, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.record_expense(uuid, uuid, bigint, date, text, text, text, text)
  to authenticated;

create or replace function public.approve_expense(p_expense_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  e record;
begin
  if auth.uid() is not null and not public.user_has_permission('expenses:approve') then
    raise exception 'Approving an expense requires the expenses:approve capability.'
      using errcode = 'P0001';
  end if;

  select * into e from public.expenses where id = p_expense_id for update;

  if e.id is null then
    raise exception 'No such expense.' using errcode = 'P0001';
  end if;

  if e.status <> 'pending_approval' then
    raise exception 'Expense % is %, so there is nothing to approve.',
      e.expense_number, e.status using errcode = 'P0001';
  end if;

  if e.recorded_by is not null and e.recorded_by = public.current_profile_id() then
    raise exception 'An expense cannot be approved by the person who recorded it.'
      using errcode = 'P0001';
  end if;

  update public.expenses
     set approved_by = public.current_profile_id(),
         approved_by_label = public.audit_actor_label(),
         approved_at = public.business_now()
   where id = e.id;

  perform public.post_expense_journal(e.id);

  perform public.record_audit_event(
    'expense.approved', 'expense', e.id::text, null,
    pg_catalog.jsonb_build_object('expense_number', e.expense_number, 'amount', e.amount),
    null, null
  );

  return e.id;
end;
$$;

revoke all on function public.approve_expense(uuid) from public, anon, authenticated;
grant execute on function public.approve_expense(uuid) to authenticated;

create or replace function public.reject_expense(p_expense_id uuid, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  e record;
begin
  if auth.uid() is not null and not public.user_has_permission('expenses:approve') then
    raise exception 'Rejecting an expense requires the expenses:approve capability.'
      using errcode = 'P0001';
  end if;

  if btrim(coalesce(p_reason, '')) = '' then
    raise exception 'Rejecting an expense requires a reason.' using errcode = 'P0001';
  end if;

  select * into e from public.expenses where id = p_expense_id for update;

  if e.id is null then
    raise exception 'No such expense.' using errcode = 'P0001';
  end if;

  if e.status <> 'pending_approval' then
    raise exception 'Expense % is %, so there is nothing to reject.',
      e.expense_number, e.status using errcode = 'P0001';
  end if;

  update public.expenses
     set status = 'rejected',
         decision_reason = btrim(p_reason),
         approved_by = public.current_profile_id(),
         approved_by_label = public.audit_actor_label(),
         approved_at = public.business_now()
   where id = e.id;

  perform public.record_audit_event(
    'expense.rejected', 'expense', e.id::text, null,
    pg_catalog.jsonb_build_object('expense_number', e.expense_number, 'reason', btrim(p_reason)),
    null, null
  );

  return e.id;
end;
$$;

revoke all on function public.reject_expense(uuid, text) from public, anon, authenticated;
grant execute on function public.reject_expense(uuid, text) to authenticated;

create or replace function public.reverse_expense(p_expense_id uuid, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  e        record;
  v_contra uuid;
begin
  if auth.uid() is not null and not public.user_has_permission('expenses:approve') then
    raise exception 'Reversing an expense requires the expenses:approve capability.'
      using errcode = 'P0001';
  end if;

  if btrim(coalesce(p_reason, '')) = '' then
    raise exception 'Reversing an expense requires a reason.' using errcode = 'P0001';
  end if;

  select * into e from public.expenses where id = p_expense_id for update;

  if e.id is null then
    raise exception 'No such expense.' using errcode = 'P0001';
  end if;

  if e.status <> 'posted' then
    raise exception 'Only a posted expense can be reversed; expense % is %.',
      e.expense_number, e.status using errcode = 'P0001';
  end if;

  v_contra := public.post_journal(
    e.branch_id,
    public.business_date(),
    'Reversal of expense ' || e.expense_number,
    'expense_reversal', e.id, null, null,
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('account_id', e.payment_account_id,
        'debit', e.amount, 'credit', 0, 'memo', 'Money returned'),
      pg_catalog.jsonb_build_object('account_id', e.expense_account_id,
        'debit', 0, 'credit', e.amount, 'memo', btrim(p_reason))
    ),
    public.business_now(), public.current_profile_id(), public.audit_actor_label()
  );

  update public.expenses
     set status = 'reversed',
         reversal_entry_id = v_contra,
         reversed_at = public.business_now(),
         reversed_by = public.current_profile_id(),
         decision_reason = btrim(p_reason)
   where id = e.id;

  update public.journal_entries
     set reversed_by_entry_id = v_contra
   where id = e.journal_entry_id and reversed_by_entry_id is null;

  perform public.record_audit_event(
    'expense.reversed', 'expense', e.id::text, null,
    pg_catalog.jsonb_build_object('expense_number', e.expense_number, 'reason', btrim(p_reason)),
    null, null
  );

  return v_contra;
end;
$$;

revoke all on function public.reverse_expense(uuid, text) from public, anon, authenticated;
grant execute on function public.reverse_expense(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
