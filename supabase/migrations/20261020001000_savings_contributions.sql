-- ===========================================================================
-- Polytos Phase 2.10 — months, minimums and qualification
--
-- ## A contribution is a deposit, net of its own reversal — and nothing else
--
-- What counts towards a month is what the member paid in that month, less any
-- of it that was reversed. A **withdrawal does not reduce a contribution**:
-- taking savings back out later does not un-pay what was paid in March. It
-- reduces the balance, which is a different question, and the two are
-- reported separately for exactly that reason.
--
-- A reversal is attributed to **the month of the deposit it reverses**, not
-- the month it was made in. A UGX 50,000 deposit in March reversed in May
-- means March was short, not that May was negative; anything else would make
-- a correction look like a missed month in the wrong place.
--
-- ## The month boundary is Kampala's, decided once
--
-- `contribution_month` is generated from `value_date`, which is
-- `business_date()` — already Africa/Kampala. A deposit taken at 00:30 on the
-- 1st belongs to the new month and one at 23:30 on the 31st to the old one,
-- and no reader of this data has to know what timezone it was written in. The
-- alternative — grouping on `occurred_at` in UTC — would move every late
-- evening deposit in Kampala into the following month.
--
-- ## "As of" means what was known then, and stays that way
--
-- `p_as_of` filters on `value_date`, for deposits and reversals alike. A
-- deposit made after the date is not counted, and neither is a reversal made
-- after it: the answer to "did this member qualify on 1 June" must not change
-- because of something that happened in July. Phase 3 will approve loans
-- against this function with the application date as `p_as_of`, and the
-- snapshot it took has to stay the snapshot it took.
--
-- ## Qualification is the client's rule, both ways
--
-- `qualifying_months_consecutive` decides whether the six months must run
-- unbroken. It is one of the nine, and savings do not open until it is
-- decided, so by the time there is a contribution history to judge, the rule
-- exists. Both arms are implemented; neither is a default.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Every month an account has contributed in, with the reversal attributed to
-- the month it corrects.
-- ---------------------------------------------------------------------------

create or replace view public.member_savings_contributions
with (security_invoker = true) as
with attributed as (
  select
    t.savings_account_id,
    -- A reversal counts against the month of the deposit it reverses.
    coalesce(o.contribution_month, t.contribution_month) as contribution_month,
    case t.kind
      when 'deposit' then t.amount
      when 'deposit_reversal' then -t.amount
      else 0
    end                                                  as contributed,
    t.value_date,
    t.kind
  from public.savings_transactions t
  left join public.savings_transactions o
    on o.id = t.reverses_transaction_id
  where t.kind in ('deposit', 'deposit_reversal')
)
select
  a.savings_account_id,
  a.contribution_month,
  sum(a.contributed)::bigint                                  as contributed,
  sum(a.contributed) filter (where a.kind = 'deposit')::bigint
                                                              as deposited,
  coalesce(-sum(a.contributed) filter (where a.kind = 'deposit_reversal'), 0)::bigint
                                                              as reversed,
  count(*) filter (where a.kind = 'deposit')                  as deposit_count,
  max(a.value_date)                                           as last_deposit_on,
  v.monthly_savings_minimum,
  (sum(a.contributed) >= v.monthly_savings_minimum)           as meets_minimum,
  greatest(v.monthly_savings_minimum - sum(a.contributed), 0)::bigint
                                                              as shortfall,
  greatest(sum(a.contributed) - v.monthly_savings_minimum, 0)::bigint
                                                              as surplus
from attributed a
join public.savings_accounts sa on sa.id = a.savings_account_id
join public.membership_policy_versions v on v.id = sa.policy_version_id
group by a.savings_account_id, a.contribution_month,
         v.monthly_savings_minimum;

comment on view public.member_savings_contributions is
  'Polytos Phase 2. What a savings account contributed in each calendar month, in Africa/Kampala, net of reversals attributed back to the month they correct. A withdrawal does not appear here: it reduces the balance, not what was contributed.';

-- ---------------------------------------------------------------------------
-- Qualification, as of a date
-- ---------------------------------------------------------------------------

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
-- SECURITY INVOKER, deliberately, and this is the whole authorisation story
-- for this function. It reads `savings_accounts` and `savings_transactions`,
-- both of which carry policies that already answer "may this caller see this
-- member?" — staff holding `savings:view` within their branch, and the member
-- whose savings they are. Running as the owner instead would hand any
-- signed-in caller every member's contribution history for the price of an
-- account id, because a definer function is not filtered by the policies on
-- the tables it reads. A second predicate written in here would be the same
-- rule stated twice, and the copy that drifts is the one that leaks.
--
-- The account not being visible and the account not existing are the same
-- answer — 'No such savings account' — which is what it should be: a caller
-- who may not read a row has no business learning that it is there.
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
begin
  select * into v_account
  from public.savings_accounts where id = p_savings_account_id;

  if not found then
    raise exception 'No such savings account.' using errcode = 'P0001';
  end if;

  select * into v_policy
  from public.membership_policy_versions where id = v_account.policy_version_id;

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
  for v_row in
    select m.contribution_month, m.contributed, m.meets_minimum
    from (
      select
        coalesce(o.contribution_month, t.contribution_month) as contribution_month,
        sum(case t.kind when 'deposit' then t.amount else -t.amount end) as contributed,
        (sum(case t.kind when 'deposit' then t.amount else -t.amount end)
           >= v_policy.monthly_savings_minimum) as meets_minimum
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

    if v_row.meets_minimum then
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
  if not public.membership_policy_allows(v_account.policy_version_id, 'savings') then
    qualifies := false;
    blocked_reason :=
      'Savings are not open under this member''s policy version, so no qualification can be claimed.';
  end if;

  return next;
end;
$$;

comment on function public.member_savings_qualification(uuid, date) is
  'Polytos Phase 2. A savings account''s contribution record and whether it qualifies, as of a date. Reads only transactions dated on or before that date, so a later deposit cannot change what was true then — which is the interface Phase 3 approves member loans against.';

revoke all on function public.member_savings_qualification(uuid, date) from public, anon;
grant execute on function public.member_savings_qualification(uuid, date) to authenticated;

-- ---------------------------------------------------------------------------
-- The savings statement
--
-- A running balance computed in the database, in one chronological order, so
-- the figure on screen, the figure in the CSV and the figure in the PDF are
-- the same figure rather than three renderings that each sorted differently.
-- The order is (value_date, transaction_number): the number is gapless and
-- monotonic, so it breaks ties on a day deterministically.
-- ---------------------------------------------------------------------------

create or replace function public.savings_statement(
  p_savings_account_id uuid,
  p_from date default null,
  p_to date default null
)
returns table (
  transaction_id uuid,
  transaction_number text,
  value_date date,
  kind text,
  description text,
  deposit bigint,
  withdrawal bigint,
  signed_amount bigint,
  running_balance bigint,
  payment_method text,
  external_reference text,
  reverses_transaction_number text,
  reversal_reason text,
  recorded_by_label text
)
language sql
stable
-- SECURITY INVOKER, for the reason set out on `member_savings_qualification`
-- above: the policies on `savings_transactions` are the boundary, and a
-- definer function here would have been a way around all of them. A member
-- calling this with another member's account id gets no rows, because the
-- policy gives them none.
security invoker
set search_path = ''
as $$
  with ordered as (
    select
      t.id,
      t.transaction_number,
      t.value_date,
      t.kind,
      t.amount,
      t.signed_amount,
      t.payment_method,
      t.external_reference,
      o.transaction_number as reverses_number,
      t.reversal_reason,
      t.recorded_by_label,
      sum(t.signed_amount) over (
        order by t.value_date, t.transaction_number
        rows between unbounded preceding and current row
      ) as running
    from public.savings_transactions t
    left join public.savings_transactions o on o.id = t.reverses_transaction_id
    where t.savings_account_id = p_savings_account_id
  )
  select
    o.id,
    o.transaction_number,
    o.value_date,
    o.kind,
    case o.kind
      when 'deposit' then 'Savings deposit'
      when 'withdrawal' then 'Savings withdrawal'
      when 'deposit_reversal' then 'Deposit reversed — ' || coalesce(o.reverses_number, '')
      else 'Withdrawal reversed — ' || coalesce(o.reverses_number, '')
    end,
    case when o.signed_amount > 0 then o.amount else 0 end::bigint,
    case when o.signed_amount < 0 then o.amount else 0 end::bigint,
    o.signed_amount,
    o.running::bigint,
    o.payment_method,
    o.external_reference,
    o.reverses_number,
    o.reversal_reason,
    o.recorded_by_label
  from ordered o
  where (p_from is null or o.value_date >= p_from)
    and (p_to is null or o.value_date <= p_to)
  order by o.value_date, o.transaction_number;
$$;

comment on function public.savings_statement(uuid, date, date) is
  'Polytos Phase 2. A savings account''s statement with a running balance. The window runs over the whole account and the period filter is applied afterwards, so a statement for March opens at the balance March actually opened at rather than at zero.';

revoke all on function public.savings_statement(uuid, date, date) from public, anon;
grant execute on function public.savings_statement(uuid, date, date) to authenticated;

-- ---------------------------------------------------------------------------
-- The savings position, for a dashboard
--
-- Every figure here is derived from the subledger, and the liability figure
-- is the one that must equal the `2100` balance. A reconciliation test
-- asserts exactly that.
-- ---------------------------------------------------------------------------

create or replace function public.savings_summary(
  p_from date default null,
  p_to date default null
)
returns table (
  accounts_open integer,
  members_saving integer,
  total_liability bigint,
  deposits_in_period bigint,
  withdrawals_in_period bigint,
  deposits_count integer,
  withdrawals_count integer,
  pending_withdrawal_requests integer,
  pending_withdrawal_value bigint,
  members_meeting_minimum integer
)
language plpgsql
stable
-- SECURITY DEFINER, unlike the two functions above, and for the opposite
-- reason. This one's whole purpose is the figure for the business as a whole:
-- under the invoker's policies a member would receive their own balance
-- labelled `total_liability`, which is not a leak but is a lie, and a branch
-- manager would receive their branch's. So it runs as the owner and asks for
-- the reporting capability explicitly — the one check that has to be written
-- out, because there is no row for a policy to filter.
security definer
set search_path = ''
as $$
begin
  if auth.uid() is not null
     and not public.user_has_permission('savings:view_reports') then
    raise exception
      'The savings position is a report. Reading it requires the savings:view_reports capability.'
      using errcode = 'P0001';
  end if;

  return query
  select
    (select count(*)::integer from public.savings_accounts where status <> 'closed'),
    (select count(distinct savings_account_id)::integer
       from public.savings_transactions where kind = 'deposit'),
    (select coalesce(sum(signed_amount), 0)::bigint from public.savings_transactions),
    (select coalesce(sum(amount) filter (where kind = 'deposit'), 0)::bigint
       - coalesce(sum(amount) filter (where kind = 'deposit_reversal'), 0)::bigint
       from public.savings_transactions
      where (p_from is null or value_date >= p_from)
        and (p_to is null or value_date <= p_to)),
    (select coalesce(sum(amount) filter (where kind = 'withdrawal'), 0)::bigint
       - coalesce(sum(amount) filter (where kind = 'withdrawal_reversal'), 0)::bigint
       from public.savings_transactions
      where (p_from is null or value_date >= p_from)
        and (p_to is null or value_date <= p_to)),
    (select count(*)::integer from public.savings_transactions
      where kind = 'deposit'
        and (p_from is null or value_date >= p_from)
        and (p_to is null or value_date <= p_to)),
    (select count(*)::integer from public.savings_transactions
      where kind = 'withdrawal'
        and (p_from is null or value_date >= p_from)
        and (p_to is null or value_date <= p_to)),
    (select count(*)::integer from public.savings_withdrawal_requests
      where status = 'pending'),
    (select coalesce(sum(amount), 0)::bigint from public.savings_withdrawal_requests
      where status = 'pending'),
    (select count(*)::integer from public.member_savings_contributions
      where contribution_month = pg_catalog.make_date(
              pg_catalog.date_part('year', public.business_date())::integer,
              pg_catalog.date_part('month', public.business_date())::integer, 1)
        and meets_minimum);
end;
$$;

comment on function public.savings_summary(date, date) is
  'Polytos Phase 2. The savings position for a dashboard: accounts, the liability, the period''s movements and this month''s compliance. Every figure comes from the subledger, and total_liability is the figure that must equal the 2100 ledger balance.';

revoke all on function public.savings_summary(date, date) from public, anon;
grant execute on function public.savings_summary(date, date) to authenticated;
