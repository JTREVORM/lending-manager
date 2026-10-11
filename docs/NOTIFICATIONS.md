# Notifications

What says *go and look*. Phase 15 of the platform upgrade; the evidence that
it was applied is in `UPGRADE-PHASE-6-REPORT.md`.

Everything in this system was already visible if somebody went and looked at
it. A loan awaiting approval is on the loan register, a cash variance is on the
reconciliation screen, a reversal is in the payment register. What the business
did not have was anything that said which of those had just happened — so an
application submitted on Friday afternoon waited until somebody opened the
right tab.

---

## 1. One row per event, addressed to an audience

The obvious design is a row per recipient: fan out to every Manager when a loan
is submitted. It is the wrong one here, for two reasons.

An event then exists as N rows that can diverge — one marked read, one deleted,
one left behind when a role changes — and there is no longer a single answer to
"what happened". And a staff member who joins on Monday gets no history of the
weekend, which for operational alerts is exactly backwards: the thing still
needs doing.

So a notification is recorded **once**, in `public.notifications`, and it names
the **capability** that may read it. "A loan is awaiting approval" is addressed
to whoever approves loans, which is a role rather than a person.

Two optional narrowings handle the rest:

| Column | When it is set | Effect |
| --- | --- | --- |
| `audience_permission` | always | A reader must hold this capability. |
| `audience_profile_id` | rarely | Only this person sees it. |
| `audience_branch_id` | where the event belongs to a branch | Only readers who may see that branch. |

The policy is those three, each independent and two of them optional:

```sql
public.user_has_permission('notifications:view')
and public.user_has_permission(audience_permission)
and (audience_profile_id is null
     or audience_profile_id = public.current_profile_id())
and (audience_branch_id is null
     or public.user_can_see_branch(audience_branch_id))
```

`audience_permission` is a **reference** to `public.permissions(key)`, not free
text. A typo would otherwise produce a notification nobody can ever read — and
that nobody can ever notice is unreadable.

### The one category addressed to a person

A refusal or a withdrawal names the staff member who submitted the application.
They are the one who has to tell the borrower, and they should not find out by
refreshing a register. Everything else goes to a role.

---

## 2. Read is per person

`public.notification_reads` holds one row per (notification, profile). "Unread"
is the absence of a row, which has a useful consequence: a notification raised
before a staff member existed is unread for them, because the thing it is about
still needs doing.

`public.notification_feed` joins the two against `current_profile_id()`, so one
event reads as unread for one person and read for another with no second copy
of it anywhere.

Marking read goes through `public.mark_notifications_read(p_ids uuid[])`:

- passing `null` marks **everything the caller can see** — that is what the
  "mark all read" control does, and it clears the bell rather than the page;
- passing ids marks exactly those;
- an id the caller cannot see is **skipped, not refused**. The honest answer to
  "mark this read" for something you cannot read is that there was nothing to
  mark.

It is a function rather than a client-side insert because the row a client
would have to supply is its own `profile_id`, and a client that chooses whose
receipt it writes can clear somebody else's bell.

**Read is dismissal.** There is no separate dismiss state — it would be a
second thing to explain that nobody asked for — and nothing is hidden once
read. A read row stays in place, visibly quieter. Hiding it would mean a staff
member who cleared the bell on the bus cannot find what they cleared.

---

## 3. Raised by events, never by the passage of time

This is the rule the whole design rests on.

A loan quietly becoming thirty-one days late is **not an event**. It is a
reading of the calendar, and Phase 7 is explicit that delinquency is derived on
every read precisely so that no column can go stale. A stored "this loan is
overdue" notification would be a second opinion with a timestamp on it: right
on Tuesday, wrong on Wednesday, and never corrected because nothing runs.

The overdue list and the aging register already answer "what is late", and they
are correct every time they are read. So notifications cover what somebody
*did*, or what the database *did*:

| Category | Raised by | Audience | Severity |
| --- | --- | --- | --- |
| `loan_awaiting_approval` | a loan moving to `pending_approval` | `loans:approve` | attention |
| `loan_awaiting_disbursement` | a loan being approved | `loans:disburse` | attention |
| `loan_decided` | a loan being refused or withdrawn | `loans:view`, the submitter | attention / info |
| `loan_disbursed` | money going out | `loans:view` | info |
| `loan_cleared` | a borrower repaying in full | `loans:view` | info |
| `payment_reversed` | a payment being taken back | `payments:reverse` | urgent |
| `penalty_applied` | a penalty materialising | `delinquency:view` | urgent |
| `promise_recorded` | a promise to pay being taken | `recovery:view` | attention |
| `guarantor_released` | `release_loan_guarantor` | `guarantors:view` | attention |
| `collateral_realised` | security being sold | `collateral:view` | urgent |
| `approval_pending` | a transfer or expense over its threshold | `transfers:approve` / `expenses:approve` | attention |
| `reconciliation_variance` | a count submitted for review | `reconciliation:approve` | urgent if it did not balance |
| `low_float` | a journal line moving a cash account below its floor | `ledger:view` | attention |
| `client_blacklisted` | a borrower being blacklisted | `clients:view` | urgent |

### What is deliberately absent

- **A payment received.** It is the normal case. Twenty receipts a day in the
  bell would train everybody to ignore the bell, and the register lists them.
  The exception — a payment taken back — is what gets a notification.
- **A promise being kept or broken.** The verdict is derived from posted
  payments and changes without any event to hang a notification on. The
  promise *being taken* is the event, and that is what is raised.
- **Anything about arrears, aging or PAR.** See above.

### The nearest honest thing to "this loan has gone bad"

`penalty_applied`. The grace period ran out and a charge was materialised
against the borrower — a fact with a date on it, not a reading of the calendar.

---

## 4. Inside the transaction

Every generation trigger is AFTER the row has changed and in the same
transaction as the change. Two consequences, both wanted:

- a notification cannot exist for an event that rolled back, and
- an event cannot happen without its notification — there is no queue to
  drain, no worker to be down, and nothing arrives minutes late.

The cost is that a failure in a trigger would fail the business transaction, so
each one does exactly one thing: build two strings and call
`raise_notification`. None reads a balance, none loops, and none raises an
exception.

`notify_low_float` is the single exception to "does not read a balance", and it
is statement-level over the transition table for that reason: one journal
entry's four lines cost one pass over the distinct cash accounts they touched
rather than four balance sums.

### Raised once

`notifications` carries `unique (category, dedupe_key)` and
`raise_notification` does `on conflict do nothing`. That is what makes every
trigger safely re-runnable:

- for an event, the key *is* the event — `loan:<id>:approved` can happen once,
  so a retried transaction or a second UPDATE touching the same row raises one
  notification;
- for the one reading taken at a moment, the key carries the business date —
  `float:<account>:<date>` — which is how "tell me once a day, not once a
  payment" is expressed with no scheduler anywhere.

---

## 5. Append-only

A notification is a record that something happened, so it is append-only the
way `audit_log`, `client_remarks` and `loan_recovery_actions` are:
statement-level BEFORE triggers that refuse UPDATE and DELETE outright.
Statement-level matters — the refusal does not depend on an attacker's WHERE
clause matching anything, and withholding a grant stops a session while a
leaked service key is not a session.

Read receipts are insert-only on the same reasoning: nothing un-happens and
nobody un-reads.

### Every reference is `restrict`

Both tables hold every foreign key with `on delete restrict`, and that is not
caution — it is forced. `SET NULL` and `CASCADE` are both **mutations**, and
these tables refuse every UPDATE and every DELETE. A nulling reference would
make deleting the referenced row fail with a confusing error about append-only
tables instead of a clear one about the reference.

`client_remarks` recorded the same reasoning in Phase 3. Nothing in this
application hard-deletes a profile or a branch — accounts are archived and
branches are closed — so `restrict` costs nothing and says what it means.

---

## 6. The screens

| Route | Capability | What it is |
| --- | --- | --- |
| the header bell | `notifications:view` | A link with a count, on every staff screen. |
| `/notifications` | `notifications:view` | The stream, with four group chips, a severity filter, an unread toggle and per-row deep links. |

`notifications:view` gates the **surface**, not the rows. It grants nobody a
notification they could not already have read, because every row is behind the
capability of the thing it is about — a Secretary/Treasurer holding it sees a
loan awaiting approval and does not see a reversal or a variance. It exists so
the route has a capability of its own rather than borrowing `dashboard:view`,
which is the defect Phases 3, 6 and 8 each found once.

### The bell is a link, not a dropdown

A panel hanging off a header icon has to be a client component with open state,
has to trap focus, has to close on escape and on an outside click, and has to
decide what it does on a phone where it would cover the page it is over. All of
that to show five rows that the page shows better.

**The badge says its state in words.** Colour alone carries nothing to somebody
who cannot see red or is reading in sunlight, so the count is in the badge and
the whole state is in the accessible name — "Notifications, 3 unread, 1
urgent". The badge caps at `99+`, because a three-digit badge does not fit the
dot and the exact figure stays in the name.

### The stream stays put

Newest first, and the order does not change when something is read. A list that
re-sorted itself as rows were marked would move under the reader's finger —
they tap "read" on the third row and the fourth jumps into the space. Severity
is shown on each row instead of sorting by it.

### The deep link is not stored

`notifications` carries `entity_type` and `entity_id` — the *subject* — and not
a URL. A stored path would be a route committed to a table: rename `/overdue`
and every notification raised before the rename points at a 404, with nothing
to fix it but a data migration. The subject is stable; the route is the
application's business, and `notificationHref` in `lib/domain/notification.ts`
is where that mapping is written once.

Where there is nothing specific to open it returns `null` and no control is
rendered, because a dead control is worse than no control. A low float is the
one case that links to a screen rather than a record: the cash position shows
all four accounts, which is what the notification is about.

---

## 7. The stream that already happened

A bell switched on over a business with thirty-five loans would otherwise be
empty until the next application was submitted, which would say nothing true.
So `20261015000300` reconstructs the stream for the events that already
happened, and the reconstruction is a **derivation, not an invention**: every
row comes out of a column the record already carried — `submitted_at` and
`submitted_by`, `approved_at` and `approved_by`, `disbursed_at`, `cleared_at`,
`cancelled_at`, a reversal's `reversed_at` and reason, a penalty's basis, rate
and deadline. Each notification is stamped with the moment its event actually
happened and attributed to the person who actually did it.

The dedupe keys are the triggers' keys character for character, which is what
makes the backfill safe to run twice and safe to run in a database where the
events are still to come: `(category, dedupe_key)` is unique, so a backfilled
row and a trigger-raised row for the same event are the same row, whichever
arrives first. In a fresh database the migration matches nothing and is a
no-op. `tests/db/notifications.test.ts` proves the equivalence the only way it
can be proved — it takes a stream the triggers raised, deletes it, runs the
real migration file off disk, and compares all thirteen columns row for row.

Two categories are deliberately left out.

- **`low_float`** is a reading of a balance at a moment, and every one of those
  balances has since moved. Reconstructing "the MTN float was low on 14
  September" would store an opinion about the past that nothing will ever
  correct — the exact staleness §3 refuses. It raises from the next journal
  line onwards and not before.
- **`approval_pending`** is raised when a transfer or an expense is *created*
  in a pending state, and a row that has since been approved does not record
  whether it ever waited: `status` is where it ended, not where it started.
  Inferring it would be guessing.

And nothing is marked read, for anybody. Nobody read a notification that did
not exist, and a read receipt is a claim about a person. So the bell is loud on
the first morning — which is what switching a bell on over a year of history
actually looks like, and the five filters and the mark-all control are there
for exactly that.

---

## 8. Who is not notified

Borrowers. The portal is their surface, and a bell telling a borrower their own
loan was disbursed would be telling them something they were handed cash for.
No borrower holds `notifications:view`, so the route turns them away at the
door rather than showing them an empty page.

---

## 9. What Phase 15 does not touch

- **No email, no SMS, no push.** The brief's Phase 6 is "table, generation
  triggers, bell, page, categories, deep links". Delivering a notification
  outside the application needs a provider, a retry policy, a per-person
  preference and a record of what was sent — none of which exists, and a
  half-built SMS path that silently drops messages is worse than none.
- **No scheduler.** Nothing polls, nothing sweeps and nothing expires. The one
  notification that is a reading rather than an event is pinned to a journal
  line and deduplicated by business date.
- **No retention policy.** The stream is a log and nothing in this system
  deletes history. Paging through it is how it is read.
