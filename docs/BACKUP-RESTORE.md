# Backup, restore and disaster recovery

A backup that has never been restored is not a backup. This document records
the strategy, a **proven** restore drill, and the recovery procedures.

## 1. Backup strategy

### Managed (hosted Supabase) — the production default
- Supabase takes **automated daily backups** on paid tiers, with
  **point-in-time recovery (PITR)** available on Pro and above. Confirm the tier
  and retention in the Supabase dashboard before launch — this is a
  **launch condition** (see the checklist).
- Retention and encryption are the provider’s; backups are encrypted at rest and
  accessible only to project owners.

### Manual / portable — provider-independent
A logical dump that can be restored anywhere:

```
pg_dump "$DATABASE_URL" -Fc -f backup-$(date -u +%Y%m%dT%H%M%SZ).dump
sha256sum backup-*.dump            # record the checksum
```

Run it from a trusted host with the direct `DATABASE_URL`. Store the dump
encrypted, off the application host. A sensible cadence for a small lender is a
**daily** logical dump in addition to the provider’s automated backups, retained
**30 days**.

## 2. Restore procedure

```
createdb lending_restore
pg_restore -d lending_restore --no-owner --role=<app_role> backup.dump
psql -d lending_restore -c 'analyze'
```

Then verify before trusting it (see §3).

**The `analyze` is not optional.** `pg_restore` restores rows, indexes and
constraints; it does not restore planner statistics. Until they are collected,
every table reads to the planner as the ten-page default — and the derived
reads in this schema are stacked four deep, so each wrong row estimate is
multiplied by the one above it. Measured on a fourteen-loan database with no
statistics, reading as an authenticated owner:

| read | no statistics | after `analyze` |
| --- | --- | --- |
| `dashboard_portfolio_summary` | 1,981 ms | 80 ms |
| `collections_today` | 1,373 ms | 79 ms |
| `loan_portfolio_report` | 320 ms | 88 ms |

Twenty-five times slower on fourteen loans, from statistics alone. Autovacuum
collects them eventually; `analyze` after a restore means the first person to
open the dashboard is not the one who waits. It reads the tables, writes
nothing to them, takes no exclusive lock, and changes no figure.

The same applies to any bulk import, and it is why
`tests/e2e/harness/seed.mjs` ends with one.

## 3. Proven restore drill

A full dump → fresh-database restore → fidelity check was executed against the
seeded end-to-end database during the Phase 10 audit:

| Check | Source | Restored | Match |
| --- | --- | --- | --- |
| loans | 15 | 15 | ✓ |
| payments | 163 | 163 | ✓ |
| allocations | 170 | 170 | ✓ |
| audit rows | 557 | 557 | ✓ |
| posted-payment sum (not reversed) | 3,649,903 | 3,649,903 | ✓ |
| allocation sum (principal+interest+penalty) | 3,649,903 | 3,649,903 | ✓ |
| reconciliation invariant (`outstanding = contractual + penalty`) | holds | holds | ✓ |
| RLS-enabled tables | 28 | 28 | ✓ |

Method: `pg_dump -Fc` (consistent snapshot) → `createdb` → `pg_restore` into a
clean database → row counts, financial fingerprints and the reconciliation
invariant re-checked on the restored copy. All matched; the restored database is
financially identical to the source.

**Before trusting any restore in production, re-run these checks:** row counts
for `loans`, `loan_payments`, `payment_allocations`, `audit_log`; the
posted-vs-allocated sums; and `select count(*) from loan_balances where
total_outstanding <> contractual_outstanding + penalty_remaining;` (must be 0).

## 4. Point-in-time recovery

PITR depends on the Supabase tier. If enabled, it allows recovery to a chosen
second within the retention window — the right tool for "a bad migration or a
mistaken bulk change happened at 14:07, roll back to 14:06." If the tier does
**not** include PITR, say so plainly: recovery granularity is the last daily
backup, and the manual daily dump narrows that window. Do not assume PITR exists.

## 5. Disaster recovery

| Scenario | Detection | Immediate action | Recover from | Owner |
| --- | --- | --- | --- | --- |
| Total database loss | `/api/health` DB check fails; app errors | Put app in maintenance; stop writes | Latest provider backup, or latest `pg_dump` | Operator/DBA |
| Accidental data change (bulk) | Audit log / user report | Stop further writes | PITR to just before the change, or latest backup | Operator/DBA |
| Bad migration slips to prod | Deploy fails or data looks wrong | Halt the release; do **not** run more migrations | Restore from backup (migrations are forward-only) | Operator/DBA |
| Failed app deployment | Smoke test / health check red | Roll back to previous known-good deploy | Previous build (see §6) | Operator |
| Compromised credentials | Alert / anomalous activity | Rotate `SUPABASE_SECRET_KEY` and Supabase keys; force re-auth | n/a | Owner/Operator |
| Provider/service outage | Uptime alert | Status page; wait or fail over if a replica exists | n/a | Operator |

## 6. Rollback and migrations

- **Application rollback** = redeploy the previous known-good build/commit. It is
  independent of the database.
- **Migrations are forward-only.** An application rollback does **not** undo a
  database migration. If a destructive or incorrect migration has already
  applied, the recovery path is a **database restore**, not an app rollback.
- Therefore: gate every migration in CI and staging first; and when a release
  includes a schema change, know in advance whether a rollback is app-only
  (no schema change) or requires a restore (schema change), and have the latest
  backup confirmed before deploying it.
