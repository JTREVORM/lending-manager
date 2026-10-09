-- ===========================================================================
-- Phase 11.2b — shared validation and the transfer path
--
-- Part of Phase 11.2; the design notes are at the head of
-- 20261011000200_money_movement_tables.sql.
-- ===========================================================================

-- Shared validation
-- ---------------------------------------------------------------------------

create or replace function public.assert_cash_account(p_account_id uuid, p_role text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  r record;
begin
  select a.cash_kind, a.status, a.name, a.is_postable into r
  from public.ledger_accounts a where a.id = p_account_id;

  if r is null then
    raise exception 'The % account does not exist.', p_role using errcode = 'P0001';
  end if;

  if r.cash_kind is null then
    raise exception
      '% is not a cash account, so money cannot be % it.', r.name,
      case p_role when 'source' then 'taken out of' else 'put into' end
      using errcode = 'P0001';
  end if;

  if r.status <> 'active' or not r.is_postable then
    raise exception '% is not active, so it cannot be used.', r.name
      using errcode = 'P0001';
  end if;
end;
$$;

revoke all on function public.assert_cash_account(uuid, text) from public, anon, authenticated;

create or replace function public.assert_postable_account(
  p_account_id uuid, p_type text, p_role text
)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  r record;
begin
  select a.account_type, a.status, a.name, a.is_postable, a.code into r
  from public.ledger_accounts a where a.id = p_account_id;

  if r is null then
    raise exception 'The % does not exist.', p_role using errcode = 'P0001';
  end if;

  if r.account_type <> p_type then
    raise exception '% is not an % account.', r.name, p_type using errcode = 'P0001';
  end if;

  if not r.is_postable then
    raise exception '% is a heading and cannot be posted to.', r.name using errcode = 'P0001';
  end if;

  if r.status <> 'active' then
    raise exception '% is not active, so it cannot be used.', r.name using errcode = 'P0001';
  end if;

  -- Interest and penalty income are written by the loan functions from a
  -- payment's own allocation components. A fee recorded here landing in
  -- either would break the Phase 10 reconciliation that proves interest
  -- income equals the interest actually collected.
  if p_type = 'income' and r.code in ('4100', '4200') then
    raise exception
      '% is posted by the lending functions from payment allocations. Record a fee against a fee account instead.',
      r.name
      using errcode = 'P0001';
  end if;
end;
$$;

revoke all on function public.assert_postable_account(uuid, text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Transfers: record, approve, reject, reverse
-- ---------------------------------------------------------------------------

create or replace function public.post_transfer_journal(p_transfer_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  t      record;
  v_from text;
  v_to   text;
  v_id   uuid;
begin
  select * into t from public.account_transfers where id = p_transfer_id for update;

  if t.id is null then
    raise exception 'No such transfer.' using errcode = 'P0001';
  end if;

  if t.journal_entry_id is not null then
    return null;
  end if;

  select name into v_from from public.ledger_accounts where id = t.from_account_id;
  select name into v_to   from public.ledger_accounts where id = t.to_account_id;

  -- Checked here rather than at submission, because the balance that matters
  -- is the one at the moment the money actually leaves.
  perform public.assert_cash_available(t.from_account_id, t.amount);

  v_id := public.post_journal(
    t.branch_id,
    t.transfer_date,
    'Transfer ' || t.transfer_number || ': ' || v_from || ' to ' || v_to,
    'transfer', t.id, null, null,
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('account_id', t.to_account_id,
        'debit', t.amount, 'credit', 0, 'memo', 'Received into ' || v_to),
      pg_catalog.jsonb_build_object('account_id', t.from_account_id,
        'debit', 0, 'credit', t.amount, 'memo', 'Sent from ' || v_from)
    ),
    t.occurred_at, t.initiated_by, t.initiated_by_label
  );

  update public.account_transfers
     set journal_entry_id = v_id, status = 'posted'
   where id = t.id;

  return v_id;
end;
$$;

revoke all on function public.post_transfer_journal(uuid) from public, anon, authenticated;

create or replace function public.record_transfer(
  p_from_account_id uuid,
  p_to_account_id uuid,
  p_amount bigint,
  p_transfer_date date,
  p_description text,
  p_external_reference text default null
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
  if auth.uid() is not null and not public.user_has_permission('transfers:create') then
    raise exception 'Moving money between accounts requires the transfers:create capability.'
      using errcode = 'P0001';
  end if;

  v_actor := public.current_profile_id();
  v_label := public.audit_actor_label();

  if p_amount is null or p_amount <= 0 then
    raise exception 'A transfer must be more than zero shillings.' using errcode = 'P0001';
  end if;

  if p_from_account_id = p_to_account_id then
    raise exception 'A transfer needs two different accounts.' using errcode = 'P0001';
  end if;

  perform public.assert_cash_account(p_from_account_id, 'source');
  perform public.assert_cash_account(p_to_account_id, 'destination');

  if btrim(coalesce(p_description, '')) = '' then
    raise exception 'A transfer needs a description saying why the money moved.'
      using errcode = 'P0001';
  end if;

  -- The source account's branch owns the movement.
  select a.branch_id into v_branch from public.ledger_accounts a where a.id = p_from_account_id;

  select fs.transfer_approval_threshold into v_threshold
  from public.finance_settings fs where fs.id = 1;

  v_status := case
    when v_threshold is not null and p_amount > v_threshold then 'pending_approval'
    else 'posted'
  end;

  v_number := public.next_reference('transfer');

  insert into public.account_transfers (
    transfer_number, branch_id, from_account_id, to_account_id, amount,
    transfer_date, occurred_at, external_reference, description, status,
    initiated_by, initiated_by_label
  )
  values (
    v_number, v_branch, p_from_account_id, p_to_account_id, p_amount,
    coalesce(p_transfer_date, public.business_date()), public.business_now(),
    nullif(btrim(coalesce(p_external_reference, '')), ''),
    btrim(p_description),
    -- Inserted as pending in both cases and promoted by the posting function,
    -- so there is exactly one place that sets `posted`, and it is the place
    -- that writes the journal.
    'pending_approval',
    v_actor, v_label
  )
  returning id into v_id;

  if v_status = 'posted' then
    perform public.post_transfer_journal(v_id);
  end if;

  perform public.record_audit_event(
    'transfer.recorded', 'account_transfer', v_id::text, null,
    pg_catalog.jsonb_build_object(
      'transfer_number', v_number, 'amount', p_amount, 'status', v_status),
    null, null
  );

  return v_id;
end;
$$;

comment on function public.record_transfer(uuid, uuid, bigint, date, text, text) is
  'Phase 11. Move money between two of the company''s cash accounts. Posts immediately unless the amount is above the configured approval threshold, in which case it waits and no journal is written.';

revoke all on function public.record_transfer(uuid, uuid, bigint, date, text, text)
  from public, anon, authenticated;
grant execute on function public.record_transfer(uuid, uuid, bigint, date, text, text) to authenticated;

create or replace function public.approve_transfer(p_transfer_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  t record;
begin
  if auth.uid() is not null and not public.user_has_permission('transfers:approve') then
    raise exception 'Approving a transfer requires the transfers:approve capability.'
      using errcode = 'P0001';
  end if;

  select * into t from public.account_transfers where id = p_transfer_id for update;

  if t.id is null then
    raise exception 'No such transfer.' using errcode = 'P0001';
  end if;

  if t.status <> 'pending_approval' then
    raise exception 'Transfer % is %, so there is nothing to approve.',
      t.transfer_number, t.status using errcode = 'P0001';
  end if;

  -- The approver is not the person who asked. Separation of duties is the
  -- only thing an approval step buys, and without this the step is theatre.
  if t.initiated_by is not null and t.initiated_by = public.current_profile_id() then
    raise exception 'A transfer cannot be approved by the person who requested it.'
      using errcode = 'P0001';
  end if;

  update public.account_transfers
     set approved_by = public.current_profile_id(),
         approved_by_label = public.audit_actor_label(),
         approved_at = public.business_now()
   where id = t.id;

  perform public.post_transfer_journal(t.id);

  perform public.record_audit_event(
    'transfer.approved', 'account_transfer', t.id::text, null,
    pg_catalog.jsonb_build_object('transfer_number', t.transfer_number, 'amount', t.amount),
    null, null
  );

  return t.id;
end;
$$;

revoke all on function public.approve_transfer(uuid) from public, anon, authenticated;
grant execute on function public.approve_transfer(uuid) to authenticated;

create or replace function public.reject_transfer(p_transfer_id uuid, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  t record;
begin
  if auth.uid() is not null and not public.user_has_permission('transfers:approve') then
    raise exception 'Rejecting a transfer requires the transfers:approve capability.'
      using errcode = 'P0001';
  end if;

  if btrim(coalesce(p_reason, '')) = '' then
    raise exception 'Rejecting a transfer requires a reason.' using errcode = 'P0001';
  end if;

  select * into t from public.account_transfers where id = p_transfer_id for update;

  if t.id is null then
    raise exception 'No such transfer.' using errcode = 'P0001';
  end if;

  if t.status <> 'pending_approval' then
    raise exception 'Transfer % is %, so there is nothing to reject.',
      t.transfer_number, t.status using errcode = 'P0001';
  end if;

  update public.account_transfers
     set status = 'rejected',
         decision_reason = btrim(p_reason),
         approved_by = public.current_profile_id(),
         approved_by_label = public.audit_actor_label(),
         approved_at = public.business_now()
   where id = t.id;

  perform public.record_audit_event(
    'transfer.rejected', 'account_transfer', t.id::text, null,
    pg_catalog.jsonb_build_object('transfer_number', t.transfer_number, 'reason', btrim(p_reason)),
    null, null
  );

  return t.id;
end;
$$;

revoke all on function public.reject_transfer(uuid, text) from public, anon, authenticated;
grant execute on function public.reject_transfer(uuid, text) to authenticated;

create or replace function public.reverse_transfer(p_transfer_id uuid, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  t        record;
  v_from   text;
  v_to     text;
  v_contra uuid;
begin
  if auth.uid() is not null and not public.user_has_permission('transfers:approve') then
    raise exception 'Reversing a transfer requires the transfers:approve capability.'
      using errcode = 'P0001';
  end if;

  if btrim(coalesce(p_reason, '')) = '' then
    raise exception 'Reversing a transfer requires a reason.' using errcode = 'P0001';
  end if;

  select * into t from public.account_transfers where id = p_transfer_id for update;

  if t.id is null then
    raise exception 'No such transfer.' using errcode = 'P0001';
  end if;

  if t.status <> 'posted' then
    raise exception 'Only a posted transfer can be reversed; transfer % is %.',
      t.transfer_number, t.status using errcode = 'P0001';
  end if;

  select name into v_from from public.ledger_accounts where id = t.from_account_id;
  select name into v_to   from public.ledger_accounts where id = t.to_account_id;

  -- The money goes back where it came from, so the destination must still
  -- hold it.
  perform public.assert_cash_available(t.to_account_id, t.amount);

  v_contra := public.post_journal(
    t.branch_id,
    public.business_date(),
    'Reversal of transfer ' || t.transfer_number,
    'transfer_reversal', t.id, null, null,
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('account_id', t.from_account_id,
        'debit', t.amount, 'credit', 0, 'memo', 'Returned to ' || v_from),
      pg_catalog.jsonb_build_object('account_id', t.to_account_id,
        'debit', 0, 'credit', t.amount, 'memo', btrim(p_reason))
    ),
    public.business_now(), public.current_profile_id(), public.audit_actor_label()
  );

  update public.account_transfers
     set status = 'reversed',
         reversal_entry_id = v_contra,
         reversed_at = public.business_now(),
         reversed_by = public.current_profile_id(),
         decision_reason = btrim(p_reason)
   where id = t.id;

  update public.journal_entries
     set reversed_by_entry_id = v_contra
   where id = t.journal_entry_id and reversed_by_entry_id is null;

  perform public.record_audit_event(
    'transfer.reversed', 'account_transfer', t.id::text, null,
    pg_catalog.jsonb_build_object('transfer_number', t.transfer_number, 'reason', btrim(p_reason)),
    null, null
  );

  return v_contra;
end;
$$;

revoke all on function public.reverse_transfer(uuid, text) from public, anon, authenticated;
grant execute on function public.reverse_transfer(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
