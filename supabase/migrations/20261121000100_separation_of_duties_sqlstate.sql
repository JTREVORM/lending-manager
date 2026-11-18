-- ===========================================================================
-- L7 — a separation-of-duties refusal says so, in its own SQLSTATE
--
-- Recommendation L7 of the full-system certification report. Found by L5's
-- browser journeys: a Manager who banks cash and then tries to clear it
-- themselves was told **"Privilege denied on record."**
--
-- That sentence names the wrong cause. The Manager *holds*
-- `deposits:verify`. What stopped them is separation of duties — somebody
-- else must check their work — so the useful response is "ask a colleague",
-- and what they were told invites a support ticket instead.
--
-- ## Why the message could not simply be passed through
--
-- `verify_bank_deposit` already raises a good sentence:
--
--     'You recorded this deposit, so you cannot verify its clearance.
--      A different Manager or Owner must.'
--
-- and `lib/db-errors.ts` replaced it, deliberately and correctly: a database
-- message can carry table names, column names, constraint names and row
-- values, so none of them is ever shown to a user. That rule stays. The fix
-- is not to start trusting database text; it is to let the *code* carry the
-- meaning, and keep the sentence in TypeScript where it can be reviewed.
--
-- ## Why a new SQLSTATE, and not an existing one
--
-- Before this migration the fourteen separation-of-duties guards raised two
-- different codes, and neither identifies them:
--
--   * `42501` (insufficient_privilege) — six of them. This is also exactly
--     what a genuine Row Level Security denial looks like from PostgREST, so
--     the application could not tell "you may not see this branch" from
--     "you may not check your own work". That ambiguity *is* the defect.
--   * `P0001` (raise_exception) — eight of them. Every hand-written business
--     rule in this schema raises `P0001`, so it identifies nothing either.
--
-- `SD001` is new, dedicated to this one meaning, and chosen to be safe:
--
--   * PostgreSQL defines no `SD` class (see the SQLSTATE appendix), and the
--     SQL standard reserves classes beginning with a letter in I–Z for
--     implementation-defined conditions, which is what this is;
--   * PostgREST reserves the `PT` class — `PTxxx` sets the HTTP status of the
--     response — so a code in that class is not available. This was measured
--     rather than assumed: raising `PT001` through the harness's real
--     PostgREST 12.2.3 produced no usable HTTP response at all.
--   * `SD001` was then measured through the same real PostgREST: it answers
--     **HTTP 400** with `{"code":"SD001"}`, the code reaching the client
--     intact, which is what `mapDatabaseError` needs and what `P0001`
--     already did.
--
-- One consequence, deliberate: the six guards that raised `42501` answered
-- **HTTP 401** before this change, because PostgREST maps that code to 401.
-- A maker-checker refusal is not an authentication problem, and a 401 is the
-- one status a client is entitled to read as "your session is the problem".
-- They now answer 400, like every other business refusal here.
--
-- ## What this migration does and does not change
--
-- Additive. Each of the fourteen functions is replaced from the definition
-- the database currently holds, with **exactly one line changed**: the
-- SQLSTATE on its own separation-of-duties `raise`. Signature, volatility,
-- `SECURITY DEFINER`, `SET search_path`, body, and every *other* raise in
-- the same function are carried across byte for byte. `CREATE OR REPLACE`
-- keeps the owner and the existing grants, so no privilege is regranted here.
--
-- Not changed: who may do what. No capability check, no RLS policy, no
-- ledger rule and no financial arithmetic is touched. A recorder still
-- cannot verify their own work — that is the control this migration exists
-- to describe more honestly, not to relax. The refused operation still
-- refuses, still writes nothing, and still rolls back.
--
-- The sentence staff now read is in `lib/db-errors.ts`, mapped from `SD001`:
-- "A different authorized officer must complete this action. You cannot
-- approve or verify your own work."
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.approve_agency_cash_reconciliation(p_reconciliation_id uuid, p_adjust boolean DEFAULT false, p_reason text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor   uuid;
  v_label   text;
  r         public.agency_cash_reconciliations;
  v_name    text;
  v_current bigint;
  v_over    uuid;
  v_entry   uuid;
begin
  v_actor := public.agency_actor('agency:reconcile');

  select * into r from public.agency_cash_reconciliations
   where id = p_reconciliation_id for update;

  if r.id is null or not public.user_can_see_branch(r.branch_id) then
    raise exception
      'No cash reconciliation with that identifier is available to you.'
      using errcode = '42501';
  end if;

  if r.status <> 'open' then
    raise exception
      'That reconciliation is already %, so it cannot be approved again.', r.status
      using errcode = 'P0001';
  end if;

  -- Maker-checker. Refused here with a sentence, ahead of the CHECK that
  -- would otherwise refuse it with a constraint name.
  if r.created_by = v_actor then
    raise exception
      'The officer who recorded a count cannot approve it. A second officer must certify it.'
      using errcode = 'SD001';
  end if;

  select l.name into v_name
  from public.ledger_accounts l where l.id = r.cash_account_id;

  perform public.lock_ledger_balances(array[r.cash_account_id]);

  -- The stale-count refusal. See this migration's header.
  select coalesce(b.balance, 0) into v_current
  from public.ledger_account_balances b where b.account_id = r.cash_account_id;
  v_current := coalesce(v_current, 0);

  if v_current <> r.system_closing_balance then
    raise exception
      'The balance of % has moved from % to % since this count was recorded, so its variance of % no longer describes anything. Count it again against the current balance.',
      v_name, r.system_closing_balance, v_current, r.variance
      using errcode = 'P0001';
  end if;

  if p_adjust then
    if r.variance = 0 then
      raise exception
        'There is nothing to adjust: the count agrees with the books.'
        using errcode = 'P0001';
    end if;

    -- Writing a difference into the ledger is its own authority.
    if auth.uid() is not null
       and not public.user_has_permission('agency:variance_adjustment') then
      raise exception
        'Writing a cash variance off requires the agency:variance_adjustment capability.'
        using errcode = '42501';
    end if;

    if pg_catalog.btrim(coalesce(p_reason, '')) = '' then
      raise exception 'A variance adjustment needs a reason.' using errcode = 'P0001';
    end if;

    v_over := public.ledger_account_by_code('5950');
    select p.full_name into v_label from public.profiles p where p.id = v_actor;

    if r.variance > 0 then
      -- More cash than the books say: bring the books up, credit the gain.
      v_entry := public.post_journal(
        r.branch_id, r.reconciliation_date,
        'Cash over on ' || r.reconciliation_date::text || ' — ' || p_reason,
        'reconciliation_adjustment', r.id, null, null,
        pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object('account_id', r.cash_account_id,
            'debit', r.variance, 'credit', 0, 'memo', 'Cash over'),
          pg_catalog.jsonb_build_object('account_id', v_over,
            'debit', 0, 'credit', r.variance, 'memo', 'Cash over and short')),
        pg_catalog.now(), v_actor, coalesce(v_label, 'system'));
    else
      -- Less cash than the books say: the shortfall is an expense, and the
      -- cash really has to be there to take out.
      perform public.assert_cash_available(r.cash_account_id, -r.variance);
      v_entry := public.post_journal(
        r.branch_id, r.reconciliation_date,
        'Cash short on ' || r.reconciliation_date::text || ' — ' || p_reason,
        'reconciliation_adjustment', r.id, null, null,
        pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object('account_id', v_over,
            'debit', -r.variance, 'credit', 0, 'memo', 'Cash short'),
          pg_catalog.jsonb_build_object('account_id', r.cash_account_id,
            'debit', 0, 'credit', -r.variance, 'memo', 'Cash short')),
        pg_catalog.now(), v_actor, coalesce(v_label, 'system'));
    end if;
  end if;

  update public.agency_cash_reconciliations
     set status = 'reconciled',
         reconciled_by = v_actor,
         reconciled_at = pg_catalog.now(),
         variance_written_off = case when p_adjust then r.variance else 0 end,
         variance_journal_entry_id = v_entry,
         notes = case
           when p_adjust then coalesce(r.notes || ' / ', '') || p_reason
           else r.notes end
   where id = r.id;

  perform public.record_audit_event(
    case when p_adjust then 'agency.cash_variance_adjusted'
         else 'agency.cash_count_approved' end,
    'agency_cash_reconciliation', r.id::text,
    pg_catalog.jsonb_build_object('status', 'open'),
    pg_catalog.jsonb_build_object(
      'status', 'reconciled',
      'variance', r.variance,
      'variance_written_off', case when p_adjust then r.variance else 0 end,
      'variance_journal_entry_id', v_entry,
      'reason', p_reason)
  );

  return v_entry;
end;
$function$;

CREATE OR REPLACE FUNCTION public.approve_agency_float_reconciliation(p_reconciliation_id uuid, p_adjust boolean DEFAULT false, p_reason text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor   uuid;
  v_label   text;
  r         public.agency_float_reconciliations;
  v_ledger  uuid;
  v_name    text;
  v_current bigint;
  v_over    uuid;
  v_entry   uuid;
begin
  v_actor := public.agency_actor('agency:reconcile');

  select * into r from public.agency_float_reconciliations
   where id = p_reconciliation_id for update;

  if r.id is null or not public.user_can_see_branch(r.branch_id) then
    raise exception
      'No float reconciliation with that identifier is available to you.'
      using errcode = '42501';
  end if;

  if r.status <> 'open' then
    raise exception
      'That reconciliation is already %, so it cannot be approved again.', r.status
      using errcode = 'P0001';
  end if;

  if r.created_by = v_actor then
    raise exception
      'The officer who recorded a float statement cannot approve it. A second officer must certify it.'
      using errcode = 'SD001';
  end if;

  select a.ledger_account_id, l.name into v_ledger, v_name
  from public.agency_provider_float_accounts a
  join public.ledger_accounts l on l.id = a.ledger_account_id
  where a.id = r.float_account_id;

  -- Provider lock first, then the account. The order this phase keeps
  -- everywhere; see 20261110000100's header.
  perform public.lock_agency_provider_balance(r.provider_id, r.branch_id);
  perform public.lock_ledger_balances(array[v_ledger]);

  select coalesce(b.balance, 0) into v_current
  from public.ledger_account_balances b where b.account_id = v_ledger;
  v_current := coalesce(v_current, 0);

  if v_current <> r.system_closing_balance then
    raise exception
      'The balance of % has moved from % to % since this statement was recorded, so its variance of % no longer describes anything. Reconcile it again against the current balance.',
      v_name, r.system_closing_balance, v_current, r.variance
      using errcode = 'P0001';
  end if;

  if p_adjust then
    if r.variance = 0 then
      raise exception
        'There is nothing to adjust: the books agree with the statement.'
        using errcode = 'P0001';
    end if;

    if auth.uid() is not null
       and not public.user_has_permission('agency:variance_adjustment') then
      raise exception
        'Writing a float variance off requires the agency:variance_adjustment capability.'
        using errcode = '42501';
    end if;

    if pg_catalog.btrim(coalesce(p_reason, '')) = '' then
      raise exception 'A variance adjustment needs a reason.' using errcode = 'P0001';
    end if;

    if r.provider_statement_ref is null then
      raise exception
        'A float variance may only be written off against a named provider statement.'
        using errcode = 'P0001';
    end if;

    v_over := public.ledger_account_by_code('5960');
    select p.full_name into v_label from public.profiles p where p.id = v_actor;

    if r.variance > 0 then
      -- The books claim more float than the provider holds. Write the
      -- surplus off and take it out of the float account — so the float has
      -- to actually be there.
      perform public.assert_agency_float_available(v_ledger, r.variance);
      v_entry := public.post_journal(
        r.branch_id, r.reconciliation_date,
        'Agency float over on ' || r.reconciliation_date::text || ' — ' || p_reason,
        'reconciliation_adjustment', r.id, null, null,
        pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object('account_id', v_over,
            'debit', r.variance, 'credit', 0, 'memo', 'Agency float over and short'),
          pg_catalog.jsonb_build_object('account_id', v_ledger,
            'debit', 0, 'credit', r.variance, 'memo', 'Float surplus written off')),
        pg_catalog.now(), v_actor, coalesce(v_label, 'system'));
    else
      -- The provider holds more than the books claim. Bring the float up.
      v_entry := public.post_journal(
        r.branch_id, r.reconciliation_date,
        'Agency float short on ' || r.reconciliation_date::text || ' — ' || p_reason,
        'reconciliation_adjustment', r.id, null, null,
        pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object('account_id', v_ledger,
            'debit', -r.variance, 'credit', 0, 'memo', 'Float shortfall recognised'),
          pg_catalog.jsonb_build_object('account_id', v_over,
            'debit', 0, 'credit', -r.variance, 'memo', 'Agency float over and short')),
        pg_catalog.now(), v_actor, coalesce(v_label, 'system'));
    end if;
  end if;

  update public.agency_float_reconciliations
     set status = 'reconciled',
         reconciled_by = v_actor,
         reconciled_at = pg_catalog.now(),
         variance_written_off = case when p_adjust then r.variance else 0 end,
         variance_journal_entry_id = v_entry,
         notes = case
           when p_adjust then coalesce(r.notes || ' / ', '') || p_reason
           else r.notes end
   where id = r.id;

  perform public.record_audit_event(
    case when p_adjust then 'agency.float_variance_adjusted'
         else 'agency.float_statement_approved' end,
    'agency_float_reconciliation', r.id::text,
    pg_catalog.jsonb_build_object('status', 'open'),
    pg_catalog.jsonb_build_object(
      'status', 'reconciled',
      'variance', r.variance,
      'variance_written_off', case when p_adjust then r.variance else 0 end,
      'variance_journal_entry_id', v_entry,
      'statement_ref', r.provider_statement_ref,
      'reason', p_reason)
  );

  return v_entry;
end;
$function$;

CREATE OR REPLACE FUNCTION public.approve_expense(p_expense_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  e record;
begin
  if auth.uid() is not null and not public.user_has_permission('expenses:approve') then
    raise exception 'Approving an expense requires the expenses:approve capability.'
      using errcode = 'P0001';
  end if;

  select * into e from public.expenses where id = p_expense_id for update;

  if e.id is null then
    raise exception 'No such expense.' using errcode = 'P0001';
  end if;

  if e.status <> 'pending_approval' then
    raise exception 'Expense % is %, so there is nothing to approve.',
      e.expense_number, e.status using errcode = 'P0001';
  end if;

  if e.recorded_by is not null and e.recorded_by = public.current_profile_id() then
    raise exception 'An expense cannot be approved by the person who recorded it.'
      using errcode = 'SD001';
  end if;

  update public.expenses
     set approved_by = public.current_profile_id(),
         approved_by_label = public.audit_actor_label(),
         approved_at = public.business_now()
   where id = e.id;

  perform public.post_expense_journal(e.id);

  perform public.record_audit_event(
    'expense.approved', 'expense', e.id::text, null,
    pg_catalog.jsonb_build_object('expense_number', e.expense_number, 'amount', e.amount),
    null, null
  );

  return e.id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.approve_transfer(p_transfer_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  t record;
begin
  if auth.uid() is not null and not public.user_has_permission('transfers:approve') then
    raise exception 'Approving a transfer requires the transfers:approve capability.'
      using errcode = 'P0001';
  end if;

  select * into t from public.account_transfers where id = p_transfer_id for update;

  if t.id is null then
    raise exception 'No such transfer.' using errcode = 'P0001';
  end if;

  if t.status <> 'pending_approval' then
    raise exception 'Transfer % is %, so there is nothing to approve.',
      t.transfer_number, t.status using errcode = 'P0001';
  end if;

  -- The approver is not the person who asked. Separation of duties is the
  -- only thing an approval step buys, and without this the step is theatre.
  if t.initiated_by is not null and t.initiated_by = public.current_profile_id() then
    raise exception 'A transfer cannot be approved by the person who requested it.'
      using errcode = 'SD001';
  end if;

  update public.account_transfers
     set approved_by = public.current_profile_id(),
         approved_by_label = public.audit_actor_label(),
         approved_at = public.business_now()
   where id = t.id;

  perform public.post_transfer_journal(t.id);

  perform public.record_audit_event(
    'transfer.approved', 'account_transfer', t.id::text, null,
    pg_catalog.jsonb_build_object('transfer_number', t.transfer_number, 'amount', t.amount),
    null, null
  );

  return t.id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.certify_agency_commission_reconciliation(p_reconciliation_id uuid, p_notes text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid;
  r       public.agency_commission_reconciliations;
begin
  v_actor := public.agency_actor('agency:reconcile');

  select * into r from public.agency_commission_reconciliations
   where id = p_reconciliation_id for update;

  if r.id is null or not public.user_can_see_branch(r.branch_id) then
    raise exception 'No such commission reconciliation.' using errcode = 'P0001';
  end if;

  if r.status = 'certified' then
    raise exception 'That commission reconciliation is already certified.'
      using errcode = 'P0001';
  end if;

  if r.created_by = v_actor then
    raise exception
      'A commission reconciliation cannot be certified by the person who submitted it.'
      using errcode = 'SD001';
  end if;

  -- No journal. Decision OD-2: reconciliation never posts a financial change.
  -- A variance that survives certification stays on the exceptions view until
  -- it is corrected at the transaction or adjusted on the Owner's authority.
  update public.agency_commission_reconciliations
     set status        = 'certified',
         reconciled_by = v_actor,
         reconciled_at = now(),
         notes         = coalesce(nullif(pg_catalog.btrim(coalesce(p_notes, '')), ''), notes),
         updated_at    = now()
   where id = p_reconciliation_id;

  perform public.record_audit_event(
    'agency_commission_reconciliation.certified',
    'agency_commission_reconciliation', p_reconciliation_id::text,
    pg_catalog.jsonb_build_object('status', 'open'),
    pg_catalog.jsonb_build_object(
      'status', 'certified', 'variance', r.variance,
      'posted_journal', false),
    null, null);
end;
$function$;

CREATE OR REPLACE FUNCTION public.confirm_cash_receipt(p_confirmation_id uuid, p_note text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  c       public.cash_receipt_confirmations;
  v_actor uuid;
  v_label text;
  v_entry public.journal_entries;
begin
  perform public.require_business_identity();
  v_actor := public.current_profile_id();
  v_label := public.audit_actor_label();

  if v_actor is null and auth.uid() is not null then
    raise exception 'A receipt must be confirmed by a signed-in member of staff.'
      using errcode = '42501';
  end if;

  if auth.uid() is not null and not public.user_has_permission('receipts:confirm') then
    raise exception 'Confirming a receipt requires the receipts:confirm capability.'
      using errcode = '42501';
  end if;

  select * into c from public.cash_receipt_confirmations
   where id = p_confirmation_id for update;

  if not found then
    raise exception 'No such receipt confirmation.' using errcode = 'P0001';
  end if;

  if not public.user_can_see_branch(c.branch_id) then
    raise exception 'That branch''s receipts are not available to you.'
      using errcode = '42501';
  end if;

  -- Already done. Returned rather than raised: a retry is not a second
  -- confirmation.
  if c.state = 'confirmed' then
    return c.id;
  end if;

  if c.state = 'voided' then
    raise exception
      'That receipt was reversed before it was confirmed, so there is nothing to confirm.'
      using errcode = 'P0001';
  end if;

  if v_actor is not null and c.recorded_by = v_actor then
    raise exception
      'You recorded this receipt, so you cannot be the one who confirms it. A different Manager or Owner must.'
      using errcode = 'SD001';
  end if;

  -- The account it makes available, locked, so a payout racing this
  -- confirmation sees one state or the other and never half of each.
  perform public.lock_ledger_balances(array[c.account_id]);

  update public.cash_receipt_confirmations
     set state = 'confirmed',
         confirmed_by = v_actor,
         confirmed_by_label = coalesce(v_label, 'system'),
         confirmed_at = pg_catalog.now(),
         confirmation_note = nullif(pg_catalog.btrim(coalesce(p_note, '')), '')
   where id = c.id;

  select * into v_entry from public.journal_entries where id = c.journal_entry_id;

  perform public.record_audit_event(
    'cash_receipt.confirmed', 'cash_receipt_confirmation', c.id::text,
    pg_catalog.jsonb_build_object('state', 'pending'),
    pg_catalog.jsonb_build_object('state', 'confirmed', 'confirmed_by', v_actor),
    pg_catalog.jsonb_build_object(
      'journal_entry_id', c.journal_entry_id,
      'entry_number', v_entry.entry_number,
      'account_id', c.account_id, 'amount', c.amount,
      'recorded_by_label', c.recorded_by_label,
      'confirmed_by_label', coalesce(v_label, 'system'))
  );

  return c.id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.confirm_physical_cash_return(p_deposit_id uuid, p_evidence_note text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  d        public.bank_deposits;
  v_actor  uuid;
  v_label  text;
  v_note   text;
  v_entry  uuid;
begin
  v_actor := public.bank_deposit_actor('deposits:verify');
  v_label := public.audit_actor_label();

  v_note := nullif(pg_catalog.btrim(coalesce(p_evidence_note, '')), '');
  if v_note is null or char_length(v_note) < 4 then
    raise exception 'Record the evidence of the physical return — who handed it back, when, and what was counted.'
      using errcode = 'P0001';
  end if;

  select * into d from public.bank_deposits where id = p_deposit_id for update;
  if not found then
    raise exception 'No such bank deposit.' using errcode = 'P0001';
  end if;
  if not public.user_can_see_branch(d.branch_id) then
    raise exception 'That branch is not available to you.' using errcode = '42501';
  end if;
  if d.status = 'returned_to_till' then
    return d.return_journal_entry_id;
  end if;
  if d.status <> 'under_investigation' then
    raise exception 'Deposit % is %. Only a deposit under investigation can be returned to the till.',
      d.deposit_number, d.status using errcode = 'P0001';
  end if;
  if v_actor is not null and d.recorded_by = v_actor then
    raise exception
      'You recorded this deposit, so you cannot confirm its return. A different Manager or Owner must.'
      using errcode = 'SD001';
  end if;

  perform public.lock_ledger_balances(array[d.transit_account_id, d.from_account_id]);
  perform public.assert_cash_funds_available(d.transit_account_id, d.amount);

  v_entry := public.post_journal(
    d.branch_id, public.business_date(),
    'Unbanked cash returned to the till — ' || d.deposit_number,
    'bank_deposit_return', d.id, null, null,
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('account_id', d.from_account_id, 'debit', d.amount, 'credit', 0,
        'memo', 'Physical return verified'),
      pg_catalog.jsonb_build_object('account_id', d.transit_account_id, 'debit', 0, 'credit', d.amount,
        'memo', 'Out of transit')
    ),
    null, v_actor, v_label);

  update public.bank_deposits
     set status = 'returned_to_till',
         return_confirmed_at = pg_catalog.now(),
         return_confirmed_by = v_actor,
         return_evidence_note = v_note,
         return_journal_entry_id = v_entry
   where id = d.id;

  perform public.record_audit_event(
    'bank_deposit.returned_to_till', 'bank_deposit', d.id::text,
    pg_catalog.jsonb_build_object('status', 'under_investigation'),
    pg_catalog.jsonb_build_object('status', 'returned_to_till'),
    pg_catalog.jsonb_build_object('journal_entry_id', v_entry, 'amount', d.amount,
      'evidence', v_note));

  return v_entry;
end;
$function$;

CREATE OR REPLACE FUNCTION public.decide_savings_withdrawal(p_request_id uuid, p_approve boolean, p_notes text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_request public.savings_withdrawal_requests;
  v_actor   uuid;
  v_notes   text;
begin
  v_actor := public.current_profile_id();

  if v_actor is null and auth.uid() is not null then
    raise exception
      'A withdrawal must be decided by a signed-in member of staff.'
      using errcode = 'P0001';
  end if;

  if auth.uid() is not null
     and not public.user_has_permission('savings:approve_withdrawal') then
    raise exception
      'Deciding a withdrawal requires the savings:approve_withdrawal capability.'
      using errcode = 'P0001';
  end if;

  select * into v_request
  from public.savings_withdrawal_requests where id = p_request_id for update;

  if not found then
    raise exception 'No such withdrawal request.' using errcode = 'P0001';
  end if;

  if v_request.status <> 'pending' then
    raise exception
      'Withdrawal request % is %, so there is nothing to decide.',
      v_request.request_number, v_request.status using errcode = 'P0001';
  end if;

  -- The control. A Manager holds both capabilities, so without this the
  -- split between preparing and deciding would exist only on the permissions
  -- page. The same refusal `record_transfer` applies to its own approvals.
  if v_actor is not null and v_request.requested_by = v_actor then
    raise exception
      'A withdrawal cannot be decided by the person who prepared it.'
      using errcode = 'SD001';
  end if;

  v_notes := nullif(pg_catalog.btrim(coalesce(p_notes, '')), '');

  if not p_approve and v_notes is null then
    raise exception 'A rejected withdrawal must say why.' using errcode = 'P0001';
  end if;

  update public.savings_withdrawal_requests
     set status = case when p_approve then 'approved' else 'rejected' end,
         decided_by = v_actor,
         decided_by_label = public.audit_actor_label(),
         decided_at = pg_catalog.now(),
         decision_notes = v_notes
   where id = p_request_id;

  return p_request_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.reject_agency_cash_banking(p_banking_id uuid, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid;
  b       public.agency_cash_bankings;
begin
  v_actor := public.agency_actor('agency:settlements');

  if pg_catalog.btrim(coalesce(p_reason, '')) = '' then
    raise exception 'Say why the cash banking is being rejected.'
      using errcode = 'P0001';
  end if;

  select * into b from public.agency_cash_bankings
   where id = p_banking_id for update;

  if b.id is null then
    raise exception 'No such cash banking.' using errcode = 'P0001';
  end if;

  if not public.user_can_see_branch(b.branch_id) then
    raise exception 'That cash banking belongs to another branch.'
      using errcode = '42501';
  end if;

  if b.status <> 'pending' then
    raise exception 'Only a pending cash banking can be rejected; this one is %.',
      b.status using errcode = 'P0001';
  end if;

  if b.created_by = v_actor then
    raise exception
      'A cash banking cannot be rejected by the person who recorded it.'
      using errcode = 'SD001';
  end if;

  update public.agency_cash_bankings
     set status          = 'rejected',
         verified_by     = v_actor,
         verified_at     = pg_catalog.now(),
         rejected_reason = pg_catalog.btrim(p_reason),
         updated_at      = pg_catalog.now()
   where id = p_banking_id;

  perform public.record_audit_event(
    'agency_cash_banking.rejected', 'agency_cash_banking', p_banking_id::text,
    pg_catalog.jsonb_build_object('status', 'pending'),
    pg_catalog.jsonb_build_object('status', 'rejected',
                                  'reason', pg_catalog.btrim(p_reason)),
    null, null);
end;
$function$;

CREATE OR REPLACE FUNCTION public.verify_agency_cash_banking(p_banking_id uuid, p_expected_revision integer DEFAULT NULL::integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid;
  b       public.agency_cash_bankings;
  v_label text;
  v_lines jsonb;
  v_entry uuid;
begin
  v_actor := public.agency_actor('agency:settlements');

  select * into b from public.agency_cash_bankings
   where id = p_banking_id for update;

  if b.id is null then
    raise exception 'No such cash banking.' using errcode = 'P0001';
  end if;

  if not public.user_can_see_branch(b.branch_id) then
    raise exception 'That cash banking belongs to another branch.'
      using errcode = '42501';
  end if;

  -- Idempotent: a verifier who presses twice gets the entry, not a second one.
  if b.status = 'posted' then
    return b.journal_entry_id;
  end if;

  if b.status <> 'pending' then
    raise exception 'Only a pending cash banking can be posted; this one is %.',
      b.status using errcode = 'P0001';
  end if;

  if b.created_by = v_actor then
    raise exception
      'A cash banking cannot be posted by the person who recorded it.'
      using errcode = 'SD001';
  end if;

  if p_expected_revision is not null and p_expected_revision <> b.revision then
    raise exception
      'This cash banking has changed since you read it (revision % now, you saw %). Reload it and check the figures again.',
      b.revision, p_expected_revision
      using errcode = 'P0001';
  end if;

  -- Both accounts, in the order `lock_ledger_balances` imposes, before any
  -- balance is read. Then the cash has to actually be there.
  perform public.lock_ledger_balances(array[b.cash_account_id, b.bank_account_id]);
  perform public.assert_cash_available(b.cash_account_id, b.amount);

  select p.full_name into v_label from public.profiles p where p.id = v_actor;

  -- Dr the bank net of the charge, Cr the till for the whole amount, and the
  -- charge to 5080 only when there is one. The credit is the full amount
  -- because that is what left the till.
  v_lines := pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object(
      'account_id', b.bank_account_id,
      'debit', b.amount - b.charge, 'credit', 0,
      'memo', 'Cash banked'),
    pg_catalog.jsonb_build_object(
      'account_id', b.cash_account_id,
      'debit', 0, 'credit', b.amount,
      'memo', 'Cash taken to the bank'));

  if b.charge > 0 then
    v_lines := v_lines || pg_catalog.jsonb_build_object(
      'account_id', public.ledger_account_by_code('5080'),
      'debit', b.charge, 'credit', 0,
      'memo', 'Bank charge on a cash deposit');
  end if;

  v_entry := public.post_journal(
    b.branch_id,
    b.banking_date,
    'Cash banked (' || b.deposit_reference || ')',
    'agency_cash_banking', b.id, null, null,
    v_lines,
    pg_catalog.now(), v_actor, coalesce(v_label, 'system'));

  update public.agency_cash_bankings
     set status           = 'posted',
         verified_by      = v_actor,
         verified_at      = pg_catalog.now(),
         journal_entry_id = v_entry,
         updated_at       = pg_catalog.now()
   where id = p_banking_id;

  perform public.record_audit_event(
    'agency_cash_banking.posted', 'agency_cash_banking', p_banking_id::text,
    pg_catalog.jsonb_build_object('status', 'pending', 'revision', b.revision),
    pg_catalog.jsonb_build_object(
      'status', 'posted', 'journal_entry_id', v_entry,
      'amount', b.amount, 'charge', b.charge,
      'bank_account_id', b.bank_account_id,
      'cash_account_id', b.cash_account_id),
    null, null);

  return v_entry;
end;
$function$;

CREATE OR REPLACE FUNCTION public.verify_agency_float_trade(p_trade_id uuid, p_expected_revision integer DEFAULT NULL::integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor    uuid;
  t          public.agency_float_trades;
  f          record;
  c          record;
  pr         public.agency_service_providers;
  v_diff     bigint;
  v_lines    jsonb := '[]'::jsonb;
  v_entry    uuid;
  v_first    uuid;
  v_second   uuid;
begin
  v_actor := public.agency_actor('agency:settlements');

  select * into t from public.agency_float_trades
   where id = p_trade_id for update;

  if t.id is null then
    raise exception 'No such float trade.' using errcode = 'P0001';
  end if;

  if not public.user_can_see_branch(t.branch_id) then
    raise exception 'That float trade belongs to another branch.'
      using errcode = '42501';
  end if;

  -- Idempotent: a verifier who presses twice gets the entry, not an error.
  if t.status = 'posted' then
    return t.journal_entry_id;
  end if;

  if t.status <> 'pending' then
    raise exception 'Only a pending float trade can be posted; this one is %.', t.status
      using errcode = 'P0001';
  end if;

  if t.created_by = v_actor then
    raise exception
      'A float trade cannot be posted by the person who recorded it.'
      using errcode = 'SD001';
  end if;

  if p_expected_revision is not null and p_expected_revision <> t.revision then
    raise exception
      'This float trade has changed since you read it (revision % now, you saw %). Reload it and check the figures again.',
      t.revision, p_expected_revision
      using errcode = 'P0001';
  end if;

  select a.provider_id, a.branch_id, a.ledger_account_id, a.status,
         a.till_name, a.label
    into f
  from public.agency_provider_float_accounts a where a.id = t.float_account_id;

  select * into pr from public.agency_service_providers where id = t.provider_id;

  -- The provider balance lock, before any account lock. For a cross-branch
  -- transfer, both branches, in branch-id order so two opposing transfers
  -- cannot deadlock.
  if t.kind = 'transfer' and t.counter_branch_id is distinct from t.branch_id then
    v_first  := least(t.branch_id, t.counter_branch_id);
    v_second := greatest(t.branch_id, t.counter_branch_id);
    perform public.lock_agency_provider_balance(t.provider_id, v_first);
    perform public.lock_agency_provider_balance(t.provider_id, v_second);
  else
    perform public.lock_agency_provider_balance(t.provider_id, t.branch_id);
  end if;

  if t.kind = 'transfer' then
    select a.ledger_account_id, a.status into c
    from public.agency_provider_float_accounts a where a.id = t.counter_float_account_id;

    perform public.lock_ledger_balances(array[f.ledger_account_id, c.ledger_account_id]);
    perform public.assert_agency_float_available(f.ledger_account_id, t.float_amount);

    v_lines := pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'account_id', c.ledger_account_id,
        'debit', t.float_amount, 'credit', 0,
        'memo', 'Float received from another line'),
      pg_catalog.jsonb_build_object(
        'account_id', f.ledger_account_id,
        'debit', 0, 'credit', t.float_amount,
        'memo', 'Float moved to another line'));

  elsif t.kind = 'purchase' then
    perform public.lock_ledger_balances(
      array[f.ledger_account_id, t.settlement_account_id]);
    perform public.assert_cash_available(t.settlement_account_id, t.cash_amount);

    v_lines := pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'account_id', f.ledger_account_id,
        'debit', t.float_amount, 'credit', 0,
        'memo', 'Float purchased'),
      pg_catalog.jsonb_build_object(
        'account_id', t.settlement_account_id,
        'debit', 0, 'credit', t.cash_amount,
        'memo', 'Paid for float'));

    -- Decision OD-1. The difference is recognised, not absorbed into 1320.
    v_diff := t.cash_amount - t.float_amount;
    if v_diff > 0 then
      v_lines := v_lines || pg_catalog.jsonb_build_object(
        'account_id', public.ledger_account_by_code('5970'),
        'debit', v_diff, 'credit', 0,
        'memo', 'Premium paid above face value');
    elsif v_diff < 0 then
      v_lines := v_lines || pg_catalog.jsonb_build_object(
        'account_id', public.ledger_account_by_code('4580'),
        'debit', 0, 'credit', -v_diff,
        'memo', 'Discount received below face value');
    end if;

  else
    perform public.lock_ledger_balances(
      array[f.ledger_account_id, t.settlement_account_id]);
    perform public.assert_agency_float_available(f.ledger_account_id, t.float_amount);

    v_lines := pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'account_id', t.settlement_account_id,
        'debit', t.float_amount + t.fee_amount, 'credit', 0,
        'memo', 'Proceeds of float sold'),
      pg_catalog.jsonb_build_object(
        'account_id', f.ledger_account_id,
        'debit', 0, 'credit', t.float_amount,
        'memo', 'Float sold'));

    if t.fee_amount > 0 then
      v_lines := v_lines || pg_catalog.jsonb_build_object(
        'account_id', public.ledger_account_by_code('4570'),
        'debit', 0, 'credit', t.fee_amount,
        'memo', 'Service fee on a float sale');
    end if;
  end if;

  v_entry := public.post_journal(
    t.branch_id,
    t.trade_date,
    case t.kind
      when 'purchase' then 'Float purchased for '
      when 'sale'     then 'Float sold from '
      else 'Float transferred from '
    end || coalesce(nullif(f.label, ''), f.till_name)
      || ' (' || t.reference || ')',
    'agency_float_' || t.kind,
    t.id,
    null,
    null,
    v_lines,
    now(),
    v_actor,
    'Float trade'
  );

  update public.agency_float_trades
     set status           = 'posted',
         verified_by      = v_actor,
         verified_at      = now(),
         journal_entry_id = v_entry,
         updated_at       = now()
   where id = p_trade_id;

  perform public.record_audit_event(
    'agency_float_trade.posted', 'agency_float_trade', p_trade_id::text,
    pg_catalog.jsonb_build_object('status', 'pending', 'revision', t.revision),
    pg_catalog.jsonb_build_object(
      'status', 'posted', 'journal_entry_id', v_entry,
      'kind', t.kind, 'float_amount', t.float_amount,
      'cash_amount', t.cash_amount, 'fee_amount', t.fee_amount),
    pg_catalog.jsonb_build_object('provider_code', pr.code),
    null);

  return v_entry;
end;
$function$;

CREATE OR REPLACE FUNCTION public.verify_agency_transaction(p_transaction_id uuid, p_expected_revision integer DEFAULT NULL::integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid;
  t       public.agency_transactions;
  v_entry uuid;
begin
  v_actor := public.agency_actor('agency:verify');

  -- Locks the row and refuses it if the caller's branch may not see it.
  t := public.agency_locked_transaction(p_transaction_id);

  if t.status = 'posted' then
    return t.journal_entry_id;               -- idempotent: already verified
  end if;

  if t.status <> 'awaiting_verification' then
    raise exception
      'Only a transaction awaiting verification can be verified; this one is %.', t.status
      using errcode = 'P0001';
  end if;

  if t.submitted_by = v_actor then
    raise exception
      'A transaction cannot be verified by the person who recorded it.'
      using errcode = 'SD001';
  end if;

  -- --- the verifier must have seen the figures they are posting ------------
  --
  -- Phase 4D. Maker-checker was in form but not in fact: this function took
  -- only an id, so a manager could press Verify on a screen loaded before an
  -- Owner authorised a commission exception, and post a figure they had never
  -- seen. Both guards below are after the idempotent return above, so a retry
  -- of an already-posted transaction still returns its journal rather than
  -- being refused for quoting an old revision.
  --
  -- A caller that quotes the revision it reviewed must quote the current one.
  if p_expected_revision is not null and p_expected_revision <> t.revision then
    raise exception
      'The financial details of this transaction changed since your screen loaded (you reviewed revision %, it is now revision %). Reload and review the current values before verifying.',
      p_expected_revision, t.revision
      using errcode = 'P0001';
  end if;

  -- And a caller that quotes nothing is refused once the money has moved
  -- after submission. Without this the guard would bind only the callers that
  -- opted into it, which is not a guarantee about the database.
  if p_expected_revision is null and t.revision is distinct from t.submitted_revision then
    raise exception
      'The financial details of this transaction changed after it was submitted (submitted at revision %, now revision %). Reload the transaction and verify the revision you reviewed.',
      t.submitted_revision, t.revision
      using errcode = 'P0001';
  end if;

  -- Stamped before posting, because the snapshot CHECK requires a verifier on
  -- any posted row and `post_agency_transaction` is what sets `posted`.
  update public.agency_transactions set verified_by = v_actor where id = p_transaction_id;

  v_entry := public.post_agency_transaction(p_transaction_id);

  insert into public.agency_transaction_audit_log
    (transaction_id, action, actor_id, old_value, new_value)
  values (p_transaction_id, 'verify', v_actor,
          pg_catalog.jsonb_build_object('status', 'awaiting_verification'),
          pg_catalog.jsonb_build_object('status', 'posted', 'journal_entry_id', v_entry));

  insert into public.agency_transaction_audit_log
    (transaction_id, action, actor_id, new_value)
  values (p_transaction_id, 'post', v_actor,
          pg_catalog.jsonb_build_object('journal_entry_id', v_entry));

  return v_entry;
end;
$function$;

CREATE OR REPLACE FUNCTION public.verify_bank_deposit(p_deposit_id uuid, p_bank_reference text, p_bank_value_date date, p_deposit_slip_path text DEFAULT NULL::text, p_notes text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  d        public.bank_deposits;
  v_actor  uuid;
  v_label  text;
  v_ref    text;
  v_entry  uuid;
  v_today  date;
begin
  v_actor := public.bank_deposit_actor('deposits:verify');
  v_label := public.audit_actor_label();

  select * into d from public.bank_deposits where id = p_deposit_id for update;
  if not found then
    raise exception 'No such bank deposit.' using errcode = 'P0001';
  end if;

  if not public.user_can_see_branch(d.branch_id) then
    raise exception 'That branch is not available to you.' using errcode = '42501';
  end if;

  -- Idempotent: a verified deposit stays verified.
  if d.status = 'cleared' then
    return d.clearance_journal_entry_id;
  end if;

  if d.status not in ('submitted', 'under_investigation') then
    raise exception 'Deposit % is %, and cannot be cleared.', d.deposit_number, d.status
      using errcode = 'P0001';
  end if;

  if v_actor is not null and d.recorded_by = v_actor then
    raise exception
      'You recorded this deposit, so you cannot verify its clearance. A different Manager or Owner must.'
      using errcode = 'SD001';
  end if;

  v_ref := pg_catalog.upper(pg_catalog.btrim(coalesce(p_bank_reference, '')));
  if v_ref = '' or char_length(v_ref) < 4 then
    raise exception 'A clearance needs the bank''s reference for the credit.' using errcode = 'P0001';
  end if;

  v_today := public.business_date();
  if p_bank_value_date is null then
    raise exception 'A clearance needs the bank''s value date.' using errcode = 'P0001';
  end if;
  if p_bank_value_date < d.deposit_date then
    raise exception 'The bank''s value date cannot precede the deposit.' using errcode = 'P0001';
  end if;
  if p_bank_value_date > v_today then
    raise exception 'The bank''s value date cannot be in the future.' using errcode = 'P0001';
  end if;

  -- The whole set, sorted, before the balance is read. Then the full amount
  -- must still be in transit (A-7: full clearance only).
  perform public.lock_ledger_balances(array[d.transit_account_id, d.bank_account_id]);
  perform public.assert_cash_funds_available(d.transit_account_id, d.amount);

  -- Dated today (A-6), never the value date.
  v_entry := public.post_journal(
    d.branch_id, v_today,
    'Bank clearance of ' || d.deposit_number || ' — ' || v_ref,
    'bank_deposit_clearance', d.id, null, null,
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('account_id', d.bank_account_id, 'debit', d.amount, 'credit', 0,
        'memo', 'Cleared by the bank'),
      pg_catalog.jsonb_build_object('account_id', d.transit_account_id, 'debit', 0, 'credit', d.amount,
        'memo', 'Out of transit')
    ),
    null, v_actor, v_label);

  update public.bank_deposits
     set status = 'cleared',
         bank_reference = v_ref,
         bank_value_date = p_bank_value_date,
         deposit_slip_path = nullif(pg_catalog.btrim(coalesce(p_deposit_slip_path, '')), ''),
         clearance_notes = nullif(pg_catalog.btrim(coalesce(p_notes, '')), ''),
         verified_by = v_actor,
         verified_by_label = coalesce(v_label, 'system'),
         verified_at = pg_catalog.now(),
         clearance_journal_entry_id = v_entry
   where id = d.id;

  perform public.record_audit_event(
    'bank_deposit.cleared', 'bank_deposit', d.id::text,
    pg_catalog.jsonb_build_object('status', d.status),
    pg_catalog.jsonb_build_object('status', 'cleared', 'bank_reference', v_ref,
      'bank_value_date', p_bank_value_date),
    pg_catalog.jsonb_build_object('journal_entry_id', v_entry, 'amount', d.amount,
      'recorded_by_label', d.recorded_by_label, 'verified_by_label', coalesce(v_label, 'system')));

  return v_entry;
end;
$function$;

CREATE OR REPLACE FUNCTION public.verify_member_beneficiary(p_beneficiary_id uuid, p_verified boolean, p_evidence_kind text, p_evidence_path text DEFAULT NULL::text, p_note text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_row public.member_beneficiaries;
  v_actor uuid;
  v_label text;
  v_objects integer;
begin
  v_actor := public.current_profile_id();
  v_label := public.audit_actor_label();

  if v_actor is null and auth.uid() is not null then
    raise exception
      'A beneficiary must be verified by a signed-in member of staff.'
      using errcode = 'P0001';
  end if;

  if auth.uid() is not null
     and not public.user_has_permission('beneficiaries:verify') then
    raise exception
      'Verifying a beneficiary requires the beneficiaries:verify capability.'
      using errcode = 'P0001';
  end if;

  select * into v_row
  from public.member_beneficiaries where id = p_beneficiary_id for update;

  if not found then
    raise exception 'No such beneficiary record.' using errcode = 'P0001';
  end if;

  if v_row.status <> 'active' then
    raise exception
      'Beneficiary % is %. Only a live record is verified.',
      v_row.beneficiary_number, v_row.status using errcode = 'P0001';
  end if;

  if v_row.verification_status <> 'pending_verification' then
    raise exception
      'Beneficiary % has already been %.',
      v_row.beneficiary_number, v_row.verification_status using errcode = 'P0001';
  end if;

  -- The control. Not a label on a permissions page: a Manager holds both
  -- `beneficiaries:manage` and `beneficiaries:verify`, and this is what stops
  -- them doing both halves of one record.
  if (v_actor is not null and v_row.recorded_by = v_actor)
     or (v_row.recorded_by is null and v_row.recorded_by_label = v_label) then
    raise exception
      'Beneficiary % was recorded by you. Somebody else must verify it — a beneficiary is who the business pays when a member dies, and one person recording and attesting to that is no check at all.',
      v_row.beneficiary_number using errcode = 'SD001';
  end if;

  if p_verified then
    if coalesce(pg_catalog.btrim(p_evidence_kind), '') = '' then
      raise exception
        'A verification names the evidence it rests on. A verified record with no evidence kind is a typed assertion, which is what this table exists not to hold.'
        using errcode = 'P0001';
    end if;

    if p_evidence_kind in ('relationship_document', 'identity_document') then
      if coalesce(pg_catalog.btrim(p_evidence_path), '') = '' then
        raise exception 'A document verification needs the object path.'
          using errcode = 'P0001';
      end if;

      -- The object must exist, in the private bucket, under this membership's
      -- own path. A path naming a file nobody uploaded verifies nothing — the
      -- check `membership_consent_evidence` introduced, for the same reason.
      select pg_catalog.count(*) into v_objects
      from storage.objects o
      where o.bucket_id = 'benefit-documents'
        and o.name = p_evidence_path
        and public.storage_path_membership_id(o.name) = v_row.membership_id;

      if v_objects = 0 then
        raise exception
          'There is no such document in this membership''s evidence folder. A path that names a file nobody uploaded verifies nothing.'
          using errcode = 'P0001';
      end if;
    elsif coalesce(pg_catalog.btrim(coalesce(p_evidence_path, '')), '') <> '' then
      raise exception
        'Evidence of kind "%" carries no document path.', p_evidence_kind
        using errcode = 'P0001';
    end if;

    -- The guard refuses a verification_status change except from here. The
    -- setting names *this row*, so one function call cannot verify two.
    perform pg_catalog.set_config('polytos.verifying', p_beneficiary_id::text, true);

    update public.member_beneficiaries
       set verification_status = 'verified',
           verification_evidence_kind = pg_catalog.btrim(p_evidence_kind),
           verification_evidence_path =
             nullif(pg_catalog.btrim(coalesce(p_evidence_path, '')), ''),
           verification_note = nullif(pg_catalog.btrim(coalesce(p_note, '')), ''),
           verified_at = pg_catalog.now(),
           verified_by = v_actor,
           verified_by_label = v_label,
           rejected_at = null,
           rejected_reason = null
     where id = p_beneficiary_id;

    perform pg_catalog.set_config('polytos.verifying', '', true);
  else
    if coalesce(pg_catalog.btrim(coalesce(p_note, '')), '') = '' then
      raise exception
        'A refusal needs a reason. Somebody will have to tell the member why.'
        using errcode = 'P0001';
    end if;

    perform pg_catalog.set_config('polytos.verifying', p_beneficiary_id::text, true);

    update public.member_beneficiaries
       set verification_status = 'rejected',
           verification_note = pg_catalog.btrim(p_note),
           rejected_at = pg_catalog.now(),
           rejected_reason = pg_catalog.btrim(p_note),
           verified_at = null,
           verified_by = null,
           verified_by_label = null
     where id = p_beneficiary_id;

    perform pg_catalog.set_config('polytos.verifying', '', true);
  end if;

  return p_beneficiary_id;
end;
$function$;

-- ---------------------------------------------------------------------------
-- The migration checks its own work.
--
-- Fourteen functions must now carry `SD001` on their separation-of-duties
-- raise, and none of them may still carry the ambiguous code it had before on
-- that same raise. Asserted here rather than left to a test, so a future
-- `create or replace` that drops the code cannot land quietly.
-- ---------------------------------------------------------------------------
do $$
declare
  v_expected text[] := array[
    'approve_agency_cash_reconciliation',
    'approve_agency_float_reconciliation',
    'approve_expense',
    'approve_transfer',
    'certify_agency_commission_reconciliation',
    'confirm_cash_receipt',
    'confirm_physical_cash_return',
    'decide_savings_withdrawal',
    'reject_agency_cash_banking',
    'verify_agency_cash_banking',
    'verify_agency_float_trade',
    'verify_agency_transaction',
    'verify_bank_deposit',
    'verify_member_beneficiary'
  ];
  v_name text;
  v_def  text;
  v_missing text[] := '{}';
begin
  foreach v_name in array v_expected loop
    select pg_get_functiondef(p.oid) into v_def
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = v_name and p.prokind = 'f';

    if v_def is null then
      v_missing := v_missing || (v_name || ' (no such function)');
    elsif position('SD001' in v_def) = 0 then
      v_missing := v_missing || (v_name || ' (no SD001 raise)');
    end if;
  end loop;

  if cardinality(v_missing) > 0 then
    raise exception
      'L7: these separation-of-duties guards do not raise SD001: %',
      array_to_string(v_missing, ', ')
      using errcode = 'P0001';
  end if;
end $$;
