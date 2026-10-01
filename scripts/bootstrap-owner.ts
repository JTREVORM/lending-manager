/**
 * Create the first Owner/Administrator.
 *
 * ## The chicken-and-egg problem
 *
 * Creating a staff account requires `users:create`, which comes from a role,
 * which must be granted by somebody who already holds `users:assign_role`. On
 * an empty database nobody holds anything, so the first Owner cannot be made
 * through the application. Something outside the permission system has to do
 * it once.
 *
 * This is that thing. It runs on a developer's or operator's machine, uses the
 * secret key, and is the only path in the system that creates authority from
 * nothing.
 *
 * ## Safety
 *
 *   - **It refuses to run twice.** If any active `owner_admin` already exists
 *     it stops without changing anything. Re-running it after a deploy is a
 *     no-op, not a second Owner nobody expected.
 *   - **No password is hard-coded.** It is read from `BOOTSTRAP_OWNER_PASSWORD`
 *     or generated. Either way it is printed once, to the operator's terminal,
 *     and never written to a file, a log or the database.
 *   - **The account must change it immediately.** `must_change_password` is
 *     set, so the first thing the new Owner can do is choose their own.
 *   - **It needs the secret key**, which only exists on a trusted machine. It
 *     cannot be triggered from a browser.
 *
 * ## Usage
 *
 *     export NEXT_PUBLIC_SUPABASE_URL=...
 *     export NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=...
 *     export SUPABASE_SECRET_KEY=...            # never commit this
 *     npm run bootstrap:owner -- --name "Jane Doe" --phone 0772123456
 *
 * Give the printed password to the person face to face, then have them sign in
 * and change it.
 */

import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { config as loadDotenv } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

import { authEmailForPhone } from '../lib/auth/identity';
import { normalizeUgandanPhone } from '../lib/domain/phone';
import { MIN_PASSWORD_LENGTH } from '../lib/validation/auth';
import type { Database } from '../types/database.types';

for (const file of ['.env.local', '.env']) {
  const path = join(process.cwd(), file);
  if (existsSync(path)) loadDotenv({ path, quiet: true });
}

interface Options {
  readonly name: string;
  readonly phone: string;
  readonly email: string | null;
  readonly password: string;
}

function fail(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

function parseArgs(): Options {
  const argv = process.argv.slice(2);
  const read = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };

  const name = read('--name');
  const phone = read('--phone');
  const email = read('--email') ?? null;

  if (name === undefined || name.trim() === '') {
    fail(
      'Missing --name. Usage: npm run bootstrap:owner -- --name "Jane Doe" --phone 0772123456',
    );
  }
  if (phone === undefined || phone.trim() === '') {
    fail(
      'Missing --phone. Usage: npm run bootstrap:owner -- --name "Jane Doe" --phone 0772123456',
    );
  }

  let canonicalPhone: string;
  try {
    canonicalPhone = normalizeUgandanPhone(phone);
  } catch (error) {
    fail(error instanceof Error ? error.message : 'Invalid phone number.');
  }

  // Supplied by the operator, or generated. A generated one is 32 hex
  // characters from a cryptographic source — long enough that it does not
  // matter if it is briefly on a terminal.
  const supplied = process.env.BOOTSTRAP_OWNER_PASSWORD?.trim();

  if (supplied !== undefined && supplied.length < MIN_PASSWORD_LENGTH) {
    fail(
      `BOOTSTRAP_OWNER_PASSWORD must be at least ${String(MIN_PASSWORD_LENGTH)} characters.`,
    );
  }

  return {
    name: name.trim(),
    phone: canonicalPhone,
    email: email === null || email.trim() === '' ? null : email.trim().toLowerCase(),
    password: supplied ?? randomBytes(16).toString('hex'),
  };
}

async function main(): Promise<void> {
  const options = parseArgs();

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const secretKey = process.env.SUPABASE_SECRET_KEY?.trim();

  if (url === undefined || url === '') {
    fail('NEXT_PUBLIC_SUPABASE_URL is not set.');
  }
  if (secretKey === undefined || secretKey === '') {
    fail(
      'SUPABASE_SECRET_KEY is not set. The first Owner can only be created with the secret key, from a trusted machine.',
    );
  }
  if (secretKey.startsWith('sb_publishable_')) {
    fail('SUPABASE_SECRET_KEY holds a publishable key. The secret key is required.');
  }

  const admin = createClient<Database>(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  console.log('\nBootstrapping the first Owner/Administrator\n');

  // --- Refuse to run twice -------------------------------------------------
  const { data: existing, error: existingError } = await admin
    .from('user_roles')
    .select('profile_id, profiles!inner(status)')
    .eq('role_key', 'owner_admin')
    .eq('profiles.status', 'active');

  if (existingError !== null) {
    fail(`Could not check for an existing Owner: ${existingError.message}`);
  }

  if ((existing ?? []).length > 0) {
    console.log(
      `  An active Owner/Administrator already exists (${String((existing ?? []).length)}).`,
    );
    console.log('  Nothing has been changed.\n');
    console.log(
      '  To add another Owner, sign in as the existing one and use the Users screen.\n',
    );
    process.exit(0);
  }

  // --- The profile ---------------------------------------------------------
  const { data: profile, error: profileError } = await admin
    .from('profiles')
    .insert({
      full_name: options.name,
      phone: options.phone,
      email: options.email,
      status: 'active',
      must_change_password: true,
      password_set_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (profileError !== null) {
    fail(`Could not create the profile: ${profileError.message}`);
  }

  // --- The login -----------------------------------------------------------
  const authEmail = authEmailForPhone(options.phone);

  const { data: created, error: authError } = await admin.auth.admin.createUser({
    email: authEmail,
    password: options.password,
    email_confirm: true,
  });

  if (authError !== null || created.user === null) {
    await admin.from('profiles').delete().eq('id', profile.id);
    fail(`Could not create the login: ${authError?.message ?? 'unknown error'}`);
  }

  const { error: linkError } = await admin
    .from('profiles')
    .update({ auth_user_id: created.user.id })
    .eq('id', profile.id);

  if (linkError !== null) {
    await admin.auth.admin.deleteUser(created.user.id);
    await admin.from('profiles').delete().eq('id', profile.id);
    fail(`Could not link the login to the profile: ${linkError.message}`);
  }

  // --- The role ------------------------------------------------------------
  const { error: roleError } = await admin
    .from('user_roles')
    .insert({ profile_id: profile.id, role_key: 'owner_admin' });

  if (roleError !== null) {
    await admin.auth.admin.deleteUser(created.user.id);
    await admin.from('profiles').delete().eq('id', profile.id);
    fail(`Could not grant the owner_admin role: ${roleError.message}`);
  }

  console.log('  Owner/Administrator created.\n');
  console.log(`    Name           ${options.name}`);
  console.log(`    Signs in with  ${options.phone}`);
  console.log(`    Temporary password\n`);
  console.log(`        ${options.password}\n`);
  console.log('  This password is shown once and is not stored anywhere in plain text.');
  console.log('  Give it to them in person. They must change it at first sign-in.\n');
}

main().catch((error: unknown) => {
  console.error('\n  Bootstrap failed.');
  console.error(`  ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
