-- ===========================================================================
-- Polytos Phase 3.10 — the audit trail, and what it must not carry
--
-- ## What is recorded
--
-- Two events, both consequences of an approval rather than acts somebody
-- performs:
--
--   `member_loan.assessed`  the business froze an eligibility assessment onto
--                           a loan: which membership, which policy version,
--                           the months served, the ceiling and the amount
--   `member_loan.pledged`   savings capacity was committed to a loan, or
--                           returned to the member when it closed
--
-- Both are statement-level, following the Phase 4 snapshot pattern: approval
-- writes one snapshot and one pledge in one statement each, and a row-level
-- trigger would record one event per row for what is one act.
--
-- ## What the trail deliberately does not carry
--
-- No member name, no phone number, no National Identification Number. The
-- Phase 1 rule, restated because Phase 3 is the first phase whose audit rows
-- are about money a named person owes: `audit:view` is broader than
-- `loans:view_sensitive`, so an audit row carrying identity would hand it to
-- everyone who can read the trail.
--
-- It also does not carry the savings **balance**. The membership number, the
-- policy version, the ceiling and the amount are the decision; the balance is
-- the member's financial position, it is already in the snapshot behind
-- `loans:view`, and a trail that accumulated it would become a second savings
-- register with a wider audience.
-- ===========================================================================

create or replace function public.audit_member_loan_assessed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
begin
  select i.loan_id, i.membership_number, i.policy_version,
         i.qualifying_months, i.months_required,
         i.max_eligible_loan, i.amount_requested, i.term_requested,
         i.repayment_frequency, i.interest_basis, i.interest_method,
         i.interest_rate_bps
    into r
  from inserted i
  limit 1;

  if r.loan_id is null then
    return null;
  end if;

  insert into public.audit_log (
    actor_profile_id, actor_auth_user_id, actor_label,
    action, entity_type, entity_id, new_values
  )
  values (
    public.current_profile_id(), auth.uid(), public.audit_actor_label(),
    'member_loan.assessed', 'loan', r.loan_id::text,
    pg_catalog.jsonb_build_object(
      'membership_number', r.membership_number,
      'policy_version', r.policy_version,
      'qualifying_months', r.qualifying_months,
      'months_required', r.months_required,
      'max_eligible_loan', r.max_eligible_loan,
      'amount_requested', r.amount_requested,
      'term_requested', r.term_requested,
      'repayment_frequency', r.repayment_frequency,
      'interest_basis', r.interest_basis,
      'interest_method', r.interest_method,
      'interest_rate_bps', r.interest_rate_bps
    )
  );

  return null;
end;
$$;

comment on function public.audit_member_loan_assessed() is
  'Polytos Phase 3. Records that an eligibility assessment was frozen onto a loan: the membership number, the policy version, the months served, the ceiling and the terms. No name, no phone, no balance.';

revoke all on function public.audit_member_loan_assessed()
  from public, anon, authenticated;

create trigger audit_member_loan_assessed
  after insert on public.member_loan_eligibility_snapshots
  referencing new table as inserted
  for each statement execute function public.audit_member_loan_assessed();

-- ---------------------------------------------------------------------------
-- The pledge, taken and released
--
-- One function for both, because they are the same fact in two directions and
-- a reader of the trail wants them adjacent. It fires on INSERT and on the one
-- permitted UPDATE — the release — and decides which happened from the
-- transition tables, because a statement trigger cannot carry a WHEN clause
-- and an event logged for the wrong one would be a lie about what happened.
-- ---------------------------------------------------------------------------

create or replace function public.audit_member_loan_pledge()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
begin
  if tg_op = 'INSERT' then
    select i.loan_id, i.pledged_amount, i.multiplier_bps, i.loan_principal
      into r
    from inserted i
    limit 1;

    if r.loan_id is null then
      return null;
    end if;

    insert into public.audit_log (
      actor_profile_id, actor_auth_user_id, actor_label,
      action, entity_type, entity_id, new_values
    )
    values (
      public.current_profile_id(), auth.uid(), public.audit_actor_label(),
      'member_loan.pledged', 'loan', r.loan_id::text,
      pg_catalog.jsonb_build_object(
        'pledged_amount', r.pledged_amount,
        'loan_principal', r.loan_principal,
        'multiplier_bps', r.multiplier_bps
      )
    );

    return null;
  end if;

  -- The release. Only rows that actually moved from unreleased to released,
  -- so an ordinary no-op UPDATE records nothing.
  select i.loan_id, i.pledged_amount, i.released_reason
    into r
  from inserted i
  join before b on b.loan_id = i.loan_id
  where i.released_at is not null and b.released_at is null
  limit 1;

  if r.loan_id is null then
    return null;
  end if;

  insert into public.audit_log (
    actor_profile_id, actor_auth_user_id, actor_label,
    action, entity_type, entity_id, new_values
  )
  values (
    public.current_profile_id(), auth.uid(), public.audit_actor_label(),
    'member_loan.pledge_released', 'loan', r.loan_id::text,
    pg_catalog.jsonb_build_object(
      'released_amount', r.pledged_amount,
      'reason', r.released_reason
    )
  );

  return null;
end;
$$;

comment on function public.audit_member_loan_pledge() is
  'Polytos Phase 3. Records savings capacity committed to a member loan and returned when it closed. Decides which happened from the transition tables rather than from a WHEN clause a statement trigger cannot carry.';

revoke all on function public.audit_member_loan_pledge()
  from public, anon, authenticated;

create trigger audit_member_loan_pledged
  after insert on public.member_loan_savings_pledges
  referencing new table as inserted
  for each statement execute function public.audit_member_loan_pledge();

create trigger audit_member_loan_pledge_released
  after update on public.member_loan_savings_pledges
  referencing old table as before new table as inserted
  for each statement execute function public.audit_member_loan_pledge();

-- ---------------------------------------------------------------------------
-- No change to the trail's own constraints
--
-- `audit_log.action` is constrained by **format** —
-- `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$` — rather than by an enumeration of
-- the actions the system records. So `member_loan.assessed`,
-- `member_loan.pledged` and `member_loan.pledge_released` need nothing added:
-- they are already permitted by shape, and there is no list to widen.
--
-- Worth stating rather than leaving as an absence. A reader comparing this
-- migration with the Phase 11 one that *did* widen
-- `journal_entries_source_valid` would otherwise wonder what was forgotten.
-- ---------------------------------------------------------------------------
