-- ===========================================================================
-- Phase 6 — payment capabilities.
--
-- ## Reversal is the Owner's alone
--
-- This is the phase's central internal control, and it is the direct analogue
-- of Phase 4 withholding `loans:disburse` from the Manager.
--
-- A Secretary/Treasurer and a Manager both record payments, because recording
-- is the job: money arrives at the counter and somebody writes it down. But
-- reversing a payment is the one action that makes money *disappear* from the
-- ledger, and the person who recorded a payment must not also be the person
-- who can unrecord it. Otherwise a staff member who pocketed a cash payment
-- could post it, hand the borrower a receipt, and reverse it afterwards — and
-- the only trace would be an entry they made themselves.
--
-- So `payments:reverse` goes to the Owner/Administrator only. A Manager who
-- believes a payment is wrong raises it; the Owner acts on it.
--
-- ## No separate receipt capability
--
-- There is no `payments:view_receipt`. A receipt is a rendering of a payment,
-- not a different record: anybody who can read the payment can already read
-- every figure a receipt shows. A capability that cannot be told apart from
-- another is a false promise about what the system enforces — the same call
-- Phase 5 made about `schedules:view_all`.
--
-- ## No edit or delete capability
--
-- Deliberately absent, as in Phase 5. Financial history is corrected by
-- posting a reversal, never by changing or removing what was recorded. There
-- is no capability to grant by mistake.
--
-- ## The borrower
--
-- `client` holds nothing, and reads their own payments through the ownership
-- clause in the Row Level Security policy — the arrangement Phases 4 and 5
-- established. Phase 6 is the first phase to actually expose it: the client
-- portal now shows their payment history and balance.
-- ===========================================================================

insert into public.permissions (key, description)
values
  ('payments:view',    'See the payment register, a payment record and its receipt.'),
  ('payments:create',  'Record a payment received from a borrower.'),
  ('payments:reverse', 'Reverse a payment recorded in error.')
on conflict (key) do update set description = excluded.description;

insert into public.role_permissions (role_key, permission_key)
values
  -- Records the money that comes over the counter. Cannot unrecord it.
  ('secretary_treasurer', 'payments:view'),
  ('secretary_treasurer', 'payments:create'),

  -- The same. A Manager approves loans; that does not extend to withdrawing
  -- a payment a borrower has a receipt for.
  ('manager', 'payments:view'),
  ('manager', 'payments:create'),

  ('owner_admin', 'payments:view'),
  ('owner_admin', 'payments:create'),
  ('owner_admin', 'payments:reverse')
on conflict (role_key, permission_key) do nothing;
