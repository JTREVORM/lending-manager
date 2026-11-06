# F1 — Capability refusals are classified as business-rule violations

**Status:** documented, not corrected. Observability defect; **not** a security
defect.
**Raised:** Phase 3 financial certification (finding F1).
**Re-measured:** Phase 4, Task 0, against the 171-migration schema.
**Owner decision required** before the correction in §4 is applied.

---

## 1. What is wrong

A PostgreSQL function refusing a caller for lack of a capability should raise
SQLSTATE `42501` (`insufficient_privilege`). Most of POLYTOS raises `P0001`
(`raise_exception`) instead, which the application maps to a *business-rule*
error rather than an *authorization* error.

`lib/db-errors.ts` is unambiguous about the mapping:

| SQLSTATE | Constant | Mapped to |
| --- | --- | --- |
| `42501` | `INSUFFICIENT_PRIVILEGE` | `AuthorizationError` — "Privilege denied on {resource}." |
| `P0001` | `RAISE_EXCEPTION` | `BusinessRuleError` — the database's own message, passed through |

## 2. The measurement

Counted over every `public` function whose body mentions a capability, on the
171-migration schema, by **refusal statement** rather than by function — a
single function often carries several refusals:

| | Count |
| --- | --- |
| Capability-refusal `raise exception` statements | **102** |
| …raising `42501` → `AuthorizationError` | **15** |
| …raising `P0001` → `BusinessRuleError` | **87** |
| …raising no `errcode` at all → `BusinessRuleError` | 0 |
| **Share misclassified** | **85%** |

Phase 3 reported "32 functions raise `42501`; 67 do not". Both are right about
different things: 32 *functions* contain a `42501` somewhere, but only 15 of the
102 individual *capability refusals* use it. Counting statements is the figure
that matters, because it is the per-denial classification that reaches the
caller. The share is therefore worse than Phase 3's "roughly two thirds".

`assess_member_loan_eligibility` sets `P0001` explicitly rather than by
omission, so this is in part a deliberate split rather than pure oversight.

## 3. Why it matters, and why it is not a security defect

**Every refusal works.** Phase 3's `tests/db/financial-authorization.test.ts`
proves 24 of them with before/after state and audit comparison: the call is
refused, no document or ledger row moves, and the audit trail gains nothing.
Nothing here lets an unauthorized caller move money.

What is lost is **observability**:

- Anything counting authorization failures sees 15% of them.
- An attacker probing, say, transfer approval is indistinguishable in the logs
  from a user hitting a validation rule.
- Alerting on `AuthorizationError` cannot be used as a privilege-abuse signal.

## 4. Why it was not corrected, and how to correct it safely

Adding `using errcode = '42501'` to a refusal **changes what the user reads.**
Two call sites pass the database's own message through to the user, keyed on
`P0001` specifically:

- `lib/clients/actions.ts:672` — `if (error.code === 'P0001' && ...)`
- `lib/guarantors/actions.ts:376` — same test

Under `42501`, `lib/db-errors.ts` returns the generic `AuthorizationError`
"Privilege denied on {resource}." So a refusal that today tells the user
*"Disbursing a loan requires the loans:disburse capability."* would instead say
*"Privilege denied on loans."* That is a regression in a user-facing message,
across far more surface than one phase should move.

**The correction, in the order that preserves behaviour:**

1. **First**, widen the passthrough. In both call sites above, accept `42501`
   alongside `P0001` when a database message is present, so the specific text
   survives the reclassification. No SQL changes in this step; nothing observable
   changes yet.
2. **Then**, in one migration per subsystem, add `using errcode = '42501'` to
   capability refusals only — never to validation or state-machine refusals,
   which are genuinely business rules and must stay `P0001`.
3. **Then** assert it: a test that every capability refusal raises `42501`, so
   the split cannot reopen.
4. Leave `assess_member_loan_eligibility` until its deliberate `P0001` is
   re-decided on its own merits.

Step 1 is a prerequisite. Doing step 2 first is what makes this look like a
user-facing regression instead of an observability fix.

## 5. What Phase 4 does about it

Phase 4's new agency-banking functions are **not** bound by the legacy
coupling — no existing call site passes their messages through. They therefore
raise `42501` for capability refusals from the outset, and `P0001` for
business-rule refusals (insufficient float, wrong state, duplicate reference).
New code is on the correct side of this from the start, so the gap narrows
rather than widens while §4 remains an open decision.
