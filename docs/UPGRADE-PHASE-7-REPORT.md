# Platform upgrade, Phase 7 — the Reports Center

Phase 7 of the plan in `PLATFORM-UPGRADE-PLAN.md`: a reusable framework behind
every report, branded PDF exports that are documents rather than pictures of a
web page, and the four Debt & Security reports the module had views for and no
way to print.

How the module works is in `REPORTING.md`. This is the evidence that it holds
and that nothing already working was broken.

---

## 1. No migration

Phase 7 adds **no schema change**. That is the point of the ordering: Phase 14
built `loan_aging`, `portfolio_at_risk`, `guarantor_exposure`,
`loan_recovery_register` and `loan_collateral_register`, and Phase 16 reads
them. The live database is untouched, the migration registry is unchanged at
`20261015000300`, and the live verification below is a read-only check that
each report returns what it claims against the real dataset.

No new capability either. The ten reports sit behind the three that already
exist — `reports:view_operational`, `reports:view_financial` and the
capability of the data each one renders.

## 2. The duplication this phase removed

A report used to exist in five places, each of which had to be remembered:

1. the page that rendered it,
2. the export route that re-ran it,
3. the CSV column builder,
4. the `REPORTS` array on the hub,
5. the capability list, written out in both the page and the route.

None of those failing is loud. A report added without a hub entry simply does
not appear, so nobody can find it. A capability list that drifts between a page
and its export route is a security defect that looks like a typo — and it is
the *route* that matters, because a download URL can be typed.

`lib/reports/registry.ts` is the one declaration now, and everything is derived
from it:

| Derived | From |
| --- | --- |
| The hub's cards, groups and period chips | `REPORTS`, mapped |
| Each page's capability check | `guardReportPage(reportHref(id), REPORTS[id].needs)` |
| Each export route | `export const GET = reportExportRoute('<id>')` — one line |
| The CSV columns | `csvColumns(definition.fields(...))` |
| The PDF columns | the same `fields`, same order, same headings |
| The export link's query string | `filterKeys` — which is why `page` can never reach a download |

The page and the route now read the **same object** for their capability list,
so they cannot differ. `tests/integration/report-routes.test.ts` pins each
list against an expectation and asserts every page passes the registry's own
array rather than a literal.

`LOADERS` in `lib/reports/export.ts` is a mapped type over `ReportId`, so two
mistakes became compile errors rather than runtime ones: adding a report
without a loader, and writing a loader that returns rows the report's fields
cannot read. Both fired during this phase, which is what the type is for.

## 3. One column, two renderings, no drift

A column is declared once as a **field** — a heading, a reader, and a kind —
and the renderings follow from the kind. Money is `1,250,000` on a screen and
in a document, and `1250000` in a spreadsheet, because the screen is for
reading and the file is for totalling. Text is disarmed in the CSV — a leading
`=`, `+`, `-` or `@` neutralised — and left exactly as typed everywhere else,
where there is no formula engine to defend against.

Five `*CsvColumns` builders went. The replacement provably changed nothing:
`tests/unit/report-fields.test.ts` renders the same rows through both and, now
the builders are gone, pins every heading row in full. Those strings were
captured from the old builders before they were deleted.

Two headings a fresh design would have written differently were deliberately
kept, because a download's shape is a contract:

* `Rate (basis points)` on the penalty report rather than a percentage. Basis
  points are how the rate is stored and how the charge was computed, and a
  financial report is the one place the precise unit beats the readable one.
* `Has active loan` as `yes` / `no`, because that is what the existing file
  contains and what a spreadsheet filter is already written against.

## 4. The PDF

### Written, not installed

`lib/reports/pdf-writer.ts` is a complete PDF writer in one file: page tree,
content stream, cross-reference table, and the standard-14 Helvetica metrics
generated into `helvetica-metrics.ts` from Adobe's own AFM data by
`scripts/gen-font-metrics.py`. Embedding a font programme — the part that
usually forces a dependency — is not needed, because Helvetica and
Helvetica-Bold are two of the fourteen faces every conforming reader carries.

So the application's ten runtime dependencies are still ten. `pdfjs-dist` was
added as a **development** dependency, to be an independent reader in the
tests; it never ships.

### The constraint, as an assertion

The brief's rule is that an export must not be a screenshot of a browser. The
tests read the generated files back with `pdfjs-dist` and assert that
`Nakimuli Zaïnabu` and `UGX 1,250,000` come *out* of them as strings. A
screenshot has no text to extract, so that is the constraint itself rather than
a promise about it. The browser suite repeats it against every report's real
download: `/BaseFont /Helvetica` present, text-showing operators present, and
the company name the application is displaying found in the file.

### What every page carries

The first page carries the letterhead from `DocumentBranding` — the same shape
the receipt and the loan statement use, so a borrower holding a receipt and a
manager holding an arrears report see one identity, from one row of
`company_settings`. Continuation pages carry a one-line running head, so a page
separated from the others still identifies itself, and the column headings
repeat. Every page footers who ran it, when, and `Page N of M`.

The mark is a JPEG beside the configured asset, by the same stem: the web uses
the WebP that `company_settings.logo_path` names, and the document uses
`/brand/polytos-logo.jpg`, which `scripts/gen-logo-jpeg.py` generates from it.
A business that replaces its mark changes one row and runs that script, and
both surfaces follow — rather than the web showing the new logo while every
printed report still carries the old one. The script reproduces the committed
asset byte for byte, which is how it was checked.

The stored path reaches `readFile`, so it is whitelisted rather than escaped,
and that check lives in `lib/reports/letterhead.ts` with no `server-only`
marker — a control that cannot be unit-tested is a control nobody can be sure
of. `tests/unit/letterhead.test.ts` puts seventeen values through it: a
traversal, a URL, a null byte, a shell metacharacter, a bare name, and the
property that whatever comes back is a single rooted path with no `..` in it.

A mark that cannot be read does not fail the report: a letterhead with the
name, tagline, numbers and addresses but no mark is still a letterhead.

### ADR-042 holds in both formats

A selection that hits the export ceiling keeps its rows and loses its totals,
with the reason printed where the totals would have been. It matters more in a
PDF than a CSV: a spreadsheet totals the column itself, while a PDF's printed
total is the figure somebody circulates.

## 5. Four reports the module had no document for

Phase 14 built the views and the worklists. What it had no way to produce was a
*document*.

| Report | Route | Capability |
| --- | --- | --- |
| Aging and portfolio at risk | `/reports/aging` | `reports:view_financial` + `delinquency:view` |
| Recovery file | `/reports/recovery` | `reports:view_operational` + `recovery:view` |
| Guarantor exposure | `/reports/guarantors` | `reports:view_financial` + `guarantors:view` |
| Security held | `/reports/collateral` | `reports:view_financial` + `collateral:view` |

Each reads the Phase 14 view through an export-shaped loader added beside the
operational one in `lib/data/security.ts` — sharing its column list and its
mapper, because a second copy of `AGING_COLUMNS` is the thing that drifts, and
a report whose columns had drifted from the screen's would disagree with it
about the same loan.

**They are not near-copies of the worklists.** An operational screen is for
doing: `/recovery` is ordered worst-first with the controls to record a call
beside each row. A report is for accounting: it totals, it says which filters
produced it, it exports and it prints on the letterhead. Each report names its
counterpart on the page and in the hub, so nobody has to work out which of two
similar screens they wanted.

Recovery sits behind the operational capability because chasing a borrower is a
Secretary/Treasurer's work. The other three total the *book* — what proportion
is at risk, what the business is covered for, what its security is worth — and
§98's rule is that a report sits behind the capability of the question it
answers. The underlying registers stay open to the roles that work from them.

## 6. A defect the parity method caught

The guarantor report's "live cover" total was wrong, and the way it was found
is the reason that method exists.

`guarantor_exposure.guaranteed_amount` is the **loan's** `principal_amount`,
not a per-guarantor share of it: the view's framing is that a guarantor stands
behind the whole loan. The first version of the total summed that column over
the live guarantee rows — so a loan with two guarantors contributed its
principal twice. On a product that requires two guarantors, the figure would
have been double the book, and it would have looked entirely plausible.

Writing the reconciliation in SQL against the base tables is what exposed it:
the column did not exist on `loan_guarantors` at all, which sent me to the view
definition. The total now counts one principal per distinct loan with a live
guarantee, the outstanding and arrears figures with it, and the card says how
many loans the figure is of. `tests/db/security-report-totals.test.ts` pins it,
including that the naive sum really is larger — so the rule is not academic.

The same test pins the other two exclusions, which are the same shape:

* **Held, valued at** counts items still held. An item released is back with
  the borrower and an item sold is gone; including them would say the business
  is secured against things it has handed back.
* **Sold for** counts realised items' proceeds, not their valuations. On one
  fixture loan that is 2,900,000 against a 3,500,000 valuation — confusing the
  two would overstate recovery by 600,000 on one item.

A second mistake of mine, found the same way: a field comment claimed
`guaranteed_total` was "the guarantor's whole exposure across this loan's
guarantees". It is the loan's total expected repayment. The column is now
`Total repayable` and says what it is.

## 7. A second defect, in the PDF layout

The first version of the page layout divided the width by the fields' weights
alone. With the four-column fixture the unit tests used, that is 180pt a column
and everything reads. With the reports this application actually ships it was
this:

| Report | Columns | Narrowest column | Characters it held |
| --- | --- | --- | --- |
| Arrears | 27 | 16.7pt | 2 |
| Guarantor exposure | 22 | 20.6pt | 3 |
| Loan portfolio | 21 | 22.8pt | 3 |
| Security held | 20 | 23.3pt | 3 |
| Aging | 18 | 27.7pt | 4 |

Every cell on the arrears report read `Na…`. The unit tests passed, because
their fixture had four columns. The browser tests passed, because they asked
whether *some* text was in the file rather than whether the values survived. A
document where every cell is an ellipsis is worse than no document, and it
would have shipped.

It was found by measuring the real field sets rather than the fixture —
re-reading the diff and asking what would make a printout useless, which is
the question a passing test suite had not been asked.

### What replaced it

Two changes, and the second matters more than the first.

**Column floors, not weights.** Each kind of value gets a minimum width taken
from what it has to hold: `1,250,000` measures 35.6pt, so money and counts get
44 with padding; `2026-10-11` gets 48; `11 Oct 2026, 09:30` gets 76; a name
gets 56, which holds "Nakimuli Zaï…" — enough to tell two borrowers apart,
which is that column's actual job. The weights now distribute only what is
*left over*, so they still give a note column more room than a date column
without being able to starve either.

**Banding.** A twenty-seven column report does not fit an A4 page in any
typography, so the columns are split across page widths — columns 1–14 over
however many pages the rows need, then columns 15–27 over the same rows again.
Every band after the first repeats the report's first column, because without
it the second band is a page of figures nobody can line up against the first,
and each band is headed with "Columns 15 to 27 of 27, with Loan number
repeated. The same rows throughout."

Headings wrap to two lines rather than truncating, which is what lets the
floors be driven by the values: "Oldest missed collection" sits on two lines
over a 48pt date column instead of dragging it 110pt wide.

The bands are **balanced**, not filled greedily. The first attempt filled each
band to the brim, which left the recovery report split 14 and 1 — one column
and an anchor alone on a landscape page. The split is now even: 7 and 8.

| Report | Columns | Bands | Pages for 40 rows | Size |
| --- | --- | --- | --- | --- |
| Collections | 16 | 1–7, 8–16 | 4 | 89KB |
| Loan portfolio | 21 | 1–10, 11–21 | 4 | 104KB |
| Arrears | 27 | 1–14, 15–27 | 4 | 110KB |
| Late-payment charges | 13 | one band | 2 | 89KB |
| Clients | 13 | one band | 2 | 84KB |
| Aging | 18 | 1–8, 9–18 | 4 | 95KB |
| Recovery file | 15 | 1–7, 8–15 | 4 | 85KB |
| Guarantor exposure | 22 | 1–11, 12–22 | 4 | 98KB |
| Security held | 20 | 1–10, 11–20 | 4 | 86KB |

`tests/unit/pdf-report.test.ts` now carries the assertions that were missing: a
twenty-seven column report is built, both bands are labelled, the anchor is
repeated, each band starts its own page, and `1,250,000`, `940,000`,
`Nakato Winnie` and `Mukasa Joseph` all come back out of the file whole. A
further test walks every field set this application ships and checks the bands
cover every column exactly once, in order, with no gap — so a report added
later with thirty columns of prose fails there rather than in a printout.

## 8. Three more, found by looking at a rendered page

Neither of these was visible in a test that only asked whether text was in the
file. Both were found by rasterising a report and reading it.

**Every "nothing recorded" cell printed `?`.** A money column renders an em
dash where the value is null, because "nothing recorded" and "zero shillings"
are different statements — and on the guarantor report, where a reader may not
be entitled to see a loan's balance, that distinction is the whole point. It
came out as a question mark.

The cause was that `toWinAnsi` was not idempotent. A string passes through it
three times in the normal path: `fitText` converts before measuring,
`measureText` converts again, and `PdfPage.text` converts once more before
writing. The first pass turned U+2014 into WinAnsi 0x97 correctly; the second
pass did not recognise 0x97 as one of its own outputs — the 0x80–0x9F band was
treated as unmappable on the way back in — so it substituted. The ellipsis
survived only by accident: `fitText` appends it *after* its own conversion, so
it is converted exactly once.

It is now idempotent for the twenty-six codes that band actually defines, and
still substitutes for the five it leaves undefined. `pdf-writer.test.ts`
asserts both, and asserts the em dash reaches the content stream as `0x97`
rather than `?`.

**Names were truncated while phone columns sat half empty.** With the floors
taking most of the width, the weights decide what is left — and a person's
name carried 2.2 against a phone number's 1.3. "Ssemakula Brian Kato" came out
as "Ssemakula Brian …" on a page where the phone column had room to spare.

A name is the column a reader scans and the one that identifies the row; a
phone number is a *fixed* thirteen characters, so below about 66 points it is
not a phone number but a prefix, and above that extra room buys nothing. The
weight mechanism is the wrong tool for the second case — it shares spare width
in proportion, which is right for a name and wrong for a value of one size. So
the name columns now carry 3.0–3.2, and `phoneField` declares a fixed floor
instead of competing for a share. Every name on the guarantor report fits
whole.

**Every money heading was cut, and lost its unit doing it.** A field's heading
is one string shared by the spreadsheet and the document, because two headings
are two things that drift — and a spreadsheet column genuinely needs `(UGX)`.
On a fourteen-column band that is fourteen repetitions of one fact, and it was
what pushed "Contract outstanding (UGX)" past three lines, so the reader saw
"Contract outstandin…" and lost the unit anyway.

The suffix is now stripped from money headings in the document, mechanically,
and the intro line says "All amounts in UGX" — taken from a money field's own
heading rather than written into the layout, so a business reporting in another
currency gets its own code. That is a *rendering* of the one heading, not a
second one: nothing is declared twice and the CSV is untouched.

### What is left as it is

A free-text column — the latest note on an arrears row, a release reason — is
truncated in the PDF on a report that also carries a dozen figures. Seventy
characters of prose and twelve money columns do not share a page width, and
widening the note squeezes the figures beside it.

That is not worked around. The marker says the value was shortened, the CSV
carries it in full, and somebody who needs the whole note opens the recovery
file report or the client's record, where it has room. A document that dropped
two money columns to fit one note would be the wrong trade for the reader the
document is for.

## 9. What this phase deliberately does not do

**Arbitrary column sorting.** The plan lists "sort" among the harness's
responsibilities, and it is the one part not built generically. Each report
opens in the order its purpose implies — aging worst-first, the recovery file
newest-first, collections by the moment money arrived — and the arrears report
keeps the four sorts Phase 8 gave it, whitelisted as `OVERDUE_SORTS`.

Making it generic would mean every field declaring the database column behind
it, because a field is a *read function* and not a column name. That is a
second declaration to keep in step with the first, on twenty-seven columns
across ten reports, in exchange for a capability the CSV already provides:
somebody who wants the portfolio by any of twenty-one columns opens the
spreadsheet and clicks the heading. Half a sorting feature — some columns
sortable and others not, with no way to tell which from the screen — would be
worse than the clear default each report has now.

**An `.xlsx` writer.** The CSV opens in every spreadsheet this business uses.
A native workbook format would be a dependency and a format to maintain for no
question the CSV cannot answer.

**A report whose rows are a historical snapshot.** Every report here is "as at
now", and says so on the page and in the document. Date ranges select *which
rows* appear, never a balance as it stood on some past date — the same rule
Phase 8 set, for the same reason: a stored opinion about the past is one
nothing will correct.

## 10. Verification

| Suite | Result |
| --- | --- |
| `tsc --noEmit` | clean |
| `eslint .` | clean |
| `prettier --check` | clean |
| Unit + integration | **2,082 passed**, 63 files |
| Database (real PostgreSQL) | **1,256 passed**, 46 files |
| `next build` | succeeds; ten reports and ten export routes |
| Browser (Playwright, desktop + mobile) | **460 passed**, 15 skipped, 18.9m |

New tests this phase:

* `tests/unit/pdf-writer.test.ts` — 21, reading every fixture back with an
  independent PDF engine: metrics, the WinAnsi substitution, truncation at a
  character boundary, string escaping, right alignment, the image passthrough,
  object numbering with no gap, and multi-page documents.
* `tests/unit/pdf-report.test.ts` — 16: the letterhead's whole identity on the
  page, a business with no tagline and one number, pagination with correct
  denominators, repeating headings, continuation-page identity, orientation,
  truncation, the capped-totals rule, and a sweep of six row counts either side
  of the page boundary to prove the totals band never falls off the bottom.
* `tests/unit/report-fields.test.ts` — 14: every heading row in full, the two
  renderings diverging where they should, and the identity-field guard.
* `tests/unit/security-report-fields.test.ts` — 16: the four new reports'
  columns, including every column the brief named for the guarantor register.
* `tests/db/security-report-totals.test.ts` — 8: the three exclusions above,
  reconciled in SQL against the base tables, plus cross-view parity between
  `loan_aging` and `loan_delinquency`.
* `tests/unit/letterhead.test.ts` — 5: the whitelist on the stored logo path.

Rewritten rather than deleted: `tests/integration/report-routes.test.ts` now
asserts the structural property — the registry's list, the page reading it, the
route carrying no list of its own — which is stronger than the source-text
match it replaced. `tests/unit/report-export.test.ts` kept all 25 of its
assertions against the field sets. `tests/integration/phase9-screens.test.tsx`
follows the hub's facts into the registry.

## 11. Live verification

Project `fszgwemtgyrbhngajpzm`. No migration, so nothing was applied. The
migration registry still reads `20261015000300` — Phase 6's last — which is
itself the evidence that this phase changed no schema. The trial balance is
unchanged at 70,496,030 / 70,496,030 over 1,469 lines, variance 0, because a
report writes nothing.

What was checked is that each report returns what it claims against the real
dataset, and that the three exclusions hold there.

**The four Phase 5 views carry data.**

| View | Rows |
| --- | --- |
| `loan_aging` | 17, across the buckets `current`, `1_7`, `8_30` and `31_60` |
| `guarantor_exposure` | 43, of which 42 live and 1 released |
| `loan_collateral_register` | 3 |
| `loan_recovery_register` | 12 |
| `portfolio_at_risk` | the four scopes: `portfolio`, `branch`, `product`, `branch_product` |

**The guarantor defect would have been material.** On the live book:

| Figure | Value |
| --- | --- |
| Distinct loans with a live guarantee | 35 |
| Live cover, counted per loan (correct) | UGX 35,450,000 |
| Live cover, summed per guarantee row (the defect) | UGX 46,350,000 |

The wrong figure was **31% high** — overstated by 10,900,000 — and it would
have looked entirely plausible on a card labelled "Live cover".

**The collateral exclusions, on the live register.**

| Figure | Value |
| --- | --- |
| Held, valued at (what the report shows) | UGX 2,200,000 |
| Every item ever taken, valued at | UGX 2,970,000 |
| Sold for, proceeds (what the report shows) | UGX 300,000 |
| Sold items' valuations | UGX 420,000 |

So the held figure excludes 770,000 of security the business no longer has,
and reporting valuations instead of proceeds would have overstated recovery by
120,000 on three items.

**The audience is enforced on live data.** Reading `notification_summary`-style
checks as the real accounts: a Secretary/Treasurer *can* read every one of the
four views — Row Level Security admits the rows, because they work from the
registers — and holds `reports:view_operational` and `recovery:view` but not
`reports:view_financial`. So the recovery report is theirs and the aging,
guarantor and collateral reports are not, which is §98's rule working: the
report sits behind the capability of the question it answers rather than the
capability of the data it happens to read.

## 12. Commit

`claude/epic-mendel-rpimtt`.
