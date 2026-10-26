-- ===========================================================================
-- Polytos Phase 4.12 — Row Level Security over the benefit and meeting tables
--
-- This is the boundary. Everything above it — a hidden sidebar entry, a
-- guarded Server Component, a disabled button — exists to give people a
-- coherent experience and to fail early. None of it survives a caller who
-- takes their own token and queries PostgREST directly, which anybody with the
-- browser's developer tools can do in a minute. Each policy below is written
-- to be correct on its own, assuming the application has been bypassed
-- entirely.
--
-- The four conventions every earlier phase carried, all load-bearing here:
--
--   * **Every capability call is wrapped in a scalar subquery**, so it plans
--     as an InitPlan evaluated once per statement rather than once per
--     candidate row. `tests/db/rls-hoisting.test.ts` fails the build on a bare
--     call.
--   * **The branch rule is restated, not called.** `user_can_see_branch` is
--     correlated *and* SECURITY DEFINER, so PostgreSQL can neither hoist nor
--     inline it.
--   * **`current_profile_id()` resolves only active profiles**, which is what
--     makes suspending an account take effect on the next request.
--   * **`authenticated` holds no privilege until granted here, per
--     operation.** There is no INSERT grant on any claim, beneficiary or
--     payment table, and no DELETE grant anywhere except the one that lets an
--     unchecked document be taken off an open claim.
--
-- ## What a member may see
--
-- Their own claims, their own claims' documents, their own beneficiary records
-- and their own beneficiaries' contact details — through the identity clause
-- on `clients.profile_id`, which grants exactly their own rows.
--
-- They may **not** see:
--
--   * the assessment snapshot, which carries an officer's working reasoning
--     and the member's own loan and savings position. No approved policy
--     discloses an assessor's note to the member it is about, and §17 of the
--     brief says to keep it private until one does;
--   * `assessment_note`, `decision_note` and a document's
--     `verification_note` — the same reason, and the reason the claim's
--     member-facing read goes through `benefit_claim_portal_view` in
--     20261022001400 rather than through the table;
--   * anybody else's anything.
--
-- A member reading their own beneficiary's details is a deliberate divergence
-- from `client_identities`, which has no self-clause. The question "is my next
-- of kin still correct?" has real consequences — a wrong answer means a
-- benefit paid to the wrong person — so a member may read their own
-- nomination. They may not write it: a beneficiary a member could change
-- themselves would be a payment instruction with no verification behind it.
--
-- ## The sensitive-data boundary, stated as rows
--
-- RLS is row-level, which is why `member_beneficiary_identities` is a separate
-- table (20261022000400). Two further places carry a beneficiary's name, and
-- both are handled as **row** predicates rather than by splitting another
-- table:
--
--   * `benefit_assessment_snapshots` — needs `benefits:assess` or
--     `benefits:approve`, and a bereavement snapshot additionally needs
--     `membership:view_sensitive`, because that is the row whose copied payee
--     name is the payment instruction;
--   * `benefit_payments` — a payment to the *member* is readable by anybody
--     with `benefits:view`, because the recipient is the member whose name
--     they already read on the claim; a payment to a *beneficiary* needs
--     `membership:view_sensitive`.
--
-- That is why a Secretary/Treasurer can run the benefit register and the
-- payment history for medical and condolence benefits, and sees a bereavement
-- payment as a row they are not entitled to read rather than as a name.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Revoke first, then grant
--
-- `CREATE TABLE` in this database inherits default privileges that hand
-- `authenticated` everything — including DELETE and TRUNCATE. Granting the few
-- operations a table should allow does not take the rest away, so every table
-- here is stripped bare **before** anything is granted back.
-- `tests/db/security.test.ts` asserts the resulting privilege list
-- exhaustively, which is how the omission in the first draft of the Phase 2
-- equivalent was found rather than shipped.
-- ---------------------------------------------------------------------------

revoke all on table public.member_beneficiaries from anon, authenticated;
revoke all on table public.member_beneficiary_identities from anon, authenticated;
revoke all on table public.benefit_claims from anon, authenticated;
revoke all on table public.benefit_claim_documents from anon, authenticated;
revoke all on table public.benefit_assessment_snapshots from anon, authenticated;
revoke all on table public.benefit_payments from anon, authenticated;
revoke all on table public.membership_meetings from anon, authenticated;
revoke all on table public.meeting_attendance from anon, authenticated;
revoke all on table public.meeting_attendance_corrections from anon, authenticated;
revoke all on table public.meeting_action_items from anon, authenticated;

-- ===========================================================================
-- member_beneficiaries
--
-- Written only by `register_member_beneficiary`, `verify_member_beneficiary`
-- and `revoke_member_beneficiary`, all SECURITY DEFINER — so there is no
-- INSERT grant at all, and the UPDATE grant exists only because those
-- functions run as the table owner and the guard is what actually constrains
-- them. A directly inserted beneficiary would be a payment instruction nobody
-- checked.
-- ===========================================================================

grant select on table public.member_beneficiaries to authenticated;

alter table public.member_beneficiaries enable row level security;

create policy member_beneficiaries_select
  on public.member_beneficiaries
  for select
  to authenticated
  using (
    (
      (select public.user_has_permission('beneficiaries:view'))
      or exists (
        select 1 from public.clients c
        where c.id = member_beneficiaries.client_id
          and c.profile_id is not null
          and c.profile_id = (select public.current_profile_id())
      )
    )
    and (
      branch_id is null
      or (select public.current_user_branch_id()) is null
      or branch_id = (select public.current_user_branch_id())
    )
  );

comment on policy member_beneficiaries_select on public.member_beneficiaries is
  'Staff holding beneficiaries:view read the records within their branch, without the contact details. A member reads their own, through clients.profile_id. Nobody writes this table through a policy — register_member_beneficiary is the only way in.';

-- ===========================================================================
-- member_beneficiary_identities
--
-- The whole reason the table exists. A Secretary/Treasurer passes
-- `beneficiaries:view` and runs the register all day; they fail here, so there
-- is no query, view or export through which they reach a beneficiary's name,
-- telephone number or identity reference.
--
-- No INSERT and no UPDATE grant. `register_member_beneficiary` writes it, and
-- the table's own triggers refuse every UPDATE and DELETE besides.
-- ===========================================================================

grant select on table public.member_beneficiary_identities to authenticated;

alter table public.member_beneficiary_identities enable row level security;

create policy member_beneficiary_identities_select
  on public.member_beneficiary_identities
  for select
  to authenticated
  using (
    (select public.user_has_permission('membership:view_sensitive'))
    or exists (
      select 1
      from public.member_beneficiaries b
      join public.clients c on c.id = b.client_id
      where b.id = member_beneficiary_identities.beneficiary_id
        and c.profile_id is not null
        and c.profile_id = (select public.current_profile_id())
    )
  );

comment on policy member_beneficiary_identities_select on public.member_beneficiary_identities is
  'Only membership:view_sensitive reads a beneficiary''s name, telephone number and identity reference — plus the member whose own nomination it is, because "is my next of kin still correct?" has real consequences. A deliberate divergence from client_identities, which has no self-clause.';

-- ===========================================================================
-- benefit_claims
--
-- Read by staff holding `benefits:view` within their branch, and by the member
-- whose claim it is. Written only by the lifecycle functions, so no INSERT
-- grant; the UPDATE grant is what those SECURITY DEFINER functions use, and
-- the guard's transition table is what constrains them.
--
-- A member reading the table sees their own row *including* the assessor's
-- note, which is why the portal reads `benefit_claim_portal_view` instead —
-- see 20261022001400. The note is a column, and RLS cannot withhold a column;
-- the honest fix is that the portal never selects it, and the view is what
-- makes that structural rather than a habit.
-- ===========================================================================

grant select on table public.benefit_claims to authenticated;

alter table public.benefit_claims enable row level security;

create policy benefit_claims_select
  on public.benefit_claims
  for select
  to authenticated
  using (
    (
      (select public.user_has_permission('benefits:view'))
      or exists (
        select 1 from public.clients c
        where c.id = benefit_claims.client_id
          and c.profile_id is not null
          and c.profile_id = (select public.current_profile_id())
      )
    )
    and (
      branch_id is null
      or (select public.current_user_branch_id()) is null
      or branch_id = (select public.current_user_branch_id())
    )
  );

comment on policy benefit_claims_select on public.benefit_claims is
  'Staff holding benefits:view read claims within their branch; a member reads their own through clients.profile_id. No INSERT or UPDATE policy: every transition is a SECURITY DEFINER function, so a claim cannot be moved by a bare UPDATE.';

-- ===========================================================================
-- benefit_claim_documents
--
-- The metadata. The objects themselves are governed by the storage policies in
-- 20261022000600, and the two are deliberately independent: a caller needs to
-- pass both to see a document, and passing one is no use.
--
-- The one DELETE grant in this migration. An unchecked document on an open
-- claim is a thing people need to undo, and the delete guard refuses anything
-- else with a message that says why.
-- ===========================================================================

grant select, delete on table public.benefit_claim_documents to authenticated;

alter table public.benefit_claim_documents enable row level security;

create policy benefit_claim_documents_select
  on public.benefit_claim_documents
  for select
  to authenticated
  using (
    (select public.user_has_permission('benefits:view'))
    or (select public.user_has_permission('beneficiaries:view'))
    or exists (
      select 1 from public.clients c
      where c.id = benefit_claim_documents.client_id
        and c.profile_id is not null
        and c.profile_id = (select public.current_profile_id())
    )
  );

comment on policy benefit_claim_documents_select on public.benefit_claim_documents is
  'Staff holding benefits:view or beneficiaries:view read the metadata; a member reads their own claims'' and their own beneficiaries''. The objects are governed separately by the storage policies, so a caller must pass both.';

create policy benefit_claim_documents_delete
  on public.benefit_claim_documents
  for delete
  to authenticated
  using (
    (
      (select public.user_has_permission('benefits:claim'))
      or (select public.user_has_permission('beneficiaries:manage'))
    )
    and verification_status = 'unchecked'
  );

comment on policy benefit_claim_documents_delete on public.benefit_claim_documents is
  'An unchecked document may be taken off by whoever may attach one. The claim''s own state is checked by the delete guard, which also refuses the removal of a document somebody has checked.';

-- ===========================================================================
-- benefit_assessment_snapshots
--
-- The internal working record: the officer's note, the cap arithmetic, the
-- member's loan and savings position, and — on a bereavement claim — the
-- copied payee. Read by the people who assess and approve, and by nobody else.
--
-- No self-clause. A member may not read the assessment of their own claim, and
-- that is the honest consequence of §17: internal assessment notes stay
-- private until an approved client-facing disclosure policy says otherwise.
-- What the member *can* see is the outcome and the amount, on their claim.
--
-- No INSERT grant, and the table's own triggers refuse UPDATE and DELETE, so
-- the only route in is `assess_benefit_claim`.
-- ===========================================================================

grant select on table public.benefit_assessment_snapshots to authenticated;

alter table public.benefit_assessment_snapshots enable row level security;

create policy benefit_assessment_snapshots_select
  on public.benefit_assessment_snapshots
  for select
  to authenticated
  using (
    (
      (select public.user_has_permission('benefits:assess'))
      or (select public.user_has_permission('benefits:approve'))
    )
    -- The bereavement snapshot's copied payee name is the payment
    -- instruction, so reading it needs the capability that reads one.
    and (
      claim_type <> 'member_bereavement'
      or (select public.user_has_permission('membership:view_sensitive'))
    )
    and exists (
      select 1 from public.memberships m
      where m.id = benefit_assessment_snapshots.membership_id
        and (
          (select public.current_user_branch_id()) is null
          or m.branch_id = (select public.current_user_branch_id())
        )
    )
  );

comment on policy benefit_assessment_snapshots_select on public.benefit_assessment_snapshots is
  'Read by benefits:assess or benefits:approve, within branch. A bereavement snapshot additionally needs membership:view_sensitive, because its copied payee name is the payment instruction. No self-clause: a member does not read the officer''s reasoning about their own claim.';

-- ===========================================================================
-- benefit_payments
--
-- The receipt. Read by staff holding `benefits:view` within their branch —
-- except that a payment to a *beneficiary* carries their name, so that row
-- needs `membership:view_sensitive`.
--
-- A member reads their own payments, and a bereavement payment is not theirs
-- to read: by then they are dead, and the row is about somebody else. The
-- self-clause is therefore written against `recipient_kind = 'member'`, which
-- expresses that without having to say it.
-- ===========================================================================

grant select on table public.benefit_payments to authenticated;

alter table public.benefit_payments enable row level security;

create policy benefit_payments_select
  on public.benefit_payments
  for select
  to authenticated
  using (
    (
      (
        (select public.user_has_permission('benefits:view'))
        and (
          recipient_kind = 'member'
          or (select public.user_has_permission('membership:view_sensitive'))
        )
      )
      or (
        recipient_kind = 'member'
        and exists (
          select 1 from public.clients c
          where c.id = benefit_payments.client_id
            and c.profile_id is not null
            and c.profile_id = (select public.current_profile_id())
        )
      )
    )
    and (
      branch_id is null
      or (select public.current_user_branch_id()) is null
      or branch_id = (select public.current_user_branch_id())
    )
  );

comment on policy benefit_payments_select on public.benefit_payments is
  'Staff holding benefits:view read payments within their branch; a payment to a beneficiary carries their name, so it additionally needs membership:view_sensitive. A member reads their own medical and condolence payments — a bereavement payment is about somebody else.';

-- ===========================================================================
-- membership_meetings
--
-- The least sensitive table in the phase: a date, a venue, an agenda and a set
-- of minutes. Read by `meetings:view` within branch. Minutes are part of the
-- row, so a reader who may see the meeting may see them — which is right: the
-- minutes of a membership meeting are a record for the membership, not a
-- confidential file.
--
-- A member does **not** read them. There is no self-clause, because a meeting
-- is not a row about any one member and the portal has no meetings surface:
-- publishing minutes to members is a decision about disclosure that nobody has
-- made, and a portal that shows them cannot un-show them.
-- ===========================================================================

grant select, update on table public.membership_meetings to authenticated;

alter table public.membership_meetings enable row level security;

create policy membership_meetings_select
  on public.membership_meetings
  for select
  to authenticated
  using (
    (select public.user_has_permission('meetings:view'))
    and (
      (select public.current_user_branch_id()) is null
      or branch_id = (select public.current_user_branch_id())
    )
  );

comment on policy membership_meetings_select on public.membership_meetings is
  'meetings:view, within branch. No self-clause for a member: publishing minutes to the membership is a disclosure decision nobody has made, and the portal has no meetings surface.';

-- The UPDATE grant is what the SECURITY DEFINER scheduling functions use. The
-- policy narrows it to `meetings:manage` within branch so that even a bare
-- UPDATE from a session cannot move another branch's meeting, and the guard
-- refuses the columns that must not change.
create policy membership_meetings_update
  on public.membership_meetings
  for update
  to authenticated
  using (
    (select public.user_has_permission('meetings:manage'))
    and (
      (select public.current_user_branch_id()) is null
      or branch_id = (select public.current_user_branch_id())
    )
  )
  with check (
    (select public.user_has_permission('meetings:manage'))
    and (
      (select public.current_user_branch_id()) is null
      or branch_id = (select public.current_user_branch_id())
    )
  );

-- No INSERT policy: `schedule_membership_meeting` is the only way a meeting is
-- created, because it is where the branch check and the number minting live.

-- ===========================================================================
-- meeting_attendance and its corrections
--
-- Read by `meetings:view` within the meeting's branch, and by nobody else.
--
-- **No self-clause**, and the reason is worth stating because the obvious
-- design has one. A member reading their own attendance row sounds useful and
-- harmless — but the row is only meaningful beside the meeting it belongs to,
-- and `membership_meetings` is staff-only (see above: publishing minutes to
-- the membership is a disclosure decision nobody has made). So a member would
-- hold a row saying `present` with no way to learn which meeting, which date
-- or which venue, and the portal has no meetings surface to show it on.
--
-- A self-clause that cannot produce a usable answer is worse than none: it
-- reads as a promise the product does not keep, and the next person to work
-- here would build a screen on it and find it empty. If the client decides
-- members should see their own attendance, this policy and
-- `membership_meetings_select` change together, which is the honest shape of
-- that decision.
--
-- The corrections table is staff-only for a different reason: "she was marked
-- absent and then present, and here is who changed it" is an internal control
-- record.
-- ===========================================================================

grant select on table public.meeting_attendance to authenticated;

alter table public.meeting_attendance enable row level security;

create policy meeting_attendance_select
  on public.meeting_attendance
  for select
  to authenticated
  using (
    (select public.user_has_permission('meetings:view'))
    and exists (
      select 1 from public.membership_meetings m
      where m.id = meeting_attendance.meeting_id
        and (
          (select public.current_user_branch_id()) is null
          or m.branch_id = (select public.current_user_branch_id())
        )
    )
  );

comment on policy meeting_attendance_select on public.meeting_attendance is
  'meetings:view within the meeting''s branch. No self-clause: the meeting a row belongs to is staff-only, so a member would hold an attendance row with no way to learn which meeting it was — a promise the product does not keep. If members should see their own attendance, this and membership_meetings_select change together.';

grant select on table public.meeting_attendance_corrections to authenticated;

alter table public.meeting_attendance_corrections enable row level security;

create policy meeting_attendance_corrections_select
  on public.meeting_attendance_corrections
  for select
  to authenticated
  using (
    (select public.user_has_permission('meetings:view'))
    and exists (
      select 1 from public.membership_meetings m
      where m.id = meeting_attendance_corrections.meeting_id
        and (
          (select public.current_user_branch_id()) is null
          or m.branch_id = (select public.current_user_branch_id())
        )
    )
  );

comment on policy meeting_attendance_corrections_select on public.meeting_attendance_corrections is
  'meetings:view within branch, and no self-clause. Who changed an attendance entry and why is an internal control record.';

-- ===========================================================================
-- meeting_action_items
-- ===========================================================================

grant select on table public.meeting_action_items to authenticated;

alter table public.meeting_action_items enable row level security;

create policy meeting_action_items_select
  on public.meeting_action_items
  for select
  to authenticated
  using (
    (select public.user_has_permission('meetings:view'))
    and exists (
      select 1 from public.membership_meetings m
      where m.id = meeting_action_items.meeting_id
        and (
          (select public.current_user_branch_id()) is null
          or m.branch_id = (select public.current_user_branch_id())
        )
    )
  );

comment on policy meeting_action_items_select on public.meeting_action_items is
  'meetings:view within the meeting''s branch. Staff-only: an action item names a member of staff and a deadline, which is internal work.';

-- ===========================================================================
-- The reference counter
--
-- Four new scopes were added in 20261022000100, and `next_reference` is
-- granted to nobody — every Phase 4 numbered table mints its number inside a
-- SECURITY DEFINER trigger, exactly as `MB`, `SA` and `WD` do. Restated here
-- because it is the kind of grant that gets added by accident when a new scope
-- appears, and `tests/db/security.test.ts` asserts it.
-- ===========================================================================

revoke all on function public.next_reference(text) from public, anon, authenticated;
