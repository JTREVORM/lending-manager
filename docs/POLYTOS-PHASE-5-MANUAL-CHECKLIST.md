# POLYTOS Phase 5 manual authentication and session checklist

Target: https://lending-manager-ten.vercel.app.
Production source: `b7f2aa700e1f9ecc54a9f5f833e440aae293a5be`.
Evidence owner: the person performing each check in their own browser.
Status: **PENDING MANUAL**, except the explicitly blocked coverage below.

## Evidence and safety

Use existing accounts privately. Record only test ID, role, browser/version,
Africa/Kampala timestamp, page paths, elapsed time, PASS/FAIL/BLOCKED, and a
short observation. Do not record or share passwords, tokens, session-cookie
values, full request/response headers, HAR files, or storage exports.
Cookie attribute names and boolean flags are sufficient.

Use GET/read-only pages and existing records/documents. Never submit a payment,
withdrawal, loan decision, benefit claim, fine, member transition, profile edit,
password change, account reset, or Policy 2.0 action. If a forced password-change
screen appears, stop that normal-flow test and mark it BLOCKED. Do not alter
accounts, roles, branches, session settings, clocks, or records to manufacture
a test case. Logout affects sessions and may sign out your other devices; plan
the test before doing it.

## Already reported by the owner

- [x] **USER-REPORTED MANUAL:** existing Owner/Admin login succeeds.
- [x] **USER-REPORTED MANUAL:** Owner/Admin dashboard loads.
- [x] **USER-REPORTED MANUAL:** browser refresh retains the session.
- [x] **USER-REPORTED MANUAL:** navigation and the unspecified functionality
      personally checked work normally.

These are the owner's report, not independently automated results. No exact
duration or list of business workflows was supplied. A browser reload does not
establish access-token renewal after its original expiry.

## Remaining checks

### P5-01: identity and role

- [ ] On the Owner/Admin account page, privately confirm the displayed identity
      is your own and the expected role is Owner/Admin. Open dashboard, loans,
      savings, and ledger as read-only pages. Refresh one permitted detail URL.
      Expected: correct identity, expected data, no cross-user identity change.
      Record a boolean identity match, not personal identifiers.
- [ ] Record the specific read-only paths checked. The earlier general statement
      about functionality does not certify every financial workflow.

### P5-02: logout and same-browser restrictions

- [ ] Open two tabs in the same browser profile and load a protected page.
      Use the application's normal Sign out command in one tab.
      Expected: return to login.
- [ ] In both tabs, directly open `/loans`, `/savings`, `/finance/ledger`,
      and `/users`, then hard refresh.
      Expected: login/unauthorized response; no fresh protected data.
- [ ] Use Back, then refresh a previously open protected detail page.
      Expected: a fresh request is refused. Distinguish a stale history image
      from a successful authorized server response; record any cached sensitive
      content separately. Do not submit an action to test this.

### P5-03: clean anonymous protected routes

- [ ] In a fresh private/incognito window, directly request `/`, `/users`,
      `/loans`, `/savings`, `/benefits`, `/finance/ledger`, and
      `/membership/policy-transitions`.
      Expected: redirect to login or deny access, with no fresh private data.
- [ ] Login remains reachable and a valid in-site return path works when the
      account holder signs in privately. No external redirect is accepted.
      Do not paste a login URL containing secret parameters into the report.

### P5-04: session-cookie and response handling

- [ ] Using your own browser's developer tools, inspect session-cookie
      attributes only. Expected on HTTPS production: HttpOnly, Secure,
      SameSite=Lax (or an explicitly documented stronger value), and Path=/.
      Check every chunk belonging to the session. Do not copy cookie values.
- [ ] Check only the cache-policy metadata of authenticated page responses:
      private/no-store, including a response that refreshes a session.
      Record whether a refresh response updates cookies, never their values.
- [ ] After logout, verify the session cookies are cleared or expired.
      Do not infer server-side refresh-token revocation solely from this.

### P5-05: renewal beyond access-token expiry

- [ ] Establish the actual configured JWT lifetime from an authorized
      read-only settings view. Record the duration only. If unavailable, mark
      this test BLOCKED; do not assume the default one-hour lifetime.
- [ ] Note login time, keep using read-only pages, and perform fresh navigation
      and hard refresh after the original JWT lifetime plus a small clock-skew
      margin. Expected: the same identity remains authenticated through a
      successful renewal, without a loop or an unrelated account appearing.
- [ ] Repeat with two tabs making read-only navigations around the renewal
      boundary. Expected: no unexplained logout or session crossover.
      Record timings and outcomes only.

### P5-06: natural session expiry and invalid refresh

- [ ] Record the configured inactivity timeout, maximum session lifetime, and
      single-session policy as non-secret values without changing them.
      If timeouts are disabled, record that fact and mark only the disabled
      timeout case N/A with a reason. Do not claim an idle session must expire.
- [ ] If a positive inactivity/time-box limit exists, wait naturally beyond
      that limit and the access-token lifetime, then make a fresh protected GET.
      Expected: reauthentication when the configured policy requires it.
      If the duration cannot be observed, leave it BLOCKED.
- [ ] For global logout, use two browser contexts of your own existing account.
      Sign out in one, then test fresh protected navigation in the other after
      its current access token expires. Expected: revoked refresh cannot renew
      the other session and reauthentication is required.
      Already-issued JWTs may remain valid until expiry; immediate global
      revocation must not be assumed. Do not extract or replay tokens.

The reviewed app calls `supabase.auth.signOut()` without a scope override;
Supabase documents the default as global. This checklist leaves that behavior
unchanged. See [Supabase sign-out](https://supabase.com/docs/reference/javascript/auth-signout)
and [session controls](https://supabase.com/docs/guides/auth/sessions).

### P5-07: Manager authorization

- [ ] An approved existing Manager account holder privately tests normal login,
      identity, dashboard, operational/financial reports, loan/savings reads,
      permitted Users listing, navigation, and refresh.
- [ ] Direct Owner-only page requests, including `/users/new` and `/audit`,
      must deny access. Policy/finance administration and sensitive reports must
      be absent or inaccessible as the capability matrix requires.
      Inspect controls only; never submit a write.
- [ ] **BLOCKED for normal navigation:** the only currently linked Manager
      profile requires a password change. Its forced-change restriction can be
      observed without completing it; changing the password is outside this
      task's authorization.

### P5-08: Secretary/Treasurer authorization

- [ ] An approved existing Secretary/Treasurer account holder privately tests
      normal login, own identity, dashboard, loan/payment/savings/ledger reads,
      operational reports, refresh, and logout.
- [ ] Direct `/users`, `/users/new`, `/audit`, Owner administration,
      financial/sensitive report pages, and sensitive identity views must deny
      access or redact data as the matrix requires.
      Loan approval, disbursement, payment reversal, and policy activation
      controls must not permit this role to act. Never submit those actions.
- [ ] Check per-person notifications and private document visibility using
      existing data. One of the two linked Secretary/Treasurer profiles requires
      a password change; its normal-flow tests remain BLOCKED. The other does
      not have that flag. Account holders keep all credentials private.

### P5-09: borrower and branch isolation

- [ ] **BLOCKED:** no existing hosted Auth-linked client-role account was
      identified. An approved existing borrower session is needed to verify
      own-record visibility, denial of other clients' detail URLs, and denial of
      staff routes. Do not create or link an account for this test.
- [ ] **BLOCKED:** the project has one branch and all four linked staff profiles
      have no branch assignment, meaning global scope in the reviewed helper.
      This cannot demonstrate cross-branch denial. Meaningful branch-scoped
      principal/data coverage requires a separately authorized isolated setup
      or an explicitly agreed certification-scope decision.

### P5-10: hosted RLS, private documents, and negative account states

- [ ] With each available approved existing role, use read-only app pages for
      allowed and forbidden existing records. For a borrower, include another
      existing client's URL; for scoped staff, another branch's records.
      Record allowed/denied UI results. A UI denial alone establishes a route
      guard result, not an independent Data API/RLS result. Hosted authenticated
      API isolation remains unexecuted; the separate SQL-context checks are
      database-only evidence. No token needs to be copied or provided.
- [ ] Check existing private documents for permitted and forbidden roles.
      If the necessary document or principal is absent, mark BLOCKED; do not
      upload a document or mint a sharing link to fill the gap.
- [ ] Suspended, inactive, no-role, or forced-change behavior may be tested only
      with already existing approved accounts in those states. Do not change an
      account's status, role, link, or password. Missing cases remain BLOCKED.
      The current forced-change database contexts retain normal capabilities
      and financial read access. This observed authorization-boundary gap
      requires explicit security review before that case can be certified.
- [ ] Production financial-write denials and transactional separation-of-duty
      tests are not exercised by submitting writes. Their execution evidence
      remains the isolated CI suite plus the live catalog checks. Record this
      scope explicitly in the final certification decision.

## Completion record

For each ID, record role, timestamp, browser, steps actually executed, expected
result, observed result, and status. Retain **USER-REPORTED MANUAL** as the
provenance for results supplied by an account holder. Keep independent
database-only checks and local Auth-shim CI results in their own categories.

Phase 5 remains **PARTIALLY VERIFIED** until the outstanding session and role
tests are completed and blocked borrower/branch/account-state coverage has an
explicit resolution. No N/A or risk acceptance is inferred from missing data.
