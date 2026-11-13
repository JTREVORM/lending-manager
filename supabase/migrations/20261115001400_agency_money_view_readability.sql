-- ===========================================================================
-- Polytos Phase 4E — the Mobile Money views, actually readable
--
-- ## The defect
--
-- Migration 001300 built three views on top of three SECURITY DEFINER helper
-- functions — `agency_commission_outstanding_by_line`,
-- `agency_commission_recovery_outstanding_by_line` and
-- `agency_commission_earned_by_line` — and 000800 and 001200 revoked those
-- functions from `authenticated`, with a comment claiming that
--
--     the screens read these figures through views whose RLS requires
--     agency:reports.
--
-- The intent was right and the mechanism was wrong. Every view in this
-- application is `security_invoker = true`, which is what makes the branch
-- rule and the capability checks on the underlying tables apply to the person
-- reading. A function called inside such a view runs as the *caller* too, so
-- a revoked EXECUTE is a refusal:
--
--     permission denied for function agency_commission_outstanding_by_line
--
-- Every Mobile Money screen therefore reported "the commission owed to each
-- agent line could not be read". Not a wrong figure — the Phase 4D-F readers
-- refuse rather than render a zero — but no figure at all.
--
-- ## Why this is not fixed by granting EXECUTE
--
-- Because the revoke is correct. A DEFINER function reachable by
-- `authenticated` is an RPC endpoint that reads the ledger with the owner's
-- rights and answers anybody who asks, whatever capability they hold. Phase
-- 4C met this exact question with `agency_commission_outstanding` and settled
-- it the other way round: the function stays engine-only, and
-- `agency_commission_summary` computes the same figure inline from
-- `journal_lines`, where RLS and `ledger:view` apply to the reader.
--
-- This migration follows that precedent. The attribution is defined once, as
-- a view rather than three copies of the SQL, and the three views join to it.
-- The functions keep their revokes and the posting refusals keep using them,
-- so a screen and a refusal still read one definition each — and they still
-- agree, which is what the original comment was reaching for.
--
-- ## What a reader without `ledger:view` sees
--
-- Zero, as they do on `agency_commission_summary` today, because the journal
-- rows are invisible to them. Every staff role holds `ledger:view`, and the
-- screens are gated on `agency:reports` above that, so this is reachable only
-- by giving somebody agency reporting without ledger reading — a combination
-- the role table does not contain. Noted rather than guarded, because
-- guarding it here would mean this view deciding a capability question that
-- belongs to the role table.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. The per-line figures, defined once
-- ---------------------------------------------------------------------------

create or replace view public.agency_commission_line_balances
with (security_invoker = true) as
with attributed as (
  -- Every GL 1310 and 2230 line, with the agent line it belongs to, resolved
  -- through the entry's source exactly as the engine's helpers resolve it.
  -- Both accounts are shared between providers, lines and branches, so an
  -- account-level balance would mix them; the source is the only attribution
  -- there is.
  --
  -- Written as one pass over the two accounts' lines rather than a scalar
  -- subquery per agent line: the figures are the same, and the work does not
  -- multiply by the number of lines open.
  select
    a.code                        as account_code,
    e.source_type,
    l.debit,
    l.credit,
    coalesce(t.float_account_id, s.float_account_id, rc.float_account_id)
                                  as float_account_id
  from public.journal_lines l
  join public.journal_entries e on e.id = l.entry_id
  join public.ledger_accounts a on a.id = l.account_id
  left join public.agency_transactions t
    on t.id = e.source_id
   and e.source_type in ('agency_transaction', 'agency_transaction_reversal')
  left join public.agency_commission_settlements s
    on s.id = e.source_id
   and e.source_type in ('agency_commission_settlement',
                         'agency_commission_settlement_reversal',
                         'agency_commission_payout',
                         'agency_commission_payout_reversal')
  left join public.agency_commission_recoveries rc
    on rc.id = e.source_id
   and e.source_type = 'agency_commission_recovery'
  where a.code in ('1310', '2230')
)
select
  f.id as float_account_id,
  -- GL 1310: what the provider still owes this line. Raised when a
  -- transaction posts, lowered by a settlement, a payout or a recovery the
  -- provider withheld from it.
  coalesce(sum(
    case
      when at.account_code = '1310'
       and at.source_type in ('agency_transaction',
                              'agency_transaction_reversal',
                              'agency_commission_settlement',
                              'agency_commission_settlement_reversal',
                              'agency_commission_payout',
                              'agency_commission_payout_reversal',
                              'agency_commission_recovery')
      then at.debit - at.credit
      else 0
    end
  ), 0)::bigint as commission_outstanding,
  -- GL 2230: what this line has been paid and must give back, which only a
  -- reversal raises and only a recovery clears (decision OD-10).
  coalesce(sum(
    case
      when at.account_code = '2230'
       and at.source_type in ('agency_transaction_reversal',
                              'agency_commission_recovery')
      then at.credit - at.debit
      else 0
    end
  ), 0)::bigint as recovery_owed
from public.agency_provider_float_accounts f
left join attributed at on at.float_account_id = f.id
group by f.id;

comment on view public.agency_commission_line_balances is
  'Phase 4E. Per agent line: the commission on GL 1310 the provider still owes it, and the commission on GL 2230 it must give back. Computed inline from the journal rather than through the engine''s DEFINER helpers, so the reader''s own ledger permission and branch rule apply — the same choice Phase 4C made for agency_commission_summary.';

revoke all on public.agency_commission_line_balances from anon, authenticated;
grant select on public.agency_commission_line_balances to authenticated;


-- ---------------------------------------------------------------------------
-- 2. Commission per agent line, without the refused function calls
-- ---------------------------------------------------------------------------

create or replace view public.agency_commission_by_line
with (security_invoker = true) as
select
  f.id                                     as float_account_id,
  f.provider_id,
  p.code                                   as provider_code,
  p.name                                   as provider_name,
  f.branch_id,
  b.branch_code,
  f.till_name,
  nullif(f.label, '')                      as label,
  f.status                                 as line_status,
  a.code                                   as ledger_account_code,
  coalesce(bal.balance, 0)                 as float_balance,
  coalesce(cb.commission_outstanding, 0)   as commission_outstanding,
  coalesce(cb.recovery_owed, 0)            as recovery_owed
from public.agency_provider_float_accounts f
join public.agency_service_providers p on p.id = f.provider_id
join public.branches b on b.id = f.branch_id
join public.ledger_accounts a on a.id = f.ledger_account_id
left join public.ledger_account_balances bal on bal.account_id = f.ledger_account_id
left join public.agency_commission_line_balances cb on cb.float_account_id = f.id;

comment on view public.agency_commission_by_line is
  'Phase 4E. One row per agent line: its float balance, the commission the provider still owes it, and the commission it owes back. The two commission figures use the same attribution as the posting refusals, so a screen cannot promise what a refusal would deny.';


-- ---------------------------------------------------------------------------
-- 3. The reconciliation register's "what the books say now"
--
-- `agency_commission_earned_by_line()` is one `sum` over posted transactions
-- in the period, so it inlines as a scalar subquery with nothing lost.
-- ---------------------------------------------------------------------------

create or replace view public.agency_commission_reconciliation_register
with (security_invoker = true) as
select
  r.id,
  r.provider_id,
  p.code              as provider_code,
  p.name              as provider_name,
  r.branch_id,
  b.branch_code,
  r.float_account_id,
  f.till_name,
  nullif(f.label, '') as label,
  r.period_start,
  r.period_end,
  r.system_commission_earned,
  r.provider_reported_commission,
  r.variance,
  case
    when r.variance = 0 then 'our books and the statement agree'
    when r.variance > 0 then 'the provider reports more than we recognised'
    else 'we recognised more than the provider reports'
  end                 as variance_means,
  r.statement_ref,
  r.status,
  r.notes,
  r.created_by,
  r.created_at,
  r.reconciled_by,
  r.reconciled_at,
  -- What the same period says now. A difference from the snapshot means a
  -- transaction in the period has been reversed or corrected since.
  coalesce((
    select sum(t.commission_amount)::bigint
      from public.agency_transactions t
     where t.float_account_id = r.float_account_id
       and t.status = 'posted'
       and t.transaction_date between r.period_start and r.period_end
  ), 0)               as current_system_earned
from public.agency_commission_reconciliations r
join public.agency_service_providers p on p.id = r.provider_id
join public.branches b on b.id = r.branch_id
join public.agency_provider_float_accounts f on f.id = r.float_account_id;

comment on view public.agency_commission_reconciliation_register is
  'Phase 4E. Every provider statement period reconciled against the books, with what the difference means in words and what the same period says now — a gap between the snapshot and the current figure means a transaction in it has since been reversed or corrected.';


-- ---------------------------------------------------------------------------
-- 4. The consolidated view's two commission totals
-- ---------------------------------------------------------------------------

create or replace view public.agency_mobile_money_consolidated
with (security_invoker = true) as
select
  p.id                                   as provider_id,
  p.code                                 as provider_code,
  p.name                                 as provider_name,
  b.id                                   as branch_id,
  b.branch_code,
  count(distinct f.id)                   as agent_lines,
  count(distinct f.id) filter (where f.status = 'active')    as active_lines,
  count(distinct f.id) filter (where f.status = 'suspended') as suspended_lines,
  coalesce(sum(bal.balance), 0)::bigint  as float_held,
  coalesce(sum(cb.commission_outstanding), 0)::bigint as commission_outstanding,
  coalesce(sum(cb.recovery_owed), 0)::bigint          as recovery_owed,
  -- Purchases and sales are the provider's float coming in and going out.
  coalesce(sum(tr.purchased), 0)::bigint as float_purchased,
  coalesce(sum(tr.purchase_premium), 0)::bigint  as purchase_premium,
  coalesce(sum(tr.purchase_discount), 0)::bigint as purchase_discount,
  coalesce(sum(tr.sold), 0)::bigint      as float_sold,
  coalesce(sum(tr.sale_fees), 0)::bigint as sale_fee_income,
  -- Transfers in their own columns, and excluded from the two above. A
  -- transfer moves float between two of this provider's own lines, so adding
  -- it to either total would report activity that never happened — twice,
  -- once from each side.
  coalesce(sum(tr.transferred_out), 0)::bigint   as float_transferred_out,
  coalesce(sum(tr.transferred_in), 0)::bigint    as float_transferred_in
from public.agency_service_providers p
join public.agency_provider_float_accounts f on f.provider_id = p.id
join public.branches b on b.id = f.branch_id
left join public.ledger_account_balances bal on bal.account_id = f.ledger_account_id
left join public.agency_commission_line_balances cb on cb.float_account_id = f.id
left join (
  select f2.id as float_account_id,
         coalesce(sum(t.float_amount) filter (where t.kind = 'purchase'
                      and t.float_account_id = f2.id), 0) as purchased,
         coalesce(sum(greatest(t.cash_amount - t.float_amount, 0))
                      filter (where t.kind = 'purchase'
                              and t.float_account_id = f2.id), 0) as purchase_premium,
         coalesce(sum(greatest(t.float_amount - t.cash_amount, 0))
                      filter (where t.kind = 'purchase'
                              and t.float_account_id = f2.id), 0) as purchase_discount,
         coalesce(sum(t.float_amount) filter (where t.kind = 'sale'
                      and t.float_account_id = f2.id), 0) as sold,
         coalesce(sum(t.fee_amount) filter (where t.kind = 'sale'
                      and t.float_account_id = f2.id), 0) as sale_fees,
         coalesce(sum(t.float_amount) filter (where t.kind = 'transfer'
                      and t.float_account_id = f2.id), 0) as transferred_out,
         coalesce(sum(t.float_amount) filter (where t.kind = 'transfer'
                      and t.counter_float_account_id = f2.id), 0) as transferred_in
    from public.agency_provider_float_accounts f2
    join public.agency_float_trades t
      on t.float_account_id = f2.id or t.counter_float_account_id = f2.id
   where t.status = 'posted'
   group by f2.id
) tr on tr.float_account_id = f.id
where p.float_model = 'provider_float'
group by p.id, p.code, p.name, b.id, b.branch_code;

comment on view public.agency_mobile_money_consolidated is
  'Phase 4E. One row per provider and branch: lines open and suspended, float held, commission owed each way, and float bought, sold and moved. Transfers are kept in their own two columns and excluded from the purchase and sale totals, because a transfer between two of our own lines is not activity with the provider.';
