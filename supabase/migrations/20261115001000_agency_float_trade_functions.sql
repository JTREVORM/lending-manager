-- ===========================================================================
-- Phase 4E — recording, verifying, rejecting and reversing a float trade
--
-- Four functions for one register, split the way decision OD-7 splits the
-- authority: `agency:float_trade` records and moves nothing,
-- `agency:settlements` verifies and that is what posts. The data layer
-- enforces the separation — `agency_float_trade_checker_is_not_maker` — so it
-- holds whatever a screen offers.
--
-- ## The three journals
--
-- **Purchase** (OD-1). Float in, cash or bank out, and the difference
-- recognised rather than hidden in the float:
--
--     face value   Dr 1320.line 500,000            Cr cash 500,000
--     premium      Dr 1320.line 500,000  Dr 5970 500   Cr cash 500,500
--     discount     Dr 1320.line 500,000            Cr cash 499,500  Cr 4580 500
--
-- Posting a premium into 1320 would overstate the float by money the provider
-- will never confirm, and the next reconciliation would report a variance that
-- is not a variance.
--
-- **Sale** (OD-6). Float out, cash or bank in, and the fee recognised
-- separately. The fee is a figure a cashier types; no rate is applied
-- anywhere, and zero is "sell without fee", stated:
--
--     Dr cash 202,000   Cr 1320.line 200,000   Cr 4570 2,000
--
-- **Transfer** (OD-3). Between two lines of one provider, within a branch or
-- across two. No cash, no income:
--
--     Dr 1320.line(to) 300,000   Cr 1320.line(from) 300,000
--
-- ## Lock order, and the deadlock a cross-branch transfer invites
--
-- The engine's order is the provider balance first, then the ledger accounts
-- sorted by id. A cross-branch transfer needs **two** provider-balance locks,
-- one per branch, and two opposing transfers taking them in the order their
-- own arguments arrive would deadlock. They are taken in branch-id order
-- instead, so the order is a property of the code and not of who called it.
--
-- ## Suspension, and why a sale and a transfer may leave one
--
-- Decision OD-4 keeps "authorized recovery operations" open on a suspended
-- line, and moving float off a compromised line is the recovery. So a
-- transfer or a sale **from** a suspended line is allowed; a purchase or a
-- transfer **into** one is not, because that is new business. A closed line
-- takes part in nothing.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. Recording — writes a row, posts nothing
-- ---------------------------------------------------------------------------

create or replace function public.record_agency_float_trade(
  p_kind                     text,
  p_float_account_id         uuid,
  p_float_amount             bigint,
  p_reference                text,
  p_counter_float_account_id uuid    default null,
  p_settlement_account_id    uuid    default null,
  p_cash_amount              bigint  default null,
  p_fee_amount               bigint  default null,
  p_source_kind              text    default null,
  p_counterparty_name        text    default null,
  p_trade_date               date    default null,
  p_notes                    text    default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor   uuid;
  f         record;
  c         record;
  pr        public.agency_service_providers;
  v_ref     text;
  v_party   text;
  -- Its own variable, not `c.branch_id`: PL/pgSQL evaluates every parameter of
  -- the INSERT below before the statement runs, so a field of an unassigned
  -- record raises even inside a CASE that would never have chosen it.
  v_counter_branch uuid;
  v_id      uuid;
begin
  v_actor := public.agency_actor('agency:float_trade');

  if p_kind is null or p_kind not in ('purchase', 'sale', 'transfer') then
    raise exception
      'A float trade is a purchase, a sale or a transfer between lines.'
      using errcode = 'P0001';
  end if;

  select a.id, a.provider_id, a.branch_id, a.ledger_account_id, a.status,
         a.till_name, a.label
    into f
  from public.agency_provider_float_accounts a
  where a.id = p_float_account_id;

  if f.id is null or not public.user_can_see_branch(f.branch_id) then
    raise exception 'No such agent line.' using errcode = 'P0001';
  end if;

  if f.status = 'closed' then
    raise exception
      'That agent line is closed, so it can take no part in a float trade.'
      using errcode = 'P0001';
  end if;

  -- A purchase is new business: the line must be open for it. A sale or a
  -- transfer takes float *off* the line, which decision OD-4 keeps available
  -- while a line is suspended.
  if p_kind = 'purchase' and f.status <> 'active' then
    raise exception
      'That agent line is %, so float may not be bought into it. Move what it holds out instead.',
      f.status
      using errcode = 'P0001';
  end if;

  select * into pr from public.agency_service_providers where id = f.provider_id;

  if pr.float_model <> 'provider_float' then
    raise exception
      '% is settled through a payable account, so it holds no float to trade.',
      pr.name
      using errcode = 'P0001';
  end if;

  if p_float_amount is null or p_float_amount <= 0 then
    raise exception 'A float trade must name a positive amount of float.'
      using errcode = 'P0001';
  end if;

  v_ref := nullif(pg_catalog.btrim(coalesce(p_reference, '')), '');
  if v_ref is null then
    raise exception
      'A float trade needs a reference, so the same movement cannot be recorded twice.'
      using errcode = 'P0001';
  end if;

  v_party := nullif(pg_catalog.btrim(coalesce(p_counterparty_name, '')), '');

  if p_kind = 'transfer' then
    select a.id, a.provider_id, a.branch_id, a.ledger_account_id, a.status
      into c
    from public.agency_provider_float_accounts a
    where a.id = p_counter_float_account_id;

    if c.id is null then
      raise exception 'No such receiving agent line.' using errcode = 'P0001';
    end if;

    -- Decision OD-3 allows a transfer across branches, and requires authority
    -- at both ends: the officer must be able to see the branch the float
    -- leaves and the branch it arrives at.
    if not public.user_can_see_branch(c.branch_id) then
      raise exception
        'You may not transfer float into a branch you do not administer.'
        using errcode = '42501';
    end if;

    if c.provider_id <> f.provider_id then
      raise exception
        'Float cannot be transferred between providers: % float is not % float.',
        pr.name, (select p2.name from public.agency_service_providers p2 where p2.id = c.provider_id)
        using errcode = 'P0001';
    end if;

    if c.id = f.id then
      raise exception 'A transfer needs two different lines.' using errcode = 'P0001';
    end if;

    if c.status <> 'active' then
      raise exception
        'The receiving agent line is %, so float may not be moved into it.', c.status
        using errcode = 'P0001';
    end if;

    v_counter_branch := c.branch_id;
  else
    if p_settlement_account_id is null then
      raise exception
        'A float % needs the cash or bank account the money %.',
        p_kind, case when p_kind = 'purchase' then 'came from' else 'went into' end
        using errcode = 'P0001';
    end if;

    perform public.assert_agency_settlement_account(
      p_settlement_account_id, f.branch_id,
      case when p_kind = 'purchase' then 'funding account' else 'receiving account' end);

    if p_kind = 'purchase' then
      if p_cash_amount is null or p_cash_amount <= 0 then
        raise exception
          'A float purchase must record what was actually paid for the float.'
          using errcode = 'P0001';
      end if;
      if p_source_kind is null then
        raise exception
          'A float purchase must say where the float came from: a service centre, another agent, the bank or cash.'
          using errcode = 'P0001';
      end if;
    else
      if p_fee_amount is null or p_fee_amount < 0 then
        raise exception
          'A float sale must state its fee. Enter 0 to sell without one.'
          using errcode = 'P0001';
      end if;
    end if;
  end if;

  begin
    insert into public.agency_float_trades
      (kind, provider_id, branch_id, float_account_id,
       counter_float_account_id, counter_branch_id, settlement_account_id,
       trade_date, float_amount, cash_amount, fee_amount,
       source_kind, counterparty_name, reference, notes, created_by)
    values
      (p_kind, f.provider_id, f.branch_id, p_float_account_id,
       case when p_kind = 'transfer' then p_counter_float_account_id end,
       v_counter_branch,
       case when p_kind <> 'transfer' then p_settlement_account_id end,
       coalesce(p_trade_date, public.business_date()),
       p_float_amount,
       case when p_kind = 'purchase' then p_cash_amount end,
       case when p_kind = 'sale' then p_fee_amount end,
       case when p_kind = 'purchase' then p_source_kind end,
       v_party, v_ref,
       nullif(pg_catalog.btrim(coalesce(p_notes, '')), ''), v_actor)
    returning id into v_id;
  exception when unique_violation then
    raise exception
      'That reference has already been recorded against this agent line.'
      using errcode = 'P0001';
  end;

  perform public.record_audit_event(
    'agency_float_trade.recorded', 'agency_float_trade', v_id::text,
    null,
    pg_catalog.jsonb_build_object(
      'kind', p_kind, 'float_amount', p_float_amount,
      'cash_amount', p_cash_amount, 'fee_amount', p_fee_amount,
      'reference', v_ref, 'status', 'pending'),
    pg_catalog.jsonb_build_object('provider_code', pr.code),
    null);

  return v_id;
end;
$$;

comment on function public.record_agency_float_trade(
  text, uuid, bigint, text, uuid, uuid, bigint, bigint, text, text, date, text) is
  'Phase 4E, decision OD-7. Records a float purchase, sale or line-to-line transfer as pending. Posts no journal, so it moves no balance. Needs agency:float_trade, which a cashier holds; posting needs a different holder of agency:settlements.';

revoke all on function public.record_agency_float_trade(
  text, uuid, bigint, text, uuid, uuid, bigint, bigint, text, text, date, text)
  from public, anon, authenticated;
grant execute on function public.record_agency_float_trade(
  text, uuid, bigint, text, uuid, uuid, bigint, bigint, text, text, date, text)
  to authenticated;


-- ---------------------------------------------------------------------------
-- 2. Verifying — the call that posts
-- ---------------------------------------------------------------------------

create or replace function public.verify_agency_float_trade(
  p_trade_id          uuid,
  p_expected_revision integer default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor    uuid;
  t          public.agency_float_trades;
  f          record;
  c          record;
  pr         public.agency_service_providers;
  v_diff     bigint;
  v_lines    jsonb := '[]'::jsonb;
  v_entry    uuid;
  v_first    uuid;
  v_second   uuid;
begin
  v_actor := public.agency_actor('agency:settlements');

  select * into t from public.agency_float_trades
   where id = p_trade_id for update;

  if t.id is null then
    raise exception 'No such float trade.' using errcode = 'P0001';
  end if;

  if not public.user_can_see_branch(t.branch_id) then
    raise exception 'That float trade belongs to another branch.'
      using errcode = '42501';
  end if;

  -- Idempotent: a verifier who presses twice gets the entry, not an error.
  if t.status = 'posted' then
    return t.journal_entry_id;
  end if;

  if t.status <> 'pending' then
    raise exception 'Only a pending float trade can be posted; this one is %.', t.status
      using errcode = 'P0001';
  end if;

  if t.created_by = v_actor then
    raise exception
      'A float trade cannot be posted by the person who recorded it.'
      using errcode = 'P0001';
  end if;

  if p_expected_revision is not null and p_expected_revision <> t.revision then
    raise exception
      'This float trade has changed since you read it (revision % now, you saw %). Reload it and check the figures again.',
      t.revision, p_expected_revision
      using errcode = 'P0001';
  end if;

  select a.provider_id, a.branch_id, a.ledger_account_id, a.status,
         a.till_name, a.label
    into f
  from public.agency_provider_float_accounts a where a.id = t.float_account_id;

  select * into pr from public.agency_service_providers where id = t.provider_id;

  -- The provider balance lock, before any account lock. For a cross-branch
  -- transfer, both branches, in branch-id order so two opposing transfers
  -- cannot deadlock.
  if t.kind = 'transfer' and t.counter_branch_id is distinct from t.branch_id then
    v_first  := least(t.branch_id, t.counter_branch_id);
    v_second := greatest(t.branch_id, t.counter_branch_id);
    perform public.lock_agency_provider_balance(t.provider_id, v_first);
    perform public.lock_agency_provider_balance(t.provider_id, v_second);
  else
    perform public.lock_agency_provider_balance(t.provider_id, t.branch_id);
  end if;

  if t.kind = 'transfer' then
    select a.ledger_account_id, a.status into c
    from public.agency_provider_float_accounts a where a.id = t.counter_float_account_id;

    perform public.lock_ledger_balances(array[f.ledger_account_id, c.ledger_account_id]);
    perform public.assert_agency_float_available(f.ledger_account_id, t.float_amount);

    v_lines := pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'account_id', c.ledger_account_id,
        'debit', t.float_amount, 'credit', 0,
        'memo', 'Float received from another line'),
      pg_catalog.jsonb_build_object(
        'account_id', f.ledger_account_id,
        'debit', 0, 'credit', t.float_amount,
        'memo', 'Float moved to another line'));

  elsif t.kind = 'purchase' then
    perform public.lock_ledger_balances(
      array[f.ledger_account_id, t.settlement_account_id]);
    perform public.assert_cash_available(t.settlement_account_id, t.cash_amount);

    v_lines := pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'account_id', f.ledger_account_id,
        'debit', t.float_amount, 'credit', 0,
        'memo', 'Float purchased'),
      pg_catalog.jsonb_build_object(
        'account_id', t.settlement_account_id,
        'debit', 0, 'credit', t.cash_amount,
        'memo', 'Paid for float'));

    -- Decision OD-1. The difference is recognised, not absorbed into 1320.
    v_diff := t.cash_amount - t.float_amount;
    if v_diff > 0 then
      v_lines := v_lines || pg_catalog.jsonb_build_object(
        'account_id', public.ledger_account_by_code('5970'),
        'debit', v_diff, 'credit', 0,
        'memo', 'Premium paid above face value');
    elsif v_diff < 0 then
      v_lines := v_lines || pg_catalog.jsonb_build_object(
        'account_id', public.ledger_account_by_code('4580'),
        'debit', 0, 'credit', -v_diff,
        'memo', 'Discount received below face value');
    end if;

  else
    perform public.lock_ledger_balances(
      array[f.ledger_account_id, t.settlement_account_id]);
    perform public.assert_agency_float_available(f.ledger_account_id, t.float_amount);

    v_lines := pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'account_id', t.settlement_account_id,
        'debit', t.float_amount + t.fee_amount, 'credit', 0,
        'memo', 'Proceeds of float sold'),
      pg_catalog.jsonb_build_object(
        'account_id', f.ledger_account_id,
        'debit', 0, 'credit', t.float_amount,
        'memo', 'Float sold'));

    if t.fee_amount > 0 then
      v_lines := v_lines || pg_catalog.jsonb_build_object(
        'account_id', public.ledger_account_by_code('4570'),
        'debit', 0, 'credit', t.fee_amount,
        'memo', 'Service fee on a float sale');
    end if;
  end if;

  v_entry := public.post_journal(
    t.branch_id,
    t.trade_date,
    case t.kind
      when 'purchase' then 'Float purchased for '
      when 'sale'     then 'Float sold from '
      else 'Float transferred from '
    end || coalesce(nullif(f.label, ''), f.till_name)
      || ' (' || t.reference || ')',
    'agency_float_' || t.kind,
    t.id,
    null,
    null,
    v_lines,
    now(),
    v_actor,
    'Float trade'
  );

  update public.agency_float_trades
     set status           = 'posted',
         verified_by      = v_actor,
         verified_at      = now(),
         journal_entry_id = v_entry,
         updated_at       = now()
   where id = p_trade_id;

  perform public.record_audit_event(
    'agency_float_trade.posted', 'agency_float_trade', p_trade_id::text,
    pg_catalog.jsonb_build_object('status', 'pending', 'revision', t.revision),
    pg_catalog.jsonb_build_object(
      'status', 'posted', 'journal_entry_id', v_entry,
      'kind', t.kind, 'float_amount', t.float_amount,
      'cash_amount', t.cash_amount, 'fee_amount', t.fee_amount),
    pg_catalog.jsonb_build_object('provider_code', pr.code),
    null);

  return v_entry;
end;
$$;

comment on function public.verify_agency_float_trade(uuid, integer) is
  'Phase 4E, decision OD-7. Posts a pending float trade: the three journals for a purchase at face value, a premium or a discount; a sale with its fee recognised separately; and a line-to-line transfer. Refuses the person who recorded it, a stale revision, and insufficient cash or float. Takes both provider-balance locks in branch-id order on a cross-branch transfer. Needs agency:settlements.';

revoke all on function public.verify_agency_float_trade(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.verify_agency_float_trade(uuid, integer)
  to authenticated;


-- ---------------------------------------------------------------------------
-- 3. Rejecting — the other half of a maker-checker control
--
-- A control that can only say yes is not a control. A rejected trade is kept,
-- with its reason, because "who recorded what and why it was refused" is the
-- part a reviewer reads.
-- ---------------------------------------------------------------------------

create or replace function public.reject_agency_float_trade(
  p_trade_id uuid,
  p_reason   text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid;
  t        public.agency_float_trades;
  v_reason text;
begin
  v_actor := public.agency_actor('agency:settlements');

  select * into t from public.agency_float_trades where id = p_trade_id for update;

  if t.id is null or not public.user_can_see_branch(t.branch_id) then
    raise exception 'No such float trade.' using errcode = 'P0001';
  end if;

  if t.status <> 'pending' then
    raise exception 'Only a pending float trade can be rejected; this one is %.', t.status
      using errcode = 'P0001';
  end if;

  v_reason := nullif(pg_catalog.btrim(coalesce(p_reason, '')), '');
  if v_reason is null then
    raise exception 'A rejection needs a reason.' using errcode = 'P0001';
  end if;

  update public.agency_float_trades
     set status          = 'rejected',
         rejected_reason = v_reason,
         verified_by     = v_actor,
         verified_at     = now(),
         updated_at      = now()
   where id = p_trade_id;

  perform public.record_audit_event(
    'agency_float_trade.rejected', 'agency_float_trade', p_trade_id::text,
    pg_catalog.jsonb_build_object('status', 'pending'),
    pg_catalog.jsonb_build_object('status', 'rejected', 'reason', v_reason),
    null, null);
end;
$$;

comment on function public.reject_agency_float_trade(uuid, text) is
  'Phase 4E. Refuses a pending float trade with a stated reason, keeping the row. Posts nothing. Needs agency:settlements, and like verification it may not be the person who recorded it.';

revoke all on function public.reject_agency_float_trade(uuid, text)
  from public, anon, authenticated;
grant execute on function public.reject_agency_float_trade(uuid, text)
  to authenticated;


-- ---------------------------------------------------------------------------
-- 4. Reversing a posted trade
--
-- A mirror of the entry, leg for leg, with sufficiency asserted on everything
-- the contra draws down — the same treatment every other agency reversal
-- gets. The original entry stays.
-- ---------------------------------------------------------------------------

create or replace function public.reverse_agency_float_trade(
  p_trade_id uuid,
  p_reason   text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid;
  t        public.agency_float_trades;
  r        record;
  v_lines  jsonb := '[]'::jsonb;
  v_entry  uuid;
  v_reason text;
  v_first  uuid;
  v_second uuid;
begin
  v_actor := public.agency_actor('agency:reverse');

  select * into t from public.agency_float_trades where id = p_trade_id for update;

  if t.id is null or not public.user_can_see_branch(t.branch_id) then
    raise exception 'No such float trade.' using errcode = 'P0001';
  end if;

  if t.status <> 'posted' then
    raise exception 'Only a posted float trade can be reversed; this one is %.', t.status
      using errcode = 'P0001';
  end if;

  v_reason := nullif(pg_catalog.btrim(coalesce(p_reason, '')), '');
  if v_reason is null then
    raise exception 'A reversal needs a reason.' using errcode = 'P0001';
  end if;

  if t.kind = 'transfer' and t.counter_branch_id is distinct from t.branch_id then
    v_first  := least(t.branch_id, t.counter_branch_id);
    v_second := greatest(t.branch_id, t.counter_branch_id);
    perform public.lock_agency_provider_balance(t.provider_id, v_first);
    perform public.lock_agency_provider_balance(t.provider_id, v_second);
  else
    perform public.lock_agency_provider_balance(t.provider_id, t.branch_id);
  end if;

  perform public.lock_ledger_balances(array(
    select l.account_id
      from public.journal_lines l
      join public.ledger_accounts a on a.id = l.account_id
     where l.entry_id = t.journal_entry_id
       and a.cash_kind is not null
  ));

  for r in
    select l.account_id, l.debit, l.credit, l.memo, a.cash_kind
      from public.journal_lines l
      join public.ledger_accounts a on a.id = l.account_id
     where l.entry_id = t.journal_entry_id
     order by l.line_number
  loop
    if r.credit > 0 then
      if r.cash_kind = 'cash_at_hand' then
        perform public.assert_cash_available(r.account_id, r.credit);
      elsif r.cash_kind = 'agency_float' then
        perform public.assert_agency_float_available(r.account_id, r.credit);
      end if;
    end if;

    v_lines := v_lines || public.agency_line(
      r.account_id, r.credit, r.debit,
      'Reversal: ' || coalesce(r.memo, 'original line'));
  end loop;

  v_entry := public.post_journal(
    t.branch_id,
    public.business_date(),
    'Reversal of float ' || t.kind || ' (' || t.reference || '): ' || v_reason,
    'agency_float_' || t.kind || '_reversal',
    t.id,
    null,
    null,
    v_lines,
    now(),
    v_actor,
    'Float trade reversal'
  );

  update public.agency_float_trades
     set status            = 'reversed',
         reversal_entry_id = v_entry,
         reversed_by       = v_actor,
         reversed_at       = now(),
         reversal_reason   = v_reason,
         updated_at        = now()
   where id = p_trade_id;

  perform public.record_audit_event(
    'agency_float_trade.reversed', 'agency_float_trade', p_trade_id::text,
    pg_catalog.jsonb_build_object('status', 'posted',
                                  'journal_entry_id', t.journal_entry_id),
    pg_catalog.jsonb_build_object('status', 'reversed',
                                  'reversal_entry_id', v_entry,
                                  'reason', v_reason),
    null, null);

  return v_entry;
end;
$$;

comment on function public.reverse_agency_float_trade(uuid, text) is
  'Phase 4E. Mirrors a posted float trade''s journal leg for leg, asserting sufficiency on every asset the contra draws down, and keeps the original. Needs agency:reverse and a reason.';

revoke all on function public.reverse_agency_float_trade(uuid, text)
  from public, anon, authenticated;
grant execute on function public.reverse_agency_float_trade(uuid, text)
  to authenticated;
