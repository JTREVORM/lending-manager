# POLYTOS stale migration-history export — 1 November 2026

Read-only export of the **nine pre-rename rows** in
`supabase_migrations.schema_migrations` on Supabase project
`fszgwemtgyrbhngajpzm` ("lending manager", PostgreSQL 17.11), captured through
the Supabase connector with `SELECT` statements only.

Nothing in production was changed to produce this artifact. The migration
history was **not** repaired, the security migration was **not** applied, the
hook was **not** activated, PR #18 was **not** merged and nothing was deployed.

## Why this artifact exists

The hosted history holds **168** rows; the reviewed source revision holds
**159** migration files. The nine extra rows are pre-rename copies of nine
migrations that were later renumbered in the repository:

| Stale version (history only) | Canonical version (repo + history) | Name |
| --- | --- | --- |
| 20261010104426 | 20261014000100 | collateral |
| 20261010104529 | 20261014000200 | recovery_actions |
| 20261010104621 | 20261014000300 | guarantee_release |
| 20261010104723 | 20261014000400 | risk_monitoring |
| 20261011060140 | 20261015000100 | notifications |
| 20261011060324 | 20261015000200 | notification_triggers |
| 20261011061348 | 20261015000300 | notification_backfill |
| 20261012062453 | 20261016000100 | balance_as_of |
| 20261012064058 | 20261016000200 | notify_what_still_waits |

**The SQL lives on the stale rows, not the canonical ones.** Each stale row
carries one statement of 5–27 KB and `created_by = salongohamuzadr@gmail.com`.
Each canonical row carries **zero** statements and a null `created_by` — they
are repair markers inserted after the rename and hold no SQL at all. Deleting
the stale rows therefore discards the only copy of that SQL the database holds,
which is why it is exported here first.

## Two records diverge from the repository

Seven of the nine are byte-identical to the repository file of the same name
(four exactly; three once trailing newlines are removed). Two are **not**:

| Record | In database | In repository |
| --- | --- | --- |
| 20261012062453 balance_as_of | 5,167 bytes | 6,460 bytes |
| 20261012064058 notify_what_still_waits | 5,538 bytes | 7,639 bytes |

For those two, the recorded SQL differs from what the repository now contains,
and **this artifact is the only copy of it**.
`sql/20261012062453_balance_as_of.sql` and
`sql/20261012064058_notify_what_still_waits.sql` are the production text,
decoded byte-for-byte from the database.

The divergence is **documentation, not behaviour**. Comparing both texts with
SQL comments and blank lines stripped shows the executable statements are
identical; the repository files added a header comment block, a section comment
and a trailing newline after the migration was applied. So the repository is
not carrying undisclosed schema changes for these two — but the checksums
genuinely differ, so the recorded text is still only preserved here.

## Contents

- `manifest.json` — per-record version, name, `created_by`, byte length,
  SHA-256, repository correspondence, and the schema fingerprint at capture.
- `sql/<version>_<name>.sql` — the nine records, each byte-exact.
- `SHA256SUMS` — checksums of the nine files, matching `manifest.json`.

## Verifying this artifact

Offline, no database and no psql:

```
node scripts/verify-migration-history-export.mjs
```

It re-hashes all nine files against the checksums read from the database,
re-checks each stated repository relationship, and exits non-zero on any
mismatch. Against the live database, `scripts/sql/migration-history-preflight.sql`
check 06 re-computes the same nine checksums server-side.
