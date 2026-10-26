-- ===========================================================================
-- Polytos Phase 4.6 — evidence, and the difference between having it and
-- having checked it
--
-- ## The failure this table is shaped to prevent
--
-- An evidence workflow becomes decorative in one specific way: a file is
-- uploaded, a green tick appears, and the tick means "a file exists". From
-- then on the claim is "documented", nobody has looked at anything, and the
-- business is paying out on photographs.
--
-- So an object in storage and a *verified fact* are two different rows'
-- worth of state here:
--
--   the object exists          → a `benefit_claim_documents` row
--   somebody checked it        → `verification_status = 'verified'`, with
--                                who, when, and against what
--
-- `verification_status` starts at `unchecked` on every row and is never
-- supplied by a caller — the guard overwrites it, the same discipline
-- `membership_terms_acceptances` and `member_beneficiaries` both apply, and
-- for the same reason: a column anybody can assert is not a control. §12 of
-- the brief says a claim must not become financially approved merely because
-- a file exists, and this is the mechanism rather than the aspiration:
-- `assess_benefit_claim` counts **verified** documents of the required kinds,
-- so an unchecked upload moves a claim no further forward than no upload at
-- all.
--
-- ## Checking a document is not approving a claim
--
-- Verification takes `benefits:assess`, not a capability of its own. Checking
-- that an invoice is an invoice is part of assessing, and a separate
-- `benefits:verify_document` would be a fourth key in a four-key chain held
-- by the same hand — the split that matters is assess/approve, and diluting
-- it with a stage nobody independent performs would weaken rather than
-- strengthen it. What *is* enforced is that the person who verified the
-- documents may not be the one who approves the claim, because they are the
-- assessor and `approve_benefit_claim` refuses the assessor.
--
-- ## Why the path is unique, and what that stops
--
-- `object_path` is unique across the table. One object, one metadata row. A
-- forged reference — pointing a second claim's row at a document somebody
-- else uploaded and had verified — is refused by the index before the
-- cross-claim check in the guard ever has to fire, and the guard refuses it
-- again on the path's own membership and claim segments. Two belts, because
-- "verify a document against another member's claim" is the attack with the
-- highest payoff available against a benefits scheme.
--
-- ## Nothing here logs the contents
--
-- The audit trail records that a document of kind `medical_invoice` was
-- attached to claim BC2600001 and later verified by a named officer. It does
-- not record the invoice, the diagnosis, the hospital, the deceased's name or
-- the identity reference. `audit:view` is broader than
-- `membership:view_sensitive`, so an audit row carrying any of that would
-- hand it to everybody who can read the trail — the Phase 3 rule, and it
-- binds hardest here because this is the first phase whose documents are
-- medical.
-- ===========================================================================

create table public.benefit_claim_documents (
  id uuid primary key default pg_catalog.gen_random_uuid(),

  -- A document belongs to a claim, or to a beneficiary record, and never to
  -- both. A beneficiary's relationship evidence outlives any one claim — it
  -- is what makes the *record* verified — so it cannot hang off a claim; and
  -- a hospital invoice means nothing apart from the claim that cites it.
  claim_id uuid references public.benefit_claims(id) on delete restrict,
  beneficiary_id uuid
    references public.member_beneficiaries(id) on delete restrict,

  -- Carried on every row, because every policy on this table scopes by
  -- membership and a policy that had to join two ways to find it would be two
  -- policies. Derived by the guard from whichever parent is set.
  membership_id uuid not null references public.memberships(id) on delete restrict,
  client_id uuid not null references public.clients(id) on delete restrict,

  kind text not null
    references public.benefit_document_kinds(key) on delete restrict,

  -- The object. Unique: one object, one row.
  object_path text not null unique,
  content_type text not null,
  byte_size bigint not null,
  -- What the uploader called the document, for a reader. Never the browser's
  -- filename — `buildBenefitDocumentPath` discards that, because an uploaded
  -- filename is attacker input and because people photograph documents with
  -- phones and the filename often carries the subject's name.
  label text,

  uploaded_at timestamptz not null default pg_catalog.now(),
  uploaded_by uuid references public.profiles(id) on delete set null,
  uploaded_by_label text not null default 'system',

  -- --- Verification ------------------------------------------------------
  --
  -- Derived, never supplied.

  verification_status text not null default 'unchecked',
  verified_at timestamptz,
  verified_by uuid references public.profiles(id) on delete set null,
  verified_by_label text,
  -- What the checker concluded. Internal: it is an officer's working note
  -- about whether a document is genuine, and no approved policy lets a member
  -- read it.
  verification_note text,

  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),

  -- Exactly one parent.
  constraint benefit_document_one_parent
    check ((claim_id is null) <> (beneficiary_id is null)),
  constraint benefit_document_path_shape
    check (
      char_length(object_path) between 20 and 500
      -- The shape the storage policies read: benefits/<membership>/<kind>/
      -- <claim-or-beneficiary>/<object>. Asserted here as well as there,
      -- because a row whose path the policies cannot parse is a row naming a
      -- document nobody can ever fetch.
      and object_path ~
        '^benefits/[0-9a-f-]{36}/[a-z_]+/([0-9a-f-]{36}|beneficiary)/[^/]+$'
    ),
  constraint benefit_document_content_type_valid
    check (
      content_type in (
        'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'
      )
    ),
  -- The bucket's own limit, restated. A row claiming a 90 MB object is a row
  -- describing something that was never stored.
  constraint benefit_document_size_sane
    check (byte_size > 0 and byte_size <= 10485760),
  constraint benefit_document_label_length
    check (label is null or char_length(btrim(label)) between 2 and 200),
  constraint benefit_document_verification_valid
    check (verification_status in ('unchecked', 'verified', 'rejected')),
  -- A checked document names who checked it and when. Both or neither.
  constraint benefit_document_checked_complete
    check (
      (verification_status = 'unchecked')
      = (verified_at is null and verified_by_label is null)
    ),
  -- A rejection says why. A verification need not: the document speaks for
  -- itself, and a mandatory note would be filled with "ok".
  constraint benefit_document_rejected_has_note
    check (verification_status <> 'rejected' or verification_note is not null),
  constraint benefit_document_note_length
    check (
      verification_note is null
      or char_length(btrim(verification_note)) between 3 and 1000
    ),
  constraint benefit_document_labels_not_blank
    check (
      btrim(uploaded_by_label) <> ''
      and (verified_by_label is null or btrim(verified_by_label) <> '')
    )
);

comment on table public.benefit_claim_documents is
  'Polytos Phase 4. Evidence attached to a benefit claim or to a beneficiary record, in the private benefit-documents bucket. A row means an object exists; verification_status means somebody checked it. Assessment counts only the verified ones, so an unchecked upload advances a claim no further than no upload at all.';
comment on column public.benefit_claim_documents.verification_status is
  'Derived, never supplied. Starts unchecked on every row; verify_benefit_document is the only route to verified. A document existing is not a fact being established.';
comment on column public.benefit_claim_documents.object_path is
  'The object in benefit-documents, unique across the table. One object, one row — which is what refuses a second claim pointing at a document somebody else had verified.';
comment on column public.benefit_claim_documents.verification_note is
  'An officer''s working conclusion about whether a document is genuine. Internal: no approved policy discloses an assessor''s reasoning to a member.';

create index benefit_claim_documents_claim_idx
  on public.benefit_claim_documents (claim_id, kind)
  where claim_id is not null;
create index benefit_claim_documents_beneficiary_idx
  on public.benefit_claim_documents (beneficiary_id)
  where beneficiary_id is not null;
create index benefit_claim_documents_membership_idx
  on public.benefit_claim_documents (membership_id);
create index benefit_claim_documents_client_idx
  on public.benefit_claim_documents (client_id);
-- The assessment's own query: has this claim a verified document of each
-- required kind.
create index benefit_claim_documents_verified_idx
  on public.benefit_claim_documents (claim_id, kind)
  where verification_status = 'verified';

create trigger benefit_claim_documents_set_updated_at
  before update on public.benefit_claim_documents
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- The guard
-- ---------------------------------------------------------------------------

create or replace function public.benefit_claim_documents_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claim public.benefit_claims;
  v_beneficiary public.member_beneficiaries;
  v_kind public.benefit_document_kinds;
  v_path_membership uuid;
  v_path_kind text;
  v_path_claim uuid;
begin
  if tg_op = 'INSERT' then
    if new.claim_id is not null then
      select * into v_claim
      from public.benefit_claims where id = new.claim_id;

      if not found then
        raise exception 'No such benefit claim.' using errcode = 'P0001';
      end if;

      -- A decided claim takes no further evidence. Attaching a document to a
      -- claim that has been paid would be attaching it to a decision — and
      -- the decision's evidence is what the snapshot froze, not what somebody
      -- added afterwards.
      if v_claim.status in ('approved', 'paid', 'rejected', 'cancelled', 'reversed') then
        raise exception
          'Claim % is %. Evidence is attached while a claim is open, not after it has been decided.',
          v_claim.claim_number, v_claim.status using errcode = 'P0001';
      end if;

      new.membership_id := v_claim.membership_id;
      new.client_id := v_claim.client_id;

      -- The kind must belong to this claim's type, or to no type. A death
      -- certificate on a medical claim is a filing mistake worth refusing:
      -- the required-document check at assessment reads kinds, so a
      -- misfiled document would be counted for the wrong claim.
      select * into v_kind
      from public.benefit_document_kinds where key = new.kind;

      if v_kind.claim_type is not null and v_kind.claim_type <> v_claim.claim_type then
        raise exception
          'A document of kind "%" belongs to a % claim, not to a % one.',
          new.kind, v_kind.claim_type, v_claim.claim_type using errcode = 'P0001';
      end if;
    else
      select * into v_beneficiary
      from public.member_beneficiaries where id = new.beneficiary_id;

      if not found then
        raise exception 'No such beneficiary record.' using errcode = 'P0001';
      end if;

      if v_beneficiary.status <> 'active' then
        raise exception
          'Beneficiary % is %. Evidence is attached to a live record.',
          v_beneficiary.beneficiary_number, v_beneficiary.status
          using errcode = 'P0001';
      end if;

      new.membership_id := v_beneficiary.membership_id;
      new.client_id := v_beneficiary.client_id;
    end if;

    -- The path must agree with the row. This is the control against a forged
    -- object reference: a caller who points a row at an object under another
    -- membership's folder, or under another claim's, is refused here — and
    -- the storage policies refuse them the object itself, so neither half
    -- works alone.
    v_path_membership := public.storage_path_membership_id(new.object_path);
    v_path_kind := public.storage_path_kind(new.object_path);
    v_path_claim := public.storage_path_claim_id(new.object_path);

    if v_path_membership is distinct from new.membership_id then
      raise exception
        'That object is not in this membership''s evidence folder. A document is filed under the membership it belongs to, and the path is what the storage policies read.'
        using errcode = 'P0001';
    end if;

    if v_path_kind is distinct from new.kind then
      raise exception
        'That object''s path says it is a "%" document, and the record says "%". They must agree — the path is what a reader fetches it by.',
        v_path_kind, new.kind using errcode = 'P0001';
    end if;

    if new.claim_id is not null then
      if v_path_claim is distinct from new.claim_id then
        raise exception
          'That object is filed under a different claim. Evidence for claim % is filed under claim %.',
          new.claim_id, coalesce(v_path_claim::text, '(none)')
          using errcode = 'P0001';
      end if;
    elsif not public.storage_path_is_beneficiary(new.object_path) then
      raise exception
        'A beneficiary document is filed under the `beneficiary` folder of its membership.'
        using errcode = 'P0001';
    end if;

    new.uploaded_by := coalesce(public.current_profile_id(), new.uploaded_by);
    new.uploaded_by_label := public.audit_actor_label();

    -- The whole point of the table. An upload is unchecked.
    new.verification_status := 'unchecked';
    new.verified_at := null;
    new.verified_by := null;
    new.verified_by_label := null;
    new.verification_note := null;

    return new;
  end if;

  -- --- UPDATE ------------------------------------------------------------
  --
  -- Only the verification columns move. The object, its parent, its kind and
  -- its provenance are what the row is.

  if new.id is distinct from old.id
     or new.claim_id is distinct from old.claim_id
     or new.beneficiary_id is distinct from old.beneficiary_id
     or new.membership_id is distinct from old.membership_id
     or new.client_id is distinct from old.client_id
     or new.kind is distinct from old.kind
     or new.object_path is distinct from old.object_path
     or new.content_type is distinct from old.content_type
     or new.byte_size is distinct from old.byte_size
     or new.uploaded_at is distinct from old.uploaded_at
     or new.uploaded_by is distinct from old.uploaded_by
     or new.uploaded_by_label is distinct from old.uploaded_by_label then
    raise exception
      'A document record is not edited. Remove it and attach the replacement — repointing a verified row at a different object is the forgery this constraint exists to refuse.'
      using errcode = 'P0001';
  end if;

  if new.verification_status is distinct from old.verification_status
     and pg_catalog.current_setting('polytos.checking_document', true)
         is distinct from new.id::text then
    raise exception
      'A document''s verification is not set by an update. verify_benefit_document is the only route.'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

comment on function public.benefit_claim_documents_guard() is
  'Polytos Phase 4. Derives the membership and client from the parent, forces an upload unchecked, and refuses a row whose object path does not agree with its membership, its kind and its claim — which is what defeats a forged object reference.';

revoke all on function public.benefit_claim_documents_guard()
  from public, anon, authenticated;

create trigger benefit_claim_documents_guard
  before insert or update on public.benefit_claim_documents
  for each row execute function public.benefit_claim_documents_guard();

-- ---------------------------------------------------------------------------
-- Removing one
--
-- Permitted, but only while the claim is still open and only for an unchecked
-- document — a DELETE policy rather than a blanket refusal, because a
-- mis-attached file on a draft is a thing people need to undo. A *verified*
-- document is evidence somebody acted on, and `reject_mutation` is not what
-- refuses it: the guard below is, with a message saying why.
-- ---------------------------------------------------------------------------

create or replace function public.benefit_claim_documents_delete_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  if old.verification_status <> 'unchecked' then
    raise exception
      'That document has been %. Evidence somebody has checked is part of the record and is not removed; attach a corrected document instead.',
      old.verification_status using errcode = 'P0001';
  end if;

  if old.claim_id is not null then
    select status into v_status
    from public.benefit_claims where id = old.claim_id;

    if v_status not in ('draft', 'submitted', 'under_verification',
                        'information_required') then
      raise exception
        'That claim is %. Evidence is removed while a claim is open.', v_status
        using errcode = 'P0001';
    end if;
  end if;

  return old;
end;
$$;

comment on function public.benefit_claim_documents_delete_guard() is
  'Polytos Phase 4. Lets an unchecked document be removed from an open claim, and refuses the removal of one somebody has already checked.';

revoke all on function public.benefit_claim_documents_delete_guard()
  from public, anon, authenticated;

create trigger benefit_claim_documents_delete_guard
  before delete on public.benefit_claim_documents
  for each row execute function public.benefit_claim_documents_delete_guard();

-- ---------------------------------------------------------------------------
-- attach_benefit_document()
--
-- The metadata write. The *object* is uploaded by the caller's own session
-- through the storage policies below — so the two halves are authorised
-- independently, and neither is enough on its own.
-- ---------------------------------------------------------------------------

create or replace function public.attach_benefit_document(
  p_claim_id uuid,
  p_beneficiary_id uuid,
  p_kind text,
  p_object_path text,
  p_content_type text,
  p_byte_size bigint,
  p_label text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_objects integer;
begin
  if public.current_profile_id() is null and auth.uid() is not null then
    raise exception
      'A document must be attached by a signed-in member of staff.'
      using errcode = 'P0001';
  end if;

  -- Claim evidence takes `benefits:claim` — the person taking the documents
  -- over the counter. Beneficiary evidence takes `beneficiaries:manage`, for
  -- the same reason: whoever may record the beneficiary may bring its paper.
  if auth.uid() is not null then
    if p_claim_id is not null then
      if not public.user_has_permission('benefits:claim') then
        raise exception
          'Attaching claim evidence requires the benefits:claim capability.'
          using errcode = 'P0001';
      end if;
    elsif not public.user_has_permission('beneficiaries:manage') then
      raise exception
        'Attaching beneficiary evidence requires the beneficiaries:manage capability.'
        using errcode = 'P0001';
    end if;
  end if;

  -- The object must be there. A metadata row naming a file nobody uploaded is
  -- the decorative-evidence failure in its purest form: the claim would look
  -- documented and there would be nothing to look at.
  select pg_catalog.count(*) into v_objects
  from storage.objects o
  where o.bucket_id = 'benefit-documents' and o.name = p_object_path;

  if v_objects = 0 then
    raise exception
      'There is no such object in the evidence bucket. Upload the document first — a record naming a file nobody uploaded documents nothing.'
      using errcode = 'P0001';
  end if;

  insert into public.benefit_claim_documents (
    claim_id, beneficiary_id, membership_id, client_id,
    kind, object_path, content_type, byte_size, label
  )
  values (
    p_claim_id, p_beneficiary_id,
    -- Placeholders: the guard derives both from the parent.
    '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000',
    p_kind, p_object_path, p_content_type, p_byte_size,
    nullif(pg_catalog.btrim(coalesce(p_label, '')), '')
  )
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.attach_benefit_document(uuid, uuid, text, text, text, bigint, text) is
  'Polytos Phase 4. Records an uploaded document against a claim or a beneficiary, unchecked, having first confirmed the object is really in the bucket. The object itself is written by the caller''s own session through the storage policies, so the two halves are authorised independently.';

revoke all on function public.attach_benefit_document(uuid, uuid, text, text, text, bigint, text)
  from public, anon;
grant execute on function public.attach_benefit_document(uuid, uuid, text, text, text, bigint, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- verify_benefit_document()
--
-- Somebody looked at it. Takes `benefits:assess`, because checking an invoice
-- is part of assessing — see the header.
-- ---------------------------------------------------------------------------

create or replace function public.verify_benefit_document(
  p_document_id uuid,
  p_verified boolean,
  p_note text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row public.benefit_claim_documents;
  v_actor uuid;
  v_label text;
  v_claim_status text;
begin
  v_actor := public.current_profile_id();
  v_label := public.audit_actor_label();

  if v_actor is null and auth.uid() is not null then
    raise exception
      'A document must be checked by a signed-in member of staff.'
      using errcode = 'P0001';
  end if;

  if auth.uid() is not null and not public.user_has_permission('benefits:assess') then
    raise exception
      'Checking benefit evidence requires the benefits:assess capability.'
      using errcode = 'P0001';
  end if;

  select * into v_row
  from public.benefit_claim_documents where id = p_document_id for update;

  if not found then
    raise exception 'No such document record.' using errcode = 'P0001';
  end if;

  if v_row.verification_status <> 'unchecked' then
    raise exception
      'That document has already been %. A conclusion about a piece of evidence is not revised in place; attach a corrected document.',
      v_row.verification_status using errcode = 'P0001';
  end if;

  -- The person who brought the document in is not the person who attests to
  -- it. The same control as the beneficiary's, and the same reason: a claim
  -- whose evidence was uploaded and verified by one hand has had no check at
  -- all.
  if (v_actor is not null and v_row.uploaded_by = v_actor)
     or (v_row.uploaded_by is null and v_row.uploaded_by_label = v_label) then
    raise exception
      'You attached that document. Somebody else must check it — evidence uploaded and attested by one person is evidence nobody checked.'
      using errcode = 'P0001';
  end if;

  if v_row.claim_id is not null then
    select status into v_claim_status
    from public.benefit_claims where id = v_row.claim_id;

    if v_claim_status not in ('submitted', 'under_verification',
                              'information_required') then
      raise exception
        'That claim is %. Evidence is checked while the claim is under verification.',
        v_claim_status using errcode = 'P0001';
    end if;
  end if;

  if not p_verified and coalesce(pg_catalog.btrim(p_note), '') = '' then
    raise exception
      'Refusing a document needs a reason. Somebody will have to ask for a replacement.'
      using errcode = 'P0001';
  end if;

  perform pg_catalog.set_config('polytos.checking_document', p_document_id::text, true);

  update public.benefit_claim_documents
     set verification_status = case when p_verified then 'verified' else 'rejected' end,
         verified_at = pg_catalog.now(),
         verified_by = v_actor,
         verified_by_label = v_label,
         verification_note = nullif(pg_catalog.btrim(coalesce(p_note, '')), '')
   where id = p_document_id;

  perform pg_catalog.set_config('polytos.checking_document', '', true);

  return p_document_id;
end;
$$;

comment on function public.verify_benefit_document(uuid, boolean, text) is
  'Polytos Phase 4. Records that somebody checked a piece of evidence, or refused it with a reason. Refuses a check from whoever attached the document, and only while the claim is under verification.';

revoke all on function public.verify_benefit_document(uuid, boolean, text) from public, anon;
grant execute on function public.verify_benefit_document(uuid, boolean, text) to authenticated;

-- ===========================================================================
-- The storage policies
--
-- Written to be correct against a caller who has bypassed the application
-- entirely and is talking to the storage API with their own token. Each one
-- reads the path, because the path is the only thing a policy has.
-- ===========================================================================

-- Reading. `benefits:view` **and** visibility of the membership itself: the
-- EXISTS runs under the reader's own policies, so branch scoping and the
-- member's own identity clause both apply here exactly as they do on the
-- claim screen.
--
-- A member reads their own evidence — the invoice they handed in — through
-- the same EXISTS, because `memberships` is visible to them through
-- `clients.profile_id`. They do not read the *assessment attachments*: see
-- below.
create policy benefit_documents_read
  on storage.objects for select to authenticated
  using (
    bucket_id = 'benefit-documents'
    and public.storage_path_kind(name) is not null
    -- Assessment working papers and authorisation documents are internal. A
    -- member who may fetch their own invoice may not fetch the officer's
    -- working note about it, and no approved policy says otherwise.
    and (
      (select public.user_has_permission('benefits:assess'))
      or public.storage_path_kind(name)
         not in ('assessment_attachment', 'authorisation_document')
    )
    and exists (
      select 1 from public.memberships m
      where m.id = public.storage_path_membership_id(name)
    )
    and (
      (select public.user_has_permission('benefits:view'))
      or exists (
        select 1
        from public.memberships m
        join public.clients c on c.id = m.client_id
        where m.id = public.storage_path_membership_id(name)
          and c.profile_id is not null
          and c.profile_id = (select public.current_profile_id())
      )
    )
  );

comment on policy benefit_documents_read on storage.objects is
  'Polytos Phase 4. Staff holding benefits:view read evidence for a membership they can see; a member reads their own through clients.profile_id. Assessment working papers and authorisation documents need benefits:assess, because an officer''s reasoning is not disclosed to the member it is about.';

-- Writing. The kind must be a kind, the path must name a membership that
-- exists, and the caller must hold the capability for what they are filing.
--
-- There is no requirement here that the claim be open: that is the metadata
-- guard's job, and duplicating it would mean a claim's state was asserted in
-- two places that could disagree. An orphan object with no metadata row
-- documents nothing and is reachable by nobody — it fails the claim's
-- document check, because the check counts rows.
create policy benefit_documents_write
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'benefit-documents'
    and (
      (select public.user_has_permission('benefits:claim'))
      or (select public.user_has_permission('beneficiaries:manage'))
      or (select public.user_has_permission('benefits:assess'))
    )
    and exists (
      select 1 from public.benefit_document_kinds k
      where k.key = public.storage_path_kind(name)
    )
    -- An assessment working paper or an authorisation document may only be
    -- filed by somebody who assesses. A counter clerk cannot manufacture the
    -- paperwork that would make a claim look authorised.
    and (
      public.storage_path_kind(name)
        not in ('assessment_attachment', 'authorisation_document')
      or (select public.user_has_permission('benefits:assess'))
    )
    and (
      public.storage_path_claim_id(name) is not null
      or public.storage_path_is_beneficiary(name)
    )
    and exists (
      select 1 from public.memberships m
      where m.id = public.storage_path_membership_id(name)
    )
  );

comment on policy benefit_documents_write on storage.objects is
  'Polytos Phase 4. An object may be written only under a membership the caller can see, with a recognised kind, by somebody holding the capability for what they are filing. Working papers and authorisation documents need benefits:assess.';

-- Removing. Only by whoever may attach, and only where no metadata row has
-- been checked — the same rule the metadata delete guard applies, expressed
-- against the object so that deleting the file and deleting the row are
-- refused together.
create policy benefit_documents_remove
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'benefit-documents'
    and (
      (select public.user_has_permission('benefits:claim'))
      or (select public.user_has_permission('beneficiaries:manage'))
    )
    and not exists (
      select 1 from public.benefit_claim_documents d
      where d.object_path = storage.objects.name
        and d.verification_status <> 'unchecked'
    )
    and exists (
      select 1 from public.memberships m
      where m.id = public.storage_path_membership_id(name)
    )
  );

comment on policy benefit_documents_remove on storage.objects is
  'Polytos Phase 4. An object may be removed by whoever may attach one, and never once its metadata row has been checked — so deleting the file and deleting the record are refused together.';
