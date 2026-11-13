-- ===========================================================================
-- Phase 4D — the verifier must have seen the figures they are posting.
--
-- `verify_agency_transaction(uuid)` took only an identifier, so it could not
-- tell a considered verification from a stale one. The scenario, reproduced
-- before this migration existed:
--
--   1. A manager opens the pending verification queue.
--   2. An Owner authorises a commission exception on one of those
--      transactions, changing the figure that will post.
--   3. The manager presses Verify on the screen they already had.
--
-- That posted the Owner's new figure without the manager ever having seen it.
-- Maker-checker in form - two people, two capabilities - but not in fact,
-- because the second person approved something other than what they read.
--
-- ## The mechanism
--
-- A revision counter on the transaction, incremented by a trigger whenever a
-- field that affects the money changes, and a verification that may quote the
-- revision it reviewed.
--
-- Two guards, because one is not enough:
--
--   * A caller that quotes a revision must quote the current one. This is the
--     strict check, and the interface always passes it.
--   * A caller that quotes nothing is refused as soon as the figures have
--     moved after submission. Without this second guard the protection would
--     bind only callers that opted in, which is a statement about the
--     application rather than about the database.
--
-- Both sit after the idempotent early return, so a retry of an
-- already-posted transaction still gets its journal back rather than a
-- complaint about a revision - the retry safety Phase 4B established is
-- untouched.
--
-- The one-argument call still works and still means what it meant, so no
-- existing authorized workflow changes. The old single-argument function is
-- dropped rather than replaced: adding a defaulted parameter changes the
-- signature, and leaving both would make a one-argument call ambiguous.
-- ===========================================================================

alter table public.agency_transactions
  add column revision integer not null default 1,
  -- What the revision was when the second officer was asked to look at it.
  add column submitted_revision integer,

  add constraint agency_transactions_revision_positive check (revision >= 1);

comment on column public.agency_transactions.revision is
  'Phase 4D. Incremented whenever a field affecting the money changes. A verifier may quote the revision they reviewed, and verification is refused if it is not the current one.';

comment on column public.agency_transactions.submitted_revision is
  'Phase 4D. The revision at the moment the transaction was handed to a second officer. A verification that quotes no revision is refused once this and `revision` differ.';


-- ---------------------------------------------------------------------------
-- What counts as a financial change
--
-- The amount, the fee, the commission and the accounts the entry will touch.
-- Deliberately NOT the status, the verifier, the journal or the reversal
-- columns: posting changes those, and counting them would make every posting
-- bump the revision and break the idempotent retry above.
-- ---------------------------------------------------------------------------

create or replace function public.agency_transaction_revision_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.principal_amount            is distinct from old.principal_amount
     or new.customer_fee             is distinct from old.customer_fee
     or new.commission_supplied      is distinct from old.commission_supplied
     or new.commission_exception_amount   is distinct from old.commission_exception_amount
     or new.commission_exception_computed is distinct from old.commission_exception_computed
     or new.transaction_type_id      is distinct from old.transaction_type_id
     or new.float_account_id         is distinct from old.float_account_id
     or new.payable_account_id       is distinct from old.payable_account_id
     or new.income_account_id        is distinct from old.income_account_id then
    new.revision := old.revision + 1;
  end if;
  return new;
end;
$$;

revoke all on function public.agency_transaction_revision_guard()
  from public, anon, authenticated;

create trigger agency_transactions_revision
  before update on public.agency_transactions
  for each row execute function public.agency_transaction_revision_guard();


-- ---------------------------------------------------------------------------
-- Submission records the revision the second officer is being shown
-- ---------------------------------------------------------------------------

create or replace function public.agency_transaction_submitted_revision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'awaiting_verification'
     and old.status is distinct from 'awaiting_verification' then
    -- `revision` is already final for this row: this trigger fires after the
    -- revision guard, which is ordered by name (`...revision` precedes
    -- `...submitted_revision` alphabetically, and PostgreSQL fires
    -- same-event row triggers in name order).
    new.submitted_revision := new.revision;
  end if;
  return new;
end;
$$;

revoke all on function public.agency_transaction_submitted_revision()
  from public, anon, authenticated;

create trigger agency_transactions_submitted_revision
  before update on public.agency_transactions
  for each row execute function public.agency_transaction_submitted_revision();


drop function if exists public.verify_agency_transaction(uuid);

create or replace function public.verify_agency_transaction(
  p_transaction_id   uuid,
  p_expected_revision integer default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  t       public.agency_transactions;
  v_entry uuid;
begin
  v_actor := public.agency_actor('agency:verify');

  -- Locks the row and refuses it if the caller's branch may not see it.
  t := public.agency_locked_transaction(p_transaction_id);

  if t.status = 'posted' then
    return t.journal_entry_id;               -- idempotent: already verified
  end if;

  if t.status <> 'awaiting_verification' then
    raise exception
      'Only a transaction awaiting verification can be verified; this one is %.', t.status
      using errcode = 'P0001';
  end if;

  if t.submitted_by = v_actor then
    raise exception
      'A transaction cannot be verified by the person who recorded it.'
      using errcode = '42501';
  end if;

  -- --- the verifier must have seen the figures they are posting ------------
  --
  -- Phase 4D. Maker-checker was in form but not in fact: this function took
  -- only an id, so a manager could press Verify on a screen loaded before an
  -- Owner authorised a commission exception, and post a figure they had never
  -- seen. Both guards below are after the idempotent return above, so a retry
  -- of an already-posted transaction still returns its journal rather than
  -- being refused for quoting an old revision.
  --
  -- A caller that quotes the revision it reviewed must quote the current one.
  if p_expected_revision is not null and p_expected_revision <> t.revision then
    raise exception
      'The financial details of this transaction changed since your screen loaded (you reviewed revision %, it is now revision %). Reload and review the current values before verifying.',
      p_expected_revision, t.revision
      using errcode = 'P0001';
  end if;

  -- And a caller that quotes nothing is refused once the money has moved
  -- after submission. Without this the guard would bind only the callers that
  -- opted into it, which is not a guarantee about the database.
  if p_expected_revision is null and t.revision is distinct from t.submitted_revision then
    raise exception
      'The financial details of this transaction changed after it was submitted (submitted at revision %, now revision %). Reload the transaction and verify the revision you reviewed.',
      t.submitted_revision, t.revision
      using errcode = 'P0001';
  end if;

  -- Stamped before posting, because the snapshot CHECK requires a verifier on
  -- any posted row and `post_agency_transaction` is what sets `posted`.
  update public.agency_transactions set verified_by = v_actor where id = p_transaction_id;

  v_entry := public.post_agency_transaction(p_transaction_id);

  insert into public.agency_transaction_audit_log
    (transaction_id, action, actor_id, old_value, new_value)
  values (p_transaction_id, 'verify', v_actor,
          pg_catalog.jsonb_build_object('status', 'awaiting_verification'),
          pg_catalog.jsonb_build_object('status', 'posted', 'journal_entry_id', v_entry));

  insert into public.agency_transaction_audit_log
    (transaction_id, action, actor_id, new_value)
  values (p_transaction_id, 'post', v_actor,
          pg_catalog.jsonb_build_object('journal_entry_id', v_entry));

  return v_entry;
end;
$$;

comment on function public.verify_agency_transaction(uuid, integer) is
  'Phase 4B, extended in Phase 4D. Verifies and posts one agency transaction. Requires agency:verify, refuses another branch''s transaction, refuses the officer who recorded it, and is idempotent: an already-posted transaction returns its journal. The second argument is the revision the verifier reviewed; verification is refused if it is not the current one, and a call quoting no revision is refused once the figures have changed after submission - so a manager cannot post a figure an Owner authorised behind a screen they had already loaded.';

revoke all on function public.verify_agency_transaction(uuid, integer)
  from public, anon;
grant execute on function public.verify_agency_transaction(uuid, integer)
  to authenticated;


-- ---------------------------------------------------------------------------
-- The verifier's screen has to be able to read the revision it is showing
--
-- `create or replace view` may only append columns, which is all this needs.
-- Appended rather than placed next to the money it guards, because the
-- alternative is dropping and recreating the view and its grants.
-- ---------------------------------------------------------------------------

create or replace view public.agency_transaction_history
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
  t.created_at,
  -- Phase 4D. What the screen must quote back when it verifies.
  t.revision
from public.agency_transactions t
join public.agency_service_providers p on p.id = t.provider_id
join public.agency_transaction_types ty on ty.id = t.transaction_type_id
join public.branches b on b.id = t.branch_id;

comment on view public.agency_transaction_history is
  'Phase 4C, extended in Phase 4D. One row per agency transaction with its provider, service, direction, money and commission, including any authorised commission exception, and the revision a verifier must quote. security_invoker.';
