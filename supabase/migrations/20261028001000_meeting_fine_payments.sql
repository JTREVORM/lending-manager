-- ===========================================================================
-- Polytos business-policy update — collecting, cancelling and reversing a
-- meeting fine
-- ===========================================================================
--
-- Three different things, and keeping them apart is most of the design:
--
--   **Collecting.** Money arrives. Dr the receiving account, Cr 4400 Meeting
--   Fine Income. This is the only point at which the General Ledger learns
--   that a fine exists, which is the convention loan penalties already set.
--
--   **Cancelling.** The charge should never have been made — the register was
--   wrong, the member had reported in advance and the message was lost. The
--   charge goes away with a reason and a name against it. Only possible while
--   nothing has been collected: if money has changed hands, the thing to undo
--   is the payment.
--
--   **Reversing a payment.** Money is given back, or was never really
--   received. A reversing journal entry, never a deletion, and the fine
--   returns to outstanding.
--
-- Collapsing the last two would be the mistake. "Cancel" on a paid fine would
-- either silently keep the member's money or silently alter the cash position
-- — and whichever it did, the books and the member would disagree.
--
-- ## Partial collection
--
-- Supported, deliberately. A member who comes with UGX 3,000 of a UGX 5,000
-- fine is paying what they have, and a system that refused it would be a
-- system that turned money away and left more outstanding than before. The
-- fine stays `outstanding` until the whole amount is in.
--
-- What is **not** here, because the client has not said it: a due date, any
-- interest or escalation on an unpaid fine, any automatic deduction from
-- savings or from a loan disbursement, and any consequence of leaving one
-- unpaid. Each is recorded as an open question rather than invented.
-- ===========================================================================

insert into public.reference_formats (scope, prefix, padding, description)
values ('meeting_fine_payment', 'FP', 5,
        'A payment collected against a meeting absence fine.')
on conflict (scope) do nothing;

create table public.meeting_fine_payments (
  id                 uuid primary key default gen_random_uuid(),
  payment_number     text not null,

  fine_id            uuid not null references public.meeting_fines(id)
                       on delete restrict,
  fine_number        text not null,
  membership_id      uuid not null references public.memberships(id)
                       on delete restrict,
  client_id          uuid not null references public.clients(id) on delete restrict,
  branch_id          uuid not null references public.branches(id) on delete restrict,

  amount             bigint not null,
  payment_method     text not null,
  cash_account_id    uuid not null references public.ledger_accounts(id)
                       on delete restrict,
  income_account_id  uuid not null references public.ledger_accounts(id)
                       on delete restrict,
  external_reference text,

  idempotency_key    uuid not null,
  value_date         date not null,
  journal_entry_id   uuid not null references public.journal_entries(id)
                       on delete restrict,

  status             text not null default 'posted',
  received_by        uuid references public.profiles(id) on delete set null,
  received_by_label  text not null,

  reversed_at        timestamptz,
  reversed_by        uuid references public.profiles(id) on delete set null,
  reversed_by_label  text,
  reversal_reason    text,
  reversal_entry_id  uuid references public.journal_entries(id) on delete restrict,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint meeting_fine_payment_amount_positive
    check (amount > 0 and amount <= 10000000),
  constraint meeting_fine_payment_method_valid
    check (payment_method in ('cash', 'mtn_mobile_money', 'airtel_money', 'bank')),
  constraint meeting_fine_payment_status_valid
    check (status in ('posted', 'reversed')),
  constraint meeting_fine_payment_reversal_coherent
    check (
      (status = 'reversed')
        = (reversed_at is not null and reversal_reason is not null
           and reversal_entry_id is not null)
    ),
  constraint meeting_fine_payment_reversal_reason_length
    check (reversal_reason is null
           or char_length(btrim(reversal_reason)) between 3 and 1000),
  -- The same rule the rest of the system applies: cash carries no network
  -- reference, and everything else must.
  constraint meeting_fine_payment_reference_shape
    check (
      case payment_method
        when 'cash' then external_reference is null
        else external_reference is not null
             and char_length(btrim(external_reference)) >= 4
      end
    )
);

comment on table public.meeting_fine_payments is
  'Polytos policy update, rule 15. Money collected against a meeting absence fine. The only point at which a fine reaches the General Ledger: Dr the receiving account, Cr 4400 Meeting Fine Income. Reversed by a reversing entry, never by deletion.';

create unique index meeting_fine_payment_number_unique
  on public.meeting_fine_payments (payment_number);

create unique index meeting_fine_payment_idempotency_unique
  on public.meeting_fine_payments (idempotency_key);

create index meeting_fine_payment_fine_idx
  on public.meeting_fine_payments (fine_id, value_date desc);

create index meeting_fine_payment_branch_idx
  on public.meeting_fine_payments (branch_id, value_date desc);

create trigger meeting_fine_payments_set_updated_at
  before update on public.meeting_fine_payments
  for each row execute function public.set_updated_at();

create trigger meeting_fine_payments_no_delete
  before delete on public.meeting_fine_payments
  for each row execute function public.reject_mutation();

create or replace function public.meeting_fine_payments_assign_number()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.payment_number := public.next_reference('meeting_fine_payment');
  return new;
end;
$$;

create trigger meeting_fine_payments_assign_number
  before insert on public.meeting_fine_payments
  for each row execute function public.meeting_fine_payments_assign_number();

create or replace function public.meeting_fine_payments_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
     or new.payment_number is distinct from old.payment_number
     or new.fine_id is distinct from old.fine_id
     or new.amount is distinct from old.amount
     or new.payment_method is distinct from old.payment_method
     or new.cash_account_id is distinct from old.cash_account_id
     or new.income_account_id is distinct from old.income_account_id
     or new.journal_entry_id is distinct from old.journal_entry_id
     or new.idempotency_key is distinct from old.idempotency_key
     or new.value_date is distinct from old.value_date
     or new.received_by_label is distinct from old.received_by_label then
    raise exception
      'A collected payment is what it is. Correcting one is a reversal, which posts its own entry.'
      using errcode = 'P0001';
  end if;

  if old.status = 'reversed' then
    raise exception
      'Payment % has already been reversed.', old.payment_number
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

create trigger meeting_fine_payments_guard
  before update on public.meeting_fine_payments
  for each row execute function public.meeting_fine_payments_guard();

-- ---------------------------------------------------------------------------
-- Collecting
-- ---------------------------------------------------------------------------

create or replace function public.post_meeting_fine_payment(
  p_fine_id uuid,
  p_amount bigint,
  p_payment_method text,
  p_external_reference text,
  p_idempotency_key uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fine      public.meeting_fines;
  v_actor     uuid;
  v_label     text;
  v_reference text;
  v_payment_id uuid;
  v_cash      uuid;
  v_income    uuid;
  v_entry_id  uuid;
  v_date      date;
  v_remaining bigint;
begin
  v_actor := public.current_profile_id();
  v_label := public.audit_actor_label();

  -- Authorisation above the replay shortcut: the early return reads a payment
  -- record, so it sits behind the check that decides whether this caller may
  -- see one.
  if v_actor is null and auth.uid() is not null then
    raise exception
      'A fine payment must be received by a signed-in member of staff.'
      using errcode = 'P0001';
  end if;

  if auth.uid() is not null and not public.user_has_permission('fines:collect') then
    raise exception
      'Recording a fine payment requires the fines:collect capability.'
      using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('meeting_fine_payment_key:' || p_idempotency_key::text)
  );

  select id into v_payment_id
  from public.meeting_fine_payments where idempotency_key = p_idempotency_key;

  if v_payment_id is not null then
    return v_payment_id;
  end if;

  select * into v_fine from public.meeting_fines where id = p_fine_id for update;

  if not found then
    raise exception 'No such fine.' using errcode = 'P0001';
  end if;

  if not public.user_can_see_branch(v_fine.branch_id) then
    raise exception 'You cannot collect that branch''s fines.' using errcode = '42501';
  end if;

  if v_fine.status = 'cancelled' then
    raise exception
      'Fine % was cancelled. There is nothing to collect.',
      v_fine.fine_number using errcode = 'P0001';
  end if;

  v_remaining := v_fine.amount - v_fine.amount_paid;

  if v_remaining <= 0 then
    raise exception
      'Fine % is settled in full. A second collection would be the member paying twice.',
      v_fine.fine_number using errcode = 'P0001';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'A payment must be more than zero shillings.'
      using errcode = 'P0001';
  end if;

  if p_amount > v_remaining then
    raise exception
      'Fine % has % shillings outstanding. A payment of % would collect more than is owed.',
      v_fine.fine_number, v_remaining, p_amount using errcode = 'P0001';
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
        'A cash payment has no network reference. Its payment number is its reference.'
        using errcode = 'P0001';
    end if;
  elsif v_reference is null then
    raise exception
      'A % payment needs the reference from the network or the bank.',
      p_payment_method using errcode = 'P0001';
  elsif char_length(v_reference) < 4 then
    raise exception
      'That transaction reference is too short to identify a payment.'
      using errcode = 'P0001';
  end if;

  v_cash := public.branch_cash_account(
    v_fine.branch_id, public.payment_method_cash_kind(p_payment_method));
  v_income := public.ledger_account_by_code('4400');

  if v_income is null then
    raise exception 'There is no meeting fine income account.' using errcode = 'P0001';
  end if;

  v_date := public.business_date();
  v_payment_id := pg_catalog.gen_random_uuid();

  -- The one entry a fine ever produces. Recognised on receipt, as 4200
  -- Penalty Income is: an assessed fine is a charge, not income.
  v_entry_id := public.post_journal(
    v_fine.branch_id,
    v_date,
    'Meeting fine — ' || v_fine.fine_number || ' (' || v_fine.meeting_number || ')',
    'other_income',
    v_payment_id,
    null,
    v_fine.client_id,
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'account_id', v_cash,
        'debit', p_amount, 'credit', 0,
        'memo', 'Fine received by ' || p_payment_method),
      pg_catalog.jsonb_build_object(
        'account_id', v_income,
        'debit', 0, 'credit', p_amount,
        'memo', 'Meeting fine — ' || v_fine.fine_number)
    ),
    null, v_actor, v_label
  );

  insert into public.meeting_fine_payments (
    id, payment_number, fine_id, fine_number,
    membership_id, client_id, branch_id,
    amount, payment_method, cash_account_id, income_account_id,
    external_reference, idempotency_key, value_date, journal_entry_id,
    received_by, received_by_label
  )
  values (
    v_payment_id, 'FP000000', p_fine_id, v_fine.fine_number,
    v_fine.membership_id, v_fine.client_id, v_fine.branch_id,
    p_amount, p_payment_method, v_cash, v_income,
    v_reference, p_idempotency_key, v_date, v_entry_id,
    v_actor, v_label
  );

  update public.meeting_fines
     set amount_paid = amount_paid + p_amount,
         status = case
           when amount_paid + p_amount >= amount then 'paid'
           else 'outstanding'
         end
   where id = p_fine_id;

  return v_payment_id;
end;
$$;

comment on function public.post_meeting_fine_payment(uuid, bigint, text, text, uuid) is
  'Polytos policy update, rule 15. Collects money against a meeting fine: Dr the receiving account, Cr 4400 Meeting Fine Income, in one atomic transaction with the fine''s own balance. Idempotent on the key, so a retried request collects once. Partial payment is accepted — a member paying what they have is money the business would otherwise turn away.';

grant execute on function
  public.post_meeting_fine_payment(uuid, bigint, text, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Cancelling a charge that should not have been made
-- ---------------------------------------------------------------------------

create or replace function public.cancel_meeting_fine(
  p_fine_id uuid,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fine  public.meeting_fines;
  v_actor uuid;
  v_label text;
begin
  v_actor := public.current_profile_id();
  v_label := public.audit_actor_label();

  if v_actor is null and auth.uid() is not null then
    raise exception
      'A fine must be cancelled by a signed-in member of staff.'
      using errcode = 'P0001';
  end if;

  if auth.uid() is not null and not public.user_has_permission('fines:reverse') then
    raise exception
      'Cancelling a fine requires the fines:reverse capability. Charging one and making it disappear are not the same act.'
      using errcode = '42501';
  end if;

  if coalesce(pg_catalog.btrim(coalesce(p_reason, '')), '') = '' then
    raise exception
      'Say why this charge should not have been made. A cancellation with no reason is a charge that vanished.'
      using errcode = 'P0001';
  end if;

  select * into v_fine from public.meeting_fines where id = p_fine_id for update;

  if not found then
    raise exception 'No such fine.' using errcode = 'P0001';
  end if;

  if not public.user_can_see_branch(v_fine.branch_id) then
    raise exception 'You cannot cancel that branch''s fines.' using errcode = '42501';
  end if;

  if v_fine.status = 'cancelled' then
    return p_fine_id;
  end if;

  -- Money has changed hands. Cancelling the charge now would either keep the
  -- member's money with nothing owed against it, or imply a refund that never
  -- happened. Reverse the payment first; then the charge can be cancelled.
  if v_fine.amount_paid > 0 then
    raise exception
      'Fine % has % shillings collected against it. Reverse the payment first — cancelling a charge that has been paid would leave the books and the member disagreeing about whose money it is.',
      v_fine.fine_number, v_fine.amount_paid using errcode = 'P0001';
  end if;

  update public.meeting_fines
     set status = 'cancelled',
         cancelled_at = pg_catalog.now(),
         cancelled_by = v_actor,
         cancelled_by_label = v_label,
         cancellation_reason = pg_catalog.btrim(p_reason)
   where id = p_fine_id;

  return p_fine_id;
end;
$$;

comment on function public.cancel_meeting_fine(uuid, text) is
  'Polytos policy update, rule 15. Cancels a charge that should not have been made — a wrong register, a lost advance notice — with a reason and a name against it. Never deletes: the row stays and says it was cancelled, by whom and why. Refuses while money has been collected, because that is a payment to reverse rather than a charge to cancel.';

grant execute on function public.cancel_meeting_fine(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Reversing money that was collected
-- ---------------------------------------------------------------------------

create or replace function public.reverse_meeting_fine_payment(
  p_payment_id uuid,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
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
         reversed_at = pg_catalog.now(),
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
$$;

comment on function public.reverse_meeting_fine_payment(uuid, text) is
  'Polytos policy update, rule 15. Reverses a collected fine payment with a mirrored journal entry and returns the fine to outstanding. The original entry is never edited: the books say money came in and went back out, because that is what happened. Undoing the collection is not the same as deciding the charge was wrong — that is a cancellation.';

grant execute on function public.reverse_meeting_fine_payment(uuid, text) to authenticated;


-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
--
-- PostgreSQL grants EXECUTE on a new function to PUBLIC, and a table created
-- in a schema `anon` can reach is reachable unless the grant is taken away.
-- Both defaults are wrong here: every table in this file is written only
-- through a SECURITY DEFINER function, and every function in it decides
-- something about money or about who may read a record.
--
-- The functions a session legitimately calls are granted back to
-- `authenticated` where they are defined. Triggers, numbering helpers and
-- notification hooks are granted back to nobody: they are called by the
-- database, and a session that could call one directly would be writing a
-- row the function assumes was validated elsewhere.

revoke all on table public.meeting_fine_payments from anon, authenticated;
revoke all on function public.meeting_fine_payments_assign_number() from public, anon, authenticated;
revoke all on function public.meeting_fine_payments_guard() from public, anon, authenticated;
revoke all on function public.post_meeting_fine_payment(uuid, bigint, text, text, uuid) from public, anon;
revoke all on function public.cancel_meeting_fine(uuid, text) from public, anon;
revoke all on function public.reverse_meeting_fine_payment(uuid, text) from public, anon;
