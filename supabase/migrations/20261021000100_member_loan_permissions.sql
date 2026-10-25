-- ===========================================================================
-- Polytos Phase 3.1 — the member-lending capabilities, and what each role may do
--
-- ## Two capabilities, not six
--
-- A member loan is a loan. It is approved by `loans:approve`, disbursed by
-- `loans:disburse`, collected by `payments:record` and reversed by
-- `payments:reverse`, exactly as every other loan is — because it *is* a row
-- in `public.loans` and a second authority over the same act would be two
-- answers to "who may lend the business's money".
--
-- So Phase 3 adds only what is genuinely new, which is two things:
--
--   `member_loans:view_eligibility`  read an assessment of whether a member
--                                    may borrow, and how much
--   `member_loans:create`            open a member-loan application
--
-- ### Why eligibility needs a capability of its own
--
-- An eligibility assessment is not a view of savings and it is not a view of
-- a membership. It is a **lending offer**: a number saying how much this
-- business is prepared to put in this person's hands. That is commercially
-- sensitive in a way neither input is, it is what a borrower will argue
-- about, and it is derived from a multiplier the Owner sets. Reading it
-- therefore needs saying, rather than falling out of `savings:view`.
--
-- It is granted to the counter as well as to management, because the
-- Secretary/Treasurer is the person a member asks "do I qualify yet?" while
-- paying in. Answering that is the whole point of a qualification clock.
--
-- ### Why creating an application is not `loans:create`
--
-- `loans:create` opens an ordinary application against a product the business
-- sells to anybody. A member-loan application additionally asserts that this
-- borrower is a member, under a named policy version, with a savings record
-- that supports the amount — a claim the database then re-checks at approval.
-- Holding `loans:create` says somebody may take a loan application; it does
-- not say they may bind the membership programme.
--
-- Withheld from the Secretary/Treasurer for the reason `clients:create` and
-- `membership:create` are: it commits the business to lend against member
-- savings. They hold the read.
--
-- ## What is deliberately *not* here
--
-- No `member_loans:approve`. See above: approval is `loans:approve`, and the
-- eligibility rules are enforced inside `validate_loan_for_approval()` so
-- that an approver who holds it still cannot approve an unqualified member.
-- A separate approval capability would let the business grant member-loan
-- approval to somebody it does not trust with lending, which is not a
-- distinction the programme makes.
--
-- No `member_loans:manage_policy`. The member interest basis, the method and
-- the savings multiplier are columns on `membership_policy_versions`, already
-- behind `membership:manage_policies` — the Owner's alone. A second
-- capability over the same columns would be a lock with two keys.
--
-- No `member_loans:pledge`. A savings pledge is a consequence of approval,
-- not an act somebody performs; see 20261021000800.
-- ===========================================================================

insert into public.permissions (key, description)
values
  ('member_loans:view_eligibility',
   'See whether a member qualifies for a member loan, the savings evidence behind the answer, and the ceiling their savings support.'),
  ('member_loans:create',
   'Open a member-loan application against a member''s savings record.')
on conflict (key) do update set description = excluded.description;

insert into public.role_permissions (role_key, permission_key)
values
  -- The counter. Answers "do I qualify yet?" and opens nothing.
  ('secretary_treasurer', 'member_loans:view_eligibility'),

  -- Runs member lending as they run lending.
  ('manager', 'member_loans:view_eligibility'),
  ('manager', 'member_loans:create'),

  ('owner_admin', 'member_loans:view_eligibility'),
  ('owner_admin', 'member_loans:create')
on conflict (role_key, permission_key) do nothing;

-- A borrower holds neither. A member reads their own loans through the
-- identity clause on `clients.profile_id`, which grants exactly their own
-- rows. Their own *eligibility* is deliberately not published to them at all
-- while the multiplier is undecided: a ceiling shown to a member is an offer,
-- and the business has not set the number that would make it one.
