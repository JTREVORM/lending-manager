# POLYTOS — Bank Agency Advance Model

**Status:** SPECIFICATION ONLY — deliberately **not implemented**.
**Phase:** 4B-S, decision K.
**Audience:** Product Owner, Finance, and whoever implements the model if it is approved.

---

## 1. Why this document exists

A bank agency transaction under the `cash_payable` float model moves cash
against a liability account in the 2200 series. A deposit collects cash from a
customer and credits the payable: POLYTOS now holds money on the partner
bank's behalf. A withdrawal pays cash out and debits the payable, releasing
what we hold.

If a withdrawal is allowed to debit past the balance held, the arithmetic
produces a negative liability. A negative liability is not a liability. It is
POLYTOS having advanced its own cash on the bank's behalf and now being owed
that cash back — a **receivable**, and a different financial instrument
altogether.

Phase 4B-S refuses that. `post_agency_transaction()` computes
`agency_payable_outstanding(provider, branch)` before paying out and raises if
the withdrawal exceeds it:

> Only 0 shillings are held on behalf of Example Bank, which is less than the
> 50000 this withdrawal would pay out. No approved bank-advance arrangement
> exists, so the payable may not go into net debit.

The floor is absolute. There is no flag, no override, no capability that
relaxes it. That is deliberate: a switch that exists but is not meant to be
used invites somebody to find out what it does. Enabling advances requires the
work specified below, reviewed and approved on its own merits.

**Attribution is per provider, not per account.** Account 2220 (Bank Agency
Payable) is shared by every partner bank, so an account-level balance would let
one bank's collections fund another bank's withdrawals. The outstanding figure
is therefore scoped to journal entries whose source is one of *that provider's*
own transactions or settlements.

---

## 2. What an approved advance actually is

An advance arrangement means the partner bank has agreed, in a signed
instrument, that POLYTOS may pay out more than it currently holds on that
bank's behalf, up to a limit, and that the bank will settle the shortfall
within an agreed period.

It carries, at minimum:

- a **counterparty** (one specific provider);
- an **exposure limit** in minor units;
- a **settlement period** (how long the bank has to clear the advance);
- an **effective** and **expiry** date;
- a **reference** to the signed instrument held outside the system;
- the **authority** under which POLYTOS accepted the risk.

None of that can be inferred from a transaction. It has to be recorded before
the first advance is permitted.

---

## 3. Accounting treatment

The current model never needs a receivable, because the floor forbids one.
Under an approved advance, the withdrawal splits at the point the payable runs
out:

Suppose 100,000 is held on the bank's behalf and an approved 500,000 limit
exists. A 300,000 withdrawal posts:

| Account | Dr | Cr | Meaning |
|---|---:|---:|---|
| 2220 Bank Agency Payable | 100,000 | | releases everything held |
| 13xx Agency Advances Receivable | 200,000 | | the bank now owes us this |
| 1010 Branch Cash | | 300,000 | cash paid out |

The receivable is a **new asset account in the 1300 series**, one per
provider or one shared with per-provider attribution by source, consistent
with how `agency_payable_outstanding` already attributes the liability. It must
not be posted into an existing receivable account used for member loans: GL
1200 is certified against the loan principal sub-ledger and an agency advance
there would break that certification.

The payable must never go negative even then. The split keeps both accounts on
their natural sides, which is what makes the exposure visible in the trial
balance rather than hidden as a sign.

Settlement reverses the split: the bank's transfer credits the receivable and
debits bank/cash, and any shortfall remaining after the settlement period is an
impairment question for Finance, not an agency question.

---

## 4. Exposure limit enforcement

The limit has to be enforced where the money moves, inside
`post_agency_transaction()`, under the same advisory lock discipline that
`lock_ledger_balances()` already provides — otherwise two concurrent
withdrawals each see headroom and together exceed the limit. Phase 4B-S proved
this class of race against cash and float and closed it; an advance limit is
the same shape of check and needs the same treatment.

The check is: `outstanding_payable + available_advance_headroom >= payout`,
where headroom is `limit - current_receivable` for that provider and branch,
evaluated after the lock is taken, not before.

An expired or inactive arrangement contributes zero headroom. The existing
provider readiness gate (`is_provisional = false AND is_active = true`) stays
in force on top of it and remains fail-closed.

---

## 5. Authorization

Accepting credit exposure to a partner bank is not a counter decision and not
a branch decision. Recording or amending an arrangement should require a new
capability at owner level — the pattern `agency:commission_exception` already
establishes in Phase 4B-S, which is granted to `owner_admin` only — and every
create, amend and deactivate must write an append-only audit row carrying the
reason and the external instrument reference.

Paying out *against* an existing arrangement is ordinary counter work and needs
no extra authority beyond the existing verification roles, because the risk was
accepted when the arrangement was signed, not when the cash left the till.

---

## 6. Implementation checklist, if approved

1. New `agency_advance_arrangements` table: provider, branch scope, limit,
   settlement period, effective/expiry dates, instrument reference, status,
   `created_by`, with `on delete restrict` foreign keys and no `numeric`
   columns (bigint minor units only).
2. New 1300-series receivable account(s), wired under the existing asset
   heading in a separate `UPDATE` (a multi-row `INSERT` cannot see a heading it
   creates in the same statement).
3. `agency_advance_outstanding(provider, branch)` and
   `agency_advance_headroom(provider, branch)`, both `security definer`,
   `search_path = ''`, revoked from `public, anon, authenticated`, attributed by
   source exactly as `agency_payable_outstanding` is.
4. Amend the payable floor in `post_agency_transaction()` to the split posting,
   taking `lock_ledger_balances()` over both the payable and the receivable
   before reading either.
5. `agency:advance_manage` capability, `owner_admin` only; audit action
   `advance_arrangement` added to `agency_audit_action_valid` and to the
   reason-required list.
6. RLS policies in the hoisted form the repository enforces
   (`tests/db/rls-hoisting.test.ts`), with the Head Office branch rule.
7. Tests: exact-value regression over the split posting; limit enforced at the
   boundary and one shilling past it; concurrent withdrawals against one limit;
   expired and inactive arrangements contributing zero headroom; cross-branch
   refusal via `agency_locked_transaction`; settlement clearing the receivable;
   trial balance still balancing after each.
8. Security baseline, generated types and the migration inventory refreshed;
   the financial reconciliation harness extended so the receivable is part of
   the certified identity rather than an unreconciled asset.

---

## 7. Until then

The floor stands. A partner bank that needs same-day liquidity before its
collections arrive must pre-fund, exactly as a `provider_float` provider does.
