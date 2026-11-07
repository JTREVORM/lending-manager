-- ===========================================================================
-- Phase 4A — the low-float warning covers agency float
--
-- `20261107000100` added `finance_settings.low_balance_agency_float`, and
-- nothing read it. `notify_low_float()` picks a threshold with a CASE over the
-- four original kinds; `agency_float` fell through, left `v_threshold` NULL,
-- and hit the `continue` — so every float account was silently skipped.
--
-- That is the wrong failure in both directions. The column I added did
-- nothing, which is worse than not adding it, and an agent whose MTN float is
-- nearly spent got no warning — on the one balance where running out stops
-- the counter dead, because unlike a till it cannot be topped up from the
-- drawer.
--
-- Found by auditing the consumers of `cash_kind` after widening the
-- constraint, not by a failing test: no test covered the fall-through,
-- because before this phase there was no fifth kind to fall through.
--
-- The function is otherwise reproduced exactly: same once-per-account-per-day
-- key, same `ledger:view` audience, same "a float running low is a thing to
-- know about rather than a thing to refuse".
-- ===========================================================================

create or replace function public.notify_low_float()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row record;
  v_threshold bigint;
  v_balance bigint;
  v_date date;
begin
  v_date := public.business_date();

  for v_row in
    select distinct a.id, a.name, a.cash_kind, a.branch_id
      from inserted i
      join public.ledger_accounts a on a.id = i.account_id
     where a.cash_kind is not null
  loop
    select case v_row.cash_kind
             when 'cash_at_hand'     then s.low_balance_cash_at_hand
             when 'mtn_mobile_money' then s.low_balance_mtn_mobile_money
             when 'airtel_money'     then s.low_balance_airtel_money
             when 'bank'             then s.low_balance_bank
             -- Phase 4A. Its own threshold, never the cash one: the whole
             -- point of keeping the settings apart is that a float limit and
             -- a till limit are different judgements.
             when 'agency_float'     then s.low_balance_agency_float
           end
      into v_threshold
      from public.finance_settings s
     limit 1;

    if v_threshold is null then
      continue;
    end if;

    select b.balance into v_balance
      from public.ledger_account_balances b
     where b.account_id = v_row.id;

    if coalesce(v_balance, 0) <= v_threshold then
      perform public.raise_notification(
        'low_float', 'attention',
        pg_catalog.format('%s is low', v_row.name),
        pg_catalog.format('UGX %s left, against a floor of UGX %s.',
          pg_catalog.to_char(coalesce(v_balance, 0), 'FM999,999,999,999'),
          pg_catalog.to_char(v_threshold, 'FM999,999,999,999')),
        'ledger:view', 'ledger_account', v_row.id,
        -- Once per account per business day. Nothing enforces a floor — a
        -- float running low is a thing to know about rather than a thing to
        -- refuse, as Phase 11 put it — so the notification is the whole
        -- mechanism and it must not become noise.
        pg_catalog.format('float:%s:%s', v_row.id, v_date),
        null, v_row.branch_id
      );
    end if;
  end loop;

  return null;
end;
$$;

comment on function public.notify_low_float() is
  'Phase 15, extended in Phase 4A. Warns once per cash account per business day when its balance is at or below its own threshold. Agency float reads low_balance_agency_float, never a cash threshold. Refuses nothing: a low float is a thing to know about.';
