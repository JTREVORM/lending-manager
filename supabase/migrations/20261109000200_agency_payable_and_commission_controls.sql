-- ===========================================================================
-- Phase 4B-S — the bank agency payable floor, and commission discrepancies
--
-- Two controls that Phase 4B left as open decisions and the security review
-- closed as requirements.
--
-- ## 1. A payable may not go into net debit (decision K, now closed)
--
-- Phase 4B corrected the direction of a bank agency withdrawal: the customer
-- receives cash, so the liability falls — Dr 2220, Cr Cash at Hand. That
-- direction is right and is unchanged here.
--
-- What Phase 4B did *not* do is bound it. Debiting a liability past zero gives
-- it a debit balance, which is no longer a liability at all: it is the bank
-- owing us for cash we advanced on its behalf. That may well be a real
-- arrangement, but it is a *different financial instrument* with its own
-- accounting, its own exposure limit and its own authorization, and letting it
-- appear by arithmetic — as a negative number in a liability account — would
-- be classifying it silently.
--
-- So for this release the floor is absolute: a withdrawal is refused if it
-- would take the provider's net payable below zero. The approved-advance model
-- is specified in `docs/POLYTOS-AGENCY-BANK-ADVANCE-MODEL.md` and is **not**
-- implemented: there is no flag to set and no path to enable, which is
-- deliberate. A switch that is present but unusable invites somebody to find
-- out what it does.
--
-- The balance is attributed **per provider**, not per account. 2220 is shared
-- by every partner bank, so an account-level balance would let one bank's
-- collections fund another's withdrawals.
--
-- ## 2. A commission discrepancy needs authority, not just typing (decision M)
--
-- Phase 4B accepted an operator-supplied commission that differed from the
-- configured rate, posted it, and flagged it. The reasoning was that a
-- provider's handset sometimes disagrees and refusing would stop the counter.
--
-- The review is right that this is the wrong default. The person typing the
-- figure is the person whose branch earns the income, the difference goes
-- straight to a 4500-series income account, and `agency:write` is held by
-- every Secretary/Treasurer. That is a self-service income adjustment.
--
-- Now: a difference is **refused** unless three things hold together — the
-- transaction carries a stated reason and a reference to external evidence,
-- and the person verifying it holds `agency:commission_exception`, which only
-- `owner_admin` has. Both figures are stored either way, so a refused
-- discrepancy is still visible for investigation.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. What a provider still owes us, or we still owe it
-- ---------------------------------------------------------------------------

create or replace function public.agency_payable_outstanding(
  p_provider_id uuid,
  p_branch_id   uuid
)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  -- Credits less debits: the normal side of a liability, so a positive result
  -- is money held on the provider's behalf and zero is nothing held. Scoped to
  -- entries whose source is one of this provider's own transactions or
  -- settlements, because the 2200-series accounts are shared between
  -- providers.
  select coalesce(pg_catalog.sum(l.credit - l.debit), 0)::bigint
    from public.journal_lines l
    join public.journal_entries e on e.id = l.entry_id
   where e.branch_id = p_branch_id
     and l.account_id = (
       select pr.payable_account_id
         from public.agency_service_providers pr
        where pr.id = p_provider_id)
     and (
       (e.source_type in ('agency_transaction', 'agency_transaction_reversal')
         and exists (select 1 from public.agency_transactions t
                      where t.id = e.source_id and t.provider_id = p_provider_id))
       or (e.source_type in ('agency_payable_settlement',
                             'agency_payable_settlement_reversal')
         and exists (select 1 from public.agency_payable_settlements s
                      where s.id = e.source_id and s.provider_id = p_provider_id))
     );
$$;

comment on function public.agency_payable_outstanding(uuid, uuid) is
  'Phase 4B-S. What is still held on one provider''s behalf at one branch: credits less debits on its payable account, attributed by source transaction. Per provider rather than per account, because the 2200-series accounts are shared between partner banks and institutions. Used to refuse a withdrawal that would take the liability into net debit.';

revoke all on function public.agency_payable_outstanding(uuid, uuid)
  from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 2. The commission exception: what was claimed, and on whose authority
-- ---------------------------------------------------------------------------

alter table public.agency_transactions
  add column commission_exception_reason   text,
  add column commission_exception_evidence text,
  add column commission_exception_by       uuid references public.profiles(id) on delete restrict,

  -- The two figures the authorisation was given *for*. Without them the
  -- authorisation is a flag rather than a decision: an Owner could approve a
  -- 1,800 difference, a counter could then edit the figure to 50,000 under
  -- `update_agency_transaction`, and the stale reason would still be present
  -- at posting. Pinning both sides also catches a provider re-rating between
  -- authorisation and posting, which moves the computed figure without
  -- anybody touching the transaction. post_agency_transaction() requires both
  -- to still hold, so any drift forces a fresh authorisation.
  add column commission_exception_amount   bigint,
  add column commission_exception_computed bigint,

  -- Stated together or not at all. A reason with no evidence is an assertion,
  -- and evidence with no reason is a reference to nothing.
  add constraint agency_transactions_commission_exception_complete
    check (
      (commission_exception_reason is null) = (commission_exception_evidence is null)
    ),

  add constraint agency_transactions_commission_exception_not_blank
    check (
      (commission_exception_reason is null
        or pg_catalog.btrim(commission_exception_reason) <> '')
      and (commission_exception_evidence is null
        or pg_catalog.btrim(commission_exception_evidence) <> '')
    ),

  -- An authoriser without a reason is nothing, and a reason without an
  -- authoriser is an unauthorised claim. They arrive together, from
  -- authorise_agency_commission_exception(), before the transaction is posted.
  add constraint agency_transactions_commission_exception_authorised
    check ((commission_exception_by is null) = (commission_exception_reason is null)),

  -- The pinned figures are part of the authorisation, so they arrive with it.
  add constraint agency_transactions_commission_exception_pinned
    check (
      (commission_exception_amount is null) = (commission_exception_reason is null)
      and (commission_exception_computed is null) = (commission_exception_reason is null)
    );

comment on column public.agency_transactions.commission_exception_reason is
  'Phase 4B-S. Why the commission posted differs from what the configured provider terms produce. Required, with evidence, before any difference may be posted.';

comment on column public.agency_transactions.commission_exception_evidence is
  'Phase 4B-S. A reference to evidence outside this system for the stated difference — a provider statement number, a handset reference, a ticket. Not validated: its value is that somebody had to name something checkable.';

comment on column public.agency_transactions.commission_exception_by is
  'Phase 4B-S. The profile that authorised the difference, stamped by authorise_agency_commission_exception() and required to hold agency:commission_exception. Deliberately not the verifier: the Owner authorises the exception and a Manager still verifies the transaction, so neither acts alone.';


-- ---------------------------------------------------------------------------
-- 3. The capability, held by the Owner alone
-- ---------------------------------------------------------------------------

insert into public.permissions (key, description)
values ('agency:commission_exception',
        'Post an agency transaction whose commission differs from the provider''s configured terms, with a stated reason and external evidence. Not a counter capability: the difference is recognised income.')
on conflict (key) do nothing;

insert into public.role_permissions (role_key, permission_key)
values ('owner_admin', 'agency:commission_exception')
on conflict (role_key, permission_key) do nothing;


-- ---------------------------------------------------------------------------
-- 4. Authorising one discrepancy, as its own act
--
-- Separate from `create` and `update` on purpose. A commission exception is
-- not a field a counter fills in; it is a decision somebody makes about
-- recognised income, and it needs a different capability from the one that
-- records the transaction. Keeping it in its own function means the
-- authorisation is its own audit entry, with its own actor, before the
-- transaction is verified by somebody else.
--
-- Callable while the transaction is a draft or awaiting verification — never
-- after posting, because the figure it authorises has by then been recognised.
-- ---------------------------------------------------------------------------

create or replace function public.authorise_agency_commission_exception(
  p_transaction_id uuid,
  p_reason         text,
  p_evidence       text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  t       public.agency_transactions;
  v_computed bigint;
begin
  v_actor := public.agency_actor('agency:commission_exception');

  if pg_catalog.btrim(coalesce(p_reason, '')) = ''
     or pg_catalog.btrim(coalesce(p_evidence, '')) = '' then
    raise exception
      'A commission exception needs both a reason and a reference to external evidence.'
      using errcode = 'P0001';
  end if;

  t := public.agency_locked_transaction(p_transaction_id);

  if t.status not in ('draft', 'awaiting_verification') then
    raise exception
      'A commission exception is authorised before the transaction is posted; this one is %.',
      t.status
      using errcode = 'P0001';
  end if;

  if t.commission_supplied is null then
    raise exception
      'This transaction supplies no commission of its own, so there is no difference to authorise.'
      using errcode = 'P0001';
  end if;

  -- Refuse an exception for a figure that does not actually differ: it would
  -- read, later, as though a discrepancy had been approved when none existed.
  select c.amount into v_computed
  from public.agency_commission_for(t.provider_id, t.principal_amount) c;

  if t.commission_supplied = v_computed then
    raise exception
      'The supplied commission already equals the % the configured terms produce, so there is nothing to authorise.',
      v_computed
      using errcode = 'P0001';
  end if;

  update public.agency_transactions
     set commission_exception_reason   = p_reason,
         commission_exception_evidence = p_evidence,
         commission_exception_by       = v_actor,
         commission_exception_amount   = t.commission_supplied,
         commission_exception_computed = v_computed
   where id = p_transaction_id;

  insert into public.agency_transaction_audit_log
    (transaction_id, action, actor_id, old_value, new_value, reason)
  values (p_transaction_id, 'commission_exception', v_actor,
          pg_catalog.jsonb_build_object('commission_computed', v_computed),
          pg_catalog.jsonb_build_object('commission_supplied', t.commission_supplied,
                                        'evidence', p_evidence),
          p_reason);
end;
$$;

comment on function public.authorise_agency_commission_exception(uuid, text, text) is
  'Phase 4B-S. Authorises one agency transaction to post a commission differing from its provider''s configured terms, with a reason and a reference to external evidence. Requires agency:commission_exception, which only owner_admin holds. Refuses a transaction that is already posted, one supplying no figure of its own, and one whose figure does not actually differ.';

revoke all on function public.authorise_agency_commission_exception(uuid, text, text)
  from public, anon;
grant execute on function public.authorise_agency_commission_exception(uuid, text, text)
  to authenticated;
