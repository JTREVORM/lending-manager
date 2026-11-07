-- ===========================================================================
-- Phase 4A — Agency Banking & Digital Payments: the audit trail
--
-- Specification: `docs/AGENCY-BANKING-ARCHITECTURE.md` v3.0, §5.10.
--
-- Append-only, by the same three triggers `audit_log` uses: UPDATE, DELETE
-- and TRUNCATE are all refused at statement level. Task 6 requires that
-- "reversals preserve the complete audit trail", and a trail that can be
-- edited preserves nothing.
--
-- ## Why a second audit table rather than rows in `audit_log`
--
-- `audit_log` is the system-wide trail and keeps its own shape. This one is
-- narrower and stricter: every row names a transaction, and the actor is
-- `not null` rather than nullable-with-a-label. An agency posting always has
-- an identified person behind it — the Phase 4B functions take the actor from
-- `current_profile_id()` and refuse an unattributable session, exactly as
-- loan disbursement does (Phase 3 finding F3). So the column can be `not
-- null`, and that is a stronger guarantee than the general trail can make.
--
-- The two are complementary, not duplicative: `audit_log` answers "what
-- happened in this system", this answers "everything that ever happened to
-- this transaction".
-- ===========================================================================

create table public.agency_transaction_audit_log (
  id             uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references public.agency_transactions(id) on delete restrict,
  action         text not null,
  actor_id       uuid not null references public.profiles(id) on delete restrict,
  old_value      jsonb,
  new_value      jsonb,
  reason         text,
  created_at     timestamptz not null default now(),

  constraint agency_audit_action_valid
    check (action = any (array[
      'submit', 'verify', 'post', 'reverse', 'cancel', 'reference_corrected'
    ])),

  -- A reversal and a reference correction are the two actions a reviewer will
  -- always ask "why" about, so neither may be recorded without an answer.
  constraint agency_audit_reason_required_where_it_matters
    check (
      action not in ('reverse', 'reference_corrected')
      or (reason is not null and pg_catalog.btrim(reason) <> '')
    ),

  -- A correction that records neither what changed nor what it became is not
  -- a record of a correction.
  constraint agency_audit_correction_records_both_values
    check (
      action <> 'reference_corrected'
      or (old_value is not null and new_value is not null)
    )
);

comment on table public.agency_transaction_audit_log is
  'Phase 4A, §5.10. Append-only history of every state change to an agency transaction. actor_id is NOT NULL because the Phase 4B functions take the actor from current_profile_id() and refuse an unattributable session, so there is no legitimate anonymous row. A reversal or a reference correction must carry a reason.';

comment on column public.agency_transaction_audit_log.action is
  'Phase 4A. reference_corrected is a metadata correction and posts no journal (correction C6); reverse is the financial path and always does. Keeping them as separate actions is what makes the two distinguishable in the trail.';


-- --- Immutability ---------------------------------------------------------

create trigger agency_transaction_audit_log_reject_update
  before update on public.agency_transaction_audit_log
  for each statement
  execute function public.reject_mutation();

create trigger agency_transaction_audit_log_reject_delete
  before delete on public.agency_transaction_audit_log
  for each statement
  execute function public.reject_mutation();

create trigger agency_transaction_audit_log_reject_truncate
  before truncate on public.agency_transaction_audit_log
  for each statement
  execute function public.reject_mutation();


-- --- Row-level security ---------------------------------------------------
--
-- Readable with `agency:reports`, and only for a transaction the reader's
-- branch can see — the trail must not become a side channel onto another
-- branch's till activity.

alter table public.agency_transaction_audit_log enable row level security;

revoke all on table public.agency_transaction_audit_log from anon, authenticated;
revoke update, delete, truncate on table public.agency_transaction_audit_log
  from anon, authenticated, service_role;

grant select on table public.agency_transaction_audit_log to authenticated;

create policy agency_transaction_audit_log_select_with_permission
  on public.agency_transaction_audit_log for select to authenticated
  using (
    (select public.user_has_permission('agency:reports'))
    and exists (
      select 1 from public.agency_transactions t
      where t.id = agency_transaction_audit_log.transaction_id
        and (
          (select public.current_user_branch_id()) is null
          or t.branch_id = (select public.current_user_branch_id())
        )
    )
  );


-- --- Indexes --------------------------------------------------------------

create index agency_transaction_audit_transaction_idx
  on public.agency_transaction_audit_log (transaction_id, created_at);

create index agency_transaction_audit_actor_idx
  on public.agency_transaction_audit_log (actor_id, created_at desc);
