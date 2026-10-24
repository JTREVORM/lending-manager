-- ===========================================================================
-- Polytos Phase 2.7 — withdrawals: requested, decided, then paid
--
-- ## Three acts, three capabilities, and one person cannot be two of them
--
-- A deposit needs no second opinion — the money is arriving. A withdrawal is
-- money leaving on somebody's judgement, so it is three steps:
--
--   request   `savings:request_withdrawal`   the counter, with the member there
--   decide    `savings:approve_withdrawal`   a Manager or the Owner
--   pay       `savings:post_withdrawal`      the ledger moves
--
-- The decision function refuses a decision from the person who made the
-- request, which is the control that makes the split real: a Manager holds
-- both capabilities, so separating them without that refusal would be a
-- control that exists only on the permissions page. It is the same refusal
-- `record_transfer` and `record_expense` already apply to their own
-- approvals.
--
-- Approving and paying *may* be the same person. That is deliberate: at a
-- branch with one Manager, requiring a third human would stop members being
-- paid, and the signature that matters — somebody other than the preparer
-- decided this — has already been taken.
--
-- ## The balance is checked twice, and the second time is the one that counts
--
-- At request time, so the counter is not promising money that is not there.
-- At posting time, under `select ... for update` on the savings account, so
-- two approved requests cannot both read the same balance and both spend it.
-- Between the two, a deposit may arrive or another withdrawal may be paid;
-- only the posting check is holding a lock, so only the posting check can be
-- relied on.
--
-- ## The active-loan rule is the client's, not ours
--
-- `savings_withdrawal_with_active_loan` is one of the nine. Savings do not
-- open at all until it is decided — `membership_policy_allows(v,'savings')`
-- requires it — so by the time a withdrawal is possible the rule exists:
--
--   `allowed`        withdraw freely
--   `blocked`        no withdrawal while a member loan is live
--   `above_pledged`  only the excess over what secures the loan
--
-- The third needs a definition of "what secures the loan" that the client's
-- documents do not give, and which depends on the savings-to-loan multiplier
-- — itself undecided. So under `above_pledged` a member with a live loan is
-- **refused, with that said plainly**, rather than having a pledged amount
-- invented for them. A member with no live loan is unaffected.
-- ===========================================================================

create table public.savings_withdrawal_requests (
  id uuid primary key default gen_random_uuid(),

  request_number text not null unique,

  savings_account_id uuid not null
    references public.savings_accounts(id) on delete restrict,
  membership_id uuid not null references public.memberships(id) on delete restrict,
  client_id uuid not null references public.clients(id) on delete restrict,
  branch_id uuid not null references public.branches(id) on delete restrict,
  policy_version_id uuid not null
    references public.membership_policy_versions(id) on delete restrict,

  amount bigint not null,
  reason text not null,

  status text not null default 'pending',

  -- What the account held when the request was taken. Kept because the
  -- decision was made against this figure, and a reviewer reading the record
  -- later should see what the decider saw rather than today's balance.
  balance_at_request bigint not null,

  requested_by uuid references public.profiles(id) on delete set null,
  requested_by_label text not null default 'system',
  requested_at timestamptz not null default pg_catalog.now(),
  business_date date not null,

  decided_by uuid references public.profiles(id) on delete set null,
  decided_by_label text,
  decided_at timestamptz,
  decision_notes text,

  -- The transaction that paid it. Set by `post_savings_withdrawal`.
  paid_transaction_id uuid references public.savings_transactions(id) on delete restrict,
  paid_at timestamptz,

  cancelled_at timestamptz,
  cancellation_reason text,

  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),

  constraint savings_withdrawal_number_shape
    check (request_number ~ '^WD[0-9]{7,}$'),
  constraint savings_withdrawal_status_valid
    check (status in ('pending', 'approved', 'rejected', 'paid', 'cancelled')),
  constraint savings_withdrawal_amount_positive
    check (amount > 0 and amount <= 1000000000000),
  constraint savings_withdrawal_balance_not_negative
    check (balance_at_request >= 0),
  constraint savings_withdrawal_reason_length
    check (char_length(btrim(reason)) between 4 and 500),
  constraint savings_withdrawal_decision_notes_length
    check (decision_notes is null or char_length(decision_notes) <= 500),
  -- A decision is attributed and dated, or it has not happened.
  constraint savings_withdrawal_decision_complete
    check (
      (status in ('approved', 'rejected', 'paid'))
      = (decided_at is not null and decided_by_label is not null)
    ),
  -- A rejection says why.
  constraint savings_withdrawal_rejection_has_notes
    check (status <> 'rejected'
           or (decision_notes is not null and btrim(decision_notes) <> '')),
  constraint savings_withdrawal_paid_has_transaction
    check ((status = 'paid') = (paid_transaction_id is not null)),
  constraint savings_withdrawal_paid_has_time
    check ((status = 'paid') = (paid_at is not null)),
  constraint savings_withdrawal_cancelled_complete
    check (
      (status = 'cancelled')
      = (cancelled_at is not null and cancellation_reason is not null)
    ),
  constraint savings_withdrawal_cancellation_reason_length
    check (cancellation_reason is null
           or char_length(btrim(cancellation_reason)) between 4 and 500)
);

comment on table public.savings_withdrawal_requests is
  'Polytos Phase 2. A request to take money out of a savings account: prepared by the counter, decided by a supervisor who is not the preparer, then paid. The balance is re-checked under lock at payment, because that is the only check holding one.';

-- One live request per account. A second while the first is undecided or
-- unpaid would let two requests spend the same balance between them.
create unique index savings_withdrawal_requests_one_live_per_account
  on public.savings_withdrawal_requests (savings_account_id)
  where status in ('pending', 'approved');

create index savings_withdrawal_requests_status_idx
  on public.savings_withdrawal_requests (status, requested_at desc);
create index savings_withdrawal_requests_account_idx
  on public.savings_withdrawal_requests (savings_account_id, requested_at desc);
create index savings_withdrawal_requests_branch_idx
  on public.savings_withdrawal_requests (branch_id, business_date desc);
create index savings_withdrawal_requests_client_idx
  on public.savings_withdrawal_requests (client_id);

create trigger savings_withdrawal_requests_set_updated_at
  before update on public.savings_withdrawal_requests
  for each row execute function public.set_updated_at();

-- Now that the table exists, the subledger's pointer to it can be a real
-- foreign key rather than a bare uuid.
alter table public.savings_transactions
  add constraint savings_transactions_withdrawal_request_fk
    foreign key (withdrawal_request_id)
    references public.savings_withdrawal_requests(id) on delete restrict;

create or replace function public.savings_withdrawal_requests_assign_number()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.request_number is not null then
    raise exception
      'A withdrawal request number is assigned by the database, not by the caller.'
      using errcode = 'P0001';
  end if;

  new.request_number := public.next_reference('savings_withdrawal');
  return new;
end;
$$;

create trigger savings_withdrawal_requests_assign_number
  before insert on public.savings_withdrawal_requests
  for each row execute function public.savings_withdrawal_requests_assign_number();

revoke all on function public.savings_withdrawal_requests_assign_number()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The request's own lifecycle
--
--   pending   -> approved, rejected, cancelled
--   approved  -> paid, cancelled
--   rejected / paid / cancelled   terminal
--
-- Binding on every caller, above the trusted-path exemption: a request that
-- went from `rejected` back to `pending` would be a decision somebody made
-- being quietly undone.
-- ---------------------------------------------------------------------------

create or replace function public.savings_withdrawal_requests_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_allowed text[];
begin
  if new.id is distinct from old.id
     or new.request_number is distinct from old.request_number
     or new.savings_account_id is distinct from old.savings_account_id
     or new.membership_id is distinct from old.membership_id
     or new.client_id is distinct from old.client_id
     or new.branch_id is distinct from old.branch_id
     or new.policy_version_id is distinct from old.policy_version_id
     or new.amount is distinct from old.amount
     or new.reason is distinct from old.reason
     or new.balance_at_request is distinct from old.balance_at_request
     or new.requested_at is distinct from old.requested_at
     or new.business_date is distinct from old.business_date
     or new.created_at is distinct from old.created_at then
    raise exception
      'A withdrawal request records what was asked for. It is decided, not rewritten.'
      using errcode = 'P0001';
  end if;

  if new.status is distinct from old.status then
    v_allowed := case old.status
      when 'pending'  then array['approved', 'rejected', 'cancelled']
      when 'approved' then array['paid', 'cancelled']
      else array[]::text[]
    end;

    if not (new.status = any (v_allowed)) then
      raise exception
        'A withdrawal request cannot move from % to %.', old.status, new.status
        using errcode = 'P0001';
    end if;
  end if;

  -- A decision, once made, is not re-made.
  if old.decided_at is not null
     and (new.decided_at is distinct from old.decided_at
          or new.decided_by_label is distinct from old.decided_by_label) then
    raise exception
      'Withdrawal request % has already been decided.', old.request_number
      using errcode = 'P0001';
  end if;

  if auth.uid() is null then
    return new;
  end if;

  if new.requested_by is distinct from old.requested_by
     or new.requested_by_label is distinct from old.requested_by_label then
    raise exception 'A withdrawal request''s provenance cannot be rewritten.'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

create trigger savings_withdrawal_requests_guard
  before update on public.savings_withdrawal_requests
  for each row execute function public.savings_withdrawal_requests_guard();

create trigger savings_withdrawal_requests_no_delete
  before delete on public.savings_withdrawal_requests
  for each statement execute function public.reject_mutation();

revoke all on function public.savings_withdrawal_requests_guard()
  from public, anon, authenticated;

-- ===========================================================================
-- Does this member hold a live loan?
--
-- One definition, used by the policy rule below and available to Phase 3.
-- `active` is the only status in which money is outstanding: a draft, a
-- pending application and an approved-but-undisbursed loan have had nothing
-- paid out, and a cleared or cancelled one owes nothing.
-- ===========================================================================

create or replace function public.client_has_live_loan(p_client_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.loans l
    where l.client_id = p_client_id and l.status = 'active'
  );
$$;

comment on function public.client_has_live_loan(uuid) is
  'Polytos Phase 2. Whether this client holds a loan with money outstanding. The single definition the savings withdrawal rule is written against.';

revoke all on function public.client_has_live_loan(uuid) from public, anon;
grant execute on function public.client_has_live_loan(uuid) to authenticated;

-- ===========================================================================
-- request_savings_withdrawal()
-- ===========================================================================

create or replace function public.request_savings_withdrawal(
  p_savings_account_id uuid,
  p_amount bigint,
  p_reason text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_account    public.savings_accounts;
  v_membership public.memberships;
  v_policy     public.membership_policy_versions;
  v_actor      uuid;
  v_balance    bigint;
  v_request_id uuid;
begin
  v_actor := public.current_profile_id();

  if v_actor is null and auth.uid() is not null then
    raise exception
      'A withdrawal request must be prepared by a signed-in member of staff.'
      using errcode = 'P0001';
  end if;

  if auth.uid() is not null
     and not public.user_has_permission('savings:request_withdrawal') then
    raise exception
      'Preparing a withdrawal requires the savings:request_withdrawal capability.'
      using errcode = 'P0001';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'A withdrawal must be more than zero shillings.'
      using errcode = 'P0001';
  end if;

  select * into v_account
  from public.savings_accounts where id = p_savings_account_id for update;

  if not found then
    raise exception 'No such savings account.' using errcode = 'P0001';
  end if;

  if v_account.status <> 'active' then
    raise exception
      'Savings account % is %. A withdrawal needs an active account.',
      v_account.account_number, v_account.status using errcode = 'P0001';
  end if;

  select * into v_membership
  from public.memberships where id = v_account.membership_id;

  if v_membership.status <> 'active' then
    raise exception
      'Membership % is %. A withdrawal needs an active membership.',
      v_membership.membership_number, v_membership.status using errcode = 'P0001';
  end if;

  if not public.membership_policy_allows(v_account.policy_version_id, 'savings') then
    raise exception
      'Savings are not open under the policy version governing this account.'
      using errcode = 'P0001';
  end if;

  select * into v_policy
  from public.membership_policy_versions where id = v_account.policy_version_id;

  -- --- The client's rule about live loans ---------------------------------
  if public.client_has_live_loan(v_account.client_id) then
    if v_policy.savings_withdrawal_with_active_loan = 'blocked' then
      raise exception
        'This member holds a live loan, and the membership policy blocks withdrawals while a loan is running.'
        using errcode = 'P0001';
    elsif v_policy.savings_withdrawal_with_active_loan = 'above_pledged' then
      -- Refused rather than guessed. "The excess over what secures the loan"
      -- needs a definition of the pledged amount that the client's documents
      -- do not give, and which depends on the savings-to-loan multiplier that
      -- is itself undecided. Inventing one here would be inventing the
      -- member's security.
      raise exception
        'The membership policy allows withdrawing only the excess over what secures a live loan, and how much that is has not been defined. Settle the savings-to-loan rule before withdrawing against a live loan.'
        using errcode = 'P0001';
    end if;
  end if;

  select coalesce(sum(signed_amount), 0)::bigint into v_balance
  from public.savings_transactions
  where savings_account_id = p_savings_account_id;

  if p_amount > v_balance then
    raise exception
      'Savings account % holds % shillings. A withdrawal of % cannot be prepared.',
      v_account.account_number, v_balance, p_amount
      using errcode = 'P0001';
  end if;

  insert into public.savings_withdrawal_requests (
    savings_account_id, membership_id, client_id, branch_id, policy_version_id,
    amount, reason, balance_at_request,
    requested_by, requested_by_label, business_date
  )
  values (
    p_savings_account_id, v_account.membership_id, v_account.client_id,
    v_account.branch_id, v_account.policy_version_id,
    p_amount, pg_catalog.btrim(p_reason), v_balance,
    v_actor, public.audit_actor_label(), public.business_date()
  )
  returning id into v_request_id;

  return v_request_id;
end;
$$;

comment on function public.request_savings_withdrawal(uuid, bigint, text) is
  'Polytos Phase 2. Prepares a withdrawal for review: checks the account, the membership, the policy''s live-loan rule and the balance. Decides nothing.';

revoke all on function public.request_savings_withdrawal(uuid, bigint, text) from public, anon;
grant execute on function public.request_savings_withdrawal(uuid, bigint, text) to authenticated;

-- ===========================================================================
-- decide_savings_withdrawal()
--
-- The refusal in here is the whole reason the capabilities are split.
-- ===========================================================================

create or replace function public.decide_savings_withdrawal(
  p_request_id uuid,
  p_approve boolean,
  p_notes text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
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
      using errcode = 'P0001';
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
$$;

comment on function public.decide_savings_withdrawal(uuid, boolean, text) is
  'Polytos Phase 2. Approves or rejects a prepared withdrawal. Refuses a decision from the person who prepared it, which is what makes the capability split a control rather than a label.';

revoke all on function public.decide_savings_withdrawal(uuid, boolean, text) from public, anon;
grant execute on function public.decide_savings_withdrawal(uuid, boolean, text) to authenticated;

-- ===========================================================================
-- post_savings_withdrawal()
--
--   Debit   2100 Member Savings      <- the liability falls
--   Credit  the branch's cash / MTN / Airtel / bank account
-- ===========================================================================

create or replace function public.post_savings_withdrawal(
  p_request_id uuid,
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
  v_request   public.savings_withdrawal_requests;
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

  -- The account lock. Everything below reads the balance, so it is taken
  -- before the balance is read and held until the transaction commits.
  select * into v_account
  from public.savings_accounts where id = v_request.savings_account_id for update;

  if v_account.status <> 'active' then
    raise exception
      'Savings account % is %.', v_account.account_number, v_account.status
      using errcode = 'P0001';
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
$$;

comment on function public.post_savings_withdrawal(uuid, text, text, uuid) is
  'Polytos Phase 2. Pays an approved withdrawal: debit 2100 Member Savings, credit the branch cash account. Re-checks the balance under a row lock on the account, because the request-time check was not holding one. Idempotent on p_idempotency_key.';

revoke all on function public.post_savings_withdrawal(uuid, text, text, uuid) from public, anon;
grant execute on function public.post_savings_withdrawal(uuid, text, text, uuid) to authenticated;

-- ===========================================================================
-- cancel_savings_withdrawal()
--
-- The member changed their mind, or the counter made a mistake. Available to
-- whoever may prepare one, because withdrawing a request is not a decision
-- about money — it is the absence of one.
-- ===========================================================================

create or replace function public.cancel_savings_withdrawal(
  p_request_id uuid,
  p_reason text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_request public.savings_withdrawal_requests;
begin
  if auth.uid() is not null
     and not public.user_has_permission('savings:request_withdrawal') then
    raise exception
      'Cancelling a withdrawal requires the savings:request_withdrawal capability.'
      using errcode = 'P0001';
  end if;

  select * into v_request
  from public.savings_withdrawal_requests where id = p_request_id for update;

  if not found then
    raise exception 'No such withdrawal request.' using errcode = 'P0001';
  end if;

  if v_request.status not in ('pending', 'approved') then
    raise exception
      'Withdrawal request % is %, so there is nothing to cancel.',
      v_request.request_number, v_request.status using errcode = 'P0001';
  end if;

  if nullif(pg_catalog.btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'A cancelled withdrawal must say why.' using errcode = 'P0001';
  end if;

  update public.savings_withdrawal_requests
     set status = 'cancelled',
         cancelled_at = pg_catalog.now(),
         cancellation_reason = pg_catalog.btrim(p_reason)
   where id = p_request_id;

  return p_request_id;
end;
$$;

comment on function public.cancel_savings_withdrawal(uuid, text) is
  'Polytos Phase 2. Withdraws a request before it is paid, with a reason. Not a decision about money, so it rides on the capability that prepares one.';

revoke all on function public.cancel_savings_withdrawal(uuid, text) from public, anon;
grant execute on function public.cancel_savings_withdrawal(uuid, text) to authenticated;
