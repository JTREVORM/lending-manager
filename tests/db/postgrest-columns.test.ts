import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { closePool, hasDatabase, query, skipReason } from '../helpers/db';

/**
 * Every column this application asks PostgREST for, against the real schema.
 *
 * ## The bug this exists for
 *
 * `listExpectedMembers` asked `membership_register` for `membership_id`. The
 * view's key column is `id` — it is a view *of* memberships — so PostgREST
 * answered 400, the data function threw, and `/meetings/[meetingId]` returned
 * 500 for every meeting. Nothing caught it until the browser suite ran in CI:
 *
 *   - **TypeScript cannot.** A PostgREST select list is a string. The row
 *     type is asserted after the call, so the compiler is being told the
 *     answer rather than checking it.
 *   - **The database suite cannot.** Those tests speak SQL directly and never
 *     name a column list the way PostgREST parses one.
 *   - **The unit suites cannot.** They hand a parsed object to a schema;
 *     there is no database within a mile of them.
 *
 * So the gap was real and the whole class of it was unguarded: a renamed
 * column, a view that drops one, a typo in a long select list. Each is a 500
 * on one screen, found by whoever opens that screen.
 *
 * ## What it checks, and what it deliberately does not
 *
 * Only `.select('…')` column lists. Those are unambiguous text, and they are
 * where the bug was. Filter arguments (`.eq('branch_id', …)`) are not
 * checked: a query chain is often built across several statements, and a
 * parser that followed them would be guessing — a test that fails for a
 * reason that is not a defect is worse than no test.
 *
 * Embedded resources (`branch:branches(name)`) are skipped, because the
 * column belongs to the joined relation rather than this one. An
 * `alias:column` rename is resolved to `column`, which is the part the
 * database has to have.
 *
 * It runs in the `db` project because it needs a real schema to check
 * against, but it needs no seed data and no roles: `information_schema` is
 * the whole fixture.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('PostgREST column lists', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

/** Directories under `lib/` that talk to PostgREST. */
const SOURCE_DIRS = [
  'lib/data',
  'lib/auth',
  'lib/benefits',
  'lib/clients',
  'lib/guarantors',
  'lib/loans',
  'lib/member-loans',
  'lib/products',
  'lib/recovery',
  'lib/settings',
];

interface Reference {
  readonly file: string;
  readonly relation: string;
  readonly column: string;
}

/**
 * Pull `.from('x') … .select('a, b, c')` out of a source file.
 *
 * The `.select(` has to be the first one after the `.from(`, which is how
 * every read in this codebase is written. The gap between them is bounded so
 * that a `.from()` with no select nearby does not adopt the next query's
 * column list.
 */
function referencesIn(file: string, source: string): readonly Reference[] {
  const found: Reference[] = [];
  const chain =
    /\.from\(\s*'([a-z_0-9]+)'\s*\)(?![\s\S]{0,400}?\.from\()[\s\S]{0,400}?\.select\(\s*(`[^`]*`|'[^']*')/g;

  let match: RegExpExecArray | null;

  while ((match = chain.exec(source)) !== null) {
    const relation = match[1] ?? '';

    // Drop embedded resources — `guarantors(full_name, phone)` — whole.
    // Their columns belong to the joined relation, and splitting the list on
    // commas first would hand `phone` to the outer one.
    const list = (match[2] ?? '')
      .slice(1, -1)
      .replace(/[a-zA-Z_0-9!:.]+\s*\([^()]*\)/g, '');

    for (const raw of list.split(',')) {
      const entry = raw.trim();

      // Anything left holding a bracket is an embed this did not flatten.
      if (entry === '' || entry.includes('(') || entry.includes(')')) continue;

      // `alias:column` — the column is what the database must have.
      const column = (entry.includes(':') ? entry.split(':')[1] : entry)?.trim() ?? '';

      // `*`, a cast, or anything that is not a plain identifier.
      if (!/^[a-z_][a-z_0-9]*$/.test(column)) continue;

      found.push({ file, relation, column });
    }
  }

  return found;
}

describeDb('every PostgREST column this application reads', () => {
  it('names a relation and a column that exist', async () => {
    const columns = await query<{ table_name: string; column_name: string }>(
      `select table_name, column_name
         from information_schema.columns
        where table_schema = 'public'`,
    );

    const known = new Map<string, Set<string>>();
    for (const row of columns) {
      let set = known.get(row.table_name);
      if (set === undefined) {
        set = new Set<string>();
        known.set(row.table_name, set);
      }
      set.add(row.column_name);
    }

    const references: Reference[] = [];
    for (const dir of SOURCE_DIRS) {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.ts')) continue;
        references.push(
          ...referencesIn(`${dir}/${name}`, readFileSync(join(dir, name), 'utf8')),
        );
      }
    }

    // A guard on the guard: a refactor that moved these reads elsewhere would
    // otherwise leave this test passing while checking nothing.
    expect(references.length).toBeGreaterThan(200);

    const missing = [
      ...new Set(
        references
          .filter((reference) => {
            return known.get(reference.relation)?.has(reference.column) !== true;
          })
          .map(
            (reference) => `${reference.file}: ${reference.relation}.${reference.column}`,
          ),
      ),
    ].sort();

    expect(missing).toEqual([]);

    await closePool();
  });
});
