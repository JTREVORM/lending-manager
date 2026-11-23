# POLYTOS — Findings, gaps and limitations

Everything this documentation project found that a reader of the manuals needs
to know about, with how it was reproduced and what it blocks.

**Scope.** These findings come from configuring and operating a real POLYTOS
instance end to end — the Docker-free documentation stack (PostgreSQL + the
real PostgREST binary + the auth shim + the production Next build), driven
through its own screens by real signed-in accounts. They are *not* a code
audit, and no attempt was made to find defects beyond the paths the two
manuals document.

**No production code was changed.** Each defect below is reported, not fixed.
Where a documented workflow could not be completed through the application,
the manual says so and names the finding rather than describing behaviour the
software does not have.

---

## Summary

| ID | Severity | Area | What it is |
| --- | --- | --- | --- |
| [F-01](#f-01) | High | Branches, chart of accounts | Three capabilities are granted and have no screen; a branch cannot be opened from the application |
| [F-02](#f-02) | High | Membership | A member's own page returns HTTP 500 for the Secretary / Treasurer |
| [F-03](#f-03) | Medium | Agency providers | A provisional provider's money model can only be corrected on the Providers screen, which is easy to miss |
| [F-04](#f-04) | **Critical** | Capital | An **equity** capital contribution cannot be recorded through the user interface at all |
| [F-05](#f-05) | High | Agency providers | No screen can add or change commission terms on a provider already in the catalogue |
| [F-05b](#f-05b) | Medium | Agency providers | No working go-live control could be driven on the Providers screen |
| [F-06](#f-06) | Medium | Governance | There is no read-only oversight role |
| [F-07](#f-07) | Low | Agency lines | The till-name format rule is enforced but never stated on the form |
| [F-08](#f-08) | High | Agency banking | A bank agent account cannot be registered without a Ugandan mobile number |
| [F-09](#f-09) | **Critical** | Agency providers | The commission **Rate** box rejects every value it is given |
| [F-10](#f-10) | Low | Agency | A raw database value is shown to the user on the Agency hub |
| [L-01](#l-01) | — | Limitation | No provider API integration — MTN, Airtel and partner banks are recorded manually |
| [L-02](#l-02) | — | Limitation | No native mobile application |
| [L-03](#l-03) | — | Limitation | Bank-advance (agent overdraft) is specified and deliberately not implemented |
| [L-04](#l-04) | — | Limitation | Several provider categories are in the catalogue but were not exercised |

---

<a id="f-04"></a>
## F-04 — An equity capital contribution cannot be recorded (Critical)

**Where.** `Finance ▸ Capital` → *Record capital introduced*, with *What kind
of money is this* set to the owner's own money.

**What happens.** The form is rejected with **“Please check the highlighted
fields.”** and no field is highlighted. The form is then cleared. A
**borrowing** records normally.

**Why.** `recordCapitalFundingAction` builds its input with

```ts
interestRateBps: formData.get('interestRateBps') ?? null,
repaymentDueOn:  formData.get('repaymentDueOn')  ?? null,
```

so the two borrowing-only fields — which the equity form does not render —
arrive as `null`. The rule that enforces “equity is not repayable and carries
no interest” tests for `undefined`:

```ts
.refine((value) =>
  value.fundingKind !== 'equity' ||
  (value.interestRateBps === undefined && value.repaymentDueOn === undefined),
  { path: ['interestRateBps'], … })
```

`null === undefined` is false, so every equity contribution fails. The error is
attached to `interestRateBps`, a field that is not on screen when the kind is
equity, which is why nothing is highlighted and the person has no way to find
out what is wrong.

**Reproduced.** Against the schema directly, with the exact shape the action
builds:

```
FAIL  equity, absent optional fields (what the form actually sends)
      {"interestRateBps":["A contribution of the owner's own money is not
       repayable and carries no interest. …"]}
PASS  equity, optional fields undefined
PASS  borrowing, absent optional fields
```

**What it blocks.** The mandatory “register the initial capital” workflow, for
the most common case. `record_capital_funding(...)` in the database is
unaffected and was used for this documentation; the verification step, the
journal entry and the resulting balances are all normal.

**Files.** `lib/finance/actions.ts` (the action), `lib/validation/finance.ts`
(`recordCapitalFundingSchema`).

---

<a id="f-09"></a>
## F-09 — The commission Rate box rejects every value (Critical)

**Where.** `Agency ▸ Register a bank` → *Register a bank or other provider* →
**Rate**.

**What happens.** `0.90`, `0.9` and `90` are all rejected with *“Please check
the highlighted fields.”* Only an empty Rate is accepted.

**Why.** The action passes the raw `FormData` string:

```ts
commissionRateBps: formData.get('commissionRateBps') ?? null,
```

into `optionalField(basisPointsSchema)`, where `basisPointsSchema` is
`z.number()`. Zod does not coerce a string to a number, so every non-empty
value fails with `"Invalid input"`.

**Reproduced.**

```
FAIL  rate="0.90"  {"commissionRateBps":["Invalid input"]}
FAIL  rate="90"    {"commissionRateBps":["Invalid input"]}
FAIL  rate="0.9"   {"commissionRateBps":["Invalid input"]}
PASS  rate=""      null
```

**What it blocks.** Registering any provider whose commission is computed from
a rate recorded in POLYTOS. A provider can still be registered if it is set to
read its commission off the partner's own statement, or with a flat amount —
which is the workaround the Administrator Manual gives.

**Files.** `lib/agency/actions.ts`, `lib/validation/agency.ts`
(`agencyProviderRegistrationSchema`), `lib/validation/common.ts`
(`basisPointsSchema`).

---

<a id="f-02"></a>
## F-02 — A member's own page fails for the Secretary / Treasurer (High)

**Where.** `Membership ▸ Membership Register` → any member.

**What happens.** HTTP 500 for every Secretary / Treasurer and every
membership. Owners and Managers are unaffected.

**Reproduced.** Three roles, two memberships:

```
owner      membership-detail    HTTP 200
manager    membership-detail    HTTP 200
secretary  membership-detail    HTTP 500   (both memberships)
```

Server log:

```
Error: Privilege denied on record.
  code: 'NOT_AUTHORIZED', httpStatus: 403,
  cause: { code: '42501', message: 'permission denied for benefit consumption' }
```

**Why.** The page renders `MembershipBenefitsPanel`, which calls
`public.medical_benefit_consumed(...)`. That function deliberately refuses a
caller holding neither `benefits:assess` nor `benefits:approve` — which the
Secretary / Treasurer does not. **The guard is correct; the page's error
handling is not.** The refusal is not caught, so the whole route fails instead
of the one panel degrading. The member-eligibility panel on the same page
*does* degrade correctly, logging
`The member eligibility register could not be read. { code: '42501' }` — so
the pattern to follow is already in the codebase.

**What it blocks.** The role that enrols and services members cannot open a
member's own page at all.

**Files.** `app/(app)/membership/[membershipId]/page.tsx`,
`components/benefits/membership-benefits-panel.tsx`,
`supabase/migrations/20261022000700_benefit_assessment.sql`.

---

<a id="f-08"></a>
## F-08 — A bank agent account needs a mobile number it does not have (High)

**Where.** `Agency ▸ Register an agent account`, for an agency-banking
provider.

**What happens.** The registration is refused. The **Line number** field is
always submitted — as an empty string when left blank — and `msisdnSchema` is

```ts
z.string().trim().regex(/^\+256[0-9]{9}$/, …).optional().nullable()
```

An empty string is neither absent nor a valid number, so it fails.

**Reproduced.**

```
FAIL  with empty msisdn (the bank case)
      {"lineMsisdn":["Enter a Ugandan mobile number, as +256700000000."]}
```

**What it blocks.** Registering a bank agency counter, which has no mobile
line. The workaround used for this documentation is to enter the branch's own
telephone number and note in the record that it is not a provider line.

**Files.** `lib/validation/agency.ts` (`msisdnSchema`,
`agencyAgentAccountSchema`, `agentLineRegistrationSchema`).

---

<a id="f-05"></a>
## F-05 — No screen adds commission terms to a catalogue provider (High)

**Where.** `Agency ▸ Register a bank`.

**What happens.** The Providers screen offers panels to *register* a provider
(which captures the terms), *approve* terms, approve a facility, open an agent
account, set a ceiling, set a threshold, take a provider out of service and
correct a provisional provider's money model. There is **no panel that records
or revises the commission terms of a provider that already exists.**

Every provider POLYTOS ships — MTN Mobile Money, Airtel Money, Stanbic Bank
Agency, UEDCL, NWSC, DStv, GOtv, Lycamobile, School Fees Collection — arrives
provisional with **no terms recorded**, and `approve_agency_provider_terms`
refuses a provider with no commission basis:

> *… records no commission rate and no fixed commission, so there is nothing to
> approve. Record its terms first, or register that it reports its own
> commission.*

**What it blocks.** Bringing any shipped catalogue provider live through the
application alone. `revise_agency_provider_terms(...)` exists in the database
and does exactly this; it has no caller in the application. It is what was used
for this documentation, and the Administrator Manual says so.

**Files.** `components/agency/provisioning-forms.tsx`,
`components/agency/provider-provisioning.tsx`,
`supabase/migrations/20261121000200_agency_provider_registration.sql`.

---

<a id="f-05b"></a>
## F-05b — No working go-live control on the Providers screen (Medium)

**Where.** `Agency ▸ Register a bank` → *Make a provider live, or take it out
of service*.

**What happens.** The panel's heading names both actions, but only a
*Take out of service* form could be found and driven on the rendered page. The
walk-through could not complete a go-live through the screen and performed it
through `activate_agency_provider(...)`, as the second Owner.

**Not a defect in the controls.** Everything the activation guard requires was
enforced correctly, and each refusal named the missing precondition in order:

```
MTN Mobile Money's commercial terms are not approved, so it cannot go live.
MTN Mobile Money advances electronic float and no facility has been approved for it.
MTN Mobile Money has no active service with an approved ceiling.
MTN Mobile Money has no open agent account, so there is nothing to transact through.
```

That sequence is the dependency order the Administrator Manual's Chapter 7
teaches, and it was discovered by being refused.

---

<a id="f-01"></a>
## F-01 — Branches and ledger accounts cannot be created (High)

**Where.** `Administration ▸ Company Settings ▸ Branch network`.

**What happens.** The panel is read-only and says so: *“Read-only here. A
branch owns ledger accounts, so opening one needs the branches:create
capability.”*

`branches:create`, `branches:update` and `finance:accounts` are declared in
the permission matrix and granted — and **no screen and no Server Action calls
any of them**. A search of `app/` and `components/` finds the three strings
only in the permission matrix itself and in that one explanatory line.

**What it blocks.** Opening a branch, and creating a branch's five money
accounts or any additional bank account. Both are implementation-team tasks in
this release. The two additional branches in the demonstration organisation
were provisioned by the SQL in
`04-Demo-Data/01-demo-organisation.sql`, which is published alongside this
report for exactly that reason.

---

<a id="f-06"></a>
## F-06 — There is no read-only oversight role (Medium)

`audit:view` is held by the **Owner / Administrator alone**, and the Owner /
Administrator also holds every write capability in the system. An external
auditor, an internal audit function or a regulator needing to inspect the audit
trail has to be given an account that can also change things.

This is a governance gap rather than a defect: the four roles POLYTOS
implements have no read-only variant, and roles are not configurable from the
application.

---

<a id="f-03"></a>
## F-03 — The money-model correction is easy to miss (Medium)

A partner bank ships as `cash_payable`, under which **there is no working
float** and a withdrawal is capped at what that bank's own deposits have
collected. Moving it to `provider_float` is possible — and the Product Owner's
confirmed decision is that banks do advance float — but only through the
*Correct a provisional provider's money model* panel, and only **while the
provider is still provisional**.

An administrator who approves the terms first has closed that door: a confirmed
provider is refused, correctly, because its posted history cites the basis that
was in force.

**Consequence if missed.** The branch funds a “working float” that the engine
will not let it spend, and every bank agency withdrawal is refused until
deposits have collected enough. The Administrator Manual puts this decision
before terms approval for that reason.

---

<a id="f-07"></a>
## F-07 — The till-name rule is enforced but not stated (Low)

`Account name` / `Till name` must match lower-case letters, digits, hyphens and
underscores. `Mbarara MTN Till 1` is refused; `mbarara-mtn-1` is accepted. The
rule appears nowhere on the form, and the failure surfaces only as
*“Please check the highlighted fields.”*

```
FAIL  as the browser submits it
      {"tillName":["A till name is lower-case letters, digits, hyphens and underscores."]}
```

---

<a id="f-10"></a>
## F-10 — A raw database value is shown to the user (Low)

The Agency hub's *Needs attention today* panel renders a transaction state as
`awaiting_verification` — the raw column value, with the underscore — where
every other surface renders it as prose. Cosmetic, and visible on the mobile
Agency hub screenshot in the User Manual.

---

<a id="l-01"></a>
## L-01 — No provider API integration (Limitation)

POLYTOS does not talk to MTN, Airtel or any partner bank. A counter completes
the transaction on the provider's own handset or terminal and records the
confirmation code in POLYTOS. The README lists MTN and Airtel APIs, SMS and
WhatsApp among the integrations the business has deferred.

**Consequence.** Float and commission figures are only as good as what was
keyed in, which is exactly why float reconciliation against the provider's own
statement is a daily control rather than a formality.

---

<a id="l-02"></a>
## L-02 — No native mobile application (Limitation)

POLYTOS is a web application with a responsive layout and an installable
home-screen shortcut. There is no Android or iOS application. Every “mobile”
screenshot in both manuals is the real responsive interface at 390 × 844, and
neither manual portrays it as a native app.

---

<a id="l-03"></a>
## L-03 — Bank advance is specified and deliberately not implemented (Limitation)

`docs/POLYTOS-AGENCY-BANK-ADVANCE-MODEL.md` is marked **SPECIFICATION ONLY —
deliberately not implemented**. Under the cash-payable model a withdrawal may
not take a partner bank's payable into net debit, and there is no flag,
override or capability that relaxes it.

This is a design decision rather than a gap, and the manuals state it plainly
because “agent banking working float” is a phrase that means something
different under each of the two money models.

---

<a id="l-04"></a>
## L-04 — Categories in the catalogue that were not exercised (Limitation)

The provider catalogue ships rows for utilities (UEDCL Yaka, NWSC Water),
television subscriptions (DStv, GOtv), airtime and data (Lycamobile) and school
fees. All arrive provisional and inactive.

This documentation brought **mobile money** (MTN, Airtel) and **agency banking**
(Stanbic) live and traded on them. The other categories are documented from
their configuration and their journal shapes, and are **not** claimed to have
been exercised end to end. Bringing one live follows the same six steps as
Chapter 7.

---

## Things that worked exactly as designed

Worth recording, because a findings report that lists only problems misleads.

- **Maker-checker held everywhere it was tested.** Capital could not be
  verified by the person who recorded it; provider terms could not be approved
  by the person who registered the provider; a bank deposit could not be
  cleared by the person who banked it. Each refusal named the rule.
- **The dependency order is enforced and self-explaining.** Four successive
  go-live refusals taught the correct sequence without reference to any
  documentation.
- **The books balanced throughout.** After configuring an organisation,
  introducing UGX 20,000,000 of capital, allocating it across five accounts,
  banking cash, funding three floats and trading, the trial balance read
  **debits 26,853,401 = credits 26,853,401**.
- **The allocation came out exactly.** Cash 8,000,000 + bank 5,000,000 + MTN
  float 3,000,000 + Airtel float 2,000,000 + Stanbic float 2,000,000 =
  20,000,000, with `3000 Owner Capital` credited **once**.
- **Rate limiting works**, including against this project's own scripted
  sign-ins, which is how it was noticed.
- **A duplicated bank deposit was recoverable through a real workflow** —
  investigate, then confirm the physical cash return — rather than needing a
  database edit.
- **338 of 340 scripted captures** across 4 roles, 2 widths and 170 screens
  rendered without an error boundary. The two failures are F-02.
