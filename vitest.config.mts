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
 * `npm run test:run` runs unit + integration, so it needs no database and is
 * the gate for CI. `npm run test:db` runs the database suite.
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
