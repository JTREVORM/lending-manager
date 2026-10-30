import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { closePool, hasDatabase, query, queryOne, skipReason } from '../helpers/db';
import {
  BENEFIT_ENABLE_PHRASE,
  BENEFIT_POLICY_VERSION,
  DEMO_CONDOLENCE_ELIGIBLE,
  DEMO_MEDICAL_ANNUAL_CAP,
  DEMO_MEDICAL_CLAIMS_PER_YEAR,
  DEMO_WAITING_PERIOD_DAYS,
  DEMO_YEAR_BASIS,
  benefitDemoRequested,
} from '../../scripts/demo-benefits';
import { MEMBER_LOAN_ENABLE_PHRASE } from '../../scripts/demo-member-loans';

/**
 * The benefit demonstration seeder, run for real.
 *
 * ## What is actually at stake
 *
 * This seeder writes **money out of the business** — three benefit payments
 * and a reversal — against synthetic claims, synthetic approvals and
 * synthetic evidence. Every one of those is a thing §1 of the brief says must
 * never be mistakable for a management decision, and the seeder's safeguards
 * are what keep it that way. So the properties worth proving are not that the
 * demonstration appears; they are:
 *
 *   1. it is gated by a phrase of its own, and nothing else turns it on;
 *   2. it refuses a hosted database outright and writes nothing;
 *   3. it refuses to run beside the member-loan demonstration;
 *   4. everything it writes says DEMONSTRATION or TEST ONLY in a column a
 *      reader sees;
 *   5. the benefit payments and the General Ledger agree, to the shilling;
 *   6. running it again changes nothing — the second and third runs are a
 *      fixed point, and neither posts a shilling.
 *
 * ## Why this is its own vitest project
 *
 * The same reason the member-loan demonstration has one: in this mode the
 * seeder publishes policy version 997.0 **as the only version in force**,
 * because a savings account is frozen to the version it was opened under and
 * a second published version would supersede the first and silently
 * un-qualify every account opened under it. Every membership suite in the
 * `db` project publishes its own version, `seed` publishes 999.0 and
 * `seed-member-loans` publishes 998.0, so this needs a rebuild nobody else
 * has written to.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('benefit demo seed suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

const run = promisify(execFile);
const ENABLE_PHRASE = 'yes-seed-polytos-demo-data';

interface SeedResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function seed(env: Record<string, string | undefined> = {}): Promise<SeedResult> {
  try {
    const { stdout, stderr } = await run('npx', ['tsx', 'scripts/seed-demo.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        POLYTOS_SEED_DEMO: ENABLE_PHRASE,
        POLYTOS_SEED_BENEFITS: BENEFIT_ENABLE_PHRASE,
        ...env,
      },
      timeout: 240_000,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: failure.code ?? 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

/**
 * Everything the benefit demonstration wrote, as one comparable row.
 *
 * Read as text so no numeric type rounds a comparison into agreement, and
 * aggregated by `string_agg` where the *set* matters rather than the count —
 * a count can stay still while two claims swap statuses.
 */
async function benefitState(): Promise<Record<string, string | null>> {
  return queryOne<Record<string, string | null>>(
    `select
       (select count(*) from public.member_beneficiaries)::text as beneficiaries,
       (select string_agg(b.status || '/' || b.verification_status,
                          ',' order by b.beneficiary_number)
          from public.member_beneficiaries b) as beneficiary_states,
       (select count(*) from public.member_beneficiary_identities)::text as identities,
       (select count(*) from public.benefit_claims)::text as claims,
       (select string_agg(c.claim_type || '/' || c.status, ',' order by c.claim_number)
          from public.benefit_claims c) as claim_states,
       (select coalesce(sum(c.approved_amount), 0)::bigint
          from public.benefit_claims c)::text as approved_total,
       (select count(*) from public.benefit_claim_documents)::text as documents,
       (select string_agg(d.verification_status, ',' order by d.id)
          from public.benefit_claim_documents d) as document_states,
       (select count(*) from public.benefit_assessment_snapshots)::text as snapshots,
       (select count(*) from public.benefit_payments)::text as payments,
       (select coalesce(sum(p.amount), 0)::bigint
          from public.benefit_payments p)::text as paid_gross,
       (select coalesce(sum(case when p.reversed_at is null then p.amount else 0 end), 0)
          ::bigint from public.benefit_payments p)::text as paid_net,
       (select count(*) from public.membership_meetings)::text as meetings,
       (select string_agg(m.status, ',' order by m.meeting_number)
          from public.membership_meetings m) as meeting_states,
       (select count(*) from public.meeting_attendance)::text as attendance,
       (select count(*) from public.meeting_attendance_corrections)::text as corrections,
       (select count(*) from public.meeting_action_items)::text as actions,
       (select count(*) from public.journal_entries)::text as journal_entries,
       (select count(*) from public.journal_lines)::text as journal_lines,
       (select coalesce(sum(debit), 0)::bigint from public.journal_lines)::text as debits,
       (select coalesce(sum(credit), 0)::bigint from public.journal_lines)::text
         as credits,
       (select coalesce(sum(signed_amount), 0)::bigint
          from public.savings_transactions)::text as savings_subledger,
       (select count(*) from public.loans)::text as loans,
       (select count(*) from public.memberships)::text as memberships,
       (select count(*) from public.clients)::text as clients,
       (select count(*) from public.membership_policy_versions)::text as policies`,
  );
}

let firstRun: SeedResult;
let stateAfterFirst: Record<string, string | null>;
let stateAfterSecond: Record<string, string | null>;
let stateAfterThird: Record<string, string | null>;

beforeAll(async () => {
  if (!hasDatabase) return;

  firstRun = await seed();

  if (firstRun.code !== 0) {
    throw new Error(`The benefit seeder failed.\n${firstRun.stdout}\n${firstRun.stderr}`);
  }

  stateAfterFirst = await benefitState();

  const second = await seed();
  if (second.code !== 0) {
    throw new Error(`The second run failed.\n${second.stdout}\n${second.stderr}`);
  }
  stateAfterSecond = await benefitState();

  const third = await seed();
  if (third.code !== 0) {
    throw new Error(`The third run failed.\n${third.stdout}\n${third.stderr}`);
  }
  stateAfterThird = await benefitState();
}, 400_000);

afterAll(async () => {
  if (!hasDatabase) return;
  await closePool();
});

// ===========================================================================
describeDb('the benefit demonstration is gated separately', () => {
  it('needs its own phrase, and nothing else turns it on', () => {
    expect(benefitDemoRequested(BENEFIT_ENABLE_PHRASE)).toBe(true);

    // The savings phrase is not this phrase. Somebody who means to seed
    // savings does not thereby publish a policy version answering four
    // decisions the client has not made, nor pay three synthetic benefits.
    for (const value of [
      undefined,
      '',
      '1',
      'true',
      'yes',
      ENABLE_PHRASE,
      MEMBER_LOAN_ENABLE_PHRASE,
      BENEFIT_ENABLE_PHRASE.toUpperCase(),
      `${BENEFIT_ENABLE_PHRASE} `,
    ]) {
      expect(benefitDemoRequested(value), String(value)).toBe(false);
    }
  });

  it('refuses a hosted database outright, and writes nothing', async () => {
    const before = await benefitState();

    const attempt = await seed({
      DATABASE_URL:
        'postgresql://postgres.zzzzzzzzzzzzzzzzzzzz:pw@aws-0-eu-west-1.pooler.supabase.com:6543/postgres',
    });

    expect(attempt.code).not.toBe(0);
    expect(attempt.stderr).toContain('Nothing has been written');
    expect(await benefitState()).toEqual(before);
  });

  it('refuses to run beside the member loan demonstration', async () => {
    const before = await benefitState();

    const attempt = await seed({
      POLYTOS_SEED_MEMBER_LOANS: MEMBER_LOAN_ENABLE_PHRASE,
    });

    expect(attempt.code).not.toBe(0);
    // The reason matters as much as the refusal: one version answering both
    // sets would put six unapproved figures in front of a reader with no way
    // to tell which demonstration each belonged to.
    expect(attempt.stderr).toContain('cannot run together');
    expect(attempt.stderr).toContain('Nothing has been written');
    expect(await benefitState()).toEqual(before);
  });

  it('names its phrase in the refusal a developer actually meets', async () => {
    const attempt = await seed({ POLYTOS_SEED_DEMO: undefined });

    expect(attempt.code).not.toBe(0);
    expect(attempt.stderr).toContain('POLYTOS_SEED_BENEFITS');
    expect(attempt.stderr).toContain(BENEFIT_ENABLE_PHRASE);
    expect(attempt.stderr).toContain('Nothing has been written');
  });
});

// ===========================================================================
describeDb('the TEST ONLY policy says so where a reader looks', () => {
  it('publishes 997.0, labelled, with the four figures nobody approved', async () => {
    const policy = await queryOne<{
      title: string;
      notes: string;
      status: string;
      cap: string;
      claims: string;
      waiting: string;
      basis: string;
      benefits_open: boolean;
    }>(
      `select title, notes, status,
              medical_benefit_annual_cap::text as cap,
              medical_benefit_claims_per_year::text as claims,
              benefit_waiting_period_days::text as waiting,
              medical_benefit_year_basis as basis,
              is_benefits_enabled as benefits_open
         from public.membership_policy_versions where version = $1`,
      [BENEFIT_POLICY_VERSION],
    );

    expect(policy.status).toBe('active');
    expect(policy.benefits_open).toBe(true);

    // The title is what a reader sees on the policy list, so that is where
    // TEST ONLY has to be — not only in a notes field nobody opens.
    expect(policy.title).toContain('TEST ONLY');
    expect(policy.notes).toContain('NOT made');

    expect(policy.cap).toBe(String(DEMO_MEDICAL_ANNUAL_CAP));
    expect(policy.claims).toBe(String(DEMO_MEDICAL_CLAIMS_PER_YEAR));
    expect(policy.waiting).toBe(String(DEMO_WAITING_PERIOD_DAYS));
    expect(policy.basis).toBe(DEMO_YEAR_BASIS);
  });

  it('keeps the client’s own four figures unchanged', async () => {
    // The rate, the admission threshold and the two fixed amounts are the
    // client's confirmed decisions. A demonstration that quietly moved one of
    // them would be the worst thing in this file: a figure the business
    // believes it approved, changed by a seeder.
    const policy = await queryOne<{
      rate: string;
      days: string;
      condolence: string;
      bereavement: string;
    }>(
      `select medical_benefit_rate_bps::text as rate,
              medical_benefit_min_admission_days::text as days,
              family_condolence_benefit::text as condolence,
              member_bereavement_benefit::text as bereavement
         from public.membership_policy_versions where version = $1`,
      [BENEFIT_POLICY_VERSION],
    );

    expect(policy.rate).toBe('500');
    expect(policy.days).toBe('1');
    expect(policy.condolence).toBe('100000');
    expect(policy.bereavement).toBe('200000');
  });

  it('uses the official family vocabulary without demo overrides', async () => {
    const rows = await query<{ key: string; eligible: boolean }>(
      `select key, condolence_eligible as eligible
         from public.beneficiary_relationships order by key`,
    );
    for (const row of rows) {
      expect(row.eligible, row.key).toBe(DEMO_CONDOLENCE_ELIGIBLE.includes(row.key));
    }
  });
});

// ===========================================================================
describeDb('everything it writes is labelled', () => {
  it('labels every claim, document, beneficiary and meeting', async () => {
    const unlabelled = await queryOne<{
      claims: string;
      documents: string;
      beneficiaries: string;
      meetings: string;
      minutes: string;
    }>(
      `select
         (select count(*) from public.benefit_claims c
           where coalesce(c.provider_name, '') not like 'DEMO%'
             and coalesce(c.deceased_name, '') not like 'DEMO%')::text as claims,
         (select count(*) from public.benefit_claim_documents d
           where coalesce(d.label, '') not like '%DEMONSTRATION%')::text as documents,
         (select count(*) from public.member_beneficiary_identities i
           where i.full_name not like 'DEMO%')::text as beneficiaries,
         (select count(*) from public.membership_meetings m
           where m.title not like 'DEMONSTRATION%')::text as meetings,
         (select count(*) from public.membership_meetings m
           where m.minutes is not null
             and m.minutes not like 'DEMONSTRATION%')::text as minutes`,
    );

    expect(unlabelled).toEqual({
      claims: '0',
      documents: '0',
      beneficiaries: '0',
      meetings: '0',
      minutes: '0',
    });
  });

  it('gives every synthetic approval and refusal a DEMONSTRATION reason', async () => {
    const rows = await query<{ claim_number: string; note: string | null }>(
      `select claim_number,
              coalesce(assessment_note, rejected_reason, cancelled_reason) as note
         from public.benefit_claims
        where status in ('assessed', 'approved', 'paid', 'rejected', 'cancelled',
                         'reversed')
        order by claim_number`,
    );

    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      expect(row.note, row.claim_number).toContain('DEMONSTRATION');
    }
  });

  it('gives every benefit payment a reversal reason that says so', async () => {
    const reversals = await query<{ reason: string | null }>(
      `select reversal_reason as reason from public.benefit_payments
        where reversed_at is not null`,
    );

    expect(reversals.length).toBe(1);
    expect(reversals[0]?.reason).toContain('DEMONSTRATION');
  });
});

// ===========================================================================
describeDb('the ten claim scenarios land where they are meant to', () => {
  it('pays three claims and reverses one', async () => {
    const summary = await queryOne<{
      paid: string;
      reversed: string;
      refused: string;
      drafts: string;
      held: string;
    }>(
      `select
         (select count(*) from public.benefit_claims where status = 'paid')::text as paid,
         (select count(*) from public.benefit_claims where status = 'reversed')::text
           as reversed,
         (select count(*) from public.benefit_claims where status = 'rejected')::text
           as refused,
         (select count(*) from public.benefit_claims where status = 'draft')::text
           as drafts,
         (select count(*) from public.benefit_claims
           where status = 'under_verification')::text as held`,
    );

    // Three paid and standing, one paid and reversed, one refused with a
    // reason, one left a draft, four held on an undecided rule.
    expect(summary).toEqual({
      paid: '3',
      reversed: '1',
      refused: '1',
      drafts: '1',
      held: '4',
    });
  });

  it('pays 5% of the bill, to the shilling', async () => {
    const medical = await queryOne<{ bill: string; approved: string }>(
      `select c.bill_amount::text as bill, c.approved_amount::text as approved
         from public.benefit_claims c
        where c.claim_type = 'medical' and c.status = 'paid'`,
    );

    // 5% of 400,000 is exactly 20,000 — the figure the brief itself quotes,
    // and the one the integer arithmetic has to produce without a float
    // anywhere near it.
    expect(medical.bill).toBe('400000');
    expect(medical.approved).toBe('20000');
  });

  it('holds each of the four claims on a named undecided rule', async () => {
    const held = await query<{ claim_number: string; codes: string | null }>(
      `select c.claim_number,
              (select string_agg(e.failure_code, ',' order by e.failure_code)
                 from public.benefit_claim_eligibility(c.id) e) as codes
         from public.benefit_claims c
        where c.status = 'under_verification'
        order by c.claim_number`,
    );

    const codes = held.flatMap((row) => (row.codes ?? '').split(',')).filter(Boolean);

    // The four the demonstration is built to show, each one a decision named
    // rather than a default taken.
    expect(codes).toContain('medical_cap_exceeded');
    expect(codes).toContain('admission_measure_undecided');
    expect(codes).toContain('next_of_kin_not_listed');
    expect(codes).toContain('membership_suspended_undecided');
  });

  it('freezes an assessment snapshot behind every decided claim', async () => {
    const counts = await queryOne<{ decided: string; snapshots: string }>(
      `select
         (select count(*) from public.benefit_claims
           where status in ('assessed', 'approved', 'paid', 'reversed'))::text
           as decided,
         (select count(*) from public.benefit_assessment_snapshots)::text as snapshots`,
    );

    expect(counts.snapshots).toBe(counts.decided);
  });

  it('pays the bereavement benefit to the frozen payee, not to the member', async () => {
    const payment = await queryOne<{
      kind: string;
      recipient: string;
      amount: string;
      beneficiary: string | null;
    }>(
      `select p.recipient_kind as kind, p.recipient_name as recipient,
              p.amount::text as amount, p.recipient_beneficiary_number as beneficiary
         from public.benefit_payments p
         join public.benefit_claims c on c.id = p.claim_id
        where c.claim_type = 'member_bereavement'`,
    );

    expect(payment.kind).toBe('beneficiary');
    expect(payment.amount).toBe('200000');
    expect(payment.beneficiary).not.toBeNull();

    // The name came from the assessment snapshot, so it is the payee the
    // approver agreed to rather than whoever the beneficiary record names now.
    const snapshot = await queryOne<{ name: string | null }>(
      `select s.beneficiary_name as name
         from public.benefit_assessment_snapshots s
         join public.benefit_claims c on c.id = s.claim_id
        where c.claim_type = 'member_bereavement'`,
    );

    expect(payment.recipient).toBe(snapshot.name);
  });
});

// ===========================================================================
describeDb('the money adds up', () => {
  it('reconciles the benefit payments against the General Ledger', async () => {
    const row = await queryOne<{ net: string; ledger: string }>(
      `select
         (select coalesce(sum(case when reversed_at is null then amount else 0 end), 0)
            ::bigint from public.benefit_payments)::text as net,
         (select coalesce(sum(b.balance), 0)::bigint
            from public.ledger_account_balances b
           where b.code in ('5210', '5220', '5230'))::text as ledger`,
    );

    expect(row.net).toBe(row.ledger);
    expect(BigInt(row.net)).toBeGreaterThan(0n);
  });

  it('leaves the journal balanced', async () => {
    const row = await queryOne<{ debits: string; credits: string }>(
      `select coalesce(sum(debit), 0)::bigint::text as debits,
              coalesce(sum(credit), 0)::bigint::text as credits
         from public.journal_lines`,
    );

    expect(row.debits).toBe(row.credits);
  });

  it('writes no second ledger: every benefit payment has one journal entry', async () => {
    const row = await queryOne<{ orphans: string; shared: string }>(
      `select
         (select count(*) from public.benefit_payments p
           where not exists (select 1 from public.journal_entries j
                              where j.id = p.journal_entry_id))::text as orphans,
         (select count(*) from (
            select journal_entry_id from public.benefit_payments
             group by journal_entry_id having count(*) > 1) d)::text as shared`,
    );

    expect(row).toEqual({ orphans: '0', shared: '0' });
  });

  it('moves no savings and writes no loan', async () => {
    // The benefits scheme and the savings a member holds are separate
    // promises. A benefit payment is an expense; it does not touch 2100, and
    // it certainly does not write a loan.
    const row = await queryOne<{ subledger: string; ledger: string; loans: string }>(
      `select
         (select coalesce(sum(signed_amount), 0)::bigint
            from public.savings_transactions)::text as subledger,
         (select coalesce(balance, 0)::bigint from public.ledger_account_balances
           where code = '2100')::text as ledger,
         (select count(*) from public.loans)::text as loans`,
    );

    expect(row.subledger).toBe(row.ledger);
    expect(row.loans).toBe('0');
  });
});

// ===========================================================================
describeDb('running it again changes nothing', () => {
  it('is a fixed point from the second run onwards', () => {
    expect(stateAfterSecond).toEqual(stateAfterFirst);
    expect(stateAfterThird).toEqual(stateAfterSecond);
  });

  it('posts no money on a second run, and says so', async () => {
    const before = await benefitState();
    const again = await seed();

    expect(again.code).toBe(0);
    expect(again.stdout).toContain('already present');
    expect(await benefitState()).toEqual(before);
  });
});

// ===========================================================================
describeDb('the meetings it writes are a coherent history', () => {
  it('holds two, cancels one and leaves one to come', async () => {
    const row = await queryOne<{ held: string; cancelled: string; scheduled: string }>(
      `select
         (select count(*) from public.membership_meetings where status = 'held')::text
           as held,
         (select count(*) from public.membership_meetings
           where status = 'cancelled')::text as cancelled,
         (select count(*) from public.membership_meetings
           where status = 'scheduled')::text as scheduled`,
    );

    expect(row).toEqual({ held: '2', cancelled: '1', scheduled: '1' });
  });

  it('derives `held` from the register rather than setting it', async () => {
    // Every held meeting has attendance, and the cancelled one has none —
    // which is the rule rather than a coincidence: a meeting people attended
    // cannot be cancelled at all.
    const rows = await query<{ status: string; marked: string }>(
      `select m.status,
              (select count(*) from public.meeting_attendance a
                where a.meeting_id = m.id)::text as marked
         from public.membership_meetings m order by m.meeting_number`,
    );

    for (const row of rows) {
      if (row.status === 'held') expect(Number(row.marked)).toBeGreaterThan(0);
      else expect(row.marked).toBe('0');
    }
  });

  it('keeps the previous answer when a register is corrected', async () => {
    const correction = await queryOne<{
      previous: string;
      next: string;
      reason: string;
    }>(
      `select previous_attendance as previous, new_attendance as next, reason
         from public.meeting_attendance_corrections limit 1`,
    );

    expect(correction.previous).toBe('absent');
    expect(correction.next).toBe('present');
    expect(correction.reason).toContain('DEMONSTRATION');
  });

  it('finalises one set of minutes and leaves one a draft', async () => {
    const row = await queryOne<{ finalised: string; drafts: string }>(
      `select
         (select count(*) from public.membership_meetings
           where minutes_finalised_at is not null)::text as finalised,
         (select count(*) from public.membership_meetings
           where minutes is not null and minutes_finalised_at is null)::text as drafts`,
    );

    expect(row).toEqual({ finalised: '1', drafts: '1' });
  });
});
