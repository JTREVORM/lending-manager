# Polytos savings — the module

Six tables, three views, three reporting functions, eleven posting and
lifecycle functions, seven capabilities — added by fourteen migrations
numbered `20261020000100`–`20261020001400`.

Nothing existing was altered destructively: no column was dropped, no
constraint relaxed, no policy widened, and no row of financial history
touched. One Phase 1 function was **replaced** —
`accept_membership_policy_version` — because leaving the old signature beside
the new one would leave a second, weaker door into the same room.

---

## 1. The one thing to get right

A member pays UGX 50,000 into their savings. There are two
plausible-looking postings:

```
  Debit  Cash at Hand               50,000
  Credit 4xxx Savings Income        50,000     -- wrong
```

```
  Debit  Cash at Hand               50,000
  Credit 2100 Member Savings        50,000     -- right
```

The first is wrong in a way that is **invisible on every screen**. The
member's balance is there, their statement reads correctly, the register is
right, the receipt is right. Nothing a counter or a member would ever look at
reveals it. What it does is overstate the year's surplus by the entire savings
book — and Phase 5 distributes that surplus, so the business would pay a
profit share out of its members' own deposits and find out when the deposits
could not be returned.

So: **a deposit increases a liability.** It is not revenue, the business does
not own it, and it will be asked for back. See ADR-051.

The registration fee is the opposite and the distinction is worth keeping
straight: `4340 Membership Registration Fees` **is** income, because the fee
buys membership and is not returned.

---

## 2. Entity relationships

```
          memberships ─────────────► membership_fee_receipts
         (Phase 1)   membership_id   (one posted receipt per membership,
              │       RESTRICT        by partial unique index)
              │                              │ journal_entry_id
              │ membership_id                ▼
              │ UNIQUE                  journal_entries
              ▼
        savings_accounts ──────► savings_withdrawal_requests
       (one per membership,  │    (one live request per account,
        no balance column)   │     by partial unique index)
              │              │            │ paid_transaction_id
              │              │            │ (deferred-safe: see §6)
              │ savings_account_id        ▼
              ▼                    savings_transactions
        savings_transactions ◄───────────┘
        (append-only subledger)
              │  reverses_transaction_id (self, one reversal per original)
              │  journal_entry_id ──────► journal_entries
              ▼
        member_savings_balances          (view: sum(signed_amount))
        member_savings_contributions     (view: per calendar month)
        savings_account_register         (view: account + member + branch)

        memberships ─────────► membership_cards
                 │              (one active per membership;
                 │               superseded_by is DEFERRABLE)
                 │
                 └───────────► membership_consent_challenges
                                (one live per membership+version;
                                 holds a digest, never the code)
```

### Why one account per *membership*, not per client

A client has at most one live membership, so for anybody currently a member
the two are the same. They differ for somebody who left and came back — and
`savings_accounts.membership_id` is unique precisely so a rejoining member
does not inherit the qualification they did not serve. See ADR-054.

---

## 3. There is no stored balance

`savings_accounts` has no `balance` column. The balance is
`sum(signed_amount)` over `savings_transactions`:

```sql
signed_amount bigint generated always as (
  case kind
    when 'deposit'             then amount
    when 'withdrawal_reversal' then amount
    else -amount
  end
) stored
```

Generated and stored, so the direction of a movement is not a field anybody
sets. A stored balance would be a second figure that can disagree with the
first, and the one that disagrees is always the one on screen. See ADR-052.

The consequence that matters operationally: **a balance check is only worth
anything inside the posting function, under the account's row lock.**
`request_savings_withdrawal` checks it, and `post_savings_withdrawal` checks
it *again* — so a deposit reversed between the approval and the counter stops
the payment rather than taking the account negative.

---

## 4. The money paths

Each writes its document and its journal entry in **one transaction**, and
each is idempotent on a key the server mints when the form renders
(ADR-030).

| Function | Debit | Credit |
| --- | --- | --- |
| `record_membership_fee` | branch cash / MTN / Airtel / bank | `4340 Membership Registration Fees` |
| `reverse_membership_fee` | `4340` | the account the money landed in |
| `post_savings_deposit` | branch cash / MTN / Airtel / bank | `2100 Member Savings` |
| `post_savings_withdrawal` | `2100 Member Savings` | branch cash / MTN / Airtel / bank |
| `reverse_savings_transaction` | every leg of the original, the other way round | |

### The posting order inside each function

The row id is minted first, the journal is posted naming it as `source_id`,
and *then* the row is inserted carrying its `journal_entry_id`:

```sql
v_txn_id   := pg_catalog.gen_random_uuid();
v_entry_id := public.post_journal(..., source_id => v_txn_id, ...);
insert into public.savings_transactions (id, ..., journal_entry_id)
values (v_txn_id, ..., v_entry_id);
```

Not insert-then-update. The subledger is append-only, so the UPDATE would be
refused — and suspending the trigger to allow it takes an `ACCESS EXCLUSIVE`
lock on the whole table, which would serialise every deposit in the business
behind every other and block readers too. `journal_entries.source_id` carries
no foreign key precisely so this ordering is available.

### Idempotency, and where the capability check goes

The capability check sits **above** the replay lookup, not below it. The early
return hands back a document id, which is a read — so a caller who may not
post must not be able to reach one by replaying a key. See ADR-056; this was a
real defect, found by a test written from the attacker's side.

---

## 5. Contributions and qualification

### A month

`member_savings_contributions` sums deposits per calendar month in
Africa/Kampala, from `contribution_month` — a generated column stamped from
`value_date`, which the posting function takes from `business_date()`. Several
deposits in a month accumulate towards that month's minimum, which is how a
member who cannot find UGX 50,000 at once still makes the month.

A **reversal is attributed to the month of the deposit it corrects**, not the
month it was made in. A deposit posted in March in error and reversed in July
stops counting for March; it does not make July negative. Qualification is
about what was saved in a month, and a correction says the saving did not
happen then.

A withdrawal does not appear here at all: it reduces the balance, not what was
contributed.

### Qualification, as of a date

`member_savings_qualification(account, as_of)` filters every transaction on
`value_date <= as_of`. So the answer to "did this member qualify on 1 June"
cannot be changed by a deposit made in July — which is what Phase 3 needs,
because it will approve member loans against this with the application date
and the snapshot it took has to stay the snapshot it took.

Both arms of the consecutive rule are implemented, and **neither is a
default**. Where `qualifying_months_consecutive` is still undecided the
function refuses to call anybody qualified and says so, rather than picking
the lenient reading — because a member shown as qualified under a rule nobody
approved is a loan approved on a guess.

---

## 6. The withdrawal lifecycle

```
  pending ──► approved ──► paid
     │           │
     │           └──► cancelled
     ├──► rejected
     └──► cancelled
```

Three acts by at least two people, and the separation is a control rather than
a label:

- `request_savings_withdrawal` — `savings:request_withdrawal`. Checks the
  account, the membership, the balance and the policy's rule about live loans.
  Decides nothing.
- `decide_savings_withdrawal` — `savings:approve_withdrawal`. **Refuses a
  decision from the person who prepared it**, so the split holds even for a
  Manager who holds both capabilities. A rejection must say why; an approval
  need not, because the request is its own justification.
- `post_savings_withdrawal` — `savings:post_withdrawal`. Re-checks the balance
  under the row lock. This is the one that moves money.
- `cancel_savings_withdrawal` — rides on `savings:request_withdrawal`, because
  cancelling is withdrawing a request.

A paid request and the transaction that paid it reference **each other**, both
with RESTRICT. Neither table can be deleted first, which is deliberate: a
payment cannot be unlinked from its request. The test teardown unlinks the
request side (returning it to `approved`) because the subledger refuses UPDATE
as well as DELETE.

### Where the policy is undecided, the operation is refused

Under `savings_withdrawal_with_active_loan = 'above_pledged'` a member holding
a live loan may withdraw "the excess over what secures the loan". How much
that is depends on the savings-to-loan multiplier, which the client has not
decided. So the function **refuses with a message naming what has to be
settled** rather than inventing a pledged amount — which would be inventing
the member's security.

---

## 7. Consent that can be checked

Phase 1 recorded a typed signature name and a typed witness name. Anybody with
the form could type anybody's name, so the record was indistinguishable from
one the member signed.

The caller now supplies the **method and its evidence**; the database decides
the **verdict**. `membership_terms_acceptances_guard` starts at `unverified`
and each branch has to earn `verified`:

| Method | What the database checks |
| --- | --- |
| `member_portal` | the session is the member's own, via `clients.profile_id` |
| `one_time_code` | a live, unspent challenge for this membership *and* this policy version, consumed in the same transaction |
| `signature_document` | the object exists in `storage.objects`, under this membership's own path |
| `witnessed_in_branch` | the witness is an active profile, and is not the recorder |
| `legacy_typed_name` | refused for a new acceptance; labels Phase 1's rows honestly |

A one-time code is stored only as a `sha256` digest, and
`consent_evidence_digest` is revoked from `authenticated` as well as `anon` —
a caller who could compute digests at will could search for the code matching
a stored one. The code is returned to its issuer **once** and exists nowhere
afterwards.

`evidence_digest` is unique, so the same evidence cannot be replayed for a
second acceptance. See ADR-055.

### Enrolment offers one method, and that is a consequence not a shortcut

`enrol_member` creates the membership. A code is bound to a membership and a
signature is stored under one, and a portal confirmation needs the member's
own session — so at the enrolment screen only `witnessed_in_branch` has
evidence that can exist yet. The other three are offered on the membership
record, where the membership exists, and the screen says so and names the
alternative.

---

## 8. Activation: the ADR-050 preconditions, now enforced

`memberships_guard_transition` refuses `pending -> active` unless **both**
hold:

- `membership_fee_is_posted(membership)` — a receipt exists, its status is
  `posted`, and the journal entry behind it is **not reversed**. The check
  joins the journal, because "successfully posted" has to mean the ledger
  carries it.
- `membership_terms_are_accepted(membership)` — a `verified` acceptance of the
  membership's **own** policy version exists. An acceptance of an earlier
  version activates nobody.

Both are checked **above** the trusted-path exemption, so they bind
`service_role` and a direct owner connection as well as a browser session. A
rule that only stops a session is one a leaked service key walks through.

`enrol_member` does the whole thing in one transaction — membership, fee,
journal, consent, activation, savings account, optional first deposit — or
rolls all of it back. The two states this business cannot afford are a member
who paid and is not active, and a member who is active and did not pay, and
there is no point between them at which the transaction can be left.

---

## 9. Row Level Security

The boundary, as always. Four conventions carried from Phase 1 and all
load-bearing here:

- **Every capability call is wrapped in a scalar subquery** —
  `(select public.user_has_permission('savings:view'))` — so it plans as an
  InitPlan evaluated once per statement rather than once per candidate row.
  `tests/db/rls-hoisting.test.ts` fails the build on a bare call.
- **The branch rule is restated, not called.** `user_can_see_branch` is
  correlated *and* SECURITY DEFINER, so PostgreSQL can neither hoist nor
  inline it.
- **`current_profile_id()` resolves only active profiles**, which is what makes
  suspending an account take effect on the next request.
- **`authenticated` holds no privilege until granted, per operation** — and
  `revoke all ... from anon, authenticated` runs *before* every grant, because
  `CREATE TABLE` in this database inherits default privileges that hand
  `authenticated` everything including DELETE and TRUNCATE. The exhaustive
  grant inventory in `tests/db/security.test.ts` is what caught the first
  draft of this phase granting exactly that.

| Relation | `authenticated` holds |
| --- | --- |
| `membership_fee_receipts` | SELECT |
| `savings_accounts` | SELECT, UPDATE (status only, via the guard) |
| `savings_transactions` | SELECT |
| `savings_withdrawal_requests` | SELECT |
| `membership_cards` | SELECT |
| `membership_consent_challenges` | *nothing at all* |
| the three views | SELECT |

Everything is written by a SECURITY DEFINER function that wrote a journal entry
in the same transaction. A receipt inserted directly would be a receipt with
no money behind it; a transaction inserted directly would be money the ledger
does not know about.

### What a member may see

Their own savings account, their own transactions, their own withdrawal
requests, their own fee receipt and their own card — through the identity
clause on `clients.profile_id`, exactly as a borrower reads their own client
record. They hold no savings capability, so the register is closed to them by
the same predicate that opens it to staff.

They may **not** deposit to their own account. The money has to arrive at a
counter before a record of it should exist.

### Reporting functions

| Function | Mode | Why |
| --- | --- | --- |
| `savings_statement` | INVOKER | reports one member; the policies decide |
| `member_savings_qualification` | INVOKER | same |
| `savings_summary` | DEFINER | reports the business; no row to filter, so it checks `savings:view_reports` itself |

All three were definer in the first draft, which meant any signed-in caller
could read any member's full statement by passing an account id. See ADR-057
for the rule this settled.

---

## 10. Capabilities

| Capability | Secretary | Manager | Owner |
| --- | --- | --- | --- |
| `savings:view` | ✓ | ✓ | ✓ |
| `savings:deposit` | ✓ | ✓ | ✓ |
| `savings:request_withdrawal` | ✓ | ✓ | ✓ |
| `savings:approve_withdrawal` | | ✓ | ✓ |
| `savings:post_withdrawal` | | ✓ | ✓ |
| `savings:view_reports` | | ✓ | ✓ |
| `savings:reverse` | | | ✓ |

A member holds none of them.

`savings:reverse` is the Owner's alone, for the reason `payments:reverse` is:
the person who records money must not be the person who can withdraw the
record. It also gates changing a savings account's status, rather than
inventing an eighth capability for a workflow this phase does not ship.

There is deliberately **no** `savings:close_account` and no
`membership_fees:*`. Closing is a status change on the account, behind
`savings:reverse`; the fee rides on `membership:create`, because collecting it
is part of enrolling somebody.

---

## 11. Screens

| Route | Capability | What it is |
| --- | --- | --- |
| `/membership/enrol` | `membership:create` | the one-submission enrolment |
| `/membership/{id}` | `membership:view` | fee, consent, savings and card panels |
| `/savings` | `savings:view` | the register, with the liability panel |
| `/savings/{id}` | `savings:view` | balance, progress, statement |
| `/savings/{id}/deposit` | `savings:deposit` | the counter's most-used screen |
| `/savings/{id}/withdraw` | `savings:request_withdrawal` | prepare, for somebody else to decide |
| `/savings/{id}/statement` | `savings:view` | a period, to print or hand over |
| `/savings/withdrawals` | `savings:approve_withdrawal` | a Manager's queue |
| `/savings/withdrawals/{id}` | `savings:approve_withdrawal` | decide, pay or cancel |
| `/portal` | `portal:view` | a member's own savings, no controls |

`/savings/withdrawals` is listed **before** `/savings` in the route
requirement table. Matched the other way round the longer path would inherit
the shorter one's requirement, and the queue of decisions would open to a
Secretary who may prepare a withdrawal but not decide one.

The deposit and enrolment forms are both two-step, with step one unmounted
while step two shows — so every value is carried as a hidden field. That is
the exact shape of the Phase 9 defect in which no payment could be recorded at
all, which is why `tests/e2e/specs/savings.write.spec.ts` presses the buttons
in order in a real browser.

---

## 12. Tests

| Suite | Tests | What it proves |
| --- | --- | --- |
| `tests/db/membership-enrolment.test.ts` | 25 | the ADR-050 preconditions, and that consent cannot be asserted |
| `tests/db/savings.test.ts` | 31 | the liability direction, append-only, the lifecycle, reversal, the statement, reconciliation |
| `tests/db/rls-savings.test.ts` | 24 | the four roles, forged ids, direct function execution, replayed keys |
| `tests/db/demo-seed.test.ts` | 18 | the seeder's refusals, and that running it three times changes nothing |
| `tests/unit/savings.test.ts` | 47 | the vocabulary matches the constraints; the arithmetic matches the database; and the regression for the month-finding bug |
| `tests/unit/savings-validation.test.ts` | 39 | the edge, including the fields that are deliberately absent |
| `tests/e2e/specs/savings.spec.ts` | 35 | the screens render, at both viewports, to the right people |
| `tests/e2e/specs/savings.write.spec.ts` | 13 | a deposit, an enrolment and a withdrawal, by pressing the buttons |

Two defects in this phase were found only by tests written from the attacker's
side, and both are worth knowing about because the same mistake is easy to
make again:

1. **Three posting functions replayed an idempotency key before checking the
   caller's capability** (ADR-056), so a caller who may not post could be
   handed the id of somebody else's movement.
2. **Three reporting functions were SECURITY DEFINER with no authorisation
   check** (ADR-057), so any signed-in caller could read any member's full
   savings history.

Neither is visible from a unit test, from a type, or from reading the function
and asking whether it looks right. Both needed a test that asked "what does
somebody with a valid token and a copy of curl actually get?"

---

## 13. What this phase does not do

Named, because a screen that implied otherwise would be the worst defect this
phase could ship:

- **No benefit claims.** The medical benefit's annual cap, how many claims a
  year it allows and any waiting period are all undecided.
- **No profit sharing.** The distribution formula is undecided.
- **No member loans.** Phase 3. `member_savings_qualification` is the
  interface it will approve against.
- **No membership status screen.** Suspending or withdrawing a membership is a
  lifecycle write whose screen belongs to a later phase; the record states
  what the lifecycle permits next as a sentence rather than as buttons.
- **No savings account closure workflow.** The status column and its guard
  exist; the screen does not.
- **No withdrawal against a live loan under `above_pledged`.** Refused with a
  message naming the rule that has to be settled, rather than guessed.

See `docs/POLYTOS-MEMBERSHIP-POLICY-DECISIONS.md` for the full list of
outstanding client decisions and which activity each one holds up.
