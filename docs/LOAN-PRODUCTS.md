# Loan products

What the business sells, where each term comes from, and which rule wins when
two places could answer the same question.

Phase 12 of the platform upgrade (migrations `20261012000200`–`20261012000700`)
replaced one implicit product — whatever `business_settings` said — with a
configurable catalogue the Owner maintains from a screen.

---

## 1. The catalogue

| Code | Name | Status | Amount | Standard rate | Duration | Application |
| --- | --- | --- | --- | --- | --- | --- |
| `QL` | Quick Loans | Offered | 100,000 – 2,000,000 | 15% / month | 1 month | Quick advance |
| `SL` | Salary Loans | Offered | 200,000 – 20,000,000 | 12% / month | 1–3 months | Salaried employment |
| `BL` | Business Loans | Offered | 300,000 – 20,000,000 | 15% / month | 1–3 months | Business |
| `IL` | Individual Loans | Offered, **default** | 100,000 – 20,000,000 | 15% / month | 1–3 months | Individual |
| `IL-LEGACY` | Individual Loan (migrated) | Withdrawn | 100,000 – 20,000,000 | 15% / month | 1–3 months | Individual |

Nothing above is compiled into the application. Every figure is a column on
`loan_products`, and `/settings/products` is where the Owner changes it.

### Why `IL-LEGACY` exists

33 loans predate the catalogue. Nothing in their records says which product
they would have been sold under, and guessing would put a label on a contract
that never carried one. So they are assigned to an explicitly named,
**inactive** product configured with exactly the terms those loans actually
carry — 15% a month, 1–3 months, grace 3 days, penalty 50% — and it cannot be
chosen for a new application.

No historical figure was changed by the migration. The product field is
populated truthfully, and a report that groups by product shows those loans as
what they are: lending the business did before it had named products.

---

## 2. Precedence, stated once

Two places hold lending rules, so the rule about the rules matters more than
either of them.

1. **`business_settings` is the guard rail.** Its amount range, term range,
   interest ceiling and penalty ceiling bound what any product may offer.
2. **The product is the source of truth for a loan.** Within the guard rail,
   the product decides the amount range, the rate and its band, the method, the
   term options, the cadences, the grace period, the penalty, whether a
   guarantor or collateral is required, and what happens on early or extra
   payment. `business_settings` is consulted only where the product is silent.
3. **`max_active_loans_per_client` stays global and only global.** It is a fact
   about the borrower, not about the product — a per-product limit would let
   somebody hold one of each.
4. **At approval the effective terms are snapshotted** onto
   `loan_product_snapshots`, and nothing afterwards rewrites them.

### The guard rail holds in both directions

| Change | What happens |
| --- | --- |
| A product steps outside `business_settings` | Refused by `loan_products_within_business_rules` (a trigger on the product), naming the limit. |
| `business_settings` is narrowed so an **active** product no longer fits | Refused by `business_settings_keep_products_valid` (a trigger on the settings row), naming the product and saying to reprice or withdraw it. |

Only the first half existed in `20261012000200`. Without the second,
lowering the business maximum would have been accepted and left four products
quietly offering more than the business permits — the rail would then apply
only to products saved afterwards, which is exactly the "two conflicting
sources of truth" this document exists to prevent.

A **withdrawn** product is ignored by the second half: it cannot be chosen for
a new application, so it cannot lend anything, and it must not be able to block
a business decision. Its existing loans are untouched either way.

### The practical consequence

Narrowing the business rules is a two-step operation, in this order:

```
1. Reprice (or withdraw) every product that would fall outside the new rules.
2. Save the new business rules.
```

Widening goes the other way: save the rules, then widen the products. The
settings screen says so before the button is pressed, and the refusal names the
product when somebody tries it the wrong way round. `narrowLendingRules()` in
`tests/helpers/loan-fixtures.ts` does both steps and hands back an exact
restore; `applyLendingTerms()` in `tests/helpers/delinquency-fixtures.ts`
opens the rail, moves the product and closes the rail, which works in either
direction.

### The interest ceiling is twice the standing rate

Not the standing rate itself. A product may legitimately price risk above the
business default, and a ceiling equal to the default would make every product
identical. What the rule refuses is a rate nobody intended to type.

---

## 3. The rate on a loan

Three columns, and the distinction between them is the thing to understand:

| Column | Meaning |
| --- | --- |
| `loan_products.default_interest_rate_bps` | What this product is priced at. |
| `loans.proposed_interest_rate_bps` | A rate somebody deliberately chose instead. `NULL` means "the product's standard rate", which is the ordinary case. |
| `loans.interest_rate_bps` | The rate the loan was **approved** at. `NOT NULL`; a draft carries a placeholder until approval writes the agreed figure. |

`proposed_interest_rate_bps` exists because `interest_rate_bps` cannot carry
the distinction: it is `NOT NULL` and a draft has to be savable, so every draft
is written with a placeholder. The first version of `approve_loan` read the
override off it and so wrote every loan at the placeholder rate instead of the
product's.

An override is permitted only where the product allows one
(`interest_override_allowed`), only inside the product's own band, and
`loan_product_snapshots` records that it happened and who approved it:

```
interest_rate_overridden  boolean   not null default false
overridden_by             uuid      → profiles
overridden_by_label       text      -- CHECK: present whenever overridden
```

A rate that differs from the product default with nobody named is what an
auditor looks for, so the constraint makes it impossible.

---

## 4. What approval does

`approve_loan` (re-emitted in `20261012000700`) runs these in order:

1. Lock the loan row; refuse unless it is `pending_approval`; check
   `loans:approve`.
2. Read the loan's product. A loan whose product names nothing is refused.
3. **`validate_loan_for_approval` first** — it owns the documented failure
   vocabulary (`below_minimum`, `term_requires_higher_amount`,
   `client_not_active`, `guarantor_incomplete`, …) that the UI maps onto
   fields. Putting the product checks ahead of it, as `20261012000300` did,
   turned a 150,000 application against a 250,000 floor into a sentence about
   Individual Loans instead of `below_minimum`.
4. The product's own checks, which say only what the validator does not cover:
   a rate the product does not permit, an amount outside the *product's* range,
   a duration not on its menu, a cadence it does not offer.
5. Compute the breakdown from the effective rate; write the contractual
   periods, the client snapshot, the guarantor snapshots and the identity
   snapshots.
6. Write the terms onto the loan.
7. `capture_loan_product_snapshot` — last, because it reads the rate and the
   applied grace and penalty off the loan that step 6 has just written.

A failure anywhere leaves the loan awaiting approval. An **inactive** product
may still be approved against: the loan was taken under it, and retiring a
product must not strand an application already in the pipeline.

---

## 5. The snapshot

`loan_product_snapshots` is append-only — `UPDATE` and `DELETE` are both
refused by trigger, the same discipline `loan_client_snapshots` carries.

It holds the product's code and name, the amount range, the agreed rate and
method, the term range, the cadence, the applied grace period and penalty, the
security requirements, the early/extra payment rules, the application profile,
and the override fields above.

A borrower may read the snapshot for **their own** loan: the terms they agreed
to are theirs to see. Everybody else needs `loans:view`.

This is what makes repricing safe. Change a product tomorrow and every loan
approved yesterday still says what it said — on the loan row, in the snapshot,
in every report and on the borrower's statement.

---

## 6. The application profile

A Salary Loan asks for an employer and a payslip; a Business Loan asks for
turnover and a trading licence. Those are *different questions*, not different
columns on `loans`: putting them there would add thirty nullable fields of
which at most a third apply to any row, and no constraint could say which.

So a product names an `application_profile` — `individual`, `salary`,
`business` or `quick` — and Phase 4 hangs the product-specific answers off the
loan in their own typed table.

`requires_supporting_documents` is what makes a Quick Loan quick: it turns off
the demand for the product's documents *before submission*. It does not weaken
approval, which is unchanged for every product — every validation rule, every
capability check and every snapshot still applies.

---

## 7. Who may change a product

| Capability | Held by | What it opens |
| --- | --- | --- |
| `products:view` | Secretary/Treasurer, Manager, Owner | Read the catalogue and its terms. |
| `products:manage` | Owner only | Create a product, change its terms, retire or re-offer it, set the default. |

Pricing is the Owner's. A Manager who could edit a product could lend at a rate
nobody agreed, which is the same reason `settings:update` is not theirs.

Three things nobody may do:

- **Delete a product.** The privilege is not granted at all. A product with
  loans written against it is named by every one of their snapshots; retiring
  is `status = 'inactive'`, which is reversible.
- **Rename a product's code.** `loan_products_stamp_actor` restores it. The
  code appears on every snapshot, export and report, so renaming it would
  relabel history.
- **Reassign authorship.** `created_by` and `updated_by` are stamped from the
  session by the same trigger.

Every create and every change writes a `product.created` / `product.updated`
row to `audit_log`, with the product's id and the values before and after.
`business_settings` and `company_settings` have been audited the same way since
Phase 2; a product is now where the rate actually lives, so it is audited too.

---

## 8. The default product

`loan_products.is_default` — one explicit flag, with
`create unique index loan_products_one_default on loan_products ((true)) where is_default`
so two defaults cannot exist even for an instant, and a CHECK that only an
active product may be it.

Explicit rather than "whichever sorts first", because sort order is about how a
picker reads and this is about what the business does by default. The first
draft of the table conflated the two, which quietly made every unnamed loan a
Quick Loan with a one-month ceiling.

`loans_stamp_product` supplies it when a caller names no product, exactly as
`loans_stamp_branch` supplies the branch — so nothing that creates a loan today
needs to know products exist. Phase 4 gives the application a product picker
and this stops firing, without anything in the database changing.

Withdrawing the default product clears the flag in the same statement.
Refusing the withdrawal instead would mean the business cannot retire a product
without first nominating its replacement in a separate step it was given no
prompt to take.

---

## 9. A retired cadence does not freeze the catalogue

`loan_products_within_business_rules` checks that every cadence a product
offers is an active row in `repayment_frequencies` — but only when the list is
being **set** (on insert, or on an update that changes the array or the
default). `20261012000600` made that conditional.

Before it, retiring "every 3 days" meant no product that had ever offered it
could be saved at all: changing such a product's rate was refused with a
message about a cadence, and the only way out was to edit a field the Owner had
not come to edit.

A product left holding a retired cadence is not thereby lending on it:
`generate_loan_schedule` reads `repayment_frequencies` and refuses an inactive
one, which `tests/db/schedule-generation.test.ts` asserts.

---

## 10. Where this is enforced, and where it is only explained

| Rule | Enforced by |
| --- | --- |
| A product fits inside the business rules | `loan_products_within_business_rules` (trigger) |
| The business rules still fit every active product | `business_settings_keep_products_valid` (trigger) |
| The standard rate is inside the product's own band | `loan_products_default_rate_in_band` (CHECK) |
| A product requiring a guarantor asks for at least one | `loan_products_guarantor_count_consistent` (CHECK) |
| One default, and it is active | `loan_products_one_default` (unique index) + `loan_products_default_is_active` (CHECK) |
| An override is permitted, inside the band, and attributed | `approve_loan` + `loan_product_snapshots_override_named` (CHECK) |
| The agreed terms never change | append-only triggers on `loan_product_snapshots` |
| Only the Owner writes a product | RLS policies on `loan_products` (`products:manage`) |
| Nobody deletes a product | no DELETE privilege granted |

Everything in `lib/validation/loan-product.ts` is a *restatement* for the
benefit of the person filling the form — it puts the message on the field that
is wrong. Nothing depends on it being correct: the database refuses the same
writes whatever asks it.

`tests/db/loan-products.test.ts` drives all of the above as a real database
role, with no application code involved.
