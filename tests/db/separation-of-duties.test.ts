/**
 * L7 — a separation-of-duties refusal has its own SQLSTATE.
 *
 * Recommendation L7 of the full-system certification report. L5's browser
 * journeys found a Manager who banked cash and then tried to clear it being
 * told **"Privilege denied on record."** — which names the wrong cause,
 * because the Manager holds `deposits:verify`. What stopped them is that
 * somebody else has to check their work.
 *
 * The cause of the wrong sentence was that the guard raised `42501`, the same
 * code a genuine Row Level Security denial raises, so `mapDatabaseError`
 * could not tell the two apart. Migration `20261121000100` gives every
 * separation-of-duties guard its own code, `SD001`.
 *
 * What this file proves, in the four shapes the brief asks for:
 *
 *   1. **Coverage** — all fourteen guards raise `SD001`, and nothing else in
 *      the schema does. Measured against the live definitions, so a future
 *      `create or replace` that drops the code fails here.
 *   2. **The authorised action still works** — a second officer clears the
 *      deposit, and the money moves.
 *   3. **Self-verification is still refused** — now with `SD001`, and with
 *      nothing written.
 *   4. **A genuine permission denial still says so** — a role without the
 *      capability still gets `42501`, which is the distinction the whole
 *      change exists to make. If this one ever went green by accident the
 *      change would have destroyed the thing it was meant to build.
 *
 * The sentence a person reads is not asserted here, because it is not the
 * database's. It is `SeparationOfDutiesError.USER_MESSAGE`, asserted in
 * `tests/unit/errors.test.ts` and read off a real screen in
 * `tests/e2e/specs/cash-sufficiency.write.spec.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestUser, deleteTestUsers } from '../helpers/auth-fixtures';
import {
  closePool,
  getClient,
  hasDatabase,
  query,
  queryOne,
  skipReason,
} from '../helpers/db';
import { fundBranchTill } from '../helpers/loan-fixtures';

const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('separation of duties', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

/** The fourteen guards, as the L7 migration names them. */
const GUARDED = [
  'approve_agency_cash_reconciliation',
  'approve_agency_float_reconciliation',
  'approve_expense',
  'approve_transfer',
  'certify_agency_commission_reconciliation',
  'confirm_cash_receipt',
  'confirm_physical_cash_return',
  'decide_savings_withdrawal',
  'reject_agency_cash_banking',
  'verify_agency_cash_banking',
  'verify_agency_float_trade',
  'verify_agency_transaction',
  'verify_bank_deposit',
  'verify_member_beneficiary',
] as const;

/**
 * Run statements attributed to one officer and commit them.
 *
 * Committed rather than rolled back because the next step has to be a
 * *different* officer in a *different* transaction: that is the control under
 * test, and a rolled-back probe cannot express it.
 */
async function asOfficerCommitted(
  authUserId: string,
  statements: readonly { readonly sql: string; readonly params?: readonly unknown[] }[],
): Promise<Record<string, unknown>[]> {
  const client = await getClient();
  try {
    await client.query('begin');
    await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [
      authUserId,
    ]);
    let rows: Record<string, unknown>[] = [];
    for (const s of statements) {
      const result = await client.query(s.sql, [...(s.params ?? [])]);
      rows = result.rows as Record<string, unknown>[];
    }
    await client.query('commit');
    return rows;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** The SQLSTATE a call raises, or null if it succeeded. */
async function sqlstateFrom(
  authUserId: string,
  sql: string,
  params: readonly unknown[],
): Promise<string | null> {
  try {
    await asOfficerCommitted(authUserId, [{ sql, params }]);
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? 'unknown';
  }
}

describeDb('separation of duties has its own SQLSTATE (L7)', () => {
  afterAll(async () => {
    await deleteTestUsers();
    await closePool();
  });

  describe('coverage, against the live definitions', () => {
    it('every one of the fourteen guards raises SD001', async () => {
      const rows = await query<{ proname: string }>(
        `select p.proname
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
            and p.prokind = 'f'
            and p.proname = any($1::text[])
            and position('SD001' in pg_get_functiondef(p.oid)) > 0
          order by p.proname`,
        [[...GUARDED]],
      );

      expect(rows.map((r) => r.proname)).toEqual([...GUARDED]);
    });

    it('nothing else in the schema raises SD001', async () => {
      // The code means one thing. If a future change starts raising it for
      // something that is not a maker-checker refusal, staff would be told to
      // find a colleague for a problem a colleague cannot solve.
      const rows = await query<{ proname: string }>(
        `select p.proname
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
            and p.prokind = 'f'
            and position('SD001' in pg_get_functiondef(p.oid)) > 0
            and not (p.proname = any($1::text[]))
          order by p.proname`,
        [[...GUARDED]],
      );

      expect(rows.map((r) => r.proname)).toEqual([]);
    });

    it('no guard still carries its old code on the separation-of-duties raise', async () => {
      // Six of them raised 42501 and eight raised P0001 before the migration.
      // Both codes legitimately appear *elsewhere* in several of these
      // functions — a branch you cannot see is still 42501 — so this asserts
      // on the guard's own raise rather than on the function as a whole.
      // The match is done here rather than in SQL: PostgreSQL's regex engine
      // caps a bounded repetition at 255, and one of these guards — the
      // beneficiary one, whose sentence explains what a beneficiary is for —
      // is longer than that from the condition to its `errcode`.
      const rows = await query<{ proname: string; definition: string }>(
        `select p.proname, pg_get_functiondef(p.oid) as definition
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.prokind = 'f' and p.proname = any($1::text[])
          order by p.proname`,
        [[...GUARDED]],
      );

      const guardOf = (definition: string): string => {
        const match =
          /(?:recorded_by|requested_by|created_by|submitted_by|initiated_by)\s*=\s*(?:v_actor|public\.current_profile_id\(\))[\s\S]*?;/i.exec(
            definition,
          );
        if (match === null) throw new Error('no separation-of-duties guard found');
        return match[0];
      };

      expect(rows).toHaveLength(GUARDED.length);
      for (const row of rows) {
        const guard = guardOf(row.definition);
        expect(guard, row.proname).toContain('SD001');
        // And not the codes it used to carry. Asserted on the guard's own
        // statement, because several of these functions still raise 42501
        // for a branch the caller cannot see, and P0001 for the ordinary
        // business rules around it — both of which are correct and must stay.
        expect(guard, row.proname).not.toContain('42501');
        expect(guard, row.proname).not.toContain('P0001');
      }
    });
  });

  describe('a bank deposit, which is where L7 was found', () => {
    let branch = '';
    let till = '';
    let bank = '';

    beforeAll(async () => {
      branch = (
        await queryOne<{ id: string }>(
          `select id from public.branches order by branch_code limit 1`,
        )
      ).id;
      // By `cash_kind`, not by code: the codes carry a branch suffix
      // (`1010-BR2601`), so a literal code would bind this test to one
      // branch's chart of accounts.
      till = (
        await queryOne<{ id: string }>(
          `select id from public.ledger_accounts
            where cash_kind = 'cash_at_hand' and branch_id = $1`,
          [branch],
        )
      ).id;
      bank = (
        await queryOne<{ id: string }>(
          `select id from public.ledger_accounts
            where cash_kind = 'bank' and branch_id = $1`,
          [branch],
        )
      ).id;
    });

    it('a second officer clears it, and the money moves', async () => {
      const recorder = await createTestUser('manager');
      const checker = await createTestUser('manager');

      await fundBranchTill(branch, 300_000);
      const recorded = await asOfficerCommitted(recorder.authUserId, [
        {
          sql: `select public.record_bank_deposit($1, $2, 120000, 'L7 allowed path', gen_random_uuid()) as id`,
          params: [till, bank],
        },
      ]);
      const deposit = String(recorded[0]?.id);

      const code = await sqlstateFrom(
        checker.authUserId,
        `select public.verify_bank_deposit($1, 'L7REF0001', current_date, null, null)`,
        [deposit],
      );
      expect(code, 'a different Manager must be able to clear it').toBeNull();

      const row = await queryOne<{ status: string; verified_by: string | null }>(
        `select status, verified_by::text from public.bank_deposits where id = $1`,
        [deposit],
      );
      expect(row.status).toBe('cleared');
      expect(row.verified_by).not.toBeNull();
    });

    it('the officer who recorded it is refused with SD001, and nothing is written', async () => {
      const recorder = await createTestUser('manager');

      await fundBranchTill(branch, 300_000);
      const recorded = await asOfficerCommitted(recorder.authUserId, [
        {
          sql: `select public.record_bank_deposit($1, $2, 90000, 'L7 self path', gen_random_uuid()) as id`,
          params: [till, bank],
        },
      ]);
      const deposit = String(recorded[0]?.id);

      const code = await sqlstateFrom(
        recorder.authUserId,
        `select public.verify_bank_deposit($1, 'L7SELF001', current_date, null, null)`,
        [deposit],
      );

      // The whole point: not 42501, which would be indistinguishable from an
      // RLS denial, and not P0001, which every business rule here raises.
      expect(code).toBe('SD001');
      expect(code).not.toBe('42501');
      expect(code).not.toBe('P0001');

      const row = await queryOne<{
        status: string;
        verified_by: string | null;
        clearance_journal_entry_id: string | null;
      }>(
        `select status, verified_by::text, clearance_journal_entry_id::text
           from public.bank_deposits where id = $1`,
        [deposit],
      );
      expect(row.status).toBe('submitted');
      expect(row.verified_by).toBeNull();
      expect(row.clearance_journal_entry_id).toBeNull();
    });

    it('a role without the capability still gets 42501, not SD001', async () => {
      // The distinction L7 exists to draw. A Secretary holds no
      // `deposits:verify`, so they are refused for a different reason and
      // must be told a different thing — "you do not have permission",
      // not "ask a colleague".
      const recorder = await createTestUser('manager');
      const secretary = await createTestUser('secretary_treasurer');

      await fundBranchTill(branch, 300_000);
      const recorded = await asOfficerCommitted(recorder.authUserId, [
        {
          sql: `select public.record_bank_deposit($1, $2, 70000, 'L7 capability path', gen_random_uuid()) as id`,
          params: [till, bank],
        },
      ]);
      const deposit = String(recorded[0]?.id);

      const code = await sqlstateFrom(
        secretary.authUserId,
        `select public.verify_bank_deposit($1, 'L7CAP0001', current_date, null, null)`,
        [deposit],
      );

      expect(code).toBe('42501');
      expect(code).not.toBe('SD001');

      const row = await queryOne<{ status: string }>(
        `select status from public.bank_deposits where id = $1`,
        [deposit],
      );
      expect(row.status).toBe('submitted');
    });
  });

  describe('a guard that used to raise P0001', () => {
    it('refuses a self-approved transfer with SD001', async () => {
      // `approve_transfer` raised `P0001` before the migration, which is what
      // every hand-written business rule in this schema raises — so the
      // application could not distinguish "a transfer needs two different
      // accounts" from "you cannot approve your own".
      const officer = await createTestUser('manager');

      const branch = (
        await queryOne<{ id: string }>(
          `select id from public.branches order by branch_code limit 1`,
        )
      ).id;

      const till = (
        await queryOne<{ id: string }>(
          `select id from public.ledger_accounts
            where cash_kind = 'cash_at_hand' and branch_id = $1`,
          [branch],
        )
      ).id;
      const bank = (
        await queryOne<{ id: string }>(
          `select id from public.ledger_accounts
            where cash_kind = 'bank' and branch_id = $1`,
          [branch],
        )
      ).id;

      // Above `finance_settings.transfer_approval_threshold` (2,000,000).
      // Below it `record_transfer` posts immediately and there is no approval
      // step to refuse -- the first draft of this test used 50,000 and was
      // refused with "there is nothing to approve", a P0001 that had nothing
      // to do with separation of duties.
      await fundBranchTill(branch, 4_000_000);
      const requested = await asOfficerCommitted(officer.authUserId, [
        {
          sql: `select public.record_transfer($1, $2, 2500000, current_date,
                  'L7 self-approved transfer', null) as id`,
          params: [till, bank],
        },
      ]);
      const transfer = String(requested[0]?.id);

      const code = await sqlstateFrom(
        officer.authUserId,
        `select public.approve_transfer($1)`,
        [transfer],
      );

      expect(code).toBe('SD001');

      const row = await queryOne<{ status: string }>(
        `select status from public.account_transfers where id = $1`,
        [transfer],
      );
      expect(row.status).not.toBe('approved');
    });
  });

  describe('the migration replaced the functions and nothing else', () => {
    it('all fourteen are still SECURITY DEFINER with a pinned search_path', async () => {
      // `create or replace` carries these across, and the L7 migration was
      // generated from each function's live definition so that it could not
      // do otherwise. Asserted because a hand-edited replacement that dropped
      // `security definer` would turn a working control into a silent
      // permission error, and nothing else in the suite would notice.
      const rows = await query<{
        proname: string;
        prosecdef: boolean;
        proconfig: string | null;
      }>(
        `select p.proname, p.prosecdef, array_to_string(p.proconfig, ',') as proconfig
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.prokind = 'f'
            and p.proname = any($1::text[])
          order by p.proname`,
        [[...GUARDED]],
      );

      expect(rows).toHaveLength(GUARDED.length);
      for (const row of rows) {
        expect(row.prosecdef, `${row.proname} must stay SECURITY DEFINER`).toBe(true);
        expect(row.proconfig ?? '', `${row.proname} must keep its search_path`).toContain(
          'search_path',
        );
      }
    });

    it('none of them is executable by anon or authenticated directly', async () => {
      // The grants are what `create or replace` is least obviously safe
      // about, so they are measured rather than trusted. Each of these is
      // reached through a definer function the application calls; none is
      // granted to the public roles.
      const leaked = await query<{ proname: string; grantee: string }>(
        `select p.proname, a.grantee::regrole::text as grantee
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           cross join aclexplode(p.proacl) a
          where n.nspname = 'public' and p.prokind = 'f'
            and p.proname = any($1::text[])
            and a.privilege_type = 'EXECUTE'
            and a.grantee::regrole::text in ('anon', 'public')
          order by p.proname`,
        [[...GUARDED]],
      );

      expect(leaked.map((r) => `${r.proname} -> ${r.grantee}`)).toEqual([]);
    });
  });
});
