# POLYTOS — Phase 4B-S Security Closure Report

**Scope:** close the gaps an independent security review found in Phase 4B.
**Branch:** `phase4b/agency-transaction-engine-2026-11-07` (PR #23), commit
history preserved, nothing force-pushed.
**Authorization:** draft only. Not merged, not deployed, no provider activated,
Phase 4C not begun. Production untouched.
**Migrations:** 186 on this branch, counted from the directory.

---

## 1. Cross-branch authorization (Task 1)

### Reproduced first

The Phase 4B lifecycle functions are `SECURITY DEFINER`, so they run as the
table owner and RLS does not apply to them. Each one looked up its transaction
by id and checked only that a row came back. The `SELECT` policy on
`agency_transactions` was never consulted, because policies do not run for a
definer function — which is the whole privilege-escalation risk one carries.

A manager at branch B was given branch A's transaction id. Of eight
operations, **seven succeeded**: submit, return, verify-and-post, cancel,
update, reference correction and reversal. A plain `SELECT` of the same row
returned zero rows, which is exactly how the gap survived review — the data
layer looked correct.

Worse, the idempotency-key lookup **disclosed another branch's UUID**: reusing
a key already held by branch A returned A's transaction id to a caller at B.

### Closed

One gate, not seven. `agency_locked_transaction(uuid)` takes `for update` on
the row and then applies `user_can_see_branch()`, which encodes the Head Office
rule (a NULL branch sees all):

```sql
select * into t from public.agency_transactions
 where id = p_transaction_id for update;
if t.id is null or not public.user_can_see_branch(t.branch_id) then
  raise exception 'No agency transaction with that identifier is available to you.'
    using errcode = '42501';
end if;
```

Six duplicated lookup-and-check blocks were replaced by a call to it, so there
is one place to get this right rather than seven places to get it wrong.

The refusal is **identical** for a transaction in another branch and for an id
that does not exist, so it discloses nothing. The idempotency path refuses the
same way instead of returning the id.

**Result: 0 of 8 operations succeed cross-branch.** Eight tests assert the
SQLSTATE, the exact message, and — because a refusal that still wrote something
is not a refusal — that the transaction's state digest, the journal-entry count
and the audit count are all unchanged. Positive controls assert Head Office and
the owning branch still work, and that a same-branch idempotency retry still
returns its own transaction.

---

## 2. Concurrency on shared cash and float (Task 2)

### Reproduced first

`assert_cash_available` and `assert_agency_float_available` read a balance and
compared it. Two transactions reading the same balance concurrently both saw
enough. Proven: a float ended at **−20,000** and a till at **−24,000**.

`post_journal()` does serialize posting, because `next_reference('journal')`
locks a counter row — but it does so *after* the balance checks, so it ordered
the writes without preventing the overdraft.

Reproducing this honestly took three attempts. The first two hung: once on the
low-float notification's dedupe key, which both racers shared, and once on that
same reference counter. The race only reproduces if the two sessions are staged
— A holds, B blocks, A commits, B proceeds — and the low-balance thresholds are
zeroed so the notification does not collide.

### Closed

`lock_ledger_balances(uuid[])` takes a transaction-scoped advisory lock per
account, **sorted by account id**, so two callers touching the same pair of
accounts always take them in the same order and cannot deadlock:

```sql
for v_id in
  select distinct t.x from pg_catalog.unnest(p_account_ids) as t(x)
   where t.x is not null order by t.x
loop
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_id::text, 0));
end loop;
```

Both assertion helpers now take the lock **before** reading the balance. The
lock is per account, not global: transactions on different tills still run
concurrently, which two tests assert.

Because the helpers are shared, every other money-movement path — `record_transfer`,
`record_expense`, `record_other_income`, `submit_reconciliation` — gained the
same protection with no change of its own. The full database suite confirms no
regression from modifying them.

The reversal path pre-locks the cash and float accounts of the original entry,
sorted, before mirroring it.

**Result:** the second transaction is refused, quoting the balance *after* the
first committed — which is what proves the read happens after the lock, not
before it.

---

## 3. Bank agency payable floor (Task 3)

A `cash_payable` withdrawal debits the provider's liability. Past zero it stops
being a liability: it becomes the partner bank owing us for cash we advanced.
That is a real arrangement, but a **different financial instrument** with its
own accounting, exposure limit and authorization — and letting it appear as a
negative number in a payable account would be classifying it silently, which
the review specifically ruled out.

For this release the floor is **absolute**:

```
Only 0 shillings are held on behalf of Example Bank, which is less than the
50000 this withdrawal would pay out. No approved bank-advance arrangement
exists, so the payable may not go into net debit.
```

There is no flag, no override and no capability that relaxes it. A switch that
exists but is not meant to be used invites somebody to find out what it does.

**Attributed per provider, not per account.** Account 2220 is shared by every
partner bank, so an account-level balance would let one bank's collections fund
another's withdrawals. `agency_payable_outstanding(provider, branch)` sums
credits less debits over entries whose source is that provider's own
transactions or settlements.

Three exact-value regression tests: the withdrawal direction is `Dr 2220, Cr
cash` on its exact lines; exactly the balance posts and one shilling more is
refused quoting `Only 0 shillings are held`; and one bank's 400,000 of
collections does not fund another bank's 50,000 withdrawal.

The approved-advance model — receivable accounting in a new 1300-series
account, exposure limits enforced under the same lock discipline, and
owner-level authorization — is specified in
`docs/POLYTOS-AGENCY-BANK-ADVANCE-MODEL.md` and is **deliberately not
implemented**.

### One choice in this that is a business question, not a technical one

The outstanding figure is scoped **per branch as well as per provider**:
`where e.branch_id = p_branch_id`. So branch B cannot pay out against
collections branch A made for the same partner bank.

That is the conservative reading and it is what the tests assert, but it is
arguable. From a cash-custody standpoint it is right — the cash really is at a
particular branch, and the cash constraint is separate and already enforced.
From a liability standpoint the payable is owed to one bank by one business,
not by a branch, so an institution-wide pool would also be defensible.

Flagged as **new decision N** rather than settled quietly, because it changes
which withdrawals a branch may serve. Widening it later is a one-line change to
this function plus its tests; narrowing it later would invalidate postings
already made, which is why it ships narrow.

---

## 4. Commission discrepancies need authority (Task 4)

Phase 4B accepted an operator-supplied commission that differed from the
configured rate, posted it, and flagged it. Recognised commission is **income**,
so that let a counter officer increase recognised income by typing another
number.

Now a difference is **refused** unless it has been authorised:

- a new capability, `agency:commission_exception`, granted to **`owner_admin`
  alone** — declared in the database and in the application's permission
  matrix, which a test holds in step;
- `authorise_agency_commission_exception(id, reason, evidence)` requires it,
  works only before posting, refuses a transaction supplying no figure of its
  own, refuses one whose figure does not actually differ, and writes an
  append-only `commission_exception` audit row;
- reason, evidence and authoriser arrive together or not at all, by CHECK
  constraints.

Deliberately **two people**: the Owner authorises the difference, a Manager
still verifies the transaction. The posting path does not re-require the
capability from the verifier, because requiring it there would collapse the two
roles into one.

### A second hole, found while reviewing this work

The authorisation was a flag rather than a decision. `update_agency_transaction`
edits a draft and had no reason to clear the exception columns, so an Owner
could authorise a 1,800 difference and a counter could then edit the figure to
50,000 and submit it — posting a number nobody approved. A provider re-rating
between authorisation and posting drifted it the same way, with nobody touching
the transaction at all.

Both figures are now **pinned** at authorisation
(`commission_exception_amount`, `commission_exception_computed`) and
re-verified at posting; any drift refuses with *"The figures changed after the
authorisation, so it must be authorised again."* Two tests walk the exact
exploit paths and assert nothing posted.

---

## 5. Historical reversal safeguards (Task 5)

Phase 4B's readiness-gate exemption read `if new.status in ('draft',
'cancelled', 'reversed')`, which exempted far more than a correction: an INSERT
arriving already labelled `reversed`, and an UPDATE to `reversed` from any
state at all.

Narrowed to the one transition that is a correction:

```sql
if new.status = 'reversed' then
  if tg_op = 'UPDATE' and old.status = 'posted' then return new; end if;
  raise exception 'A transaction may only become reversed from a posted state.'
    using errcode = 'P0001';
end if;
```

Tests: a provider is deactivated, last week's posting is reversed behind it,
and the provider is asserted still inactive and still refusing new postings;
and `reversed` is refused from every other state. The contra entry is asserted
to mirror the original line for line.

---

## 6. Ledger integrity (Task 6) — and a correction

Task 6 asked for a compatibility and migration recommendation for a
transaction-safe debit = credit invariant covering every posting source.

**The invariant already exists, and Phase 4B reported otherwise.** A comment in
`20261108000200_agency_posting.sql`, the `post_agency_transaction()` function
comment, and PR #23's own description all state that *"every entry balances is a
test in this repository, not an invariant of the writer."* That is wrong, and
wrong in the direction that matters: it understated the ledger's protection.

`journal_assert_balanced()` has run since Phase 1 from two `DEFERRABLE
INITIALLY DEFERRED` constraint triggers, one on each ledger table. At commit,
every entry must have at least two lines and its debits must equal its credits.
Because the triggers sit on the **tables**, they bind every writer — the
application, `service_role`, a definer function, or a statement typed into
psql — and because they are deferred they tolerate the momentarily unbalanced
state that inserting lines one at a time necessarily produces.

What was true: `post_journal()` itself does not check. What was false:
everything after that.

**Recommendation: no migration and no ledger change.** The full evidence,
compatibility assessment and the two bypass probes are in
`docs/POLYTOS-LEDGER-BALANCE-INVARIANT-REVIEW.md`. Both wrong comments are
corrected in this branch, and `post_agency_transaction()`'s own balance
assertion is kept as a second line of defence — it fails at the point of
posting and names the transaction rather than a journal number.

21 new tests convert "the trigger covers this structurally" from an argument
into a check: for each of the five Phase 4 source types, an unbalanced entry is
refused naming the difference, a one-sided entry is refused, and a balanced one
is accepted; a momentarily unbalanced entry mid-transaction is tolerated with
the intermediate state asserted; both triggers are asserted to exist, on the
right tables, deferred; `authenticated` cannot disable them or set
`session_replication_role`; and no migration does either — a check that strips
SQL comments first, because two migrations discuss `disable trigger` precisely
to explain why they avoid it, and matching a comment would fail on correct code.

---

## 7. Verification (Task 7)

<!-- VERIFICATION_TABLE -->

---

## 8. What is deliberately not done

- No merge, no deployment, no production migration.
- No provider activated. All nine catalogue providers remain
  `is_provisional = true, is_active = false` with NULL rates; the posting path
  enforces `is_provisional = false AND is_active = true` at the database layer.
- Policy 2.0 not activated; no demo data deleted; no security gate bypassed.
- Phase 4C (settlement and reconciliation) not begun.
- The bank-advance model is specified, not built.
- Synthetic test rates only. No production provider term is invented anywhere.

## 9. Open decisions

**K is now closed** by the absolute payable floor, with the advance model
specified for separate approval. **M is now closed** by owner-only
authorization of commission differences.

**L remains open:** Phase 4A stores `requires_approval_above` per transaction
type and nothing reads it, so a 50,000 and a 50,000,000 transaction still need
the same authority. C, F, G, H and I remain open from Phase 4A.

**N is new and open:** should a bank agency payable be pooled across branches
or held per branch? It ships per branch, which is the narrower choice; see
section 3.

Two new items for consideration, both in the ledger review document: whether a
reversal's exact mirroring should become a database invariant rather than a
tested property, and whether source-type-to-account-class consistency belongs
in the reconciliation harness.

## 10. For review

Phase 4B-S is complete and returned for independent review. Nothing further
should be merged, deployed or activated, and Phase 4C should not begin, until
that review reports.
