import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  asUser,
  asUserCommitted,
  createTestUser,
  deleteTestUsers,
  type TestUser,
} from '../helpers/auth-fixtures';
import {
  attachVerifiedDocument,
  clearEvidenceBucket,
  makeBenefitMember,
  makeVerifiedBeneficiary,
  requiredKindsFor,
  type BenefitMember,
} from '../helpers/benefits';
import { closePool, hasDatabase, query, queryOne, skipReason } from '../helpers/db';
import { forcePolicyStatus, publishTestPolicy } from '../helpers/membership';

/**
 * Benefit payments, the journals behind them, and the invariants the rest of
 * the books depend on.
 *
 * ## What these are really testing
 *
 * A benefit payment is the only thing in Phase 4 that moves money, so it is
 * the only thing in Phase 4 that can break the General Ledger. The tests fall
 * into three groups:
 *
 *   1. **the posting is right** — the correct expense account for the claim
 *      type, the correct cash account for the method, a balanced entry, and
 *      the recipient taken from the authorisation rather than from the live
 *      beneficiary record;
 *   2. **it happens once** — idempotent on the key, refused twice by state and
 *      by index, and reversed rather than deleted;
 *   3. **it touches nothing else** — not `2100 Member Savings`, not a loan's
 *      principal, not a savings pledge, not a revenue account.
 *
 * The third group is the one that matters most and the one a reviewer would
 * not think to ask for. A benefit that quietly debited the savings liability
 * would look right on every screen and would be paying members out of their
 * own deposits.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('benefit accounting suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

interface Fixtures {
  owner: TestUser;
  manager: TestUser;
  approver: TestUser;
  secretary: TestUser;
  borrower: TestUser;
  policyId: string;
  nextMember: () => Promise<BenefitMember>;
}

let fx: Fixtures;

const ADMISSION = { in: '2025-03-10 09:00+03', out: '2025-03-14 11:00+03' } as const;

/** A claim driven all the way to `approved`, ready to pay. */
async function approvedMedicalClaim(
  bill: number,
  provider: string,
): Promise<{
  readonly claimId: string;
  readonly member: BenefitMember;
  readonly amount: number;
}> {
  const member = await fx.nextMember();

  const opened = await asUserCommitted(fx.secretary, [
    {
      sql: `select public.open_benefit_claim(
                     $1, 'medical', null, $2, $3::timestamptz, $4::timestamptz,
                     $5::bigint, null, null, null) as id`,
      params: [member.membershipId, provider, ADMISSION.in, ADMISSION.out, bill],
    },
  ]);

  const claimId = (opened.rows[0] as { id: string }).id;

  await asUserCommitted(fx.secretary, [
    { sql: `select public.submit_benefit_claim($1) as id`, params: [claimId] },
  ]);

  for (const kind of await requiredKindsFor('medical')) {
    await attachVerifiedDocument(
      claimId,
      member.membershipId,
      kind,
      fx.secretary,
      fx.manager,
    );
  }

  const assessed = await asUserCommitted(fx.manager, [
    {
      sql: `select public.assess_benefit_claim($1, 'Invoice agrees with the record.') as amount`,
      params: [claimId],
    },
  ]);
  if (!assessed.ok) throw new Error(`could not assess: ${assessed.message}`);

  const approved = await asUserCommitted(fx.approver, [
    {
      sql: `select public.approve_benefit_claim($1, null, 'Agreed.') as amount`,
      params: [claimId],
    },
  ]);
  if (!approved.ok) throw new Error(`could not approve: ${approved.message}`);

  return {
    claimId,
    member,
    amount: Number((approved.rows[0] as { amount: string }).amount),
  };
}

/** An approved bereavement claim, with a verified payee frozen into it. */
async function approvedBereavementClaim(payeeName: string): Promise<{
  readonly claimId: string;
  readonly member: BenefitMember;
  readonly beneficiaryId: string;
}> {
  const member = await fx.nextMember();
  const beneficiaryId = await makeVerifiedBeneficiary(
    member.membershipId,
    fx.secretary,
    fx.manager,
    { fullName: payeeName },
  );

  const opened = await asUserCommitted(fx.secretary, [
    {
      sql: `select public.open_benefit_claim(
                     $1, 'member_bereavement', '2025-05-01'::date,
                     null, null, null, null, 'The Deceased Member', null, $2) as id`,
      params: [member.membershipId, beneficiaryId],
    },
  ]);

  const claimId = (opened.rows[0] as { id: string }).id;

  await asUserCommitted(fx.secretary, [
    { sql: `select public.submit_benefit_claim($1) as id`, params: [claimId] },
  ]);

  for (const kind of await requiredKindsFor('member_bereavement')) {
    await attachVerifiedDocument(
      claimId,
      member.membershipId,
      kind,
      fx.secretary,
      fx.manager,
    );
  }

  const assessed = await asUserCommitted(fx.manager, [
    { sql: `select public.assess_benefit_claim($1, null) as amount`, params: [claimId] },
  ]);
  if (!assessed.ok) throw new Error(`could not assess: ${assessed.message}`);

  const approved = await asUserCommitted(fx.approver, [
    {
      sql: `select public.approve_benefit_claim($1, null, null) as amount`,
      params: [claimId],
    },
  ]);
  if (!approved.ok) throw new Error(`could not approve: ${approved.message}`);

  return { claimId, member, beneficiaryId };
}

async function accountBalance(code: string): Promise<number> {
  const row = await queryOne<{ net: string }>(
    `select coalesce(sum(l.debit) - sum(l.credit), 0)::text as net
       from public.journal_lines l
       join public.ledger_accounts a on a.id = l.account_id
      where a.code = $1`,
    [code],
  );
  return Number(row.net);
}

beforeAll(async () => {
  if (!hasDatabase) return;

  const [owner, manager, approver, secretary, borrower] = await Promise.all([
    createTestUser('owner_admin'),
    createTestUser('manager'),
    createTestUser('manager'),
    createTestUser('secretary_treasurer'),
    createTestUser('client'),
  ]);

  await query(
    `insert into public.user_roles (profile_id, role_key) values ($1, 'owner_admin')
     on conflict do nothing`,
    [approver.profileId],
  );

  const policyId = await publishTestPolicy({
    version: '42.0',
    // Its own effective day. `membership_policy_versions_effective_from_unique`
    // and `..._one_active` between them mean every suite needs a distinct
    // date, and the suites run sequentially in one database.
    effectiveDaysAgo: 899,
    qualifyingMonthsConsecutive: false,
    withdrawalRule: 'allowed',
    // TEST ONLY: the client has decided none of these four.
    medicalAnnualCap: 5_000_000,
    medicalClaimsPerYear: 12,
    benefitWaitingPeriodDays: 0,
    medicalYearBasis: 'calendar_year',
  });

  fx = {
    owner,
    manager,
    approver,
    secretary,
    borrower,
    policyId,
    nextMember: () => makeBenefitMember(policyId, { activatedOn: '2024-06-01' }),
  };
});

afterAll(async () => {
  if (!hasDatabase) return;

  await clearEvidenceBucket();
  await deleteTestUsers();
  await forcePolicyStatus(fx.policyId, 'superseded');
  await closePool();
});

describeDb('the posting', () => {
  it('debits 5210 and credits the branch cash account', async () => {
    // The claim is driven to `approved` **before** the balances are read.
    // Enrolling the member posts a UGX 5,000 registration fee, which is a
    // real journal into cash and income — so a snapshot taken earlier would
    // measure the fixture as well as the payment.
    const { claimId, amount } = await approvedMedicalClaim(400_000, 'Mulago Hospital');

    const before = {
      medical: await accountBalance('5210'),
      cash: await accountBalance('1010-BR2601'),
    };

    const paid = await asUserCommitted(fx.manager, [
      {
        sql: `select public.post_benefit_payment($1, 'cash', null, gen_random_uuid()) as id`,
        params: [claimId],
      },
    ]);

    expect(paid.message ?? 'ok').toBe('ok');
    expect(amount).toBe(20_000);

    expect(await accountBalance('5210')).toBe(before.medical + 20_000);
    // A credit to a debit-normal asset account reduces it: the money left.
    expect(await accountBalance('1010-BR2601')).toBe(before.cash - 20_000);
  });

  it('debits 5220 for a condolence benefit and 5230 for a bereavement one', async () => {
    const before = {
      condolence: await accountBalance('5220'),
      bereavement: await accountBalance('5230'),
    };

    // Condolence, which needs an eligible relationship — the fixture decides
    // for this test only, because the migration leaves every row NULL.
    await query(
      `update public.beneficiary_relationships
          set condolence_eligible = true where key = 'parent'`,
    );

    try {
      const member = await fx.nextMember();
      const opened = await asUserCommitted(fx.secretary, [
        {
          sql: `select public.open_benefit_claim(
                         $1, 'family_condolence', '2025-04-02'::date,
                         null, null, null, null, 'Grace Akello', 'parent', null) as id`,
          params: [member.membershipId],
        },
      ]);
      const condolenceClaim = (opened.rows[0] as { id: string }).id;

      await asUserCommitted(fx.secretary, [
        {
          sql: `select public.submit_benefit_claim($1) as id`,
          params: [condolenceClaim],
        },
      ]);
      for (const kind of await requiredKindsFor('family_condolence')) {
        await attachVerifiedDocument(
          condolenceClaim,
          member.membershipId,
          kind,
          fx.secretary,
          fx.manager,
        );
      }
      await asUserCommitted(fx.manager, [
        {
          sql: `select public.assess_benefit_claim($1, null) as amount`,
          params: [condolenceClaim],
        },
      ]);
      await asUserCommitted(fx.approver, [
        {
          sql: `select public.approve_benefit_claim($1, null, null) as amount`,
          params: [condolenceClaim],
        },
      ]);
      await asUserCommitted(fx.manager, [
        {
          sql: `select public.post_benefit_payment(
                         $1, 'mtn_mobile_money', 'MTN-REF-0001',
                         gen_random_uuid()) as id`,
          params: [condolenceClaim],
        },
      ]);
    } finally {
      await query(
        `update public.beneficiary_relationships
            set condolence_eligible = null where key = 'parent'`,
      );
    }

    const bereavement = await approvedBereavementClaim('Paid To Next Of Kin');
    await asUserCommitted(fx.manager, [
      {
        sql: `select public.post_benefit_payment($1, 'cash', null, gen_random_uuid()) as id`,
        params: [bereavement.claimId],
      },
    ]);

    expect(await accountBalance('5220')).toBe(before.condolence + 100_000);
    expect(await accountBalance('5230')).toBe(before.bereavement + 200_000);
  });

  it('posts one balanced entry with the right source type', async () => {
    const { claimId } = await approvedMedicalClaim(600_000, 'Nsambya Hospital');

    await asUserCommitted(fx.manager, [
      {
        sql: `select public.post_benefit_payment($1, 'cash', null, gen_random_uuid()) as id`,
        params: [claimId],
      },
    ]);

    const entry = await queryOne<{
      source_type: string;
      debits: string;
      credits: string;
      lines: string;
      loan_id: string | null;
    }>(
      `select e.source_type, e.loan_id,
              sum(l.debit)::text as debits, sum(l.credit)::text as credits,
              count(*)::text as lines
         from public.benefit_payments p
         join public.journal_entries e on e.id = p.journal_entry_id
         join public.journal_lines l on l.entry_id = e.id
        where p.claim_id = $1
        group by e.source_type, e.loan_id`,
      [claimId],
    );

    expect(entry.source_type).toBe('benefit_payment');
    expect(entry.lines).toBe('2');
    expect(entry.debits).toBe(entry.credits);
    // Never attached to a loan: a benefit is not a loan event, and attaching
    // one would put it on the loan's own ledger view.
    expect(entry.loan_id).toBeNull();
  });

  it('takes the recipient from the authorisation, not the live record', async () => {
    const { claimId, member, beneficiaryId } =
      await approvedBereavementClaim('The Approved Payee');

    // A beneficiary change is refused while a bereavement claim is live — that
    // is tested in `beneficiaries.test.ts`. This test proves the second belt:
    // even if the live record were somehow different, the payment reads the
    // snapshot. So the snapshot is read directly and compared with what was
    // paid.
    const snapshot = await queryOne<{ beneficiary_name: string }>(
      `select beneficiary_name from public.benefit_assessment_snapshots
        where claim_id = $1`,
      [claimId],
    );

    await asUserCommitted(fx.manager, [
      {
        sql: `select public.post_benefit_payment($1, 'cash', null, gen_random_uuid()) as id`,
        params: [claimId],
      },
    ]);

    const payment = await queryOne<{
      recipient_kind: string;
      recipient_name: string;
      recipient_beneficiary_id: string;
    }>(
      `select recipient_kind, recipient_name, recipient_beneficiary_id
         from public.benefit_payments where claim_id = $1`,
      [claimId],
    );

    expect(payment.recipient_kind).toBe('beneficiary');
    expect(payment.recipient_name).toBe(snapshot.beneficiary_name);
    expect(payment.recipient_name).toBe('The Approved Payee');
    expect(payment.recipient_beneficiary_id).toBe(beneficiaryId);
    expect(member.membershipId).toBeTruthy();
  });

  it('pays a medical benefit to the member, not to a beneficiary', async () => {
    const { claimId, member } = await approvedMedicalClaim(300_000, 'Case Medcare');

    await asUserCommitted(fx.manager, [
      {
        sql: `select public.post_benefit_payment($1, 'cash', null, gen_random_uuid()) as id`,
        params: [claimId],
      },
    ]);

    const payment = await queryOne<{
      recipient_kind: string;
      recipient_name: string;
      recipient_beneficiary_id: string | null;
    }>(
      `select recipient_kind, recipient_name, recipient_beneficiary_id
         from public.benefit_payments where claim_id = $1`,
      [claimId],
    );

    const client = await queryOne<{ full_name: string }>(
      `select full_name from public.clients where id = $1`,
      [member.clientId],
    );

    expect(payment.recipient_kind).toBe('member');
    expect(payment.recipient_name).toBe(client.full_name);
    expect(payment.recipient_beneficiary_id).toBeNull();
  });

  it('requires a network reference for mobile money and refuses one for cash', async () => {
    const first = await approvedMedicalClaim(100_000, 'Reference Test A');
    const unreferenced = await asUserCommitted(fx.manager, [
      {
        sql: `select public.post_benefit_payment(
                       $1, 'mtn_mobile_money', null, gen_random_uuid()) as id`,
        params: [first.claimId],
      },
    ]);
    expect(unreferenced.ok).toBe(false);
    expect(unreferenced.message).toContain('needs the reference');

    const second = await approvedMedicalClaim(100_000, 'Reference Test B');
    const overReferenced = await asUserCommitted(fx.manager, [
      {
        sql: `select public.post_benefit_payment(
                       $1, 'cash', 'SHOULD-NOT-BE-HERE', gen_random_uuid()) as id`,
        params: [second.claimId],
      },
    ]);
    expect(overReferenced.ok).toBe(false);
    expect(overReferenced.message).toContain('no network reference');
  });
});

describeDb('paying once', () => {
  it('returns the first payment on a replayed key', async () => {
    const { claimId } = await approvedMedicalClaim(400_000, 'Replay Hospital');

    const key = (await queryOne<{ key: string }>(`select gen_random_uuid()::text as key`))
      .key;

    const first = await asUserCommitted(fx.manager, [
      {
        sql: `select public.post_benefit_payment($1, 'cash', null, $2::uuid) as id`,
        params: [claimId, key],
      },
    ]);
    const second = await asUserCommitted(fx.manager, [
      {
        sql: `select public.post_benefit_payment($1, 'cash', null, $2::uuid) as id`,
        params: [claimId, key],
      },
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect((second.rows[0] as { id: string }).id).toBe(
      (first.rows[0] as { id: string }).id,
    );

    // And one journal entry, not two. A network retry must not pay a benefit
    // twice, and the proof is in the ledger rather than in the return value.
    const entries = await query<{ id: string }>(
      `select e.id from public.journal_entries e
        where e.source_type = 'benefit_payment'
          and e.source_id = (select id from public.benefit_payments
                              where claim_id = $1)`,
      [claimId],
    );
    expect(entries).toHaveLength(1);
  });

  it('refuses a second payment under a different key', async () => {
    const { claimId } = await approvedMedicalClaim(400_000, 'Double Pay Hospital');

    const first = await asUserCommitted(fx.manager, [
      {
        sql: `select public.post_benefit_payment($1, 'cash', null, gen_random_uuid()) as id`,
        params: [claimId],
      },
    ]);
    expect(first.ok).toBe(true);

    const second = await asUserCommitted(fx.manager, [
      {
        sql: `select public.post_benefit_payment($1, 'cash', null, gen_random_uuid()) as id`,
        params: [claimId],
      },
    ]);

    // By state: the claim is `paid`, and only an approved claim is paid.
    expect(second.ok).toBe(false);
    expect(second.message).toContain('Only an approved claim is paid');
  });

  it('refuses a payment on an unapproved claim', async () => {
    const member = await fx.nextMember();
    const opened = await asUserCommitted(fx.secretary, [
      {
        sql: `select public.open_benefit_claim(
                       $1, 'medical', null, 'Unapproved Hospital',
                       $2::timestamptz, $3::timestamptz, 400000,
                       null, null, null) as id`,
        params: [member.membershipId, ADMISSION.in, ADMISSION.out],
      },
    ]);

    const paid = await asUserCommitted(fx.manager, [
      {
        sql: `select public.post_benefit_payment($1, 'cash', null, gen_random_uuid()) as id`,
        params: [(opened.rows[0] as { id: string }).id],
      },
    ]);

    expect(paid.ok).toBe(false);
    expect(paid.message).toContain('Only an approved claim is paid');
  });

  it('refuses a payment from a caller without benefits:pay', async () => {
    const { claimId } = await approvedMedicalClaim(400_000, 'Unauthorised Hospital');

    const attempt = await asUser(
      fx.secretary,
      `select public.post_benefit_payment($1, 'cash', null, gen_random_uuid()) as id`,
      [claimId],
    );

    expect(attempt.ok).toBe(false);
    expect(attempt.message).toContain('benefits:pay');
  });

  it('refuses a replayed key to a caller who holds no capability', async () => {
    // ADR-056: the capability check sits above the replay shortcut, because
    // the early return reads a payment record. Otherwise a caller with no
    // capability could replay somebody else's key and read back a payment
    // they are not entitled to.
    const { claimId } = await approvedMedicalClaim(400_000, 'Replay Probe Hospital');
    const key = (await queryOne<{ key: string }>(`select gen_random_uuid()::text as key`))
      .key;

    await asUserCommitted(fx.manager, [
      {
        sql: `select public.post_benefit_payment($1, 'cash', null, $2::uuid) as id`,
        params: [claimId, key],
      },
    ]);

    const replayed = await asUser(
      fx.borrower,
      `select public.post_benefit_payment($1, 'cash', null, $2::uuid) as id`,
      [claimId, key],
    );

    expect(replayed.ok).toBe(false);
    expect(replayed.message).toContain('benefits:pay');
  });

  it('never edits or deletes a payment', async () => {
    const { claimId } = await approvedMedicalClaim(400_000, 'Immutable Hospital');
    await asUserCommitted(fx.manager, [
      {
        sql: `select public.post_benefit_payment($1, 'cash', null, gen_random_uuid()) as id`,
        params: [claimId],
      },
    ]);

    const payment = await queryOne<{ id: string }>(
      `select id from public.benefit_payments where claim_id = $1`,
      [claimId],
    );

    await expect(
      query(`update public.benefit_payments set amount = 1 where id = $1`, [payment.id]),
    ).rejects.toThrow(/receipt and does not change/);

    await expect(
      query(`delete from public.benefit_payments where id = $1`, [payment.id]),
    ).rejects.toThrow();
  });
});

describeDb('reversal', () => {
  it('posts the contra entry, keeps the original, and links the pair', async () => {
    const { claimId } = await approvedMedicalClaim(400_000, 'Reversal Hospital');

    // After the enrolment fee, before the payment: see the first posting test.
    const before = {
      medical: await accountBalance('5210'),
      cash: await accountBalance('1010-BR2601'),
    };

    await asUserCommitted(fx.manager, [
      {
        sql: `select public.post_benefit_payment($1, 'cash', null, gen_random_uuid()) as id`,
        params: [claimId],
      },
    ]);

    const payment = await queryOne<{ id: string; journal_entry_id: string }>(
      `select id, journal_entry_id from public.benefit_payments where claim_id = $1`,
      [claimId],
    );

    const reversed = await asUserCommitted(fx.owner, [
      {
        sql: `select public.reverse_benefit_payment(
                       $1, 'The invoice was for a different patient.') as entry_id`,
        params: [payment.id],
      },
    ]);

    expect(reversed.message ?? 'ok').toBe('ok');

    // Back where it started. Two entries, not an edited one.
    expect(await accountBalance('5210')).toBe(before.medical);
    expect(await accountBalance('1010-BR2601')).toBe(before.cash);

    const row = await queryOne<{
      reversed_at: string;
      reversal_reason: string;
      reversed_by_label: string;
      reversal_journal_entry_id: string;
      claim_status: string;
      original_points_at: string;
      reversal_source: string;
    }>(
      `select p.reversed_at::text, p.reversal_reason, p.reversed_by_label,
              p.reversal_journal_entry_id, c.status as claim_status,
              original.reversed_by_entry_id as original_points_at,
              contra.source_type as reversal_source
         from public.benefit_payments p
         join public.benefit_claims c on c.id = p.claim_id
         join public.journal_entries original on original.id = p.journal_entry_id
         join public.journal_entries contra
           on contra.id = p.reversal_journal_entry_id
        where p.id = $1`,
      [payment.id],
    );

    expect(row.reversal_reason).toContain('different patient');
    expect(row.claim_status).toBe('reversed');
    // The pair, linked both ways.
    expect(row.original_points_at).toBe(row.reversal_journal_entry_id);
    expect(row.reversal_source).toBe('benefit_payment_reversal');
  });

  it('does not reopen the claim, and does not let it be paid again', async () => {
    const { claimId } = await approvedMedicalClaim(400_000, 'No Reopen Hospital');
    await asUserCommitted(fx.manager, [
      {
        sql: `select public.post_benefit_payment($1, 'cash', null, gen_random_uuid()) as id`,
        params: [claimId],
      },
    ]);

    const payment = await queryOne<{ id: string }>(
      `select id from public.benefit_payments where claim_id = $1`,
      [claimId],
    );

    await asUserCommitted(fx.owner, [
      {
        sql: `select public.reverse_benefit_payment($1, 'Paid in error.') as entry_id`,
        params: [payment.id],
      },
    ]);

    // `reversed` is terminal: there is no edge back to `approved`, so an
    // erroneous reversal cannot make a paid claim payable a second time.
    await expect(
      query(`update public.benefit_claims set status = 'approved' where id = $1`, [
        claimId,
      ]),
    ).rejects.toThrow(/cannot go from reversed to approved/);

    const paid = await asUserCommitted(fx.manager, [
      {
        sql: `select public.post_benefit_payment($1, 'cash', null, gen_random_uuid()) as id`,
        params: [claimId],
      },
    ]);
    expect(paid.ok).toBe(false);
  });

  it('releases the annual cap, because the money came back', async () => {
    const member = await fx.nextMember();

    const open = async (provider: string, admission: string, discharge: string) => {
      const opened = await asUserCommitted(fx.secretary, [
        {
          sql: `select public.open_benefit_claim(
                         $1, 'medical', null, $2, $3::timestamptz, $4::timestamptz,
                         90000000, null, null, null) as id`,
          params: [member.membershipId, provider, admission, discharge],
        },
      ]);
      const id = (opened.rows[0] as { id: string }).id;
      await asUserCommitted(fx.secretary, [
        { sql: `select public.submit_benefit_claim($1) as id`, params: [id] },
      ]);
      for (const kind of await requiredKindsFor('medical')) {
        await attachVerifiedDocument(
          id,
          member.membershipId,
          kind,
          fx.secretary,
          fx.manager,
        );
      }
      return id;
    };

    // 5% of 90,000,000 is 4,500,000, inside the 5,000,000 cap. A second
    // identical claim would take the year to 9,000,000 and be refused.
    const first = await open(
      'Cap Hospital A',
      '2025-02-03 08:00+03',
      '2025-02-08 09:00+03',
    );
    await asUserCommitted(fx.manager, [
      { sql: `select public.assess_benefit_claim($1, null) as amount`, params: [first] },
    ]);
    await asUserCommitted(fx.approver, [
      {
        sql: `select public.approve_benefit_claim($1, null, null) as amount`,
        params: [first],
      },
    ]);
    await asUserCommitted(fx.manager, [
      {
        sql: `select public.post_benefit_payment($1, 'cash', null, gen_random_uuid()) as id`,
        params: [first],
      },
    ]);

    const second = await open(
      'Cap Hospital B',
      '2025-04-03 08:00+03',
      '2025-04-08 09:00+03',
    );
    const blocked = await asUserCommitted(fx.manager, [
      { sql: `select public.assess_benefit_claim($1, null) as amount`, params: [second] },
    ]);
    expect(blocked.ok).toBe(false);
    expect(blocked.message).toContain('medical_cap_exceeded');

    // Reverse the first. The money came back, so the capacity did.
    const payment = await queryOne<{ id: string }>(
      `select id from public.benefit_payments where claim_id = $1`,
      [first],
    );
    await asUserCommitted(fx.owner, [
      {
        sql: `select public.reverse_benefit_payment($1, 'Duplicate invoice.') as entry_id`,
        params: [payment.id],
      },
    ]);

    const nowAllowed = await asUserCommitted(fx.manager, [
      { sql: `select public.assess_benefit_claim($1, null) as amount`, params: [second] },
    ]);
    expect(nowAllowed.message ?? 'ok').toBe('ok');
  });

  it('refuses a reversal from anybody but the Owner', async () => {
    const { claimId } = await approvedMedicalClaim(400_000, 'Reversal Authority');
    await asUserCommitted(fx.manager, [
      {
        sql: `select public.post_benefit_payment($1, 'cash', null, gen_random_uuid()) as id`,
        params: [claimId],
      },
    ]);

    const payment = await queryOne<{ id: string }>(
      `select id from public.benefit_payments where claim_id = $1`,
      [claimId],
    );

    const attempt = await asUser(
      fx.manager,
      `select public.reverse_benefit_payment($1, 'I changed my mind.') as entry_id`,
      [payment.id],
    );

    expect(attempt.ok).toBe(false);
    expect(attempt.message).toContain('savings:reverse');
  });

  it('refuses a reversal with no reason, and a second reversal', async () => {
    const { claimId } = await approvedMedicalClaim(400_000, 'One Reversal Only');
    await asUserCommitted(fx.manager, [
      {
        sql: `select public.post_benefit_payment($1, 'cash', null, gen_random_uuid()) as id`,
        params: [claimId],
      },
    ]);

    const payment = await queryOne<{ id: string }>(
      `select id from public.benefit_payments where claim_id = $1`,
      [claimId],
    );

    const silent = await asUserCommitted(fx.owner, [
      {
        sql: `select public.reverse_benefit_payment($1, '  ') as entry_id`,
        params: [payment.id],
      },
    ]);
    expect(silent.ok).toBe(false);
    expect(silent.message).toContain('needs a reason');

    await asUserCommitted(fx.owner, [
      {
        sql: `select public.reverse_benefit_payment($1, 'Paid in error.') as entry_id`,
        params: [payment.id],
      },
    ]);

    const again = await asUserCommitted(fx.owner, [
      {
        sql: `select public.reverse_benefit_payment($1, 'Again.') as entry_id`,
        params: [payment.id],
      },
    ]);
    expect(again.ok).toBe(false);
    expect(again.message).toContain('already reversed');
  });
});

describeDb('what a benefit must never touch', () => {
  it('does not move the savings liability, a loan balance or a pledge', async () => {
    // Both claims are driven to `approved` first, so the balances below
    // measure the two *payments* and not the two enrolment fees that come
    // with creating two members.
    const { claimId } = await approvedMedicalClaim(400_000, 'Invariant Hospital');
    const bereavement = await approvedBereavementClaim('Invariant Payee');

    const before = {
      savings: await accountBalance('2100'),
      receivable: await accountBalance('1200'),
      interestIncome: await accountBalance('4100'),
      registrationIncome: await accountBalance('4340'),
    };

    const loansBefore = await query<{ loan_id: string; principal_remaining: string }>(
      `select loan_id, principal_remaining::text from public.loan_balances
        order by loan_id`,
    );
    const pledgesBefore = await query<{ loan_id: string; pledged_amount: string }>(
      `select loan_id, pledged_amount::text from public.member_loan_savings_pledges
        where released_at is null order by loan_id`,
    );

    await asUserCommitted(fx.manager, [
      {
        sql: `select public.post_benefit_payment($1, 'cash', null, gen_random_uuid()) as id`,
        params: [claimId],
      },
    ]);

    await asUserCommitted(fx.manager, [
      {
        sql: `select public.post_benefit_payment($1, 'cash', null, gen_random_uuid()) as id`,
        params: [bereavement.claimId],
      },
    ]);

    // The one that matters most. A benefit that quietly debited 2100 would
    // look right on every screen and would be paying members out of their own
    // deposits.
    expect(await accountBalance('2100')).toBe(before.savings);
    // Not a loan disbursement: no receivable is created.
    expect(await accountBalance('1200')).toBe(before.receivable);
    // Not income of any kind.
    expect(await accountBalance('4100')).toBe(before.interestIncome);
    expect(await accountBalance('4340')).toBe(before.registrationIncome);

    const loansAfter = await query<{ loan_id: string; principal_remaining: string }>(
      `select loan_id, principal_remaining::text from public.loan_balances
        order by loan_id`,
    );
    expect(loansAfter).toEqual(loansBefore);

    const pledgesAfter = await query<{ loan_id: string; pledged_amount: string }>(
      `select loan_id, pledged_amount::text from public.member_loan_savings_pledges
        where released_at is null order by loan_id`,
    );
    expect(pledgesAfter).toEqual(pledgesBefore);
  });

  it('leaves every journal balanced', async () => {
    const { claimId } = await approvedMedicalClaim(400_000, 'Trial Balance Hospital');
    await asUserCommitted(fx.manager, [
      {
        sql: `select public.post_benefit_payment($1, 'cash', null, gen_random_uuid()) as id`,
        params: [claimId],
      },
    ]);

    const unbalanced = await query<{ id: string }>(
      `select e.id
         from public.journal_entries e
         join public.journal_lines l on l.entry_id = e.id
        group by e.id
       having sum(l.debit) <> sum(l.credit)`,
    );

    expect(unbalanced).toEqual([]);

    const trial = await queryOne<{ net: string }>(
      `select (sum(debit) - sum(credit))::text as net from public.journal_lines`,
    );
    expect(Number(trial.net)).toBe(0);
  });

  it('reports the same figure from the ledger as from the claim table', async () => {
    const { claimId } = await approvedMedicalClaim(800_000, 'Reconciliation Hospital');
    await asUserCommitted(fx.manager, [
      {
        sql: `select public.post_benefit_payment($1, 'cash', null, gen_random_uuid()) as id`,
        params: [claimId],
      },
    ]);

    // `benefit_expense_by_type` reads the General Ledger, and the dashboard
    // reads the payments. They must agree, and a report that read one source
    // for both could not tell anybody when they did not.
    const fromLedger = await asUser(
      fx.owner,
      `select sum(net_expense)::text as net
         from public.benefit_expense_by_type('2000-01-01'::date, '2100-01-01'::date)`,
    );

    const fromPayments = await queryOne<{ net: string }>(
      `select coalesce(sum(amount), 0)::text as net
         from public.benefit_payments where reversed_at is null`,
    );

    expect((fromLedger.rows[0] as { net: string }).net).toBe(fromPayments.net);
  });
});
