-- ===========================================================================
-- Polytos Phase 4.9 — the money, and the receipt somebody signs
--
-- ## The posting
--
--     Debit   5210 / 5220 / 5230   the benefit expense
--     Credit  the branch's cash / MTN / Airtel / bank account
--
-- That is the documented cash-payment pattern, and it is the one the client's
-- own documents describe: money handed to a member at the counter, or to a
-- bereaved family. 20261022000200 sets out why there is no payable account
-- and what would have to change if the client says they approve monthly and
-- pay in a batch.
--
-- A benefit payment is **never** a loan disbursement. It creates no
-- receivable, nothing is repayable, and classifying it as one would put it in
-- the loan book and in every arrears report. It is not a savings withdrawal
-- either: it does not touch `2100 Member Savings`, because the member's
-- savings are the member's money and a benefit is the company's. Both of
-- those are asserted by `tests/db/benefit-accounting.test.ts` against the
-- ledger rather than left as intentions.
--
-- ## Idempotency, and why authorisation sits above it
--
-- A benefit payment is not idempotent by state the way an approval is: the
-- claim moves from `approved` to `paid`, so a second call would be refused by
-- the transition table — but only *after* it had read the claim. A network
-- retry that arrives twice must return the first payment, not a confusing
-- refusal, so every submission carries a key minted server-side when the form
-- renders and the function returns the existing payment on a replay.
--
-- The capability check sits **above** the replay shortcut, which is ADR-056's
-- rule and the reason it exists: the early return reads a payment record, so
-- it has to sit behind the check that decides whether this caller may see
-- one. Otherwise a caller with no capability could replay somebody else's key
-- and read back a payment they are not entitled to.
--
-- ## What is frozen into the receipt
--
-- The recipient. For a medical or condolence claim that is the member; for a
-- bereavement claim it is the beneficiary **as the assessment snapshot
-- recorded them**, not as the beneficiary table reads today. The snapshot is
-- the authorisation, and a payment that re-read the live record could pay
-- somebody the approver never saw. That is the fraud §11 of the brief names,
-- and this is the line of code that refuses it.
--
-- ## Separation of duties, and the one split that is deliberately not made
--
-- Assessing and approving are refused to the same person — by
-- `approve_benefit_claim`, and that is the control the roadmap calls the one
-- that must not be collapsed. Paying is a third capability, held by the
-- Manager and the Owner.
--
-- Paying is **not** refused to the approver, and the reason is worth stating
-- rather than leaving as an omission. A refusal there would require three
-- distinct people for every benefit: an assessor, an approver and a payer.
-- In a business with one Owner, one Manager and one Secretary/Treasurer that
-- makes a claim unpayable whenever one of three people is out — and the
-- person it would most often block is the Owner, who can already do anything
-- and against whom the control therefore buys nothing. The judgement that
-- needs an independent check is the one that turns documents into a figure,
-- and that check is enforced. Recorded here and in docs/POLYTOS-BENEFITS.md
-- so that a business that grows enough staff to want the third split knows
-- exactly where to add it.
--
-- ## Reversal
--
-- A reversal never deletes. It posts the contra journal, stamps the original
-- payment with who reversed it and why, links the two entries through
-- `reversed_by_entry_id`, and moves the claim to `reversed`.
--
-- It does **not** reopen the claim. `reversed` is terminal: there is no edge
-- back to `approved`, so an erroneous reversal cannot make a paid claim
-- payable again, and nothing about a reversal revives a rejected one. What it
-- does do is release the annual cap the claim had consumed — because
-- `medical_benefit_consumed` counts `assessed`, `approved` and `paid`, and a
-- reversed claim is none of those. That is correct: the money came back.
-- ===========================================================================

create table public.benefit_payments (
  id uuid primary key default pg_catalog.gen_random_uuid(),

  -- `BP2600001`. Its own scope, separate from the claim's: the claim is the
  -- request and this is the receipt the recipient signs for.
  payment_number text not null unique,

  claim_id uuid not null references public.benefit_claims(id) on delete restrict,
  claim_number text not null,
  claim_type text not null,

  membership_id uuid not null references public.memberships(id) on delete restrict,
  client_id uuid not null references public.clients(id) on delete restrict,
  branch_id uuid not null references public.branches(id) on delete restrict,

  amount bigint not null,

  -- --- Who was paid, frozen -----------------------------------------------
  --
  -- Copied from the assessment snapshot for a bereavement claim, and from the
  -- client record for the other two. Never re-read at payment time: the
  -- snapshot is the authorisation, and a payment that consulted the live
  -- beneficiary table could pay somebody the approver never saw.

  recipient_kind text not null,
  recipient_name text not null,
  recipient_phone text not null,
  -- The beneficiary record the payment instruction came from, where it came
  -- from one. A reference for an auditor; the name and number above are what
  -- was actually paid.
  recipient_beneficiary_id uuid
    references public.member_beneficiaries(id) on delete restrict,
  recipient_beneficiary_number text,

  -- --- The money ----------------------------------------------------------

  payment_method text not null,
  cash_account_id uuid not null references public.ledger_accounts(id) on delete restrict,
  expense_account_id uuid not null
    references public.ledger_accounts(id) on delete restrict,
  external_reference text,

  idempotency_key uuid not null unique,
  value_date date not null,
  journal_entry_id uuid not null unique
    references public.journal_entries(id) on delete restrict,

  paid_at timestamptz not null default pg_catalog.now(),
  paid_by uuid references public.profiles(id) on delete set null,
  paid_by_label text not null default 'system',

  -- --- Reversal -----------------------------------------------------------

  reversed_at timestamptz,
  reversed_by uuid references public.profiles(id) on delete set null,
  reversed_by_label text,
  reversal_reason text,
  reversal_journal_entry_id uuid unique
    references public.journal_entries(id) on delete restrict,

  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),

  constraint benefit_payment_number_shape check (payment_number ~ '^BP[0-9]{6,}$'),
  constraint benefit_payment_amount_positive
    check (amount > 0 and amount <= 1000000000),
  constraint benefit_payment_type_valid
    check (claim_type in ('medical', 'family_condolence', 'member_bereavement')),
  constraint benefit_payment_recipient_kind_valid
    check (recipient_kind in ('member', 'beneficiary')),
  -- A beneficiary payment names the record it came from; a payment to the
  -- member does not. The bereavement benefit is payable to the next of kin,
  -- so the two are not interchangeable.
  constraint benefit_payment_recipient_shape
    check (
      case recipient_kind
        when 'beneficiary' then
          recipient_beneficiary_id is not null
          and recipient_beneficiary_number is not null
        else
          recipient_beneficiary_id is null
          and recipient_beneficiary_number is null
      end
    ),
  constraint benefit_payment_bereavement_pays_beneficiary
    check (claim_type <> 'member_bereavement' or recipient_kind = 'beneficiary'),
  constraint benefit_payment_others_pay_member
    check (claim_type = 'member_bereavement' or recipient_kind = 'member'),
  constraint benefit_payment_recipient_name_shape
    check (char_length(btrim(recipient_name)) between 3 and 150),
  constraint benefit_payment_recipient_phone_shape
    check (recipient_phone ~ '^\+256[0-9]{9}$'),
  constraint benefit_payment_method_valid
    check (payment_method in ('cash', 'mtn_mobile_money', 'airtel_money', 'bank')),
  -- A cash payment's receipt number is its reference; anything through a
  -- network or a bank carries theirs. The same rule savings withdrawals
  -- apply, and for the same reason: an unreferenced mobile money payment
  -- cannot be reconciled against the statement.
  constraint benefit_payment_reference_shape
    check (
      case payment_method
        when 'cash' then external_reference is null
        else external_reference is not null
             and char_length(btrim(external_reference)) between 4 and 100
      end
    ),
  constraint benefit_payment_reversal_complete
    check (
      (reversed_at is null)
      = (reversed_by_label is null
         and reversal_reason is null
         and reversal_journal_entry_id is null)
    ),
  constraint benefit_payment_reversal_reason_length
    check (
      reversal_reason is null
      or char_length(btrim(reversal_reason)) between 3 and 1000
    ),
  constraint benefit_payment_labels_not_blank
    check (
      btrim(paid_by_label) <> ''
      and (reversed_by_label is null or btrim(reversed_by_label) <> '')
    ),
  constraint benefit_payment_entries_differ
    check (reversal_journal_entry_id is distinct from journal_entry_id)
);

comment on table public.benefit_payments is
  'Polytos Phase 4. A benefit paid: the amount, the recipient frozen as the assessment authorised them, the cash account it left, the expense account it hit, and the journal behind it. Idempotent on idempotency_key. A reversal stamps this row and posts a contra entry; it never deletes one.';
comment on column public.benefit_payments.recipient_name is
  'Who was paid, copied from the assessment snapshot for a bereavement claim and from the client record otherwise. Never re-read at payment time: the snapshot is the authorisation, and a payment consulting the live beneficiary table could pay somebody the approver never saw.';
comment on column public.benefit_payments.idempotency_key is
  'Minted server-side when the payment form renders, so two taps carry one key and a network retry returns the first payment instead of paying twice.';

-- One live payment per claim. A reversed payment leaves the index, so a claim
-- whose payment was reversed could in principle be paid again — except that
-- `reversed` is terminal in the transition table, so no route reaches the
-- approval it would need. Both, because the index is what holds under
-- concurrency and the transition table is what a reader can follow.
create unique index benefit_payments_one_live_per_claim
  on public.benefit_payments (claim_id)
  where reversed_at is null;

comment on index public.benefit_payments_one_live_per_claim is
  'One unreversed payment per claim. The index, not a check in a function: two concurrent payment calls with different idempotency keys would both pass a check and both post.';

create index benefit_payments_claim_idx on public.benefit_payments (claim_id);
create index benefit_payments_membership_idx
  on public.benefit_payments (membership_id, value_date desc);
create index benefit_payments_client_idx on public.benefit_payments (client_id);
create index benefit_payments_branch_date_idx
  on public.benefit_payments (branch_id, value_date desc);
create index benefit_payments_type_idx
  on public.benefit_payments (claim_type, value_date desc)
  where reversed_at is null;

create trigger benefit_payments_set_updated_at
  before update on public.benefit_payments
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- The number, and immutability
-- ---------------------------------------------------------------------------

create or replace function public.benefit_payments_assign_number()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.payment_number := public.next_reference('benefit_payment');
  return new;
end;
$$;

revoke all on function public.benefit_payments_assign_number()
  from public, anon, authenticated;

create trigger benefit_payments_assign_number
  before insert on public.benefit_payments
  for each row execute function public.benefit_payments_assign_number();

create or replace function public.benefit_payments_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Only the reversal columns move. A payment is a receipt: the amount, the
  -- recipient, the accounts and the journal are what it says happened, and a
  -- route that could change any of them would make every receipt provisional.
  if new.id is distinct from old.id
     or new.payment_number is distinct from old.payment_number
     or new.claim_id is distinct from old.claim_id
     or new.claim_number is distinct from old.claim_number
     or new.claim_type is distinct from old.claim_type
     or new.membership_id is distinct from old.membership_id
     or new.client_id is distinct from old.client_id
     or new.branch_id is distinct from old.branch_id
     or new.amount is distinct from old.amount
     or new.recipient_kind is distinct from old.recipient_kind
     or new.recipient_name is distinct from old.recipient_name
     or new.recipient_phone is distinct from old.recipient_phone
     or new.recipient_beneficiary_id is distinct from old.recipient_beneficiary_id
     or new.recipient_beneficiary_number is distinct from old.recipient_beneficiary_number
     or new.payment_method is distinct from old.payment_method
     or new.cash_account_id is distinct from old.cash_account_id
     or new.expense_account_id is distinct from old.expense_account_id
     or new.external_reference is distinct from old.external_reference
     or new.idempotency_key is distinct from old.idempotency_key
     or new.value_date is distinct from old.value_date
     or new.journal_entry_id is distinct from old.journal_entry_id
     or new.paid_at is distinct from old.paid_at
     or new.paid_by is distinct from old.paid_by
     or new.paid_by_label is distinct from old.paid_by_label then
    raise exception
      'A benefit payment is a receipt and does not change. Reverse it, which posts the contra entry and keeps this one.'
      using errcode = 'P0001';
  end if;

  if old.reversed_at is not null then
    raise exception
      'Payment % has already been reversed.', old.payment_number
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

comment on function public.benefit_payments_guard() is
  'Polytos Phase 4. Refuses every edit to a benefit payment except the one reversal stamp, and refuses a second reversal.';

revoke all on function public.benefit_payments_guard() from public, anon, authenticated;

create trigger benefit_payments_guard
  before update on public.benefit_payments
  for each row execute function public.benefit_payments_guard();

create trigger benefit_payments_no_delete
  before delete on public.benefit_payments
  for each row execute function public.reject_mutation();

-- ---------------------------------------------------------------------------
-- post_benefit_payment()
--
--   Debit   5210 / 5220 / 5230 the benefit expense
--   Credit  the branch's cash / MTN / Airtel / bank account
-- ---------------------------------------------------------------------------

create or replace function public.post_benefit_payment(
  p_claim_id uuid,
  p_payment_method text,
  p_external_reference text,
  p_idempotency_key uuid
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_claim     public.benefit_claims;
  v_snapshot  public.benefit_assessment_snapshots;
  v_client    public.clients;
  v_actor     uuid;
  v_label     text;
  v_reference text;
  v_payment_id uuid;
  v_cash      uuid;
  v_expense   uuid;
  v_entry_id  uuid;
  v_date      date;
  v_recipient_kind text;
  v_recipient_name text;
  v_recipient_phone text;
  v_beneficiary_id uuid;
  v_beneficiary_number text;
begin
  v_actor := public.current_profile_id();
  v_label := public.audit_actor_label();

  -- Authorisation above the replay shortcut. ADR-056: the early return reads
  -- a payment record, so it sits behind the check that decides whether this
  -- caller may see one.
  if v_actor is null and auth.uid() is not null then
    raise exception
      'A benefit must be paid by a signed-in member of staff.'
      using errcode = 'P0001';
  end if;

  if auth.uid() is not null and not public.user_has_permission('benefits:pay') then
    raise exception
      'Paying a benefit requires the benefits:pay capability.'
      using errcode = 'P0001';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('benefit_payment_key:' || p_idempotency_key::text)
  );

  select id into v_payment_id
  from public.benefit_payments where idempotency_key = p_idempotency_key;

  if v_payment_id is not null then
    return v_payment_id;
  end if;

  select * into v_claim from public.benefit_claims where id = p_claim_id for update;

  if not found then
    raise exception 'No such benefit claim.' using errcode = 'P0001';
  end if;

  if v_claim.status <> 'approved' then
    raise exception
      'Claim % is %. Only an approved claim is paid.',
      v_claim.claim_number, v_claim.status using errcode = 'P0001';
  end if;

  -- The policy gate, re-asked at the moment the money moves. A version that
  -- has been superseded between approval and payment, or whose effective date
  -- has not arrived, stops the payment — because `membership_policy_allows`
  -- is the authority on whether benefits are open and this is the last point
  -- at which asking it can still prevent anything.
  if not public.membership_policy_allows(v_claim.policy_version_id, 'benefits') then
    raise exception
      'Benefit payments are not open under policy version %, so claim % cannot be paid. The benefit rules behind it are undecided or the version is not in force.',
      v_claim.policy_version, v_claim.claim_number using errcode = 'P0001';
  end if;

  select * into v_snapshot
  from public.benefit_assessment_snapshots where claim_id = p_claim_id;

  if not found then
    raise exception
      'Claim % has no assessment snapshot, so there is no authorised recipient or amount. Nothing is paid on a claim whose assessment is not on the record.',
      v_claim.claim_number using errcode = 'P0001';
  end if;

  -- The amount is the claim's approved amount, and it must agree with the
  -- assessment the approval rested on. Two figures that could disagree would
  -- be two answers to "how much did the business authorise", and the brief's
  -- "no payment exceeding approved entitlement" is this check.
  if v_claim.approved_amount is null or v_claim.approved_amount <= 0 then
    raise exception
      'Claim % has no approved amount.', v_claim.claim_number using errcode = 'P0001';
  end if;

  if v_claim.approved_amount > v_snapshot.assessed_amount then
    raise exception
      'Claim % is approved for % but was assessed at %. A payment never exceeds the assessment it rests on.',
      v_claim.claim_number, v_claim.approved_amount, v_snapshot.assessed_amount
      using errcode = 'P0001';
  end if;

  -- The recipient, from the authorisation rather than from the live record.
  if v_claim.claim_type = 'member_bereavement' then
    if v_snapshot.beneficiary_id is null
       or v_snapshot.beneficiary_name is null
       or v_snapshot.beneficiary_phone is null then
      raise exception
        'Claim %''s assessment records no verified beneficiary, so there is nobody the business may pay.',
        v_claim.claim_number using errcode = 'P0001';
    end if;

    v_recipient_kind := 'beneficiary';
    v_recipient_name := v_snapshot.beneficiary_name;
    v_recipient_phone := v_snapshot.beneficiary_phone;
    v_beneficiary_id := v_snapshot.beneficiary_id;
    v_beneficiary_number := v_snapshot.beneficiary_number;
  else
    select * into v_client from public.clients where id = v_claim.client_id;

    if v_client.phone is null then
      raise exception
        'Client % has no telephone number on record, so the payment has no recipient detail to issue a receipt against.',
        v_client.client_number using errcode = 'P0001';
    end if;

    v_recipient_kind := 'member';
    v_recipient_name := v_client.full_name;
    v_recipient_phone := v_client.phone;
    v_beneficiary_id := null;
    v_beneficiary_number := null;
  end if;

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
        'A cash benefit payment has no network reference. Its payment number is its reference.'
        using errcode = 'P0001';
    end if;
  elsif v_reference is null then
    raise exception
      'A % benefit payment needs the reference from the network or the bank.',
      p_payment_method using errcode = 'P0001';
  elsif char_length(v_reference) < 4 then
    raise exception
      'That transaction reference is too short to identify a payment.'
      using errcode = 'P0001';
  end if;

  v_cash := public.branch_cash_account(
    v_claim.branch_id, public.payment_method_cash_kind(p_payment_method));
  v_expense := public.benefit_expense_account(v_claim.claim_type);

  if v_expense is null then
    raise exception
      'There is no benefit expense account for a claim of type "%".', v_claim.claim_type
      using errcode = 'P0001';
  end if;

  v_date := public.business_date();
  v_payment_id := pg_catalog.gen_random_uuid();

  v_entry_id := public.post_journal(
    v_claim.branch_id,
    v_date,
    'Member benefit — ' || v_claim.claim_number || ' (' || v_claim.claim_type || ')',
    'benefit_payment',
    v_payment_id,
    -- No loan. A benefit payment is not a loan event, and attaching one would
    -- put it on the loan's own ledger view.
    null,
    v_claim.client_id,
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'account_id', v_expense,
        'debit', v_claim.approved_amount, 'credit', 0,
        'memo', 'Benefit — ' || v_claim.claim_number),
      pg_catalog.jsonb_build_object(
        'account_id', v_cash,
        'debit', 0, 'credit', v_claim.approved_amount,
        'memo', 'Benefit paid to ' || v_recipient_kind)
    ),
    null, v_actor, v_label
  );

  insert into public.benefit_payments (
    id, payment_number, claim_id, claim_number, claim_type,
    membership_id, client_id, branch_id, amount,
    recipient_kind, recipient_name, recipient_phone,
    recipient_beneficiary_id, recipient_beneficiary_number,
    payment_method, cash_account_id, expense_account_id, external_reference,
    idempotency_key, value_date, journal_entry_id,
    paid_by, paid_by_label
  )
  values (
    v_payment_id, 'BP000000', p_claim_id, v_claim.claim_number, v_claim.claim_type,
    v_claim.membership_id, v_claim.client_id, v_claim.branch_id,
    v_claim.approved_amount,
    v_recipient_kind, v_recipient_name, v_recipient_phone,
    v_beneficiary_id, v_beneficiary_number,
    p_payment_method, v_cash, v_expense, v_reference,
    p_idempotency_key, v_date, v_entry_id,
    v_actor, v_label
  );

  update public.benefit_claims
     set status = 'paid',
         payment_id = v_payment_id
   where id = p_claim_id;

  return v_payment_id;
end;
$$;

comment on function public.post_benefit_payment(uuid, text, text, uuid) is
  'Polytos Phase 4. Pays an approved benefit: debit 5210/5220/5230, credit the branch cash account. The recipient comes from the assessment snapshot, never from the live beneficiary record. Re-asks the policy gate at the moment the money moves. Idempotent on p_idempotency_key, with the capability check above the replay.';

revoke all on function public.post_benefit_payment(uuid, text, text, uuid) from public, anon;
grant execute on function public.post_benefit_payment(uuid, text, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- reverse_benefit_payment()
--
-- The Owner's alone, under `savings:reverse` — the capability that already
-- covers reversing a posted movement in this programme. A fifth benefit
-- capability over the same class of act would be a second answer to "who may
-- un-say a payment", and the person who handed over the money is the last
-- person who should be able to decide it never happened.
-- ---------------------------------------------------------------------------

create or replace function public.reverse_benefit_payment(
  p_payment_id uuid,
  p_reason text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_payment public.benefit_payments;
  v_actor   uuid;
  v_label   text;
  v_entry_id uuid;
  v_date    date;
begin
  v_actor := public.current_profile_id();
  v_label := public.audit_actor_label();

  if v_actor is null and auth.uid() is not null then
    raise exception
      'A benefit payment must be reversed by a signed-in member of staff.'
      using errcode = 'P0001';
  end if;

  if auth.uid() is not null and not public.user_has_permission('savings:reverse') then
    raise exception
      'Reversing a benefit payment requires the savings:reverse capability — the same authority that reverses any other posted movement in this programme.'
      using errcode = 'P0001';
  end if;

  if coalesce(pg_catalog.btrim(p_reason), '') = '' then
    raise exception
      'A reversal needs a reason. It rewrites what the books say happened.'
      using errcode = 'P0001';
  end if;

  select * into v_payment
  from public.benefit_payments where id = p_payment_id for update;

  if not found then
    raise exception 'No such benefit payment.' using errcode = 'P0001';
  end if;

  if v_payment.reversed_at is not null then
    raise exception
      'Payment % was already reversed on %.',
      v_payment.payment_number, v_payment.reversed_at::date using errcode = 'P0001';
  end if;

  v_date := public.business_date();

  -- The contra entry: the same two accounts, the other way round. Its own
  -- source type, because `journal_entries_one_per_source` is unique on
  -- (source_type, source_id) and reusing `benefit_payment` would collide with
  -- the entry being reversed.
  v_entry_id := public.post_journal(
    v_payment.branch_id,
    v_date,
    'Reversal of member benefit — ' || v_payment.payment_number,
    'benefit_payment_reversal',
    p_payment_id,
    null,
    v_payment.client_id,
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'account_id', v_payment.cash_account_id,
        'debit', v_payment.amount, 'credit', 0,
        'memo', 'Benefit payment reversed — ' || v_payment.claim_number),
      pg_catalog.jsonb_build_object(
        'account_id', v_payment.expense_account_id,
        'debit', 0, 'credit', v_payment.amount,
        'memo', 'Benefit expense reversed — ' || v_payment.claim_number)
    ),
    null, v_actor, v_label
  );

  -- The pair, linked. `journal_entries` carries its own append-only
  -- discipline; this is the stamp that lets the two be shown together.
  update public.journal_entries
     set reversed_by_entry_id = v_entry_id
   where id = v_payment.journal_entry_id;

  update public.benefit_payments
     set reversed_at = pg_catalog.now(),
         reversed_by = v_actor,
         reversed_by_label = v_label,
         reversal_reason = pg_catalog.btrim(p_reason),
         reversal_journal_entry_id = v_entry_id
   where id = p_payment_id;

  -- The claim becomes `reversed`, which is terminal. It does not become
  -- `approved` again: an erroneous reversal must not make a paid claim
  -- payable a second time, and the transition table has no edge that would
  -- allow it.
  update public.benefit_claims
     set status = 'reversed'
   where id = v_payment.claim_id;

  return v_entry_id;
end;
$$;

comment on function public.reverse_benefit_payment(uuid, text) is
  'Polytos Phase 4. Reverses a benefit payment: posts the contra journal, links the pair, stamps the original with who and why, and moves the claim to the terminal reversed state. Never deletes, never reopens the claim, and releases the annual cap the claim had consumed because the money came back.';

revoke all on function public.reverse_benefit_payment(uuid, text) from public, anon;
grant execute on function public.reverse_benefit_payment(uuid, text) to authenticated;
