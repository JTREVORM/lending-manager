-- ===========================================================================
-- Operational task 5 — what has to be true before a provider goes live
--
-- ## The three gaps this closes
--
-- ### 1. `requires_approval_above` was configuration, not a control
--
-- `app/(app)/agency/providers/page.tsx` shows the column and strikes it
-- through, and its header says exactly why:
--
--   > Shown because it is configured and somebody will ask what it does, and
--   > marked as not enforced because it is not. Decision L — whether a
--   > threshold should gate verification — is unresolved, and the posting
--   > engine does not read this column.
--
-- The e2e seed says the same thing beside the one value it sets:
-- "Configured, and not enforced: the posting engine does not read it."
--
-- It is enforced from here. A transaction whose principal exceeds its
-- service's threshold may be verified only by somebody holding
-- `agency:verify_high_value`, which is the Owner's. That is "threshold
-- verification": the ordinary ceiling (`max_single_transaction`) says what
-- may be transacted at all and has been enforced since Phase 4A; the
-- threshold says what may be transacted *without the Owner looking at it*.
--
-- Enforced twice, deliberately. `verify_agency_transaction()` refuses early,
-- with a sentence naming the figure and the authority needed. A trigger on
-- `agency_transactions` then refuses the transition into `posted` whenever the
-- recorded verifier does not hold the capability — and it checks the
-- *verifier's* authority, read from `verified_by`, not the caller's. The
-- trigger is the guarantee: it holds for any route, including one that stamps
-- `verified_by` and calls `post_agency_transaction()` directly.
--
-- ### 2. A float facility was a number nobody had agreed
--
-- Float arrives by replenishment or purchase, and nothing capped it. A
-- partner that has agreed to advance 10,000,000 of float could be replenished
-- to 90,000,000 without a refusal, because POLYTOS held no record of what was
-- agreed. `float_facility_limit` records it, approved on the same authority
-- as the commercial terms and against a named instrument, and float cannot be
-- taken above it.
--
-- Scoped per provider, not per agent account: a facility is granted by the
-- partner to the business, and the business decides how to spread it across
-- its outlets. A cash-payable partner has no facility at all, and the CHECK
-- says so — there is no float to extend.
--
-- ### 3. Nothing stood between "terms approved" and "live"
--
-- Operational task 1 gave terms their second person. It deliberately left
-- `is_active` alone, because approving what a partner pays and deciding that
-- POLYTOS is ready to transact on that partner's behalf are two judgements.
-- This migration is the second one, and it has preconditions:
--
--   * the terms are approved (the provider is not provisional);
--   * it earns something, or reports what it earns;
--   * at least one service is active and states a ceiling;
--   * at least one agent account is open to transact through;
--   * if the partner advances float, a facility is approved;
--   * the authorization names the instrument it was given under;
--   * and the person authorizing it is not the person who registered it.
--
-- All seven are checked by `activate_agency_provider()`, and the four that
-- can be re-derived from the row are checked again by a trigger on the
-- `is_active` transition, so going live is not something an UPDATE can do.
--
-- ## Preserved
--
-- `max_single_transaction` enforcement, the readiness guard, the maker-checker
-- on verification, the submitter/verifier separation, every RLS policy and
-- every existing capability are untouched. `verify_agency_transaction()` is
-- replaced from the definition the database holds with one block inserted;
-- its signature, volatility, definer status, search_path, idempotent return,
-- revision guards and audit writes are carried across byte for byte.
--
-- Nothing is activated by this migration. All nine catalogue providers remain
-- provisional and inactive, which is the state the brief requires.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. Whether a *particular person* holds a capability
--
-- `user_has_permission()` answers for the current session. The high-value
-- trigger has to answer for the profile recorded in `verified_by`, which may
-- not be the session — `post_agency_transaction()` is `SECURITY DEFINER` and
-- a trusted path may have no JWT at all. Same two joins, one argument.
-- ---------------------------------------------------------------------------

create or replace function public.profile_has_permission(
  p_profile_id uuid,
  p_permission_key text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.user_roles ur
    join public.role_permissions rp on rp.role_key = ur.role_key
    where ur.profile_id = p_profile_id
      and rp.permission_key = p_permission_key
  )
$$;

comment on function public.profile_has_permission(uuid, text) is
  'Operational task 5. Whether a named profile holds a capability, as opposed to user_has_permission(), which answers for the current session. Needed where the authority that matters is the one recorded on a document rather than the one making the call.';

revoke all on function public.profile_has_permission(uuid, text)
  from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 2. The capabilities
-- ---------------------------------------------------------------------------

insert into public.permissions (key, description) values
  ('agency:verify_high_value',
   'Verify an agency transaction whose amount exceeds its service''s approval threshold. The ordinary agency:verify capability is not enough above the threshold: that is what the threshold is for.')
on conflict (key) do nothing;

insert into public.role_permissions (role_key, permission_key) values
  ('owner_admin', 'agency:verify_high_value')
on conflict (role_key, permission_key) do nothing;


-- ---------------------------------------------------------------------------
-- 3. The float facility, and the activation trail
-- ---------------------------------------------------------------------------

alter table public.agency_service_providers
  add column float_facility_limit  bigint,
  add column facility_reference    text,
  add column facility_approved_by  uuid references public.profiles(id) on delete set null,
  add column facility_approved_at  timestamptz,
  add column facility_note         text,
  add column activated_by          uuid references public.profiles(id) on delete set null,
  add column activated_at          timestamptz,
  add column activation_reference  text,
  add column activation_note       text,
  add column deactivated_by        uuid references public.profiles(id) on delete set null,
  add column deactivated_at        timestamptz,
  add column deactivation_reason   text;

comment on column public.agency_service_providers.float_facility_limit is
  'Operational task 5. The most electronic float, in shillings, that this partner has agreed to advance across all of the business''s agent accounts. Float cannot be replenished or purchased above it. NULL means no facility is approved, which for a provider_float partner means it cannot go live; a cash_payable partner has none by construction, because it advances no float.';

comment on column public.agency_service_providers.activation_reference is
  'Operational task 5. The instrument the decision to go live was taken under — a board minute, a signed authority, a dated instruction. Required to activate, because "somebody switched it on" is not an authorization.';

alter table public.agency_service_providers
  add constraint agency_providers_facility_positive
  check (float_facility_limit is null or float_facility_limit > 0);

-- A partner that holds the customer's cash advances no float, so a facility
-- on one is a number with no meaning.
alter table public.agency_service_providers
  add constraint agency_providers_no_facility_for_cash_payable
  check (float_model <> 'cash_payable' or float_facility_limit is null);

-- A facility is a commercial grant: it has an approver and an instrument.
alter table public.agency_service_providers
  add constraint agency_providers_facility_states_authority
  check (float_facility_limit is null
         or (facility_approved_by is not null
             and facility_approved_at is not null
             and pg_catalog.btrim(coalesce(facility_reference, '')) <> ''));

alter table public.agency_service_providers
  add constraint agency_providers_facility_reference_shape
  check (facility_reference is null
         or (pg_catalog.btrim(facility_reference) = facility_reference
             and pg_catalog.length(facility_reference) between 2 and 120));

alter table public.agency_service_providers
  add constraint agency_providers_activation_reference_shape
  check (activation_reference is null
         or (pg_catalog.btrim(activation_reference) = activation_reference
             and pg_catalog.length(activation_reference) between 2 and 120));


-- ---------------------------------------------------------------------------
-- 4. `set_agency_float_facility()`
--
-- The same authority that approves what a partner pays approves how much of
-- the partner's money the business may hold, and for the same reason: both
-- are terms of the commercial agreement, and neither is an operational
-- setting. So `agency:provider_approval`, and not the registrant.
-- ---------------------------------------------------------------------------

create or replace function public.set_agency_float_facility(
  p_provider_id uuid,
  p_limit       bigint,
  p_reference   text,
  p_note        text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  pr      public.agency_service_providers;
  v_ref   text;
  v_held  bigint;
  v_old   bigint;
begin
  if auth.uid() is not null
     and not (select public.user_has_permission('agency:provider_approval')) then
    raise exception 'Not authorized to approve an agency float facility.'
      using errcode = '42501';
  end if;

  v_actor := public.current_profile_id();
  v_ref := nullif(pg_catalog.btrim(coalesce(p_reference, '')), '');

  select * into pr from public.agency_service_providers
  where id = p_provider_id for update;

  if pr.id is null then
    raise exception 'No such agency provider.' using errcode = 'P0001';
  end if;

  if v_actor is not null and pr.registered_by is not null and v_actor = pr.registered_by then
    raise exception
      'You registered %, so you cannot also approve its float facility. A different Owner or Administrator must.',
      pr.name
      using errcode = 'SD001';
  end if;

  if pr.float_model <> 'provider_float' then
    raise exception
      '% holds the customer''s cash and advances no float, so it has no facility to approve.',
      pr.name
      using errcode = 'P0001';
  end if;

  if p_limit is null or p_limit <= 0 then
    raise exception
      'A float facility must be a positive number of shillings. NULL means no facility is approved, which is what %''s facility already says.',
      pr.name
      using errcode = 'P0001';
  end if;

  if v_ref is null then
    raise exception
      'Record the instrument this facility is granted under. POLYTOS does not hold the agreement, so the record has to say where it is.'
      using errcode = 'P0001';
  end if;

  -- Lowering a facility below the float already held would make the next
  -- reconciliation read as a breach of a limit that was never breached.
  select coalesce(pg_catalog.sum(coalesce(b.balance, 0)), 0) into v_held
    from public.agency_provider_float_accounts f
    left join public.ledger_account_balances b on b.account_id = f.ledger_account_id
   where f.provider_id = p_provider_id;

  if p_limit < v_held then
    raise exception
      '% already holds % shillings of float, which is more than the % facility being approved. Sell or transfer the excess off first.',
      pr.name, v_held, p_limit
      using errcode = 'P0001';
  end if;

  v_old := pr.float_facility_limit;

  update public.agency_service_providers
     set float_facility_limit = p_limit,
         facility_reference   = v_ref,
         facility_approved_by = v_actor,
         facility_approved_at = pg_catalog.now(),
         facility_note        = nullif(pg_catalog.btrim(coalesce(p_note, '')), ''),
         updated_at           = pg_catalog.now()
   where id = p_provider_id;

  perform public.record_audit_event(
    'agency_provider.float_facility_set', 'agency_provider', p_provider_id::text,
    pg_catalog.jsonb_build_object('float_facility_limit', v_old),
    pg_catalog.jsonb_build_object('float_facility_limit', p_limit),
    pg_catalog.jsonb_build_object(
      'provider_code', pr.code, 'facility_reference', v_ref,
      'float_held', v_held,
      'note', nullif(pg_catalog.btrim(coalesce(p_note, '')), '')),
    null);
end;
$$;

comment on function public.set_agency_float_facility(uuid, bigint, text, text) is
  'Operational task 5. Approves the most electronic float a partner has agreed to advance, against a named instrument. Requires agency:provider_approval, refuses the profile that registered the provider with SQLSTATE SD001, refuses a cash_payable partner, and refuses a facility smaller than the float already held.';

revoke all on function public.set_agency_float_facility(uuid, bigint, text, text)
  from public, anon;
grant execute on function public.set_agency_float_facility(uuid, bigint, text, text)
  to authenticated;


-- ---------------------------------------------------------------------------
-- 5. Float cannot be taken above the facility
--
-- One guard, two tables. It fires where float is *acquired* — a replenishment,
-- and a purchase — and not on a sale or a line-to-line transfer, neither of
-- which raises the provider's total.
--
-- A trade is recorded pending and posts on verification, so the guard runs on
-- INSERT (refusing early, before anybody is asked to verify an impossible
-- trade) and again on the transition to `posted`. A facility that shrank, or
-- another trade that posted, in between is therefore caught.
--
-- ## The two moments count differently, and getting this wrong costs a false
-- ## refusal
--
-- Whether the incoming float is *already in the balance* when the guard runs
-- depends on which document it is, because the two functions order their work
-- differently:
--
--   * `post_float_replenishment()` inserts the document and *then* calls
--     `post_journal()`. At INSERT the float has not arrived, so the test is
--     `held + amount > limit`.
--   * `verify_agency_float_trade()` calls `post_journal()` and *then* updates
--     the trade to `posted`. By the time the guard sees that update the float
--     is already in the balance, so the test is `held > limit`. Adding the
--     amount again would refuse a purchase that exactly fills an empty
--     facility — a 10,000,000 purchase against a 10,000,000 facility would
--     compute 20,000,000 — which is a false refusal of a legitimate trade.
--
-- A trade's own INSERT posts nothing, so it is counted the first way.
--
-- A provider with no facility is **not** refused here. That would break every
-- fixture and every existing float account, and it would be the wrong place:
-- a provider with no approved facility cannot be activated at all (§7), and
-- nothing can be posted against an inactive provider. The facility check is
-- about staying inside an agreed limit, not about having one.
-- ---------------------------------------------------------------------------

create or replace function public.agency_float_facility_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account  uuid;
  v_amount   bigint;
  -- True where the incoming float is already in the ledger balance, so that
  -- it must not be added to it a second time. See the header above.
  v_posted   boolean := false;
  pr         record;
  v_held     bigint;
  v_would    bigint;
begin
  if tg_table_name = 'agency_float_trades' then
    -- Only a purchase brings float in from outside the provider.
    if new.kind <> 'purchase' then
      return new;
    end if;

    -- On INSERT, and on the one transition that posts it. Any other update of
    -- a posted trade is a correction of metadata and moves no float.
    if tg_op = 'UPDATE' then
      if not (old.status <> 'posted' and new.status = 'posted') then
        return new;
      end if;
      v_posted := true;
    end if;

    v_account := new.float_account_id;
    v_amount  := new.float_amount;
  else
    v_account := new.float_account_id;
    v_amount  := new.amount;
  end if;

  if v_account is null or v_amount is null or v_amount <= 0 then
    return new;
  end if;

  select p.id, p.name, p.float_facility_limit into pr
  from public.agency_provider_float_accounts f
  join public.agency_service_providers p on p.id = f.provider_id
  where f.id = v_account;

  if pr.id is null or pr.float_facility_limit is null then
    return new;
  end if;

  select coalesce(pg_catalog.sum(coalesce(b.balance, 0)), 0) into v_held
    from public.agency_provider_float_accounts f
    left join public.ledger_account_balances b on b.account_id = f.ledger_account_id
   where f.provider_id = pr.id;

  v_would := case when v_posted then v_held else v_held + v_amount end;

  if v_would > pr.float_facility_limit then
    raise exception
      '% has approved a float facility of % shillings. It holds %, so % more would take it to % — more than it agreed to advance.',
      pr.name, pr.float_facility_limit,
      case when v_posted then v_held - v_amount else v_held end,
      v_amount, v_would
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

comment on function public.agency_float_facility_guard() is
  'Operational task 5. Refuses a float replenishment or float purchase that would take a provider''s total float above the facility it has approved. Fires where float is acquired, not on a sale or a line-to-line transfer; a provider with no approved facility is not refused here, because it cannot be activated at all.';

revoke all on function public.agency_float_facility_guard()
  from public, anon, authenticated;

create trigger agency_float_replenishments_within_facility
  before insert on public.agency_float_replenishments
  for each row execute function public.agency_float_facility_guard();

create trigger agency_float_trades_within_facility
  before insert or update on public.agency_float_trades
  for each row execute function public.agency_float_facility_guard();


-- ---------------------------------------------------------------------------
-- 5b. `set_agency_service_threshold()`
--
-- `set_agency_service_limit()` from 20261115000300 sets the ceiling above
-- which nothing may be transacted at all. There has never been a setter for
-- the *threshold* — the amount above which the Owner has to look at it —
-- because until this migration the column was not read by anything, so a
-- screen that set it would have been configuring a control that did not
-- exist. It exists now, so it needs a way in.
--
-- Deliberately `agency:providers` and not `agency:provider_approval`: a
-- threshold is an internal operating limit on the business's own staff, not a
-- term of the partner's agreement. The facility and the commission terms are
-- the partner's and need the approval capability; this is the Owner deciding
-- how much they are willing to have posted without their own eyes on it.
-- ---------------------------------------------------------------------------

create or replace function public.set_agency_service_threshold(
  p_transaction_type_id     uuid,
  p_requires_approval_above bigint,
  p_reason                  text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_type     record;
  v_provider record;
  v_old      bigint;
begin
  if auth.uid() is not null
     and not (select public.user_has_permission('agency:providers')) then
    raise exception 'Not authorized to configure agency approval thresholds.'
      using errcode = '42501';
  end if;

  select t.id, t.code, t.name, t.provider_id, t.requires_approval_above,
         t.max_single_transaction
    into v_type
  from public.agency_transaction_types t
  where t.id = p_transaction_type_id;

  if v_type.id is null then
    raise exception 'No such agency service type.' using errcode = 'P0001';
  end if;

  select pr.id, pr.code, pr.name into v_provider
  from public.agency_service_providers pr where pr.id = v_type.provider_id;

  -- Zero is not "every transaction needs the Owner", it is a threshold that
  -- no amount can be below, and NULL already means nobody decided. Both are
  -- refused so the only way to express a threshold is to state one — the same
  -- rule `set_agency_service_limit()` applies to the ceiling.
  if p_requires_approval_above is null or p_requires_approval_above <= 0 then
    raise exception
      'An approval threshold must be a positive amount. NULL means nobody has decided, which is what % %''s threshold already says.',
      v_provider.name, v_type.name
      using errcode = 'P0001';
  end if;

  -- A threshold at or above the ceiling can never be reached, so it would be
  -- a control that reads as present and never fires.
  if v_type.max_single_transaction is not null
     and p_requires_approval_above >= v_type.max_single_transaction then
    raise exception
      'A % may not exceed % shillings, so a threshold of % could never be reached. Set it below the ceiling.',
      v_type.name, v_type.max_single_transaction, p_requires_approval_above
      using errcode = 'P0001';
  end if;

  v_old := v_type.requires_approval_above;

  update public.agency_transaction_types
     set requires_approval_above = p_requires_approval_above,
         updated_at              = now()
   where id = p_transaction_type_id;

  perform public.record_audit_event(
    'agency_service_type.threshold_set', 'agency_service_type',
    p_transaction_type_id::text,
    pg_catalog.jsonb_build_object('requires_approval_above', v_old),
    pg_catalog.jsonb_build_object('requires_approval_above', p_requires_approval_above),
    pg_catalog.jsonb_build_object(
      'provider_code', v_provider.code, 'service_code', v_type.code,
      'max_single_transaction', v_type.max_single_transaction,
      'reason', nullif(pg_catalog.btrim(coalesce(p_reason, '')), '')),
    null);

  return p_transaction_type_id;
end;
$$;

comment on function public.set_agency_service_threshold(uuid, bigint, text) is
  'Operational task 5. Sets the amount above which a service''s transactions may be verified only by a holder of agency:verify_high_value. Requires agency:providers — an internal operating limit on the business''s own staff, not a term of the partner''s agreement. Refuses a non-positive threshold and one at or above the service''s own ceiling, which could never be reached.';

revoke all on function public.set_agency_service_threshold(uuid, bigint, text)
  from public, anon;
grant execute on function public.set_agency_service_threshold(uuid, bigint, text)
  to authenticated;


-- ---------------------------------------------------------------------------
-- 6. Threshold verification
--
-- 6a. The guarantee: a trigger on the transition into `posted`.
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
      'A % of % shillings is above the % threshold at which the Owner must approve it, so it cannot post without a recorded verifier.',
      v_type, new.principal_amount, v_threshold
      using errcode = 'P0001';
  end if;

  if not public.profile_has_permission(new.verified_by, 'agency:verify_high_value') then
    raise exception
      'A % of % shillings is above the % threshold for this service. It must be verified by somebody authorized to approve amounts above it.',
      v_type, new.principal_amount, v_threshold
      using errcode = 'SD001';
  end if;

  return new;
end;
$$;

comment on function public.agency_high_value_authority_guard() is
  'Operational task 5. Refuses an agency transaction posting above its service''s requires_approval_above threshold unless the profile recorded in verified_by holds agency:verify_high_value. Reads the verifier''s authority rather than the caller''s, so it holds for any route that stamps a verifier and posts.';

revoke all on function public.agency_high_value_authority_guard()
  from public, anon, authenticated;

create trigger agency_transactions_high_value_authority
  before insert or update on public.agency_transactions
  for each row execute function public.agency_high_value_authority_guard();


-- ---------------------------------------------------------------------------
-- 6b. The early refusal, inside the verification path.
--
-- Replaced from the definition the database holds. One block added, marked
-- below; everything else — the idempotent return, the two revision guards,
-- the maker-checker refusal, the `verified_by` stamp and both audit writes —
-- is carried across unchanged.
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
        'A % of % shillings is above the % threshold for this service. Ask the Owner to verify it.',
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
  'Phase 4B, extended by operational task 5. Verifies and posts an agency transaction somebody else recorded. Refuses the submitter, refuses a stale revision, and — new — refuses a verifier without agency:verify_high_value where the amount exceeds the service''s approval threshold. Idempotent: an already-posted transaction returns its journal.';

revoke all on function public.verify_agency_transaction(uuid, integer) from public, anon;
grant execute on function public.verify_agency_transaction(uuid, integer) to authenticated;


-- ---------------------------------------------------------------------------
-- 7. Going live
--
-- 7a. The guarantee: a trigger on the `is_active` transition.
--
-- It governs the transition, not the state. A fixture or a seed that creates
-- a provider already active is untouched — that is a world being built, and
-- the readiness guard still refuses to post against it while it is
-- provisional. What cannot happen is a provider being *switched on* by an
-- UPDATE that did not satisfy the preconditions.
-- ---------------------------------------------------------------------------

create or replace function public.agency_provider_activation_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_types bigint;
  v_lines bigint;
begin
  if not (old.is_active = false and new.is_active = true) then
    return new;
  end if;

  if new.is_provisional then
    raise exception
      '%''s commercial terms are not approved, so it cannot go live. A second Owner or Administrator must approve them first.',
      new.name
      using errcode = 'P0001';
  end if;

  if pg_catalog.btrim(coalesce(new.activation_reference, '')) = ''
     or new.activated_by is null
     or new.activated_at is null then
    raise exception
      'Making % live is an authorization, so it must name who gave it and under what instrument. Use activate_agency_provider().',
      new.name
      using errcode = 'P0001';
  end if;

  if new.activated_by is not null and new.registered_by is not null
     and new.activated_by = new.registered_by then
    raise exception
      'The person who registered % cannot also authorize it to go live. A different Owner or Administrator must.',
      new.name
      using errcode = 'SD001';
  end if;

  -- Defence in depth behind `deactivate_agency_provider()`, which clears the
  -- trail: an authorization that predates the provider being taken out of
  -- service is last month's decision, not this one's.
  if new.deactivated_at is not null and new.activated_at <= new.deactivated_at then
    raise exception
      '% was taken out of service after that authorization was given, so it is not an authorization to put it back. Authorize it again.',
      new.name
      using errcode = 'P0001';
  end if;

  if new.float_model = 'provider_float' and new.float_facility_limit is null then
    raise exception
      '% advances electronic float and no facility has been approved for it, so there is no agreed limit on how much of its money the business may hold.',
      new.name
      using errcode = 'P0001';
  end if;

  select pg_catalog.count(*) into v_types
  from public.agency_transaction_types t
  where t.provider_id = new.id and t.is_active
    and t.max_single_transaction is not null;

  if v_types = 0 then
    raise exception
      '% has no active service with an approved ceiling, so there is nothing it could be asked to do. Set a limit on at least one service first.',
      new.name
      using errcode = 'P0001';
  end if;

  select pg_catalog.count(*) into v_lines
  from public.agency_provider_float_accounts f
  where f.provider_id = new.id and f.status = 'active';

  if v_lines = 0 then
    raise exception
      '% has no open agent account, so there is nothing to transact through. Register one first.',
      new.name
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

comment on function public.agency_provider_activation_guard() is
  'Operational task 5. Refuses the transition of an agency provider from inactive to active unless its terms are approved, the authorization names its author and instrument, that author is not the registrant, a float facility is approved where the partner advances float, at least one service is active with a ceiling, and at least one agent account is open.';

revoke all on function public.agency_provider_activation_guard()
  from public, anon, authenticated;

create trigger agency_service_providers_activation_guard
  before update on public.agency_service_providers
  for each row execute function public.agency_provider_activation_guard();


-- ---------------------------------------------------------------------------
-- 7b. `activate_agency_provider()`
--
-- The same seven preconditions, checked here so each has its own sentence,
-- then the UPDATE the trigger re-checks.
-- ---------------------------------------------------------------------------

create or replace function public.activate_agency_provider(
  p_provider_id             uuid,
  p_authorization_reference text,
  p_note                    text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  pr      public.agency_service_providers;
  v_ref   text;
begin
  if auth.uid() is not null
     and not (select public.user_has_permission('agency:provider_approval')) then
    raise exception 'Not authorized to make an agency provider live.'
      using errcode = '42501';
  end if;

  v_actor := public.current_profile_id();
  v_ref := nullif(pg_catalog.btrim(coalesce(p_authorization_reference, '')), '');

  select * into pr from public.agency_service_providers
  where id = p_provider_id for update;

  if pr.id is null then
    raise exception 'No such agency provider.' using errcode = 'P0001';
  end if;

  if pr.is_active then
    raise exception '% is already live.', pr.name using errcode = 'P0001';
  end if;

  if v_ref is null then
    raise exception
      'Record the instrument this authorization was given under — a board minute, a signed authority, a dated instruction. "Somebody switched it on" is not an authorization.'
      using errcode = 'P0001';
  end if;

  if pr.is_provisional then
    raise exception
      '%''s commercial terms are not approved, so it cannot go live. A second Owner or Administrator must approve them first.',
      pr.name
      using errcode = 'P0001';
  end if;

  if v_actor is not null and pr.registered_by is not null and v_actor = pr.registered_by then
    raise exception
      'You registered %, so you cannot also authorize it to go live. A different Owner or Administrator must.',
      pr.name
      using errcode = 'SD001';
  end if;

  if pr.commission_source = 'configured'
     and pr.commission_rate_bps is null
     and pr.commission_fixed is null then
    raise exception
      '% records no commission rate and no fixed commission, so what it earns is undecided.',
      pr.name
      using errcode = 'P0001';
  end if;

  if pr.float_model = 'provider_float' and pr.float_facility_limit is null then
    raise exception
      '% advances electronic float and no facility has been approved for it. Approve the facility it has agreed, with the instrument it was granted under, before it goes live.',
      pr.name
      using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from public.agency_transaction_types t
     where t.provider_id = p_provider_id and t.is_active
       and t.max_single_transaction is not null
  ) then
    raise exception
      '% has no active service with an approved ceiling. Set the limit on at least one service before it goes live.',
      pr.name
      using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from public.agency_provider_float_accounts f
     where f.provider_id = p_provider_id and f.status = 'active'
  ) then
    raise exception
      '% has no open agent account, so there is nothing to transact through. Register one before it goes live.',
      pr.name
      using errcode = 'P0001';
  end if;

  update public.agency_service_providers
     set is_active            = true,
         activated_by         = v_actor,
         activated_at         = pg_catalog.now(),
         activation_reference = v_ref,
         activation_note      = nullif(pg_catalog.btrim(coalesce(p_note, '')), ''),
         deactivated_by       = null,
         deactivated_at       = null,
         deactivation_reason  = null,
         updated_at           = pg_catalog.now()
   where id = p_provider_id;

  perform public.record_audit_event(
    'agency_provider.activated', 'agency_provider', p_provider_id::text,
    pg_catalog.jsonb_build_object('is_active', false),
    pg_catalog.jsonb_build_object('is_active', true),
    pg_catalog.jsonb_build_object(
      'provider_code', pr.code,
      'authorization_reference', v_ref,
      'float_facility_limit', pr.float_facility_limit,
      'note', nullif(pg_catalog.btrim(coalesce(p_note, '')), '')),
    null);
end;
$$;

comment on function public.activate_agency_provider(uuid, text, text) is
  'Operational task 5. Makes an agency provider live, once its terms are approved, it earns something, a service has a ceiling, an agent account is open and — where it advances float — a facility is approved. Requires agency:provider_approval, refuses the profile that registered it with SQLSTATE SD001, and records the instrument the authorization was given under.';

revoke all on function public.activate_agency_provider(uuid, text, text) from public, anon;
grant execute on function public.activate_agency_provider(uuid, text, text) to authenticated;


-- ---------------------------------------------------------------------------
-- 7c. `deactivate_agency_provider()`
--
-- Taking a provider out of service needs a reason and no preconditions. It is
-- the safe direction: the readiness guard then refuses every new posting,
-- while reversals of what is already posted stay possible, which is the
-- exemption Phase 4B wrote for exactly this case.
-- ---------------------------------------------------------------------------

create or replace function public.deactivate_agency_provider(
  p_provider_id uuid,
  p_reason      text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid;
  pr       public.agency_service_providers;
  v_reason text;
  v_open   bigint;
begin
  if auth.uid() is not null
     and not (select public.user_has_permission('agency:provider_approval')) then
    raise exception 'Not authorized to take an agency provider out of service.'
      using errcode = '42501';
  end if;

  v_actor := public.current_profile_id();
  v_reason := nullif(pg_catalog.btrim(coalesce(p_reason, '')), '');

  if v_reason is null then
    raise exception 'Say why this provider is being taken out of service.'
      using errcode = 'P0001';
  end if;

  select * into pr from public.agency_service_providers
  where id = p_provider_id for update;

  if pr.id is null then
    raise exception 'No such agency provider.' using errcode = 'P0001';
  end if;

  if not pr.is_active then
    raise exception '% is already out of service.', pr.name using errcode = 'P0001';
  end if;

  -- Said rather than refused. Transactions awaiting verification are not
  -- blocked by an inactive provider only by accident — the readiness guard
  -- reads `is_active` at posting — so this is the moment to point them out.
  select pg_catalog.count(*) into v_open
  from public.agency_transactions t
  where t.provider_id = p_provider_id
    and t.status in ('draft', 'awaiting_verification');

  -- The activation trail is cleared, not kept as history. Keeping it would
  -- leave a provider that has been taken out of service carrying a complete
  -- authorization, and the activation guard reads exactly those columns — so a
  -- bare `update ... set is_active = true` would pass on last month's board
  -- minute. Going live again is a new decision and needs a new authorization.
  -- The one that was given is not lost: `agency_provider.activated` is in the
  -- audit log with its instrument, and so is this deactivation.
  update public.agency_service_providers
     set is_active            = false,
         activated_by         = null,
         activated_at         = null,
         activation_reference = null,
         activation_note      = null,
         deactivated_by       = v_actor,
         deactivated_at       = pg_catalog.now(),
         deactivation_reason  = v_reason,
         updated_at           = pg_catalog.now()
   where id = p_provider_id;

  perform public.record_audit_event(
    'agency_provider.deactivated', 'agency_provider', p_provider_id::text,
    pg_catalog.jsonb_build_object('is_active', true),
    pg_catalog.jsonb_build_object('is_active', false),
    pg_catalog.jsonb_build_object(
      'provider_code', pr.code, 'reason', v_reason,
      'unresolved_transactions', v_open),
    null);
end;
$$;

comment on function public.deactivate_agency_provider(uuid, text) is
  'Operational task 5. Takes a live agency provider out of service with a stated reason, and clears its activation trail so that going live again needs a fresh authorization rather than the one already spent. No preconditions: it is the safe direction. The audit event records how many of its transactions were still unresolved, because each will now be refused at posting.';

revoke all on function public.deactivate_agency_provider(uuid, text) from public, anon;
grant execute on function public.deactivate_agency_provider(uuid, text) to authenticated;


-- ---------------------------------------------------------------------------
-- 8. What a screen needs to show before anybody presses the button
--
-- One row per provider, with each precondition answered. A screen that lists
-- what is outstanding, rather than offering a button that fails, needs this.
-- ---------------------------------------------------------------------------

create view public.agency_provider_readiness
with (security_invoker = true) as
select
  p.id                       as provider_id,
  p.code                     as provider_code,
  p.name                     as provider_name,
  p.category,
  p.float_model,
  p.commission_model,
  p.commission_source,
  p.commission_rate_bps,
  p.commission_fixed,
  p.is_provisional,
  p.is_active,
  p.terms_reference,
  p.terms_approved_at,
  p.float_facility_limit,
  p.facility_reference,
  p.facility_approved_at,
  p.activation_reference,
  p.activated_at,
  p.deactivated_at,
  p.deactivation_reason,

  (not p.is_provisional)                                    as terms_approved,
  (p.commission_source = 'reported'
     or p.commission_rate_bps is not null
     or p.commission_fixed is not null)                      as commission_decided,
  (p.float_model <> 'provider_float'
     or p.float_facility_limit is not null)                  as facility_approved,

  (select pg_catalog.count(*) from public.agency_transaction_types t
    where t.provider_id = p.id and t.is_active
      and t.max_single_transaction is not null)              as services_with_ceiling,
  (select pg_catalog.count(*) from public.agency_transaction_types t
    where t.provider_id = p.id and t.is_active
      and t.requires_approval_above is not null)             as services_with_threshold,
  (select pg_catalog.count(*) from public.agency_provider_float_accounts f
    where f.provider_id = p.id and f.status = 'active')      as open_agent_accounts,

  -- Cast, because `sum(bigint)` is `numeric` and `tests/db/schema.test.ts`
  -- fails the build on a numeric column anywhere in `public` — including one
  -- a view projects. Shillings are integral; nothing here needs a scale.
  (select coalesce(pg_catalog.sum(coalesce(b.balance, 0)), 0)::bigint
     from public.agency_provider_float_accounts f
     left join public.ledger_account_balances b on b.account_id = f.ledger_account_id
    where f.provider_id = p.id)                              as float_held,

  (
    not p.is_provisional
    and (p.commission_source = 'reported'
         or p.commission_rate_bps is not null
         or p.commission_fixed is not null)
    and (p.float_model <> 'provider_float' or p.float_facility_limit is not null)
    and exists (select 1 from public.agency_transaction_types t
                 where t.provider_id = p.id and t.is_active
                   and t.max_single_transaction is not null)
    and exists (select 1 from public.agency_provider_float_accounts f
                 where f.provider_id = p.id and f.status = 'active')
  )                                                          as ready_to_activate
from public.agency_service_providers p;

comment on view public.agency_provider_readiness is
  'Operational task 5. Every provider with each activation precondition answered separately, and ready_to_activate for all of them together. ready_to_activate says the provider''s own configuration is complete; it does not say the authorization has been given, which is a person''s decision and is recorded by activate_agency_provider(). security_invoker, so the reader''s RLS decides what they see.';

revoke all on public.agency_provider_readiness from public, anon, authenticated;
grant select on public.agency_provider_readiness to authenticated;
