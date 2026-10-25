-- ===========================================================================
-- Polytos Phase 2.5 — the savings account
--
-- ## One account per membership, and never per client
--
-- The unique key is `membership_id`, not `client_id`, and the difference is
-- the whole design. A client who withdraws in 2026 and rejoins in 2028 has
-- two memberships — Phase 1 made that a partial unique index rather than a
-- reused row, because the savings qualification clock restarts. If the
-- savings account hung off the client, the 2028 member would inherit the 2026
-- balance and the 2026 contribution history, and six months of qualification
-- they did not serve.
--
-- So: two memberships, two accounts, two histories. The money in the first is
-- still owed to the person — settling it is a withdrawal against that
-- account, which is a decision the client has not yet made rules for and
-- which this phase therefore does not perform.
--
-- ## There is no balance column, deliberately
--
-- A `balance` column is a number that can disagree with the transactions
-- under it, and the first time it does, nobody can tell which is right. The
-- balance is `sum(signed_amount)` over `savings_transactions`, exposed by
-- `member_savings_balances` in the next migration, and the posting functions
-- compute it under a row lock on this table so two concurrent withdrawals
-- cannot both read the same balance and both spend it.
--
-- The lock target is the account row. That is why this table exists as a row
-- at all rather than as a view over memberships: it is the thing a
-- transaction serialises on.
--
-- ## Status
--
--   active    Takes deposits, pays withdrawals.
--   dormant   Takes deposits; a withdrawal needs the account reactivated.
--             Set by the business, not by inactivity — nobody has decided
--             what inactivity means here.
--   closed    Takes nothing. Reaching this state is one of the rules the
--             client has not settled, so no function in this phase sets it;
--             the status exists because the schema should not have to change
--             when they do decide.
-- ===========================================================================

create table public.savings_accounts (
  id uuid primary key default gen_random_uuid(),

  -- Minted by `next_reference('savings_account')` in a BEFORE INSERT trigger.
  account_number text not null unique,

  -- One per membership. The unique constraint is the rule.
  membership_id uuid not null unique
    references public.memberships(id) on delete restrict,
  -- Denormalised from the membership so the register is one read, and so a
  -- statement stays attributable.
  client_id uuid not null references public.clients(id) on delete restrict,
  branch_id uuid not null references public.branches(id) on delete restrict,

  -- The savings rules this account was opened under: the monthly minimum and
  -- the qualifying period that its contribution history is judged against.
  policy_version_id uuid not null
    references public.membership_policy_versions(id) on delete restrict,

  status text not null default 'active',
  status_reason text,

  opened_on date not null,
  closed_on date,

  created_by uuid references public.profiles(id) on delete set null,
  created_by_label text not null default 'system',
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),

  constraint savings_account_number_shape
    check (account_number ~ '^SA[0-9]{6,}$'),
  constraint savings_account_status_valid
    check (status in ('active', 'dormant', 'closed')),
  constraint savings_account_restricted_has_reason
    check (status = 'active' or (status_reason is not null and btrim(status_reason) <> '')),
  constraint savings_account_status_reason_length
    check (status_reason is null or char_length(status_reason) <= 500),
  constraint savings_account_closed_has_date
    check ((status = 'closed') = (closed_on is not null)),
  constraint savings_account_closed_after_opened
    check (closed_on is null or closed_on >= opened_on),
  constraint savings_account_opened_plausible
    check (opened_on >= '2020-01-01'::date)
);

comment on table public.savings_accounts is
  'Polytos Phase 2. A member''s savings account. One per membership, never per client: a client who rejoins starts a new account, because the qualification clock restarts. Carries no balance column — the balance is the sum of its transactions.';
comment on column public.savings_accounts.membership_id is
  'Unique. Two memberships for the same person are two accounts with two histories, which is what stops a rejoining member inheriting qualification they did not serve.';
comment on column public.savings_accounts.policy_version_id is
  'The savings rules this account is judged against: the monthly minimum and the qualifying period. Frozen at opening, as the membership''s own terms are.';

create index savings_accounts_client_idx on public.savings_accounts (client_id);
create index savings_accounts_branch_idx on public.savings_accounts (branch_id);
create index savings_accounts_status_idx on public.savings_accounts (status);
create index savings_accounts_opened_idx on public.savings_accounts (opened_on desc);

create trigger savings_accounts_set_updated_at
  before update on public.savings_accounts
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- The account number
-- ---------------------------------------------------------------------------

create or replace function public.savings_accounts_assign_number()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.account_number is not null then
    raise exception
      'A savings account number is assigned by the database, not by the caller.'
      using errcode = 'P0001';
  end if;

  new.account_number := public.next_reference('savings_account');
  return new;
end;
$$;

create trigger savings_accounts_assign_number
  before insert on public.savings_accounts
  for each row execute function public.savings_accounts_assign_number();

revoke all on function public.savings_accounts_assign_number()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Provenance and the guard
--
-- The branch, the client and the policy are derived from the membership —
-- always, and a supplied value that disagrees is refused rather than
-- overwritten. The Phase 1 lesson, applied to the account: a default is not a
-- rule, and silently correcting a value hides a caller that believes it is
-- choosing one.
-- ---------------------------------------------------------------------------

create or replace function public.savings_accounts_stamp_provenance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_membership public.memberships;
begin
  select * into v_membership
  from public.memberships where id = new.membership_id;

  if not found then
    raise exception 'No such membership.' using errcode = 'P0001';
  end if;

  if v_membership.status not in ('pending', 'active', 'suspended') then
    raise exception
      'Membership % has ended. A savings account cannot be opened on it.',
      v_membership.membership_number using errcode = 'P0001';
  end if;

  if new.client_id is not null and new.client_id <> v_membership.client_id then
    raise exception
      'A savings account belongs to the member''s own client record.'
      using errcode = 'P0001';
  end if;

  if new.branch_id is not null and new.branch_id <> v_membership.branch_id then
    raise exception
      'A savings account is held at the membership''s own branch.'
      using errcode = 'P0001';
  end if;

  if new.policy_version_id is not null
     and new.policy_version_id <> v_membership.policy_version_id then
    raise exception
      'A savings account is judged against the member''s own policy version.'
      using errcode = 'P0001';
  end if;

  new.client_id := v_membership.client_id;
  new.branch_id := v_membership.branch_id;
  new.policy_version_id := v_membership.policy_version_id;

  new.created_by := public.current_profile_id();
  new.created_by_label := public.audit_actor_label();
  new.opened_on := coalesce(new.opened_on, public.business_date());

  -- An account opens active. There is no state in which it exists and
  -- refuses the first deposit.
  if new.status <> 'active' then
    raise exception
      'A savings account is opened active. Restricting it is a later decision, with a reason.'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

create trigger savings_accounts_stamp_provenance
  before insert on public.savings_accounts
  for each row execute function public.savings_accounts_stamp_provenance();

create or replace function public.savings_accounts_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
     or new.account_number is distinct from old.account_number
     or new.membership_id is distinct from old.membership_id
     or new.client_id is distinct from old.client_id
     or new.policy_version_id is distinct from old.policy_version_id
     or new.opened_on is distinct from old.opened_on
     or new.created_at is distinct from old.created_at then
    raise exception 'A savings account''s provenance cannot be rewritten.'
      using errcode = 'P0001';
  end if;

  -- The branch follows the membership, which follows the client.
  if new.branch_id is distinct from old.branch_id
     and new.branch_id is distinct from (
       select m.branch_id from public.memberships m where m.id = old.membership_id
     ) then
    raise exception
      'A savings account is held at the membership''s own branch.'
      using errcode = 'P0001';
  end if;

  if new.status is distinct from old.status then
    if old.status = 'closed' then
      raise exception
        'Savings account % is closed. Closing is final.', old.account_number
        using errcode = 'P0001';
    end if;

    if new.status not in ('active', 'dormant', 'closed') then
      raise exception 'Unknown savings account status "%".', new.status
        using errcode = 'P0001';
    end if;

    new.closed_on := case when new.status = 'closed'
                          then coalesce(new.closed_on, public.business_date())
                     end;
  end if;

  if auth.uid() is null then
    return new;
  end if;

  if new.created_by is distinct from old.created_by
     or new.created_by_label is distinct from old.created_by_label then
    raise exception 'Savings account provenance cannot be rewritten.'
      using errcode = 'P0001';
  end if;

  if (new.status is distinct from old.status
      or new.status_reason is distinct from old.status_reason)
     and not public.user_has_permission('savings:reverse') then
    -- Restricting an account is a supervisory act, not a counter one. It
    -- rides on the narrowest savings capability rather than inventing an
    -- eighth one for a workflow this phase does not ship.
    raise exception
      'Changing a savings account''s status requires the savings:reverse capability.'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

create trigger savings_accounts_guard
  before update on public.savings_accounts
  for each row execute function public.savings_accounts_guard();

-- An account holds financial history. It is closed, never deleted.
create trigger savings_accounts_no_delete
  before delete on public.savings_accounts
  for each statement execute function public.reject_mutation();

revoke all on function public.savings_accounts_stamp_provenance()
  from public, anon, authenticated;
revoke all on function public.savings_accounts_guard()
  from public, anon, authenticated;

-- ===========================================================================
-- open_savings_account()
--
-- Idempotent by construction rather than by key: a membership has one
-- account, so a second call returns the first. That is what lets the
-- enrolment function call it without having to know whether it has run.
-- ===========================================================================

create or replace function public.open_savings_account(p_membership_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_account_id uuid;
  v_membership public.memberships;
begin
  -- Serialise on the membership, so two enrolment submissions cannot both
  -- find no account and both insert one.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('savings_account:' || p_membership_id::text)
  );

  select id into v_account_id
  from public.savings_accounts where membership_id = p_membership_id;

  if v_account_id is not null then
    return v_account_id;
  end if;

  select * into v_membership
  from public.memberships where id = p_membership_id;

  if not found then
    raise exception 'No such membership.' using errcode = 'P0001';
  end if;

  if auth.uid() is not null
     and not public.user_has_permission('membership:create')
     and not public.user_has_permission('savings:deposit') then
    raise exception
      'Opening a savings account requires the membership:create or savings:deposit capability.'
      using errcode = 'P0001';
  end if;

  -- The savings rules have to be open. Enrolment and savings are gated
  -- separately — a member can be enrolled while the savings questions are
  -- unanswered — so this is the gate that says the account may exist.
  if not public.membership_policy_allows(v_membership.policy_version_id, 'savings') then
    raise exception
      'Savings are not open under the policy version governing membership %. The savings rules have not been decided.',
      v_membership.membership_number using errcode = 'P0001';
  end if;

  insert into public.savings_accounts (membership_id, opened_on)
  values (p_membership_id, public.business_date())
  returning id into v_account_id;

  return v_account_id;
end;
$$;

comment on function public.open_savings_account(uuid) is
  'Polytos Phase 2. Opens the membership''s savings account, or returns the one it already has. Refuses while the savings rules are undecided — enrolment and savings are gated separately.';

revoke all on function public.open_savings_account(uuid) from public, anon;
grant execute on function public.open_savings_account(uuid) to authenticated;
