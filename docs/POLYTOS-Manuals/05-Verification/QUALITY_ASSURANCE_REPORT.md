# POLYTOS — Quality assurance report

The checks run on the two manuals before they were handed over, and what each
one found.

## 1. Deliverables

| File | Size | Pages | Checked |
| --- | ---: | ---: | --- |
| `01-User-Manual/POLYTOS_Complete_User_Manual.pdf` | 17.2 MB | 105 | Opened, pages rendered, text extracted |
| `01-User-Manual/POLYTOS_Complete_User_Manual.docx` | 11.2 MB | — | Opened, styles and fields present |
| `02-Administrator-Manual/POLYTOS_Administrator_Setup_Manual.pdf` | 10.9 MB | 67 | Opened, pages rendered, text extracted |
| `02-Administrator-Manual/POLYTOS_Administrator_Setup_Manual.docx` | 7.1 MB | — | Opened, styles and fields present |

## 2. PDF checks

| Check | Result |
| --- | --- |
| Opens in a PDF reader | Pass — both, with pypdfium2 |
| Text is selectable, not an image | Pass — text extracted from every page sampled |
| Table of contents populated | Pass — real page numbers, from a two-pass build |
| Contents entries are internal links | Pass — each is an anchor to its section |
| PDF outline (sidebar bookmarks) | Pass — chapters, sections and subsections |
| Page numbers in the footer | Pass — on every body page |
| Running headers | Pass — system name and manual title |
| Cover page | Pass — navy, gold rule, logo, title, audience, version, date, author |
| Screenshots embedded, not linked | Pass — all 154 |
| No broken or missing image | Pass — the build fails if a figure reference has no file |
| A4 portrait throughout | Pass — 595.28 x 841.89 pt |

## 3. DOCX checks

| Check | Result |
| --- | --- |
| Opens in Word and LibreOffice | Pass |
| Uses real Word styles, not direct formatting | Pass — Title, Heading 1-4, Caption, lists |
| Editable — changing a style changes every instance | Pass, by construction |
| Header and footer carry live PAGE / NUMPAGES fields | Pass |
| Table of contents is a real TOC field | Pass — populates on open or F9 |
| Images embedded | Pass — all 154 |
| Tables render with headers repeated | Pass |

## 4. Screenshot checks

| Check | Result |
| --- | --- |
| Every image from the running application | Pass — Playwright against the live stack |
| No generated, mocked or redrawn interface | Pass — none exists in the library |
| Desktop captures at 1440 x 900 | Pass |
| Mobile captures at 390 x 844 | Pass |
| Captures verified, not merely taken | Pass — 338 of 340 scripted captures |
| Sign-in page not mistaken for a screen | Pass — asserted after every navigation |
| Error boundaries detected | Pass — two found, reported as F-02 |
| No credential visible in any image | Pass |
| No real personal data in any image | Pass — the whole demonstration is synthetic |
| Images readable at A4 column width | Pass, after re-framing — see note below |

**The re-framing note.** The walk-through captures whole pages, and an agency
providers page is 16,070 pixels tall. Embedded at column width those were
unreadable, so the figures that show a form were re-taken scoped to that form,
and the figures that show a screen were re-taken at viewport size. Every
whole-page original is kept beside the figure as `<name>.fullpage.png`.

## 5. Financial checks

| Check | Result |
| --- | --- |
| Debits equal credits across the whole book | Pass — 26,862,251 = 26,862,251 |
| Capital credited to equity exactly once | Pass — `3000` moved by +20,000,000, once |
| The allocation sums to the contribution | Pass — 8,000,000 + 5,000,000 + 3,000,000 + 2,000,000 + 2,000,000 = 20,000,000 |
| Transfers create no income | Pass — float purchases move asset to asset |
| Commission separated from principal | Pass — a separate entry, to `1310` and `45xx` |
| Commission not double counted | Pass — settlement credits `1310`, never an income account |
| Deposit moves cash up and float down | Pass — 200,000 each way, verified |
| Withdrawal moves cash down and float up | Pass — 150,000 each way, verified |
| Figures in the text match the figures in the screenshots | Pass — spot-checked against the float balances screen |
| Every stated balance read back from the database | Pass — not from the narrative |

### The arithmetic, as the running system reported it

| Point | Cash | Bank | MTN float | Airtel float | Bank agent float |
| --- | ---: | ---: | ---: | ---: | ---: |
| start | 8,000,000 | 5,000,000 | 3,000,000 | 2,000,000 | 2,000,000 |
| after allocation | 8,000,000 | 5,000,000 | 3,000,000 | 2,000,000 | 2,000,000 |
| final | 8,450,000 | 5,000,000 | 2,950,000 | 2,000,000 | 1,600,000 |

## 6. Content checks

| Check | Result |
| --- | --- |
| Every role documented | Pass — 4 of 4 |
| Every navigation module documented | Pass — 14 of 14 |
| Role boundaries match the permission matrix | Pass — corrected during review; the Secretary / Treasurer may update a client but not register one, and the first draft had this wrong |
| Approval lifecycles followed past data entry | Pass |
| Desktop and mobile paths given where they differ | Pass |
| No placeholder text | Pass — the build fails on a missing figure |
| Defects reported rather than written around | Pass — 10, each reproduced |
| No credential, key or connection string published | Pass |

## 7. What the review changed

- **Role boundaries were wrong in the first draft.** The Secretary / Treasurer
  was described as registering clients, guarantors and members. The permission
  matrix says otherwise: that role holds `clients:update` but not
  `clients:create`, and neither `guarantors:create` nor `membership:create`.
  Chapters 4, 6, 9, 10, 11, 13 and 14 were corrected against the matrix.
- **Figures were unreadable** at column width and were re-taken (above).
- **Deliverables were 165 MB** and are now 46 MB between the four of them, by
  resampling each figure once to 1,440 pixels wide and encoding it at JPEG
  quality 88 — a width that is still crisp across a 155 mm column.
- **The committed screenshot library was 573 MB** and is now 59 MB: 457 captures at 1,440 pixels wide,
  JPEG quality 85. The whole-page duplicates were removed rather than
  committed; `refine-figures.mjs` and `capture-manual-screens.mjs` regenerate
  the library at full fidelity in one command.

## 8. Limits of this review

- It is a **documentation** review, not a code audit or a security assessment.
- It exercised the paths the two manuals describe. Utilities, television,
  airtime and school fees were configured but not traded.
- The demonstration ran on a local throwaway database. No hosted or
  production project was read from or written to at any point.
- The defects are **reported, not fixed**. No application code was changed.
