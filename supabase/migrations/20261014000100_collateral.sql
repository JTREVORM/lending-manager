-- ===========================================================================
-- Phase 14.1 — the security a loan is written against
--
-- Phase 12 gave a product a `collateral_required` flag and nothing to record
-- against it, so a Business Loan could declare that it wants security and the
-- system had nowhere to say what was taken. This is that table.
--
-- ## What an item is, and when it stops being editable
--
-- A pledged item has two lives. Before the money moves it is part of the
-- application — a description a loan officer types, corrects and re-values
-- while the file is being assembled. From the moment the loan is active it is
-- evidence: the thing the business agreed to lend against, and the thing it
-- will point at if the borrower does not pay. So the item's *identity* — what
-- it is, its serial number, what it was valued at and when — freezes at
-- disbursement.
--
-- What never freezes is its *status*. An item is held, then released when the
-- loan clears, or realised when it is sold to recover a debt. Those are
-- events that happen to a live loan by definition, and a table that froze them
-- would be a table that cannot record the only thing security is for.
--
-- ## Why the value is not an obligation
--
-- `estimated_value` is what somebody thought the item was worth on a date. It
-- is not a figure any balance is computed from, it posts nothing to the
-- ledger, and realising an item does not reduce a loan by its valuation — a
-- realisation is money, and money reaches the books as a payment through
-- `post_payment` like every other shilling. The valuation is a judgement
-- recorded beside the loan, and this schema is careful never to let it look
-- like anything more.
-- ===========================================================================

create table public.loan_collateral (
  id uuid primary key default gen_random_uuid(),
  loan_id uuid not null references public.loans(id) on delete restrict,

  -- A short closed list rather than free text: "Motorcycle", "motor cycle"
  -- and "Boda" are three spellings of one category, and a register that
  -- cannot group them cannot report on them.
  item_type text not null,
  description text not null,

  -- Whole shillings, like every other amount in this schema. What somebody
  -- judged it to be worth, on `valued_on`.
  estimated_value bigint not null,
  valued_on date not null,

  serial_number text,
  ownership_document text,
  location text,

  status text not null default 'held',
  released_at timestamptz,
  released_by uuid references public.profiles(id) on delete set null,
  release_reason text,

  -- What a realisation actually fetched. Recorded here as the fact of the
  -- sale; the money itself reaches the books as a payment, never from this
  -- column.
  realised_amount bigint,
  realised_at timestamptz,
  realised_by uuid references public.profiles(id) on delete set null,

  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),

  constraint loan_collateral_item_type_valid check (item_type in (
    'land_title', 'building', 'motor_vehicle', 'motorcycle', 'bicycle',
    'electronics', 'furniture', 'machinery', 'livestock', 'stock_in_trade',
    'household_goods', 'other'
  )),
  constraint loan_collateral_description_length
    check (char_length(btrim(description)) between 3 and 500),
  constraint loan_collateral_value_positive check (estimated_value > 0),
  constraint loan_collateral_value_sane check (estimated_value <= 1000000000000),
  constraint loan_collateral_valued_not_future check (valued_on <= current_date),

  constraint loan_collateral_status_valid
    check (status in ('held', 'released', 'realised')),

  -- A status and its evidence travel together. "Released" with no date is a
  -- status somebody changed and did not record.
  constraint loan_collateral_released_consistent check (
    (status = 'released') = (released_at is not null)
  ),
  constraint loan_collateral_realised_consistent check (
    (status = 'realised') = (realised_at is not null)
  ),
  constraint loan_collateral_realised_amount check (
    (realised_at is null and realised_amount is null)
    or (realised_at is not null and realised_amount is not null
        and realised_amount >= 0 and realised_amount <= 1000000000000)
  ),
  constraint loan_collateral_release_reason_length
    check (release_reason is null
           or char_length(btrim(release_reason)) between 3 and 500)
);

create index loan_collateral_loan_idx on public.loan_collateral (loan_id);
create index loan_collateral_status_idx on public.loan_collateral (status);

comment on table public.loan_collateral is
  'Phase 14. What a loan is secured on: the item, what it was valued at and when, and whether it is still held, released or realised. The valuation is a judgement recorded beside the loan, never a figure any balance is computed from.';

create trigger loan_collateral_set_updated_at
  before update on public.loan_collateral
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- What freezes, and when
-- ---------------------------------------------------------------------------

create or replace function public.loan_collateral_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  select l.status into v_status
    from public.loans l
   where l.id = coalesce(new.loan_id, old.loan_id);

  if v_status is null then
    raise exception 'No such loan.' using errcode = 'P0001';
  end if;

  if tg_op = 'DELETE' then
    -- An item can be struck off while the file is still being assembled.
    -- Afterwards it is evidence, and an item that was taken and is no longer
    -- wanted is *released*, which is a status rather than a deletion.
    if v_status not in ('draft', 'pending_approval', 'approved') then
      raise exception
        'Security on a % loan cannot be removed. Release it instead.', v_status
        using errcode = 'P0001';
    end if;

    return old;
  end if;

  if tg_op = 'INSERT' then
    if v_status in ('cleared', 'cancelled') then
      raise exception
        'Security cannot be added to a % loan.', v_status using errcode = 'P0001';
    end if;

    new.created_by := coalesce(public.current_profile_id(), new.created_by);
    return new;
  end if;

  -- UPDATE. Provenance is never rewritten.
  new.created_by := old.created_by;
  new.created_at := old.created_at;
  new.loan_id := old.loan_id;

  -- The identity of the item freezes once the money has moved.
  if v_status not in ('draft', 'pending_approval', 'approved') then
    if new.item_type is distinct from old.item_type
       or new.description is distinct from old.description
       or new.estimated_value is distinct from old.estimated_value
       or new.valued_on is distinct from old.valued_on
       or new.serial_number is distinct from old.serial_number
       or new.ownership_document is distinct from old.ownership_document then
      -- Worded so the status reads correctly whatever it is: "on a active
      -- loan" is what interpolating the status after an article produces, and
      -- a guard's message is the only explanation the person at the counter
      -- gets.
      raise exception
        'What this item is and what it was valued at cannot be changed once the loan is %. It is what the business agreed to lend against.',
        v_status using errcode = 'P0001';
    end if;
  end if;

  -- A status moves forward only. Held becomes released or realised; neither
  -- comes back, because an item handed over or sold cannot be un-handed.
  if new.status is distinct from old.status then
    if old.status <> 'held' then
      raise exception
        'This item has already been %. That cannot be undone.', old.status
        using errcode = 'P0001';
    end if;

    if new.status = 'released' then
      new.released_at := pg_catalog.now();
      new.released_by := public.current_profile_id();
    elsif new.status = 'realised' then
      new.realised_at := pg_catalog.now();
      new.realised_by := public.current_profile_id();
    end if;
  elsif new.released_at is distinct from old.released_at
     or new.released_by is distinct from old.released_by
     or new.realised_at is distinct from old.realised_at
     or new.realised_by is distinct from old.realised_by then
    raise exception 'Release and realisation are stamped by the database.'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

comment on function public.loan_collateral_guard() is
  'Phase 14. Freezes a pledged item''s identity once the loan is live, stamps who released or realised it, and refuses a status that moves backwards.';

revoke all on function public.loan_collateral_guard() from public, anon, authenticated;

create trigger loan_collateral_guard
  before insert or update or delete on public.loan_collateral
  for each row execute function public.loan_collateral_guard();

-- ---------------------------------------------------------------------------
-- Capabilities
--
-- Reading follows the loan. Recording and releasing is its own capability,
-- held by the roles that handle the item itself — the Secretary/Treasurer
-- takes it in, the Manager and the Owner decide what happens to it.
-- ---------------------------------------------------------------------------

insert into public.permissions (key, description) values
  ('collateral:view', 'See the security recorded against a loan.'),
  ('collateral:manage', 'Record security against a loan, and release or realise it.')
on conflict (key) do nothing;

insert into public.role_permissions (role_key, permission_key) values
  ('secretary_treasurer', 'collateral:view'),
  ('secretary_treasurer', 'collateral:manage'),
  ('manager', 'collateral:view'),
  ('manager', 'collateral:manage'),
  ('owner_admin', 'collateral:view'),
  ('owner_admin', 'collateral:manage')
on conflict (role_key, permission_key) do nothing;

alter table public.loan_collateral enable row level security;

revoke all on table public.loan_collateral from anon, authenticated;
grant select, insert, update, delete on table public.loan_collateral to authenticated;

create policy loan_collateral_select_with_permission
  on public.loan_collateral for select to authenticated
  using (public.user_has_permission('collateral:view'));

create policy loan_collateral_insert_with_permission
  on public.loan_collateral for insert to authenticated
  with check (public.user_has_permission('collateral:manage'));

create policy loan_collateral_update_with_permission
  on public.loan_collateral for update to authenticated
  using (public.user_has_permission('collateral:manage'))
  with check (public.user_has_permission('collateral:manage'));

create policy loan_collateral_delete_with_permission
  on public.loan_collateral for delete to authenticated
  using (public.user_has_permission('collateral:manage'));

-- ---------------------------------------------------------------------------
-- The register
-- ---------------------------------------------------------------------------

create view public.loan_collateral_register with (security_invoker = true) as
select
  col.id,
  col.loan_id,
  l.loan_number,
  l.status as loan_status,
  l.branch_id,
  l.client_id,
  c.client_number,
  c.full_name as client_name,
  c.phone as client_phone,
  p.product_code,
  p.name as product_name,
  col.item_type,
  col.description,
  col.estimated_value,
  col.valued_on,
  col.serial_number,
  col.ownership_document,
  col.location,
  col.status,
  col.released_at,
  col.release_reason,
  col.realised_amount,
  col.realised_at,
  col.created_at,
  -- What the loan still owes, so a reader can see cover against exposure
  -- without joining two screens together. Null for a reader who may not see
  -- collections, which is honest: they do not know.
  d.total_outstanding
from public.loan_collateral col
join public.loans l on l.id = col.loan_id
join public.clients c on c.id = l.client_id
join public.loan_products p on p.id = l.loan_product_id
left join public.loan_delinquency d on d.loan_id = l.id;

comment on view public.loan_collateral_register is
  'Phase 14. Every pledged item with its loan, its borrower, its status and what that loan still owes.';

revoke all on public.loan_collateral_register from anon, authenticated;
grant select on public.loan_collateral_register to authenticated;

-- ---------------------------------------------------------------------------
-- The application profile learns what the product asks for
--
-- Phase 12 gave a product `collateral_required` and `min_guarantors`, and
-- nothing read them. The application screen needs both to say "this product
-- expects security and none is recorded" — which is the whole value of the
-- flag, and the reason it was added.
--
-- Re-emitted in full rather than wrapped. A `create or replace view` whose
-- body selects from the view it is replacing resolves the name to the old
-- definition at parse time and leaves behind a view that recurses into
-- itself — accepted by the planner, and then "infinite recursion detected in
-- rules" on the first read. The two new columns are appended at the end, so
-- every existing caller's column list is untouched.
-- ---------------------------------------------------------------------------

create or replace view public.loan_application_profile with (security_invoker = true) as
select
  l.id as loan_id,
  l.loan_number,
  l.status,
  p.product_code,
  p.name as product_name,
  p.application_profile,
  p.requires_supporting_documents,
  case p.application_profile
    when 'salary' then s.loan_id is not null
    when 'business' then b.loan_id is not null
    else true
  end as details_present,
  s.employer_name,
  s.job_title,
  s.net_monthly_salary,
  s.salary_pay_day,
  exists (
    select 1 from public.loan_documents d
    where d.loan_id = l.id and d.kind = 'payslip'
  ) as has_payslip,
  b.business_name,
  b.business_type,
  b.monthly_turnover,
  b.loan_purpose,
  exists (
    select 1 from public.loan_documents d
    where d.loan_id = l.id and d.kind = 'trading_licence'
  ) as has_trading_licence,
  s.employer_contact,
  s.staff_number,
  s.employment_started_on,
  s.employment_status,
  s.salary_verification,
  exists (
    select 1 from public.loan_documents d
    where d.loan_id = l.id and d.kind = 'employment_letter'
  ) as has_employment_letter,
  b.business_location,
  b.trading_since,
  b.monthly_expenses,
  b.business_contact,
  b.employee_count,
  b.premises_ownership,
  b.trading_licence_number,
  exists (
    select 1 from public.loan_documents d
    where d.loan_id = l.id and d.kind = 'bank_statement'
  ) as has_bank_statement,
  (
    select pg_catalog.count(*) from public.loan_documents d
    where d.loan_id = l.id
  ) as document_count,
  -- Phase 14. Two flags Phase 12 gave a product and nothing ever read.
  p.collateral_required,
  p.min_guarantors
from public.loans l
join public.loan_products p on p.id = l.loan_product_id
left join public.loan_salary_details s on s.loan_id = l.id
left join public.loan_business_details b on b.loan_id = l.id;

comment on view public.loan_application_profile is
  'Phase 14. One row per loan: which product it was taken under, which questions that product asks, how they were answered, which documents were filed, and whether the product expects security and how many guarantors.';
