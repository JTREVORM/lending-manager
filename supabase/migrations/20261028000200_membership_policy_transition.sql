-- ===========================================================================
-- Polytos business-policy update — moving members onto a new policy version
-- without rewriting what they were held to before
-- ===========================================================================
--
-- ## The problem this exists for
--
-- `memberships.policy_version_id` and `savings_accounts.policy_version_id` are
-- each frozen when the row is created, and every engine in the system reads
-- them: `member_savings_qualification` reads the **account's** version to find
-- the monthly minimum and the qualifying-month rule;
-- `member_loan_eligibility_of` reads the **membership's** version for the
-- multiplier; `benefit_claim_eligibility` reads the **claim's**.
--
-- That freeze is why publishing a new version is safe today — nobody moves, so
-- nothing changes — and it is also why a new version does nothing. The client
-- has now answered the questions that hold savings, lending and two of the
-- three benefits shut, and those answers are worth nothing to a member whose
-- account still points at the version that left them open.
--
-- Rewriting the frozen column is not the answer. It would mean:
--
--   - a member who qualified yesterday can stop qualifying today, because the
--     new version's monthly minimum or consecutive-months rule reaches back
--     over every month they ever saved;
--   - the policy under which a historical deposit was accepted is gone, and
--     with it the ability to say what the rule was when it happened;
--   - a member is bound to terms they were never shown.
--
-- ## The shape of the answer
--
-- A membership now has **two** policy facts rather than one:
--
--   - its **original** version — `memberships.policy_version_id`, untouched,
--     the terms it was enrolled under;
--   - its **governing** version as of a date — the assignment history below,
--     falling back to the original when there is none.
--
-- `membership_policy_assignments` is append-only and dated. The governing
-- version on a date is the latest assignment effective on or before it. A
-- member who moves from 1.0 to 2.0 on 1 December is judged under 1.0 for
-- November and under 2.0 for December, and **both answers stay available
-- forever**. Nothing is overwritten, so nothing is lost.
--
-- Savings accounts are not assigned separately. An account belongs to a
-- membership, the membership is what the business signs terms with, and two
-- accounts of one member governed by different policies would be a state
-- nobody could explain. `savings_account_governing_policy` resolves through
-- the membership, and never moves an account earlier than its own frozen
-- version — an account opened in October is on October's terms in October
-- however the membership moves in December.
--
-- ## Consent
--
-- `membership_terms_acceptances` already exists, already carries a consent
-- method, a signature, a witness and a verification status, and is already
-- unique on (membership, policy version). It is the record of a member being
-- shown terms and agreeing to them, which is exactly what a transition needs,
-- so this migration **reuses it** rather than inventing a second consent
-- table. `transition_membership_to_policy` refuses without one.
--
-- That is a deliberate reading of "record new policy acceptance **where
-- required**": acceptance is required for every transition. A policy version
-- is a set of contractual terms; there is no such thing as moving somebody
-- onto new terms they have not accepted, and a flag that let an operator skip
-- it would be the one that got used.
--
-- ## Safety properties, and where each is enforced
--
--  1. New version without mutating old terms   — nothing here updates a
--     policy version at all; the freeze guards are untouched.
--  2. Memberships preserved                    — no row is deleted or
--     renumbered; the transition only inserts.
--  3. Savings account identities preserved     — `savings_accounts` is not
--     written to by anything in this file.
--  4. Historical transactions preserved        — likewise.
--  5. Current balances preserved               — no ledger posting anywhere
--     in this migration.
--  6. Historical policy preserved              — the assignment history is
--     dated and append-only, and the resolver answers "as of".
--  7. Acceptance recorded                      — refusal without it.
--  8. Consent evidence preserved               — the existing acceptance
--     table, with its signature and witness columns.
--  9. No silent re-qualification               — the qualification engine
--     reads the governing policy **for the month being judged**, so a month
--     saved under the old minimum is judged against the old minimum.
-- 10. Preview before transition                — `preview_membership_policy_
--     transition`, read-only, qualification before and after.
-- 11. Audited                                  — a transition row per batch,
--     an assignment row per member, both carrying who and when.
-- 12. Controlled effective date                — `effective_on` on the batch;
--     the target version's own `effective_from` must have arrived.
-- 13. No double processing                     — unique (transition,
--     membership) and unique (membership, version, effective_from).
-- 14. Interrupted and retried safely           — one member per transaction,
--     every step an upsert-or-skip, and a half-finished batch is resumed by
--     calling the same function again.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The batch
-- ---------------------------------------------------------------------------

create table public.membership_policy_transitions (
  id                    uuid primary key default gen_random_uuid(),
  transition_number     text not null,

  from_version_id       uuid references public.membership_policy_versions(id)
                          on delete restrict,
  to_version_id         uuid not null
                          references public.membership_policy_versions(id)
                          on delete restrict,
  to_version            text not null,

  -- The day the new terms begin to govern. Separate from the version's own
  -- `effective_from`, because a version may be in force for new enrolments
  -- well before the business works through the existing book.
  effective_on          date not null,

  status                text not null default 'previewed',

  -- What the preview found, recorded on the batch so that what was decided
  -- against is on the record rather than recomputed later against a book that
  -- has moved.
  previewed_memberships integer not null default 0,
  previewed_accounts    integer not null default 0,
  previewed_qualified_before integer not null default 0,
  previewed_qualified_after  integer not null default 0,

  transitioned_count    integer not null default 0,

  note                  text,

  requested_by          uuid references public.profiles(id) on delete set null,
  requested_by_label    text not null,
  started_at            timestamptz not null default now(),
  completed_at          timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint membership_policy_transition_status_valid
    check (status in ('previewed', 'in_progress', 'completed', 'abandoned')),
  constraint membership_policy_transition_moves_somewhere
    check (from_version_id is distinct from to_version_id),
  constraint membership_policy_transition_completion_coherent
    check ((status = 'completed') = (completed_at is not null)),
  constraint membership_policy_transition_note_length
    check (note is null or char_length(note) <= 4000),
  constraint membership_policy_transition_counts_sane
    check (
      previewed_memberships >= 0 and previewed_accounts >= 0
      and previewed_qualified_before >= 0 and previewed_qualified_after >= 0
      and transitioned_count >= 0
    )
);

comment on table public.membership_policy_transitions is
  'Polytos policy update. One row per controlled move of the existing book onto a new policy version: the target, the day the new terms begin to govern, what the preview found, and how many memberships have been moved so far. A batch is resumable — an interrupted run is continued by calling transition_membership_to_policy again for the members it had not reached.';

comment on column public.membership_policy_transitions.effective_on is
  'The day the new terms begin to govern the memberships in this batch. Distinct from the version''s own effective_from: a version can be in force for new enrolments long before the business has worked through the existing book, and a member''s terms change on the day they accepted them rather than on the day the version was published.';

create unique index membership_policy_transition_number_unique
  on public.membership_policy_transitions (transition_number);

-- One live batch per target version. A second preview against the same target
-- while one is still running would produce two batches whose per-member
-- functions raced over the same assignments.
create unique index membership_policy_transition_one_live_per_target
  on public.membership_policy_transitions (to_version_id)
  where status in ('previewed', 'in_progress');

create index membership_policy_transition_status_idx
  on public.membership_policy_transitions (status, started_at desc);

create trigger membership_policy_transitions_set_updated_at
  before update on public.membership_policy_transitions
  for each row execute function public.set_updated_at();

insert into public.reference_formats (scope, prefix, padding, description)
values ('membership_policy_transition', 'PT', 4,
        'A controlled move of the existing book onto a new membership policy version.')
on conflict (scope) do nothing;

create or replace function public.membership_policy_transitions_assign_number()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.transition_number := public.next_reference('membership_policy_transition');
  return new;
end;
$$;

create trigger membership_policy_transitions_assign_number
  before insert on public.membership_policy_transitions
  for each row execute function public.membership_policy_transitions_assign_number();

-- ---------------------------------------------------------------------------
-- The assignment history
-- ---------------------------------------------------------------------------

create table public.membership_policy_assignments (
  id                 uuid primary key default gen_random_uuid(),
  membership_id      uuid not null references public.memberships(id)
                       on delete restrict,
  policy_version_id  uuid not null
                       references public.membership_policy_versions(id)
                       on delete restrict,
  policy_version     text not null,

  -- The first day this version governs the membership. Dates, not instants:
  -- a qualifying month is a calendar month in Africa/Kampala and a governing
  -- policy that changed halfway through an afternoon would make the month it
  -- changed in unanswerable.
  effective_from     date not null,

  -- The version it replaced, for reading the history without a window
  -- function. NULL on the first assignment after enrolment.
  previous_version_id uuid references public.membership_policy_versions(id)
                       on delete restrict,

  transition_id      uuid references public.membership_policy_transitions(id)
                       on delete restrict,
  acceptance_id      uuid references public.membership_terms_acceptances(id)
                       on delete restrict,

  reason             text not null,

  assigned_by        uuid references public.profiles(id) on delete set null,
  assigned_by_label  text not null,
  created_at         timestamptz not null default now(),

  constraint membership_policy_assignment_reason_length
    check (char_length(btrim(reason)) between 3 and 1000),
  constraint membership_policy_assignment_moves_somewhere
    check (previous_version_id is distinct from policy_version_id)
);

comment on table public.membership_policy_assignments is
  'Polytos policy update. Append-only, dated history of which policy version governs a membership. The governing version on a date is the latest assignment effective on or before it, falling back to memberships.policy_version_id — the version the member was enrolled under, which is never rewritten. Two facts rather than one: what they joined on, and what governs them now.';

comment on column public.membership_policy_assignments.acceptance_id is
  'The member''s acceptance of these terms. NOT NULL in practice — transition_membership_to_policy refuses without one — and nullable in the schema only so that a future administrative correction can be recorded with its own reason rather than by forging a consent.';

create unique index membership_policy_assignment_one_per_day
  on public.membership_policy_assignments
     (membership_id, policy_version_id, effective_from);

-- Requirement 13, as a constraint rather than as a check in code: a batch
-- cannot process the same membership twice.
create unique index membership_policy_assignment_once_per_transition
  on public.membership_policy_assignments (transition_id, membership_id)
  where transition_id is not null;

create index membership_policy_assignment_lookup_idx
  on public.membership_policy_assignments
     (membership_id, effective_from desc, created_at desc);

create index membership_policy_assignment_transition_idx
  on public.membership_policy_assignments (transition_id);

-- Append-only. A governing-policy history that could be edited would be a
-- history of nothing: the whole point is that the answer to "what governed
-- this member in November" cannot be changed in December.
create trigger membership_policy_assignments_no_update
  before update on public.membership_policy_assignments
  for each row execute function public.reject_mutation();

create trigger membership_policy_assignments_no_delete
  before delete on public.membership_policy_assignments
  for each row execute function public.reject_mutation();

-- ---------------------------------------------------------------------------
-- Resolving the governing policy
-- ---------------------------------------------------------------------------

create or replace function public.membership_governing_policy(
  p_membership_id uuid,
  p_as_of date default null
)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (
      select a.policy_version_id
      from public.membership_policy_assignments a
      where a.membership_id = p_membership_id
        and a.effective_from <= coalesce(p_as_of, public.business_date())
      order by a.effective_from desc, a.created_at desc
      limit 1
    ),
    (
      select m.policy_version_id
      from public.memberships m
      where m.id = p_membership_id
    )
  );
$$;

comment on function public.membership_governing_policy(uuid, date) is
  'Polytos policy update. Which policy version governs a membership on a date: the latest assignment effective on or before it, else the version the member was enrolled under. Answering "as of" is the whole point — a month saved under the old minimum is judged against the old minimum.';

grant execute on function public.membership_governing_policy(uuid, date) to authenticated;

create or replace function public.savings_account_governing_policy(
  p_savings_account_id uuid,
  p_as_of date default null
)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_account public.savings_accounts;
  v_governing uuid;
  v_as_of date;
begin
  select * into v_account
  from public.savings_accounts where id = p_savings_account_id;

  if not found then
    return null;
  end if;

  v_as_of := coalesce(p_as_of, public.business_date());

  -- Before the account existed, and on the day it opened, the account's own
  -- frozen version is the answer whatever the membership has done since. An
  -- account opened in October is on October's terms in October.
  if v_as_of < v_account.opened_on then
    return v_account.policy_version_id;
  end if;

  select a.policy_version_id into v_governing
  from public.membership_policy_assignments a
  where a.membership_id = v_account.membership_id
    and a.effective_from <= v_as_of
    -- An assignment that predates the account does not reach back into it:
    -- the account was opened under its own version and that is the earliest
    -- thing governing it.
    and a.effective_from >= v_account.opened_on
  order by a.effective_from desc, a.created_at desc
  limit 1;

  return coalesce(v_governing, v_account.policy_version_id);
end;
$$;

comment on function public.savings_account_governing_policy(uuid, date) is
  'Polytos policy update. Which policy version governs a savings account on a date. Resolved through the membership — an account belongs to one, and two accounts of one member on different policies would be a state nobody could explain — but never earlier than the account''s own frozen version, so a transition cannot reach back over months saved before the account existed.';

grant execute on function public.savings_account_governing_policy(uuid, date) to authenticated;

-- ---------------------------------------------------------------------------
-- The preview
-- ---------------------------------------------------------------------------

create or replace function public.preview_membership_policy_transition(
  p_to_version_id uuid,
  p_effective_on date default null
)
returns table (
  membership_id        uuid,
  membership_number    text,
  member_name          text,
  branch_name          text,
  membership_status    text,
  current_version_id   uuid,
  current_version      text,
  savings_account_count integer,
  savings_balance      bigint,
  qualifies_before     boolean,
  qualifies_after      boolean,
  qualifying_months_before integer,
  qualifying_months_after  integer,
  has_acceptance       boolean,
  already_transitioned boolean,
  advisory             text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_target   public.membership_policy_versions;
  v_as_of    date;
begin
  if auth.uid() is not null
     and not public.user_has_permission('membership_policy:manage') then
    raise exception
      'Previewing a policy transition requires the membership_policy:manage capability.'
      using errcode = '42501';
  end if;

  select * into v_target
  from public.membership_policy_versions where id = p_to_version_id;

  if not found then
    raise exception 'No such policy version.' using errcode = 'P0001';
  end if;

  v_as_of := coalesce(p_effective_on, public.business_date());

  return query
  with members as (
    select m.id, m.membership_number, c.full_name, b.name as branch_name,
           m.status,
           public.membership_governing_policy(m.id, v_as_of) as current_version_id
    from public.memberships m
    join public.clients c on c.id = m.client_id
    left join public.branches b on b.id = m.branch_id
    where m.status in ('active', 'suspended')
  ),
  accounts as (
    select s.membership_id,
           pg_catalog.count(*)::integer as account_count,
           coalesce(pg_catalog.sum(
             (select coalesce(pg_catalog.sum(t.signed_amount), 0)
                from public.savings_transactions t
               where t.savings_account_id = s.id
                 and t.value_date <= v_as_of)
           ), 0)::bigint as balance,
           -- One qualification answer per member, taken from the account that
           -- is furthest along. A member with two accounts qualifies on the
           -- strength of the better one, which is what the engine does.
           pg_catalog.max(q.qualifying_months)::integer as months_before,
           bool_or(q.qualifies) as qualifies_before
    from public.savings_accounts s
    cross join lateral public.member_savings_qualification(s.id, v_as_of) q
    where s.status = 'active'
    group by s.membership_id
  )
  select
    mm.id,
    mm.membership_number,
    mm.full_name,
    mm.branch_name,
    mm.status,
    mm.current_version_id,
    (select v.version from public.membership_policy_versions v
      where v.id = mm.current_version_id),
    coalesce(a.account_count, 0),
    coalesce(a.balance, 0),
    coalesce(a.qualifies_before, false),
    -- "After" is computed by asking the same engine the same question against
    -- the target version's rules, without writing anything. It is a
    -- projection, not a dry run: nothing is inserted and rolled back.
    coalesce(
      (select bool_or(p.qualifies)
         from public.savings_accounts s2
         cross join lateral public.savings_qualification_under_policy(
           s2.id, p_to_version_id, v_as_of) p
        where s2.membership_id = mm.id and s2.status = 'active'),
      false),
    coalesce(a.months_before, 0),
    coalesce(
      (select pg_catalog.max(p.qualifying_months)::integer
         from public.savings_accounts s2
         cross join lateral public.savings_qualification_under_policy(
           s2.id, p_to_version_id, v_as_of) p
        where s2.membership_id = mm.id and s2.status = 'active'),
      0),
    exists (
      select 1 from public.membership_terms_acceptances ta
      where ta.membership_id = mm.id and ta.policy_version_id = p_to_version_id
    ),
    exists (
      select 1 from public.membership_policy_assignments pa
      where pa.membership_id = mm.id and pa.policy_version_id = p_to_version_id
    ),
    case
      when mm.current_version_id = p_to_version_id
        then 'Already governed by this version.'
      when not exists (
        select 1 from public.membership_terms_acceptances ta
        where ta.membership_id = mm.id and ta.policy_version_id = p_to_version_id
      ) then 'No acceptance of these terms on record. The transition will refuse until the member accepts.'
      else null
    end
  from members mm
  left join accounts a on a.membership_id = mm.id
  order by mm.membership_number;
end;
$$;

comment on function public.preview_membership_policy_transition(uuid, date) is
  'Polytos policy update. What a transition onto a version would affect, before anything is written: every live membership, its accounts and balance, whether it qualifies for a member loan today and whether it would under the target version, and whether the member has accepted the new terms. Read-only — nothing is inserted and rolled back, so a preview cannot leave a partial batch behind.';

grant execute on function public.preview_membership_policy_transition(uuid, date)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Opening and closing a batch
-- ---------------------------------------------------------------------------

create or replace function public.begin_membership_policy_transition(
  p_to_version_id uuid,
  p_effective_on date,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target public.membership_policy_versions;
  v_actor  uuid;
  v_label  text;
  v_id     uuid;
  v_counts record;
begin
  v_actor := public.current_profile_id();
  v_label := public.audit_actor_label();

  if v_actor is null and auth.uid() is not null then
    raise exception
      'A policy transition must be opened by a signed-in member of staff.'
      using errcode = 'P0001';
  end if;

  if auth.uid() is not null
     and not public.user_has_permission('membership_policy:manage') then
    raise exception
      'Opening a policy transition requires the membership_policy:manage capability.'
      using errcode = '42501';
  end if;

  select * into v_target
  from public.membership_policy_versions where id = p_to_version_id;

  if not found then
    raise exception 'No such policy version.' using errcode = 'P0001';
  end if;

  -- A draft is a document being written. Moving the book onto one would bind
  -- members to figures nobody has approved.
  if v_target.approved_at is null then
    raise exception
      'Policy version % has not been approved. The book is not moved onto unapproved terms.',
      v_target.version using errcode = 'P0001';
  end if;

  if v_target.status <> 'active' then
    raise exception
      'Policy version % is %. Only the version in force governs anybody.',
      v_target.version, v_target.status using errcode = 'P0001';
  end if;

  if p_effective_on is null then
    raise exception
      'A transition needs the day the new terms begin to govern.'
      using errcode = 'P0001';
  end if;

  if p_effective_on < v_target.effective_from then
    raise exception
      'Policy version % takes effect on %, so it cannot govern anybody from %.',
      v_target.version, v_target.effective_from, p_effective_on
      using errcode = 'P0001';
  end if;

  -- Resuming rather than starting again. Requirement 14: an interrupted batch
  -- is continued, and calling this function twice returns the same batch
  -- rather than opening a second one that would race the first.
  select id into v_id
  from public.membership_policy_transitions
  where to_version_id = p_to_version_id
    and status in ('previewed', 'in_progress');

  if v_id is not null then
    return v_id;
  end if;

  select
    pg_catalog.count(*)::integer as memberships,
    coalesce(pg_catalog.sum(p.savings_account_count), 0)::integer as accounts,
    pg_catalog.count(*) filter (where p.qualifies_before)::integer as before,
    pg_catalog.count(*) filter (where p.qualifies_after)::integer as after_
  into v_counts
  from public.preview_membership_policy_transition(p_to_version_id, p_effective_on) p;

  insert into public.membership_policy_transitions (
    transition_number, from_version_id, to_version_id, to_version,
    effective_on, status,
    previewed_memberships, previewed_accounts,
    previewed_qualified_before, previewed_qualified_after,
    note, requested_by, requested_by_label
  )
  values (
    'PT000000', null, p_to_version_id, v_target.version,
    p_effective_on, 'previewed',
    v_counts.memberships, v_counts.accounts,
    v_counts.before, v_counts.after_,
    nullif(pg_catalog.btrim(coalesce(p_note, '')), ''), v_actor, v_label
  )
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.begin_membership_policy_transition(uuid, date, text) is
  'Polytos policy update. Opens a controlled transition onto an approved, in-force version and records what the preview found. Calling it again while a batch is live returns that batch rather than opening a second — an interrupted run is resumed, never restarted.';

grant execute on function public.begin_membership_policy_transition(uuid, date, text)
  to authenticated;

create or replace function public.complete_membership_policy_transition(
  p_transition_id uuid
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_transition public.membership_policy_transitions;
  v_count integer;
begin
  if auth.uid() is not null
     and not public.user_has_permission('membership_policy:manage') then
    raise exception
      'Closing a policy transition requires the membership_policy:manage capability.'
      using errcode = '42501';
  end if;

  select * into v_transition
  from public.membership_policy_transitions where id = p_transition_id for update;

  if not found then
    raise exception 'No such policy transition.' using errcode = 'P0001';
  end if;

  if v_transition.status = 'completed' then
    return v_transition.transitioned_count;
  end if;

  select pg_catalog.count(*)::integer into v_count
  from public.membership_policy_assignments
  where transition_id = p_transition_id;

  update public.membership_policy_transitions
     set status = 'completed',
         transitioned_count = v_count,
         completed_at = pg_catalog.now()
   where id = p_transition_id;

  return v_count;
end;
$$;

comment on function public.complete_membership_policy_transition(uuid) is
  'Polytos policy update. Closes a batch and records how many memberships it moved, counted from the assignment rows rather than from a running total somebody could have got wrong. Idempotent.';

grant execute on function public.complete_membership_policy_transition(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Moving one membership
-- ---------------------------------------------------------------------------
--
-- One membership per call, and therefore one per transaction. A batch that
-- moved two thousand members in a single statement would, on failing at the
-- nineteen-hundredth, roll back the first eighteen hundred — and the operator
-- would have no way of knowing which. Per-member, every call is either a move
-- or a no-op, and a crashed run is finished by running it again.

create or replace function public.transition_membership_to_policy(
  p_transition_id uuid,
  p_membership_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_transition public.membership_policy_transitions;
  v_membership public.memberships;
  v_current    uuid;
  v_acceptance public.membership_terms_acceptances;
  v_actor      uuid;
  v_label      text;
  v_existing   uuid;
  v_id         uuid;
begin
  v_actor := public.current_profile_id();
  v_label := public.audit_actor_label();

  if v_actor is null and auth.uid() is not null then
    raise exception
      'A policy transition must be carried out by a signed-in member of staff.'
      using errcode = 'P0001';
  end if;

  if auth.uid() is not null
     and not public.user_has_permission('membership_policy:manage') then
    raise exception
      'Moving a membership onto a new policy version requires the membership_policy:manage capability.'
      using errcode = '42501';
  end if;

  select * into v_transition
  from public.membership_policy_transitions where id = p_transition_id for update;

  if not found then
    raise exception 'No such policy transition.' using errcode = 'P0001';
  end if;

  if v_transition.status not in ('previewed', 'in_progress') then
    raise exception
      'Transition % is %. A closed batch moves nobody.',
      v_transition.transition_number, v_transition.status using errcode = 'P0001';
  end if;

  -- Serialise this membership against a concurrent move of the same one. The
  -- unique index would catch it anyway; the lock turns a constraint violation
  -- into an orderly no-op, which is what a resumable batch needs.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('policy_transition:' || p_membership_id::text)
  );

  select * into v_membership
  from public.memberships where id = p_membership_id;

  if not found then
    raise exception 'No such membership.' using errcode = 'P0001';
  end if;

  if not public.user_can_see_branch(v_membership.branch_id) then
    raise exception
      'You cannot move that branch''s members onto a new policy version.'
      using errcode = '42501';
  end if;

  if v_membership.status not in ('active', 'suspended') then
    raise exception
      'Membership % is %. A policy transition moves the live book; an ended membership keeps the terms it ended under.',
      v_membership.membership_number, v_membership.status using errcode = 'P0001';
  end if;

  -- Requirement 13. Already moved by this batch, or already governed by the
  -- target: return the existing assignment and write nothing.
  select id into v_existing
  from public.membership_policy_assignments
  where membership_id = p_membership_id
    and policy_version_id = v_transition.to_version_id
    and effective_from = v_transition.effective_on;

  if v_existing is not null then
    return v_existing;
  end if;

  v_current := public.membership_governing_policy(
    p_membership_id, v_transition.effective_on);

  if v_current = v_transition.to_version_id then
    raise exception
      'Membership % is already governed by version % on %.',
      v_membership.membership_number, v_transition.to_version,
      v_transition.effective_on using errcode = 'P0001';
  end if;

  -- Requirement 7 and 8. The member has to have been shown these terms and
  -- agreed to them. `membership_terms_acceptances` is the existing record of
  -- exactly that, with its signature, witness and verification status.
  select * into v_acceptance
  from public.membership_terms_acceptances
  where membership_id = p_membership_id
    and policy_version_id = v_transition.to_version_id;

  if not found or v_acceptance.verification_status <> 'verified' then
    raise exception
      'Membership % has not accepted the terms of policy version %. A member is not moved onto terms they have not agreed to.',
      v_membership.membership_number, v_transition.to_version
      using errcode = 'P0001';
  end if;

  insert into public.membership_policy_assignments (
    membership_id, policy_version_id, policy_version, effective_from,
    previous_version_id, transition_id, acceptance_id,
    reason, assigned_by, assigned_by_label
  )
  values (
    p_membership_id, v_transition.to_version_id, v_transition.to_version,
    v_transition.effective_on,
    v_current, p_transition_id, v_acceptance.id,
    'Transition ' || v_transition.transition_number || ' onto policy version '
      || v_transition.to_version,
    v_actor, v_label
  )
  returning id into v_id;

  update public.membership_policy_transitions
     set status = 'in_progress',
         transitioned_count = transitioned_count + 1
   where id = p_transition_id;

  return v_id;
end;
$$;

comment on function public.transition_membership_to_policy(uuid, uuid) is
  'Polytos policy update. Moves one membership onto the batch''s target version by appending a dated assignment, after checking that the member has accepted those terms. Writes nothing to memberships, savings_accounts or savings_transactions: the original policy, the account identities, the history and the balances are all untouched. Idempotent per membership, so an interrupted batch is finished by running it again.';

grant execute on function public.transition_membership_to_policy(uuid, uuid)
  to authenticated;


-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
--
-- PostgreSQL grants EXECUTE on a new function to PUBLIC, and a table created
-- in a schema `anon` can reach is reachable unless the grant is taken away.
-- Both defaults are wrong here: every table in this file is written only
-- through a SECURITY DEFINER function, and every function in it decides
-- something about money or about who may read a record.
--
-- The functions a session legitimately calls are granted back to
-- `authenticated` where they are defined. Triggers, numbering helpers and
-- notification hooks are granted back to nobody: they are called by the
-- database, and a session that could call one directly would be writing a
-- row the function assumes was validated elsewhere.

revoke all on table public.membership_policy_transitions from anon, authenticated;
revoke all on table public.membership_policy_assignments from anon, authenticated;
revoke all on function public.membership_policy_transitions_assign_number() from public, anon, authenticated;
revoke all on function public.membership_governing_policy(uuid, date) from public, anon;
revoke all on function public.savings_account_governing_policy(uuid, date) from public, anon;
revoke all on function public.preview_membership_policy_transition(uuid, date) from public, anon;
revoke all on function public.begin_membership_policy_transition(uuid, date, text) from public, anon;
revoke all on function public.complete_membership_policy_transition(uuid) from public, anon;
revoke all on function public.transition_membership_to_policy(uuid, uuid) from public, anon;
