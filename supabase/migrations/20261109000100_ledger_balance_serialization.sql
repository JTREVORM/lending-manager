-- ===========================================================================
-- Phase 4B-S — serialise the accounts a posting is about to draw down
--
-- ## The race, reproduced before it was fixed
--
-- Two *distinct* agency transactions, each affordable on its own:
--
--   float funded 100,000; two deposits of 60,000   -> float ended at -20,000
--   cash at hand 120,000; two withdrawals of 72,000 -> cash ended at -24,000
--
-- Both posted. The trial balance still footed, because each entry balanced on
-- its own — the overdraft is a business-rule breach, not an accounting one,
-- which is exactly why no existing identity caught it.
--
-- `assert_cash_available()` and `assert_agency_float_available()` read a
-- balance and compare it. Nothing held that balance still between the read and
-- the write, so two transactions could both read 100,000, both conclude that
-- 60,000 was affordable, and both post.
--
-- ## Why the existing serialization does not help
--
-- Journal posting is already serialised: `post_journal()` calls
-- `next_reference('journal')`, whose row lock on the counter holds until
-- commit, so two postings cannot interleave. But that lock is taken **after**
-- the balance check. It orders the two writes; it cannot stop the second one
-- from having decided it was affordable against a balance the first had
-- already spent. Staging the reproduction around that lock is what made the
-- overdraft visible.
--
-- A unique index on the low-balance notification's dedupe key also serialises
-- two postings to the same account on the same day — but only once the balance
-- is at or below the threshold, and again too late. Neither is a control.
--
-- ## The fix
--
-- A transaction-scoped advisory lock per ledger account, taken **before** the
-- balance is read, so the check and the write are atomic with respect to any
-- other transaction touching the same account.
--
-- Three properties matter:
--
--   **Deterministic order.** `lock_ledger_balances()` sorts the accounts, so
--   two transactions locking the same pair always take them in the same order
--   and cannot deadlock on each other.
--
--   **Per account, not global.** An advisory lock keyed on the account id
--   serialises only transactions contending for that balance. Two tills, two
--   branches, or a till and a bank account proceed in parallel exactly as
--   before.
--
--   **Fresh reads after the lock.** The lock is acquired first and the balance
--   read after, inside the same assertion, so the waiting transaction sees the
--   committed result of the one it waited for.
--
-- ## Why the lock lives in the shared assertions
--
-- Cash at Hand is not the agency module's. `record_transfer()`,
-- `record_expense()`, `record_other_income()` and `submit_reconciliation()`
-- draw on the same balance, and each reads it through
-- `assert_cash_available()`. Protecting only the agency path would leave an
-- agency withdrawal racing a lending expense on the same till — the same
-- defect with one participant renamed. Putting the lock inside the assertion
-- gives every caller the protection without any of them changing.
--
-- It is additive: no refusal message, SQLSTATE or threshold changes. A
-- transaction that was going to succeed still succeeds; one that would have
-- overdrawn now waits and is then refused on a true balance.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. The lock
-- ---------------------------------------------------------------------------

create or replace function public.lock_ledger_balances(p_account_ids uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  -- Sorted, so every transaction that needs the same two accounts takes them
  -- in the same order. Distinct, so a repeat in the array is not a second
  -- acquisition. NULLs dropped, because an optional account is not an account.
  for v_id in
    select distinct t.x
      from pg_catalog.unnest(p_account_ids) as t(x)
     where t.x is not null
     order by t.x
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(v_id::text, 0));
  end loop;
end;
$$;

comment on function public.lock_ledger_balances(uuid[]) is
  'Phase 4B-S. Takes a transaction-scoped advisory lock on each named ledger account, in sorted order, so a balance check and the posting that depends on it are atomic against any other transaction touching the same account. Per account rather than global: unrelated accounts never contend. Released at commit or rollback, so no caller can leak a lock.';

revoke all on function public.lock_ledger_balances(uuid[]) from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 2. The cash assertion locks before it reads
--
-- Reproduced verbatim from `20261011*` apart from the two added lines, so the
-- refusal a caller sees is unchanged.
-- ---------------------------------------------------------------------------

create or replace function public.assert_cash_available(p_account_id uuid, p_amount bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_allow   boolean;
  v_balance bigint;
  v_name    text;
begin
  -- Phase 4B-S. Before the balance is read, so the read is not stale by the
  -- time the caller posts against it. Every caller of this function — the
  -- agency engine, transfers, expenses, other income and reconciliation —
  -- gains the protection here rather than each implementing its own.
  perform public.lock_ledger_balances(array[p_account_id]);

  select fs.allow_negative_cash into v_allow from public.finance_settings fs where fs.id = 1;

  if coalesce(v_allow, false) then
    return;
  end if;

  v_balance := public.ledger_account_balance(p_account_id);

  if v_balance >= p_amount then
    return;
  end if;

  select a.name into v_name from public.ledger_accounts a where a.id = p_account_id;

  raise exception
    '% holds % shillings, which is less than the % being taken out of it.',
    coalesce(v_name, 'That account'), v_balance, p_amount
    using errcode = 'P0001';
end;
$$;

comment on function public.assert_cash_available(uuid, bigint) is
  'Phase 11, serialised in Phase 4B-S. Refuses a cash movement that would overdraw the account unless finance_settings.allow_negative_cash is set. Locks the account before reading its balance, so two transactions cannot both find the same money affordable.';


-- ---------------------------------------------------------------------------
-- 3. And the float assertion, for the same reason
-- ---------------------------------------------------------------------------

create or replace function public.assert_agency_float_available(
  p_account_id uuid,
  p_amount bigint
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_allow   boolean;
  v_balance bigint;
  v_name    text;
  v_kind    text;
begin
  perform public.lock_ledger_balances(array[p_account_id]);

  select a.name, a.cash_kind into v_name, v_kind
  from public.ledger_accounts a where a.id = p_account_id;

  if v_name is null then
    raise exception 'That float account does not exist.' using errcode = 'P0001';
  end if;

  if v_kind is distinct from 'agency_float' then
    raise exception
      '% is not an agency float account, so the float rule does not apply to it.', v_name
      using errcode = 'P0001';
  end if;

  select fs.allow_negative_agency_float into v_allow
  from public.finance_settings fs where fs.id = 1;

  if coalesce(v_allow, false) then
    return;
  end if;

  v_balance := public.ledger_account_balance(p_account_id);

  if v_balance >= p_amount then
    return;
  end if;

  raise exception
    '% holds % shillings of float, which is less than the % being sent out of it.',
    v_name, v_balance, p_amount
    using errcode = 'P0001';
end;
$$;

comment on function public.assert_agency_float_available(uuid, bigint) is
  'Phase 4A, correction C4, serialised in Phase 4B-S. Refuses an agency float movement that would overdraw the account, reading only allow_negative_agency_float and never allow_negative_cash. Locks the account before reading its balance.';

revoke all on function public.assert_agency_float_available(uuid, bigint)
  from public, anon, authenticated;
