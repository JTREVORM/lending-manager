# POLYTOS — the cash cutover, before Decision A binds on live money

**Prepared on the Owner's instruction of 2026-11-17**, which required this
before any future financial activation: *"signed cash counts for each till,
bank confirmations for every account and an Owner-approved verified opening
position."*

**Status: NOT STARTED. Nothing in this document has been performed.** No
migration has been applied to production Supabase, no deployment made, no
provider or membership policy activated, and no production financial
transaction created. This is a checklist to be worked through by people, not
a record of work done.

---

## 1. Why a migration cannot do this, and this document exists instead

Decision A measures every payout against **available funds**: an account's
booked balance less every receipt no second officer has confirmed. For that to
mean anything on day one, the opening position has to be true.

The migrations take **"no restriction recorded" to mean "available"**. That
choice is deliberate and it is what guarantees the upgrade moved nothing: the
membership upgrade gate reports all 28 financial figures identical across the
change, journal totals included. Every shilling already in the books on
cutover day is therefore treated as spendable.

**That is an assumption about the past, not a measurement of it.** It says
nothing about whether the cash the ledger claims is physically in the drawer.
If a till is short on cutover day, Decision A will faithfully authorise
payouts against money that is not there — because nothing told it otherwise.

So the control is only as good as the opening count, and the opening count is
a human act: opening a drawer, counting notes, signing for the figure. No
migration can perform it and this one does not pretend to.

---

## 2. Before the day

| | Step | Who | Evidence to keep |
| --- | --- | --- | --- |
| 2.1 | Freeze the list of cash accounts that will be in use, per branch: till, each mobile-money wallet, each bank account. Decision A adds a `1050 Cash in Transit` per branch; it must open at **zero**. | Owner | The signed account list |
| 2.2 | Name, in writing, the officers who hold `receipts:confirm` and `deposits:verify` at each branch, and **at least two per branch**. A branch with one such officer cannot clear its own deposits: the rule that the verifier may not be the recorder will stop it, correctly, and the branch will be unable to bank cash. | Owner | The signed authorisation list |
| 2.3 | Confirm each branch has somebody who can count a drawer who did **not** take the money in. Where a branch is one person, decide in advance who covers it — this is a staffing decision the software will enforce, not advise. | Owner | Written cover arrangement |
| 2.4 | Agree the cutover date and a cash cut-off time, after which no receipt is taken until the opening position is signed. | Owner | Dated instruction to branches |
| 2.5 | Decide the treatment for a bank deposit the bank never acknowledges — **blocker B-1**. Until this is decided, an unresolved deposit stays `under_investigation` and posts nothing, by design. That is safe but it is not closure: transit will accumulate items nobody can age, recover or write off. | Owner, with the accountant | A written accounting instruction |

---

## 3. On the day — the count, per account

One row per cash account, per branch. **Every line needs two signatures**: the
officer who counted and a different officer who witnessed it. One signature is
not a count; it is an assertion.

| | Step | Who | Evidence to keep |
| --- | --- | --- | --- |
| 3.1 | Count the physical cash in each till. Record denominations, not just a total. | Cashier + witness | Signed count sheet per till |
| 3.2 | Compare the counted figure to the ledger's booked balance for that account. | Manager | The comparison, signed |
| 3.3 | Where they differ, **record the difference and its explanation before anything is signed off.** A difference reconciled after the fact is not reconciled. | Manager | Written variance note |
| 3.4 | For each mobile-money wallet, take the provider's own balance at the cut-off and compare it to the ledger. | Manager | Provider statement or screenshot, timed |
| 3.5 | For each bank account, obtain the **bank's own confirmation** of the balance at the cut-off — a statement or a letter, not an internal figure. | Manager | The bank's document |
| 3.6 | Confirm `1050 Cash in Transit` is zero for every branch, and that no cash is physically in motion at the cut-off. If any is, hold it and count it into a till instead. | Manager | Signed nil return per branch |

---

## 4. The opening verified position

| | Step | Who | Evidence to keep |
| --- | --- | --- | --- |
| 4.1 | Assemble one schedule: every cash account, its counted or bank-confirmed figure, its ledger figure, and any difference with its explanation. | Manager | The schedule |
| 4.2 | Resolve every difference, or have the Owner accept each one explicitly and in writing. **An unexplained difference must not be carried into the opening position.** | Owner | Signed acceptances |
| 4.3 | **Owner approves the opening verified position**, by account, by signature and date. This is the figure Decision A will treat as available from that moment. | Owner | The signed opening position |
| 4.4 | Record where the signed documents are held, and who may produce them. | Owner | Filing note |

---

## 5. Only then

| | Step |
| --- | --- |
| 5.1 | Apply the migrations to production Supabase. |
| 5.2 | Deploy. |
| 5.3 | Reconcile the first day's close against the signed opening position before the second day opens. If the first close does not reconcile, the opening position was wrong and the cutover should be re-done rather than argued with. |

Steps 5.1 and 5.2 remain **prohibited** until the Owner lifts the production
restriction separately. Nothing in this document authorises them.

---

## 6. What this does not cover

- **Membership policy approval.** Both versions are drafts and the membership,
  savings, member-lending, benefits and meeting-fine modules correctly refuse
  to run. Unrelated to cash, and still outstanding.
- **Provider activation.** All ten real providers are provisional and cannot
  post. Each needs its float, commission and settlement arrangement confirmed
  against its own contract.
- **The six open policy decisions**, ranked in §J of the certification report.
- **Blocker B-1**, which §2.6 above asks to be decided before cutover because
  transit will otherwise accumulate items with no treatment.

---

## 7. The one-line test of whether this was done properly

On the morning after cutover, for every cash account, somebody can produce a
signed piece of paper stating what was counted, who counted it, who witnessed
it, and what the Owner approved as the opening figure — and that figure equals
the account's booked balance in the ledger.

If that is not true for even one account, Decision A is authorising payouts
against a figure nobody verified, which is the condition it was built to end.
