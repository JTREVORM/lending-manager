-- ===========================================================================
-- Phase 10.2 — Head Office, the chart, Bank as a payment method, and the
-- historical backfill
--
-- ## The accounting model
--
-- Income is recognised when it is **collected**, not when it is charged.
-- That is the model the brief states:
--
--     Dr Cash / MTN / Airtel / Bank
--       Cr Loans Receivable        (the principal component)
--       Cr Interest Income         (the interest component)
--       Cr Penalty Income          (the penalty component)
--
-- Two consequences follow, and both are deliberate.
--
-- `Loans Receivable` carries **principal only**. It is the money paid out
-- less the principal component of what has come back, which is exactly the
-- figure `dashboard_portfolio_summary.principal_outstanding` already
-- reports. Interest that has been charged but not yet received is not an
-- asset here; it is simply not yet income.
--
-- Charging a penalty therefore posts **nothing**. No money moves, and under
-- cash-basis recognition no income arises until the borrower pays it. The
-- penalty appears in the ledger through the `allocated_penalty` component of
-- the repayment that settles it. `ensure_penalty_applied` consequently needs
-- no ledger wiring, which is why it is absent from the next migration.
--
-- ## Which account funded the historical disbursements
--
-- `loans` records no disbursement method — there is no column for one and
-- never was. So this is an attribution, not a fact recovered from the data,
-- and it is stated here rather than buried: **every historical disbursement
-- is posted out of Cash at Hand**. These are small shilling advances to
-- market traders, mechanics and food vendors, which a lender of this size
-- hands over at the counter. Splitting them across accounts would be
-- inventing financial activity, which this backfill must not do.
--
-- ## How the opening capital was derived
--
-- Not chosen. Computed.
--
-- Replaying every disbursement and every posted payment in timestamp order
-- against Cash at Hand, the running balance reaches its lowest point of
-- **−21,449,163** on 2026-09-29. MTN and Airtel never go negative at any
-- point (their lowest points are +52,000 and +58,500, both after their first
-- inflow), and the bank account has no historical movement at all.
--
-- So the opening entry is **21,449,163 into Cash at Hand**, dated the day
-- before the first disbursement. That is the smallest figure that keeps the
-- cash position non-negative throughout its whole history, and not one
-- shilling more: Cash at Hand touches exactly zero at its lowest point. A
-- rounder, larger number would have made the dashboard look better and the
-- figure arbitrary.
--
-- The resulting books:
--
--   Cash at Hand      1,846,418     Owner Capital    21,449,163
--   MTN              10,974,067     Interest Income   4,448,123
--   Airtel            4,115,545     Penalty Income       17,441
--   Cash at Bank              0
--   Loans Receivable  8,978,697
--   ------------------------------------------------------------
--                    25,914,727                      25,914,727
--
-- ## Idempotency
--
-- A unique index on `(source_type, source_id)` makes a duplicate journal for
-- the same event impossible at the storage level, and `backfill_ledger_history`
-- skips any event it has already posted. Running it twice is a no-op, which
-- is asserted by a test rather than assumed.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- One event, one journal
-- ---------------------------------------------------------------------------

create unique index journal_entries_one_per_source
  on public.journal_entries (source_type, source_id)
  where source_id is not null;

comment on index public.journal_entries_one_per_source is
  'Phase 10. An event posts once. A second journal for the same disbursement, payment or reversal is refused by the index rather than detected afterwards.';

-- ---------------------------------------------------------------------------
-- Branch assignment for the records that belong to one
-- ---------------------------------------------------------------------------

alter table public.clients add column branch_id uuid references public.branches(id) on delete restrict;
alter table public.loans add column branch_id uuid references public.branches(id) on delete restrict;

comment on column public.clients.branch_id is
  'Phase 10. The branch that holds this client''s relationship. Backfilled to Head Office.';
comment on column public.loans.branch_id is
  'Phase 10. The branch that issued this loan. The journals for its disbursement and repayments carry the same branch.';

create index clients_branch_idx on public.clients (branch_id);
create index loans_branch_idx on public.loans (branch_id);

-- ---------------------------------------------------------------------------
-- Bank as a fourth payment method
--
-- The constraint listed three. The two companion constraints need no change
-- and are deliberately left alone: a bank transfer is not cash, so it falls
-- into the branch that *requires* an external reference — which is right,
-- because a bank transfer always has one and a payment that cannot be traced
-- back to a bank statement is not reconcilable.
-- ---------------------------------------------------------------------------

alter table public.loan_payments drop constraint loan_payments_method_valid;
alter table public.loan_payments add constraint loan_payments_method_valid
  check (payment_method in ('cash', 'mtn_mobile_money', 'airtel_money', 'bank'));

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create or replace function public.payment_method_cash_kind(p_method text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_method
    when 'cash' then 'cash_at_hand'
    when 'mtn_mobile_money' then 'mtn_mobile_money'
    when 'airtel_money' then 'airtel_money'
    when 'bank' then 'bank'
  end;
$$;

comment on function public.payment_method_cash_kind(text) is
  'Phase 10. The account a payment by this method lands in. NULL for an unknown method, which the callers treat as an error rather than a default.';

revoke all on function public.payment_method_cash_kind(text) from public, anon, authenticated;
grant execute on function public.payment_method_cash_kind(text) to authenticated;

create or replace function public.branch_cash_account(p_branch_id uuid, p_cash_kind text)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  select a.id into v_id
  from public.ledger_accounts a
  where a.branch_id = p_branch_id
    and a.cash_kind = p_cash_kind
    and a.status = 'active'
  order by a.code
  limit 1;

  if v_id is null then
    raise exception
      'This branch has no active % account. Money cannot be moved through an account that does not exist.',
      p_cash_kind
      using errcode = 'P0001';
  end if;

  return v_id;
end;
$$;

comment on function public.branch_cash_account(uuid, text) is
  'Phase 10. The branch''s account of a given kind. Raises rather than returning NULL, so a missing account stops the transaction instead of producing a journal with a null leg.';

revoke all on function public.branch_cash_account(uuid, text) from public, anon, authenticated;

create or replace function public.ledger_account_by_code(p_code text)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  select a.id into v_id from public.ledger_accounts a where a.code = p_code;

  if v_id is null then
    raise exception 'No ledger account with code %.', p_code using errcode = 'P0001';
  end if;

  return v_id;
end;
$$;

revoke all on function public.ledger_account_by_code(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Posting
--
-- The one way a journal is written. Takes the whole entry — header and every
-- line — so a half-posted journal is not a state this function can leave
-- behind, and the deferred balance check sees a complete entry.
-- ---------------------------------------------------------------------------

create or replace function public.post_journal(
  p_branch_id uuid,
  p_entry_date date,
  p_description text,
  p_source_type text,
  p_source_id uuid,
  p_loan_id uuid,
  p_client_id uuid,
  p_lines jsonb,
  p_posted_at timestamptz default null,
  p_created_by uuid default null,
  p_created_by_label text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entry_id uuid;
  v_line     jsonb;
  v_number   smallint := 0;
  v_debit    bigint;
  v_credit   bigint;
begin
  insert into public.journal_entries (
    entry_number, branch_id, entry_date, posted_at, description,
    source_type, source_id, loan_id, client_id, created_by, created_by_label
  )
  values (
    public.next_reference('journal'),
    p_branch_id,
    p_entry_date,
    coalesce(p_posted_at, pg_catalog.now()),
    p_description,
    p_source_type,
    p_source_id,
    p_loan_id,
    p_client_id,
    coalesce(p_created_by, public.current_profile_id()),
    coalesce(nullif(pg_catalog.btrim(coalesce(p_created_by_label, '')), ''),
             public.audit_actor_label())
  )
  returning id into v_entry_id;

  for v_line in select * from pg_catalog.jsonb_array_elements(p_lines)
  loop
    v_debit := coalesce((v_line ->> 'debit')::bigint, 0);
    v_credit := coalesce((v_line ->> 'credit')::bigint, 0);

    -- A component that is zero is not a line. A repayment that happened to
    -- cover no penalty should not carry an empty penalty leg, and the
    -- one-side constraint would refuse it anyway.
    continue when v_debit = 0 and v_credit = 0;

    v_number := v_number + 1;

    insert into public.journal_lines
      (entry_id, line_number, account_id, debit, credit, memo)
    values
      (v_entry_id, v_number, (v_line ->> 'account_id')::uuid, v_debit, v_credit,
       nullif(pg_catalog.btrim(coalesce(v_line ->> 'memo', '')), ''));
  end loop;

  return v_entry_id;
end;
$$;

comment on function public.post_journal(uuid, date, text, text, uuid, uuid, uuid, jsonb, timestamptz, uuid, text) is
  'Phase 10. The only way a journal is written. Zero-amount components are dropped rather than posted as empty legs; the deferred balance check then sees a complete, balanced entry.';

revoke all on function public.post_journal(uuid, date, text, text, uuid, uuid, uuid, jsonb, timestamptz, uuid, text)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Head Office, and the chart of accounts
-- ---------------------------------------------------------------------------

do $seed$
declare
  v_branch uuid;
  v_code   text;
  v_owner  uuid;
begin
  if exists (select 1 from public.branches) then
    return;
  end if;

  select p.id into v_owner
  from public.profiles p
  join public.user_roles ur on ur.profile_id = p.id
  where ur.role_key = 'owner_admin'
  order by p.created_at
  limit 1;

  v_code := public.next_reference('branch');

  insert into public.branches
    (branch_code, name, location, district, status, opened_on, created_by, notes)
  values
    (v_code, 'Head Office', 'Plot 14, Kyanja Ring Road', 'Kampala', 'active',
     (select coalesce(pg_catalog.min(l.disbursed_at)::date, current_date) - 1
        from public.loans l),
     v_owner,
     'The branch every client and loan predating the branch network belongs to.')
  returning id into v_branch;

  -- The four places money sits, one set per branch.
  insert into public.ledger_accounts
    (code, name, account_type, normal_side, cash_kind, branch_id, description)
  values
    ('1010-' || v_code, 'Cash at Hand — Head Office', 'asset', 'debit',
     'cash_at_hand', v_branch, 'Notes and coin in the office.'),
    ('1020-' || v_code, 'MTN Mobile Money — Head Office', 'asset', 'debit',
     'mtn_mobile_money', v_branch, 'The MTN merchant float.'),
    ('1030-' || v_code, 'Airtel Money — Head Office', 'asset', 'debit',
     'airtel_money', v_branch, 'The Airtel merchant float.'),
    ('1040-' || v_code, 'Cash at Bank — Head Office', 'asset', 'debit',
     'bank', v_branch, 'The business bank account.');

  -- Everything that is not cash is company-wide and sliced by the branch on
  -- the entry. See the note in migration 20261010000100.
  insert into public.ledger_accounts
    (code, name, account_type, normal_side, description)
  values
    ('1200', 'Loans Receivable', 'asset', 'debit',
     'Principal paid out and not yet recovered. Principal only: interest charged but not received is not an asset under this model.'),
    ('3000', 'Owner Capital', 'equity', 'credit',
     'Money the owner has put into the business.'),
    ('4100', 'Interest Income', 'income', 'credit',
     'The interest component of payments actually received.'),
    ('4200', 'Penalty Income', 'income', 'credit',
     'The late-charge component of payments actually received.');
end
$seed$;

-- Every client and loan that predates the branch network belongs to Head
-- Office. Written before the NOT NULL below, which is what makes the column
-- mandatory from here on without rewriting history.
update public.clients set branch_id = (select id from public.branches order by branch_code limit 1)
 where branch_id is null;
update public.loans set branch_id = (select id from public.branches order by branch_code limit 1)
 where branch_id is null;

-- ---------------------------------------------------------------------------
-- Branch stamping
--
-- The column is mandatory from here on, but nothing that creates a client or
-- a loan today knows branches exist — not the server actions, not the test
-- harness, not a hand-written INSERT. Making the column NOT NULL without
-- this would break client registration and loan creation outright, which is
-- the opposite of preserving working functionality.
--
-- So the database supplies it. A loan takes its borrower's branch, because a
-- loan is issued where the relationship is held; a client with no branch
-- named takes the primary one. When Phase 2 gives the UI a branch picker it
-- passes a value and these stop firing, without anything here changing.
-- ---------------------------------------------------------------------------

create or replace function public.clients_stamp_branch()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.branch_id is null then
    select b.id into new.branch_id
    from public.branches b
    where b.status = 'active'
    order by b.opened_on, b.branch_code
    limit 1;
  end if;

  if new.branch_id is null then
    raise exception
      'No active branch exists, so this client cannot be placed in one.'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

revoke all on function public.clients_stamp_branch() from public, anon, authenticated;

create trigger clients_stamp_branch
  before insert on public.clients
  for each row execute function public.clients_stamp_branch();

create or replace function public.loans_stamp_branch()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.branch_id is null then
    select c.branch_id into new.branch_id
    from public.clients c
    where c.id = new.client_id;
  end if;

  if new.branch_id is null then
    raise exception
      'This loan has no branch and its borrower has none either.'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

revoke all on function public.loans_stamp_branch() from public, anon, authenticated;

create trigger loans_stamp_branch
  before insert on public.loans
  for each row execute function public.loans_stamp_branch();

alter table public.clients alter column branch_id set not null;
alter table public.loans alter column branch_id set not null;

-- ---------------------------------------------------------------------------
-- The three postings, as functions
--
-- One implementation each, used by both the historical backfill below and
-- the live money functions in the next migration. Writing them twice — once
-- to derive history and once to post new events — is how the two drift until
-- an old payment and a new one book differently.
--
-- Each reads the records rather than taking figures as arguments, so it
-- cannot be handed a number that disagrees with the ledger it is posting
-- for, and each returns NULL when the event is already posted.
-- ---------------------------------------------------------------------------

create or replace function public.post_disbursement_journal(p_loan_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  r      record;
  v_tz   text := public.business_timezone();
begin
  select l.id, l.loan_number, l.client_id, l.principal_amount, l.disbursed_at,
         l.disbursed_by, l.branch_id, coalesce(pr.full_name, 'system') as actor
    into r
  from public.loans l
  left join public.profiles pr on pr.id = l.disbursed_by
  where l.id = p_loan_id;

  if r.id is null then
    raise exception 'No such loan.' using errcode = 'P0001';
  end if;

  if r.disbursed_at is null then
    raise exception 'Loan % has not been disbursed; there is nothing to post.', r.loan_number
      using errcode = 'P0001';
  end if;

  if exists (select 1 from public.journal_entries e
              where e.source_type = 'loan_disbursement' and e.source_id = r.id) then
    return null;
  end if;

  return public.post_journal(
    r.branch_id,
    (r.disbursed_at at time zone v_tz)::date,
    'Loan ' || r.loan_number || ' disbursed',
    'loan_disbursement', r.id, r.id, r.client_id,
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'account_id', public.ledger_account_by_code('1200'),
        'debit', r.principal_amount, 'credit', 0, 'memo', 'Principal advanced'),
      pg_catalog.jsonb_build_object(
        'account_id', public.branch_cash_account(r.branch_id, 'cash_at_hand'),
        'debit', 0, 'credit', r.principal_amount, 'memo', 'Paid out at the counter')
    ),
    r.disbursed_at, r.disbursed_by, r.actor
  );
end;
$$;

comment on function public.post_disbursement_journal(uuid) is
  'Phase 10. Dr Loans Receivable, Cr the branch Cash at Hand. The funding account is Cash at Hand because `loans` records no disbursement method; see the note at the head of this migration.';

revoke all on function public.post_disbursement_journal(uuid) from public, anon, authenticated;

create or replace function public.post_repayment_journal(p_payment_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  r    record;
  v_tz text := public.business_timezone();
begin
  select p.id, p.payment_number, p.loan_id, p.client_id, p.amount, p.payment_method,
         p.received_at, p.recorded_by, p.recorded_by_label, l.branch_id, l.loan_number,
         coalesce(pg_catalog.sum(a.allocated_principal), 0)::bigint as principal,
         coalesce(pg_catalog.sum(a.allocated_interest), 0)::bigint as interest,
         coalesce(pg_catalog.sum(a.allocated_penalty), 0)::bigint as penalty
    into r
  from public.loan_payments p
  join public.loans l on l.id = p.loan_id
  left join public.payment_allocations a on a.payment_id = p.id
  where p.id = p_payment_id
  group by p.id, l.branch_id, l.loan_number;

  if r.id is null then
    raise exception 'No such payment.' using errcode = 'P0001';
  end if;

  if exists (select 1 from public.journal_entries e
              where e.source_type = 'loan_repayment' and e.source_id = r.id) then
    return null;
  end if;

  -- The three components must account for the whole payment. If they do not,
  -- the journal would balance only by inventing a figure, so this stops
  -- instead — and because it runs inside the posting transaction, the
  -- payment rolls back with it.
  if r.principal + r.interest + r.penalty <> r.amount then
    raise exception
      'Payment % cannot be posted: its allocations total % but the payment is %.',
      r.payment_number, r.principal + r.interest + r.penalty, r.amount
      using errcode = 'P0001';
  end if;

  return public.post_journal(
    r.branch_id,
    (r.received_at at time zone v_tz)::date,
    'Payment ' || r.payment_number || ' on loan ' || r.loan_number,
    'loan_repayment', r.id, r.loan_id, r.client_id,
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'account_id', public.branch_cash_account(r.branch_id,
          public.payment_method_cash_kind(r.payment_method)),
        'debit', r.amount, 'credit', 0, 'memo', 'Received by ' || r.payment_method),
      pg_catalog.jsonb_build_object(
        'account_id', public.ledger_account_by_code('1200'),
        'debit', 0, 'credit', r.principal, 'memo', 'Principal recovered'),
      pg_catalog.jsonb_build_object(
        'account_id', public.ledger_account_by_code('4100'),
        'debit', 0, 'credit', r.interest, 'memo', 'Interest earned'),
      pg_catalog.jsonb_build_object(
        'account_id', public.ledger_account_by_code('4200'),
        'debit', 0, 'credit', r.penalty, 'memo', 'Late charge recovered')
    ),
    r.received_at, r.recorded_by, r.recorded_by_label
  );
end;
$$;

comment on function public.post_repayment_journal(uuid) is
  'Phase 10. Dr the receiving account, Cr Loans Receivable, Interest Income and Penalty Income by the payment''s own allocation components. Refuses if the components do not sum to the payment.';

revoke all on function public.post_repayment_journal(uuid) from public, anon, authenticated;

create or replace function public.post_reversal_journal(p_payment_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  r        record;
  v_tz     text := public.business_timezone();
  v_contra uuid;
begin
  select p.id, p.payment_number, p.loan_id, p.client_id, p.amount, p.payment_method,
         p.reversed_at, p.reversed_by, p.reversal_reason, l.branch_id,
         e.id as original_entry,
         coalesce(pg_catalog.sum(a.allocated_principal), 0)::bigint as principal,
         coalesce(pg_catalog.sum(a.allocated_interest), 0)::bigint as interest,
         coalesce(pg_catalog.sum(a.allocated_penalty), 0)::bigint as penalty,
         coalesce(pr.full_name, 'system') as actor
    into r
  from public.loan_payments p
  join public.loans l on l.id = p.loan_id
  left join public.journal_entries e
    on e.source_type = 'loan_repayment' and e.source_id = p.id
  left join public.payment_allocations a on a.payment_id = p.id
  left join public.profiles pr on pr.id = p.reversed_by
  where p.id = p_payment_id
  group by p.id, l.branch_id, e.id, pr.full_name;

  if r.id is null then
    raise exception 'No such payment.' using errcode = 'P0001';
  end if;

  if r.reversed_at is null then
    raise exception 'Payment % has not been reversed.', r.payment_number
      using errcode = 'P0001';
  end if;

  if exists (select 1 from public.journal_entries e2
              where e2.source_type = 'payment_reversal' and e2.source_id = r.id) then
    return null;
  end if;

  -- The original posting stands and a contra entry cancels it. A reversal is
  -- an event in the books, not an erasure from them.
  v_contra := public.post_journal(
    r.branch_id,
    (r.reversed_at at time zone v_tz)::date,
    'Reversal of payment ' || r.payment_number,
    'payment_reversal', r.id, r.loan_id, r.client_id,
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'account_id', public.ledger_account_by_code('1200'),
        'debit', r.principal, 'credit', 0, 'memo', 'Principal put back'),
      pg_catalog.jsonb_build_object(
        'account_id', public.ledger_account_by_code('4100'),
        'debit', r.interest, 'credit', 0, 'memo', 'Interest withdrawn'),
      pg_catalog.jsonb_build_object(
        'account_id', public.ledger_account_by_code('4200'),
        'debit', r.penalty, 'credit', 0, 'memo', 'Late charge withdrawn'),
      pg_catalog.jsonb_build_object(
        'account_id', public.branch_cash_account(r.branch_id,
          public.payment_method_cash_kind(r.payment_method)),
        'debit', 0, 'credit', r.amount,
        'memo', coalesce(r.reversal_reason, 'Reversed'))
    ),
    r.reversed_at, r.reversed_by, r.actor
  );

  if r.original_entry is not null then
    update public.journal_entries
       set reversed_by_entry_id = v_contra
     where id = r.original_entry and reversed_by_entry_id is null;
  end if;

  return v_contra;
end;
$$;

comment on function public.post_reversal_journal(uuid) is
  'Phase 10. The exact contra of the repayment journal, dated the day of the reversal, with the original stamped as reversed by it.';

revoke all on function public.post_reversal_journal(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The backfill
-- ---------------------------------------------------------------------------

create or replace function public.backfill_ledger_history()
returns table (opening bigint, disbursements integer, repayments integer, reversals integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch  uuid;
  v_tz      text := public.business_timezone();
  v_cash    uuid;
  v_owner   uuid;
  v_deficit bigint;
  v_opening bigint := 0;
  v_first_at timestamptz;
  r         record;
  v_disb    integer := 0;
  v_pay     integer := 0;
  v_rev     integer := 0;
begin
  select b.id into v_branch from public.branches b order by b.branch_code limit 1;
  if v_branch is null then
    raise exception 'No branch exists; the chart of accounts has not been seeded.'
      using errcode = 'P0001';
  end if;

  v_cash := public.branch_cash_account(v_branch, 'cash_at_hand');

  select p.id into v_owner
  from public.profiles p
  join public.user_roles ur on ur.profile_id = p.id
  where ur.role_key = 'owner_admin'
  order by p.created_at
  limit 1;

  -- --- The opening entry -------------------------------------------------
  --
  -- Derived, not chosen: the deepest the cash position ever goes, replaying
  -- every disbursement and every cash movement in timestamp order. A
  -- reversal returns the money on the day it was reversed, because the
  -- inflow really did happen and really was undone.
  if not exists (select 1 from public.journal_entries where source_type = 'opening_balance') then
    with events as (
      select l.disbursed_at as at, -l.principal_amount::bigint as delta
        from public.loans l where l.disbursed_at is not null
      union all
      select p.received_at, p.amount::bigint
        from public.loan_payments p where p.payment_method = 'cash'
      union all
      select p.reversed_at, -p.amount::bigint
        from public.loan_payments p
       where p.payment_method = 'cash' and p.status <> 'posted' and p.reversed_at is not null
    ),
    running as (
      select pg_catalog.sum(delta) over (order by at, delta
                              rows between unbounded preceding and current row) as balance
        from events
    )
    select least(pg_catalog.min(balance), 0) into v_deficit from running;

    v_opening := -coalesce(v_deficit, 0);

    if v_opening > 0 then
      -- The instant of the first disbursement, less a day. Taking the
      -- timestamp rather than casting a date to one keeps this free of a
      -- bare `timestamp`, which has no zone and is forbidden here for the
      -- usual reason: it would read as a different moment in a different
      -- session.
      select pg_catalog.min(l.disbursed_at) - interval '1 day'
        into v_first_at
      from public.loans l where l.disbursed_at is not null;

      perform public.post_journal(
        v_branch,
        (coalesce(v_first_at, pg_catalog.now()) at time zone v_tz)::date,
        'Capital introduced',
        'opening_balance', null, null, null,
        pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object('account_id', v_cash, 'debit', v_opening, 'credit', 0,
            'memo', 'Derived: the deepest the cash position reaches over its whole history, so it never goes negative.'),
          pg_catalog.jsonb_build_object('account_id', public.ledger_account_by_code('3000'),
            'debit', 0, 'credit', v_opening)
        ),
        coalesce(v_first_at, pg_catalog.now()),
        v_owner,
        'system'
      );
    end if;
  else
    select pg_catalog.sum(l.debit) into v_opening
    from public.journal_lines l
    join public.journal_entries e on e.id = l.entry_id
    where e.source_type = 'opening_balance' and l.account_id = v_cash;
  end if;

  -- Chronological, so the ledger reads the way the business happened.
  for r in
    select l.id from public.loans l
     where l.disbursed_at is not null order by l.disbursed_at, l.loan_number
  loop
    if public.post_disbursement_journal(r.id) is not null then
      v_disb := v_disb + 1;
    end if;
  end loop;

  for r in
    select p.id from public.loan_payments p order by p.received_at, p.payment_number
  loop
    if public.post_repayment_journal(r.id) is not null then
      v_pay := v_pay + 1;
    end if;
  end loop;

  for r in
    select p.id from public.loan_payments p
     where p.status <> 'posted' and p.reversed_at is not null
     order by p.reversed_at, p.payment_number
  loop
    if public.post_reversal_journal(r.id) is not null then
      v_rev := v_rev + 1;
    end if;
  end loop;

  return query select v_opening, v_disb, v_pay, v_rev;
end;
$$;

comment on function public.backfill_ledger_history() is
  'Phase 10. Derives journals for the disbursements, payments and reversals already recorded, through the same three functions the live money functions use. Idempotent: an event already posted is skipped, and the unique index on (source_type, source_id) makes a duplicate impossible regardless.';

revoke all on function public.backfill_ledger_history() from public, anon, authenticated;

select * from public.backfill_ledger_history();
