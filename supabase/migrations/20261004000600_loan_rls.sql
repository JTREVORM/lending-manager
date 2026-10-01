-- ===========================================================================
-- Phase 4 — Row Level Security for loans and their snapshots.
--
-- The boundary. Hidden buttons, guarded Server Actions and route protection
-- all exist to give people a coherent experience and to fail early; none of
-- them survives a caller who takes their own token and queries PostgREST
-- directly. So each policy below is written to be correct on its own,
-- assuming everything above it has been bypassed.
--
-- Two things carried from earlier phases:
--
--   * `public.current_profile_id()` resolves only *active* profiles, so
--     suspending a staff account takes effect on the next request rather than
--     when their token expires;
--   * there is **no DELETE grant anywhere in this migration**. Financial
--     history is not deletable; a loan is cancelled, and the privilege simply
--     is not there to be misused.
--
-- ## The borrower
--
-- A client's own loan view is a later phase. The policy is written now, and
-- it is deliberately narrow: a borrower may read their own loan rows once the
-- loan has been approved, and nothing else — no draft, no review note, no
-- guarantor data, no identity snapshot. No capability is granted to the
-- `client` role, so today the clause grants access to a borrower reading
-- their own record and to nobody else; the interface that uses it arrives
-- later.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- loans
-- ---------------------------------------------------------------------------

grant select, insert, update on table public.loans to authenticated;

create policy loans_select_own_or_register
  on public.loans
  for select
  to authenticated
  using (
    public.user_has_permission('loans:view')
    -- A borrower reads their own loans, and only once they are real
    -- agreements. A draft is the business thinking aloud; showing it would
    -- let a borrower see a loan being considered, and read a review note
    -- written about them.
    or (
      status in ('approved', 'active', 'cleared', 'cancelled')
      and exists (
        select 1 from public.clients c
        where c.id = loans.client_id
          and c.profile_id is not null
          and c.profile_id = public.current_profile_id()
      )
    )
  );

comment on policy loans_select_own_or_register on public.loans is
  'Staff with loans:view read the register. A linked borrower reads their own non-draft loans — the clause is prepared for the later client portal; no client capability is granted today.';

create policy loans_insert_with_permission
  on public.loans
  for insert
  to authenticated
  with check (
    public.user_has_permission('loans:create')
    -- A loan is born as a draft. Permitting any other status here would let
    -- whoever can create a loan also approve it, skipping review entirely.
    and status = 'draft'
    -- And born with nothing decided about it.
    and approved_at is null
    and approved_by is null
    and disbursed_at is null
    and disbursed_by is null
    and cancelled_at is null
    and submitted_at is null
  );

comment on policy loans_insert_with_permission on public.loans is
  'Only loans:create may start a loan, and it must arrive as a draft with no lifecycle attribution — otherwise creating would be approving.';

create policy loans_update_with_permission
  on public.loans
  for update
  to authenticated
  using (
    public.user_has_permission('loans:update_draft')
    or public.user_has_permission('loans:submit')
    or public.user_has_permission('loans:approve')
    or public.user_has_permission('loans:disburse')
    or public.user_has_permission('loans:cancel')
  )
  with check (
    public.user_has_permission('loans:update_draft')
    or public.user_has_permission('loans:submit')
    or public.user_has_permission('loans:approve')
    or public.user_has_permission('loans:disburse')
    or public.user_has_permission('loans:cancel')
  );

comment on policy loans_update_with_permission on public.loans is
  'Any lifecycle capability opens the row; which transition that caller may actually perform is decided by loans_guard_transition, per transition and per column.';

-- ---------------------------------------------------------------------------
-- loan_periods — the contractual breakdown
--
-- No INSERT policy for a session. The breakdown is written only by
-- `approve_loan`, which is SECURITY DEFINER and therefore runs as the table
-- owner, bypassing RLS. That is the point: nobody can write a breakdown by
-- hand, so the stored figures are always the ones the database computed.
-- ---------------------------------------------------------------------------

grant select on table public.loan_periods to authenticated;

create policy loan_periods_select_with_loan
  on public.loan_periods
  for select
  to authenticated
  using (
    -- Visible exactly when the loan is. The sub-select is itself subject to
    -- the policy above, so this is that rule rather than a second copy of it
    -- that could drift.
    exists (select 1 from public.loans l where l.id = loan_periods.loan_id)
  );

comment on policy loan_periods_select_with_loan on public.loan_periods is
  'Readable with its loan. No INSERT policy: only approve_loan writes a breakdown, so stored figures are always computed ones.';

-- ---------------------------------------------------------------------------
-- loan_client_snapshots
-- ---------------------------------------------------------------------------

grant select on table public.loan_client_snapshots to authenticated;

create policy loan_client_snapshots_select_with_permission
  on public.loan_client_snapshots
  for select
  to authenticated
  using (
    public.user_has_permission('loans:view')
    -- A borrower may read their own snapshot: it is their own name and
    -- address as the business recorded it, and seeing it is how an error gets
    -- reported.
    or exists (
      select 1 from public.clients c
      where c.id = loan_client_snapshots.client_id
        and c.profile_id is not null
        and c.profile_id = public.current_profile_id()
    )
  );

-- ---------------------------------------------------------------------------
-- loan_guarantor_snapshots
--
-- Staff only, with no borrower clause at all — the same rule Phase 3 applied
-- to `guarantors`. A guarantor's details are that person's data, disclosed to
-- the lender, not to the borrower who named them.
-- ---------------------------------------------------------------------------

grant select on table public.loan_guarantor_snapshots to authenticated;

create policy loan_guarantor_snapshots_select_with_permission
  on public.loan_guarantor_snapshots
  for select
  to authenticated
  using (public.user_has_permission('loans:view'));

comment on policy loan_guarantor_snapshots_select_with_permission on public.loan_guarantor_snapshots is
  'Staff holding loans:view only. No borrower clause, matching Phase 3: a guarantor''s details are disclosed to the lender, not to the borrower.';

-- ---------------------------------------------------------------------------
-- loan_identity_snapshots — the protected half
--
-- `loans:view_sensitive`, which the Manager and the Owner hold and the
-- Secretary/Treasurer does not. Without this separation, copying NINs onto a
-- loan would have handed every holder of `loans:view` the identity numbers
-- that Phase 3 went to some trouble to keep behind `clients:view_nin`.
--
-- No borrower clause. A borrower already knows their own number, and a table
-- that never shows one cannot leak one.
-- ---------------------------------------------------------------------------

grant select on table public.loan_identity_snapshots to authenticated;

create policy loan_identity_snapshots_select_with_permission
  on public.loan_identity_snapshots
  for select
  to authenticated
  using (public.user_has_permission('loans:view_sensitive'));

comment on policy loan_identity_snapshots_select_with_permission on public.loan_identity_snapshots is
  'Only loans:view_sensitive. A Secretary/Treasurer reads the loan register all day and reaches no identity number through it — see ADR-018 and ADR-022.';
