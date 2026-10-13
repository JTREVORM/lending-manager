-- ===========================================================================
-- Phase 14.2 — the chasing, written down
--
-- A loan in arrears gets worked: somebody rings the borrower, somebody walks
-- to the shop, somebody takes a promise to pay on Friday. Until now none of
-- that was anywhere. The arrears figure was visible and the effort against it
-- was invisible, which makes the one number the business can see — "fourteen
-- loans overdue" — impossible to act on, because nobody can tell which of the
-- fourteen were called yesterday and which have been untouched for a month.
--
-- ## Append-only, for the same reason remarks are
--
-- A recovery note is evidence of what was known and said at the counter. Its
-- whole value is that it cannot be quietly reworded once the loan goes bad, so
-- this table is append-only, enforced the way `audit_log` and `client_remarks`
-- are: statement-level BEFORE triggers that refuse UPDATE and DELETE outright,
-- rather than merely withholding grants. A mistake is corrected by appending a
-- correction, not by editing the past.
--
-- ## A promise is a recorded action, not a schedule change
--
-- "He will pay 200,000 on Friday" changes nothing contractual. The installment
-- is still due when it was due, the arrears figure is still what it is, and the
-- penalty clock keeps its own time. A promise is a staff member's record of
-- what a borrower said — so it lives here, beside the call that produced it,
-- and it is never allowed anywhere near the repayment schedule.
--
-- Whether a promise was kept is therefore *derived*, never stored: posted
-- payments on that loan between the promise and its date, measured against the
-- amount promised. Nothing has to remember to mark a promise broken, and a
-- reversal that undoes a payment un-keeps the promise automatically, because
-- the promise was only ever a question asked of the payments table.
-- ===========================================================================

create table public.loan_recovery_actions (
  id uuid primary key default gen_random_uuid(),
  loan_id uuid not null references public.loans(id) on delete restrict,

  action_kind text not null,

  -- What came of it. Null for the kinds where "outcome" is meaningless — a
  -- note has no outcome, it is one.
  outcome text,

  notes text not null,

  -- When this action happened. Supplied rather than derived, because a field
  -- officer records Tuesday's visit on Wednesday morning and the register
  -- should say Tuesday.
  action_date date not null default current_date,

  -- The next date somebody should come back to this loan. Independent of a
  -- promise: a call that reached nobody still earns a follow-up.
  follow_up_on date,

  -- The promise, complete or absent. Enforced as a group below.
  promised_amount bigint,
  promised_on date,

  created_by uuid references public.profiles(id) on delete restrict,
  created_by_label text not null default 'system',
  created_at timestamptz not null default pg_catalog.now(),

  -- A correction points at the action it corrects. The corrected action is
  -- not modified — nothing in this table ever is.
  corrects_action_id uuid references public.loan_recovery_actions(id) on delete restrict,

  constraint loan_recovery_actions_kind_valid check (action_kind in (
    'call', 'visit', 'message', 'letter', 'note', 'promise', 'correction'
  )),

  constraint loan_recovery_actions_outcome_valid check (outcome is null or outcome in (
    'reached', 'no_answer', 'wrong_number', 'refused_to_pay',
    'not_found', 'promised_to_pay', 'paid', 'disputed', 'deceased'
  )),

  -- An outcome belongs to an attempt at contact. A note or a correction is not
  -- an attempt at anything.
  constraint loan_recovery_actions_outcome_applies check (
    action_kind in ('call', 'visit', 'message', 'letter', 'promise')
    or outcome is null
  ),

  constraint loan_recovery_actions_notes_length
    check (char_length(btrim(notes)) between 3 and 2000),

  constraint loan_recovery_actions_action_date_not_future
    check (action_date <= current_date),

  -- Complete or none. A promised amount with no date is a figure nobody can
  -- ever call broken, and a date with no amount is a promise to pay something.
  constraint loan_recovery_actions_promise_complete check (
    (promised_amount is null) = (promised_on is null)
  ),
  constraint loan_recovery_actions_promise_required check (
    action_kind <> 'promise' or promised_amount is not null
  ),
  constraint loan_recovery_actions_promise_only_on_promise check (
    action_kind = 'promise' or promised_amount is null
  ),
  constraint loan_recovery_actions_promised_amount_positive check (
    (promised_amount is null)
    or (promised_amount > 0 and promised_amount <= 1000000000000)
  ),
  -- A promise is about the future at the moment it is made. `action_date` is
  -- the floor rather than today, so backdating Tuesday's visit still records a
  -- promise for Friday coherently.
  constraint loan_recovery_actions_promised_on_after_action check (
    promised_on is null or promised_on >= action_date
  ),
  constraint loan_recovery_actions_follow_up_after_action check (
    follow_up_on is null or follow_up_on >= action_date
  ),

  constraint loan_recovery_actions_correction_consistent check (
    (action_kind = 'correction' and corrects_action_id is not null)
    or (action_kind <> 'correction' and corrects_action_id is null)
  )
);

create index loan_recovery_actions_loan_idx
  on public.loan_recovery_actions (loan_id, action_date desc, created_at desc);

-- Partial, because the only question ever asked of this column is "what is
-- outstanding", and the overwhelming majority of rows have no follow-up.
create index loan_recovery_actions_follow_up_idx
  on public.loan_recovery_actions (follow_up_on)
  where follow_up_on is not null;

create index loan_recovery_actions_promise_idx
  on public.loan_recovery_actions (loan_id, promised_on)
  where promised_amount is not null;

comment on table public.loan_recovery_actions is
  'Append-only record of recovery effort against a loan: calls, visits, messages, letters, notes and promises to pay. Never updated or deleted; a mistake is corrected by appending a correction. A promise changes nothing contractual — whether it was kept is derived from posted payments.';
comment on column public.loan_recovery_actions.created_by_label is
  'The author''s name as it was when the action was recorded, so the register stays readable after the account is archived.';
comment on column public.loan_recovery_actions.promised_amount is
  'What the borrower said they would pay, on `promised_on`. Records a statement, not an obligation: no schedule, balance or penalty is computed from it.';

-- ---------------------------------------------------------------------------
-- Append-only, enforced
-- ---------------------------------------------------------------------------

create trigger loan_recovery_actions_no_update
  before update on public.loan_recovery_actions
  execute function public.reject_mutation();

create trigger loan_recovery_actions_no_delete
  before delete on public.loan_recovery_actions
  execute function public.reject_mutation();

-- ---------------------------------------------------------------------------
-- Authorship, and the two things a payload may not claim
-- ---------------------------------------------------------------------------

create or replace function public.loan_recovery_actions_stamp_author()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  v_label text;
  v_loan_status text;
  v_corrected_loan uuid;
begin
  v_actor := public.current_profile_id();

  if v_actor is not null then
    select p.full_name into v_label from public.profiles p where p.id = v_actor;
  end if;

  new.created_by := v_actor;
  new.created_by_label :=
    coalesce(nullif(pg_catalog.btrim(v_label), ''), 'system');

  select l.status into v_loan_status from public.loans l where l.id = new.loan_id;

  if v_loan_status is null then
    raise exception 'No such loan.' using errcode = 'P0001';
  end if;

  -- Recovery is work done against money that has gone out. A loan that was
  -- never disbursed has nothing to recover, and recording a collection call
  -- against a draft application would be a fiction.
  if v_loan_status in ('draft', 'pending_approval', 'approved', 'cancelled') then
    raise exception
      'There is nothing to recover on a % loan.', v_loan_status
      using errcode = 'P0001';
  end if;

  -- A correction must point at an action on the same loan, or it becomes a way
  -- to attach one borrower's history to another's file.
  if new.corrects_action_id is not null then
    select ra.loan_id into v_corrected_loan
      from public.loan_recovery_actions ra
     where ra.id = new.corrects_action_id;

    if v_corrected_loan is null then
      raise exception 'The action being corrected does not exist.'
        using errcode = 'P0001';
    end if;

    if v_corrected_loan <> new.loan_id then
      raise exception 'A correction must belong to the same loan as the action it corrects.'
        using errcode = 'P0001';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.loan_recovery_actions_stamp_author() is
  'Phase 14. Derives the author from the session, refuses recovery activity on a loan that was never disbursed, and keeps a correction on its own loan.';

revoke all on function public.loan_recovery_actions_stamp_author() from public, anon, authenticated;

create trigger loan_recovery_actions_stamp_author
  before insert on public.loan_recovery_actions
  for each row execute function public.loan_recovery_actions_stamp_author();

-- ---------------------------------------------------------------------------
-- Capabilities
-- ---------------------------------------------------------------------------

insert into public.permissions (key, description) values
  ('recovery:view', 'See the recovery history and follow-ups on a loan.'),
  ('recovery:record', 'Record a recovery action, follow-up or promise to pay.')
on conflict (key) do nothing;

insert into public.role_permissions (role_key, permission_key) values
  ('secretary_treasurer', 'recovery:view'),
  ('secretary_treasurer', 'recovery:record'),
  ('manager', 'recovery:view'),
  ('manager', 'recovery:record'),
  ('owner_admin', 'recovery:view'),
  ('owner_admin', 'recovery:record')
on conflict (role_key, permission_key) do nothing;

alter table public.loan_recovery_actions enable row level security;

revoke all on table public.loan_recovery_actions from anon, authenticated;
-- No UPDATE or DELETE grant, and triggers that refuse both regardless.
grant select, insert on table public.loan_recovery_actions to authenticated;

create policy loan_recovery_actions_select_with_permission
  on public.loan_recovery_actions for select to authenticated
  using (public.user_has_permission('recovery:view'));

create policy loan_recovery_actions_insert_with_permission
  on public.loan_recovery_actions for insert to authenticated
  with check (public.user_has_permission('recovery:record'));

-- ---------------------------------------------------------------------------
-- The register, and the derived promise verdict
-- ---------------------------------------------------------------------------

create view public.loan_recovery_register with (security_invoker = true) as
select
  ra.id,
  ra.loan_id,
  l.loan_number,
  l.status as loan_status,
  l.branch_id,
  l.client_id,
  c.client_number,
  c.full_name as client_name,
  c.phone as client_phone,
  p.product_code,
  p.name as product_name,
  ra.action_kind,
  ra.outcome,
  ra.notes,
  ra.action_date,
  ra.follow_up_on,
  ra.promised_amount,
  ra.promised_on,
  ra.corrects_action_id,
  ra.created_by,
  ra.created_by_label,
  ra.created_at,

  -- Superseded by a later correction. Shown rather than hidden: a reader
  -- should see both what was written and that it was corrected.
  exists (
    select 1 from public.loan_recovery_actions fix
     where fix.corrects_action_id = ra.id
  ) as is_corrected,

  -- What has actually been paid against a promise: posted payments on this
  -- loan from the day the promise was made through the day it was for. Null
  -- for every row that is not a promise, so the column reads as "not
  -- applicable" rather than as zero paid.
  case when ra.promised_amount is null then null else (
    select coalesce(sum(lp.amount), 0)::bigint
      from public.loan_payments lp
     where lp.loan_id = ra.loan_id
       and lp.status = 'posted'
       and public.payment_business_date(lp.received_at)
             between ra.action_date and ra.promised_on
  ) end as promise_paid_amount,

  case
    when ra.promised_amount is null then null
    when (
      select coalesce(sum(lp.amount), 0)
        from public.loan_payments lp
       where lp.loan_id = ra.loan_id
         and lp.status = 'posted'
         and public.payment_business_date(lp.received_at)
               between ra.action_date and ra.promised_on
    ) >= ra.promised_amount then 'kept'
    when ra.promised_on >= current_date then 'pending'
    else 'broken'
  end as promise_status
from public.loan_recovery_actions ra
join public.loans l on l.id = ra.loan_id
join public.clients c on c.id = l.client_id
join public.loan_products p on p.id = l.loan_product_id;

comment on view public.loan_recovery_register is
  'Phase 14. Every recovery action with its loan and borrower, whether a later correction supersedes it, and — for a promise — what was actually paid against it and whether it was kept, pending or broken. The verdict is derived from posted payments, so a reversal un-keeps a promise on its own.';

revoke all on public.loan_recovery_register from anon, authenticated;
grant select on public.loan_recovery_register to authenticated;

-- One row per loan: the state of the chase. This is what a Debt & Security
-- worklist is actually sorted by — not the individual actions, but "when was
-- this last touched, and what is owed next".
create view public.loan_recovery_status with (security_invoker = true) as
select
  l.id as loan_id,
  l.loan_number,
  l.status as loan_status,
  l.branch_id,
  l.client_id,
  c.client_number,
  c.full_name as client_name,
  c.phone as client_phone,
  p.product_code,
  p.name as product_name,
  d.arrears_amount,
  d.days_past_due,
  d.delinquency_state,
  d.total_outstanding,

  agg.action_count,
  agg.last_action_date,
  agg.last_action_kind,
  agg.last_action_notes,
  agg.last_action_by,

  -- The earliest follow-up still ahead of, or on, today — plus the earliest
  -- one already missed, which is the figure a supervisor actually wants.
  agg.next_follow_up_on,
  agg.overdue_follow_up_on,

  promise.promised_amount as open_promise_amount,
  promise.promised_on as open_promise_on,
  promise.promise_status as open_promise_status
from public.loans l
join public.clients c on c.id = l.client_id
join public.loan_products p on p.id = l.loan_product_id
left join public.loan_delinquency d on d.loan_id = l.id
left join (
  select
    ra.loan_id,
    count(*)::integer as action_count,
    max(ra.action_date) as last_action_date,
    (array_agg(ra.action_kind order by ra.action_date desc, ra.created_at desc))[1]
      as last_action_kind,
    (array_agg(ra.notes order by ra.action_date desc, ra.created_at desc))[1]
      as last_action_notes,
    (array_agg(ra.created_by_label order by ra.action_date desc, ra.created_at desc))[1]
      as last_action_by,
    min(ra.follow_up_on) filter (where ra.follow_up_on >= current_date)
      as next_follow_up_on,
    min(ra.follow_up_on) filter (where ra.follow_up_on < current_date)
      as overdue_follow_up_on
  from public.loan_recovery_actions ra
  group by ra.loan_id
) agg on agg.loan_id = l.id
left join (
  -- The most recent promise on each loan, with its derived verdict. "Most
  -- recent" rather than "all": a borrower who promises Friday and then
  -- re-promises Monday has one live promise, the later one.
  select distinct on (r.loan_id)
    r.loan_id,
    r.promised_amount,
    r.promised_on,
    r.promise_status
  from public.loan_recovery_register r
  where r.promised_amount is not null
  order by r.loan_id, r.action_date desc, r.created_at desc
) promise on promise.loan_id = l.id
where l.status in ('active', 'grace_period', 'arrears', 'cleared');

comment on view public.loan_recovery_status is
  'Phase 14. One row per disbursed loan: its arrears position, when it was last worked and by whom, the next and the missed follow-up, and the live promise to pay if there is one.';

revoke all on public.loan_recovery_status from anon, authenticated;
grant select on public.loan_recovery_status to authenticated;
