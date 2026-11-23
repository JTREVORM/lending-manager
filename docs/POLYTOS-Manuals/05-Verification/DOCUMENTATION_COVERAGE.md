# POLYTOS — Documentation coverage

What the two manuals cover, measured against the application rather than
against a plan.

## Headline

| Measure | Count |
| --- | ---: |
| Roles the application implements | 4 |
| Roles documented, one chapter each | 4 |
| Capabilities in the permission matrix | 130 |
| Navigation modules | 14 |
| Navigation entries | 126 |
| Distinct routes behind them | 68 |
| Distinct routes photographed and verified | 68 |
| Route coverage | 100% |
| Manual chapters | 28 (User) + 15 (Administrator) = 43 |
| Figures embedded | 154 distinct screenshots |
| Worked financial examples verified against the ledger | 11 |
| Defects found, reproduced and reported | 10 |
| Limitations recorded | 4 |

## Role coverage

| Role | Capabilities | User Manual chapter | Screens photographed as this role |
| --- | ---: | --- | ---: |
| Secretary / Treasurer | 54 | 4 | 80 |
| Manager | 96 | 3 | 116 |
| Owner / Administrator | 129 | 2 | 136 |
| Client | 3 | 5 | 2 |

All four roles are documented. POLYTOS implements no others — there is no
separate cashier, teller, accountant or auditor role, and the manuals say so
rather than inventing chapters for roles that do not exist. The counter role
is the Secretary / Treasurer (User Manual Chapter 4); oversight is the
`audit:view` capability, held by the Owner / Administrator alone (F-06).

## Module coverage

| Module | Entries | Routes | Photographed | User chapter | Administrator chapter |
| --- | ---: | ---: | ---: | --- | --- |
| Clients | 7 | 3 | 3/3 | 9 | — |
| Membership | 8 | 4 | 4/4 | 10 | 12 |
| Member Savings | 5 | 3 | 3/3 | 11 | 12 |
| Member Lending | 4 | 2 | 2/2 | 12 | 12 |
| Member Benefits | 9 | 8 | 8/8 | 13 | 12 |
| Meetings | 4 | 2 | 2/2 | 14 | — |
| Loan Management | 14 | 4 | 4/4 | 15 | 12 |
| Collections | 8 | 4 | 4/4 | 16 | — |
| Debt & Security | 12 | 8 | 8/8 | 17 | — |
| Finance | 10 | 10 | 10/10 | 18 | 5, 6 |
| Agency | 27 | 18 | 18/18 | 19–22 | 7–11 |
| Reports | 5 | 1 | 1/1 | 23 | 14 |
| Branch Network | 4 | 4 | 4/4 | 8 | 3 |
| Administration | 9 | 5 | 5/5 | 24 | 1, 2, 4, 13 |

## Financial workflows documented end to end

Each of these is documented from entry through approval to posting, with the
balances before and after read back out of the running system.

| # | Workflow | Verified result |
| --- | --- | ---: |
| 1 | Capital introduced, recorded and verified | `3000` credited once, +UGX 20,000,000 |
| 2 | Allocation of that capital across five accounts | sums to UGX 20,000,000 exactly |
| 3 | Banking cash, recorded then cleared | UGX 5,000,000 via Cash in Transit |
| 4 | A duplicated deposit investigated and returned to the till | cash restored to UGX 8,000,000 |
| 5 | MTN float purchased out of cash | UGX 3,000,000 |
| 6 | Airtel float purchased out of cash | UGX 2,000,000 |
| 7 | Bank agent float purchased out of cash | UGX 2,000,000 |
| 8 | MTN deposit, recorded, submitted, verified, posted | cash +200,000 / float −200,000 |
| 9 | MTN withdrawal, recorded, submitted, verified, posted | cash −150,000 / float +150,000 |
| 10 | Bank agency deposit, recorded, submitted, verified, posted | cash +400,000 / float −400,000 |
| 11 | Commission recognised on all three | UGX 8,850 to `1310` and the `45xx` series |

**Trial balance after all of it: debits 26,862,251 = credits 26,862,251.**

## What is not claimed

- **Utilities, television, airtime and school fees were not traded.** Those
  provider categories ship in the catalogue, arrive provisional and inactive,
  and are documented from their configuration and journal shapes only (L-04).
- **No provider API was exercised**, because none exists (L-01).
- **Branch creation was not performed through the application**, because it
  cannot be (F-01).
- **An equity capital contribution was not recorded through the screen**,
  because it cannot be (F-04). It was recorded through the function the
  screen calls, and that is stated wherever it matters.
- **Loan origination, membership enrolment and benefit payment were
  documented from the seeded demonstration book** rather than performed from
  scratch during this project. The screens are real and the figures are the
  application's own.

## Coverage statement

Every one of the 14 navigation modules is documented. 68 of the 68 distinct routes behind the navigation rail
were photographed and verified; the remainder are the query-string filters of
routes already photographed, which render the same screen.

This is **not** a claim of 100% coverage. The exclusions above are real, and
the ten defects in `06-Findings/FINDINGS_AND_GAPS.md` mean parts of the
documented configuration path cannot currently be completed in the
application at all.
