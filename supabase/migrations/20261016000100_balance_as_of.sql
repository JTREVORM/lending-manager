-- ===========================================================================
-- Phase 13.1 — a count is compared against the balance on the day it was made
--
-- `submit_reconciliation` has always accepted a `p_business_date` in the past.
-- It then read the account's balance with `ledger_account_balance`, which sums
-- every journal line ever written to the account, with no date bound. So a
-- count recorded for a past day was compared against *today's* books, and the
-- variance it stored — the figure `approve_reconciliation` later writes off to
-- Cash Over and Short — was the sum of the genuine difference on that day and
-- every movement since.
--
-- A till counted on the 15th and entered on the 20th is ordinary bookkeeping,
-- so the date was not the mistake; reading the balance without it was. This
-- adds the as-of reading and uses it.
--
-- Same-day counts, which is every count the application itself submits, are
-- unaffected: as of today is today's balance.
-- ===========================================================================

create or replace function public.ledger_account_balance_as_of(
  p_account_id uuid,
  p_as_of date
)
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
  select a.normal_side into v_side
  from public.ledger_accounts a where a.id = p_account_id;

  if v_side is null then
    raise exception 'No such ledger account.' using errcode = 'P0001';
  end if;

  -- `entry_date` is the business date of the entry, which is the date the
  -- money moved. `posted_at` is when somebody typed it in, and counting by
  -- that would put a backdated correction on the wrong side of the cut-off.
  select coalesce(pg_catalog.sum(l.debit), 0), coalesce(pg_catalog.sum(l.credit), 0)
    into v_debit, v_credit
  from public.journal_lines l
  join public.journal_entries e on e.id = l.entry_id
  where l.account_id = p_account_id
    and e.entry_date <= p_as_of;

  if v_side = 'debit' then
    return v_debit - v_credit;
  end if;

  return v_credit - v_debit;
end;
$$;

comment on function public.ledger_account_balance_as_of(uuid, date) is
  'Phase 13. What an account''s books said at the end of a given business date. `ledger_account_balance` is the same reading with no cut-off, and remains the right one for "can this money leave now".';

revoke all on function public.ledger_account_balance_as_of(uuid, date) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Re-emitted: the count is read against its own business date
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
  'Phase 11, amended in Phase 13. Record what was counted against what the ledger said on the date of the count. A count that agrees is balanced and posts nothing; one that differs waits, visibly, until somebody approves the write-off.';

revoke all on function public.submit_reconciliation(uuid, date, bigint, text)
  from public, anon, authenticated;
grant execute on function public.submit_reconciliation(uuid, date, bigint, text) to authenticated;
