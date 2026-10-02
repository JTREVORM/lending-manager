-- ===========================================================================
-- Phase 5 — the schedule audit trail.
--
-- A trigger rather than an application call, for the reason established in
-- Phase 3: a trigger fires in the same transaction as the change, so the data
-- and the trail cannot disagree, and an audit call in a Server Action is
-- skipped by anything reaching the table another way.
--
-- ## One event, with the shape of the schedule and not its contents
--
-- Statement-level, so generating 91 daily collections produces one
-- `loan.schedule_generated` entry rather than 91 near-identical ones.
--
-- The metadata records what somebody auditing would need to recognise the
-- schedule — how many collections, between which dates, at what cadence, for
-- what total — and deliberately **not** the schedule itself. Dumping a few
-- hundred rows of JSON into the trail would make the audit log the largest
-- table in the system, and it would add nothing: the installments are
-- themselves append-only, so the trail has no history to preserve that the
-- rows do not already hold.
--
-- ## The actor
--
-- `current_profile_id()` and `auth.uid()` read session settings, which a
-- SECURITY DEFINER function does not change. So generation running inside
-- `disburse_loan` is attributed to the person who released the money, which
-- is correct — the schedule is a consequence of their act. No actor is ever
-- accepted from a caller.
-- ===========================================================================

create or replace function public.audit_loan_schedule_generated()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_loan_id    uuid;
  v_count      integer;
  v_first_due  date;
  v_final_due  date;
  v_total      bigint;
  v_schedule   public.loan_schedules;
begin
  -- The transition table is read through dynamic SQL, following the Phase 4
  -- pattern: `inserted` is not a schema-qualified relation, and this function
  -- runs with an empty search_path.
  execute
    'select loan_id,
            pg_catalog.count(*)::integer,
            pg_catalog.min(due_date),
            pg_catalog.max(due_date),
            pg_catalog.sum(expected_amount)
       from inserted
      group by loan_id
      limit 1'
    into v_loan_id, v_count, v_first_due, v_final_due, v_total;

  if v_loan_id is null then
    return null;
  end if;

  -- The cadence, from the header row the generator wrote just before these.
  select * into v_schedule from public.loan_schedules where loan_id = v_loan_id;

  insert into public.audit_log (
    actor_profile_id, actor_auth_user_id, actor_label,
    action, entity_type, entity_id, new_values
  )
  values (
    public.current_profile_id(), auth.uid(), public.audit_actor_label(),
    'loan.schedule_generated', 'loan', v_loan_id::text,
    pg_catalog.jsonb_build_object(
      'installment_count', v_count,
      'first_due_date', v_first_due,
      'final_due_date', v_final_due,
      -- The scheduled completion date under its own name. Phase 7 builds loan
      -- expiry, grace periods and penalties on this, and an auditor asking
      -- "when was this loan due to finish" should not have to infer it.
      'scheduled_completion_date', v_final_due,
      'total_scheduled_amount', v_total,
      'repayment_frequency', v_schedule.repayment_frequency,
      'interval_days', v_schedule.interval_days,
      'disbursement_date', v_schedule.disbursement_date,
      'generator_version', v_schedule.generator_version
      -- Deliberately not the installments. A few hundred rows of JSON would
      -- preserve nothing the append-only table does not already hold.
    )
  );

  return null;
end;
$$;

comment on function public.audit_loan_schedule_generated() is
  'AFTER INSERT statement-level on loan_installments: one event recording the shape of the generated schedule — count, first and final due date, cadence and total — never the rows themselves.';

create trigger audit_loan_schedule_generated
  after insert on public.loan_installments
  referencing new table as inserted
  for each statement
  execute function public.audit_loan_schedule_generated();

revoke all on function public.audit_loan_schedule_generated()
  from public, anon, authenticated;
