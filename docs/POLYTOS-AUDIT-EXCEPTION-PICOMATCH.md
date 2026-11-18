# Dependency audit exception — picomatch GHSA-fc5q-39xc-vjpf

**Approved** by the Owner, 2026-11-18. **Expires 2026-12-02** — the gate stops
applying the exception *on* that date, so the last day it covers is
2026-12-01. **Scope:** the full dependency tree; never the production tree.

## The advisory

| | |
| --- | --- |
| Identifier | GHSA-fc5q-39xc-vjpf, CVE-2026-112366 |
| Package | `picomatch`, every published version `<= 4.0.7` |
| Severity | High, CVSS v4 8.7 (availability only), CWE-1333 |
| Published | 2026-10-19; reviewed by the GitHub Advisory Database 2026-11-17 |
| Patched version | **None.** 4.0.7 is the latest release. |

A single-branch repeated extglob pattern such as `+(*a)` compiles to a regular
expression with nested quantifiers; matching it against a short non-matching
string such as `aaaaaaaaaaaaaaaaaaaaaaaab` backtracks exponentially and blocks
the event loop. The attacker has to control the **pattern**.

Because there is nothing to upgrade to, the gate cannot be made green by a
dependency change, and `npm audit fix --force` would only downgrade the test
framework (vitest 5 to 3.1.4) and the Next.js lint config (16 to 14) without
removing the advisory.

## What carries it

Every one of the 13 high findings that remain after the minimatch bump
(#44) is one advisory, reaching the tree through `tinyglobby`, `fdir`,
`micromatch`, `fast-glob`, `vite`, `vitest` and the lint/test plugins that
depend on them. All are **development tooling**. `npm audit --omit=dev`
reports zero vulnerabilities.

## Next.js's vendored copy — investigated

`npm audit` cannot see `node_modules/next/dist/compiled/picomatch`, a compiled
copy inside Next 16.4.6, and its source is minified, so its version cannot be
read from it. It was measured instead, with the advisory's own trigger, in
a time-limited child process, against the npm-installed 4.0.7 (known
vulnerable) and the vendored copy:

| `+(*a)` against `a…ab` | picomatch 4.0.7 | Next 16.4.6 vendored |
| --- | --- | --- |
| n = 18 | 13.7 ms | 14.1 ms |
| n = 24 | 837 ms | 685 ms |
| n = 28 | 10,976 ms | 11,299 ms |

**The vendored copy is vulnerable.** It is not covered by this exception,
because the audit cannot report it, and it is not fixable here: it is part of
the framework release.

Whether it is reachable is a separate question. Next calls it in exactly
three places:

1. `images.remotePatterns` (hostname, pathname),
2. `images.localPatterns` (pathname),
3. a middleware config's `unstable_allowDynamic`.

All three take **patterns written by the developer in configuration**; the
request supplies only the string matched against them. This repository sets
none of them (`next.config.ts` has no `images` key, and no first-party file
mentions `remotePatterns`, `localPatterns` or `unstable_allowDynamic`), and
`proxy.ts` uses Next's `matcher`, which is not a picomatch glob. So no pattern
exists for a request to be matched against, and no request can supply one.

## Accepted residual risk

- **Development tooling.** `vite`, `vitest`, `eslint`/`typescript-eslint`,
  `tinyglobby` and `fdir` run on developers' machines and in CI, against this
  repository's own globs and configuration. An attacker would have to
  control a glob pattern fed to them, which means already controlling the
  repository or the pipeline. Impact if it happened: a hung CI job or dev
  server. No confidentiality or integrity impact; nothing runs in production.
- **Vendored copy in Next.** Present and vulnerable, unreachable with this
  configuration. It becomes reachable the day someone adds `images.remotePatterns`
  or `images.localPatterns` containing a repeated extglob, or sets
  `unstable_allowDynamic` likewise. **Do not add such a pattern** until the
  framework carries a patched picomatch.
- **Not covered by anything here:** a transitive dependency that bundles its
  own picomatch the way Next does, which no audit tool can enumerate.

Likelihood: very low. Impact: availability of tooling only. The exception is
accepted on that basis, for 14 days.

## How the exception is bounded

`security/audit-exceptions.json` is read only by `scripts/audit-gate.ts`, and
the gate is `npm audit --audit-level=high` with these rules (all unit-tested
in `tests/unit/audit-gate.test.ts`):

- one advisory, named by GHSA identifier; nothing is allowlisted by package;
- the threshold stays at **high**, and a **critical** advisory can never be
  excepted — a re-rating to critical ends the exception;
- it never applies to `npm audit --omit=dev`, which does not read the file;
- it **expires automatically**: on 2026-12-02 the gate fails, with no flag or
  environment variable to move the date;
- it **removes itself**: if a version above 4.0.7 is published, or the
  advisory stops being reported, the gate fails and says to delete the entry;
  if the registry cannot be asked, the gate warns and the expiry stands.

## Removing it

1. A picomatch release above 4.0.7 appears (the gate will say so).
2. Upgrade the dependants so the tree resolves it; `npm audit` should be clean.
3. Delete the entry from `security/audit-exceptions.json`. When the file holds
   no entries, `scripts/audit-gate.ts` may stay: it is the same check as
   `npm audit --audit-level=high` and costs nothing.
4. If the date arrives first, either upgrade or ask the Owner for a new,
   written approval with a new date. The gate does not extend itself.
