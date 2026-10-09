-- ===========================================================================
-- Phase 13.2 — the questions a product actually asks
--
-- A Salary Loan asks for an employer, a staff number, a net salary and a pay
-- date. A Business Loan asks for the business, how long it has traded, its
-- turnover and what the money is for. Those are *different questions*, and
-- Phase 12 recorded which product asks which by naming an
-- `application_profile`. This is where the answers go.
--
-- ## Why two tables and not thirty columns on `loans`
--
-- Thirty nullable columns of which at most a third apply to any row, and no
-- constraint able to say which third. `employer_name is not null` would be
-- meaningless on a Business Loan and unenforceable on a Salary Loan, so the
-- completeness rule would have to live in application code — where it is not
-- a rule.
--
-- One table per profile, each with the loan as its primary key, means every
-- column in it is NOT NULL where the business needs an answer, and the
-- *presence of the row* is what approval checks. A Quick Loan and an
-- Individual Loan add no table, because they ask nothing extra.
--
-- ## Why they freeze when the application is submitted
--
-- These are the answers the credit decision was made on. A salary that could
-- be edited after approval would make the file disagree with the decision,
-- which is the same reason the client and guarantor snapshots exist. So they
-- are editable while the loan is a draft and immutable from the moment it is
-- submitted — not append-only, because a draft is meant to be corrected.
--
-- There is no separate snapshot table: the row is already one-per-loan and
-- frozen at submission, so copying it would be storing the same facts twice.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- A salaried borrower
-- ---------------------------------------------------------------------------

create table public.loan_salary_details (
  loan_id uuid primary key references public.loans(id) on delete restrict,

  employer_name text not null,
  employer_contact text,
  job_title text not null,
  staff_number text,
  -- Whole shillings, like every other amount in this schema.
  net_monthly_salary bigint not null,
  -- The day of the month the salary lands. A collection schedule that ignores
  -- it asks a borrower to pay on the day before they are paid.
  salary_pay_day smallint not null,
  employment_started_on date,
  -- The evidence. A path under the private documents bucket, never a URL.
  payslip_path text,
  employment_letter_path text,

  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),

  constraint loan_salary_employer_not_blank check (btrim(employer_name) <> ''),
  constraint loan_salary_job_not_blank check (btrim(job_title) <> ''),
  constraint loan_salary_amount_positive check (net_monthly_salary > 0),
  constraint loan_salary_amount_sane check (net_monthly_salary <= 1000000000),
  constraint loan_salary_pay_day_valid check (salary_pay_day between 1 and 31),
  constraint loan_salary_employment_started_past
    check (employment_started_on is null or employment_started_on <= current_date),
  constraint loan_salary_payslip_path_shape
    check (payslip_path is null or (payslip_path !~ '^/' and payslip_path !~ '\.\.')),
  constraint loan_salary_letter_path_shape
    check (employment_letter_path is null
           or (employment_letter_path !~ '^/' and employment_letter_path !~ '\.\.'))
);

comment on table public.loan_salary_details is
  'Phase 13. The answers a salary product asks for, one row per loan. Editable while the loan is a draft, frozen from submission, because these are the facts the credit decision was made on.';

create trigger loan_salary_details_set_updated_at
  before update on public.loan_salary_details
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- A trading business
-- ---------------------------------------------------------------------------

create table public.loan_business_details (
  loan_id uuid primary key references public.loans(id) on delete restrict,

  business_name text not null,
  business_type text not null,
  business_location text not null,
  trading_since date,
  monthly_turnover bigint not null,
  -- What the money is for. The single most useful line on a business
  -- application and the one a Quick Loan deliberately does not ask.
  loan_purpose text not null,
  employee_count smallint,
  premises_ownership text,

  trading_licence_number text,
  trading_licence_path text,
  bank_statement_path text,

  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),

  constraint loan_business_name_not_blank check (btrim(business_name) <> ''),
  constraint loan_business_type_not_blank check (btrim(business_type) <> ''),
  constraint loan_business_location_not_blank check (btrim(business_location) <> ''),
  constraint loan_business_purpose_length
    check (char_length(btrim(loan_purpose)) between 5 and 500),
  constraint loan_business_turnover_positive check (monthly_turnover > 0),
  constraint loan_business_turnover_sane check (monthly_turnover <= 10000000000),
  constraint loan_business_trading_since_past
    check (trading_since is null or trading_since <= current_date),
  constraint loan_business_employees_sane
    check (employee_count is null or employee_count between 0 and 10000),
  constraint loan_business_premises_valid
    check (premises_ownership is null
           or premises_ownership in ('owned', 'rented', 'family', 'mobile')),
  constraint loan_business_licence_path_shape
    check (trading_licence_path is null
           or (trading_licence_path !~ '^/' and trading_licence_path !~ '\.\.')),
  constraint loan_business_statement_path_shape
    check (bank_statement_path is null
           or (bank_statement_path !~ '^/' and bank_statement_path !~ '\.\.'))
);

comment on table public.loan_business_details is
  'Phase 13. The answers a business product asks for, one row per loan. Same lifecycle as loan_salary_details: editable in draft, frozen from submission.';

create trigger loan_business_details_set_updated_at
  before update on public.loan_business_details
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Frozen from submission
--
-- One function for both tables. The rule it enforces is the Phase 4
-- discipline applied to the application rather than to the terms: a draft is
-- meant to be corrected, and everything after submission is evidence.
-- ---------------------------------------------------------------------------

create or replace function public.loan_application_details_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_loan_id uuid;
begin
  v_loan_id := case when tg_op = 'DELETE' then old.loan_id else new.loan_id end;

  select l.status into v_status from public.loans l where l.id = v_loan_id;

  if v_status is null then
    raise exception 'No such loan.' using errcode = 'P0001';
  end if;

  if v_status <> 'draft' then
    raise exception
      'The application details of a % loan cannot be changed. They are what the decision was made on.',
      v_status using errcode = 'P0001';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

comment on function public.loan_application_details_guard() is
  'Phase 13. Confines every write to the product-specific application tables to a loan that is still a draft.';

revoke all on function public.loan_application_details_guard() from public, anon, authenticated;

create trigger loan_salary_details_guard
  before insert or update or delete on public.loan_salary_details
  for each row execute function public.loan_application_details_guard();

create trigger loan_business_details_guard
  before insert or update or delete on public.loan_business_details
  for each row execute function public.loan_application_details_guard();

-- ---------------------------------------------------------------------------
-- Who wrote it
-- ---------------------------------------------------------------------------

create or replace function public.loan_application_details_stamp_actor()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(public.current_profile_id(), new.created_by);
  else
    new.created_by := old.created_by;
  end if;

  return new;
end;
$$;

revoke all on function public.loan_application_details_stamp_actor()
  from public, anon, authenticated;

create trigger loan_salary_details_stamp_actor
  before insert or update on public.loan_salary_details
  for each row execute function public.loan_application_details_stamp_actor();

create trigger loan_business_details_stamp_actor
  before insert or update on public.loan_business_details
  for each row execute function public.loan_application_details_stamp_actor();

-- ---------------------------------------------------------------------------
-- Row level security
--
-- Read with `loans:view`, write with `loans:update_draft` — the same
-- capability that edits the draft these answers belong to, because they are
-- part of it. A borrower reads nothing here: their own salary and turnover
-- are on their own application, but the portal shows a borrower their
-- obligations, not the paperwork the business assessed them on.
-- ---------------------------------------------------------------------------

alter table public.loan_salary_details enable row level security;
alter table public.loan_business_details enable row level security;

revoke all on table public.loan_salary_details from anon, authenticated;
revoke all on table public.loan_business_details from anon, authenticated;

grant select, insert, update on table public.loan_salary_details to authenticated;
grant select, insert, update on table public.loan_business_details to authenticated;

-- No DELETE grant. Clearing an answer is an UPDATE to null where the column
-- permits it; removing the row would remove the evidence that the question
-- was asked. The guard above would refuse it after submission anyway.

create policy loan_salary_details_select_with_permission
  on public.loan_salary_details for select to authenticated
  using (public.user_has_permission('loans:view'));

create policy loan_salary_details_insert_with_permission
  on public.loan_salary_details for insert to authenticated
  with check (public.user_has_permission('loans:update_draft'));

create policy loan_salary_details_update_with_permission
  on public.loan_salary_details for update to authenticated
  using (public.user_has_permission('loans:update_draft'))
  with check (public.user_has_permission('loans:update_draft'));

create policy loan_business_details_select_with_permission
  on public.loan_business_details for select to authenticated
  using (public.user_has_permission('loans:view'));

create policy loan_business_details_insert_with_permission
  on public.loan_business_details for insert to authenticated
  with check (public.user_has_permission('loans:update_draft'));

create policy loan_business_details_update_with_permission
  on public.loan_business_details for update to authenticated
  using (public.user_has_permission('loans:update_draft'))
  with check (public.user_has_permission('loans:update_draft'));

-- ---------------------------------------------------------------------------
-- Reading an application with whichever details it has
-- ---------------------------------------------------------------------------

create view public.loan_application_profile with (security_invoker = true) as
select
  l.id as loan_id,
  l.loan_number,
  l.status,
  p.product_code,
  p.name as product_name,
  p.application_profile,
  p.requires_supporting_documents,
  -- Whether the product's own questions have been answered at all. The
  -- completeness of each answer is a constraint on the row itself.
  case p.application_profile
    when 'salary' then s.loan_id is not null
    when 'business' then b.loan_id is not null
    else true
  end as details_present,
  s.employer_name,
  s.job_title,
  s.net_monthly_salary,
  s.salary_pay_day,
  s.payslip_path is not null as has_payslip,
  b.business_name,
  b.business_type,
  b.monthly_turnover,
  b.loan_purpose,
  b.trading_licence_path is not null as has_trading_licence
from public.loans l
join public.loan_products p on p.id = l.loan_product_id
left join public.loan_salary_details s on s.loan_id = l.id
left join public.loan_business_details b on b.loan_id = l.id;

comment on view public.loan_application_profile is
  'Phase 13. One row per loan: which product it was taken under, which questions that product asks, and whether they have been answered.';

revoke all on public.loan_application_profile from anon, authenticated;
grant select on public.loan_application_profile to authenticated;
