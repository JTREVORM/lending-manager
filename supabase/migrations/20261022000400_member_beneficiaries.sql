-- ===========================================================================
-- Polytos Phase 4.4 — next of kin, which is a payment instruction
--
-- ## What this is
--
-- It looks like a contact list. It is not. The member bereavement benefit is
-- **payable to the registered next of kin**, so a row here is the business's
-- standing instruction about who receives UGX 200,000 when a member dies. The
-- obvious fraud against a benefits scheme is not a forged hospital bill; it is
-- a member of staff who adds themselves as the beneficiary of a member they
-- expect to die, or who edits an existing record the week a claim is filed.
--
-- Everything below follows from that one sentence.
--
-- ## Two tables, because two different questions are asked
--
-- `member_beneficiaries` answers *is there somebody the business may pay, and
-- what are they to the member* — the relationship, whether the record is
-- primary, whether anybody has verified it. That question is asked constantly:
-- by the register, by an assessor deciding a claim, by a clerk telling a
-- member their nomination is on file.
--
-- `member_beneficiary_identities` answers *who, exactly, and how do we reach
-- them* — the name, the telephone numbers, where they live, what identity
-- document was shown. That is the payment instruction itself, and it is asked
-- for rarely: by an assessor about to recommend a payment, and by the person
-- handing over the money.
--
-- The split is the same one `client_identities` already makes for a National
-- Identification Number, and for the same reason: **Row Level Security is
-- row-level.** A single table with a `membership:view_sensitive` policy could
-- only grant or deny the whole row, so a Secretary/Treasurer who must be able
-- to see that a member has a verified next of kin would thereby see that
-- person's name, telephone number and identity reference. A second table is
-- the only mechanism this database has that actually enforces the
-- distinction rather than describing it.
--
-- Where this diverges from `client_identities`: that table has no self-clause,
-- because a borrower already knows their own NIN and a portal that never
-- displays one cannot leak one. A member *should* be able to read their own
-- nomination — "is my next of kin still correct?" is a question whose wrong
-- answer means a benefit paid to the wrong person — so the policy in
-- 20261022001200 grants it to them through `clients.profile_id`.
--
-- ## The duplicate rule, as a digest
--
-- The documented identity rule for a duplicate is the same person, named the
-- same way, with the same telephone number, on the same membership, live. Both
-- halves of that now live in different tables, so neither can carry the index.
--
-- `identity_digest` is the answer: a hex sha256 of the membership, the
-- normalised name and the telephone number, stamped on the record by the
-- function that writes it, and uniquely indexed over the live rows. It leaks
-- nothing — it is the pattern `membership_terms_acceptances.evidence_digest`
-- already uses — and it refuses a second row differing only in spacing or
-- capitalisation as the data-entry slip it is.
--
-- ## Five properties, each closing one way the instruction could be bent
--
-- **1. Recording and verifying are different people.** A beneficiary is
-- `pending_verification` when recorded and reaches `verified` only through
-- `verify_member_beneficiary`, which refuses a verification from whoever
-- recorded it — the control `decide_savings_withdrawal` already uses.
-- `verification_status` is never supplied by a caller; the guard overwrites
-- whatever arrives, exactly as `membership_terms_acceptances` does with its
-- own. A column anybody can assert is not a control.
--
-- **2. A change supersedes, it never overwrites.** `UPDATE` is refused on
-- every column that bears on who gets paid. A change is a *new row* that names
-- the one it replaces, and the old row becomes `superseded` with its details
-- intact. So the record the business relied on in March is still readable in
-- June, and "who was the beneficiary when this claim was approved" has an
-- answer no later edit can change.
--
-- **3. A live claim freezes the instruction.** Changing a beneficiary while a
-- bereavement claim on that membership is past submission is refused — not
-- because the change is illegitimate, but because the claim's approved
-- recipient must not move under it. The claim's own snapshot
-- (20261022000700) is the second belt: it copies the beneficiary's details at
-- assessment, so even a change that slipped through could not redirect a
-- payment that was already authorised.
--
-- **4. Verification needs evidence that exists.** `verified` requires an
-- evidence kind and, for a document, an object that is really in the private
-- bucket under this membership's own path — the technique
-- `membership_consent_evidence` introduced, for the same reason: a path naming
-- a file nobody uploaded verifies nothing.
--
-- **5. One live primary recipient.** A member may register several
-- beneficiaries — the client has not said whether they may, so the schema
-- permits it rather than guessing — but exactly one may be `is_primary` while
-- live, enforced by a partial unique index. The bereavement benefit is one
-- payment, so a scheme with two equal primary beneficiaries has no payee; and
-- an *apportionment* between several, 60/40, is a rule the client has not
-- given, so there is no share column to be filled in with a guess.
--
-- ## What is deliberately not collected
--
-- No date of birth, no occupation, no next-of-kin-of-the-next-of-kin. Each
-- would be useful to somebody and none is needed to pay UGX 200,000 to a named
-- person who can be telephoned and identified.
--
-- The identity reference is **nullable and length-bounded**, not a National
-- Identification Number column. Polytos holds NINs for *clients*, because a
-- client is the business's counterparty. A beneficiary is a third party who has
-- consented to nothing, may be a minor, and may not hold a national ID at all
-- — and the client's approved procedure for identifying them does not exist
-- yet. So the column records *what document was shown*, and the question of
-- which documents are acceptable is recorded in docs/POLYTOS-BENEFITS.md as the
-- client's to answer.
--
-- ## One forward reference, deliberately
--
-- The guard and `revoke_member_beneficiary` both query
-- `public.benefit_claims`, which 20261022000500 creates after this file.
-- PL/pgSQL resolves a table name when the function *runs*, not when it is
-- created, so this is well defined — and the alternative orderings are worse:
-- `benefit_claims` references `member_beneficiaries` by foreign key, so it
-- genuinely has to come second, and moving the check into a function created
-- later would be the same forward reference wearing a hat. Nothing registers a
-- beneficiary during migration, so there is no window in which the reference
-- could be reached before the table exists.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The relationship vocabulary
--
-- A closed list, because the condolence benefit's eligibility turns on
-- relationship and free text cannot be assessed: "mother", "Mother" and "mum"
-- would be three rules. It is deliberately *wider* than any plausible
-- eligible-family definition, because this list says what relationships
-- exist, not which ones qualify — and which ones qualify is one of the
-- client's open questions. Nothing here grants an entitlement.
-- ---------------------------------------------------------------------------

create table public.beneficiary_relationships (
  key text primary key,
  label text not null,
  -- The display order on a form. Somebody picking "spouse" should not have to
  -- read past "cousin" to reach it.
  sort_order smallint not null,

  -- Whether this relationship is **eligible** for the family condolence
  -- benefit. NULL throughout, deliberately and on every row: the client has
  -- not said who counts as an eligible family member, and a default here would
  -- be the invented policy the brief forbids. `assess_benefit_claim` refuses a
  -- condolence assessment while the relationship it needs is NULL, and says
  -- which.
  condolence_eligible boolean,

  created_at timestamptz not null default pg_catalog.now(),
  -- Mutable: the migration upserts the label and the sort order, and
  -- `condolence_eligible` is the column the client's answer will land in. A
  -- vocabulary row is edited rather than superseded, because nothing
  -- references the words — the key is what a beneficiary record points at.
  updated_at timestamptz not null default pg_catalog.now(),

  constraint beneficiary_relationship_key_shape check (key ~ '^[a-z][a-z0-9_]*$'),
  constraint beneficiary_relationship_label_not_blank check (btrim(label) <> '')
);

create trigger beneficiary_relationships_set_updated_at
  before update on public.beneficiary_relationships
  for each row execute function public.set_updated_at();

comment on table public.beneficiary_relationships is
  'Polytos Phase 4. The relationships a beneficiary or a deceased family member may stand in to a member. condolence_eligible is NULL on every row because the client has not defined an eligible family member; a condolence claim cannot be assessed while the relationship it names is undecided.';
comment on column public.beneficiary_relationships.condolence_eligible is
  'Whether this relationship qualifies for the family condolence benefit. NULL means the client has not decided. There is no default: a default would be an invented eligibility rule.';

insert into public.beneficiary_relationships (key, label, sort_order)
values
  ('spouse', 'Spouse', 10),
  ('child', 'Child', 20),
  ('parent', 'Parent', 30),
  ('sibling', 'Sibling', 40),
  ('grandparent', 'Grandparent', 50),
  ('grandchild', 'Grandchild', 60),
  ('uncle_aunt', 'Uncle or aunt', 70),
  ('nephew_niece', 'Nephew or niece', 80),
  ('cousin', 'Cousin', 90),
  ('guardian', 'Guardian', 100),
  ('other_relative', 'Other relative', 110),
  ('other', 'Other', 120)
on conflict (key) do update set
  label = excluded.label,
  sort_order = excluded.sort_order;

-- A reference vocabulary every beneficiary and condolence form renders, so it
-- is readable by any signed-in user: a list of words for family relationships
-- discloses nothing about any person. Revoked bare first, because CREATE TABLE
-- in this database inherits default privileges that hand `authenticated`
-- everything, DELETE included.
revoke all on table public.beneficiary_relationships from anon, authenticated;
grant select on table public.beneficiary_relationships to authenticated;

alter table public.beneficiary_relationships enable row level security;

create policy beneficiary_relationships_select
  on public.beneficiary_relationships for select to authenticated using (true);

comment on policy beneficiary_relationships_select on public.beneficiary_relationships is
  'Readable by any signed-in user. A list of words for family relationships discloses nothing about any person, and every beneficiary form has to render it.';

-- ---------------------------------------------------------------------------
-- The record
-- ---------------------------------------------------------------------------

create table public.member_beneficiaries (
  id uuid primary key default pg_catalog.gen_random_uuid(),

  -- `BN2600001`, minted by the trigger below. Quoted in a claim's approved
  -- evidence, so a change produces a new reference rather than reusing one.
  beneficiary_number text not null unique,

  -- The membership, not the client. A beneficiary is a promise of the
  -- *programme*, and `on delete restrict` because a membership with a
  -- beneficiary record is not a membership anybody may delete.
  membership_id uuid not null references public.memberships(id) on delete restrict,
  -- Carried as well, because every read of this table is joined to the member
  -- and because RLS needs the client without a second hop. Set by the guard
  -- from the membership, never supplied.
  client_id uuid not null references public.clients(id) on delete restrict,
  -- The membership's branch at the time of recording, for branch scoping.
  branch_id uuid not null references public.branches(id) on delete restrict,

  relationship text not null
    references public.beneficiary_relationships(key) on delete restrict,

  -- The duplicate rule, as a digest. See the header: the name and the
  -- telephone number live in the sibling table, so neither can carry the
  -- index, and a hex sha256 over the membership, the normalised name and the
  -- number refuses a second live row for the same person while disclosing
  -- nothing.
  identity_digest text not null,

  -- --- Standing ----------------------------------------------------------

  -- One primary per membership while live. A second beneficiary is recorded as
  -- not primary, which is a contact the business holds rather than a payee it
  -- has chosen.
  is_primary boolean not null default true,

  status text not null default 'active',
  -- Set when the row stops being live. A superseded row keeps every detail.
  ended_on date,
  ended_reason text,

  -- The row this one replaces, if it replaces one. The chain is how "who was
  -- the beneficiary in March" is answered.
  supersedes_id uuid unique
    references public.member_beneficiaries(id) on delete restrict,

  -- --- Verification ------------------------------------------------------
  --
  -- Never supplied by a caller. The guard derives it, and
  -- `verify_member_beneficiary` is the only route to `verified`.

  verification_status text not null default 'pending_verification',
  verification_evidence_kind text,
  -- The object in `benefit-documents` that evidences the relationship, where
  -- the evidence is a document. Checked to exist, under this membership's own
  -- path, by `verify_member_beneficiary`.
  verification_evidence_path text,
  verification_note text,
  verified_at timestamptz,
  verified_by uuid references public.profiles(id) on delete set null,
  verified_by_label text,
  rejected_at timestamptz,
  rejected_reason text,

  -- --- Provenance --------------------------------------------------------
  --
  -- Both an id and a label, as everywhere else here: a profile that no longer
  -- exists is less useful than NULL, and the label keeps the name the record
  -- was taken under. The label is what the separation-of-duties refusal reads
  -- when the id is gone.

  recorded_by uuid references public.profiles(id) on delete set null,
  recorded_by_label text not null default 'system',
  recorded_on date not null,

  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),

  constraint member_beneficiary_number_shape
    check (beneficiary_number ~ '^BN[0-9]{6,}$'),
  constraint member_beneficiary_digest_shape
    check (identity_digest ~ '^[0-9a-f]{64}$'),

  constraint member_beneficiary_status_valid
    check (status in ('active', 'superseded', 'revoked')),
  -- A row that is no longer live has a date and a reason. One without either
  -- is a record somebody half-ended.
  constraint member_beneficiary_ended_complete
    check (
      (status = 'active') = (ended_on is null)
      and (ended_on is null) = (ended_reason is null)
    ),
  constraint member_beneficiary_ended_reason_length
    check (ended_reason is null or char_length(btrim(ended_reason)) between 3 and 500),
  constraint member_beneficiary_not_own_predecessor
    check (supersedes_id is distinct from id),

  constraint member_beneficiary_verification_valid
    check (verification_status in ('pending_verification', 'verified', 'rejected')),
  constraint member_beneficiary_evidence_kind_valid
    check (
      verification_evidence_kind is null
      or verification_evidence_kind in (
        'relationship_document', 'identity_document',
        'witnessed_in_branch', 'existing_client_record'
      )
    ),
  -- A verified record names who verified it, when, and on what. All three
  -- together or none: a verification with no evidence kind is the typed-name
  -- defect ADR-055 closed for consent, in a new coat.
  constraint member_beneficiary_verified_complete
    check (
      (verification_status = 'verified')
      = (verified_at is not null
         and verified_by_label is not null
         and verification_evidence_kind is not null)
    ),
  constraint member_beneficiary_verifier_label_not_blank
    check (verified_by_label is null or btrim(verified_by_label) <> ''),
  -- A document evidence kind needs a path; the other kinds must not carry one,
  -- because a path that is not checked is a path that lies.
  constraint member_beneficiary_document_evidence_has_path
    check (
      case verification_evidence_kind
        when 'relationship_document' then verification_evidence_path is not null
        when 'identity_document'     then verification_evidence_path is not null
        else verification_evidence_path is null
      end
    ),
  constraint member_beneficiary_evidence_path_shape
    check (
      verification_evidence_path is null
      or char_length(verification_evidence_path) between 10 and 500
    ),
  constraint member_beneficiary_rejected_complete
    check (
      (verification_status = 'rejected')
      = (rejected_at is not null and rejected_reason is not null)
    ),
  constraint member_beneficiary_rejected_reason_length
    check (
      rejected_reason is null
      or char_length(btrim(rejected_reason)) between 3 and 500
    ),
  constraint member_beneficiary_verification_note_length
    check (
      verification_note is null
      or char_length(btrim(verification_note)) between 3 and 1000
    ),
  -- Only a live row may be the primary. A superseded primary would make two,
  -- so both ending functions clear the flag in the same statement that ends
  -- the row.
  --
  -- There is deliberately **no** constraint forcing a superseded row to stop
  -- being `verified`. `status` and `verification_status` are independent
  -- axes: the first says whether this is the business's live instruction, the
  -- second says whether anybody checked it. A superseded row must keep both
  -- facts, because "the business paid BN2600001 in March, and it had been
  -- verified by a named officer" is exactly what a historic payment has to
  -- stay explicable by. "The verified beneficiary" is therefore
  -- `status = 'active' and verification_status = 'verified'`, which is what
  -- every caller asks for, rather than a fact the schema destroys on the way
  -- past.
  constraint member_beneficiary_only_active_is_primary
    check (status = 'active' or not is_primary),
  constraint member_beneficiary_recorded_label_not_blank
    check (btrim(recorded_by_label) <> ''),
  constraint member_beneficiary_recorded_on_plausible
    check (recorded_on >= date '2020-01-01')
);

comment on table public.member_beneficiaries is
  'Polytos Phase 4. A member''s registered next of kin and other beneficiaries, without their contact details — those are in member_beneficiary_identities, behind membership:view_sensitive. This is the business''s payment instruction for the bereavement benefit, not a contact list: a change supersedes rather than overwrites, verification is a separate act by a separate person, and no row reaches verified except through verify_member_beneficiary.';
comment on column public.member_beneficiaries.verification_status is
  'Derived, never supplied. The guard overwrites whatever a caller sends and verify_member_beneficiary is the only route to verified — the same discipline membership_terms_acceptances applies to its own, for the same reason.';
comment on column public.member_beneficiaries.identity_digest is
  'Hex sha256 of the membership, the normalised name and the telephone number. Carries the duplicate rule across the table split, and discloses nothing — the pattern membership_terms_acceptances.evidence_digest already uses.';
comment on column public.member_beneficiaries.supersedes_id is
  'The record this one replaces. Unique, so two rows cannot both claim to replace one, and the chain is how the beneficiary a historic claim relied on stays readable.';
comment on column public.member_beneficiaries.is_primary is
  'The one beneficiary the bereavement benefit is payable to. One per membership while live; a second beneficiary is a contact the business holds, not a payee it has chosen. There is no apportionment column, because no apportionment rule has been given.';

-- One live primary per membership. Partial, so a superseded primary does not
-- block the one that replaced it.
create unique index member_beneficiaries_one_primary
  on public.member_beneficiaries (membership_id)
  where status = 'active' and is_primary;

create unique index member_beneficiaries_no_duplicate_active
  on public.member_beneficiaries (identity_digest)
  where status = 'active';

comment on index public.member_beneficiaries_no_duplicate_active is
  'The documented duplicate rule: one live record per (membership, normalised name, telephone). Normalised before hashing, so a second row differing only in spacing or case is refused as the slip it is.';

create index member_beneficiaries_membership_idx
  on public.member_beneficiaries (membership_id, status);
create index member_beneficiaries_client_idx
  on public.member_beneficiaries (client_id);
create index member_beneficiaries_branch_idx
  on public.member_beneficiaries (branch_id);
create index member_beneficiaries_verification_idx
  on public.member_beneficiaries (verification_status)
  where status = 'active';

create trigger member_beneficiaries_set_updated_at
  before update on public.member_beneficiaries
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- The payment instruction itself
--
-- One row per beneficiary record, same primary key. Behind
-- `membership:view_sensitive`, which is the capability this table exists to
-- make real.
--
-- It is **not** append-only in the way its parent is: there is nothing to
-- update, because the parent refuses every change that bears on who gets paid
-- and a change is a new parent row with a new identity row beside it.
-- 20261022001200 grants no UPDATE at all.
-- ---------------------------------------------------------------------------

create table public.member_beneficiary_identities (
  beneficiary_id uuid primary key
    references public.member_beneficiaries(id) on delete restrict,

  full_name text not null,

  -- How the business reaches them when a member dies. Required: a payment
  -- instruction with no way to contact the payee is not one.
  phone text not null,
  alternative_phone text,

  -- Where they live, in the form this business already uses for a client.
  -- Optional, because a telephone number is what actually finds somebody in
  -- Kampala and a village name is corroboration.
  village_area text,
  district text,

  -- What document was shown, if one was. Deliberately not a NIN column — see
  -- the header.
  identity_reference text,
  identity_document_kind text,

  created_at timestamptz not null default pg_catalog.now(),

  constraint member_beneficiary_identity_name_shape
    check (char_length(btrim(full_name)) between 3 and 150),
  -- The same shape the client record uses. A beneficiary who cannot be
  -- telephoned cannot be paid.
  constraint member_beneficiary_identity_phone_shape
    check (phone ~ '^\+256[0-9]{9}$'),
  constraint member_beneficiary_identity_alt_phone_shape
    check (alternative_phone is null or alternative_phone ~ '^\+256[0-9]{9}$'),
  constraint member_beneficiary_identity_alt_phone_differs
    check (alternative_phone is null or alternative_phone <> phone),
  constraint member_beneficiary_identity_village_length
    check (village_area is null
           or char_length(btrim(village_area)) between 2 and 120),
  constraint member_beneficiary_identity_district_length
    check (district is null or char_length(btrim(district)) between 2 and 120),
  constraint member_beneficiary_identity_reference_length
    check (identity_reference is null
           or char_length(btrim(identity_reference)) between 4 and 60),
  constraint member_beneficiary_identity_kind_valid
    check (
      identity_document_kind is null
      or identity_document_kind in (
        'national_id', 'passport', 'drivers_licence',
        'village_letter', 'birth_certificate', 'other'
      )
    ),
  -- A reference with no document named, or a document named with no reference,
  -- is half an identification. Both or neither.
  constraint member_beneficiary_identity_complete
    check ((identity_reference is null) = (identity_document_kind is null))
);

comment on table public.member_beneficiary_identities is
  'Polytos Phase 4. Who a beneficiary is and how to reach them — the payment instruction itself, behind membership:view_sensitive. A separate table because Row Level Security is row-level: a single table could only grant or deny the whole row, so the clerk who must see that a member has a verified next of kin would thereby see that person''s name, number and identity reference. The same split client_identities already makes for a National Identification Number.';
comment on column public.member_beneficiary_identities.identity_reference is
  'What identity document was shown, where one was. Deliberately not a National Identification Number column: a beneficiary is a third party who has consented to nothing, may be a minor, and the client''s procedure for identifying them is undecided.';

create trigger member_beneficiary_identities_no_update
  before update on public.member_beneficiary_identities
  for each row execute function public.reject_mutation();

create trigger member_beneficiary_identities_no_delete
  before delete on public.member_beneficiary_identities
  for each row execute function public.reject_mutation();

-- ---------------------------------------------------------------------------
-- The number
-- ---------------------------------------------------------------------------

create or replace function public.member_beneficiaries_assign_number()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- A supplied number is ignored rather than refused, the convention every
  -- other numbered table here follows: the counter is the authority, and a
  -- caller who guesses is simply overruled.
  new.beneficiary_number := public.next_reference('beneficiary');
  return new;
end;
$$;

comment on function public.member_beneficiaries_assign_number() is
  'Polytos Phase 4. Mints BN2600001 from the atomic counter, overruling anything supplied. Never MAX(number) + 1, which under two concurrent callers issues one number twice.';

revoke all on function public.member_beneficiaries_assign_number()
  from public, anon, authenticated;

create trigger member_beneficiaries_assign_number
  before insert on public.member_beneficiaries
  for each row execute function public.member_beneficiaries_assign_number();

-- ---------------------------------------------------------------------------
-- The guard
--
-- Three jobs, in this order: derive what must not be supplied, refuse what
-- must not change, and refuse a change that would move a live claim's payee.
-- ---------------------------------------------------------------------------

create or replace function public.member_beneficiaries_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_membership public.memberships;
  v_predecessor public.member_beneficiaries;
  v_live_claims integer;
begin
  if tg_op = 'INSERT' then
    select * into v_membership
    from public.memberships where id = new.membership_id;

    if not found then
      raise exception 'No such membership.' using errcode = 'P0001';
    end if;

    -- A beneficiary belongs to a membership that still exists as a
    -- relationship. Recording next of kin for a membership withdrawn two years
    -- ago is not a payment instruction anybody will act on; a *deceased*
    -- membership is refused for a sharper reason — the bereavement claim is
    -- already live by then, and a beneficiary created after the death is
    -- exactly the substitution this phase exists to prevent.
    if v_membership.status not in ('pending', 'active', 'suspended') then
      raise exception
        'Membership % is %. A beneficiary may only be registered against a live membership — and never after a member has died, because the claim is already open by then.',
        v_membership.membership_number, v_membership.status
        using errcode = 'P0001';
    end if;

    -- Derived, not supplied. A caller who could choose the client or the
    -- branch could file a beneficiary against one membership and have it read
    -- as another's.
    new.client_id := v_membership.client_id;
    new.branch_id := v_membership.branch_id;
    new.recorded_on := public.business_date();

    new.recorded_by := coalesce(public.current_profile_id(), new.recorded_by);
    new.recorded_by_label := public.audit_actor_label();

    -- The whole point. Whatever arrived, a new record is unverified.
    new.verification_status := 'pending_verification';
    new.verification_evidence_kind := null;
    new.verification_evidence_path := null;
    new.verified_at := null;
    new.verified_by := null;
    new.verified_by_label := null;
    new.rejected_at := null;
    new.rejected_reason := null;

    -- A new record is live. `superseded` and `revoked` are reached by the
    -- functions that end a record, never by an insert claiming to be already
    -- over.
    new.status := 'active';
    new.ended_on := null;
    new.ended_reason := null;

    if new.supersedes_id is not null then
      select * into v_predecessor
      from public.member_beneficiaries where id = new.supersedes_id for update;

      if not found then
        raise exception 'No such beneficiary record to supersede.'
          using errcode = 'P0001';
      end if;

      if v_predecessor.membership_id <> new.membership_id then
        raise exception
          'Beneficiary % belongs to a different membership. A change replaces a record on the same membership.',
          v_predecessor.beneficiary_number using errcode = 'P0001';
      end if;

      if v_predecessor.status <> 'active' then
        raise exception
          'Beneficiary % is already %. A superseded record cannot be superseded again.',
          v_predecessor.beneficiary_number, v_predecessor.status
          using errcode = 'P0001';
      end if;

      -- The third property from the header. A bereavement claim past
      -- submission has a recipient the business is deciding on; moving the
      -- beneficiary under it is refused here, and refused again by the claim's
      -- own frozen snapshot if it ever got this far.
      select pg_catalog.count(*) into v_live_claims
      from public.benefit_claims c
      where c.membership_id = new.membership_id
        and c.claim_type = 'member_bereavement'
        and c.status not in ('draft', 'rejected', 'cancelled');

      if v_live_claims > 0 then
        raise exception
          'A bereavement claim on membership % is under way. The beneficiary cannot be changed while it is, because the recipient the business is deciding on must not move. Resolve or cancel the claim first.',
          v_membership.membership_number using errcode = 'P0001';
      end if;

      -- The predecessor steps down in the same statement, so there is never a
      -- moment at which both are live and the primary index is the arbiter.
      update public.member_beneficiaries
         set status = 'superseded',
             is_primary = false,
             ended_on = public.business_date(),
             ended_reason = 'Superseded by a later beneficiary record.'
       where id = new.supersedes_id;
    end if;

    return new;
  end if;

  -- --- UPDATE ------------------------------------------------------------
  --
  -- Everything that bears on who gets paid is immutable. A correction is a new
  -- record through `register_member_beneficiary`, which is what makes the
  -- history a history. The columns an update *may* touch are the ones the
  -- verification and ending functions write, and `updated_at`.

  if new.id is distinct from old.id
     or new.beneficiary_number is distinct from old.beneficiary_number
     or new.membership_id is distinct from old.membership_id
     or new.client_id is distinct from old.client_id
     or new.relationship is distinct from old.relationship
     or new.identity_digest is distinct from old.identity_digest
     or new.supersedes_id is distinct from old.supersedes_id
     or new.recorded_by is distinct from old.recorded_by
     or new.recorded_by_label is distinct from old.recorded_by_label
     or new.recorded_on is distinct from old.recorded_on then
    raise exception
      'A beneficiary record is not edited. Register a replacement, which supersedes this one and keeps it readable — a benefit approved on the old details must stay explicable.'
      using errcode = 'P0001';
  end if;

  -- Verification is not reached by an UPDATE either. `verify_member_
  -- beneficiary` is SECURITY DEFINER and sets `polytos.verifying` for the
  -- duration of its own write, which is the only way past this.
  if new.verification_status is distinct from old.verification_status
     and pg_catalog.current_setting('polytos.verifying', true)
         is distinct from new.id::text then
    raise exception
      'A beneficiary''s verification is not set by an update. verify_member_beneficiary is the only route, and it refuses the person who recorded the record.'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

comment on function public.member_beneficiaries_guard() is
  'Polytos Phase 4. Derives the membership''s client, branch and the business date; forces a new record unverified; refuses every edit to a detail that bears on who gets paid; and refuses a supersession while a bereavement claim on the membership is live.';

revoke all on function public.member_beneficiaries_guard() from public, anon, authenticated;

create trigger member_beneficiaries_guard
  before insert or update on public.member_beneficiaries
  for each row execute function public.member_beneficiaries_guard();

-- Deleted by nobody. A beneficiary record is evidence of a payment
-- instruction; `revoke_member_beneficiary` ends one without removing it.
create trigger member_beneficiaries_no_delete
  before delete on public.member_beneficiaries
  for each row execute function public.reject_mutation();

-- ---------------------------------------------------------------------------
-- register_member_beneficiary()
--
-- The only way in. A direct INSERT is impossible anyway — 20261022001200
-- grants no INSERT on either table — so this is where the capability check and
-- the input discipline live, and it is what writes both halves in one
-- statement each so a record can never exist without its identity.
-- ---------------------------------------------------------------------------

create or replace function public.register_member_beneficiary(
  p_membership_id uuid,
  p_full_name text,
  p_relationship text,
  p_phone text,
  p_alternative_phone text default null,
  p_village_area text default null,
  p_district text default null,
  p_identity_document_kind text default null,
  p_identity_reference text default null,
  p_is_primary boolean default true,
  p_supersedes_id uuid default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_actor uuid;
  v_name text;
  v_phone text;
begin
  v_actor := public.current_profile_id();

  if v_actor is null and auth.uid() is not null then
    raise exception
      'A beneficiary must be recorded by a signed-in member of staff.'
      using errcode = 'P0001';
  end if;

  if auth.uid() is not null
     and not public.user_has_permission('beneficiaries:manage') then
    raise exception
      'Registering a beneficiary requires the beneficiaries:manage capability.'
      using errcode = 'P0001';
  end if;

  -- Normalised once, here, so the digest and the stored name agree. Collapsing
  -- runs of whitespace is what makes "Mary  Nakato" and "Mary Nakato" one
  -- person to the duplicate index.
  v_name := pg_catalog.regexp_replace(
    pg_catalog.btrim(coalesce(p_full_name, '')), '\s+', ' ', 'g');
  v_phone := pg_catalog.btrim(coalesce(p_phone, ''));

  -- Serialise on the membership, so two counter staff recording the same next
  -- of kin at once meet the duplicate index rather than each other.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('beneficiary:' || p_membership_id::text)
  );

  -- A second primary is not an error to shout about — it is the common case of
  -- recording a second contact — so a membership that already has a live
  -- primary is told to supersede it rather than silently demoting either.
  if p_is_primary and p_supersedes_id is null
     and exists (
       select 1 from public.member_beneficiaries b
       where b.membership_id = p_membership_id
         and b.status = 'active' and b.is_primary
     ) then
    raise exception
      'This membership already has a primary beneficiary. Record this one as an additional contact, or supersede the existing record — which keeps it readable.'
      using errcode = 'P0001';
  end if;

  insert into public.member_beneficiaries (
    membership_id, client_id, branch_id,
    relationship, identity_digest,
    is_primary, supersedes_id, recorded_on
  )
  values (
    p_membership_id,
    -- Placeholders: the guard derives both from the membership, and a BEFORE
    -- row trigger runs before the foreign keys are checked.
    p_membership_id, p_membership_id,
    p_relationship,
    public.consent_evidence_digest(
      p_membership_id::text || ':' || pg_catalog.lower(v_name) || ':' || v_phone),
    coalesce(p_is_primary, true),
    p_supersedes_id,
    public.business_date()
  )
  returning id into v_id;

  insert into public.member_beneficiary_identities (
    beneficiary_id, full_name, phone, alternative_phone,
    village_area, district, identity_document_kind, identity_reference
  )
  values (
    v_id, v_name, v_phone,
    nullif(pg_catalog.btrim(coalesce(p_alternative_phone, '')), ''),
    nullif(pg_catalog.btrim(coalesce(p_village_area, '')), ''),
    nullif(pg_catalog.btrim(coalesce(p_district, '')), ''),
    nullif(pg_catalog.btrim(coalesce(p_identity_document_kind, '')), ''),
    nullif(pg_catalog.btrim(coalesce(p_identity_reference, '')), '')
  );

  return v_id;
end;
$$;

comment on function public.register_member_beneficiary(uuid, text, text, text, text, text, text, text, text, boolean, uuid) is
  'Polytos Phase 4. Records a beneficiary against a live membership, unverified, writing the record and its identity together so neither can exist without the other. Supplying p_supersedes_id records a change: the old record becomes superseded with its details intact, which is refused while a bereavement claim on the membership is live.';

revoke all on function public.register_member_beneficiary(uuid, text, text, text, text, text, text, text, text, boolean, uuid)
  from public, anon;
grant execute on function public.register_member_beneficiary(uuid, text, text, text, text, text, text, text, text, boolean, uuid)
  to authenticated;

-- ---------------------------------------------------------------------------
-- verify_member_beneficiary()
--
-- The second pair of eyes. Refuses the person who recorded the record, by id
-- *and* by label — the label because a staff account that has since been
-- archived leaves `recorded_by` NULL, and a refusal that silently stopped
-- applying when somebody left would be the worst kind of control.
-- ---------------------------------------------------------------------------

create or replace function public.verify_member_beneficiary(
  p_beneficiary_id uuid,
  p_verified boolean,
  p_evidence_kind text,
  p_evidence_path text default null,
  p_note text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row public.member_beneficiaries;
  v_actor uuid;
  v_label text;
  v_objects integer;
begin
  v_actor := public.current_profile_id();
  v_label := public.audit_actor_label();

  if v_actor is null and auth.uid() is not null then
    raise exception
      'A beneficiary must be verified by a signed-in member of staff.'
      using errcode = 'P0001';
  end if;

  if auth.uid() is not null
     and not public.user_has_permission('beneficiaries:verify') then
    raise exception
      'Verifying a beneficiary requires the beneficiaries:verify capability.'
      using errcode = 'P0001';
  end if;

  select * into v_row
  from public.member_beneficiaries where id = p_beneficiary_id for update;

  if not found then
    raise exception 'No such beneficiary record.' using errcode = 'P0001';
  end if;

  if v_row.status <> 'active' then
    raise exception
      'Beneficiary % is %. Only a live record is verified.',
      v_row.beneficiary_number, v_row.status using errcode = 'P0001';
  end if;

  if v_row.verification_status <> 'pending_verification' then
    raise exception
      'Beneficiary % has already been %.',
      v_row.beneficiary_number, v_row.verification_status using errcode = 'P0001';
  end if;

  -- The control. Not a label on a permissions page: a Manager holds both
  -- `beneficiaries:manage` and `beneficiaries:verify`, and this is what stops
  -- them doing both halves of one record.
  if (v_actor is not null and v_row.recorded_by = v_actor)
     or (v_row.recorded_by is null and v_row.recorded_by_label = v_label) then
    raise exception
      'Beneficiary % was recorded by you. Somebody else must verify it — a beneficiary is who the business pays when a member dies, and one person recording and attesting to that is no check at all.',
      v_row.beneficiary_number using errcode = 'P0001';
  end if;

  if p_verified then
    if coalesce(pg_catalog.btrim(p_evidence_kind), '') = '' then
      raise exception
        'A verification names the evidence it rests on. A verified record with no evidence kind is a typed assertion, which is what this table exists not to hold.'
        using errcode = 'P0001';
    end if;

    if p_evidence_kind in ('relationship_document', 'identity_document') then
      if coalesce(pg_catalog.btrim(p_evidence_path), '') = '' then
        raise exception 'A document verification needs the object path.'
          using errcode = 'P0001';
      end if;

      -- The object must exist, in the private bucket, under this membership's
      -- own path. A path naming a file nobody uploaded verifies nothing — the
      -- check `membership_consent_evidence` introduced, for the same reason.
      select pg_catalog.count(*) into v_objects
      from storage.objects o
      where o.bucket_id = 'benefit-documents'
        and o.name = p_evidence_path
        and public.storage_path_membership_id(o.name) = v_row.membership_id;

      if v_objects = 0 then
        raise exception
          'There is no such document in this membership''s evidence folder. A path that names a file nobody uploaded verifies nothing.'
          using errcode = 'P0001';
      end if;
    elsif coalesce(pg_catalog.btrim(coalesce(p_evidence_path, '')), '') <> '' then
      raise exception
        'Evidence of kind "%" carries no document path.', p_evidence_kind
        using errcode = 'P0001';
    end if;

    -- The guard refuses a verification_status change except from here. The
    -- setting names *this row*, so one function call cannot verify two.
    perform pg_catalog.set_config('polytos.verifying', p_beneficiary_id::text, true);

    update public.member_beneficiaries
       set verification_status = 'verified',
           verification_evidence_kind = pg_catalog.btrim(p_evidence_kind),
           verification_evidence_path =
             nullif(pg_catalog.btrim(coalesce(p_evidence_path, '')), ''),
           verification_note = nullif(pg_catalog.btrim(coalesce(p_note, '')), ''),
           verified_at = pg_catalog.now(),
           verified_by = v_actor,
           verified_by_label = v_label,
           rejected_at = null,
           rejected_reason = null
     where id = p_beneficiary_id;

    perform pg_catalog.set_config('polytos.verifying', '', true);
  else
    if coalesce(pg_catalog.btrim(coalesce(p_note, '')), '') = '' then
      raise exception
        'A refusal needs a reason. Somebody will have to tell the member why.'
        using errcode = 'P0001';
    end if;

    perform pg_catalog.set_config('polytos.verifying', p_beneficiary_id::text, true);

    update public.member_beneficiaries
       set verification_status = 'rejected',
           verification_note = pg_catalog.btrim(p_note),
           rejected_at = pg_catalog.now(),
           rejected_reason = pg_catalog.btrim(p_note),
           verified_at = null,
           verified_by = null,
           verified_by_label = null
     where id = p_beneficiary_id;

    perform pg_catalog.set_config('polytos.verifying', '', true);
  end if;

  return p_beneficiary_id;
end;
$$;

comment on function public.verify_member_beneficiary(uuid, boolean, text, text, text) is
  'Polytos Phase 4. Verifies or refuses a beneficiary record. Refuses a verification from whoever recorded it, by profile id and by actor label, and requires evidence that exists — a document path is checked against storage under this membership''s own folder.';

revoke all on function public.verify_member_beneficiary(uuid, boolean, text, text, text)
  from public, anon;
grant execute on function public.verify_member_beneficiary(uuid, boolean, text, text, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- revoke_member_beneficiary()
--
-- The member withdrew the nomination and named nobody in their place. The row
-- stays; it stops being live. Distinct from a supersession because there is no
-- replacement, and distinct from a rejection because the record was not found
-- wanting — the member changed their mind.
-- ---------------------------------------------------------------------------

create or replace function public.revoke_member_beneficiary(
  p_beneficiary_id uuid,
  p_reason text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row public.member_beneficiaries;
  v_live_claims integer;
begin
  if public.current_profile_id() is null and auth.uid() is not null then
    raise exception
      'A beneficiary must be revoked by a signed-in member of staff.'
      using errcode = 'P0001';
  end if;

  if auth.uid() is not null
     and not public.user_has_permission('beneficiaries:manage') then
    raise exception
      'Revoking a beneficiary requires the beneficiaries:manage capability.'
      using errcode = 'P0001';
  end if;

  if coalesce(pg_catalog.btrim(p_reason), '') = '' then
    raise exception 'A revocation needs a reason.' using errcode = 'P0001';
  end if;

  select * into v_row
  from public.member_beneficiaries where id = p_beneficiary_id for update;

  if not found then
    raise exception 'No such beneficiary record.' using errcode = 'P0001';
  end if;

  if v_row.status <> 'active' then
    raise exception
      'Beneficiary % is already %.', v_row.beneficiary_number, v_row.status
      using errcode = 'P0001';
  end if;

  select pg_catalog.count(*) into v_live_claims
  from public.benefit_claims c
  where c.membership_id = v_row.membership_id
    and c.claim_type = 'member_bereavement'
    and c.status not in ('draft', 'rejected', 'cancelled');

  if v_live_claims > 0 then
    raise exception
      'A bereavement claim on this membership is under way. The beneficiary cannot be revoked while it is.'
      using errcode = 'P0001';
  end if;

  update public.member_beneficiaries
     set status = 'revoked',
         is_primary = false,
         ended_on = public.business_date(),
         ended_reason = pg_catalog.btrim(p_reason)
   where id = p_beneficiary_id;

  return p_beneficiary_id;
end;
$$;

comment on function public.revoke_member_beneficiary(uuid, text) is
  'Polytos Phase 4. Ends a beneficiary record with a reason, keeping every detail. Refused while a bereavement claim on the membership is live.';

revoke all on function public.revoke_member_beneficiary(uuid, text) from public, anon;
grant execute on function public.revoke_member_beneficiary(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- member_primary_beneficiary()
--
-- The question an assessor asks: is there somebody this business may pay, and
-- what are they to the member. It deliberately returns **no name**: that is
-- the sibling table's, behind `membership:view_sensitive`, and a function that
-- returned it would be a hole straight through the split this migration exists
-- to make.
--
-- SECURITY INVOKER, so the caller's own policies decide whether they see the
-- row at all — ADR-057's rule.
-- ---------------------------------------------------------------------------

create or replace function public.member_primary_beneficiary(p_membership_id uuid)
returns table (
  beneficiary_id uuid,
  beneficiary_number text,
  relationship text,
  verification_status text,
  verified_at timestamptz,
  verified_by_label text
)
language sql
stable
security invoker
set search_path = ''
as $$
  select b.id, b.beneficiary_number, b.relationship,
         b.verification_status, b.verified_at, b.verified_by_label
  from public.member_beneficiaries b
  where b.membership_id = p_membership_id
    and b.status = 'active'
    and b.is_primary
  limit 1;
$$;

comment on function public.member_primary_beneficiary(uuid) is
  'Polytos Phase 4. The live primary beneficiary of a membership and its verification state — one row or none, and no name. SECURITY INVOKER, so a caller sees it only if their own policies let them; the identity is in member_beneficiary_identities behind membership:view_sensitive.';

revoke all on function public.member_primary_beneficiary(uuid) from public, anon;
grant execute on function public.member_primary_beneficiary(uuid) to authenticated;
