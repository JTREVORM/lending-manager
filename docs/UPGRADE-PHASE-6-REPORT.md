# Platform upgrade, Phase 6 — notifications

Phase 6 of the plan in `PLATFORM-UPGRADE-PLAN.md`: a table, the triggers that
fill it, the bell in the header, the page behind the bell, the categories it is
filtered by and the links it opens.

How the module works is in `NOTIFICATIONS.md`. This is the evidence that it was
applied, that it holds, and that nothing already working was broken.

---

## 1. Migrations added

| Migration | What it does |
| --- | --- |
| `20261015000100_notifications.sql` | `notifications` — one row per event, addressed to the capability that may read it, with two optional narrowings (a person, a branch) and a dedupe key — append-only through statement-level triggers; `notification_reads`, insert-only, keyed by the pair; `raise_notification(...)`, the one writer, swallowing a duplicate on the key; `mark_notifications_read(uuid[])`, so a client cannot write somebody else's receipt; `notifications:view`; RLS; `notification_feed` and `notification_summary`. |
| `20261015000200_notification_triggers.sql` | Ten generation triggers — loan transitions, a payment taken back, a penalty charged, a promise taken, security sold, a transfer or expense awaiting a decision, a reconciliation that did not balance, a float running low, a borrower blacklisted — each AFTER the change and inside its transaction. Re-emits `release_loan_guarantor` to raise `guarantor_released` from inside the function that already holds the decision. |
| `20261015000300_notification_backfill.sql` | The stream for the events that preceded the triggers, derived from the columns the record already carried and written under the triggers' own dedupe keys. A no-op in a fresh database. |

## 2. The design decision the whole phase rests on

**One row per event, addressed to a capability — not a row per recipient.**

The obvious shape is a fan-out: a notification per Manager when a loan is
submitted. It is wrong here for two reasons. An event then exists as N rows
that can diverge, so "was this dealt with?" has N answers. And a staff member
who joins on Monday gets no history of the weekend — which for operational
alerts is exactly backwards, because the thing still needs doing.

So a notification is recorded once and names the *capability* that may see it.
"A loan is awaiting approval" is addressed to whoever approves loans, which is
a role and not a person. Unread is therefore per person, in
`notification_reads`, which is what a bell needs.

Live, that is three different bells over the same 110 rows: the Owner sees 108,
a Manager 79, a Secretary/Treasurer 48 — and the two the Owner does not see are
the two addressed to the person who submitted the applications that were
cancelled. Nothing had to be fanned out to make that true, and nothing can
drift out of step.

## 3. Nothing is raised by the calendar

This is the rule that keeps the stream honest, and it is why there is no
"this loan is overdue" notification.

Arrears is computed from the schedule, the ledger and today's date on every
read, precisely so that no column can go stale. A stored "this loan is 31 days
late" notification is a column with a timestamp on it: right on Tuesday, wrong
on Wednesday, and never corrected, because nothing runs. The overdue list and
the aging register already answer "what is late", and they are correct every
time they are read.

So every category traces to something somebody or the database *did*. The
nearest honest event to a loan going bad is the penalty: the grace period ran
out and a charge was materialised, which is a fact with a date on it. That is
what gets notified.

The one reading rather than event — a float running low — is pinned to a
journal line, so it cannot fire without something having moved, and its dedupe
key carries the business date, which is how "tell me once this morning, not
once per payment" is expressed with no scheduler at all.

## 4. Four defects found while building it

**Every foreign key on an append-only table must be `restrict`.** The first
version used `on delete cascade` and `on delete set null`, and the tests failed
with "Table public.notifications is append-only; DELETE is not permitted" —
from a teardown deleting a *profile*. Both SET NULL and CASCADE are mutations,
and a table that refuses every UPDATE and every DELETE refuses them too. So
every reference on both tables is `restrict`, which is also the clearer error:
it names the reference rather than the append-only rule. `client_remarks` had
recorded the same reasoning; this phase is where it became a doctrine.

**A Phase 5 test was passing for the wrong reason.** "Refuses a caller without
`collateral:manage`" worked by deleting the row from `role_permissions` — and
`authenticated` holds no DELETE on that table, so the delete failed with 42501
and the insert it was supposed to guard never ran at all. The test would have
passed against a database with no guard whatsoever. Rewritten to sign in as a
role that genuinely lacks the capability.

**The suite's hard-coded date went stale.** Nineteen schedule-generation tests
failed the moment the clock rolled past `2026-10-10`, because the fixtures pin
that date while `loans_disbursed_after_approved` compares it against an
`approved_at` of `now()`. Pulling the approval back alone then trips
`loans_approved_after_created`. Fixed with a `historyBefore()` helper that
moves the whole chain — created, submitted, approved, disbursed — rather than
one link of it.

**A regex matched a word inside a word.** A unit test asserting no category
names a calendar reading used `/overdue|in_arrears|late/`, which matches
`collateral_realised` — "col-LATE-ral". Replaced with per-underscore-word
matching against a set. The same class of mistake as Phase 5's `\breal`
matching `realised_amount`.

## 5. Schema changes

Two tables, two views, three functions (one re-emitted), fourteen triggers,
one capability.

- **`notifications`** — `category` (14, checked), `severity`
  (`info` / `attention` / `urgent`), `title`, `body`, `audience_permission`
  (required, references `permissions`), `audience_profile_id`,
  `audience_branch_id`, `entity_type` (9, checked, because the deep link is
  built from it and an unrecognised type would render a dead control),
  `entity_id`, `actor_profile_id`, `actor_label`, `occurred_at`, `dedupe_key`,
  unique on `(category, dedupe_key)`. Four indexes. UPDATE and DELETE refused.
- **`notification_reads`** — `(notification_id, profile_id)` as the primary
  key, `read_at`. Insert-only: nothing un-happens and nobody un-reads.
- **`raise_notification(...)`** — the only writer. Derives the actor from the
  session and swallows a duplicate on the key, which is what makes every
  generation trigger safely re-runnable.
- **`mark_notifications_read(uuid[])`** — null means "everything I can see".
  A function rather than an insert because the row a client would have to
  supply is its own `profile_id`, and a client that can choose whose receipt it
  writes can clear somebody else's bell.
- **`notification_feed`** / **`notification_summary`** — `security_invoker`,
  so one RLS policy with three narrowings decides every row. The summary always
  returns exactly one row, zeroes included, so a caller never has to tell
  "nothing to report" from "the query failed".

## 6. Application layer

| File | What it holds |
| --- | --- |
| `lib/domain/notification.ts` | The categories, the four groups the page filters by, the severities and their rank, `notificationHref` (returning null where there is nothing to open), and `badgeCount` capping at `99+`. |
| `lib/data/notifications.ts` | The three reads. `getNotificationSummary()` falls back to zeroes rather than throwing, because a failed count must not be able to take down the header on every page. |
| `lib/validation/notification.ts` | `markNotificationsReadSchema`, where null and the empty array are deliberately different things, and the stream's search parameters. |
| `lib/notifications/actions.ts` | `markNotificationsReadAction`. An absent `notificationId` is null, which the function reads as "everything I can see"; revalidates the stream and the dashboard, which is what moves the bell in the layout. |
| `components/notifications/notification-badge.tsx` | The bell. A link, not a dropdown — a panel hanging off a header icon would need open state, focus trapping, escape and outside-click handling, and a decision about what it does on a phone, all to show five rows the page shows better. The count is in the badge and the whole state is in the accessible name. |
| `components/notifications/notification-list.tsx` | The stream: group chips, a severity select, an unread toggle, and a per-row mark-read. Newest first, and the order does not change when something is read. |
| `app/(app)/notifications/page.tsx` | Guarded on `notifications:view`, reading the feed and the summary in parallel. |

The bell is in both the desktop and the mobile icon bars; `/notifications` is
in the rail under Operations; the route is in `lib/auth/routing.ts` behind its
own capability rather than borrowing `dashboard:view`.

## 7. What this phase deliberately does not do

- **No email, no SMS, no push.** Delivering outside the application needs a
  provider, a retry policy, a per-person preference and a record of what was
  sent. None of that exists, and a half-built SMS path that silently drops
  messages is worse than none.
- **No scheduler.** Nothing polls, sweeps or expires.
- **No retention policy.** The stream is a log; paging is how it is read.
- **No borrower notifications.** The portal is their surface, and no borrower
  holds `notifications:view`, so the route turns them away at the door rather
  than showing them an empty page.

## 8. Verification

| Suite | Result |
| --- | --- |
| `tsc --noEmit` | clean |
| `eslint .` | clean |
| `prettier --check` | clean |
| Unit + integration | **1,978 passed**, 58 files |
| Database (real PostgreSQL) | **1,248 passed**, 45 files |
| Migration discipline | 28 passed |
| Browser (Playwright, desktop + mobile) | **402 passed**, 15 skipped, 14.3m |
| `next build` | succeeds |

New tests: 24 database (`tests/db/notifications.test.ts`, three of them on the
backfill), 27 unit (`tests/unit/notification-validation.test.ts`), 17
integration (`tests/integration/notification-ui.test.tsx`), and a browser spec
(`tests/e2e/specs/notifications.write.spec.ts`).

The backfill's test is the one worth naming. A backfill that claims to
reproduce what a trigger would have produced can only be trusted if that is
checked, so the test takes a stream the triggers raised, deletes it, runs the
real migration file off disk, and compares all thirteen columns row for row —
the wording, the audience, the actor, the moment and the dedupe key. A backfill
that got the audience right and the timestamp wrong would be worse than none,
because it would look correct.

### Three browser failures, and what they were

1. **A flash message that does not exist.** The spec asserted "marked read"
   appeared after clearing one row, but the card renders an Alert only on
   failure — the row gaining "Read" and losing its control *is* the feedback.
   Rewritten to assert the resulting state, and the bell dropping, which also
   covers that the action revalidates far enough up to reach the layout.
2. **`opacity-70` on a read card.** Dimming a container dims every child's
   colour with it, and it put the neutral "Read" badge below the contrast
   floor on a mobile axe sweep. Replaced with a neutral left edge, the same
   4px as an unread row's severity edge, so clearing a row does not shift the
   list. `components/reports/report-table.tsx` had recorded this exact lesson;
   it has now been learned twice.
3. **A count taken mid-animation.** "No destination label is clipped in the
   rail" counted visible spans immediately after clicking the menu button.
   `count()` returns a plain number, so `expect` cannot retry it, and a closed
   drawer is `invisible` — every span in it genuinely invisible. It had been
   passing on timing. Now waits for the rail, as every other test in that file
   already did.

## 9. Live application

Project `fszgwemtgyrbhngajpzm`, PostgreSQL 17.11.

Before applying anything, the live migration registry was compared with the
repository: it ended at `20261014000400`, Phase 5's last, with no Phase 6 rows
and neither new table present — the expected state. The columns every Phase 6
trigger reads were then hashed in both databases across fourteen tables:
`a064c1963c4046a10d8a5535905a7475`, 265 columns, **identical**. No unexpected
live difference, so the migrations were applied.

After applying, every new object was hashed by category in both databases:

| Category | Hash | Count |
| --- | --- | --- |
| Columns | `48fcb086da0f8d0ce6fd8d18b3f22ba3` | 17 |
| Constraints | `a52d31376cd0f1263714c3624283949c` | 16 |
| Indexes | `91ec12beb985b3f3952e0bbd3c6e09ea` | 8 |
| Policies | `e0906a73653abd5dbc31e54cd15fda7f` | 2 |
| Triggers | `63964c7d525544ea42325d315287dc18` | 14 |
| Function bodies | `2673d6d7fb0dbe72fa2ae50e970c7521` | 13 |
| Views | `d86acb51e23dd75136eb4ac5d5703ab3` | 2 |
| Grants to `anon` / `authenticated` | `e5bb89c895cc20401cda14122545fa1a` | 4 |
| `notifications:view` role grants | `ac7dd44cb510bb7676bf6ff657e456f2` | 3 |

All nine match, live against local, including the function bodies (comments
stripped and whitespace collapsed, which Phase 4 established is what the
comparison actually requires).

As in Phase 5, the migration tool recorded no registry rows of its own, so
`20261015000100`, `20261015000200` and `20261015000300` were inserted at their
repository versions.

## 10. Demo data

The live dataset was **preserved, not rebuilt**. The backfill derived 110
notifications from it, and every category reconciles against a direct count of
its own source rows:

| Category | Source | Rows |
| --- | --- | --- |
| `loan_awaiting_approval` | loans with `submitted_at` | 33 |
| `loan_awaiting_disbursement` | loans with `approved_at` | 28 |
| `loan_disbursed` | loans with `disbursed_at` | 26 |
| `loan_cleared` | cleared loans with `cleared_at` | 9 |
| `loan_decided` | cancelled loans | 2 |
| `penalty_applied` | penalties | 5 |
| `promise_recorded` | recovery actions with a promised amount | 3 |
| `payment_reversed` | reversed payments | 1 |
| `collateral_realised` | realised security | 1 |
| `guarantor_released` | released guarantees | 1 |
| `client_blacklisted` | blacklisted borrowers | 1 |

110 in total — 66 `attention`, 36 `info`, 8 `urgent` — across 11 categories.
No category raised a row with no source, and no source row went unraised. No
audience references a capability that does not exist. No read receipts were
written, because nobody read a notification that did not exist.

**Reconciliation.** The trial balance before applying Phase 6 was
70,496,030 / 70,496,030 over 1,469 lines, variance 0. After applying all three
migrations and the backfill it is 70,496,030 / 70,496,030 over 1,469 lines,
variance 0 — unchanged, as it must be. A notification is a record that
something happened; it is not a financial movement, and it does not touch the
ledger.

**Read live, as the real staff.** Reading `notification_summary` through the
RLS policy as each role returned 108 unread for the Owner (8 urgent), 79 for
the Manager (7 urgent) and 48 for the Secretary/Treasurer. The Secretary's feed
holds no `payment_reversed` — that is addressed to `payments:reverse`, which is
the Owner's alone — and no `loan_awaiting_approval` or
`loan_awaiting_disbursement`. The audience is enforced on live data, not just
in tests.

One thing the e2e harness confirmed about the backfill that is worth recording:
in that database it added 22 rows on top of the 58 the triggers had raised,
all of them for the back-dated historical portfolio the seed writes with direct
INSERTs. An INSERT at a final status is not a transition, so no trigger ever
fires for it — which is exactly the gap the backfill exists to close, and the
reason it is a migration rather than a one-off script.

## 11. Commit

`claude/epic-mendel-rpimtt`.
