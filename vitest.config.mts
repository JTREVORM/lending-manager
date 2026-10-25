import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * Three test projects, run separately because they need different
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
          exclude: ['tests/db/demo-seed.test.ts', 'tests/db/demo-borrower-reuse.test.ts'],
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
    ],
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      include: ['lib/**/*.ts', 'config/**/*.ts', 'components/**/*.tsx'],
      exclude: ['lib/supabase/**', 'lib/data/**', '**/*.d.ts'],
    },
  },
});
