-- ===========================================================================
-- Phase 6 — the payment ledger.
--
-- ## Two tables, and why the schedule is not one of them
--
--   * `loan_payments` — the money that arrived: how much, by what means, when,
--     from whom, recorded by whom.
--   * `payment_allocations` — which scheduled collections that money
--     satisfied, and how much of each was principal and how much interest.
--
-- `loan_installments` (Phase 5) is **not touched**. A Monday scheduled at
-- UGX 4,000 stays UGX 4,000 forever; whether it has been paid is a fact about
-- payments, not about the schedule. Keeping them apart is what lets Phase 7
-- compute arrears on an unpaid collection without rewriting the collection —
-- see ADR-026, which anticipated exactly this.
--
-- ## No stored balance columns
--
-- There is no `amount_paid` on the loan, no `remaining_balance`, no
-- `arrears_balance`. Every balance is derived from the contract and the
-- allocations of **posted** payments, through the views in migration
-- `20261006000400`. A reversal therefore changes every balance in the system
-- the instant it commits, because the reversed payment's allocations simply
-- stop being counted — no cache to invalidate and nothing to go stale.
--
-- The one apparent exception is `outstanding_before` / `outstanding_after` on
-- the payment row. Those are **not balances**. They are a record of what the
-- receipt said at the counter, frozen at the moment of posting, and nothing
-- reads them to answer "what is owed". See ADR-029.
-- ===========================================================================

create table public.loan_payments (
  id uuid primary key default gen_random_uuid(),

  -- Minted by `next_reference('payment')`, the Phase 1 atomic generator.
  -- Refused if supplied, immutable once issued. Doubles as the receipt
  -- number: a second numbering system would be two things to reconcile and
  -- one more way for a receipt to name a payment that does not exist.
  payment_number text not null unique,

  loan_id uuid not null references public.loans (id) on delete restrict,
  -- Denormalised from the loan so the register can filter by borrower without
  -- a join, and so a payment is still attributable if a loan is ever
  -- restructured into another. Checked against the loan at posting.
  client_id uuid not null references public.clients (id) on delete restrict,

  amount bigint not null,

  payment_method text not null,

  -- The network's transaction reference, for Mobile Money. Normalised at
  -- posting: trimmed and upper-cased, never otherwise altered. Required for
  -- Mobile Money and absent for cash — see the constraints below.
  external_reference text,

  -- --- Idempotency -------------------------------------------------------
  -- Every payment carries one, and it is unique. A retried submission — a
  -- double-tap on a phone, a lost response, a browser replaying a form —
  -- arrives with the same key and `post_payment` returns the payment that
  -- already exists rather than recording the money twice.
  --
  -- Cash is the case that needs this: Mobile Money has a network reference
  -- that makes a duplicate detectable, and cash has nothing. See ADR-030.
  idempotency_key uuid not null unique,

  status text not null default 'posted',

  -- Database time, not the browser's. A clock the client controls is a clock
  -- an attacker controls, and backdating a payment changes which collections
  -- it covers. A genuine historical entry would need its own audited
  -- workflow; this phase does not offer one.
  received_at timestamptz not null default pg_catalog.now(),

  recorded_by uuid not null references public.profiles (id) on delete restrict,

  -- --- The receipt record ------------------------------------------------
  -- What the borrower was told, frozen. Written by `post_payment` from
  -- figures it derived itself, never accepted from a caller.
  outstanding_before bigint not null,
  outstanding_after bigint not null,

  -- The borrower's name as it read when the receipt was issued. The client
  -- record may legitimately change later; an old receipt should still show
  -- what was printed on it.
  client_name_at_payment text not null,
  -- And who took the money, as a label rather than only an id, so a receipt
  -- is still readable after a staff account is disabled or renamed.
  recorded_by_label text not null,

  notes text,

  -- --- Reversal ----------------------------------------------------------
  -- The only fields that may ever be added after posting, and only by
  -- `reverse_payment`. Everything above is frozen; see migration
  -- 20261006000500.
  reversed_at timestamptz,
  reversed_by uuid references public.profiles (id) on delete restrict,
  reversal_reason text,

  created_at timestamptz not null default pg_catalog.now(),

  -- --- Structural integrity ----------------------------------------------
  constraint loan_payments_number_shape
    check (payment_number ~ '^PAY[0-9]{6,}$'),

  -- Money, and a payment of nothing is not a payment.
  constraint loan_payments_amount_positive check (amount > 0),
  -- Mirrors MAX_UGX_AMOUNT in lib/domain/money.ts.
  constraint loan_payments_amount_in_range check (amount <= 1000000000000000),

  constraint loan_payments_method_valid
    check (payment_method in ('cash', 'mtn_mobile_money', 'airtel_money')),

  constraint loan_payments_status_valid
    check (status in ('posted', 'reversed')),

  -- --- The external reference rules ---------------------------------------
  --
  -- Required for Mobile Money, because it is the only thing that makes a
  -- duplicate detectable: two UGX 4,000 MTN payments from one borrower on one
  -- day are indistinguishable without it, and one of them may be a
  -- double-posting of the other.
  --
  -- Forbidden for cash, rather than merely optional. An optional field that is
  -- sometimes filled invites staff to type a receipt book number into it, and
  -- then the uniqueness rule below starts refusing legitimate payments. Cash
  -- is identified by its payment number.
  constraint loan_payments_reference_required_for_mobile_money
    check (
      payment_method = 'cash'
      or (external_reference is not null and btrim(external_reference) <> '')
    ),
  constraint loan_payments_no_reference_for_cash
    check (payment_method <> 'cash' or external_reference is null),

  -- Normalisation is enforced, not merely applied. If it were only applied by
  -- the posting function, a direct insert could store ' abc123 ' and defeat
  -- the uniqueness rule by whitespace alone.
  constraint loan_payments_reference_normalised
    check (
      external_reference is null
      or (
        external_reference = pg_catalog.upper(pg_catalog.btrim(external_reference))
        and char_length(external_reference) between 4 and 64
      )
    ),

  -- --- The receipt figures ------------------------------------------------
  constraint loan_payments_outstanding_non_negative
    check (outstanding_before >= 0 and outstanding_after >= 0),
  -- The specification's receipt invariant, enforced rather than tested:
  -- previous balance minus the payment is the new balance.
  constraint loan_payments_receipt_balances
    check (outstanding_after = outstanding_before - amount),

  constraint loan_payments_client_name_not_blank
    check (btrim(client_name_at_payment) <> ''),
  constraint loan_payments_recorded_by_label_not_blank
    check (btrim(recorded_by_label) <> ''),

  constraint loan_payments_notes_length
    check (notes is null or char_length(notes) <= 1000),

  -- --- Reversal consistency -----------------------------------------------
  -- Each half of the reversal implies the others. Without this a payment
  -- could read as reversed with nobody named and no reason given, which is
  -- worse than useless in a dispute: it looks like a record and answers
  -- nothing.
  constraint loan_payments_reversal_complete
    check (
      (reversed_at is null and reversed_by is null and reversal_reason is null)
      or (
        reversed_at is not null
        and reversed_by is not null
        and reversal_reason is not null
        and btrim(reversal_reason) <> ''
      )
    ),
  constraint loan_payments_reversal_matches_status
    check ((status = 'reversed') = (reversed_at is not null)),
  constraint loan_payments_reversal_reason_length
    check (reversal_reason is null or char_length(reversal_reason) <= 500),

  -- --- Chronology ---------------------------------------------------------
  constraint loan_payments_reversed_after_received
    check (reversed_at is null or reversed_at >= received_at),
  constraint loan_payments_received_plausible
    check (received_at >= '2020-01-01'::timestamptz)
);

comment on table public.loan_payments is
  'The payment ledger. Append-only apart from the reversal stamp; balances are derived from allocations, never stored here. outstanding_before/after record what the receipt said, not what is owed now.';
comment on column public.loan_payments.payment_number is
  'Business reference and receipt number, e.g. PAY260001. Minted atomically by next_reference(); immutable.';
comment on column public.loan_payments.idempotency_key is
  'Unique per payment. A retried submission reuses it and post_payment returns the existing payment rather than recording the money twice.';
comment on column public.loan_payments.outstanding_before is
  'The loan balance before this payment, as printed on the receipt. A historical record, never read to answer what is currently owed — see ADR-029.';
comment on column public.loan_payments.received_at is
  'Database time at posting. Never supplied by a caller: a clock the client controls decides which collections a payment covers.';
comment on column public.loan_payments.status is
  'posted or reversed. A reversed payment keeps its amount and its allocations; they simply stop counting toward the balance.';

-- ---------------------------------------------------------------------------
-- Duplicate Mobile Money references
--
-- Unique on (method, reference) rather than on the reference alone, because
-- MTN and Airtel number their transactions independently and a format
-- collision across the two networks would be a genuine coincidence, not a
-- duplicate. Scoping by method lets each network's numbering be authoritative
-- for itself.
--
-- Partial, so cash — which has no reference — is not forced into a
-- single-row-per-NULL arrangement.
--
-- Note this binds *reversed* payments too. A reference already used and then
-- reversed cannot be reused, which is correct: reversal does not un-happen the
-- network transaction, and permitting reuse would make the duplicate check
-- defeatable by reversing first.
-- ---------------------------------------------------------------------------

create unique index loan_payments_unique_external_reference
  on public.loan_payments (payment_method, external_reference)
  where external_reference is not null;

comment on index public.loan_payments_unique_external_reference is
  'One payment per network transaction reference. Scoped by method so an MTN and an Airtel reference of the same shape do not collide. Binds reversed payments too, so reversing cannot free a reference for reuse.';

-- ---------------------------------------------------------------------------
-- payment_allocations — where the money went
-- ---------------------------------------------------------------------------

create table public.payment_allocations (
  id uuid primary key default gen_random_uuid(),

  payment_id uuid not null references public.loan_payments (id) on delete restrict,
  installment_id uuid not null
    references public.loan_installments (id) on delete restrict,

  -- Denormalised for the per-loan aggregates the balance views compute, and
  -- safe to denormalise because both parents are append-only: neither value
  -- can change, so they cannot come to disagree.
  loan_id uuid not null references public.loans (id) on delete restrict,

  allocated_amount bigint not null,
  allocated_principal bigint not null,
  allocated_interest bigint not null,

  created_at timestamptz not null default pg_catalog.now(),

  constraint payment_allocations_amount_positive check (allocated_amount > 0),
  constraint payment_allocations_components_non_negative
    check (allocated_principal >= 0 and allocated_interest >= 0),
  -- The components are the amount. Enforced per row, so no allocation can
  -- credit a borrower's principal without the interest adding up.
  constraint payment_allocations_components_sum
    check (allocated_amount = allocated_principal + allocated_interest),

  -- One allocation per installment per payment. Two would still reconcile on
  -- totals while making the per-installment caps harder to reason about, and
  -- there is no reason for a payment to touch one collection twice.
  constraint payment_allocations_unique_per_payment
    unique (payment_id, installment_id)
);

comment on table public.payment_allocations is
  'Which scheduled collections a payment satisfied, split into principal and interest. Append-only. A reversed payment keeps its allocations as history; the balance views exclude them.';
comment on column public.payment_allocations.loan_id is
  'Denormalised from the payment. Safe because both parents are append-only, so the two cannot drift.';

-- ---------------------------------------------------------------------------
-- Indexes
--
-- Each answers a query the system actually makes. Nothing speculative: an
-- index that is never probed still costs on every insert, and a payment
-- posting writes an allocation per collection it touches.
-- ---------------------------------------------------------------------------

-- The payment register, newest first, and the per-loan history.
create index loan_payments_loan_received_idx
  on public.loan_payments (loan_id, received_at desc);
create index loan_payments_client_received_idx
  on public.loan_payments (client_id, received_at desc);
create index loan_payments_received_at_idx
  on public.loan_payments (received_at desc);

-- "What did we collect today, and how much of it was cash." Partial, because
-- the collection totals only ever count posted payments.
create index loan_payments_method_received_idx
  on public.loan_payments (payment_method, received_at desc)
  where status = 'posted';

-- Searching by the network reference a borrower quotes over the phone.
create index loan_payments_external_reference_idx
  on public.loan_payments (external_reference)
  where external_reference is not null;

-- The balance aggregates, which group by loan and by installment.
create index payment_allocations_loan_idx on public.payment_allocations (loan_id);
create index payment_allocations_installment_idx
  on public.payment_allocations (installment_id);
create index payment_allocations_payment_idx on public.payment_allocations (payment_id);

-- ---------------------------------------------------------------------------
-- Payment numbering
-- ---------------------------------------------------------------------------

create or replace function public.loan_payments_assign_number()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Refused rather than silently overwritten, matching the Phase 4 precedent
  -- for loan numbers. A caller that believes it is choosing a receipt number
  -- is a caller worth correcting loudly.
  if new.payment_number is not null then
    raise exception 'A payment number is assigned by the database, not by the caller.'
      using errcode = 'P0001';
  end if;

  new.payment_number := public.next_reference('payment');

  return new;
end;
$$;

comment on function public.loan_payments_assign_number() is
  'BEFORE INSERT on loan_payments: mints the payment and receipt number atomically. A supplied value is refused.';

create trigger loan_payments_assign_number
  before insert on public.loan_payments
  for each row execute function public.loan_payments_assign_number();

revoke all on function public.loan_payments_assign_number()
  from public, anon, authenticated;

alter table public.loan_payments enable row level security;
alter table public.payment_allocations enable row level security;

revoke all on table public.loan_payments from anon, authenticated;
revoke all on table public.payment_allocations from anon, authenticated;
