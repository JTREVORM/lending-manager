-- ===========================================================================
-- Polytos Phase 4.11 — the new categories on the existing stream
--
-- ## One mechanism, not two
--
-- `public.notifications` already exists: one row per event, addressed to the
-- capability that may read it, deduplicated on a key, append-only, raised by
-- triggers and read through `notification_feed`. Phase 4 adds **categories**
-- and **entity types** to it. It adds no table, no delivery channel and no
-- second bell.
--
-- Both CHECK constraints are replaced wholesale rather than extended, because
-- a CHECK cannot be added to — the same thing 20261020000200 did to the
-- journal source types, and every existing value is carried across unchanged.
--
-- ## What a benefit notification may say
--
-- This is the first phase whose events are *medical*, so the rule the
-- notification design already had becomes load-bearing: a notification names
-- the thing and links to it, and carries no confidential detail. So:
--
--   allowed    the claim number, the claim type, the amount on a payment,
--              the membership number, the meeting number and date
--   never      the hospital, the diagnosis, the bill, the deceased's name,
--              the beneficiary's name or telephone number, any document
--
-- `audience_permission` narrows who can read a row at all, but that is not
-- the argument for keeping detail out: a notification preview appears on a
-- phone's lock screen and in a browser tab title, outside every policy this
-- database has. §16 of the brief says sensitive medical details must not
-- appear in insecure previews, and the only reliable way to honour that is
-- for the row itself not to contain them.
--
-- A claim *type* is carried, after some thought. "Medical claim BC2600001 is
-- waiting for assessment" tells a reader which queue it belongs to and which
-- rules apply, and it is the same disclosure the register makes to the same
-- capability. "A member has been admitted to hospital" is a fact about their
-- health; "there is a medical claim to assess" is a fact about the business's
-- work. The line is drawn at the person.
--
-- ## Who each category is addressed to
--
-- The capability that does the next thing, so a notification is a queue
-- rather than an announcement. The exceptions are the two addressed to a
-- person: a claim decided goes to whoever submitted it, because they are the
-- one who has to tell the member; and a meeting action goes to its assignee.
-- That is the shape `loan_decided` already has, and the reason is the same.
--
-- No notification is addressed to a **member**. A member has no capability
-- here and reads their own claim through the identity clause on
-- `clients.profile_id`; a row addressed to them would need an audience
-- narrowing the table does not have, and inventing one would be a second
-- notification system in the first one's clothing. The portal shows a member
-- their claim's status directly, which is the honest way to tell them.
-- ===========================================================================

alter table public.notifications drop constraint notifications_category_valid;

alter table public.notifications add constraint notifications_category_valid
  check (category in (
    'loan_awaiting_approval',
    'loan_awaiting_disbursement',
    'loan_decided',
    'loan_disbursed',
    'loan_cleared',
    'payment_reversed',
    'penalty_applied',
    'promise_recorded',
    'guarantor_released',
    'collateral_realised',
    'approval_pending',
    'reconciliation_variance',
    'low_float',
    'client_blacklisted',
    -- Polytos Phase 4. Benefits.
    'benefit_claim_submitted',
    'benefit_claim_information_required',
    'benefit_claim_assessed',
    'benefit_claim_decided',
    'benefit_paid',
    'benefit_payment_reversed',
    'beneficiary_awaiting_verification',
    -- Polytos Phase 4. Meetings.
    'meeting_scheduled',
    'meeting_rescheduled',
    'meeting_cancelled',
    'meeting_action_assigned'
  ));

alter table public.notifications drop constraint notifications_entity_type_valid;

alter table public.notifications add constraint notifications_entity_type_valid
  check (entity_type in (
    'loan', 'payment', 'client', 'guarantor', 'collateral',
    'transfer', 'expense', 'reconciliation', 'ledger_account',
    -- Polytos Phase 4. Each one is a route the bell can link to, which is why
    -- the list is closed: an unrecognised type renders a dead control.
    'benefit_claim', 'benefit_payment', 'member_beneficiary',
    'membership_meeting', 'meeting_action'
  ));

comment on constraint notifications_entity_type_valid on public.notifications is
  'What a notification may be about. Closed, because the link on the bell is built from it and an unrecognised type would render a dead control.';

-- ---------------------------------------------------------------------------
-- The claim lifecycle
--
-- One trigger for the whole lifecycle rather than one per status, because the
-- shape is the same each time and five triggers on one table would fire in an
-- order nobody had chosen. Row-level, because a claim moves one at a time.
-- ---------------------------------------------------------------------------

create or replace function public.notify_benefit_claim_transition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_membership text;
  v_type text;
begin
  if new.status = old.status then
    return null;
  end if;

  select m.membership_number into v_membership
  from public.memberships m where m.id = new.membership_id;

  -- The claim type in the words a person uses. Carried because it says which
  -- queue and which rules; see the header on where the line is drawn.
  v_type := case new.claim_type
    when 'medical' then 'Medical'
    when 'family_condolence' then 'Family condolence'
    when 'member_bereavement' then 'Member bereavement'
  end;

  if new.status = 'submitted' then
    -- To whoever checks evidence. The queue this creates is the verification
    -- queue, which is why it is addressed to `benefits:assess` rather than to
    -- `benefits:view`.
    perform public.raise_notification(
      'benefit_claim_submitted', 'attention',
      v_type || ' claim ' || new.claim_number || ' has been submitted',
      'Membership ' || coalesce(v_membership, 'unknown')
        || '. The evidence needs checking before it can be assessed.',
      'benefits:assess', 'benefit_claim', new.id,
      'claim:' || new.id::text || ':submitted',
      null, new.branch_id);

  elsif new.status = 'information_required' then
    -- To whoever took the claim in: they are the person who will telephone
    -- the member. Addressed to the capability rather than to the submitter
    -- personally, because the counter is staffed by whoever is in.
    perform public.raise_notification(
      'benefit_claim_information_required', 'attention',
      'Claim ' || new.claim_number || ' is waiting for more information',
      'Membership ' || coalesce(v_membership, 'unknown')
        || '. Open the claim to see what is needed.',
      'benefits:claim', 'benefit_claim', new.id,
      'claim:' || new.id::text || ':info:' || public.business_date()::text,
      null, new.branch_id);

  elsif new.status = 'assessed' then
    -- To the approver. The amount is deliberately **not** in the body: it is
    -- on the claim, behind `benefits:view`, and a figure in a notification
    -- preview is a figure on a lock screen.
    perform public.raise_notification(
      'benefit_claim_assessed', 'attention',
      v_type || ' claim ' || new.claim_number || ' is waiting for approval',
      'Membership ' || coalesce(v_membership, 'unknown')
        || '. Assessed by ' || coalesce(new.assessed_by_label, 'staff')
        || ', who may not approve it.',
      'benefits:approve', 'benefit_claim', new.id,
      'claim:' || new.id::text || ':assessed:' || new.assessed_at::text,
      null, new.branch_id);

  elsif new.status = 'approved' then
    perform public.raise_notification(
      'benefit_claim_decided', 'attention',
      v_type || ' claim ' || new.claim_number || ' has been approved',
      'Membership ' || coalesce(v_membership, 'unknown')
        || '. It is waiting to be paid.',
      'benefits:pay', 'benefit_claim', new.id,
      'claim:' || new.id::text || ':approved',
      null, new.branch_id);

  elsif new.status = 'rejected' then
    -- To the person who submitted it, by name. They are the one who has to
    -- tell the member, and they should not find out by refreshing a register
    -- — the judgement `loan_decided` already encodes.
    perform public.raise_notification(
      'benefit_claim_decided', 'info',
      v_type || ' claim ' || new.claim_number || ' has been refused',
      'Membership ' || coalesce(v_membership, 'unknown')
        || '. Open the claim for the reason given.',
      'benefits:claim', 'benefit_claim', new.id,
      'claim:' || new.id::text || ':rejected:' || coalesce(new.decided_at::text, ''),
      new.submitted_by, new.branch_id);

  elsif new.status = 'paid' then
    perform public.raise_notification(
      'benefit_paid', 'info',
      v_type || ' claim ' || new.claim_number || ' has been paid',
      'Membership ' || coalesce(v_membership, 'unknown')
        || '. The payment and its journal entry are on the claim.',
      'benefits:view', 'benefit_claim', new.id,
      'claim:' || new.id::text || ':paid',
      null, new.branch_id);

  elsif new.status = 'reversed' then
    -- Urgent, and to the broadest benefit audience. A reversal rewrites what
    -- the books say happened, and everybody who reads the benefit register
    -- should know it happened — the same treatment `payment_reversed` gets.
    perform public.raise_notification(
      'benefit_payment_reversed', 'urgent',
      'The payment of claim ' || new.claim_number || ' has been reversed',
      'Membership ' || coalesce(v_membership, 'unknown')
        || '. The contra journal entry is on the payment record.',
      'benefits:view', 'benefit_claim', new.id,
      'claim:' || new.id::text || ':reversed',
      null, new.branch_id);
  end if;

  return null;
end;
$$;

comment on function public.notify_benefit_claim_transition() is
  'Polytos Phase 4. Raises one notification per benefit claim transition, addressed to the capability that does the next thing — so the stream is a queue rather than an announcement. Carries the claim number, type and membership number, and never the hospital, the bill, the deceased or the beneficiary.';

revoke all on function public.notify_benefit_claim_transition()
  from public, anon, authenticated;

create trigger notify_benefit_claim_transition
  after update of status on public.benefit_claims
  for each row execute function public.notify_benefit_claim_transition();

-- ---------------------------------------------------------------------------
-- A beneficiary waiting to be checked
--
-- Addressed to `beneficiaries:verify`, which is the whole point of the
-- notification: the record is unverified, an unverified beneficiary cannot be
-- paid, and nobody finds out there is one to check by browsing.
-- ---------------------------------------------------------------------------

create or replace function public.notify_beneficiary_awaiting_verification()
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

  -- No name, no telephone number, no relationship. `beneficiaries:verify` is
  -- held by people who may read all three on the record itself; a lock-screen
  -- preview is not one of the places they may read them.
  perform public.raise_notification(
    'beneficiary_awaiting_verification', 'attention',
    'A beneficiary record is waiting to be checked',
    'Membership ' || coalesce(v_membership, 'unknown')
      || ', record ' || new.beneficiary_number
      || '. Recorded by ' || new.recorded_by_label
      || ', who may not verify it. Until it is checked, no bereavement benefit can be paid against it.',
    'beneficiaries:verify', 'member_beneficiary', new.id,
    'beneficiary:' || new.id::text || ':pending',
    null, new.branch_id);

  return null;
end;
$$;

comment on function public.notify_beneficiary_awaiting_verification() is
  'Polytos Phase 4. Tells whoever may verify a beneficiary that there is one waiting. Carries the membership and record numbers and the recorder''s name, and not the beneficiary''s name, telephone number or relationship.';

revoke all on function public.notify_beneficiary_awaiting_verification()
  from public, anon, authenticated;

create trigger notify_beneficiary_awaiting_verification
  after insert on public.member_beneficiaries
  for each row execute function public.notify_beneficiary_awaiting_verification();

-- ---------------------------------------------------------------------------
-- Meetings
-- ---------------------------------------------------------------------------

create or replace function public.notify_meeting_scheduled()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- `meetings:view`, not `meetings:manage`: a meeting is announced to
  -- everybody who may know about it, which is the one notification in this
  -- phase that genuinely is an announcement rather than a queue.
  perform public.raise_notification(
    'meeting_scheduled', 'info',
    new.title || ' — ' || pg_catalog.to_char(new.meeting_date, 'FMDay DD FMMonth YYYY'),
    'At ' || new.venue || ', '
      || pg_catalog.to_char(new.scheduled_at at time zone 'Africa/Kampala', 'HH24:MI')
      || '. Meeting ' || new.meeting_number || '.',
    'meetings:view', 'membership_meeting', new.id,
    'meeting:' || new.id::text || ':scheduled',
    null, new.branch_id);

  return null;
end;
$$;

revoke all on function public.notify_meeting_scheduled()
  from public, anon, authenticated;

create trigger notify_meeting_scheduled
  after insert on public.membership_meetings
  for each row execute function public.notify_meeting_scheduled();

create or replace function public.notify_meeting_moved()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'cancelled' and old.status <> 'cancelled' then
    perform public.raise_notification(
      'meeting_cancelled', 'attention',
      new.title || ' has been cancelled',
      'Meeting ' || new.meeting_number || ', which was to be held on '
        || pg_catalog.to_char(new.meeting_date, 'FMDD FMMonth YYYY')
        || '. Reason: ' || coalesce(new.cancellation_reason, 'not stated') || '.',
      'meetings:view', 'membership_meeting', new.id,
      'meeting:' || new.id::text || ':cancelled',
      null, new.branch_id);

  elsif new.scheduled_at is distinct from old.scheduled_at then
    -- The dedupe key carries the new instant, so a meeting moved twice
    -- raises two notifications — which is right, because members have
    -- arranged their day around each of them.
    perform public.raise_notification(
      'meeting_rescheduled', 'attention',
      new.title || ' has moved to '
        || pg_catalog.to_char(new.meeting_date, 'FMDay DD FMMonth YYYY'),
      'At ' || new.venue || ', '
        || pg_catalog.to_char(new.scheduled_at at time zone 'Africa/Kampala', 'HH24:MI')
        || '. Previously '
        || pg_catalog.to_char(
             old.scheduled_at at time zone 'Africa/Kampala', 'FMDD FMMonth YYYY HH24:MI')
        || '. Reason: ' || coalesce(new.reschedule_reason, 'not stated') || '.',
      'meetings:view', 'membership_meeting', new.id,
      'meeting:' || new.id::text || ':moved:' || new.scheduled_at::text,
      null, new.branch_id);
  end if;

  return null;
end;
$$;

comment on function public.notify_meeting_moved() is
  'Polytos Phase 4. Announces a cancellation or a move. The reschedule dedupe key carries the new instant, so a meeting moved twice is announced twice — members have arranged their day around each date.';

revoke all on function public.notify_meeting_moved()
  from public, anon, authenticated;

create trigger notify_meeting_moved
  after update on public.membership_meetings
  for each row execute function public.notify_meeting_moved();

create or replace function public.notify_meeting_action_assigned()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_meeting public.membership_meetings;
begin
  if new.assigned_to is null then
    return null;
  end if;

  select * into v_meeting
  from public.membership_meetings where id = new.meeting_id;

  -- Addressed to the assignee personally. An action item assigned to
  -- everybody is assigned to nobody, which is the whole reason
  -- `assigned_to` is a profile.
  perform public.raise_notification(
    'meeting_action_assigned', 'attention',
    'You have an action from ' || v_meeting.title,
    pg_catalog.left(new.description, 300)
      || case when new.due_on is null then ''
              else ' Due ' || pg_catalog.to_char(new.due_on, 'FMDD FMMonth YYYY') || '.'
         end,
    'meetings:view', 'meeting_action', new.id,
    'action:' || new.id::text || ':assigned',
    new.assigned_to, v_meeting.branch_id);

  return null;
end;
$$;

comment on function public.notify_meeting_action_assigned() is
  'Polytos Phase 4. Tells a staff member they have been given an action, addressed to them personally — an action assigned to everybody is assigned to nobody.';

revoke all on function public.notify_meeting_action_assigned()
  from public, anon, authenticated;

create trigger notify_meeting_action_assigned
  after insert on public.meeting_action_items
  for each row execute function public.notify_meeting_action_assigned();
