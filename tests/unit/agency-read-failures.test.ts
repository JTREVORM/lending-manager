import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Phase 4D-F — a failed agency read is reported, never rendered as a figure.
 *
 * ## What went wrong
 *
 * Every reader in `lib/data/agency.ts` answered a failed query with `[]`,
 * logged and moved on. That is the same defect Phase 19 found on the lending
 * dashboard, rebuilt from scratch in the agency module, and on these screens
 * it reads as:
 *
 *   * `UGX 0` commission outstanding, and `UGX 0` owed to providers
 *   * "No float till is registered"
 *   * "Nothing outstanding. No unverified transaction, no reconciliation
 *     awaiting a second officer, no empty float till" — on the screen an
 *     officer closes the day from
 *   * an empty transaction register, which is what somebody checks before
 *     recording a customer's transaction a second time
 *
 * Every one of those is a statement about money, none of them was true, and
 * the third is said on the screen whose entire purpose is to be trusted when
 * it says nothing is outstanding.
 *
 * ## What these tests pin
 *
 * That each reader returns `{ ok: false }` — "I could not read this" —
 * rather than a shape a screen would draw as fact, and that it distinguishes
 * being refused from being unable. The screens' own handling is asserted in
 * a real browser against a real revoked grant by
 * `tests/e2e/specs/agency.write.spec.ts`.
 */

// `lib/data/*` is server-only, which refuses to load outside a React Server
// Component. The readers themselves are plain async functions; the guard is
// what stops them being imported here, so it is stubbed rather than worked
// around.
vi.mock('server-only', () => ({}));

/** The error PostgREST relays when Postgres cancels a statement. */
const CANCELLED = {
  code: '57014',
  message: 'canceling statement due to statement timeout',
};

/** The error PostgREST relays when the role may not read the relation. */
const REFUSED = {
  code: '42501',
  message: 'permission denied for view agency_commission_summary',
};

let nextResult: { data: unknown; error: unknown } = { data: null, error: CANCELLED };

function builder(): unknown {
  const result = nextResult;
  const self: Record<string, unknown> = {};
  for (const method of [
    'select',
    'eq',
    'neq',
    'gt',
    'gte',
    'lt',
    'lte',
    'not',
    'is',
    'in',
    'range',
    'filter',
    'match',
    'or',
    'order',
    'limit',
  ]) {
    self[method] = () => self;
  }
  self.maybeSingle = () => Promise.resolve(result);
  self.single = () => Promise.resolve(result);
  self.then = (
    resolve: (value: typeof result) => unknown,
    reject?: (reason: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  return self;
}

const fromMock = vi.fn(() => builder());
/** One reader calls an RPC rather than selecting from a view. */
const rpcMock = vi.fn<
  () => Promise<{ data: unknown; error: { code: string; message: string } | null }>
>(() => Promise.resolve({ data: null, error: CANCELLED }));

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () => Promise.resolve({ from: fromMock, rpc: rpcMock }),
}));

// The readers log a warning on failure, which is correct and not under test.
vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const {
  getAgencyAgentLineObligations,
  getAgencyCashCounts,
  getAgencyCashMovement,
  getAgencyCommission,
  getAgencyCommissionMonths,
  getAgencyCommissionReconciliations,
  getAgencyCommissionSettlements,
  getAgencyExceptions,
  getAgencyFloatBalances,
  getAgencyFloatStatements,
  getAgencyFloatTrades,
  getAgencyLineCommission,
  getAgencyMoneyConsolidated,
  getAgencyMoneyDashboard,
  getAgencyPayableSettlements,
  getAgencyPayables,
  getAgencyProviders,
  getAgencyServiceTypes,
  getAgencyTransaction,
  getAgencyTransactions,
  getAgencyVariances,
  getPostableFloatTills,
} = await import('@/lib/data/agency');

/** Every list reader, named by the sentence its failure would otherwise tell. */
const LIST_READERS: readonly {
  readonly name: string;
  readonly lie: string;
  readonly read: () => Promise<{ ok: boolean }>;
}[] = [
  {
    name: 'getAgencyFloatBalances',
    lie: 'no float till is registered',
    read: () => getAgencyFloatBalances(),
  },
  {
    name: 'getAgencyTransactions',
    lie: 'nothing has been recorded at this counter',
    read: () => getAgencyTransactions({ limit: 10 }),
  },
  {
    name: 'getAgencyCommission',
    lie: 'UGX 0 commission is outstanding',
    read: () => getAgencyCommission(),
  },
  {
    name: 'getAgencyPayables',
    lie: 'UGX 0 is owed to providers',
    read: () => getAgencyPayables(),
  },
  {
    name: 'getAgencyVariances',
    lie: 'nothing has been reconciled',
    read: () => getAgencyVariances({ limit: 10 }),
  },
  {
    name: 'getAgencyCashMovement',
    lie: 'no agency cash moved today',
    read: () => getAgencyCashMovement({ limit: 10 }),
  },
  {
    name: 'getAgencyExceptions',
    lie: 'nothing is outstanding, the day may be closed',
    read: () => getAgencyExceptions(),
  },
  {
    name: 'getAgencyProviders',
    lie: 'no provider is registered',
    read: () => getAgencyProviders(),
  },
  {
    name: 'getAgencyServiceTypes',
    lie: 'no service type is configured',
    read: () => getAgencyServiceTypes(),
  },
  {
    name: 'getAgencyCashCounts',
    lie: 'no drawer has been counted',
    read: () => getAgencyCashCounts({ limit: 10 }),
  },
  {
    name: 'getAgencyFloatStatements',
    lie: 'no provider statement has been recorded',
    read: () => getAgencyFloatStatements({ limit: 10 }),
  },
  {
    name: 'getAgencyCommissionSettlements',
    lie: 'no commission has been remitted to us',
    read: () => getAgencyCommissionSettlements({ limit: 10 }),
  },
  {
    name: 'getAgencyPayableSettlements',
    lie: 'nothing has been remitted to a provider',
    read: () => getAgencyPayableSettlements({ limit: 10 }),
  },
  {
    name: 'getPostableFloatTills',
    lie: 'no till is available to post against',
    read: () => getPostableFloatTills(),
  },
  // Phase 4E. Six more, and the sentences they would otherwise tell are the
  // same kind of lie: a figure about money, produced by a query that did not
  // run. The last two are the worst of them — a supervisor deciding a line is
  // healthy, and an Owner deciding a provider owes nothing.
  {
    name: 'getAgencyLineCommission',
    lie: 'UGX 0 commission is owed to this agent line',
    read: () => getAgencyLineCommission(),
  },
  {
    name: 'getAgencyMoneyDashboard',
    lie: 'this line holds no float and has nothing outstanding',
    read: () => getAgencyMoneyDashboard({ providerCode: 'MTN_MOMO' }),
  },
  {
    name: 'getAgencyMoneyConsolidated',
    lie: 'this provider owes us nothing and holds no float',
    read: () => getAgencyMoneyConsolidated(),
  },
  {
    name: 'getAgencyFloatTrades',
    lie: 'no float trade is waiting for a second officer',
    read: () => getAgencyFloatTrades({ limit: 10 }),
  },
  {
    name: 'getAgencyCommissionReconciliations',
    lie: 'no provider statement is unreconciled',
    read: () => getAgencyCommissionReconciliations({ limit: 10 }),
  },
  {
    name: 'getAgencyCommissionMonths',
    lie: 'this line earned no commission this month',
    read: () => getAgencyCommissionMonths({ limit: 10 }),
  },
];

describe('a failed agency read is reported, not rendered', () => {
  beforeEach(() => {
    fromMock.mockClear();
    rpcMock.mockClear();
    nextResult = { data: null, error: CANCELLED };
  });

  for (const reader of LIST_READERS) {
    it(`${reader.name} does not become "${reader.lie}"`, async () => {
      const result = await reader.read();
      expect(result.ok).toBe(false);
      expect(result).not.toHaveProperty('rows');
    });
  }

  it('a single transaction reports failure rather than "not found"', async () => {
    // The page answers `null` with the not-found screen. Telling an officer
    // their transaction does not exist because a query timed out is how a
    // transaction gets recorded twice.
    const result = await getAgencyTransaction('11111111-1111-1111-1111-111111111111');
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('row');
  });

  it('names a refusal as a refusal and everything else as unavailable', async () => {
    nextResult = { data: null, error: REFUSED };
    const refused = await getAgencyCommission();
    expect(refused).toMatchObject({ ok: false, kind: 'forbidden' });

    nextResult = { data: null, error: CANCELLED };
    const cancelled = await getAgencyCommission();
    expect(cancelled).toMatchObject({ ok: false, kind: 'unavailable' });
  });

  it('says what could not be read, so a screen can name it', async () => {
    const result = await getAgencyExceptions();
    expect(result).toMatchObject({ ok: false, what: 'the outstanding exceptions' });
  });

  it('does not let a failed obligations read become "nothing stands in the way"', async () => {
    // Phase 4E. This read decides whether the screen offers to close an agent
    // line. An empty array means "closing this is safe", and a failed query
    // answering with one would offer the button on a line that still holds
    // float — which the database would then refuse, after the Owner had been
    // told it was fine.
    rpcMock.mockResolvedValueOnce({ data: null, error: CANCELLED });
    const result = await getAgencyAgentLineObligations(
      '11111111-1111-1111-1111-111111111111',
    );
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('row');
  });

  it('reports a line with nothing in the way as exactly that', async () => {
    rpcMock.mockResolvedValueOnce({ data: [], error: null });
    const result = await getAgencyAgentLineObligations(
      '11111111-1111-1111-1111-111111111111',
    );
    expect(result).toEqual({ ok: true, row: [] });
  });

  it('still reports an empty result as empty when the query succeeded', async () => {
    // The other half. A register with nothing in it is a real and common
    // answer, and this must not turn into an error either.
    nextResult = { data: [], error: null };
    const result = await getAgencyExceptions();
    expect(result).toEqual({ ok: true, rows: [] });
  });

  it('filters postable tills without swallowing a failure', async () => {
    nextResult = { data: null, error: CANCELLED };
    const failed = await getPostableFloatTills();
    expect(failed.ok).toBe(false);

    nextResult = { data: [], error: null };
    const empty = await getPostableFloatTills();
    expect(empty).toEqual({ ok: true, rows: [] });
  });
});
