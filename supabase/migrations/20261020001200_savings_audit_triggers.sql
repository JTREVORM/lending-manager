-- ===========================================================================
-- Polytos Phase 2.12 — the audit trail for money that is not a loan
--
-- Triggers rather than calls in a posting function, for the reason every
-- other phase gives: a trigger fires in the same transaction as the change,
-- so the data and the trail cannot disagree, and it covers every route to the
-- table rather than the one route somebody remembered to instrument.
--
-- ## What is captured, and what is deliberately not
--
-- Amounts, references, accounts, methods and who did it. No personal data:
-- the member is the client, and the client trail already covers them under
-- its own rules, including the one that keeps a National Identification
-- Number out of the trail entirely.
--
-- The consent trail is the exception worth stating. It records the **method**
-- and the **verification result** but never the evidence itself — not the
-- signature path, not the phone number a code went to, not the digest. An
-- audit row naming the file would be a way to find somebody's signature by
-- reading a table governed by different policies from the one that protects
-- it.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- membership_fee_receipts
-- ---------------------------------------------------------------------------

create or replace function public.audit_membership_fee_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_action text;
  v_old    jsonb;
  v_new    jsonb;
begin
  if tg_op = 'INSERT' then
    v_action := 'membership_fee.recorded';
    v_new := pg_catalog.jsonb_build_object(
      'receipt_number', new.receipt_number,
      'membership_id', new.membership_id,
      'amount', new.amount,
      'payment_method', new.payment_method,
      'receiving_account_id', new.receiving_account_id,
      'journal_entry_id', new.journal_entry_id,
      'business_date', new.business_date
    );
  else
    v_action := case
      when new.status = 'reversed' and old.status <> 'reversed'
        then 'membership_fee.reversed'
      else 'membership_fee.updated'
    end;
    v_old := pg_catalog.jsonb_build_object('status', old.status);
    v_new := pg_catalog.jsonb_build_object(
      'status', new.status,
      'reversal_reason', new.reversal_reason,
      'reversal_entry_id', new.reversal_entry_id
    );
  end if;

  perform public.record_audit_event(
    v_action, 'membership_fee_receipt', new.id::text, v_old, v_new,
    pg_catalog.jsonb_build_object(
      'receipt_number', new.receipt_number,
      'membership_id', new.membership_id)
  );

  return new;
end;
$$;

create trigger audit_membership_fee_change
  after insert or update on public.membership_fee_receipts
  for each row execute function public.audit_membership_fee_change();

revoke all on function public.audit_membership_fee_change()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- savings_accounts
-- ---------------------------------------------------------------------------

create or replace function public.audit_savings_account_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_action text;
  v_old    jsonb;
  v_new    jsonb;
begin
  if tg_op = 'INSERT' then
    v_action := 'savings_account.opened';
    v_new := pg_catalog.jsonb_build_object(
      'account_number', new.account_number,
      'membership_id', new.membership_id,
      'branch_id', new.branch_id,
      'policy_version_id', new.policy_version_id,
      'opened_on', new.opened_on
    );
  else
    v_action := case
      when new.status is distinct from old.status then 'savings_account.status_changed'
      else 'savings_account.updated'
    end;
    v_old := pg_catalog.jsonb_build_object(
      'status', old.status, 'status_reason', old.status_reason);
    v_new := pg_catalog.jsonb_build_object(
      'status', new.status, 'status_reason', new.status_reason,
      'closed_on', new.closed_on);
  end if;

  perform public.record_audit_event(
    v_action, 'savings_account', new.id::text, v_old, v_new,
    pg_catalog.jsonb_build_object(
      'account_number', new.account_number,
      'membership_id', new.membership_id)
  );

  return new;
end;
$$;

create trigger audit_savings_account_change
  after insert or update on public.savings_accounts
  for each row execute function public.audit_savings_account_change();

revoke all on function public.audit_savings_account_change()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- savings_transactions
--
-- INSERT only, because the table takes nothing else.
-- ---------------------------------------------------------------------------

create or replace function public.audit_savings_transaction()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.record_audit_event(
    'savings.' || new.kind,
    'savings_transaction',
    new.id::text,
    null,
    pg_catalog.jsonb_build_object(
      'transaction_number', new.transaction_number,
      'savings_account_id', new.savings_account_id,
      'kind', new.kind,
      'amount', new.amount,
      'signed_amount', new.signed_amount,
      'payment_method', new.payment_method,
      'cash_account_id', new.cash_account_id,
      'journal_entry_id', new.journal_entry_id,
      'reverses_transaction_id', new.reverses_transaction_id,
      'reversal_reason', new.reversal_reason,
      'value_date', new.value_date
    ),
    pg_catalog.jsonb_build_object(
      'transaction_number', new.transaction_number,
      'membership_id', new.membership_id)
  );

  return new;
end;
$$;

create trigger audit_savings_transaction
  after insert on public.savings_transactions
  for each row execute function public.audit_savings_transaction();

revoke all on function public.audit_savings_transaction()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- savings_withdrawal_requests
-- ---------------------------------------------------------------------------

create or replace function public.audit_savings_withdrawal_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_action text;
  v_old    jsonb;
  v_new    jsonb;
begin
  if tg_op = 'INSERT' then
    v_action := 'savings_withdrawal.requested';
    v_new := pg_catalog.jsonb_build_object(
      'request_number', new.request_number,
      'savings_account_id', new.savings_account_id,
      'amount', new.amount,
      'balance_at_request', new.balance_at_request,
      'reason', new.reason
    );
  else
    v_action := 'savings_withdrawal.' || new.status;
    v_old := pg_catalog.jsonb_build_object('status', old.status);
    v_new := pg_catalog.jsonb_build_object(
      'status', new.status,
      'decision_notes', new.decision_notes,
      'paid_transaction_id', new.paid_transaction_id,
      'cancellation_reason', new.cancellation_reason
    );
  end if;

  perform public.record_audit_event(
    v_action, 'savings_withdrawal_request', new.id::text, v_old, v_new,
    pg_catalog.jsonb_build_object(
      'request_number', new.request_number,
      'membership_id', new.membership_id)
  );

  return new;
end;
$$;

create trigger audit_savings_withdrawal_change
  after insert or update on public.savings_withdrawal_requests
  for each row execute function public.audit_savings_withdrawal_change();

revoke all on function public.audit_savings_withdrawal_change()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- membership_terms_acceptances
--
-- Phase 1 already audits the acceptance. This replaces that trigger function
-- so the trail also records *how* consent was given and whether it verified —
-- and still records none of the evidence itself.
-- ---------------------------------------------------------------------------

create or replace function public.audit_membership_terms_accepted()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.record_audit_event(
    'membership.terms_accepted',
    'membership_terms_acceptance',
    new.id::text,
    null,
    pg_catalog.jsonb_build_object(
      'membership_id', new.membership_id,
      'policy_version', new.policy_version,
      'accepted_at', new.accepted_at,
      -- How, and whether it held. Never the signature path, never the phone
      -- number, never the digest: an audit row naming the evidence would be
      -- a way to find somebody's signature through a table governed by
      -- different policies than the one protecting it.
      'consent_method', new.consent_method,
      'verification_status', new.verification_status,
      'witness_profile_id', new.witness_profile_id
    ),
    pg_catalog.jsonb_build_object('membership_id', new.membership_id)
  );

  return new;
end;
$$;

comment on function public.audit_membership_terms_accepted() is
  'AFTER INSERT on membership_terms_acceptances: records that terms were accepted, by which method, and whether the evidence verified. Never the evidence itself.';

revoke all on function public.audit_membership_terms_accepted()
  from public, anon, authenticated;
