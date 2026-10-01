-- ===========================================================================
-- 20261001000200_profiles
--
-- Application-level identity.
--
-- ## Relationship to auth.users
--
-- `auth_user_id` is a NULLABLE unique reference to `auth.users(id)`.
--
-- Nullable is the important part. Staff register a borrower at the counter,
-- and that borrower has no portal credentials at that moment — possibly ever.
-- A design that made `profiles.id` equal to `auth.users.id` would force an
-- auth account into existence for every client, which is both wrong and a
-- security liability (accounts nobody asked for, with recovery addresses
-- nobody controls). So the profile is the system's own identity record, and an
-- auth account is an optional capability attached to it.
--
-- `ON DELETE RESTRICT` means an auth user who has a profile cannot simply be
-- deleted. That is deliberate: in a lending business a person's record is
-- referenced by loans and payments, and silently orphaning it would corrupt
-- the books. Offboarding is a two-step, documented in docs/DATABASE.md —
-- archive the profile, then unlink and delete the auth account if required.
--
-- No password, hash or token is stored here. Supabase Auth owns credentials.
--
-- ## Row Level Security
--
-- RLS is enabled with NO policies, which denies all access to `anon` and
-- `authenticated`. Table privileges are revoked as well, so even if RLS were
-- accidentally disabled the roles still hold no grant. Phase 2 adds the
-- policies; nothing in this phase needs read access, so nothing is opened.
-- ===========================================================================

create table public.profiles (
  id uuid primary key default gen_random_uuid(),

  -- Optional link to a Supabase Auth account. Unique when present.
  auth_user_id uuid unique references auth.users (id) on delete restrict,

  full_name text not null,

  -- Canonical E.164, e.g. +256772123456. The business identifies clients by
  -- phone, so it is unique and format-constrained.
  phone text not null unique,

  -- Optional: many clients have no email address.
  email text unique,

  status text not null default 'active',

  -- Set when, and only when, status becomes 'archived'. Archiving is this
  -- system's substitute for deletion.
  archived_at timestamptz,

  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),

  constraint profiles_full_name_not_blank
    check (btrim(full_name) <> ''),

  constraint profiles_full_name_length
    check (char_length(full_name) between 2 and 120),

  -- Mirrors UGANDA_E164_PATTERN in lib/domain/phone.ts.
  constraint profiles_phone_e164
    check (phone ~ '^\+256[0-9]{9}$'),

  -- Deliberately loose: a strict RFC 5322 regex rejects valid addresses.
  -- This catches typos and junk, and the application validates properly.
  constraint profiles_email_shape
    check (email is null or email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),

  -- Stored lowercase so the unique index is genuinely case-insensitive.
  constraint profiles_email_lowercase
    check (email is null or email = lower(email)),

  -- Mirrors PROFILE_STATUSES in lib/domain/status.ts.
  constraint profiles_status_valid
    check (status in ('active', 'inactive', 'suspended', 'archived')),

  -- An archived row must say when it was archived, and a live row must not
  -- claim to have been.
  constraint profiles_archived_at_consistent
    check (
      (status = 'archived' and archived_at is not null)
      or (status <> 'archived' and archived_at is null)
    )
);

comment on table public.profiles is
  'Application-level person record. Optionally linked to a Supabase Auth account; never stores credentials.';
comment on column public.profiles.auth_user_id is
  'Optional link to auth.users. NULL for people registered by staff who have no portal login.';
comment on column public.profiles.phone is
  'Canonical E.164 Ugandan number (+256 plus nine digits). Primary business identifier.';
comment on column public.profiles.status is
  'Lifecycle: active | inactive | suspended | archived. Archiving replaces deletion.';

-- Working lists filter out archived rows, so index the live ones.
create index profiles_status_idx on public.profiles (status);
create index profiles_created_at_idx on public.profiles (created_at desc);

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row
  execute function public.set_updated_at();

-- --- Access control -------------------------------------------------------
-- Default-deny. RLS with no policies blocks every row for anon/authenticated;
-- revoking privileges means the roles hold no grant either, so the two
-- controls are independent.
alter table public.profiles enable row level security;

revoke all on table public.profiles from anon, authenticated;

-- DEFERRED TO PHASE 2 — intentionally absent:
--   * "a user may read and update their own profile"
--   * "staff may read client profiles"
--   * "owner_admin may manage all profiles"
-- Phase 2 will express these with public.current_profile_id() and
-- public.user_has_at_least_role(), defined in the next migration.
