-- ===========================================================================
-- Phase 3 — audit triggers for clients, guarantors, links and remarks.
--
-- Triggers rather than application calls, for the Phase 2 reason: a trigger
-- fires in the same transaction as the change, so the data and the trail
-- cannot disagree. An audit call in a Server Action is skipped by anything
-- that reaches the table another way, and "anything" includes a correct-looking
-- future refactor.
--
-- ## What is deliberately not captured
--
-- No National Identification Number appears in any audit row. A NIN is
-- reusable identity evidence, and `audit_log` is readable by `audit:view` —
-- a different, broader capability than `clients:view_nin`. Writing NINs into
-- the trail would quietly undo the separation that `client_identities` exists
-- to create.
--
-- So an identity change records *that* the number changed and what it now
-- ends in, never the numbers themselves. "Changed, now ending 7K2" is enough
-- to investigate a suspicious correction; the full before-and-after is in
-- neither place it should not be.
--
-- Storage paths are recorded, because a path is not content: it is the only
-- way to tell which file a change replaced, and the object itself stays
-- behind a private bucket policy.
-- ===========================================================================

-- A NIN reduced to something safe to store: the last three characters, which
-- distinguish a correction from a substitution without being the number.
create or replace function public.mask_nin(p_nin text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_nin is null then null
    else '***' || pg_catalog.right(p_nin, 3)
  end;
$$;

comment on function public.mask_nin(text) is
  'Reduces a National Identification Number to its last three characters, for audit metadata that must not carry the number itself.';

revoke all on function public.mask_nin(text) from public, anon, authenticated;
grant execute on function public.mask_nin(text) to authenticated;

-- ---------------------------------------------------------------------------
-- The actor, resolved once
-- ---------------------------------------------------------------------------

create or replace function public.audit_actor_label()
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  v_label text;
begin
  v_actor := public.current_profile_id();

  if v_actor is not null then
    select p.full_name into v_label from public.profiles p where p.id = v_actor;
  end if;

  return coalesce(nullif(pg_catalog.btrim(v_label), ''), 'system');
end;
$$;

comment on function public.audit_actor_label() is
  'The acting user''s name for an audit row, or ''system'' when there is no session — migrations, the privileged client, scheduled work.';

revoke all on function public.audit_actor_label() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- clients
-- ---------------------------------------------------------------------------

create or replace function public.audit_client_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_action text;
  v_old    jsonb;
  v_new    jsonb;
begin
  if tg_op = 'INSERT' then
    v_action := 'client.created';
    v_new := pg_catalog.jsonb_build_object(
      'client_number', new.client_number,
      'full_name', new.full_name,
      'phone', new.phone,
      'district', new.district,
      'village_area', new.village_area,
      'occupation', new.occupation,
      'status', new.status
    );
  else
    -- One change, one name. A status change that also corrects a phone number
    -- is recorded as a status change, because that is the part somebody will
    -- later search for.
    if new.status is distinct from old.status then
      v_action := 'client.status_changed';
    elsif new.profile_id is distinct from old.profile_id then
      v_action := case
        when new.profile_id is null then 'client.auth_unlinked'
        else 'client.auth_linked'
      end;
    elsif new.photo_path is distinct from old.photo_path then
      v_action := 'client.photo_changed';
    else
      v_action := 'client.updated';
    end if;

    v_old := pg_catalog.jsonb_build_object(
      'full_name', old.full_name,
      'phone', old.phone,
      'alternative_phone', old.alternative_phone,
      'occupation', old.occupation,
      'business_type', old.business_type,
      'village_area', old.village_area,
      'district', old.district,
      'status', old.status,
      'status_reason', old.status_reason,
      'photo_path', old.photo_path,
      'profile_id', old.profile_id
    );
    v_new := pg_catalog.jsonb_build_object(
      'full_name', new.full_name,
      'phone', new.phone,
      'alternative_phone', new.alternative_phone,
      'occupation', new.occupation,
      'business_type', new.business_type,
      'village_area', new.village_area,
      'district', new.district,
      'status', new.status,
      'status_reason', new.status_reason,
      'photo_path', new.photo_path,
      'profile_id', new.profile_id
    );
  end if;

  insert into public.audit_log (
    actor_profile_id, actor_auth_user_id, actor_label,
    action, entity_type, entity_id, old_values, new_values
  )
  values (
    public.current_profile_id(), auth.uid(), public.audit_actor_label(),
    v_action, 'client', new.id::text, v_old, v_new
  );

  return null;
end;
$$;

comment on function public.audit_client_change() is
  'AFTER INSERT/UPDATE on clients. Records no National Identification Number: that is audited separately and masked.';

create trigger audit_client_change
  after insert or update on public.clients
  for each row execute function public.audit_client_change();

-- ---------------------------------------------------------------------------
-- client_identities — masked
-- ---------------------------------------------------------------------------

create or replace function public.audit_client_identity_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_action text;
begin
  if tg_op = 'INSERT' then
    v_action := 'client.identity_recorded';
  elsif new.id_document_path is distinct from old.id_document_path then
    v_action := 'client.document_changed';
  else
    v_action := 'client.identity_updated';
  end if;

  insert into public.audit_log (
    actor_profile_id, actor_auth_user_id, actor_label,
    action, entity_type, entity_id, old_values, new_values
  )
  values (
    public.current_profile_id(), auth.uid(), public.audit_actor_label(),
    v_action, 'client_identity', new.client_id::text,
    case when tg_op = 'INSERT' then null else pg_catalog.jsonb_build_object(
      -- Masked: enough to tell a correction from a substitution, not enough
      -- to be the number.
      'nin_masked', public.mask_nin(old.nin),
      'nin_present', old.nin is not null,
      'id_document_path', old.id_document_path
    ) end,
    pg_catalog.jsonb_build_object(
      'nin_masked', public.mask_nin(new.nin),
      'nin_present', new.nin is not null,
      'id_document_path', new.id_document_path
    )
  );

  return null;
end;
$$;

comment on function public.audit_client_identity_change() is
  'AFTER INSERT/UPDATE on client_identities. Stores only a masked NIN, because audit:view is broader than clients:view_nin.';

create trigger audit_client_identity_change
  after insert or update on public.client_identities
  for each row execute function public.audit_client_identity_change();

-- ---------------------------------------------------------------------------
-- guarantors
-- ---------------------------------------------------------------------------

create or replace function public.audit_guarantor_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_action text;
  v_old    jsonb;
  v_new    jsonb;
begin
  if tg_op = 'INSERT' then
    v_action := 'guarantor.created';
    v_new := pg_catalog.jsonb_build_object(
      'full_name', new.full_name,
      'phone', new.phone,
      'location', new.location,
      'occupation', new.occupation
    );
  else
    v_action := case
      when new.photo_path is distinct from old.photo_path
        then 'guarantor.photo_changed'
      else 'guarantor.updated'
    end;

    v_old := pg_catalog.jsonb_build_object(
      'full_name', old.full_name,
      'phone', old.phone,
      'alternative_phone', old.alternative_phone,
      'location', old.location,
      'district', old.district,
      'occupation', old.occupation,
      'photo_path', old.photo_path
    );
    v_new := pg_catalog.jsonb_build_object(
      'full_name', new.full_name,
      'phone', new.phone,
      'alternative_phone', new.alternative_phone,
      'location', new.location,
      'district', new.district,
      'occupation', new.occupation,
      'photo_path', new.photo_path
    );
  end if;

  insert into public.audit_log (
    actor_profile_id, actor_auth_user_id, actor_label,
    action, entity_type, entity_id, old_values, new_values
  )
  values (
    public.current_profile_id(), auth.uid(), public.audit_actor_label(),
    v_action, 'guarantor', new.id::text, v_old, v_new
  );

  return null;
end;
$$;

create trigger audit_guarantor_change
  after insert or update on public.guarantors
  for each row execute function public.audit_guarantor_change();

create or replace function public.audit_guarantor_identity_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.audit_log (
    actor_profile_id, actor_auth_user_id, actor_label,
    action, entity_type, entity_id, old_values, new_values
  )
  values (
    public.current_profile_id(), auth.uid(), public.audit_actor_label(),
    case when tg_op = 'INSERT'
      then 'guarantor.identity_recorded'
      else 'guarantor.identity_updated' end,
    'guarantor_identity', new.guarantor_id::text,
    case when tg_op = 'INSERT' then null else pg_catalog.jsonb_build_object(
      'nin_masked', public.mask_nin(old.nin),
      'nin_present', old.nin is not null
    ) end,
    pg_catalog.jsonb_build_object(
      'nin_masked', public.mask_nin(new.nin),
      'nin_present', new.nin is not null
    )
  );

  return null;
end;
$$;

create trigger audit_guarantor_identity_change
  after insert or update on public.guarantor_identities
  for each row execute function public.audit_guarantor_identity_change();

-- ---------------------------------------------------------------------------
-- client_guarantors
-- ---------------------------------------------------------------------------

create or replace function public.audit_client_guarantor_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_action text;
begin
  if tg_op = 'INSERT' then
    v_action := 'guarantor.linked';
  elsif old.active and not new.active then
    v_action := 'guarantor.unlinked';
  else
    v_action := 'guarantor.link_updated';
  end if;

  insert into public.audit_log (
    actor_profile_id, actor_auth_user_id, actor_label,
    action, entity_type, entity_id, old_values, new_values
  )
  values (
    public.current_profile_id(), auth.uid(), public.audit_actor_label(),
    v_action, 'client_guarantor', new.id::text,
    case when tg_op = 'INSERT' then null else pg_catalog.jsonb_build_object(
      'relationship_to_client', old.relationship_to_client,
      'active', old.active
    ) end,
    pg_catalog.jsonb_build_object(
      'client_id', new.client_id,
      'guarantor_id', new.guarantor_id,
      'relationship_to_client', new.relationship_to_client,
      'active', new.active,
      'detached_reason', new.detached_reason
    )
  );

  return null;
end;
$$;

create trigger audit_client_guarantor_change
  after insert or update on public.client_guarantors
  for each row execute function public.audit_client_guarantor_change();

-- ---------------------------------------------------------------------------
-- client_remarks
--
-- The remark body is not copied into the trail. It is already in an
-- append-only table that cannot be edited or deleted, so duplicating it would
-- add a second copy to keep consistent and would put staff commentary in front
-- of `audit:view` holders who were given that capability for a different
-- purpose. What is recorded is that a remark was added, by whom, and of what
-- category.
-- ---------------------------------------------------------------------------

create or replace function public.audit_client_remark_added()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.audit_log (
    actor_profile_id, actor_auth_user_id, actor_label,
    action, entity_type, entity_id, new_values
  )
  values (
    public.current_profile_id(), auth.uid(), public.audit_actor_label(),
    'client.remark_added', 'client_remark', new.id::text,
    pg_catalog.jsonb_build_object(
      'client_id', new.client_id,
      'category', new.category,
      'body_length', char_length(new.body),
      'retracts_remark_id', new.retracts_remark_id
    )
  );

  return null;
end;
$$;

comment on function public.audit_client_remark_added() is
  'AFTER INSERT on client_remarks. Records that a remark exists, not its text: the text is already in an append-only table.';

create trigger audit_client_remark_added
  after insert on public.client_remarks
  for each row execute function public.audit_client_remark_added();

revoke all on function public.audit_client_change() from public, anon, authenticated;
revoke all on function public.audit_client_identity_change() from public, anon, authenticated;
revoke all on function public.audit_guarantor_change() from public, anon, authenticated;
revoke all on function public.audit_guarantor_identity_change() from public, anon, authenticated;
revoke all on function public.audit_client_guarantor_change() from public, anon, authenticated;
revoke all on function public.audit_client_remark_added() from public, anon, authenticated;
