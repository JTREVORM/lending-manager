# POLYTOS — Ledger Balance Invariant: Compatibility and Migration Recommendation

**Phase:** 4B-S, Task 6.
**Asked for:** a compatibility and migration recommendation, with tests, for a
transaction-safe debit = credit invariant applying to every posting source. No
unreviewed broad ledger change.
**Recommendation:** **no migration, and no ledger change.** The invariant
already exists, is already transaction-safe, and already binds every posting
source. What was missing was proof that it binds the sources Phase 4 added, and
protection against it being removed. Both are now tests.

---

## 1. A correction first

Phase 4B recorded, in a comment inside
`supabase/migrations/20261108000200_agency_posting.sql` and in the
`post_agency_transaction()` function comment, that:

> `post_journal()` does **not** check that debits equal credits. It has no such
> check and no constraint behind it […] "Every entry balances" is a *test* in
> this repository, not an invariant of the writer.

The first sentence is true. **The rest is wrong**, and wrong in the direction
that matters, because it understated the ledger's protection and would lead the
next reader to believe the books were guarded only by a test suite. Both
comments have been corrected in this branch.

---

## 2. What actually exists

`journal_assert_balanced(uuid)` has been in place since Phase 1,
`supabase/migrations/20261010000100_branches_and_ledger.sql`. It asserts three
things about an entry:

1. the entry has at least one line — *"An entry that posts nothing is not an
   entry."*;
2. the entry has at least two lines — *"A posting has at least two sides."*;
3. its debits equal its credits, naming the difference.

It runs from two constraint triggers:

| Trigger | Table | Events | Timing |
|---|---|---|---|
| `journal_entries_assert_balanced` | `journal_entries` | INSERT, UPDATE | `DEFERRABLE INITIALLY DEFERRED` |
| `journal_lines_assert_balanced` | `journal_lines` | INSERT, UPDATE, DELETE | `DEFERRABLE INITIALLY DEFERRED` |

Three properties follow, and they are exactly the three Task 6 asked for.

**It is transaction-safe.** Deferred to commit, so the momentarily unbalanced
state that inserting lines one at a time necessarily produces is allowed to
exist inside the transaction and refused at its boundary. An immediate check
could not work at all: it would reject every multi-line posting after its first
line.

**It binds every posting source.** The triggers sit on the tables, not inside
`post_journal()`. They therefore apply to the application, to `service_role`,
to a SECURITY DEFINER function running as the table owner, and to a statement
typed straight into psql. There are 26 source types in the live
`journal_entries_source_valid` constraint, five of them added by Phase 4, and
the invariant covers them without naming any of them.

**Nothing in the codebase writes around it.** `post_journal()` is the only
writer of `journal_entries` and `journal_lines` across all 186 migrations, and
no TypeScript in `lib/` or `app/` inserts into either table. So the invariant
would hold even if it were only inside `post_journal()` — but it is not, which
is what makes it durable against a future direct writer.

---

## 3. Compatibility assessment

| Question | Finding |
|---|---|
| Does any existing posting source produce an entry the invariant would reject? | No. Every entry in a migrated database balances; the certification harness re-checks this against a fully seeded book. |
| Are there zero-line or one-line entries in existing data? | None. |
| Does `post_journal()` ever create an entry with no lines? | It skips lines where debit and credit are both zero, so an all-zero line set would yield a line-less entry — which the **entries-side** trigger catches. This is why the invariant needs triggers on both tables, and it has them. |
| Would adding an immediate check break anything? | Yes, everything. Multi-line posting is unbalanced between line inserts by construction. Deferred is not a convenience, it is a requirement. |
| Is a migration required? | **No.** Zero schema change, zero behavioural change. |

---

## 4. Can it be stepped around?

The invariant is a trigger, not a row-level policy, so ownership does not
exempt anyone from it the way `SECURITY DEFINER` exempts a function from RLS.
Two vectors remain in principle, and both were probed:

| Vector | Result for `authenticated` |
|---|---|
| `ALTER TABLE … DISABLE TRIGGER` | Refused — `must be owner of table journal_lines` |
| `SET session_replication_role = 'replica'` | Refused — `permission denied to set parameter` |

The residual vector is a **privileged** session doing one of those two things —
a migration, or a superuser at the console. No migration does: the two files
that match a text search for it do so only in comments explaining why they
avoid it. That is now asserted by a test that strips SQL comments before
scanning, so it fails if a migration ever starts doing it rather than merely
discussing it.

This residual vector is not closable from inside the database by a database
owner, and it is the same vector that would let a privileged session drop any
constraint. It belongs to deployment controls, not to the schema.

---

## 5. Tests added

`tests/db/ledger-balance-invariant.test.ts`, 21 tests, in the `db` project
(rollback-only, commits nothing). They use `set constraints all immediate` to
force the deferred check at a chosen point inside a transaction that is then
rolled back, which raises exactly the error a commit would raise.

- The five Phase 4 agency source types are the five expected ones, read from
  the live constraint rather than hardcoded — so a sixth added later fails this
  test until it is considered.
- For **each** of those five source types, three tests: an unbalanced entry is
  refused naming the difference; a one-sided entry is refused naming the
  two-sides rule; a balanced entry is accepted. One test per source, so a
  failure names the source that escaped.
- A momentarily unbalanced entry mid-transaction is tolerated, with the
  intermediate 300,000-to-0 state asserted explicitly — this is the test that
  pins *transaction-safety* rather than mere presence.
- The two triggers exist, on the two expected tables, and are both
  `DEFERRABLE INITIALLY DEFERRED` constraint triggers. This fails if a refactor
  converts either to an ordinary trigger or drops one.
- `authenticated` cannot disable the triggers, and cannot set
  `session_replication_role`.
- No migration sets `session_replication_role` or disables a trigger, comments
  excluded.

`tests/db/ledger.test.ts` already proves the rule itself (balanced accepted,
difference named, one line refused, no lines refused, a two-sided line
refused), and `tests/db/agency-security-closure.test.ts` already proves a
reversal's contra entry mirrors its original line for line — the one
cross-entry property the per-entry invariant cannot see.

---

## 6. Recommendation

1. **Make no ledger change.** The invariant asked for is present, correct and
   stronger than the request (it also requires two sides). A broad change here
   would add risk to a certified ledger for no gain.
2. **Keep `post_agency_transaction()`'s own balance assertion.** It is
   redundant for correctness and useful for diagnosis: it fails at the point of
   posting rather than at commit, and names the agency transaction instead of a
   journal number. Its comment now says so instead of claiming the ledger is
   unguarded.
3. **Keep the new tests**, which are the actual deliverable: they convert
   "the trigger covers this structurally" from an argument into a check.
4. **Treat the privileged-session vector as a deployment control.** Recommend
   that production migrations are reviewed for `session_replication_role` and
   `DISABLE TRIGGER` — now enforced in CI by the test above — and that no
   application role is ever granted table ownership.

### If a stronger invariant is wanted anyway

For completeness, the two things the current invariant does *not* assert, with
their costs, for the Product Owner and ChatGPT to weigh:

- **That an entry's lines post to accounts appropriate to its source type.**
  This would need a source-to-account-class map and would couple the ledger to
  business classification; it is the kind of rule better placed in the
  reconciliation harness, where it can be reported on rather than refused.
- **That a reversal exactly mirrors its original.** Currently a tested property
  of `reverse_agency_transaction()` rather than a database invariant. Making it
  an invariant would need a deferred trigger comparing two entries through
  `reversed_by_entry_id`. Feasible, bounded, and genuinely a behavioural change
  — so not something to slip in under a security-closure phase.
