-- ===========================================================================
-- Polytos Phase 1.6 — Row Level Security for the membership tables
--
-- This is the boundary. Everything above it — hidden sidebar entries, guarded
-- Server Components, the route map — exists to give people a coherent
-- experience and to fail early. None of it survives a caller who takes their
-- own token and queries PostgREST directly, which anybody with the browser's
-- developer tools can do in a minute. So each policy below is written to be
-- correct on its own, assuming the application above it has been bypassed
-- entirely.
--
-- Four conventions carried from the lending phases, each load-bearing:
--
--   * **Every capability call is wrapped in a scalar subquery.**
--     `(select public.user_has_permission('membership:view'))` is planned as
--     an InitPlan and evaluated once per statement; the bare call is
--     evaluated once per candidate row. Phase 18 measured a single register
--     read invoking the helper 20,524 times and taking 3.2 seconds. The
--     predicate is identical; only when it is evaluated changes. A database
--     test (`tests/db/rls-hoisting.test.ts`) fails the build on a bare call.
--
--   * **The branch rule is restated, not called.**
--     `user_can_see_branch(branch_id)` is correlated *and* SECURITY DEFINER,
--     so PostgreSQL can neither hoist it nor inline it. The same rule is
--     written out with the caller's own branch hoisted, exactly as the
--     clients and loans policies write it.
--
--   * **`public.current_profile_id()` resolves only *active* profiles.**
--     Every self-clause routes through it, which is what makes suspending an
--     account take effect on the next request rather than when its token
--     expires.
--
--   * **`authenticated` holds no privilege until granted here, per
--     operation.** There is no DELETE grant anywhere in this migration, which
--     is how "a membership is withdrawn, never deleted" is enforced rather
--     than merely documented.
--
-- ## What a borrower may see
--
-- Their own membership, and nothing else — through the identity clause,
-- keyed on `clients.profile_id`, which grants exactly one row. They hold no
-- membership capability, so the register is closed to them by the same
-- predicate that opens it to staff.
--
-- They may read the policy version they were enrolled under and the terms
-- they themselves accepted, because those are the terms binding *them*; a
-- programme that hid its own rules from the people bound by them would be
-- the defect `guarantor_consent_terms` was written to avoid.
--
-- They may **not** read `membership_status_history`. A suspension reason is
-- an internal decision written about them, in the same category as
-- `client_remarks`, and Polytos Phase 5 will decide what the portal shows
-- about a member's standing in words chosen for that purpose.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- membership_policy_versions
--
-- Read by every signed-in staff member who may see membership at all: a
-- Secretary/Treasurer has to be able to quote the registration fee and the
-- savings minimum at the counter. Written only with
-- `membership:manage_policies`, which is the Owner's alone.
--
-- The self-clause lets a member read the version they were enrolled under.
-- It is scoped to versions they are actually bound by rather than to the
-- whole table, because a draft the business is preparing is not yet anybody's
-- terms.
-- ---------------------------------------------------------------------------

grant select, insert, update on table public.membership_policy_versions to authenticated;

create policy membership_policy_versions_select
  on public.membership_policy_versions
  for select
  to authenticated
  using (
    (select public.user_has_permission('membership:view'))
    or exists (
      select 1
      from public.memberships m
      join public.clients c on c.id = m.client_id
      where m.policy_version_id = membership_policy_versions.id
        and c.profile_id is not null
        and c.profile_id = (select public.current_profile_id())
    )
  );

comment on policy membership_policy_versions_select on public.membership_policy_versions is
  'Staff holding membership:view read the published policy. A member reads the version they were enrolled under, and no other — a draft the business is preparing is nobody''s terms yet.';

create policy membership_policy_versions_insert
  on public.membership_policy_versions
  for insert
  to authenticated
  with check (
    (select public.user_has_permission('membership:manage_policies'))
    -- A version arrives as a draft. Publishing is a second, deliberate act
    -- that the update guard attributes and timestamps; a version that could
    -- arrive already active and approved would skip both.
    and status = 'draft'
    and approved_at is null
    and approved_by is null
  );

comment on policy membership_policy_versions_insert on public.membership_policy_versions is
  'Only membership:manage_policies may publish a policy version, and it arrives as an unapproved draft.';

create policy membership_policy_versions_update
  on public.membership_policy_versions
  for update
  to authenticated
  using ((select public.user_has_permission('membership:manage_policies')))
  with check ((select public.user_has_permission('membership:manage_policies')));

-- ---------------------------------------------------------------------------
-- memberships
--
-- The register for staff, one row for a linked borrower, nothing for anybody
-- else. The branch rule applies as it does to clients and loans: a profile
-- assigned to a branch sees that branch's memberships, and a profile with no
-- branch — which every existing profile is — is unrestricted.
-- ---------------------------------------------------------------------------

grant select, insert, update on table public.memberships to authenticated;

create policy memberships_select_own_or_register
  on public.memberships
  for select
  to authenticated
  using (
    (
      (select public.user_has_permission('membership:view'))
      or exists (
        select 1
        from public.clients c
        where c.id = memberships.client_id
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

comment on policy memberships_select_own_or_register on public.memberships is
  'Staff holding membership:view read the register, within their branch. A linked borrower reads their own membership and no other. Nobody else reads anything.';

create policy memberships_insert_with_permission
  on public.memberships
  for insert
  to authenticated
  with check (
    (select public.user_has_permission('membership:create'))
    -- Enrolment produces a pending membership. The trigger refuses any other
    -- status as well; stating it here too means the refusal does not depend
    -- on a trigger somebody could disable.
    and status = 'pending'
    and (
      branch_id is null
      or (select public.current_user_branch_id()) is null
      or branch_id = (select public.current_user_branch_id())
    )
  );

comment on policy memberships_insert_with_permission on public.memberships is
  'Only membership:create may enrol a member, the membership arrives pending, and a branch-scoped profile may enrol only into their own branch.';

create policy memberships_update_with_permission
  on public.memberships
  for update
  to authenticated
  using (
    (
      (select public.user_has_permission('membership:update'))
      or (select public.user_has_permission('membership:manage_status'))
    )
    and (
      branch_id is null
      or (select public.current_user_branch_id()) is null
      or branch_id = (select public.current_user_branch_id())
    )
  )
  with check (
    (
      (select public.user_has_permission('membership:update'))
      or (select public.user_has_permission('membership:manage_status'))
    )
    and (
      branch_id is null
      or (select public.current_user_branch_id()) is null
      or branch_id = (select public.current_user_branch_id())
    )
  );

comment on policy memberships_update_with_permission on public.memberships is
  'Either membership-editing capability opens the row; which columns that caller may actually change is decided by memberships_guard_transition. A borrower holds neither, so a member cannot edit their own membership.';

-- ---------------------------------------------------------------------------
-- membership_status_history
--
-- SELECT only. No INSERT privilege for any session: rows are written by
-- `memberships_record_status`, a SECURITY DEFINER trigger, so the history
-- cannot be composed by hand. No UPDATE and no DELETE, on top of the
-- statement-level triggers that refuse both — two independent mechanisms,
-- because append-only is the entire value of the table.
--
-- No self-clause. These are the business's own notes about a member's
-- standing, including why they were suspended, and the reasoning is the same
-- as for `client_remarks`.
-- ---------------------------------------------------------------------------

grant select on table public.membership_status_history to authenticated;

create policy membership_status_history_select
  on public.membership_status_history
  for select
  to authenticated
  using ((select public.user_has_permission('membership:view')));

comment on policy membership_status_history_select on public.membership_status_history is
  'Staff holding membership:view only. No self-clause: a suspension reason is an internal decision written about the member.';

-- ---------------------------------------------------------------------------
-- membership_terms_acceptances
--
-- Staff who may see membership read them. A member reads their own, because
-- it is the record of what they personally signed and the one document in
-- this family they are most entitled to re-read.
--
-- SELECT and INSERT only. An acceptance is evidence: the guard refuses every
-- substantive edit, and there is no UPDATE privilege to reach the few fields
-- it would permit, so correcting one means recording a fresh acceptance.
-- ---------------------------------------------------------------------------

grant select, insert on table public.membership_terms_acceptances to authenticated;

create policy membership_terms_acceptances_select
  on public.membership_terms_acceptances
  for select
  to authenticated
  using (
    (select public.user_has_permission('membership:view'))
    or exists (
      select 1
      from public.memberships m
      join public.clients c on c.id = m.client_id
      where m.id = membership_terms_acceptances.membership_id
        and c.profile_id is not null
        and c.profile_id = (select public.current_profile_id())
    )
  );

comment on policy membership_terms_acceptances_select on public.membership_terms_acceptances is
  'Staff holding membership:view, and the member themselves — it is the record of what that person signed.';

create policy membership_terms_acceptances_insert
  on public.membership_terms_acceptances
  for insert
  to authenticated
  with check ((select public.user_has_permission('membership:create')));

comment on policy membership_terms_acceptances_insert on public.membership_terms_acceptances is
  'Taking the acceptance is part of enrolling a member, so it takes the same capability. Polytos Phase 2 owns the write path.';

-- ---------------------------------------------------------------------------
-- The register, as one read
--
-- `security_invoker`, like every other view in this schema. A reporting view
-- that ran as its owner would be the most valuable single object here: it
-- would hand every membership to any caller who could name it, whatever the
-- policies above say. Running as the invoker means the policies on
-- `memberships`, `clients` and `branches` all still apply, and a borrower
-- selecting from it sees exactly their own row.
--
-- It exists so the register is one round trip rather than a membership read
-- followed by a client read per row — the query waterfall the dashboard work
-- in Phases 17 and 19 was spent removing.
-- ---------------------------------------------------------------------------

create view public.membership_register
with (security_invoker = true) as
select
  m.id,
  m.membership_number,
  m.client_id,
  c.client_number,
  c.full_name,
  c.phone,
  c.village_area,
  c.district,
  c.status                as client_status,
  m.branch_id,
  b.name                  as branch_name,
  m.status,
  m.status_reason,
  m.status_changed_at,
  m.applied_on,
  m.activated_on,
  m.ended_on,
  m.policy_version_id,
  v.version               as policy_version,
  v.is_financially_enabled as policy_is_financially_enabled,
  m.notes,
  m.created_at,
  m.updated_at
from public.memberships m
join public.clients c on c.id = m.client_id
join public.membership_policy_versions v on v.id = m.policy_version_id
left join public.branches b on b.id = m.branch_id;

comment on view public.membership_register is
  'Polytos Phase 1. A membership with the member''s name and the policy version governing them, as one read. security_invoker, so every underlying policy still applies.';

revoke all on table public.membership_register from anon, authenticated;
grant select on table public.membership_register to authenticated;
