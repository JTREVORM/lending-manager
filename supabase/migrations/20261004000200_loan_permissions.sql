-- ===========================================================================
-- Phase 4 — loan capabilities.
--
-- The lifecycle is deliberately split across several capabilities rather than
-- a single `loans:manage`, because the separation between *entering* a loan,
-- *approving* it and *releasing the money* is the main internal control a
-- small lending business has. One capability would collapse all three.
--
-- ## The grants, and why they stop where they do
--
-- **Secretary/Treasurer** enters loans. The business's own description of the
-- role is that they record loan details and amounts, so they hold
-- `loans:create`, `loans:update_draft` and `loans:submit` — everything up to
-- asking for a decision, and nothing that makes one.
--
-- **Manager** reviews and approves, and may return a draft for correction.
-- They deliberately do **not** hold `loans:disburse`. A Manager also holds
-- `loans:create`, so granting disbursement as well would let one person
-- originate a loan, approve it and hand over the cash with nobody else
-- involved. Withholding it means the money is released by somebody who did
-- not approve it, which is the whole value of having two roles.
--
-- **Owner/Administrator** holds everything, including cancellation and the
-- sensitive identity snapshots. In a business this size the Owner is the
-- backstop for every control, and that is a decision about trust rather than
-- about software.
--
-- **Client** holds nothing. The borrower-facing loan view is a later phase;
-- Row Level Security is written for it now (see 20261004000600) but no
-- capability is granted and no interface is exposed.
-- ===========================================================================

insert into public.permissions (key, description)
values
  ('loans:view',           'See the loan register and open a loan record.'),
  ('loans:create',         'Start a loan draft and enter its details.'),
  ('loans:update_draft',   'Change a loan while it is still a draft.'),
  ('loans:submit',         'Submit a completed draft for approval.'),
  ('loans:approve',        'Approve a loan, or return it to draft for correction.'),
  ('loans:disburse',       'Release the money and activate an approved loan.'),
  ('loans:cancel',         'Cancel a loan before it is disbursed.'),
  ('loans:view_sensitive', 'Read the identity snapshots captured against a loan.')
on conflict (key) do update set description = excluded.description;

insert into public.role_permissions (role_key, permission_key)
values
  -- --- secretary_treasurer: enters loans, decides nothing ------------------
  ('secretary_treasurer', 'loans:view'),
  ('secretary_treasurer', 'loans:create'),
  ('secretary_treasurer', 'loans:update_draft'),
  ('secretary_treasurer', 'loans:submit'),

  -- --- manager: reviews, approves, does not release money -----------------
  ('manager', 'loans:view'),
  ('manager', 'loans:create'),
  ('manager', 'loans:update_draft'),
  ('manager', 'loans:submit'),
  ('manager', 'loans:approve'),
  ('manager', 'loans:view_sensitive'),

  -- --- owner_admin: the full lifecycle ------------------------------------
  ('owner_admin', 'loans:view'),
  ('owner_admin', 'loans:create'),
  ('owner_admin', 'loans:update_draft'),
  ('owner_admin', 'loans:submit'),
  ('owner_admin', 'loans:approve'),
  ('owner_admin', 'loans:disburse'),
  ('owner_admin', 'loans:cancel'),
  ('owner_admin', 'loans:view_sensitive')
on conflict (role_key, permission_key) do nothing;
