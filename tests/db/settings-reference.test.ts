import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  asServiceRole,
  asUser,
  createTestUser,
  deleteTestUsers,
  type TestUser,
} from '../helpers/auth-fixtures';
import { closePool, hasDatabase, query, skipReason } from '../helpers/db';

/**
 * The safe read surface for reference numbering on the Settings screen.
 *
 * ## The contract this protects
 *
 * `reference_sequences` is default-deny: RLS on, the table grants revoked
 * from `authenticated`, and no policy — because the counters disclose how
 * many clients and loans the business has. `tests/db/security.test.ts`
 * asserts the no-policy half of that, and it must stay true.
 *
 * Phase 12's Settings screen nonetheless read the table straight from the
 * caller's session, which is `42501 permission denied` rather than an empty
 * result, and every Owner saw a "could not be read" banner. Phase 18 fixes it
 * with `settings_reference_sequences()` — a `settings:view`-gated
 * SECURITY DEFINER function that returns only the three fields the screen
 * shows, while the table itself stays exactly as locked.
 *
 * So these assertions pull in both directions at once: the function must let
 * an Owner read the counters, and the table must still refuse everyone —
 * including that same Owner — a direct read. A fix that opened the table to
 * make the screen work would pass the first and fail the last.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('settings reference numbering suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

/**
 * A bespoke staff role that holds a real capability but not `settings:view`.
 *
 * Every seeded staff role holds `settings:view`, so proving the gate keys on
 * the capability — and not merely on "is this a signed-in staff member" —
 * needs a staff principal that lacks it. `payments:view` is a genuine
 * capability, so this is a plausible role, not an empty one.
 */
const NO_SETTINGS_ROLE = 'test_no_settings_view';

describeDb('settings_reference_sequences()', () => {
  let owner: TestUser;
  let borrower: TestUser;
  let staffWithoutSettings: TestUser;

  beforeAll(async () => {
    await deleteTestUsers();

    // A rank above every seeded role, and off their 10/30/50/70 spacing, so it
    // cannot collide with the unique rank constraint.
    await query(
      `insert into public.roles (key, label, description, rank, is_staff)
       values ($1, 'Test (no settings)', 'Fixture role without settings:view.', 975, true)
       on conflict (key) do nothing`,
      [NO_SETTINGS_ROLE],
    );
    await query(
      `insert into public.role_permissions (role_key, permission_key)
       values ($1, 'payments:view')
       on conflict do nothing`,
      [NO_SETTINGS_ROLE],
    );

    owner = await createTestUser('owner_admin');
    borrower = await createTestUser('client');
    staffWithoutSettings = await createTestUser(NO_SETTINGS_ROLE);

    // At least one counter to read, issued through the only legitimate write
    // path. `service_role` keeps EXECUTE on `next_reference`; no session role
    // can advance a counter, which is the whole reason the table is locked.
    await asServiceRole(`select public.next_reference('client')`);
  });

  afterAll(async () => {
    await deleteTestUsers();
    // The bespoke role outlives deleteTestUsers (it clears user_roles for the
    // test profiles, not the role itself), so remove it here — children
    // first, for the ON DELETE RESTRICT foreign keys.
    await query(`delete from public.role_permissions where role_key = $1`, [
      NO_SETTINGS_ROLE,
    ]);
    await query(`delete from public.roles where key = $1`, [NO_SETTINGS_ROLE]);
    await closePool();
  });

  it('lets an Owner read the counters, with rows', async () => {
    const result = await asUser(
      owner,
      `select scope, period_year, last_value from public.settings_reference_sequences()`,
    );

    expect(result.ok).toBe(true);
    expect(result.rows.length).toBeGreaterThan(0);

    const row = result.rows[0] as {
      scope: string;
      period_year: number;
      last_value: number;
    };
    expect(typeof row.scope).toBe('string');
    expect(Number.isInteger(Number(row.period_year))).toBe(true);
    expect(Number(row.last_value)).toBeGreaterThanOrEqual(1);
  });

  it('exposes only scope, period year and last value — no internal columns', async () => {
    // `select *` from the function, so a future hand that widened the
    // function to return `created_at` or the prefix from `reference_formats`
    // would fail here rather than quietly leak it.
    const result = await asUser(
      owner,
      `select * from public.settings_reference_sequences()`,
    );

    expect(result.ok).toBe(true);
    expect(Object.keys(result.rows[0] ?? {}).sort()).toEqual([
      'last_value',
      'period_year',
      'scope',
    ]);
  });

  it('refuses a borrower, who holds no settings capability', async () => {
    const result = await asUser(
      borrower,
      `select * from public.settings_reference_sequences()`,
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe('42501');
  });

  it('refuses a staff role that lacks settings:view', async () => {
    // The gate keys on the capability, not on being signed in or being staff.
    const result = await asUser(
      staffWithoutSettings,
      `select * from public.settings_reference_sequences()`,
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe('42501');
  });

  it('leaves the underlying table unreadable, even to the Owner', async () => {
    // The function is the only way in. A direct table read is permission
    // denied for everyone through a session — which is the defect's own
    // error, now confined to the path nothing is supposed to take.
    const viaTable = await asUser(owner, `select scope from public.reference_sequences`);
    expect(viaTable.ok).toBe(false);
    expect(viaTable.code).toBe('42501');

    const borrowerViaTable = await asUser(
      borrower,
      `select scope from public.reference_sequences`,
    );
    expect(borrowerViaTable.ok).toBe(false);
    expect(borrowerViaTable.code).toBe('42501');
  });

  it('is not executable by an anonymous visitor', async () => {
    // EXECUTE is granted to `authenticated`, not to `anon`: a signed-out
    // caller cannot even reach the gate.
    const { asAnon } = await import('../helpers/auth-fixtures');
    const result = await asAnon(`select * from public.settings_reference_sequences()`);

    expect(result.ok).toBe(false);
    expect(result.code).toBe('42501');
  });
});
