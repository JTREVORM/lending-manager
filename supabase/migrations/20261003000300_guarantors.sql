-- ===========================================================================
-- Phase 3 — guarantors, and their association with clients.
--
-- ## One guarantor, many clients
--
-- The link is a separate table rather than a column on `clients`, because in
-- practice the same person guarantees several borrowers: a trader vouches for
-- two relatives and a neighbour. Duplicating that person's record three times
-- would mean three photographs to keep current, three NINs to keep unique,
-- and no way to see that one person carries three obligations — which is
-- precisely the exposure a lender wants visible.
--
-- The cost is a search-then-link step in the registration flow instead of a
-- single form. That is the right trade, and the flow is built accordingly.
--
-- ## A note for Phase 4
--
-- A guarantor's details change: they move, they change trade, they change
-- number. `client_guarantors` therefore records the *current* association,
-- and nothing here is suitable as loan evidence on its own.
--
-- When Phase 4 issues a loan it must **snapshot** the guarantor details it
-- relied on — name, NIN, phone, relationship — into the loan's own rows, not
-- reference `guarantors.id` and read through at display time. Otherwise a
-- guarantor correcting their phone number in 2027 silently rewrites what the
-- business will claim it was told in 2026, and the loan file stops being
-- evidence. The same applies to the client's own identity data.
--
-- This migration deliberately provides no snapshot mechanism: there is nothing
-- yet to snapshot into, and an unused one would rot.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- guarantors
-- ---------------------------------------------------------------------------

create table public.guarantors (
  id uuid primary key default gen_random_uuid(),

  full_name text not null,
  sex text not null,

  -- Date of birth rather than age, for the same reason as clients: an age is
  -- wrong within a year of being recorded, and cannot be corrected without
  -- knowing when it was taken.
  date_of_birth date not null,

  phone text not null,
  alternative_phone text,

  occupation text not null,
  location text not null,
  district text,

  photo_path text,

  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  archived_at timestamptz,

  constraint guarantors_full_name_not_blank
    check (btrim(full_name) <> ''),
  constraint guarantors_full_name_length
    check (char_length(full_name) between 2 and 120),
  constraint guarantors_sex_valid
    check (sex in ('female', 'male')),
  constraint guarantors_phone_e164
    check (phone ~ '^\+256[0-9]{9}$'),
  constraint guarantors_alternative_phone_e164
    check (alternative_phone is null or alternative_phone ~ '^\+256[0-9]{9}$'),
  constraint guarantors_alternative_phone_differs
    check (alternative_phone is null or alternative_phone <> phone),
  constraint guarantors_occupation_not_blank
    check (btrim(occupation) <> ''),
  constraint guarantors_location_not_blank
    check (btrim(location) <> ''),
  constraint guarantors_date_of_birth_adult
    check (date_of_birth <= (pg_catalog.now() at time zone 'Africa/Kampala')::date
                            - interval '18 years'),
  constraint guarantors_date_of_birth_plausible
    check (date_of_birth >= '1900-01-01'::date),
  constraint guarantors_photo_path_shape
    check (
      photo_path is null
      or photo_path ~ '^guarantors/[0-9a-f-]{36}/photo/[0-9a-zA-Z._-]{1,120}$'
    )
);

comment on table public.guarantors is
  'A person who vouches for a borrower. One guarantor may stand for several clients; the association is in client_guarantors.';

-- ---------------------------------------------------------------------------
-- guarantor_identities — the sensitive half, as for clients
-- ---------------------------------------------------------------------------

create table public.guarantor_identities (
  guarantor_id uuid primary key references public.guarantors (id) on delete cascade,
  nin text,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),

  constraint guarantor_identities_nin_shape
    check (nin is null or nin ~ '^C[MF][0-9A-Z]{12}$')
);

comment on table public.guarantor_identities is
  'A guarantor''s National Identification Number. Separate from guarantors so that reading it is a policy-enforced privilege.';

create unique index guarantor_identities_nin_unique
  on public.guarantor_identities (nin)
  where nin is not null;

comment on index public.guarantor_identities_nin_unique is
  'One NIN, one guarantor — which is what makes "this person already guarantees two clients" visible instead of silently duplicated.';

-- ---------------------------------------------------------------------------
-- client_guarantors — the association
-- ---------------------------------------------------------------------------

create table public.client_guarantors (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  guarantor_id uuid not null references public.guarantors (id) on delete restrict,

  -- How this guarantor knows the client. Recorded per association rather than
  -- on the guarantor, because the same person is a brother to one client and
  -- a business partner to another.
  relationship_to_client text not null,

  -- Detaching sets this false rather than deleting the row. A loan issued in
  -- Phase 4 against this association must still be explicable afterwards,
  -- and "the record was deleted" is not an explanation.
  active boolean not null default true,
  detached_at timestamptz,
  detached_by uuid references public.profiles (id) on delete set null,
  detached_reason text,

  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),

  constraint client_guarantors_relationship_not_blank
    check (btrim(relationship_to_client) <> ''),
  constraint client_guarantors_relationship_length
    check (char_length(relationship_to_client) between 2 and 60),
  constraint client_guarantors_detached_consistent
    check (
      (active and detached_at is null and detached_by is null)
      or (not active and detached_at is not null)
    ),
  constraint client_guarantors_detached_reason_length
    check (detached_reason is null or char_length(detached_reason) <= 300)
);

comment on table public.client_guarantors is
  'Which guarantors stand for which clients, and in what relationship. Detaching deactivates rather than deletes.';

-- One *active* association per pair. The same person may be re-attached after
-- being detached, which is why the uniqueness is partial rather than on the
-- pair outright — a client and guarantor may have a history.
create unique index client_guarantors_active_pair_unique
  on public.client_guarantors (client_id, guarantor_id)
  where active;

comment on index public.client_guarantors_active_pair_unique is
  'A guarantor stands for a client once at a time. Partial on `active`, so a detached association can be re-made without colliding with its own history.';

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

create index guarantors_phone_idx on public.guarantors (phone);
create index guarantors_full_name_trgm_idx
  on public.guarantors using gin (lower(full_name) extensions.gin_trgm_ops);
create index guarantors_created_at_idx on public.guarantors (created_at desc);

-- Both directions are traversed: a client's guarantors on the client page, and
-- a guarantor's clients on the guarantor page.
create index client_guarantors_client_idx
  on public.client_guarantors (client_id) where active;
create index client_guarantors_guarantor_idx
  on public.client_guarantors (guarantor_id) where active;

create trigger guarantors_set_updated_at
  before update on public.guarantors
  for each row execute function public.set_updated_at();

create trigger guarantor_identities_set_updated_at
  before update on public.guarantor_identities
  for each row execute function public.set_updated_at();

create trigger client_guarantors_set_updated_at
  before update on public.client_guarantors
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Provenance and column authorization
-- ---------------------------------------------------------------------------

create or replace function public.guarantors_stamp_provenance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.created_by := public.current_profile_id();
  return new;
end;
$$;

comment on function public.guarantors_stamp_provenance() is
  'BEFORE INSERT on guarantors and client_guarantors: derives created_by from the session.';

create trigger guarantors_stamp_provenance
  before insert on public.guarantors
  for each row execute function public.guarantors_stamp_provenance();

create trigger client_guarantors_stamp_provenance
  before insert on public.client_guarantors
  for each row execute function public.guarantors_stamp_provenance();

create or replace function public.guarantors_guard_privileged_columns()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Binding on every caller.
  if new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'Guarantor provenance cannot be rewritten.'
      using errcode = 'P0001';
  end if;

  if auth.uid() is null then
    return new;
  end if;

  if new.photo_path is distinct from old.photo_path
     and not public.user_has_permission('guarantors:documents') then
    raise exception
      'Changing a guarantor photograph requires the guarantors:documents capability.'
      using errcode = 'P0001';
  end if;

  if (
       new.full_name is distinct from old.full_name
    or new.sex is distinct from old.sex
    or new.date_of_birth is distinct from old.date_of_birth
    or new.phone is distinct from old.phone
    or new.alternative_phone is distinct from old.alternative_phone
    or new.occupation is distinct from old.occupation
    or new.location is distinct from old.location
    or new.district is distinct from old.district
  ) and not public.user_has_permission('guarantors:update') then
    raise exception
      'Changing guarantor details requires the guarantors:update capability.'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

comment on function public.guarantors_guard_privileged_columns() is
  'BEFORE UPDATE on guarantors: per-column authorization, provenance rules first.';

create trigger guarantors_guard_privileged_columns
  before update on public.guarantors
  for each row execute function public.guarantors_guard_privileged_columns();

-- ---------------------------------------------------------------------------
-- Detaching an association
--
-- A row trigger rather than a policy, because the rule is about *how* the
-- transition happens: active may become inactive, and the attribution is the
-- database's to write. Re-activating a detached association is refused
-- outright — make a new one, so the history stays legible.
-- ---------------------------------------------------------------------------

create or replace function public.client_guarantors_guard_detach()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Binding on every caller.
  if new.client_id is distinct from old.client_id
     or new.guarantor_id is distinct from old.guarantor_id then
    raise exception
      'An association cannot be repointed at a different client or guarantor. Detach it and make a new one.'
      using errcode = 'P0001';
  end if;

  if old.active and not new.active then
    new.detached_at := pg_catalog.now();
    new.detached_by := public.current_profile_id();
  elsif not old.active and new.active then
    raise exception
      'A detached association is history. Create a new association instead of reviving it.'
      using errcode = 'P0001';
  elsif new.detached_at is distinct from old.detached_at
     or new.detached_by is distinct from old.detached_by then
    raise exception
      'Detachment attribution is maintained by the database, not by the caller.'
      using errcode = 'P0001';
  end if;

  if auth.uid() is null then
    return new;
  end if;

  if not public.user_has_permission('guarantors:link') then
    raise exception
      'Changing a guarantor association requires the guarantors:link capability.'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

comment on function public.client_guarantors_guard_detach() is
  'BEFORE UPDATE on client_guarantors: allows detaching, refuses reviving, and stamps attribution itself.';

create trigger client_guarantors_guard_detach
  before update on public.client_guarantors
  for each row execute function public.client_guarantors_guard_detach();

revoke all on function public.guarantors_stamp_provenance()
  from public, anon, authenticated;
revoke all on function public.guarantors_guard_privileged_columns()
  from public, anon, authenticated;
revoke all on function public.client_guarantors_guard_detach()
  from public, anon, authenticated;

alter table public.guarantors enable row level security;
alter table public.guarantor_identities enable row level security;
alter table public.client_guarantors enable row level security;
revoke all on table public.guarantors from anon, authenticated;
revoke all on table public.guarantor_identities from anon, authenticated;
revoke all on table public.client_guarantors from anon, authenticated;
