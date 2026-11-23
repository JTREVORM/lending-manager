# POLYTOS Management System — Documentation

Client-ready manuals for the POLYTOS Management System, prepared by **Trevor
Digital Solutions**, version 1.0, issued 23 November 2026.

Everything here was produced by configuring and operating a real POLYTOS
instance end to end. Every screenshot is of the running application, driven
through its own sign-in form by a real account. Nothing is illustrated, mocked
up or redrawn, and where the application could not do something the manuals
say so and name the finding.

---

## The deliverables

| File | For | Pages |
| --- | --- | ---: |
| [`01-User-Manual/POLYTOS_Complete_User_Manual.pdf`](01-User-Manual/POLYTOS_Complete_User_Manual.pdf) | Everybody who uses POLYTOS | 105 |
| [`01-User-Manual/POLYTOS_Complete_User_Manual.docx`](01-User-Manual/POLYTOS_Complete_User_Manual.docx) | The editable edition | — |
| [`02-Administrator-Manual/POLYTOS_Administrator_Setup_Manual.pdf`](02-Administrator-Manual/POLYTOS_Administrator_Setup_Manual.pdf) | Owners, administrators, implementers | 67 |
| [`02-Administrator-Manual/POLYTOS_Administrator_Setup_Manual.docx`](02-Administrator-Manual/POLYTOS_Administrator_Setup_Manual.docx) | The editable edition | — |

Each manual is a standalone document with its own cover, contents, page
numbering, chapters, figures, glossary and troubleshooting. The PDFs carry
selectable text, a contents list with real page numbers and working internal
links, and a sidebar outline. The Word editions use real Word styles rather
than direct formatting, so they stay editable; their contents list is a TOC
field that populates when the document is opened (Ctrl+A then F9 in Word, or
Tools ▸ Update ▸ Indexes and Tables in LibreOffice).

## What is in each one

**Manual One — Complete User & Operations Manual.** Chapters 1 to 7 introduce
the system and work through every role it implements. Chapters 8 to 24 work
through every module in a repeated ten-heading format: purpose, who may use
it, prerequisites, how to reach it, the screen, the fields, the steps, a worked
example, how to verify it, and what goes wrong. Chapters 25 to 28 are
troubleshooting, frequently asked questions, the glossary and a topic index.

**Manual Two — Administrator Setup & System Configuration Manual.** Fifteen
chapters from first sign-in to a go-live checklist, in the order the
application's own controls demand. Chapter 5 is the capital registration,
worked to the shilling. Chapters 7, 8 and 9 are the mandatory MTN, Airtel and
bank agency registrations, performed rather than described.

## The rest of the folder

| Folder | What is in it |
| --- | --- |
| `03-Screenshots/` | The photograph library: 256 desktop and 201 mobile captures, by module, with `manifest.json` recording what each capture was and whether it verified. JPEG at 1,440 pixels wide; the capture scripts regenerate it as lossless PNG at 2,880 |
| `04-Demo-Data/` | The scripts that built the demonstration, captured the screens and generated the manuals. See its own README |
| `05-Verification/` | Module inventory, role / permission matrix, coverage report, screenshot manifest, quality assurance report |
| `06-Findings/` | Everything this project found that a reader needs to know about: ten defects and four limitations |

## Read the findings first

`06-Findings/FINDINGS_AND_GAPS.md` lists ten defects found by doing the work
the manuals document. Two matter before anyone follows Manual Two:

- **F-04** — an **equity** capital contribution cannot be recorded through the
  Capital screen at all. A borrowing records normally.
- **F-09** — the commission **Rate** box on provider registration rejects every
  value it is given.

Both were reproduced against the validation schemas directly, both are
root-caused in the report, and both have a stated workaround. **No application
code was changed by this project** — the defects are reported, not fixed.

## The demonstration organisation

Everything was done as **POLYTOS Demonstration Enterprise**, a fictional
Ugandan business with three branches, on a local throwaway database. No real
customer, staff member, telephone number, bank account or agent number appears
anywhere. No hosted or production project was read from or written to at any
point. Amounts are in Uganda Shillings, which POLYTOS stores as whole
shillings.

Its Mbarara Branch began with all five money accounts at zero, which is why the
capital worked example can be traced exactly:

| Account | Code | Balance after allocation |
| --- | --- | ---: |
| Cash at Hand — Mbarara | `1010-BR2602` | UGX 8,000,000 |
| Cash at Bank — Mbarara | `1040-BR2602` | UGX 5,000,000 |
| MTN float — `mbarara-mtn-1` | `1320.MTN_MOMO.BR2602.T1` | UGX 3,000,000 |
| Airtel float — `mbarara-airtel-1` | `1320.AIRTEL_MONEY.BR2602.T1` | UGX 2,000,000 |
| Stanbic agent float — `mbarara-stanbic-1` | `1320.STANBIC.BR2602.T1` | UGX 2,000,000 |
| **Total — one contribution of** | `3000` credited once | **UGX 20,000,000** |

## Reproducing it

```bash
# 1. The stack: PostgreSQL + the real PostgREST binary + the auth shim + the
#    production Next build. Needs no Docker.
bash tests/e2e/harness/stack.sh up

# 2. The demonstration organisation's identity and its three branches
psql "$E2E_DATABASE_URL" -f docs/POLYTOS-Manuals/04-Demo-Data/01-demo-organisation.sql

# 3. Configure it, allocate the capital, and trade
node docs/POLYTOS-Manuals/04-Demo-Data/administrator-setup-walkthrough.mjs
node docs/POLYTOS-Manuals/04-Demo-Data/operations-walkthrough.mjs

# 4. Photograph everything
node docs/POLYTOS-Manuals/04-Demo-Data/capture-manual-screens.mjs
node docs/POLYTOS-Manuals/04-Demo-Data/refine-figures.mjs

# 5. Build the four files
python3 docs/POLYTOS-Manuals/04-Demo-Data/build_manuals.py
```

The build fails if any figure the manuals reference has no photograph behind
it, so a broken image cannot be shipped silently.
