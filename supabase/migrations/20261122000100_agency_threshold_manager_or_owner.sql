-- ===========================================================================
-- The approved policy for an above-threshold agency transaction: an
-- independent Manager **or** Owner, not the Owner alone
--
-- ## What this corrects
--
-- Operational task 5 closed decision L — whether `requires_approval_above`
-- should gate verification — and implemented it as the narrowest thing the
-- open question could become: `agency:verify_high_value`, granted to
-- `owner_admin` alone. The migration that did it says so in its own header:
-- "which is the Owner's".
--
-- That was a guess about an unresolved decision, and the guess was wrong. The
-- Owner's policy is an **independent Manager or Owner** — the same rule this
-- business already approved for bank deposits, recorded as Decision A rule 8:
--
--   > A different authorized Manager or Owner verifies clearance; no
--   > self-verification.
--
-- Owner-only is operationally worse and not more prudent: it leaves every
-- large counter transaction waiting for one person, which in a branch at
-- four o'clock means the customer is turned away or the amount is split to
-- get under the threshold. A threshold that is routinely worked around is not
-- a control.
--
-- ## What changes, and what deliberately does not
--
-- One grant. `agency:verify_high_value` goes to `manager` as well, and the
-- two refusal messages stop naming the Owner specifically.
--
-- **Nothing about the enforcement changes.** Both gates stay exactly where
-- they were and keep doing exactly what they did:
--
--   * `verify_agency_transaction()` refuses a caller without the capability,
--     early, with a sentence naming the figure and the threshold;
--   * `agency_high_value_authority_guard()` refuses the transition into
--     `posted` unless the profile recorded in `verified_by` holds it — read
--     from the row, not from the caller, so it binds any route that stamps a
--     verifier and posts directly.
--
-- And every separation-of-duties rule is untouched: the submitter still
-- cannot verify their own transaction (`SD001`), the revision guards still
-- refuse a verifier who has not seen the figures, the roster still decides
-- who may operate an agent account, and the audit log still records who
-- verified what.
--
-- ## Why the capability survives at all, now that two roles hold it
--
-- A fair objection: `agency:verify` is already `manager, owner_admin`, so
-- after this grant the two capabilities have identical holders and the
-- threshold narrows nobody. Three reasons it stays:
--
--   1. **The policy is now a grant, not a rule in a function.** The Owner can
--      make the threshold Owner-only again by revoking one row from
--      `role_permissions` — no migration, no change to any posting path. That
--      is the whole point of expressing it as a capability, and
--      `tests/db/agency-provider-provisioning.test.ts` proves it by revoking
--      the grant and watching the Manager be refused.
--   2. **It binds a role that does not exist yet.** A future Supervisor or
--      Teller role granted `agency:verify` does not get above-threshold
--      authority with it. Without the capability it would.
--   3. **The record says the threshold was met.** `verified_by` on an
--      above-threshold transaction is a profile the database checked against
--      a named capability at the moment it posted, which is what an auditor
--      asking "who approved this large withdrawal, and were they allowed to"
--      needs to read.
--
-- What the capability no longer claims is that only the Owner may act. The
-- messages said that and now do not.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. The grant, and the description that describes it
-- ---------------------------------------------------------------------------

insert into public.role_permissions (role_key, permission_key) values
  ('manager', 'agency:verify_high_value')
on conflict (role_key, permission_key) do nothing;

update public.permissions
   set description =
         'Verify an agency transaction whose amount exceeds its service''s approval threshold. Held by the Manager and the Owner: the approved policy is an independent Manager or Owner, never the officer who recorded it. Ordinary agency:verify is not enough above the threshold, so a role granted that alone does not inherit this.'
 where key = 'agency:verify_high_value';


-- ---------------------------------------------------------------------------
-- 2. The trigger's sentence
--
-- Replaced from the definition the database holds, with the two messages
-- reworded and nothing else altered: the early return for a non-posting
-- status, the already-posted exemption, the threshold read, the NULL-verifier
-- refusal and the capability check are carried across unchanged.
-- ---------------------------------------------------------------------------

create or replace function public.agency_high_value_authority_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_threshold bigint;
  v_type      text;
begin
  if new.status <> 'posted' then
    return new;
  end if;

  if tg_op = 'UPDATE' and old.status = 'posted' then
    return new;                       -- already posted; this is not the gate
  end if;

  select t.requires_approval_above, t.name into v_threshold, v_type
  from public.agency_transaction_types t where t.id = new.transaction_type_id;

  if v_threshold is null or new.principal_amount <= v_threshold then
    return new;
  end if;

  -- Above the threshold. The authority that counts is the one recorded on the
  -- transaction, not whoever happens to be running this statement.
  if new.verified_by is null then
    raise exception
      'A % of % shillings is above the % threshold at which an independent Manager or Owner must approve it, so it cannot post without a recorded verifier.',
      v_type, new.principal_amount, v_threshold
      using errcode = 'P0001';
  end if;

  if not public.profile_has_permission(new.verified_by, 'agency:verify_high_value') then
    raise exception
      'A % of % shillings is above the % threshold for this service. It must be verified by an authorized Manager or Owner.',
      v_type, new.principal_amount, v_threshold
      using errcode = 'SD001';
  end if;

  return new;
end;
$$;

comment on function public.agency_high_value_authority_guard() is
  'Operational task 5, policy corrected 20261122000100. Refuses an agency transaction posting above its service''s requires_approval_above threshold unless the profile recorded in verified_by holds agency:verify_high_value — the approved policy being an independent Manager or Owner. Reads the verifier''s authority rather than the caller''s, so it holds for any route that stamps a verifier and posts.';

revoke all on function public.agency_high_value_authority_guard()
  from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 3. The verification path's sentence
--
-- Replaced from the definition the database holds. One string changed:
-- "Ask the Owner to verify it." becomes the policy as approved. The
-- idempotent return, both revision guards, the maker-checker refusal, the
-- `verified_by` stamp and both audit writes are carried across byte for byte.
-- ---------------------------------------------------------------------------

create or replace function public.verify_agency_transaction(
  p_transaction_id uuid,
  p_expected_revision integer default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  t       public.agency_transactions;
  v_entry uuid;
  v_threshold bigint;
  v_type_name text;
begin
  v_actor := public.agency_actor('agency:verify');

  t := public.agency_locked_transaction(p_transaction_id);

  if t.status = 'posted' then
    return t.journal_entry_id;               -- idempotent: already verified
  end if;

  if t.status <> 'awaiting_verification' then
    raise exception
      'Only a transaction awaiting verification can be verified; this one is %.', t.status
      using errcode = 'P0001';
  end if;

  if t.submitted_by = v_actor then
    raise exception
      'A transaction cannot be verified by the person who recorded it.'
      using errcode = 'SD001';
  end if;

  -- --- Operational task 5: the approval threshold --------------------------
  -- Above it, ordinary `agency:verify` is not enough. Refused here so the
  -- officer is told which authority is needed and by how much the amount
  -- exceeds the threshold, rather than meeting the trigger's refusal after
  -- the row has been stamped.
  select t2.requires_approval_above, t2.name into v_threshold, v_type_name
  from public.agency_transaction_types t2 where t2.id = t.transaction_type_id;

  if v_threshold is not null and t.principal_amount > v_threshold then
    if auth.uid() is not null
       and not (select public.user_has_permission('agency:verify_high_value')) then
      raise exception
        'A % of % shillings is above the % threshold for this service. An authorized Manager or Owner has to verify it.',
        v_type_name, t.principal_amount, v_threshold
        using errcode = 'SD001';
    end if;
  end if;

  -- --- the verifier must have seen the figures they are posting ------------
  if p_expected_revision is not null and p_expected_revision <> t.revision then
    raise exception
      'The financial details of this transaction changed since your screen loaded (you reviewed revision %, it is now revision %). Reload and review the current values before verifying.',
      p_expected_revision, t.revision
      using errcode = 'P0001';
  end if;

  if p_expected_revision is null and t.revision is distinct from t.submitted_revision then
    raise exception
      'The financial details of this transaction changed after it was submitted (submitted at revision %, now revision %). Reload the transaction and verify the revision you reviewed.',
      t.submitted_revision, t.revision
      using errcode = 'P0001';
  end if;

  update public.agency_transactions set verified_by = v_actor where id = p_transaction_id;

  v_entry := public.post_agency_transaction(p_transaction_id);

  insert into public.agency_transaction_audit_log
    (transaction_id, action, actor_id, old_value, new_value)
  values (p_transaction_id, 'verify', v_actor,
          pg_catalog.jsonb_build_object('status', 'awaiting_verification'),
          pg_catalog.jsonb_build_object('status', 'posted', 'journal_entry_id', v_entry));

  insert into public.agency_transaction_audit_log
    (transaction_id, action, actor_id, new_value)
  values (p_transaction_id, 'post', v_actor,
          pg_catalog.jsonb_build_object('journal_entry_id', v_entry));

  return v_entry;
end;
$$;

comment on function public.verify_agency_transaction(uuid, integer) is
  'Phase 4B, extended by operational task 5 and corrected by 20261122000100. Verifies and posts an agency transaction somebody else recorded. Refuses the submitter, refuses a stale revision, and refuses a verifier without agency:verify_high_value where the amount exceeds the service''s approval threshold — the approved policy being an independent Manager or Owner. Idempotent: an already-posted transaction returns its journal.';

revoke all on function public.verify_agency_transaction(uuid, integer) from public, anon;
grant execute on function public.verify_agency_transaction(uuid, integer) to authenticated;
