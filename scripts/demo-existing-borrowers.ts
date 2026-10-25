/** Opt-in demonstration membership scenarios mapped to borrowers in the existing loan book.
 * This code NEVER updates clients, loans, schedules, payments or loan balances.
 * Scenario-to-client associations persist on memberships.notes for stable reruns.
 */
import type pg from 'pg';
export interface BorrowerScenario {
  readonly letter: string;
  readonly phone: string;
}
export interface DemoBorrower {
  readonly id: string;
  readonly full_name: string;
  readonly loan_count: number;
  readonly has_membership: boolean;
}
const PHRASE = 'yes-reuse-existing-demo-borrowers';
const MARKER = 'DEMONSTRATION SCENARIO ';
const REUSED = MARKER + '% — existing loan borrower';

export async function chooseExistingDemoBorrowers(
  client: pg.Client,
  scenarios: readonly BorrowerScenario[],
  optIn: string | undefined,
): Promise<Map<string, DemoBorrower>> {
  if (!optIn) {
    // The mirror of the synthetic-client guard below, and it has to be here
    // rather than there: this is the branch a plain `npm run seed:demo` takes.
    //
    // Every scenario's fee and deposit idempotency key is derived from its
    // letter alone, so the keys are the same in both modes. Once a reuse run
    // has spent them on real loan-book borrowers, a synthetic run replays
    // those keys instead of posting anything: `enrol_member` hands back the
    // existing borrower's membership, the six new synthetic clients are left
    // with no membership at all, and the one membership that does get created
    // points at a fee receipt belonging to somebody else. The money still
    // reconciles — nothing is double-posted — which is exactly what makes it
    // dangerous, because the demonstration then shows one person's
    // registration fee against another person's name.
    //
    // So refuse, rather than produce that. Recovering needs a decision about
    // which set of people the posted money belongs to, and that is not a
    // decision a seeding script may take on its own.
    const reused = await client.query<{ n: number }>(
      'select count(*)::int as n from public.memberships where notes like $1',
      [REUSED],
    );
    if (reused.rows[0]!.n > 0)
      throw new Error(
        'This database already holds demonstration scenarios mapped onto existing loan ' +
          'borrowers. Seeding synthetic demo clients now would replay their posted fee and ' +
          'deposit keys and attribute one person’s money to another. Set ' +
          'POLYTOS_DEMO_BORROWER_REUSE=' +
          PHRASE +
          ' to continue with the existing borrowers, or use a clean database. Nothing written.',
      );
    return new Map();
  }
  if (optIn !== PHRASE)
    throw new Error(
      'Borrower reuse needs the exact POLYTOS_DEMO_BORROWER_REUSE opt-in; nothing written.',
    );
  // Reusing old deterministic money keys on different borrowers is unsafe.
  // Refuse to remap pre-existing synthetic demonstration clients.
  const synthetic = await client.query<{ n: number }>(
    'select count(*)::int as n from public.clients where phone = any($1::text[])',
    [scenarios.map((s) => s.phone)],
  );
  if (synthetic.rows[0]!.n > 0)
    throw new Error(
      'Synthetic demo clients already exist. Do not remap their posted fee/deposit keys.',
    );
  const book = await client.query<DemoBorrower>(
    'select c.id, c.full_name, count(l.id)::int as loan_count, ' +
      'exists (select 1 from public.memberships m where m.client_id=c.id ' +
      "and m.status in ('pending','active','suspended')) as has_membership " +
      'from public.clients c join public.loans l on l.client_id=c.id ' +
      "where c.status <> 'blacklisted' group by c.id " +
      'order by count(l.id) desc, c.client_number asc',
  );
  if (book.rows.length < scenarios.length + 1)
    throw new Error(
      'Expected at least seven borrower clients: six members and a non-member. No writes made.',
    );
  const known = await client.query<{ client_id: string; notes: string }>(
    'select client_id, notes from public.memberships ' +
      "where notes like 'DEMONSTRATION SCENARIO %' " +
      "and status in ('pending','active','suspended')",
  );
  const byId = new Map(book.rows.map((row) => [row.id, row]));
  const chosen = new Map<string, DemoBorrower>();
  const used = new Set<string>();
  for (const record of known.rows) {
    const letter = record.notes.slice(MARKER.length, MARKER.length + 1);
    if (!scenarios.some((s) => s.letter === letter)) continue;
    const row = byId.get(record.client_id);
    if (!row || chosen.has(letter) || used.has(row.id))
      throw new Error(
        'Ambiguous persisted demo scenario or its loan borrower disappeared; refusing to remap.',
      );
    chosen.set(letter, row);
    used.add(row.id);
  }
  for (const scenario of scenarios) {
    if (chosen.has(scenario.letter)) continue;
    const borrower = book.rows.find((row) => !used.has(row.id) && !row.has_membership);
    if (!borrower)
      throw new Error('Not enough free loan borrowers to assign all scenarios.');
    chosen.set(scenario.letter, borrower);
    used.add(borrower.id);
  }
  if (!book.rows.some((row) => !used.has(row.id) && !row.has_membership))
    throw new Error('At least one loan borrower must remain a non-member.');
  console.log(
    '  borrower bridge  six EXISTING loan-book clients selected, others non-members',
  );
  return chosen;
}

export async function verifyBorrowerBridge(
  client: pg.Client,
  scenarios: readonly BorrowerScenario[],
  chosen: ReadonlyMap<string, DemoBorrower>,
): Promise<void> {
  if (chosen.size === 0) return;
  for (const scenario of scenarios) {
    const borrower = chosen.get(scenario.letter);
    if (!borrower)
      throw new Error('Missing linked borrower for scenario ' + scenario.letter);
    const rows = await client.query<{ n: number }>(
      'select count(*)::int as n from public.memberships m ' +
        'join public.loans l on l.client_id=m.client_id ' +
        'where m.client_id=$1 and m.notes like $2',
      [borrower.id, MARKER + scenario.letter + ' —%'],
    );
    if (rows.rows[0]!.n !== borrower.loan_count)
      throw new Error(
        'Scenario ' + scenario.letter + ' is not linked to the expected loan borrower.',
      );
  }
  const nonMember = await client.query<{ n: number }>(
    'select count(distinct c.id)::int as n from public.clients c ' +
      'join public.loans l on l.client_id=c.id ' +
      'where not exists(select 1 from public.memberships m where m.client_id=c.id ' +
      "and m.status in ('pending','active','suspended'))",
  );
  if (nonMember.rows[0]!.n === 0) throw new Error('All loan borrowers became members.');
  console.log('  borrower bridge  all scenarios, loan links and non-members verified');
}
