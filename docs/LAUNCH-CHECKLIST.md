# Launch checklist

Gate go-live on this list. Items marked **[manual]** cannot be verified in CI or
the build container and must be confirmed by the operator against the real
production project/domain.

## Launch day — must all be true before the first real client
- [ ] CI is green on the release commit: checks, database, **browser** all pass.
- [ ] `npm run verify` green locally/in pipeline.
- [ ] Production environment variables set and `npm run check:env` passes. **[manual]**
- [ ] `NEXT_PUBLIC_APP_ENV=production` (so `'unsafe-eval'` is off and HSTS is on). **[manual]**
- [ ] HTTPS live on the production domain; HTTP redirects to HTTPS. **[manual]**
- [ ] TLS certificate valid; `NEXT_PUBLIC_SITE_URL` and Supabase Site/redirect URLs match the domain. **[manual]**
- [ ] A **backup has been taken** and its **restore proven** (`BACKUP-RESTORE.md` §3 checks pass). **[manual]**
- [ ] Supabase backup tier confirmed (daily backups; PITR if required). **[manual]**
- [ ] First Owner/Administrator created with `bootstrap:owner`; temporary password delivered securely; owner has changed it. **[manual]**
- [ ] No synthetic/test data in the production database (migrations + reference data only).
- [ ] Company settings reviewed: name, timezone, currency, min/max loan, interest rate, grace period, penalty rate, repayment frequencies, reference formats. **[manual]**
- [ ] Security headers verified on the live domain (CSP with nonce, no `'unsafe-eval'`, HSTS, frame/referrer/permissions). **[manual, mirror of `security.spec`]**
- [ ] PWA install tested on a real phone from the production URL. **[manual]**
- [ ] Logging reaching the operator; `/api/health` returns ok. **[manual]**
- [ ] (Recommended) external error monitoring + uptime alerting wired. **[manual, launch condition — not a blocker if strong logs + health are in place]**

## First-day operation (how to run the core flows)
1. **Register the first client** — Clients → Register client; capture identity and contact.
2. **Approve the first loan** — Loans → new loan → draft → submit → approve → disburse. Terms (rate, grace, penalty) are captured at approval and are immutable thereafter.
3. **Record the first payment** — Payments → find the borrower → choose the loan → enter amount/method/reference → confirm. A receipt number is issued.
4. **Reconcile** — open the loan: the payment appears in Payments; the balance reduced by the allocation; the receipt is viewable/printable.
5. **Verify the receipt** — open/print it; confirm the figures match the loan.
6. **Inspect the audit log** — Audit trail shows the registration, approval, disbursement and payment with the acting user.

## Daily operation
- [ ] Review the day’s collections (dashboard / collections report).
- [ ] Review overdue loans and act on arrears.
- [ ] Confirm the backup for the previous day completed. **[manual]**
- [ ] Review any failed financial mutations / errors in the logs.
- [ ] Review audit-log exceptions (reversals, role changes, settings changes).

## Stop conditions (NO-GO until resolved)
Reconciliation mismatch · RLS cross-client leak · a client able to mutate their
own financial data · payment duplication risk · unproven/broken restore · no
production backup plan · secret in the client bundle · service-worker leak of
private data · severe production dependency vulnerability · a critical browser
workflow failing · inability to create/revoke the production Owner safely · a
failed clean install or migration · an HTTPS/session-security failure.
