import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  asUser,
  createTestUser,
  deleteTestUsers,
  type TestUser,
} from '../helpers/auth-fixtures';
import {
  closePool,
  expectError,
  hasDatabase,
  inRollbackTransaction,
  query,
  queryOne,
  skipReason,
} from '../helpers/db';
import { satisfyActivationPreconditions } from '../helpers/membership';
import {
  LIVE_MEMBERSHIP_STATUSES,
  MEMBERSHIP_STATUSES,
  MEMBERSHIP_TRANSITIONS,
  UNDECIDED_POLICY_RULES,
  canTransitionMembership,
  isPolicyFinanciallyEnabled,
} from '@/lib/domain/membership';
import { REFERENCE_FORMAT_DEFAULTS } from '@/lib/domain/reference';

/**
 * The membership foundation, against a real database.
 *
 * What these assert, in order: that the schema says what
 * `lib/domain/membership.ts` says; that the lifecycle cannot be stepped
 * outside; that a client cannot hold two live memberships even under
 * concurrency; that a policy version members are enrolled under cannot be
 * reworded; and that the financial gate cannot be opened while a decision is
 * outstanding.
 *
 * The last of those is the one that matters most for Polytos Phase 1. Nine
 * of the programme's rules are undecided, and the whole design rests on the
 * claim that nothing financial can run until they are settled. A claim like
 * that is worth nothing without a test that tries.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('membership suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

interface Fixtures {
  owner: TestUser;
  manager: TestUser;
  secretary: TestUser;
  clientId: string;
  policyVersionId: string;
}

let fx: Fixtures;

/** Register a client as the table owner, bypassing policies deliberately. */
async function makeClient(name: string, phone: string): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `insert into public.clients
       (full_name, sex, date_of_birth, phone, occupation, village_area, district)
     values ($1, 'female', '1990-01-01', $2, 'Trader', 'Kalerwe', 'Kampala')
     returning id`,
    [name, phone],
  );
  return row.id;
}

/**
 * Put the seeded policy version in force for the duration of the suite.
 *
 * It ships as a draft, deliberately — see migration 20261019000200 — so a
 * membership cannot be enrolled against it as shipped. Activating it here is
 * what lets the lifecycle be exercised at all, and it is reverted in
 * `afterAll` so the suite leaves the database as it found it.
 *
 * The effective date is moved back with it. The seed carries 1 November
 * 2026, which is when the programme begins; "in force" means active,
 * approved **and** started, so a version that has not started yet enrols
 * nobody. Backdating it here is the fixture saying "the programme is
 * running", which is the premise every test below is written against.
 */
async function activateSeededPolicy(): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `update public.membership_policy_versions
        set approved_at = pg_catalog.now(), status = 'active',
            effective_from = public.business_date() - 1
      where version = '1.0'
      returning id`,
  );
  return row.id;
}

async function restoreSeededPolicy(): Promise<void> {
  // `approved_at` is frozen once set by the guard, so the trigger is
  // suspended for the restore — the same documented owner-level exemption
  // `deleteTestUsers` uses, and safe for the same reason: a throwaway
  // database, as the owner, with no application code involved.
  await query(
    `alter table public.membership_policy_versions
       disable trigger membership_policy_versions_guard`,
  );
  await query(
    `alter table public.membership_policy_versions
       disable trigger audit_membership_policy_change`,
  );
  try {
    await query(
      `update public.membership_policy_versions
          set status = 'draft', approved_at = null, approved_by = null,
              approved_by_label = null, effective_from = '2026-11-01'
        where version = '1.0'`,
    );
  } finally {
    await query(
      `alter table public.membership_policy_versions
         enable trigger audit_membership_policy_change`,
    );
    await query(
      `alter table public.membership_policy_versions
         enable trigger membership_policy_versions_guard`,
    );
  }
}

beforeAll(async () => {
  if (!hasDatabase) return;

  const [owner, manager, secretary] = await Promise.all([
    createTestUser('owner_admin'),
    createTestUser('manager'),
    createTestUser('secretary_treasurer'),
  ]);

  fx = {
    owner,
    manager,
    secretary,
    clientId: await makeClient('Nakato Ssemakula Birabwa', '+256700100001'),
    policyVersionId: await activateSeededPolicy(),
  };
});

afterAll(async () => {
  if (!hasDatabase) return;
  await deleteTestUsers();
  await restoreSeededPolicy();
  await closePool();
});

// ===========================================================================
describeDb('the membership schema says what the domain module says', () => {
  it('constrains status to exactly the application vocabulary', async () => {
    const row = await queryOne<{ definition: string }>(
      `select pg_get_constraintdef(c.oid) as definition
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
        where t.relname = 'memberships' and c.conname = 'memberships_status_valid'`,
    );

    for (const status of MEMBERSHIP_STATUSES) {
      expect(row.definition, status).toContain(`'${status}'`);
    }
  });

  it('occupies the single live slot with exactly the live statuses', async () => {
    const row = await queryOne<{ definition: string }>(
      `select pg_get_indexdef(i.indexrelid) as definition
         from pg_index i
         join pg_class c on c.oid = i.indexrelid
        where c.relname = 'memberships_one_live_per_client'`,
    );

    for (const status of LIVE_MEMBERSHIP_STATUSES) {
      expect(row.definition, status).toContain(`'${status}'`);
    }
    // And no terminal status, which would make rejoining impossible.
    expect(row.definition).not.toContain("'withdrawn'");
    expect(row.definition).not.toContain("'deceased'");
  });

  it('numbers memberships in the shape the application formats', async () => {
    const format = REFERENCE_FORMAT_DEFAULTS.membership;

    const row = await queryOne<{ prefix: string; padding: number }>(
      `select prefix, padding from public.reference_formats where scope = 'membership'`,
    );

    expect(row.prefix).toBe(format.prefix);
    expect(row.padding).toBe(format.padding);
  });

  it('declares every undecided rule as a nullable column', async () => {
    // The whole gate rests on NULL meaning "undecided". A column that was
    // NOT NULL, or carried a default, would make the gate unopenable or —
    // far worse — silently satisfied by a value nobody chose.
    const columnFor: Readonly<Record<string, string>> = {
      interestBasis: 'interest_basis',
      interestMethod: 'interest_method',
      savingsToLoanMultiplierBps: 'savings_to_loan_multiplier_bps',
      qualifyingMonthsConsecutive: 'qualifying_months_consecutive',
      savingsWithdrawalWithActiveLoan: 'savings_withdrawal_with_active_loan',
      profitDistributionBasis: 'profit_distribution_basis',
      medicalBenefitAnnualCap: 'medical_benefit_annual_cap',
      medicalBenefitClaimsPerYear: 'medical_benefit_claims_per_year',
      benefitWaitingPeriodDays: 'benefit_waiting_period_days',
    };

    for (const rule of UNDECIDED_POLICY_RULES) {
      const column = columnFor[rule];
      expect(column, `${rule} has no column mapping`).toBeDefined();

      const row = await queryOne<{ is_nullable: string; column_default: string | null }>(
        `select is_nullable, column_default
           from information_schema.columns
          where table_schema = 'public'
            and table_name = 'membership_policy_versions'
            and column_name = $1`,
        [column],
      );

      expect(row.is_nullable, column).toBe('YES');
      expect(row.column_default, column).toBeNull();
    }
  });
});

// ===========================================================================
describeDb('membership numbering', () => {
  it('mints the number itself and refuses a caller-supplied one', async () => {
    await inRollbackTransaction(async (client) => {
      const inserted = await client.query<{ membership_number: string }>(
        `insert into public.memberships (client_id, applied_on)
         values ($1, current_date) returning membership_number`,
        [fx.clientId],
      );

      expect(inserted.rows[0]?.membership_number).toMatch(/^MB\d{5,}$/);
    });

    const refused = await expectError(
      `insert into public.memberships (client_id, membership_number, applied_on)
       values ($1, 'MB269999', current_date)`,
      [fx.clientId],
    );

    expect(refused?.message).toContain('assigned by the database');
  });

  it('issues a distinct number to every one of twenty concurrent enrolments', async () => {
    // The duplicate-invoice bug, in its membership form. Twenty clients
    // enrolled at once through twenty separate connections: if the counter
    // were read-then-written rather than advanced atomically, two of them
    // would come back with the same number on a card.
    const clientIds = await Promise.all(
      Array.from({ length: 20 }, (_unused, index) =>
        makeClient(
          `Concurrency Member ${String(index)}`,
          `+2567001010${String(index).padStart(2, '0')}`,
        ),
      ),
    );

    const numbers = await Promise.all(
      clientIds.map(async (clientId) => {
        const row = await queryOne<{ membership_number: string }>(
          `insert into public.memberships (client_id, applied_on)
           values ($1, current_date) returning membership_number`,
          [clientId],
        );
        return row.membership_number;
      }),
    );

    expect(new Set(numbers).size).toBe(numbers.length);
  });
});

// ===========================================================================
describeDb('one live membership per client', () => {
  it('refuses a second live membership, and permits one after it ends', async () => {
    const clientId = await makeClient('Rejoining Member', '+256700102001');

    const first = await queryOne<{ id: string }>(
      `insert into public.memberships (client_id, applied_on)
       values ($1, current_date) returning id`,
      [clientId],
    );

    const second = await expectError(
      `insert into public.memberships (client_id, applied_on)
       values ($1, current_date)`,
      [clientId],
    );

    expect(second?.code).toBe('23505');
    expect(second?.constraint).toBe('memberships_one_live_per_client');

    // End the first, and the slot opens. A rejoining member is a new row
    // with a new number, because the qualification clock restarts.
    await query(
      `update public.memberships
          set status = 'withdrawn', status_reason = 'Left the programme'
        where id = $1`,
      [first.id],
    );

    const rejoin = await queryOne<{ membership_number: string }>(
      `insert into public.memberships (client_id, applied_on)
       values ($1, current_date) returning membership_number`,
      [clientId],
    );

    expect(rejoin.membership_number).toMatch(/^MB\d{5,}$/);

    const held = await query<{ count: string }>(
      `select count(*) as count from public.memberships where client_id = $1`,
      [clientId],
    );

    // Both rows survive: the history is not rewritten by rejoining.
    expect(Number(held[0]?.count)).toBe(2);
  });

  it('lets only one of two simultaneous enrolments through', async () => {
    const clientId = await makeClient('Simultaneous Member', '+256700102002');

    const attempts = await Promise.allSettled([
      query(
        `insert into public.memberships (client_id, applied_on)
         values ($1, current_date)`,
        [clientId],
      ),
      query(
        `insert into public.memberships (client_id, applied_on)
         values ($1, current_date)`,
        [clientId],
      ),
    ]);

    const succeeded = attempts.filter((result) => result.status === 'fulfilled');

    expect(succeeded).toHaveLength(1);
  });
});

// ===========================================================================
describeDb('the lifecycle', () => {
  /**
   * A pending membership that *can* be activated.
   *
   * Polytos Phase 2 made `pending -> active` conditional on a posted
   * registration fee and a verified acceptance (ADR-050) — the preconditions
   * this file's own Phase 1 comments said would arrive. The helper satisfies
   * them the way the counter does, through `record_membership_fee` and an
   * acceptance the guard verifies, so every assertion below is about the
   * lifecycle and not about enrolment.
   */
  async function enrol(phone: string): Promise<string> {
    const clientId = await makeClient(`Lifecycle ${phone}`, phone);
    const row = await queryOne<{ id: string }>(
      `insert into public.memberships (client_id, applied_on)
       values ($1, current_date) returning id`,
      [clientId],
    );
    await satisfyActivationPreconditions(row.id, fx.manager.profileId);
    return row.id;
  }

  it('creates every membership pending, and refuses any other opening status', async () => {
    const refused = await expectError(
      `insert into public.memberships (client_id, applied_on, status)
       values ($1, current_date, 'active')`,
      [fx.clientId],
    );

    expect(refused?.message).toContain('created pending');
  });

  it('permits exactly the transitions the domain module permits', async () => {
    for (const from of MEMBERSHIP_STATUSES) {
      for (const to of MEMBERSHIP_STATUSES) {
        if (from === to) continue;

        const expected = canTransitionMembership(from, to);
        // Cross-check the table the domain module publishes, so this loop
        // cannot pass by both sides agreeing on the wrong thing.
        expect(MEMBERSHIP_TRANSITIONS[from].includes(to)).toBe(expected);
      }
    }

    // And the database agrees, step by step along a real membership.
    const id = await enrol('+256700103001');

    await query(`update public.memberships set status = 'active' where id = $1`, [id]);

    const backwards = await expectError(
      `update public.memberships set status = 'pending' where id = $1`,
      [id],
    );
    expect(backwards?.message).toContain('cannot move from active to pending');

    await query(
      `update public.memberships
          set status = 'suspended', status_reason = 'Savings in arrears'
        where id = $1`,
      [id],
    );
    await query(`update public.memberships set status = 'active' where id = $1`, [id]);
    await query(
      `update public.memberships
          set status = 'withdrawn', status_reason = 'Member left'
        where id = $1`,
      [id],
    );

    const fromTerminal = await expectError(
      `update public.memberships set status = 'active' where id = $1`,
      [id],
    );
    expect(fromTerminal?.message).toContain('cannot move from withdrawn to active');
  });

  it('demands a reason for a suspension and a withdrawal, and not for a death', async () => {
    const id = await enrol('+256700103002');
    await query(`update public.memberships set status = 'active' where id = $1`, [id]);

    const noReason = await expectError(
      `update public.memberships set status = 'suspended' where id = $1`,
      [id],
    );
    expect(noReason?.constraint).toBe('memberships_restricted_status_has_reason');

    // A death needs no reason: the reason is the status.
    await query(`update public.memberships set status = 'deceased' where id = $1`, [id]);

    const row = await queryOne<{ status: string; ended_on: string | null }>(
      `select status, ended_on from public.memberships where id = $1`,
      [id],
    );
    expect(row.status).toBe('deceased');
    expect(row.ended_on).not.toBeNull();
  });

  it('stamps the dates itself and refuses a caller that tries to', async () => {
    const id = await enrol('+256700103003');

    await query(`update public.memberships set status = 'active' where id = $1`, [id]);

    const activated = await queryOne<{ activated_on: string }>(
      `select activated_on from public.memberships where id = $1`,
      [id],
    );
    expect(activated.activated_on).not.toBeNull();

    // Backdating an activation would backdate a savings qualification, so
    // the date cannot be moved once the transition has stamped it.
    const backdated = await expectError(
      `update public.memberships set activated_on = current_date - 200 where id = $1`,
      [id],
    );
    expect(backdated?.message).toContain('stamped by the transition');
  });

  it('records every transition in the history, in order, and nowhere else', async () => {
    const id = await enrol('+256700103004');

    await query(`update public.memberships set status = 'active' where id = $1`, [id]);
    await query(
      `update public.memberships
          set status = 'suspended', status_reason = 'Under review'
        where id = $1`,
      [id],
    );

    const history = await query<{ from_status: string | null; to_status: string }>(
      `select from_status, to_status
         from public.membership_status_history
        where membership_id = $1 order by id`,
      [id],
    );

    expect(history).toEqual([
      { from_status: null, to_status: 'pending' },
      { from_status: 'pending', to_status: 'active' },
      { from_status: 'active', to_status: 'suspended' },
    ]);

    // Append-only, by trigger as well as by privilege.
    const edited = await expectError(
      `update public.membership_status_history set reason = 'something else'
        where membership_id = $1`,
      [id],
    );
    expect(edited?.message).toContain('append-only');

    const deleted = await expectError(
      `delete from public.membership_status_history where membership_id = $1`,
      [id],
    );
    expect(deleted?.message).toContain('append-only');
  });

  it('refuses to delete a membership at all', async () => {
    const id = await enrol('+256700103005');

    const deleted = await expectError(`delete from public.memberships where id = $1`, [
      id,
    ]);

    expect(deleted?.message).toContain('append-only');
  });

  it('refuses to move a membership to another client, or to another policy', async () => {
    const id = await enrol('+256700103006');
    const otherClient = await makeClient('Other Member', '+256700103007');

    const moved = await expectError(
      `update public.memberships set client_id = $2 where id = $1`,
      [id, otherClient],
    );
    expect(moved?.message).toContain('belongs to the client it was opened for');
  });
});

// ===========================================================================
describeDb('the policy version', () => {
  it('cannot have its figures changed once a member is enrolled under it', async () => {
    const clientId = await makeClient('Policy Held Member', '+256700104001');
    await query(
      `insert into public.memberships (client_id, applied_on)
       values ($1, current_date)`,
      [clientId],
    );

    const reworded = await expectError(
      `update public.membership_policy_versions
          set monthly_savings_minimum = 100000
        where id = $1`,
      [fx.policyVersionId],
    );

    expect(reworded?.message).toContain('Publish a new version');
  });

  it('keeps at most one version in force', async () => {
    const clash = await expectError(
      `insert into public.membership_policy_versions
         (version, title, effective_from, status, approved_at, approved_by_label,
          registration_fee, monthly_savings_minimum, savings_qualifying_months,
          member_loan_interest_rate_bps, member_loan_max_term_months,
          member_loan_weekly_cadence_max_months, non_member_loan_max_term_months,
          medical_benefit_rate_bps, medical_benefit_min_admission_days,
          family_condolence_benefit, member_bereavement_benefit)
       values ('9.9', 'A second version in force', current_date + 1, 'active',
               pg_catalog.now(), 'test',
               5000, 50000, 6, 500, 5, 2, 3, 500, 1, 100000, 200000)`,
    );

    expect(clash?.code).toBe('23505');
  });

  it('refuses a version that is in force but unapproved', async () => {
    const unapproved = await expectError(
      `insert into public.membership_policy_versions
         (version, title, effective_from, status,
          registration_fee, monthly_savings_minimum, savings_qualifying_months,
          member_loan_interest_rate_bps, member_loan_max_term_months,
          member_loan_weekly_cadence_max_months, non_member_loan_max_term_months,
          medical_benefit_rate_bps, medical_benefit_min_admission_days,
          family_condolence_benefit, member_bereavement_benefit)
       values ('9.8', 'Unapproved but in force', current_date + 2, 'superseded',
               5000, 50000, 6, 500, 5, 2, 3, 500, 1, 100000, 200000)`,
    );

    expect(unapproved?.constraint).toBe('membership_policy_in_force_is_approved');
  });

  it('is never deleted', async () => {
    const deleted = await expectError(
      `delete from public.membership_policy_versions where id = $1`,
      [fx.policyVersionId],
    );

    expect(deleted?.message).toContain('append-only');
  });
});

// ===========================================================================
describeDb('the financial gate', () => {
  it('stays shut while any decision is outstanding, however the version is edited', async () => {
    // The seeded version is active and approved for the duration of this
    // suite, and still must not be financially enabled: nine rules are
    // undecided, and the generated column cannot be talked round.
    const row = await queryOne<{ is_financially_enabled: boolean }>(
      `select is_financially_enabled
         from public.membership_policy_versions where id = $1`,
      [fx.policyVersionId],
    );

    expect(row.is_financially_enabled).toBe(false);

    // And it cannot be set directly: it is GENERATED ALWAYS.
    const forced = await expectError(
      `update public.membership_policy_versions
          set is_financially_enabled = true where id = $1`,
      [fx.policyVersionId],
    );

    expect(forced).not.toBeNull();
  });

  it('opens only when every decision is made, and the TypeScript gate agrees', async () => {
    await inRollbackTransaction(async (client) => {
      await client.query(
        `insert into public.membership_policy_versions
           (version, title, effective_from, status, approved_at, approved_by_label,
            registration_fee, monthly_savings_minimum, savings_qualifying_months,
            member_loan_interest_rate_bps, member_loan_max_term_months,
            member_loan_weekly_cadence_max_months, non_member_loan_max_term_months,
            medical_benefit_rate_bps, medical_benefit_min_admission_days,
            family_condolence_benefit, member_bereavement_benefit,
            interest_basis, interest_method, savings_to_loan_multiplier_bps,
            qualifying_months_consecutive, savings_withdrawal_with_active_loan,
            profit_distribution_basis, medical_benefit_annual_cap,
            medical_benefit_claims_per_year, benefit_waiting_period_days)
         values ('9.1', 'Fully decided', current_date + 10, 'draft',
                 pg_catalog.now(), 'test',
                 5000, 50000, 6, 500, 5, 2, 3, 500, 1, 100000, 200000,
                 'per_month', 'flat', 20000, true, 'blocked',
                 'pro_rata_savings', 500000, 2, 90)`,
      );

      // Not in force, so still not enabled — being complete is necessary and
      // not sufficient. It is seeded as a draft rather than as a superseded
      // version because a policy version's status moves one way only and a
      // superseded one is never brought back; `membership-hardening.test.ts`
      // asserts that rule, in both directions and for the privileged path
      // too. For this gate the two are the same case: not active.
      const notInForce = await client.query<{ enabled: boolean }>(
        `select is_financially_enabled as enabled
           from public.membership_policy_versions where version = '9.1'`,
      );
      expect(notInForce.rows[0]?.enabled).toBe(false);

      // Retire the seeded one and put this in force.
      await client.query(
        `update public.membership_policy_versions set status = 'superseded'
          where version = '1.0'`,
      );
      await client.query(
        `update public.membership_policy_versions set status = 'active'
          where version = '9.1'`,
      );

      const enabled = await client.query<{ enabled: boolean }>(
        `select is_financially_enabled as enabled
           from public.membership_policy_versions where version = '9.1'`,
      );
      expect(enabled.rows[0]?.enabled).toBe(true);

      // And the TypeScript gate reaches the same answer on the same row.
      expect(
        isPolicyFinanciallyEnabled({
          status: 'active',
          approvedAt: new Date().toISOString(),
          interestBasis: 'per_month',
          interestMethod: 'flat',
          savingsToLoanMultiplierBps: 20000,
          qualifyingMonthsConsecutive: true,
          savingsWithdrawalWithActiveLoan: 'blocked',
          profitDistributionBasis: 'pro_rata_savings',
          medicalBenefitAnnualCap: 500000,
          medicalBenefitClaimsPerYear: 2,
          benefitWaitingPeriodDays: 90,
        }),
      ).toBe(true);
    });
  });

  it('refuses an enrolment when no version is in force', async () => {
    await inRollbackTransaction(async (client) => {
      await client.query(
        `update public.membership_policy_versions set status = 'superseded'
          where status = 'active'`,
      );

      const clientRow = await client.query<{ id: string }>(
        `insert into public.clients
           (full_name, sex, date_of_birth, phone, occupation, village_area, district)
         values ('No Policy Member', 'male', '1990-01-01', '+256700105001',
                 'Trader', 'Kalerwe', 'Kampala')
         returning id`,
      );

      await expect(
        client.query(
          `insert into public.memberships (client_id, applied_on)
           values ($1, current_date)`,
          [clientRow.rows[0]?.id],
        ),
      ).rejects.toThrow(/No membership policy version is in force/);
    });
  });
});

// ===========================================================================
describeDb('the audit trail follows every membership change', () => {
  it('records the enrolment and each status change, naming neither more nor less', async () => {
    const clientId = await makeClient('Audited Member', '+256700106001');

    const membership = await queryOne<{ id: string; membership_number: string }>(
      `insert into public.memberships (client_id, applied_on)
       values ($1, current_date) returning id, membership_number`,
      [clientId],
    );

    await satisfyActivationPreconditions(membership.id, fx.manager.profileId);

    await query(`update public.memberships set status = 'active' where id = $1`, [
      membership.id,
    ]);

    const rows = await query<{ action: string; metadata: Record<string, unknown> }>(
      `select action, metadata from public.audit_log
        where entity_type = 'membership' and entity_id = $1
        order by id`,
      [membership.id],
    );

    expect(rows.map((row) => row.action)).toEqual([
      'membership.enrolled',
      'membership.status_changed',
    ]);

    // The membership number and the client are named; nothing personal is.
    for (const row of rows) {
      expect(row.metadata.membership_number).toBe(membership.membership_number);
      expect(JSON.stringify(row)).not.toContain('Audited Member');
    }
  });
});

// ===========================================================================
describeDb('what a session may actually write', () => {
  it('lets a Manager enrol and move a membership, and a Secretary neither', async () => {
    const clientId = await makeClient('Capability Member', '+256700107001');

    const refusedEnrolment = await asUser(
      fx.secretary,
      `insert into public.memberships (client_id, applied_on)
       values ($1, current_date)`,
      [clientId],
    );
    // RLS filters an INSERT out as a policy violation rather than a silent
    // no-op, so this is an error and not a zero row count.
    expect(refusedEnrolment.ok).toBe(false);
    expect(refusedEnrolment.code).toBe('42501');

    const enrolled = await asUser(
      fx.manager,
      `insert into public.memberships (client_id, applied_on)
       values ($1, current_date) returning id`,
      [clientId],
    );
    expect(enrolled.ok).toBe(true);

    // And a Manager may move it. The membership the Manager just enrolled is
    // the one that moves, and its Phase 2 preconditions are met first — the
    // assertion is about the Manager's authority, not about enrolment.
    const movedClientId = await makeClient('Moved Member', '+256700107002');
    const movedMembership = await queryOne<{ id: string }>(
      `insert into public.memberships (client_id, applied_on)
       values ($1, current_date) returning id`,
      [movedClientId],
    );
    await satisfyActivationPreconditions(movedMembership.id, fx.owner.profileId);

    const moved = await asUser(
      fx.manager,
      `update public.memberships set status = 'active'
        where id = $1 returning status`,
      [movedMembership.id],
    );

    expect(moved.ok, moved.message).toBe(true);
    expect(moved.rowCount).toBe(1);
  });

  it('refuses a status change to a holder of membership:update alone', async () => {
    // There is no role in the matrix holding `membership:update` without
    // `membership:manage_status`, so the capability is revoked from the
    // Manager's role for the length of this transaction to prove the column
    // guard — not the role list — is what refuses the write.
    const clientId = await makeClient('Guarded Member', '+256700107003');
    const membership = await queryOne<{ id: string }>(
      `insert into public.memberships (client_id, applied_on)
       values ($1, current_date) returning id`,
      [clientId],
    );
    // The Phase 2 preconditions are met, so the refusal below is about the
    // capability and not about an unpaid fee.
    await satisfyActivationPreconditions(membership.id, fx.owner.profileId);

    await inRollbackTransaction(async (client) => {
      await client.query(
        `delete from public.role_permissions
          where role_key = 'manager' and permission_key = 'membership:manage_status'`,
      );

      await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [
        fx.manager.authUserId,
      ]);
      await client.query('set local role authenticated');

      await expect(
        client.query(`update public.memberships set status = 'active' where id = $1`, [
          membership.id,
        ]),
      ).rejects.toThrow(/membership:manage_status/);
    });
  });

  it('refuses a policy change to everybody but the Owner', async () => {
    for (const actor of [fx.manager, fx.secretary]) {
      const refused = await asUser(
        actor,
        `update public.membership_policy_versions set notes = 'edited' where id = $1`,
        [fx.policyVersionId],
      );

      // Either the policy filters the row out (rowCount 0) or the column
      // guard raises. Both are denials; neither is a change.
      expect(refused.rowCount, actor.role).toBe(0);
    }

    const after = await queryOne<{ notes: string | null }>(
      `select notes from public.membership_policy_versions where id = $1`,
      [fx.policyVersionId],
    );

    expect(after.notes).not.toBe('edited');
  });
});
