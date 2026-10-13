-- ===========================================================================
-- Phase 15.2 — what raises a notification
--
-- Every trigger here is AFTER the row has changed and inside the same
-- transaction as the change. Two consequences, both wanted:
--
--   * a notification cannot exist for an event that rolled back, and
--   * an event cannot happen without its notification — there is no queue to
--     drain, no worker to be down, and nothing arrives minutes late.
--
-- The cost is that a failure in here would fail the business transaction, so
-- every one of these does exactly one thing: build two strings and call
-- `raise_notification`, which swallows a duplicate. None of them reads a
-- balance, none of them loops, and none of them raises an exception.
--
-- ## Why there is no "loan is overdue" trigger
--
-- There is no row to hang it on. Arrears is computed from the schedule, the
-- ledger and today's date, on every read, precisely so that no column can go
-- stale — and a notification is a column with a timestamp. The nearest honest
-- event is the penalty: when the grace period runs out and a charge is
-- materialised, something happened, and that is what gets notified.
--
-- ## Why a payment received raises nothing
--
-- Because it is the normal case. Twenty receipts a day in the bell would
-- train everybody to ignore the bell, and the register already lists them.
-- The exception — a payment taken back — is what gets a notification.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Loans
-- ---------------------------------------------------------------------------

create or replace function public.notify_loan_transition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_client text;
  v_product text;
begin
  if new.status is not distinct from old.status then
    return null;
  end if;

  select c.full_name into v_client from public.clients c where c.id = new.client_id;
  select p.name into v_product
    from public.loan_products p where p.id = new.loan_product_id;

  if new.status = 'pending_approval' and old.status = 'draft' then
    perform public.raise_notification(
      'loan_awaiting_approval', 'attention',
      pg_catalog.format('%s is awaiting approval', new.loan_number),
      pg_catalog.format('%s — %s, UGX %s. Submitted for a decision.',
        coalesce(v_client, 'A borrower'), coalesce(v_product, 'a loan'),
        pg_catalog.to_char(new.principal_amount, 'FM999,999,999,999')),
      'loans:approve', 'loan', new.id,
      pg_catalog.format('loan:%s:submitted:%s', new.id, new.submitted_at),
      null, new.branch_id
    );

  elsif new.status = 'approved' then
    -- Addressed to whoever releases the money, which is deliberately not the
    -- person who approved it: Phase 4 withholds `loans:disburse` from the
    -- Manager so that one person cannot originate, approve and pay out.
    perform public.raise_notification(
      'loan_awaiting_disbursement', 'attention',
      pg_catalog.format('%s is approved and awaiting disbursement', new.loan_number),
      pg_catalog.format('%s — UGX %s to be released.',
        coalesce(v_client, 'A borrower'),
        pg_catalog.to_char(new.principal_amount, 'FM999,999,999,999')),
      'loans:disburse', 'loan', new.id,
      pg_catalog.format('loan:%s:approved', new.id),
      null, new.branch_id
    );

  elsif new.status = 'cancelled' then
    -- The one category addressed to a person. Whoever submitted the
    -- application is the person who has to tell the borrower, and they should
    -- not find out by refreshing the register.
    perform public.raise_notification(
      'loan_decided',
      case when new.closure_kind = 'rejected' then 'attention' else 'info' end,
      pg_catalog.format('%s was %s', new.loan_number,
        case when new.closure_kind = 'rejected' then 'refused' else 'withdrawn' end),
      coalesce(new.cancellation_reason, 'No reason was recorded.'),
      'loans:view', 'loan', new.id,
      pg_catalog.format('loan:%s:cancelled', new.id),
      new.submitted_by, new.branch_id
    );

  elsif new.status = 'active' and old.status = 'approved' then
    perform public.raise_notification(
      'loan_disbursed', 'info',
      pg_catalog.format('%s was disbursed', new.loan_number),
      pg_catalog.format('UGX %s released to %s.',
        pg_catalog.to_char(new.principal_amount, 'FM999,999,999,999'),
        coalesce(v_client, 'the borrower')),
      'loans:view', 'loan', new.id,
      pg_catalog.format('loan:%s:disbursed', new.id),
      null, new.branch_id
    );

  elsif new.status = 'cleared' then
    perform public.raise_notification(
      'loan_cleared', 'info',
      pg_catalog.format('%s is cleared', new.loan_number),
      pg_catalog.format('%s has repaid in full.', coalesce(v_client, 'The borrower')),
      'loans:view', 'loan', new.id,
      pg_catalog.format('loan:%s:cleared:%s', new.id, new.cleared_at),
      null, new.branch_id
    );
  end if;

  return null;
end;
$$;

comment on function public.notify_loan_transition() is
  'Phase 15. Raises a notification on the five loan transitions somebody acts on. A refusal or a withdrawal is addressed to the person who submitted the application, because they are the one who has to tell the borrower.';

revoke all on function public.notify_loan_transition() from public, anon, authenticated;

create trigger notify_loan_transition
  after update on public.loans
  for each row execute function public.notify_loan_transition();

-- ---------------------------------------------------------------------------
-- A payment taken back
-- ---------------------------------------------------------------------------

create or replace function public.notify_payment_reversed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_loan text;
  v_branch uuid;
begin
  select l.loan_number, l.branch_id into v_loan, v_branch
    from public.loans l where l.id = new.loan_id;

  perform public.raise_notification(
    'payment_reversed', 'urgent',
    pg_catalog.format('%s was reversed', new.payment_number),
    pg_catalog.format('UGX %s on %s. %s',
      pg_catalog.to_char(new.amount, 'FM999,999,999,999'),
      coalesce(v_loan, 'a loan'),
      coalesce(new.reversal_reason, 'No reason was recorded.')),
    -- To whoever may reverse — which is the Owner alone. A reversal is the
    -- one financial act this system lets a person undo, so the person who
    -- holds that power is the one told each time it is used.
    'payments:reverse', 'payment', new.id,
    pg_catalog.format('payment:%s:reversed', new.id),
    null, v_branch
  );

  return null;
end;
$$;

comment on function public.notify_payment_reversed() is
  'Phase 15. Urgent, and addressed to the capability that performed it: a reversal is the one financial act a person can undo, so its holder is told every time it is used.';

revoke all on function public.notify_payment_reversed() from public, anon, authenticated;

create trigger notify_payment_reversed
  after update on public.loan_payments
  for each row
  when (new.status = 'reversed' and old.status is distinct from 'reversed')
  execute function public.notify_payment_reversed();

-- ---------------------------------------------------------------------------
-- A penalty charged
--
-- The nearest thing to "this loan has gone bad" that is an actual event. The
-- grace period ran out and a charge was materialised against the borrower,
-- which is a fact with a date on it rather than a reading of the calendar.
-- ---------------------------------------------------------------------------

create or replace function public.notify_penalty_applied()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_loan text;
  v_client text;
  v_branch uuid;
begin
  select l.loan_number, c.full_name, l.branch_id
    into v_loan, v_client, v_branch
    from public.loans l
    join public.clients c on c.id = l.client_id
   where l.id = new.loan_id;

  perform public.raise_notification(
    'penalty_applied', 'urgent',
    pg_catalog.format('%s has been charged a penalty', coalesce(v_loan, 'A loan')),
    pg_catalog.format('UGX %s charged to %s after the grace period ran out on %s. Calculated at %s%% of the UGX %s outstanding at the deadline.',
      pg_catalog.to_char(new.penalty_amount, 'FM999,999,999,999'),
      coalesce(v_client, 'the borrower'),
      pg_catalog.to_char(new.grace_end_date, 'DD Mon YYYY'),
      pg_catalog.to_char(new.penalty_rate_bps / 100.0, 'FM999990.0'),
      pg_catalog.to_char(new.basis_amount, 'FM999,999,999,999')),
    'delinquency:view', 'loan', new.loan_id,
    pg_catalog.format('penalty:%s', new.id),
    null, v_branch
  );

  return null;
end;
$$;

comment on function public.notify_penalty_applied() is
  'Phase 15. The nearest honest event to "this loan has gone bad": the grace period ran out and a charge was materialised. Not a reading of the calendar, which is why there is no overdue notification.';

revoke all on function public.notify_penalty_applied() from public, anon, authenticated;

create trigger notify_penalty_applied
  after insert on public.loan_penalties
  for each row execute function public.notify_penalty_applied();

-- ---------------------------------------------------------------------------
-- A promise taken
--
-- Notified because it is a commitment somebody will have to check on, and the
-- date is the thing worth knowing. Whether it was *kept* raises nothing —
-- that is derived from the payments and would be a notification about the
-- calendar again.
-- ---------------------------------------------------------------------------

create or replace function public.notify_promise_recorded()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_loan text;
  v_client text;
  v_branch uuid;
begin
  if new.promised_amount is null then
    return null;
  end if;

  select l.loan_number, c.full_name, l.branch_id
    into v_loan, v_client, v_branch
    from public.loans l
    join public.clients c on c.id = l.client_id
   where l.id = new.loan_id;

  perform public.raise_notification(
    'promise_recorded', 'attention',
    pg_catalog.format('%s promised UGX %s by %s',
      coalesce(v_client, 'A borrower'),
      pg_catalog.to_char(new.promised_amount, 'FM999,999,999,999'),
      pg_catalog.to_char(new.promised_on, 'DD Mon')),
    pg_catalog.format('On %s. Whether it is kept is read from the payments.',
      coalesce(v_loan, 'a loan')),
    'recovery:view', 'loan', new.loan_id,
    pg_catalog.format('promise:%s', new.id),
    null, v_branch
  );

  return null;
end;
$$;

comment on function public.notify_promise_recorded() is
  'Phase 15. Raises on the promise being taken, not on its being kept or broken — that verdict is derived from the payments and changes without any event to hang a notification on.';

revoke all on function public.notify_promise_recorded() from public, anon, authenticated;

create trigger notify_promise_recorded
  after insert on public.loan_recovery_actions
  for each row execute function public.notify_promise_recorded();

-- ---------------------------------------------------------------------------
-- Security sold
-- ---------------------------------------------------------------------------

create or replace function public.notify_collateral_realised()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_loan text;
  v_branch uuid;
begin
  select l.loan_number, l.branch_id into v_loan, v_branch
    from public.loans l where l.id = new.loan_id;

  perform public.raise_notification(
    'collateral_realised', 'urgent',
    pg_catalog.format('Security on %s was sold', coalesce(v_loan, 'a loan')),
    pg_catalog.format('%s fetched UGX %s. Post the proceeds as a payment if that has not been done.',
      new.description,
      pg_catalog.to_char(coalesce(new.realised_amount, 0), 'FM999,999,999,999')),
    'collateral:view', 'loan', new.loan_id,
    pg_catalog.format('collateral:%s:realised', new.id),
    null, v_branch
  );

  return null;
end;
$$;

comment on function public.notify_collateral_realised() is
  'Phase 15. Says in the body that the proceeds reach the loan as a payment, because the sale and the receipt are two events and a staff member who believes otherwise will not post the second.';

revoke all on function public.notify_collateral_realised() from public, anon, authenticated;

create trigger notify_collateral_realised
  after update on public.loan_collateral
  for each row
  when (new.status = 'realised' and old.status is distinct from 'realised')
  execute function public.notify_collateral_realised();

-- ---------------------------------------------------------------------------
-- A guarantor let out
--
-- Raised from inside `release_loan_guarantor` rather than by a trigger. The
-- function already holds the decision, the capability check and the audit
-- entry; a trigger on the column would have to re-derive which of the two
-- release paths it was looking at, and there is only one path.
-- ---------------------------------------------------------------------------

create or replace function public.release_loan_guarantor(
  p_loan_guarantor_id uuid,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.loan_guarantors;
  v_loan public.loans;
  v_remaining integer;
  v_required integer;
  v_name text;
begin
  if p_reason is null or pg_catalog.btrim(p_reason) = '' then
    raise exception 'Releasing a guarantor requires a reason.'
      using errcode = 'P0001';
  end if;

  if auth.uid() is not null and not public.user_has_permission('guarantors:release') then
    raise exception 'Releasing a guarantor requires the guarantors:release capability.'
      using errcode = 'P0001';
  end if;

  select * into v_row
    from public.loan_guarantors
   where id = p_loan_guarantor_id
     for update;

  if not found then
    raise exception 'No such guarantee.' using errcode = 'P0001';
  end if;

  if v_row.released_at is not null then
    raise exception 'This guarantee was already released.' using errcode = 'P0001';
  end if;

  select * into v_loan from public.loans where id = v_row.loan_id;

  -- A draft's guarantors are removed, not released: nothing has been promised
  -- to anybody yet, and a release row on an application that never became a
  -- loan is noise in the register.
  if v_loan.status in ('draft', 'pending_approval', 'approved') then
    raise exception
      'This loan has not been disbursed. Remove the guarantor from the application instead.'
      using errcode = 'P0001';
  end if;

  -- Where the loan is over, the guarantee ended with it and the register
  -- already says so. Stamping a discretionary release on top would invent a
  -- decision nobody made.
  if v_loan.status in ('cleared', 'cancelled') then
    raise exception
      'This guarantee ended when the loan was %. There is nothing to release.',
      v_loan.status using errcode = 'P0001';
  end if;

  -- A live loan must keep the cover its product requires. Releasing the last
  -- guarantor of a loan that needs two is not a release, it is leaving the
  -- business unsecured, and it should be refused rather than warned about.
  select p.min_guarantors into v_required
    from public.loan_products p
   where p.id = v_loan.loan_product_id;

  select pg_catalog.count(*)::integer into v_remaining
    from public.loan_guarantors g
   where g.loan_id = v_row.loan_id
     and g.id <> v_row.id
     and g.released_at is null;

  if v_remaining < coalesce(v_required, 0) then
    raise exception
      'This loan requires % guarantor(s) and would be left with %. Attach a replacement before releasing this one.',
      v_required, v_remaining using errcode = 'P0001';
  end if;

  perform pg_catalog.set_config('lending.releasing_guarantee', 'on', true);

  update public.loan_guarantors
     set released_at = pg_catalog.now(),
         released_by = public.current_profile_id(),
         release_reason = pg_catalog.btrim(p_reason)
   where id = p_loan_guarantor_id;

  perform pg_catalog.set_config('lending.releasing_guarantee', 'off', true);

  insert into public.audit_log (
    actor_profile_id, actor_auth_user_id, actor_label,
    action, entity_type, entity_id, new_values
  )
  values (
    public.current_profile_id(), auth.uid(), public.audit_actor_label(),
    'loan.guarantor_released', 'loan', v_row.loan_id::text,
    pg_catalog.jsonb_build_object(
      'loan_guarantor_id', p_loan_guarantor_id,
      'reason', pg_catalog.btrim(p_reason),
      'guarantors_remaining', v_remaining
    )
  );

  -- Phase 15. The guarantor is a person who is not the borrower and who was
  -- told they are out; the business should be able to see that decision
  -- without going looking for it.
  v_name := coalesce(
    v_row.snapshot_full_name,
    (select c.full_name from public.clients c where c.id = v_row.guarantor_client_id),
    (select g.full_name from public.guarantors g where g.id = v_row.guarantor_id),
    'A guarantor'
  );

  perform public.raise_notification(
    'guarantor_released', 'attention',
    pg_catalog.format('%s was released from %s', v_name, v_loan.loan_number),
    pg_catalog.btrim(p_reason),
    'guarantors:view', 'loan', v_row.loan_id,
    pg_catalog.format('guarantee:%s:released', p_loan_guarantor_id),
    null, v_loan.branch_id
  );

  return p_loan_guarantor_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Money movements awaiting a decision, and a count that did not balance
-- ---------------------------------------------------------------------------

create or replace function public.notify_transfer_pending()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_from text;
  v_to text;
begin
  select a.name into v_from from public.ledger_accounts a where a.id = new.from_account_id;
  select a.name into v_to from public.ledger_accounts a where a.id = new.to_account_id;

  perform public.raise_notification(
    'approval_pending', 'attention',
    pg_catalog.format('%s is awaiting approval', new.transfer_number),
    pg_catalog.format('UGX %s from %s to %s.',
      pg_catalog.to_char(new.amount, 'FM999,999,999,999'),
      coalesce(v_from, 'an account'), coalesce(v_to, 'an account')),
    'transfers:approve', 'transfer', new.id,
    pg_catalog.format('transfer:%s:pending', new.id),
    null, new.branch_id
  );

  return null;
end;
$$;

comment on function public.notify_transfer_pending() is
  'Phase 15. A transfer over the approval threshold waits for a decision; without this it waits until somebody opens the transfers screen.';

revoke all on function public.notify_transfer_pending() from public, anon, authenticated;

create trigger notify_transfer_pending
  after insert on public.account_transfers
  for each row
  when (new.status = 'pending_approval')
  execute function public.notify_transfer_pending();

create or replace function public.notify_expense_pending()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.raise_notification(
    'approval_pending', 'attention',
    pg_catalog.format('%s is awaiting approval', new.expense_number),
    pg_catalog.format('UGX %s — %s.',
      pg_catalog.to_char(new.amount, 'FM999,999,999,999'), new.description),
    'expenses:approve', 'expense', new.id,
    pg_catalog.format('expense:%s:pending', new.id),
    null, new.branch_id
  );

  return null;
end;
$$;

comment on function public.notify_expense_pending() is
  'Phase 15. The same for an expense over its threshold.';

revoke all on function public.notify_expense_pending() from public, anon, authenticated;

create trigger notify_expense_pending
  after insert on public.expenses
  for each row
  when (new.status = 'pending_approval')
  execute function public.notify_expense_pending();

create or replace function public.notify_reconciliation_variance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account text;
begin
  select a.name into v_account
    from public.ledger_accounts a where a.id = new.account_id;

  perform public.raise_notification(
    'reconciliation_variance',
    -- A count that balances needs no notification; one that does not is money
    -- unaccounted for, which is the most serious thing this system can say.
    case when new.variance = 0 then 'attention' else 'urgent' end,
    case
      when new.variance = 0 then
        pg_catalog.format('%s is awaiting review', new.reconciliation_number)
      else
        pg_catalog.format('%s does not balance: UGX %s',
          new.reconciliation_number,
          pg_catalog.to_char(new.variance, 'FM999,999,999,999'))
    end,
    pg_catalog.format('%s counted on %s. System UGX %s, counted UGX %s. %s',
      coalesce(v_account, 'An account'),
      pg_catalog.to_char(new.business_date, 'DD Mon YYYY'),
      pg_catalog.to_char(new.system_balance, 'FM999,999,999,999'),
      pg_catalog.to_char(new.counted_balance, 'FM999,999,999,999'),
      coalesce(new.explanation, 'No explanation was given.')),
    'reconciliation:approve', 'reconciliation', new.id,
    pg_catalog.format('reconciliation:%s:submitted', new.id),
    null, new.branch_id
  );

  return null;
end;
$$;

comment on function public.notify_reconciliation_variance() is
  'Phase 15. Urgent where the count did not balance, because money unaccounted for is the most serious thing this system can report; merely awaiting review is attention.';

revoke all on function public.notify_reconciliation_variance() from public, anon, authenticated;

create trigger notify_reconciliation_variance
  after insert on public.account_reconciliations
  for each row
  when (new.status = 'submitted')
  execute function public.notify_reconciliation_variance();

-- ---------------------------------------------------------------------------
-- A float running low
--
-- The one notification that is a *reading* rather than an event, and it is
-- pinned to an event anyway: a journal line moved a cash account. The dedupe
-- key carries the business date, so a branch that takes thirty payments on a
-- low float is told once that morning rather than thirty times.
--
-- Statement-level, over the transition table, so one entry's four lines cost
-- one pass over the distinct cash accounts they touched rather than four
-- balance sums.
-- ---------------------------------------------------------------------------

create or replace function public.notify_low_float()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row record;
  v_threshold bigint;
  v_balance bigint;
  v_date date;
begin
  v_date := public.business_date();

  for v_row in
    select distinct a.id, a.name, a.cash_kind, a.branch_id
      from inserted i
      join public.ledger_accounts a on a.id = i.account_id
     where a.cash_kind is not null
  loop
    select case v_row.cash_kind
             when 'cash_at_hand'     then s.low_balance_cash_at_hand
             when 'mtn_mobile_money' then s.low_balance_mtn_mobile_money
             when 'airtel_money'     then s.low_balance_airtel_money
             when 'bank'             then s.low_balance_bank
           end
      into v_threshold
      from public.finance_settings s
     limit 1;

    if v_threshold is null then
      continue;
    end if;

    select b.balance into v_balance
      from public.ledger_account_balances b
     where b.account_id = v_row.id;

    if coalesce(v_balance, 0) <= v_threshold then
      perform public.raise_notification(
        'low_float', 'attention',
        pg_catalog.format('%s is low', v_row.name),
        pg_catalog.format('UGX %s left, against a floor of UGX %s.',
          pg_catalog.to_char(coalesce(v_balance, 0), 'FM999,999,999,999'),
          pg_catalog.to_char(v_threshold, 'FM999,999,999,999')),
        'ledger:view', 'ledger_account', v_row.id,
        -- Once per account per business day. Nothing enforces a floor — a
        -- float running low is a thing to know about rather than a thing to
        -- refuse, as Phase 11 put it — so the notification is the whole
        -- mechanism and it must not become noise.
        pg_catalog.format('float:%s:%s', v_row.id, v_date),
        null, v_row.branch_id
      );
    end if;
  end loop;

  return null;
end;
$$;

comment on function public.notify_low_float() is
  'Phase 15. Reads the four thresholds Phase 11 left for it and raises once per account per business day. Statement-level over the transition table, so an entry''s lines cost one pass rather than one balance sum each.';

revoke all on function public.notify_low_float() from public, anon, authenticated;

create trigger notify_low_float
  after insert on public.journal_lines
  referencing new table as inserted
  for each statement execute function public.notify_low_float();

-- ---------------------------------------------------------------------------
-- A borrower blacklisted
-- ---------------------------------------------------------------------------

create or replace function public.notify_client_blacklisted()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.raise_notification(
    'client_blacklisted', 'urgent',
    pg_catalog.format('%s has been blacklisted', new.full_name),
    pg_catalog.format('%s. %s cannot be approved for a further loan while this stands.',
      coalesce(new.status_reason, 'No reason was recorded.'),
      new.client_number),
    'clients:view', 'client', new.id,
    pg_catalog.format('client:%s:blacklisted:%s', new.id, new.updated_at),
    null, new.branch_id
  );

  return null;
end;
$$;

comment on function public.notify_client_blacklisted() is
  'Phase 15. The one client-status change that stops future lending, so it is the one that is notified. The dedupe key carries `updated_at`, so a borrower blacklisted, reinstated and blacklisted again raises twice — which is right, because it happened twice.';

revoke all on function public.notify_client_blacklisted() from public, anon, authenticated;

create trigger notify_client_blacklisted
  after update on public.clients
  for each row
  when (new.status = 'blacklisted' and old.status is distinct from 'blacklisted')
  execute function public.notify_client_blacklisted();
