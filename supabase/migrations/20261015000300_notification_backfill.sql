-- ===========================================================================
-- Phase 15.3 — the stream that already happened
--
-- The generation triggers in 15.2 fire from here on. Without this migration
-- the bell is empty on the day it is switched on, and stays empty until the
-- next loan is submitted — which would say nothing true about a business with
-- thirty-five loans, nine of them repaid, and five penalties already charged.
--
-- ## This is a derivation, not an invention
--
-- Every row below comes out of the record. A loan carries `submitted_at` and
-- `submitted_by`, `approved_at` and `approved_by`, `disbursed_at`,
-- `cleared_at`, `cancelled_at`; a reversal carries `reversed_at` and its
-- reason; a penalty carries the basis, the rate and the deadline it ran past.
-- So each notification is stamped with the moment its event actually
-- happened, attributed to the person who actually did it, and worded by the
-- same `format` the trigger would have used.
--
-- The dedupe keys are the triggers' keys, character for character. That is
-- what makes this safe to run twice and safe to run *before* the triggers in
-- a database where the events are still to come: the unique constraint on
-- `(category, dedupe_key)` means a backfilled row and a trigger-raised row
-- for the same event are the same row, whichever arrives first. In a fresh
-- database every statement here matches nothing and the migration is a
-- no-op — which is correct, and is what happens in the test database and in
-- the e2e harness, where the seed drives the real functions and the triggers
-- raise the stream themselves.
--
-- ## What is deliberately not backfilled
--
-- `low_float` is a reading of a balance at a moment, and those balances have
-- all moved since. Reconstructing "the MTN float was low on 14 September"
-- would be storing an opinion about the past that nothing will ever correct
-- — precisely the staleness the whole design refuses. It raises from the next
-- journal line onwards and not before.
--
-- `approval_pending` is not backfilled either. A transfer or an expense is
-- notified when it is *created* in a pending state, and a row that has since
-- been approved does not record whether it ever waited: `status` is where it
-- ended, not where it started. Inferring it would be guessing. (There are no
-- transfers, expenses or reconciliations in the live dataset at the time of
-- writing, so this excludes nothing in practice — but the rule is the
-- reason, not the row count.)
--
-- ## No read receipts
--
-- Nothing here is marked read, for anybody. Nobody read a notification that
-- did not exist, and a read receipt is a claim about a person. So the bell is
-- loud on the first morning — which is what switching a bell on over a year
-- of history actually looks like, and the five filters and the mark-all
-- control are there for exactly that.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Submitted for a decision
-- ---------------------------------------------------------------------------
insert into public.notifications (
  category, severity, title, body, audience_permission, audience_branch_id,
  entity_type, entity_id, actor_profile_id, actor_label, occurred_at, dedupe_key
)
select
  'loan_awaiting_approval', 'attention',
  pg_catalog.format('%s is awaiting approval', l.loan_number),
  pg_catalog.format('%s — %s, UGX %s. Submitted for a decision.',
    coalesce(c.full_name, 'A borrower'), coalesce(p.name, 'a loan'),
    pg_catalog.to_char(l.principal_amount, 'FM999,999,999,999')),
  'loans:approve', l.branch_id,
  'loan', l.id, l.submitted_by,
  coalesce(nullif(pg_catalog.btrim(
    (select pr.full_name from public.profiles pr where pr.id = l.submitted_by)), ''), 'system'), l.submitted_at,
  pg_catalog.format('loan:%s:submitted:%s', l.id, l.submitted_at)
from public.loans l
left join public.clients c on c.id = l.client_id
left join public.loan_products p on p.id = l.loan_product_id
where l.submitted_at is not null
on conflict (category, dedupe_key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Approved, and waiting for the money
-- ---------------------------------------------------------------------------
insert into public.notifications (
  category, severity, title, body, audience_permission, audience_branch_id,
  entity_type, entity_id, actor_profile_id, actor_label, occurred_at, dedupe_key
)
select
  'loan_awaiting_disbursement', 'attention',
  pg_catalog.format('%s is approved and awaiting disbursement', l.loan_number),
  pg_catalog.format('%s — UGX %s to be released.',
    coalesce(c.full_name, 'A borrower'),
    pg_catalog.to_char(l.principal_amount, 'FM999,999,999,999')),
  'loans:disburse', l.branch_id,
  'loan', l.id, l.approved_by,
  coalesce(nullif(pg_catalog.btrim(
    (select pr.full_name from public.profiles pr where pr.id = l.approved_by)), ''), 'system'), l.approved_at,
  pg_catalog.format('loan:%s:approved', l.id)
from public.loans l
left join public.clients c on c.id = l.client_id
where l.approved_at is not null
on conflict (category, dedupe_key) do nothing;

-- ---------------------------------------------------------------------------
-- 3. Refused or withdrawn — the one category addressed to a person
-- ---------------------------------------------------------------------------
insert into public.notifications (
  category, severity, title, body, audience_permission,
  audience_profile_id, audience_branch_id,
  entity_type, entity_id, actor_profile_id, actor_label, occurred_at, dedupe_key
)
select
  'loan_decided',
  case when l.closure_kind = 'rejected' then 'attention' else 'info' end,
  pg_catalog.format('%s was %s', l.loan_number,
    case when l.closure_kind = 'rejected' then 'refused' else 'withdrawn' end),
  coalesce(l.cancellation_reason, 'No reason was recorded.'),
  'loans:view', l.submitted_by, l.branch_id,
  'loan', l.id, l.cancelled_by,
  coalesce(nullif(pg_catalog.btrim(
    (select pr.full_name from public.profiles pr where pr.id = l.cancelled_by)), ''), 'system'),
  coalesce(l.cancelled_at, l.updated_at),
  pg_catalog.format('loan:%s:cancelled', l.id)
from public.loans l
where l.status = 'cancelled'
on conflict (category, dedupe_key) do nothing;

-- ---------------------------------------------------------------------------
-- 4. Disbursed
-- ---------------------------------------------------------------------------
insert into public.notifications (
  category, severity, title, body, audience_permission, audience_branch_id,
  entity_type, entity_id, actor_profile_id, actor_label, occurred_at, dedupe_key
)
select
  'loan_disbursed', 'info',
  pg_catalog.format('%s was disbursed', l.loan_number),
  pg_catalog.format('UGX %s released to %s.',
    pg_catalog.to_char(l.principal_amount, 'FM999,999,999,999'),
    coalesce(c.full_name, 'the borrower')),
  'loans:view', l.branch_id,
  'loan', l.id, l.disbursed_by,
  coalesce(nullif(pg_catalog.btrim(
    (select pr.full_name from public.profiles pr where pr.id = l.disbursed_by)), ''), 'system'), l.disbursed_at,
  pg_catalog.format('loan:%s:disbursed', l.id)
from public.loans l
left join public.clients c on c.id = l.client_id
where l.disbursed_at is not null
on conflict (category, dedupe_key) do nothing;

-- ---------------------------------------------------------------------------
-- 5. Repaid in full
-- ---------------------------------------------------------------------------
insert into public.notifications (
  category, severity, title, body, audience_permission, audience_branch_id,
  entity_type, entity_id, actor_profile_id, actor_label, occurred_at, dedupe_key
)
select
  'loan_cleared', 'info',
  pg_catalog.format('%s is cleared', l.loan_number),
  pg_catalog.format('%s has repaid in full.', coalesce(c.full_name, 'The borrower')),
  'loans:view', l.branch_id,
  'loan', l.id, l.cleared_by,
  coalesce(nullif(pg_catalog.btrim(
    (select pr.full_name from public.profiles pr where pr.id = l.cleared_by)), ''), 'system'), l.cleared_at,
  pg_catalog.format('loan:%s:cleared:%s', l.id, l.cleared_at)
from public.loans l
left join public.clients c on c.id = l.client_id
where l.status = 'cleared' and l.cleared_at is not null
on conflict (category, dedupe_key) do nothing;

-- ---------------------------------------------------------------------------
-- 6. A payment taken back
-- ---------------------------------------------------------------------------
insert into public.notifications (
  category, severity, title, body, audience_permission, audience_branch_id,
  entity_type, entity_id, actor_profile_id, actor_label, occurred_at, dedupe_key
)
select
  'payment_reversed', 'urgent',
  pg_catalog.format('%s was reversed', pay.payment_number),
  pg_catalog.format('UGX %s on %s. %s',
    pg_catalog.to_char(pay.amount, 'FM999,999,999,999'),
    coalesce(l.loan_number, 'a loan'),
    coalesce(pay.reversal_reason, 'No reason was recorded.')),
  'payments:reverse', l.branch_id,
  'payment', pay.id, pay.reversed_by,
  coalesce(nullif(pg_catalog.btrim(
    (select pr.full_name from public.profiles pr where pr.id = pay.reversed_by)), ''), 'system'),
  coalesce(pay.reversed_at, pay.created_at),
  pg_catalog.format('payment:%s:reversed', pay.id)
from public.loan_payments pay
left join public.loans l on l.id = pay.loan_id
where pay.status = 'reversed'
on conflict (category, dedupe_key) do nothing;

-- ---------------------------------------------------------------------------
-- 7. A penalty charged
--
-- No actor: a penalty is materialised by the rule, not decided by a person,
-- which is why `loan_penalties` carries no `created_by` to attribute it to.
-- ---------------------------------------------------------------------------
insert into public.notifications (
  category, severity, title, body, audience_permission, audience_branch_id,
  entity_type, entity_id, actor_label, occurred_at, dedupe_key
)
select
  'penalty_applied', 'urgent',
  pg_catalog.format('%s has been charged a penalty', coalesce(l.loan_number, 'A loan')),
  pg_catalog.format('UGX %s charged to %s after the grace period ran out on %s. Calculated at %s%% of the UGX %s outstanding at the deadline.',
    pg_catalog.to_char(pen.penalty_amount, 'FM999,999,999,999'),
    coalesce(c.full_name, 'the borrower'),
    pg_catalog.to_char(pen.grace_end_date, 'DD Mon YYYY'),
    pg_catalog.to_char(pen.penalty_rate_bps / 100.0, 'FM999990.0'),
    pg_catalog.to_char(pen.basis_amount, 'FM999,999,999,999')),
  'delinquency:view', l.branch_id,
  'loan', pen.loan_id, 'system', pen.created_at,
  pg_catalog.format('penalty:%s', pen.id)
from public.loan_penalties pen
left join public.loans l on l.id = pen.loan_id
left join public.clients c on c.id = l.client_id
on conflict (category, dedupe_key) do nothing;

-- ---------------------------------------------------------------------------
-- 8. A promise taken
--
-- `created_by_label` rather than the profile's current name: the recovery
-- file already froze the officer's name as it was when they wrote the note,
-- for the reason the append-only tables all share.
-- ---------------------------------------------------------------------------
insert into public.notifications (
  category, severity, title, body, audience_permission, audience_branch_id,
  entity_type, entity_id, actor_profile_id, actor_label, occurred_at, dedupe_key
)
select
  'promise_recorded', 'attention',
  pg_catalog.format('%s promised UGX %s by %s',
    coalesce(c.full_name, 'A borrower'),
    pg_catalog.to_char(act.promised_amount, 'FM999,999,999,999'),
    pg_catalog.to_char(act.promised_on, 'DD Mon')),
  pg_catalog.format('On %s. Whether it is kept is read from the payments.',
    coalesce(l.loan_number, 'a loan')),
  'recovery:view', l.branch_id,
  'loan', act.loan_id, act.created_by,
  coalesce(nullif(pg_catalog.btrim(act.created_by_label), ''), 'system'),
  act.created_at,
  pg_catalog.format('promise:%s', act.id)
from public.loan_recovery_actions act
left join public.loans l on l.id = act.loan_id
left join public.clients c on c.id = l.client_id
where act.promised_amount is not null
on conflict (category, dedupe_key) do nothing;

-- ---------------------------------------------------------------------------
-- 9. Security sold
-- ---------------------------------------------------------------------------
insert into public.notifications (
  category, severity, title, body, audience_permission, audience_branch_id,
  entity_type, entity_id, actor_profile_id, actor_label, occurred_at, dedupe_key
)
select
  'collateral_realised', 'urgent',
  pg_catalog.format('Security on %s was sold', coalesce(l.loan_number, 'a loan')),
  pg_catalog.format('%s fetched UGX %s. Post the proceeds as a payment if that has not been done.',
    col.description,
    pg_catalog.to_char(coalesce(col.realised_amount, 0), 'FM999,999,999,999')),
  'collateral:view', l.branch_id,
  'loan', col.loan_id, col.realised_by,
  coalesce(nullif(pg_catalog.btrim(
    (select pr.full_name from public.profiles pr where pr.id = col.realised_by)), ''), 'system'),
  coalesce(col.realised_at, col.updated_at),
  pg_catalog.format('collateral:%s:realised', col.id)
from public.loan_collateral col
left join public.loans l on l.id = col.loan_id
where col.status = 'realised'
on conflict (category, dedupe_key) do nothing;

-- ---------------------------------------------------------------------------
-- 10. A guarantor let out
-- ---------------------------------------------------------------------------
insert into public.notifications (
  category, severity, title, body, audience_permission, audience_branch_id,
  entity_type, entity_id, actor_profile_id, actor_label, occurred_at, dedupe_key
)
select
  'guarantor_released', 'attention',
  pg_catalog.format('%s was released from %s',
    coalesce(
      g.snapshot_full_name,
      (select c2.full_name from public.clients c2 where c2.id = g.guarantor_client_id),
      (select gr.full_name from public.guarantors gr where gr.id = g.guarantor_id),
      'A guarantor'),
    l.loan_number),
  coalesce(g.release_reason, 'No reason was recorded.'),
  'guarantors:view', l.branch_id,
  'loan', g.loan_id, g.released_by,
  coalesce(nullif(pg_catalog.btrim(
    (select pr.full_name from public.profiles pr where pr.id = g.released_by)), ''), 'system'), g.released_at,
  pg_catalog.format('guarantee:%s:released', g.id)
from public.loan_guarantors g
join public.loans l on l.id = g.loan_id
where g.released_at is not null
on conflict (category, dedupe_key) do nothing;

-- ---------------------------------------------------------------------------
-- 11. A borrower blacklisted
--
-- The one event whose actor the row does not record — `clients` carries the
-- status and the reason but not who set them — so this is attributed to
-- `system`, which is what `raise_notification` itself produces for a caller
-- with no profile. The audit log holds the name for anybody who needs it.
-- ---------------------------------------------------------------------------
insert into public.notifications (
  category, severity, title, body, audience_permission, audience_branch_id,
  entity_type, entity_id, actor_label, occurred_at, dedupe_key
)
select
  'client_blacklisted', 'urgent',
  pg_catalog.format('%s has been blacklisted', cl.full_name),
  pg_catalog.format('%s. %s cannot be approved for a further loan while this stands.',
    coalesce(cl.status_reason, 'No reason was recorded.'),
    cl.client_number),
  'clients:view', cl.branch_id,
  'client', cl.id, 'system', cl.updated_at,
  pg_catalog.format('client:%s:blacklisted:%s', cl.id, cl.updated_at)
from public.clients cl
where cl.status = 'blacklisted'
on conflict (category, dedupe_key) do nothing;

