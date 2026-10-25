-- ===========================================================================
-- Polytos Phase 2.4 — the registration fee, and the receipt that proves it
--
-- ## A receipt is not a settlement, and this schema says which it is
--
-- The row below records that money was **taken at the counter** and that a
-- journal was posted for it. For cash that is the whole story. For MTN,
-- Airtel and a bank transfer it is not: the network says the transfer
-- happened, and the business finds out whether it really did when the account
-- is reconciled against the statement.
--
-- This phase deliberately does **not** invent a `settlement_status` column
-- for that, because the system already has the mechanism:
-- `account_reconciliations` compares an account's system balance against a
-- counted one, and every posting this migration makes lands in a branch cash,
-- Mobile Money or bank account and is therefore already inside it. Adding a
-- second, parallel notion of "settled" would give two answers to one
-- question. What the receipt carries instead is the network's own reference,
-- required for every non-cash method, which is what makes the line findable
-- on the statement.
--
-- ## The amount comes from the policy, never from the caller
--
-- `p_amount` is checked against `membership_policy_versions.registration_fee`
-- on the version the member is enrolled under, and a mismatch is refused. A
-- posting function that accepted whatever amount it was handed would make the
-- published policy advisory — and the fee is the one figure in the whole
-- programme that the client's documents state without ambiguity.
--
-- ## One live receipt per membership
--
-- A partial unique index over `status = 'posted'`. A fee reversed in error can
-- be taken again; a fee taken twice cannot stand. This is also what makes the
-- activation precondition in 20261020001000 a single, cheap `exists`.
-- ===========================================================================

create table public.membership_fee_receipts (
  id uuid primary key default gen_random_uuid(),

  -- Minted by `next_reference('membership_fee')` in a BEFORE INSERT trigger,
  -- never supplied: the same discipline the payment number carries, and for
  -- the same reason — it is printed and handed to a member.
  receipt_number text not null unique,

  membership_id uuid not null references public.memberships(id) on delete restrict,
  -- Denormalised from the membership rather than joined, because a receipt is
  -- a document: it has to stay readable and attributable on its own.
  client_id uuid not null references public.clients(id) on delete restrict,
  branch_id uuid not null references public.branches(id) on delete restrict,
  -- The terms the fee was charged under. Freezes which published figure this
  -- receipt is evidence of.
  policy_version_id uuid not null
    references public.membership_policy_versions(id) on delete restrict,

  amount bigint not null,

  payment_method text not null,
  -- Where the money landed. A real account, not a label: this is the leg the
  -- journal debits and the balance a reconciliation counts.
  receiving_account_id uuid not null
    references public.ledger_accounts(id) on delete restrict,
  external_reference text,

  -- The retry key. A lost response, a double tap and a replayed form all
  -- arrive with the same key and get the same receipt back.
  idempotency_key uuid not null unique,

  status text not null default 'posted',

  received_at timestamptz not null default pg_catalog.now(),
  -- The business day it belongs to, in Africa/Kampala. A receipt taken at
  -- 00:30 Kampala is that day's takings, not the previous day's, and a
  -- timestamp alone would make that a timezone question.
  business_date date not null,

  -- The journal this receipt wrote. RESTRICT: the entry is the accounting
  -- evidence for the document, and neither may outlive the other.
  journal_entry_id uuid references public.journal_entries(id) on delete restrict,
  reversal_entry_id uuid references public.journal_entries(id) on delete restrict,

  recorded_by uuid references public.profiles(id) on delete set null,
  recorded_by_label text not null default 'system',
  -- The member's name as it was when they paid, for the printed receipt.
  client_name_at_payment text not null,

  notes text,

  reversed_at timestamptz,
  reversed_by uuid references public.profiles(id) on delete set null,
  reversed_by_label text,
  reversal_reason text,

  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),

  constraint membership_fee_receipt_number_shape
    check (receipt_number ~ '^MF[0-9]{6,}$'),
  constraint membership_fee_status_valid
    check (status in ('posted', 'reversed')),
  constraint membership_fee_amount_positive
    check (amount > 0 and amount <= 1000000000),
  constraint membership_fee_method_valid
    check (payment_method in ('cash', 'mtn_mobile_money', 'airtel_money', 'bank')),
  -- A cash payment has no network reference; its receipt number is its
  -- reference. Stated here as well as in the function, so the rule survives a
  -- caller that reaches the table another way.
  constraint membership_fee_cash_has_no_reference
    check (payment_method <> 'cash' or external_reference is null),
  constraint membership_fee_reference_length
    check (external_reference is null
           or char_length(btrim(external_reference)) between 4 and 100),
  constraint membership_fee_notes_length
    check (notes is null or char_length(notes) <= 1000),
  constraint membership_fee_client_name_not_blank
    check (btrim(client_name_at_payment) <> ''),
  -- A reversal is all three or none of them.
  constraint membership_fee_reversal_complete
    check (
      (status = 'reversed')
      = (reversed_at is not null and reversed_by_label is not null
         and reversal_reason is not null)
    ),
  constraint membership_fee_reversal_reason_length
    check (reversal_reason is null
           or char_length(btrim(reversal_reason)) between 4 and 500),
  constraint membership_fee_reversed_has_entry
    check (status <> 'reversed' or reversal_entry_id is not null)
);

comment on table public.membership_fee_receipts is
  'Polytos Phase 2. The registration fee a member paid to join, and the journal it posted. A posted, unreversed receipt is one of the two preconditions of activating a membership.';
comment on column public.membership_fee_receipts.receiving_account_id is
  'The branch cash, Mobile Money or bank account the money landed in. Non-cash receipts are recorded here and verified as settled through account_reconciliations, which already covers these accounts.';
comment on column public.membership_fee_receipts.idempotency_key is
  'Supplied by the caller. A retry carrying the same key returns the receipt that already exists rather than taking the fee twice.';

-- One live fee per membership. A reversed one does not occupy the slot.
create unique index membership_fee_receipts_one_posted_per_membership
  on public.membership_fee_receipts (membership_id)
  where status = 'posted';

-- The duplicate-network-reference rule the loan payments already carry: one
-- network reference identifies one movement of money.
create unique index membership_fee_receipts_reference_unique
  on public.membership_fee_receipts (payment_method, external_reference)
  where external_reference is not null;

create index membership_fee_receipts_membership_idx
  on public.membership_fee_receipts (membership_id, received_at desc);
create index membership_fee_receipts_client_idx
  on public.membership_fee_receipts (client_id);
create index membership_fee_receipts_branch_date_idx
  on public.membership_fee_receipts (branch_id, business_date desc);

create trigger membership_fee_receipts_set_updated_at
  before update on public.membership_fee_receipts
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- The receipt number
-- ---------------------------------------------------------------------------

create or replace function public.membership_fee_receipts_assign_number()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.receipt_number is not null then
    raise exception
      'A receipt number is assigned by the database, not by the caller.'
      using errcode = 'P0001';
  end if;

  new.receipt_number := public.next_reference('membership_fee');
  return new;
end;
$$;

create trigger membership_fee_receipts_assign_number
  before insert on public.membership_fee_receipts
  for each row execute function public.membership_fee_receipts_assign_number();

revoke all on function public.membership_fee_receipts_assign_number()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- A receipt is a document: it is reversed, never edited and never deleted
-- ---------------------------------------------------------------------------

create or replace function public.membership_fee_receipts_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
     or new.receipt_number is distinct from old.receipt_number
     or new.membership_id is distinct from old.membership_id
     or new.client_id is distinct from old.client_id
     or new.branch_id is distinct from old.branch_id
     or new.policy_version_id is distinct from old.policy_version_id
     or new.amount is distinct from old.amount
     or new.payment_method is distinct from old.payment_method
     or new.receiving_account_id is distinct from old.receiving_account_id
     or new.external_reference is distinct from old.external_reference
     or new.idempotency_key is distinct from old.idempotency_key
     or new.received_at is distinct from old.received_at
     or new.business_date is distinct from old.business_date
     or new.journal_entry_id is distinct from old.journal_entry_id
     or new.client_name_at_payment is distinct from old.client_name_at_payment
     or new.created_at is distinct from old.created_at then
    raise exception
      'A registration fee receipt is evidence. It is reversed, not edited.'
      using errcode = 'P0001';
  end if;

  if old.status = 'reversed' and new.status <> 'reversed' then
    raise exception
      'Receipt % has already been reversed.', old.receipt_number
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

create trigger membership_fee_receipts_guard
  before update on public.membership_fee_receipts
  for each row execute function public.membership_fee_receipts_guard();

create trigger membership_fee_receipts_no_delete
  before delete on public.membership_fee_receipts
  for each statement execute function public.reject_mutation();

revoke all on function public.membership_fee_receipts_guard()
  from public, anon, authenticated;

-- ===========================================================================
-- record_membership_fee()
--
-- Takes the fee, writes the receipt and posts the journal — in one
-- transaction, so there is no state in which a member has paid and the books
-- do not know, or the books know and no receipt exists.
--
--   Debit   the branch's cash / MTN / Airtel / bank account
--   Credit  4340 Membership Registration Fees
--
-- Income, not a liability: the fee is consideration for joining and is not
-- repayable. Whether it becomes refundable is one of the rules the client has
-- not settled, and no refund path exists until they do.
-- ===========================================================================

create or replace function public.record_membership_fee(
  p_membership_id uuid,
  p_amount bigint,
  p_payment_method text,
  p_external_reference text,
  p_idempotency_key uuid,
  p_notes text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_membership public.memberships;
  v_client     public.clients;
  v_policy     public.membership_policy_versions;
  v_actor      uuid;
  v_label      text;
  v_reference  text;
  v_receipt_id uuid;
  v_account    uuid;
  v_income     uuid;
  v_entry_id   uuid;
  v_date       date;
begin
  -- --- Idempotency, before anything else ---------------------------------
  -- The lock is on the key, so two deliveries of one submission serialise
  -- here rather than racing to the unique constraint.
  -- --- The actor ----------------------------------------------------------
  --
  -- Established, and authorised, **before** the replay shortcut below. The
  -- early return hands back a receipt id, which is a read of a document; a
  -- caller who may not collect a fee must not reach one by replaying a key.
  -- The lock and the lookup follow the check, not the other way round.
  v_actor := public.current_profile_id();
  v_label := public.audit_actor_label();

  if v_actor is null and auth.uid() is not null then
    raise exception
      'A registration fee must be recorded by a signed-in member of staff.'
      using errcode = 'P0001';
  end if;

  if auth.uid() is not null
     and not public.user_has_permission('membership:create') then
    raise exception
      'Collecting a registration fee requires the membership:create capability.'
      using errcode = 'P0001';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('membership_fee_key:' || p_idempotency_key::text)
  );

  select id into v_receipt_id
  from public.membership_fee_receipts
  where idempotency_key = p_idempotency_key;

  if v_receipt_id is not null then
    return v_receipt_id;
  end if;

  -- --- The membership -----------------------------------------------------
  select * into v_membership
  from public.memberships where id = p_membership_id for update;

  if not found then
    raise exception 'No such membership.' using errcode = 'P0001';
  end if;

  if v_membership.status not in ('pending', 'active', 'suspended') then
    raise exception
      'Membership % has ended. A registration fee cannot be taken against it.',
      v_membership.membership_number using errcode = 'P0001';
  end if;

  select * into v_client from public.clients where id = v_membership.client_id;

  if not found then
    raise exception 'The client on this membership no longer exists.'
      using errcode = 'P0001';
  end if;

  -- --- The terms ----------------------------------------------------------
  select * into v_policy
  from public.membership_policy_versions
  where id = v_membership.policy_version_id;

  if not public.membership_policy_allows(v_membership.policy_version_id, 'enrolment') then
    raise exception
      'Policy version % does not open enrolment, so no registration fee can be taken under it.',
      v_policy.version using errcode = 'P0001';
  end if;

  -- The published figure, not the caller's. The whole point of versioning the
  -- policy is that this number is not a parameter.
  if p_amount is distinct from v_policy.registration_fee then
    raise exception
      'The registration fee under policy version % is % shillings, not %.',
      v_policy.version, v_policy.registration_fee, coalesce(p_amount, 0)
      using errcode = 'P0001';
  end if;

  -- --- The method and its reference ---------------------------------------
  if p_payment_method not in ('cash', 'mtn_mobile_money', 'airtel_money', 'bank') then
    raise exception 'Unknown payment method "%".', p_payment_method
      using errcode = 'P0001';
  end if;

  v_reference := pg_catalog.upper(pg_catalog.btrim(coalesce(p_external_reference, '')));
  if v_reference = '' then
    v_reference := null;
  end if;

  if p_payment_method = 'cash' then
    if v_reference is not null then
      raise exception
        'A cash payment has no network reference. Its receipt number is its reference.'
        using errcode = 'P0001';
    end if;
  elsif v_reference is null then
    raise exception
      'A % payment needs the reference from the network or the bank. It is what makes the line findable when the account is reconciled.',
      p_payment_method using errcode = 'P0001';
  elsif char_length(v_reference) < 4 then
    raise exception
      'That transaction reference is too short to identify a payment.'
      using errcode = 'P0001';
  end if;

  -- --- Where the money landed ---------------------------------------------
  v_account := public.branch_cash_account(
    v_membership.branch_id,
    public.payment_method_cash_kind(p_payment_method));

  v_income := public.ledger_account_by_code('4340');
  v_date := public.business_date();

  -- --- The journal, then the receipt --------------------------------------
  --
  -- The id is minted here rather than by the column default, so the journal
  -- can name its source before the source row exists and the receipt can
  -- carry its entry id from the moment it is written. Writing the row first
  -- and updating the entry id back would mean a receipt that is, for an
  -- instant, a document with no accounting behind it — and the guard above
  -- refuses that update anyway, because a receipt is evidence rather than a
  -- working record. `journal_entries.source_id` carries no foreign key
  -- precisely so this ordering is available.
  v_receipt_id := pg_catalog.gen_random_uuid();

  v_entry_id := public.post_journal(
    v_membership.branch_id,
    v_date,
    'Membership registration fee — ' || v_membership.membership_number,
    'membership_fee',
    v_receipt_id,
    null,
    v_membership.client_id,
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'account_id', v_account, 'debit', p_amount, 'credit', 0,
        'memo', 'Registration fee received'),
      pg_catalog.jsonb_build_object(
        'account_id', v_income, 'debit', 0, 'credit', p_amount,
        'memo', 'Membership registration fee income')
    ),
    null, v_actor, v_label
  );

  insert into public.membership_fee_receipts (
    id, membership_id, client_id, branch_id, policy_version_id,
    amount, payment_method, receiving_account_id, external_reference,
    idempotency_key, business_date, journal_entry_id,
    recorded_by, recorded_by_label, client_name_at_payment, notes
  )
  values (
    v_receipt_id, p_membership_id, v_membership.client_id, v_membership.branch_id,
    v_membership.policy_version_id,
    p_amount, p_payment_method, v_account, v_reference,
    p_idempotency_key, v_date, v_entry_id,
    v_actor, v_label, v_client.full_name,
    nullif(pg_catalog.btrim(coalesce(p_notes, '')), '')
  );

  return v_receipt_id;
end;
$$;

comment on function public.record_membership_fee(uuid, bigint, text, text, uuid, text) is
  'Polytos Phase 2. Takes a membership registration fee, writes its receipt and posts the journal in one transaction. The amount is checked against the governing policy version rather than trusted. Idempotent on p_idempotency_key.';

revoke all on function public.record_membership_fee(uuid, bigint, text, text, uuid, text)
  from public, anon;
grant execute on function public.record_membership_fee(uuid, bigint, text, text, uuid, text)
  to authenticated;
