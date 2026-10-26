-- ===========================================================================
-- Polytos Phase 4.3 — the private bucket benefit evidence lives in
--
-- ## Why the bucket comes before the tables that use it
--
-- Both the beneficiary table and the claim table verify evidence by checking
-- that a named object **actually exists** in this bucket under the right
-- membership's path. That check is the difference between "somebody typed a
-- filename" and "somebody uploaded a document", and it is the same technique
-- `membership_consent_evidence` introduced in Phase 2.
--
-- So the bucket and the two functions that read a path are created first, and
-- everything after them can rely on both.
--
-- ## The path shape, and why it is a shape rather than a convention
--
--     benefits/<membership_id>/<kind>/<claim_id-or-'beneficiary'>/<object>
--
-- Scope, then owner, then kind is exactly what `client-documents`,
-- `guarantor-documents`, `loan-documents` and `membership-consent` all do,
-- and the reason is that it makes the storage policies **expressible as a
-- predicate** rather than as a convention somebody has to remember. A policy
-- can say "the membership in segment two must be one the caller may see"; it
-- cannot say "please name your files sensibly".
--
-- So the first three segments are read by functions that already exist:
-- `storage_path_membership_id` (segment two, from Phase 2) and
-- `storage_path_kind` (segment three, from Phase 1). Reused rather than
-- rewritten — one answer to "which membership does this object belong to",
-- not two that could drift.
--
-- Benefits need one segment more than any earlier bucket, because evidence
-- belongs to a **claim** as well as to a membership, and a claim's documents
-- must not be reachable from another claim on the same member. That is
-- segment four: a claim id for claim evidence, and the literal `beneficiary`
-- for a relationship document attached to a beneficiary record rather than
-- to a claim. A path whose fourth segment is neither yields NULL from both
-- functions below, which denies every policy that reads them.
--
-- ## Private, and the size and type limits
--
-- Private, like every bucket in this project: a signed URL with a short life,
-- never a public object. Medical documents and death certificates are the
-- most sensitive material this system will ever hold, and a public bucket
-- would make a leak a matter of guessing a UUID.
--
-- 10 MiB and the same five media types as every other bucket here. A
-- photograph of an admission form or an invoice needs no more room than a
-- national ID scan, and the list deliberately excludes anything executable,
-- any archive and any Office format — a document the business must be able to
-- read on a phone at a counter is an image or a PDF.
-- ===========================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'benefit-documents',
  'benefit-documents',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf']
)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- The fourth path segment: the claim, or `beneficiary`
-- ---------------------------------------------------------------------------

create or replace function public.storage_path_claim_id(p_name text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case
    when (pg_catalog.string_to_array(p_name, '/'))[4] ~
         '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then ((pg_catalog.string_to_array(p_name, '/'))[4])::uuid
  end;
$$;

comment on function public.storage_path_claim_id(text) is
  'Polytos Phase 4. The benefit claim a benefit-documents object belongs to, taken from segment four of its path. NULL when that segment is not a UUID — which is the case for a beneficiary relationship document, and which denies every claim-scoped policy.';

revoke all on function public.storage_path_claim_id(text) from public, anon;
grant execute on function public.storage_path_claim_id(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Whether the path says `beneficiary` in segment four
--
-- A separate function rather than an inline comparison, so the literal exists
-- in exactly one place and the storage policies and the verification
-- functions cannot disagree about its spelling.
-- ---------------------------------------------------------------------------

create or replace function public.storage_path_is_beneficiary(p_name text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select (pg_catalog.string_to_array(p_name, '/'))[4] = 'beneficiary';
$$;

comment on function public.storage_path_is_beneficiary(text) is
  'Polytos Phase 4. Whether a benefit-documents object is attached to a beneficiary record rather than to a claim — segment four reads `beneficiary`. One spelling, in one place.';

revoke all on function public.storage_path_is_beneficiary(text) from public, anon;
grant execute on function public.storage_path_is_beneficiary(text) to authenticated;

-- ---------------------------------------------------------------------------
-- The document kinds
--
-- A closed list, used by the metadata table, by the storage INSERT policy
-- (through `storage_path_kind`, which reads segment three) and by the forms. A
-- kind is **what the document is said to be**, which is not the same as what
-- it proves: `verification_status` on the metadata row is a separate column
-- set by a separate act, because a file existing is not a fact being
-- established. §12 of the brief is explicit about this, and it is the single
-- most common way an evidence workflow becomes decorative.
-- ---------------------------------------------------------------------------

create table public.benefit_document_kinds (
  key text primary key,
  label text not null,
  -- Which claim type this kind of document belongs to, or NULL for one that
  -- any claim may carry. Not a foreign key, because claim types are a CHECK
  -- constraint rather than a table — the same shape payment methods take.
  claim_type text,
  sort_order smallint not null,
  -- Whether a claim of that type cannot be assessed without one. Enforced in
  -- `assess_benefit_claim`, listed here so the form can mark it required and
  -- the two cannot disagree.
  is_required_for_assessment boolean not null default false,

  constraint benefit_document_kind_key_shape check (key ~ '^[a-z][a-z0-9_]*$'),
  constraint benefit_document_kind_label_not_blank check (btrim(label) <> ''),
  constraint benefit_document_kind_claim_type_valid
    check (
      claim_type is null
      or claim_type in ('medical', 'family_condolence', 'member_bereavement')
    )
);

comment on table public.benefit_document_kinds is
  'Polytos Phase 4. What a benefit evidence document may be said to be, and whether a claim of its type cannot be assessed without one. A kind says what a document claims to be; benefit_claim_documents.verification_status says whether anybody checked.';

insert into public.benefit_document_kinds
  (key, label, claim_type, sort_order, is_required_for_assessment)
values
  -- Medical. The admission evidence and the invoice are both required,
  -- because the two facts a medical claim rests on are *that the member was
  -- admitted for long enough* and *what the bill was* — and no single
  -- document reliably carries both.
  ('hospital_admission', 'Hospital admission record', 'medical', 10, true),
  ('hospital_discharge', 'Hospital discharge record', 'medical', 20, false),
  ('medical_invoice', 'Hospital invoice or bill', 'medical', 30, true),
  ('medical_report', 'Medical report', 'medical', 40, false),

  -- Family condolence. The death of the family member, and the relationship.
  -- Both required: either alone proves half of the claim.
  ('family_death_evidence', 'Evidence of the family member''s death',
   'family_condolence', 50, true),
  ('relationship_evidence', 'Evidence of the family relationship',
   'family_condolence', 60, true),

  -- Member bereavement. The member's death. The beneficiary's own
  -- verification is on the beneficiary record, not here, which is why there
  -- is no required beneficiary document on the claim.
  ('member_death_evidence', 'Evidence of the member''s death',
   'member_bereavement', 70, true),
  ('burial_permit', 'Burial permit', 'member_bereavement', 80, false),

  -- Any claim.
  ('beneficiary_verification', 'Beneficiary verification document', null, 90, false),
  ('assessment_attachment', 'Assessment working paper', null, 100, false),
  ('authorisation_document', 'Authorisation document', null, 110, false),
  ('payment_receipt', 'Signed payment receipt', null, 120, false),
  ('supporting', 'Other supporting document', null, 130, false)
on conflict (key) do update set
  label = excluded.label,
  claim_type = excluded.claim_type,
  sort_order = excluded.sort_order,
  is_required_for_assessment = excluded.is_required_for_assessment;

-- A reference vocabulary a form has to render, so it is readable by any
-- signed-in user: a list of document names discloses nothing about any
-- person. Revoked bare first, because CREATE TABLE in this database inherits
-- default privileges that hand `authenticated` everything including DELETE —
-- the discipline every table here follows.
revoke all on table public.benefit_document_kinds from anon, authenticated;
grant select on table public.benefit_document_kinds to authenticated;

alter table public.benefit_document_kinds enable row level security;

create policy benefit_document_kinds_select
  on public.benefit_document_kinds for select to authenticated using (true);

comment on policy benefit_document_kinds_select on public.benefit_document_kinds is
  'Readable by any signed-in user. A list of document names discloses nothing about any person, and every claim form has to render it.';
