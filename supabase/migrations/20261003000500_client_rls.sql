-- ===========================================================================
-- Phase 3 — Row Level Security for clients, guarantors, links and remarks.
--
-- This is the boundary. Everything above it — hidden buttons, guarded Server
-- Actions, route protection — is there to give people a coherent experience
-- and to fail early. None of it survives a caller who takes their own token
-- and queries PostgREST directly, which is a thing anyone with the browser's
-- developer tools can do in a minute.
--
-- So each policy below is written to be correct on its own, assuming the
-- application above it has been bypassed entirely.
--
-- Two conventions carried from Phase 2:
--
--   * `public.current_profile_id()` resolves only *active* profiles. Every
--     self-clause routes through it, which is what makes suspending an account
--     take effect on the next request rather than when its token expires.
--
--   * `authenticated` holds no table privileges until granted here, and the
--     grant is per-operation. There is no DELETE grant anywhere in this
--     migration, which is how the no-hard-delete policy is enforced rather
--     than merely documented.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- clients
-- ---------------------------------------------------------------------------

-- No DELETE. Archiving replaces deletion, and a capability cannot be added
-- later by accident because the privilege simply is not there.
grant select, insert, update on table public.clients to authenticated;

create policy clients_select_own_or_directory
  on public.clients
  for select
  to authenticated
  using (
    -- A borrower reads their own record, and only through their active
    -- profile. This clause is keyed on identity rather than on a capability
    -- precisely so that it grants exactly one row.
    (
      profile_id is not null
      and profile_id = public.current_profile_id()
    )
    or public.user_has_permission('clients:view')
  );

comment on policy clients_select_own_or_directory on public.clients is
  'A linked borrower reads their own row. Staff holding clients:view read the directory. Nobody else reads anything.';

create policy clients_insert_with_permission
  on public.clients
  for insert
  to authenticated
  with check (
    public.user_has_permission('clients:create')
    -- A client may not be registered already restricted. Blacklisting is a
    -- decision made about an existing client, with a reason and an Owner's
    -- name on it; arriving pre-blacklisted would bypass that.
    and status in ('active', 'inactive')
    -- Linking is a separate, Owner-only act through link_client_profile().
    -- Permitting it here would let whoever can register a client also decide
    -- which login reads it.
    and profile_id is null
  );

comment on policy clients_insert_with_permission on public.clients is
  'Only clients:create may register a client, and the new row may arrive neither restricted nor pre-linked to a login.';

create policy clients_update_with_permission
  on public.clients
  for update
  to authenticated
  using (
    public.user_has_permission('clients:update')
    or public.user_has_permission('clients:status')
    or public.user_has_permission('clients:blacklist')
    or public.user_has_permission('clients:archive')
    or public.user_has_permission('clients:documents')
  )
  with check (
    public.user_has_permission('clients:update')
    or public.user_has_permission('clients:status')
    or public.user_has_permission('clients:blacklist')
    or public.user_has_permission('clients:archive')
    or public.user_has_permission('clients:documents')
  );

comment on policy clients_update_with_permission on public.clients is
  'Any client-editing capability opens the row; which columns that caller may actually change is decided by clients_guard_privileged_columns. A borrower holds none of these, so clients cannot edit their own business record.';

-- ---------------------------------------------------------------------------
-- client_identities
--
-- The whole reason this table exists. A Secretary/Treasurer passes
-- `clients:view` and reads the directory all day; they fail here, so there is
-- no query, view or export through which they reach a NIN.
--
-- Note what is absent: no self-clause. A borrower cannot read their own NIN
-- through the portal either. That is deliberate — they already know it, the
-- portal gains nothing by reproducing it, and a portal that does not display
-- identity numbers cannot leak them.
-- ---------------------------------------------------------------------------

grant select, insert, update on table public.client_identities to authenticated;

create policy client_identities_select_with_permission
  on public.client_identities
  for select
  to authenticated
  using (public.user_has_permission('clients:view_nin'));

comment on policy client_identities_select_with_permission on public.client_identities is
  'Only clients:view_nin reads a National Identification Number. No self-clause: the portal has no reason to display one.';

create policy client_identities_insert_with_permission
  on public.client_identities
  for insert
  to authenticated
  with check (public.user_has_permission('clients:create'));

create policy client_identities_update_with_permission
  on public.client_identities
  for update
  to authenticated
  using (
    public.user_has_permission('clients:view_nin')
    and (
      public.user_has_permission('clients:update')
      or public.user_has_permission('clients:documents')
    )
  )
  with check (
    public.user_has_permission('clients:view_nin')
    and (
      public.user_has_permission('clients:update')
      or public.user_has_permission('clients:documents')
    )
  );

comment on policy client_identities_update_with_permission on public.client_identities is
  'Correcting a NIN requires being able to read it as well as to edit — a blind write would overwrite evidence the caller cannot see.';

-- ---------------------------------------------------------------------------
-- guarantors
--
-- No self-clause and no borrower access at all. A borrower has no business
-- reading guarantor records, including those of their own guarantors: the
-- guarantor's phone number and photograph are that person's data, disclosed
-- to the lender, not to the borrower who named them.
-- ---------------------------------------------------------------------------

grant select, insert, update on table public.guarantors to authenticated;

create policy guarantors_select_with_permission
  on public.guarantors
  for select
  to authenticated
  using (public.user_has_permission('guarantors:view'));

comment on policy guarantors_select_with_permission on public.guarantors is
  'Staff holding guarantors:view only. Borrowers have no guarantor directory, not even for their own guarantors.';

create policy guarantors_insert_with_permission
  on public.guarantors
  for insert
  to authenticated
  with check (public.user_has_permission('guarantors:create'));

create policy guarantors_update_with_permission
  on public.guarantors
  for update
  to authenticated
  using (
    public.user_has_permission('guarantors:update')
    or public.user_has_permission('guarantors:documents')
  )
  with check (
    public.user_has_permission('guarantors:update')
    or public.user_has_permission('guarantors:documents')
  );

-- ---------------------------------------------------------------------------
-- guarantor_identities
-- ---------------------------------------------------------------------------

grant select, insert, update on table public.guarantor_identities to authenticated;

create policy guarantor_identities_select_with_permission
  on public.guarantor_identities
  for select
  to authenticated
  using (public.user_has_permission('guarantors:view_nin'));

create policy guarantor_identities_insert_with_permission
  on public.guarantor_identities
  for insert
  to authenticated
  with check (public.user_has_permission('guarantors:create'));

create policy guarantor_identities_update_with_permission
  on public.guarantor_identities
  for update
  to authenticated
  using (
    public.user_has_permission('guarantors:view_nin')
    and public.user_has_permission('guarantors:update')
  )
  with check (
    public.user_has_permission('guarantors:view_nin')
    and public.user_has_permission('guarantors:update')
  );

-- ---------------------------------------------------------------------------
-- client_guarantors
--
-- Readable by anyone who may see guarantors, because the association is
-- meaningless without them. Writable only with `guarantors:link`.
-- ---------------------------------------------------------------------------

grant select, insert, update on table public.client_guarantors to authenticated;

create policy client_guarantors_select_with_permission
  on public.client_guarantors
  for select
  to authenticated
  using (public.user_has_permission('guarantors:view'));

create policy client_guarantors_insert_with_permission
  on public.client_guarantors
  for insert
  to authenticated
  with check (
    public.user_has_permission('guarantors:link')
    -- An association cannot arrive already detached: that would write
    -- history that never happened.
    and active
  );

comment on policy client_guarantors_insert_with_permission on public.client_guarantors is
  'Only guarantors:link may attach a guarantor, and the association must arrive active.';

create policy client_guarantors_update_with_permission
  on public.client_guarantors
  for update
  to authenticated
  using (public.user_has_permission('guarantors:link'))
  with check (public.user_has_permission('guarantors:link'));

-- ---------------------------------------------------------------------------
-- client_remarks
--
-- SELECT and INSERT only — no UPDATE or DELETE privilege at all, on top of
-- the statement-level triggers that refuse both. Two independent mechanisms,
-- because append-only is the entire value of the table.
--
-- A borrower reads nothing here. These are the notes staff write *about* them.
-- ---------------------------------------------------------------------------

grant select, insert on table public.client_remarks to authenticated;

create policy client_remarks_select_with_permission
  on public.client_remarks
  for select
  to authenticated
  using (public.user_has_permission('clients:remarks_view'));

comment on policy client_remarks_select_with_permission on public.client_remarks is
  'Internal staff commentary. No self-clause: a borrower must not read the notes written about them.';

create policy client_remarks_insert_with_permission
  on public.client_remarks
  for insert
  to authenticated
  with check (public.user_has_permission('clients:remarks_create'));
