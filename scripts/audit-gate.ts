#!/usr/bin/env tsx
/**
 * The dependency audit gate: `npm audit --audit-level=high`, plus a short list
 * of individually approved, expiring exceptions.
 *
 *   npx tsx scripts/audit-gate.ts [--scope full|prod]
 *
 * ## What it is not
 *
 * It does not turn auditing off, lower the threshold, or allowlist by package.
 * The threshold stays at **high**: any advisory of high or critical severity
 * that is not named in `security/audit-exceptions.json` fails the build, and
 * every exception names one advisory by its GHSA identifier.
 *
 * ## Why a script and not `--audit-level` or a package override
 *
 * `npm audit` has no way to waive one advisory. The two alternatives are worse:
 * lowering the level to `critical` would let every future high-severity
 * advisory through, and `npm audit fix --force` would downgrade the test
 * framework and the Next.js lint config to repair a vulnerability that has no
 * patched release at all.
 *
 * ## What an exception is bound by
 *
 *   - **Expiry.** On and after the `expires` date the exception stops applying
 *     and the gate fails. The date is read from the clock; there is no
 *     environment variable or flag that moves it.
 *   - **Severity.** Only a `high` advisory can be excepted. If the advisory is
 *     re-rated `critical`, the exception no longer applies.
 *   - **Scope.** `dev-only`: it applies to the full-tree run and never to
 *     `--scope prod`, which ignores the file entirely.
 *   - **Removal.** If the advisory is no longer reported, or a version outside
 *     its vulnerable range has been published, the gate fails and says to
 *     remove the entry. An exception cannot outlive the thing it excuses.
 *
 * Registry lookups for the removal check are best effort: if the registry
 * cannot be reached it warns and carries on, and the expiry remains the hard
 * backstop. `npm audit` itself failing to reach the registry fails closed.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

/** The severities that fail the build. Deliberately not configurable. */
export const BLOCKING_SEVERITIES: readonly string[] = ['high', 'critical'];

export interface AuditException {
  readonly id: string;
  readonly package: string;
  readonly cve?: string;
  readonly severity: string;
  readonly vulnerableRange: string;
  readonly scope: string;
  readonly approvedBy: string;
  readonly approvedOn: string;
  readonly expires: string;
  readonly removeWhen: string;
  readonly residualRisk: string;
}

export interface RootAdvisory {
  readonly id: string;
  readonly package: string;
  readonly severity: string;
  readonly title: string;
}

interface AuditVia {
  readonly source?: number;
  readonly name?: string;
  readonly title?: string;
  readonly url?: string;
  readonly severity?: string;
}

export interface AuditReport {
  readonly vulnerabilities?: Readonly<
    Record<string, { readonly via?: readonly (string | AuditVia)[] }>
  >;
}

export type Scope = 'full' | 'prod';

export interface Evaluation {
  /** Advisories at or above the threshold that nothing excuses. */
  readonly blocking: readonly RootAdvisory[];
  /** Advisories an unexpired, valid exception excuses. */
  readonly excepted: readonly RootAdvisory[];
  /** Why the gate fails besides `blocking`: expired, unused, patched, invalid. */
  readonly problems: readonly string[];
}

const GHSA = /^GHSA(-[2-9cfghjmpqrvwx]{4}){3}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The GHSA identifier at the end of an advisory URL, or null. */
export function advisoryId(url: string | undefined): string | null {
  if (url === undefined) return null;
  const last = url.split('/').pop() ?? '';
  return GHSA.test(last) ? last : null;
}

/**
 * Every advisory the report is built from. `npm audit` lists a vulnerable
 * package once per dependent, with severity carried upward, so the advisories
 * themselves are the objects in `via`; the strings are links between packages.
 * Severity is taken from the advisory, never from the package that inherits it.
 */
export function rootAdvisories(report: AuditReport): RootAdvisory[] {
  const found = new Map<string, RootAdvisory>();
  for (const node of Object.values(report.vulnerabilities ?? {})) {
    for (const via of node.via ?? []) {
      if (typeof via === 'string') continue;
      const id = advisoryId(via.url) ?? `source-${String(via.source ?? 'unknown')}`;
      if (!found.has(id)) {
        found.set(id, {
          id,
          package: via.name ?? 'unknown',
          severity: via.severity ?? 'unknown',
          title: via.title ?? '',
        });
      }
    }
  }
  return [...found.values()];
}

/** `<=X.Y.Z` is the only range form an exception may use. */
function upperBound(range: string): readonly [number, number, number] | null {
  const m = /^<=(\d+)\.(\d+)\.(\d+)$/.exec(range);
  return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])];
}

function above(version: string, bound: readonly [number, number, number]): boolean {
  if (version.includes('-')) return false; // a prerelease is not a verified patch
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (m === null) return false;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3])];
  for (let i = 0; i < 3; i += 1) {
    const [a, b] = [parts[i] ?? 0, bound[i] ?? 0];
    if (a !== b) return a > b;
  }
  return false;
}

/** Why one entry is malformed, or null if it is well formed. */
export function invalidReason(e: AuditException): string | null {
  if (!GHSA.test(e.id)) return `"${e.id}" is not a GHSA identifier`;
  if (e.package.trim() === '') return 'no package named';
  if (e.severity !== 'high') {
    return 'only a high-severity advisory can be excepted; critical never can';
  }
  if (e.scope !== 'dev-only') return `scope must be "dev-only", not "${e.scope}"`;
  if (!ISO_DATE.test(e.expires) || Number.isNaN(Date.parse(e.expires))) {
    return `expires "${e.expires}" is not a YYYY-MM-DD date`;
  }
  if (upperBound(e.vulnerableRange) === null) {
    return `vulnerableRange "${e.vulnerableRange}" must have the form <=X.Y.Z`;
  }
  for (const field of [e.approvedBy, e.approvedOn, e.removeWhen, e.residualRisk]) {
    if (field.trim() === '')
      return 'approvedBy, approvedOn, removeWhen and residualRisk are required';
  }
  return null;
}

export interface EvaluateInput {
  readonly report: AuditReport;
  readonly exceptions: readonly AuditException[];
  /** `YYYY-MM-DD`, from the clock. */
  readonly today: string;
  readonly scope: Scope;
  /** Every published version, by package, where the registry could be asked. */
  readonly published?: Readonly<Record<string, readonly string[]>>;
}

export function evaluateAudit(input: EvaluateInput): Evaluation {
  const roots = rootAdvisories(input.report);
  const problems: string[] = [];
  const usable = new Map<string, AuditException>();

  // Production dependencies are never excepted, and the file is not even read
  // for them: an entry cannot mention a package that ships.
  if (input.scope === 'full') {
    for (const e of input.exceptions) {
      const invalid = invalidReason(e);
      if (invalid !== null) {
        problems.push(`Exception ${e.id} is invalid: ${invalid}.`);
        continue;
      }
      if (input.today >= e.expires) {
        problems.push(
          `Exception ${e.id} (${e.package}) expired on ${e.expires}. ` +
            `Upgrade, or have the Owner approve a new date in security/audit-exceptions.json.`,
        );
        continue;
      }
      const bound = upperBound(e.vulnerableRange);
      const patched =
        bound === null
          ? []
          : (input.published?.[e.package] ?? []).filter((v) => above(v, bound));
      if (patched.length > 0) {
        problems.push(
          `Exception ${e.id}: ${e.package} ${patched.slice(-3).join(', ')} is outside ` +
            `${e.vulnerableRange}. A patch exists: upgrade, then remove this exception.`,
        );
        continue;
      }
      const reported = roots.find((r) => r.id === e.id);
      if (reported === undefined) {
        problems.push(
          `Exception ${e.id} (${e.package}) is no longer reported by npm audit. ` +
            `Remove it from security/audit-exceptions.json.`,
        );
        continue;
      }
      if (reported.severity !== 'high') {
        problems.push(
          `Exception ${e.id} covers a high advisory, but npm audit now rates it ` +
            `${reported.severity}. It no longer applies.`,
        );
        continue;
      }
      usable.set(e.id, e);
    }
  }

  const blocking: RootAdvisory[] = [];
  const excepted: RootAdvisory[] = [];
  for (const root of roots) {
    if (!BLOCKING_SEVERITIES.includes(root.severity)) continue;
    (usable.has(root.id) ? excepted : blocking).push(root);
  }
  return { blocking, excepted, problems };
}

// ---------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------
function npmJson(args: readonly string[]): unknown {
  const run = spawnSync('npm', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  // `npm audit` exits non-zero whenever it finds anything; the JSON on stdout
  // is the answer either way.
  return JSON.parse(run.stdout) as unknown;
}

function main(): number {
  const scopeArg = process.argv.indexOf('--scope');
  const scope: Scope =
    process.argv[scopeArg + 1] === 'prod' && scopeArg > -1 ? 'prod' : 'full';

  let report: AuditReport & { error?: unknown };
  try {
    report = npmJson(
      scope === 'prod' ? ['audit', '--omit=dev', '--json'] : ['audit', '--json'],
    ) as AuditReport & { error?: unknown };
  } catch (error) {
    console.error('npm audit produced no readable report; failing closed.', error);
    return 2;
  }
  if (report.error !== undefined) {
    console.error('npm audit could not complete; failing closed.', report.error);
    return 2;
  }

  const file = JSON.parse(readFileSync('security/audit-exceptions.json', 'utf8')) as {
    exceptions: AuditException[];
  };

  const published: Record<string, string[]> = {};
  if (scope === 'full') {
    for (const e of file.exceptions) {
      try {
        published[e.package] = npmJson([
          'view',
          e.package,
          'versions',
          '--json',
        ]) as string[];
      } catch {
        console.warn(
          `warning: could not ask the registry whether ${e.package} has a patched release; ` +
            `the expiry date is the only backstop for ${e.id}.`,
        );
      }
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const result = evaluateAudit({
    report,
    exceptions: file.exceptions,
    today,
    scope,
    published,
  });

  console.log(`npm audit, ${scope} tree, threshold high (${today}).`);
  for (const r of result.excepted) {
    const e = file.exceptions.find((x) => x.id === r.id);
    console.log(
      `  ACCEPTED  ${r.id}  ${r.package}  [${r.severity}]  expires ${e?.expires ?? '?'}  ${r.title}`,
    );
  }
  for (const r of result.blocking) {
    console.error(`  BLOCKING  ${r.id}  ${r.package}  [${r.severity}]  ${r.title}`);
  }
  for (const p of result.problems) console.error(`  PROBLEM   ${p}`);

  if (result.blocking.length > 0 || result.problems.length > 0) {
    console.error('Dependency audit gate: FAIL');
    return 1;
  }
  console.log(
    result.excepted.length > 0
      ? 'Dependency audit gate: PASS, with the accepted exception above.'
      : 'Dependency audit gate: PASS, no exceptions in use.',
  );
  return 0;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exit(main());
}
