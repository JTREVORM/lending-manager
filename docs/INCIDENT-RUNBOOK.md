# Incident runbook

First actions for the situations an operator of a live lending system actually
hits. Keep it short; link out to `BACKUP-RESTORE.md` for recovery mechanics.

## Golden rules
- **Never edit or delete financial rows directly.** Corrections go through the
  product: reverse a payment, cancel a loan, change a role. Every one of those
  leaves an audit trail; a direct `UPDATE`/`DELETE` does not, and may violate a
  constraint or an invariant.
- **Preserve the audit log.** It is append-only by design. Do not prune it.
- When in doubt, stop writes first, diagnose second.

## A user cannot sign in
1. Confirm the account is **active** and has a **role** (Users screen). A
   disabled account or one with no role is refused by design.
2. If they are rate-limited ("too many attempts"), it clears after a few minutes
   (sign-in: 8 attempts / 5 min). Do not disable the limiter.
3. If they forgot their password, an administrator issues a reset; the account is
   then forced to set a new password on next sign-in.
4. Account enumeration is resisted — the sign-in page does not reveal whether an
   address exists. That is intended; don’t "fix" it.

## A payment was recorded incorrectly / twice
1. Do **not** delete it. Open the loan → Payments → **reverse** the wrong
   payment. The reversal reopens the balance and is itself audited.
2. A genuine duplicate (same cash / same Mobile Money reference) is blocked at
   source by idempotency; if two distinct payments exist, reverse the one that
   should not stand.
3. Re-check the loan balance and, if cleared in error, confirm it reopens.

## Wrong role / over-privileged user
1. Change the role on the Users screen. Role changes are audited and take effect
   on the user’s next request (the session carries no stale authority).
2. The last Owner/Administrator cannot be removed or demoted — the database
   enforces "an Owner always remains."

## A client or loan appears to be "missing"
1. Confirm the viewer’s **role** — a Secretary/Treasurer sees less than an Owner;
   a borrower sees only their own data. "Missing" is often "not permitted," which
   is correct.
2. Check the status filter on the list (e.g. "Active and inactive").

## The application is unavailable
1. Check `/api/health`. It reports process up and database reachable.
2. If the process is down → redeploy / restart; if it won’t start, check the env
   (a missing required variable fails startup by design — read the logs).
3. If the database is unreachable → see **DB unavailable** below.

## The database is unavailable
1. Check the provider status and the connection. Put the app in maintenance if
   it is serving errors.
2. Do not attempt schema changes while diagnosing.
3. If data loss is suspected, go to `BACKUP-RESTORE.md` → Disaster recovery.

## A deployment failed
1. Roll back to the previous known-good build (redeploy the previous commit).
2. **If the release included a migration**, an app rollback does not undo it —
   check whether a database restore is required (`BACKUP-RESTORE.md` §6).

## Suspected account or credential compromise
1. Rotate `SUPABASE_SECRET_KEY` and the Supabase keys; redeploy.
2. Force affected users to re-authenticate (reset passwords).
3. Review the audit log for the actor and the window; reverse any unauthorized
   financial actions through the product.

## Data correction policy (reinforced)
- No direct deletes of clients, loans, payments, schedules or audit rows.
- No direct edits of financial figures.
- Use reversal, cancellation and the approved administrative workflows.
- Every correction must remain visible in the audit history.
