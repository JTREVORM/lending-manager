-- ===========================================================================
-- Polytos business-policy update — rule 12: a death certificate and three
-- other group members
-- ===========================================================================
--
-- > Required evidence: a death certificate, and confirmation by at least
-- > three other group members.
--
-- ## Why this is a table and not three text boxes
--
-- The brief is explicit — "Do not store only three manually typed names" —
-- and the reason is the whole point of the rule. Three typed names cost
-- nothing to produce. A confirmation requirement that could be satisfied by
-- the person filling in the form is not a control; it is the appearance of
-- one, which is worse than none because it stops anybody looking further.
--
-- So a confirmation is a row naming a **membership**: a real member of this
-- programme, with a membership number, who exists independently of this
-- claim. Three of them, all different, none of them the deceased.
--
-- The death certificate stays where the other evidence is —
-- `benefit_claim_documents`, with its required kinds, its two-person
-- verification and its storage-path check — because it is a document and that
-- table is what this system does with documents. Phase 4 already requires it
-- for both death-related claim types.
--
-- ## What each row carries
--
--   - **Who confirmed.** A membership id, foreign-keyed. Not a name.
--   - **What they said.** A statement, because "confirmed" without words is a
--     tick box, and a tick box is what somebody clicks without reading.
--   - **How it was taken.** In branch with a signature, as a meeting
--     resolution, or witnessed by staff. Each is a different quality of
--     evidence and the record should not pretend they are the same.
--   - **Who took it.** Staff, named and dated.
--
-- ## The rules, and where each lives
--
--   - three distinct members          → unique (claim, confirming membership)
--   - a real membership               → foreign key
--   - not the deceased                → checked in the function *and* in a
--                                       trigger, because the function is not
--                                       the only way a row could arrive
--   - a member in good standing       → active or suspended, checked in the
--                                       function
--   - cannot forge another's          → the recording staff member is stamped
--                                       from the session, never supplied
--   - cannot change after approval    → append-only, plus a trigger that
--                                       refuses a new row once the claim has
--                                       been approved or paid
--   - cannot approve until complete   → `benefit_claim_eligibility`, in the
--                                       migration that follows
--
-- ## No fabricated confirmations
--
-- Nothing here creates a confirmation. The demonstration seeder creates them
-- only in an isolated environment, under its own opt-in phrase, against
-- demonstration memberships, and the brief forbids seeding them into a hosted
-- database — which the seeder already refuses to run against.
-- ===========================================================================

create table public.benefit_death_confirmations (
  id                       uuid primary key default gen_random_uuid(),

  claim_id                 uuid not null references public.benefit_claims(id)
                             on delete restrict,
  claim_number             text not null,
  -- The membership the claim is about. Denormalised so the "not the
  -- deceased" trigger does not have to join, and so the row is readable on
  -- its own.
  subject_membership_id    uuid not null references public.memberships(id)
                             on delete restrict,

  confirming_membership_id uuid not null references public.memberships(id)
                             on delete restrict,
  confirming_membership_number text not null,

  -- What was confirmed, in the confirming member's terms. A statement rather
  -- than a flag, because a flag is what somebody ticks without reading.
  statement                text not null,
  -- How the confirming member knew the deceased, where they said. Optional:
  -- the rule asks for group members, not for relatives.
  relationship_note        text,

  confirmation_method      text not null,
  signature_name           text,
  -- A document in the private evidence bucket, where one was produced.
  evidence_path            text,

  recorded_by              uuid references public.profiles(id) on delete set null,
  recorded_by_label        text not null,
  recorded_at              timestamptz not null default now(),
  business_date            date not null,
  created_at               timestamptz not null default now(),

  constraint benefit_death_confirmation_not_the_deceased
    check (confirming_membership_id <> subject_membership_id),
  constraint benefit_death_confirmation_statement_length
    check (char_length(btrim(statement)) between 10 and 2000),
  constraint benefit_death_confirmation_relationship_length
    check (relationship_note is null
           or char_length(btrim(relationship_note)) between 2 and 200),
  constraint benefit_death_confirmation_method_valid
    check (confirmation_method in
             ('in_branch_signature', 'meeting_resolution', 'witnessed_by_staff')),
  -- A signature method with nothing signed is not a signature.
  constraint benefit_death_confirmation_signature_present
    check (confirmation_method <> 'in_branch_signature' or signature_name is not null),
  constraint benefit_death_confirmation_signature_length
    check (signature_name is null
           or char_length(btrim(signature_name)) between 2 and 120),
  -- The same storage-path shape the rest of the benefit evidence uses, so an
  -- object outside this claim's own folder cannot be cited.
  constraint benefit_death_confirmation_evidence_path_shape
    check (
      evidence_path is null
      or evidence_path ~ '^benefits/[0-9a-f-]{36}/[a-z_]+/[0-9a-f-]{36}/[0-9a-zA-Z._-]{1,120}$'
    )
);

comment on table public.benefit_death_confirmations is
  'Polytos policy update, rule 12. A confirmation of a death by another member of the programme, naming a real membership rather than a typed name. Three distinct ones, none of them the deceased, are required before a condolence or bereavement claim can be assessed. Append-only, and closed once the claim is approved.';

comment on column public.benefit_death_confirmations.statement is
  'What the confirming member actually said. A statement rather than a flag: a tick box is what somebody clicks without reading, and this is the evidence a UGX 200,000 payment rests on.';

comment on column public.benefit_death_confirmations.confirmation_method is
  'How the confirmation was taken — in branch against a signature, as a resolution of a membership meeting, or witnessed by staff. Three different qualities of evidence; the record does not pretend they are the same.';

create unique index benefit_death_confirmation_once_per_member
  on public.benefit_death_confirmations (claim_id, confirming_membership_id);

create index benefit_death_confirmation_claim_idx
  on public.benefit_death_confirmations (claim_id, recorded_at);

create index benefit_death_confirmation_member_idx
  on public.benefit_death_confirmations (confirming_membership_id);

create trigger benefit_death_confirmations_no_update
  before update on public.benefit_death_confirmations
  for each row execute function public.reject_mutation();

create trigger benefit_death_confirmations_no_delete
  before delete on public.benefit_death_confirmations
  for each row execute function public.reject_mutation();

-- ---------------------------------------------------------------------------
-- The rules that need to see the claim
-- ---------------------------------------------------------------------------
--
-- Stated as a trigger as well as inside `record_death_confirmation`, because
-- the function is not the only way a row could arrive: the table owner, a
-- future import, a `service_role` key. A control that only exists in the
-- happy path is a control that is not there.

create or replace function public.benefit_death_confirmations_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claim public.benefit_claims;
begin
  select * into v_claim from public.benefit_claims where id = new.claim_id;

  if not found then
    raise exception 'No such benefit claim.' using errcode = 'P0001';
  end if;

  if v_claim.claim_type not in ('family_condolence', 'member_bereavement') then
    raise exception
      'Claim % is a % claim. A death confirmation belongs to a death-related claim.',
      v_claim.claim_number, v_claim.claim_type using errcode = 'P0001';
  end if;

  if new.subject_membership_id is distinct from v_claim.membership_id then
    raise exception
      'A death confirmation must name the membership its claim is about.'
      using errcode = 'P0001';
  end if;

  if new.claim_number is distinct from v_claim.claim_number then
    raise exception 'A death confirmation cannot be filed under another claim''s number.'
      using errcode = 'P0001';
  end if;

  -- Closed once the money has been authorised. "Cannot change confirmation
  -- evidence after financial approval" is the brief's wording, and adding a
  -- fourth confirmation after an approval would change the evidence the
  -- approval rested on just as surely as editing one would.
  if v_claim.status in ('approved', 'paid') then
    raise exception
      'Claim % has been %. The confirmations an approval rested on are closed; a correction is a reversal with a reason, not a new confirmation.',
      v_claim.claim_number, v_claim.status using errcode = 'P0001';
  end if;

  return new;
end;
$$;

comment on function public.benefit_death_confirmations_guard() is
  'Polytos policy update. The rules a death confirmation must satisfy that need the claim in view: the claim is death-related, the subject is its own membership, and nothing is added once the claim has been approved or paid. Stated here as well as in record_death_confirmation, because the function is not the only way a row could arrive.';

create trigger benefit_death_confirmations_guard
  before insert on public.benefit_death_confirmations
  for each row execute function public.benefit_death_confirmations_guard();

-- ---------------------------------------------------------------------------
-- Recording one
-- ---------------------------------------------------------------------------

create or replace function public.record_death_confirmation(
  p_claim_id uuid,
  p_confirming_membership_id uuid,
  p_statement text,
  p_confirmation_method text,
  p_signature_name text default null,
  p_evidence_path text default null,
  p_relationship_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claim      public.benefit_claims;
  v_confirmer  public.memberships;
  v_actor      uuid;
  v_label      text;
  v_id         uuid;
begin
  v_actor := public.current_profile_id();
  v_label := public.audit_actor_label();

  if v_actor is null and auth.uid() is not null then
    raise exception
      'A death confirmation must be taken by a signed-in member of staff.'
      using errcode = 'P0001';
  end if;

  -- The capability that collects a claim's evidence. Not `benefits:assess`:
  -- gathering the confirmations is counter work, and the person who assesses
  -- the claim should be looking at evidence somebody else collected.
  if auth.uid() is not null and not public.user_has_permission('benefits:claim') then
    raise exception
      'Recording a death confirmation requires the benefits:claim capability.'
      using errcode = '42501';
  end if;

  select * into v_claim from public.benefit_claims where id = p_claim_id for update;

  if not found then
    raise exception 'No such benefit claim.' using errcode = 'P0001';
  end if;

  if not public.user_can_see_branch(v_claim.branch_id) then
    raise exception 'You cannot work that branch''s claims.' using errcode = '42501';
  end if;

  select * into v_confirmer
  from public.memberships where id = p_confirming_membership_id;

  if not found then
    raise exception
      'No such membership. A death confirmation names a member of this programme, not a typed name.'
      using errcode = 'P0001';
  end if;

  if p_confirming_membership_id = v_claim.membership_id then
    raise exception
      'Membership % is the membership this claim is about. The deceased does not confirm their own death.',
      v_confirmer.membership_number using errcode = 'P0001';
  end if;

  -- "three **other group members**". A member whose own membership has ended
  -- is not one, and a pending application is not a member yet.
  if v_confirmer.status not in ('active', 'suspended') then
    raise exception
      'Membership % is %. A confirmation comes from a member of the programme.',
      v_confirmer.membership_number, v_confirmer.status using errcode = 'P0001';
  end if;

  -- Serialise against a concurrent third and fourth confirmation. The unique
  -- index stops a duplicate member; this stops two callers both believing
  -- they were the one that completed the set.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('death_confirmations:' || p_claim_id::text)
  );

  if exists (
    select 1 from public.benefit_death_confirmations
    where claim_id = p_claim_id
      and confirming_membership_id = p_confirming_membership_id
  ) then
    raise exception
      'Membership % has already confirmed this death. Three confirmations means three different members.',
      v_confirmer.membership_number using errcode = 'P0001';
  end if;

  insert into public.benefit_death_confirmations (
    claim_id, claim_number, subject_membership_id,
    confirming_membership_id, confirming_membership_number,
    statement, relationship_note, confirmation_method,
    signature_name, evidence_path,
    recorded_by, recorded_by_label, business_date
  )
  values (
    p_claim_id, v_claim.claim_number, v_claim.membership_id,
    p_confirming_membership_id, v_confirmer.membership_number,
    pg_catalog.btrim(p_statement),
    nullif(pg_catalog.btrim(coalesce(p_relationship_note, '')), ''),
    p_confirmation_method,
    nullif(pg_catalog.btrim(coalesce(p_signature_name, '')), ''),
    nullif(pg_catalog.btrim(coalesce(p_evidence_path, '')), ''),
    v_actor, v_label, public.business_date()
  )
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.record_death_confirmation(uuid, uuid, text, text, text, text, text) is
  'Polytos policy update, rule 12. Records one group member''s confirmation of a death against a claim. The confirming member is a real membership, in good standing, and never the deceased; the staff member who took it is stamped from the session rather than supplied. Needs benefits:claim — gathering evidence is counter work, and the assessor should be reading evidence somebody else collected.';

grant execute on function
  public.record_death_confirmation(uuid, uuid, text, text, text, text, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- How many there are
-- ---------------------------------------------------------------------------

create or replace function public.death_confirmation_count(p_claim_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.count(*)::integer
  from public.benefit_death_confirmations d
  join public.benefit_claims bc on bc.id = d.claim_id
  join public.clients c on c.id = bc.client_id
  where d.claim_id = p_claim_id
    and (
      auth.uid() is null
      or (public.user_has_permission('benefits:view')
          and public.user_can_see_branch(bc.branch_id))
      or c.profile_id = public.current_profile_id()
    );
$$;

comment on function public.death_confirmation_count(uuid) is
  'Polytos policy update. How many distinct group members have confirmed the death behind a claim. SECURITY DEFINER so that a claim screen can show "2 of 3" without the reader holding the capability to read who they were.';

grant execute on function public.death_confirmation_count(uuid) to authenticated;


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

revoke all on table public.benefit_death_confirmations from anon, authenticated;
revoke all on function public.benefit_death_confirmations_guard() from public, anon, authenticated;
revoke all on function public.record_death_confirmation(uuid, uuid, text, text, text, text, text) from public, anon;
revoke all on function public.death_confirmation_count(uuid) from public, anon;
