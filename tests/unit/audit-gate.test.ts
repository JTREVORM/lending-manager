/**
 * The dependency audit gate's exception rules.
 *
 * These tests are the reason the exception can be trusted: it is narrow, it
 * expires on its own, and it cannot be stretched to cover anything else.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  advisoryId,
  evaluateAudit,
  invalidReason,
  rootAdvisories,
  type AuditException,
  type AuditReport,
} from '@/scripts/audit-gate';

const PICOMATCH = 'GHSA-fc5q-39xc-vjpf';
const OTHER = 'GHSA-xxxx-xxxx-xxxx';

const exception: AuditException = {
  id: PICOMATCH,
  package: 'picomatch',
  severity: 'high',
  vulnerableRange: '<=4.0.7',
  scope: 'dev-only',
  approvedBy: 'Owner',
  approvedOn: '2026-11-18',
  expires: '2026-12-02',
  removeWhen: 'a patched release or the expiry',
  residualRisk: 'docs/POLYTOS-AUDIT-EXCEPTION-PICOMATCH.md',
};

function advisory(id: string, name: string, severity: string) {
  return {
    source: 1,
    name,
    title: `${name} advisory`,
    url: `https://github.com/advisories/${id}`,
    severity,
  };
}

/** What npm reports for the picomatch chain: one advisory, four dependents. */
function picomatchReport(extra: AuditReport['vulnerabilities'] = {}): AuditReport {
  return {
    vulnerabilities: {
      picomatch: { via: [advisory(PICOMATCH, 'picomatch', 'high')] },
      tinyglobby: { via: ['picomatch'] },
      vite: { via: ['picomatch', 'tinyglobby'] },
      vitest: { via: ['vite', 'tinyglobby'] },
      ...extra,
    },
  };
}

const base = {
  report: picomatchReport(),
  exceptions: [exception],
  today: '2026-11-18',
  scope: 'full' as const,
};

describe('rootAdvisories', () => {
  it('counts advisories, not the packages that inherit them', () => {
    const roots = rootAdvisories(picomatchReport());
    expect(roots.map((r) => r.id)).toEqual([PICOMATCH]);
  });

  it('reads the advisory identifier off the URL', () => {
    expect(advisoryId(`https://github.com/advisories/${PICOMATCH}`)).toBe(PICOMATCH);
    expect(advisoryId('https://example.com/not-an-advisory')).toBeNull();
    expect(advisoryId(undefined)).toBeNull();
  });
});

describe('the exception, while it is valid', () => {
  it('excuses exactly the named advisory and nothing else', () => {
    const result = evaluateAudit(base);
    expect(result.excepted.map((r) => r.id)).toEqual([PICOMATCH]);
    expect(result.blocking).toEqual([]);
    expect(result.problems).toEqual([]);
  });

  it('does not excuse a different high-severity advisory in the same tree', () => {
    const result = evaluateAudit({
      ...base,
      report: picomatchReport({
        somepkg: { via: [advisory(OTHER, 'somepkg', 'high')] },
      }),
    });
    expect(result.excepted.map((r) => r.id)).toEqual([PICOMATCH]);
    expect(result.blocking.map((r) => r.id)).toEqual([OTHER]);
  });

  it('keeps the threshold at high: a moderate advisory neither blocks nor needs an exception', () => {
    const result = evaluateAudit({
      ...base,
      report: picomatchReport({
        minimatch: { via: [advisory(OTHER, 'minimatch', 'moderate')] },
        'typescript-estree': { via: ['minimatch', 'tinyglobby'] },
      }),
    });
    expect(result.blocking).toEqual([]);
  });

  it('blocks a critical advisory', () => {
    const result = evaluateAudit({
      ...base,
      exceptions: [],
      report: { vulnerabilities: { x: { via: [advisory(OTHER, 'x', 'critical')] } } },
    });
    expect(result.blocking.map((r) => r.id)).toEqual([OTHER]);
  });

  it('with no exceptions at all, the picomatch advisory blocks', () => {
    const result = evaluateAudit({ ...base, exceptions: [] });
    expect(result.blocking.map((r) => r.id)).toEqual([PICOMATCH]);
  });
});

describe('expiry', () => {
  it('still applies the day before it expires', () => {
    const result = evaluateAudit({ ...base, today: '2026-12-01' });
    expect(result.blocking).toEqual([]);
    expect(result.problems).toEqual([]);
  });

  it('stops applying on the date itself, and the gate fails', () => {
    const result = evaluateAudit({ ...base, today: '2026-12-02' });
    expect(result.blocking.map((r) => r.id)).toEqual([PICOMATCH]);
    expect(result.problems.join(' ')).toMatch(/expired on 2026-12-02/);
  });

  it('stays failed after the date', () => {
    const result = evaluateAudit({ ...base, today: '2027-03-01' });
    expect(result.blocking.map((r) => r.id)).toEqual([PICOMATCH]);
  });
});

describe('removal', () => {
  it('fails when a version outside the vulnerable range has been published', () => {
    const result = evaluateAudit({
      ...base,
      published: { picomatch: ['4.0.6', '4.0.7', '4.0.8'] },
    });
    expect(result.problems.join(' ')).toMatch(/4\.0\.8 is outside <=4\.0\.7/);
    expect(result.excepted).toEqual([]);
    expect(result.blocking.map((r) => r.id)).toEqual([PICOMATCH]);
  });

  it('does not treat a prerelease as a verified patch', () => {
    const result = evaluateAudit({
      ...base,
      published: { picomatch: ['4.0.7', '4.1.0-alpha.1'] },
    });
    expect(result.problems).toEqual([]);
  });

  it('fails when the advisory is no longer reported, telling you to remove the entry', () => {
    const result = evaluateAudit({ ...base, report: { vulnerabilities: {} } });
    expect(result.problems.join(' ')).toMatch(/no longer reported.*Remove it/);
  });
});

describe('what an exception cannot do', () => {
  it('never applies to the production tree', () => {
    const result = evaluateAudit({ ...base, scope: 'prod' });
    expect(result.excepted).toEqual([]);
    expect(result.blocking.map((r) => r.id)).toEqual([PICOMATCH]);
  });

  it('does not survive the advisory being re-rated critical', () => {
    const result = evaluateAudit({
      ...base,
      report: {
        vulnerabilities: {
          picomatch: { via: [advisory(PICOMATCH, 'picomatch', 'critical')] },
        },
      },
    });
    expect(result.excepted).toEqual([]);
    expect(result.blocking.map((r) => r.id)).toEqual([PICOMATCH]);
  });

  it.each([
    ['a critical exception', { severity: 'critical' }],
    ['a non-dev scope', { scope: 'all' }],
    ['a non-GHSA identifier', { id: 'picomatch' }],
    ['an unparseable date', { expires: 'December' }],
    ['a range that is not <=X.Y.Z', { vulnerableRange: '*' }],
    ['no recorded approver', { approvedBy: ' ' }],
  ])('rejects %s', (_label, patch) => {
    const bad = { ...exception, ...patch };
    expect(invalidReason(bad)).not.toBeNull();
    const result = evaluateAudit({ ...base, exceptions: [bad] });
    expect(result.excepted).toEqual([]);
    expect(result.blocking.map((r) => r.id)).toEqual([PICOMATCH]);
  });
});

describe('the committed exception file', () => {
  const file = JSON.parse(readFileSync('security/audit-exceptions.json', 'utf8')) as {
    exceptions: AuditException[];
  };

  it('contains exactly the one approved exception', () => {
    expect(file.exceptions.map((e) => e.id)).toEqual([PICOMATCH]);
  });

  it('is well formed, high-only, dev-only and expires on 2026-12-02', () => {
    const [e] = file.exceptions;
    if (e === undefined) throw new Error('security/audit-exceptions.json has no entry');
    expect(invalidReason(e)).toBeNull();
    expect(e.severity).toBe('high');
    expect(e.scope).toBe('dev-only');
    expect(e.expires).toBe('2026-12-02');
  });
});
