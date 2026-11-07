import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * Five test projects, run separately because they need different
 * environments and different prerequisites:
 *
 *   unit         Pure logic — money, rates, dates, phone numbers, validation,
 *                permissions, logging. No database, no DOM. Fast enough to run
 *                on every save.
 *
 *   integration  Component rendering in jsdom, plus checks that cross module
 *                boundaries. No database.
 *
 *   db           Real PostgreSQL. Verifies the migrations apply to a clean
 *                database and that the schema behaves — constraints,
 *                triggers, RLS, grants, concurrency. Requires DATABASE_URL;
 *                see `npm run db:local:setup`.
 *
 *   seed         The demonstration seeder, run for real, twice. Its own
 *                project rather than a file in `db`, because the property it
 *                proves is about a *clean* database and because the data it
 *                writes is global: it publishes a policy version, and only
 *                one version may be in force, so every membership suite that
 *                publishes its own would collide with it. A project gets its
 *                own `globalSetup`, which rebuilds the database first — so
 *                the seeder meets the empty database it is specified
 *                against, and leaves nothing behind for anything else.
 *
 *   seed-reuse   The same seeder against a database that already holds a loan
 *                book, with borrower reuse opted in.
 *
 *   seed-member-loans
 *                The Phase 3 member loan demonstration, which needs a
 *                database of its own for two reasons: it publishes policy
 *                version 998.0 as the *only* version in force, and borrower
 *                reuse needs a database the synthetic seeder has never
 *                touched.
 *
 * `npm run test:run` runs unit + integration, so it needs no database and is
 * the gate for CI. `npm run test:db` runs the database suite, then the
 * seeder's.
 */
export default defineConfig({
  plugins: [react()],
  // Resolves the `@/*` alias from tsconfig.json natively, so the paths are
  // declared in exactly one place.
  resolve: { tsconfigPaths: true },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/unit/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          environment: 'jsdom',
          setupFiles: ['./tests/helpers/setup-dom.ts'],
          include: ['tests/integration/**/*.test.{ts,tsx}'],
        },
      },
      {
        extends: true,
        test: {
          name: 'db',
          environment: 'node',
          include: ['tests/db/**/*.test.ts'],
          // Rebuilds the database from the migrations first, so every run
          // starts identical and re-proves that the migrations apply to an
          // empty database.
          globalSetup: ['./tests/helpers/db-global-setup.ts'],
          // Schema assertions query the catalogue repeatedly, and the
          // concurrency tests depend on controlling who else is writing.
          fileParallelism: false,
          testTimeout: 30_000,
          // Each seeder suite has a project of its own; see their headers.
          // So does the agency foundation suite, for the same kind of reason:
          // it commits a second branch, and a second branch is global state.
          // `money-movement.test.ts` and `ledger-posting.test.ts` read
          // `branch_cash_position` with `queryOne`, which requires exactly one
          // row — so leaving it in this project made those two pass or fail on
          // file ordering alone. It did pass locally and failed in CI, which is
          // the definition of the problem rather than bad luck.
          exclude: [
            'tests/db/demo-seed.test.ts',
            'tests/db/demo-borrower-reuse.test.ts',
            'tests/db/member-loan-demo-seed.test.ts',
            'tests/db/benefit-demo-seed.test.ts',
            'tests/db/agency-foundation.test.ts',
            'tests/db/agency-transaction-engine.test.ts',
            'tests/db/agency-security-closure.test.ts',
          ],
        },
      },
      {
        extends: true,
        test: {
          name: 'agency',
          environment: 'node',
          include: ['tests/db/agency-foundation.test.ts'],
          // Its own database, rebuilt from the migrations, because this suite
          // commits fixtures the rest of the database suite can see: a second
          // branch, a confirmed provider, and the float tills provisioned
          // against both. None of it can be cleaned up afterwards either —
          // `agency_provider_float_accounts` is append-only by trigger and
          // every reference to a branch is ON DELETE RESTRICT, which is the
          // schema behaving correctly.
          //
          // Keeping it here rather than in `db` is what makes the suite
          // honest: it needs two branches to prove that one branch cannot
          // reach the other's till, and it must not make another file's
          // single-branch assumption false to get them.
          globalSetup: ['./tests/helpers/db-global-setup.ts'],
          fileParallelism: false,
          testTimeout: 30_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'agency-engine',
          environment: 'node',
          include: ['tests/db/agency-transaction-engine.test.ts'],
          // Its own database again, and for a stronger reason than the
          // foundation suite's: this one posts real journals. It funds float
          // and a till and then moves money through them, so any suite that
          // asserts a cash position, a trial balance or a ledger total would
          // be reading a book this one had written to. Sharing a database
          // would make those suites depend on file ordering, which is the
          // failure the foundation suite already hit once.
          globalSetup: ['./tests/helpers/db-global-setup.ts'],
          fileParallelism: false,
          testTimeout: 60_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'agency-security',
          environment: 'node',
          include: ['tests/db/agency-security-closure.test.ts'],
          // Its own database, for the reason the other two agency projects
          // have one, and one more besides: this suite stages real races on
          // two open connections and commits them in a chosen order. A suite
          // sharing the database would see balances mid-race.
          globalSetup: ['./tests/helpers/db-global-setup.ts'],
          fileParallelism: false,
          testTimeout: 90_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'agency-settlement',
          environment: 'node',
          include: ['tests/db/agency-settlement.test.ts'],
          // Its own database, like the other agency projects: this suite posts
          // real settlements and stages races on two connections, so a suite
          // sharing the database would read a book this one wrote to.
          globalSetup: ['./tests/helpers/db-global-setup.ts'],
          fileParallelism: false,
          testTimeout: 120_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'seed',
          environment: 'node',
          include: ['tests/db/demo-seed.test.ts'],
          globalSetup: ['./tests/helpers/db-global-setup.ts'],
          fileParallelism: false,
          // The seeder runs three times inside this suite, each a child
          // process applying a dated deposit history, so the budget is wider
          // than the database suite's.
          testTimeout: 180_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'seed-reuse',
          environment: 'node',
          include: ['tests/db/demo-borrower-reuse.test.ts'],
          globalSetup: ['./tests/helpers/db-global-setup.ts'],
          fileParallelism: false,
          // Borrower reuse needs a database the synthetic seeder has never
          // touched: once the six scenario fee and deposit keys are spent on
          // synthetic clients, reuse correctly refuses to remap them. Hence a
          // separate project with its own rebuild rather than another file in
          // the `seed` one.
          //
          // It also builds a loan book first — two borrowers driven all the
          // way to disbursement — and then runs the seeder four times, so the
          // budget is wider again.
          testTimeout: 300_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'seed-member-loans',
          environment: 'node',
          include: ['tests/db/member-loan-demo-seed.test.ts'],
          globalSetup: ['./tests/helpers/db-global-setup.ts'],
          fileParallelism: false,
          // The member loan demonstration publishes policy version 998.0 and
          // requires it to be the only version in force: a savings account is
          // frozen to the version it was opened under, so a second published
          // version would supersede the first and silently un-qualify every
          // account opened under it. Every membership suite in the `db`
          // project publishes its own version, and `seed` publishes 999.0, so
          // this needs a rebuild nobody else has written to.
          //
          // It builds a loan book first as well, and then runs the seeder
          // five times — three for the fixed point, two for the refusals — so
          // it gets the widest budget of the five projects.
          testTimeout: 400_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'seed-benefits',
          environment: 'node',
          include: ['tests/db/benefit-demo-seed.test.ts'],
          globalSetup: ['./tests/helpers/db-global-setup.ts'],
          fileParallelism: false,
          // Polytos Phase 4. The benefit demonstration publishes policy
          // version 997.0 and requires it to be the only version in force,
          // for the reason `seed-member-loans` does: a savings account is
          // frozen to the version it was opened under, so a second published
          // version supersedes the first and silently un-qualifies every
          // account opened under it. It also back-dates the demonstration
          // memberships, which no other suite expects.
          //
          // It runs the seeder six times — three for the fixed point, three
          // for the refusals — each a child process, so it gets a budget as
          // wide as the member-loan suite's.
          testTimeout: 400_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      include: ['lib/**/*.ts', 'config/**/*.ts', 'components/**/*.tsx'],
      exclude: ['lib/supabase/**', 'lib/data/**', '**/*.d.ts'],
    },
  },
});
