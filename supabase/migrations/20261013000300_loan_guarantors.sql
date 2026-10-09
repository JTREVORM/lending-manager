-- ===========================================================================
-- Phase 13.3 — guarantors, captured on the application they guarantee
--
-- Until now a guarantor belonged to a *client*: `client_guarantors` attaches
-- a person to a borrower, and approval snapshotted whoever happened to be
-- attached at that moment. That is the directory of a borrower's backers, and
-- it is useful. What it cannot say is **who guaranteed this loan** — a
-- borrower with three loans and a changing circle of backers has one list,
-- and the snapshot of loan two already disagrees with it.
--
-- So the two are separated, and each means one thing:
--
--   * `client_guarantors` — the client's known backers. The directory the
--     application offers as candidates. Unchanged.
--   * `loan_guarantors` — who guaranteed *this* application, with the consent
--     they signed. New, and the source of truth for a loan.
--
-- ## Two ways to be a guarantor, and only one identity record either way
--
-- Option A is an existing client: somebody already in `clients`, with their
-- own identity record, their own NIN and their own history. They are
-- referenced, never copied — a second identity record for the same person is
-- how a register comes to hold two of somebody with different phone numbers.
--
-- Option B is an external person: somebody who is not a borrower, held in
-- `guarantors`.
--
-- Exactly one of the two, enforced by a CHECK. A row that named both would be
-- a row where "who is this" has two answers.
--
-- ## The consent is a document, not a checkbox
--
-- A guarantor is agreeing to pay somebody else's debt. What makes that
-- enforceable is that they were shown terms, those terms had a version, and
-- they signed in front of a witness on a date. All four are recorded, the
-- terms text itself is a row rather than a string in a template, and the
-- version is copied onto the loan's snapshot at approval — so a guarantor
-- cannot be held to terms the business edited afterwards.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The terms a guarantor signs
-- ---------------------------------------------------------------------------

create table public.guarantor_consent_terms (
  id uuid primary key default gen_random_uuid(),

  version text not null unique,
  title text not null,
  body text not null,
  effective_from date not null,
  -- The version a new consent is taken under. Exactly one, so no screen has
  -- to decide which of two current versions it meant.
  is_current boolean not null default false,

  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),

  constraint guarantor_terms_version_shape check (version ~ '^[0-9]+\.[0-9]+$'),
  constraint guarantor_terms_title_not_blank check (btrim(title) <> ''),
  -- Long enough to be terms rather than a sentence. The seeded version below
  -- is about 1,500 characters.
  constraint guarantor_terms_body_length check (char_length(btrim(body)) >= 200)
);

create unique index guarantor_consent_terms_one_current
  on public.guarantor_consent_terms ((true)) where is_current;

comment on table public.guarantor_consent_terms is
  'Phase 13. The versioned terms a guarantor signs. Append a new version rather than editing one in force: a consent records which version it was given, and a guarantor cannot be held to words the business changed afterwards.';

create trigger guarantor_consent_terms_set_updated_at
  before update on public.guarantor_consent_terms
  for each row execute function public.set_updated_at();

-- The body of a version that has been signed is evidence. It may be retired
-- (`is_current = false`) but never reworded.
create or replace function public.guarantor_consent_terms_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.version is distinct from old.version
     or new.body is distinct from old.body
     or new.effective_from is distinct from old.effective_from then
    if exists (
      select 1 from public.loan_guarantors lg where lg.consent_terms_id = old.id
    ) then
      raise exception
        'Version % has been signed. Publish a new version instead of rewording this one.',
        old.version using errcode = 'P0001';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.guarantor_consent_terms_guard() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Who guaranteed this loan
-- ---------------------------------------------------------------------------

create table public.loan_guarantors (
  id uuid primary key default gen_random_uuid(),
  loan_id uuid not null references public.loans(id) on delete restrict,

  -- Exactly one of these two. Option A references a client; option B
  -- references an external guarantor record.
  guarantor_id uuid references public.guarantors(id) on delete restrict,
  guarantor_client_id uuid references public.clients(id) on delete restrict,

  relationship_to_client text not null,

  -- --- The consent -------------------------------------------------------
  consent_terms_id uuid references public.guarantor_consent_terms(id) on delete restrict,
  -- Denormalised on purpose: the version is what a printed form shows and
  -- what an auditor reads, and it must survive the terms row being retired.
  consent_version text,
  consented_at timestamptz,
  -- Who signed, as they signed it. Not a lookup: the point of a signature is
  -- that it is the name the person wrote.
  signature_name text,
  -- An uploaded image of the signature, where one was taken. A path under the
  -- private documents bucket, never a URL.
  signature_path text,
  witness_name text,
  witness_phone text,
  consent_place text,

  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),

  constraint loan_guarantors_one_subject
    check ((guarantor_id is not null) <> (guarantor_client_id is not null)),
  constraint loan_guarantors_relationship_not_blank
    check (btrim(relationship_to_client) <> ''),

  -- A consent is all of its parts or none of them. A row with a date and no
  -- signatory, or a signatory and no witness, is not a consent anybody could
  -- rely on — and "partially signed" is not a state the business recognises.
  constraint loan_guarantors_consent_complete
    check (
      (consent_terms_id is null and consent_version is null and consented_at is null
       and signature_name is null and witness_name is null)
      or
      (consent_terms_id is not null and consent_version is not null
       and consented_at is not null
       and btrim(coalesce(signature_name, '')) <> ''
       and btrim(coalesce(witness_name, '')) <> '')
    ),
  constraint loan_guarantors_signature_path_shape
    check (signature_path is null
           or (signature_path !~ '^/' and signature_path !~ '\.\.')),
  constraint loan_guarantors_consent_not_future
    check (consented_at is null or consented_at <= pg_catalog.now())
);

-- One appearance each per loan, whichever kind of subject it is.
create unique index loan_guarantors_unique_external
  on public.loan_guarantors (loan_id, guarantor_id) where guarantor_id is not null;
create unique index loan_guarantors_unique_client
  on public.loan_guarantors (loan_id, guarantor_client_id)
  where guarantor_client_id is not null;

create index loan_guarantors_loan_idx on public.loan_guarantors (loan_id);
create index loan_guarantors_guarantor_idx on public.loan_guarantors (guarantor_id);
create index loan_guarantors_client_idx on public.loan_guarantors (guarantor_client_id);

comment on table public.loan_guarantors is
  'Phase 13. Who guaranteed a particular loan, and the consent they signed. The source of truth for a loan''s guarantors; client_guarantors remains the borrower''s directory of backers.';

create trigger loan_guarantors_set_updated_at
  before update on public.loan_guarantors
  for each row execute function public.set_updated_at();

create trigger guarantor_consent_terms_guard
  before update on public.guarantor_consent_terms
  for each row execute function public.guarantor_consent_terms_guard();

-- ---------------------------------------------------------------------------
-- The loans that already exist
--
-- 33 of them, and every one was guaranteed by whoever was attached to the
-- borrower at the time. For the 28 past approval that is recorded in
-- `loan_guarantor_snapshots`, which is the evidence of what the business
-- actually relied on — so the backfill reads the snapshot, not the current
-- state of the client's register, which may since have changed.
--
-- The remaining applications (drafts and pending) are backfilled from the
-- client's active register, because that is what an approval today would
-- have used and it is what the new screens will show.
--
-- Consent is left null throughout, deliberately: those undertakings were
-- signed on paper, before this phase existed, and a version number invented
-- for them would be evidence of something that did not happen. The approval
-- validator requires consent only where a guarantor row has none *and* the
-- loan is being approved from now on.
--
-- ## Why this runs before the triggers below are created
--
-- `loan_guarantors_check_eligibility` refuses a guarantor on a loan that is
-- not a draft, which is right for every write the application makes and wrong
-- for exactly these rows: they belong to loans that were approved, disbursed
-- and in most cases repaid. A trigger fires for the table's owner as readily
-- as for anybody else, so there is no privilege that exempts a backfill —
-- the only honest way to write history is to write it before the rule that
-- governs the future exists. Order inside a migration is the lever, and this
-- is what it is for.
-- ---------------------------------------------------------------------------

do $backfill$
declare
  r record;
begin
  -- From the snapshots, for loans already past approval.
  for r in
    select s.loan_id, s.guarantor_id, s.relationship_to_client
    from public.loan_guarantor_snapshots s
    join public.loans l on l.id = s.loan_id
    where s.guarantor_id is not null
  loop
    insert into public.loan_guarantors
      (loan_id, guarantor_id, relationship_to_client)
    values
      (r.loan_id, r.guarantor_id,
       coalesce(nullif(pg_catalog.btrim(r.relationship_to_client), ''), 'not recorded'))
    on conflict do nothing;
  end loop;

  -- From the client's register, for applications not yet decided.
  for r in
    select l.id as loan_id, cg.guarantor_id, cg.relationship_to_client
    from public.loans l
    join public.client_guarantors cg on cg.client_id = l.client_id and cg.active
    where l.status in ('draft', 'pending_approval')
  loop
    insert into public.loan_guarantors
      (loan_id, guarantor_id, relationship_to_client)
    values
      (r.loan_id, r.guarantor_id,
       coalesce(nullif(pg_catalog.btrim(r.relationship_to_client), ''), 'not recorded'))
    on conflict do nothing;
  end loop;
end
$backfill$;

-- ---------------------------------------------------------------------------
-- Eligibility rules, where the business sets them
-- ---------------------------------------------------------------------------

alter table public.business_settings
  add column allow_client_as_guarantor boolean not null default true,
  add column guarantor_min_age_years smallint not null default 18,
  add column guarantor_max_active_loans smallint not null default 2;

comment on column public.business_settings.allow_client_as_guarantor is
  'Phase 13. Whether an existing borrower may guarantee somebody else''s loan. Off makes every guarantor an external person.';
comment on column public.business_settings.guarantor_min_age_years is
  'Phase 13. The age a guarantor must have reached. Checked against the date of birth on whichever record names them.';
comment on column public.business_settings.guarantor_max_active_loans is
  'Phase 13. How many active loans one person may guarantee at once. A guarantor standing behind six loans is a concentration nobody chose.';

alter table public.business_settings add constraint business_settings_guarantor_age_sane
  check (guarantor_min_age_years between 16 and 80);

alter table public.business_settings add constraint business_settings_guarantor_load_sane
  check (guarantor_max_active_loans between 1 and 20);

-- ---------------------------------------------------------------------------
-- Eligibility, enforced
--
-- Every rule here is about *this* person and *this* loan, so it is checked
-- when the row is written and again — by the approval validator — at the
-- moment of the decision. Checking only at write time would let a guarantor
-- blacklisted the next day sail through approval.
-- ---------------------------------------------------------------------------

create or replace function public.loan_guarantors_check_eligibility()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_loan      public.loans;
  v_settings  public.business_settings;
  v_dob       date;
  v_name      text;
  v_backing   integer;
begin
  select * into v_loan from public.loans where id = new.loan_id;

  if v_loan.id is null then
    raise exception 'No such loan.' using errcode = 'P0001';
  end if;

  -- Guarantors are part of the application, so they are added to one.
  if v_loan.status <> 'draft' then
    raise exception
      'Guarantors cannot be changed on a % loan. They are part of the application.',
      v_loan.status using errcode = 'P0001';
  end if;

  select * into v_settings from public.business_settings where id = 1;

  -- --- Option A: an existing client -------------------------------------
  if new.guarantor_client_id is not null then
    if not v_settings.allow_client_as_guarantor then
      raise exception
        'The business does not permit a borrower to guarantee another borrower''s loan.'
        using errcode = 'P0001';
    end if;

    if new.guarantor_client_id = v_loan.client_id then
      raise exception 'A borrower cannot guarantee their own loan.'
        using errcode = 'P0001';
    end if;

    select c.date_of_birth, c.full_name into v_dob, v_name
    from public.clients c where c.id = new.guarantor_client_id;

    if v_name is null then
      raise exception 'No such client.' using errcode = 'P0001';
    end if;

    -- The guarantor's own standing matters: somebody the business has
    -- blacklisted is not somebody it will rely on.
    if not exists (
      select 1 from public.clients c
      where c.id = new.guarantor_client_id and c.status = 'active'
    ) then
      raise exception '% is not an active client and cannot guarantee a loan.', v_name
        using errcode = 'P0001';
    end if;
  else
    select g.date_of_birth, g.full_name into v_dob, v_name
    from public.guarantors g where g.id = new.guarantor_id;

    if v_name is null then
      raise exception 'No such guarantor.' using errcode = 'P0001';
    end if;

    if exists (
      select 1 from public.guarantors g
      where g.id = new.guarantor_id and g.archived_at is not null
    ) then
      raise exception '% has been archived and cannot guarantee a loan.', v_name
        using errcode = 'P0001';
    end if;
  end if;

  -- --- Age ---------------------------------------------------------------
  if v_dob is not null
     and v_dob > (current_date - (v_settings.guarantor_min_age_years || ' years')::interval) then
    raise exception
      '% is under %, the age the business requires of a guarantor.',
      v_name, v_settings.guarantor_min_age_years using errcode = 'P0001';
  end if;

  -- --- Concentration -----------------------------------------------------
  -- How many *active* loans this person already stands behind. Applications
  -- and cleared loans do not count: the first is not yet an exposure and the
  -- second no longer is.
  select pg_catalog.count(*) into v_backing
  from public.loan_guarantors lg
  join public.loans l on l.id = lg.loan_id
  where l.status = 'active'
    and lg.id is distinct from new.id
    and (
      (new.guarantor_id is not null and lg.guarantor_id = new.guarantor_id)
      or (new.guarantor_client_id is not null
          and lg.guarantor_client_id = new.guarantor_client_id)
    );

  if v_backing >= v_settings.guarantor_max_active_loans then
    raise exception
      '% already guarantees % active loans, which is the limit the business permits.',
      v_name, v_backing using errcode = 'P0001';
  end if;

  return new;
end;
$$;

comment on function public.loan_guarantors_check_eligibility() is
  'Phase 13. Applies the business''s guarantor rules when a guarantor is attached to an application: who may act, how old they must be, and how many active loans one person may stand behind.';

revoke all on function public.loan_guarantors_check_eligibility()
  from public, anon, authenticated;

-- `update of <columns>` rather than a bare `update`, and the column list is
-- the application: who the guarantor is, how they are related, and the
-- consent. Approval writes the frozen `snapshot_*` columns on the same row
-- while the loan is `pending_approval`, and a bare UPDATE trigger refused it
-- — the rule meant "the application cannot change", not "nothing on this row
-- may ever be written again". Found by approving a loan.
create trigger loan_guarantors_check_eligibility
  before insert or update of
    guarantor_id, guarantor_client_id, relationship_to_client,
    consent_terms_id, consent_version, consented_at,
    signature_name, signature_path, witness_name, witness_phone, consent_place
  on public.loan_guarantors
  for each row execute function public.loan_guarantors_check_eligibility();

-- A guarantor may be removed from an application while it is a draft, and
-- never afterwards: the loan was agreed on the strength of them.
create or replace function public.loan_guarantors_guard_removal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  select l.status into v_status from public.loans l where l.id = old.loan_id;

  if v_status is not null and v_status <> 'draft' then
    raise exception
      'A guarantor cannot be removed from a % loan. The loan was agreed on the strength of them.',
      v_status using errcode = 'P0001';
  end if;

  return old;
end;
$$;

revoke all on function public.loan_guarantors_guard_removal()
  from public, anon, authenticated;

create trigger loan_guarantors_guard_removal
  before delete on public.loan_guarantors
  for each row execute function public.loan_guarantors_guard_removal();

create or replace function public.loan_guarantors_stamp_actor()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(public.current_profile_id(), new.created_by);
  else
    new.created_by := old.created_by;
    new.loan_id := old.loan_id;
  end if;

  return new;
end;
$$;

revoke all on function public.loan_guarantors_stamp_actor() from public, anon, authenticated;

create trigger loan_guarantors_stamp_actor
  before insert or update on public.loan_guarantors
  for each row execute function public.loan_guarantors_stamp_actor();

-- ---------------------------------------------------------------------------
-- The snapshot widens to carry the consent
--
-- `loan_guarantor_snapshots` has recorded who guaranteed a loan since
-- Phase 4. What it could not record is what they signed, because there was
-- nothing to record. These columns are nullable for exactly one reason,
-- stated here so nobody later makes them NOT NULL and breaks the history:
-- the 28 loans approved before this phase were guaranteed on paper, and
-- inventing a version number for them would be inventing evidence.
-- ---------------------------------------------------------------------------

-- `on delete restrict`, matching the `guarantor_id` column beside them and
-- never `set null`. A referential action of SET NULL is implemented as an
-- UPDATE against this table, and the append-only guard here is
-- statement-level: it fires when such an UPDATE *starts*, whether or not any
-- row matches. Adding a SET NULL reference therefore made deleting any
-- client fail with "loan_guarantor_snapshots is append-only", which is how
-- this was found — every teardown in the test suite broke at once.
alter table public.loan_guarantor_snapshots
  add column subject_kind text,
  add column subject_client_id uuid references public.clients(id) on delete restrict,
  add column consent_terms_id uuid references public.guarantor_consent_terms(id) on delete restrict,
  add column consent_version text,
  add column consented_at timestamptz,
  add column signature_name text,
  add column witness_name text;

comment on column public.loan_guarantor_snapshots.subject_kind is
  'Phase 13. Whether this guarantor was an external person or an existing client. Null on a snapshot captured before Phase 13, when every guarantor came from the client register.';
comment on column public.loan_guarantor_snapshots.consent_version is
  'Phase 13. The version of the guarantor terms this person signed, frozen. Null where the consent was taken on paper before this phase.';

alter table public.loan_guarantor_snapshots
  add constraint loan_guarantor_snapshots_subject_kind_valid
  check (subject_kind is null or subject_kind in ('external', 'client'));

-- ---------------------------------------------------------------------------
-- The first version of the terms
--
-- Seeded rather than left to a screen, because a business cannot take a
-- consent before it has terms, and version 1.0 is a document the client
-- already uses on paper. The wording is deliberately plain: a guarantor
-- signing it has to be able to read what they are agreeing to.
-- ---------------------------------------------------------------------------

insert into public.guarantor_consent_terms
  (version, title, body, effective_from, is_current)
values (
  '1.0',
  'Guarantor undertaking',
  'I confirm that I have read and understood this undertaking before signing it.

1. I agree to act as guarantor for the loan described on this application, taken from Polytos Financial Services Ltd ("the lender").

2. I understand that if the borrower does not pay any amount due under the loan — whether principal, interest or a late-payment charge — the lender may require that amount from me, and I agree to pay it.

3. My liability is limited to the amounts owing under this loan, together with any late-payment charge properly applied to it. It does not extend to any other borrowing by the borrower, and it does not renew automatically for any future loan.

4. I confirm that the personal details I have given are true, that I am of the age the lender requires of a guarantor, and that I am not under any legal disability that would prevent me giving this undertaking.

5. I consent to the lender holding and using my personal details, including my identification number, for the purposes of this loan, and to the lender contacting me about the borrower''s account.

6. I understand that my obligations under this undertaking end when the loan is fully repaid, and that I may ask the lender at any time for a statement of what remains owing.

7. I have signed this undertaking freely, in the presence of the witness named below, on the date shown.',
  current_date,
  true
);

-- ---------------------------------------------------------------------------
-- Capabilities
-- ---------------------------------------------------------------------------

insert into public.permissions (key, description) values
  ('guarantor_terms:manage', 'Publish a new version of the guarantor undertaking.')
on conflict (key) do nothing;

insert into public.role_permissions (role_key, permission_key) values
  -- The Owner's. The terms are a legal undertaking, and the person who may
  -- reword what a guarantor signs is the person who answers for it.
  ('owner_admin', 'guarantor_terms:manage')
on conflict (role_key, permission_key) do nothing;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.loan_guarantors enable row level security;
alter table public.guarantor_consent_terms enable row level security;

revoke all on table public.loan_guarantors from anon, authenticated;
revoke all on table public.guarantor_consent_terms from anon, authenticated;

grant select, insert, update, delete on table public.loan_guarantors to authenticated;
grant select on table public.guarantor_consent_terms to authenticated;
grant insert, update on table public.guarantor_consent_terms to authenticated;

-- Reading a loan's guarantors needs `guarantors:view` as well as `loans:view`:
-- a guarantor is a person, and the capability that opens the guarantor
-- register is the one that decides whether a role may read people who are not
-- borrowers.
create policy loan_guarantors_select_with_permission
  on public.loan_guarantors for select to authenticated
  using (
    public.user_has_permission('loans:view')
    and public.user_has_permission('guarantors:view')
  );

create policy loan_guarantors_insert_with_permission
  on public.loan_guarantors for insert to authenticated
  with check (
    public.user_has_permission('loans:update_draft')
    and public.user_has_permission('guarantors:link')
  );

create policy loan_guarantors_update_with_permission
  on public.loan_guarantors for update to authenticated
  using (
    public.user_has_permission('loans:update_draft')
    and public.user_has_permission('guarantors:link')
  )
  with check (
    public.user_has_permission('loans:update_draft')
    and public.user_has_permission('guarantors:link')
  );

create policy loan_guarantors_delete_with_permission
  on public.loan_guarantors for delete to authenticated
  using (
    public.user_has_permission('loans:update_draft')
    and public.user_has_permission('guarantors:link')
  );

-- The terms are readable by every signed-in user, borrowers included: a
-- guarantor who holds a portal login is entitled to re-read what they signed.
create policy guarantor_consent_terms_select_authenticated
  on public.guarantor_consent_terms for select to authenticated
  using (true);

create policy guarantor_consent_terms_insert_with_permission
  on public.guarantor_consent_terms for insert to authenticated
  with check (public.user_has_permission('guarantor_terms:manage'));

create policy guarantor_consent_terms_update_with_permission
  on public.guarantor_consent_terms for update to authenticated
  using (public.user_has_permission('guarantor_terms:manage'))
  with check (public.user_has_permission('guarantor_terms:manage'));

-- ---------------------------------------------------------------------------
-- Reading a loan's guarantors
--
-- One view, because every caller wants the same thing: the person's name and
-- contact details whichever kind of record holds them, and whether the
-- consent is signed.
-- ---------------------------------------------------------------------------

create view public.loan_guarantor_register with (security_invoker = true) as
select
  lg.id,
  lg.loan_id,
  l.loan_number,
  l.status as loan_status,
  l.client_id,
  case when lg.guarantor_client_id is not null then 'client' else 'external' end
    as subject_kind,
  lg.guarantor_id,
  lg.guarantor_client_id,
  coalesce(c.full_name, g.full_name) as full_name,
  coalesce(c.phone, g.phone) as phone,
  coalesce(c.alternative_phone, g.alternative_phone) as alternative_phone,
  coalesce(c.sex, g.sex) as sex,
  coalesce(c.date_of_birth, g.date_of_birth) as date_of_birth,
  coalesce(c.occupation, g.occupation) as occupation,
  coalesce(c.village_area, g.location) as location,
  coalesce(c.district, g.district) as district,
  c.client_number,
  lg.relationship_to_client,
  lg.consent_terms_id,
  lg.consent_version,
  lg.consented_at,
  lg.signature_name,
  lg.signature_path is not null as has_signature_image,
  lg.witness_name,
  lg.witness_phone,
  lg.consent_place,
  lg.consented_at is not null as consent_signed,
  -- Whether an identification number is on file for this person, which the
  -- approval validator requires. The number itself stays behind its own
  -- capability and is not published here.
  case
    when lg.guarantor_client_id is not null
      then exists (select 1 from public.client_identities ci
                    where ci.client_id = lg.guarantor_client_id)
    else exists (select 1 from public.guarantor_identities gi
                  where gi.guarantor_id = lg.guarantor_id)
  end as has_identification,
  lg.created_at
from public.loan_guarantors lg
join public.loans l on l.id = lg.loan_id
left join public.clients c on c.id = lg.guarantor_client_id
left join public.guarantors g on g.id = lg.guarantor_id;

comment on view public.loan_guarantor_register is
  'Phase 13. A loan''s guarantors with their details resolved from whichever record holds them, and whether each has signed the undertaking.';

revoke all on public.loan_guarantor_register from anon, authenticated;
grant select on public.loan_guarantor_register to authenticated;
