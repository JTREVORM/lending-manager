-- ===========================================================================
-- Phase 4C — Correcting a commission settlement.
--
-- Deviation D7. Phase 4A gave `agency_payable_settlements` a status and five
-- reversal columns and gave the ledger an
-- `agency_payable_settlement_reversal` source type.
-- `agency_commission_settlements` got none of it.
--
-- That asymmetry is not cosmetic. Phase 4B refuses to reverse a transaction
-- whose deferred commission has already been settled — correctly, because
-- reversing the accrual while the cash has been banked would leave 1310 in
-- debit against a receivable nobody owes. But with no way to correct a
-- settlement, a settlement recorded **in error** permanently blocks the
-- reversal of an otherwise perfectly valid historical transaction. The error
-- becomes unfixable by being recorded.
--
-- So: a correction, not a deletion. The original row is kept and annotated,
-- a balanced contra entry is posted, and 1310 is restored.
--
-- ## The part that would be a silent bug if it were left out
--
-- `agency_commission_outstanding()` nets accruals against entries whose
-- source type is `agency_commission_settlement`. A correction posts a
-- *different* source type. If that type were not added to the function, a
-- corrected settlement would still count as having cleared the receivable:
-- the outstanding figure would stay understated for ever, the next genuine
-- settlement would be refused as excessive, and nothing would say why. That
-- is the unexplained negative receivable this task forbids, arriving by
-- omission rather than by intent. The function is amended below, in the same
-- migration, because shipping one without the other is shipping a defect.
-- ===========================================================================

alter table public.journal_entries
  drop constraint journal_entries_source_valid;

alter table public.journal_entries
  add constraint journal_entries_source_valid
  check (
    source_type = any (array[
      'opening_balance', 'loan_disbursement', 'loan_repayment', 'payment_reversal',
      'penalty_charge', 'transfer', 'transfer_reversal', 'expense', 'expense_reversal',
      'other_income', 'other_income_reversal', 'reconciliation_adjustment', 'adjustment',
      'membership_fee', 'membership_fee_reversal', 'savings_deposit',
      'savings_deposit_reversal', 'savings_withdrawal', 'savings_withdrawal_reversal',
      'benefit_payment', 'benefit_payment_reversal',
      -- Phase 4A
      'agency_transaction', 'agency_transaction_reversal',
      'agency_commission_settlement',
      'agency_payable_settlement', 'agency_payable_settlement_reversal',
      -- Phase 4C
      'agency_float_replenishment',
      'agency_commission_settlement_reversal'
    ])
  );


alter table public.agency_commission_settlements
  add column status            text not null default 'posted',
  add column reversed_at       timestamptz,
  add column reversed_by       uuid references public.profiles(id) on delete restrict,
  add column reversal_reason   text,
  add column reversal_entry_id uuid references public.journal_entries(id) on delete restrict,

  add constraint agency_commission_settlement_status_valid
    check (status in ('posted', 'reversed')),

  -- The same completeness pair the payable table carries: a reversed
  -- settlement names who, when, why and with which contra entry, and an
  -- unreversed one carries none of those.
  add constraint agency_commission_settlement_reversed_is_complete
    check (
      status <> 'reversed'
      or (reversed_at is not null and reversed_by is not null
          and reversal_reason is not null and reversal_entry_id is not null)
    ),
  add constraint agency_commission_settlement_unreversed_is_clean
    check (
      status = 'reversed'
      or (reversed_at is null and reversed_by is null
          and reversal_entry_id is null)
    );

comment on column public.agency_commission_settlements.status is
  'Phase 4C. posted, or reversed by a contra entry. A settlement is never deleted: correcting one leaves the original row and adds the reversal identity, date, reason and contra entry to it.';


-- ---------------------------------------------------------------------------
-- The amended outstanding figure — see this migration's header
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
       -- the accruals: entries whose source is one of this provider's
       -- transactions
       (e.source_type in ('agency_transaction', 'agency_transaction_reversal')
         and exists (select 1 from public.agency_transactions t
                      where t.id = e.source_id and t.provider_id = p_provider_id))
       -- the settlements that cleared them, and Phase 4C's corrections of
       -- those settlements, which put the receivable back. Both source types
       -- carry the settlement's own id as source_id.
       or (e.source_type in ('agency_commission_settlement',
                             'agency_commission_settlement_reversal')
         and exists (select 1 from public.agency_commission_settlements s
                      where s.id = e.source_id and s.provider_id = p_provider_id))
     );
$$;

comment on function public.agency_commission_outstanding(uuid, uuid) is
  'Phase 4B, amended in Phase 4C. What one provider is still owed in commission at one branch: debits less credits on 1310, attributed by source entity because 1310 is shared across providers. Counts accruals, the transaction reversals that undo them, the settlements that clear them, and the Phase 4C corrections that put a mistaken settlement back.';

revoke all on function public.agency_commission_outstanding(uuid, uuid)
  from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- Branch-safe access to one commission settlement
-- ---------------------------------------------------------------------------

create or replace function public.agency_locked_commission_settlement(
  p_settlement_id uuid
)
returns public.agency_commission_settlements
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.agency_commission_settlements;
begin
  select * into s from public.agency_commission_settlements
   where id = p_settlement_id for update;

  if s.id is null or not public.user_can_see_branch(s.branch_id) then
    raise exception
      'No agency commission settlement with that identifier is available to you.'
      using errcode = '42501';
  end if;

  return s;
end;
$$;

comment on function public.agency_locked_commission_settlement(uuid) is
  'Phase 4C. Locks one commission settlement and refuses it if the caller''s branch may not see it, with the same refusal as for an unknown id.';

revoke all on function public.agency_locked_commission_settlement(uuid)
  from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- reverse_commission_settlement
--
--   Dr  1310 Agency Commission Receivable   settlement_amount
--   Cr  the account the money was received into
--
-- The exact mirror of §6.8. The cash goes back out of the receiving account,
-- so that account has to still hold it: `assert_cash_available` is the
-- "respect receiving-account availability" requirement, and it is a real
-- constraint rather than a formality — a branch that has already spent the
-- commission cannot un-receive it without first funding the account.
-- ---------------------------------------------------------------------------

create or replace function public.reverse_commission_settlement(
  p_settlement_id uuid,
  p_reason        text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor      uuid;
  v_label      text;
  s            public.agency_commission_settlements;
  v_name       text;
  v_receivable uuid;
  v_entry      uuid;
begin
  -- Settlement-reversal authority, not settlement authority: recording a
  -- remittance and undoing one are different acts, as for the payable path.
  v_actor := public.agency_actor('agency:reverse');

  if pg_catalog.btrim(coalesce(p_reason, '')) = '' then
    raise exception 'A settlement correction needs a reason.'
      using errcode = 'P0001';
  end if;

  -- Locks the row and applies the branch rule.
  s := public.agency_locked_commission_settlement(p_settlement_id);

  if s.status <> 'posted' then
    raise exception
      'That commission settlement is already %, so it cannot be corrected again.',
      s.status
      using errcode = 'P0001';
  end if;

  select p.name into v_name
  from public.agency_service_providers p where p.id = s.provider_id;

  v_receivable := public.ledger_account_by_code('1310');

  -- Provider lock, then sorted account locks. The order this phase keeps
  -- everywhere; see 20261110000100's header.
  perform public.lock_agency_provider_balance(s.provider_id, s.branch_id);
  perform public.lock_ledger_balances(
    array[s.settlement_account_id, v_receivable]);

  -- The money has to still be in the account it was received into.
  perform public.assert_cash_available(
    s.settlement_account_id, s.settlement_amount);

  select p.full_name into v_label from public.profiles p where p.id = v_actor;

  v_entry := public.post_journal(
    s.branch_id,
    public.business_date(),
    coalesce(v_name, 'Agency') || ' commission settlement corrected — ' || p_reason,
    'agency_commission_settlement_reversal', s.id, null, null,
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'account_id', v_receivable,
        'debit', s.settlement_amount, 'credit', 0,
        'memo', 'Commission receivable restored'),
      pg_catalog.jsonb_build_object(
        'account_id', s.settlement_account_id,
        'debit', 0, 'credit', s.settlement_amount,
        'memo', 'Commission returned')),
    pg_catalog.now(), v_actor, coalesce(v_label, 'system')
  );

  update public.agency_commission_settlements
     set status            = 'reversed',
         reversed_at       = pg_catalog.now(),
         reversed_by       = v_actor,
         reversal_reason   = p_reason,
         reversal_entry_id = v_entry
   where id = s.id;

  perform public.record_audit_event(
    'agency.commission_settlement_reversed',
    'agency_commission_settlement', s.id::text,
    pg_catalog.jsonb_build_object(
      'status', 'posted', 'journal_entry_id', s.journal_entry_id),
    pg_catalog.jsonb_build_object(
      'status', 'reversed',
      'reversal_entry_id', v_entry,
      'settlement_amount', s.settlement_amount,
      'reason', p_reason)
  );

  return v_entry;
end;
$$;

comment on function public.reverse_commission_settlement(uuid, text) is
  'Phase 4C. Corrects one commission settlement recorded in error, by a balanced contra entry — Dr 1310, Cr the receiving account — which restores the receivable and releases any historical transaction the settlement was blocking from reversal. Requires agency:reverse, refuses a settlement at another branch with 42501, refuses one already corrected, requires a reason, and refuses if the receiving account no longer holds the money. The settlement row is never deleted: its status, corrector, reason and contra entry are recorded on it.';

revoke all on function public.reverse_commission_settlement(uuid, text)
  from public, anon;
grant execute on function public.reverse_commission_settlement(uuid, text)
  to authenticated;
