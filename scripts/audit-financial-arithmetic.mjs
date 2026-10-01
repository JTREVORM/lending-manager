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

    for (const [pattern, label] of UNSAFE) {
      if (pattern.test(line)) {
        findings.push({ path, line: index + 1, label, text: trimmed.slice(0, 80) });
      }
    }
  });
}

for (const file of FINANCIAL_FILES) scan(file);

const migrations = readdirSync('supabase/migrations')
  .filter((name) => name.startsWith('20261004') && name.endsWith('.sql'))
  .map((name) => join('supabase/migrations', name));

for (const file of migrations) scan(file);

// --- The money.ts exclusion, verified ---------------------------------------
const engine = readFileSync('lib/domain/loan.ts', 'utf8');
const importBlock = /import\s*\{([^}]*)\}\s*from\s*'@\/lib\/domain\/money'/.exec(engine);

if (importBlock === null) {
  findings.push({
    path: 'lib/domain/loan.ts',
    line: 0,
    label: 'no recognisable money import — the audit cannot verify what it uses',
    text: '',
  });
} else {
  const imported = importBlock[1]
    .split(',')
    .map((name) => name.replace(/\btype\b/, '').trim())
    .filter((name) => name !== '');

  for (const name of imported) {
    if (!PERMITTED_MONEY_IMPORTS.has(name)) {
      findings.push({
        path: 'lib/domain/loan.ts',
        line: 0,
        label: `reaches \`${name}\` in the money layer, which this audit has not cleared as integer-only`,
        text: '',
      });
    }
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
console.log('  the loan engine reaches only integer/BigInt money helpers');
console.log('  scanner verified against a positive control');
