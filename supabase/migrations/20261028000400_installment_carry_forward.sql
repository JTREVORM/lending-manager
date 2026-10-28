-- ===========================================================================
-- Polytos business-policy update — rule 6: an unpaid installment is carried
-- into the following month's collection
-- ===========================================================================
--
-- > "If not paid, it has to be moved to the following month."
--
-- ## The thing this must not become
--
-- The obvious reading is "change the due date", and it is wrong. The due date
-- is contractual: it is what the member agreed to, what arrears are measured
-- from, what the delinquency engine ages, and what every report about whether
-- this book is being repaid on time depends on. Moving it would make a loan
-- that was three months late look current, and it would do so silently,
-- across the whole portfolio, in a way nobody could undo.
--
-- So nothing in this migration writes to `loan_installments`. Not the due
-- date, not the expected amount, not the principal or interest split. The
-- table keeps a `reject_mutation` guard on update and this file does not try
-- to work around it.
--
-- ## What a carry-forward actually is
--
-- It is a statement about **collection**, not about the contract: "this
-- amount was due in October, it was not paid, and it is on November's
-- collection list." The contract still says October. Both facts are true and
-- the business needs both — one to chase the money, one to know how late it
-- is.
--
-- `loan_installment_carry_forwards` is therefore append-only and additive. A
-- row says which installment, which month it came from, which month it is
-- being collected in, and how much was outstanding when it moved. The original
-- due date is copied onto the row as well, so a statement printed from the
-- carry-forward never loses sight of when the money was actually due.
--
-- ## What it is deliberately not
--
--   - **Not a reschedule.** A formal change to the contract goes through the
--     system's own amendment path, is agreed with the member and rewrites the
--     schedule on the record. This is the collection desk moving a line onto
--     next month's list.
--   - **Not interest.** Carrying an amount forward adds nothing to it. No
--     interest accrues on the carry, nothing is capitalised, and the amount
--     recorded is the amount that was outstanding — which is why
--     `loan_outstanding` is byte-for-byte unchanged by any number of
--     carry-forwards, and a test asserts exactly that.
--   - **Not a second receivable.** The unique index on (installment, target
--     month) means an installment can be carried into a given month once.
--     Running the function twice on the same day is a no-op, and the money is
--     never counted twice.
--   - **Not forgiveness.** A carried installment is still unpaid, still in
--     arrears, still aged by the delinquency engine from its original due
--     date. `loan_delinquency` and `loan_aging` are untouched.
--
-- ## The monthly anchor is still open, and this does not need it
--
-- `repayment_frequencies.month_anchor` — whether a loan disbursed on 31
-- January is collected on 28 February or 1 March — is a different question,
-- recorded as undecided in docs/POLYTOS-MEMBERSHIP-POLICY-DECISIONS.md, and
-- the client's sentence does not answer it. The `monthly` cadence stays
-- inactive with a NULL anchor.
--
-- A collection *period* needs no anchor: it is a calendar month in
-- Africa/Kampala, and "the following month" is the month after. So this works
-- today, for loans on every cadence, and answering the anchor later changes
-- nothing here.
-- ===========================================================================

create table public.loan_installment_carry_forwards (
  id                    uuid primary key default gen_random_uuid(),

  loan_id               uuid not null references public.loans(id)
                          on delete restrict,
  loan_number           text not null,
  installment_id        uuid not null references public.loan_installments(id)
                          on delete restrict,
  installment_number    integer not null,

  -- Copied, not joined. A statement printed from this row must say when the
  -- money was contractually due even if it is read in isolation, and the
  -- whole risk this table manages is the due date being lost sight of.
  original_due_date     date not null,

  -- Calendar months in Africa/Kampala, stored as their first day.
  carried_from_period   date not null,
  carried_to_period     date not null,

  -- What was outstanding at the moment of the carry. A record of the amount
  -- moved, not a live balance: the live balance is
  -- `loan_installment_coverage`, which this table does not affect.
  amount_outstanding    bigint not null,
  principal_outstanding bigint not null,
  interest_outstanding  bigint not null,

  reason                text not null,

  carried_by            uuid references public.profiles(id) on delete set null,
  carried_by_label      text not null,
  business_date         date not null,
  created_at            timestamptz not null default now(),

  constraint loan_carry_forward_periods_are_month_starts
    check (
      carried_from_period = pg_catalog.date_trunc('month', carried_from_period)::date
      and carried_to_period = pg_catalog.date_trunc('month', carried_to_period)::date
    ),
  constraint loan_carry_forward_moves_forward
    check (carried_to_period > carried_from_period),
  constraint loan_carry_forward_amounts_sane
    check (
      amount_outstanding > 0
      and principal_outstanding >= 0
      and interest_outstanding >= 0
      and principal_outstanding + interest_outstanding = amount_outstanding
    ),
  constraint loan_carry_forward_reason_length
    check (char_length(btrim(reason)) between 3 and 1000)
);

comment on table public.loan_installment_carry_forwards is
  'Polytos policy update, rule 6. An unpaid installment moved onto a later month''s collection list. Append-only and additive: the installment itself is never rewritten, the original due date is copied here, no interest is added, and loan_outstanding is unchanged by any number of these rows. A statement about collection, not about the contract.';

comment on column public.loan_installment_carry_forwards.original_due_date is
  'The installment''s contractual due date, copied so that a carry-forward read on its own still says when the money was due. Arrears and ageing are measured from this date and not from carried_to_period.';

create unique index loan_carry_forward_once_per_target_month
  on public.loan_installment_carry_forwards (installment_id, carried_to_period);

create index loan_carry_forward_loan_idx
  on public.loan_installment_carry_forwards (loan_id, carried_to_period desc);

create index loan_carry_forward_period_idx
  on public.loan_installment_carry_forwards (carried_to_period, loan_id);

create trigger loan_installment_carry_forwards_no_update
  before update on public.loan_installment_carry_forwards
  for each row execute function public.reject_mutation();

create trigger loan_installment_carry_forwards_no_delete
  before delete on public.loan_installment_carry_forwards
  for each row execute function public.reject_mutation();

-- ---------------------------------------------------------------------------
-- Where an installment is being collected
-- ---------------------------------------------------------------------------

create view public.loan_collection_schedule
with (security_invoker = true) as
select
  c.loan_id,
  l.loan_number,
  l.client_id,
  l.branch_id,
  l.status            as loan_status,
  c.installment_id,
  c.installment_number,
  -- The contract.
  c.due_date          as original_due_date,
  c.expected_amount,
  c.scheduled_principal,
  c.scheduled_interest,
  -- What has been paid against it, and what is left.
  c.allocated_amount,
  c.remaining_amount,
  c.remaining_principal,
  c.remaining_interest,
  -- Collection. The month the obligation now sits in is the latest month it
  -- has been carried into, or its own due month if it has never been carried.
  coalesce(
    (select pg_catalog.max(cf.carried_to_period)
       from public.loan_installment_carry_forwards cf
      where cf.installment_id = c.installment_id),
    pg_catalog.date_trunc('month', c.due_date)::date
  )                   as collection_period,
  coalesce(
    (select pg_catalog.count(*)
       from public.loan_installment_carry_forwards cf
      where cf.installment_id = c.installment_id),
    0
  )::integer          as carry_forward_count,
  -- Days late, from the **contractual** date. A carry-forward does not make a
  -- late installment less late, and this column is what says so on a screen.
  greatest(public.business_date() - c.due_date, 0)::integer as days_past_due
from public.loan_installment_coverage c
join public.loans l on l.id = c.loan_id;

comment on view public.loan_collection_schedule is
  'Polytos policy update. Every installment with both of its dates: the contractual due date it is measured from, and the collection period it is currently being chased in after any carry-forwards. days_past_due is counted from the contractual date, so carrying an installment forward never makes it look less late.';

revoke all on table public.loan_collection_schedule from anon, authenticated;
grant select on table public.loan_collection_schedule to authenticated;

-- ---------------------------------------------------------------------------
-- Carrying the unpaid ones forward
-- ---------------------------------------------------------------------------

create or replace function public.carry_forward_unpaid_installments(
  p_loan_id uuid,
  p_as_of date default null,
  p_reason text default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_loan    public.loans;
  v_actor   uuid;
  v_label   text;
  v_as_of   date;
  v_month   date;
  v_target  date;
  v_reason  text;
  v_count   integer := 0;
  v_row     record;
begin
  v_actor := public.current_profile_id();
  v_label := public.audit_actor_label();

  if v_actor is null and auth.uid() is not null then
    raise exception
      'A carry-forward must be recorded by a signed-in member of staff.'
      using errcode = 'P0001';
  end if;

  -- The collection desk's own capability. Recording that an unpaid line moves
  -- onto next month's list is the same kind of act as recording a payment
  -- against it, and it changes no contract — so it is `payments:create`
  -- rather than a capability of its own.
  if auth.uid() is not null and not public.user_has_permission('payments:create') then
    raise exception
      'Carrying an unpaid installment forward requires the payments:create capability.'
      using errcode = '42501';
  end if;

  select * into v_loan from public.loans where id = p_loan_id;

  if not found then
    raise exception 'No such loan.' using errcode = 'P0001';
  end if;

  if not public.user_can_see_branch(v_loan.branch_id) then
    raise exception 'You cannot work that branch''s collections.'
      using errcode = '42501';
  end if;

  if v_loan.status <> 'active' then
    raise exception
      'Loan % is %. Only an active loan has a collection list.',
      v_loan.loan_number, v_loan.status using errcode = 'P0001';
  end if;

  -- One loan at a time, serialised against a concurrent run of the same loan.
  -- The unique index would catch a duplicate anyway; the lock makes a repeat
  -- an orderly no-op rather than a constraint violation.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('carry_forward:' || p_loan_id::text)
  );

  v_as_of := coalesce(p_as_of, public.business_date());
  v_month := pg_catalog.date_trunc('month', v_as_of)::date;
  v_target := (v_month + interval '1 month')::date;
  v_reason := coalesce(
    nullif(pg_catalog.btrim(coalesce(p_reason, '')), ''),
    'Unpaid at the end of the ' || pg_catalog.to_char(v_month, 'FMMonth YYYY')
      || ' collection period.');

  for v_row in
    select s.installment_id, s.installment_number, s.original_due_date,
           s.remaining_amount, s.remaining_principal, s.remaining_interest,
           s.collection_period
    from public.loan_collection_schedule s
    where s.loan_id = p_loan_id
      and s.remaining_amount > 0
      -- Due on or before the as-of date: a future installment is not unpaid,
      -- it is simply not due yet.
      and s.original_due_date <= v_as_of
      -- Already sitting in a later month's list: carrying it again from this
      -- month would move it twice for one missed collection.
      and s.collection_period <= v_month
    order by s.installment_number
  loop
    insert into public.loan_installment_carry_forwards (
      loan_id, loan_number, installment_id, installment_number,
      original_due_date, carried_from_period, carried_to_period,
      amount_outstanding, principal_outstanding, interest_outstanding,
      reason, carried_by, carried_by_label, business_date
    )
    values (
      p_loan_id, v_loan.loan_number, v_row.installment_id, v_row.installment_number,
      v_row.original_due_date, v_row.collection_period, v_target,
      v_row.remaining_amount, v_row.remaining_principal, v_row.remaining_interest,
      v_reason, v_actor, v_label, v_as_of
    )
    on conflict (installment_id, carried_to_period) do nothing;

    if found then
      v_count := v_count + 1;
    end if;
  end loop;

  return v_count;
end;
$$;

comment on function public.carry_forward_unpaid_installments(uuid, date, text) is
  'Polytos policy update, rule 6. Moves every unpaid or part-paid installment of an active loan onto the following month''s collection list. Writes only to loan_installment_carry_forwards: no due date, expected amount, allocation, penalty or ledger entry changes, and loan_outstanding is identical before and after. Idempotent — running it twice in the same month adds nothing.';

grant execute on function public.carry_forward_unpaid_installments(uuid, date, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- What is on a month's collection list
-- ---------------------------------------------------------------------------

create or replace function public.loan_collection_period_total(
  p_loan_id uuid,
  p_period date
)
returns bigint
language sql
stable
set search_path = ''
as $$
  select coalesce(pg_catalog.sum(s.remaining_amount), 0)::bigint
  from public.loan_collection_schedule s
  where s.loan_id = p_loan_id
    and s.collection_period = pg_catalog.date_trunc('month', p_period)::date
    and s.remaining_amount > 0;
$$;

comment on function public.loan_collection_period_total(uuid, date) is
  'Polytos policy update. What a loan owes on one month''s collection list: the installments due in that month plus any carried into it, counted once each. Never more than the loan''s own outstanding balance, because a carry-forward moves an obligation rather than copying it.';

grant execute on function public.loan_collection_period_total(uuid, date) to authenticated;


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

revoke all on table public.loan_installment_carry_forwards from anon, authenticated;
revoke all on function public.carry_forward_unpaid_installments(uuid, date, text) from public, anon;
