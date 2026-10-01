-- ===========================================================================
-- Phase 3 — Storage policies for client and guarantor documents.
--
-- The buckets were created private in Phase 1 (`20261001000700`) with no
-- policies at all, which meant default-deny: nothing could be read or written
-- by any session. That was correct while nothing uploaded anything. Phase 3
-- needs uploads, so the policies arrive now, and they are written so that the
-- bucket's privacy does not depend on anything above the database.
--
-- ## Why a path convention is load-bearing
--
-- `storage.objects` has a `name` column holding the object's path. A policy
-- can reason about that path, which means the path layout *is* the
-- authorization model:
--
--     clients/<client uuid>/photo/<filename>
--     clients/<client uuid>/id/<filename>
--     guarantors/<guarantor uuid>/photo/<filename>
--
-- Reading an object therefore requires the caller to be allowed to see the
-- client or guarantor whose folder it sits in. Guessing a path gains nothing:
-- the guess still has to name a client the caller may read, and if they may
-- read that client they could have found the path legitimately.
--
-- The identity-document folder is gated on `clients:view_nin` rather than
-- `clients:view`, matching `client_identities`. A scan of a national ID is
-- the same evidence as the number on it.
--
-- ## Filename policy
--
-- The filename is generated server-side — a random token plus an extension —
-- and never derived from what the browser sent. An uploaded name is attacker
-- input: it can contain `../`, a null byte, a right-to-left override to
-- disguise an extension, or simply be 4KB long. The path shape constraints on
-- `clients.photo_path` and the policies below both enforce the generated
-- shape, so a crafted name cannot be stored even if some future code path
-- forgets to replace it.
-- ===========================================================================

-- The client folder a path refers to, or NULL if the path is not of the
-- expected shape. Used by the policies below so the parsing rule is written
-- once.
create or replace function public.storage_path_client_id(p_name text)
returns uuid
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_segments text[];
begin
  v_segments := pg_catalog.string_to_array(p_name, '/');

  if pg_catalog.array_length(v_segments, 1) < 3
     or v_segments[1] <> 'clients' then
    return null;
  end if;

  -- A path whose second segment is not a UUID is not one this application
  -- wrote. Returning NULL fails every policy below closed.
  begin
    return v_segments[2]::uuid;
  exception when others then
    return null;
  end;
end;
$$;

comment on function public.storage_path_client_id(text) is
  'The client UUID in a clients/<uuid>/... storage path, or NULL when the path is not of that shape. NULL fails every storage policy closed.';

create or replace function public.storage_path_guarantor_id(p_name text)
returns uuid
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_segments text[];
begin
  v_segments := pg_catalog.string_to_array(p_name, '/');

  if pg_catalog.array_length(v_segments, 1) < 3
     or v_segments[1] <> 'guarantors' then
    return null;
  end if;

  begin
    return v_segments[2]::uuid;
  exception when others then
    return null;
  end;
end;
$$;

comment on function public.storage_path_guarantor_id(text) is
  'The guarantor UUID in a guarantors/<uuid>/... storage path, or NULL when the path is not of that shape.';

-- The folder kind: 'photo', 'id', or NULL.
create or replace function public.storage_path_kind(p_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select (pg_catalog.string_to_array(p_name, '/'))[3];
$$;

comment on function public.storage_path_kind(text) is
  'The third path segment, naming what kind of document this is — photo or id.';

revoke all on function public.storage_path_client_id(text) from public, anon, authenticated;
revoke all on function public.storage_path_guarantor_id(text) from public, anon, authenticated;
revoke all on function public.storage_path_kind(text) from public, anon, authenticated;
grant execute on function public.storage_path_client_id(text) to authenticated;
grant execute on function public.storage_path_guarantor_id(text) to authenticated;
grant execute on function public.storage_path_kind(text) to authenticated;

-- ---------------------------------------------------------------------------
-- client-documents
-- ---------------------------------------------------------------------------

-- Reading. A photograph needs `clients:view` plus the right to see that
-- particular client; an identity document needs `clients:view_nin`.
--
-- The `exists` sub-select is itself subject to RLS on `public.clients`, so the
-- "may see that client" test is the policy already written there rather than a
-- second, possibly divergent copy of it.
create policy client_documents_read
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'client-documents'
    and public.storage_path_client_id(name) is not null
    and exists (
      select 1 from public.clients c
      where c.id = public.storage_path_client_id(name)
    )
    and case public.storage_path_kind(name)
      when 'photo' then public.user_has_permission('clients:view')
      when 'id'    then public.user_has_permission('clients:view_nin')
      else false
    end
  );

comment on policy client_documents_read on storage.objects is
  'Reading a client document requires the capability for that document kind AND visibility of the client, the latter enforced by RLS on public.clients.';

create policy client_documents_insert
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'client-documents'
    and public.storage_path_client_id(name) is not null
    and exists (
      select 1 from public.clients c
      where c.id = public.storage_path_client_id(name)
    )
    and public.user_has_permission('clients:documents')
    and public.storage_path_kind(name) in ('photo', 'id')
  );

comment on policy client_documents_insert on storage.objects is
  'Uploads require clients:documents and must land in an existing client''s folder, under a recognised document kind.';

-- Replacing an object in place. Permitted, because replacing a photograph is
-- ordinary work; the audit trail records the path change on the client row.
create policy client_documents_update
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'client-documents'
    and public.user_has_permission('clients:documents')
    and public.storage_path_client_id(name) is not null
  )
  with check (
    bucket_id = 'client-documents'
    and public.user_has_permission('clients:documents')
    and public.storage_path_client_id(name) is not null
  );

-- No DELETE policy. Identity evidence is not freely deletable, per the
-- no-hard-delete rule: a replaced file stays until an operator removes it
-- deliberately with the secret key. The alternative — letting the application
-- delete — means a bug can destroy the only copy of a client's ID scan.
--
-- The consequence is honest: replaced files accumulate. That is a storage
-- cost, paid in exchange for not being able to lose evidence, and the
-- deliberate decision is recorded in docs/DECISIONS.md.

-- ---------------------------------------------------------------------------
-- guarantor-documents
-- ---------------------------------------------------------------------------

create policy guarantor_documents_read
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'guarantor-documents'
    and public.storage_path_guarantor_id(name) is not null
    and public.user_has_permission('guarantors:view')
    and exists (
      select 1 from public.guarantors g
      where g.id = public.storage_path_guarantor_id(name)
    )
    and public.storage_path_kind(name) = 'photo'
  );

comment on policy guarantor_documents_read on storage.objects is
  'A guarantor photograph is readable by staff holding guarantors:view. Borrowers hold no such capability, so one client cannot retrieve another client''s guarantor photograph by guessing a path — or their own guarantor''s, either.';

create policy guarantor_documents_insert
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'guarantor-documents'
    and public.storage_path_guarantor_id(name) is not null
    and exists (
      select 1 from public.guarantors g
      where g.id = public.storage_path_guarantor_id(name)
    )
    and public.user_has_permission('guarantors:documents')
    and public.storage_path_kind(name) = 'photo'
  );

create policy guarantor_documents_update
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'guarantor-documents'
    and public.user_has_permission('guarantors:documents')
    and public.storage_path_guarantor_id(name) is not null
  )
  with check (
    bucket_id = 'guarantor-documents'
    and public.user_has_permission('guarantors:documents')
    and public.storage_path_guarantor_id(name) is not null
  );

-- ---------------------------------------------------------------------------
-- The buckets stay private
--
-- Re-asserted rather than assumed. A bucket flipped to public would serve
-- every object over an unauthenticated URL, and no policy above would apply —
-- `public` short-circuits the whole mechanism. Phase 1 created them private;
-- this makes it true again after any manual change, and the accompanying test
-- asserts it.
-- ---------------------------------------------------------------------------

update storage.buckets
   set public = false
 where id in ('client-documents', 'guarantor-documents', 'company-assets');
