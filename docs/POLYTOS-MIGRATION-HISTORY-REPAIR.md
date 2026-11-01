# POLYTOS migration-history repair — connector-based preflight

Date: 1 November 2026. Target: Supabase project `fszgwemtgyrbhngajpzm`
("lending manager"), PostgreSQL 17.11, region eu-west-1.

**Status: preflight PASSED, repair PREPARED, repair NOT EXECUTED.**

Nothing was changed in production. The migration history was not repaired, the
security migration `20261030180224` was not applied, the PostgREST hook was not
activated, PR #18 was not merged, and nothing was deployed. No `DELETE`,
`UPDATE`, `INSERT`, DDL, `SET`, transaction-control or `VACUUM` statement was
sent to the database. Every statement executed was a `SELECT`.

This replaces the psql-only transactional preflight. It needs no PostgreSQL
installation, no `psql`, no connection string and no PowerShell: everything
below ran through the Supabase connector, and the two helper scripts run
offline under Node, which the repository already requires.

The second project in the same organization, `nmdyyhkwmsnhfhfivoji`
("salongohamuza's Project"), was never touched. Every call named
`fszgwemtgyrbhngajpzm` explicitly, and check 01 re-confirms the target from
inside the session.

## What the history actually contains

The hosted history holds **168** rows. The reviewed source revision holds
**159** migration files. The nine extra rows are pre-rename copies of nine
migrations that were later renumbered in the repository:

| Stale version | Canonical version | Name | Recorded SQL |
| --- | --- | --- | --- |
| 20261010104426 | 20261014000100 | collateral | 15,585 B |
| 20261010104529 | 20261014000200 | recovery_actions | 16,802 B |
| 20261010104621 | 20261014000300 | guarantee_release | 13,877 B |
| 20261010104723 | 20261014000400 | risk_monitoring | 15,640 B |
| 20261011060140 | 20261015000100 | notifications | 19,348 B |
| 20261011060324 | 20261015000200 | notification_triggers | 26,613 B |
| 20261011061348 | 20261015000300 | notification_backfill | 15,845 B |
| 20261012062453 | 20261016000100 | balance_as_of | 5,167 B |
| 20261012064058 | 20261016000200 | notify_what_still_waits | 5,538 B |

Two findings here were not previously recorded, and both matter to the repair.

**The SQL is held by the stale rows, not the canonical ones.** Each stale row
carries one statement and `created_by = salongohamuzadr@gmail.com`. Each
canonical row carries **zero** statements (SHA-256 `e3b0c442…b855`, the hash of
the empty string) and a null `created_by`: they are repair markers added after
the rename, holding no SQL. Deleting the nine stale rows therefore removes the
only copy of that SQL the database has, and leaves nine history entries that
name a migration but record none of its text. That is a permanent, accepted
reduction in what the ledger can tell you — the repository `.sql` files remain
the source of truth — and it is the reason the export below was taken first.

**Two records diverge from the repository, by comments only.** Seven of the
nine are byte-identical to the repository file of the same name (four exactly;
three once trailing newlines are removed). `balance_as_of` and
`notify_what_still_waits` are not: the repository files are 6,460 B and 7,639 B
against the recorded 5,167 B and 5,538 B. Comparing both texts with SQL
comments and blank lines stripped shows the **executable SQL is identical** —
the repository added a header comment block, a section comment and a trailing
newline after the migration was applied. The repository is not hiding schema
changes for these two, but their checksums genuinely differ, so the recorded
text survives only in the export.

## Deliverable 1 — the audit artifact

`docs/audit/polytos-migration-history-2026-11-01/`

- `manifest.json` — per record: version, name, `created_by`, byte length,
  SHA-256, repository correspondence, divergence nature, plus the schema
  fingerprint at capture.
- `sql/<version>_<name>.sql` — the nine records, each byte-exact.
- `SHA256SUMS`, `README.md`.

Fidelity was established, not assumed. Seven files are byte-identical to the
repository file whose SHA-256 equals the database's, so they are reproductions
proven equal by cryptographic hash. The two divergent records were pulled out
of the database as base64 and decoded, giving 5,167 B / 5,538 B files whose
SHA-256 match the database exactly. All nine verify:

```
node scripts/verify-migration-history-export.mjs
```

That re-hashes every file against the checksum read from the database,
re-checks each stated repository relationship, and exits non-zero on mismatch.
It needs no database. Server-side, preflight check 06 recomputes the same nine
checksums in PostgreSQL.

## Deliverables 2 and 3 — the read-only preflight and its results

`scripts/sql/migration-history-preflight.sql` is one `SELECT` returning one row
per check. It is runnable through the connector or pasted into the dashboard SQL
editor. Because it is a single statement, all 21 checks share one snapshot.

Executed 1 November 2026 against `fszgwemtgyrbhngajpzm`. **All 21 PASS.**

| # | Check | Observed | Expected |
| --- | --- | --- | --- |
| 01 | target database / role / engine | postgres / postgres / PostgreSQL 17.11 | same |
| 02 | history row count | 168 | 168 |
| 03 | repository migration files | 159 | 159 |
| 04 | stale rows present | 9 | 9 |
| 05 | stale rows carry exactly one statement | 9 | 9 |
| 06 | stale SQL checksums match the exported artifact | 9 | 9 |
| 07 | canonical counterparts present | 9 | 9 |
| 08 | canonical counterparts hold no SQL | 9 | 9 |
| 09 | history rows absent from the repository | 9 | 9 |
| 10 | those rows are exactly the nine stale versions | 9 | 9 |
| 11 | repository files missing from history | 0 | 0 |
| 12 | POST-REPAIR: rows that would not match the repository | 0 | 0 |
| 13 | POST-REPAIR: repository files left uncovered | 0 | 0 |
| 14 | POST-REPAIR: history row count | 159 | 159 |
| 15 | POST-REPAIR: duplicate migration names remaining | 0 | 0 |
| 16 | security migration 20261030180224 absent | 0 | 0 |
| 17 | readiness migration 20261030115530 present once | 1 | 1 |
| 18 | fingerprint: public columns | 7e42df13d874978c3996a2efc604ca48 | same |
| 19 | fingerprint: public functions | a5d2c1142da9c8f74eb637f80442b86e | same |
| 20 | fingerprint: public + storage policies | 96bfcae6171b2c92c34fa9299a58bd6c | same |
| 21 | financial rows loans/payments/schedules/audit | 35/470/26/1671 | same |

Checks 12–15 are the expected post-repair history, computed with set algebra
(`EXCEPT`) over the live table rather than by executing anything: remove the
nine stale versions and the remaining 159 rows equal the repository's 159
filenames exactly, in both directions, with no duplicate names left.

Supporting read-only observations:

- Catalogue at capture: 80 public tables, 49 views, 313 functions, 126 public
  and 15 storage policies, 275 triggers, 372 indexes.
- `supabase_migrations.schema_migrations` is a plain table with **no triggers,
  no rules, no RLS, no policies and no inbound foreign keys** — only a primary
  key on `version` and a unique constraint on `idempotency_key`. Only
  `postgres` holds grants. Nothing can cascade from deleting rows in it.
- All nine stale rows have `rollback` and `idempotency_key` null, so a restore
  is fully specified.
- The Git-linked default Supabase branch `main` is still **MIGRATIONS_FAILED**
  and still bound to the production Git branch `claude/intelligent-knuth-2r8mpw`.

## Deliverable 4 — what the read-only preflight cannot assure

The read-only workflow is strictly weaker than `BEGIN; DELETE …; verify;
ROLLBACK;` in a psql session. Honestly stated:

**1. No executed rehearsal of the delete.** The transactional preflight would
have run the real `DELETE`, observed the actual affected-row count and the real
post-state, then thrown it away. Checks 12–15 *compute* the post-state; they
never execute the statement. The first real execution will be the production
one. Narrowed, not removed, by: the table has no triggers, rules, RLS or
inbound foreign keys, so there is no hidden side effect for a rehearsal to
discover; the statement is a single atomic statement; and it is self-guarding
(below). Residual risk: a syntax or planning error surfaces only on the real
run — where it would abort the statement and change nothing.

**2. No engine-enforced read-only guarantee.** psql can `BEGIN READ ONLY` or
`SET default_transaction_read_only = on`, after which PostgreSQL itself refuses
any write, whatever the SQL says. Setting a session GUC is not a `SELECT`, and
each connector call is its own implicit transaction, so I could not establish
that. The read-only property here rests on the SQL text — audited to contain no
mutating keyword — and on review, not on the server rejecting writes. The same
`execute_sql` tool is capable of writing. A reviewer must read the SQL to trust
it; with psql they could have trusted the engine.

**3. No single transaction spanning verify-then-repair.** psql could verify and
repair inside one transaction, so nothing could change in between. Connector
calls autocommit independently, which leaves a time-of-check-to-time-of-use gap
between the preflight above and any later repair — and the Git-linked Supabase
branch in `MIGRATIONS_FAILED` is a live candidate for changing that table
without warning. The repair statement answers this by re-verifying all nine
version/checksum pairs at execution time and deleting nothing unless exactly
nine match, so a changed history yields **zero** deletions rather than a wrong
one. The gap is closed for safety, not for convenience: a drifted history means
the repair no-ops and must be re-read.

**4. No lock or timeout control.** The reviewed scoped executor sets statement
and lock timeouts and takes an advisory lock to serialise against a concurrent
run. A single connector statement takes only the server's default locks and
timeouts. Two simultaneous repairs are not serialised by an advisory lock,
though the nine-match guard means the loser deletes nothing.

**5. No server-side backup.** psql could `pg_dump` or `COPY` the table out on
the server before deleting. The connector cannot write server-side files, so
the export passed through this session instead. The artifact is a verified
logical backup of the nine rows and `scripts/emit-migration-history-restore.mjs`
reproduces all nine byte-exactly (proven: 9/9 round-trip through the generated
SQL). What is **not** covered: the other 159 rows are not backed up, and this
is not a point-in-time-recovery substitute. Accepted deliberately — POLYTOS
holds disposable demo data and no full database backup was required.

**6. One snapshot per statement, not one across the session.** The 21 checks
share a snapshot because they are one statement. The export, the fingerprint
capture and the preflight were three statements minutes apart, so their mutual
consistency is *evidenced* rather than *guaranteed*: the preflight re-asserted
the capture's fingerprints and row counts and they matched exactly, so nothing
moved in between. A psql session could have held one repeatable-read snapshot
across all of it.

**7. Neither approach proves downstream tooling behaviour.** Nothing here shows
what the Supabase CLI or the Git integration will do after the repair — whether
`supabase db push` then succeeds, or whether `main` clears MIGRATIONS_FAILED.
The connector exposes neither that branch's failed-job diagnostics nor its
automatic-migration configuration. That stays an operator verification item and
an unchanged PR #18 blocker.

**8. The repair is not proof that the nine migrations' effects are intact.**
The fingerprints show the catalogue matches capture; they do not individually
re-derive each migration's objects from its recorded SQL.

## Deliverable 5 — the exact repair operation, for authorization

`scripts/sql/migration-history-repair.sql`. **Not executed.** One statement,
therefore one implicit transaction — all nine rows or none:

```sql
with expected(version, sha256) as (values
  ('20261010104426','98591dbae2ad3d9fc992759e6491399f71696cbae14d3f75d9b89f37a084508f'),
  ('20261010104529','e5753bf0571827b0b490bc0800e1b5624d3caad0f02aa6dd69ee2777c26c8ba0'),
  ('20261010104621','e3cdd816e9a7c627cf03ff7a524e61f2ccaa990ff7d0257dad464e7e0d8b66e2'),
  ('20261010104723','ad2067ba148daec602d1fc0145b59e29cafd3de37f38a273672b49575960909b'),
  ('20261011060140','0a7cc4d676b13667f3803e3c60f17864c1e26fd2676dd6d54ead9028e3ff563b'),
  ('20261011060324','990cc6926e12094485a1d192a8c9561970d0c3bc3fe1578f571ed1f055d2c8d0'),
  ('20261011061348','110fa53c76d3f4cf174721c4bc416d97a5b60b153ba1cc15101c1352b4b337ff'),
  ('20261012062453','702864d7b3505d0ef0777e0d8555769c150aae758ff7758c703757ffafdf67dd'),
  ('20261012064058','789049653cd3c6c7bdcbf293a105dcf9cceca2daad6790128f01b5a3b2f35006')
),
matched as (
  select m.version
    from supabase_migrations.schema_migrations m
    join expected e on e.version = m.version
   where coalesce(array_length(m.statements, 1), 0) = 1
     and encode(sha256(convert_to(m.statements[1], 'UTF8')), 'hex') = e.sha256
),
doomed as (
  select version from matched where (select count(*) from matched) = 9
)
delete from supabase_migrations.schema_migrations m
 using doomed d
 where m.version = d.version
returning m.version, m.name;
```

What it does and does not do:

- Writes to exactly one table: the migration-history ledger. No application
  schema, no business data, no account or financial row is touched.
- Each version is paired with the SHA-256 of the SQL it is known to carry; a
  row whose content changed is not matched and not deleted.
- The `= 9` guard means that if any one of the nine is missing or altered,
  **zero** rows are deleted.
- `RETURNING` prints which rows went. **Expect exactly nine.** Anything else
  means nothing was deleted and the state must be re-read before retrying.

Afterwards, `scripts/sql/migration-history-postcheck.sql` — read-only, same 21
checks with the repaired expectations: history 159, no stale version present,
no stale checksum remaining, history equal to the repository in both
directions, no duplicate names, and the **same** fingerprints and financial row
counts as checks 18–21 above, which the repair must not move.

To reverse it:

```
node scripts/emit-migration-history-restore.mjs > restore.sql
```

That regenerates, from the verified artifact, the exact `INSERT` returning all
nine rows to their original state — same versions, names, `created_by`, single
-element `statements`, null `rollback` and `idempotency_key` — with
`ON CONFLICT (version) DO NOTHING` so it can never overwrite an existing row.
Review it before use. It requires the same explicit authorization as the repair.

## Still awaiting your authorization

Not done, and not to be done without your explicit approval:

1. The repair above.
2. Applying the security migration `20261030180224`.
3. Activating the PostgREST hook.
4. Merging PR #18.
5. Any deployment.

Repairing the history does **not** clear PR #18's other NO-GO blockers: the
effective hosted PostgREST environment and cached-hook report, the Vercel
auto-alias hold and old-artifact containment, real Storage service and
signed-URL behaviour, hosted Auth and account certification, and green CI at
the exact head. The `MIGRATIONS_FAILED` branch job's diagnostics and its
automatic-migration configuration remain unavailable through this connector and
still need operator verification before any merge.
