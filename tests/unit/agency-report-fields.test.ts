import { describe, expect, it } from 'vitest';

import {
  agencyCashBankingFields,
  agencyCashCountFields,
  agencyCommissionFields,
  agencyCommissionSettlementFields,
  agencyFloatFields,
  agencyPayableFields,
  agencyPerformanceFields,
  agencyTransactionFields,
  agencyVarianceFields,
} from '@/lib/reports/agency-fields';
import { assertNoIdentityField, csvColumns } from '@/lib/reports/columns';
import { toCsv } from '@/lib/domain/reporting';
import {
  AGENCY_REPORT_SECTIONS,
  AGENCY_REPORT_SECTION_META,
  categoriesForScope,
  readAgencyReportFilter,
  tallyAgentPerformance,
} from '@/lib/agency/reporting';

const ZONE = 'Africa/Kampala';

/**
 * What every Agency download looks like, and what it refuses to carry.
 *
 * ## Why the headings are written out in full
 *
 * For the reason `tests/unit/report-fields.test.ts` gives about the lending
 * reports: a change to a download's shape is not a refactor, it is a silent
 * change to a file somebody has a saved formula against. Writing the headings
 * out is what makes the next change visible in a diff rather than in a
 * reconciliation that stops balancing.
 *
 * ## Why two of these tests are about absence
 *
 * An exported file is the most portable thing this application produces. The
 * transaction report carries the *provider's* reference, which is what a
 * reconciliation is matched on, and deliberately not the customer identifier
 * the customer gave at the counter. And nothing anywhere carries a customer
 * bank balance, because client Rule 1 forbids one existing: "POLYTOS must
 * never attempt to retrieve, calculate or display an individual customer's
 * banking balance."
 */
describe('the heading row each Agency report writes', () => {
  const headings = (fields: readonly { readonly header: string }[]): readonly string[] =>
    fields.map((f) => f.header);

  it('transactions', () => {
    expect(headings(agencyTransactionFields())).toEqual([
      'Date',
      'Provider',
      'Account',
      'Branch',
      'Type',
      'Direction',
      'Status',
      'Principal (UGX)',
      'Charge (UGX)',
      'Commission (UGX)',
      'Provider reference',
      'Recorded by',
      'Verified by',
    ]);
  });

  it('electronic float', () => {
    expect(headings(agencyFloatFields())).toEqual([
      'Provider',
      'Account',
      'Identifier',
      'Branch',
      'Ledger account',
      'Status',
      'Float held (UGX)',
      'Deposits today (UGX)',
      'Withdrawals today (UGX)',
      'Commission today (UGX)',
      'Commission receivable (UGX)',
      'Owed back (UGX)',
    ]);
  });

  it('cash banked', () => {
    expect(headings(agencyCashBankingFields())).toEqual([
      'Date',
      'Reference',
      'Branch',
      'Banked into',
      'Banked by',
      'Amount (UGX)',
      'Charge (UGX)',
      'Net banked (UGX)',
      'Status',
      'Recorded by',
      'Verified by',
    ]);
  });

  it('cash counts', () => {
    expect(headings(agencyCashCountFields())).toEqual([
      'Date',
      'Branch',
      'Account',
      'Book balance (UGX)',
      'Counted (UGX)',
      'Variance (UGX)',
      'Variance means',
      'Written off (UGX)',
      'Status',
    ]);
  });

  it('commission', () => {
    expect(headings(agencyCommissionFields())).toEqual([
      'Provider',
      'Branch',
      'Earned (UGX)',
      'Received (UGX)',
      'Returned (UGX)',
      'Outstanding (UGX)',
    ]);
  });

  it('commission settlements', () => {
    expect(headings(agencyCommissionSettlementFields())).toEqual([
      'Date',
      'Provider',
      'Branch',
      'Statement',
      'Amount (UGX)',
      'Settled into',
      'Status',
      'Reversal reason',
    ]);
  });

  it('provider payables', () => {
    expect(headings(agencyPayableFields())).toEqual([
      'Provider',
      'Branch',
      'Collected (UGX)',
      'Remitted (UGX)',
      'Reversed (UGX)',
      'Outstanding (UGX)',
    ]);
  });

  it('variances', () => {
    expect(headings(agencyVarianceFields())).toEqual([
      'Date',
      'Kind',
      'Branch',
      'Provider',
      'System balance (UGX)',
      'Counted / statement (UGX)',
      'Variance (UGX)',
      'Variance means',
      'Written off (UGX)',
      'Status',
      'Statement',
    ]);
  });

  it('agent performance, naming volume as volume and never as profit', () => {
    const columns = headings(agencyPerformanceFields());

    expect(columns).toEqual([
      'Staff member',
      'Recorded',
      'Verified',
      'Deposits',
      'Deposit service volume (UGX)',
      'Withdrawals',
      'Withdrawal service volume (UGX)',
      'Reversed',
    ]);

    // §6.5: "Do not treat the full monetary volume of customer transactions as
    // profit." Commission is earned by an account, not by whoever keyed the
    // transaction, so attributing it to a person would be inventing an
    // allocation rule the business has not stated.
    expect(columns.join(' ')).not.toMatch(/commission|profit|income|earnings/i);
  });
});

describe('what an Agency export refuses to carry', () => {
  it('carries no customer identifier on the transaction report', () => {
    const columns = agencyTransactionFields().map((f) => f.header.toLowerCase());

    // The provider's reference is there, because that is what a
    // reconciliation is matched on. What the customer handed over at the
    // counter is not.
    expect(columns).toContain('provider reference');
    for (const forbidden of [
      'customer identifier',
      'customer',
      'phone',
      'account number',
    ]) {
      expect(columns, forbidden).not.toContain(forbidden);
    }
  });

  it('carries no customer balance anywhere, because Rule 1 forbids one existing', () => {
    const every = [
      ...agencyTransactionFields(),
      ...agencyFloatFields(),
      ...agencyCashBankingFields(),
      ...agencyCashCountFields(),
      ...agencyCommissionFields(),
      ...agencyCommissionSettlementFields(),
      ...agencyPayableFields(),
      ...agencyVarianceFields(),
      ...agencyPerformanceFields(),
    ].map((f) => f.header.toLowerCase());

    for (const heading of every) {
      expect(heading, heading).not.toMatch(/customer (balance|bank|account balance)/);
    }
  });

  it('passes the identity-field assertion the reporting layer applies', () => {
    // The same guard every lending report's fields go through: no field whose
    // heading or value would be an identification number.
    expect(() => {
      assertNoIdentityField('agency-transactions', agencyTransactionFields());
      assertNoIdentityField('agency-cash-and-float', agencyFloatFields());
      assertNoIdentityField('agency-cash-banking', agencyCashBankingFields());
      assertNoIdentityField('agency-cash-counts', agencyCashCountFields());
      assertNoIdentityField('agency-commission', agencyCommissionFields());
      assertNoIdentityField('agency-settlements', agencyCommissionSettlementFields());
      assertNoIdentityField('agency-payables', agencyPayableFields());
      assertNoIdentityField('agency-reconciliation', agencyVarianceFields());
      assertNoIdentityField('agency-agent-performance', agencyPerformanceFields());
    }).not.toThrow();
  });
});

describe('the whole file, not just its heading', () => {
  it('writes money as plain digits, so a spreadsheet reads it as a number', () => {
    const csv = toCsv(csvColumns(agencyPerformanceFields()), [
      {
        name: 'Aketch Grace',
        recorded: 12,
        verified: 0,
        deposits: 7,
        depositValue: 1_250_000,
        withdrawals: 5,
        withdrawalValue: 940_500,
        reversed: 1,
      },
    ]);

    const [, row] = csv.split('\n');

    // 1250000, not "1,250,000": a grouped figure in a CSV is a parse failure
    // waiting for a spreadsheet with a different locale, and these files are
    // opened in Excel to be totalled.
    expect(row).toContain('1250000');
    expect(row).toContain('940500');
    expect(row).not.toContain('1,250,000');
  });

  it('disarms a provider reference that begins like a formula', () => {
    // A provider reference is user-supplied, and a CSV cell beginning with `=`
    // is a formula in every spreadsheet that opens it.
    const csv = toCsv(csvColumns(agencyPerformanceFields()), [
      {
        name: '=1+1',
        recorded: 0,
        verified: 0,
        deposits: 0,
        depositValue: 0,
        withdrawals: 0,
        withdrawalValue: 0,
        reversed: 0,
      },
    ]);

    expect(csv).not.toMatch(/^"?=1\+1/m);
  });
});

describe('the Agency report filter', () => {
  it('defaults to the overview, every provider and this month', () => {
    const filter = readAgencyReportFilter({}, ZONE);

    expect(filter.section).toBe('overview');
    expect(filter.scope).toBe('all');
    expect(filter.providerCode).toBeNull();
    // Not `today`. An agency report is read to reconcile a provider's
    // statement and to see commission against settlement, and both are
    // monthly questions; a hub that opened on one day's figures would look
    // empty every morning.
    expect(filter.period).toBe('month');
    expect(filter.error).toBeNull();
  });

  it('heads the hub\'s default screen "Agency reports", which a browser test asserts', () => {
    /*
      `tests/e2e/specs/agency.spec.ts` opens `/agency/reports` and requires the
      words "Agency reports" to be visible in `main`. The hub's heading comes
      from this table, so the wording is pinned here as well — a rename now
      breaks a test that runs in a second rather than one that runs twenty
      minutes into a browser suite.

      `label` and `heading` differ only for the overview, and deliberately:
      under a branch called "Consolidated Agency Reports" the row can only
      read "Overview", while "Overview" alone as an `<h1>` says nothing about
      what is being overviewed. The first version had one field for both and
      left the page headed "Overview", which is what the browser suite caught.
    */
    expect(AGENCY_REPORT_SECTION_META.overview.heading).toBe('Agency reports');
    expect(AGENCY_REPORT_SECTION_META.overview.label).toBe('Overview');

    // Every other section's heading is its label: there is nothing to
    // disambiguate once the section names itself.
    for (const section of AGENCY_REPORT_SECTIONS) {
      if (section === 'overview') continue;
      const meta = AGENCY_REPORT_SECTION_META[section];
      expect(meta.heading, section).toBe(meta.label);
    }
  });

  it('reads every section the hub declares', () => {
    for (const section of AGENCY_REPORT_SECTIONS) {
      expect(readAgencyReportFilter({ section }, ZONE).section).toBe(section);
    }
  });

  it('falls back rather than erroring on a value it cannot read', () => {
    // A filter is a convenience, not a control: what a reader may see is
    // decided by the route's capability and by Row Level Security, and
    // neither is affected by anything in this function.
    const filter = readAgencyReportFilter(
      { section: 'nonsense', scope: 'nonsense', provider: 'not a code', account: 'x' },
      ZONE,
    );

    expect(filter.section).toBe('overview');
    expect(filter.scope).toBe('all');
    expect(filter.providerCode).toBeNull();
    expect(filter.accountId).toBeNull();
  });

  it('accepts a provider code of the database’s own shape, and nothing else', () => {
    expect(readAgencyReportFilter({ provider: 'TESTNET_1' }, ZONE).providerCode).toBe(
      'TESTNET_1',
    );
    for (const bad of ['testnet', 'A', 'HAS SPACE', 'has-dash', '']) {
      expect(
        readAgencyReportFilter({ provider: bad }, ZONE).providerCode,
        bad,
      ).toBeNull();
    }
  });

  it('refuses an unreadable custom range with a sentence instead of figures', () => {
    const filter = readAgencyReportFilter(
      { period: 'custom', from: 'not-a-date', to: 'also-not' },
      ZONE,
    );

    // The hub and the export route both show this instead of the report. A
    // silent fallback would be the worst outcome: the reader would act on
    // figures for a period they did not ask for.
    expect(filter.error).not.toBeNull();
  });

  it('maps a scope to provider categories without naming a provider', () => {
    expect(categoriesForScope('banking')).toEqual(['agency_banking']);
    expect(categoriesForScope('mobile_money')).toEqual(['mobile_money']);

    // `all` is every category rather than "no filter", so a provider in a
    // category nobody expected is counted in the consolidated report instead
    // of silently vanishing from it.
    const all = categoriesForScope('all');
    expect(all).toContain('agency_banking');
    expect(all).toContain('mobile_money');
    expect(all).toContain('utility');
  });
});

describe('the agent performance tally', () => {
  const tx = (over: Partial<Parameters<typeof tallyAgentPerformance>[0][number]>) => ({
    submittedByName: 'Aketch Grace',
    verifiedByName: null,
    status: 'posted',
    direction: 'deposit',
    principalAmount: 100_000,
    ...over,
  });

  it('counts recording and verifying separately', () => {
    // Verifying is a control, not counter work. Merging them would make the
    // busiest checker look like the busiest cashier, and the maker-checker
    // separation is what this report is most often read to confirm.
    const rows = tallyAgentPerformance([
      tx({ submittedByName: 'Grace', verifiedByName: 'Moses' }),
      tx({ submittedByName: 'Grace', verifiedByName: 'Moses' }),
      tx({ submittedByName: 'Moses', verifiedByName: 'Grace' }),
    ]);

    const grace = rows.find((r) => r.name === 'Grace');
    const moses = rows.find((r) => r.name === 'Moses');

    expect(grace?.recorded).toBe(2);
    expect(grace?.verified).toBe(1);
    expect(moses?.recorded).toBe(1);
    expect(moses?.verified).toBe(2);
  });

  it('counts a draft as recorded and in no volume at all', () => {
    // Only a posted transaction has a value in the book, so only a posted one
    // contributes to a volume.
    const [row] = tallyAgentPerformance([tx({ status: 'draft' })]);

    expect(row?.recorded).toBe(1);
    expect(row?.deposits).toBe(0);
    expect(row?.depositValue).toBe(0);
  });

  it('counts a reversal as recorded, in its own column, and in no volume', () => {
    const [row] = tallyAgentPerformance([tx({ status: 'reversed' })]);

    expect(row?.recorded).toBe(1);
    expect(row?.reversed).toBe(1);
    expect(row?.depositValue).toBe(0);
  });

  it('keeps deposits and withdrawals apart', () => {
    const [row] = tallyAgentPerformance([
      tx({ direction: 'deposit', principalAmount: 300_000 }),
      tx({ direction: 'withdrawal', principalAmount: 200_000 }),
    ]);

    expect(row?.depositValue).toBe(300_000);
    expect(row?.withdrawalValue).toBe(200_000);
  });

  it('attributes nothing to nobody', () => {
    // A transaction with no recorded officer — a system posting — must not
    // create a row named after the absence of one.
    const rows = tallyAgentPerformance([
      tx({ submittedByName: null, verifiedByName: null }),
    ]);
    expect(rows).toHaveLength(0);
  });

  it('orders the busiest recorder first', () => {
    const rows = tallyAgentPerformance([
      tx({ submittedByName: 'Quiet' }),
      tx({ submittedByName: 'Busy' }),
      tx({ submittedByName: 'Busy' }),
    ]);
    expect(rows.map((r) => r.name)).toEqual(['Busy', 'Quiet']);
  });
});
