/**
 * Eager environment validation, for deployment pipelines.
 *
 * The application validates its configuration lazily, at the moment it first
 * needs it, so that `next build` succeeds in a CI job holding no credentials.
 * That is the right trade-off for a build, but it means a misconfigured
 * deployment would only fail when a user loaded a page.
 *
 * This script closes that gap: run it after deploying and before accepting
 * traffic, and it exits non-zero with every problem listed.
 *
 *   npm run check:env
 *
 * It prints variable NAMES and validation messages only, never a value, so it
 * is safe to run in a CI log.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { config as loadDotenv } from 'dotenv';

import { getAppEnvironment, inspectPublicEnv } from '../lib/env.public';

// Mirror Next.js's precedence: .env.local wins over .env.
//
// Loading these after the import is safe: lib/env.public.ts reads
// `process.env` inside its functions, not at module scope, so nothing has
// been captured yet.
for (const file of ['.env.local', '.env']) {
  const path = join(process.cwd(), file);
  if (existsSync(path)) loadDotenv({ path, quiet: true });
}

let failed = false;

console.log('Checking environment configuration\n');

// --- Public variables -------------------------------------------------------
const publicResult = inspectPublicEnv();

if (publicResult.ok) {
  console.log('  PASS  public variables');
} else {
  failed = true;
  console.log('  FAIL  public variables');
  for (const problem of publicResult.problems) {
    console.log(`          - ${problem}`);
  }
}

// --- Server-only variables --------------------------------------------------
//
// Read directly rather than through lib/env.server.ts: that module imports
// `server-only`, which throws outside a React Server Component context.
const secretKey = process.env.SUPABASE_SECRET_KEY?.trim();
const databaseUrl = process.env.DATABASE_URL?.trim();

if (secretKey === undefined || secretKey === '') {
  // Optional in Phase 1 — nothing uses the privileged client yet.
  console.log('  SKIP  SUPABASE_SECRET_KEY not set (optional; nothing requires it yet)');
} else if (secretKey.startsWith('sb_publishable_')) {
  failed = true;
  console.log('  FAIL  SUPABASE_SECRET_KEY holds a publishable key, not a secret key');
} else {
  console.log('  PASS  SUPABASE_SECRET_KEY is set');
}

if (databaseUrl === undefined || databaseUrl === '') {
  console.log('  SKIP  DATABASE_URL not set (needed only for local database tests)');
} else if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
  failed = true;
  console.log('  FAIL  DATABASE_URL is not a postgres:// or postgresql:// URL');
} else {
  console.log('  PASS  DATABASE_URL is set');
}

// --- The mistake that matters most -----------------------------------------
//
// A secret key behind a NEXT_PUBLIC_ prefix is inlined into the client bundle
// and shipped to every browser. It bypasses Row Level Security, so this is a
// total compromise of the database, not a degradation.
const leaked = Object.entries(process.env).filter(
  ([name, value]) =>
    name.startsWith('NEXT_PUBLIC_') && value?.includes('sb_secret_') === true,
);

if (leaked.length > 0) {
  failed = true;
  console.log('\n  FAIL  a secret key is exposed through a public variable:');
  for (const [name] of leaked) {
    console.log(`          - ${name} contains an sb_secret_ value`);
  }
  console.log(
    '\n        A NEXT_PUBLIC_ variable is inlined into the browser bundle. This key',
  );
  console.log(
    '        bypasses Row Level Security. Rotate it in the Supabase dashboard.',
  );
}

console.log(`\nEnvironment: ${getAppEnvironment()}`);

if (failed) {
  console.log('\nConfiguration is INVALID. See the failures above.');
  process.exit(1);
}

console.log('Configuration is valid.');
