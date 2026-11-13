-- ===========================================================================
-- Phase 4E — float bought, float sold, float moved between lines
--
-- Decision OD-7: "Cashiers may record purchases, sales and transfers. A
-- different Manager or Owner/Admin must verify before posting. Pending
-- transactions must not affect financial balances. Preserve revision checks
-- and maker-checker controls."
--
-- That is the shape the transaction engine already has, and it is a different
-- shape from the one float movement already had. `post_float_replenishment()`
-- records and posts in a single call by one holder of `agency:settlements`,
-- which was right when only a Manager could move float and there was one kind
-- of movement — a top-up from the branch's own cash or bank.
--
-- ## Why a new register rather than an extended one
--
-- Three reasons, in increasing order of importance.
--
-- Shape: a purchase at a premium, a sale with a fee and a line-to-line
-- transfer post three different journals, and only one of them is the
-- replenishment's "Dr float, Cr cash".
--
-- Lifecycle: a replenishment has no pending state, because it never needed
-- one. Adding `status` to it would change the meaning of every row already
-- there, and of the screen and the 78 settlement tests that read them.
--
-- Separation of duties: `post_float_replenishment()` lets one person move
-- float. OD-7 says two people must. Rather than weaken the new rule to fit
-- the old path, the new path implements the rule, and the old one keeps the
-- authority it always had — `agency:settlements`, which a cashier does not
-- hold. Retiring it is a follow-up, recorded in the delivery report, not a
-- thing to do in the same change that introduces its replacement.
--
-- ## One table, three kinds
--
-- `kind` discriminates, and a CHECK per kind requires exactly the columns
-- that kind needs and forbids the rest — so a transfer cannot carry a fee and
-- a sale cannot carry a counterparty line. One table keeps one register, one
-- verification function, one reversal and one set of duplicate indexes; three
-- tables would need four copies of each and would answer "what has this line
-- traded" three different ways.
--
-- ## Pending affects nothing, by construction
--
-- No journal is written until verification. Every balance in this schema is
-- derived from `journal_lines`, so a pending trade cannot move one: there is
-- nothing to subtract it from. That is stronger than a rule saying it must
-- not, and it is why this table carries no "provisional balance" column for
-- anybody to read by mistake.
-- ===========================================================================

create table if not exists public.agency_float_trades (
  id                       uuid primary key default gen_random_uuid(),
  kind                     text not null,
  provider_id              uuid not null references public.agency_service_providers(id) on delete restrict,
  branch_id                uuid not null references public.branches(id) on delete restrict,

  -- The line this trade is about: receiving on a purchase, selling on a sale,
  -- sending on a transfer.
  float_account_id         uuid not null references public.agency_provider_float_accounts(id) on delete restrict,
  -- A transfer's receiving line, and its branch, which may differ (OD-3).
  counter_float_account_id uuid references public.agency_provider_float_accounts(id) on delete restrict,
  counter_branch_id        uuid references public.branches(id) on delete restrict,
  -- Cash or bank: the funding account on a purchase, the receiving account on
  -- a sale, nothing on a transfer.
  settlement_account_id    uuid references public.ledger_accounts(id) on delete restrict,

  trade_date               date not null,
  float_amount             bigint not null,
  -- What was actually paid for a purchase. Equal to float_amount at face
  -- value; more is a premium, less is a discount (OD-1).
  cash_amount              bigint,
  -- A sale's service fee, manually entered, zero for "sell without fee"
  -- (OD-6). Never a rate.
  fee_amount               bigint,

  source_kind              text,
  counterparty_name        text,
  reference                text not null,
  notes                    text,

  status                   text not null default 'pending',
  revision                 integer not null default 1,
  verified_by              uuid references public.profiles(id) on delete restrict,
  verified_at              timestamptz,
  rejected_reason          text,
  journal_entry_id         uuid references public.journal_entries(id) on delete restrict,

  reversal_entry_id        uuid references public.journal_entries(id) on delete restrict,
  reversed_by              uuid references public.profiles(id) on delete restrict,
  reversed_at              timestamptz,
  reversal_reason          text,

  created_by               uuid not null references public.profiles(id) on delete restrict,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  constraint agency_float_trade_kind_valid
    check (kind = any (array['purchase', 'sale', 'transfer'])),

  constraint agency_float_trade_status_valid
    check (status = any (array['pending', 'posted', 'rejected', 'reversed'])),

  constraint agency_float_trade_amount_positive
    check (float_amount > 0),

  constraint agency_float_trade_revision_positive
    check (revision > 0),

  constraint agency_float_trade_reference_stated
    check (pg_catalog.btrim(reference) = reference
           and pg_catalog.length(reference) between 3 and 80),

  -- A purchase pays cash or bank for float, and records what it actually paid.
  constraint agency_float_trade_purchase_shape
    check (kind <> 'purchase'
           or (cash_amount is not null and cash_amount > 0
               and settlement_account_id is not null
               and source_kind is not null
               and counter_float_account_id is null
               and counter_branch_id is null
               and fee_amount is null)),

  -- A sale gives float and receives cash or bank, with an optional fee.
  constraint agency_float_trade_sale_shape
    check (kind <> 'sale'
           or (fee_amount is not null and fee_amount >= 0
               and settlement_account_id is not null
               and cash_amount is null
               and source_kind is null
               and counter_float_account_id is null
               and counter_branch_id is null)),

  -- A transfer moves float between two lines and touches no cash at all.
  constraint agency_float_trade_transfer_shape
    check (kind <> 'transfer'
           or (counter_float_account_id is not null
               and counter_float_account_id <> float_account_id
               and counter_branch_id is not null
               and settlement_account_id is null
               and cash_amount is null
               and fee_amount is null
               and source_kind is null)),

  constraint agency_float_trade_source_kind_valid
    check (source_kind is null
           or source_kind = any (array[
             'provider_service_centre', 'external_agent', 'bank', 'cash'])),

  -- Maker-checker, at the data layer. The person who recorded a trade may not
  -- be the person who posted it, whatever a screen offers.
  constraint agency_float_trade_checker_is_not_maker
    check (verified_by is null or verified_by <> created_by),

  -- A posted trade carries its journal, its checker and the moment it posted.
  constraint agency_float_trade_posted_is_complete
    check (status <> 'posted'
           or (journal_entry_id is not null
               and verified_by is not null
               and verified_at is not null)),

  -- A pending trade carries none of them, and no rejection either.
  constraint agency_float_trade_pending_is_clean
    check (status <> 'pending'
           or (journal_entry_id is null
               and verified_by is null
               and verified_at is null
               and rejected_reason is null
               and reversal_entry_id is null)),

  constraint agency_float_trade_rejected_states_reason
    check (status <> 'rejected'
           or (pg_catalog.btrim(coalesce(rejected_reason, '')) <> ''
               and journal_entry_id is null)),

  constraint agency_float_trade_reversed_is_complete
    check (status <> 'reversed'
           or (reversal_entry_id is not null
               and reversed_by is not null
               and reversed_at is not null
               and pg_catalog.btrim(coalesce(reversal_reason, '')) <> ''
               and journal_entry_id is not null)),

  constraint agency_float_trade_unreversed_is_clean
    check (status = 'reversed'
           or (reversal_entry_id is null
               and reversed_by is null
               and reversed_at is null
               and reversal_reason is null))
);

comment on table public.agency_float_trades is
  'Phase 4E, decision OD-7. Float bought from a service centre or another agent, sold to one, or moved between two lines of the same provider. Recorded by a cashier and posted only when a different holder of agency:settlements verifies it, so a pending row moves no money — there is no journal, and every balance here is derived from journals.';
comment on column public.agency_float_trades.cash_amount is
  'Phase 4E, decision OD-1. What a purchase actually paid. Equal to float_amount at face value; more is a premium, recognised as an expense in 5970; less is a discount, recognised as income in 4580.';
comment on column public.agency_float_trades.fee_amount is
  'Phase 4E, decision OD-6. A sale''s service fee, entered by hand and credited to 4570. Zero is "sell without fee", stated rather than left null. No rate or percentage is applied anywhere.';
comment on column public.agency_float_trades.revision is
  'Phase 4E. Incremented whenever a pending trade''s financial details change, so a verifier cannot post figures they have not seen. The same control verify_agency_transaction() uses.';

create unique index if not exists agency_float_trade_reference_unique
  on public.agency_float_trades (float_account_id, reference);

create index if not exists agency_float_trade_pending_idx
  on public.agency_float_trades (branch_id, status, trade_date);

create index if not exists agency_float_trade_line_idx
  on public.agency_float_trades (float_account_id, trade_date);

create index if not exists agency_float_trade_counter_idx
  on public.agency_float_trades (counter_float_account_id)
  where counter_float_account_id is not null;


-- ---------------------------------------------------------------------------
-- Row level security
--
-- Read for anyone who may see the branch and holds agency:reports. Writes go
-- through the functions in the next migration and nowhere else: the table
-- grants no INSERT or UPDATE to `authenticated` at all.
-- ---------------------------------------------------------------------------

alter table public.agency_float_trades enable row level security;
revoke all on table public.agency_float_trades from anon, authenticated;
grant select on table public.agency_float_trades to authenticated;

drop policy if exists agency_float_trades_read on public.agency_float_trades;
-- The branch rule restated inline, for the reason 20261018000100 gives:
-- `user_can_see_branch()` is correlated and SECURITY DEFINER, so it runs two
-- queries against `profiles` for every row rather than once for the query.
-- Both ends of a transfer are named, because a cross-branch transfer concerns
-- the receiving branch too.
create policy agency_float_trades_read
  on public.agency_float_trades for select
  to authenticated
  using ((select public.user_has_permission('agency:reports'))
         and (branch_id is null
              or (select public.current_user_branch_id()) is null
              or branch_id = (select public.current_user_branch_id())
              or counter_branch_id = (select public.current_user_branch_id())));

comment on policy agency_float_trades_read on public.agency_float_trades is
  'Phase 4E. A trade is visible to either end of it: a cross-branch transfer concerns both branches, and the receiving branch must be able to see what is coming before it is posted.';


-- ---------------------------------------------------------------------------
-- Append-only in the ways that matter
-- ---------------------------------------------------------------------------

drop trigger if exists agency_float_trades_no_delete on public.agency_float_trades;
create trigger agency_float_trades_no_delete
  before delete on public.agency_float_trades
  for each row execute function public.reject_mutation();

drop trigger if exists agency_float_trades_set_updated_at on public.agency_float_trades;
create trigger agency_float_trades_set_updated_at
  before update on public.agency_float_trades
  for each row execute function public.set_updated_at();


-- ---------------------------------------------------------------------------
-- The revision guard
--
-- Mirrors `agency_transaction_revision_guard()`: any change to the figures a
-- verifier would be approving bumps the revision, and the verifier passes the
-- revision it saw. A stale one is refused rather than posted.
--
-- The immutable facts are guarded here too. Once a trade is recorded, what it
-- is and which accounts it touches are not editable — a cashier who chose the
-- wrong line records a new trade and has this one rejected.
-- ---------------------------------------------------------------------------

create or replace function public.agency_float_trade_revision_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.kind is distinct from old.kind
     or new.provider_id is distinct from old.provider_id
     or new.branch_id is distinct from old.branch_id
     or new.float_account_id is distinct from old.float_account_id
     or new.counter_float_account_id is distinct from old.counter_float_account_id
     or new.settlement_account_id is distinct from old.settlement_account_id then
    raise exception
      'What a float trade is, and which accounts it touches, cannot be changed once it is recorded. Reject it and record the right one.'
      using errcode = 'P0001';
  end if;

  if new.float_amount is distinct from old.float_amount
     or new.cash_amount is distinct from old.cash_amount
     or new.fee_amount is distinct from old.fee_amount
     or new.trade_date is distinct from old.trade_date then
    if old.status <> 'pending' then
      raise exception
        'Only a pending float trade can be edited; this one is %.', old.status
        using errcode = 'P0001';
    end if;
    new.revision := old.revision + 1;
  end if;

  return new;
end;
$$;

revoke all on function public.agency_float_trade_revision_guard()
  from public, anon, authenticated;

comment on function public.agency_float_trade_revision_guard() is
  'Phase 4E. Refuses a change to what a float trade is or which accounts it touches, and increments the revision when its figures change while pending, so a verifier cannot post an amount they never saw.';

drop trigger if exists agency_float_trades_revision on public.agency_float_trades;
create trigger agency_float_trades_revision
  before update on public.agency_float_trades
  for each row execute function public.agency_float_trade_revision_guard();
