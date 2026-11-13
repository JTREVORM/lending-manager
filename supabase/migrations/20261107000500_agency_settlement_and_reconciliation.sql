-- ===========================================================================
-- Phase 4A — Agency Banking & Digital Payments: settlement and reconciliation
-- records
--
-- Specification: `docs/AGENCY-BANKING-ARCHITECTURE.md` v3.0, §5.6–§5.9, and
-- its §12 Step 3, which groups all nine tables in one dependency-ordered set.
--
-- Tables only. The functions that write them — `record_commission_settlement()`,
-- `post_agency_payable_settlement()`, `post_float_replenishment()` and the
-- reconciliation approvals — are Phase 4C. Landing the schema now keeps 4C to
-- functions and views, and keeps the migration ordering in one reviewable
-- place.
--
-- ## Why four tables and not two
--
-- Correction C2 separates the two *settlements*. A commission settlement is
-- the provider paying the company what it earned; a payable settlement is the
-- company paying a school or a bank what it collected. They move money in
-- opposite directions, clear different accounts, and one of them cannot use
-- `record_transfer()` at all because a liability account has no `cash_kind`.
--
-- Correction C9 separates the two *reconciliations*. Physical cash in a till
-- and electronic float at a provider are different balances with different
-- counterparties, different evidence (a count versus a statement) and
-- different write-off accounts (5950 versus 5960). The v2 draft had one table
-- for both, which is why a variance could not be attributed.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. `agency_commission_settlements`
--
-- The provider remits commission the company already recognised as
-- receivable. Dr the account that received the money, Cr 1310.
--
-- Partial settlement is the normal case, not an exception: providers remit in
-- batches covering many transactions. So there is no link from a settlement to
-- the transactions it covers — the receivable is cleared in aggregate, and
-- double recognition is prevented by checking the 1310 balance before posting
-- rather than by matching rows (correction C7).
-- ---------------------------------------------------------------------------

create table public.agency_commission_settlements (
  id                     uuid primary key default gen_random_uuid(),
  provider_id            uuid not null references public.agency_service_providers(id) on delete restrict,
  branch_id              uuid not null references public.branches(id) on delete restrict,
  settlement_date        date not null,
  settlement_amount      bigint not null,
  settlement_account_id  uuid not null references public.ledger_accounts(id) on delete restrict,
  provider_statement_ref text,
  journal_entry_id       uuid references public.journal_entries(id) on delete restrict,
  created_by             uuid not null references public.profiles(id) on delete restrict,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  constraint agency_commission_settlement_amount_positive
    check (settlement_amount > 0),

  -- One statement reference per provider, so the same provider batch cannot be
  -- banked twice. This is the settlement-level twin of the transaction-level
  -- provider_reference rule.
  constraint agency_commission_settlement_ref_shape
    check (provider_statement_ref is null or pg_catalog.btrim(provider_statement_ref) <> '')
);

create unique index agency_commission_settlement_statement_unique
  on public.agency_commission_settlements (provider_id, provider_statement_ref)
  where provider_statement_ref is not null;

comment on table public.agency_commission_settlements is
  'Phase 4A, correction C7. A provider remitting commission the company accrued to 1310 under the deferred model. Deliberately not linked to the individual transactions it covers: providers settle in batches, so the receivable is cleared in aggregate and double recognition is prevented by checking the 1310 balance before posting.';


-- ---------------------------------------------------------------------------
-- 2. `agency_payable_settlements`
--
-- The company remits what it collected on a provider's behalf. Dr the payable
-- (2210/2220/2290), Cr cash.
--
-- Correction C2: this cannot go through `record_transfer()`, which calls
-- `assert_cash_account()` on both legs and a liability account has no
-- `cash_kind`. Hence a dedicated posting function in Phase 4C, and hence this
-- table carries the payable account explicitly rather than inferring it.
--
-- Unlike a commission settlement, this one is reversible: paying a school the
-- wrong amount is a mistake the company itself made and must be able to undo.
-- ---------------------------------------------------------------------------

create table public.agency_payable_settlements (
  id                   uuid primary key default gen_random_uuid(),
  provider_id          uuid not null references public.agency_service_providers(id) on delete restrict,
  branch_id            uuid not null references public.branches(id) on delete restrict,
  payable_account_id   uuid not null references public.ledger_accounts(id) on delete restrict,
  cash_account_id      uuid not null references public.ledger_accounts(id) on delete restrict,
  settlement_date      date not null,
  settlement_amount    bigint not null,
  provider_receipt_ref text,
  journal_entry_id     uuid references public.journal_entries(id) on delete restrict,
  status               text not null default 'posted',
  reversed_at          timestamptz,
  reversed_by          uuid references public.profiles(id) on delete restrict,
  reversal_reason      text,
  reversal_entry_id    uuid references public.journal_entries(id) on delete restrict,
  created_by           uuid not null references public.profiles(id) on delete restrict,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint agency_payable_settlement_amount_positive
    check (settlement_amount > 0),
  constraint agency_payable_settlement_status_valid
    check (status = any (array['posted', 'reversed'])),
  constraint agency_payable_settlement_reversed_is_complete
    check (
      status <> 'reversed'
      or (reversed_at is not null and reversed_by is not null
          and reversal_reason is not null and reversal_entry_id is not null)
    ),
  constraint agency_payable_settlement_unreversed_is_clean
    check (
      status = 'reversed'
      or (reversed_at is null and reversed_by is null and reversal_entry_id is null)
    )
);

comment on table public.agency_payable_settlements is
  'Phase 4A, correction C2. The company remitting money it collected on a provider''s behalf — school fees to an institution, deposits to a partner bank. Dr the 2200-series payable, Cr cash. Cannot use record_transfer(), which refuses an account with no cash_kind, so Phase 4C gives it post_agency_payable_settlement().';


-- ---------------------------------------------------------------------------
-- 3. `agency_float_reconciliations`
--
-- Correction C9, the electronic half. The company's ledger balance for one
-- till against the provider's own statement for the same till on the same day.
--
-- `variance` is GENERATED, so it cannot be typed in. A reconciliation whose
-- stated variance disagrees with its own two balances would be worse than no
-- reconciliation, and making it a stored generated column removes the
-- possibility rather than testing for it.
-- ---------------------------------------------------------------------------

create table public.agency_float_reconciliations (
  id                         uuid primary key default gen_random_uuid(),
  float_account_id           uuid not null references public.agency_provider_float_accounts(id) on delete restrict,
  reconciliation_date        date not null,
  system_closing_balance     bigint not null,
  provider_statement_balance bigint not null,
  variance                   bigint not null
                               generated always as
                               (system_closing_balance - provider_statement_balance) stored,
  variance_written_off       bigint not null default 0,
  variance_journal_entry_id  uuid references public.journal_entries(id) on delete restrict,
  notes                      text,
  status                     text not null default 'open',
  reconciled_by              uuid references public.profiles(id) on delete restrict,
  reconciled_at              timestamptz,
  created_by                 uuid not null references public.profiles(id) on delete restrict,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),

  constraint agency_float_recon_status_valid
    check (status = any (array['open', 'reconciled'])),

  -- A closed reconciliation names who closed it and when. An open one has
  -- neither.
  constraint agency_float_recon_closed_is_complete
    check (
      status <> 'reconciled'
      or (reconciled_by is not null and reconciled_at is not null)
    ),
  constraint agency_float_recon_open_is_clean
    check (
      status = 'reconciled'
      or (reconciled_by is null and reconciled_at is null)
    ),

  -- Money may only be written off by somebody approving the reconciliation,
  -- and only with the journal entry that did it. This is the structural half
  -- of "never permit unauthorized or unbalanced financial adjustments".
  constraint agency_float_recon_writeoff_needs_approval
    check (
      variance_written_off = 0
      or (status = 'reconciled' and variance_journal_entry_id is not null)
    ),

  unique (float_account_id, reconciliation_date)
);

comment on table public.agency_float_reconciliations is
  'Phase 4A, correction C9. One till''s ledger float balance against the provider''s own statement for the same day. variance is a stored generated column so it cannot contradict the two balances it is derived from. A write-off requires both approval and a journal entry.';


-- ---------------------------------------------------------------------------
-- 4. `agency_cash_reconciliations`
--
-- Correction C9, the physical half: notes and coins counted in the drawer
-- against the branch's 1010 Cash at Hand.
--
-- Note the variance is signed the other way round from the float table, and
-- deliberately so. Here the count is the fact and the ledger is the claim, so
-- `physical_count - system_closing_balance` is "what we actually have, less
-- what we said we had". For float the statement is the fact, so the subtraction
-- runs the other way. Both read as "our figure minus the truth" in their own
-- context; the two tables are not meant to be summed.
--
-- Correction C10: the 1010 account is intentionally shared with lending. A
-- cash reconciliation here is a reconciliation of the whole till, not of an
-- agency-only slice of it.
-- ---------------------------------------------------------------------------

create table public.agency_cash_reconciliations (
  id                        uuid primary key default gen_random_uuid(),
  branch_id                 uuid not null references public.branches(id) on delete restrict,
  cash_account_id           uuid not null references public.ledger_accounts(id) on delete restrict,
  reconciliation_date       date not null,
  system_closing_balance    bigint not null,
  physical_count            bigint not null,
  variance                  bigint not null
                              generated always as
                              (physical_count - system_closing_balance) stored,
  variance_written_off      bigint not null default 0,
  variance_journal_entry_id uuid references public.journal_entries(id) on delete restrict,
  notes                     text,
  status                    text not null default 'open',
  reconciled_by             uuid references public.profiles(id) on delete restrict,
  reconciled_at             timestamptz,
  created_by                uuid not null references public.profiles(id) on delete restrict,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  constraint agency_cash_recon_status_valid
    check (status = any (array['open', 'reconciled'])),
  constraint agency_cash_recon_count_not_negative
    check (physical_count >= 0),
  constraint agency_cash_recon_closed_is_complete
    check (
      status <> 'reconciled'
      or (reconciled_by is not null and reconciled_at is not null)
    ),
  constraint agency_cash_recon_open_is_clean
    check (
      status = 'reconciled'
      or (reconciled_by is null and reconciled_at is null)
    ),
  constraint agency_cash_recon_writeoff_needs_approval
    check (
      variance_written_off = 0
      or (status = 'reconciled' and variance_journal_entry_id is not null)
    ),

  unique (branch_id, cash_account_id, reconciliation_date)
);

comment on table public.agency_cash_reconciliations is
  'Phase 4A, correction C9 and C10. A physical cash count against the branch''s shared 1010 Cash at Hand. The 1010 account is deliberately shared with lending, so this reconciles the whole till rather than an agency-only slice. variance is physical_count - system_closing_balance: what is actually there, less what the books claim.';


-- ---------------------------------------------------------------------------
-- 5. Immutability
--
-- A settlement and a reconciliation are financial records. Neither may be
-- deleted; a payable settlement is undone by reversal, and a reconciliation
-- by a later one for the same day being impossible — the unique key means the
-- day's answer is given once.
-- ---------------------------------------------------------------------------

-- Each of these rows has a lifecycle after insert: a payable settlement can be
-- reversed, a reconciliation can be approved, and the journal id is stamped
-- once the entry it points at exists. So each carries `updated_at` and the
-- trigger that advances it.
create trigger agency_commission_settlements_set_updated_at
  before update on public.agency_commission_settlements
  for each row execute function public.set_updated_at();

create trigger agency_payable_settlements_set_updated_at
  before update on public.agency_payable_settlements
  for each row execute function public.set_updated_at();

create trigger agency_float_reconciliations_set_updated_at
  before update on public.agency_float_reconciliations
  for each row execute function public.set_updated_at();

create trigger agency_cash_reconciliations_set_updated_at
  before update on public.agency_cash_reconciliations
  for each row execute function public.set_updated_at();

create trigger agency_commission_settlements_no_delete
  before delete on public.agency_commission_settlements
  for each row execute function public.reject_mutation();

create trigger agency_payable_settlements_no_delete
  before delete on public.agency_payable_settlements
  for each row execute function public.reject_mutation();

create trigger agency_float_reconciliations_no_delete
  before delete on public.agency_float_reconciliations
  for each row execute function public.reject_mutation();

create trigger agency_cash_reconciliations_no_delete
  before delete on public.agency_cash_reconciliations
  for each row execute function public.reject_mutation();


-- ---------------------------------------------------------------------------
-- 6. Row-level security
-- ---------------------------------------------------------------------------

alter table public.agency_commission_settlements enable row level security;
alter table public.agency_payable_settlements enable row level security;
alter table public.agency_float_reconciliations enable row level security;
alter table public.agency_cash_reconciliations enable row level security;

revoke all on table public.agency_commission_settlements from anon, authenticated;
revoke all on table public.agency_payable_settlements from anon, authenticated;
revoke all on table public.agency_float_reconciliations from anon, authenticated;
revoke all on table public.agency_cash_reconciliations from anon, authenticated;

grant select on table public.agency_commission_settlements to authenticated;
grant select on table public.agency_payable_settlements to authenticated;
grant select on table public.agency_float_reconciliations to authenticated;
grant select on table public.agency_cash_reconciliations to authenticated;

-- Hoisted: the capability is evaluated once per statement, and the branch
-- test is restated inline rather than calling `user_can_see_branch()`. See
-- migration 20261018000100 and `tests/db/rls-hoisting.test.ts`.

create policy agency_commission_settlements_select_with_permission
  on public.agency_commission_settlements for select to authenticated
  using (
    (select public.user_has_permission('agency:reports'))
    and (
      branch_id is null
      or (select public.current_user_branch_id()) is null
      or branch_id = (select public.current_user_branch_id())
    )
  );

create policy agency_payable_settlements_select_with_permission
  on public.agency_payable_settlements for select to authenticated
  using (
    (select public.user_has_permission('agency:reports'))
    and (
      branch_id is null
      or (select public.current_user_branch_id()) is null
      or branch_id = (select public.current_user_branch_id())
    )
  );

-- A float reconciliation has no branch column of its own; its branch is the
-- till's, so the predicate reaches through the registry. The branch comparison
-- inside the EXISTS is still the restated form, for the same reason.
create policy agency_float_reconciliations_select_with_permission
  on public.agency_float_reconciliations for select to authenticated
  using (
    (select public.user_has_permission('agency:reports'))
    and exists (
      select 1 from public.agency_provider_float_accounts f
      where f.id = agency_float_reconciliations.float_account_id
        and (
          (select public.current_user_branch_id()) is null
          or f.branch_id = (select public.current_user_branch_id())
        )
    )
  );

create policy agency_cash_reconciliations_select_with_permission
  on public.agency_cash_reconciliations for select to authenticated
  using (
    (select public.user_has_permission('agency:reports'))
    and (
      branch_id is null
      or (select public.current_user_branch_id()) is null
      or branch_id = (select public.current_user_branch_id())
    )
  );


-- ---------------------------------------------------------------------------
-- 7. Indexes
-- ---------------------------------------------------------------------------

create index agency_commission_settlements_provider_idx
  on public.agency_commission_settlements (provider_id, settlement_date desc);

create index agency_payable_settlements_provider_idx
  on public.agency_payable_settlements (provider_id, settlement_date desc, status);

create index agency_float_reconciliations_date_idx
  on public.agency_float_reconciliations (reconciliation_date desc, status);

create index agency_cash_reconciliations_date_idx
  on public.agency_cash_reconciliations (branch_id, reconciliation_date desc, status);
