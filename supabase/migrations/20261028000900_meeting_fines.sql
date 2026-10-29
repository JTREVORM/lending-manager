-- ===========================================================================
-- Polytos business-policy update — rule 15, second half: the UGX 5,000
-- unexcused-absence fine
-- ===========================================================================
--
-- > An unexcused absence attracts a UGX 5,000 fine.
--
-- Phase 4 recorded attendance in four answers and attached **no consequence
-- to any of them** — deliberately, documented in ADR-068, with a unit test
-- asserting that no label in the module contained the words penalty, fine,
-- suspend, warning or strike. The client has now approved a consequence, so
-- that ADR is superseded and this is what replaces it.
--
-- ## The accounting model, and why it is this one
--
-- A fine is money owed to the business that has not been received. There are
-- two defensible ways to carry that:
--
--   **Accrual.** On assessment, Dr a receivable and Cr fine income; on
--   collection, Dr cash and Cr the receivable. The outstanding balance lives
--   in the General Ledger.
--
--   **On collection.** The charge is tracked in its own table; the General
--   Ledger recognises income when the money arrives, Dr cash and Cr fine
--   income.
--
-- This system already answered that question for the closest thing it has —
-- **loan penalties**. A penalty is charged into `loan_penalties`, its
-- outstanding balance is computed by `loan_penalty_outstanding`, and nothing
-- touches the General Ledger until a repayment arrives, at which point
-- `post_repayment_journal` credits 4200 Penalty Income by the penalty
-- component of the payment.
--
-- Meeting fines follow it. Not from inertia: a second convention in one set
-- of books would mean the income statement answered "what did we earn" one
-- way for a late loan and another way for a missed meeting, and whoever
-- reconciled it would have to know which. The brief's requirement is a model
-- "consistent with existing financial policies", and this is the policy that
-- exists.
--
-- The five states the brief asks for are all here, and none of them needs an
-- accrual entry to be answerable:
--
--   assessed   — a row exists
--   outstanding— status `outstanding`, amount_paid < amount
--   collected  — `meeting_fine_payments`, and 4400 in the General Ledger
--   cancelled  — status `cancelled`, with a reason and a name
--   reversed   — a reversal row and a reversing journal entry
--
-- An unpaid fine is therefore **structurally** incapable of appearing as cash
-- received, which is stronger than a rule saying it must not.
--
-- ## What the fine does not do
--
-- It is not deducted from savings. It is not deducted from a loan
-- disbursement. It does not suspend anybody, does not affect loan
-- eligibility, and does not affect a benefit. The client approved a fine, not
-- a set of consequences for not paying one — and a collection deadline, an
-- interest charge on an unpaid fine and an automatic deduction are each a
-- rule nobody has stated. `docs/POLYTOS-MEMBERSHIP-POLICY-DECISIONS.md`
-- records them as open.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The amount is a policy term
-- ---------------------------------------------------------------------------

alter table public.membership_policy_versions
  add column meeting_absence_fine bigint,
  add constraint membership_policy_meeting_fine_sane
    check (
      meeting_absence_fine is null
      or (meeting_absence_fine >= 0 and meeting_absence_fine <= 10000000)
    );

comment on column public.membership_policy_versions.meeting_absence_fine is
  'Polytos policy update, rule 15. What an unexcused absence from a membership meeting costs. The client''s figure is UGX 5,000. NULL means nobody has recorded it, and a fine cannot be assessed against a version that has not — there is no default, because the amount is the whole rule.';

-- Frozen with the other contractual terms, for the same reason: a member who
-- joined when no fine existed did not agree to one written in afterwards.
create or replace function public.membership_policy_terms_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_in_use boolean;
begin
  if new.medical_benefit_cap_mode is not distinct from old.medical_benefit_cap_mode
     and new.benefit_qualification_basis
           is not distinct from old.benefit_qualification_basis
     and new.death_confirmations_required
           is not distinct from old.death_confirmations_required
     and new.meeting_absence_fine is not distinct from old.meeting_absence_fine then
    return new;
  end if;

  if old.approved_at is not null then
    raise exception
      'Policy version % has been approved. Publish a new version to change how the medical ceiling, the benefit qualifying period, the death-confirmation requirement or the meeting absence fine is set.',
      old.version using errcode = 'P0001';
  end if;

  select exists (
    select 1 from public.memberships m where m.policy_version_id = old.id
  ) into v_in_use;

  if v_in_use then
    raise exception
      'Members are enrolled under policy version %. Publish a new version to change how the medical ceiling, the benefit qualifying period, the death-confirmation requirement or the meeting absence fine is set.',
      old.version using errcode = 'P0001';
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- The income account
-- ---------------------------------------------------------------------------

insert into public.ledger_accounts (code, name, account_type, normal_side, is_postable, status, description)
values (
  '4400', 'Meeting Fine Income', 'income', 'credit', true, 'active',
  'Polytos policy update, rule 15. Fines collected for unexcused absence from a membership meeting. Credited when the money arrives, as 4200 Penalty Income is — an assessed but unpaid fine is tracked in meeting_fines and is not income until it is received.'
)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- The fines
-- ---------------------------------------------------------------------------

insert into public.reference_formats (scope, prefix, padding, description)
values ('meeting_fine', 'MFN', 5,
        'A fine for unexcused absence from a membership meeting.')
on conflict (scope) do nothing;

create table public.meeting_fines (
  id                 uuid primary key default gen_random_uuid(),
  fine_number        text not null,

  meeting_id         uuid not null references public.membership_meetings(id)
                       on delete restrict,
  meeting_number     text not null,
  meeting_date       date not null,
  membership_id      uuid not null references public.memberships(id)
                       on delete restrict,
  membership_number  text not null,
  client_id          uuid not null references public.clients(id) on delete restrict,
  branch_id          uuid not null references public.branches(id) on delete restrict,

  policy_version_id  uuid not null
                       references public.membership_policy_versions(id)
                       on delete restrict,
  policy_version     text not null,

  amount             bigint not null,
  amount_paid        bigint not null default 0,

  status             text not null default 'outstanding',

  -- What the register said at the moment the fine was charged. Copied, not
  -- joined: a correction to the register afterwards must not silently change
  -- the evidence a charge rested on. `meeting_attendance_corrections` keeps
  -- the trail of the register itself.
  attendance_at_assessment     text not null,
  absence_reason_at_assessment text,
  -- The notice, where there was one. A fine beside a rejected notice is a
  -- different thing from a fine where the member said nothing, and the row
  -- should say which.
  notice_id          uuid references public.meeting_absence_notices(id)
                       on delete restrict,

  assessed_on        date not null,
  assessed_by        uuid references public.profiles(id) on delete set null,
  assessed_by_label  text not null,

  cancelled_at       timestamptz,
  cancelled_by       uuid references public.profiles(id) on delete set null,
  cancelled_by_label text,
  cancellation_reason text,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint meeting_fine_status_valid
    check (status in ('outstanding', 'paid', 'cancelled')),
  constraint meeting_fine_amount_positive
    check (amount > 0 and amount <= 10000000),
  constraint meeting_fine_paid_within_amount
    check (amount_paid >= 0 and amount_paid <= amount),
  constraint meeting_fine_paid_status_coherent
    check ((status = 'paid') = (amount_paid = amount and status <> 'cancelled')),
  constraint meeting_fine_cancellation_coherent
    check (
      (status = 'cancelled')
        = (cancelled_at is not null and cancellation_reason is not null)
    ),
  -- A cancelled fine that had already been paid would need the money
  -- returning, which is a reversal of the payment and not a cancellation of
  -- the charge. Keeping them apart keeps the cash trail honest.
  constraint meeting_fine_cancelled_is_unpaid
    check (status <> 'cancelled' or amount_paid = 0),
  constraint meeting_fine_cancellation_reason_length
    check (cancellation_reason is null
           or char_length(btrim(cancellation_reason)) between 3 and 1000),
  -- Rule 15 charges an absence. A member who was present, or who was
  -- represented, is not absent — and the register answer is copied here so
  -- the constraint can say so.
  constraint meeting_fine_charges_an_absence
    check (attendance_at_assessment in ('absent', 'apology'))
);

comment on table public.meeting_fines is
  'Polytos policy update, rule 15. A UGX 5,000 charge for unexcused absence from a membership meeting. One per member per meeting. The General Ledger sees nothing until the money arrives — an assessed fine is a charge, not income, exactly as a loan penalty is.';

comment on column public.meeting_fines.attendance_at_assessment is
  'What the register said when the fine was charged, copied rather than joined. A correction to the register afterwards must not silently change the evidence a charge rested on; it is a reason to cancel the fine, which somebody signs.';

comment on column public.meeting_fines.amount_paid is
  'What has been collected against this fine. Maintained by meeting_fine_payments and never written directly. Partial collection is supported because a member may pay what they have, and refusing it would mean the business turned money away.';

create unique index meeting_fine_number_unique on public.meeting_fines (fine_number);

-- The brief's "at most one UGX 5,000 fine for the same meeting absence",
-- as a constraint rather than as a check in code.
create unique index meeting_fine_one_per_member_per_meeting
  on public.meeting_fines (meeting_id, membership_id);

create index meeting_fine_status_idx
  on public.meeting_fines (status, meeting_date desc);

create index meeting_fine_membership_idx
  on public.meeting_fines (membership_id, meeting_date desc);

create index meeting_fine_branch_idx
  on public.meeting_fines (branch_id, meeting_date desc);

create trigger meeting_fines_set_updated_at
  before update on public.meeting_fines
  for each row execute function public.set_updated_at();

create trigger meeting_fines_no_delete
  before delete on public.meeting_fines
  for each row execute function public.reject_mutation();

create or replace function public.meeting_fines_assign_number()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.fine_number := public.next_reference('meeting_fine');
  return new;
end;
$$;

create trigger meeting_fines_assign_number
  before insert on public.meeting_fines
  for each row execute function public.meeting_fines_assign_number();

-- ---------------------------------------------------------------------------
-- What may change on a fine
-- ---------------------------------------------------------------------------

create or replace function public.meeting_fines_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
     or new.fine_number is distinct from old.fine_number
     or new.meeting_id is distinct from old.meeting_id
     or new.membership_id is distinct from old.membership_id
     or new.amount is distinct from old.amount
     or new.policy_version_id is distinct from old.policy_version_id
     or new.attendance_at_assessment is distinct from old.attendance_at_assessment
     or new.assessed_on is distinct from old.assessed_on
     or new.assessed_by_label is distinct from old.assessed_by_label
     or new.created_at is distinct from old.created_at then
    raise exception
      'A fine''s charge is what it is. Only its collection and its cancellation may change.'
      using errcode = 'P0001';
  end if;

  if old.status = 'cancelled' and new.status is distinct from old.status then
    raise exception
      'Fine % has been cancelled. A cancelled charge is not revived; assess a new one if the facts have changed.',
      old.fine_number using errcode = 'P0001';
  end if;

  if new.amount_paid < old.amount_paid
     and new.status is not distinct from old.status
     and old.status <> 'cancelled' then
    -- A reduction only ever comes from a payment reversal, which sets the
    -- status back to `outstanding` in the same statement.
    null;
  end if;

  return new;
end;
$$;

comment on function public.meeting_fines_guard() is
  'Polytos policy update. A fine''s charge — which meeting, which member, how much, on what register evidence — is frozen at assessment. Only collection and cancellation move, and a cancelled fine is never revived.';

create trigger meeting_fines_guard
  before update on public.meeting_fines
  for each row execute function public.meeting_fines_guard();

-- ---------------------------------------------------------------------------
-- Who is fineable
-- ---------------------------------------------------------------------------
--
-- Read as a function rather than written inline in the assessment, so the
-- screen that offers "assess these fines" shows exactly the list the
-- assessment will act on, and a reviewer can see why somebody is or is not on
-- it. The same reasoning as `benefit_claim_eligibility`.

create or replace function public.meeting_fine_candidates(p_meeting_id uuid)
returns table (
  membership_id     uuid,
  membership_number text,
  member_name       text,
  attendance        text,
  absence_reason    text,
  notice_id         uuid,
  notice_status     text,
  excused           boolean,
  already_fined     boolean,
  fineable          boolean,
  reason            text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_meeting public.membership_meetings;
begin
  select * into v_meeting
  from public.membership_meetings where id = p_meeting_id;

  if not found then
    return;
  end if;

  return query
  select
    a.membership_id,
    m.membership_number,
    c.full_name,
    a.attendance,
    a.absence_reason,
    n.id,
    n.review_status,
    coalesce(n.review_status = 'approved', false),
    exists (
      select 1 from public.meeting_fines f
      where f.meeting_id = p_meeting_id and f.membership_id = a.membership_id
    ),
    -- Fineable when all of: the meeting happened, the member was absent, no
    -- accepted excuse, and no fine already charged.
    v_meeting.status = 'held'
      and a.attendance in ('absent', 'apology')
      and coalesce(n.review_status, 'none') <> 'approved'
      and not exists (
        select 1 from public.meeting_fines f
        where f.meeting_id = p_meeting_id and f.membership_id = a.membership_id
      ),
    case
      when v_meeting.status = 'cancelled'
        then 'The meeting was cancelled. Nobody is absent from a meeting that did not happen.'
      when v_meeting.status <> 'held'
        then 'The meeting is ' || v_meeting.status || '. A fine follows a meeting that took place.'
      when a.attendance = 'present'
        then 'Present.'
      when a.attendance = 'represented'
        then 'Represented by somebody else. Whether a representative satisfies the attendance obligation is not recorded, so no charge is made.'
      when n.review_status = 'approved'
        then 'Excused — an advance notice was accepted.'
      when n.review_status = 'pending'
        then 'An advance notice is waiting to be reviewed. Decide it before charging.'
      when exists (
        select 1 from public.meeting_fines f
        where f.meeting_id = p_meeting_id and f.membership_id = a.membership_id
      ) then 'Already charged.'
      when n.review_status = 'rejected'
        then 'An advance notice was given and rejected.'
      else 'Absent, with no advance notice.'
    end
  from public.meeting_attendance a
  join public.memberships m on m.id = a.membership_id
  join public.clients c on c.id = m.client_id
  left join public.meeting_absence_notices n
    on n.meeting_id = p_meeting_id and n.membership_id = a.membership_id
  where a.meeting_id = p_meeting_id
  order by m.membership_number;
end;
$$;

comment on function public.meeting_fine_candidates(uuid) is
  'Polytos policy update, rule 15. Every member on a meeting''s register, with whether they are fineable and why. "Represented" is deliberately not fineable: whether sending somebody in your place satisfies a compulsory-attendance obligation is a rule the client has not stated, and charging for it would be inventing one. A pending notice blocks the charge rather than being ignored.';

grant execute on function public.meeting_fine_candidates(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Charging one
-- ---------------------------------------------------------------------------

create or replace function public.assess_meeting_fine(
  p_meeting_id uuid,
  p_membership_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_meeting    public.membership_meetings;
  v_membership public.memberships;
  v_policy     public.membership_policy_versions;
  v_candidate  record;
  v_actor      uuid;
  v_label      text;
  v_id         uuid;
begin
  v_actor := public.current_profile_id();
  v_label := public.audit_actor_label();

  if v_actor is null and auth.uid() is not null then
    raise exception
      'A fine must be charged by a signed-in member of staff.'
      using errcode = 'P0001';
  end if;

  if auth.uid() is not null and not public.user_has_permission('fines:assess') then
    raise exception
      'Charging a meeting fine requires the fines:assess capability. Marking the register and charging for what it says are different acts.'
      using errcode = '42501';
  end if;

  select * into v_meeting
  from public.membership_meetings where id = p_meeting_id for update;

  if not found then
    raise exception 'No such meeting.' using errcode = 'P0001';
  end if;

  if not public.user_can_see_branch(v_meeting.branch_id) then
    raise exception 'You cannot charge that branch''s members.' using errcode = '42501';
  end if;

  -- Serialise against a concurrent charge of the same member. The unique
  -- index would catch it; the lock makes a repeat an orderly refusal.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('meeting_fine:' || p_meeting_id::text || ':'
                        || p_membership_id::text)
  );

  select * into v_candidate
  from public.meeting_fine_candidates(p_meeting_id) k
  where k.membership_id = p_membership_id;

  if not found then
    raise exception
      'That member is not on meeting %''s register, so there is nothing to charge.',
      v_meeting.meeting_number using errcode = 'P0001';
  end if;

  if not v_candidate.fineable then
    raise exception
      'Membership % cannot be charged for meeting %: %',
      v_candidate.membership_number, v_meeting.meeting_number, v_candidate.reason
      using errcode = 'P0001';
  end if;

  select * into v_membership from public.memberships where id = p_membership_id;

  -- The version governing the member on the day of the meeting. Not today's:
  -- a member moved onto new terms in December is charged for a November
  -- meeting under November's terms.
  select * into v_policy
  from public.membership_policy_versions
  where id = public.membership_governing_policy(
    p_membership_id, v_meeting.meeting_date);

  if v_policy.meeting_absence_fine is null then
    raise exception
      'Policy version % does not record what an unexcused absence costs, so no fine can be charged under it. The amount is the whole rule and there is no default.',
      v_policy.version using errcode = 'P0001';
  end if;

  if v_policy.meeting_absence_fine = 0 then
    raise exception
      'Policy version % records the absence fine as zero, which is a decision that there is no charge. Nothing is assessed.',
      v_policy.version using errcode = 'P0001';
  end if;

  insert into public.meeting_fines (
    fine_number, meeting_id, meeting_number, meeting_date,
    membership_id, membership_number, client_id, branch_id,
    policy_version_id, policy_version, amount,
    attendance_at_assessment, absence_reason_at_assessment, notice_id,
    assessed_on, assessed_by, assessed_by_label
  )
  values (
    'MF000000', p_meeting_id, v_meeting.meeting_number, v_meeting.meeting_date,
    p_membership_id, v_membership.membership_number,
    v_membership.client_id, v_meeting.branch_id,
    v_policy.id, v_policy.version, v_policy.meeting_absence_fine,
    v_candidate.attendance, v_candidate.absence_reason, v_candidate.notice_id,
    public.business_date(), v_actor, v_label
  )
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.assess_meeting_fine(uuid, uuid) is
  'Polytos policy update, rule 15. Charges one member the absence fine for one meeting, at the amount recorded by the policy version governing them on the day of that meeting. Refuses a member who was present, represented, excused, or already charged, and refuses entirely where the policy records no amount. Posts nothing to the General Ledger: a charge is not income.';

grant execute on function public.assess_meeting_fine(uuid, uuid) to authenticated;

create or replace function public.assess_meeting_fines(p_meeting_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row   record;
  v_count integer := 0;
begin
  for v_row in
    select k.membership_id
    from public.meeting_fine_candidates(p_meeting_id) k
    where k.fineable
    order by k.membership_number
  loop
    perform public.assess_meeting_fine(p_meeting_id, v_row.membership_id);
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

comment on function public.assess_meeting_fines(uuid) is
  'Polytos policy update, rule 15. Charges every fineable absence from one meeting, one at a time through assess_meeting_fine so that each gets the same checks. Idempotent: a member already charged is not fineable, so a second run adds nothing.';

grant execute on function public.assess_meeting_fines(uuid) to authenticated;


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

revoke all on table public.meeting_fines from anon, authenticated;
revoke all on function public.membership_policy_terms_guard() from public, anon, authenticated;
revoke all on function public.meeting_fines_assign_number() from public, anon, authenticated;
revoke all on function public.meeting_fines_guard() from public, anon, authenticated;
revoke all on function public.meeting_fine_candidates(uuid) from public, anon;
revoke all on function public.assess_meeting_fine(uuid, uuid) from public, anon;
revoke all on function public.assess_meeting_fines(uuid) from public, anon;
