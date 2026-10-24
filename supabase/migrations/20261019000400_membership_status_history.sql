-- ===========================================================================
-- Polytos Phase 1.4 — the membership status history
--
-- ## Why a table and not the audit trail
--
-- `audit_log` already records every change to every membership row, and it is
-- append-only and tamper-resistant. It is also readable only with
-- `audit:view`, which is the Owner's alone, and its payload is a generic
-- jsonb diff.
--
-- The membership lifecycle needs to be readable by the people who work it:
-- a Manager asking why a member is suspended, a Secretary/Treasurer checking
-- when somebody was enrolled, and — from Polytos Phase 5 — the member
-- themselves in the portal. "Became active on 3 March, suspended on 12 June
-- for arrears, reinstated on 2 July" is a statement about the member's
-- relationship with the business, not an administrative audit record.
--
-- It is also load-bearing arithmetic. The savings qualification period counts
-- months of *active* membership, and the benefit waiting period counts from
-- activation — so Polytos Phases 2 and 4 need the transition dates as rows
-- they can join to, not as jsonb buried in a trail nobody may read.
--
-- Both exist, and neither replaces the other: this is the business history,
-- `audit_log` is the forensic one.
--
-- ## Append-only, and written only by the trigger
--
-- No UPDATE and no DELETE, by trigger and by privilege alike. And no INSERT
-- privilege for any session either: rows are written by
-- `memberships_record_status` below, firing inside the same transaction as
-- the change it records. A history a caller could write by hand would be a
-- history, not the history.
-- ===========================================================================

create table public.membership_status_history (
  -- bigint identity rather than a uuid: this is an ordered log, and the order
  -- matters more than the key being quotable.
  id bigint generated always as identity primary key,

  membership_id uuid not null references public.memberships(id) on delete restrict,

  -- NULL on the opening row, which records the enrolment itself rather than a
  -- transition out of something.
  from_status text,
  to_status text not null,

  reason text,

  -- The business date the change belongs to, in the business timezone, so a
  -- transition recorded at 23:40 UTC is filed under the Kampala day it
  -- happened on.
  effective_on date not null,

  -- RESTRICT, not SET NULL, and the distinction is not stylistic. This table
  -- refuses every UPDATE, and an `ON DELETE SET NULL` *is* an UPDATE — so a
  -- profile deletion would be refused by the append-only trigger rather than
  -- by the foreign key, with an error naming the wrong table. `notifications`
  -- holds every one of its references with RESTRICT for exactly this reason.
  --
  -- The label is what makes RESTRICT affordable: the history stays readable
  -- under the name the change was made in, so nothing is lost by refusing to
  -- blank the id.
  changed_by uuid references public.profiles(id) on delete restrict,
  changed_by_label text not null default 'system',

  occurred_at timestamptz not null default pg_catalog.now(),

  constraint membership_status_history_to_status_valid
    check (to_status in ('pending', 'active', 'suspended', 'withdrawn', 'deceased')),
  constraint membership_status_history_from_status_valid
    check (
      from_status is null
      or from_status in ('pending', 'active', 'suspended', 'withdrawn', 'deceased')
    ),
  -- A row that records no movement is noise in a log people read.
  constraint membership_status_history_is_a_change
    check (from_status is distinct from to_status),
  constraint membership_status_history_reason_length
    check (reason is null or char_length(reason) <= 500),
  constraint membership_status_history_label_not_blank
    check (btrim(changed_by_label) <> '')
);

comment on table public.membership_status_history is
  'Polytos Phase 1. Every membership status change, in the order it happened. Append-only and written only by the trigger on memberships, so the data and its history cannot disagree. Distinct from audit_log: this is the business record a Manager reads, that is the forensic one only an Owner reads.';

create index membership_status_history_membership_idx
  on public.membership_status_history (membership_id, occurred_at desc);
create index membership_status_history_effective_idx
  on public.membership_status_history (effective_on desc);

-- Two independent mechanisms, because append-only is the entire value of the
-- table: statement-level triggers, and privileges that are never granted.
create trigger membership_status_history_no_update
  before update on public.membership_status_history
  for each statement execute function public.reject_mutation();

create trigger membership_status_history_no_delete
  before delete on public.membership_status_history
  for each statement execute function public.reject_mutation();

-- ---------------------------------------------------------------------------
-- The one write path
--
-- AFTER INSERT and AFTER UPDATE OF status on `memberships`. A trigger rather
-- than a call in a Server Action, for the Phase 2 reason: a trigger fires in
-- the same transaction as the change, so a write that reaches the table by
-- any other route still records itself.
-- ---------------------------------------------------------------------------

create or replace function public.memberships_record_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.membership_status_history (
      membership_id, from_status, to_status, reason,
      effective_on, changed_by, changed_by_label
    )
    values (
      new.id, null, new.status, new.status_reason,
      new.applied_on, new.created_by, public.audit_actor_label()
    );

    return new;
  end if;

  if new.status is distinct from old.status then
    insert into public.membership_status_history (
      membership_id, from_status, to_status, reason,
      effective_on, changed_by, changed_by_label
    )
    values (
      new.id, old.status, new.status, new.status_reason,
      coalesce(
        case when new.status in ('withdrawn', 'deceased') then new.ended_on end,
        case when new.status = 'active' then new.activated_on end,
        public.business_date()
      ),
      new.status_changed_by, public.audit_actor_label()
    );
  end if;

  return new;
end;
$$;

comment on function public.memberships_record_status() is
  'AFTER INSERT/UPDATE on memberships: records the enrolment and every subsequent status change in membership_status_history, inside the same transaction as the change.';

create trigger memberships_record_status_on_insert
  after insert on public.memberships
  for each row execute function public.memberships_record_status();

create trigger memberships_record_status_on_update
  after update of status on public.memberships
  for each row execute function public.memberships_record_status();

revoke all on function public.memberships_record_status()
  from public, anon, authenticated;

alter table public.membership_status_history enable row level security;
revoke all on table public.membership_status_history from anon, authenticated;
