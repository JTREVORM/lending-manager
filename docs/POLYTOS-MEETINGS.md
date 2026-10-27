# Polytos monthly meetings — the module

Four tables, two views, two capabilities and eleven database functions, in
migration `20261022001000` with their Row Level Security, audit and
notification work in `20261022001200`–`20261022001400`. They ship beside
benefits because they share that work, and they are documented separately
because they share nothing else: a meeting moves no money.

---

## 1. What the client actually asked for, and what they did not

The documents say the membership programme holds a **monthly meeting**. That
is the whole of it. They do not say:

- which day of the month, or at what time;
- how many members make it count;
- what happens to a member who does not come.

So this module imposes none of those, and **the absence is the design rather
than an omission**. A default weekday would become the rule by accident. A
quorum field would be a policy invented by a form. And an attendance
consequence would be the most consequential thing in the module — a member
told they had been penalised under a rule nobody approved.

The one rule the documents do state is enforced: **one monthly general
meeting per branch per calendar month**, by a partial unique index on the
generated `meeting_date` column rather than by a check in a function, because
two concurrent inserts would both pass a check.

A special, committee or annual general meeting in the same month is not
refused. That is the business's business.

---

## 2. Entity relationships

```
          branches (Phase 10)
              │ branch_id
              ▼
     membership_meetings ──────────► meeting_action_items
       (generated meeting_date)              │ assigned_to
              │                              ▼
              │ meeting_id              profiles (Phase 1)
              ▼
      meeting_attendance ──────────► meeting_attendance_corrections
         (one per member)                  (append-only)
              │ membership_id
              ▼
         memberships (Phase 1)
```

`meeting_date` is generated from `scheduled_at` **in Africa/Kampala**:

```sql
(scheduled_at at time zone 'Africa/Kampala')::date
```

A meeting at 00:30 on 1 November announced as November's would be filed in
October if the instant were read as UTC — and because the column is generated,
that mistake would be permanent. The monthly uniqueness index is written over
`date_part('year', …)` and `date_part('month', …)` rather than
`date_trunc('month', …)`, because `date_trunc` on a date is not immutable in
this configuration and a `::timestamp` cast would have violated the project's
own rule against timezone-less timestamps.

---

## 3. The status is derived, not set

```
 scheduled ──mark the first member──► held
     │
     ├──reschedule──► scheduled (with a reason, and the old time kept)
     └──cancel──────► cancelled (only while nobody has attended)
```

There is no "mark as held" control anywhere in the application, and that is
deliberate: `mark_meeting_attendance` moves the meeting when the first member
is marked. A meeting with a register and a `scheduled` status would be two
statements about one afternoon, and somebody would have to remember to
reconcile them.

`cancel_membership_meeting` checks the **register before the status**, so the
refusal reads "people attended, so it happened" rather than "it is already
held". The distinction matters to whoever reads the message: one is a fact
about the afternoon, the other is a fact about a column.

---

## 4. Attendance, and the correction trail

Four answers: `present`, `absent`, `apology`, `represented`.

`apology` earns its place because a member who sent word is not in the same
position as one who did not, and a register that collapsed the two would make
"how many apologies did we have" unanswerable. `represented` is for a member
whose family member came instead, which is ordinary in Kampala and which
neither `present` nor `absent` describes.

Marking the **same** answer again is a no-op. Marking a **different** one is a
correction: it needs a reason, and the previous entry is written to
`meeting_attendance_corrections`, which refuses `UPDATE` and `DELETE`. A
register that could be silently rewritten would not be evidence of anything.

That asymmetry cannot be expressed in a form schema, because whether this is
a correction depends on what the register already says — which only the
database knows. So `markAttendanceSchema` accepts the submission either way
and the function refuses the silent edit. The screen asks for a reason when
it can see the answer changing, and the database has the last word.

The expected register is the meeting's **own branch's** live memberships —
`active` and `suspended`, which is what `mark_meeting_attendance` accepts. A
pending application is not a member yet, and a withdrawn or deceased one is
not one any more.

---

## 5. Minutes

Before anybody finalises them, minutes are a draft and can be rewritten
freely. Once finalised, `record_meeting_minutes` refuses a silent edit: an
amendment needs a note saying what changed, and the row keeps
`minutes_amended_at` and that note for good. So the history of a disputed
decision is readable, which is the only reason minutes exist.

One text field rather than a structured record of motions and seconds.
Minutes are prose that gets read aloud and signed; a table of motions would be
a data model nothing joins to, filled in by whoever was fastest, and it would
make the common case — writing down what was agreed — harder than a notebook.

The screen renders them as text, never as markup: they are somebody's words,
and interpreting them as HTML would be both wrong and unsafe.

---

## 6. Action items

An assignee is a **staff profile**, not a typed name. "Somebody will look into
it" is how an action item becomes nobody's, and a free-text name cannot be
notified, listed on a dashboard, or checked against an account that still
exists. `add_meeting_action_item` refuses an assignee whose account is not
active.

A consequence of that is worth stating plainly, because it is a limitation
rather than a feature: **a Secretary/Treasurer cannot see the staff list.**
`profiles` needs `users:view`, which a Manager and an Owner hold and a
Secretary does not — and the Secretary is usually the person writing the
minutes. So the form says it cannot offer names and records the item
unassigned, which is a real and ordinary state. It does **not** reach around
the policy with a privileged read: "who works here" is a staff directory
question, and widening that capability for the convenience of one form would
widen it for everything.

Overdue is computed from the business date in Africa/Kampala, passed in from
the server. Comparing `Date` objects would make an item due today overdue at
21:00 Kampala, which is 00:00 UTC the next day — and the register would chase
somebody a day early.

---

## 7. Row Level Security

| Table | SELECT | Writes |
| --- | --- | --- |
| `membership_meetings` | `meetings:view` | functions; the only **UPDATE** grant in the phase |
| `meeting_attendance` | `meetings:view` | functions only |
| `meeting_attendance_corrections` | `meetings:view` | append-only |
| `meeting_action_items` | `meetings:view` | functions only |

Two choices to note.

**`meeting_attendance` has no self-clause.** A member cannot read their own
attendance row, and that is not an oversight: the register is an internal
record about a room, the corrections table records who changed an answer and
why, and a member who wants to know whether they were marked present asks at
the branch. Adding a self-clause would also expose, by elimination, who else
was absent.

**`membership_meetings` is the one table with an UPDATE grant**, because
`record_meeting_minutes` and the reschedule path write to it as the caller
under the policy rather than through a definer function. Every other write in
this module is a function.

Meetings are **staff-only, with no portal surface at all.** A member hears
about a meeting through a notification, and reads nothing about who else came.

---

## 8. Capabilities

| Capability | Held by | What it is for |
| --- | --- | --- |
| `meetings:view` | Secretary, Manager, Owner | the list, a meeting, its register and its minutes |
| `meetings:manage` | Secretary, Manager, Owner | scheduling, marking, writing up, action items |

Two, not five, and deliberately not split by act. Convening a meeting and
marking its register are the same person's work at a branch — the Secretary's
— and a separation between them would be a control with nothing behind it.
Finalising minutes is the one act an Owner performs in the demonstration
data, and it is not a separate capability: the business has not said who signs
the minute book.

---

## 9. Screens

| Screen | Guard |
| --- | --- |
| `/meetings` | `meetings:view` |
| `/meetings/{id}` | `meetings:view` |
| `/meetings/new` | `meetings:manage` |

The section's dashboard carries two panels above the list, and each earns its
place by answering a question the list buries: **what is coming** (the
question members ask at the counter, and the one thing a list ordered
newest-first hides) and **what is outstanding** (the commitments made in a
meeting that nobody has closed — the thing a minute book is for and the thing
a minute book never surfaces).

Both are omitted when empty rather than shown as a zero.

---

## 10. Tests

| Suite | What it is for |
| --- | --- |
| `tests/db/meetings.test.ts` | the monthly rule, the derived status, the correction trail, minutes and amendments, action items |
| `tests/unit/meetings.test.ts` | the domain, including the absences: no quorum, no weekday, no penalty |
| `tests/unit/meeting-validation.test.ts` | the write surface and the two asymmetries the database owns |
| `tests/e2e/specs/meetings.spec.ts` | the screens in a browser, at 390px, as three roles |
| `tests/e2e/specs/benefits.write.spec.ts` | marking a register and writing minutes by pressing the buttons |

The unit suites assert the absences as deliberately as they assert anything
else, so adding a quorum or an attendance penalty has to change a test that
says there isn't one.

---

## 11. What this module does not do

- **It does not decide a meeting day, an hour or a quorum.**
- **It does not attach any consequence to absence.** No cumulative count, no
  flag, no effect on savings, a loan or a benefit.
- **It does not give a member a portal view of a register or of minutes.**
- **It does not move money.** No journal entry, no ledger account, no fee for
  missing a meeting — the last of which is exactly the kind of rule a system
  must not invent.
- **It does not record who spoke, or how anybody voted.** Minutes are prose,
  and the business has not asked for a motion register.
