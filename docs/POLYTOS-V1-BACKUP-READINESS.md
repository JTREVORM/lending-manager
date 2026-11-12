# POLYTOS V1 — backup readiness and restore procedure

Prepared 12 November 2026. **Nothing in this document has been executed.**
It is the procedure to run against the live project before any V1 migration is
applied, and it names which steps only the Owner can perform.

`docs/BACKUP-RESTORE.md` holds the standing strategy and the verification
checks. This document is the V1-specific instance of it: the actual project,
the actual blocker, and the order to work in.

## 1. Why this gates the migrations

The V1 security integration applies **ten migrations** to production. Nine of
them change function definitions and grants; none writes a business row. They
are still schema changes to a database holding real money records, and
`DROP VIEW` in `20261104000100` is not reversible by re-running anything.

Supabase's own protection does not currently exist for this project:

| Item | Current state | Needed |
| --- | --- | --- |
| Organisation | `SALONGO` (`udrfljoqkwwgsrionoad`) | — |
| Plan | **free** (`tier_free`) | Pro or above |
| Automated daily backups | **none** | daily |
| Point-in-time recovery | **none** | optional, recommended |
| Project | `fszgwemtgyrbhngajpzm`, `ACTIVE_HEALTHY`, PostgreSQL 17.11 | — |

`docs/BACKUP-RESTORE.md` §1 states that automated daily backups and PITR are
paid-tier features. `docs/LAUNCH-CHECKLIST.md` lists *"unproven/broken
restore"* and *"no production backup plan"* as NO-GO stop conditions.

So the rule for V1 is simply: **no migration is applied until a backup of this
project has been taken and a restore from it has been proven.**

## 2. Steps only the Owner can perform

These need dashboard or billing access. They cannot be done from this session
or from CI, and no automation should attempt them.

- [ ] **O-1. Upgrade the organisation to Pro.** Supabase Dashboard →
      Organisation `SALONGO` → Billing. This is a paid change and is the
      Owner's commercial decision.
- [ ] **O-2. Confirm daily backups are on** and note the retention window.
      Dashboard → Project `fszgwemtgyrbhngajpzm` → Database → Backups.
- [ ] **O-3. Decide on PITR.** Not required for launch if a daily provider
      backup plus the manual dump in §3 are both in place. Recommended once
      real lending volume starts, because the recovery granularity without it
      is the last daily backup.
- [ ] **O-4. Obtain the direct `DATABASE_URL`** for the manual dump
      (Dashboard → Project Settings → Database → Connection string, *direct*
      connection, not the pooler). Handle it as a credential: never paste it
      into chat, a commit, a shell history or CI output.
- [ ] **O-5. Choose where encrypted dumps are stored**, off the application
      host, and who holds the decryption key.

**Note on O-1.** Leaked-password protection (a separate launch item) is also
documented by Supabase as Pro-and-above, so O-1 unblocks that too.

## 3. The backup, once the plan allows it

Run from a trusted host with the direct connection string in the environment.
These commands are from `docs/BACKUP-RESTORE.md` §1, unchanged.

```
pg_dump "$DATABASE_URL" -Fc -f polytos-prelaunch-$(date -u +%Y%m%dT%H%M%SZ).dump
sha256sum polytos-prelaunch-*.dump          # record the checksum
```

Record alongside the file: the UTC timestamp, the checksum, the
`supabase_migrations.schema_migrations` count at the time (expected **161**
before the V1 migrations), and the three financial totals in §4 below.

Store the dump encrypted and off the application host.

## 4. The figures to capture before and after

A restore is only proven if you can say what *should* be there. Capture these
read-only figures immediately before the backup, and compare after any
restore. The expected values as at this audit:

| Check | Expected now |
| --- | --- |
| Migrations applied | 161 |
| Clients | 28 |
| Loans | 35 |
| Loan payments | 470 |
| Journal entries | 597 |
| Total debits | 89,649,530 |
| Total credits | 89,649,530 |
| Individually unbalanced entries | 0 |
| Disbursed loans without a disbursement journal | 0 |

The debit/credit equality and the zero counts are the ones that matter: they
are invariants, so a restore that breaks them is wrong regardless of what the
row counts say.

## 5. The restore drill

Restore to a **scratch database**, never over production.

```
createdb lending_restore
pg_restore -d lending_restore --no-owner --role=<app_role> polytos-prelaunch-*.dump
psql -d lending_restore -c 'analyze'
```

`analyze` is not optional — `docs/BACKUP-RESTORE.md` §2 measures
`dashboard_portfolio_summary` at 1,981 ms without statistics and 80 ms with
them, because the derived reads in this schema stack four deep.

Then run the `docs/BACKUP-RESTORE.md` §3 checks against `lending_restore`,
plus the §4 table above. The drill passes only when every invariant holds and
every count matches what was recorded.

- [ ] **D-1.** Dump taken, checksum recorded.
- [ ] **D-2.** Restore into a scratch database completed without error.
- [ ] **D-3.** `analyze` run.
- [ ] **D-4.** §3 checks pass.
- [ ] **D-5.** §4 figures match the pre-backup capture.
- [ ] **D-6.** Result, timestamps and operator recorded.

## 6. Order of work

1. O-1 to O-5 (Owner).
2. §3 backup, §4 capture.
3. §5 restore drill. **If D-4 or D-5 fails, stop — do not migrate.**
4. Only then apply the ten V1 migrations, in filename order.
5. Re-capture §4 against production. The nine guard migrations change no rows,
   so every figure in that table must be **identical** afterwards. A changed
   financial total means something unexpected ran and is grounds for rollback.
6. Re-run `npm run check:security` against production and the Supabase
   security advisor, and compare the inventory.

## 7. Rollback position

Pre-commit interruption of a migration leaves no DDL and no history row; the
scoped executor in `scripts/lib/scoped-security-migration.mjs` runs one file
in one transaction with an advisory lock and refuses an existing version.

After a migration commits, the rollback is the §3 dump restored into a new
project, not an in-place downgrade. There is no down-migration for these, and
`20261104000100` drops a view. That is acceptable for guard migrations that
tighten grants, and it is the reason the dump must exist first.

Record the prior Vercel deployment ID before the application release, so the
application can be rolled back independently of the database.
