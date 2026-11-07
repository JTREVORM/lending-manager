-- ===========================================================================
-- Phase 4A — Agency Banking & Digital Payments: permissions
--
-- Specification: `docs/AGENCY-BANKING-ARCHITECTURE.md` v3.0, §9.
--
-- Nine capability keys and their role grants. Two deliberate departures from
-- §9, both recorded in `docs/POLYTOS-PHASE-4-ARCHITECTURE-RECONCILIATION.md`
-- and both tightenings.
--
-- ## Departure 1 — `agency:verify` excludes secretary_treasurer
--
-- §9 grants it to `secretary_treasurer` "cannot verify own", relying on the
-- `verifier_not_submitter` CHECK. The Product Owner decided against it
-- (decision E), and the reason is consistency: Phase 3 certified that a
-- `secretary_treasurer` holds `transfers:create` and `expenses:create` but
-- neither `:approve`, so that role may record a movement of money and may
-- never approve one — not even somebody else's. Verification is what posts an
-- agency transaction to the ledger, so it is the same act under a different
-- name. A role that cannot approve a 50,000 transfer should not be able to
-- post an agency transaction of any size.
--
-- The CHECK constraint stays regardless. It is the second line: even between
-- two managers, nobody verifies their own entry.
--
-- ## Departure 2 — `agency:reports` excludes `client`
--
-- §9 says "All roles". Taken literally that includes `client`, which is the
-- borrower role, and every agency table's RLS predicate is built on
-- `agency:reports` — so granting it to `client` would let a borrower read
-- every agency transaction, till balance and settlement in their branch. The
-- system's own convention is unambiguous: `client` holds exactly three
-- permissions, all self-service, and no finance permission has ever been
-- granted to it. "All roles" is read as all *staff* roles.
-- ===========================================================================

insert into public.permissions (key, description)
values
  ('agency:write',
   'Record, edit and cancel draft agency transactions. Does not post anything to the ledger.'),
  ('agency:verify',
   'Verify an agency transaction somebody else recorded, which posts it to the ledger. Never one''s own: agency_transactions_verifier_not_submitter refuses that at the data layer.'),
  ('agency:reverse',
   'Reverse a posted agency transaction dated today, by posting contra entries. Never by deleting anything.'),
  ('agency:reverse_cross_day',
   'Reverse a posted agency transaction dated before today. Separate from agency:reverse because reopening a closed day is a different decision from correcting the current one.'),
  ('agency:correct',
   'Correct the provider reference on a posted agency transaction. Metadata only: it posts no journal entry (correction C6).'),
  ('agency:settlements',
   'Post commission settlements, payable remittances and float replenishments.'),
  ('agency:reconcile',
   'Submit and approve cash-till and provider-float reconciliations, including approving a variance write-off.'),
  ('agency:providers',
   'Create and edit agency providers, their transaction types, and their float tills.'),
  ('agency:reports',
   'View agency transactions, till and float balances, commission earnings and settlement history. Read-only, and the predicate every agency RLS policy is built on.')
on conflict (key) do nothing;


-- ---------------------------------------------------------------------------
-- Role grants
--
--                             | sec_treasurer | manager | owner_admin
--   agency:write              |      yes      |   yes   |    yes
--   agency:verify             |      NO       |   yes   |    yes
--   agency:reverse            |      no       |   yes   |    yes
--   agency:reverse_cross_day  |      no       |   no    |    yes
--   agency:correct            |      no       |   yes   |    yes
--   agency:settlements        |      no       |   yes   |    yes
--   agency:reconcile          |      no       |   yes   |    yes
--   agency:providers          |      no       |   no    |    yes
--   agency:reports            |      yes      |   yes   |    yes
--
-- `client` appears nowhere, deliberately.
--
-- owner_admin is granted everything manager holds, following the existing
-- matrix where expenses:approve and transfers:approve both go to manager and
-- owner_admin together. §9 lists agency:reverse and agency:correct against
-- manager alone, which would leave the owner unable to correct an error the
-- manager made.
-- ---------------------------------------------------------------------------

insert into public.role_permissions (role_key, permission_key)
values
  ('secretary_treasurer', 'agency:write'),
  ('secretary_treasurer', 'agency:reports'),

  ('manager', 'agency:write'),
  ('manager', 'agency:verify'),
  ('manager', 'agency:reverse'),
  ('manager', 'agency:correct'),
  ('manager', 'agency:settlements'),
  ('manager', 'agency:reconcile'),
  ('manager', 'agency:reports'),

  ('owner_admin', 'agency:write'),
  ('owner_admin', 'agency:verify'),
  ('owner_admin', 'agency:reverse'),
  ('owner_admin', 'agency:reverse_cross_day'),
  ('owner_admin', 'agency:correct'),
  ('owner_admin', 'agency:settlements'),
  ('owner_admin', 'agency:reconcile'),
  ('owner_admin', 'agency:providers'),
  ('owner_admin', 'agency:reports')
on conflict (role_key, permission_key) do nothing;
