-- ===========================================================================
-- Phase 4E — an agent line is a thing with a name, a number and a state
--
-- Phase 4A gave `agency_provider_float_accounts` everything the *ledger*
-- needs: a provider, a branch, a till name and its own `1320.*` account,
-- unique on (provider, branch, till_name). What it has nothing of is what the
-- *business* needs to tell one line from another — the MSISDN a customer's
-- money actually moves through, the agent number printed on the provider's
-- statement, a name a person recognises, and whether the line is open.
--
-- ## `till_name` is not the label, and cannot become one
--
-- `till_name` is embedded in the ledger account code that
-- `ensure_agency_float_account()` mints: `1320.MTN_MOMO.BR2601`,
-- `1320.MTN_MOMO.BR2601.T2`. Renaming it would leave a code that names a till
-- that no longer exists, on an account carrying posted history. So `till_name`
-- stays immutable — enforced by a trigger below — and `label` is the editable
-- human name. Two columns because they answer two questions: which account,
-- and which line is this on the counter.
--
-- ## Three states, because OD-4 asks for three (two of them not "deleted")
--
-- Decision OD-4: "Normal deactivation requires zero float, settled commission
-- and no pending obligations. Emergency suspension immediately stops new
-- activity while retaining balances, histories and authorized recovery
-- operations."
--
--   active     — trading
--   suspended  — the emergency state. New activity stops at once; the float
--                balance, the history and the recovery operations remain.
--                Entered with a reason, left with a reason.
--   closed     — the orderly end. Reachable only from a line with zero float,
--                no outstanding commission and nothing pending (enforced in
--                20261115000300, where the function that performs it lives).
--
-- ## Why `is_active` survives
--
-- Two functions read it — the recording guard in 20261107000400 and
-- `post_float_replenishment()` — and `agency_float_balances` exposes it as
-- `till_is_active`. Replacing it would mean rewriting a view and two tested
-- posting paths for no gain. Instead it stays, and a CHECK ties it to
-- `status` so the two can never disagree: both `suspended` and `closed` read
-- as inactive, which is exactly the behaviour those three readers already
-- have for a line that must take no new business.
--
-- The coupling CHECK also means a future `update … set is_active = false`
-- that forgets the status fails loudly instead of creating a line that is
-- inactive for the engine and active on the screen.
--
-- Reversals deliberately do **not** read `is_active`, and that is what makes
-- OD-4's "authorized recovery operations" work on a suspended line without
-- any exception being carved out here.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. Identity
-- ---------------------------------------------------------------------------

alter table public.agency_provider_float_accounts
  add column if not exists label        text not null default '',
  add column if not exists line_msisdn  text,
  add column if not exists agent_code   text,
  add column if not exists opened_on    date,
  add column if not exists closed_on    date,
  add column if not exists notes        text,
  add column if not exists updated_by   uuid references public.profiles(id) on delete set null;

comment on column public.agency_provider_float_accounts.label is
  'Phase 4E. The human name of the agent line, as the counter calls it. Editable, unlike till_name, which is part of the ledger account code.';
comment on column public.agency_provider_float_accounts.line_msisdn is
  'Phase 4E. The agent line''s own number, in the same +256 form as every other phone in this schema. The number the provider''s float actually sits behind.';
comment on column public.agency_provider_float_accounts.agent_code is
  'Phase 4E. The provider''s own identifier for this line, as printed on their statement. What a commission reconciliation is matched on.';
comment on column public.agency_provider_float_accounts.opened_on is
  'Phase 4E. The business date the line started trading. Never derived from created_at, which is when somebody typed it in.';
comment on column public.agency_provider_float_accounts.closed_on is
  'Phase 4E. The business date the line stopped trading, set when it is closed.';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'agency_float_msisdn_shape') then
    alter table public.agency_provider_float_accounts
      add constraint agency_float_msisdn_shape
      check (line_msisdn is null or line_msisdn ~ '^\+256[0-9]{9}$');
  end if;

  if not exists (select 1 from pg_constraint where conname = 'agency_float_agent_code_shape') then
    alter table public.agency_provider_float_accounts
      add constraint agency_float_agent_code_shape
      check (agent_code is null
             or (pg_catalog.btrim(agent_code) = agent_code
                 and pg_catalog.length(agent_code) between 2 and 40));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'agency_float_label_shape') then
    alter table public.agency_provider_float_accounts
      add constraint agency_float_label_shape
      check (pg_catalog.btrim(label) = label and pg_catalog.length(label) <= 80);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'agency_float_dates_in_order') then
    alter table public.agency_provider_float_accounts
      add constraint agency_float_dates_in_order
      check (closed_on is null or opened_on is null or closed_on >= opened_on);
  end if;
end;
$$;

-- An MSISDN identifies one line, so two lines may not claim the same number.
-- Partial, because most existing rows have none and null is not a claim.
create unique index if not exists agency_float_msisdn_unique
  on public.agency_provider_float_accounts (line_msisdn)
  where line_msisdn is not null;

-- The provider's own agent code is unique within that provider, not globally:
-- two providers may both call a line "AG001".
create unique index if not exists agency_float_agent_code_unique
  on public.agency_provider_float_accounts (provider_id, agent_code)
  where agent_code is not null;


-- ---------------------------------------------------------------------------
-- 2. State
-- ---------------------------------------------------------------------------

alter table public.agency_provider_float_accounts
  add column if not exists status             text not null default 'active',
  add column if not exists status_reason      text,
  add column if not exists status_changed_by  uuid references public.profiles(id) on delete set null,
  add column if not exists status_changed_at  timestamptz;

comment on column public.agency_provider_float_accounts.status is
  'Phase 4E, decision OD-4. active | suspended | closed. Suspension is the emergency stop: new activity ceases at once, balances and history remain, and recovery operations stay possible. Closure is the orderly end and is only reachable with zero float, no outstanding commission and nothing pending.';
comment on column public.agency_provider_float_accounts.status_reason is
  'Phase 4E. Why the line is in this state. Required for anything other than active, in both directions, so a suspension and the lifting of one each name their cause.';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'agency_float_status_valid') then
    alter table public.agency_provider_float_accounts
      add constraint agency_float_status_valid
      check (status = any (array['active', 'suspended', 'closed']));
  end if;

  -- The coupling. `is_active` is what the engine reads; `status` is what a
  -- person sets. They are the same fact, so they are checked to be.
  if not exists (select 1 from pg_constraint where conname = 'agency_float_status_matches_is_active') then
    alter table public.agency_provider_float_accounts
      add constraint agency_float_status_matches_is_active
      check (is_active = (status = 'active'));
  end if;

  -- A state that stops business must say why, and must name who stopped it.
  if not exists (select 1 from pg_constraint where conname = 'agency_float_inactive_states_reason') then
    alter table public.agency_provider_float_accounts
      add constraint agency_float_inactive_states_reason
      check (status = 'active'
             or (pg_catalog.btrim(coalesce(status_reason, '')) <> ''
                 and status_changed_by is not null
                 and status_changed_at is not null));
  end if;

  -- A closed line has a closing date; an open one does not.
  if not exists (select 1 from pg_constraint where conname = 'agency_float_closed_has_date') then
    alter table public.agency_provider_float_accounts
      add constraint agency_float_closed_has_date
      check ((status = 'closed') = (closed_on is not null));
  end if;
end;
$$;

create index if not exists agency_float_status_idx
  on public.agency_provider_float_accounts (status, provider_id, branch_id);


-- ---------------------------------------------------------------------------
-- 3. `till_name` and the ledger account are immutable
--
-- Both are encoded in, or are, the account that carries the line's posted
-- history. A rename would make the code lie; a re-point would move posted
-- money. Neither is a thing an administrator should be able to do by filling
-- in a form, so neither is possible at all.
-- ---------------------------------------------------------------------------

create or replace function public.agency_float_account_immutable_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.till_name is distinct from old.till_name then
    raise exception
      'A till name is part of its ledger account code (%), so it cannot be renamed. Create a new line and close this one.',
      (select a.code from public.ledger_accounts a where a.id = old.ledger_account_id)
      using errcode = 'P0001';
  end if;

  if new.ledger_account_id is distinct from old.ledger_account_id then
    raise exception
      'An agent line cannot be re-pointed at a different ledger account: the posted history belongs to the account it has.'
      using errcode = 'P0001';
  end if;

  if new.provider_id is distinct from old.provider_id
     or new.branch_id is distinct from old.branch_id then
    raise exception
      'An agent line cannot be moved to another provider or branch.'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

revoke all on function public.agency_float_account_immutable_identity()
  from public, anon, authenticated;

comment on function public.agency_float_account_immutable_identity() is
  'Phase 4E. Refuses a change to the four facts the ledger account encodes: till name, account, provider and branch. The editable identity is label, MSISDN, agent code and notes.';

drop trigger if exists agency_float_account_identity_immutable
  on public.agency_provider_float_accounts;
create trigger agency_float_account_identity_immutable
  before update on public.agency_provider_float_accounts
  for each row execute function public.agency_float_account_immutable_identity();


-- ---------------------------------------------------------------------------
-- 4. Every administrative act on a line, and on a provider, is audited
--
-- `agency_transaction_audit_log.transaction_id` is NOT NULL, so configuration
-- changes have no home there. They belong in the general `public.audit_log`,
-- which already carries entity_type, entity_id, old_values, new_values and an
-- actor, and is already append-only. `record_audit_event()` resolves the actor
-- the same way every other audited change in this schema does.
-- ---------------------------------------------------------------------------

create or replace function public.audit_agency_configuration_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entity text := case tg_table_name
                     when 'agency_provider_float_accounts' then 'agency_agent_line'
                     when 'agency_service_providers'       then 'agency_provider'
                     when 'agency_transaction_types'       then 'agency_service_type'
                     else tg_table_name
                   end;
begin
  if tg_op = 'INSERT' then
    perform public.record_audit_event(
      v_entity || '.created', v_entity, new.id::text,
      null, pg_catalog.to_jsonb(new), null, null);
    return new;
  end if;

  -- An update that changed nothing is not an event.
  if pg_catalog.to_jsonb(new) - 'updated_at' = pg_catalog.to_jsonb(old) - 'updated_at' then
    return new;
  end if;

  perform public.record_audit_event(
    v_entity || '.updated', v_entity, new.id::text,
    pg_catalog.to_jsonb(old), pg_catalog.to_jsonb(new), null, null);
  return new;
end;
$$;

revoke all on function public.audit_agency_configuration_change()
  from public, anon, authenticated;

comment on function public.audit_agency_configuration_change() is
  'Phase 4E. Writes every agency configuration change — agent lines, providers, service types — into the general audit log with both values. Updates that move only updated_at are not recorded, so a no-op save leaves no trail to read through.';

drop trigger if exists agency_float_accounts_audited on public.agency_provider_float_accounts;
create trigger agency_float_accounts_audited
  after insert or update on public.agency_provider_float_accounts
  for each row execute function public.audit_agency_configuration_change();

drop trigger if exists agency_service_providers_audited on public.agency_service_providers;
create trigger agency_service_providers_audited
  after insert or update on public.agency_service_providers
  for each row execute function public.audit_agency_configuration_change();

drop trigger if exists agency_transaction_types_audited on public.agency_transaction_types;
create trigger agency_transaction_types_audited
  after insert or update on public.agency_transaction_types
  for each row execute function public.audit_agency_configuration_change();
