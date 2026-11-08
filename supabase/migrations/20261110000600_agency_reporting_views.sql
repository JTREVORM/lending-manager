-- ===========================================================================
-- Phase 4C — Agency reporting views.
--
-- Seven read-only views, every one `security_invoker = true`, which is the
-- whole security design: the view runs with the **caller's** privileges, so
-- the row-level policies already on `agency_transactions`,
-- `agency_service_providers`, the settlement tables, `journal_entries` and
-- `journal_lines` all apply. A branch-scoped officer sees their branch; Head
-- Office sees every branch; a borrower holds no agency capability and so sees
-- nothing at all. None of that is restated here, because restating it is how
-- the two copies drift apart.
--
-- ## Why the aggregates are computed inline rather than from the helpers
--
-- `agency_commission_outstanding()` and `agency_payable_outstanding()` are
-- SECURITY DEFINER and revoked from `authenticated` — deliberately, since a
-- provider-level receivable is not something any signed-in user should be
-- able to total. A `security_invoker` view that called them would be denied
-- for exactly that reason. So these views recompute the same figures from
-- `journal_lines`, which carries RLS, attributed by **source entity** rather
-- than by account because 1310, 2210 and 2220 are each shared across
-- providers. The attribution rule is therefore written twice — once in the
-- functions, once here — and the suite asserts the two agree.
--
-- These are data views only. The screens that read them are Phase 4D.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Float balances by provider and till
-- ---------------------------------------------------------------------------

create view public.agency_float_balances
with (security_invoker = true) as
select
  f.id                as float_account_id,
  f.provider_id,
  p.code              as provider_code,
  p.name              as provider_name,
  f.branch_id,
  b.branch_code,
  b.name              as branch_name,
  f.till_name,
  f.is_active         as till_is_active,
  a.id                as ledger_account_id,
  a.code              as ledger_account_code,
  coalesce(bal.balance, 0)::bigint as balance,
  p.is_active         as provider_is_active,
  p.is_provisional    as provider_is_provisional
from public.agency_provider_float_accounts f
join public.agency_service_providers p on p.id = f.provider_id
join public.branches b on b.id = f.branch_id
join public.ledger_accounts a on a.id = f.ledger_account_id
left join public.ledger_account_balances bal on bal.account_id = a.id;

comment on view public.agency_float_balances is
  'Phase 4C. Electronic float held in each provider till, by provider and branch. security_invoker, so the caller''s own row-level policies scope it.';

-- The database grants defaults on every new relation, so a bare grant is
-- not enough: without this revoke, anon holds all seven privileges on a
-- brand-new view. Revoke first, then grant the one that is intended.
revoke all on public.agency_float_balances from anon, authenticated;
grant select on public.agency_float_balances to authenticated;


-- ---------------------------------------------------------------------------
-- 2. Transaction history
-- ---------------------------------------------------------------------------

create view public.agency_transaction_history
with (security_invoker = true) as
select
  t.id,
  t.branch_id,
  b.branch_code,
  t.provider_id,
  p.code              as provider_code,
  p.name              as provider_name,
  ty.code             as type_code,
  ty.name             as type_name,
  ty.direction,
  t.transaction_date,
  t.status,
  t.principal_amount,
  t.customer_fee,
  t.commission_amount,
  t.commission_computed,
  t.commission_supplied,
  t.commission_exception_reason,
  t.customer_identifier,
  t.provider_reference,
  t.journal_entry_id,
  t.reversal_entry_id,
  t.submitted_by,
  t.verified_by,
  t.created_at
from public.agency_transactions t
join public.agency_service_providers p on p.id = t.provider_id
join public.agency_transaction_types ty on ty.id = t.transaction_type_id
join public.branches b on b.id = t.branch_id;

comment on view public.agency_transaction_history is
  'Phase 4C. One row per agency transaction with its provider, service, direction, money and commission, including any authorised commission exception. security_invoker.';

-- The database grants defaults on every new relation, so a bare grant is
-- not enough: without this revoke, anon holds all seven privileges on a
-- brand-new view. Revoke first, then grant the one that is intended.
revoke all on public.agency_transaction_history from anon, authenticated;
grant select on public.agency_transaction_history to authenticated;


-- ---------------------------------------------------------------------------
-- 3. Commission earned, received and outstanding
--
-- Earned is what accrued to 1310 and what transaction reversals took back
-- out; received is what settlements cleared; corrections put it back. The
-- three columns are derived from the same source-attributed lines, so they
-- always add up.
-- ---------------------------------------------------------------------------

create view public.agency_commission_summary
with (security_invoker = true) as
with lines as (
  select
    e.branch_id,
    e.source_type,
    coalesce(t.provider_id, s.provider_id) as provider_id,
    l.debit,
    l.credit
  from public.journal_lines l
  join public.journal_entries e on e.id = l.entry_id
  join public.ledger_accounts a on a.id = l.account_id
  left join public.agency_transactions t
    on e.source_type in ('agency_transaction', 'agency_transaction_reversal')
   and t.id = e.source_id
  left join public.agency_commission_settlements s
    on e.source_type in ('agency_commission_settlement',
                         'agency_commission_settlement_reversal')
   and s.id = e.source_id
  where a.code = '1310'
)
select
  lines.provider_id,
  p.code  as provider_code,
  p.name  as provider_name,
  lines.branch_id,
  b.branch_code,
  -- accrued less what transaction reversals removed
  sum(case when lines.source_type in ('agency_transaction',
                                      'agency_transaction_reversal')
           then lines.debit - lines.credit else 0 end)::bigint as commission_earned,
  -- settlements credit 1310; corrections debit it back
  sum(case when lines.source_type = 'agency_commission_settlement'
           then lines.credit - lines.debit else 0 end)::bigint as commission_received,
  sum(case when lines.source_type = 'agency_commission_settlement_reversal'
           then lines.debit - lines.credit else 0 end)::bigint as commission_returned,
  sum(lines.debit - lines.credit)::bigint as commission_outstanding
from lines
join public.agency_service_providers p on p.id = lines.provider_id
join public.branches b on b.id = lines.branch_id
where lines.provider_id is not null
group by lines.provider_id, p.code, p.name, lines.branch_id, b.branch_code;

comment on view public.agency_commission_summary is
  'Phase 4C. Commission earned, received, returned by correction, and still outstanding, per provider and branch. Attributed by source entity because 1310 is shared across providers, and computed inline rather than from agency_commission_outstanding(), which is revoked from authenticated on purpose.';

-- The database grants defaults on every new relation, so a bare grant is
-- not enough: without this revoke, anon holds all seven privileges on a
-- brand-new view. Revoke first, then grant the one that is intended.
revoke all on public.agency_commission_summary from anon, authenticated;
grant select on public.agency_commission_summary to authenticated;


-- ---------------------------------------------------------------------------
-- 4. Provider payables and remittances
-- ---------------------------------------------------------------------------

create view public.agency_payable_summary
with (security_invoker = true) as
with lines as (
  select
    e.branch_id,
    e.source_type,
    coalesce(t.provider_id, s.provider_id) as provider_id,
    l.debit,
    l.credit
  from public.journal_lines l
  join public.journal_entries e on e.id = l.entry_id
  join public.ledger_accounts a on a.id = l.account_id
  left join public.agency_transactions t
    on e.source_type in ('agency_transaction', 'agency_transaction_reversal')
   and t.id = e.source_id
  left join public.agency_payable_settlements s
    on e.source_type in ('agency_payable_settlement',
                         'agency_payable_settlement_reversal')
   and s.id = e.source_id
  where a.code like '22%' and a.cash_kind is null
)
select
  lines.provider_id,
  p.code  as provider_code,
  p.name  as provider_name,
  lines.branch_id,
  b.branch_code,
  sum(case when lines.source_type in ('agency_transaction',
                                      'agency_transaction_reversal')
           then lines.credit - lines.debit else 0 end)::bigint as collected_on_behalf,
  sum(case when lines.source_type = 'agency_payable_settlement'
           then lines.debit - lines.credit else 0 end)::bigint as remitted,
  sum(case when lines.source_type = 'agency_payable_settlement_reversal'
           then lines.credit - lines.debit else 0 end)::bigint as remittance_reversed,
  sum(lines.credit - lines.debit)::bigint as payable_outstanding
from lines
join public.agency_service_providers p on p.id = lines.provider_id
join public.branches b on b.id = lines.branch_id
where lines.provider_id is not null
group by lines.provider_id, p.code, p.name, lines.branch_id, b.branch_code;

comment on view public.agency_payable_summary is
  'Phase 4C. What was collected on each provider''s behalf, what has been remitted, what a reversal put back, and what is still held — per provider and branch, never per shared 2200-series account.';

-- The database grants defaults on every new relation, so a bare grant is
-- not enough: without this revoke, anon holds all seven privileges on a
-- brand-new view. Revoke first, then grant the one that is intended.
revoke all on public.agency_payable_summary from anon, authenticated;
grant select on public.agency_payable_summary to authenticated;


-- ---------------------------------------------------------------------------
-- 5. Cash and float variances, in one list
--
-- Two sources with opposite variance conventions (deviation D2), so the
-- `variance` column here is normalised to a single meaning and the
-- `variance_means` column states it, rather than leaving a reader to guess
-- which sign convention a row follows.
-- ---------------------------------------------------------------------------

create view public.agency_variance_report
with (security_invoker = true) as
select
  'cash'::text          as reconciliation_kind,
  r.id,
  r.branch_id,
  b.branch_code,
  null::uuid            as provider_id,
  null::text            as provider_name,
  null::uuid            as float_account_id,
  r.cash_account_id     as account_id,
  r.reconciliation_date,
  r.system_closing_balance,
  r.physical_count      as counted_or_statement_balance,
  r.variance,
  'physical count less the books'::text as variance_means,
  r.variance_written_off,
  r.variance_journal_entry_id,
  r.status,
  r.created_by,
  r.reconciled_by,
  null::text            as provider_statement_ref,
  r.notes
from public.agency_cash_reconciliations r
join public.branches b on b.id = r.branch_id
union all
select
  'float'::text         as reconciliation_kind,
  r.id,
  r.branch_id,
  b.branch_code,
  r.provider_id,
  p.name                as provider_name,
  r.float_account_id,
  f.ledger_account_id   as account_id,
  r.reconciliation_date,
  r.system_closing_balance,
  r.provider_statement_balance as counted_or_statement_balance,
  r.variance,
  'the books less the provider statement'::text as variance_means,
  r.variance_written_off,
  r.variance_journal_entry_id,
  r.status,
  r.created_by,
  r.reconciled_by,
  r.provider_statement_ref,
  r.notes
from public.agency_float_reconciliations r
join public.agency_provider_float_accounts f on f.id = r.float_account_id
left join public.agency_service_providers p on p.id = r.provider_id
join public.branches b on b.id = r.branch_id;

comment on view public.agency_variance_report is
  'Phase 4C. Cash counts and float statements in one list. The two tables use opposite variance conventions, so every row states what its own sign means rather than leaving a reader to infer it.';

-- The database grants defaults on every new relation, so a bare grant is
-- not enough: without this revoke, anon holds all seven privileges on a
-- brand-new view. Revoke first, then grant the one that is intended.
revoke all on public.agency_variance_report from anon, authenticated;
grant select on public.agency_variance_report to authenticated;


-- ---------------------------------------------------------------------------
-- 6. Daily agency cash movement
--
-- What agency work did to the branch tills on a given day. Restricted to
-- cash_at_hand lines on agency-sourced entries, so lending movement through
-- the same drawer is not counted here — the shared till is reconciled as a
-- whole by the cash reconciliation, but attributed per module by this view.
-- ---------------------------------------------------------------------------

create view public.agency_daily_cash_movement
with (security_invoker = true) as
select
  e.branch_id,
  b.branch_code,
  e.entry_date,
  a.id   as cash_account_id,
  a.code as cash_account_code,
  e.source_type,
  count(*)::bigint                       as entry_lines,
  sum(l.debit)::bigint                   as cash_in,
  sum(l.credit)::bigint                  as cash_out,
  (sum(l.debit) - sum(l.credit))::bigint as net_movement
from public.journal_lines l
join public.journal_entries e on e.id = l.entry_id
join public.ledger_accounts a on a.id = l.account_id
join public.branches b on b.id = e.branch_id
where a.cash_kind = 'cash_at_hand'
  and e.source_type in (
    'agency_transaction', 'agency_transaction_reversal',
    'agency_commission_settlement', 'agency_commission_settlement_reversal',
    'agency_payable_settlement', 'agency_payable_settlement_reversal',
    'agency_float_replenishment')
group by e.branch_id, b.branch_code, e.entry_date, a.id, a.code, e.source_type;

comment on view public.agency_daily_cash_movement is
  'Phase 4C. Agency cash into and out of each branch till per day, by source. Lending movement through the same drawer is excluded here and included in the cash reconciliation, which counts the whole till.';

-- The database grants defaults on every new relation, so a bare grant is
-- not enough: without this revoke, anon holds all seven privileges on a
-- brand-new view. Revoke first, then grant the one that is intended.
revoke all on public.agency_daily_cash_movement from anon, authenticated;
grant select on public.agency_daily_cash_movement to authenticated;


-- ---------------------------------------------------------------------------
-- 7. End-of-day exceptions
--
-- The things that should be looked at before a day is called finished. Each
-- row names the kind of exception and what it is about, so one query answers
-- "what is outstanding" rather than seven.
-- ---------------------------------------------------------------------------

create view public.agency_end_of_day_exceptions
with (security_invoker = true) as
-- A transaction recorded but never verified or cancelled.
select
  'unverified_transaction'::text as exception_kind,
  t.branch_id,
  t.transaction_date   as as_of_date,
  t.id                 as subject_id,
  p.name               as provider_name,
  t.principal_amount   as amount,
  t.status             as detail
from public.agency_transactions t
join public.agency_service_providers p on p.id = t.provider_id
where t.status in ('draft', 'awaiting_verification')
union all
-- A count or statement submitted and never certified.
select
  'open_reconciliation'::text,
  r.branch_id,
  r.reconciliation_date,
  r.id,
  null::text,
  r.variance,
  'cash count awaiting approval'::text
from public.agency_cash_reconciliations r
where r.status = 'open'
union all
select
  'open_reconciliation'::text,
  r.branch_id,
  r.reconciliation_date,
  r.id,
  p.name,
  r.variance,
  'float statement awaiting approval'::text
from public.agency_float_reconciliations r
left join public.agency_service_providers p on p.id = r.provider_id
where r.status = 'open'
union all
-- A certified reconciliation whose difference was never explained.
select
  'unexplained_variance'::text,
  r.branch_id,
  r.reconciliation_date,
  r.id,
  null::text,
  r.variance,
  'cash variance recorded but not written off'::text
from public.agency_cash_reconciliations r
where r.status = 'reconciled' and r.variance <> 0 and r.variance_written_off = 0
union all
select
  'unexplained_variance'::text,
  r.branch_id,
  r.reconciliation_date,
  r.id,
  p.name,
  r.variance,
  'float variance recorded but not written off'::text
from public.agency_float_reconciliations r
left join public.agency_service_providers p on p.id = r.provider_id
where r.status = 'reconciled' and r.variance <> 0 and r.variance_written_off = 0
union all
-- A float till that an active provider has let run dry.
select
  'float_exhausted'::text,
  v.branch_id,
  null::date,
  v.float_account_id,
  v.provider_name,
  v.balance,
  'float till is empty'::text
from public.agency_float_balances v
where v.till_is_active and v.provider_is_active and v.balance <= 0;

comment on view public.agency_end_of_day_exceptions is
  'Phase 4C. What should be looked at before a day is called finished: transactions neither verified nor cancelled, reconciliations awaiting approval, certified reconciliations whose difference was never explained, and active float tills that have run dry.';

-- The database grants defaults on every new relation, so a bare grant is
-- not enough: without this revoke, anon holds all seven privileges on a
-- brand-new view. Revoke first, then grant the one that is intended.
revoke all on public.agency_end_of_day_exceptions from anon, authenticated;
grant select on public.agency_end_of_day_exceptions to authenticated;
