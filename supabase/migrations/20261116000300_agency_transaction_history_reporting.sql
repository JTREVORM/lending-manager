-- ===========================================================================
-- Polytos Agency redesign — what a transaction report has to be able to ask
--
-- `agency_transaction_history` is the view every transaction screen and every
-- transaction report reads. It carries the provider's id, code and name, and
-- the two profile ids of the officers who submitted and verified the row.
--
-- Three things the redesign's reporting needs are therefore missing:
--
--   * **the provider's category**, so "every Agent Banking transaction" and
--     "every Mobile Money transaction" are a filter rather than a second
--     query against the provider table, and so no report has to name a code;
--   * **the two officers' names**, because §6.1 asks for "entering and
--     verifying personnel" on a transaction report and §6.5 asks for a report
--     per staff member — and a report that printed two UUIDs would have to be
--     joined back to `profiles` by five screens, each of which could join it
--     differently;
--   * **the branch's name**, for the same reason the branch code alone is not
--     enough on a printed report.
--
-- Appended, not rewritten: the body below is the definition
-- `20261115001300` created, verbatim, with five columns added at the end, so
-- every existing reader is untouched by construction. `create or replace
-- view` would refuse anything else.
--
-- `security_invoker = true` is kept, so the reader's own capability and branch
-- rule still decide which rows come back. The two joins to `profiles` are
-- LEFT joins: a draft transaction has no verifier, and a left join is what
-- keeps it in the register instead of silently dropping it.
-- ===========================================================================

create or replace view public.agency_transaction_history
with (security_invoker = true) as
select
  t.id,
  t.branch_id,
  b.branch_code,
  t.provider_id,
  p.code  as provider_code,
  p.name  as provider_name,
  ty.code as type_code,
  ty.name as type_name,
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
  t.created_at,
  t.revision,
  -- Phase 4E.
  t.float_account_id,
  f.till_name,
  nullif(f.label, '') as label,
  t.customer_fee_mode,
  t.transacted_at,
  -- Appended by the Agency redesign.
  p.category          as provider_category,
  b.name              as branch_name,
  maker.full_name     as submitted_by_name,
  checker.full_name   as verified_by_name,
  -- The provider's own identifier for the line, which is what a bank prints
  -- on the statement a transaction report is reconciled against.
  f.agent_code
from public.agency_transactions t
join public.agency_service_providers p on p.id = t.provider_id
join public.agency_transaction_types ty on ty.id = t.transaction_type_id
join public.branches b on b.id = t.branch_id
left join public.agency_provider_float_accounts f on f.id = t.float_account_id
left join public.profiles maker on maker.id = t.submitted_by
left join public.profiles checker on checker.id = t.verified_by;

comment on view public.agency_transaction_history is
  'Phase 4B, extended by the Agency redesign. Every agency transaction with its provider, type, branch, line and figures. provider_category separates the Agent Banking reports from the Mobile Money reports without naming a provider code; submitted_by_name and verified_by_name are the maker and the checker, which the transaction and agent-performance reports both print. security_invoker, so the reader''s own capability and branch rule decide the rows.';
