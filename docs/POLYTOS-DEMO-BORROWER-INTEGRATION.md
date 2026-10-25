# Demo borrower integration — Phase 2 release gate

This opt-in integration maps the six membership/savings demonstration scenarios
onto six **existing** clients with loan records. It never edits those clients,
loan contracts, repayment schedules, payments or existing loan ledger postings.
A minimum of one existing borrower remains a non-member.

## Opt in

The ordinary `npm run seed:demo` still creates entirely synthetic clients.
Borrower reuse requires **two independent opt-ins**:

`POLYTOS_SEED_DEMO=yes-seed-polytos-demo-data`

`POLYTOS_DEMO_BORROWER_REUSE=yes-reuse-existing-demo-borrowers`

The original project's Supabase host allow-list remains in force; the other
connected Supabase project named **Primary** is not allowed.

Run only after Phase 2 migrations are applied. Do not run against a database
containing actual customer records. Approval by a human that *all selected
clients are synthetic test identities* is mandatory.

## Guarantees

- Requires at least seven eligible borrowers; selects six deterministically by
  loan count and client number, while leaving a borrower as a non-member.
- Saves each scenario marker in the new membership's notes; later runs recover
  the mapping even if the loan book ordering changes.
- If the old six synthetic demonstration clients already exist, refuses to
  reassign deterministic receipt/payment keys to new people.
- **And the reverse.** A plain `npm run seed:demo` against a database that
  already holds reused borrowers is refused too — see the section below.
- Uses the original enrolment, posted-fee, verified-consent, savings,
  withdrawal and reversal functions. Existing client names and loans remain
  unmodified; demo markers are visible on membership records only.
- Ensures the savings liability ledger reconciles after posting.
- The upgrade-verification script creates a real representative loan book,
  verifies the six links, checks an untouched loan snapshot and compares all
  financial figures after three identical seed executions. It runs as a
  mandatory GitHub database CI step.

## The two modes must never meet, in either order

Found while validating this integration against a real loan book, and fixed
before it was committed.

Every scenario's fee and deposit idempotency key is derived from its **letter
alone**, so the keys are identical in both modes. The patch as delivered
guarded one direction — reuse refuses when the synthetic clients exist — and
left the mirror open. Running the ordinary synthetic seed on a database that
had already been seeded with borrower reuse did this:

- six synthetic clients were created, but only **one** new membership;
- for scenarios A–E the spent fee keys replayed, so `enrol_member` handed back
  the *existing borrower's* membership and the five new clients were left with
  no membership at all;
- the one membership that was created pointed at a fee receipt belonging to a
  different person;
- the seeder's own tally reported "members enrolled 6".

The money still reconciled — subledger equal to the 2100 liability, nothing
double-posted — which is precisely what made it dangerous. The demonstration
would have shown one person's registration fee under another person's name,
and `public.memberships` is append-only, so **none of it can be deleted
afterwards**.

`chooseExistingDemoBorrowers` now refuses that combination before any write,
naming the opt-in that would make it deliberate. Recovering from the mixed
state requires deciding which set of people the posted money belongs to, and
that is not a decision a seeding script may take.

## Tests

`tests/db/demo-borrower-reuse.test.ts` — its own vitest project
(`seed-reuse`), because borrower reuse needs a database the synthetic seeder
has never touched. It builds a real loan book, two borrowers driven all the
way to disbursement so there are genuine schedules and journal entries to
disturb, then asserts:

- no client is created, and all six scenarios map onto clients that already
  existed;
- every loan figure, installment date and outstanding balance is byte
  identical before and after, including the lending-ledger posting count;
- the seeder adds only membership and savings journal sources;
- no audit row claims a client or loan was modified;
- each scenario's membership, posted fee and savings account point at that one
  client, and the consent carries the borrower's own name rather than a demo
  alias;
- at least one loan borrower remains a non-member;
- runs two and three are a financial fixed point;
- and both unsafe mode combinations are refused, writing nothing.

This is a **code and test change** only. It neither applies hosted migrations
nor starts a hosted seed. Release and hosted demonstration population must be
separate, explicitly authorized operations.

## Known limitation

The browser suite does not exercise reuse mode. Playwright runs against the
e2e harness seed, which builds its own membership and savings fixtures, not
the demonstration seeder. Reuse is covered by the database project above and
by the CI upgrade gate; no screenshot shows it.
