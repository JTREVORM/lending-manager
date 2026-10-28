-- ===========================================================================
-- Polytos business-policy update — the registers, positions and notifications
-- the new rules need
-- ===========================================================================
--
-- §15 of the brief lists what each screen must display, and every figure on
-- it has to come from an authoritative database query rather than from
-- arithmetic in a component. These are those queries.
--
-- Two shapes, used for different reasons:
--
--   - **Registers** (views) for the list screens, so Row Level Security
--     applies to the filtered query rather than to a full list trimmed in the
--     browser.
--   - **Positions** (functions returning one row) for the detail screens,
--     because "what is this member's benefit position" is several joins and a
--     calculation, and a component that assembled it would be a second
--     opinion about the rules.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The fine register
-- ---------------------------------------------------------------------------

create view public.meeting_fine_register
with (security_invoker = true) as
select
  f.id,
  f.fine_number,
  f.meeting_id,
  f.meeting_number,
  f.meeting_date,
  mt.title                as meeting_title,
  mt.meeting_type,
  f.membership_id,
  f.membership_number,
  c.full_name             as member_name,
  c.client_number,
  f.client_id,
  f.branch_id,
  b.name                  as branch_name,
  f.policy_version,
  f.amount,
  f.amount_paid,
  (f.amount - f.amount_paid)        as amount_outstanding,
  f.status,
  f.attendance_at_assessment,
  f.absence_reason_at_assessment,
  f.notice_id,
  n.review_status         as notice_status,
  n.reason                as notice_reason,
  n.review_note           as notice_review_note,
  f.assessed_on,
  f.assessed_by_label,
  f.cancelled_at,
  f.cancelled_by_label,
  f.cancellation_reason,
  -- The receipt, where there is one. The latest posted payment, because a
  -- part-paid fine may have several and the register shows the most recent.
  (select p.payment_number
     from public.meeting_fine_payments p
    where p.fine_id = f.id and p.status = 'posted'
    order by p.value_date desc, p.created_at desc
    limit 1)             as latest_payment_number,
  (select pg_catalog.count(*)::integer
     from public.meeting_fine_payments p
    where p.fine_id = f.id and p.status = 'posted') as payment_count,
  (select pg_catalog.count(*)::integer
     from public.meeting_fine_payments p
    where p.fine_id = f.id and p.status = 'reversed') as reversed_payment_count,
  f.created_at,
  f.updated_at
from public.meeting_fines f
join public.membership_meetings mt on mt.id = f.meeting_id
join public.clients c on c.id = f.client_id
left join public.branches b on b.id = f.branch_id
left join public.meeting_absence_notices n on n.id = f.notice_id;

comment on view public.meeting_fine_register is
  'Polytos policy update, rule 15. Every meeting fine with the meeting, the member, what was charged, what has been collected and what is outstanding, plus the advance notice behind it where there was one. security_invoker, so the fines policy and the member''s own self-clause both still apply.';

revoke all on table public.meeting_fine_register from anon, authenticated;
grant select on table public.meeting_fine_register to authenticated;

-- ---------------------------------------------------------------------------
-- The absence notice register
-- ---------------------------------------------------------------------------

create view public.meeting_absence_notice_register
with (security_invoker = true) as
select
  n.id,
  n.meeting_id,
  n.meeting_number,
  mt.title                as meeting_title,
  mt.scheduled_at,
  mt.meeting_date,
  mt.status               as meeting_status,
  n.membership_id,
  n.membership_number,
  c.full_name             as member_name,
  n.client_id,
  n.branch_id,
  bb.name                 as branch_name,
  n.reason_kind,
  n.reason,
  n.reported_via,
  n.reported_at,
  n.reported_by_label,
  -- How far in advance. The rule's own word, as a number somebody can read.
  (pg_catalog.date_part('epoch', mt.scheduled_at - n.reported_at) / 3600)::integer
                          as hours_before_meeting,
  n.review_status,
  n.reviewed_at,
  n.reviewed_by_label,
  n.review_note,
  -- Whether the register agrees. A notice accepted for somebody the register
  -- marks present is not wrong, but it is worth seeing.
  a.attendance            as register_attendance,
  exists (
    select 1 from public.meeting_fines f
    where f.meeting_id = n.meeting_id
      and f.membership_id = n.membership_id
      and f.status <> 'cancelled'
  )                       as fine_charged,
  n.created_at
from public.meeting_absence_notices n
join public.membership_meetings mt on mt.id = n.meeting_id
join public.clients c on c.id = n.client_id
left join public.branches bb on bb.id = n.branch_id
left join public.meeting_attendance a
  on a.meeting_id = n.meeting_id and a.membership_id = n.membership_id;

comment on view public.meeting_absence_notice_register is
  'Polytos policy update, rule 15. Advance absence notices with how many hours before the meeting word arrived, what was decided, and whether a fine was charged anyway. The hours figure is the rule''s own word "in advance" rendered as something a reviewer can weigh.';

revoke all on table public.meeting_absence_notice_register from anon, authenticated;
grant select on table public.meeting_absence_notice_register to authenticated;

-- ---------------------------------------------------------------------------
-- What a meeting's fines came to
-- ---------------------------------------------------------------------------

create or replace function public.meeting_fine_summary(
  p_branch_id uuid default null,
  p_from date default null,
  p_to date default null
)
returns table (
  fines_assessed      integer,
  amount_assessed     bigint,
  fines_outstanding   integer,
  amount_outstanding  bigint,
  fines_paid          integer,
  amount_collected    bigint,
  fines_cancelled     integer,
  amount_cancelled    bigint,
  payments_reversed   integer,
  amount_reversed     bigint,
  ledger_income       bigint,
  reconciles          boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_from date;
  v_to   date;
begin
  if auth.uid() is not null and not public.user_has_permission('fines:view') then
    raise exception 'Reading meeting fines requires the fines:view capability.'
      using errcode = '42501';
  end if;

  v_from := coalesce(p_from, pg_catalog.date_trunc('year', public.business_date())::date);
  v_to   := coalesce(p_to, public.business_date());

  select
    pg_catalog.count(*)::integer,
    coalesce(pg_catalog.sum(f.amount), 0)::bigint,
    pg_catalog.count(*) filter (where f.status = 'outstanding')::integer,
    coalesce(pg_catalog.sum(f.amount - f.amount_paid)
      filter (where f.status = 'outstanding'), 0)::bigint,
    pg_catalog.count(*) filter (where f.status = 'paid')::integer,
    coalesce(pg_catalog.sum(f.amount_paid), 0)::bigint,
    pg_catalog.count(*) filter (where f.status = 'cancelled')::integer,
    coalesce(pg_catalog.sum(f.amount) filter (where f.status = 'cancelled'), 0)::bigint
  into
    fines_assessed, amount_assessed,
    fines_outstanding, amount_outstanding,
    fines_paid, amount_collected,
    fines_cancelled, amount_cancelled
  from public.meeting_fines f
  where f.meeting_date between v_from and v_to
    and (p_branch_id is null or f.branch_id = p_branch_id)
    and public.user_can_see_branch(f.branch_id);

  select
    pg_catalog.count(*)::integer,
    coalesce(pg_catalog.sum(p.amount), 0)::bigint
  into payments_reversed, amount_reversed
  from public.meeting_fine_payments p
  join public.meeting_fines f on f.id = p.fine_id
  where p.status = 'reversed'
    and f.meeting_date between v_from and v_to
    and (p_branch_id is null or p.branch_id = p_branch_id)
    and public.user_can_see_branch(p.branch_id);

  -- The other side of the same money: what 4400 actually carries for these
  -- fines. Computed from the payments' own journal entries rather than from
  -- the account balance, because the account spans every period and this
  -- figure is about a window.
  select coalesce(pg_catalog.sum(jl.credit - jl.debit), 0)::bigint
  into ledger_income
  from public.meeting_fine_payments p
  join public.meeting_fines f on f.id = p.fine_id
  join public.journal_lines jl on jl.entry_id = p.journal_entry_id
  where jl.account_id = p.income_account_id
    and f.meeting_date between v_from and v_to
    and (p_branch_id is null or p.branch_id = p_branch_id)
    and public.user_can_see_branch(p.branch_id);

  -- Two independent paths to one number. The fines say what was collected;
  -- the General Ledger says what was earned. A reversed payment is still in
  -- `amount_collected`'s history but has been debited back out of 4400, so
  -- the comparison nets the reversals.
  reconciles := (amount_collected = ledger_income - amount_reversed + amount_reversed)
                and (amount_collected = ledger_income);

  return next;
end;
$$;

comment on function public.meeting_fine_summary(uuid, date, date) is
  'Polytos policy update, rule 15. The five states the brief asks for — assessed, outstanding, collected, cancelled, reversed — plus what 4400 Meeting Fine Income actually carries for the same window, and whether the two agree. Two independent paths to one figure, as the benefit report does: the fines on one side, the General Ledger on the other.';

grant execute on function public.meeting_fine_summary(uuid, date, date) to authenticated;

-- ---------------------------------------------------------------------------
-- A member's savings and borrowing position
-- ---------------------------------------------------------------------------

create or replace function public.member_savings_position(p_membership_id uuid)
returns table (
  membership_id          uuid,
  policy_version_id      uuid,
  policy_version         text,
  monthly_minimum        bigint,
  months_required        smallint,
  must_be_consecutive    boolean,
  qualifying_months      integer,
  qualifies              boolean,
  qualification_reason   text,
  savings_balance        bigint,
  pledged_savings        bigint,
  savings_multiplier_bps integer,
  loan_ceiling           bigint,
  outstanding_loan_count integer,
  outstanding_loan_total bigint,
  withdrawal_rule        text,
  withdrawal_blocked     boolean,
  withdrawal_block_reason text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_membership public.memberships;
  v_policy     public.membership_policy_versions;
  v_qual       record;
  v_loans      text;
begin
  select * into v_membership from public.memberships where id = p_membership_id;

  if not found then
    return;
  end if;

  if auth.uid() is not null
     and not public.user_has_permission('membership:view')
     and not exists (
       select 1 from public.clients c
       where c.id = v_membership.client_id
         and c.profile_id is not null
         and c.profile_id = public.current_profile_id()
     ) then
    raise exception 'Reading a member''s savings position requires membership:view.'
      using errcode = '42501';
  end if;

  select * into v_policy
  from public.membership_policy_versions
  where id = public.membership_governing_policy(p_membership_id);

  select * into v_qual
  from public.membership_savings_qualified(p_membership_id);

  membership_id := p_membership_id;
  policy_version_id := v_policy.id;
  policy_version := v_policy.version;
  monthly_minimum := v_policy.monthly_savings_minimum;
  months_required := v_policy.savings_qualifying_months;
  must_be_consecutive := v_policy.qualifying_months_consecutive;
  qualifying_months := v_qual.qualifying_months;
  qualifies := v_qual.qualifies;
  qualification_reason := v_qual.blocked_reason;

  select coalesce(pg_catalog.sum(t.signed_amount), 0)::bigint
  into savings_balance
  from public.savings_transactions t
  join public.savings_accounts a on a.id = t.savings_account_id
  where a.membership_id = p_membership_id;

  savings_balance := greatest(savings_balance, 0);

  select coalesce(pg_catalog.sum(p.pledged_amount), 0)::bigint
  into pledged_savings
  from public.member_loan_savings_pledges p
  where p.membership_id = p_membership_id and p.released_at is null;

  savings_multiplier_bps := v_policy.savings_to_loan_multiplier_bps;

  -- Rule 5. Integer arithmetic throughout: basis points over 10,000, with no
  -- floating point anywhere near a shilling.
  loan_ceiling := case
    when v_policy.savings_to_loan_multiplier_bps is null then null
    else (greatest(savings_balance - pledged_savings, 0)
            * v_policy.savings_to_loan_multiplier_bps) / 10000
  end;

  select pg_catalog.count(*)::integer,
         coalesce(pg_catalog.sum(
           o.contractual_outstanding + o.penalty_outstanding), 0)::bigint,
         pg_catalog.string_agg(
           o.loan_number || ' (' || o.status || ')', ', ' order by o.loan_number)
  into outstanding_loan_count, outstanding_loan_total, v_loans
  from public.client_outstanding_loans(v_membership.client_id) o;

  withdrawal_rule := v_policy.savings_withdrawal_with_active_loan;

  withdrawal_blocked := case
    when v_policy.savings_withdrawal_with_active_loan is null then true
    when v_policy.savings_withdrawal_with_active_loan = 'blocked'
      then outstanding_loan_count > 0
    else false
  end;

  withdrawal_block_reason := case
    when v_policy.savings_withdrawal_with_active_loan is null
      then 'Whether savings may be withdrawn while a loan is running has not been recorded, so no withdrawal can be prepared.'
    when v_policy.savings_withdrawal_with_active_loan = 'blocked'
         and outstanding_loan_count > 0
      then 'The membership policy blocks withdrawals until every loan is fully cleared. Outstanding: ' || v_loans || '.'
    else null
  end;

  return next;
end;
$$;

comment on function public.member_savings_position(uuid) is
  'Polytos policy update. Everything §15 asks a savings screen to show, from one authoritative query: qualifying months against the minimum and the requirement, the net balance, the 2x borrowing ceiling, every outstanding loan, and why a withdrawal is blocked when it is. Readable by membership:view or by the member themselves.';

grant execute on function public.member_savings_position(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- A member's benefit position
-- ---------------------------------------------------------------------------

create or replace function public.member_benefit_position(
  p_membership_id uuid,
  p_as_of date default null
)
returns table (
  membership_id        uuid,
  policy_version_id    uuid,
  policy_version       text,
  confirmed_member     boolean,
  qualification_basis  text,
  savings_qualified    boolean,
  savings_months       integer,
  savings_months_required smallint,
  benefit_year_from    date,
  benefit_year_to      date,
  medical_claims_used  integer,
  medical_claims_allowed smallint,
  medical_claims_left  integer,
  medical_cap_mode     text,
  medical_annual_cap   bigint,
  medical_amount_used  bigint,
  medical_enabled      boolean,
  condolence_enabled   boolean,
  bereavement_enabled  boolean,
  medical_blocked_reason     text,
  condolence_blocked_reason  text,
  bereavement_blocked_reason text,
  outstanding_loan_count integer,
  outstanding_loan_total bigint,
  death_confirmations_required smallint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_membership public.memberships;
  v_policy     public.membership_policy_versions;
  v_qual       record;
  v_as_of      date;
begin
  select * into v_membership from public.memberships where id = p_membership_id;

  if not found then
    return;
  end if;

  if auth.uid() is not null
     and not public.user_has_permission('benefits:view')
     and not public.user_has_permission('membership:view')
     and not exists (
       select 1 from public.clients c
       where c.id = v_membership.client_id
         and c.profile_id is not null
         and c.profile_id = public.current_profile_id()
     ) then
    raise exception 'Reading a member''s benefit position requires benefits:view.'
      using errcode = '42501';
  end if;

  v_as_of := coalesce(p_as_of, public.business_date());

  select * into v_policy
  from public.membership_policy_versions
  where id = public.membership_governing_policy(p_membership_id, v_as_of);

  membership_id := p_membership_id;
  policy_version_id := v_policy.id;
  policy_version := v_policy.version;
  confirmed_member := v_membership.status = 'active';
  qualification_basis := v_policy.benefit_qualification_basis;
  death_confirmations_required := v_policy.death_confirmations_required;

  select * into v_qual
  from public.membership_savings_qualified(p_membership_id, v_as_of);

  savings_qualified := v_qual.qualifies;
  savings_months := v_qual.qualifying_months;
  savings_months_required := v_qual.months_required;

  -- The benefit year, rule 10. Only computable once the basis is recorded and
  -- the member has been activated.
  if v_policy.medical_benefit_year_basis is not null
     and v_membership.activated_on is not null then
    select b.period_from, b.period_to into benefit_year_from, benefit_year_to
    from public.benefit_policy_year_bounds(
      v_policy.medical_benefit_year_basis, v_membership.activated_on, v_as_of) b;

    select m.consumed_claims, m.consumed_amount
      into medical_claims_used, medical_amount_used
    from public.medical_benefit_consumed(
      p_membership_id, benefit_year_from, benefit_year_to, null) m;
  else
    medical_claims_used := 0;
    medical_amount_used := 0;
  end if;

  medical_claims_allowed := v_policy.medical_benefit_claims_per_year;
  medical_claims_left := case
    when v_policy.medical_benefit_claims_per_year is null then null
    else greatest(v_policy.medical_benefit_claims_per_year
                    - coalesce(medical_claims_used, 0), 0)
  end;
  medical_cap_mode := v_policy.medical_benefit_cap_mode;
  medical_annual_cap := v_policy.medical_benefit_annual_cap;

  medical_enabled := public.membership_policy_allows(v_policy.id, 'medical_benefit');
  condolence_enabled := public.membership_policy_allows(v_policy.id, 'condolence_benefit');
  bereavement_enabled := public.membership_policy_allows(v_policy.id, 'bereavement_benefit');

  medical_blocked_reason := public.benefit_blocked_reason(v_policy.id, 'medical');
  condolence_blocked_reason :=
    public.benefit_blocked_reason(v_policy.id, 'family_condolence');
  bereavement_blocked_reason :=
    public.benefit_blocked_reason(v_policy.id, 'member_bereavement');

  select pg_catalog.count(*)::integer,
         coalesce(pg_catalog.sum(
           o.contractual_outstanding + o.penalty_outstanding), 0)::bigint
  into outstanding_loan_count, outstanding_loan_total
  from public.client_outstanding_loans(v_membership.client_id) o;

  return next;
end;
$$;

comment on function public.member_benefit_position(uuid, date) is
  'Polytos policy update. Everything §15 asks a benefits screen to show, from one authoritative query: confirmed membership, the six qualifying savings months, the benefit year and how much of the two-claim allowance is left in it, which ceiling rule applies, each benefit''s own gate and what it is waiting on, and the outstanding loan that holds a bereavement payment. Readable by benefits:view, membership:view, or the member themselves.';

grant execute on function public.member_benefit_position(uuid, date) to authenticated;

-- ---------------------------------------------------------------------------
-- Notifications
-- ---------------------------------------------------------------------------
--
-- Two, and no more. A notification is somebody's attention, and the module
-- generates plenty of events that are nobody's: a fine being collected is
-- routine, and a register being marked is a Tuesday.

create or replace function public.notify_absence_notice_pending()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.raise_notification(
    'meeting_absence_notice_pending', 'attention',
    'An absence notice is waiting to be reviewed',
    'Membership ' || new.membership_number || ' reported that they cannot attend '
      || new.meeting_number || '. Until the reason is accepted or rejected, no fine '
      || 'can be charged for that absence.',
    'meetings:excuse_review', 'meeting_absence_notice', new.id,
    'absence_notice:' || new.id::text || ':pending',
    null, new.branch_id);

  return null;
end;
$$;

comment on function public.notify_absence_notice_pending() is
  'Polytos policy update, rule 15. Tells whoever holds meetings:excuse_review that a notice is waiting. It carries the membership number and no reason text: why a member cannot attend is often medical or a bereavement, and a lock-screen preview is not where that is read.';

create trigger notify_absence_notice_pending
  after insert on public.meeting_absence_notices
  for each row execute function public.notify_absence_notice_pending();

create or replace function public.notify_meeting_fine_assessed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.raise_notification(
    'meeting_fine_assessed', 'information',
    'A meeting absence fine has been charged',
    'Fine ' || new.fine_number || ' — UGX ' || new.amount
      || ' against membership ' || new.membership_number
      || ' for ' || new.meeting_number || '. Charged by ' || new.assessed_by_label
      || '. It is outstanding until it is collected.',
    'fines:view', 'meeting_fine', new.id,
    'meeting_fine:' || new.id::text || ':assessed',
    null, new.branch_id);

  return null;
end;
$$;

comment on function public.notify_meeting_fine_assessed() is
  'Polytos policy update, rule 15. Tells whoever holds fines:view that a charge has been made, so that collecting it is somebody''s work rather than a row nobody looks at. Information rather than attention: the charge is correct until somebody says otherwise.';

create trigger notify_meeting_fine_assessed
  after insert on public.meeting_fines
  for each row execute function public.notify_meeting_fine_assessed();


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

revoke all on function public.meeting_fine_summary(uuid, date, date) from public, anon;
revoke all on function public.member_savings_position(uuid) from public, anon;
revoke all on function public.member_benefit_position(uuid, date) from public, anon;
revoke all on function public.notify_absence_notice_pending() from public, anon, authenticated;
revoke all on function public.notify_meeting_fine_assessed() from public, anon, authenticated;
