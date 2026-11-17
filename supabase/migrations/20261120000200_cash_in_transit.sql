-- ===========================================================================
-- Decision A, part 2 of 4 — Cash in Transit
--
-- A bank deposit is money that has left the till and has not yet arrived at
-- the bank. Until now a deposit was an `account_transfers` row, and
-- `post_transfer_journal` debited the bank in the same transaction it credited
-- the till — so a deposit was spendable from the bank the instant it was
-- typed, before any bank had seen it (rule 5, 7 and 8 of the Owner's ruling).
--
-- `1050-<branch> Cash in Transit` is the sixth cash kind: an asset, held by a
-- branch, that money moves into when a deposit is recorded and out of when a
-- different officer verifies the bank's clearance (part 3) or verifies that
-- the physical cash came back.
--
-- ## Why this migration is one piece, and three things ship together
--
-- A sixth `cash_kind` has three inseparable consequences, exactly as the fifth
-- had when Phase 4A added `agency_float` (20261107000900):
--
--   1. `branch_cash_position` gains an `in_transit` component in the SAME
--      migration. `total_liquidity` is `sum(balance) where cash_kind is not
--      null`, so a kind that is not also a named component makes the parts
--      stop summing to the total and two certified identities fail.
--
--   2. `assert_cash_account` refuses `in_transit` in the SAME migration. It
--      tests only `cash_kind is null`, so the moment the kind is legal, Cash
--      in Transit becomes a valid `record_transfer` endpoint — and a transfer
--      needs only `transfers:create`. Only the dedicated clearance and
--      physical-return functions may move transit; anything else is a bypass
--      of the control being built.
--
--   3. One transit account per branch, enforced structurally, so no
--      alphabetical `limit 1` can ever pick between two.
--
-- Transit money stays inside book liquidity — it is the company's money, it
-- is just not spendable yet — and `cash_account_availability` reports it with
-- an available figure of zero, because `assert_spendable_account` refuses it.
-- ===========================================================================

-- 1. The kind.
alter table public.ledger_accounts
  drop constraint ledger_accounts_cash_kind_valid;

alter table public.ledger_accounts
  add constraint ledger_accounts_cash_kind_valid
  check (
    cash_kind is null
    or cash_kind in ('cash_at_hand', 'mtn_mobile_money', 'airtel_money', 'bank',
                     'agency_float', 'in_transit')
  );

-- 2. One per branch.
create unique index ledger_accounts_one_transit_per_branch
  on public.ledger_accounts (branch_id)
  where cash_kind = 'in_transit';

-- 3. The account, created on demand and idempotently, so a branch opened
--    after this migration gets one the first time anybody deposits from it.
create or replace function public.ensure_branch_transit_account(p_branch_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id   uuid;
  b      record;
begin
  select a.id into v_id
    from public.ledger_accounts a
   where a.branch_id = p_branch_id and a.cash_kind = 'in_transit';

  if v_id is not null then
    return v_id;
  end if;

  select br.id, br.branch_code, br.name into b
    from public.branches br where br.id = p_branch_id;

  if b.id is null then
    raise exception 'No such branch.' using errcode = 'P0001';
  end if;

  insert into public.ledger_accounts
    (code, name, account_type, normal_side, cash_kind, branch_id, is_postable, status,
     description)
  values
    ('1050-' || b.branch_code, 'Cash in Transit — ' || b.name,
     'asset', 'debit', 'in_transit', b.id, true, 'active',
     'Decision A. Money that has left the till for the bank and has not yet been cleared by the bank. Not spendable. Moved only by a verified clearance or a verified physical return.')
  on conflict (branch_id) where cash_kind = 'in_transit' do nothing;

  select a.id into v_id
    from public.ledger_accounts a
   where a.branch_id = p_branch_id and a.cash_kind = 'in_transit';

  return v_id;
end;
$$;

revoke all on function public.ensure_branch_transit_account(uuid) from public, anon, authenticated;

-- Every branch that exists today.
do $$
declare
  v_branch uuid;
begin
  for v_branch in select id from public.branches loop
    perform public.ensure_branch_transit_account(v_branch);
  end loop;
end;
$$;

-- 4. Hardening. Re-emitted from the live definition (20261107000900) with one
--    refusal added, in the same migration that made the kind legal.
create or replace function public.assert_cash_account(p_account_id uuid, p_role text)
returns void
language plpgsql
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

  if r.cash_kind = 'agency_float' then
    raise exception
      '% is an agency float account. Float is moved through the agency services module, not through a cash transfer.',
      r.name
      using errcode = 'P0001';
  end if;

  -- Decision A. Transit is moved by a verified clearance or a verified
  -- physical return and by nothing else. A generic transfer into it would
  -- fake a deposit; one out of it would spend money the bank has not cleared.
  if r.cash_kind = 'in_transit' then
    raise exception
      '% is Cash in Transit. Money reaches it by recording a bank deposit and leaves it only when a different officer verifies the bank''s clearance or the physical return of the cash.',
      r.name
      using errcode = 'P0001';
  end if;

  if r.status <> 'active' or not r.is_postable then
    raise exception '% is not active, so it cannot be used.', r.name
      using errcode = 'P0001';
  end if;
end;
$$;

-- 5. The position screen gains its sixth component. Appended after
--    `agency_float`, because `create or replace view` can only add a column
--    at the end; every existing column keeps its name, type and position.
create or replace view public.branch_cash_position with (security_invoker = true) as
select
  b.id as branch_id,
  b.branch_code,
  b.name as branch_name,
  b.status as branch_status,
  coalesce(pg_catalog.sum(bal.balance) filter (where bal.cash_kind = 'cash_at_hand'), 0)::bigint
    as cash_at_hand,
  coalesce(pg_catalog.sum(bal.balance) filter (where bal.cash_kind = 'mtn_mobile_money'), 0)::bigint
    as mtn_mobile_money,
  coalesce(pg_catalog.sum(bal.balance) filter (where bal.cash_kind = 'airtel_money'), 0)::bigint
    as airtel_money,
  coalesce(pg_catalog.sum(bal.balance) filter (where bal.cash_kind = 'bank'), 0)::bigint
    as cash_at_bank,
  coalesce(pg_catalog.sum(bal.balance), 0)::bigint as total_liquidity,
  coalesce(pg_catalog.sum(bal.balance) filter (where bal.cash_kind = 'agency_float'), 0)::bigint
    as agency_float,
  -- Decision A. The sixth kind, as its own line so the parts still sum to the
  -- total. Money on its way to the bank: inside book liquidity, outside
  -- anything spendable.
  coalesce(pg_catalog.sum(bal.balance) filter (where bal.cash_kind = 'in_transit'), 0)::bigint
    as in_transit
from public.branches b
left join public.ledger_account_balances bal
  on bal.branch_id = b.id and bal.cash_kind is not null
group by b.id;

comment on view public.branch_cash_position is
  'Phase 10, extended in Phase 4A and Decision A. Where the company''s money is, by branch: till cash, the two wallets, the bank, agency float, cash in transit to the bank, and the total of all six. total_liquidity is every account with a cash_kind, so it equals the sum of the six components and equals the general ledger — both identities are walked by scripts/certify-financial-reconciliation.mjs. Nothing on this view is spendable by virtue of being here: available funds are cash_account_availability.';
