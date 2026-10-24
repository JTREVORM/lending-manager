-- ===========================================================================
-- Polytos Phase 1.5 — what a member was shown, and agreed to
--
-- ## Why an acceptance is a row and not a boolean on the membership
--
-- A member is agreeing to save UGX 50,000 a month and to a set of benefit
-- rules that the business may later change. What makes that enforceable — in
-- either direction — is that they were shown a specific version of the terms
-- on a specific date and put their name to it. `terms_accepted = true` on the
-- membership would record none of that, and it could not survive the
-- business publishing version 1.1.
--
-- So this is the same shape the guarantor consent takes (`loan_guarantors`,
-- Phase 13): the version is referenced *and* denormalised onto the row,
-- because the version string is what a printed form shows and what an auditor
-- reads, and it must stay legible after the terms row is superseded.
--
-- ## One acceptance per version, not one per membership
--
-- The unique key is `(membership_id, policy_version_id)`. A member accepts
-- version 1.0 at enrolment; if the business later publishes 1.1 and asks
-- existing members to accept it, that is a second row, and the two together
-- are the history of what that member agreed to and when. A unique key on
-- `membership_id` alone would make re-acceptance impossible to record, which
-- is exactly the case the versioning exists for.
--
-- ## Nothing writes this yet
--
-- Polytos Phase 2 takes the acceptance at enrolment, alongside the
-- registration fee receipt. This phase creates the table, its constraints and
-- its policies so that the write path has somewhere correct to land — and so
-- that the authorization around it is reviewed before anything depends on it.
-- ===========================================================================

create table public.membership_terms_acceptances (
  id uuid primary key default gen_random_uuid(),

  membership_id uuid not null references public.memberships(id) on delete restrict,

  policy_version_id uuid not null
    references public.membership_policy_versions(id) on delete restrict,
  -- Denormalised on purpose. See the note above: the printed form carries the
  -- version string, and it must outlive the row being superseded.
  policy_version text not null,

  accepted_at timestamptz not null,

  -- Who signed, as they signed it. Not a lookup onto `clients.full_name`:
  -- the point of a signature is that it is the name the person wrote.
  signature_name text not null,
  -- An uploaded image of the signature, where one was taken. A path under the
  -- private documents bucket, never a URL. Polytos Phase 2 writes it.
  signature_path text,

  witness_name text,
  witness_phone text,
  accepted_place text,

  recorded_by uuid references public.profiles(id) on delete set null,

  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),

  constraint membership_terms_version_shape
    check (policy_version ~ '^[0-9]+\.[0-9]+$'),
  constraint membership_terms_signature_name_length
    check (char_length(btrim(signature_name)) between 2 and 120),
  constraint membership_terms_witness_name_length
    check (witness_name is null or char_length(btrim(witness_name)) between 2 and 120),
  constraint membership_terms_witness_phone_e164
    check (witness_phone is null or witness_phone ~ '^\+256[0-9]{9}$'),
  constraint membership_terms_place_length
    check (accepted_place is null or char_length(btrim(accepted_place)) between 2 and 160),
  -- The same path discipline every other storage column in this schema
  -- carries: generated server-side, and shaped so traversal, an absolute
  -- path, or a path into another bucket is refused by the constraint rather
  -- than by a code review.
  constraint membership_terms_signature_path_shape
    check (
      signature_path is null
      or signature_path
         ~ '^memberships/[0-9a-f-]{36}/signature/[0-9a-zA-Z._-]{1,120}$'
    ),
  constraint membership_terms_accepted_not_future
    check (accepted_at <= pg_catalog.now() + interval '1 day'),

  -- One acceptance per version per membership.
  unique (membership_id, policy_version_id)
);

comment on table public.membership_terms_acceptances is
  'Polytos Phase 1. The record that a member was shown a specific version of the membership terms and agreed to it. One row per (membership, version), so re-acceptance after a policy change is recordable rather than destructive.';
comment on column public.membership_terms_acceptances.policy_version is
  'Denormalised version string. The printed form carries it, and it must stay legible after the policy row is superseded.';

create index membership_terms_acceptances_membership_idx
  on public.membership_terms_acceptances (membership_id, accepted_at desc);
create index membership_terms_acceptances_version_idx
  on public.membership_terms_acceptances (policy_version_id);

create trigger membership_terms_acceptances_set_updated_at
  before update on public.membership_terms_acceptances
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- The version string and the version row cannot disagree
--
-- `policy_version` is denormalised, and a denormalised column that nothing
-- checks is a column that eventually lies. This copies it from the referenced
-- row rather than trusting the caller, and refuses to let either half move
-- afterwards.
-- ---------------------------------------------------------------------------

create or replace function public.membership_terms_acceptances_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version text;
begin
  if tg_op = 'INSERT' then
    select v.version into v_version
    from public.membership_policy_versions v
    where v.id = new.policy_version_id;

    if v_version is null then
      raise exception 'No such membership policy version.' using errcode = 'P0001';
    end if;

    -- Derived, never trusted.
    new.policy_version := v_version;
    new.recorded_by := public.current_profile_id();

    return new;
  end if;

  -- An acceptance is evidence. Nothing about what was agreed may be edited;
  -- a mistake is corrected by recording the correct acceptance against a new
  -- version, which is what publishing one is for.
  --
  -- Binding on every caller, including service_role: what the member signed
  -- is not the privileged client's to revise either.
  if new.membership_id is distinct from old.membership_id
     or new.policy_version_id is distinct from old.policy_version_id
     or new.policy_version is distinct from old.policy_version
     or new.accepted_at is distinct from old.accepted_at
     or new.signature_name is distinct from old.signature_name
     or new.created_at is distinct from old.created_at then
    raise exception
      'A recorded acceptance of the membership terms cannot be edited.'
      using errcode = 'P0001';
  end if;

  -- `recorded_by` is `ON DELETE SET NULL`, so deleting the recorder's profile
  -- blanks it — a database cascade, not a caller reattributing the record. A
  -- *session* may still not touch it, which is what this checks, below the
  -- trusted-path exemption for the same reason the other guards place it
  -- there.
  if auth.uid() is not null
     and new.recorded_by is distinct from old.recorded_by then
    raise exception
      'A recorded acceptance of the membership terms cannot be edited.'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

comment on function public.membership_terms_acceptances_guard() is
  'BEFORE INSERT/UPDATE on membership_terms_acceptances: copies the version string from the referenced policy row rather than trusting the caller, derives the recorder from the session, and freezes everything substantive afterwards.';

create trigger membership_terms_acceptances_guard
  before insert or update on public.membership_terms_acceptances
  for each row execute function public.membership_terms_acceptances_guard();

create trigger membership_terms_acceptances_no_delete
  before delete on public.membership_terms_acceptances
  for each statement execute function public.reject_mutation();

revoke all on function public.membership_terms_acceptances_guard()
  from public, anon, authenticated;

alter table public.membership_terms_acceptances enable row level security;
revoke all on table public.membership_terms_acceptances from anon, authenticated;
