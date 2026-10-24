-- ===========================================================================
-- Polytos Phase 2.8 — reversing a savings transaction, and a fee receipt
--
-- ## A reversal moves money back; it does not change a record's mind
--
-- Both functions here write a **new** record and a **new** journal, and leave
-- the original exactly as it was. Nothing is edited, nothing is deleted, and
-- the statement shows both lines — which is what makes a correction auditable
-- rather than merely tidy.
--
-- This is the rule `reverse_payment`, `reverse_transfer` and `reverse_expense`
-- already follow, and the reason it matters here is specific: a savings
-- balance is the sum of its transactions. A reversal that flipped a status
-- flag instead of inserting a contra row would leave the balance unchanged
-- while claiming the deposit had been undone, and the member's statement and
-- the general ledger would disagree about how much the business owes them.
--
-- ## Why reversing is the Owner's alone
--
-- `savings:reverse` is held by `owner_admin` and nobody else. A reversal
-- rewrites what the books say happened, and the person who took the money is
-- the last person who should be able to decide it never arrived. The same
-- judgement `reverse_payment` already encodes.
--
-- ## Reversing a registration fee does not un-activate a member
--
-- It cannot: the activation precondition is checked at the moment of
-- activation, and a membership that is already `active` stays active. What it
-- does do is make the state visible — the register shows a member whose fee
-- has been reversed, and the business decides what to do about it. Silently
-- suspending somebody because an accountant corrected a posting would be the
-- system making a membership decision it has no business making.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The reversal's idempotency key
--
-- Derived from the transaction being reversed rather than taken as a
-- parameter, so a retried reversal — a lost response, a double tap — carries
-- the same key as the first and is refused by the unique index instead of
-- posting a second contra entry. A caller cannot mint two keys for one
-- reversal because a caller does not mint this one at all.
-- ---------------------------------------------------------------------------

create or replace function public.savings_reversal_key(p_transaction_id uuid)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select (pg_catalog.md5('savings_reversal:' || p_transaction_id::text))::uuid;
$$;

comment on function public.savings_reversal_key(uuid) is
  'Polytos Phase 2. The idempotency key a reversal of this transaction will carry. Deterministic, so a retried reversal replays rather than posting twice.';

revoke all on function public.savings_reversal_key(uuid) from public, anon, authenticated;

create or replace function public.reverse_savings_transaction(
  p_transaction_id uuid,
  p_reason text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
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
$$;

comment on function public.reverse_savings_transaction(uuid, text) is
  'Polytos Phase 2. Reverses a posted savings deposit or withdrawal by writing a contra transaction and a contra journal. Never edits the original. Refuses a second reversal, and refuses to reverse a deposit that has already been spent.';

revoke all on function public.reverse_savings_transaction(uuid, text) from public, anon;
grant execute on function public.reverse_savings_transaction(uuid, text) to authenticated;

-- ===========================================================================
-- reverse_membership_fee()
--
--   Debit   4340 Membership Registration Fees    <- the income is given back
--   Credit  the account the money landed in
--
-- The receipt's status becomes `reversed` — that is not the accounting, it is
-- the document saying what happened to it, and the contra journal beside it
-- is the accounting.
-- ===========================================================================

create or replace function public.reverse_membership_fee(
  p_receipt_id uuid,
  p_reason text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
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
$$;

comment on function public.reverse_membership_fee(uuid, text) is
  'Polytos Phase 2. Reverses a registration fee receipt with a contra journal. Does not un-activate a membership: activation is checked when it happens, and a system that suspended somebody because an accountant corrected a posting would be making a membership decision it has no business making.';

revoke all on function public.reverse_membership_fee(uuid, text) from public, anon;
grant execute on function public.reverse_membership_fee(uuid, text) to authenticated;
