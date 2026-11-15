-- ===========================================================================
-- Polytos Agency redesign — who may operate which agent account
--
-- ## The decision this implements
--
-- Client Rule 6: "One agent can operate across multiple banks. A single
-- employee can be assigned to several banking providers and agent accounts.
-- The application must preserve account-level transaction ownership, staff
-- accountability and authorization."
--
-- Until now the first half was true and the second was not. Any officer
-- holding `agency:write` could record against any agent account at a branch
-- they could see, so "assigned to" had no meaning: the delivery report called
-- this out as Rule 6 being satisfied operationally but with no roster. The
-- Product Owner has asked for the roster, and for it to be a real control:
-- "Unassigned staff must not be able to record or post financial transactions
-- against those accounts."
--
-- ## The rule, stated once
--
-- An officer may **operate** an agent account — record a transaction, a float
-- trade or a cash banking against it — if either:
--
--   * they hold an active assignment to that account, or
--   * they hold `agency:verify`, which is the oversight capability.
--
-- The second clause is the "properly defined Manager and Owner/Admin
-- oversight" the Owner asked for, and it is not a loophole. Three reasons it
-- has to be there:
--
--   1. **Maker-checker needs two people.** Posting is refused to whoever
--      recorded, so an account whose roster held one cashier could never have
--      anything posted against it. Requiring the checker to be on the roster
--      too would mean every account needs at least two named officers before
--      it can trade, and a second Manager could not cover an absence.
--
--   2. **An account must be recoverable.** If the only assigned cashier
--      leaves, somebody has to be able to reach the float that is still on
--      that account. An Owner locked out of an account they registered is an
--      operational trap, not a control.
--
--   3. **It is already the narrower set.** `agency:verify` is held by the
--      Manager and the Owner and by nobody else — a Secretary/Treasurer holds
--      `agency:write` and not `agency:verify`. So the clause reads exactly as
--      "an assigned officer, or a Manager or Owner acting in oversight", and
--      an unassigned Secretary can neither record nor post. That is the
--      sentence the Owner wrote.
--
-- Oversight use is visible rather than silent: `agency_account_operators`
-- lists the roster, and the transaction audit log already names the actor on
-- every recording and posting, so an account operated by somebody not on its
-- roster is a question anybody can ask of the data.
--
-- ## What this does not change
--
-- Branch isolation and maker-checker are untouched and still apply *first*: a
-- roster entry does not let an officer reach another branch's account, and it
-- does not let the recorder post their own work. Assignment is a third gate,
-- not a replacement for either.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. The roster
--
-- Many-to-many, because Rule 6 is explicit in both directions: one employee
-- across several accounts, and one account worked by several employees.
--
-- Revocation is a state, not a delete. Who could operate an account last
-- March is a question an auditor asks about a transaction posted last March,
-- and a deleted row cannot answer it.
-- ---------------------------------------------------------------------------

create table if not exists public.agency_account_staff (
  id                uuid primary key default gen_random_uuid(),

  float_account_id  uuid not null references public.agency_provider_float_accounts(id) on delete restrict,
  profile_id        uuid not null references public.profiles(id) on delete restrict,

  status            text not null default 'active',

  assigned_by       uuid not null references public.profiles(id) on delete restrict,
  assigned_at       timestamptz not null default now(),
  notes             text,

  revoked_by        uuid references public.profiles(id) on delete restrict,
  revoked_at        timestamptz,
  revoked_reason    text,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint agency_account_staff_status_valid
    check (status = any (array['active', 'revoked'])),

  -- A revoked row says who revoked it, when, and why. A control that can be
  -- withdrawn without a reason is a control nobody can review.
  constraint agency_account_staff_revoked_states
    check (status <> 'revoked'
           or (revoked_by is not null
               and revoked_at is not null
               and pg_catalog.btrim(coalesce(revoked_reason, '')) <> '')),

  constraint agency_account_staff_active_states
    check (status <> 'active'
           or (revoked_by is null
               and revoked_at is null
               and revoked_reason is null))
);

comment on table public.agency_account_staff is
  'Polytos Agency redesign, client Rule 6. Which staff may operate which agent account or agent line — many-to-many, because one employee may work several accounts and one account may be worked by several employees. An officer may operate an account if they hold an active assignment to it, or hold agency:verify, which is the Manager and Owner oversight capability. Revocation is a state rather than a delete, because who could operate an account last March is a question an auditor asks about a transaction posted last March.';

comment on column public.agency_account_staff.status is
  'active or revoked. A revoked assignment is kept, with who revoked it and why, so the roster can be read as it stood at any past date.';

-- One active assignment per person per account. Partial, so a revoked row
-- never blocks a re-assignment — somebody may come back to an account.
create unique index if not exists agency_account_staff_one_active
  on public.agency_account_staff (float_account_id, profile_id)
  where status = 'active';

create index if not exists agency_account_staff_by_profile
  on public.agency_account_staff (profile_id, status);
create index if not exists agency_account_staff_by_account
  on public.agency_account_staff (float_account_id, status);

create trigger agency_account_staff_set_updated_at
  before update on public.agency_account_staff
  for each row execute function public.set_updated_at();

create trigger agency_account_staff_no_delete
  before delete on public.agency_account_staff
  for each row execute function public.reject_mutation();


-- ---------------------------------------------------------------------------
-- 2. Row Level Security
--
-- Readable with `agency:reports`, scoped to the branch of the account the
-- assignment is for. Writes come only through the two RPCs below: no INSERT,
-- UPDATE or DELETE grant exists for any exposed role.
-- ---------------------------------------------------------------------------

alter table public.agency_account_staff enable row level security;

create policy agency_account_staff_select_with_permission
  on public.agency_account_staff
  for select to authenticated
  using (
    (select public.user_has_permission('agency:reports'))
    and exists (
      select 1
        from public.agency_provider_float_accounts f
       where f.id = agency_account_staff.float_account_id
         and (
           (select public.current_user_branch_id()) is null
           or f.branch_id = (select public.current_user_branch_id())
         )
    )
  );

revoke all on table public.agency_account_staff from anon, authenticated;
grant select on public.agency_account_staff to authenticated;


-- ---------------------------------------------------------------------------
-- 3. The rule, as one function every path calls
--
-- SECURITY DEFINER because it reads the roster for *another* profile — a
-- checker asking whether the recorder was assigned — and the policy above is
-- branch-scoped to the reader. STABLE, so it may be used in a trigger and in
-- a view without being re-evaluated per row.
-- ---------------------------------------------------------------------------

create or replace function public.agency_may_operate_account(
  p_float_account_id uuid,
  p_profile_id       uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_assigned boolean;
  v_oversees boolean;
begin
  -- A transaction against a cash_payable provider names no account, so there
  -- is nothing to be assigned to and nothing to refuse.
  if p_float_account_id is null then
    return true;
  end if;

  if p_profile_id is null then
    return false;
  end if;

  select exists (
    select 1 from public.agency_account_staff s
     where s.float_account_id = p_float_account_id
       and s.profile_id = p_profile_id
       and s.status = 'active'
  ) into v_assigned;

  if v_assigned then
    return true;
  end if;

  -- Oversight: `agency:verify` is held by the Manager and the Owner and by
  -- nobody else. See this migration's header for why the clause exists.
  select exists (
    select 1
      from public.user_roles ur
      join public.role_permissions rp on rp.role_key = ur.role_key
     where ur.profile_id = p_profile_id
       and rp.permission_key = 'agency:verify'
  ) into v_oversees;

  return v_oversees;
end;
$$;

comment on function public.agency_may_operate_account(uuid, uuid) is
  'Polytos Agency redesign, client Rule 6. True when this profile may operate this agent account: an active assignment, or agency:verify, which only the Manager and the Owner hold. True for a null account, because a cash_payable provider names none. Read by the enforcing trigger, by the float trade and cash banking paths, and by the roster view.';

-- Revoked from every exposed role, `authenticated` included. It answers "is
-- this profile on that account's roster" for *any* pair, which is roster
-- information, and the behavioural probe is what made that obvious: as a
-- borrower it returned rather than refused. Nothing outside the database
-- needs it — the enforcing triggers and `assert_agency_account_operator()`
-- are SECURITY DEFINER and run as the owner, and a screen that wants the
-- roster reads `agency_account_operators`, which carries the branch rule.
revoke all on function public.agency_may_operate_account(uuid, uuid)
  from public, anon, authenticated;


create or replace function public.assert_agency_account_operator(
  p_float_account_id uuid,
  p_profile_id       uuid,
  p_what             text
)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_label text;
begin
  if public.agency_may_operate_account(p_float_account_id, p_profile_id) then
    return;
  end if;

  select coalesce(nullif(pg_catalog.btrim(f.label), ''), 'till ' || f.till_name)
    into v_label
    from public.agency_provider_float_accounts f
   where f.id = p_float_account_id;

  raise exception
    'You are not assigned to %, so you may not % against it. An Owner or a Manager assigns staff to an agent account.',
    coalesce(v_label, 'that agent account'), p_what
    using errcode = '42501';
end;
$$;

comment on function public.assert_agency_account_operator(uuid, uuid, text) is
  'Polytos Agency redesign. Raises 42501 naming the account when a profile may not operate it. 42501 rather than P0001 because it is an authorization refusal, which is what the application maps to "not permitted" rather than to a data problem.';

-- Revoked from `authenticated` for the same reason as the predicate it wraps:
-- its refusal message names the account, so a caller could use it to discover
-- which accounts exist and who is on them.
revoke all on function public.assert_agency_account_operator(uuid, uuid, text)
  from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 4. Enforcement on the transaction engine
--
-- A trigger rather than an edit to `create_agency_transaction()`, for two
-- reasons. It covers **every** path that writes a transaction, including any
-- added later, so the control cannot be bypassed by a new function that
-- forgot to call it. And it leaves a long, heavily tested posting function
-- exactly as it is.
--
-- Two moments are checked, because the Owner named two: recording, and
-- posting.
--
--   * INSERT — the recorder, from `submitted_by`, which the engine sets in the
--     same statement.
--   * UPDATE to `posted` — the checker, from `verified_by`.
--
-- `cancelled` and `reversed` are deliberately not checked. A cancellation
-- moves no money, and refusing a reversal would trap a mistake behind a
-- roster change — the same exemption `agency_transaction_live_readiness_guard`
-- makes, for the same reason.
-- ---------------------------------------------------------------------------

create or replace function public.agency_transaction_operator_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform public.assert_agency_account_operator(
      new.float_account_id, new.submitted_by, 'record a transaction');
    return new;
  end if;

  -- Only the transition that puts it in the book.
  if new.status = 'posted' and coalesce(old.status, '') <> 'posted' then
    perform public.assert_agency_account_operator(
      new.float_account_id, new.verified_by, 'post a transaction');
  end if;

  return new;
end;
$$;

comment on function public.agency_transaction_operator_guard() is
  'Polytos Agency redesign, client Rule 6. Refuses a recording by an officer not assigned to the agent account, and a posting by one not assigned to it. A trigger rather than a check inside create_agency_transaction(), so every path that writes a transaction is covered including ones added later. Cancellation and reversal are exempt: one moves no money, and refusing the other would trap a mistake behind a roster change.';

revoke all on function public.agency_transaction_operator_guard()
  from public, anon, authenticated;

create trigger agency_transactions_operator_guard
  before insert or update on public.agency_transactions
  for each row execute function public.agency_transaction_operator_guard();


-- ---------------------------------------------------------------------------
-- 5. Assigning and revoking
--
-- Either capability may staff an account: `agency:providers`, which the Owner
-- holds and which registers the account in the first place, or
-- `agency:settlements`, which the Manager holds. That is the Owner/Admin and
-- Manager oversight the decision asked for — the Manager staffs the counter
-- day to day, the Owner configures what the counter is.
-- ---------------------------------------------------------------------------

create or replace function public.agency_staffing_actor()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
begin
  v_actor := public.current_profile_id();

  if auth.uid() is not null
     and not (
       (select public.user_has_permission('agency:providers'))
       or (select public.user_has_permission('agency:settlements'))
     ) then
    raise exception
      'Not authorized to assign staff to an agent account. An Owner or a Manager does that.'
      using errcode = '42501';
  end if;

  if v_actor is null then
    raise exception 'No acting profile could be resolved.' using errcode = '42501';
  end if;

  return v_actor;
end;
$$;

revoke all on function public.agency_staffing_actor() from public, anon, authenticated;


create or replace function public.assign_agency_account_staff(
  p_float_account_id uuid,
  p_profile_id       uuid,
  p_notes            text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  f       record;
  p       record;
  v_id    uuid;
begin
  v_actor := public.agency_staffing_actor();

  select a.id, a.branch_id, a.status,
         coalesce(nullif(pg_catalog.btrim(a.label), ''), 'till ' || a.till_name) as label
    into f
    from public.agency_provider_float_accounts a
   where a.id = p_float_account_id;

  if f.id is null or not public.user_can_see_branch(f.branch_id) then
    raise exception 'No agent account with that identifier is available to you.'
      using errcode = '42501';
  end if;

  if f.status = 'closed' then
    raise exception
      '% is closed, so nobody can be assigned to operate it.', f.label
      using errcode = 'P0001';
  end if;

  select pr.id, pr.full_name, pr.status, pr.branch_id into p
    from public.profiles pr where pr.id = p_profile_id;

  if p.id is null then
    raise exception 'No such staff member.' using errcode = 'P0001';
  end if;

  if p.status <> 'active' then
    raise exception
      '% is not an active account, so they cannot be assigned to operate an agent account.',
      p.full_name
      using errcode = 'P0001';
  end if;

  -- A borrower is not staff. Assigning one would create a roster entry that
  -- the capability check would refuse anyway, which is a confusing way to say
  -- no.
  if not exists (
    select 1 from public.user_roles ur
     where ur.profile_id = p_profile_id and ur.role_key <> 'client'
  ) then
    raise exception
      '% holds no staff role, so they cannot operate an agent account.',
      p.full_name
      using errcode = 'P0001';
  end if;

  -- Branch isolation, stated here as well as in the policy: an officer
  -- belonging to one branch is not staffed onto another branch's account.
  -- A head-office officer (no branch) may be assigned anywhere.
  if p.branch_id is not null and p.branch_id <> f.branch_id then
    raise exception
      '% belongs to another branch, so they cannot be assigned to %.',
      p.full_name, f.label
      using errcode = 'P0001';
  end if;

  -- Idempotent: assigning somebody already assigned returns their row rather
  -- than failing, so a double-clicked form is not an error.
  select s.id into v_id
    from public.agency_account_staff s
   where s.float_account_id = p_float_account_id
     and s.profile_id = p_profile_id
     and s.status = 'active';

  if v_id is not null then
    return v_id;
  end if;

  insert into public.agency_account_staff
    (float_account_id, profile_id, assigned_by, notes)
  values
    (p_float_account_id, p_profile_id, v_actor,
     nullif(pg_catalog.btrim(coalesce(p_notes, '')), ''))
  returning id into v_id;

  perform public.record_audit_event(
    'agency_account_staff.assigned', 'agency_account_staff', v_id::text, null,
    pg_catalog.jsonb_build_object(
      'float_account_id', p_float_account_id,
      'profile_id', p_profile_id,
      'status', 'active'),
    pg_catalog.jsonb_build_object('account', f.label, 'staff', p.full_name),
    null);

  return v_id;
end;
$$;

comment on function public.assign_agency_account_staff(uuid, uuid, text) is
  'Polytos Agency redesign, client Rule 6. Assigns a staff member to operate one agent account. Needs agency:providers or agency:settlements — the Owner or a Manager. Refuses an account the caller''s branch cannot see, a closed account, an inactive profile, a borrower, and an officer belonging to another branch. Idempotent on an existing active assignment. One officer may be assigned to any number of accounts, across any number of providers, which is the half of Rule 6 that already worked.';

revoke all on function public.assign_agency_account_staff(uuid, uuid, text)
  from public, anon;
grant execute on function public.assign_agency_account_staff(uuid, uuid, text) to authenticated;


create or replace function public.revoke_agency_account_staff(
  p_float_account_id uuid,
  p_profile_id       uuid,
  p_reason           text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  s       public.agency_account_staff;
  f       record;
begin
  v_actor := public.agency_staffing_actor();

  if pg_catalog.btrim(coalesce(p_reason, '')) = '' then
    raise exception 'Say why the assignment is being withdrawn.' using errcode = 'P0001';
  end if;

  select a.id, a.branch_id,
         coalesce(nullif(pg_catalog.btrim(a.label), ''), 'till ' || a.till_name) as label
    into f
    from public.agency_provider_float_accounts a
   where a.id = p_float_account_id;

  if f.id is null or not public.user_can_see_branch(f.branch_id) then
    raise exception 'No agent account with that identifier is available to you.'
      using errcode = '42501';
  end if;

  select * into s
    from public.agency_account_staff
   where float_account_id = p_float_account_id
     and profile_id = p_profile_id
     and status = 'active'
   for update;

  if s.id is null then
    raise exception 'That staff member is not assigned to %.', f.label
      using errcode = 'P0001';
  end if;

  update public.agency_account_staff
     set status         = 'revoked',
         revoked_by     = v_actor,
         revoked_at     = pg_catalog.now(),
         revoked_reason = pg_catalog.btrim(p_reason),
         updated_at     = pg_catalog.now()
   where id = s.id;

  perform public.record_audit_event(
    'agency_account_staff.revoked', 'agency_account_staff', s.id::text,
    pg_catalog.jsonb_build_object('status', 'active'),
    pg_catalog.jsonb_build_object(
      'status', 'revoked', 'reason', pg_catalog.btrim(p_reason)),
    pg_catalog.jsonb_build_object('account', f.label),
    null);

  return s.id;
end;
$$;

comment on function public.revoke_agency_account_staff(uuid, uuid, text) is
  'Polytos Agency redesign. Withdraws an assignment, with a stated reason, keeping the row. Needs agency:providers or agency:settlements. The transactions the officer already recorded are untouched: a roster change is not a correction of history.';

revoke all on function public.revoke_agency_account_staff(uuid, uuid, text)
  from public, anon;
grant execute on function public.revoke_agency_account_staff(uuid, uuid, text) to authenticated;


-- ---------------------------------------------------------------------------
-- 6. The roster, as a screen reads it
-- ---------------------------------------------------------------------------

create or replace view public.agency_account_operators
with (security_invoker = true) as
select
  s.id,
  s.float_account_id,
  f.provider_id,
  p.code                        as provider_code,
  p.name                        as provider_name,
  p.category                    as provider_category,
  f.branch_id,
  b.branch_code,
  b.name                        as branch_name,
  f.till_name,
  nullif(f.label, '')           as account_label,
  f.status                      as account_status,
  s.profile_id,
  staff.full_name               as staff_name,
  staff.status                  as staff_status,
  s.status,
  s.assigned_by,
  assigner.full_name            as assigned_by_name,
  s.assigned_at,
  s.notes,
  s.revoked_by,
  revoker.full_name             as revoked_by_name,
  s.revoked_at,
  s.revoked_reason
from public.agency_account_staff s
join public.agency_provider_float_accounts f on f.id = s.float_account_id
join public.agency_service_providers p on p.id = f.provider_id
join public.branches b on b.id = f.branch_id
join public.profiles staff on staff.id = s.profile_id
join public.profiles assigner on assigner.id = s.assigned_by
left join public.profiles revoker on revoker.id = s.revoked_by;

comment on view public.agency_account_operators is
  'Polytos Agency redesign, client Rule 6. The roster: who may operate which agent account, with who assigned them and when, and for a withdrawn assignment who withdrew it and why. security_invoker, so the table''s own branch-scoped policy decides the rows.';

revoke all on public.agency_account_operators from anon, authenticated;
grant select on public.agency_account_operators to authenticated;
