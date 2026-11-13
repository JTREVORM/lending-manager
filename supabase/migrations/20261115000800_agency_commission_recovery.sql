-- ===========================================================================
-- Phase 4E — commission already received, on a transaction being reversed
--
-- Decision OD-10: "Permit authorized reversals. Reclassify commission already
-- received as a provider recovery payable, not a negative receivable. Record
-- subsequent recovery or offsets separately with a balanced ledger and
-- complete audit history."
--
-- ## What this replaces
--
-- `reverse_agency_transaction()` refused outright when the commission on the
-- transaction had already been settled: *"Commission of X on this transaction
-- has already been settled … Reverse the commission settlement first."* That
-- rule kept 1310 from going negative, which was the right instinct, by
-- forbidding a correction that has nothing to do with the settlement. A
-- customer's transaction and the provider's monthly payment are different
-- events; a wrong amount keyed at the counter should not require a month's
-- commission payment to be unwound before it can be fixed.
--
-- ## Why not simply allow 1310 to go negative
--
-- Because it would not mean anything. 1310 is "commission the provider owes
-- us"; a negative balance there asserts the provider owes us less than
-- nothing. What is actually true after a reversal of a paid-out transaction is
-- that we are holding money that is no longer ours, which is a liability. It
-- has its own account, 2230, and its own name on the trial balance, where a
-- reader can see it and ask about it. A contra-asset hidden inside 1310 is a
-- figure nobody looks at.
--
-- ## The split
--
-- The mirror credits the receivable as far as the receivable goes, and credits
-- the remainder to 2230:
--
--     Dr 4510 income            c
--     Cr 1310 receivable        min(c, outstanding)
--     Cr 2230 recovery payable  c - min(c, outstanding)
--
-- Both are credits, the debit side is untouched, and the entry balances. When
-- nothing has been paid out — the ordinary case, and every case the existing
-- suites cover — `outstanding >= c`, the 2230 leg is zero and the entry is
-- character-for-character what Phase 4C posted.
--
-- The outstanding figure is read **per agent line** where the provider keeps
-- float, because a branch may run several lines and the one that binds is the
-- line that earned it.
--
-- ## And then it is recovered
--
-- 2230 is cleared one of two ways, both of which the provider actually does:
-- it deducts the amount from the line's float, or it pays less commission next
-- time. `record_agency_commission_recovery()` posts either, against its own
-- register, with a mandatory reference and per-line duplicate protection.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. The recovery register
-- ---------------------------------------------------------------------------

create table if not exists public.agency_commission_recoveries (
  id                 uuid primary key default gen_random_uuid(),
  provider_id        uuid not null references public.agency_service_providers(id) on delete restrict,
  branch_id          uuid not null references public.branches(id) on delete restrict,
  float_account_id   uuid not null references public.agency_provider_float_accounts(id) on delete restrict,
  recovery_date      date not null,
  amount             bigint not null,
  method             text not null,
  provider_reference text not null,
  notes              text,
  journal_entry_id   uuid references public.journal_entries(id) on delete restrict,
  created_by         uuid not null references public.profiles(id) on delete restrict,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint agency_commission_recovery_amount_positive
    check (amount > 0),

  constraint agency_commission_recovery_method_valid
    check (method = any (array['float_deduction', 'commission_offset'])),

  constraint agency_commission_recovery_reference_stated
    check (pg_catalog.btrim(provider_reference) = provider_reference
           and pg_catalog.length(provider_reference) between 3 and 80)
);

comment on table public.agency_commission_recoveries is
  'Phase 4E, decision OD-10. How a commission recovery payable in 2230 was cleared: the provider deducted it from the line''s float, or set it against commission it would otherwise have paid. One row per recovery, append-only in effect because nothing updates it after its journal is attached.';
comment on column public.agency_commission_recoveries.method is
  'float_deduction: the provider took the money out of the line''s electronic float (Dr 2230, Cr 1320.line). commission_offset: the provider withheld it from commission it owed us (Dr 2230, Cr 1310), which lowers both what we owe and what we are owed.';

create unique index if not exists agency_commission_recovery_reference_unique
  on public.agency_commission_recoveries (float_account_id, provider_reference);

create index if not exists agency_commission_recovery_line_idx
  on public.agency_commission_recoveries (float_account_id, recovery_date);

alter table public.agency_commission_recoveries enable row level security;
revoke all on table public.agency_commission_recoveries from anon, authenticated;
grant select on table public.agency_commission_recoveries to authenticated;

drop policy if exists agency_commission_recoveries_read on public.agency_commission_recoveries;
-- The branch rule is restated inline rather than delegated to
-- `user_can_see_branch(branch_id)`. That helper is correlated *and* SECURITY
-- DEFINER, so PostgreSQL neither hoists nor inlines it: it stays a real
-- function call per row, each one running two queries against `profiles`.
-- 20261018000100 rewrote eighty-one policies for exactly this reason, and
-- `tests/db/rls-hoisting.test.ts` fails any policy that reintroduces it —
-- which is how this one was caught.
create policy agency_commission_recoveries_read
  on public.agency_commission_recoveries for select
  to authenticated
  using ((select public.user_has_permission('agency:reports'))
         and (branch_id is null
              or (select public.current_user_branch_id()) is null
              or branch_id = (select public.current_user_branch_id())));

-- Append-only, like every other agency register: a recovery is corrected by
-- recording another one, never by editing what was recorded.
drop trigger if exists agency_commission_recoveries_no_delete on public.agency_commission_recoveries;
create trigger agency_commission_recoveries_no_delete
  before delete on public.agency_commission_recoveries
  for each row execute function public.reject_mutation();

drop trigger if exists agency_commission_recoveries_set_updated_at on public.agency_commission_recoveries;
create trigger agency_commission_recoveries_set_updated_at
  before update on public.agency_commission_recoveries
  for each row execute function public.set_updated_at();


-- ---------------------------------------------------------------------------
-- 2. What a line owes back, read from the ledger
--
-- The same GL-derived shape as `agency_commission_outstanding_by_line()`: a
-- subsidiary figure derived from 2230's own lines rather than kept beside
-- them, so the two cannot drift. 2230 is a credit-side account, so the sign is
-- credits less debits.
-- ---------------------------------------------------------------------------

create or replace function public.agency_commission_recovery_outstanding_by_line(
  p_float_account_id uuid
)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(pg_catalog.sum(l.credit - l.debit), 0)::bigint
    from public.journal_lines l
    join public.journal_entries e on e.id = l.entry_id
    join public.ledger_accounts a on a.id = l.account_id
   where a.code = '2230'
     and (
       (e.source_type = 'agency_transaction_reversal'
         and exists (select 1 from public.agency_transactions t
                      where t.id = e.source_id
                        and t.float_account_id = p_float_account_id))
       or (e.source_type = 'agency_commission_recovery'
         and exists (select 1 from public.agency_commission_recoveries rc
                      where rc.id = e.source_id
                        and rc.float_account_id = p_float_account_id))
     );
$$;

comment on function public.agency_commission_recovery_outstanding_by_line(uuid) is
  'Phase 4E, decision OD-10. Commission one agent line has received and must give back, read from the GL lines on 2230 and attributed through each entry''s source. Raised by a reversal of a paid-out transaction, cleared by a recovery.';

-- Engine-only, like the receivable readers beside it. Without this revoke the
-- function inherits the default ACL and `anon` can read it, which the
-- database security check caught.
revoke all on function public.agency_commission_recovery_outstanding_by_line(uuid)
  from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 3. Recording a recovery
-- ---------------------------------------------------------------------------

create or replace function public.record_agency_commission_recovery(
  p_float_account_id   uuid,
  p_amount             bigint,
  p_method             text,
  p_provider_reference text,
  p_recovery_date      date default null,
  p_notes              text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor    uuid;
  f          record;
  pr         public.agency_service_providers;
  v_recovery uuid;
  v_credit   uuid;
  v_owed     bigint;
  v_ref      text;
  v_id       uuid;
  v_entry    uuid;
  v_memo     text;
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

  select * into pr from public.agency_service_providers where id = f.provider_id;

  if p_method is null or p_method not in ('float_deduction', 'commission_offset') then
    raise exception
      'A recovery is either a float deduction or an offset against commission owed.'
      using errcode = 'P0001';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'A recovery must be a positive amount.' using errcode = 'P0001';
  end if;

  v_ref := nullif(pg_catalog.btrim(coalesce(p_provider_reference, '')), '');
  if v_ref is null then
    raise exception
      'A recovery needs the provider''s reference, so the same deduction cannot be recorded twice.'
      using errcode = 'P0001';
  end if;

  v_recovery := public.ledger_account_by_code('2230');
  v_credit := case p_method
                when 'float_deduction' then f.ledger_account_id
                else public.ledger_account_by_code('1310')
              end;

  perform public.lock_agency_provider_balance(f.provider_id, f.branch_id);
  perform public.lock_ledger_balances(array[v_recovery, v_credit]);

  v_owed := public.agency_commission_recovery_outstanding_by_line(p_float_account_id);

  if p_amount > v_owed then
    raise exception
      '% shillings of commission are owed back on %, which is less than the % being recovered.',
      v_owed, coalesce(nullif(f.label, ''), f.till_name), p_amount
      using errcode = 'P0001';
  end if;

  -- A float deduction takes value out of the line, so the line must hold it.
  -- An offset moves nothing: it lowers two balances that are already there.
  if p_method = 'float_deduction' then
    perform public.assert_agency_float_available(f.ledger_account_id, p_amount);
  end if;

  begin
    insert into public.agency_commission_recoveries
      (provider_id, branch_id, float_account_id, recovery_date, amount, method,
       provider_reference, notes, created_by)
    values
      (f.provider_id, f.branch_id, p_float_account_id,
       coalesce(p_recovery_date, public.business_date()), p_amount, p_method,
       v_ref, nullif(pg_catalog.btrim(coalesce(p_notes, '')), ''), v_actor)
    returning id into v_id;
  exception when unique_violation then
    raise exception
      'That provider reference has already been recorded as a recovery against this agent line.'
      using errcode = 'P0001';
  end;

  v_memo := case p_method
              when 'float_deduction' then 'Recovered by deduction from float'
              else 'Offset against commission owed to us'
            end;

  v_entry := public.post_journal(
    f.branch_id,
    coalesce(p_recovery_date, public.business_date()),
    'Commission recovery by ' || pr.name || ' on '
      || coalesce(nullif(f.label, ''), f.till_name) || ' (' || v_ref || ')',
    'agency_commission_recovery',
    v_id,
    null,
    null,
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'account_id', v_recovery,
        'debit', p_amount, 'credit', 0,
        'memo', 'Commission recovery payable cleared'),
      pg_catalog.jsonb_build_object(
        'account_id', v_credit,
        'debit', 0, 'credit', p_amount,
        'memo', v_memo)),
    now(),
    v_actor,
    'Commission recovery'
  );

  update public.agency_commission_recoveries
     set journal_entry_id = v_entry, updated_at = now()
   where id = v_id;

  perform public.record_audit_event(
    'agency_commission_recovery.recorded',
    'agency_commission_recovery',
    v_id::text,
    pg_catalog.jsonb_build_object('owed_before', v_owed),
    pg_catalog.jsonb_build_object(
      'float_account_id', p_float_account_id,
      'amount', p_amount,
      'method', p_method,
      'provider_reference', v_ref,
      'owed_after', v_owed - p_amount),
    pg_catalog.jsonb_build_object('provider_code', pr.code),
    null);

  return v_id;
end;
$$;

comment on function public.record_agency_commission_recovery(uuid, bigint, text, text, date, text) is
  'Phase 4E, decision OD-10. Clears a commission recovery payable: Dr 2230, Cr the line''s float (the provider took it back) or Cr 1310 (the provider withheld it from commission it owed). Refuses more than the line owes, a missing or repeated reference, and a float deduction the line cannot cover. Needs agency:settlements.';

revoke all on function public.record_agency_commission_recovery(uuid, bigint, text, text, date, text)
  from public, anon, authenticated;
grant execute on function public.record_agency_commission_recovery(uuid, bigint, text, text, date, text)
  to authenticated;


-- ---------------------------------------------------------------------------
-- 4. The reversal, with the split
--
-- Replaced in full. Every other part — the cross-day authority check, the
-- provider lock before the receivable is read, the sorted account locks, the
-- sufficiency assertions on each asset the contra draws down, the balance
-- assertion, the status update — is character-for-character what Phase 4C-S
-- and 4B-S wrote. Only the commission leg of the mirror changes, and only
-- when the commission has already been received.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.reverse_agency_transaction(p_transaction_id uuid, p_reason text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor       uuid;
  t             public.agency_transactions;
  pr            public.agency_service_providers;
  v_lines       jsonb := '[]'::jsonb;
  v_receivable  uuid;
  v_recovery    uuid;
  v_back        bigint;
  v_reclassed   bigint := 0;
  v_entry       uuid;
  v_label       text;
  v_outstanding bigint;
  r             record;
  v_debits      bigint := 0;
  v_credits     bigint := 0;
begin
  v_actor := public.agency_actor('agency:reverse');

  if pg_catalog.btrim(coalesce(p_reason, '')) = '' then
    raise exception 'A reversal needs a reason.' using errcode = 'P0001';
  end if;

  -- Phase 4B-S: locked and branch-authorized, like every other lifecycle
  -- function. A reversal moves money, so it was one of the two worst cases in
  -- the reproduced cross-branch vulnerability.
  t := public.agency_locked_transaction(p_transaction_id);

  if t.status = 'reversed' then
    return t.reversal_entry_id;              -- idempotent
  end if;

  if t.status <> 'posted' then
    raise exception
      'Only a posted transaction can be reversed; this one is %.', t.status
      using errcode = 'P0001';
  end if;

  -- Reopening a closed day is a different decision from correcting today's.
  if t.transaction_date < public.business_date()
     and not public.user_has_permission('agency:reverse_cross_day') then
    raise exception
      'This transaction is dated %, and reversing a prior day requires the agency:reverse_cross_day capability.',
      t.transaction_date
      using errcode = '42501';
  end if;

  select * into pr from public.agency_service_providers where id = t.provider_id;

  -- Phase 4C-S, C1. The provider lock, before the receivable is read.
  --
  -- This function decided whether a transaction's deferred commission was
  -- still unsettled by reading agency_commission_outstanding(), with no lock
  -- at all; record_commission_settlement() reads the same figure under
  -- lock_agency_provider_balance(). A settlement of 1,500 and a reversal
  -- carrying 1,000 could each see the full 2,000 outstanding and together
  -- leave the receivable at -500.
  --
  -- Taken before the account locks below, so the global order - provider
  -- lock, then sorted account locks - holds on this path as on every other.
  perform public.lock_agency_provider_balance(t.provider_id, t.branch_id);

  -- Phase 4E, decision OD-10. Until now a transaction whose commission had
  -- already been received could not be reversed at all: the reversal refused
  -- and told the officer to reverse the settlement first. That is a defensible
  -- rule and the wrong one — the customer's transaction and the provider's
  -- payment are different events, and a keying error at the counter should not
  -- need a settlement unwound to correct it.
  --
  -- OD-10: "Permit authorized reversals. Reclassify commission already
  -- received as a provider recovery payable, not a negative receivable."
  --
  -- So the receivable is reduced as far as it goes, and the remainder becomes
  -- a liability in 2230: money we hold that is no longer ours. Read per agent
  -- line where the provider keeps float, because one branch may run several
  -- lines and the figure that binds is the line's own.
  v_receivable := public.ledger_account_by_code('1310');
  v_recovery   := public.ledger_account_by_code('2230');

  -- Both figures bind, and the smaller one decides.
  --
  -- The per-line figure attributes 1310's lines through each entry's source,
  -- and a Phase 4C settlement into cash or the bank names no line — so it
  -- clears receivable that the per-line view still counts as outstanding.
  -- Crediting back the line's figure alone therefore pushed the provider's
  -- branch total negative, which is the very thing this change exists to
  -- prevent. Found by the two existing suites, which is what they are for.
  --
  -- The amount that can go back to 1310 without making either figure negative
  -- is the lesser of the two, so that is what is used.
  if t.commission_model_applied = 'deferred' and t.commission_amount > 0 then
    v_outstanding := public.agency_commission_outstanding(t.provider_id, t.branch_id);

    if t.float_account_id is not null then
      v_outstanding := least(
        v_outstanding,
        public.agency_commission_outstanding_by_line(t.float_account_id));
    end if;
  else
    v_outstanding := 0;
  end if;

  -- Phase 4B-S. Every cash or float account the contra will draw down, locked
  -- up front in one sorted batch.
  --
  -- In practice an agency entry debits exactly one of cash or float, so the
  -- loop below would take a single lock anyway. But the loop walks the journal
  -- in line order, which is data-dependent, and relying on "there happens to
  -- be only one" is how a lock-order inversion arrives later with a new
  -- posting shape. Sorting them here makes the ordering a property of the code
  -- rather than of the data.
  -- Phase 4C-S, C3: both sides, not only the debits. The contra credits
  -- whichever account the original debited, and a credit moves a balance just
  -- as a debit does. `and l.debit > 0` meant the account the contra was about
  -- to *increase* went unlocked, which is the same mistake the posting path
  -- made with deposits.
  perform public.lock_ledger_balances(array(
    select l.account_id
      from public.journal_lines l
      join public.ledger_accounts a on a.id = l.account_id
     where l.entry_id = t.journal_entry_id
       and a.cash_kind is not null
  ));

  -- Mirror the original journal, leg for leg, and check sufficiency on every
  -- asset the contra is about to draw down.
  for r in
    select l.account_id, l.debit, l.credit, l.memo, a.cash_kind
      from public.journal_lines l
      join public.ledger_accounts a on a.id = l.account_id
     where l.entry_id = t.journal_entry_id
     order by l.line_number
  loop
    if r.debit > 0 then
      if r.cash_kind = 'cash_at_hand' then
        perform public.assert_cash_available(r.account_id, r.debit);
      elsif r.cash_kind = 'agency_float' then
        perform public.assert_agency_float_available(r.account_id, r.debit);
      end if;
    end if;

    -- The commission accrual, mirrored. Crediting the whole figure back to
    -- 1310 would drive the receivable negative when the provider has already
    -- paid it, so it is credited only as far as the receivable goes and the
    -- rest is credited to 2230. The entry still balances: both are credits,
    -- and the debit side of the mirror is unchanged.
    if r.account_id = v_receivable and r.debit > 0 then
      v_back := least(r.debit, greatest(v_outstanding, 0));

      if v_back > 0 then
        v_lines := v_lines || public.agency_line(
          r.account_id, 0, v_back,
          'Reversal: ' || coalesce(r.memo, 'commission receivable'));
      end if;

      if r.debit - v_back > 0 then
        v_reclassed := r.debit - v_back;
        v_lines := v_lines || public.agency_line(
          v_recovery, 0, v_reclassed,
          'Commission already received and now owed back to ' || pr.name);
      end if;

      -- Whatever is credited back lowers what remains for the lines after
      -- this one, which matters only if a future entry carries two accruals.
      v_outstanding := v_outstanding - v_back;
    else
      v_lines := v_lines || public.agency_line(
        r.account_id, r.credit, r.debit,
        'Reversal: ' || coalesce(r.memo, 'original line'));
    end if;
  end loop;

  if v_lines = '[]'::jsonb then
    raise exception
      'The original journal for this transaction has no lines; it cannot be mirrored.'
      using errcode = 'P0001';
  end if;

  select coalesce(pg_catalog.sum((l ->> 'debit')::bigint), 0),
         coalesce(pg_catalog.sum((l ->> 'credit')::bigint), 0)
    into v_debits, v_credits
  from pg_catalog.jsonb_array_elements(v_lines) l;

  if v_debits <> v_credits then
    raise exception
      'Refusing to post an unbalanced agency reversal: debits % against credits %.',
      v_debits, v_credits
      using errcode = 'P0001';
  end if;

  select p.full_name into v_label from public.profiles p where p.id = v_actor;

  v_entry := public.post_journal(
    t.branch_id,
    public.business_date(),
    'Reversal of ' || pr.name || ' transaction'
      || coalesce(' — ' || nullif(pg_catalog.btrim(coalesce(t.provider_reference, '')), ''), ''),
    'agency_transaction_reversal', t.id, null, null,
    v_lines,
    pg_catalog.now(), v_actor, coalesce(v_label, 'system')
  );

  update public.agency_transactions
     set status            = 'reversed',
         reversed_at       = pg_catalog.now(),
         reversed_by       = v_actor,
         reversal_reason   = p_reason,
         reversal_entry_id = v_entry
   where id = p_transaction_id;

  -- The stamp that lets the original entry name what undid it. `journal_entries`
  -- refuses DELETE but permits this, which is the pattern `reverse_transfer()`
  -- established.
  update public.journal_entries
     set reversed_by_entry_id = v_entry
   where id = t.journal_entry_id and reversed_by_entry_id is null;

  insert into public.agency_transaction_audit_log
    (transaction_id, action, actor_id, old_value, new_value, reason)
  values (p_transaction_id, 'reverse', v_actor,
          pg_catalog.jsonb_build_object('status', 'posted',
                                        'journal_entry_id', t.journal_entry_id,
                                        'commission_amount', t.commission_amount),
          pg_catalog.jsonb_build_object('status', 'reversed',
                                        'commission_reclassified_to_recovery', v_reclassed,
                                        'reversal_entry_id', v_entry),
          p_reason);

  return v_entry;
end;
$function$;


comment on function public.reverse_agency_transaction(uuid, text) is
  'Phase 4B, serialised in 4B-S and 4C-S, extended in Phase 4E for decision OD-10. Mirrors a posted transaction''s journal leg for leg, asserting sufficiency on every asset the contra draws down. Commission already received from the provider is credited to 2230 rather than driving 1310 negative; the rest of the receivable is credited back as before. Needs agency:reverse, and agency:reverse_cross_day for a prior business day.';


-- ---------------------------------------------------------------------------
-- 5. A commission offset lowers the receivable, so the figure must see it
--
-- `commission_offset` posts Dr 2230, Cr 1310: the provider withholds what it
-- owes us against what we owe it. That credit to 1310 reduces the receivable,
-- and `agency_commission_outstanding()` would not have counted it, because the
-- entry's source type was not in its list. The provider-wide figure would then
-- have reported commission still owed that had already been set off — and
-- `record_commission_settlement()` would have allowed it to be settled again.
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
       or (e.source_type = 'agency_commission_recovery'
         and exists (select 1 from public.agency_commission_recoveries rc
                      where rc.id = e.source_id and rc.provider_id = p_provider_id))
     );
$$;

comment on function public.agency_commission_outstanding(uuid, uuid) is
  'Phase 4B, extended in Phase 4E. Commission a provider has earned at one branch and not yet paid, read from the GL lines on 1310 and attributed through each entry''s source: accruals through the transaction; settlements, their reversals and payouts into float through the settlement register; and commission offsets through the recovery register.';

-- Deliberately revoked and not granted. The pre-4E figure was engine-only,
-- and widening a read helper to `authenticated` because a screen wants it is
-- how a capability check gets skipped: the screens read these figures through
-- views whose RLS requires agency:reports.
revoke all on function public.agency_commission_outstanding(uuid, uuid)
  from public, anon, authenticated;


-- And the per-line figure, for the same reason: an offset against a line
-- lowers what that line is owed.
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
       or (e.source_type = 'agency_commission_recovery'
         and exists (select 1 from public.agency_commission_recoveries rc
                      where rc.id = e.source_id
                        and rc.float_account_id = p_float_account_id))
     );
$$;

-- Deliberately revoked and not granted. The pre-4E figure was engine-only,
-- and widening a read helper to `authenticated` because a screen wants it is
-- how a capability check gets skipped: the screens read these figures through
-- views whose RLS requires agency:reports.
revoke all on function public.agency_commission_outstanding_by_line(uuid)
  from public, anon, authenticated;
