-- ===========================================================================
-- Phase 4C — Physical cash reconciliation and provider float reconciliation.
--
-- Two processes, deliberately not one. A till of banknotes is counted by
-- hand; an electronic float is compared against a provider's statement. They
-- have different evidence, different adjustment accounts, and — the part that
-- matters most here — **opposite variance conventions**, which Phase 4C's
-- reconciliation document records as deviation D2:
--
--   agency_cash_reconciliations.variance  = physical_count - system_closing_balance
--   agency_float_reconciliations.variance = system_closing_balance - provider_statement_balance
--
-- Both are GENERATED ALWAYS and the brief instructs that they be used as
-- they are. So a positive number is a cash **excess** in one table and a
-- system **overstatement** in the other: opposite directions of correction.
-- There is therefore no shared adjustment helper below. Each approval
-- function derives its own direction, and all four signed cases are asserted
-- separately in the suite.
--
-- ## The stale reconciliation
--
-- A count is taken against a balance. If cash moves between the count and
-- the approval, the variance on the row no longer describes anything: it is
-- the difference between a physical count and a balance that has since
-- changed. Approving it would write off a variance that was never measured,
-- and an adjustment posted on that basis is a fabricated correction.
--
-- Both approval functions therefore re-read the system balance under the
-- lock and refuse if it has moved from the snapshot the submission stored.
-- The reconciliation has to be submitted again against the current balance.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Deviation D3 — the float reconciliation did not record who or what
--
-- It keyed on the till alone: no provider, no branch, and no statement
-- reference. Provider and branch are reachable through
-- `agency_provider_float_accounts`, so nothing was lost, but a report that
-- must join three tables to say which branch a variance belongs to is a
-- report that will eventually be written wrongly. Denormalised and then
-- **checked** by a trigger against the till's own registration, rather than
-- trusted.
-- ---------------------------------------------------------------------------

alter table public.agency_float_reconciliations
  add column provider_id uuid references public.agency_service_providers(id) on delete restrict,
  add column branch_id   uuid references public.branches(id) on delete restrict,
  add column provider_statement_ref text,

  add constraint agency_float_recon_statement_ref_shape
    check (provider_statement_ref is null or btrim(provider_statement_ref) <> ''),

  -- A write-off is a financial correction, and its evidence is the statement
  -- it was measured against. No reference, no write-off.
  add constraint agency_float_recon_writeoff_needs_evidence
    check (variance_written_off = 0 or provider_statement_ref is not null);

comment on column public.agency_float_reconciliations.provider_statement_ref is
  'Phase 4C. The provider statement the closing balance was compared against. Required before any variance may be written off: it is the evidence for the adjustment.';


-- ---------------------------------------------------------------------------
-- 2. Deviation D4 — neither table enforced maker-checker
--
-- Both carried `created_by` and `reconciled_by` and nothing stopped them
-- holding the same profile. The officer who counts the cash must not be the
-- one who certifies the count.
-- ---------------------------------------------------------------------------

alter table public.agency_cash_reconciliations
  add constraint agency_cash_recon_maker_is_not_checker
    check (status <> 'reconciled' or reconciled_by <> created_by);

alter table public.agency_float_reconciliations
  add constraint agency_float_recon_maker_is_not_checker
    check (status <> 'reconciled' or reconciled_by <> created_by);


-- ---------------------------------------------------------------------------
-- 3. The adjustment capability
--
-- Recording a count and writing off a difference are different authorities.
-- `agency:reconcile` (manager and owner) submits and approves a count;
-- writing a variance into the ledger is an owner decision, exactly as a
-- commission exception is. Without this split, a manager who miscounts can
-- certify the miscount into the books.
-- ---------------------------------------------------------------------------

insert into public.permissions (key, description)
values ('agency:variance_adjustment',
        'Write a reconciliation variance off to the over-and-short accounts. Not a counting capability: the adjustment is a financial correction.')
on conflict (key) do nothing;

insert into public.role_permissions (role_key, permission_key)
values ('owner_admin', 'agency:variance_adjustment')
on conflict (role_key, permission_key) do nothing;


-- ---------------------------------------------------------------------------
-- 4. The float reconciliation guard
-- ---------------------------------------------------------------------------

create or replace function public.agency_float_reconciliation_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  f record;
begin
  select a.provider_id, a.branch_id into f
  from public.agency_provider_float_accounts a
  where a.id = new.float_account_id;

  if f is null then
    raise exception 'That float till is not registered.' using errcode = 'P0001';
  end if;

  if new.provider_id is distinct from f.provider_id
     or new.branch_id is distinct from f.branch_id then
    raise exception
      'That float till belongs to a different provider or branch than the one recorded.'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

revoke all on function public.agency_float_reconciliation_guard()
  from public, anon, authenticated;

create trigger agency_float_reconciliations_guard
  before insert or update on public.agency_float_reconciliations
  for each row execute function public.agency_float_reconciliation_guard();


-- ---------------------------------------------------------------------------
-- 5. Submitting a physical cash count
--
-- The whole branch till, not an agency slice of it. Agency deposits and loan
-- repayments land in the same drawer and are counted together — which is why
-- this reconciles `cash_at_hand` and refuses an agency float account
-- outright. Float is electronic and has its own process below.
-- ---------------------------------------------------------------------------

create or replace function public.submit_agency_cash_reconciliation(
  p_cash_account_id uuid,
  p_physical_count  bigint,
  p_date            date default null,
  p_notes           text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor  uuid;
  a        record;
  v_date   date;
  v_system bigint;
  v_id     uuid;
begin
  v_actor := public.agency_actor('agency:reconcile');

  select l.name, l.cash_kind, l.branch_id, l.status, l.is_postable
    into a
  from public.ledger_accounts l where l.id = p_cash_account_id;

  if a is null or a.branch_id is null or not public.user_can_see_branch(a.branch_id) then
    raise exception
      'No cash account with that identifier is available to you.'
      using errcode = '42501';
  end if;

  -- An agency float account has a cash_kind, so a looser test would admit it.
  -- It is not countable by hand and must not travel this path.
  if a.cash_kind = 'agency_float' then
    raise exception
      '% is an electronic agency float account. It is reconciled against the provider''s statement, not by a physical count.',
      a.name
      using errcode = 'P0001';
  end if;

  if a.cash_kind <> 'cash_at_hand' then
    raise exception
      '% is not a till of cash, so it cannot be counted.', a.name
      using errcode = 'P0001';
  end if;

  if a.status <> 'active' or not a.is_postable then
    raise exception '% is not active, so it cannot be reconciled.', a.name
      using errcode = 'P0001';
  end if;

  if p_physical_count is null or p_physical_count < 0 then
    raise exception 'A physical count cannot be negative.' using errcode = 'P0001';
  end if;

  v_date := coalesce(p_date, public.business_date());

  -- A count cannot be taken for a day that has not happened.
  if v_date > public.business_date() then
    raise exception
      'A cash count cannot be recorded for %, which is in the future.', v_date
      using errcode = 'P0001';
  end if;

  -- Snapshot under the lock, so the figure stored is the one that was true
  -- when the count was taken.
  perform public.lock_ledger_balances(array[p_cash_account_id]);
  select coalesce(b.balance, 0) into v_system
  from public.ledger_account_balances b where b.account_id = p_cash_account_id;
  v_system := coalesce(v_system, 0);

  begin
    insert into public.agency_cash_reconciliations
      (branch_id, cash_account_id, reconciliation_date,
       system_closing_balance, physical_count, notes, created_by)
    values
      (a.branch_id, p_cash_account_id, v_date,
       v_system, p_physical_count,
       nullif(pg_catalog.btrim(coalesce(p_notes, '')), ''), v_actor)
    returning id into v_id;
  exception when unique_violation then
    raise exception
      '% has already been reconciled for %.', a.name, v_date
      using errcode = 'P0001';
  end;

  perform public.record_audit_event(
    'agency.cash_count_submitted',
    'agency_cash_reconciliation', v_id::text, null,
    pg_catalog.jsonb_build_object(
      'branch_id', a.branch_id,
      'cash_account_id', p_cash_account_id,
      'reconciliation_date', v_date,
      'system_closing_balance', v_system,
      'physical_count', p_physical_count,
      'variance', p_physical_count - v_system)
  );

  return v_id;
end;
$$;

comment on function public.submit_agency_cash_reconciliation(uuid, bigint, date, text) is
  'Phase 4C. Records one physical count of a branch till, covering agency and lending cash together because they share the drawer. Requires agency:reconcile. Refuses a branch the caller cannot see with 42501, refuses an agency float account and anything that is not cash at hand, refuses a negative count, refuses a future date, and refuses a second count of the same account on the same day. The system balance is snapshotted under the account lock, so the stored figure is the one that was true when the count was taken.';

revoke all on function public.submit_agency_cash_reconciliation(uuid, bigint, date, text)
  from public, anon;
grant execute on function public.submit_agency_cash_reconciliation(uuid, bigint, date, text)
  to authenticated;


-- ---------------------------------------------------------------------------
-- 6. Approving a physical cash count
--
-- `p_adjust` is explicit. A variance is recorded whether or not it is
-- written off, and a difference alone never creates an adjustment: an
-- unexplained variance is a real outcome and is left on the record as one.
--
-- Direction, for this table only (variance = physical - system):
--   variance > 0  more cash than the books say   Dr cash   / Cr 5950
--   variance < 0  less cash than the books say   Dr 5950   / Cr cash
-- ---------------------------------------------------------------------------

create or replace function public.approve_agency_cash_reconciliation(
  p_reconciliation_id uuid,
  p_adjust            boolean default false,
  p_reason            text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor   uuid;
  v_label   text;
  r         public.agency_cash_reconciliations;
  v_name    text;
  v_current bigint;
  v_over    uuid;
  v_entry   uuid;
begin
  v_actor := public.agency_actor('agency:reconcile');

  select * into r from public.agency_cash_reconciliations
   where id = p_reconciliation_id for update;

  if r.id is null or not public.user_can_see_branch(r.branch_id) then
    raise exception
      'No cash reconciliation with that identifier is available to you.'
      using errcode = '42501';
  end if;

  if r.status <> 'open' then
    raise exception
      'That reconciliation is already %, so it cannot be approved again.', r.status
      using errcode = 'P0001';
  end if;

  -- Maker-checker. Refused here with a sentence, ahead of the CHECK that
  -- would otherwise refuse it with a constraint name.
  if r.created_by = v_actor then
    raise exception
      'The officer who recorded a count cannot approve it. A second officer must certify it.'
      using errcode = '42501';
  end if;

  select l.name into v_name
  from public.ledger_accounts l where l.id = r.cash_account_id;

  perform public.lock_ledger_balances(array[r.cash_account_id]);

  -- The stale-count refusal. See this migration's header.
  select coalesce(b.balance, 0) into v_current
  from public.ledger_account_balances b where b.account_id = r.cash_account_id;
  v_current := coalesce(v_current, 0);

  if v_current <> r.system_closing_balance then
    raise exception
      'The balance of % has moved from % to % since this count was recorded, so its variance of % no longer describes anything. Count it again against the current balance.',
      v_name, r.system_closing_balance, v_current, r.variance
      using errcode = 'P0001';
  end if;

  if p_adjust then
    if r.variance = 0 then
      raise exception
        'There is nothing to adjust: the count agrees with the books.'
        using errcode = 'P0001';
    end if;

    -- Writing a difference into the ledger is its own authority.
    if auth.uid() is not null
       and not public.user_has_permission('agency:variance_adjustment') then
      raise exception
        'Writing a cash variance off requires the agency:variance_adjustment capability.'
        using errcode = '42501';
    end if;

    if pg_catalog.btrim(coalesce(p_reason, '')) = '' then
      raise exception 'A variance adjustment needs a reason.' using errcode = 'P0001';
    end if;

    v_over := public.ledger_account_by_code('5950');
    select p.full_name into v_label from public.profiles p where p.id = v_actor;

    if r.variance > 0 then
      -- More cash than the books say: bring the books up, credit the gain.
      v_entry := public.post_journal(
        r.branch_id, r.reconciliation_date,
        'Cash over on ' || r.reconciliation_date::text || ' — ' || p_reason,
        'reconciliation_adjustment', r.id, null, null,
        pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object('account_id', r.cash_account_id,
            'debit', r.variance, 'credit', 0, 'memo', 'Cash over'),
          pg_catalog.jsonb_build_object('account_id', v_over,
            'debit', 0, 'credit', r.variance, 'memo', 'Cash over and short')),
        pg_catalog.now(), v_actor, coalesce(v_label, 'system'));
    else
      -- Less cash than the books say: the shortfall is an expense, and the
      -- cash really has to be there to take out.
      perform public.assert_cash_available(r.cash_account_id, -r.variance);
      v_entry := public.post_journal(
        r.branch_id, r.reconciliation_date,
        'Cash short on ' || r.reconciliation_date::text || ' — ' || p_reason,
        'reconciliation_adjustment', r.id, null, null,
        pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object('account_id', v_over,
            'debit', -r.variance, 'credit', 0, 'memo', 'Cash short'),
          pg_catalog.jsonb_build_object('account_id', r.cash_account_id,
            'debit', 0, 'credit', -r.variance, 'memo', 'Cash short')),
        pg_catalog.now(), v_actor, coalesce(v_label, 'system'));
    end if;
  end if;

  update public.agency_cash_reconciliations
     set status = 'reconciled',
         reconciled_by = v_actor,
         reconciled_at = pg_catalog.now(),
         variance_written_off = case when p_adjust then r.variance else 0 end,
         variance_journal_entry_id = v_entry,
         notes = case
           when p_adjust then coalesce(r.notes || ' / ', '') || p_reason
           else r.notes end
   where id = r.id;

  perform public.record_audit_event(
    case when p_adjust then 'agency.cash_variance_adjusted'
         else 'agency.cash_count_approved' end,
    'agency_cash_reconciliation', r.id::text,
    pg_catalog.jsonb_build_object('status', 'open'),
    pg_catalog.jsonb_build_object(
      'status', 'reconciled',
      'variance', r.variance,
      'variance_written_off', case when p_adjust then r.variance else 0 end,
      'variance_journal_entry_id', v_entry,
      'reason', p_reason)
  );

  return v_entry;
end;
$$;

comment on function public.approve_agency_cash_reconciliation(uuid, boolean, text) is
  'Phase 4C. Certifies one physical cash count, optionally writing its variance off to 5950. Requires agency:reconcile to approve and agency:variance_adjustment as well to adjust, so a manager who miscounts cannot certify the miscount into the books. Refuses the officer who recorded the count, refuses a reconciliation already closed, and refuses one whose underlying balance has moved since the count was taken — a stale variance describes nothing and writing it off would fabricate a correction. A variance is always recorded; it is only written off when asked for, with a reason. Direction for this table: a positive variance is more cash than the books say, so Dr cash / Cr 5950.';

revoke all on function public.approve_agency_cash_reconciliation(uuid, boolean, text)
  from public, anon;
grant execute on function public.approve_agency_cash_reconciliation(uuid, boolean, text)
  to authenticated;


-- ---------------------------------------------------------------------------
-- 7. Submitting a provider float reconciliation
-- ---------------------------------------------------------------------------

create or replace function public.submit_agency_float_reconciliation(
  p_float_account_id  uuid,
  p_statement_balance bigint,
  p_statement_ref     text default null,
  p_date              date default null,
  p_notes             text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor  uuid;
  f        record;
  v_date   date;
  v_system bigint;
  v_id     uuid;
begin
  v_actor := public.agency_actor('agency:reconcile');

  select a.id, a.provider_id, a.branch_id, a.ledger_account_id, a.is_active,
         p.name as provider_name
    into f
  from public.agency_provider_float_accounts a
  join public.agency_service_providers p on p.id = a.provider_id
  where a.id = p_float_account_id;

  if f.id is null or not public.user_can_see_branch(f.branch_id) then
    raise exception
      'No agency float till with that identifier is available to you.'
      using errcode = '42501';
  end if;

  if p_statement_balance is null or p_statement_balance < 0 then
    raise exception
      'A provider statement balance cannot be negative.' using errcode = 'P0001';
  end if;

  v_date := coalesce(p_date, public.business_date());
  if v_date > public.business_date() then
    raise exception
      'A float reconciliation cannot be recorded for %, which is in the future.', v_date
      using errcode = 'P0001';
  end if;

  perform public.lock_ledger_balances(array[f.ledger_account_id]);
  select coalesce(b.balance, 0) into v_system
  from public.ledger_account_balances b where b.account_id = f.ledger_account_id;
  v_system := coalesce(v_system, 0);

  begin
    insert into public.agency_float_reconciliations
      (float_account_id, provider_id, branch_id, reconciliation_date,
       system_closing_balance, provider_statement_balance,
       provider_statement_ref, notes, created_by)
    values
      (p_float_account_id, f.provider_id, f.branch_id, v_date,
       v_system, p_statement_balance,
       nullif(pg_catalog.btrim(coalesce(p_statement_ref, '')), ''),
       nullif(pg_catalog.btrim(coalesce(p_notes, '')), ''), v_actor)
    returning id into v_id;
  exception when unique_violation then
    raise exception
      'That float till has already been reconciled for %.', v_date
      using errcode = 'P0001';
  end;

  perform public.record_audit_event(
    'agency.float_statement_submitted',
    'agency_float_reconciliation', v_id::text, null,
    pg_catalog.jsonb_build_object(
      'provider_id', f.provider_id,
      'branch_id', f.branch_id,
      'float_account_id', p_float_account_id,
      'reconciliation_date', v_date,
      'system_closing_balance', v_system,
      'provider_statement_balance', p_statement_balance,
      'variance', v_system - p_statement_balance,
      'statement_ref', p_statement_ref)
  );

  return v_id;
end;
$$;

comment on function public.submit_agency_float_reconciliation(uuid, bigint, text, date, text) is
  'Phase 4C. Records one provider float till against the provider''s statement balance, per till so a provider''s several tills reconcile independently. Requires agency:reconcile and refuses a till the caller''s branch cannot see with 42501. Provider and branch are taken from the till''s registration, never from the caller. The system balance is snapshotted under the account lock.';

revoke all on function public.submit_agency_float_reconciliation(uuid, bigint, text, date, text)
  from public, anon;
grant execute on function public.submit_agency_float_reconciliation(uuid, bigint, text, date, text)
  to authenticated;


-- ---------------------------------------------------------------------------
-- 8. Approving a provider float reconciliation
--
-- Direction, for this table only (variance = system - statement):
--   variance > 0  books above the statement   Dr 5960  / Cr float   (§6.12)
--   variance < 0  books below the statement   Dr float / Cr 5960
--
-- Note this is the **opposite** sign convention to the cash table. The two
-- branches below are written out separately for that reason; sharing them
-- through one signed helper is exactly the mistake deviation D2 warns about.
-- ---------------------------------------------------------------------------

create or replace function public.approve_agency_float_reconciliation(
  p_reconciliation_id uuid,
  p_adjust            boolean default false,
  p_reason            text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor   uuid;
  v_label   text;
  r         public.agency_float_reconciliations;
  v_ledger  uuid;
  v_name    text;
  v_current bigint;
  v_over    uuid;
  v_entry   uuid;
begin
  v_actor := public.agency_actor('agency:reconcile');

  select * into r from public.agency_float_reconciliations
   where id = p_reconciliation_id for update;

  if r.id is null or not public.user_can_see_branch(r.branch_id) then
    raise exception
      'No float reconciliation with that identifier is available to you.'
      using errcode = '42501';
  end if;

  if r.status <> 'open' then
    raise exception
      'That reconciliation is already %, so it cannot be approved again.', r.status
      using errcode = 'P0001';
  end if;

  if r.created_by = v_actor then
    raise exception
      'The officer who recorded a float statement cannot approve it. A second officer must certify it.'
      using errcode = '42501';
  end if;

  select a.ledger_account_id, l.name into v_ledger, v_name
  from public.agency_provider_float_accounts a
  join public.ledger_accounts l on l.id = a.ledger_account_id
  where a.id = r.float_account_id;

  -- Provider lock first, then the account. The order this phase keeps
  -- everywhere; see 20261110000100's header.
  perform public.lock_agency_provider_balance(r.provider_id, r.branch_id);
  perform public.lock_ledger_balances(array[v_ledger]);

  select coalesce(b.balance, 0) into v_current
  from public.ledger_account_balances b where b.account_id = v_ledger;
  v_current := coalesce(v_current, 0);

  if v_current <> r.system_closing_balance then
    raise exception
      'The balance of % has moved from % to % since this statement was recorded, so its variance of % no longer describes anything. Reconcile it again against the current balance.',
      v_name, r.system_closing_balance, v_current, r.variance
      using errcode = 'P0001';
  end if;

  if p_adjust then
    if r.variance = 0 then
      raise exception
        'There is nothing to adjust: the books agree with the statement.'
        using errcode = 'P0001';
    end if;

    if auth.uid() is not null
       and not public.user_has_permission('agency:variance_adjustment') then
      raise exception
        'Writing a float variance off requires the agency:variance_adjustment capability.'
        using errcode = '42501';
    end if;

    if pg_catalog.btrim(coalesce(p_reason, '')) = '' then
      raise exception 'A variance adjustment needs a reason.' using errcode = 'P0001';
    end if;

    if r.provider_statement_ref is null then
      raise exception
        'A float variance may only be written off against a named provider statement.'
        using errcode = 'P0001';
    end if;

    v_over := public.ledger_account_by_code('5960');
    select p.full_name into v_label from public.profiles p where p.id = v_actor;

    if r.variance > 0 then
      -- The books claim more float than the provider holds. Write the
      -- surplus off and take it out of the float account — so the float has
      -- to actually be there.
      perform public.assert_agency_float_available(v_ledger, r.variance);
      v_entry := public.post_journal(
        r.branch_id, r.reconciliation_date,
        'Agency float over on ' || r.reconciliation_date::text || ' — ' || p_reason,
        'reconciliation_adjustment', r.id, null, null,
        pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object('account_id', v_over,
            'debit', r.variance, 'credit', 0, 'memo', 'Agency float over and short'),
          pg_catalog.jsonb_build_object('account_id', v_ledger,
            'debit', 0, 'credit', r.variance, 'memo', 'Float surplus written off')),
        pg_catalog.now(), v_actor, coalesce(v_label, 'system'));
    else
      -- The provider holds more than the books claim. Bring the float up.
      v_entry := public.post_journal(
        r.branch_id, r.reconciliation_date,
        'Agency float short on ' || r.reconciliation_date::text || ' — ' || p_reason,
        'reconciliation_adjustment', r.id, null, null,
        pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object('account_id', v_ledger,
            'debit', -r.variance, 'credit', 0, 'memo', 'Float shortfall recognised'),
          pg_catalog.jsonb_build_object('account_id', v_over,
            'debit', 0, 'credit', -r.variance, 'memo', 'Agency float over and short')),
        pg_catalog.now(), v_actor, coalesce(v_label, 'system'));
    end if;
  end if;

  update public.agency_float_reconciliations
     set status = 'reconciled',
         reconciled_by = v_actor,
         reconciled_at = pg_catalog.now(),
         variance_written_off = case when p_adjust then r.variance else 0 end,
         variance_journal_entry_id = v_entry,
         notes = case
           when p_adjust then coalesce(r.notes || ' / ', '') || p_reason
           else r.notes end
   where id = r.id;

  perform public.record_audit_event(
    case when p_adjust then 'agency.float_variance_adjusted'
         else 'agency.float_statement_approved' end,
    'agency_float_reconciliation', r.id::text,
    pg_catalog.jsonb_build_object('status', 'open'),
    pg_catalog.jsonb_build_object(
      'status', 'reconciled',
      'variance', r.variance,
      'variance_written_off', case when p_adjust then r.variance else 0 end,
      'variance_journal_entry_id', v_entry,
      'statement_ref', r.provider_statement_ref,
      'reason', p_reason)
  );

  return v_entry;
end;
$$;

comment on function public.approve_agency_float_reconciliation(uuid, boolean, text) is
  'Phase 4C. Certifies one provider float reconciliation, optionally writing its variance off to 5960. Requires agency:reconcile, and agency:variance_adjustment as well to adjust. Refuses the officer who recorded the statement, one already closed, one whose float balance has moved since the statement was recorded, and a write-off with no named provider statement. Direction for this table is the opposite of the cash one: a positive variance means the books claim more float than the provider holds, so Dr 5960 / Cr float, and the float must actually be there to take out.';

revoke all on function public.approve_agency_float_reconciliation(uuid, boolean, text)
  from public, anon;
grant execute on function public.approve_agency_float_reconciliation(uuid, boolean, text)
  to authenticated;
