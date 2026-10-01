-- ===========================================================================
-- Phase 4 — the loan audit trail.
--
-- Triggers rather than application calls, for the reason established in
-- Phase 3: a trigger fires in the same transaction as the change, so the data
-- and the trail cannot disagree, and an audit call in a Server Action is
-- skipped by anything that reaches the table another way.
--
-- ## What is deliberately not recorded
--
-- **No identity data, and no snapshot contents.** `audit_log` is readable by
-- `audit:view`, which is a different and broader capability than
-- `loans:view_sensitive`. Dumping a snapshot into audit metadata would make
-- the identity separation pointless — a reader with `audit:view` would see
-- every NIN the business ever captured.
--
-- So a snapshot event records that a snapshot was captured, for which loan,
-- and how many rows. The contents stay in the tables their policies protect.
--
-- The loan's *commercial* figures are recorded in full. They are not
-- sensitive — they are the agreement — and a dispute about what was approved
-- is exactly what the trail is for.
-- ===========================================================================

create or replace function public.audit_loan_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_action text;
  v_old    jsonb;
  v_new    jsonb;
begin
  if tg_op = 'INSERT' then
    v_action := 'loan.created';
    v_new := pg_catalog.jsonb_build_object(
      'loan_number', new.loan_number,
      'client_id', new.client_id,
      'principal_amount', new.principal_amount,
      'loan_term_months', new.loan_term_months,
      'repayment_frequency', new.repayment_frequency,
      'proposed_disbursement_date', new.proposed_disbursement_date,
      'status', new.status
    );
  else
    -- One change, one name. A status transition is recorded as that
    -- transition, because that is the event somebody will later search for.
    if new.status is distinct from old.status then
      v_action := case new.status
        when 'pending_approval' then
          case when old.status = 'draft' then 'loan.submitted' else 'loan.updated' end
        when 'approved'  then 'loan.approved'
        when 'active'    then 'loan.disbursed'
        when 'cancelled' then 'loan.cancelled'
        when 'cleared'   then 'loan.cleared'
        when 'draft'     then 'loan.returned_to_draft'
        else 'loan.updated'
      end;
    else
      v_action := 'loan.updated';
    end if;

    v_old := pg_catalog.jsonb_build_object(
      'status', old.status,
      'principal_amount', old.principal_amount,
      'interest_rate_bps', old.interest_rate_bps,
      'loan_term_months', old.loan_term_months,
      'repayment_frequency', old.repayment_frequency,
      'total_interest', old.total_interest,
      'total_expected_repayment', old.total_expected_repayment
    );
    v_new := pg_catalog.jsonb_build_object(
      'status', new.status,
      'principal_amount', new.principal_amount,
      'interest_rate_bps', new.interest_rate_bps,
      'interest_method', new.interest_method,
      'loan_term_months', new.loan_term_months,
      'repayment_frequency', new.repayment_frequency,
      'total_interest', new.total_interest,
      'total_expected_repayment', new.total_expected_repayment,
      'cancellation_reason', new.cancellation_reason
    );
  end if;

  insert into public.audit_log (
    actor_profile_id, actor_auth_user_id, actor_label,
    action, entity_type, entity_id, old_values, new_values
  )
  values (
    public.current_profile_id(), auth.uid(), public.audit_actor_label(),
    v_action, 'loan', new.id::text, v_old, v_new
  );

  return null;
end;
$$;

comment on function public.audit_loan_change() is
  'AFTER INSERT/UPDATE on loans. Records the commercial figures in full — they are the agreement — and no identity data.';

create trigger audit_loan_change
  after insert or update on public.loans
  for each row execute function public.audit_loan_change();

-- ---------------------------------------------------------------------------
-- Snapshot capture
--
-- One event per snapshot table, recording that it happened and how much was
-- captured. Statement-level, so approving a loan with three guarantors
-- produces one event saying three rather than three near-identical events.
-- ---------------------------------------------------------------------------

create or replace function public.audit_loan_snapshot_created()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_loan_id uuid;
  v_count   integer;
begin
  -- `tg_argv[0]` names the snapshot kind, so one function serves all four
  -- tables rather than four near-identical ones.
  execute pg_catalog.format(
    'select loan_id, pg_catalog.count(*)::integer from inserted group by loan_id limit 1'
  ) into v_loan_id, v_count;

  if v_loan_id is null then
    return null;
  end if;

  insert into public.audit_log (
    actor_profile_id, actor_auth_user_id, actor_label,
    action, entity_type, entity_id, new_values
  )
  values (
    public.current_profile_id(), auth.uid(), public.audit_actor_label(),
    'loan.snapshot_created', 'loan', v_loan_id::text,
    pg_catalog.jsonb_build_object(
      -- The kind and the row count. Never the contents: audit:view is broader
      -- than loans:view_sensitive, and a snapshot in the trail would hand
      -- every identity number to anyone who can read the trail.
      'snapshot', tg_argv[0],
      'rows_captured', v_count
    )
  );

  return null;
end;
$$;

comment on function public.audit_loan_snapshot_created() is
  'AFTER INSERT statement-level on each loan snapshot table: records that a snapshot was captured and how many rows, never its contents.';

create trigger audit_loan_periods_created
  after insert on public.loan_periods
  referencing new table as inserted
  for each statement
  execute function public.audit_loan_snapshot_created('periods');

create trigger audit_loan_client_snapshot_created
  after insert on public.loan_client_snapshots
  referencing new table as inserted
  for each statement
  execute function public.audit_loan_snapshot_created('client');

create trigger audit_loan_guarantor_snapshot_created
  after insert on public.loan_guarantor_snapshots
  referencing new table as inserted
  for each statement
  execute function public.audit_loan_snapshot_created('guarantor');

create trigger audit_loan_identity_snapshot_created
  after insert on public.loan_identity_snapshots
  referencing new table as inserted
  for each statement
  execute function public.audit_loan_snapshot_created('identity');

-- ---------------------------------------------------------------------------
-- Terms locked
--
-- A distinct event at the moment a loan's commercial terms become immutable,
-- because "when did this stop being editable" is a question an auditor asks
-- and the status history alone answers only indirectly.
-- ---------------------------------------------------------------------------

create or replace function public.audit_loan_terms_locked()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.audit_log (
    actor_profile_id, actor_auth_user_id, actor_label,
    action, entity_type, entity_id, new_values
  )
  values (
    public.current_profile_id(), auth.uid(), public.audit_actor_label(),
    'loan.terms_locked', 'loan', new.id::text,
    pg_catalog.jsonb_build_object(
      'principal_amount', new.principal_amount,
      'interest_rate_bps', new.interest_rate_bps,
      'interest_method', new.interest_method,
      'loan_term_months', new.loan_term_months,
      'repayment_frequency', new.repayment_frequency,
      'total_interest', new.total_interest,
      'total_expected_repayment', new.total_expected_repayment,
      'grace_period_days_applied', new.grace_period_days_applied,
      'penalty_rate_bps_applied', new.penalty_rate_bps_applied
    )
  );

  return null;
end;
$$;

comment on function public.audit_loan_terms_locked() is
  'AFTER UPDATE on loans becoming approved: records the exact terms that became immutable, so "what was agreed" has a single authoritative entry.';

create trigger audit_loan_terms_locked
  after update on public.loans
  for each row
  when (new.status = 'approved' and old.status <> 'approved')
  execute function public.audit_loan_terms_locked();

revoke all on function public.audit_loan_change() from public, anon, authenticated;
revoke all on function public.audit_loan_snapshot_created() from public, anon, authenticated;
revoke all on function public.audit_loan_terms_locked() from public, anon, authenticated;
