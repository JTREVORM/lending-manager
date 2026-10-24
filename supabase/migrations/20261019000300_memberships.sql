-- ===========================================================================
-- Polytos Phase 1.3 — the membership record
--
-- ## Membership hangs off the client, it does not replace it
--
-- There is exactly one identity table for the people this business deals
-- with, and it is `public.clients`. A member is a client with a membership;
-- a non-member is a client without one. This table therefore carries no
-- name, no phone number, no date of birth and no National Identification
-- Number — every one of those already exists one join away, behind policies
-- that were written for them.
--
-- The alternative, a `members` table with its own identity columns, was
-- rejected for the reason stated at the head of `20261003000200_clients.sql`:
-- a second identity record for the same person is how a register comes to
-- hold two of somebody with different phone numbers. It would also mean the
-- NIN protection built into `client_identities` had to be built again, and
-- the second copy would be the one that leaked.
--
-- ## One live membership per client, enforced structurally
--
-- "One client record may have one active membership" is a uniqueness rule,
-- so it is a unique index — not a check in a Server Action, which two
-- concurrent enrolments would both pass.
--
-- The index is partial over the *live* statuses: pending, active and
-- suspended. A pending application and an active membership both occupy the
-- slot, because the business should not be able to take a second application
-- from somebody who already has one outstanding. `withdrawn` and `deceased`
-- are terminal and historical, and a client who withdrew in 2026 and rejoins
-- in 2028 is a legitimate second row — which is the whole reason the rule is
-- partial rather than a unique constraint on `client_id`.
--
-- ## The lifecycle
--
--   pending    An application has been taken. Nothing has been paid, nothing
--              has been promised. The registration fee receipt and the terms
--              acceptance are what move it on, and both arrive in Polytos
--              Phase 2.
--   active     A member in good standing. Savings accrue, benefits apply.
--   suspended  Membership restricted by a decision of the business, with a
--              reason. Still a member; still referenced by history.
--   withdrawn  The member left, or the business ended the membership.
--              Terminal.
--   deceased   Terminal, and distinct from withdrawn because it is the state
--              in which the bereavement benefit becomes payable to the
--              registered next of kin. Collapsing the two would make that
--              benefit unanswerable from the record.
--
-- Transitions, who may make them, and what each needs are enforced by
-- `memberships_guard_transition` below and documented in
-- docs/POLYTOS-MEMBERSHIP-SCHEMA.md.
--
-- ## No savings, no balances, no fees
--
-- Deliberately absent: `savings_balance`, `total_saved`, `months_qualified`,
-- `registration_fee_paid`. Every one of them would be a financial figure in
-- a table nothing posts to, which is the mistake `loan_schedules` avoided in
-- Phase 5 by refusing to carry an `amount_paid` of zero. Polytos Phase 2 owns
-- savings, and it will own them in its own tables so that this row never has
-- to be rewritten when money moves.
-- ===========================================================================

create table public.memberships (
  id uuid primary key default gen_random_uuid(),

  -- Minted by `next_reference('membership')` in a BEFORE INSERT trigger,
  -- never supplied by a caller. Immutable thereafter: it goes on a card.
  membership_number text not null unique,

  -- The client this membership belongs to. RESTRICT, not CASCADE: a client
  -- is archived rather than deleted, and a membership must not be able to
  -- vanish because somebody removed a client row.
  client_id uuid not null references public.clients(id) on delete restrict,

  -- Where the relationship is held. Stamped from the client by a trigger,
  -- exactly as `loans.branch_id` is, so the branch visibility rule that
  -- already applies to clients and loans applies here too.
  branch_id uuid not null references public.branches(id) on delete restrict,

  -- The rules this member was enrolled under. RESTRICT, and the version's
  -- figures are frozen once referenced — see 20261019000200.
  policy_version_id uuid not null
    references public.membership_policy_versions(id) on delete restrict,

  status text not null default 'pending',
  -- Why. Required for suspended and withdrawn; the full history of every
  -- change is in `membership_status_history`, which is append-only.
  status_reason text,
  status_changed_at timestamptz,
  status_changed_by uuid references public.profiles(id) on delete set null,

  -- The day the application was taken. A calendar date in the business
  -- timezone, because membership obligations are monthly and a timestamp
  -- would make "which month did they join in" a timezone question.
  applied_on date not null,
  -- The day membership began. NULL while pending.
  activated_on date,
  -- The day it ended, for a withdrawn or deceased membership.
  ended_on date,

  -- Operational free text on the record itself, the same role `clients.notes`
  -- plays. Attributed commentary belongs on the client's remarks.
  notes text,

  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),

  constraint memberships_number_shape
    check (membership_number ~ '^MB[0-9]{5,}$'),

  constraint memberships_status_valid
    check (status in ('pending', 'active', 'suspended', 'withdrawn', 'deceased')),

  -- A restriction the business chose must say why, the same rule
  -- `clients_restricted_status_has_reason` states. Deceased is excluded: the
  -- reason is the status.
  constraint memberships_restricted_status_has_reason
    check (
      status not in ('suspended', 'withdrawn')
      or (status_reason is not null and btrim(status_reason) <> '')
    ),
  constraint memberships_status_reason_length
    check (status_reason is null or char_length(status_reason) <= 500),
  constraint memberships_notes_length
    check (notes is null or char_length(notes) <= 2000),

  -- The dates and the status cannot drift apart.
  constraint memberships_pending_has_no_dates
    check (status <> 'pending' or (activated_on is null and ended_on is null)),
  constraint memberships_live_is_activated
    check (
      status not in ('active', 'suspended')
      or (activated_on is not null and ended_on is null)
    ),
  -- A membership that ended says when. It may never have been activated — an
  -- application withdrawn before activation is a real and ordinary case — so
  -- `activated_on` is not required here.
  constraint memberships_ended_has_end_date
    check (status not in ('withdrawn', 'deceased') or ended_on is not null),

  constraint memberships_activated_after_applied
    check (activated_on is null or activated_on >= applied_on),
  constraint memberships_ended_after_applied
    check (ended_on is null or ended_on >= applied_on),
  constraint memberships_ended_after_activated
    check (ended_on is null or activated_on is null or ended_on >= activated_on),

  -- A mistyped year. The upper bound tolerates a day either side of the
  -- business date, the way the client date-of-birth bounds do, so a clock
  -- skew at midnight in Kampala does not refuse a legitimate enrolment.
  constraint memberships_applied_on_plausible
    check (
      applied_on >= '2020-01-01'::date
      and applied_on
          <= ((pg_catalog.now() at time zone 'Africa/Kampala')::date + 1)
    )
);

comment on table public.memberships is
  'Polytos Phase 1. A client''s membership of the Polytos savings and benefits programme. Carries no identity data: the member is the client it references. One live membership per client, enforced by a partial unique index.';
comment on column public.memberships.membership_number is
  'Business reference, e.g. MB260001. Minted atomically by next_reference(); immutable, because it is printed on a membership card.';
comment on column public.memberships.policy_version_id is
  'The membership policy version this member was enrolled under. The version''s figures are frozen once referenced, so changing the programme cannot vary an existing member''s terms.';
comment on column public.memberships.status is
  'pending: applied, not yet enrolled. active: in good standing. suspended: restricted by decision, reason required. withdrawn: ended, reason required. deceased: ended by death, the state in which the bereavement benefit becomes payable.';

-- ---------------------------------------------------------------------------
-- One live membership per client
--
-- The rule the brief states, as the only mechanism that holds under
-- concurrency. A frontend check and a Server Action check both lose the race
-- that this index wins.
-- ---------------------------------------------------------------------------
create unique index memberships_one_live_per_client
  on public.memberships (client_id)
  where status in ('pending', 'active', 'suspended');

comment on index public.memberships_one_live_per_client is
  'One live membership per client. Partial over pending/active/suspended, so a client who withdrew and later rejoins keeps both rows and the history stays intact.';

-- The register: filter by status, newest application first.
create index memberships_status_idx on public.memberships (status);
create index memberships_applied_on_idx on public.memberships (applied_on desc);
create index memberships_branch_idx on public.memberships (branch_id);
-- "Is this client a member", which the client profile asks on every view.
create index memberships_client_idx on public.memberships (client_id);
create index memberships_policy_version_idx on public.memberships (policy_version_id);

create trigger memberships_set_updated_at
  before update on public.memberships
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Membership numbering
--
-- Minted in a BEFORE INSERT trigger rather than by the application, for the
-- two reasons `clients_assign_client_number` gives: the number cannot then be
-- supplied by a caller, and there is no window in which a membership exists
-- without one. `next_reference()` is the atomic generator proven gapless
-- under 60-way concurrency in Phase 1 of the lending system.
-- ---------------------------------------------------------------------------

create or replace function public.memberships_assign_number()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Refused rather than silently replaced: silently replacing it would hide a
  -- caller that believes it is choosing the number.
  if new.membership_number is not null then
    raise exception
      'A membership number is assigned by the database, not by the caller.'
      using errcode = 'P0001';
  end if;

  new.membership_number := public.next_reference('membership');
  return new;
end;
$$;

comment on function public.memberships_assign_number() is
  'BEFORE INSERT on memberships: mints the membership number atomically via next_reference(), and refuses a caller-supplied one.';

create trigger memberships_assign_number
  before insert on public.memberships
  for each row execute function public.memberships_assign_number();

-- ---------------------------------------------------------------------------
-- Provenance, the branch and the governing policy, on insert
--
-- Three things the caller does not get to choose. `created_by` comes from the
-- session, so "who enrolled this member" cannot be attributed to somebody
-- else. The branch comes from the client, because a membership is held where
-- the relationship is. The policy version is whichever is in force.
--
-- ## Derived always, not merely defaulted
--
-- The first draft of this trigger filled the branch and the policy version
-- in **when they arrived NULL**, which is a default rather than a rule. A
-- caller with `membership:create` and a copy of curl supplies them, and a
-- supplied value went through untouched: a member enrolled into a branch
-- they have no relationship with, or under a draft nobody approved, a
-- superseded version, or one that does not begin until next year. The RLS
-- policy did not close it either — it scopes a branch-assigned profile to
-- their own branch, and every profile in this system is unassigned, so the
-- clause was vacuously true.
--
-- So both are derived on every insert, and a value that disagrees with the
-- derivation is **refused** rather than silently corrected — the same choice
-- `memberships_assign_number` makes about a supplied membership number, and
-- for the same reason: silently correcting it hides a caller that believes
-- it is choosing.
--
-- These rules are stated before any trusted-path exemption, so they bind
-- `service_role` and the table owner too. What a membership *is* does not
-- depend on which key opened the connection.
-- ---------------------------------------------------------------------------

create or replace function public.memberships_stamp_provenance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_client_branch uuid;
  v_active_policy uuid;
begin
  new.created_by := public.current_profile_id();

  -- --- The branch is the client's ----------------------------------------

  select c.branch_id into v_client_branch
  from public.clients c where c.id = new.client_id;

  if v_client_branch is null then
    select b.id into v_client_branch
    from public.branches b
    where b.status = 'active'
    order by b.branch_code
    limit 1;
  end if;

  if v_client_branch is null then
    raise exception
      'A membership is held at a branch, and the business has no active branch to hold this one at.'
      using errcode = 'P0001';
  end if;

  if new.branch_id is not null and new.branch_id <> v_client_branch then
    raise exception
      'A membership is held at the client''s own branch. Move the client to the other branch first if that is what was meant.'
      using errcode = 'P0001';
  end if;

  new.branch_id := v_client_branch;

  -- --- The terms are the ones in force -----------------------------------

  v_active_policy := public.active_membership_policy_id();

  if v_active_policy is null then
    raise exception
      'No membership policy version is in force. Approve and activate one, on or before today, before enrolling a member.'
      using errcode = 'P0001';
  end if;

  if new.policy_version_id is not null
     and new.policy_version_id <> v_active_policy then
    raise exception
      'A member is enrolled under the membership policy version in force, not under a draft, a superseded version, or one that has not started.'
      using errcode = 'P0001';
  end if;

  if not public.membership_policy_allows(v_active_policy, 'enrolment') then
    raise exception
      'The membership policy version in force does not open enrolment.'
      using errcode = 'P0001';
  end if;

  new.policy_version_id := v_active_policy;

  -- A membership arrives pending. Enrolling somebody straight into `active`
  -- would skip the registration fee and the terms acceptance that Polytos
  -- Phase 2 makes the preconditions of activation, and would leave no
  -- `pending -> active` row in the history for anybody to audit.
  if new.status <> 'pending' then
    raise exception
      'A membership is created pending and activated afterwards, so the activation is recorded.'
      using errcode = 'P0001';
  end if;

  -- Status attribution on the opening row is the creation itself.
  new.status_changed_at := pg_catalog.now();
  new.status_changed_by := new.created_by;

  return new;
end;
$$;

comment on function public.memberships_stamp_provenance() is
  'BEFORE INSERT on memberships: derives created_by from the session, the branch from the client and the policy version from the one in force on the business date — always, refusing a supplied value that disagrees rather than defaulting around it. Refuses a membership created in any status but pending, and one opened when no version is in force. Binds every caller, service_role included.';

create trigger memberships_stamp_provenance
  before insert on public.memberships
  for each row execute function public.memberships_stamp_provenance();

-- ---------------------------------------------------------------------------
-- The lifecycle, and per-column authorization
--
-- One trigger, in the shape `clients_guard_privileged_columns` established:
-- rules that bind every caller — including `service_role` and the table
-- owner — are stated **before** the trusted-path exemption, because a rule
-- placed after it is a rule a leaked secret key can skip.
--
-- Valid transitions:
--
--   pending   -> active, withdrawn, deceased
--   active    -> suspended, withdrawn, deceased
--   suspended -> active, withdrawn, deceased
--   withdrawn -> (nothing; terminal)
--   deceased  -> (nothing; terminal)
--
-- Reactivating a withdrawn membership is not a transition. It is a new
-- enrolment, which mints a new number and a new row, because the savings
-- qualification clock and the benefit waiting period both restart and a
-- reused row could not express that.
-- ---------------------------------------------------------------------------

create or replace function public.memberships_guard_transition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_allowed text[];
begin
  -- --- Binding on everyone -----------------------------------------------

  if new.membership_number is distinct from old.membership_number then
    raise exception 'A membership number cannot be changed once issued.'
      using errcode = 'P0001';
  end if;

  if new.client_id is distinct from old.client_id then
    raise exception
      'A membership belongs to the client it was opened for. Withdraw it and enrol the other client.'
      using errcode = 'P0001';
  end if;

  -- The branch follows the client, on an update as on an insert. A
  -- membership moved to a branch the client has no relationship with would
  -- put the row outside the branch rule that decides who may read it.
  if new.branch_id is distinct from old.branch_id
     and new.branch_id is distinct from (
       select c.branch_id from public.clients c where c.id = old.client_id
     ) then
    raise exception
      'A membership is held at the client''s own branch. Move the client, and the membership follows.'
      using errcode = 'P0001';
  end if;

  -- A member's terms move only through a recorded re-acceptance.
  --
  -- The version a member is held to is the contract they signed, so a plain
  -- UPDATE of this column is refused — but "never" was the wrong rule. The
  -- business will publish version 1.1, and the law and the programme both
  -- allow existing members to be asked to accept it. What that needs is
  -- evidence, not an open column. So the change is permitted on three
  -- conditions, each checked independently:
  --
  --   * it arrived through `accept_membership_policy_version()`, which sets
  --     the transaction-local marker this reads;
  --   * the member's acceptance of the new version is already recorded in
  --     `membership_terms_acceptances`; and
  --   * the new version is itself approved and in force today.
  --
  -- The marker alone would be a weak boundary — it is a routing flag, not a
  -- permission — which is why the other two are asserted here rather than
  -- trusted to the function that set it.
  if new.policy_version_id is distinct from old.policy_version_id then
    if coalesce(
         pg_catalog.current_setting('app.membership_policy_reacceptance', true), ''
       ) <> old.id::text then
      raise exception
        'A member is held to the policy version they were enrolled under. Record a re-acceptance with accept_membership_policy_version() to move them onto new terms.'
        using errcode = 'P0001';
    end if;

    if not exists (
      select 1
      from public.membership_terms_acceptances a
      where a.membership_id = old.id
        and a.policy_version_id = new.policy_version_id
    ) then
      raise exception
        'Moving a member onto a new policy version needs their recorded acceptance of it.'
        using errcode = 'P0001';
    end if;

    if not public.membership_policy_allows(new.policy_version_id, 'enrolment') then
      raise exception
        'A member can only be moved onto a membership policy version that is approved and in force.'
        using errcode = 'P0001';
    end if;
  end if;

  -- ## Polytos Phase 2 must add two preconditions to `pending -> active`
  --
  -- This guard checks that the transition is *shaped* correctly. It does not
  -- — and in Phase 1 cannot — check that the member has actually paid and
  -- actually agreed, because neither record exists yet. Phase 2 owns both,
  -- and both belong **here**, in this trigger, before the transition is
  -- allowed:
  --
  --   1. **A posted registration fee.** Not a boolean on the membership and
  --      not a check in the Server Action: a row in `membership_fee_receipts`
  --      whose journal entry exists and is not reversed. "Successfully
  --      posted" means the ledger moved, so the test is the journal, not the
  --      receipt's own status column. A receipt reversed after activation
  --      must be visible as such — Phase 2 decides whether that suspends the
  --      membership or merely flags it, but the activation itself must never
  --      have been possible without the posting.
  --
  --   2. **A recorded terms acceptance.** A row in
  --      `membership_terms_acceptances` for this membership *and* the exact
  --      `policy_version_id` the membership carries. Not any acceptance:
  --      accepting version 1.0 does not activate somebody enrolled under 1.1.
  --
  -- Both are statements about rows in other tables, so neither can be a CHECK
  -- constraint; they are `exists (...)` tests in this function, stated above
  -- the trusted-path exemption so they bind `service_role` too. A membership
  -- that went active without a fee and without a signature is a person the
  -- business is taking savings from under terms nobody can show they agreed
  -- to, and that is not a state a Server Action should be trusted to prevent.
  --
  -- See docs/POLYTOS-SIX-PHASE-ROADMAP.md (Phase 2) and ADR-050.
  if new.status is distinct from old.status then
    v_allowed := case old.status
      when 'pending'   then array['active', 'withdrawn', 'deceased']
      when 'active'    then array['suspended', 'withdrawn', 'deceased']
      when 'suspended' then array['active', 'withdrawn', 'deceased']
      else array[]::text[]
    end;

    if not (new.status = any (v_allowed)) then
      raise exception
        'A membership cannot move from % to %.', old.status, new.status
        using errcode = 'P0001';
    end if;

    -- The date each transition needs, stamped rather than trusted. A caller
    -- that could set `activated_on` freely could backdate a savings
    -- qualification by six months.
    if new.status = 'active' and old.status = 'pending' then
      new.activated_on := coalesce(new.activated_on, public.business_date());
    end if;

    if new.status in ('withdrawn', 'deceased') then
      new.ended_on := coalesce(new.ended_on, public.business_date());
    end if;

    -- Returning from suspension does not re-open an ended membership, and
    -- nothing above can reach `active` from a terminal state, so clearing
    -- `ended_on` here is unreachable by design rather than by omission.

    new.status_changed_at := pg_catalog.now();
    new.status_changed_by := public.current_profile_id();
  end if;

  -- The lifecycle dates are set by the transitions above and nowhere else.
  if new.status is not distinct from old.status
     and (new.activated_on is distinct from old.activated_on
          or new.ended_on is distinct from old.ended_on) then
    raise exception
      'Membership dates are stamped by the transition that sets them.'
      using errcode = 'P0001';
  end if;

  -- --- The trusted server path -------------------------------------------
  -- auth.uid() is NULL for `service_role` and for the table owner — that is,
  -- for migrations, the privileged client and the test harness. The checks
  -- below are about a *session*, and there is no session to check.
  if auth.uid() is null then
    return new;
  end if;

  -- --- Binding on sessions -----------------------------------------------
  --
  -- Provenance and status attribution are checked *here* rather than above,
  -- which is where `clients_guard_privileged_columns` checks the same two
  -- things and for the same reason. `memberships.created_by` and
  -- `status_changed_by` are `ON DELETE SET NULL`, so deleting a profile
  -- blanks them — a database cascade that preserves the record, not a caller
  -- attributing somebody else's work to themselves. Refusing it above the
  -- exemption would make a profile undeletable by any route, which is a
  -- different policy than the one intended and one the schema states
  -- explicitly where it does mean it (see `membership_status_history`).

  if new.applied_on is distinct from old.applied_on
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'Membership provenance cannot be rewritten.'
      using errcode = 'P0001';
  end if;

  if new.status is not distinct from old.status
     and (new.status_changed_at is distinct from old.status_changed_at
          or new.status_changed_by is distinct from old.status_changed_by) then
    raise exception
      'Status attribution is maintained by the database, not by the caller.'
      using errcode = 'P0001';
  end if;

  if new.status is distinct from old.status then
    if not public.user_has_permission('membership:manage_status') then
      raise exception
        'Changing a membership status requires the membership:manage_status capability.'
        using errcode = 'P0001';
    end if;
  end if;

  -- Everything else on the table is an ordinary detail. Stated explicitly so
  -- that a column added later is refused until somebody decides which rule it
  -- falls under.
  if (
       new.notes is distinct from old.notes
    or new.branch_id is distinct from old.branch_id
  ) and not public.user_has_permission('membership:update') then
    raise exception
      'Changing membership details requires the membership:update capability.'
      using errcode = 'P0001';
  end if;

  -- A reason may be corrected alongside a status change by the person making
  -- it; on its own it is an ordinary detail.
  if new.status is not distinct from old.status
     and new.status_reason is distinct from old.status_reason
     and not public.user_has_permission('membership:update') then
    raise exception
      'Changing membership details requires the membership:update capability.'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

comment on function public.memberships_guard_transition() is
  'BEFORE UPDATE on memberships: enforces the lifecycle, keeps the branch following the client, permits a change of policy version only through a recorded re-acceptance onto a version in force, stamps the dates and the attribution each transition needs, and applies per-column authorization. Rules binding every caller, including service_role, are stated before the trusted-path exemption.';

create trigger memberships_guard_transition
  before update on public.memberships
  for each row execute function public.memberships_guard_transition();

-- A membership is never deleted. It is withdrawn, which is a status with a
-- date, a reason and an actor — and the savings, fees and benefits that will
-- hang off it from Polytos Phase 2 make the row financial history.
create trigger memberships_no_delete
  before delete on public.memberships
  for each statement execute function public.reject_mutation();

revoke all on function public.memberships_assign_number()
  from public, anon, authenticated;
revoke all on function public.memberships_stamp_provenance()
  from public, anon, authenticated;
revoke all on function public.memberships_guard_transition()
  from public, anon, authenticated;

-- --- Access control --------------------------------------------------------

alter table public.memberships enable row level security;
revoke all on table public.memberships from anon, authenticated;
