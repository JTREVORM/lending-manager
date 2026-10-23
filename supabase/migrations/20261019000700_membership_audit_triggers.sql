-- ===========================================================================
-- Polytos Phase 1.7 — audit triggers for the membership tables
--
-- Triggers rather than calls in a Server Action, for the reason Phase 2
-- established and Phase 3 restated: a trigger fires in the same transaction
-- as the change, so the data and the trail cannot disagree. An audit call in
-- application code is skipped by anything that reaches the table another way,
-- and "anything" includes a correct-looking future refactor.
--
-- ## What is deliberately not captured
--
-- No personal data. A membership row holds none of its own — the member's
-- name, phone and National Identification Number all live on `clients` and
-- `client_identities`, whose own audit triggers already cover them under
-- their own rules, including the one that keeps a NIN out of the trail
-- entirely. Writing the member's name into a membership audit row would
-- quietly duplicate identity data into a table read under a different
-- capability, which is the separation `client_identities` exists to create.
--
-- So a membership audit row carries the membership number, the client's id,
-- the status either side of the change, the reason, and the policy version.
-- That is enough to answer "who did what to this membership, and when", and
-- it names nobody who is not already named by the client trail.
--
-- ## The policy trail is the important one
--
-- A membership policy version sets the registration fee, the savings
-- minimum, the benefit amounts and the interest rule. Changing one is the
-- membership analogue of changing a lending rate, which `audit_settings_change`
-- already records. The full before-and-after is captured here, because every
-- figure in it is a business term rather than somebody's data, and because
-- "who approved this version, and when" is the first question an auditor of
-- the programme will ask.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- memberships
-- ---------------------------------------------------------------------------

create or replace function public.audit_membership_change()
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
    v_action := 'membership.enrolled';
    v_new := pg_catalog.jsonb_build_object(
      'membership_number', new.membership_number,
      'client_id', new.client_id,
      'branch_id', new.branch_id,
      'policy_version_id', new.policy_version_id,
      'status', new.status,
      'applied_on', new.applied_on
    );
  else
    -- A status change and an ordinary correction are different events, and a
    -- reader of the trail should not have to diff two blobs to tell them
    -- apart.
    v_action := case
      when new.status is distinct from old.status then 'membership.status_changed'
      else 'membership.updated'
    end;

    v_old := pg_catalog.jsonb_build_object(
      'status', old.status,
      'status_reason', old.status_reason,
      'activated_on', old.activated_on,
      'ended_on', old.ended_on,
      'notes', old.notes
    );
    v_new := pg_catalog.jsonb_build_object(
      'status', new.status,
      'status_reason', new.status_reason,
      'activated_on', new.activated_on,
      'ended_on', new.ended_on,
      'notes', new.notes
    );
  end if;

  perform public.record_audit_event(
    v_action,
    'membership',
    new.id::text,
    v_old,
    v_new,
    pg_catalog.jsonb_build_object(
      'membership_number', new.membership_number,
      'client_id', new.client_id
    )
  );

  return new;
end;
$$;

comment on function public.audit_membership_change() is
  'AFTER INSERT/UPDATE on memberships: records the enrolment and every subsequent change. Carries no personal data — the member is the client, and the client trail already covers them.';

create trigger audit_membership_change
  after insert or update on public.memberships
  for each row execute function public.audit_membership_change();

revoke all on function public.audit_membership_change()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- membership_policy_versions
-- ---------------------------------------------------------------------------

create or replace function public.audit_membership_policy_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_action text;
  v_old    jsonb;
begin
  if tg_op = 'INSERT' then
    v_action := 'membership_policy.published';
  elsif new.approved_at is distinct from old.approved_at
        and new.approved_at is not null then
    v_action := 'membership_policy.approved';
  elsif new.status is distinct from old.status then
    v_action := 'membership_policy.status_changed';
  else
    v_action := 'membership_policy.updated';
  end if;

  if tg_op = 'UPDATE' then
    v_old := pg_catalog.to_jsonb(old) - 'created_at' - 'updated_at';
  end if;

  perform public.record_audit_event(
    v_action,
    'membership_policy',
    new.id::text,
    v_old,
    pg_catalog.to_jsonb(new) - 'created_at' - 'updated_at',
    pg_catalog.jsonb_build_object(
      'version', new.version,
      'is_financially_enabled', new.is_financially_enabled
    )
  );

  return new;
end;
$$;

comment on function public.audit_membership_policy_change() is
  'AFTER INSERT/UPDATE on membership_policy_versions: the full before-and-after. Every column is a business term rather than somebody''s personal data, and "who approved this, and when" is the first question an auditor asks of the programme.';

create trigger audit_membership_policy_change
  after insert or update on public.membership_policy_versions
  for each row execute function public.audit_membership_policy_change();

revoke all on function public.audit_membership_policy_change()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- membership_terms_acceptances
--
-- The signature image path is recorded; the signature itself is a file in a
-- private bucket. A path is not content — it is the only way to tell which
-- file an acceptance refers to — and the same reasoning applies here as to
-- the client document paths in `20261003000600`.
-- ---------------------------------------------------------------------------

create or replace function public.audit_membership_terms_accepted()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.record_audit_event(
    'membership_terms.accepted',
    'membership',
    new.membership_id::text,
    null,
    pg_catalog.jsonb_build_object(
      'acceptance_id', new.id,
      'policy_version', new.policy_version,
      'accepted_at', new.accepted_at,
      'signature_name', new.signature_name,
      'signature_path', new.signature_path,
      'witness_name', new.witness_name
    ),
    pg_catalog.jsonb_build_object('policy_version_id', new.policy_version_id)
  );

  return new;
end;
$$;

comment on function public.audit_membership_terms_accepted() is
  'AFTER INSERT on membership_terms_acceptances: records that a member was shown a version of the terms and signed it. Filed under the membership, so the acceptance and the enrolment read as one story.';

create trigger audit_membership_terms_accepted
  after insert on public.membership_terms_acceptances
  for each row execute function public.audit_membership_terms_accepted();

revoke all on function public.audit_membership_terms_accepted()
  from public, anon, authenticated;
