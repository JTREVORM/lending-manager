import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'coverage/**',
      'out/**',
      'build/**',
      '.pglocal/**',
      'next-env.d.ts',
    ],
  },

  // Next.js recommended rules + core web vitals + jsx-a11y + typescript-eslint
  // (base/recommended). `core-web-vitals` already bundles `next/typescript`.
  ...nextCoreWebVitals,

  // Type-aware linting on top, for our own sources only.
  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [
      ...tseslint.configs.recommendedTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // `any` defeats the purpose of using TypeScript for a financial system.
      '@typescript-eslint/no-explicit-any': 'error',

      // An unhandled promise in money-handling code means silent data loss.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      // Assertions that paper over wrong types are how bad data gets written.
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',

      // Unused code is dead weight; `_`-prefixed bindings stay allowed.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      // `console` bypasses the redaction in lib/logger.ts.
      'no-console': 'error',

      // No legitimate use in this codebase.
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',

      // Guard the server/client boundary. These modules read secrets or hold a
      // privileged client; pulling either into a Client Component would ship
      // their contents to the browser. The `server-only` package catches this
      // at build time too — this rule fails faster and explains why.
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@/lib/env.server',
              message:
                'Server-only module. Read configuration in a Server Component, Server Action or Route Handler and pass plain values down.',
            },
            {
              name: '@/lib/supabase/admin',
              message:
                'Privileged server-only Supabase client. Never import this from client code.',
            },
          ],
        },
      ],
    },
  },

  // The server-only modules compose with each other. Each carries
  // `import 'server-only'`, which is the build-time guard that actually keeps
  // them out of the client bundle; the `no-restricted-imports` rule above is a
  // faster, friendlier signal for everything else. Exempting exactly these
  // files keeps the rule meaningful everywhere it matters.
  {
    files: [
      'lib/env.server.ts',
      'lib/supabase/admin.ts',
      'lib/supabase/server.ts',
      'lib/data/**/*.ts',
      // `'use server'` modules: Next.js compiles these for the server only,
      // and a Client Component importing one gets a network call rather than
      // the module. They are the sanctioned place to reach the privileged
      // client, which is why each use states its reason.
      'lib/auth/actions.ts',
      'lib/auth/admin-actions.ts',
      // Phase 3. Linking a client record to a portal login calls a
      // service_role-only database function, so this module reaches the
      // privileged client for that one operation and states its reason.
      'lib/clients/actions.ts',
      'lib/auth/context.ts',
      'lib/auth/guard.ts',
    ],
    rules: { 'no-restricted-imports': 'off' },
  },

  // types/database.types.ts mirrors the output of `supabase gen types
  // typescript`. Reformatting it to satisfy stylistic preferences would be
  // undone by the next regeneration, reintroducing the same errors, so the
  // generator's shape is preserved and these two rules are waived for it.
  // Type-safety rules still apply.
  {
    files: ['types/database.types.ts'],
    rules: {
      '@typescript-eslint/consistent-type-definitions': 'off',
      '@typescript-eslint/consistent-indexed-object-style': 'off',
    },
  },

  // Node-side tooling legitimately writes to stdout and reaches into env.
  {
    files: [
      'scripts/**/*.ts',
      'tests/**/*.ts',
      'tests/**/*.tsx',
      '*.config.ts',
      '*.config.mts',
    ],
    rules: {
      'no-console': 'off',
      'no-restricted-imports': 'off',
    },
  },

  // The logger is the single place allowed to touch `console`.
  {
    files: ['lib/logger.ts'],
    rules: { 'no-console': 'off' },
  },
);
