create or replace function public.notify_transfer_pending()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r      record;
  v_from text;
  v_to   text;
begin
  -- Deferred to commit, so this is the status the transaction settled on
  -- rather than the one the insert started with.
  select * into r from public.account_transfers where id = new.id;

  if r.id is null or r.status <> 'pending_approval' then
    return null;
  end if;

  select a.name into v_from from public.ledger_accounts a where a.id = r.from_account_id;
  select a.name into v_to   from public.ledger_accounts a where a.id = r.to_account_id;

  perform public.raise_notification(
    'approval_pending', 'attention',
    pg_catalog.format('%s is awaiting approval', r.transfer_number),
    pg_catalog.format('UGX %s from %s to %s.',
      pg_catalog.to_char(r.amount, 'FM999,999,999,999'),
      coalesce(v_from, 'an account'), coalesce(v_to, 'an account')),
    'transfers:approve', 'transfer', r.id,
    pg_catalog.format('transfer:%s:pending', r.id),
    null, r.branch_id
  );

  return null;
end;
$$;

comment on function public.notify_transfer_pending() is
  'Phase 15, corrected in Phase 13. A transfer over the approval threshold waits for a decision; without this it waits until somebody opens the transfers screen. Deferred to commit, because `record_transfer` inserts every transfer as pending and promotes the ones that post.';

revoke all on function public.notify_transfer_pending() from public, anon, authenticated;

drop trigger if exists notify_transfer_pending on public.account_transfers;

create constraint trigger notify_transfer_pending
  after insert on public.account_transfers
  deferrable initially deferred
  for each row
  execute function public.notify_transfer_pending();

create or replace function public.notify_expense_pending()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
begin
  select * into r from public.expenses where id = new.id;

  if r.id is null or r.status <> 'pending_approval' then
    return null;
  end if;

  perform public.raise_notification(
    'approval_pending', 'attention',
    pg_catalog.format('%s is awaiting approval', r.expense_number),
    pg_catalog.format('UGX %s — %s.',
      pg_catalog.to_char(r.amount, 'FM999,999,999,999'), r.description),
    'expenses:approve', 'expense', r.id,
    pg_catalog.format('expense:%s:pending', r.id),
    null, r.branch_id
  );

  return null;
end;
$$;

comment on function public.notify_expense_pending() is
  'Phase 15, corrected in Phase 13. The same for an expense over its threshold, deferred for the same reason.';

revoke all on function public.notify_expense_pending() from public, anon, authenticated;

drop trigger if exists notify_expense_pending on public.expenses;

create constraint trigger notify_expense_pending
  after insert on public.expenses
  deferrable initially deferred
  for each row
  execute function public.notify_expense_pending();

create or replace function public.notify_reconciliation_variance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r         record;
  v_account text;
begin
  select * into r from public.account_reconciliations where id = new.id;

  -- A count that was approved inside the same transaction — which is what
  -- `submit_reconciliation` does when the business has said a second review
  -- is not required — is not awaiting anybody.
  if r.id is null or r.status <> 'submitted' then
    return null;
  end if;

  select a.name into v_account
    from public.ledger_accounts a where a.id = r.account_id;

  perform public.raise_notification(
    'reconciliation_variance',
    -- A count that balances needs no notification; one that does not is money
    -- unaccounted for, which is the most serious thing this system can say.
    case when r.variance = 0 then 'attention' else 'urgent' end,
    case
      when r.variance = 0 then
        pg_catalog.format('%s is awaiting review', r.reconciliation_number)
      else
        pg_catalog.format('%s does not balance: UGX %s',
          r.reconciliation_number,
          pg_catalog.to_char(r.variance, 'FM999,999,999,999'))
    end,
    pg_catalog.format('%s counted on %s. System UGX %s, counted UGX %s. %s',
      coalesce(v_account, 'An account'),
      pg_catalog.to_char(r.business_date, 'DD Mon YYYY'),
      pg_catalog.to_char(r.system_balance, 'FM999,999,999,999'),
      pg_catalog.to_char(r.counted_balance, 'FM999,999,999,999'),
      coalesce(r.explanation, 'No explanation was given.')),
    'reconciliation:approve', 'reconciliation', r.id,
    pg_catalog.format('reconciliation:%s:submitted', r.id),
    null, r.branch_id
  );

  return null;
end;
$$;

comment on function public.notify_reconciliation_variance() is
  'Phase 15, corrected in Phase 13. Urgent where the count did not balance, because money unaccounted for is the most serious thing this system can report; merely awaiting review is attention. Deferred to commit, so a difference written off on submission is not announced as waiting.';

revoke all on function public.notify_reconciliation_variance() from public, anon, authenticated;

drop trigger if exists notify_reconciliation_variance on public.account_reconciliations;

create constraint trigger notify_reconciliation_variance
  after insert on public.account_reconciliations
  deferrable initially deferred
  for each row
  execute function public.notify_reconciliation_variance();