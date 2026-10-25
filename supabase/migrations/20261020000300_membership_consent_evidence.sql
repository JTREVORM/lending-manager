-- ===========================================================================
-- Polytos Phase 2.3 — consent that can be verified, not consent that is typed
--
-- ## The defect this closes, stated plainly
--
-- `membership_terms_acceptances.signature_name` is free text. Anybody holding
-- the capability can type any member's name into it, and the row that results
-- is indistinguishable from one the member themselves signed. Phase 1 shipped
-- that table with no write path, so it was a latent problem rather than a
-- live one; ADR-050 recorded that Phase 2 must not build the form until the
-- database can tell the difference.
--
-- This migration is that difference.
--
-- ## Four methods, each with something a staff member cannot type
--
--   `member_portal`        The member confirmed from their own signed-in
--                          account. The trigger checks that the session
--                          making the record resolves, through
--                          `clients.profile_id`, to this member. A staff
--                          member cannot produce this row at all.
--
--   `one_time_code`        A code was sent to the phone number on the client
--                          record and returned. The trigger consumes a
--                          matching, unexpired, unused challenge — and marks
--                          it used, so the same code cannot be spent twice.
--
--   `signature_document`   A signature image or scanned form. The trigger
--                          checks the object **actually exists** in the
--                          private bucket, under this membership's own path.
--                          A path that names a file nobody uploaded verifies
--                          nothing, so it is refused.
--
--   `witnessed_in_branch`  A second member of staff witnessed the signing.
--                          The witness is a `profiles` row — a person with an
--                          account, who can be asked — not a typed name and
--                          phone number. They must be active, and they must
--                          not be the person recording the acceptance: one
--                          person is not two witnesses.
--
-- ## `verification_status` is derived, never supplied
--
-- The guard overwrites whatever a caller sends. There is no path by which
-- `verified = true` arrives from outside and is believed, which is the whole
-- point: the Phase 1 defect was a column anybody could assert, and replacing
-- it with a different column anybody could assert would be the same defect in
-- a new coat.
--
-- ## Replay is refused by a digest, not by trust
--
-- `evidence_digest` is unique. The same signature file, the same challenge,
-- the same portal confirmation cannot be presented twice — not for a second
-- membership, and not for a second policy version on the same membership.
-- Re-accepting new terms requires new evidence, which is what re-accepting
-- means.
--
-- ## What happens to rows written before this migration
--
-- They are marked `legacy_typed_name` / `unverified` rather than deleted or
-- quietly upgraded. The activation precondition in 20261020001000 requires
-- `verified`, so such a row activates nobody — which is the correct treatment
-- of an acceptance whose evidence nobody can produce.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The private bucket
--
-- Same shape as every other bucket in this project: private, 10 MiB, images
-- and PDFs. A signature is a photograph of a piece of paper or a drawn image;
-- neither needs more room than a national ID scan.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'membership-consent',
  'membership-consent',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf']
)
on conflict (id) do nothing;

-- The second path segment: the membership this object belongs to. The same
-- technique `storage_path_loan_id` uses, and the reason is the same — it is
-- what makes the policies below expressible as a predicate rather than a
-- convention somebody has to remember.
create or replace function public.storage_path_membership_id(p_name text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case
    when (pg_catalog.string_to_array(p_name, '/'))[2] ~
         '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then ((pg_catalog.string_to_array(p_name, '/'))[2])::uuid
  end;
$$;

comment on function public.storage_path_membership_id(text) is
  'Polytos Phase 2. The membership a membership-consent object belongs to, taken from its path. NULL when the path is not shaped like one, which denies every policy below.';

revoke all on function public.storage_path_membership_id(text) from public, anon;
grant execute on function public.storage_path_membership_id(text) to authenticated;

-- ---------------------------------------------------------------------------
-- The digest
--
-- PostgreSQL's own `sha256()`, not pgcrypto's `digest()`: this project
-- installs `pg_trgm` and nothing else, and adding an extension to compute a
-- hash the server already computes would be a dependency bought for nothing.
-- ---------------------------------------------------------------------------

create or replace function public.consent_evidence_digest(p_material text)
returns text
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(p_material, 'UTF8')), 'hex');
$$;

comment on function public.consent_evidence_digest(text) is
  'Polytos Phase 2. The digest stamped on a consent record, and on a one-time code. Hex sha256, so membership_terms_evidence_digest_shape can check its shape.';

revoke all on function public.consent_evidence_digest(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The one-time challenge
--
-- A code delivered to the phone number already on the client record, and
-- returned by whoever holds that phone. The code itself is never stored: only
-- its digest, so a reader of this table cannot replay one.
-- ---------------------------------------------------------------------------

create table public.membership_consent_challenges (
  id uuid primary key default gen_random_uuid(),

  membership_id uuid not null references public.memberships(id) on delete restrict,
  policy_version_id uuid not null
    references public.membership_policy_versions(id) on delete restrict,

  -- The number the code went to, copied from the client record at the moment
  -- of issue. Copied rather than joined: if the client later changes their
  -- phone, what this challenge proves is that the person holding *that*
  -- number answered.
  delivered_to text not null,

  -- `digest(code)`, never the code. A challenge table that held live codes
  -- would be a way to consent on somebody's behalf by reading the database.
  code_digest text not null,

  issued_by uuid references public.profiles(id) on delete set null,
  issued_by_label text not null default 'system',
  issued_at timestamptz not null default pg_catalog.now(),
  expires_at timestamptz not null,

  consumed_at timestamptz,
  attempts smallint not null default 0,

  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),

  constraint membership_consent_challenge_phone_e164
    check (delivered_to ~ '^\+256[0-9]{9}$'),
  constraint membership_consent_challenge_digest_shape
    check (code_digest ~ '^[0-9a-f]{64}$'),
  constraint membership_consent_challenge_expires_after_issue
    check (expires_at > issued_at),
  constraint membership_consent_challenge_attempts_bounded
    check (attempts between 0 and 10)
);

comment on table public.membership_consent_challenges is
  'Polytos Phase 2. A one-time code issued to the phone number on a member''s client record, to be returned as evidence that the member themselves accepted the terms. Holds the code''s digest, never the code.';

create index membership_consent_challenges_membership_idx
  on public.membership_consent_challenges (membership_id, issued_at desc);

-- At most one live challenge per membership and version. Issuing a second
-- while the first is unspent would let two codes open the same door.
create unique index membership_consent_challenges_one_live
  on public.membership_consent_challenges (membership_id, policy_version_id)
  where consumed_at is null;

create trigger membership_consent_challenges_set_updated_at
  before update on public.membership_consent_challenges
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- The evidence columns on the acceptance itself
--
-- Added nullable, backfilled, then made NOT NULL — so the migration is
-- correct against a database that already holds acceptances as well as
-- against an empty one.
-- ---------------------------------------------------------------------------

alter table public.membership_terms_acceptances
  add column consent_method text,
  add column verification_status text,
  add column evidence_reference text,
  add column evidence_digest text,
  add column verified_at timestamptz,
  add column verified_by uuid references public.profiles(id) on delete set null,
  add column verified_by_label text,
  add column member_profile_id uuid references public.profiles(id) on delete set null,
  add column witness_profile_id uuid references public.profiles(id) on delete set null,
  add column challenge_id uuid
    references public.membership_consent_challenges(id) on delete restrict;

-- Anything already recorded carried a typed name and nothing else. Saying so
-- is more useful than deleting it: the row is evidence that somebody wrote
-- something down, and `unverified` is the honest weight to give it.
update public.membership_terms_acceptances
   set consent_method = 'legacy_typed_name',
       verification_status = 'unverified'
 where consent_method is null;

alter table public.membership_terms_acceptances
  alter column consent_method set not null,
  alter column verification_status set not null;

alter table public.membership_terms_acceptances
  add constraint membership_terms_consent_method_valid
    check (consent_method in (
      'member_portal',
      'one_time_code',
      'signature_document',
      'witnessed_in_branch',
      'legacy_typed_name'
    )),
  add constraint membership_terms_verification_status_valid
    check (verification_status in ('unverified', 'verified', 'rejected')),

  -- A verified acceptance says who verified it and when. Both halves or
  -- neither, the same rule the policy approval carries.
  add constraint membership_terms_verified_is_attributed
    check (
      verification_status <> 'verified'
      or (verified_at is not null and verified_by_label is not null)
    ),

  -- A legacy row can never become verified. There is no evidence to produce.
  add constraint membership_terms_legacy_stays_unverified
    check (consent_method <> 'legacy_typed_name' or verification_status = 'unverified'),

  -- Each method carries the thing that makes it checkable.
  add constraint membership_terms_portal_names_the_member
    check (consent_method <> 'member_portal' or member_profile_id is not null),
  add constraint membership_terms_code_names_the_challenge
    check (consent_method <> 'one_time_code' or challenge_id is not null),
  add constraint membership_terms_signature_names_the_file
    check (consent_method <> 'signature_document' or signature_path is not null),
  add constraint membership_terms_witness_is_a_person
    check (consent_method <> 'witnessed_in_branch' or witness_profile_id is not null),

  -- One person is not two. A staff member cannot witness their own entry,
  -- which is the same reason `record_transfer` refuses an approval from the
  -- person who asked.
  add constraint membership_terms_witness_is_not_the_recorder
    check (
      witness_profile_id is null
      or recorded_by is null
      or witness_profile_id <> recorded_by
    ),

  add constraint membership_terms_evidence_digest_shape
    check (evidence_digest is null or evidence_digest ~ '^[0-9a-f]{64}$'),
  add constraint membership_terms_evidence_reference_length
    check (evidence_reference is null or char_length(btrim(evidence_reference)) between 1 and 200);

-- Replay refused structurally. The same file, the same challenge, the same
-- portal confirmation cannot be presented for a second acceptance.
create unique index membership_terms_evidence_digest_unique
  on public.membership_terms_acceptances (evidence_digest)
  where evidence_digest is not null;

comment on column public.membership_terms_acceptances.consent_method is
  'How this acceptance can be checked by somebody who was not there. legacy_typed_name is the pre-Phase-2 state and is never verified.';
comment on column public.membership_terms_acceptances.verification_status is
  'Derived by membership_terms_acceptances_guard from evidence it can actually check. Never settable by a caller.';
comment on column public.membership_terms_acceptances.evidence_digest is
  'A digest of the evidence, unique across the table, so the same evidence cannot be presented for a second acceptance.';

-- ---------------------------------------------------------------------------
-- The guard, rewritten: it verifies rather than accepts
--
-- Phase 1's version derived the version string and the recorder. This one
-- keeps both and adds the verification, which is stated **above** the
-- trusted-path exemption so it binds `service_role` and the table owner too.
-- A privileged key that could write `verified` would be a privileged key that
-- could manufacture consent.
-- ---------------------------------------------------------------------------

create or replace function public.membership_terms_acceptances_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version       text;
  v_membership    public.memberships;
  v_client        public.clients;
  v_challenge     public.membership_consent_challenges;
  v_witness       public.profiles;
  v_object_count  integer;
  v_actor         uuid;
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
    v_actor := public.current_profile_id();
    new.recorded_by := v_actor;

    select * into v_membership
    from public.memberships where id = new.membership_id;

    if not found then
      raise exception 'No such membership.' using errcode = 'P0001';
    end if;

    select * into v_client
    from public.clients where id = v_membership.client_id;

    -- --- The verification --------------------------------------------------
    --
    -- Starts refused. Each branch below has to earn `verified`, and the ones
    -- that cannot are left as they are rather than given the benefit of the
    -- doubt.
    new.verification_status := 'unverified';
    new.verified_at := null;
    new.verified_by := null;
    new.verified_by_label := null;

    if new.consent_method = 'legacy_typed_name' then
      raise exception
        'legacy_typed_name records what was written before consent could be verified. A new acceptance must use a method that can be checked.'
        using errcode = 'P0001';

    elsif new.consent_method = 'member_portal' then
      -- The member themselves, from their own account. Checked against the
      -- *session*, so a staff member cannot assert it: `current_profile_id()`
      -- resolves only active profiles, and it must be the profile the client
      -- record is linked to.
      if v_client.profile_id is null then
        raise exception
          'This member has no portal account, so they cannot accept the terms through one.'
          using errcode = 'P0001';
      end if;

      if new.member_profile_id is distinct from v_client.profile_id then
        raise exception
          'A portal acceptance must name the member''s own account.'
          using errcode = 'P0001';
      end if;

      if v_actor is distinct from v_client.profile_id then
        raise exception
          'A portal acceptance must be made by the member, signed in to their own account.'
          using errcode = 'P0001';
      end if;

      new.verification_status := 'verified';
      new.evidence_digest := public.consent_evidence_digest(
        'portal:' || new.membership_id::text || ':' ||
        new.policy_version_id::text || ':' || v_client.profile_id::text);

    elsif new.consent_method = 'one_time_code' then
      select * into v_challenge
      from public.membership_consent_challenges
      where id = new.challenge_id
      for update;

      if not found then
        raise exception 'No such consent challenge.' using errcode = 'P0001';
      end if;

      if v_challenge.membership_id <> new.membership_id
         or v_challenge.policy_version_id <> new.policy_version_id then
        raise exception
          'That consent challenge was issued for a different membership or a different policy version.'
          using errcode = 'P0001';
      end if;

      if v_challenge.consumed_at is not null then
        raise exception
          'That consent challenge has already been used. Issue a new one.'
          using errcode = 'P0001';
      end if;

      if v_challenge.expires_at <= pg_catalog.now() then
        raise exception
          'That consent challenge has expired. Issue a new one.'
          using errcode = 'P0001';
      end if;

      -- Spent here, in the same transaction as the acceptance it proves.
      update public.membership_consent_challenges
         set consumed_at = pg_catalog.now()
       where id = v_challenge.id;

      new.verification_status := 'verified';
      new.evidence_reference := v_challenge.delivered_to;
      new.evidence_digest :=
        public.consent_evidence_digest('challenge:' || v_challenge.id::text);

    elsif new.consent_method = 'signature_document' then
      -- The file has to be there. A path is a claim; an object is evidence.
      select count(*) into v_object_count
      from storage.objects o
      where o.bucket_id = 'membership-consent'
        and o.name = new.signature_path;

      if v_object_count = 0 then
        raise exception
          'No signature document has been uploaded at that path. Upload it before recording the acceptance.'
          using errcode = 'P0001';
      end if;

      if public.storage_path_membership_id(new.signature_path)
         is distinct from new.membership_id then
        raise exception
          'That signature document belongs to a different membership.'
          using errcode = 'P0001';
      end if;

      new.verification_status := 'verified';
      new.evidence_reference := new.signature_path;
      new.evidence_digest :=
        public.consent_evidence_digest('signature:' || new.signature_path);

    elsif new.consent_method = 'witnessed_in_branch' then
      select * into v_witness
      from public.profiles where id = new.witness_profile_id;

      if not found then
        raise exception
          'The witness must be a member of staff with an account, not a name written on a form.'
          using errcode = 'P0001';
      end if;

      if v_witness.status <> 'active' then
        raise exception
          'The witness''s account is %, so they cannot witness an acceptance.',
          v_witness.status using errcode = 'P0001';
      end if;

      if v_actor is not null and v_witness.id = v_actor then
        raise exception
          'A witness cannot be the person recording the acceptance.'
          using errcode = 'P0001';
      end if;

      new.verification_status := 'verified';
      new.evidence_reference := v_witness.full_name;
      new.evidence_digest := public.consent_evidence_digest(
        'witness:' || new.membership_id::text || ':' ||
        new.policy_version_id::text || ':' || v_witness.id::text);

    else
      raise exception 'Unknown consent method "%".', new.consent_method
        using errcode = 'P0001';
    end if;

    if new.verification_status = 'verified' then
      new.verified_at := pg_catalog.now();
      new.verified_by := v_actor;
      new.verified_by_label := public.audit_actor_label();
    end if;

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
     or new.consent_method is distinct from old.consent_method
     or new.verification_status is distinct from old.verification_status
     or new.evidence_digest is distinct from old.evidence_digest
     or new.verified_at is distinct from old.verified_at
     or new.verified_by_label is distinct from old.verified_by_label
     or new.challenge_id is distinct from old.challenge_id
     or new.created_at is distinct from old.created_at then
    raise exception
      'A recorded acceptance of the membership terms cannot be edited.'
      using errcode = 'P0001';
  end if;

  -- `recorded_by`, `verified_by`, `member_profile_id` and
  -- `witness_profile_id` are all `ON DELETE SET NULL`, so deleting a profile
  -- blanks them — a database cascade that preserves the record, not a caller
  -- reattributing it. Checking them above the exemption would make a staff
  -- profile undeletable by any route once they had witnessed one signature,
  -- which is a different policy than the one intended; the evidence survives
  -- regardless, because `evidence_reference` holds the witness's name and
  -- `evidence_digest` is what stops the evidence being reused.
  --
  -- A *session* may still not touch any of them, which is what this checks.
  if auth.uid() is not null
     and (new.recorded_by is distinct from old.recorded_by
          or new.verified_by is distinct from old.verified_by
          or new.member_profile_id is distinct from old.member_profile_id
          or new.witness_profile_id is distinct from old.witness_profile_id) then
    raise exception
      'A recorded acceptance of the membership terms cannot be edited.'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

comment on function public.membership_terms_acceptances_guard() is
  'BEFORE INSERT/UPDATE on membership_terms_acceptances: derives the version string and the recorder, and *verifies* the consent evidence rather than accepting a caller''s claim about it. verification_status is computed here and nowhere else. Binds every caller, service_role included.';

-- ---------------------------------------------------------------------------
-- Access control on the challenge table
-- ---------------------------------------------------------------------------

alter table public.membership_consent_challenges enable row level security;
revoke all on table public.membership_consent_challenges from anon, authenticated;

-- Deliberately no grant at all. A challenge is issued and consumed by
-- SECURITY DEFINER functions; no session reads or writes this table directly,
-- because the only interesting thing in it is a digest and the only
-- interesting operation on it is one the database performs itself.

create trigger membership_consent_challenges_no_delete
  before delete on public.membership_consent_challenges
  for each statement execute function public.reject_mutation();
