# Business policy implementation audit

Source branch: `feat/polytos-policy-implementation`.
Baseline reviewed: `0157e74e7e17b1651d49f0aab893211930c200f2`.
Production base: `56b77e97fd776bd29dc10a5411e003a28f84774f`.

The initial branch contains seventeen policy migrations, database types and
fixture changes. It contains no corresponding application changes. This is
an implementation checkpoint, not a release approval or a completed delivery.

## Confirmed initial CI result

Run 40644455851: code/unit/build passed; database had 28 failures and 1,733
passes; browser failed during seeding, before tests began.

## Corrections in the first checkpoint

- Revoke anonymous execution of `loan_collection_period_total`.
- Preserve the branch predicate while hoisting caller lookups in new RLS policies.
- Mirror the six new capabilities and exact role grants in the application.
- Extend the exhaustive schema/security inventories for the new objects.
- Give old policy fixtures explicit cap modes and qualification bases.
- Give the browser harness its own policy version instead of colliding with
  the official, unapproved version 2.0.
- Supply real membership confirmations and a prior next-of-kin listing in
  death-benefit tests, rather than relaxing evidence rules.
- Read reversal journals when reconciling meeting fine income.
- Lock the transition batch during a member move and require verified consent.
- Include the policy migration prefix in the financial upgrade verifier.
- Express existing recorded cap/waiting decisions in the new policy vocabulary.
- Keep historical assessments intact while enforcing the new evidence
  constraints on future writes. The two new mandatory-evidence CHECKs are
  intentionally NOT VALID against immutable historical rows.

## Outstanding work

The official draft's assumed effective date still requires correction and
an explicit authorized timing decision. Further work remains on governing
policy integration, privileged reader authorization, concurrency, audited
workflows, server actions, interfaces, demo data and release evidence. The
medical ceiling decision and Phase 5 profit distribution remain unapproved.

No hosted project, hosted migration, production record, policy activation,
merge or deployment is part of this checkpoint. The managed execution
environment was pending during preparation; runtime verification must be
reported from CI and an isolated database, never inferred from code review.
