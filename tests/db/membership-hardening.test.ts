import { makeBenefitMember } from '../helpers/benefits';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  MEMBERSHIP_ACTIVITIES,
  isActivityReady,
  type MembershipActivity,
  type PolicyDecisionState,
} from '@/lib/domain/membership';

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
  query,
  queryOne,
  skipReason,
} from '../helpers/db';

/**
 * Membership enrolment integrity, policy immutability, and the per-activity
 * financial gates — attacked rather than described.
 *
 * ## Why this file exists separately from `rls-membership.test.ts`
 *
 * That file asks "who may reach this row". This one asks the question behind
 * it: **given that somebody legitimately may write here, what can they write
 * that they should not be able to?** A manager holding `membership:create` is
 * meant to enrol members. Nothing in an RLS policy stops them enrolling one
 * into another branch, or under a draft set of terms nobody approved, or
 * under a version the business has not started yet — and a membership is the
 * contract under which that person's savings will be taken, so each of those
 * is a wrong answer to "what was this member promised".
 *
 * ## Everything here runs as a real database role
 *
 * `asUser` sets `request.jwt.claim.sub` and `set local role authenticated`,
 * which is what PostgREST does for a request carrying a token. The
 * application is not involved, so no guard in a Server Action and no hidden
 * button can account for a pass. Where a rule is meant to bind *every*
 * caller — the ones stated above the trusted-path exemption — the same attack
 * is repeated as the table owner, because a rule that only stops a session is
 * a rule a leaked service key walks through.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('membership hardening suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

/** Every rule the client has not decided, and a value each could take. */
const DECIDED = {
  interest_basis: `'per_month'`,
  interest_method: `'flat'`,
  savings_to_loan_multiplier_bps: '20000',
  qualifying_months_consecutive: 'true',
  savings_withdrawal_with_active_loan: `'blocked'`,
  profit_distribution_basis: `'pro_rata_savings'`,
  medical_benefit_annual_cap: '2000000',
  medical_benefit_claims_per_year: '2',
  benefit_waiting_period_days: '90',
} as const;

const SAVINGS_RULES = [
  'qualifying_months_consecutive',
  'savings_withdrawal_with_active_loan',
] as const;
const LENDING_RULES = [
  'interest_basis',
  'interest_method',
  'savings_to_loan_multiplier_bps',
] as const;
const BENEFIT_RULES = [
  'medical_benefit_annual_cap',
  'medical_benefit_claims_per_year',
  'benefit_waiting_period_days',
] as const;
const PROFIT_RULES = ['profit_distribution_basis'] as const;

interface Fixtures {
  owner: TestUser;
  manager: TestUser;
  /** The client enrolled under `inForceVersionId`. */
  memberClientId: string;
  membershipId: string;
  /** A second client, with no membership, for fresh enrolment attempts. */
  freeClientId: string;
  /** Active, approved, effective yesterday. The version in force. */
  inForceVersionId: string;
  /** Approved and active in the past, then superseded. */
  supersededVersionId: string;
  /** Never approved. */
  draftVersionId: string;
  /** The branch the clients belong to, and a second one they do not. */
  homeBranchId: string;
  otherBranchId: string;
}

let fx: Fixtures;

/** The columns every version needs, with the confirmed figures. */
const CONFIRMED_COLUMNS = `
  version, title, effective_from, status,
  registration_fee, monthly_savings_minimum, savings_qualifying_months,
  member_loan_interest_rate_bps, member_loan_max_term_months,
  member_loan_weekly_cadence_max_months, non_member_loan_max_term_months,
  medical_benefit_rate_bps, medical_benefit_min_admission_days,
  family_condolence_benefit, member_bereavement_benefit`;

const CONFIRMED_VALUES = `
  5000, 50000, 6,
  500, 5,
  2, 3,
  500, 1,
  100000, 200000`;

/**
 * Insert a policy version as the owner of the tables.
 *
 * Deliberately not through `asUser`: these are the fixtures, and what the
 * tests are about is what a *session* may do to them afterwards.
 */
async function makeVersion(
  version: string,
  /** A literal date, or a number of days before the business date. */
  effectiveFrom: string | number,
  status: 'draft' | 'active' | 'superseded',
  decided: readonly (keyof typeof DECIDED)[] = [],
): Promise<string> {
  const compatibilityColumns: string[] = [];
  const compatibilityValues: string[] = [];
  if (decided.includes('medical_benefit_annual_cap')) {
    compatibilityColumns.push('medical_benefit_cap_mode');
    compatibilityValues.push("'amount'");
  }
  if (decided.includes('benefit_waiting_period_days')) {
    compatibilityColumns.push(
      'benefit_qualification_basis',
      'death_confirmations_required',
    );
    compatibilityValues.push("'waiting_period_days'", '0');
  }
  if (decided.includes('medical_benefit_claims_per_year')) {
    compatibilityColumns.push('medical_benefit_year_basis');
    compatibilityValues.push("'calendar_year'");
  }
  const extraColumns = decided.length > 0 ? `, ${decided.join(', ')}` : '';
  const extraValues =
    decided.length > 0 ? `, ${decided.map((rule) => DECIDED[rule]).join(', ')}` : '';
  const approval = status === 'draft' ? '' : `, approved_at, approved_by_label`;
  const approvalValues = status === 'draft' ? '' : `, pg_catalog.now(), 'fixture'`;

  const effective =
    typeof effectiveFrom === 'number' ? `(public.business_date() - $3::int)` : `$3::date`;

  const row = await queryOne<{ id: string }>(
    `insert into public.membership_policy_versions
       (${CONFIRMED_COLUMNS}${extraColumns}${compatibilityColumns.length ? ', ' + compatibilityColumns.join(', ') : ''}${approval})
     values ($1, $2, ${effective}, $4, ${CONFIRMED_VALUES}${extraValues}${compatibilityValues.length ? ', ' + compatibilityValues.join(', ') : ''}${approvalValues})
     returning id`,
    [version, `Hardening fixture ${version}`, effectiveFrom, status],
  );
  return row.id;
}

/**
 * Set a version's status for a fixture, around the guard rather than through
 * it.
 *
 * The production rule is one-way — draft to active to superseded, and never
 * back — and that rule is itself asserted below, through the guard, as a
 * session and as the table owner. A fixture that needs to rewind the world
 * between two tests is not a counter-example to it; it is the same
 * owner-level exemption `deleteTestUsers` uses to take an append-only
 * database apart, and it is safe here for the same reason: a throwaway
 * database, as the owner, with no application code involved.
 */
async function forceStatus(
  versionId: string,
  status: 'draft' | 'active' | 'superseded',
): Promise<void> {
  await query(
    `alter table public.membership_policy_versions
       disable trigger membership_policy_versions_guard`,
  );
  try {
    await query(
      `update public.membership_policy_versions set status = $2 where id = $1`,
      [versionId, status],
    );
  } finally {
    await query(
      `alter table public.membership_policy_versions
         enable trigger membership_policy_versions_guard`,
    );
  }
}

/** Stamp the board's approval on a draft, which activating one requires. */
async function approve(versionId: string): Promise<void> {
  await query(
    `update public.membership_policy_versions
        set approved_at = pg_catalog.now(), approved_by_label = 'fixture'
      where id = $1`,
    [versionId],
  );
}

async function makeClient(
  name: string,
  phone: string,
  branchId: string,
): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `insert into public.clients
       (full_name, sex, date_of_birth, phone, occupation, village_area, district, branch_id)
     values ($1, 'female', '1990-01-01', $2, 'Trader', 'Kalerwe', 'Kampala', $3)
     returning id`,
    [name, phone, branchId],
  );
  return row.id;
}

beforeAll(async () => {
  if (!hasDatabase) return;

  const [owner, manager] = await Promise.all([
    createTestUser('owner_admin'),
    createTestUser('manager'),
  ]);

  const home = await queryOne<{ id: string }>(
    `select id from public.branches order by branch_code limit 1`,
  );
  const other = await queryOne<{ id: string }>(
    `insert into public.branches
       (branch_code, name, location, district, status, opened_on)
     values ('BR2699', 'Hardening Branch', 'Kalerwe', 'Kampala', 'active',
             public.business_date())
     on conflict (branch_code) do update set name = excluded.name
     returning id`,
  );

  // A version that was in force and has been retired, one that never left
  // the drawer, and the one governing today.
  const supersededVersionId = await makeVersion('9.0', '2024-01-01', 'superseded');
  const draftVersionId = await makeVersion('9.1', '2030-01-01', 'draft');
  // Yesterday in the business timezone, so "in force today" is true without
  // depending on the clock inside the test. Every version this file later
  // activates takes its own day, because two versions that have left draft
  // cannot share an effective date.
  const inForceVersionId = await makeVersion('9.2', 1, 'active');

  const memberClientId = await makeClient('Hardening Member', '+256700300001', home.id);
  const freeClientId = await makeClient('Hardening Unenrolled', '+256700300002', home.id);

  const membership = await queryOne<{ id: string }>(
    `insert into public.memberships (client_id, applied_on)
     values ($1, public.business_date()) returning id`,
    [memberClientId],
  );

  fx = {
    owner,
    manager,
    memberClientId,
    membershipId: membership.id,
    freeClientId,
    inForceVersionId,
    supersededVersionId,
    draftVersionId,
    homeBranchId: home.id,
    otherBranchId: other.id,
  };
});

afterAll(async () => {
  if (!hasDatabase) return;

  await deleteTestUsers();

  // The policy versions this file wrote. Append-only by design, so clearing
  // them needs the documented owner-level exemption `deleteTestUsers` uses
  // for every other append-only table.
  await query(
    `alter table public.membership_policy_versions
       disable trigger membership_policy_versions_no_delete`,
  );
  await query(
    `alter table public.membership_policy_versions
       disable trigger audit_membership_policy_change`,
  );
  try {
    await query(`delete from public.membership_policy_versions where version like '9.%'`);
  } finally {
    await query(
      `alter table public.membership_policy_versions
         enable trigger audit_membership_policy_change`,
    );
    await query(
      `alter table public.membership_policy_versions
         enable trigger membership_policy_versions_no_delete`,
    );
  }

  await query(`delete from public.branches where branch_code = 'BR2699'`);

  await closePool();
});

// ===========================================================================
// 1. Enrolment integrity
// ===========================================================================

describeDb('a membership cannot be opened into the wrong branch', () => {
  it('refuses an explicit branch that is not the client’s', async () => {
    const result = await asUser(
      fx.manager,
      `insert into public.memberships (client_id, applied_on, branch_id)
       values ($1, public.business_date(), $2) returning id`,
      [fx.freeClientId, fx.otherBranchId],
    );

    expect(result.ok).toBe(false);
    expect(result.message ?? '').toMatch(/branch/i);
  });

  it('stamps the client’s branch when none is supplied', async () => {
    const result = await asUser(
      fx.manager,
      `insert into public.memberships (client_id, applied_on)
       values ($1, public.business_date()) returning branch_id`,
      [fx.freeClientId],
    );

    expect(result.ok).toBe(true);
    expect(result.rows[0]?.branch_id).toBe(fx.homeBranchId);
  });

  it('refuses the wrong branch for the table owner too, not only for a session', async () => {
    // The rule is about what a membership *is*, so it binds the privileged
    // path as well. A rule that only stops a session is one a leaked
    // service-role key walks straight through.
    const error = await expectError(
      `insert into public.memberships (client_id, applied_on, branch_id)
       values ($1, public.business_date(), $2)`,
      [fx.freeClientId, fx.otherBranchId],
    );

    expect(error?.message ?? '').toMatch(/branch/i);
  });

  it('refuses to move an existing membership to another branch', async () => {
    const result = await asUser(
      fx.owner,
      `update public.memberships set branch_id = $2 where id = $1`,
      [fx.membershipId, fx.otherBranchId],
    );

    expect(result.ok).toBe(false);
    expect(result.message ?? '').toMatch(/branch/i);
  });
});

describeDb('a membership cannot be opened under terms that are not in force', () => {
  it('refuses an explicit draft version', async () => {
    const result = await asUser(
      fx.manager,
      `insert into public.memberships (client_id, applied_on, policy_version_id)
       values ($1, public.business_date(), $2) returning id`,
      [fx.freeClientId, fx.draftVersionId],
    );

    expect(result.ok).toBe(false);
    expect(result.message ?? '').toMatch(/policy version/i);
  });

  it('refuses an explicit superseded version', async () => {
    const result = await asUser(
      fx.manager,
      `insert into public.memberships (client_id, applied_on, policy_version_id)
       values ($1, public.business_date(), $2) returning id`,
      [fx.freeClientId, fx.supersededVersionId],
    );

    expect(result.ok).toBe(false);
    expect(result.message ?? '').toMatch(/policy version/i);
  });

  it('refuses a version that is active but does not start until later', async () => {
    const future = await makeVersion('9.3', '2099-01-01', 'draft');
    await approve(future);
    await forceStatus(fx.inForceVersionId, 'superseded');
    await forceStatus(future, 'active');

    try {
      const result = await asUser(
        fx.manager,
        `insert into public.memberships (client_id, applied_on)
         values ($1, public.business_date()) returning id`,
        [fx.freeClientId],
      );

      expect(result.ok).toBe(false);
      expect(result.message ?? '').toMatch(/no membership policy version is in force/i);
    } finally {
      await forceStatus(future, 'superseded');
      await forceStatus(fx.inForceVersionId, 'active');
    }
  });

  it('refuses the wrong version for the table owner too', async () => {
    const error = await expectError(
      `insert into public.memberships (client_id, applied_on, policy_version_id)
       values ($1, public.business_date(), $2)`,
      [fx.freeClientId, fx.draftVersionId],
    );

    expect(error?.message ?? '').toMatch(/policy version/i);
  });

  it('stamps the version in force when none is supplied', async () => {
    const result = await asUser(
      fx.manager,
      `insert into public.memberships (client_id, applied_on)
       values ($1, public.business_date()) returning policy_version_id`,
      [fx.freeClientId],
    );

    expect(result.ok).toBe(true);
    expect(result.rows[0]?.policy_version_id).toBe(fx.inForceVersionId);
  });
});

// ===========================================================================
// 2. Policy immutability
// ===========================================================================

describeDb('a policy version that governs somebody is frozen', () => {
  it('refuses a change to a rule that was undecided at enrolment', async () => {
    // The defect this reproduces: the freeze listed only the confirmed
    // NOT NULL figures, so the nine undecided rules could be written into a
    // version members were already enrolled under — which is a retroactive
    // variation of their terms wearing the costume of "filling in a blank".
    const result = await asUser(
      fx.owner,
      `update public.membership_policy_versions
          set qualifying_months_consecutive = true
        where id = $1`,
      [fx.inForceVersionId],
    );

    expect(result.ok).toBe(false);
    expect(result.message ?? '').toMatch(/publish a new version/i);
  });

  it('refuses a change to every one of the nine, one at a time', async () => {
    for (const [column, value] of Object.entries(DECIDED)) {
      const result = await asUser(
        fx.owner,
        `update public.membership_policy_versions
            set ${column} = ${value}
          where id = $1`,
        [fx.inForceVersionId],
      );

      expect(result.ok, column).toBe(false);
    }
  });

  it('refuses a change to the title a member’s form carries', async () => {
    const result = await asUser(
      fx.owner,
      `update public.membership_policy_versions set title = 'Rewritten' where id = $1`,
      [fx.inForceVersionId],
    );

    expect(result.ok).toBe(false);
  });

  it('leaves the member’s terms exactly as they were after every refusal', async () => {
    const row = await queryOne<Record<string, unknown>>(
      `select v.title, v.registration_fee, v.qualifying_months_consecutive,
              v.interest_basis, v.medical_benefit_annual_cap
         from public.memberships m
         join public.membership_policy_versions v on v.id = m.policy_version_id
        where m.id = $1`,
      [fx.membershipId],
    );

    expect(row.title).toBe('Hardening fixture 9.2');
    expect(row.registration_fee).toBe('5000');
    expect(row.qualifying_months_consecutive).toBeNull();
    expect(row.interest_basis).toBeNull();
    expect(row.medical_benefit_annual_cap).toBeNull();
  });

  it('refuses the same change from the table owner, not only from a session', async () => {
    const error = await expectError(
      `update public.membership_policy_versions
          set profit_distribution_basis = 'equal_shares'
        where id = $1`,
      [fx.inForceVersionId],
    );

    expect(error?.message ?? '').toMatch(/publish a new version/i);
  });

  it('still allows an operational note to be corrected', async () => {
    const result = await asUser(
      fx.owner,
      `update public.membership_policy_versions
          set notes = 'Corrected after the board meeting'
        where id = $1`,
      [fx.inForceVersionId],
    );

    expect(result.ok).toBe(true);
  });
});

describeDb('a version that nobody is enrolled under is frozen once approved', () => {
  it('refuses a figure change after approval', async () => {
    const id = await makeVersion('9.4', '2027-03-01', 'draft');
    await query(
      `update public.membership_policy_versions
          set approved_at = pg_catalog.now(), approved_by_label = 'fixture'
        where id = $1`,
      [id],
    );

    const result = await asUser(
      fx.owner,
      `update public.membership_policy_versions set registration_fee = 9999 where id = $1`,
      [id],
    );

    expect(result.ok).toBe(false);
    expect(result.message ?? '').toMatch(/approved/i);
  });

  it('allows a draft to be edited freely before it is approved', async () => {
    const id = await makeVersion('9.5', '2027-04-01', 'draft');

    const result = await asUser(
      fx.owner,
      `update public.membership_policy_versions
          set registration_fee = 7500, benefit_waiting_period_days = 30
        where id = $1`,
      [id],
    );

    expect(result.ok).toBe(true);
  });
});

describeDb('a policy version moves through its statuses in one direction', () => {
  it('refuses an active version being put back into draft', async () => {
    const result = await asUser(
      fx.owner,
      `update public.membership_policy_versions set status = 'draft' where id = $1`,
      [fx.inForceVersionId],
    );

    expect(result.ok).toBe(false);
    expect(result.message ?? '').toMatch(/cannot move from active to draft/i);
  });

  it('refuses a superseded version being brought back into force', async () => {
    const result = await asUser(
      fx.owner,
      `update public.membership_policy_versions set status = 'active' where id = $1`,
      [fx.supersededVersionId],
    );

    expect(result.ok).toBe(false);
    expect(result.message ?? '').toMatch(/cannot move from superseded/i);
  });

  it('refuses a superseded version being returned to draft', async () => {
    const result = await asUser(
      fx.owner,
      `update public.membership_policy_versions set status = 'draft' where id = $1`,
      [fx.supersededVersionId],
    );

    expect(result.ok).toBe(false);
  });

  it('refuses an unapproved draft being activated', async () => {
    const id = await makeVersion('9.6', '2027-05-01', 'draft');

    const result = await asUser(
      fx.owner,
      `update public.membership_policy_versions set status = 'active' where id = $1`,
      [id],
    );

    expect(result.ok).toBe(false);
  });

  it('refuses the reversal from the table owner too', async () => {
    const error = await expectError(
      `update public.membership_policy_versions set status = 'draft' where id = $1`,
      [fx.inForceVersionId],
    );

    expect(error?.message ?? '').toMatch(/cannot move from active to draft/i);
  });
});

describeDb('moving a member onto new terms is a re-acceptance, not an update', () => {
  it('refuses a direct change of the version a member is held to', async () => {
    const result = await asUser(
      fx.owner,
      `update public.memberships set policy_version_id = $2 where id = $1`,
      [fx.membershipId, fx.supersededVersionId],
    );

    expect(result.ok).toBe(false);
  });

  it('preserves the original terms and moves governing policy only through a verified transition', async () => {
    const transitionMember = await makeBenefitMember(fx.inForceVersionId, {
      witnessProfileId: fx.manager.profileId,
    });
    // Effective today, which is after the version the member is on. Terms
    // move forward; the test below asserts the other direction is refused.
    const target = await makeVersion('9.7', 0, 'draft', [
      'qualifying_months_consecutive',
    ]);
    await query(
      `update public.membership_policy_versions
          set approved_at = pg_catalog.now(), approved_by_label = 'board minute 4/2027'
        where id = $1`,
      [target],
    );
    // In force from today, so the member can actually be moved onto it.
    await forceStatus(fx.inForceVersionId, 'superseded');
    await forceStatus(target, 'active');

    try {
      const accepted = await queryOne<{ id: string }>(
        `select public.accept_membership_policy_version(
                  $1, $2, 'witnessed_in_branch', 'Hardening Member',
                  null, $3, null, 'Kampala') as id`,
        [transitionMember.membershipId, target, fx.manager.profileId],
      );
      expect(accepted.id).toBeTruthy();

      const moved = await queryOne<{ policy_version_id: string }>(
        `select policy_version_id from public.memberships where id = $1`,
        [transitionMember.membershipId],
      );
      expect(moved.policy_version_id).toBe(fx.inForceVersionId);

      const batch = await queryOne<{ id: string }>(
        `select public.begin_membership_policy_transition(
          $1, public.business_date(), 'Verified transition regression') as id`,
        [target],
      );
      const assignment = await queryOne<{ id: string }>(
        'select public.transition_membership_to_policy($1, $2) as id',
        [batch.id, transitionMember.membershipId],
      );
      const governing = await queryOne<{ id: string }>(
        'select public.membership_governing_policy($1) as id',
        [transitionMember.membershipId],
      );
      expect(governing.id).toBe(target);
      const original = await queryOne<{ id: string }>(
        'select policy_version_id as id from public.memberships where id = $1',
        [transitionMember.membershipId],
      );
      expect(original.id).toBe(fx.inForceVersionId);

      const acceptances = await query<{ policy_version: string }>(
        `select policy_version from public.membership_terms_acceptances
          where membership_id = $1 order by accepted_at`,
        [transitionMember.membershipId],
      );
      expect(acceptances.map((row) => row.policy_version)).toContain('9.7');

      const audited = await query<{ action: string }>(
        `select action from public.audit_log
          where entity_id = $1 and action = 'membership_policy_assignments.recorded'`,
        [assignment.id],
      );
      expect(audited.length).toBe(1);
    } finally {
      await query(
        'alter table public.membership_policy_assignments disable trigger membership_policy_assignments_no_delete',
      );
      try {
        await query(
          'delete from public.membership_policy_assignments where membership_id = $1',
          [transitionMember.membershipId],
        );
      } finally {
        await query(
          'alter table public.membership_policy_assignments enable trigger membership_policy_assignments_no_delete',
        );
      }
      await query(
        'delete from public.membership_policy_transitions where to_version_id = $1',
        [target],
      );
      // The original policy was preserved throughout.
      await query(
        `alter table public.memberships disable trigger memberships_guard_transition`,
      );
      try {
        await query(
          `update public.memberships set policy_version_id = $2 where id = $1`,
          [transitionMember.membershipId, fx.inForceVersionId],
        );
      } finally {
        await query(
          `alter table public.memberships enable trigger memberships_guard_transition`,
        );
      }
      await forceStatus(target, 'superseded');
      await forceStatus(fx.inForceVersionId, 'active');
      await query(
        `alter table public.membership_terms_acceptances
           disable trigger membership_terms_acceptances_no_delete`,
      );
      try {
        await query(
          `delete from public.membership_terms_acceptances where membership_id = $1`,
          [transitionMember.membershipId],
        );
      } finally {
        await query(
          `alter table public.membership_terms_acceptances
             enable trigger membership_terms_acceptances_no_delete`,
        );
      }
    }
  });

  it('refuses a re-acceptance onto terms that took effect earlier', async () => {
    // Backdating somebody's contract, wearing the costume of an upgrade.
    const earlier = await makeVersion('9.9', 30, 'draft');
    await approve(earlier);
    await forceStatus(fx.inForceVersionId, 'superseded');
    await forceStatus(earlier, 'active');

    try {
      const error = await expectError(
        `select public.accept_membership_policy_version(
                  $1, $2, 'witnessed_in_branch', 'Hardening Member',
                  null, $3, null, null)`,
        [fx.membershipId, earlier, fx.manager.profileId],
      );

      expect(error?.message ?? '').toMatch(/took effect before/i);
    } finally {
      await forceStatus(earlier, 'superseded');
      await forceStatus(fx.inForceVersionId, 'active');
    }
  });

  it('refuses a re-acceptance onto a version that is not in force', async () => {
    const error = await expectError(
      `select public.accept_membership_policy_version(
              $1, $2, 'witnessed_in_branch', 'Hardening Member', null, $3, null, null)`,
      [fx.membershipId, fx.draftVersionId, fx.manager.profileId],
    );

    expect(error?.message ?? '').toMatch(/in force/i);
  });

  it('refuses a re-acceptance from a caller without membership:manage_policies', async () => {
    const result = await asUser(
      fx.manager,
      `select public.accept_membership_policy_version(
              $1, $2, 'witnessed_in_branch', 'Hardening Member', null, $3, null, null)`,
      [fx.membershipId, fx.inForceVersionId, fx.owner.profileId],
    );

    expect(result.ok).toBe(false);
    expect(result.message ?? '').toMatch(/manage_policies/i);
  });
});

describeDb('who may write a policy version at all', () => {
  it('refuses every write from a Manager, who holds four membership capabilities', async () => {
    // membership:view, :create, :update and :manage_status — and none of them
    // is :manage_policies. The register is theirs; the terms are not.
    const attempts = [
      [
        `update public.membership_policy_versions set notes = 'manager was here' where id = $1`,
        [fx.inForceVersionId],
      ],
      [
        `update public.membership_policy_versions set status = 'superseded' where id = $1`,
        [fx.inForceVersionId],
      ],
      [
        `update public.membership_policy_versions
            set approved_at = pg_catalog.now() where id = $1`,
        [fx.draftVersionId],
      ],
    ] as const;

    for (const [sql, params] of attempts) {
      const result = await asUser(fx.manager, sql, [...params]);
      // Either the row never opens (RLS filters it, rowCount 0) or the guard
      // raises. Both are refusals, and a test that accepted only one of them
      // would pass for the wrong reason.
      expect(result.ok ? result.rowCount : 0, sql).toBe(0);
    }
  });

  it('refuses a Manager publishing a version of their own', async () => {
    const result = await asUser(
      fx.manager,
      `insert into public.membership_policy_versions
         (version, title, effective_from, status,
          registration_fee, monthly_savings_minimum, savings_qualifying_months,
          member_loan_interest_rate_bps, member_loan_max_term_months,
          member_loan_weekly_cadence_max_months, non_member_loan_max_term_months,
          medical_benefit_rate_bps, medical_benefit_min_admission_days,
          family_condolence_benefit, member_bereavement_benefit)
       values ('9.20', 'Manager''s own terms', '2028-01-01', 'draft',
               0, 50000, 6, 500, 5, 2, 3, 500, 1, 100000, 200000)`,
    );

    expect(result.ok ? result.rowCount : 0).toBe(0);
  });

  it('refuses even the Owner publishing a version that arrives already in force', async () => {
    // The insert policy requires a draft with no approval. A version that
    // could arrive active and approved would skip the publishing act the
    // update guard attributes and timestamps.
    const result = await asUser(
      fx.owner,
      `insert into public.membership_policy_versions
         (version, title, effective_from, status, approved_at, approved_by_label,
          registration_fee, monthly_savings_minimum, savings_qualifying_months,
          member_loan_interest_rate_bps, member_loan_max_term_months,
          member_loan_weekly_cadence_max_months, non_member_loan_max_term_months,
          medical_benefit_rate_bps, medical_benefit_min_admission_days,
          family_condolence_benefit, member_bereavement_benefit)
       values ('9.21', 'Born in force', '2028-02-01', 'active',
               pg_catalog.now(), 'nobody',
               5000, 50000, 6, 500, 5, 2, 3, 500, 1, 100000, 200000)`,
    );

    expect(result.ok ? result.rowCount : 0).toBe(0);
  });

  it('lets the Owner publish a draft and correct it before approval', async () => {
    const result = await asUser(
      fx.owner,
      `insert into public.membership_policy_versions
         (version, title, effective_from, status,
          registration_fee, monthly_savings_minimum, savings_qualifying_months,
          member_loan_interest_rate_bps, member_loan_max_term_months,
          member_loan_weekly_cadence_max_months, non_member_loan_max_term_months,
          medical_benefit_rate_bps, medical_benefit_min_admission_days,
          family_condolence_benefit, member_bereavement_benefit)
       values ('9.22', 'A legitimate next version', '2028-03-01', 'draft',
               5000, 50000, 6, 500, 5, 2, 3, 500, 1, 100000, 200000)
       returning id`,
    );

    // `asUser` rolls back, so this leaves nothing behind.
    expect(result.ok).toBe(true);
    expect(result.rowCount).toBe(1);
  });

  it('refuses a Manager enrolling under a version, and a Secretary enrolling at all', async () => {
    // The Secretary/Treasurer holds membership:view and nothing else.
    const secretary = await createTestUser('secretary_treasurer');

    const result = await asUser(
      secretary,
      `insert into public.memberships (client_id, applied_on)
       values ($1, public.business_date())`,
      [fx.freeClientId],
    );

    expect(result.ok ? result.rowCount : 0).toBe(0);
  });
});

// ===========================================================================
// 3. Effective dates and the per-activity gates
// ===========================================================================

describeDb('the version in force respects the business date', () => {
  it('returns nothing while the active version has not started', async () => {
    const future = await makeVersion('9.8', '2099-06-01', 'draft');
    await approve(future);
    await forceStatus(fx.inForceVersionId, 'superseded');
    await forceStatus(future, 'active');

    try {
      const row = await queryOne<{ id: string | null }>(
        `select public.active_membership_policy_id() as id`,
      );
      expect(row.id).toBeNull();
    } finally {
      await forceStatus(future, 'superseded');
      await forceStatus(fx.inForceVersionId, 'active');
    }
  });

  it('returns the version once its effective date has arrived', async () => {
    const row = await queryOne<{ id: string | null }>(
      `select public.active_membership_policy_id() as id`,
    );
    expect(row.id).toBe(fx.inForceVersionId);
  });
});

describeDb('each activity is gated on the decisions that activity needs', () => {
  async function allows(versionId: string, activity: string): Promise<boolean> {
    const row = await queryOne<{ ok: boolean }>(
      `select public.membership_policy_allows($1, $2) as ok`,
      [versionId, activity],
    );
    return row.ok;
  }

  it('opens enrolment on an approved, effective version with every rule undecided', async () => {
    // The defect this reproduces: `is_financially_enabled` was one switch for
    // five different activities, so a registration fee could not be taken
    // because nobody had settled the year-end profit formula.
    expect(await allows(fx.inForceVersionId, 'enrolment')).toBe(true);
  });

  it('keeps savings shut until the savings rules are decided, and no longer', async () => {
    const id = await makeVersion('9.10', 3, 'draft', SAVINGS_RULES);
    await approve(id);
    await forceStatus(fx.inForceVersionId, 'superseded');
    await forceStatus(id, 'active');

    try {
      expect(await allows(fx.inForceVersionId, 'savings')).toBe(false);
      expect(await allows(id, 'savings')).toBe(true);
      // Savings do not wait on benefits or on the profit formula.
      expect(await allows(id, 'benefits')).toBe(false);
      expect(await allows(id, 'profit_sharing')).toBe(false);
    } finally {
      await forceStatus(id, 'superseded');
      await forceStatus(fx.inForceVersionId, 'active');
    }
  });

  it('keeps member lending shut until the pricing rules are decided', async () => {
    const partial = await makeVersion('9.11', '2027-09-01', 'draft', SAVINGS_RULES);
    const full = await makeVersion('9.12', 4, 'draft', [
      ...SAVINGS_RULES,
      ...LENDING_RULES,
    ]);

    expect(await allows(partial, 'lending')).toBe(false);
    expect(await allows(full, 'lending')).toBe(false); // not approved yet

    await query(
      `update public.membership_policy_versions
          set approved_at = pg_catalog.now(), approved_by_label = 'fixture'
        where id = any($1)`,
      [[partial, full]],
    );
    await forceStatus(fx.inForceVersionId, 'superseded');
    await forceStatus(full, 'active');

    try {
      expect(await allows(full, 'lending')).toBe(true);
    } finally {
      await forceStatus(full, 'superseded');
      await forceStatus(fx.inForceVersionId, 'active');
    }
  });

  it('gates benefits and profit sharing on their own rules alone', async () => {
    const benefits = await makeVersion('9.13', 5, 'draft', BENEFIT_RULES);
    const profit = await makeVersion('9.14', 6, 'draft', PROFIT_RULES);

    await query(
      `update public.membership_policy_versions
          set approved_at = pg_catalog.now(), approved_by_label = 'fixture'
        where id = any($1)`,
      [[benefits, profit]],
    );
    await forceStatus(fx.inForceVersionId, 'superseded');

    try {
      await forceStatus(benefits, 'active');
      expect(await allows(benefits, 'benefits')).toBe(true);
      expect(await allows(benefits, 'savings')).toBe(false);
      await forceStatus(benefits, 'superseded');

      await forceStatus(profit, 'active');
      expect(await allows(profit, 'profit_sharing')).toBe(true);
      expect(await allows(profit, 'benefits')).toBe(false);
      await forceStatus(profit, 'superseded');
    } finally {
      await forceStatus(fx.inForceVersionId, 'active');
    }
  });

  it('shuts every activity on a version whose effective date has not arrived', async () => {
    const future = await makeVersion('9.15', '2099-07-01', 'draft', [
      ...SAVINGS_RULES,
      ...LENDING_RULES,
      ...BENEFIT_RULES,
      ...PROFIT_RULES,
    ]);
    await approve(future);
    await forceStatus(fx.inForceVersionId, 'superseded');
    await forceStatus(future, 'active');

    try {
      for (const activity of [
        'enrolment',
        'savings',
        'lending',
        'benefits',
        'profit_sharing',
      ]) {
        expect(await allows(future, activity), activity).toBe(false);
      }
      // And the overall indicator still reports the version as complete,
      // because completeness and "in force today" are different questions.
      const row = await queryOne<{ complete: boolean }>(
        `select is_financially_enabled as complete
           from public.membership_policy_versions where id = $1`,
        [future],
      );
      expect(row.complete).toBe(true);
    } finally {
      await forceStatus(future, 'superseded');
      await forceStatus(fx.inForceVersionId, 'active');
    }
  });

  it('refuses an activity nobody has defined rather than failing quietly shut', async () => {
    const error = await expectError(
      `select public.membership_policy_allows($1, 'mobile_money')`,
      [fx.inForceVersionId],
    );

    expect(error?.message ?? '').toMatch(/mobile_money/i);
  });

  it('gives the same answer as the TypeScript gate, activity by activity', async () => {
    // Two implementations of one rule drift. This is what stops them: the
    // same row, read through the generated column, through
    // `membership_policy_allows`, and through `isActivityReady`.
    const rows = await query<Record<string, unknown> & { readonly id: string }>(
      `select id, status, approved_at,
              interest_basis, interest_method, savings_to_loan_multiplier_bps,
              qualifying_months_consecutive, savings_withdrawal_with_active_loan,
              profit_distribution_basis, medical_benefit_annual_cap,
              medical_benefit_claims_per_year, benefit_waiting_period_days,
              is_enrolment_enabled, is_savings_enabled, is_member_lending_enabled,
              is_benefits_enabled, is_profit_sharing_enabled
         from public.membership_policy_versions
        where effective_from <= public.business_date()
        order by version`,
    );

    expect(rows.length).toBeGreaterThanOrEqual(2);

    const column: Readonly<Record<MembershipActivity, string>> = {
      enrolment: 'is_enrolment_enabled',
      savings: 'is_savings_enabled',
      lending: 'is_member_lending_enabled',
      benefits: 'is_benefits_enabled',
      profit_sharing: 'is_profit_sharing_enabled',
    };

    for (const row of rows) {
      const policy = {
        status: row.status,
        approvedAt: row.approved_at ?? null,
        interestBasis: row.interest_basis,
        interestMethod: row.interest_method,
        savingsToLoanMultiplierBps: row.savings_to_loan_multiplier_bps,
        qualifyingMonthsConsecutive: row.qualifying_months_consecutive,
        savingsWithdrawalWithActiveLoan: row.savings_withdrawal_with_active_loan,
        profitDistributionBasis: row.profit_distribution_basis,
        medicalBenefitAnnualCap:
          row.medical_benefit_annual_cap === null
            ? null
            : Number(row.medical_benefit_annual_cap),
        medicalBenefitClaimsPerYear: row.medical_benefit_claims_per_year,
        benefitWaitingPeriodDays: row.benefit_waiting_period_days,
      } as PolicyDecisionState;

      for (const activity of MEMBERSHIP_ACTIVITIES) {
        const label = `${row.id} ${activity}`;
        const expected = isActivityReady(policy, activity);

        expect(row[column[activity]], label).toBe(expected);
        expect(await allows(row.id, activity), label).toBe(expected);
      }
    }
  });

  it('refuses a write to any of the readiness columns', async () => {
    for (const column of [
      'is_enrolment_enabled',
      'is_savings_enabled',
      'is_member_lending_enabled',
      'is_benefits_enabled',
      'is_profit_sharing_enabled',
      'is_financially_enabled',
    ]) {
      const error = await expectError(
        `update public.membership_policy_versions set ${column} = true where id = $1`,
        [fx.inForceVersionId],
      );

      expect(error, column).not.toBeNull();
    }
  });
});
