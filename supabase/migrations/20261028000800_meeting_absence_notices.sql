-- ===========================================================================
-- Polytos business-policy update — rule 15, first half: reporting in advance
-- ===========================================================================
--
-- > Monthly membership meetings are compulsory. A member who cannot attend
-- > must report in advance and provide a valid reason. An unexcused absence
-- > attracts a UGX 5,000 fine.
--
-- The fine is the next migration. This one is the thing that stops it being
-- charged, and it has to exist first — a system that could charge a fine
-- before it could record an excuse would charge some fines it should not, and
-- there would be no way to tell afterwards which.
--
-- ## Why `meeting_attendance.attendance = 'apology'` is not enough
--
-- Phase 4 records four answers on the register: present, absent, apology,
-- represented. "Apology" there means *somebody said they were sorry* — it is
-- a description of the register, written on the day, by whoever marked it.
--
-- Rule 15 needs three further facts the register cannot hold:
--
--   - **when** the member said it. "In advance" is the client's word, and a
--     message left the morning after is not an advance notice.
--   - **whether it was accepted.** A reason given is not a reason approved.
--     The brief is explicit: "Do not automatically assume every apology is
--     valid merely because an attendance row says `apology`."
--   - **who accepted it**, and when. Accepting an excuse cancels a UGX 5,000
--     charge, so it is a financial decision with a name against it.
--
-- So the notice is its own record, with its own review, and the register stays
-- what it is: a description of who was in the room.
--
-- ## "In advance" is enforced, not described
--
-- A notice cannot be recorded once the meeting has started. Not a warning,
-- not a flag on the row — a refusal, because the whole content of the rule is
-- the word *advance*, and a notice table that accepted retrospective entries
-- would quietly become a way of cancelling fines after the fact.
--
-- A member who genuinely could not report in advance — taken to hospital that
-- morning — is not left without a remedy: the fine, once assessed, can be
-- cancelled with a reason by somebody holding `fines:reverse`. That is the
-- right shape for it. The exception is visible, it is somebody's decision,
-- and it is on the record.
--
-- ## Separation
--
-- The person who takes the message does not decide whether it is valid.
-- `meetings:manage` records the notice — clerical, and usually the
-- Secretary/Treasurer, who is who the member rings. `meetings:excuse_review`
-- accepts or rejects it, and the function refuses a reviewer who is the
-- person that recorded it, whatever capabilities they hold.
-- ===========================================================================

create table public.meeting_absence_notices (
  id                 uuid primary key default gen_random_uuid(),

  meeting_id         uuid not null references public.membership_meetings(id)
                       on delete restrict,
  meeting_number     text not null,
  membership_id      uuid not null references public.memberships(id)
                       on delete restrict,
  membership_number  text not null,
  client_id          uuid not null references public.clients(id)
                       on delete restrict,
  branch_id          uuid not null references public.branches(id)
                       on delete restrict,

  -- The same vocabulary the register uses, so a notice and the attendance row
  -- it explains do not describe the same absence in two different languages.
  reason_kind        text not null,
  reason             text not null,

  -- How the member got the message to the business. Recorded because "they
  -- told us" is not evidence and the quality of the channel is part of the
  -- decision.
  reported_via       text not null,
  reported_at        timestamptz not null default now(),
  reported_by        uuid references public.profiles(id) on delete set null,
  reported_by_label  text not null,

  review_status      text not null default 'pending',
  reviewed_at        timestamptz,
  reviewed_by        uuid references public.profiles(id) on delete set null,
  reviewed_by_label  text,
  review_note        text,

  business_date      date not null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint meeting_absence_reason_kind_valid
    check (reason_kind in
             ('illness', 'travel', 'work', 'bereavement', 'family',
              'not_stated', 'other')),
  constraint meeting_absence_reason_length
    check (char_length(btrim(reason)) between 3 and 1000),
  constraint meeting_absence_reported_via_valid
    check (reported_via in
             ('in_person', 'telephone', 'sms', 'through_another_member', 'written')),
  constraint meeting_absence_review_status_valid
    check (review_status in ('pending', 'approved', 'rejected')),
  -- A decision has a decider and a time; a pending notice has neither.
  constraint meeting_absence_review_coherent
    check (
      (review_status = 'pending')
        = (reviewed_at is null and reviewed_by_label is null)
    ),
  -- A rejection has to say why. An accepted excuse costs the member nothing
  -- and needs no justification; a rejected one costs them UGX 5,000.
  constraint meeting_absence_rejection_has_a_reason
    check (review_status <> 'rejected' or review_note is not null),
  constraint meeting_absence_review_note_length
    check (review_note is null or char_length(btrim(review_note)) between 3 and 1000)
);

comment on table public.meeting_absence_notices is
  'Polytos policy update, rule 15. A member''s advance notice that they cannot attend a meeting, and the separate decision about whether the reason is accepted. Distinct from meeting_attendance.attendance = ''apology'', which describes the register on the day: a reason given is not a reason approved, and only an approved one stops the UGX 5,000 fine.';

comment on column public.meeting_absence_notices.reported_at is
  'When the member got word to the business. The whole content of the rule is the word "advance", so a notice cannot be recorded once the meeting has started — a member who genuinely could not report in time is remedied by cancelling the fine with a reason, which is visible and somebody''s decision, rather than by a retrospective notice nobody can see.';

create unique index meeting_absence_notice_one_per_member
  on public.meeting_absence_notices (meeting_id, membership_id);

create index meeting_absence_notice_review_idx
  on public.meeting_absence_notices (review_status, meeting_id);

create index meeting_absence_notice_membership_idx
  on public.meeting_absence_notices (membership_id, reported_at desc);

create trigger meeting_absence_notices_set_updated_at
  before update on public.meeting_absence_notices
  for each row execute function public.set_updated_at();

create trigger meeting_absence_notices_no_delete
  before delete on public.meeting_absence_notices
  for each row execute function public.reject_mutation();

-- ---------------------------------------------------------------------------
-- What may change after the row exists
-- ---------------------------------------------------------------------------
--
-- Only the review. The notice itself — who, which meeting, what they said,
-- when they said it, who took it — is what the review is a decision *about*,
-- and a record whose subject could be edited after the decision would be a
-- record of nothing.

create or replace function public.meeting_absence_notices_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
     or new.meeting_id is distinct from old.meeting_id
     or new.membership_id is distinct from old.membership_id
     or new.reason_kind is distinct from old.reason_kind
     or new.reason is distinct from old.reason
     or new.reported_via is distinct from old.reported_via
     or new.reported_at is distinct from old.reported_at
     or new.reported_by_label is distinct from old.reported_by_label
     or new.created_at is distinct from old.created_at then
    raise exception
      'An absence notice records what the member said and when. Only the review of it may change.'
      using errcode = 'P0001';
  end if;

  -- A decision is taken once. Changing an approval to a rejection after a
  -- fine has been assessed on the strength of it would rewrite the basis of a
  -- charge; the remedy for a wrong decision is to cancel the fine, with a
  -- reason, which is visible.
  if old.review_status <> 'pending' and new.review_status is distinct from old.review_status then
    raise exception
      'This notice has already been %. A decision taken is not re-taken; correct the fine instead, with a reason.',
      old.review_status using errcode = 'P0001';
  end if;

  return new;
end;
$$;

comment on function public.meeting_absence_notices_guard() is
  'Polytos policy update. An absence notice is append-only except for its review, and the review is taken once. Correcting a wrong decision is a fine cancellation with a reason, which somebody signs, rather than a quiet edit to the record the charge rested on.';

create trigger meeting_absence_notices_guard
  before update on public.meeting_absence_notices
  for each row execute function public.meeting_absence_notices_guard();

-- ---------------------------------------------------------------------------
-- Recording one
-- ---------------------------------------------------------------------------

create or replace function public.record_meeting_absence_notice(
  p_meeting_id uuid,
  p_membership_id uuid,
  p_reason_kind text,
  p_reason text,
  p_reported_via text default 'telephone'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_meeting    public.membership_meetings;
  v_membership public.memberships;
  v_actor      uuid;
  v_label      text;
  v_id         uuid;
begin
  v_actor := public.current_profile_id();
  v_label := public.audit_actor_label();

  if v_actor is null and auth.uid() is not null then
    raise exception
      'An absence notice must be recorded by a signed-in member of staff.'
      using errcode = 'P0001';
  end if;

  if auth.uid() is not null and not public.user_has_permission('meetings:manage') then
    raise exception
      'Recording an absence notice requires the meetings:manage capability.'
      using errcode = '42501';
  end if;

  select * into v_meeting
  from public.membership_meetings where id = p_meeting_id;

  if not found then
    raise exception 'No such meeting.' using errcode = 'P0001';
  end if;

  if not public.user_can_see_branch(v_meeting.branch_id) then
    raise exception 'You cannot work that branch''s meetings.' using errcode = '42501';
  end if;

  if v_meeting.status = 'cancelled' then
    raise exception
      'Meeting % was cancelled, so there is nothing to be absent from.',
      v_meeting.meeting_number using errcode = 'P0001';
  end if;

  -- The rule's own word. A notice after the meeting has begun is not advance
  -- notice, and accepting one here would make the fine cancellable after the
  -- fact by anybody who could write a row.
  if pg_catalog.now() >= v_meeting.scheduled_at then
    raise exception
      'Meeting % began at %. An absence must be reported in advance; a member who could not do so is remedied by cancelling the fine with a reason, not by a notice recorded afterwards.',
      v_meeting.meeting_number, v_meeting.scheduled_at using errcode = 'P0001';
  end if;

  select * into v_membership
  from public.memberships where id = p_membership_id;

  if not found then
    raise exception 'No such membership.' using errcode = 'P0001';
  end if;

  if v_membership.branch_id <> v_meeting.branch_id then
    raise exception
      'Membership % belongs to another branch, so it is not on this meeting''s register.',
      v_membership.membership_number using errcode = 'P0001';
  end if;

  if v_membership.status not in ('active', 'suspended') then
    raise exception
      'Membership % is %. Only a member of the programme is expected at its meetings.',
      v_membership.membership_number, v_membership.status using errcode = 'P0001';
  end if;

  insert into public.meeting_absence_notices (
    meeting_id, meeting_number, membership_id, membership_number,
    client_id, branch_id,
    reason_kind, reason, reported_via,
    reported_by, reported_by_label, business_date
  )
  values (
    p_meeting_id, v_meeting.meeting_number, p_membership_id,
    v_membership.membership_number, v_membership.client_id, v_meeting.branch_id,
    p_reason_kind, pg_catalog.btrim(p_reason), p_reported_via,
    v_actor, v_label, public.business_date()
  )
  on conflict (meeting_id, membership_id) do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id from public.meeting_absence_notices
    where meeting_id = p_meeting_id and membership_id = p_membership_id;
  end if;

  return v_id;
end;
$$;

comment on function public.record_meeting_absence_notice(uuid, uuid, text, text, text) is
  'Polytos policy update, rule 15. Records that a member reported in advance that they cannot attend, with the reason and how word reached the business. Refuses once the meeting has begun, because "in advance" is the rule. Idempotent per member and meeting.';

grant execute on function
  public.record_meeting_absence_notice(uuid, uuid, text, text, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Deciding whether it is a valid reason
-- ---------------------------------------------------------------------------

create or replace function public.review_meeting_absence_notice(
  p_notice_id uuid,
  p_approved boolean,
  p_note text default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_notice public.meeting_absence_notices;
  v_actor  uuid;
  v_label  text;
  v_status text;
begin
  v_actor := public.current_profile_id();
  v_label := public.audit_actor_label();

  if v_actor is null and auth.uid() is not null then
    raise exception
      'An absence notice must be reviewed by a signed-in member of staff.'
      using errcode = 'P0001';
  end if;

  if auth.uid() is not null
     and not public.user_has_permission('meetings:excuse_review') then
    raise exception
      'Accepting or rejecting an absence notice requires the meetings:excuse_review capability. Taking the message and deciding whether it excuses the member are different acts.'
      using errcode = '42501';
  end if;

  select * into v_notice
  from public.meeting_absence_notices where id = p_notice_id for update;

  if not found then
    raise exception 'No such absence notice.' using errcode = 'P0001';
  end if;

  if not public.user_can_see_branch(v_notice.branch_id) then
    raise exception 'You cannot review that branch''s absence notices.'
      using errcode = '42501';
  end if;

  -- Separation of duties, as a refusal rather than as a convention. The
  -- person who took the message is usually the person the member rang, and
  -- they should not be the person who decides it excuses a charge.
  if v_actor is not null and v_notice.reported_by = v_actor then
    raise exception
      'You recorded this notice. Somebody else decides whether it excuses the absence.'
      using errcode = 'P0001';
  end if;

  if v_notice.review_status <> 'pending' then
    raise exception
      'This notice has already been %. A decision taken is not re-taken.',
      v_notice.review_status using errcode = 'P0001';
  end if;

  v_status := case when p_approved then 'approved' else 'rejected' end;

  if not p_approved
     and coalesce(pg_catalog.btrim(coalesce(p_note, '')), '') = '' then
    raise exception
      'Rejecting an absence notice costs the member UGX 5,000. Say why.'
      using errcode = 'P0001';
  end if;

  update public.meeting_absence_notices
     set review_status = v_status,
         reviewed_at = pg_catalog.now(),
         reviewed_by = v_actor,
         reviewed_by_label = v_label,
         review_note = nullif(pg_catalog.btrim(coalesce(p_note, '')), '')
   where id = p_notice_id;

  return v_status;
end;
$$;

comment on function public.review_meeting_absence_notice(uuid, boolean, text) is
  'Polytos policy update, rule 15. Accepts or rejects a member''s advance absence notice. Needs meetings:excuse_review, refuses the person who recorded the notice, and refuses a rejection with no reason — rejecting one costs the member UGX 5,000.';

grant execute on function public.review_meeting_absence_notice(uuid, boolean, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Was this member excused?
-- ---------------------------------------------------------------------------

create or replace function public.meeting_absence_excused(
  p_meeting_id uuid,
  p_membership_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.meeting_absence_notices n
    where n.meeting_id = p_meeting_id
      and n.membership_id = p_membership_id
      and n.review_status = 'approved'
  );
$$;

comment on function public.meeting_absence_excused(uuid, uuid) is
  'Polytos policy update, rule 15. Whether a member''s absence from a meeting was excused — an advance notice that somebody accepted. Approved only: a pending notice has not excused anybody yet, and a rejected one has been considered and refused.';

grant execute on function public.meeting_absence_excused(uuid, uuid) to authenticated;


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

revoke all on table public.meeting_absence_notices from anon, authenticated;
revoke all on function public.meeting_absence_notices_guard() from public, anon, authenticated;
revoke all on function public.record_meeting_absence_notice(uuid, uuid, text, text, text) from public, anon;
revoke all on function public.review_meeting_absence_notice(uuid, boolean, text) from public, anon;
revoke all on function public.meeting_absence_excused(uuid, uuid) from public, anon;
