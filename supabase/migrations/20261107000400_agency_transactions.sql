-- ===========================================================================
-- Phase 4A — Agency Banking & Digital Payments: the transaction record
--
-- Specification: `docs/AGENCY-BANKING-ARCHITECTURE.md` v3.0, §5.5 and §7.
--
-- The table and its integrity only. The lifecycle *functions* —
-- `submit_agency_transaction()`, `verify_agency_transaction()`,
-- `post_agency_transaction()`, `reverse_agency_transaction()` — are Phase 4B.
-- What lands here is everything that must be true of a row no matter which
-- function wrote it, so that the engine cannot create a state the books
-- cannot explain.
--
-- ## Separation of duties is a constraint, not a convention
--
-- `verifier_not_submitter` is a CHECK, so the database refuses a row in which
-- one person both recorded and verified a movement of money. A rule enforced
-- only in a function is a rule that holds until somebody writes a second
-- function.
--
-- Note what the Product Owner decided about *who* may verify: `agency:verify`
-- goes to `manager` and `owner_admin` only, matching the maker-checker
-- boundary Phase 3 certified for transfers and expenses, rather than the
-- looser §9 grant that would have included `secretary_treasurer`
-- (reconciliation §4, decision E). The CHECK here is the second line: even
-- between two managers, nobody verifies their own.
--
-- ## Why the money columns are three and not one
--
-- `principal_amount`, `commission_amount` and `customer_fee` are kept apart
-- because they are three different claims. The principal is the customer's
-- money passing through; the commission is what the provider owes the company;
-- the customer fee is what the customer paid the company directly. Summing
-- them into one figure would make it impossible to state, later, which part of
-- a reversal is income being given back. All three are `bigint` minor units,
-- never a float.
-- ===========================================================================

-- Every foreign key here is ON DELETE RESTRICT, including the nullable
-- references to `profiles`. The money-movement tables use SET NULL for
-- provenance columns, but they each carry a label column that keeps the name
-- the document was recorded under; these do not, so SET NULL would quietly
-- erase who verified or reversed a posting. In a financial system that is
-- worse than refusing the delete, and profiles are archived rather than
-- deleted in any case.
create table public.agency_transactions (
  id                  uuid primary key default gen_random_uuid(),
  branch_id           uuid not null references public.branches(id) on delete restrict,
  provider_id         uuid not null references public.agency_service_providers(id) on delete restrict,
  transaction_type_id uuid not null references public.agency_transaction_types(id) on delete restrict,

  -- Exactly one of these, enforced below: a transaction either moves the
  -- company's electronic float or creates a liability to the provider.
  float_account_id    uuid references public.agency_provider_float_accounts(id) on delete restrict,
  payable_account_id  uuid references public.ledger_accounts(id) on delete restrict,

  status              text not null default 'draft',

  principal_amount    bigint not null,
  commission_amount   bigint not null default 0,
  customer_fee        bigint not null default 0,

  provider_reference  text,
  customer_identifier text,
  customer_name       text,
  description         text,

  transaction_date    date not null default current_date,
  posted_at           timestamptz,
  reversed_at         timestamptz,

  -- `original_id` is set on the reversing row and points at what it reverses.
  -- `reversal_id` is set on the original and points at the row that reversed
  -- it. Both directions are stored because both are asked: "has this been
  -- reversed" and "what did this reverse".
  original_id         uuid references public.agency_transactions(id) on delete restrict,
  reversal_id         uuid references public.agency_transactions(id) on delete restrict,

  submitted_by        uuid not null references public.profiles(id) on delete restrict,
  verified_by         uuid references public.profiles(id) on delete restrict,
  reversed_by         uuid references public.profiles(id) on delete restrict,
  reversal_reason     text,

  journal_entry_id    uuid references public.journal_entries(id) on delete restrict,
  reversal_entry_id   uuid references public.journal_entries(id) on delete restrict,

  idempotency_key     text unique,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint agency_transactions_status_valid
    check (status = any (array[
      'draft', 'awaiting_verification', 'posted', 'reversed', 'cancelled'
    ])),

  constraint agency_transactions_principal_positive
    check (principal_amount > 0),
  constraint agency_transactions_commission_not_negative
    check (commission_amount >= 0),
  constraint agency_transactions_customer_fee_not_negative
    check (customer_fee >= 0),

  constraint agency_transactions_exactly_one_settlement_account
    check (
      (float_account_id is not null and payable_account_id is null)
      or (float_account_id is null and payable_account_id is not null)
    ),

  -- Separation of duties, at the data layer.
  constraint agency_transactions_verifier_not_submitter
    check (verified_by is null or verified_by <> submitted_by),

  constraint agency_transactions_reversal_not_own_original
    check (original_id is null or original_id <> id),
  constraint agency_transactions_reversal_not_self
    check (reversal_id is null or reversal_id <> id),

  -- A posted transaction has a journal and a time; an unposted one has
  -- neither. This is what makes "no document without its journal" structural.
  constraint agency_transactions_posted_has_journal
    check (
      (status in ('posted', 'reversed')) = (journal_entry_id is not null)
    ),
  constraint agency_transactions_posted_has_time
    check ((status in ('posted', 'reversed')) = (posted_at is not null)),

  -- A reversed transaction carries the whole story: who, when, why, and the
  -- contra entry. Task 6's "reversals preserve the complete audit trail"
  -- cannot be satisfied by a row that lost any of it.
  constraint agency_transactions_reversed_is_complete
    check (
      status <> 'reversed'
      or (
        reversed_at is not null
        and reversed_by is not null
        and reversal_reason is not null
        and reversal_entry_id is not null
      )
    ),
  constraint agency_transactions_unreversed_is_clean
    check (
      status = 'reversed'
      or (reversed_at is null and reversed_by is null and reversal_entry_id is null)
    ),

  -- Verification is what posts, so a posted row must name its verifier.
  constraint agency_transactions_posted_has_verifier
    check (status not in ('posted', 'reversed') or verified_by is not null)
);

comment on table public.agency_transactions is
  'Phase 4A. One manually entered agency or digital payment transaction. Lifecycle draft -> awaiting_verification -> posted -> reversed, with cancelled available before posting. The principal, the commission and the customer fee are kept as three separate bigint amounts because they are three different claims on three different parties. Writes come only from the Phase 4B SECURITY DEFINER functions.';

comment on column public.agency_transactions.provider_reference is
  'Phase 4A, correction C7/C13. The provider''s own transaction identifier — an MTN reference, a Yaka token. Unique per provider once the row is more than a draft, and a reversed row keeps its claim on the reference: see agency_transactions_provider_reference_unique.';

comment on column public.agency_transactions.idempotency_key is
  'Phase 4A. Supplied by the caller so a retried submission cannot create a second transaction. Follows the convention of loan_payments and savings_transactions.';

comment on column public.agency_transactions.float_account_id is
  'Phase 4A, correction C13. The till, not the provider: a branch running two MTN tills posts each transaction against the one that actually moved, so each reconciles on its own.';


-- ---------------------------------------------------------------------------
-- Provider reference uniqueness
--
-- Correction C7. The index deliberately excludes only `draft` and `cancelled`.
-- A **reversed** transaction keeps its claim on the reference, because the
-- provider's reference was genuinely consumed by that transaction — reversing
-- the accounting does not un-send the money at MTN. Allowing the reference to
-- be re-entered after a reversal is how the same provider transaction gets
-- booked twice.
-- ---------------------------------------------------------------------------

create unique index agency_transactions_provider_reference_unique
  on public.agency_transactions (provider_id, provider_reference)
  where provider_reference is not null
    and status <> 'draft'
    and status <> 'cancelled';


-- ---------------------------------------------------------------------------
-- A reversal is one-to-one
--
-- Without these, two reversing rows could point at one original and the
-- original's own `reversal_id` would name only the last of them.
-- ---------------------------------------------------------------------------

create unique index agency_transactions_one_reversal_per_original
  on public.agency_transactions (original_id)
  where original_id is not null;

create unique index agency_transactions_one_original_per_reversal
  on public.agency_transactions (reversal_id)
  where reversal_id is not null;


-- ---------------------------------------------------------------------------
-- Cross-table integrity
--
-- The CHECK constraints cannot reach another table, so these go in a trigger:
-- the type must belong to the provider, the till must belong to the provider
-- and the branch, the payable must be the provider's own, and the float model
-- must match which account was supplied.
-- ---------------------------------------------------------------------------

create or replace function public.agency_transaction_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_provider record;
  v_type     record;
  v_till     record;
begin
  select * into v_provider
  from public.agency_service_providers where id = new.provider_id;

  if v_provider is null then
    raise exception 'No such agency provider.' using errcode = 'P0001';
  end if;

  select * into v_type
  from public.agency_transaction_types where id = new.transaction_type_id;

  if v_type is null then
    raise exception 'No such agency transaction type.' using errcode = 'P0001';
  end if;

  if v_type.provider_id <> new.provider_id then
    raise exception
      'Transaction type % does not belong to %.', v_type.name, v_provider.name
      using errcode = 'P0001';
  end if;

  -- The float model decides which settlement account the row must carry, and
  -- the exactly-one CHECK has already guaranteed it carries precisely one.
  if v_provider.float_model = 'provider_float' then
    if new.float_account_id is null then
      raise exception
        '% is settled from electronic float, so the transaction needs a till.', v_provider.name
        using errcode = 'P0001';
    end if;

    select * into v_till
    from public.agency_provider_float_accounts where id = new.float_account_id;

    if v_till.provider_id <> new.provider_id then
      raise exception 'That till does not belong to %.', v_provider.name
        using errcode = 'P0001';
    end if;

    -- Branch isolation, at the data layer: a branch cannot post against
    -- another branch's till even if it can name one.
    if v_till.branch_id <> new.branch_id then
      raise exception 'That till belongs to a different branch.'
        using errcode = 'P0001';
    end if;

    if not v_till.is_active then
      raise exception 'That till is not active.' using errcode = 'P0001';
    end if;
  else
    if new.payable_account_id is null then
      raise exception
        '% is settled through a payable account, so the transaction needs one.', v_provider.name
        using errcode = 'P0001';
    end if;

    if new.payable_account_id is distinct from v_provider.payable_account_id then
      raise exception
        'That payable account is not the one registered for %.', v_provider.name
        using errcode = 'P0001';
    end if;
  end if;

  -- A transaction cannot be worth more than its type allows. Checked here
  -- rather than only in the posting function so it holds for a draft too.
  if v_type.max_single_transaction is not null
     and new.principal_amount > v_type.max_single_transaction then
    raise exception
      'A single % may not exceed % shillings.', v_type.name, v_type.max_single_transaction
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

create trigger agency_transactions_guard
  before insert or update on public.agency_transactions
  for each row execute function public.agency_transaction_guard();

-- As with the registry guards: a trigger needs no EXECUTE grant, so the
-- default one is withheld rather than reviewed into the baseline.
revoke all on function public.agency_transaction_guard()
  from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- Housekeeping and immutability
--
-- No DELETE, ever. A posted transaction is a financial record and a cancelled
-- one is evidence that somebody started and stopped; neither may be made to
-- disappear. Reversal is the only way to undo money.
-- ---------------------------------------------------------------------------

create trigger agency_transactions_set_updated_at
  before update on public.agency_transactions
  for each row execute function public.set_updated_at();

create trigger agency_transactions_no_delete
  before delete on public.agency_transactions
  for each row execute function public.reject_mutation();


-- ---------------------------------------------------------------------------
-- Row-level security
--
-- SELECT only, gated on `agency:reports` and branch-isolated. A borrower holds
-- no `agency:*` permission at all, so the predicate is false for them and the
-- table returns nothing — which is Task 6's "borrowers cannot access unrelated
-- financial records", by the same mechanism the rest of the finance module
-- uses.
-- ---------------------------------------------------------------------------

alter table public.agency_transactions enable row level security;

revoke all on table public.agency_transactions from anon, authenticated;
grant select on table public.agency_transactions to authenticated;

create policy agency_transactions_select_with_permission
  on public.agency_transactions for select to authenticated
  using (
    (select public.user_has_permission('agency:reports'))
    and (
      branch_id is null
      or (select public.current_user_branch_id()) is null
      or branch_id = (select public.current_user_branch_id())
    )
  );


-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

create index agency_transactions_branch_date_idx
  on public.agency_transactions (branch_id, transaction_date desc, status);

create index agency_transactions_provider_idx
  on public.agency_transactions (provider_id, transaction_date desc);

create index agency_transactions_status_idx
  on public.agency_transactions (status, transaction_date desc);

create index agency_transactions_till_idx
  on public.agency_transactions (float_account_id)
  where float_account_id is not null;

create index agency_transactions_submitted_by_idx
  on public.agency_transactions (submitted_by, transaction_date desc);

-- Pending verification is a worklist screen, so it gets its own small index
-- rather than scanning by status.
create index agency_transactions_awaiting_idx
  on public.agency_transactions (branch_id, created_at)
  where status = 'awaiting_verification';

create index agency_transactions_customer_identifier_idx
  on public.agency_transactions (customer_identifier)
  where customer_identifier is not null;
