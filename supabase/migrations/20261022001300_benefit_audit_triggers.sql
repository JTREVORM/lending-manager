-- ===========================================================================
-- Polytos Phase 4.13 — the audit trail, and what it must not carry
--
-- ## What is recorded
--
-- Six events, each a decision somebody made:
--
--   `beneficiary.registered`  a payment instruction was recorded
--   `beneficiary.verified`    somebody attested to it, or refused it
--   `beneficiary.ended`       it was superseded or revoked
--   `benefit_claim.decided`   a claim moved: submitted, assessed, approved,
--                             refused, paid, reversed
--   `benefit_document.checked` a piece of evidence was accepted or refused
--   `meeting.attendance_corrected` a register entry was changed
--
-- ## What the trail deliberately does not carry
--
-- No beneficiary name, no telephone number, no identity reference, no
-- hospital, no diagnosis, no bill, no deceased's name, no document.
--
-- `audit:view` is broader than `membership:view_sensitive` and broader than
-- `benefits:view`: the Secretary/Treasurer holds the first and neither of the
-- others. An audit row carrying a beneficiary's name would therefore hand the
-- payment instruction to everybody who can read the trail — which is the exact
-- hole the two-table split in 20261022000400 exists to close, reopened from
-- behind. The Phase 1 rule, restated because Phase 4 is the first phase whose
-- records are medical.
--
-- So each row carries **references and decisions**: the claim number, the
-- beneficiary number, the membership number, the amount where the event is
-- about money, who acted, and the status it moved to. That is what an auditor
-- needs — "was this approved by somebody other than the assessor", "when was
-- this beneficiary verified and by whom" — and it is answerable without any of
-- the above.
--
-- The amount **is** carried on a claim decision, after some thought. It is the
-- figure an auditor is checking, it is already in the General Ledger behind
-- `ledger:view`, and a trail that recorded "a claim was approved" without
-- saying for how much would be useless for the one thing it exists for. A
-- member's *medical history* is confidential; the sum the business paid out is
-- its own accounting.
--
-- ## Row-level, not statement-level
--
-- The Phase 3 member-loan triggers are statement-level, because an approval
-- writes one snapshot and one pledge in one statement each and a row-level
-- trigger would record one event per row for what is one act. These are
-- row-level because each of these events genuinely is one row: one claim
-- moves, one beneficiary is verified, one register entry is corrected.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Beneficiaries
-- ---------------------------------------------------------------------------

create or replace function public.audit_beneficiary_registered()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_membership text;
begin
  select m.membership_number into v_membership
  from public.memberships m where m.id = new.membership_id;

  insert into public.audit_log (
    actor_profile_id, actor_auth_user_id, actor_label,
    action, entity_type, entity_id, new_values
  )
  values (
    public.current_profile_id(), auth.uid(), public.audit_actor_label(),
    'beneficiary.registered', 'member_beneficiary', new.id::text,
    -- The relationship is carried and the name is not. "A spouse was
    -- registered as next of kin for MB260001" is the decision; who she is, is
    -- the payment instruction.
    pg_catalog.jsonb_build_object(
      'beneficiary_number', new.beneficiary_number,
      'membership_number', v_membership,
      'relationship', new.relationship,
      'is_primary', new.is_primary,
      'verification_status', new.verification_status,
      'supersedes', (
        select b.beneficiary_number from public.member_beneficiaries b
        where b.id = new.supersedes_id
      )
    )
  );

  return null;
end;
$$;

comment on function public.audit_beneficiary_registered() is
  'Polytos Phase 4. Records that a beneficiary was registered: the record number, the membership, the relationship and whether it supersedes another. No name, no telephone number, no identity reference — audit:view is broader than membership:view_sensitive.';

revoke all on function public.audit_beneficiary_registered()
  from public, anon, authenticated;

create trigger audit_beneficiary_registered
  after insert on public.member_beneficiaries
  for each row execute function public.audit_beneficiary_registered();

create or replace function public.audit_beneficiary_decided()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.verification_status is distinct from old.verification_status then
    insert into public.audit_log (
      actor_profile_id, actor_auth_user_id, actor_label,
      action, entity_type, entity_id, old_values, new_values
    )
    values (
      public.current_profile_id(), auth.uid(), public.audit_actor_label(),
      'beneficiary.verified', 'member_beneficiary', new.id::text,
      pg_catalog.jsonb_build_object(
        'verification_status', old.verification_status),
      pg_catalog.jsonb_build_object(
        'beneficiary_number', new.beneficiary_number,
        'verification_status', new.verification_status,
        'evidence_kind', new.verification_evidence_kind,
        -- The separation of duties, as an audit fact: both names, so an
        -- auditor can see they differ without re-deriving it.
        'recorded_by', new.recorded_by_label,
        'verified_by', new.verified_by_label
      )
    );
  end if;

  if new.status is distinct from old.status then
    insert into public.audit_log (
      actor_profile_id, actor_auth_user_id, actor_label,
      action, entity_type, entity_id, old_values, new_values
    )
    values (
      public.current_profile_id(), auth.uid(), public.audit_actor_label(),
      'beneficiary.ended', 'member_beneficiary', new.id::text,
      pg_catalog.jsonb_build_object('status', old.status),
      pg_catalog.jsonb_build_object(
        'beneficiary_number', new.beneficiary_number,
        'status', new.status,
        'ended_on', new.ended_on,
        'reason', new.ended_reason
      )
    );
  end if;

  return null;
end;
$$;

comment on function public.audit_beneficiary_decided() is
  'Polytos Phase 4. Records a beneficiary''s verification and its ending, carrying both the recorder''s and the verifier''s names so the separation of duties is an audit fact rather than something to re-derive.';

revoke all on function public.audit_beneficiary_decided()
  from public, anon, authenticated;

create trigger audit_beneficiary_decided
  after update on public.member_beneficiaries
  for each row execute function public.audit_beneficiary_decided();

-- ---------------------------------------------------------------------------
-- Claims
-- ---------------------------------------------------------------------------

create or replace function public.audit_benefit_claim_decided()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_membership text;
begin
  if new.status = old.status then
    return null;
  end if;

  select m.membership_number into v_membership
  from public.memberships m where m.id = new.membership_id;

  insert into public.audit_log (
    actor_profile_id, actor_auth_user_id, actor_label,
    action, entity_type, entity_id, old_values, new_values
  )
  values (
    public.current_profile_id(), auth.uid(), public.audit_actor_label(),
    'benefit_claim.decided', 'benefit_claim', new.id::text,
    pg_catalog.jsonb_build_object('status', old.status),
    pg_catalog.jsonb_build_object(
      'claim_number', new.claim_number,
      'claim_type', new.claim_type,
      'membership_number', v_membership,
      'policy_version', new.policy_version,
      'status', new.status,
      -- The amounts: what the figure was at each stage. See the header on why
      -- money is carried where medical detail is not.
      'assessed_amount', new.assessed_amount,
      'approved_amount', new.approved_amount,
      -- The control, as an audit fact. An auditor reading one row can see that
      -- the approver was not the assessor.
      'assessed_by', new.assessed_by_label,
      'decided_by', new.decided_by_label,
      -- The reason a claim was refused is a business decision, and the member
      -- is entitled to be told it, so it belongs here. The *assessment* note
      -- does not: it is an officer's working reasoning about documents.
      'rejected_reason', new.rejected_reason,
      'cancelled_reason', new.cancelled_reason
    )
  );

  return null;
end;
$$;

comment on function public.audit_benefit_claim_decided() is
  'Polytos Phase 4. Records every benefit claim transition: the claim and membership numbers, the policy version, the amounts, and both the assessor''s and the decider''s names. No hospital, no bill, no deceased, no diagnosis and no assessment note.';

revoke all on function public.audit_benefit_claim_decided()
  from public, anon, authenticated;

create trigger audit_benefit_claim_decided
  after update of status on public.benefit_claims
  for each row execute function public.audit_benefit_claim_decided();

-- A claim being opened is recorded too, because "who started this" is a
-- question an auditor asks of a claim that should never have existed.
create or replace function public.audit_benefit_claim_opened()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_membership text;
begin
  select m.membership_number into v_membership
  from public.memberships m where m.id = new.membership_id;

  insert into public.audit_log (
    actor_profile_id, actor_auth_user_id, actor_label,
    action, entity_type, entity_id, new_values
  )
  values (
    public.current_profile_id(), auth.uid(), public.audit_actor_label(),
    'benefit_claim.opened', 'benefit_claim', new.id::text,
    pg_catalog.jsonb_build_object(
      'claim_number', new.claim_number,
      'claim_type', new.claim_type,
      'membership_number', v_membership,
      'policy_version', new.policy_version,
      'event_date', new.event_date,
      'claimed_amount', new.claimed_amount
    )
  );

  return null;
end;
$$;

revoke all on function public.audit_benefit_claim_opened()
  from public, anon, authenticated;

create trigger audit_benefit_claim_opened
  after insert on public.benefit_claims
  for each row execute function public.audit_benefit_claim_opened();

-- ---------------------------------------------------------------------------
-- Evidence
--
-- That somebody checked a document, and who. Not what the document was of, and
-- not the checker's note — a conclusion about whether an invoice is genuine is
-- an officer's working judgement, and `audit:view` is not the audience for it.
-- ---------------------------------------------------------------------------

create or replace function public.audit_benefit_document_checked()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.verification_status is not distinct from old.verification_status then
    return null;
  end if;

  insert into public.audit_log (
    actor_profile_id, actor_auth_user_id, actor_label,
    action, entity_type, entity_id, old_values, new_values
  )
  values (
    public.current_profile_id(), auth.uid(), public.audit_actor_label(),
    'benefit_document.checked', 'benefit_claim',
    coalesce(new.claim_id, new.beneficiary_id)::text,
    pg_catalog.jsonb_build_object('verification_status', old.verification_status),
    pg_catalog.jsonb_build_object(
      'document_kind', new.kind,
      'verification_status', new.verification_status,
      'uploaded_by', new.uploaded_by_label,
      'checked_by', new.verified_by_label,
      'claim_number', (
        select c.claim_number from public.benefit_claims c where c.id = new.claim_id
      ),
      'beneficiary_number', (
        select b.beneficiary_number from public.member_beneficiaries b
        where b.id = new.beneficiary_id
      )
    )
  );

  return null;
end;
$$;

comment on function public.audit_benefit_document_checked() is
  'Polytos Phase 4. Records that a piece of evidence was accepted or refused, by whom, and who had attached it. Not the document, not its contents, and not the checker''s note — audit:view is not the audience for an officer''s judgement about whether an invoice is genuine.';

revoke all on function public.audit_benefit_document_checked()
  from public, anon, authenticated;

create trigger audit_benefit_document_checked
  after update on public.benefit_claim_documents
  for each row execute function public.audit_benefit_document_checked();

-- ---------------------------------------------------------------------------
-- Payments
--
-- The payment and its reversal. The recipient's *kind* is carried and their
-- name is not, for the reason the whole beneficiary split exists; the amount
-- and the accounts are, because they are the accounting.
-- ---------------------------------------------------------------------------

create or replace function public.audit_benefit_payment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.audit_log (
      actor_profile_id, actor_auth_user_id, actor_label,
      action, entity_type, entity_id, new_values
    )
    values (
      public.current_profile_id(), auth.uid(), public.audit_actor_label(),
      'benefit_payment.posted', 'benefit_payment', new.id::text,
      pg_catalog.jsonb_build_object(
        'payment_number', new.payment_number,
        'claim_number', new.claim_number,
        'claim_type', new.claim_type,
        'amount', new.amount,
        'payment_method', new.payment_method,
        'recipient_kind', new.recipient_kind,
        'recipient_beneficiary_number', new.recipient_beneficiary_number,
        'expense_account', (
          select a.code from public.ledger_accounts a
          where a.id = new.expense_account_id
        ),
        'cash_account', (
          select a.code from public.ledger_accounts a
          where a.id = new.cash_account_id
        ),
        'journal_entry_id', new.journal_entry_id
      )
    );

    return null;
  end if;

  if new.reversed_at is not null and old.reversed_at is null then
    insert into public.audit_log (
      actor_profile_id, actor_auth_user_id, actor_label,
      action, entity_type, entity_id, new_values
    )
    values (
      public.current_profile_id(), auth.uid(), public.audit_actor_label(),
      'benefit_payment.reversed', 'benefit_payment', new.id::text,
      pg_catalog.jsonb_build_object(
        'payment_number', new.payment_number,
        'claim_number', new.claim_number,
        'amount', new.amount,
        'reason', new.reversal_reason,
        'reversed_by', new.reversed_by_label,
        'paid_by', new.paid_by_label,
        'reversal_journal_entry_id', new.reversal_journal_entry_id
      )
    );
  end if;

  return null;
end;
$$;

comment on function public.audit_benefit_payment() is
  'Polytos Phase 4. Records a benefit payment and its reversal: the amounts, the accounts, the journal entries, the recipient''s kind and the beneficiary record number — and never the recipient''s name.';

revoke all on function public.audit_benefit_payment()
  from public, anon, authenticated;

create trigger audit_benefit_payment
  after insert or update on public.benefit_payments
  for each row execute function public.audit_benefit_payment();

-- ---------------------------------------------------------------------------
-- Meetings
--
-- Scheduling, moving and cancelling a meeting, and correcting a register.
--
-- A correction is audited as well as recorded in
-- `meeting_attendance_corrections`, and the duplication is deliberate: the
-- corrections table is the register's own history, read beside the register;
-- the audit row is read by somebody asking what a named member of staff did
-- last Tuesday. Those are different questions with different readers, and a
-- single answer would serve one of them badly.
-- ---------------------------------------------------------------------------

create or replace function public.audit_meeting_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.audit_log (
      actor_profile_id, actor_auth_user_id, actor_label,
      action, entity_type, entity_id, new_values
    )
    values (
      public.current_profile_id(), auth.uid(), public.audit_actor_label(),
      'meeting.scheduled', 'membership_meeting', new.id::text,
      pg_catalog.jsonb_build_object(
        'meeting_number', new.meeting_number,
        'meeting_type', new.meeting_type,
        'title', new.title,
        'venue', new.venue,
        'scheduled_at', new.scheduled_at,
        'meeting_date', new.meeting_date
      )
    );

    return null;
  end if;

  if new.status is distinct from old.status
     or new.scheduled_at is distinct from old.scheduled_at then
    insert into public.audit_log (
      actor_profile_id, actor_auth_user_id, actor_label,
      action, entity_type, entity_id, old_values, new_values
    )
    values (
      public.current_profile_id(), auth.uid(), public.audit_actor_label(),
      case
        when new.status = 'cancelled' then 'meeting.cancelled'
        when new.scheduled_at is distinct from old.scheduled_at
          then 'meeting.rescheduled'
        else 'meeting.status_changed'
      end,
      'membership_meeting', new.id::text,
      pg_catalog.jsonb_build_object(
        'status', old.status, 'scheduled_at', old.scheduled_at),
      pg_catalog.jsonb_build_object(
        'meeting_number', new.meeting_number,
        'status', new.status,
        'scheduled_at', new.scheduled_at,
        'reason', coalesce(new.cancellation_reason, new.reschedule_reason)
      )
    );
  end if;

  if new.minutes_finalised_at is not null and old.minutes_finalised_at is null then
    insert into public.audit_log (
      actor_profile_id, actor_auth_user_id, actor_label,
      action, entity_type, entity_id, new_values
    )
    values (
      public.current_profile_id(), auth.uid(), public.audit_actor_label(),
      'meeting.minutes_finalised', 'membership_meeting', new.id::text,
      pg_catalog.jsonb_build_object(
        'meeting_number', new.meeting_number,
        'finalised_by', new.minutes_finalised_by_label
      )
    );
  end if;

  if new.minutes_amended_at is distinct from old.minutes_amended_at
     and new.minutes_amended_at is not null then
    insert into public.audit_log (
      actor_profile_id, actor_auth_user_id, actor_label,
      action, entity_type, entity_id, new_values
    )
    values (
      public.current_profile_id(), auth.uid(), public.audit_actor_label(),
      'meeting.minutes_amended', 'membership_meeting', new.id::text,
      pg_catalog.jsonb_build_object(
        'meeting_number', new.meeting_number,
        'note', new.minutes_amendment_note
      )
    );
  end if;

  return null;
end;
$$;

comment on function public.audit_meeting_event() is
  'Polytos Phase 4. Records scheduling, rescheduling, cancellation, and the finalising and amendment of minutes. The minutes themselves are not copied into the trail: they are already readable behind meetings:view, and audit:view is a wider audience.';

revoke all on function public.audit_meeting_event()
  from public, anon, authenticated;

create trigger audit_meeting_event
  after insert or update on public.membership_meetings
  for each row execute function public.audit_meeting_event();

create or replace function public.audit_attendance_corrected()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_meeting text;
  v_membership text;
begin
  select m.meeting_number into v_meeting
  from public.membership_meetings m where m.id = new.meeting_id;

  select m.membership_number into v_membership
  from public.memberships m where m.id = new.membership_id;

  insert into public.audit_log (
    actor_profile_id, actor_auth_user_id, actor_label,
    action, entity_type, entity_id, old_values, new_values
  )
  values (
    public.current_profile_id(), auth.uid(), public.audit_actor_label(),
    'meeting.attendance_corrected', 'membership_meeting', new.meeting_id::text,
    pg_catalog.jsonb_build_object(
      'attendance', new.previous_attendance,
      'absence_reason', new.previous_absence_reason,
      'marked_by', new.previous_marked_by_label
    ),
    pg_catalog.jsonb_build_object(
      'meeting_number', v_meeting,
      'membership_number', v_membership,
      'attendance', new.new_attendance,
      'absence_reason', new.new_absence_reason,
      'reason', new.reason,
      'corrected_by', new.corrected_by_label
    )
  );

  return null;
end;
$$;

comment on function public.audit_attendance_corrected() is
  'Polytos Phase 4. Records an attendance correction in the trail as well as in meeting_attendance_corrections. Deliberate duplication: the corrections table is the register''s own history, and the audit row answers "what did this member of staff do last Tuesday".';

revoke all on function public.audit_attendance_corrected()
  from public, anon, authenticated;

create trigger audit_attendance_corrected
  after insert on public.meeting_attendance_corrections
  for each row execute function public.audit_attendance_corrected();
