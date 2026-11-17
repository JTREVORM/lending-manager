/**
 * Server actions return the user-facing message, not the developer one.
 *
 * `lib/errors.ts` is explicit about the split: `message` "is the
 * developer-facing description and may contain detail; it is logged but never
 * returned to a client", and `userMessage` "is what the UI shows". Nineteen
 * handlers in `lib/finance/actions.ts` returned the first one.
 *
 * It was not theoretical. L7 was filed because a Manager who banked cash and
 * then tried to clear it was told **"Privilege denied on record."** That is
 * not `AuthorizationError`'s `userMessage` — which reads "You do not have
 * permission to do this." — it is its `message`, verbatim, resource label
 * and all. Half of that defect was the error class and half was the field.
 *
 * Asserted against the source rather than by calling each action, because
 * every one of the nineteen needs a live Supabase client and a failing RPC to
 * reach its catch block. A scanner over the file is cheap, total, and fails
 * for the right reason — the repository already takes this approach for money
 * arithmetic in `npm run audit:money`.
 *
 * Repo-wide, over `lib/` and `app/`, because the whole repository is now
 * clean: 19 occurrences in `lib/finance/actions.ts` and 56 more across
 * eleven other modules — benefits 17, meetings 8, savings 7, membership 7,
 * products 7, settings 3, payments 2, member loans 2, agency 1,
 * policy update 1, and one data module. Seventy-five in all.
 *
 * A scoped version of this test would be the weaker thing to leave behind.
 * The defect was never about finance: it was one habit, repeated in every
 * module that catches a database error, and a guard that covers one file
 * invites the next module to repeat it.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { mapDatabaseError } from '@/lib/db-errors';

const FINANCE = join(process.cwd(), 'lib/finance/actions.ts');

/** Every TypeScript source under `lib/` and `app/`. */
function sourceFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (/\.tsx?$/.test(entry)) {
        found.push(full);
      }
    }
  };
  walk(root);
  return found;
}

describe('no server action returns a developer error message', () => {
  it('nothing under lib/ or app/ reads `.message` off a mapped database error', () => {
    // `.message` on a mapped database error is the developer sentence:
    // "Privilege denied on record.", "Foreign key violated on transfer.",
    // "Unique constraint violated on client." None of those is written for
    // somebody standing at a counter.
    //
    // Five different variable names were in use — `error`, `ownerError`,
    // `assessmentError`, `insertion.error`, `response.error` — which is part
    // of why the habit went unnoticed for so long. The pattern below does not
    // care which.
    const offenders: string[] = [];
    for (const file of [
      ...sourceFiles(join(process.cwd(), 'lib')),
      ...sourceFiles(join(process.cwd(), 'app')),
    ]) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/mapDatabaseError\([^)]*\)\.message/g)) {
        offenders.push(`${file.replace(process.cwd(), '.')}: ${match[0]}`);
      }
    }

    expect(offenders, 'use .userMessage, or project through toPublicError').toEqual([]);
  });

  describe('lib/finance/actions.ts, where this was found', () => {
    const source = readFileSync(FINANCE, 'utf8');

    it('still maps every database failure rather than swallowing it', () => {
      // The counterpart assertion. Removing the offending calls by deleting the
      // error handling would also satisfy the test above, and would be much
      // worse: a failed RPC would report success. There are nineteen handlers
      // and each must still map its error.
      const mapped = [...source.matchAll(/mapDatabaseError\(/g)];

      // Nineteen call sites plus the import.
      expect(mapped.length).toBeGreaterThanOrEqual(19);
      expect(source).toContain("import { mapDatabaseError } from '@/lib/db-errors';");
    });

    it('changes no business-rule sentence, which is why this is safe', () => {
      // The property that makes this a safe change rather than a risky one.
      //
      // Every deliberate business rule in the schema raises `P0001`, and a
      // CHECK or exclusion violation raises `23514`/`23P01`. All three map to
      // `BusinessRuleError`, which — alone among the subclasses — sets
      // `userMessage` to its own `message`, because business-rule messages are
      // written for staff.
      //
      // So for exactly the errors that carry a financial rule, the two fields
      // are the same string and switching between them is a no-op. Decision A's
      // refusals, the guarantor ceiling, the no-unfunded-payouts trigger: none
      // of them says anything different to an officer after this change.
      //
      // What changes is the errors that were never meant to be shown raw —
      // privilege, conflict, foreign key, not-found, transient database — and
      // for those the developer sentence was the wrong one all along.
      for (const code of ['P0001', '23514', '23P01']) {
        const mapped = mapDatabaseError({ code }, 'deposit');
        expect(mapped.userMessage, `SQLSTATE ${code}`).toBe(mapped.message);
      }

      // And the counter-examples, where the two differ and `userMessage` is the
      // one a person should read.
      for (const code of ['42501', '23505', '23503', 'P0002']) {
        const mapped = mapDatabaseError({ code }, 'deposit');
        expect(mapped.userMessage, `SQLSTATE ${code}`).not.toBe(mapped.message);
      }
    });

    it('every mapped failure is returned as a refusal, not as a success', () => {
      // `ok: false` must accompany each one. A handler that returned
      // `ok: true` with a mapped error message would be the quiet half-success
      // this module's own comments say it exists to avoid.
      const returns = [...source.matchAll(/return \{[^}]*mapDatabaseError\([^}]*\}/g)];

      expect(returns.length).toBeGreaterThanOrEqual(19);
      for (const [fragment] of returns) {
        expect(fragment, fragment.slice(0, 80)).toContain('ok: false');
      }
    });
  });
});
