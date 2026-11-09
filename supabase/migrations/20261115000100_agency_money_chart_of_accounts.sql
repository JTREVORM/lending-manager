-- ===========================================================================
-- Phase 4E — three accounts the Mobile Money decisions require
--
-- Approved decisions OD-1 and OD-10 name financial treatments that Phase 4A's
-- chart has nowhere to put. Each gets its own postable account rather than
-- being netted into an existing one, for the reason correction C9 gave when it
-- refused to net float variances into 5950: two different failures in one
-- account hide both.
--
-- ## 5970 — a premium paid for float (OD-1)
--
-- A branch short of float buys it from another agent or a service centre, and
-- pays more than face value: 500,500 cash for 500,000 of float. The 500 is the
-- cost of being short, and it is an expense of trading, not a float balance.
-- Posting it into 1320 would overstate the float by money the provider will
-- never confirm, and the next reconciliation would report a variance that is
-- not a variance.
--
-- ## 4580 — a discount received on float (OD-1)
--
-- The same trade the other way: 499,500 paid for 500,000 of float. The 500 is
-- income. Deliberately NOT 4570 Agency Service Fees, which is what a customer
-- pays us at the counter; this is a trading gain against another agent, and a
-- reader asking "what did we earn from customers" must not be handed both.
--
-- ## 2230 — commission we have been paid and must give back (OD-10)
--
-- A transaction is reversed after its commission has already been paid into
-- the line's float. Crediting 1310 would drive the line's receivable negative,
-- which is a statement that the provider owes us less than nothing — not a
-- fact about anything. What is true is that we hold money that is no longer
-- ours, so it is a liability until it is recovered or offset. OD-10 says
-- exactly that: "Reclassify commission already received as a provider recovery
-- payable, not a negative receivable."
--
-- Nothing here is postable by a human. Each account is reached only by the
-- posting functions added later in this phase.
-- ===========================================================================

insert into public.ledger_accounts (code, name, account_type, normal_side, is_postable, status, description)
values
  ('2230', 'Agency Commission Recovery Payable', 'liability', 'credit', true, 'active',
   'Phase 4E, decision OD-10. Commission the provider has already paid into a float line, on a transaction that was afterwards reversed. Credited by the reversal, debited when the provider recovers it or offsets it against a later payout. Never a negative balance in 1310.')
on conflict (code) do nothing;

insert into public.ledger_accounts (code, name, account_type, normal_side, is_postable, status, description)
values
  ('4580', 'Agency Float Purchase Discount', 'income', 'credit', true, 'active',
   'Phase 4E, decision OD-1. Where a float purchase below face value is recognised: 499,500 paid for 500,000 of float credits 500 here. Deliberately not 4570 Agency Service Fees, which is what the customer pays at the counter — this is a trading gain against another agent or a service centre.')
on conflict (code) do nothing;

insert into public.ledger_accounts (code, name, account_type, normal_side, is_postable, status, description)
values
  ('5970', 'Agency Float Purchase Premium', 'expense', 'debit', true, 'active',
   'Phase 4E, decision OD-1. Where a float purchase above face value is recognised: 500,500 paid for 500,000 of float debits 500 here. The cost of being short of float, kept out of 1320 so the line''s balance is always what the provider will confirm.')
on conflict (code) do nothing;


-- ---------------------------------------------------------------------------
-- Parent wiring, afterwards and idempotent, for the reason
-- 20261107000200 states: a subquery inside the INSERT that creates the parent
-- sees the table as it was before the statement and returns NULL.
-- ---------------------------------------------------------------------------

update public.ledger_accounts
   set parent_id = (select id from public.ledger_accounts where code = '2200')
 where code = '2230' and parent_id is null;

update public.ledger_accounts
   set parent_id = (select id from public.ledger_accounts where code = '4500')
 where code = '4580' and parent_id is null;

update public.ledger_accounts
   set parent_id = (select id from public.ledger_accounts where code = '5000')
 where code = '5970' and parent_id is null;


-- ---------------------------------------------------------------------------
-- Resolver helpers
--
-- Every posting function in this phase needs these three by code, and
-- `ledger_account_by_code()` already exists and is already used by the agency
-- engine. Named constants would be a second source of truth; these are not
-- added.
-- ---------------------------------------------------------------------------

comment on column public.ledger_accounts.code is
  'Stable account code. The agency engine resolves 1310, 2230, 4570, 4580, 5960 and 5970 by code through ledger_account_by_code(), so a code is part of the schema contract and is never re-pointed at a different account.';
