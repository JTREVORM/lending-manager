-- ===========================================================================
-- Workstream A — the shared Cash at Hand till.
--
-- Phase 4C-S closed three agency concurrency races and recorded one risk it
-- did not close: a branch till is shared between agency work and lending, and
-- `approve_agency_cash_reconciliation()` counts the **whole** till. The
-- agency paths lock that account in either direction; the lending paths did
-- not, so a certified count could be measured against a balance a loan
-- repayment had already changed.
--
-- ## The audit
--
-- Twenty-nine functions post a journal. Sixteen took no account lock at all,
-- and seven lending source types move a branch till:
--
--   loan_repayment, savings_deposit, membership_fee        cash in
--   loan_disbursement, benefit_payment, savings_withdrawal cash out
--   savings_deposit_reversal                               cash out
--
-- None of them locked it. The four paths that did - transfers, expenses and
-- two reversals - got the lock only as a side effect of
-- `assert_cash_available()`, and that helper locks the single account it
-- checks. Since sufficiency is only ever checked on the balance being drawn
-- *down*, every account an entry credited went unlocked.
--
-- Phase 4B-S claimed that `record_transfer`, `record_expense`,
-- `record_other_income` and `submit_reconciliation` all gained the protection
-- from that helper. That was true only of the paths that draw down.
-- `record_other_income` credits a till and never calls it; nor does
-- `submit_reconciliation`'s approval. The claim was too broad and is
-- corrected here.
--
-- ## The correction
--
-- The lock goes inside `post_journal()`, which is the single writer of every
-- journal line in the system. One function instead of fourteen, covering
-- every path by construction - including paths added later. No business rule,
-- accounting direction, allocation, schedule, permission or audit behaviour
-- changes; the only new statement acquires a lock.
--
-- Deliberately **not** added: a till sufficiency check on the lending
-- cash-out paths. `disburse_loan`, `post_benefit_payment` and
-- `post_savings_withdrawal` do not check that the till holds the money, so
-- two concurrent disbursements can overdraw it. That is a real finding and it
-- is reported, but adding the check would be a new business rule, and this
-- correction is authorised to add synchronisation only.
-- ===========================================================================

create or replace function public.post_journal(
  p_branch_id uuid,
  p_entry_date date,
  p_description text,
  p_source_type text,
  p_source_id uuid,
  p_loan_id uuid,
  p_client_id uuid,
  p_lines jsonb,
  p_posted_at timestamptz default null,
  p_created_by uuid default null,
  p_created_by_label text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entry_id uuid;
  v_line     jsonb;
  v_number   smallint := 0;
  v_debit    bigint;
  v_credit   bigint;
begin
  -- Workstream A. Every cash and float account this entry touches, locked
  -- before a single line is written and before `next_reference` is taken.
  --
  -- post_journal() is the only writer of journal_entries and journal_lines in
  -- the system, so this is the one place that can cover every posting path -
  -- lending, savings, membership, fees, benefits, agency - and every path
  -- added later, which a list of functions cannot promise.
  --
  -- It is needed because locks were being acquired as a side effect of the
  -- sufficiency checks, and sufficiency is only ever checked on the balance
  -- being drawn *down*. Seven lending source types move a branch till -
  -- loan_repayment, savings_deposit, membership_fee, loan_disbursement,
  -- benefit_payment, savings_withdrawal and a savings reversal - and not one
  -- of them locked it, in either direction. So an agency cash count, which
  -- counts the whole shared till, could be certified against a balance a
  -- repayment had already changed.
  --
  -- Taken before the reference counter, so the global order every poster
  -- follows is: provider lock (where one applies), account locks, counter.
  -- `lock_ledger_balances` sorts by account id, so two callers touching the
  -- same accounts cannot take them in opposite orders.
  perform public.lock_ledger_balances(array(
    select (l ->> 'account_id')::uuid
      from pg_catalog.jsonb_array_elements(p_lines) l
      join public.ledger_accounts a on a.id = (l ->> 'account_id')::uuid
     where a.cash_kind is not null
  ));

  insert into public.journal_entries (
    entry_number, branch_id, entry_date, posted_at, description,
    source_type, source_id, loan_id, client_id, created_by, created_by_label
  )
  values (
    public.next_reference('journal'),
    p_branch_id,
    p_entry_date,
    coalesce(p_posted_at, pg_catalog.now()),
    p_description,
    p_source_type,
    p_source_id,
    p_loan_id,
    p_client_id,
    coalesce(p_created_by, public.current_profile_id()),
    coalesce(nullif(pg_catalog.btrim(coalesce(p_created_by_label, '')), ''),
             public.audit_actor_label())
  )
  returning id into v_entry_id;

  for v_line in select * from pg_catalog.jsonb_array_elements(p_lines)
  loop
    v_debit := coalesce((v_line ->> 'debit')::bigint, 0);
    v_credit := coalesce((v_line ->> 'credit')::bigint, 0);

    -- A component that is zero is not a line. A repayment that happened to
    -- cover no penalty should not carry an empty penalty leg, and the
    -- one-side constraint would refuse it anyway.
    continue when v_debit = 0 and v_credit = 0;

    v_number := v_number + 1;

    insert into public.journal_lines
      (entry_id, line_number, account_id, debit, credit, memo)
    values
      (v_entry_id, v_number, (v_line ->> 'account_id')::uuid, v_debit, v_credit,
       nullif(pg_catalog.btrim(coalesce(v_line ->> 'memo', '')), ''));
  end loop;

  return v_entry_id;
end;
$$;


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
  -- Workstream A. Both accounts, up front and sorted.
  --
  -- A transfer debits one cash account and credits another, and this path
  -- locked only the source - through assert_cash_available, which locks the
  -- one account it checks. Once post_journal() locks every cash account in
  -- the entry, a caller holding just the source would be holding an
  -- out-of-order subset: two opposing transfers could each hold one account
  -- and then wait for the other. Sorted acquisition only prevents a deadlock
  -- when every holder acquires in sorted order from the start.
  perform public.lock_ledger_balances(
    array[t.from_account_id, t.to_account_id]);

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
  -- Workstream A. Both accounts, for the reason given in
  -- post_transfer_journal: a contra moves the same two tills back.
  perform public.lock_ledger_balances(
    array[t.from_account_id, t.to_account_id]);

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
