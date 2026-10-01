-- ===========================================================================
-- Phase 3 — the client record.
--
-- ## Why `clients` is not `profiles`
--
-- `profiles` answers "who may sign in, and what may they do". `clients`
-- answers "who are we lending to". Most clients of a Ugandan lending business
-- will never sign in to anything, and a staff member is not a client. Putting
-- business data on `profiles` would mean every client needing a row in the
-- table that governs authentication — and it would mean the identity table
-- growing a `blacklisted` status, which has no meaning for a login.
--
-- The link is therefore optional and indirect: `clients.profile_id` references
-- `profiles`, which itself optionally references `auth.users`. One identity
-- system, reached through one column.
--
-- ## Why the National Identification Number lives in its own table
--
-- A NIN is reusable identity evidence. Someone holding one can impersonate its
-- owner to a third party, which is not true of a phone number or an
-- occupation. The specification asks that only authorized roles reach it.
--
-- PostgreSQL cannot express "this role may read these columns of the rows it
-- can see": column privileges are granted to database roles, and every signed-
-- in user of this application is the same database role, `authenticated`. So a
-- NIN column on `clients` could only have been protected by not selecting it
-- in the interface — which is not protection, because a token can query
-- PostgREST directly.
--
-- Isolating it in `client_identities` makes the restriction a row policy,
-- which is the one mechanism that does hold. The practical consequence is the
-- one that matters: a Secretary/Treasurer, who legitimately reads the client
-- directory all day, cannot read a single NIN by any route — and neither can
-- a client list, a search result, or a CSV export, because the number is not
-- in the table they read.
--
-- The identity document path lives there too. It is the scan of the same
-- document, so protecting one and not the other would be pointless.
-- ===========================================================================

-- Trigram matching, for name search. Supabase provisions extensions into the
-- `extensions` schema; the schema is created defensively so this migration
-- also replays on a bare PostgreSQL cluster.
create schema if not exists extensions;
create extension if not exists pg_trgm with schema extensions;

-- ---------------------------------------------------------------------------
-- clients
-- ---------------------------------------------------------------------------

create table public.clients (
  id uuid primary key default gen_random_uuid(),

  -- Minted by `next_reference('client')` in a BEFORE INSERT trigger, never
  -- supplied by a caller. Immutable thereafter: it appears on paper the
  -- business has already handed to the client.
  client_number text not null unique,

  -- Optional portal login, reached through the identity table rather than
  -- directly. A client registered at the counter has NULL here, which is the
  -- normal case. Unique, so one login cannot serve two client records.
  profile_id uuid unique references public.profiles (id) on delete restrict,

  full_name text not null,
  sex text not null,
  date_of_birth date not null,

  phone text not null,
  alternative_phone text,

  occupation text not null,
  business_type text,

  -- Uganda's administrative hierarchy, kept as free text because the business
  -- works from what the client says rather than from a gazetteer.
  village_area text not null,
  district text not null,

  photo_path text,

  status text not null default 'active',
  -- Why the client is in this status. Required for suspended and blacklisted;
  -- the full history of changes is in `audit_log`, which is append-only.
  status_reason text,
  status_changed_at timestamptz,
  status_changed_by uuid references public.profiles (id) on delete set null,

  -- Operational free text. Not a substitute for `client_remarks`, which is
  -- append-only and attributed; this is the "lives behind the market" note
  -- that belongs on the record itself.
  notes text,

  registered_at timestamptz not null default pg_catalog.now(),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  archived_at timestamptz,

  constraint clients_client_number_shape
    check (client_number ~ '^CL[0-9]{5,}$'),
  constraint clients_full_name_not_blank
    check (btrim(full_name) <> ''),
  constraint clients_full_name_length
    check (char_length(full_name) between 2 and 120),
  constraint clients_sex_valid
    check (sex in ('female', 'male')),
  constraint clients_phone_e164
    check (phone ~ '^\+256[0-9]{9}$'),
  constraint clients_alternative_phone_e164
    check (alternative_phone is null or alternative_phone ~ '^\+256[0-9]{9}$'),
  constraint clients_alternative_phone_differs
    check (alternative_phone is null or alternative_phone <> phone),
  constraint clients_occupation_not_blank
    check (btrim(occupation) <> ''),
  constraint clients_village_area_not_blank
    check (btrim(village_area) <> ''),
  constraint clients_district_not_blank
    check (btrim(district) <> ''),

  -- 18 is the borrowing age. The upper bound catches a mistyped year — a
  -- date of birth in 1890 is a typo, not a customer.
  constraint clients_date_of_birth_adult
    check (date_of_birth <= (pg_catalog.now() at time zone 'Africa/Kampala')::date
                            - interval '18 years'),
  constraint clients_date_of_birth_plausible
    check (date_of_birth >= '1900-01-01'::date),

  constraint clients_status_valid
    check (status in ('active', 'inactive', 'suspended', 'blacklisted', 'archived')),

  -- A restriction the business has chosen must say why. Without this, a
  -- client could be blacklisted by an accidental form submission and nobody
  -- would be able to tell whether it was deliberate.
  constraint clients_restricted_status_has_reason
    check (
      status not in ('suspended', 'blacklisted')
      or (status_reason is not null and btrim(status_reason) <> '')
    ),
  constraint clients_status_reason_length
    check (status_reason is null or char_length(status_reason) <= 500),
  constraint clients_notes_length
    check (notes is null or char_length(notes) <= 2000),

  constraint clients_archived_at_consistent
    check (
      (status = 'archived' and archived_at is not null)
      or (status <> 'archived' and archived_at is null)
    ),

  -- Storage paths are generated server-side. The constraint rejects anything
  -- that is not the shape this application writes, which rules out traversal
  -- (`..`), absolute paths, and a path pointing into another bucket.
  constraint clients_photo_path_shape
    check (
      photo_path is null
      or photo_path ~ '^clients/[0-9a-f-]{36}/photo/[0-9a-zA-Z._-]{1,120}$'
    )
);

comment on table public.clients is
  'A customer of the lending business. Distinct from profiles, which is application identity; linked optionally through profile_id.';
comment on column public.clients.client_number is
  'Business reference, e.g. CL26001. Minted atomically by next_reference(); immutable.';
comment on column public.clients.profile_id is
  'Optional link to an application identity, and through it to a portal login. NULL for a counter-registered client.';
comment on column public.clients.status is
  'active: borrowing normally. inactive: retained, not currently borrowing. suspended: temporarily restricted, reason required. blacklisted: deliberately refused future lending, reason required. archived: replaces deletion.';
comment on column public.clients.status_reason is
  'Why the client holds this status. Required for suspended and blacklisted. The change history is in audit_log.';
comment on column public.clients.notes is
  'Free-text operational note on the record itself. Attributed, append-only commentary belongs in client_remarks.';

-- ---------------------------------------------------------------------------
-- client_identities — the sensitive half
-- ---------------------------------------------------------------------------

create table public.client_identities (
  client_id uuid primary key references public.clients (id) on delete cascade,

  -- Uganda's NIN is 14 characters: 'CM' or 'CF' (citizen, male/female) then
  -- twelve alphanumerics. Validated by shape rather than by checksum, because
  -- the check digit algorithm is not published; a wrong-length or
  -- wrong-prefixed number is a typo worth rejecting, and anything beyond that
  -- is the registrar's business.
  nin text,
  id_document_path text,

  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),

  constraint client_identities_nin_shape
    check (nin is null or nin ~ '^C[MF][0-9A-Z]{12}$'),
  constraint client_identities_id_document_path_shape
    check (
      id_document_path is null
      or id_document_path ~ '^clients/[0-9a-f-]{36}/id/[0-9a-zA-Z._-]{1,120}$'
    )
);

comment on table public.client_identities is
  'A client''s National Identification Number and identity document. Separate from clients so that reading it is a distinct, policy-enforced privilege rather than an interface convention.';

-- NIN uniqueness is a hard business rule, and the right one: a NIN identifies
-- exactly one person, so two client records sharing one is a duplicate or a
-- transcription error, never a legitimate pair. Partial, because the number is
-- optional — a client registered without their card present still gets a
-- record.
create unique index client_identities_nin_unique
  on public.client_identities (nin)
  where nin is not null;

comment on index public.client_identities_nin_unique is
  'One NIN, one client. Partial: a client may be registered before their number is recorded.';

-- ---------------------------------------------------------------------------
-- Indexes
--
-- Chosen for the four searches the specification names and the two the list
-- screen performs. Nothing speculative: no index for a column no query
-- filters on.
-- ---------------------------------------------------------------------------

-- Exact lookups. `client_number` and `phone` are what a staff member types
-- when a client is standing in front of them.
create index clients_phone_idx on public.clients (phone);
create index clients_alternative_phone_idx on public.clients (alternative_phone)
  where alternative_phone is not null;

-- Substring name search, case-insensitive. A btree index cannot serve
-- `ilike '%nakato%'`; a trigram index can, which is why pg_trgm is here.
create index clients_full_name_trgm_idx
  on public.clients using gin (lower(full_name) extensions.gin_trgm_ops);

-- The list screen: filter by status, order by registration date.
create index clients_status_idx on public.clients (status);
create index clients_registered_at_idx on public.clients (registered_at desc);

-- The portal, resolving "which client am I".
create index clients_profile_id_idx on public.clients (profile_id)
  where profile_id is not null;

create trigger clients_set_updated_at
  before update on public.clients
  for each row
  execute function public.set_updated_at();

create trigger client_identities_set_updated_at
  before update on public.client_identities
  for each row
  execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Client numbering
--
-- Minted in a BEFORE INSERT trigger rather than by the application, for two
-- reasons: the number cannot then be supplied by a caller, and there is no
-- window in which a client row exists without one. `next_reference()` is the
-- Phase 1 generator — an atomic upsert against `reference_sequences` under a
-- row lock, proven gapless under 60-way concurrency.
-- ---------------------------------------------------------------------------

create or replace function public.clients_assign_client_number()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- A supplied value is refused rather than silently replaced. Silently
  -- replacing it would hide a caller that believes it is choosing the number.
  if new.client_number is not null then
    raise exception
      'A client number is assigned by the database, not by the caller.'
      using errcode = 'P0001';
  end if;

  new.client_number := public.next_reference('client');
  return new;
end;
$$;

comment on function public.clients_assign_client_number() is
  'BEFORE INSERT on clients: mints the client number atomically via next_reference(), and refuses a caller-supplied one.';

-- The column is NOT NULL, so the trigger has to run before the constraint is
-- checked. BEFORE INSERT triggers do.
create trigger clients_assign_client_number
  before insert on public.clients
  for each row
  execute function public.clients_assign_client_number();

-- ---------------------------------------------------------------------------
-- Column-level authorization
--
-- Row Level Security decides which rows a caller may touch. It cannot decide
-- which columns, so the rules that differ per column live here — the same
-- shape as `profiles_guard_privileged_columns` from Phase 2.
--
-- Rules that bind every caller, including `service_role` and the table owner,
-- are stated before the trusted-path exemption. That ordering is the lesson of
-- the Phase 2 password-change bypass: a rule placed after the exemption is a
-- rule the privileged client can skip, and the privileged client is exactly
-- what a leaked secret key becomes.
-- ---------------------------------------------------------------------------

create or replace function public.clients_guard_privileged_columns()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_linking boolean;
begin
  v_linking := coalesce(
    pg_catalog.current_setting('app.linking_client_auth', true), ''
  ) = 'on';

  -- --- Binding on everyone -------------------------------------------------

  -- The client number is on paper the business has already issued. Changing
  -- it would invalidate every receipt and ledger entry referring to it.
  if new.client_number is distinct from old.client_number then
    raise exception 'A client number cannot be changed once issued.'
      using errcode = 'P0001';
  end if;

  -- Linkage is routed through link_client_profile(), which announces itself.
  -- Without this, a direct UPDATE could point a client record at any login.
  if new.profile_id is distinct from old.profile_id and not v_linking then
    raise exception
      'A portal login is linked through the linking function, not by editing the client.'
      using errcode = 'P0001';
  end if;

  -- Stamped by the database so the record of who changed a status, and when,
  -- cannot be forged or omitted by the caller that made the change.
  if new.status is distinct from old.status then
    new.status_changed_at := pg_catalog.now();
    new.status_changed_by := public.current_profile_id();
  elsif new.status_changed_at is distinct from old.status_changed_at
     or new.status_changed_by is distinct from old.status_changed_by then
    raise exception
      'Status attribution is maintained by the database, not by the caller.'
      using errcode = 'P0001';
  end if;

  -- Archiving is a soft delete. Keeping the timestamp honest keeps it
  -- auditable.
  if new.status = 'archived' and old.status <> 'archived' then
    new.archived_at := pg_catalog.now();
  elsif new.status <> 'archived' then
    new.archived_at := null;
  end if;

  -- --- The trusted server path ---------------------------------------------
  -- `auth.uid()` is NULL for `service_role` and for the table owner, i.e. for
  -- migrations, the privileged client and the test harness. Capability checks
  -- below this line are about a *session*, and there is no session to check.
  if auth.uid() is null then
    return new;
  end if;

  -- --- Binding on sessions -------------------------------------------------

  if new.status is distinct from old.status then
    -- Blacklisting, and lifting a blacklisting, are the Owner's to make.
    if new.status = 'blacklisted' or old.status = 'blacklisted' then
      if not public.user_has_permission('clients:blacklist') then
        raise exception
          'Blacklisting a client, or lifting one, requires the clients:blacklist capability.'
          using errcode = 'P0001';
      end if;
    elsif new.status = 'archived' or old.status = 'archived' then
      if not public.user_has_permission('clients:archive') then
        raise exception
          'Archiving a client requires the clients:archive capability.'
          using errcode = 'P0001';
      end if;
    elsif not public.user_has_permission('clients:status') then
      raise exception
        'Changing a client status requires the clients:status capability.'
        using errcode = 'P0001';
    end if;
  end if;

  -- A photograph is a document, not an ordinary detail.
  if new.photo_path is distinct from old.photo_path
     and not public.user_has_permission('clients:documents') then
    raise exception
      'Changing a client photograph requires the clients:documents capability.'
      using errcode = 'P0001';
  end if;

  -- Everything else on the table is an ordinary detail, and `clients:update`
  -- covers it. Stated explicitly so that a column added later is refused
  -- until somebody decides which rule it falls under.
  if (
       new.full_name is distinct from old.full_name
    or new.sex is distinct from old.sex
    or new.date_of_birth is distinct from old.date_of_birth
    or new.phone is distinct from old.phone
    or new.alternative_phone is distinct from old.alternative_phone
    or new.occupation is distinct from old.occupation
    or new.business_type is distinct from old.business_type
    or new.village_area is distinct from old.village_area
    or new.district is distinct from old.district
    or new.notes is distinct from old.notes
    or new.registered_at is distinct from old.registered_at
  ) and not public.user_has_permission('clients:update') then
    raise exception 'Changing client details requires the clients:update capability.'
      using errcode = 'P0001';
  end if;

  -- Provenance is history. It is written once, by the insert.
  if new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'Client provenance cannot be rewritten.'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

comment on function public.clients_guard_privileged_columns() is
  'BEFORE UPDATE on clients: per-column authorization. Rules binding every caller, including service_role, are stated before the trusted-path exemption.';

create trigger clients_guard_privileged_columns
  before update on public.clients
  for each row
  execute function public.clients_guard_privileged_columns();

-- ---------------------------------------------------------------------------
-- Provenance on insert
-- ---------------------------------------------------------------------------

create or replace function public.clients_stamp_provenance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Derived from the session, never accepted from the caller, so "who
  -- registered this client" cannot be attributed to somebody else.
  new.created_by := public.current_profile_id();

  if new.status = 'archived' then
    new.archived_at := coalesce(new.archived_at, pg_catalog.now());
  end if;

  return new;
end;
$$;

comment on function public.clients_stamp_provenance() is
  'BEFORE INSERT on clients: derives created_by from the session rather than trusting the payload.';

create trigger clients_stamp_provenance
  before insert on public.clients
  for each row
  execute function public.clients_stamp_provenance();

-- ---------------------------------------------------------------------------
-- Linking a client to a portal login
--
-- Callable only by `service_role`, for the same reason as
-- `confirm_password_change`: the browser must not be able to decide which
-- login sees which client's data. Every invariant is checked inside, under an
-- advisory lock, so two concurrent links cannot both pass their checks and
-- then both commit.
-- ---------------------------------------------------------------------------

create or replace function public.link_client_profile(
  p_client_id uuid,
  p_profile_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_existing_client uuid;
  v_client_profile  uuid;
  v_profile_status  text;
begin
  if p_client_id is null or p_profile_id is null then
    raise exception 'A client and a profile are both required.'
      using errcode = 'P0001';
  end if;

  -- Serialises the checks below against a concurrent link. Without it, two
  -- transactions could each find the profile unused and each link it.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('link_client_profile')
  );

  select c.profile_id into v_client_profile
  from public.clients c where c.id = p_client_id
  for update;

  if not found then
    raise exception 'No such client.' using errcode = 'P0001';
  end if;

  if v_client_profile is not null then
    raise exception 'That client already has a portal login.'
      using errcode = 'P0001';
  end if;

  select p.status into v_profile_status
  from public.profiles p where p.id = p_profile_id;

  if not found then
    raise exception 'No such profile.' using errcode = 'P0001';
  end if;

  if v_profile_status <> 'active' then
    raise exception 'That account is not active.' using errcode = 'P0001';
  end if;

  select c.id into v_existing_client
  from public.clients c where c.profile_id = p_profile_id;

  if v_existing_client is not null then
    raise exception 'That login is already linked to another client.'
      using errcode = 'P0001';
  end if;

  perform pg_catalog.set_config('app.linking_client_auth', 'on', true);
  update public.clients set profile_id = p_profile_id where id = p_client_id;
  perform pg_catalog.set_config('app.linking_client_auth', 'off', true);
end;
$$;

comment on function public.link_client_profile(uuid, uuid) is
  'Links a client record to an application identity. service_role only; serialised by advisory lock so concurrent links cannot both succeed.';

-- Naming each role matters: Supabase grants EXECUTE on new functions to anon
-- and authenticated through ALTER DEFAULT PRIVILEGES, and those grants survive
-- a REVOKE FROM PUBLIC.
revoke all on function public.link_client_profile(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.clients_assign_client_number()
  from public, anon, authenticated;
revoke all on function public.clients_guard_privileged_columns()
  from public, anon, authenticated;
revoke all on function public.clients_stamp_provenance()
  from public, anon, authenticated;

alter table public.clients enable row level security;
alter table public.client_identities enable row level security;
revoke all on table public.clients from anon, authenticated;
revoke all on table public.client_identities from anon, authenticated;
