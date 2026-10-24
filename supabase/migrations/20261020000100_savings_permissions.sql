-- ===========================================================================
-- Polytos Phase 2.1 — the savings capabilities, and what each role may do
--
-- ## The separation that matters
--
-- Taking money in and letting money out are not the same act, and the people
-- who may do them are not the same people. `savings:deposit` is a counter
-- capability: a Secretary/Treasurer takes a member's UGX 50,000 and issues a
-- receipt, and nothing about that decision needs a second opinion — the money
-- is arriving.
--
-- A withdrawal is money leaving on the strength of somebody's judgement, so
-- it is split into three capabilities rather than one:
--
--   `savings:request_withdrawal`  prepare it, with the member in front of you
--   `savings:approve_withdrawal`  decide it
--   `savings:post_withdrawal`     pay it, and move the ledger
--
-- The counter prepares; a Manager or the Owner decides. The posting function
-- additionally refuses an approval from the person who requested it, exactly
-- as `record_transfer` and `record_expense` already refuse an approval from
-- the person who asked. Splitting the capabilities without that refusal would
-- be a control that exists on paper: a Manager holds both.
--
-- `savings:reverse` is narrower still. A reversal rewrites what the books say
-- happened, and it is the Owner's alone — the same judgement `reverse_payment`
-- and `reverse_transfer` already encode.
--
-- ## What is deliberately *not* here
--
-- No `savings:close_account`. Closing a savings account is one of the rules
-- the client has not settled (see
-- docs/POLYTOS-MEMBERSHIP-POLICY-DECISIONS.md), and a capability with no
-- workflow behind it is a permission that looks enforced and is not. It
-- arrives with the rule.
--
-- No `membership_fees:*` either. Collecting the registration fee is part of
-- enrolling a member, not a separate act with its own authority, so it rides
-- on `membership:create` — which is also what makes the combined
-- fee-plus-first-deposit payment a single authorization decision rather than
-- two that could disagree.
-- ===========================================================================

insert into public.permissions (key, description)
values
  ('savings:view',
   'See the savings register, a member''s savings account, their statement and their contribution history.'),
  ('savings:deposit',
   'Record a savings deposit and issue its receipt.'),
  ('savings:request_withdrawal',
   'Prepare a savings withdrawal request for review.'),
  ('savings:approve_withdrawal',
   'Approve or reject a savings withdrawal request.'),
  ('savings:post_withdrawal',
   'Pay an approved savings withdrawal and post it to the ledger.'),
  ('savings:reverse',
   'Reverse a posted savings transaction, with a reason, leaving both entries in the trail.'),
  ('savings:view_reports',
   'See savings totals across members: the liability position, period deposits and withdrawals, and contribution compliance.')
on conflict (key) do update set description = excluded.description;

insert into public.role_permissions (role_key, permission_key)
values
  -- The counter. Takes money, prepares requests, prints receipts — and
  -- decides nothing. `savings:view` comes with it because a deposit cannot be
  -- recorded against an account nobody can look up.
  ('secretary_treasurer', 'savings:view'),
  ('secretary_treasurer', 'savings:deposit'),
  ('secretary_treasurer', 'savings:request_withdrawal'),

  -- Supervises. May decide a withdrawal and may pay one, but the posting
  -- function still refuses the pair from one person on the same request.
  ('manager', 'savings:view'),
  ('manager', 'savings:deposit'),
  ('manager', 'savings:request_withdrawal'),
  ('manager', 'savings:approve_withdrawal'),
  ('manager', 'savings:post_withdrawal'),
  ('manager', 'savings:view_reports'),

  ('owner_admin', 'savings:view'),
  ('owner_admin', 'savings:deposit'),
  ('owner_admin', 'savings:request_withdrawal'),
  ('owner_admin', 'savings:approve_withdrawal'),
  ('owner_admin', 'savings:post_withdrawal'),
  ('owner_admin', 'savings:reverse'),
  ('owner_admin', 'savings:view_reports')
on conflict (role_key, permission_key) do nothing;

-- A borrower holds none of these. A member reads their own savings the way
-- they read their own membership: through the identity clause on
-- `clients.profile_id`, which grants exactly their own rows. Granting
-- `savings:view` to `client` would mean granting the whole register.

-- ---------------------------------------------------------------------------
-- The Phase 2 reference scopes
--
-- Each is minted by `public.next_reference()` inside a BEFORE INSERT trigger,
-- exactly as `MB`, `LN` and `PAY` are. Padding of 4 on the member-facing ones
-- matches the membership number they sit beside on a receipt; the withdrawal
-- request is an internal document and takes 5, as the finance documents do.
-- ---------------------------------------------------------------------------

insert into public.reference_formats (scope, prefix, padding, description)
values
  ('membership_fee', 'MF', 4,
   'Membership registration fee receipts, e.g. MF260001'),
  ('savings_account', 'SA', 4,
   'Savings account numbers, e.g. SA260001'),
  ('savings_transaction', 'SV', 5,
   'Savings deposits, withdrawals and reversals, e.g. SV2600001'),
  ('savings_withdrawal', 'WD', 5,
   'Savings withdrawal requests, e.g. WD2600001'),
  ('membership_card', 'MC', 4,
   'Membership card issues and reissues, e.g. MC260001')
on conflict (scope) do nothing;
