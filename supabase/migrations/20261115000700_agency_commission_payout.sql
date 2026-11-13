-- ===========================================================================
-- Phase 4E — the commission arrives, and it arrives in the float
--
-- Under the deferred model a transaction's commission is recognised the moment
-- it posts: Dr 1310 Agency Commission Receivable, Cr the provider's income
-- account. Phase 4C can already clear that receivable, with
-- `record_commission_settlement()` — partial settlements, over-settlement
-- refused, a statement reference, a reversal, a correction path. All of it
-- stays.
--
-- What it cannot do is the thing MTN and Airtel actually do.
-- `assert_agency_settlement_account()` refuses an agency float account in so
-- many words: "Use the branch's cash at hand or its bank account … not an
-- agency float account." That refusal is right for the account it was written
-- for — a provider paying commission into the drawer or the bank — and wrong
-- for mobile money, where the commission is credited to the agent line's own
-- float and the agent simply has more float to trade with.
--
-- ## Two things were missing, not one
--
-- **A destination.** A payout into the line's float, which is this
-- migration's `record_agency_commission_payout()`.
--
-- **An attribution.** `agency_commission_outstanding(provider, branch)` reads
-- the GL lines on 1310 and attributes them through the entry's source, which
-- is a good design: the subsidiary figure is derived from the ledger rather
-- than kept beside it, so the two cannot drift. But it stops at the branch,
-- and a branch may run several lines of one provider. Paying 45,000 into the
-- first line when the second earned it would leave both figures wrong and the
-- provider+branch total right, which is the hardest kind of error to find.
-- `agency_commission_outstanding_by_line()` is the same query one level
-- finer, and it is what the payout refuses against.
--
-- ## Why the settlement table is extended rather than duplicated
--
-- A payout is a commission settlement with a different destination. Extending
-- the table keeps one register, one reversal function, one correction path and
-- one set of constraints; a parallel `agency_commission_payouts` table would
-- need its own copy of each, and the two would answer "what has this provider
-- paid us" differently within a month.
--
-- `float_account_id` is NULL for every settlement Phase 4C can make, and
-- non-null for a payout into that line. A CHECK ties it to
-- `settlement_account_id` so the pair cannot disagree about where the money
-- went.
--
-- ## The reference is mandatory (decision OD-8)
--
-- OD-8: "Require a unique provider transaction ID or verifiable statement
-- reference, with duplicate protection scoped appropriately to the provider
-- and agent line."
--
-- Phase 4C's reference is optional, and its uniqueness index is partial, so a
-- NULL reference silently carries no duplicate protection at all — two
-- identical payouts would both post. For a payout the reference is required
-- and unique per line, so the second attempt is refused by the index rather
-- than by anybody noticing.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. The destination on the settlement row
-- ---------------------------------------------------------------------------

alter table public.agency_commission_settlements
  add column if not exists float_account_id uuid
    references public.agency_provider_float_accounts(id) on delete restrict,
  add column if not exists notes text;

comment on column public.agency_commission_settlements.float_account_id is
  'Phase 4E. The agent line whose float received the commission, when the provider paid it there rather than into cash or the bank. NULL is a Phase 4C settlement into the branch''s cash at hand or bank account.';

-- The destination account and the line must name the same ledger account, or
-- the register and the journal would disagree about where the money went.
-- A trigger rather than a CHECK, because PostgreSQL forbids a subquery in a
-- CHECK — and rightly: a constraint that reads another table is not a
-- constraint on this row, whatever it is spelled as.
create or replace function public.agency_commission_settlement_destination_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ledger uuid;
  v_line   record;
begin
  if new.float_account_id is null then
    return new;
  end if;

  select f.ledger_account_id, f.provider_id, f.branch_id into v_line
  from public.agency_provider_float_accounts f
  where f.id = new.float_account_id;

  if v_line.ledger_account_id is null then
    raise exception 'No such agent line.' using errcode = 'P0001';
  end if;

  if new.settlement_account_id is distinct from v_line.ledger_account_id then
    raise exception
      'A payout into an agent line must be settled against that line''s own float account.'
      using errcode = 'P0001';
  end if;

  -- And the line must belong to the provider and branch the settlement names,
  -- so a payout cannot be filed under one provider and posted to another's
  -- float.
  if v_line.provider_id is distinct from new.provider_id
     or v_line.branch_id is distinct from new.branch_id then
    raise exception
      'That agent line does not belong to the provider and branch of this settlement.'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

revoke all on function public.agency_commission_settlement_destination_guard()
  from public, anon, authenticated;

comment on function public.agency_commission_settlement_destination_guard() is
  'Phase 4E. Where a commission settlement names an agent line, its settlement account must be that line''s own float account, and the line must belong to the settlement''s provider and branch. A trigger, because a CHECK may not read another table.';

drop trigger if exists agency_commission_settlement_destination
  on public.agency_commission_settlements;
create trigger agency_commission_settlement_destination
  before insert or update on public.agency_commission_settlements
  for each row execute function public.agency_commission_settlement_destination_guard();


-- Per-line duplicate protection, beside Phase 4C's per-provider index. A
-- payout always carries a reference, so this index always bites.
create unique index if not exists agency_commission_payout_reference_unique
  on public.agency_commission_settlements (float_account_id, provider_statement_ref)
  where float_account_id is not null and provider_statement_ref is not null;


-- ---------------------------------------------------------------------------
-- 2. Outstanding commission, one agent line at a time
--
-- The same GL-derived query `agency_commission_outstanding()` uses, scoped to
-- the line: accruals through the transaction that caused them, clearances
-- through the settlement that caused them.
--
-- A `cash_payable` provider accrues to 1310 with no float account, so the sum
-- of this across a provider's lines equals that provider's branch total only
-- where the provider keeps float. That is a property of the chart, not a gap:
-- 1310 is one account shared by every provider.
-- ---------------------------------------------------------------------------

create or replace function public.agency_commission_outstanding_by_line(
  p_float_account_id uuid
)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(pg_catalog.sum(l.debit - l.credit), 0)::bigint
    from public.journal_lines l
    join public.journal_entries e on e.id = l.entry_id
    join public.ledger_accounts a on a.id = l.account_id
   where a.code = '1310'
     and (
       (e.source_type in ('agency_transaction', 'agency_transaction_reversal')
         and exists (select 1 from public.agency_transactions t
                      where t.id = e.source_id
                        and t.float_account_id = p_float_account_id))
       or (e.source_type in ('agency_commission_settlement',
                             'agency_commission_settlement_reversal',
                             'agency_commission_payout',
                             'agency_commission_payout_reversal')
         and exists (select 1 from public.agency_commission_settlements s
                      where s.id = e.source_id
                        and s.float_account_id = p_float_account_id))
     );
$$;

comment on function public.agency_commission_outstanding_by_line(uuid) is
  'Phase 4E. Commission earned by one agent line and not yet received, read from the GL lines on 1310 and attributed through each entry''s source, so the subsidiary figure cannot drift from the ledger. Accruals come through the transaction, clearances through the settlement or payout. Exact where every settlement for the provider names a line, which is the Mobile Money case; an upper bound where a Phase 4C settlement into cash or the bank cleared receivable it cannot attribute to one. Callers that must not overdraw the receivable take the lesser of this and agency_commission_outstanding().';

-- Deliberately revoked and not granted. The pre-4E figure was engine-only,
-- and widening a read helper to `authenticated` because a screen wants it is
-- how a capability check gets skipped: the screens read these figures through
-- views whose RLS requires agency:reports.
revoke all on function public.agency_commission_outstanding_by_line(uuid)
  from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 3. Two more journal source types
-- ---------------------------------------------------------------------------

alter table public.journal_entries
  drop constraint if exists journal_entries_source_valid;

alter table public.journal_entries
  add constraint journal_entries_source_valid
  check (source_type = any (array[
    'opening_balance',
    'loan_disbursement', 'loan_repayment', 'payment_reversal', 'penalty_charge',
    'transfer', 'transfer_reversal',
    'expense', 'expense_reversal',
    'other_income', 'other_income_reversal',
    'reconciliation_adjustment', 'adjustment',
    'membership_fee', 'membership_fee_reversal',
    'savings_deposit', 'savings_deposit_reversal',
    'savings_withdrawal', 'savings_withdrawal_reversal',
    'benefit_payment', 'benefit_payment_reversal',
    -- In the order they were added, which is how
    -- tests/db/ledger-balance-invariant.test.ts reads this list: a tidier
    -- grouping would lose the record of when each source appeared.
    'agency_transaction', 'agency_transaction_reversal',
    'agency_commission_settlement',
    'agency_payable_settlement', 'agency_payable_settlement_reversal',
    'agency_float_replenishment',
    'agency_commission_settlement_reversal',
    -- Phase 4E
    'agency_commission_payout', 'agency_commission_payout_reversal',
    'agency_commission_recovery',
    'agency_float_purchase', 'agency_float_purchase_reversal',
    'agency_float_sale', 'agency_float_sale_reversal',
    'agency_float_transfer', 'agency_float_transfer_reversal'
  ]));


-- ---------------------------------------------------------------------------
-- 4. Recording the payout
--
-- Lock order is the one the whole agency engine uses: the provider balance
-- first, then the ledger accounts sorted by id inside `lock_ledger_balances`.
-- The provider lock is what stops two payouts against two lines of the same
-- provider both reading the same outstanding figure.
-- ---------------------------------------------------------------------------

create or replace function public.record_agency_commission_payout(
  p_float_account_id   uuid,
  p_amount             bigint,
  p_provider_reference text,
  p_payout_date        date default null,
  p_notes              text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor       uuid;
  f             record;
  pr            public.agency_service_providers;
  v_receivable  uuid;
  v_outstanding bigint;
  v_ref         text;
  v_id          uuid;
  v_entry       uuid;
begin
  v_actor := public.agency_actor('agency:settlements');

  select a.id, a.provider_id, a.branch_id, a.ledger_account_id, a.status,
         a.till_name, a.label
    into f
  from public.agency_provider_float_accounts a
  where a.id = p_float_account_id;

  if f.id is null or not public.user_can_see_branch(f.branch_id) then
    raise exception 'No such agent line.' using errcode = 'P0001';
  end if;

  -- A closed line is finished. A suspended one may still receive what it
  -- earned: decision OD-4 keeps "authorized recovery operations" open, and
  -- commission the provider owes for business already done is exactly that.
  if f.status = 'closed' then
    raise exception
      'That agent line is closed, so nothing may be paid into it.'
      using errcode = 'P0001';
  end if;

  select * into pr from public.agency_service_providers where id = f.provider_id;

  if pr.commission_model <> 'deferred' then
    raise exception
      '% recognises commission at the point of sale, so there is no receivable to pay out.',
      pr.name
      using errcode = 'P0001';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'A commission payout must be a positive amount.'
      using errcode = 'P0001';
  end if;

  -- Decision OD-8. Required, not optional: without it the duplicate index
  -- below has nothing to bite on and the same payout could post twice.
  v_ref := nullif(pg_catalog.btrim(coalesce(p_provider_reference, '')), '');
  if v_ref is null then
    raise exception
      'A commission payout needs the provider''s transaction ID or statement reference, so the same payment cannot be recorded twice.'
      using errcode = 'P0001';
  end if;

  v_receivable := public.ledger_account_by_code('1310');

  perform public.lock_agency_provider_balance(f.provider_id, f.branch_id);
  perform public.lock_ledger_balances(array[f.ledger_account_id, v_receivable]);

  v_outstanding := public.agency_commission_outstanding_by_line(p_float_account_id);

  if p_amount > v_outstanding then
    raise exception
      '% shillings of commission are outstanding on %, which is less than the % being paid in.',
      v_outstanding, coalesce(nullif(f.label, ''), f.till_name), p_amount
      using errcode = 'P0001';
  end if;

  begin
    insert into public.agency_commission_settlements
      (provider_id, branch_id, float_account_id, settlement_date, settlement_amount,
       settlement_account_id, provider_statement_ref, notes, created_by)
    values
      (f.provider_id, f.branch_id, p_float_account_id,
       coalesce(p_payout_date, public.business_date()), p_amount,
       f.ledger_account_id, v_ref,
       nullif(pg_catalog.btrim(coalesce(p_notes, '')), ''), v_actor)
    returning id into v_id;
  exception when unique_violation then
    raise exception
      'That provider reference has already been recorded against this agent line.'
      using errcode = 'P0001';
  end;

  v_entry := public.post_journal(
    f.branch_id,
    coalesce(p_payout_date, public.business_date()),
    'Commission paid into ' || coalesce(nullif(f.label, ''), f.till_name)
      || ' by ' || pr.name || ' (' || v_ref || ')',
    'agency_commission_payout',
    v_id,
    null,
    null,
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'account_id', f.ledger_account_id,
        'debit', p_amount, 'credit', 0,
        'memo', 'Commission received into float'),
      pg_catalog.jsonb_build_object(
        'account_id', v_receivable,
        'debit', 0, 'credit', p_amount,
        'memo', 'Commission receivable cleared')),
    now(),
    v_actor,
    'Commission payout'
  );

  update public.agency_commission_settlements
     set journal_entry_id = v_entry, updated_at = now()
   where id = v_id;

  perform public.record_audit_event(
    'agency_commission_payout.recorded',
    'agency_commission_settlement',
    v_id::text,
    pg_catalog.jsonb_build_object('outstanding_before', v_outstanding),
    pg_catalog.jsonb_build_object(
      'float_account_id', p_float_account_id,
      'amount', p_amount,
      'provider_reference', v_ref,
      'outstanding_after', v_outstanding - p_amount),
    pg_catalog.jsonb_build_object('provider_code', pr.code),
    null);

  return v_id;
end;
$$;

comment on function public.record_agency_commission_payout(uuid, bigint, text, date, text) is
  'Phase 4E. Records commission the provider paid into one agent line''s float: Dr the line''s 1320 account, Cr 1310. Touches no income account, because the income was recognised when each transaction posted. Refuses more than that line owes, a missing or repeated provider reference, a closed line, and a provider on the immediate model. Needs agency:settlements.';

revoke all on function public.record_agency_commission_payout(uuid, bigint, text, date, text)
  from public, anon, authenticated;
grant execute on function public.record_agency_commission_payout(uuid, bigint, text, date, text)
  to authenticated;


-- ---------------------------------------------------------------------------
-- 5. And the provider-wide figure must see a payout
--
-- `agency_commission_outstanding(provider, branch)` attributes 1310's lines
-- through each entry's source, and it listed four source types. A payout is a
-- fifth, so without this the provider-wide figure would not fall when the
-- provider paid — and `record_commission_settlement()`, which refuses more
-- than that figure, would have let the same commission be settled twice.
--
-- The payout rows live in `agency_commission_settlements`, so the attribution
-- clause already finds them; only the source-type list had to grow.
-- ---------------------------------------------------------------------------

create or replace function public.agency_commission_outstanding(
  p_provider_id uuid,
  p_branch_id   uuid
)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(pg_catalog.sum(l.debit - l.credit), 0)::bigint
    from public.journal_lines l
    join public.journal_entries e on e.id = l.entry_id
    join public.ledger_accounts a on a.id = l.account_id
   where a.code = '1310'
     and e.branch_id = p_branch_id
     and (
       (e.source_type in ('agency_transaction', 'agency_transaction_reversal')
         and exists (select 1 from public.agency_transactions t
                      where t.id = e.source_id and t.provider_id = p_provider_id))
       or (e.source_type in ('agency_commission_settlement',
                             'agency_commission_settlement_reversal',
                             'agency_commission_payout',
                             'agency_commission_payout_reversal')
         and exists (select 1 from public.agency_commission_settlements s
                      where s.id = e.source_id and s.provider_id = p_provider_id))
     );
$$;

comment on function public.agency_commission_outstanding(uuid, uuid) is
  'Phase 4B, extended in Phase 4E. Commission a provider has earned at one branch and not yet paid, read from the GL lines on 1310 and attributed through each entry''s source: the accruals through the transaction, and the settlements, their reversals and the payouts into float through the settlement register.';

-- Deliberately revoked and not granted. The pre-4E figure was engine-only,
-- and widening a read helper to `authenticated` because a screen wants it is
-- how a capability check gets skipped: the screens read these figures through
-- views whose RLS requires agency:reports.
revoke all on function public.agency_commission_outstanding(uuid, uuid)
  from public, anon, authenticated;
