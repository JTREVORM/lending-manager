# POLYTOS — Agency Lock and Resource Matrix

**Phase:** 4C-S, Task 4.
**Enforced by:** `tests/db/agency-settlement.test.ts`, describe block
*"the lock and resource matrix"*. The table below is stated in the test, not
derived from the code, so a function that acquires **no** lock fails against
its row — an order-only check would have passed it in silence.

---

## The rule

A financially relevant function locks, in this order, **before it reads any
balance it is about to decide on**:

1. **`lock_agency_provider_balance(provider, branch)`** — for every
   provider-scoped resource it touches: the GL 1310 commission receivable and
   the 2200-series payables. Those accounts are **shared across providers**, so
   no account lock can protect one provider's share of them.
2. **`lock_ledger_balances([...])`** — for every **cash or float** account
   whose balance the entry changes, **in either direction**, sorted by account
   id inside the helper so two callers cannot take them in opposite orders.

Two clauses, and Phase 4C got the second one wrong in a specific way worth
naming: locks were acquired as a *side effect* of the sufficiency checks, and
sufficiency is only ever checked on the balance being drawn **down**. So every
account an entry *credited* went unlocked.

**Locking an account you debit does not stop somebody crediting it.**

### What is deliberately not locked

GL 1310 and the 2200-series accounts are **not** in any account-lock list.
There is no account-level rule on them — no sufficiency check, no floor —
because the figure that matters is one provider's balance at one branch, which
clause 1 protects. Locking them was over-serialisation: it made every
commission settlement in the business queue behind every other while
protecting nothing. Removed in 4C-S, with a test that two providers settling
into different accounts do not block each other.

---

## The matrix

| Function | Provider resource | Ledger accounts changed | Locks | Balance checks | Source type | Races against |
| --- | --- | --- | --- | --- | --- | --- |
| `post_agency_transaction` | 1310 receivable (accrual); 2200-series payable (bank model) | branch cash at hand; provider float **or** payable | provider → accounts | cash/float sufficiency; bank payable floor | `agency_transaction` | payable settlement, another withdrawal, both reconciliations |
| `reverse_agency_transaction` | 1310 receivable; payable | the same accounts, mirrored | provider → accounts (**both sides**) | commission outstanding; cash/float sufficiency on the contra | `agency_transaction_reversal` | commission settlement, commission correction, reconciliation |
| `record_commission_settlement` | 1310 receivable | branch cash at hand **or** bank | provider → receiving account | commission outstanding | `agency_commission_settlement` | transaction reversal, another settlement, cash reconciliation |
| `reverse_commission_settlement` | 1310 receivable | the receiving account | provider → receiving account | receiving account still holds the money | `agency_commission_settlement_reversal` | another settlement, transaction reversal, cash reconciliation |
| `post_agency_payable_settlement` | 2200-series payable | payable; branch cash or bank | provider → accounts | payable outstanding; cash sufficiency | `agency_payable_settlement` | bank withdrawal, another settlement, cash reconciliation |
| `reverse_agency_payable_settlement` | 2200-series payable | the same accounts, mirrored | provider → accounts | settlement is still posted | `agency_payable_settlement_reversal` | bank withdrawal, another settlement, cash reconciliation |
| `post_float_replenishment` | provider float position | provider float till; funding account | provider → accounts | funding account sufficiency | `agency_float_replenishment` | float reconciliation, a withdrawal drawing the same float |
| `approve_agency_float_reconciliation` | provider float position | provider float till; GL 5960 | provider → account | snapshot is not stale; float sufficiency on a surplus write-off | `reconciliation_adjustment` | any transaction or replenishment moving the same till |
| `approve_agency_cash_reconciliation` | **none** | branch cash at hand; GL 5950 | account only | snapshot is not stale; cash sufficiency on a shortage write-off | `reconciliation_adjustment` | any agency **or lending** posting moving the same till |
| `submit_agency_cash_reconciliation` | **none** | none (snapshots only) | account only | snapshots the balance under lock | *(no journal)* | any posting moving the same till |
| `submit_agency_float_reconciliation` | **none** | none (snapshots only) | account only | snapshots the balance under lock | *(no journal)* | any posting moving the same float till |

`approve_agency_cash_reconciliation` is the one row with no provider resource,
and the reason matters: a branch till is shared between agency work and
lending, and belongs to neither provider. It is reconciled as a whole, which
is why that row races against lending postings too.

## Completeness

The matrix is only a certification if nothing is missing from it. A second
test enumerates every function whose body reads
`agency_commission_outstanding()` or `agency_payable_outstanding()` and fails
if any of them is absent from the rows marked as holding a provider resource.
A function added later therefore fails the suite until somebody classifies it.

## Deadlock safety

One global order across two keyspaces: the provider lock first, then the
account locks, which `lock_ledger_balances()` sorts internally. No caller can
hold one and wait for the other in the opposite direction. The matrix test
also asserts the textual order in every function that takes both, so a later
edit that reverses them fails.

Verified behaviourally as well: a commission settlement and a float
replenishment on the same provider, issued on two connections, both complete
rather than one aborting on deadlock detection.
