# The demonstration environment, and how the manuals were made

Everything the two POLYTOS manuals contain was produced by these scripts,
against a running application. This folder is here so the work can be checked
and repeated.

## Safety

- **Nothing here touches a hosted or production project.** Every script
  defaults to `postgresql://lending@127.0.0.1:5433/lending_e2e`, the throwaway
  database the Docker-free end-to-end harness creates and destroys. There is
  no production connection string anywhere in this folder.
- **No control was relaxed.** No permission, Row Level Security policy,
  constraint or guard was changed, disabled or worked around to make a step
  succeed. Where POLYTOS demands two different Owners, two different Owners
  were used.
- **Nothing was faked.** A step the application refused is recorded as
  `blocked` with the exact refusal in `walkthrough-result.json`, and the manual
  says so. A step performed through a database function because no screen
  exists is recorded as `done-without-screen`, and the manual says that too.
- **No application code was changed.** The defects in
  `../06-Findings/FINDINGS_AND_GAPS.md` are reported, not fixed.
- **No real data.** Every name, telephone number, identification number, agent
  code, bank account number and amount is invented.

## The files

| File | What it does |
| --- | --- |
| `01-demo-organisation.sql` | Names the demonstration organisation and provisions its three branches with their five money accounts each. The only thing written directly, and only because branch creation has no screen — finding F-01 |
| `administrator-setup-walkthrough.mjs` | Registers the second Owner, records and verifies the capital, and brings MTN, Airtel and Stanbic live through the Providers and agent-account screens |
| `operations-walkthrough.mjs` | Authorises the counter staff, banks part of the cash, funds the three floats, and puts three transactions through the counter from draft to posted |
| `config-panels-capture.mjs` | Re-opens the configuration panels and fills them, for the figures the walk-through could not photograph mid-entry on a second run |
| `refine-figures.mjs` | Re-photographs each figure at a size an A4 page can carry: panels scoped to a form, screens at viewport size. Keeps every whole-page original as `<name>.fullpage.png` |
| `capture-manual-screens.mjs` | The scripted sweep: 170 screens, four roles, two widths, with every capture verified rather than merely taken |
| `polytos_doc.py` | The renderer. One content model, two outputs: ReportLab for the PDF, python-docx for the Word edition |
| `content_common.py` | Figure numbering, screenshot resolution, the glossary, and the facts both manuals quote |
| `manual_user_a/b/c.py` | Manual One's 28 chapters |
| `manual_admin.py` | Manual Two's 15 chapters |
| `build_manuals.py` | Builds all four deliverables, and fails if any figure reference has no photograph |
| `walkthrough-result.json` | What each configuration step did, in order, with every refusal quoted |
| `operations-result.json` | The balances before and after each money movement, and the trial balance |

## Running it

```bash
bash tests/e2e/harness/stack.sh up         # needs a `postgrest` binary on PATH
source <(bash tests/e2e/harness/stack.sh env)

psql "$E2E_DATABASE_URL" -f docs/POLYTOS-Manuals/04-Demo-Data/01-demo-organisation.sql
node docs/POLYTOS-Manuals/04-Demo-Data/administrator-setup-walkthrough.mjs
node docs/POLYTOS-Manuals/04-Demo-Data/operations-walkthrough.mjs
node docs/POLYTOS-Manuals/04-Demo-Data/capture-manual-screens.mjs
node docs/POLYTOS-Manuals/04-Demo-Data/config-panels-capture.mjs
node docs/POLYTOS-Manuals/04-Demo-Data/refine-figures.mjs
python3 docs/POLYTOS-Manuals/04-Demo-Data/build_manuals.py
```

The two walk-throughs are **idempotent**: a second run finds the work already
done and says so rather than doing it twice. That matters — an early run
recorded the UGX 5,000,000 bank deposit a second time, which was undone
through the application's own investigate-and-return workflow rather than by
editing the database.

### Two things worth knowing

**Sign-in is rate-limited, and these scripts hit it.** Signing four accounts in
repeatedly inside five minutes is exactly what the limiter is for. If a script
stops at `page.waitForURL: Timeout`, wait five minutes and run it again.

**`stack.sh down` kills processes by command line, scoped to the project
directory.** Run it from somewhere else — `cd /tmp && bash
/path/to/tests/e2e/harness/stack.sh down` — or a shell whose own command line
mentions `postgrest` will stop itself.

## The demonstration organisation

**POLYTOS Demonstration Enterprise**, Kampala, UGX, Africa/Kampala.

| Branch | Code | Role in the demonstration |
| --- | --- | --- |
| Kampala Main Branch | `BR2601` | Carries the seeded lending, membership, savings and benefits book that Manual One's registers are photographed from |
| Mbarara Branch | `BR2602` | Began at zero. Configured from nothing: capital, bank, three agent lines, three floats, three posted transactions |
| Masaka Branch | `BR2603` | Open, untraded. Used for the figures that show a registration form being filled in |

| Person | Role | Part they play |
| --- | --- | --- |
| Nalubega Sarah Kiwanuka | Owner / Administrator | Registers, records, opens accounts |
| Ssekandi Joseph Mukasa | Owner / Administrator | Approves — the second pair of eyes every control demands |
| Okello Daniel Omara | Manager | Verifies counter transactions, banks cash |
| Namirembe Grace Atim | Secretary / Treasurer | Works the counter |
| Wasswa Peter Lubega | Secretary / Treasurer | Holds a temporary password, for the forced-change figure |
| Akello Betty Anyango | Secretary / Treasurer | Suspended, for the user-directory figure |
| Mugisha Robert Tumwine | Client | The borrower whose portal is photographed |

The demonstration password is a harness literal already committed to this
repository and is not a secret. It authenticates against a local auth shim that
generates a fresh signing key every time the stack starts, and reaches no
hosted project.
