#!/usr/bin/env node
/**
 * Audit the loan arithmetic for floating-point hazards.
 *
 * `0.15 * 200_000` is 30000.000000000004 in IEEE 754. Across a three-period
 * loan that is invisible; across a year of posted payments it is a ledger that
 * does not balance. So the loan path is held to integer and `BigInt`
 * arithmetic only, and this checks that mechanically rather than by review.
 *
 * Run as part of the verification sweep:  node scripts/audit-financial-arithmetic.mjs
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

/**
 * The files that compute or carry loan money.
 *
 * `lib/domain/money.ts` is deliberately **not** here. It is Phase 1's money
 * layer and contains one float-tolerant escape hatch — `roundToShilling`,
 * which takes an arbitrary number and therefore uses `Math.round` for its
 * half-up mode. That function exists for callers who genuinely hold a
 * non-integer, and the loan engine is not one of them: it reaches money only
 * through `applyRateBps`, `divideEvenly`, `sumUgx` and `toUgx`, all of which
 * are `BigInt` or integer throughout.
 *
 * That is asserted below rather than assumed, so the exclusion cannot quietly
 * become a hole.
 */
const FINANCIAL_FILES = [
  'lib/domain/loan.ts',
  'lib/validation/loan.ts',
  'lib/loans/actions.ts',
  'lib/data/loans.ts',
  // Phase 5. The schedule allocates contractual money across collection
  // dates, so it is held to the same standard as the engine that produced it.
  'lib/domain/repayment-schedule.ts',
  'lib/data/schedules.ts',
  // The screens that render money. They only format, but a `toFixed` here
  // would show a borrower a different figure from the one on record.
  'components/loans/loan-breakdown-table.tsx',
  'components/loans/repayment-schedule-table.tsx',
  'components/loans/schedule-summary.tsx',
];

const UNSAFE = [
  [/\*\s*0\.\d+/, 'a float-literal rate (e.g. `* 0.15`)'],
  [/\bparseFloat\b/, 'parseFloat'],
  [/Number\.parseFloat/, 'Number.parseFloat'],
  [/\/\s*100(?:\.0)?\b(?!\d)/, 'a decimal division by 100'],
  [/\bMath\.round\(/, 'Math.round on money'],
  [/\bMath\.(?:floor|ceil)\((?![^)]*length)/, 'Math.floor/ceil on money'],
  [/::\s*(?:float|double|real)/, 'a float cast in SQL'],
  [/\btoFixed\(/, 'toFixed'],
];

/** The money helpers the loan engine is permitted to reach. */
const PERMITTED_MONEY_IMPORTS = new Set([
  'applyRateBps',
  'divideEvenly',
  'sumUgx',
  'toUgx',
  'formatUgx',
  'MAX_UGX_AMOUNT',
  'UgxAmount',
]);

/**
 * Integer arithmetic on **counts and calendar dates**, which the money
 * patterns above cannot tell apart from arithmetic on amounts.
 *
 * Each entry is a specific expression with the reason it is not a money
 * hazard. The list is verified below: an entry that no longer appears in its
 * file fails the audit, so an exemption cannot outlive the line it was
 * written for and quietly cover something new.
 */
const ACKNOWLEDGED = [
  {
    path: 'lib/domain/repayment-schedule.ts',
    snippet: 'Math.floor(totalDays / intervalDays)',
    reason:
      'how many collection dates fit in the term — a count of days, not an amount. ' +
      'Every amount in this file goes through divideEvenly, which is BigInt.',
  },
];

const findings = [];

function scan(path) {
  const text = readFileSync(path, 'utf8');

  text.split('\n').forEach((line, index) => {
    const trimmed = line.trim();

    // Comments explain the hazard; they are not the hazard.
    if (
      trimmed.startsWith('*') ||
      trimmed.startsWith('//') ||
      trimmed.startsWith('--') ||
      trimmed.startsWith('/*')
    ) {
      return;
    }

    const cleared = ACKNOWLEDGED.some(
      (entry) => entry.path === path && line.includes(entry.snippet),
    );

    if (cleared) return;

    for (const [pattern, label] of UNSAFE) {
      if (pattern.test(line)) {
        findings.push({ path, line: index + 1, label, text: trimmed.slice(0, 80) });
      }
    }
  });
}

for (const file of FINANCIAL_FILES) scan(file);

const migrations = readdirSync('supabase/migrations')
  .filter(
    (name) =>
      (name.startsWith('20261004') || name.startsWith('20261005')) &&
      name.endsWith('.sql'),
  )
  .map((name) => join('supabase/migrations', name));

for (const file of migrations) scan(file);

// --- The money.ts exclusion, verified ---------------------------------------
// Both engines: the Phase 4 loan calculation and the Phase 5 schedule
// allocation. Each must reach the money layer only through helpers this audit
// has cleared as integer or BigInt throughout.
for (const enginePath of ['lib/domain/loan.ts', 'lib/domain/repayment-schedule.ts']) {
  const engine = readFileSync(enginePath, 'utf8');
  const importBlock = /import\s*\{([^}]*)\}\s*from\s*'@\/lib\/domain\/money'/.exec(
    engine,
  );

  if (importBlock === null) {
    findings.push({
      path: enginePath,
      line: 0,
      label: 'no recognisable money import — the audit cannot verify what it uses',
      text: '',
    });
    continue;
  }

  const imported = importBlock[1]
    .split(',')
    .map((name) => name.replace(/\btype\b/, '').trim())
    .filter((name) => name !== '');

  for (const name of imported) {
    if (!PERMITTED_MONEY_IMPORTS.has(name)) {
      findings.push({
        path: enginePath,
        line: 0,
        label: `reaches \`${name}\` in the money layer, which this audit has not cleared as integer-only`,
        text: '',
      });
    }
  }
}

// --- Every acknowledged exemption still describes a real line --------------
// Without this an exemption outlives the code it was written for, and the next
// `Math.floor` on that file passes unexamined.
for (const entry of ACKNOWLEDGED) {
  if (!readFileSync(entry.path, 'utf8').includes(entry.snippet)) {
    findings.push({
      path: entry.path,
      line: 0,
      label: `stale exemption: \`${entry.snippet}\` is no longer in this file`,
      text: '',
    });
  }
}

// --- A positive control, so "clean" is never "the scanner is broken" --------
const CONTROL = 'const interest = principal * 0.15;';
if (!UNSAFE.some(([pattern]) => pattern.test(CONTROL))) {
  console.error('  the scanner failed its own positive control');
  process.exit(2);
}

if (findings.length > 0) {
  console.error('Floating-point hazards in the loan arithmetic:\n');
  for (const finding of findings) {
    console.error(`  ${finding.path}:${finding.line}  ${finding.label}`);
    if (finding.text !== '') console.error(`    ${finding.text}`);
  }
  process.exit(1);
}

const count = FINANCIAL_FILES.length + migrations.length;
console.log(`  ${String(count)} financial files scanned, no hazard found`);
console.log('  both engines reach only integer/BigInt money helpers');
console.log(
  `  ${String(ACKNOWLEDGED.length)} acknowledged non-money exemption(s), each verified present`,
);
console.log('  scanner verified against a positive control');
