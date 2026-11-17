-- ===========================================================================
-- Decision A, part 4 of 4 — no unfunded payouts
--
-- The Owner's ruling of 2026-11-16, rules 1 to 5: every outgoing payment must
-- be covered by available funds in the actual account it leaves; balances are
-- never pooled across accounts or branches; a short payout is refused before
-- anything is posted; and `allow_negative_cash` may not bypass it.
--
-- Parts 1 to 3 built the primitives. This part makes them bind, in two ways
-- that are deliberately independent of each other:
--
--   1. **Each payout path asks, by name.** The three the full-system audit
--      found unprotected — loan disbursement, savings-withdrawal payout and
--      benefit payment — now call `assert_cash_funds_available` on the one
--      account money leaves, and the four receipt-reversal paths release or
--      assert through `release_or_assert_receipt_reversal`. This is what
--      produces a legible refusal naming the account and the shortfall.
--
--   2. **The storage layer refuses anyway.** `journal_lines_assert_funded` is
--      a DEFERRED constraint trigger: at commit, any line that took money out
--      of a till, wallet, bank or transit account must leave that account's
--      available balance at or above zero. It binds `service_role`, a
--      hand-written INSERT, and — the point — every posting path written
--      after today, which a list of functions cannot promise.
--
-- Belt and braces on purpose. The Owner's instruction was explicit that this
-- must not be solved by a superficial call that a later path can forget.
--
-- ## Why the trigger polices only lines that take money out
--
-- A line that puts money *in* raises the balance, so it cannot create a
-- shortfall — and policing it would make a legacy negative account impossible
-- to repair, which is the opposite of the intent. Agency float is excluded
-- because it has its own rule and its own setting
-- (`assert_agency_float_available` / `allow_negative_agency_float`), which the
-- Owner's instruction 2 expressly preserves.
--
-- ## What it does not change
--
-- Not one historical figure. No confirmation row exists for any receipt
-- posted before part 1, so every historical balance is fully available, and
-- the trigger is `AFTER INSERT` — it never looks at a row already in the
-- table. Whether legacy till cash is physically present is the operational
-- cutover question recorded in the implementation plan §11.4; a migration
-- cannot answer it and this one does not pretend to.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Loan disbursement — the path with no funding account at all
--
-- `disburse_loan(p_loan_id)` took a loan and nothing else, and
-- `post_disbursement_journal` hard-coded the branch's Cash at Hand, because
-- `loans` records no disbursement method. So "the selected funding account"
-- had no representation.
--
-- Both gain an optional account. Passing nothing keeps today's behaviour —
-- the branch till — so every existing caller, fixture and test is unchanged;
-- passing an account disburses from it, after checking it is a spendable
-- account of the loan's own branch. DROP then CREATE rather than an overload,
-- which PostgreSQL would refuse as ambiguous.
-- ---------------------------------------------------------------------------

drop function if exists public.post_disbursement_journal(uuid);

create or replace function public.post_disbursement_journal(
  p_loan_id uuid,
  p_funding_account_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  r       record;
  v_tz    text := public.business_timezone();
  v_cash  uuid;
  v_branch uuid;
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

  -- The funding account: the one named, or the branch's till as before.
  if p_funding_account_id is null then
    v_cash := public.branch_cash_account(r.branch_id, 'cash_at_hand');
  else
    select a.branch_id into v_branch
      from public.ledger_accounts a where a.id = p_funding_account_id;

    if v_branch is null then
      raise exception 'The funding account does not exist.' using errcode = 'P0001';
    end if;

    -- A-5. An account of this loan's own branch. Naming another branch's
    -- account would be exactly the cross-branch borrowing rule 3 forbids.
    if v_branch <> r.branch_id then
      raise exception
        'That funding account belongs to another branch. A loan is paid out of its own branch''s money.'
        using errcode = 'P0001';
    end if;

    v_cash := p_funding_account_id;
  end if;

  perform public.assert_spendable_account(v_cash, 'funding');

  -- Decision A, rule 1. The money has to be there, in this account, now.
  -- Before this, a disbursement credited the till unconditionally and a
  -- branch that had never been funded went straight into deficit.
  perform public.assert_cash_funds_available(v_cash, r.principal_amount);

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
        'account_id', v_cash,
        'debit', 0, 'credit', r.principal_amount, 'memo', 'Paid out at the counter')
    ),
    r.disbursed_at, r.disbursed_by, r.actor
  );
end;
$$;

revoke all on function public.post_disbursement_journal(uuid, uuid) from public, anon, authenticated;

drop function if exists public.disburse_loan(uuid);

create or replace function public.disburse_loan(
  p_loan_id uuid,
  p_funding_account_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_loan   public.loans;
  v_client public.clients;
begin
  select * into v_loan from public.loans where id = p_loan_id for update;

  if not found then
    raise exception 'No such loan.' using errcode = 'P0001';
  end if;

  -- A second tap finds the loan already active and is refused cleanly, rather
  -- than disbursing twice.
  if v_loan.status <> 'approved' then
    raise exception
      'Only an approved loan can be disbursed; this one is %.', v_loan.status
      using errcode = 'P0001';
  end if;

  if auth.uid() is not null and not public.user_has_permission('loans:disburse') then
    raise exception 'Disbursing a loan requires the loans:disburse capability.'
      using errcode = 'P0001';
  end if;

  -- Eligibility again. A client blacklisted between approval and disbursement
  -- must not receive money.
  select * into v_client from public.clients where id = v_loan.client_id;

  if v_client.status <> 'active' then
    raise exception
      'This client is % and cannot receive a disbursement.', v_client.status
      using errcode = 'P0001';
  end if;

  if not exists (select 1 from public.loan_periods where loan_id = p_loan_id) then
    raise exception 'This loan has no contractual breakdown and cannot be disbursed.'
      using errcode = 'P0001';
  end if;

  if not exists (select 1 from public.loan_client_snapshots where loan_id = p_loan_id) then
    raise exception 'This loan has no client snapshot and cannot be disbursed.'
      using errcode = 'P0001';
  end if;

  update public.loans set status = 'active' where id = p_loan_id;

  perform public.generate_loan_schedule(p_loan_id);

  -- The ledger, in this transaction. If the funding account is short, this
  -- raises and the whole disbursement goes with it: the loan stays approved,
  -- no installment survives, and no journal is written.
  perform public.post_disbursement_journal(p_loan_id, p_funding_account_id);
  return p_loan_id;
end;
$$;

revoke all on function public.disburse_loan(uuid, uuid) from public, anon;
grant execute on function public.disburse_loan(uuid, uuid) to authenticated;

CREATE OR REPLACE FUNCTION public.post_savings_withdrawal(p_request_id uuid, p_payment_method text, p_external_reference text, p_idempotency_key uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_request   public.savings_withdrawal_requests;
  v_withdrawable bigint;
  v_policy_id uuid;
  v_account   public.savings_accounts;
  v_actor     uuid;
  v_label     text;
  v_reference text;
  v_txn_id    uuid;
  v_cash      uuid;
  v_liability uuid;
  v_entry_id  uuid;
  v_balance   bigint;
  v_date      date;
begin
  v_actor := public.current_profile_id();
  v_label := public.audit_actor_label();

  -- Authorisation above the replay shortcut, for the reason set out in
  -- `post_savings_deposit`: the early return reads a movement, so it has to
  -- sit behind the check that decides whether this caller may see one.
  if v_actor is null and auth.uid() is not null then
    raise exception
      'A withdrawal must be paid by a signed-in member of staff.'
      using errcode = 'P0001';
  end if;

  if auth.uid() is not null
     and not public.user_has_permission('savings:post_withdrawal') then
    raise exception
      'Paying a withdrawal requires the savings:post_withdrawal capability.'
      using errcode = 'P0001';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('savings_txn_key:' || p_idempotency_key::text)
  );

  select id into v_txn_id
  from public.savings_transactions where idempotency_key = p_idempotency_key;

  if v_txn_id is not null then
    return v_txn_id;
  end if;

  select * into v_request
  from public.savings_withdrawal_requests where id = p_request_id for update;

  if not found then
    raise exception 'No such withdrawal request.' using errcode = 'P0001';
  end if;

  if v_request.status <> 'approved' then
    raise exception
      'Withdrawal request % is %. Only an approved request is paid.',
      v_request.request_number, v_request.status using errcode = 'P0001';
  end if;

  if not public.user_can_see_branch(v_request.branch_id) then
    raise exception 'You cannot pay that branch''s withdrawal.' using errcode = '42501';
  end if;

  -- Serialize decisions that can reopen debt against withdrawal or bereavement payment.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('policy_client_financial:' || v_request.client_id::text)
  );

  perform public.lock_savings_capacity(v_request.savings_account_id);

  -- The account lock. Everything below reads the balance, so it is taken
  -- before the balance is read and held until the transaction commits.
  select * into v_account
  from public.savings_accounts where id = v_request.savings_account_id for update;

  if v_account.status <> 'active' then
    raise exception
      'Savings account % is %.', v_account.account_number, v_account.status
      using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from public.memberships m
    where m.id = v_account.membership_id and m.status = 'active'
  ) then
    raise exception 'A withdrawal needs an active membership.' using errcode = 'P0001';
  end if;

  v_policy_id := public.savings_account_governing_policy(v_account.id);
  if not public.membership_policy_allows(v_policy_id, 'savings') then
    raise exception 'Savings are not open under the governing policy.' using errcode = 'P0001';
  end if;

  -- The check that counts. The balance at request time was informative; this
  -- one is holding a lock, so a deposit withdrawn twice and two approved
  -- requests racing each other both stop here.
  select coalesce(sum(signed_amount), 0)::bigint into v_balance
  from public.savings_transactions
  where savings_account_id = v_request.savings_account_id;

  if v_request.amount > v_balance then
    raise exception
      'Savings account % now holds % shillings, which is less than the % approved. The balance moved after the decision.',
      v_account.account_number, v_balance, v_request.amount
      using errcode = 'P0001';
  end if;

  v_withdrawable := public.savings_withdrawable_amount(v_account.id);
  if v_withdrawable is null or v_request.amount > v_withdrawable then
    raise exception 'An outstanding loan or savings pledge now blocks this withdrawal.'
      using errcode = 'P0001';
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
        'A cash withdrawal has no network reference. Its transaction number is its reference.'
        using errcode = 'P0001';
    end if;
  elsif v_reference is null then
    raise exception
      'A % withdrawal needs the reference from the network or the bank.',
      p_payment_method using errcode = 'P0001';
  elsif char_length(v_reference) < 4 then
    raise exception
      'That transaction reference is too short to identify a withdrawal.'
      using errcode = 'P0001';
  end if;

  v_cash := public.branch_cash_account(
    v_account.branch_id, public.payment_method_cash_kind(p_payment_method));

  -- Decision A. The company's own money, in the one account this withdrawal
  -- leaves. The checks above are all about the member's savings; none of them
  -- asks whether the business holds the cash to pay them.
  perform public.assert_spendable_account(v_cash, 'funding');
  perform public.assert_cash_funds_available(v_cash, v_request.amount);
  v_liability := public.ledger_account_by_code('2100');
  v_date := public.business_date();
  v_txn_id := pg_catalog.gen_random_uuid();

  v_entry_id := public.post_journal(
    v_account.branch_id,
    v_date,
    'Member savings withdrawal — ' || v_account.account_number,
    'savings_withdrawal',
    v_txn_id,
    null,
    v_account.client_id,
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'account_id', v_liability, 'debit', v_request.amount, 'credit', 0,
        'memo', 'Member savings — ' || v_account.account_number),
      pg_catalog.jsonb_build_object(
        'account_id', v_cash, 'debit', 0, 'credit', v_request.amount,
        'memo', 'Savings paid out')
    ),
    null, v_actor, v_label
  );

  insert into public.savings_transactions (
    id, savings_account_id, membership_id, client_id, branch_id,
    kind, amount, payment_method, cash_account_id, external_reference,
    idempotency_key, value_date, journal_entry_id, withdrawal_request_id,
    recorded_by, recorded_by_label
  )
  values (
    v_txn_id, v_request.savings_account_id, v_request.membership_id,
    v_request.client_id, v_request.branch_id,
    'withdrawal', v_request.amount, p_payment_method, v_cash, v_reference,
    p_idempotency_key, v_date, v_entry_id, p_request_id, v_actor, v_label
  );

  update public.savings_withdrawal_requests
     set status = 'paid',
         paid_transaction_id = v_txn_id,
         paid_at = pg_catalog.now()
   where id = p_request_id;

  return v_txn_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.post_benefit_payment(p_claim_id uuid, p_payment_method text, p_external_reference text, p_idempotency_key uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  v_blocked   text;
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
    if not exists (
      select 1 from public.benefit_payments bp
      where bp.id = v_payment_id and bp.claim_id = p_claim_id
        and bp.payment_method = p_payment_method
        and coalesce(bp.external_reference, '') =
          pg_catalog.upper(pg_catalog.btrim(coalesce(p_external_reference, '')))
        and public.user_can_see_branch(bp.branch_id)
    ) then
      raise exception 'That receipt key belongs to another payment request.'
        using errcode = '42501';
    end if;
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

  if not public.user_can_see_branch(v_claim.branch_id) then
    raise exception 'You cannot pay that branch''s claim.' using errcode = '42501';
  end if;

  -- Serialize decisions that can reopen debt against withdrawal or bereavement payment.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('policy_client_financial:' || v_claim.client_id::text)
  );

  -- The conditions that can change between approval and payment, re-asked at
  -- the moment the money moves: this benefit's gate, and rule 14's loan.
  v_blocked := public.benefit_payment_blocked_reason(p_claim_id);

  if v_blocked is not null then
    raise exception
      'Claim % cannot be paid. %', v_claim.claim_number, v_blocked
      using errcode = 'P0001';
  end if;

  select * into v_snapshot
  from public.benefit_assessment_snapshots where claim_id = p_claim_id;

  if not found then
    raise exception
      'Claim % has no assessment snapshot, so there is no authorised recipient or amount. Nothing is paid on a claim whose assessment is not on the record.',
      v_claim.claim_number using errcode = 'P0001';
  end if;

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

  -- Decision A. The funding account, before anything is posted.
  perform public.assert_spendable_account(v_cash, 'funding');
  perform public.assert_cash_funds_available(v_cash, v_claim.approved_amount);
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
$function$;

CREATE OR REPLACE FUNCTION public.post_reversal_journal(p_payment_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  -- Decision A. Money leaves the till again. If the receipt was never
  -- confirmed its restriction is released instead, so booked and pending fall
  -- together and availability is unchanged; if it was confirmed, the cash is
  -- in the spendable pool and this is a payout like any other.
  perform public.release_or_assert_receipt_reversal(
    r.original_entry,
    public.branch_cash_account(r.branch_id,
      public.payment_method_cash_kind(r.payment_method)),
    r.amount);

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
$function$;

CREATE OR REPLACE FUNCTION public.reverse_savings_transaction(p_transaction_id uuid, p_reason text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_original  public.savings_transactions;
  v_account   public.savings_accounts;
  v_actor     uuid;
  v_label     text;
  v_reason    text;
  v_kind      text;
  v_source    text;
  v_txn_id    uuid;
  v_entry_id  uuid;
  v_liability uuid;
  v_balance   bigint;
  v_date      date;
begin
  v_actor := public.current_profile_id();
  v_label := public.audit_actor_label();

  if v_actor is null and auth.uid() is not null then
    raise exception
      'A reversal must be made by a signed-in member of staff.'
      using errcode = 'P0001';
  end if;

  if auth.uid() is not null and not public.user_has_permission('savings:reverse') then
    raise exception 'Reversing a savings transaction requires the savings:reverse capability.'
      using errcode = 'P0001';
  end if;

  v_reason := nullif(pg_catalog.btrim(coalesce(p_reason, '')), '');

  if v_reason is null or char_length(v_reason) < 4 then
    raise exception 'A reversal must say why, in at least four characters.'
      using errcode = 'P0001';
  end if;

  select * into v_original
  from public.savings_transactions where id = p_transaction_id;

  if not found then
    raise exception 'No such savings transaction.' using errcode = 'P0001';
  end if;

  if v_original.kind not in ('deposit', 'withdrawal') then
    raise exception
      'Transaction % is itself a reversal. Reversing a reversal would be a third entry saying nothing new.',
      v_original.transaction_number using errcode = 'P0001';
  end if;

  -- The lock, before the balance is read. A reversal of a deposit reduces the
  -- balance, so it races a concurrent withdrawal exactly as a withdrawal
  -- would.
  select * into v_account
  from public.savings_accounts
  where id = v_original.savings_account_id for update;

  -- Refused structurally by `savings_transactions_one_reversal_per_original`
  -- as well; stated here so the message explains itself rather than arriving
  -- as a constraint name.
  if exists (
    select 1 from public.savings_transactions
    where reverses_transaction_id = p_transaction_id
  ) then
    raise exception
      'Transaction % has already been reversed.', v_original.transaction_number
      using errcode = 'P0001';
  end if;

  v_kind := case v_original.kind
              when 'deposit' then 'deposit_reversal'
              else 'withdrawal_reversal'
            end;
  v_source := case v_original.kind
                when 'deposit' then 'savings_deposit_reversal'
                else 'savings_withdrawal_reversal'
              end;

  -- Reversing a deposit takes money back out of the member's savings. If it
  -- has already been withdrawn, there is nothing to take back, and the
  -- liability would go negative — the business would be recorded as owing a
  -- member less than nothing.
  if v_kind = 'deposit_reversal' then
    select coalesce(sum(signed_amount), 0)::bigint into v_balance
    from public.savings_transactions
    where savings_account_id = v_original.savings_account_id;

    if v_original.amount > v_balance then
      raise exception
        'Savings account % holds only % shillings, so a deposit of % cannot be reversed. Reverse the withdrawals that spent it first.',
        v_account.account_number, v_balance, v_original.amount
        using errcode = 'P0001';
    end if;
  end if;

  v_liability := public.ledger_account_by_code('2100');
  v_date := public.business_date();
  v_txn_id := pg_catalog.gen_random_uuid();

  -- Decision A. Reversing a deposit takes cash back out of the business.
  if v_kind = 'deposit_reversal' then
    perform public.release_or_assert_receipt_reversal(
      v_original.journal_entry_id, v_original.cash_account_id, v_original.amount);
  end if;

  -- The contra entry: every leg of the original, the other way round.
  v_entry_id := public.post_journal(
    v_original.branch_id,
    v_date,
    'Reversal of ' || v_original.transaction_number || ' — ' || v_reason,
    v_source,
    v_txn_id,
    null,
    v_original.client_id,
    case v_original.kind
      when 'deposit' then
        pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'account_id', v_liability, 'debit', v_original.amount, 'credit', 0,
            'memo', 'Deposit reversed — ' || v_original.transaction_number),
          pg_catalog.jsonb_build_object(
            'account_id', v_original.cash_account_id,
            'debit', 0, 'credit', v_original.amount,
            'memo', 'Deposit reversed'))
      else
        pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'account_id', v_original.cash_account_id,
            'debit', v_original.amount, 'credit', 0,
            'memo', 'Withdrawal reversed'),
          pg_catalog.jsonb_build_object(
            'account_id', v_liability, 'debit', 0, 'credit', v_original.amount,
            'memo', 'Withdrawal reversed — ' || v_original.transaction_number))
    end,
    null, v_actor, v_label
  );

  insert into public.savings_transactions (
    id, savings_account_id, membership_id, client_id, branch_id,
    kind, amount, payment_method, cash_account_id,
    idempotency_key, value_date, journal_entry_id,
    reverses_transaction_id, reversal_reason,
    recorded_by, recorded_by_label
  )
  values (
    v_txn_id, v_original.savings_account_id, v_original.membership_id,
    v_original.client_id, v_original.branch_id,
    v_kind, v_original.amount, v_original.payment_method,
    v_original.cash_account_id,
    -- The reversal's own key, derived from the original so a retried reversal
    -- of the same transaction replays rather than posting twice. Deriving it
    -- rather than taking it as a parameter means a caller cannot make two.
    public.savings_reversal_key(p_transaction_id),
    v_date, v_entry_id, p_transaction_id, v_reason, v_actor, v_label
  );

  return v_txn_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.reverse_membership_fee(p_receipt_id uuid, p_reason text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_receipt  public.membership_fee_receipts;
  v_actor    uuid;
  v_label    text;
  v_reason   text;
  v_income   uuid;
  v_entry_id uuid;
begin
  v_actor := public.current_profile_id();
  v_label := public.audit_actor_label();

  if v_actor is null and auth.uid() is not null then
    raise exception
      'A reversal must be made by a signed-in member of staff.'
      using errcode = 'P0001';
  end if;

  if auth.uid() is not null and not public.user_has_permission('savings:reverse') then
    raise exception
      'Reversing a registration fee requires the savings:reverse capability.'
      using errcode = 'P0001';
  end if;

  v_reason := nullif(pg_catalog.btrim(coalesce(p_reason, '')), '');

  if v_reason is null or char_length(v_reason) < 4 then
    raise exception 'A reversal must say why, in at least four characters.'
      using errcode = 'P0001';
  end if;

  select * into v_receipt
  from public.membership_fee_receipts where id = p_receipt_id for update;

  if not found then
    raise exception 'No such registration fee receipt.' using errcode = 'P0001';
  end if;

  if v_receipt.status = 'reversed' then
    raise exception
      'Receipt % has already been reversed.', v_receipt.receipt_number
      using errcode = 'P0001';
  end if;

  v_income := public.ledger_account_by_code('4340');

  -- Decision A. The fee goes back out of the account it came into.
  perform public.release_or_assert_receipt_reversal(
    v_receipt.journal_entry_id, v_receipt.receiving_account_id, v_receipt.amount);

  v_entry_id := public.post_journal(
    v_receipt.branch_id,
    public.business_date(),
    'Reversal of registration fee ' || v_receipt.receipt_number || ' — ' || v_reason,
    'membership_fee_reversal',
    v_receipt.id,
    null,
    v_receipt.client_id,
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'account_id', v_income, 'debit', v_receipt.amount, 'credit', 0,
        'memo', 'Registration fee reversed — ' || v_receipt.receipt_number),
      pg_catalog.jsonb_build_object(
        'account_id', v_receipt.receiving_account_id,
        'debit', 0, 'credit', v_receipt.amount,
        'memo', 'Registration fee returned')
    ),
    null, v_actor, v_label
  );

  update public.membership_fee_receipts
     set status = 'reversed',
         reversed_at = pg_catalog.now(),
         reversed_by = v_actor,
         reversed_by_label = v_label,
         reversal_reason = v_reason,
         reversal_entry_id = v_entry_id
   where id = p_receipt_id;

  return v_entry_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.reverse_meeting_fine_payment(p_payment_id uuid, p_reason text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_payment public.meeting_fine_payments;
  v_fine    public.meeting_fines;
  v_actor   uuid;
  v_label   text;
  v_entry   uuid;
begin
  v_actor := public.current_profile_id();
  v_label := public.audit_actor_label();

  if v_actor is null and auth.uid() is not null then
    raise exception
      'A fine payment must be reversed by a signed-in member of staff.'
      using errcode = 'P0001';
  end if;

  if auth.uid() is not null and not public.user_has_permission('fines:reverse') then
    raise exception
      'Reversing a fine payment requires the fines:reverse capability.'
      using errcode = '42501';
  end if;

  if coalesce(pg_catalog.btrim(coalesce(p_reason, '')), '') = '' then
    raise exception 'Say why this payment is being reversed.'
      using errcode = 'P0001';
  end if;

  select * into v_payment
  from public.meeting_fine_payments where id = p_payment_id for update;

  if not found then
    raise exception 'No such fine payment.' using errcode = 'P0001';
  end if;

  if not public.user_can_see_branch(v_payment.branch_id) then
    raise exception 'You cannot reverse that branch''s payments.'
      using errcode = '42501';
  end if;

  if v_payment.status = 'reversed' then
    raise exception
      'Payment % has already been reversed.', v_payment.payment_number
      using errcode = 'P0001';
  end if;

  select * into v_fine
  from public.meeting_fines where id = v_payment.fine_id for update;

  -- A reversing entry, the mirror of the original. Never an edit to the
  -- entry that was posted: the books record that money came in and that it
  -- went back out, which is what happened.
  -- Decision A. The fine goes back out of the till it came into.
  perform public.release_or_assert_receipt_reversal(
    v_payment.journal_entry_id, v_payment.cash_account_id, v_payment.amount);

  v_entry := public.post_journal(
    v_payment.branch_id,
    public.business_date(),
    'Meeting fine reversed — ' || v_payment.payment_number
      || ' (' || v_fine.fine_number || ')',
    'other_income_reversal',
    p_payment_id,
    null,
    v_payment.client_id,
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'account_id', v_payment.income_account_id,
        'debit', v_payment.amount, 'credit', 0,
        'memo', 'Reversal of ' || v_payment.payment_number),
      pg_catalog.jsonb_build_object(
        'account_id', v_payment.cash_account_id,
        'debit', 0, 'credit', v_payment.amount,
        'memo', 'Fine returned')
    ),
    null, v_actor, v_label
  );

  update public.meeting_fine_payments
     set status = 'reversed',
         reversed_at = public.business_now(),
         reversed_by = v_actor,
         reversed_by_label = v_label,
         reversal_reason = pg_catalog.btrim(p_reason),
         reversal_entry_id = v_entry
   where id = p_payment_id;

  -- The charge stands again. A reversal undoes the collection, not the fine:
  -- whether the charge itself was wrong is a separate decision, taken by
  -- cancelling it.
  update public.meeting_fines
     set amount_paid = greatest(amount_paid - v_payment.amount, 0),
         status = 'outstanding'
   where id = v_payment.fine_id;

  return v_entry;
end;
$function$;

CREATE OR REPLACE FUNCTION public.reverse_other_income(p_income_id uuid, p_reason text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  i        record;
  v_contra uuid;
begin
  if auth.uid() is not null and not public.user_has_permission('income:create') then
    raise exception 'Reversing income requires the income:create capability.'
      using errcode = 'P0001';
  end if;

  if btrim(coalesce(p_reason, '')) = '' then
    raise exception 'Reversing income requires a reason.' using errcode = 'P0001';
  end if;

  select * into i from public.other_income where id = p_income_id for update;

  if i.id is null then
    raise exception 'No such income record.' using errcode = 'P0001';
  end if;

  if i.status <> 'posted' then
    raise exception 'Income % has already been reversed.', i.income_number
      using errcode = 'P0001';
  end if;

  -- Decision A. Other income is a receipt, so it carries a restriction until
  -- somebody counts the drawer. Reversed before that, the restriction is
  -- released and booked and pending fall together; reversed after, the money
  -- is in the spendable pool and this is a payout like any other.
  perform public.release_or_assert_receipt_reversal(
    i.journal_entry_id, i.receiving_account_id, i.amount);

  v_contra := public.post_journal(
    i.branch_id,
    public.business_date(),
    'Reversal of income ' || i.income_number,
    'other_income_reversal', i.id, i.loan_id, i.client_id,
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('account_id', i.income_account_id,
        'debit', i.amount, 'credit', 0, 'memo', btrim(p_reason)),
      pg_catalog.jsonb_build_object('account_id', i.receiving_account_id,
        'debit', 0, 'credit', i.amount, 'memo', 'Money returned')
    ),
    public.business_now(), public.current_profile_id(), public.audit_actor_label()
  );

  update public.other_income
     set status = 'reversed',
         reversal_entry_id = v_contra,
         reversed_at = public.business_now(),
         reversed_by = public.current_profile_id(),
         decision_reason = btrim(p_reason)
   where id = i.id;

  update public.journal_entries
     set reversed_by_entry_id = v_contra
   where id = i.journal_entry_id and reversed_by_entry_id is null;

  perform public.record_audit_event(
    'other_income.reversed', 'other_income', i.id::text, null,
    pg_catalog.jsonb_build_object('income_number', i.income_number, 'reason', btrim(p_reason)),
    null, null
  );

  return v_contra;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 3. The storage-level guarantee
--
-- DEFERRED, so it is evaluated at commit against the finished state of the
-- transaction rather than line by line — a multi-leg entry that takes money
-- out of one account and puts it into another must be judged whole.
--
-- Only lines that reduce a policed cash account are examined. A line that
-- increases one cannot create a shortfall, and examining it would make an
-- account that is already negative impossible to repair.
-- ---------------------------------------------------------------------------

create or replace function public.journal_lines_assert_funded()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind      text;
  v_name      text;
  v_booked    bigint;
  v_pending   bigint;
  v_available bigint;
begin
  select a.cash_kind, a.name into v_kind, v_name
    from public.ledger_accounts a where a.id = new.account_id;

  -- Not cash, so not this rule's business.
  if v_kind is null then
    return null;
  end if;

  -- Agency float keeps its own rule and its own setting, which the Owner's
  -- instruction 2 preserves: `assert_agency_float_available` and
  -- `allow_negative_agency_float`. Two rules over one balance would be two
  -- answers to one question.
  if v_kind = 'agency_float' then
    return null;
  end if;

  -- Money coming in cannot make an account short.
  if new.credit <= new.debit then
    return null;
  end if;

  v_booked  := public.ledger_account_balance(new.account_id);
  v_pending := case when v_kind = 'in_transit' then 0
                    else public.cash_account_pending_amount(new.account_id) end;
  v_available := v_booked - v_pending;

  if v_available >= 0 then
    return null;
  end if;

  raise exception
    'This would leave % holding % shillings available (% booked, % awaiting confirmation). Nothing is paid out of an account that does not hold it.',
    v_name, v_available, v_booked, v_pending
    using errcode = 'P0001';
end;
$$;

comment on function public.journal_lines_assert_funded() is
  'Decision A, the guarantee. At commit, a line that took money out of a till, wallet, bank or transit account must leave that account''s available balance at or above zero. Deferred, so a whole entry is judged at once. Binds every caller including service_role and any posting path written later. Agency float is excluded: it has its own rule.';

revoke all on function public.journal_lines_assert_funded() from public, anon, authenticated;

create constraint trigger journal_lines_assert_funded
  after insert on public.journal_lines
  deferrable initially deferred
  for each row
  execute function public.journal_lines_assert_funded();
