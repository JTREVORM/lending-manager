-- ===========================================================================
-- Polytos business-policy update — the qualification engine reads the
-- governing version, and judges each month by the terms of that month
-- ===========================================================================
--
-- The previous two migrations built the pieces. This one joins them:
-- `member_savings_qualification` stops reading the version frozen on the
-- account and starts reading the version that **governs** it on the date
-- being asked about.
--
-- Two different things change, and keeping them apart is the point:
--
--   - **The rule** — how many qualifying months are required, and whether
--     they must be consecutive — comes from the version governing the member
--     *now*. Those are the terms they are currently held to, and a member who
--     has accepted new terms is judged by them.
--
--   - **The bar for each month** — the monthly minimum a contribution had to
--     clear — comes from the version that governed the member *in that
--     month*. A January deposit of UGX 50,000 cleared January's bar, and no
--     later transition can make it not have done.
--
-- That split is the whole safety property. Without it, moving a member onto a
-- version with a higher minimum would reach back over every month they ever
-- saved and silently take months away from them — which is the failure the
-- brief names in §4, and which no amount of care at the transition itself
-- would prevent.
--
-- The rule itself changing is **not** hidden, and is not meant to be. If a new
-- version required eight months where the old one required six, a
-- transitioned member would be short two, and that is a real consequence of
-- the terms they accepted. `preview_membership_policy_transition` exists to
-- put exactly that in front of whoever authorises the move, before anybody is
-- moved: `qualifies_before` and `qualifies_after`, member by member.
--
-- For the policy version this update prepares, the minimum and the month count
-- are both unchanged from 1.0 — UGX 50,000 and six — so no member's
-- qualification moves at all. The machinery is still correct rather than
-- merely lucky, and `tests/db/policy-transition.test.ts` proves it against a
-- version where the figures do differ.
-- ===========================================================================

create or replace function public.member_savings_qualification(
  p_savings_account_id uuid,
  p_as_of date default null
)
returns table (
  savings_account_id uuid,
  as_of date,
  monthly_minimum bigint,
  months_required smallint,
  must_be_consecutive boolean,
  qualifying_months integer,
  longest_consecutive_months integer,
  months_recorded integer,
  months_short integer,
  total_contributed bigint,
  total_withdrawn bigint,
  balance bigint,
  qualifies boolean,
  blocked_reason text
)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_version uuid;
begin
  -- The version governing this account on the date being asked about, which
  -- is the account's own frozen version until a transition moves the
  -- membership — so every account that has never been transitioned gets
  -- exactly the answer it got before this migration.
  v_version := public.savings_account_governing_policy(
    p_savings_account_id, p_as_of);

  if v_version is null then
    raise exception 'No such savings account.' using errcode = 'P0001';
  end if;

  return query
  select * from public.savings_qualification_under_policy(
    p_savings_account_id, v_version, p_as_of,
    -- Each month against the terms of that month.
    true);
end;
$$;

comment on function public.member_savings_qualification(uuid, date) is
  'Polytos Phase 2, rewired by the policy update. Whether a savings account has met the qualifying-month rule as of a date. The rule — how many months, and whether consecutive — comes from the version governing the member on that date; the monthly minimum each contribution had to clear comes from the version that governed them in that month. A transition therefore cannot take away a month already saved.';

-- Prospective savings and loan work resolves the dated governing policy.
-- Existing accounts, loans, schedules and approval snapshots are never updated.
create or replace function public.member_loan_eligibility_of(
  p_client_id uuid,
  p_amount bigint default null,
  p_term_months smallint default null,
  p_repayment_frequency text default null,
  p_as_of date default null
)
returns table (
  client_id uuid,
  membership_id uuid,
  membership_number text,
  membership_status text,
  policy_version_id uuid,
  policy_version text,
  as_of date,
  savings_account_id uuid,
  savings_account_number text,
  savings_account_status text,
  months_required smallint,
  must_be_consecutive boolean,
  qualifying_months integer,
  consecutive_qualifying_months integer,
  savings_qualifies boolean,
  eligible_savings bigint,
  multiplier_bps integer,
  max_eligible_loan bigint,
  max_term_months smallint,
  required_cadence text,
  active_loan_count integer,
  active_loan_limit integer,
  outstanding_principal bigint,
  pledged_savings bigint,
  pending_withdrawals bigint,
  available_savings bigint,
  amount_requested bigint,
  term_requested smallint,
  is_eligible boolean,
  may_proceed boolean,
  blocking_reasons text[]
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_membership public.memberships;
  v_policy     public.membership_policy_versions;
  v_account    public.savings_accounts;
  v_settings   public.business_settings;
  v_qual       record;
  v_reasons    text[] := '{}';
  v_product    public.loan_products;
begin
  as_of := coalesce(p_as_of, public.business_date());
  client_id := p_client_id;
  amount_requested := p_amount;
  term_requested := p_term_months;
  is_eligible := false;
  may_proceed := false;

  select * into v_settings from public.business_settings where id = 1;

  if not found then
    blocking_reasons := array['Business settings have not been configured.'];
    return next;
    return;
  end if;

  active_loan_limit := v_settings.max_active_loans_per_client;

  -- --- Is there a client at all ------------------------------------------
  if p_client_id is null
     or not exists (select 1 from public.clients c where c.id = p_client_id) then
    blocking_reasons := array['There is no such client.'];
    return next;
    return;
  end if;

  -- --- Is there a live membership ----------------------------------------
  -- The partial unique index on `memberships` guarantees at most one row in
  -- pending/active/suspended, so this is a single row by construction rather
  -- than by `limit 1`.
  select * into v_membership
  from public.memberships m
  where m.client_id = p_client_id
    and m.status in ('pending', 'active', 'suspended');

  if not found then
    blocking_reasons :=
      array['This client is not a member of the savings programme, so they cannot take a member loan. An ordinary loan product is unaffected.'];
    return next;
    return;
  end if;

  membership_id := v_membership.id;
  membership_number := v_membership.membership_number;
  membership_status := v_membership.status;
  policy_version_id := public.membership_governing_policy(v_membership.id, as_of);

  select * into v_policy
  from public.membership_policy_versions
  where id = public.membership_governing_policy(v_membership.id, as_of);

  policy_version := v_policy.version;
  months_required := v_policy.savings_qualifying_months;
  must_be_consecutive := v_policy.qualifying_months_consecutive;
  multiplier_bps := v_policy.savings_to_loan_multiplier_bps;
  max_term_months := v_policy.member_loan_max_term_months;
  required_cadence := public.member_loan_cadence_for_term(
    public.membership_governing_policy(v_membership.id, as_of), p_term_months
  );

  -- --- The membership's own standing -------------------------------------
  if v_membership.status = 'pending' then
    v_reasons := v_reasons
      || 'This membership has not been activated: the registration fee and a verified acceptance of the member''s own terms are both required first.'::text;
  elsif v_membership.status = 'suspended' then
    v_reasons := v_reasons
      || ('This membership is suspended'
          || coalesce(' — ' || v_membership.status_reason, '') || '.');
  end if;

  -- --- Is member lending open under *this member's* version --------------
  -- Their frozen version, not the programme as it stands. A member on a
  -- superseded version is authorised for nothing, and a member on a version
  -- whose lending decisions are open cannot borrow however long they have
  -- saved.
  if not public.membership_policy_allows(public.membership_governing_policy(v_membership.id, as_of), 'lending') then
    v_reasons := v_reasons
      || ('Member lending is not open under policy version '
          || coalesce(v_policy.version, '(unknown)')
          || '. ' || public.member_lending_blocked_reason(public.membership_governing_policy(v_membership.id, as_of)));
  end if;

  -- --- The savings account -----------------------------------------------
  -- Aliased, because `membership_id` is also an OUT parameter of this
  -- function and an unqualified reference would be ambiguous.
  select sa.* into v_account
  from public.savings_accounts sa
  where sa.membership_id = v_membership.id;

  if not found then
    v_reasons := v_reasons
      || 'This member has no savings account, so there is no qualifying history and nothing securing a loan.'::text;
  else
    savings_account_id := v_account.id;
    savings_account_number := v_account.account_number;
    savings_account_status := v_account.status;

    if v_account.status <> 'active' then
      v_reasons := v_reasons
        || ('This savings account is ' || v_account.status
            || coalesce(' — ' || v_account.status_reason, '') || '.');
    end if;

    -- Phase 2's calculation, as of the assessment date. The only one.
    select * into v_qual
    from public.member_savings_qualification(v_account.id, as_of);

    qualifying_months := v_qual.qualifying_months;
    consecutive_qualifying_months := v_qual.longest_consecutive_months;
    savings_qualifies := v_qual.qualifies;
    -- The balance, not the lifetime deposits: a withdrawal reduces what
    -- secures a loan.
    eligible_savings := v_qual.balance;

    if not v_qual.qualifies then
      v_reasons := v_reasons
        || coalesce(v_qual.blocked_reason, 'The savings qualifying period has not been served.')::text;
    end if;
  end if;

  -- --- What of the savings is actually free -------------------------------
  --
  -- Three figures, and the distinction between them is the whole reason two
  -- concurrency tests exist:
  --
  --   `eligible_savings`     what the member holds. Evidence.
  --   `pledged_savings`      what already secures a live member loan.
  --   `pending_withdrawals`  what the member has asked for and a supervisor
  --                          has approved but nobody has paid yet. Still in
  --                          the balance, and not available to secure
  --                          anything, because it is on its way out.
  --
  -- The ceiling is computed from what is left, not from the balance. Without
  -- that, two loans approved in succession would each see the whole balance
  -- and between them consume twice the capacity the member has — which is
  -- exactly what `tests/db/member-loan-concurrency.test.ts` found when the
  -- ceiling was computed from the balance alone, with only the
  -- belt-and-braces invariant inside `approve_loan` catching it.
  if v_account.id is not null then
    pledged_savings := public.savings_pledged_amount(v_account.id, as_of);

    -- `v_account.id` rather than the `savings_account_id` OUT parameter:
    -- the table has a column of that name too, so an unqualified reference
    -- would be ambiguous.
    select coalesce(pg_catalog.sum(r.amount), 0)::bigint
      into pending_withdrawals
    from public.savings_withdrawal_requests r
    where r.savings_account_id = v_account.id
      and r.status in ('pending', 'approved')
      and r.business_date <= as_of;
  else
    pledged_savings := 0;
    pending_withdrawals := 0;
  end if;

  available_savings := greatest(
    coalesce(eligible_savings, 0) - pledged_savings - pending_withdrawals, 0
  );

  -- --- The ceiling, where there is one ------------------------------------
  -- NULL, not a guess, while the multiplier is undecided. The reason is
  -- already in `v_reasons` by way of the lending gate; stating a number here
  -- would be inventing the member's credit limit.
  if multiplier_bps is not null and eligible_savings is not null then
    -- Rounded **down**, and that is not an oversight. A pledge is
    -- `principal / multiplier` rounded up, so that rounding can only ever
    -- over-pledge; if the ceiling rounded half-up as well, then at a
    -- multiplier below 1x a loan taken at exactly the ceiling would pledge one
    -- shilling more than the member holds, and the invariant inside
    -- `approve_loan` would refuse a legitimate approval. Rounding a maximum
    -- down is also right on its own terms: a ceiling rounded up grants a
    -- shilling nobody authorised. See `memberLoanCeiling` in
    -- lib/domain/member-loan.ts, where a property test found it.
    max_eligible_loan := (available_savings * multiplier_bps) / 10000;

    -- The business's own bounds still apply. The multiplier decides how much a
    -- member's savings support; it does not exempt them from what the business
    -- lends at all.
    select * into v_product
    from public.loan_products
    where product_code = 'ML';

    if v_product.id is not null then
      max_eligible_loan := least(max_eligible_loan, v_product.max_amount);
    end if;

    max_eligible_loan := least(
      max_eligible_loan, v_settings.max_loan_amount
    );
  end if;

  -- --- Existing obligations ----------------------------------------------
  select pg_catalog.count(*)::integer
    into active_loan_count
  from public.loans l
  where l.client_id = p_client_id and l.status = 'active';

  select coalesce(pg_catalog.sum(b.principal_remaining), 0)::bigint
    into outstanding_principal
  from public.loan_balances b
  join public.loans l on l.id = b.loan_id
  where l.client_id = p_client_id and l.status = 'active';

  if active_loan_count >= v_settings.max_active_loans_per_client then
    v_reasons := v_reasons
      || ('This client already has ' || active_loan_count
          || ' active loan(s), and the business permits '
          || v_settings.max_active_loans_per_client
          || ' at a time. An existing ordinary loan is not converted or repriced by membership; it has to run its course.');
  end if;

  -- --- Eligibility, before the request ------------------------------------
  is_eligible := pg_catalog.cardinality(v_reasons) = 0;

  -- --- The request itself -------------------------------------------------
  if p_amount is not null then
    if p_amount <= 0 then
      v_reasons := v_reasons || 'A loan amount must be a positive number of shillings.'::text;
    else
      if max_eligible_loan is not null and p_amount > max_eligible_loan then
        v_reasons := v_reasons
          || ('The requested ' || p_amount || ' exceeds the '
              || max_eligible_loan || ' this member''s savings support.'
              || case
                   when pledged_savings > 0 or pending_withdrawals > 0
                   then ' Of a balance of ' || coalesce(eligible_savings, 0)
                        || ', ' || pledged_savings || ' secures a live member loan and '
                        || pending_withdrawals || ' is awaiting payment as a withdrawal.'
                   else ''
                 end);
      end if;

      if p_amount < v_settings.min_loan_amount then
        v_reasons := v_reasons
          || ('The business lends from ' || v_settings.min_loan_amount || '.');
      end if;
    end if;
  end if;

  if p_term_months is not null then
    if p_term_months < 1 then
      v_reasons := v_reasons || 'A loan term must be at least one month.'::text;
    elsif p_term_months > v_policy.member_loan_max_term_months then
      v_reasons := v_reasons
        || ('A member loan runs for at most '
            || v_policy.member_loan_max_term_months || ' months; '
            || p_term_months || ' was requested.');
    end if;

    if p_term_months > 1
       and p_amount is not null
       and p_amount < v_settings.multi_month_min_amount then
      v_reasons := v_reasons
        || ('A loan of more than one month requires at least '
            || v_settings.multi_month_min_amount || '.');
    end if;
  end if;

  if p_repayment_frequency is not null
     and required_cadence is not null
     and p_repayment_frequency <> required_cadence then
    v_reasons := v_reasons
      || ('A ' || p_term_months || '-month member loan is collected '
          || required_cadence || ', not ' || p_repayment_frequency || '.');
  end if;

  if p_repayment_frequency is not null
     and not exists (
       select 1 from public.repayment_frequencies rf
       where rf.key = p_repayment_frequency and rf.is_active
     ) then
    v_reasons := v_reasons
      || ('The ' || p_repayment_frequency
          || ' collection cadence is not available. A calendar-monthly cadence stays unavailable until the business decides what a monthly collection does in a month that has no such day.');
  end if;

  blocking_reasons := v_reasons;
  may_proceed := pg_catalog.cardinality(v_reasons) = 0
    and p_amount is not null
    and p_term_months is not null;

  return next;
end;
$$;
create or replace function public.savings_accounts_stamp_provenance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_membership public.memberships;
begin
  select * into v_membership
  from public.memberships where id = new.membership_id;

  if not found then
    raise exception 'No such membership.' using errcode = 'P0001';
  end if;

  if v_membership.status not in ('pending', 'active', 'suspended') then
    raise exception
      'Membership % has ended. A savings account cannot be opened on it.',
      v_membership.membership_number using errcode = 'P0001';
  end if;

  if new.client_id is not null and new.client_id <> v_membership.client_id then
    raise exception
      'A savings account belongs to the member''s own client record.'
      using errcode = 'P0001';
  end if;

  if new.branch_id is not null and new.branch_id <> v_membership.branch_id then
    raise exception
      'A savings account is held at the membership''s own branch.'
      using errcode = 'P0001';
  end if;

  if new.policy_version_id is not null
     and new.policy_version_id <> public.membership_governing_policy(v_membership.id, coalesce(new.opened_on, public.business_date())) then
    raise exception
      'A savings account is judged against the member''s own policy version.'
      using errcode = 'P0001';
  end if;

  new.client_id := v_membership.client_id;
  new.branch_id := v_membership.branch_id;
  new.policy_version_id := public.membership_governing_policy(v_membership.id, coalesce(new.opened_on, public.business_date()));

  new.created_by := public.current_profile_id();
  new.created_by_label := public.audit_actor_label();
  new.opened_on := coalesce(new.opened_on, public.business_date());

  -- An account opens active. There is no state in which it exists and
  -- refuses the first deposit.
  if new.status <> 'active' then
    raise exception
      'A savings account is opened active. Restricting it is a later decision, with a reason.'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;
create or replace function public.open_savings_account(p_membership_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_account_id uuid;
  v_membership public.memberships;
begin
  -- Serialise on the membership, so two enrolment submissions cannot both
  -- find no account and both insert one.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('savings_account:' || p_membership_id::text)
  );

  select id into v_account_id
  from public.savings_accounts where membership_id = p_membership_id;

  if v_account_id is not null then
    return v_account_id;
  end if;

  select * into v_membership
  from public.memberships where id = p_membership_id;

  if not found then
    raise exception 'No such membership.' using errcode = 'P0001';
  end if;

  if auth.uid() is not null
     and not public.user_has_permission('membership:create')
     and not public.user_has_permission('savings:deposit') then
    raise exception
      'Opening a savings account requires the membership:create or savings:deposit capability.'
      using errcode = 'P0001';
  end if;

  -- The savings rules have to be open. Enrolment and savings are gated
  -- separately — a member can be enrolled while the savings questions are
  -- unanswered — so this is the gate that says the account may exist.
  if not public.membership_policy_allows(public.membership_governing_policy(v_membership.id), 'savings') then
    raise exception
      'Savings are not open under the policy version governing membership %. The savings rules have not been decided.',
      v_membership.membership_number using errcode = 'P0001';
  end if;

  insert into public.savings_accounts (membership_id, opened_on)
  values (p_membership_id, public.business_date())
  returning id into v_account_id;

  return v_account_id;
end;
$$;
create or replace function public.post_savings_deposit(
  p_savings_account_id uuid,
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
  v_account     public.savings_accounts;
  v_membership  public.memberships;
  v_actor       uuid;
  v_label       text;
  v_reference   text;
  v_txn_id      uuid;
  v_cash        uuid;
  v_liability   uuid;
  v_entry_id    uuid;
  v_date        date;
begin
  v_actor := public.current_profile_id();
  v_label := public.audit_actor_label();

  -- Authorisation first, and **above the replay shortcut below**, which is
  -- not an ordering detail. A caller who may not deposit must not be able to
  -- learn a transaction id by replaying a key either: the early return is a
  -- read of somebody else's movement, and putting it before this check would
  -- have made every posted deposit readable by any signed-in caller holding a
  -- key. The rule is: establish who is asking, then decide whether this is a
  -- retry of their own request.
  if v_actor is null and auth.uid() is not null then
    raise exception
      'A deposit must be recorded by a signed-in member of staff.'
      using errcode = 'P0001';
  end if;

  if auth.uid() is not null and not public.user_has_permission('savings:deposit') then
    raise exception 'Recording a deposit requires the savings:deposit capability.'
      using errcode = 'P0001';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('savings_txn_key:' || p_idempotency_key::text)
  );

  select id into v_txn_id
  from public.savings_transactions where idempotency_key = p_idempotency_key;

  -- The retry path. A lost response, a double tap, a replayed form: the money
  -- is recorded once and the caller gets the answer it would have had.
  if v_txn_id is not null then
    return v_txn_id;
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'A deposit must be more than zero shillings.'
      using errcode = 'P0001';
  end if;

  -- Locked for the rest of the transaction. A concurrent deposit or
  -- withdrawal on the same account waits here.
  select * into v_account
  from public.savings_accounts where id = p_savings_account_id for update;

  if not found then
    raise exception 'No such savings account.' using errcode = 'P0001';
  end if;

  if v_account.status = 'closed' then
    raise exception
      'Savings account % is closed.', v_account.account_number
      using errcode = 'P0001';
  end if;

  select * into v_membership
  from public.memberships where id = v_account.membership_id;

  if v_membership.status not in ('pending', 'active', 'suspended') then
    raise exception
      'Membership % has ended. Its savings account takes no further deposits.',
      v_membership.membership_number using errcode = 'P0001';
  end if;

  if not public.membership_policy_allows(public.savings_account_governing_policy(v_account.id), 'savings') then
    raise exception
      'Savings are not open under the policy version governing this account. The savings rules have not been decided.'
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
        'A cash deposit has no network reference. Its transaction number is its reference.'
        using errcode = 'P0001';
    end if;
  elsif v_reference is null then
    raise exception
      'A % deposit needs the reference from the network or the bank. It is what makes the line findable when the account is reconciled.',
      p_payment_method using errcode = 'P0001';
  elsif char_length(v_reference) < 4 then
    raise exception
      'That transaction reference is too short to identify a deposit.'
      using errcode = 'P0001';
  end if;

  v_cash := public.branch_cash_account(
    v_account.branch_id, public.payment_method_cash_kind(p_payment_method));
  v_liability := public.ledger_account_by_code('2100');
  v_date := public.business_date();

  -- The id is minted here rather than by the default, so the journal can
  -- name its source before the source row exists and the row can carry its
  -- entry id from the moment it is written.
  --
  -- The alternative — insert, post, then UPDATE the entry id back — would
  -- need the append-only trigger suspended for the duration, and
  -- `alter table ... disable trigger` takes an ACCESS EXCLUSIVE lock on the
  -- whole table. Every deposit in the business would serialise behind every
  -- other, and readers would block too. `journal_entries.source_id` carries
  -- no foreign key precisely so this ordering is available.
  v_txn_id := pg_catalog.gen_random_uuid();

  v_entry_id := public.post_journal(
    v_account.branch_id,
    v_date,
    'Member savings deposit — ' || v_account.account_number,
    'savings_deposit',
    v_txn_id,
    null,
    v_account.client_id,
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'account_id', v_cash, 'debit', p_amount, 'credit', 0,
        'memo', 'Savings received'),
      pg_catalog.jsonb_build_object(
        'account_id', v_liability, 'debit', 0, 'credit', p_amount,
        'memo', 'Member savings — ' || v_account.account_number)
    ),
    null, v_actor, v_label
  );

  insert into public.savings_transactions (
    id, savings_account_id, membership_id, client_id, branch_id,
    kind, amount, payment_method, cash_account_id, external_reference,
    idempotency_key, value_date, journal_entry_id,
    recorded_by, recorded_by_label, notes
  )
  values (
    v_txn_id, p_savings_account_id, v_account.membership_id, v_account.client_id,
    v_account.branch_id,
    'deposit', p_amount, p_payment_method, v_cash, v_reference,
    p_idempotency_key, v_date, v_entry_id, v_actor, v_label,
    nullif(pg_catalog.btrim(coalesce(p_notes, '')), '')
  );

  return v_txn_id;
end;
$$;

create or replace view public.membership_register
with (security_invoker = true) as
select
  m.id,
  m.membership_number,
  m.client_id,
  c.client_number,
  c.full_name,
  c.phone,
  c.village_area,
  c.district,
  c.status                as client_status,
  m.branch_id,
  b.name                  as branch_name,
  m.status,
  m.status_reason,
  m.status_changed_at,
  m.applied_on,
  m.activated_on,
  m.ended_on,
  public.membership_governing_policy(m.id) as policy_version_id,
  v.version               as policy_version,
  -- The gates, one per activity, as the version governing this member
  -- computes them. Not `is_financially_enabled`: that is one boolean about
  -- five different activities, and a member screen that showed it would say
  -- "no" about a version under which enrolment and savings are both open.
  -- "Has it started" is deliberately absent here too — the register is a
  -- list of members, not the gate a posting consults, and that gate is
  -- `membership_policy_allows()`.
  v.is_enrolment_enabled   as policy_enrolment_enabled,
  v.is_savings_enabled     as policy_savings_enabled,
  v.is_member_lending_enabled as policy_member_lending_enabled,
  v.is_benefits_enabled    as policy_benefits_enabled,
  -- One per benefit, because the policy update split the gate. A member
  -- screen that said "benefits: no" while a condolence claim was payable
  -- would be the single-switch mistake showing through to the counter.
  v.is_medical_benefit_enabled     as policy_medical_benefit_enabled,
  v.is_condolence_benefit_enabled  as policy_condolence_benefit_enabled,
  v.is_bereavement_benefit_enabled as policy_bereavement_benefit_enabled,
  v.is_profit_sharing_enabled as policy_profit_sharing_enabled,
  m.notes,
  m.created_at,
  m.updated_at
from public.memberships m
join public.clients c on c.id = m.client_id
join public.membership_policy_versions v on v.id = public.membership_governing_policy(m.id)
left join public.branches b on b.id = m.branch_id;

