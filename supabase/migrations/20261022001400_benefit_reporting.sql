-- ===========================================================================
-- Polytos Phase 4.14 — the registers, the portal's read, and the dashboard
--
-- ## Why views and not queries in the data layer
--
-- Each register below joins a claim to its member, its membership and its
-- policy. Written in TypeScript that is four joins repeated in every caller
-- that needs them, and the one that drifts is the one nobody tested. Written
-- as a view it is one definition, and — more importantly — it is one place
-- where `security_invoker = true` applies the underlying policies.
--
-- **Every view here is `security_invoker`.** That is ADR-057's rule and it is
-- not a formality: a definer view over `benefit_claims` would hand every
-- claim to anybody who could select from the view, which is exactly the hole
-- the policies in 20261022001200 exist to close. A member selecting from
-- `benefit_claim_register` gets their own rows and nobody else's, because the
-- policy beneath it says so.
--
-- ## The dashboard is one function, not twelve queries
--
-- Every figure on the Benefits dashboard comes from one call. The alternative
-- — a query per tile — is how a register read came to invoke
-- `user_has_permission` 20,524 times in Phase 18, and the Supabase free tier
-- is the constraint this system is actually under.
--
-- It is SECURITY DEFINER with an explicit capability check, for the reason
-- `savings_summary` and `member_loan_summary` both are: these are
-- business-wide aggregates, so there is no *row* for a policy to filter. A
-- total across every claim has nothing to filter, so the function names the
-- capability instead.
--
-- ## The portal's read is a view, not a habit
--
-- `benefit_claims` carries `assessment_note` — an officer's working reasoning
-- about documents — and RLS cannot withhold a column. A member's policy grants
-- them their own row, note included.
--
-- The honest fix is that the portal never selects it, and
-- `benefit_claim_portal_view` is what makes that structural: the column is not
-- in the view, so a portal screen cannot render it by accident and a future
-- `select *` cannot reintroduce it. The *refusal reason* is in the view,
-- because a member is entitled to be told why their claim was refused; the
-- assessor's reasoning about whether an invoice looked genuine is not the same
-- thing.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- benefit_claim_register
--
-- The staff register. Carries the member's name, which is behind
-- `clients:view` on `clients` and reaches this view through the invoker's own
-- policies — so a caller who cannot read the client cannot read the name here
-- either, because the join returns nothing.
-- ---------------------------------------------------------------------------

create view public.benefit_claim_register with (security_invoker = true) as
select
  c.id,
  c.claim_number,
  c.claim_type,
  c.status,
  c.event_date,
  c.membership_id,
  m.membership_number,
  m.status as membership_status,
  c.client_id,
  cl.client_number,
  cl.full_name as member_name,
  c.branch_id,
  b.name as branch_name,
  c.policy_version,
  c.claimed_amount,
  c.assessed_amount,
  c.approved_amount,
  -- The medical facts a register shows: the provider and the length of stay.
  -- The bill is here too, because it is the basis of the figure beside it and
  -- a register that showed the benefit without the bill would be unauditable.
  c.provider_name,
  c.bill_amount,
  c.admission_nights,
  c.admission_inclusive_days,
  c.admission_elapsed_days,
  c.deceased_name,
  c.deceased_relationship,
  r.label as deceased_relationship_label,
  c.beneficiary_id,
  -- Whether there is a payee and whether anybody has checked them. The
  -- beneficiary's *name* is deliberately absent: it is in
  -- `member_beneficiary_identities`, behind `membership:view_sensitive`, and a
  -- register column would be a hole straight through that split.
  ben.beneficiary_number,
  ben.verification_status as beneficiary_verification_status,
  c.submitted_at,
  c.submitted_by_label,
  c.assessed_at,
  c.assessed_by_label,
  c.decided_at,
  c.decided_by_label,
  c.rejected_reason,
  c.cancelled_reason,
  c.information_required_note,
  c.payment_id,
  p.payment_number,
  p.value_date as paid_on,
  p.reversed_at as payment_reversed_at,
  -- How much checked evidence the claim has, and how much it still needs. Two
  -- counts rather than a boolean, because "2 of 3 documents checked" is what a
  -- register reader wants and `has_evidence` is not.
  (
    select pg_catalog.count(*)::integer
    from public.benefit_claim_documents d
    where d.claim_id = c.id
  ) as document_count,
  (
    select pg_catalog.count(*)::integer
    from public.benefit_claim_documents d
    where d.claim_id = c.id and d.verification_status = 'verified'
  ) as verified_document_count,
  (
    select pg_catalog.count(*)::integer
    from public.benefit_document_kinds k
    where k.is_required_for_assessment and k.claim_type = c.claim_type
  ) as required_document_count,
  c.created_at,
  c.updated_at
from public.benefit_claims c
join public.memberships m on m.id = c.membership_id
join public.clients cl on cl.id = c.client_id
join public.branches b on b.id = c.branch_id
left join public.beneficiary_relationships r on r.key = c.deceased_relationship
left join public.member_beneficiaries ben on ben.id = c.beneficiary_id
left join public.benefit_payments p on p.id = c.payment_id;

comment on view public.benefit_claim_register is
  'Polytos Phase 4. The benefit claim register: the claim, its member, its evidence counts and its payment. security_invoker, so the policies beneath decide which claims a caller sees and a member sees their own. Carries no beneficiary name — that is behind membership:view_sensitive in member_beneficiary_identities.';

revoke all on public.benefit_claim_register from anon, authenticated;
grant select on public.benefit_claim_register to authenticated;

-- ---------------------------------------------------------------------------
-- benefit_claim_portal_view
--
-- What a member may be shown about their own claim. The column list is the
-- disclosure policy: `assessment_note` is absent, and so is every figure about
-- their loan or savings position, because a benefit screen is not where a
-- member learns what the business thinks of their creditworthiness.
-- ---------------------------------------------------------------------------

create view public.benefit_claim_portal_view with (security_invoker = true) as
select
  c.id,
  c.claim_number,
  c.claim_type,
  c.status,
  c.event_date,
  c.client_id,
  c.claimed_amount,
  -- The assessed and approved figures are the member's own entitlement, and
  -- withholding them would make the portal a screen that says "we have decided
  -- something about your money".
  c.assessed_amount,
  c.approved_amount,
  c.provider_name,
  c.bill_amount,
  c.deceased_name,
  -- The two things a member is entitled to be told: what is missing, and why
  -- it was refused. Not the assessor's reasoning about whether the documents
  -- looked genuine.
  c.information_required_note,
  c.rejected_reason,
  c.submitted_at,
  c.decided_at,
  p.payment_number,
  p.value_date as paid_on,
  p.amount as paid_amount,
  p.payment_method
from public.benefit_claims c
left join public.benefit_payments p on p.id = c.payment_id;

comment on view public.benefit_claim_portal_view is
  'Polytos Phase 4. A member''s own view of their claim. The column list is the disclosure policy: assessment_note is absent, so a portal screen cannot render it by accident and a future select * cannot reintroduce it. The refusal reason is present, because a member is entitled to be told why.';

revoke all on public.benefit_claim_portal_view from anon, authenticated;
grant select on public.benefit_claim_portal_view to authenticated;

-- ---------------------------------------------------------------------------
-- member_beneficiary_register
--
-- Who has a next of kin on file, and whether anybody has checked. The
-- register's whole job is to make the unverified ones findable, because an
-- unverified beneficiary means a bereavement benefit that cannot be paid.
--
-- No name and no telephone number. A screen that needs those joins
-- `member_beneficiary_identities` itself and gets them only if the caller
-- holds `membership:view_sensitive`.
-- ---------------------------------------------------------------------------

create view public.member_beneficiary_register with (security_invoker = true) as
select
  ben.id,
  ben.beneficiary_number,
  ben.membership_id,
  m.membership_number,
  m.status as membership_status,
  ben.client_id,
  cl.client_number,
  cl.full_name as member_name,
  ben.branch_id,
  ben.relationship,
  r.label as relationship_label,
  ben.is_primary,
  ben.status,
  ben.verification_status,
  ben.verification_evidence_kind,
  ben.verified_at,
  ben.verified_by_label,
  ben.rejected_reason,
  ben.recorded_on,
  ben.recorded_by_label,
  ben.ended_on,
  ben.ended_reason,
  prior.beneficiary_number as supersedes_number,
  (
    select pg_catalog.count(*)::integer
    from public.benefit_claim_documents d
    where d.beneficiary_id = ben.id
  ) as document_count,
  ben.created_at
from public.member_beneficiaries ben
join public.memberships m on m.id = ben.membership_id
join public.clients cl on cl.id = ben.client_id
left join public.beneficiary_relationships r on r.key = ben.relationship
left join public.member_beneficiaries prior on prior.id = ben.supersedes_id;

comment on view public.member_beneficiary_register is
  'Polytos Phase 4. Who has a beneficiary on file and whether it has been checked, with no name or telephone number — those are in member_beneficiary_identities behind membership:view_sensitive. The register''s job is to make the unverified ones findable, because an unverified beneficiary is a bereavement benefit that cannot be paid.';

revoke all on public.member_beneficiary_register from anon, authenticated;
grant select on public.member_beneficiary_register to authenticated;

-- ---------------------------------------------------------------------------
-- benefit_payment_register
-- ---------------------------------------------------------------------------

create view public.benefit_payment_register with (security_invoker = true) as
select
  p.id,
  p.payment_number,
  p.claim_id,
  p.claim_number,
  p.claim_type,
  p.membership_id,
  m.membership_number,
  p.client_id,
  cl.full_name as member_name,
  p.branch_id,
  b.name as branch_name,
  p.amount,
  p.recipient_kind,
  p.recipient_name,
  p.recipient_beneficiary_number,
  p.payment_method,
  p.external_reference,
  ea.code as expense_account_code,
  ea.name as expense_account_name,
  ca.code as cash_account_code,
  ca.name as cash_account_name,
  p.value_date,
  p.journal_entry_id,
  p.paid_at,
  p.paid_by_label,
  p.reversed_at,
  p.reversed_by_label,
  p.reversal_reason,
  p.reversal_journal_entry_id,
  -- One column rather than a reader working it out from a NULL. A reversed
  -- payment is still a row in the register, and a register that showed it
  -- identically to a live one would be a register of money the business did
  -- not spend.
  (p.reversed_at is null) as is_live
from public.benefit_payments p
join public.memberships m on m.id = p.membership_id
join public.clients cl on cl.id = p.client_id
join public.branches b on b.id = p.branch_id
join public.ledger_accounts ea on ea.id = p.expense_account_id
join public.ledger_accounts ca on ca.id = p.cash_account_id;

comment on view public.benefit_payment_register is
  'Polytos Phase 4. Benefit payments with their recipient, accounts and journal entries. security_invoker, so a payment to a beneficiary reaches only callers holding membership:view_sensitive — the recipient name is in the row.';

revoke all on public.benefit_payment_register from anon, authenticated;
grant select on public.benefit_payment_register to authenticated;

-- ---------------------------------------------------------------------------
-- membership_meeting_register and meeting_attendance_register
-- ---------------------------------------------------------------------------

create view public.membership_meeting_register with (security_invoker = true) as
select
  mm.id,
  mm.meeting_number,
  mm.branch_id,
  b.name as branch_name,
  mm.meeting_type,
  mm.title,
  mm.venue,
  mm.scheduled_at,
  mm.meeting_date,
  mm.status,
  mm.agenda,
  mm.minutes,
  mm.minutes_finalised_at,
  mm.minutes_finalised_by_label,
  mm.minutes_amended_at,
  mm.minutes_amendment_note,
  mm.rescheduled_from,
  mm.reschedule_reason,
  mm.cancelled_at,
  mm.cancellation_reason,
  -- The register's four counts. Computed here rather than in the caller
  -- because "who came" is the question the list is opened with.
  (
    select pg_catalog.count(*)::integer from public.meeting_attendance a
    where a.meeting_id = mm.id
  ) as attendance_recorded,
  (
    select pg_catalog.count(*)::integer from public.meeting_attendance a
    where a.meeting_id = mm.id and a.attendance = 'present'
  ) as present_count,
  (
    select pg_catalog.count(*)::integer from public.meeting_attendance a
    where a.meeting_id = mm.id and a.attendance in ('absent', 'apology')
  ) as absent_count,
  -- How many members the branch had, so "25 of 31" is answerable. Live
  -- memberships at read time rather than at meeting time: a membership that
  -- has since been withdrawn was still expected on the day, and recording the
  -- expected roll as of the meeting would need a snapshot table nobody asked
  -- for. The register says `expected_members` rather than implying otherwise.
  (
    select pg_catalog.count(*)::integer from public.memberships m
    where m.branch_id = mm.branch_id and m.status in ('active', 'suspended')
  ) as expected_members,
  (
    select pg_catalog.count(*)::integer from public.meeting_action_items ai
    where ai.meeting_id = mm.id
  ) as action_count,
  (
    select pg_catalog.count(*)::integer from public.meeting_action_items ai
    where ai.meeting_id = mm.id and ai.status in ('open', 'in_progress')
  ) as open_action_count,
  mm.created_at,
  mm.created_by_label
from public.membership_meetings mm
join public.branches b on b.id = mm.branch_id;

comment on view public.membership_meeting_register is
  'Polytos Phase 4. Meetings with their attendance and action counts. expected_members is the branch''s live memberships at read time, not at meeting time — recording the expected roll as of the day would need a snapshot table nobody asked for, and the column is named so as not to imply one.';

revoke all on public.membership_meeting_register from anon, authenticated;
grant select on public.membership_meeting_register to authenticated;

create view public.meeting_attendance_register with (security_invoker = true) as
select
  a.id,
  a.meeting_id,
  mm.meeting_number,
  mm.title as meeting_title,
  mm.meeting_date,
  mm.branch_id,
  a.membership_id,
  m.membership_number,
  a.client_id,
  cl.client_number,
  cl.full_name as member_name,
  cl.phone as member_phone,
  a.attendance,
  a.absence_reason,
  a.note,
  a.marked_at,
  a.marked_by_label,
  a.corrected_at,
  a.correction_count
from public.meeting_attendance a
join public.membership_meetings mm on mm.id = a.meeting_id
join public.memberships m on m.id = a.membership_id
join public.clients cl on cl.id = a.client_id;

comment on view public.meeting_attendance_register is
  'Polytos Phase 4. A meeting''s attendance register, exportable. security_invoker, so a member reaches only their own row and the register itself needs meetings:view.';

revoke all on public.meeting_attendance_register from anon, authenticated;
grant select on public.meeting_attendance_register to authenticated;

-- ---------------------------------------------------------------------------
-- benefit_summary()
--
-- The dashboard, in one round trip.
-- ---------------------------------------------------------------------------

create or replace function public.benefit_summary(
  p_from date default null,
  p_to date default null
)
returns table (
  -- The pipeline.
  claims_draft integer,
  claims_submitted integer,
  claims_under_verification integer,
  claims_information_required integer,
  claims_assessed integer,
  claims_approved integer,
  claims_rejected integer,
  claims_paid integer,
  claims_total integer,

  -- The money, over the period. Live payments only — a reversed payment is
  -- money the business did not spend, and a dashboard that counted it would
  -- disagree with the trial balance.
  paid_total bigint,
  paid_medical bigint,
  paid_condolence bigint,
  paid_bereavement bigint,
  payments_reversed integer,
  reversed_total bigint,

  -- What the business has committed and not yet paid. The figure that matters
  -- most and the one a cash-basis ledger cannot show, because there is no
  -- payable account (20261022000200).
  approved_awaiting_payment bigint,

  -- The beneficiary position. The reason it is on the benefits dashboard: a
  -- member with no verified next of kin is a bereavement benefit that cannot
  -- be paid, and nobody discovers that at a convenient moment.
  members_with_beneficiary integer,
  members_with_verified_beneficiary integer,
  beneficiaries_awaiting_verification integer,
  live_memberships integer,

  -- Meetings.
  meetings_upcoming integer,
  meetings_held_in_period integer,
  attendance_recorded_in_period integer,
  meeting_actions_open integer,

  -- Whether any of this can happen today, and why not.
  benefits_open boolean,
  blocked_reason text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_from date;
  v_to date;
  v_policy public.membership_policy_versions;
begin
  -- The gate. A business-wide aggregate has no row for a policy to filter, so
  -- the function names the capability — the same reasoning `savings_summary`
  -- and `member_loan_summary` both carry, including the `auth.uid()` test:
  -- the check is a statement about a *session*, and there is none for a
  -- migration, for `service_role` or for the test harness, none of which hold
  -- a capability to check. Without it a maintenance read of this figure could
  -- not run at all.
  if auth.uid() is not null
     and not public.user_has_permission('benefits:view') then
    raise exception 'permission denied for benefit summary'
      using errcode = '42501';
  end if;

  v_to := coalesce(p_to, public.business_date());
  -- A calendar year to date by default, which is what a dashboard opened with
  -- no filter should show. Not the policy year: that is per member and
  -- undecided, and a dashboard cannot have a different period per row.
  v_from := coalesce(
    p_from,
    pg_catalog.make_date(pg_catalog.date_part('year', v_to)::int, 1, 1));

  select * into v_policy
  from public.membership_policy_versions
  where status = 'active'
  order by effective_from desc
  limit 1;

  return query
  with claims as (
    select c.status, c.claim_type, c.approved_amount
    from public.benefit_claims c
  ),
  payments as (
    select p.claim_type, p.amount, p.reversed_at
    from public.benefit_payments p
    where p.value_date between v_from and v_to
  ),
  meetings as (
    select mm.id, mm.status, mm.meeting_date, mm.scheduled_at
    from public.membership_meetings mm
  )
  select
    (select pg_catalog.count(*)::integer from claims where status = 'draft'),
    (select pg_catalog.count(*)::integer from claims where status = 'submitted'),
    (select pg_catalog.count(*)::integer from claims
      where status = 'under_verification'),
    (select pg_catalog.count(*)::integer from claims
      where status = 'information_required'),
    (select pg_catalog.count(*)::integer from claims where status = 'assessed'),
    (select pg_catalog.count(*)::integer from claims where status = 'approved'),
    (select pg_catalog.count(*)::integer from claims where status = 'rejected'),
    (select pg_catalog.count(*)::integer from claims
      where status in ('paid', 'reversed')),
    (select pg_catalog.count(*)::integer from claims),

    (select coalesce(pg_catalog.sum(amount), 0)::bigint from payments
      where reversed_at is null),
    (select coalesce(pg_catalog.sum(amount), 0)::bigint from payments
      where reversed_at is null and claim_type = 'medical'),
    (select coalesce(pg_catalog.sum(amount), 0)::bigint from payments
      where reversed_at is null and claim_type = 'family_condolence'),
    (select coalesce(pg_catalog.sum(amount), 0)::bigint from payments
      where reversed_at is null and claim_type = 'member_bereavement'),
    (select pg_catalog.count(*)::integer from payments where reversed_at is not null),
    (select coalesce(pg_catalog.sum(amount), 0)::bigint from payments
      where reversed_at is not null),

    (select coalesce(pg_catalog.sum(approved_amount), 0)::bigint from claims
      where status = 'approved'),

    (select pg_catalog.count(distinct b.membership_id)::integer
      from public.member_beneficiaries b where b.status = 'active'),
    (select pg_catalog.count(distinct b.membership_id)::integer
      from public.member_beneficiaries b
      where b.status = 'active' and b.verification_status = 'verified'),
    (select pg_catalog.count(*)::integer
      from public.member_beneficiaries b
      where b.status = 'active'
        and b.verification_status = 'pending_verification'),
    (select pg_catalog.count(*)::integer from public.memberships m
      where m.status in ('active', 'suspended')),

    (select pg_catalog.count(*)::integer from meetings
      where status = 'scheduled' and scheduled_at >= pg_catalog.now()),
    (select pg_catalog.count(*)::integer from meetings
      where status = 'held' and meeting_date between v_from and v_to),
    (select pg_catalog.count(*)::integer
      from public.meeting_attendance a
      join meetings mm on mm.id = a.meeting_id
      where mm.meeting_date between v_from and v_to),
    (select pg_catalog.count(*)::integer from public.meeting_action_items ai
      where ai.status in ('open', 'in_progress')),

    coalesce(
      v_policy.id is not null
      and public.membership_policy_allows(v_policy.id, 'benefits'), false),
    case
      when v_policy.id is null then
        'No membership policy version is in force, so no benefit can be assessed or paid.'
      when public.membership_policy_allows(v_policy.id, 'benefits') then null
      else public.benefits_blocked_reason(v_policy.id)
    end;
end;
$$;

comment on function public.benefit_summary(date, date) is
  'Polytos Phase 4. Every figure on the Benefits dashboard in one round trip, gated on benefits:view because a business-wide aggregate has no row for a policy to filter. Money counts live payments only: a reversed payment is money the business did not spend, and counting it would disagree with the trial balance.';

revoke all on function public.benefit_summary(date, date) from public, anon;
grant execute on function public.benefit_summary(date, date) to authenticated;

-- ---------------------------------------------------------------------------
-- benefits_blocked_reason()
--
-- The sentence a screen shows when benefits are shut, naming the decisions
-- rather than saying "not available". The counterpart of
-- `member_lending_blocked_reason`, and written for the same reason: a banner
-- that does not say what is missing teaches the reader to scroll past it.
-- ---------------------------------------------------------------------------

create or replace function public.benefits_blocked_reason(p_version_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v public.membership_policy_versions;
  v_missing text[] := '{}';
begin
  select * into v
  from public.membership_policy_versions where id = p_version_id;

  if not found then
    return 'That policy version does not exist.';
  end if;

  if v.status <> 'active' then
    return pg_catalog.format(
      'Policy version %s is %s, so it authorises nothing.', v.version, v.status);
  end if;

  if v.approved_at is null then
    return pg_catalog.format(
      'Policy version %s has not been approved.', v.version);
  end if;

  if v.effective_from > public.business_date() then
    return pg_catalog.format(
      'Policy version %s takes effect on %s.', v.version, v.effective_from);
  end if;

  -- The `::text` casts matter. Without them PostgreSQL resolves
  -- `text[] || <untyped literal>` as array-to-array concatenation and tries
  -- to parse the sentence as an array literal, which fails at run time rather
  -- than at creation. `member_lending_blocked_reason` carries the same casts
  -- for the same reason.
  if v.medical_benefit_annual_cap is null then
    v_missing := v_missing
      || 'the most the medical benefit pays one member in a year'::text;
  end if;

  if v.medical_benefit_claims_per_year is null then
    v_missing := v_missing
      || 'how many medical claims a member may make in a year'::text;
  end if;

  if v.benefit_waiting_period_days is null then
    v_missing := v_missing
      || 'how long after enrolment a benefit may first be claimed'::text;
  end if;

  if pg_catalog.array_length(v_missing, 1) is null then
    return null;
  end if;

  return 'Benefit payments wait on '
    || pg_catalog.array_to_string(v_missing, '; ')
    || '. Until the client decides, no claim can be assessed, approved or paid.';
end;
$$;

comment on function public.benefits_blocked_reason(uuid) is
  'Polytos Phase 4. Why benefits are shut under a policy version, naming the undecided rules in the words a person would use. The counterpart of member_lending_blocked_reason: a banner that does not say what is missing teaches the reader to scroll past it.';

revoke all on function public.benefits_blocked_reason(uuid) from public, anon;
grant execute on function public.benefits_blocked_reason(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- benefit_expense_by_type()
--
-- The reporting figure: what the benefits scheme cost, by promise, from the
-- General Ledger rather than from the claim table.
--
-- Read from the **journal** deliberately. The claim table and the ledger
-- should agree, and a report that read the claim table could not tell anybody
-- when they did not. This one reconciles against the trial balance by
-- construction, because it is the same rows the trial balance sums.
-- ---------------------------------------------------------------------------

create or replace function public.benefit_expense_by_type(
  p_from date,
  p_to date
)
returns table (
  account_code text,
  account_name text,
  claim_type text,
  posted_debits bigint,
  posted_credits bigint,
  net_expense bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  -- `reports:view_financial`, not `benefits:view`: this is a figure from the
  -- General Ledger, and who may read the company's expense accounts is a
  -- financial-reporting question rather than a benefits one. Inside the
  -- `auth.uid()` test for the reason `savings_summary` states: a capability
  -- check is about a session, and the trusted path has none.
  if auth.uid() is not null
     and not public.user_has_permission('reports:view_financial') then
    raise exception 'permission denied for benefit expense report'
      using errcode = '42501';
  end if;

  return query
    select
      a.code,
      a.name,
      case a.code
        when '5210' then 'medical'
        when '5220' then 'family_condolence'
        when '5230' then 'member_bereavement'
      end,
      coalesce(pg_catalog.sum(l.debit), 0)::bigint,
      coalesce(pg_catalog.sum(l.credit), 0)::bigint,
      (coalesce(pg_catalog.sum(l.debit), 0)
        - coalesce(pg_catalog.sum(l.credit), 0))::bigint
    from public.ledger_accounts a
    left join public.journal_lines l on l.account_id = a.id
    left join public.journal_entries e on e.id = l.entry_id
      and e.entry_date between p_from and p_to
    where a.code in ('5210', '5220', '5230')
      and (l.id is null or e.id is not null)
    group by a.code, a.name
    order by a.code;
end;
$$;

comment on function public.benefit_expense_by_type(date, date) is
  'Polytos Phase 4. What the benefits scheme cost over a period, by promise, read from the General Ledger rather than from the claim table — so it reconciles against the trial balance by construction and a disagreement between the two becomes visible instead of invisible. Gated on reports:view_financial.';

revoke all on function public.benefit_expense_by_type(date, date) from public, anon;
grant execute on function public.benefit_expense_by_type(date, date) to authenticated;
