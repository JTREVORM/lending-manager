-- ===========================================================================
-- Polytos business-policy update — asking the savings qualification question
-- of a named policy version
-- ===========================================================================
--
-- `member_savings_qualification` answers "does this account qualify" by
-- reading the policy version frozen on the account. Two things now need to
-- ask the same question of a *different* version:
--
--   - the transition preview, which has to show what would change before
--     anybody is moved — "qualifies today, would not qualify afterwards" is
--     the sentence the whole preview exists to produce;
--   - the qualification engine itself, once a membership can be governed by
--     one version in November and another in December.
--
-- So the body moves into `savings_qualification_under_policy`, which takes the
-- version as an argument, and `member_savings_qualification` becomes a thin
-- call to it. Same answer, same columns, same every existing caller — this
-- migration changes no behaviour at all. It only makes the question askable of
-- a version that is not the one on the account.
--
-- The monthly minimum is resolved **per contribution month** rather than once,
-- from the version governing the membership in that month. That is the
-- guarantee the transition rests on: a month saved under a UGX 50,000 minimum
-- is judged against UGX 50,000 forever, whatever the member is moved onto
-- afterwards. With the version being asked about passed in explicitly, the
-- per-month lookup is bounded by it — a preview of version 2.0 asks "what
-- would 2.0 say", and the live engine asks "what does the governing version
-- for that month say".
--
-- `p_month_minimum_from_history` is what separates the two. False — the
-- preview — judges every month against the one version named. True — the live
-- engine, from the next migration — judges each month against the version
-- that governed it. Both are needed and they are different questions:
-- "what would this version say about my whole history" and "what do the terms
-- I was actually held to say".
-- ===========================================================================

create or replace function public.savings_qualification_under_policy(
  p_savings_account_id uuid,
  p_policy_version_id uuid,
  p_as_of date default null,
  p_month_minimum_from_history boolean default false
)
returns table (
  savings_account_id uuid,
  as_of date,
  monthly_minimum bigint,
  months_required smallint,
  must_be_consecutive boolean,
  qualifying_months integer,
  longest_consecutive_months integer,
  months_recorded integer,
  months_short integer,
  total_contributed bigint,
  total_withdrawn bigint,
  balance bigint,
  qualifies boolean,
  blocked_reason text
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_account    public.savings_accounts;
  v_policy     public.membership_policy_versions;
  v_as_of      date;
  v_run        integer := 0;
  v_best       integer := 0;
  v_prev       date;
  v_row        record;
  v_minimum    bigint;
begin
  select * into v_account
  from public.savings_accounts where id = p_savings_account_id;

  if not found then
    raise exception 'No such savings account.' using errcode = 'P0001';
  end if;

  select * into v_policy
  from public.membership_policy_versions where id = p_policy_version_id;

  if not found then
    raise exception 'No such policy version.' using errcode = 'P0001';
  end if;

  v_as_of := coalesce(p_as_of, public.business_date());

  savings_account_id := p_savings_account_id;
  as_of := v_as_of;
  monthly_minimum := v_policy.monthly_savings_minimum;
  months_required := v_policy.savings_qualifying_months;
  must_be_consecutive := v_policy.qualifying_months_consecutive;

  -- Everything below reads only transactions dated on or before `as_of`, so
  -- the answer to "did they qualify then" cannot be changed by anything that
  -- happened since.
  select
    coalesce(sum(t.amount) filter (where t.kind = 'deposit'), 0)
      - coalesce(sum(t.amount) filter (where t.kind = 'deposit_reversal'), 0),
    coalesce(sum(t.amount) filter (where t.kind = 'withdrawal'), 0)
      - coalesce(sum(t.amount) filter (where t.kind = 'withdrawal_reversal'), 0),
    coalesce(sum(t.signed_amount), 0)
  into total_contributed, total_withdrawn, balance
  from public.savings_transactions t
  where t.savings_account_id = p_savings_account_id
    and t.value_date <= v_as_of;

  qualifying_months := 0;
  months_recorded := 0;
  longest_consecutive_months := 0;

  -- The months, in order, so the consecutive run can be measured in one pass.
  --
  -- A reversal is attributed back to the month of the deposit it reverses,
  -- not to the month somebody noticed — `coalesce(o.contribution_month,
  -- t.contribution_month)`. A February correction to a January deposit takes
  -- January below the minimum, which is the honest answer.
  for v_row in
    select m.contribution_month, m.contributed
    from (
      select
        coalesce(o.contribution_month, t.contribution_month) as contribution_month,
        sum(case t.kind when 'deposit' then t.amount else -t.amount end) as contributed
      from public.savings_transactions t
      left join public.savings_transactions o on o.id = t.reverses_transaction_id
      where t.savings_account_id = p_savings_account_id
        and t.kind in ('deposit', 'deposit_reversal')
        and t.value_date <= v_as_of
      group by coalesce(o.contribution_month, t.contribution_month)
    ) m
    order by m.contribution_month
  loop
    months_recorded := months_recorded + 1;

    -- The minimum this month is judged against. Under the preview that is the
    -- version being asked about; under the live engine it is the version that
    -- governed the member in that month — so a transition cannot change what
    -- an already-saved month was worth.
    if p_month_minimum_from_history then
      v_minimum := coalesce(
        (select pv.monthly_savings_minimum
           from public.membership_policy_versions pv
          where pv.id = public.savings_account_governing_policy(
                  p_savings_account_id,
                  -- The last day of the contribution month, which is the
                  -- month's own terms: a member moved on the 15th saved the
                  -- whole month under the version they ended it on.
                  (v_row.contribution_month + interval '1 month'
                     - interval '1 day')::date)),
        v_policy.monthly_savings_minimum);
    else
      v_minimum := v_policy.monthly_savings_minimum;
    end if;

    if v_row.contributed >= v_minimum then
      qualifying_months := qualifying_months + 1;

      -- A run continues only into the next calendar month. A gap resets it,
      -- which is what "consecutive" means and the reason this is a loop
      -- rather than a count.
      if v_prev is not null
         and v_row.contribution_month = (v_prev + interval '1 month')::date then
        v_run := v_run + 1;
      else
        v_run := 1;
      end if;

      v_best := greatest(v_best, v_run);
      v_prev := v_row.contribution_month;
    else
      v_run := 0;
      v_prev := null;
    end if;
  end loop;

  longest_consecutive_months := v_best;
  months_short := greatest(v_policy.savings_qualifying_months - qualifying_months, 0);

  -- The rule, both arms, neither defaulted.
  if v_policy.qualifying_months_consecutive is null then
    qualifies := false;
    blocked_reason :=
      'Whether the qualifying months must be consecutive has not been decided, so nobody can be shown as qualified.';
  elsif v_policy.qualifying_months_consecutive then
    qualifies := v_best >= v_policy.savings_qualifying_months;
    blocked_reason := case
      when qualifies then null
      else 'The longest unbroken run of qualifying months is ' || v_best ||
           ' of the ' || v_policy.savings_qualifying_months || ' required.'
    end;
  else
    qualifies := qualifying_months >= v_policy.savings_qualifying_months;
    blocked_reason := case
      when qualifies then null
      else qualifying_months || ' of the ' || v_policy.savings_qualifying_months ||
           ' qualifying months have been saved.'
    end;
  end if;

  -- A member whose savings are not open cannot be qualified for anything,
  -- whatever the history says.
  if not public.membership_policy_allows(p_policy_version_id, 'savings') then
    qualifies := false;
    blocked_reason :=
      'Savings are not open under this member''s policy version, so no qualification can be claimed.';
  end if;

  return next;
end;
$$;

comment on function public.savings_qualification_under_policy(uuid, uuid, date, boolean) is
  'Polytos policy update. The savings qualification question, asked of a named policy version rather than of the one frozen on the account. The transition preview asks it of the target version to show what would change; member_savings_qualification asks it of the governing version. p_month_minimum_from_history judges each contribution month against the version that governed it, which is what makes a transition unable to change what an already-saved month was worth.';

grant execute on function
  public.savings_qualification_under_policy(uuid, uuid, date, boolean)
  to authenticated;

-- ---------------------------------------------------------------------------
-- The existing entry point, now a delegation
-- ---------------------------------------------------------------------------
--
-- Same signature, same columns, same answer. The governing version replaces
-- the frozen one in the next migration; here it still reads the account's own,
-- so this file changes nothing a test could observe.

create or replace function public.member_savings_qualification(
  p_savings_account_id uuid,
  p_as_of date default null
)
returns table (
  savings_account_id uuid,
  as_of date,
  monthly_minimum bigint,
  months_required smallint,
  must_be_consecutive boolean,
  qualifying_months integer,
  longest_consecutive_months integer,
  months_recorded integer,
  months_short integer,
  total_contributed bigint,
  total_withdrawn bigint,
  balance bigint,
  qualifies boolean,
  blocked_reason text
)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_version uuid;
begin
  select a.policy_version_id into v_version
  from public.savings_accounts a where a.id = p_savings_account_id;

  if v_version is null then
    raise exception 'No such savings account.' using errcode = 'P0001';
  end if;

  return query
  select * from public.savings_qualification_under_policy(
    p_savings_account_id, v_version, p_as_of, false);
end;
$$;

comment on function public.member_savings_qualification(uuid, date) is
  'Polytos Phase 2. Whether a savings account has met the qualifying-month rule as of a date, and why not when it has not. A thin call to savings_qualification_under_policy since the policy update, so that the same question can be asked of a version other than the one on the account.';


-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
--
-- PostgreSQL grants EXECUTE on a new function to PUBLIC, and a table created
-- in a schema `anon` can reach is reachable unless the grant is taken away.
-- Both defaults are wrong here: every table in this file is written only
-- through a SECURITY DEFINER function, and every function in it decides
-- something about money or about who may read a record.
--
-- The functions a session legitimately calls are granted back to
-- `authenticated` where they are defined. Triggers, numbering helpers and
-- notification hooks are granted back to nobody: they are called by the
-- database, and a session that could call one directly would be writing a
-- row the function assumes was validated elsewhere.

revoke all on function public.savings_qualification_under_policy(uuid, uuid, date, boolean) from public, anon;
