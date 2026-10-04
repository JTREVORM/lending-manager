import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { METRIC_DEFINITIONS } from '@/lib/domain/reporting';

/**
 * The documentation and the code agree about what every figure means.
 *
 * §162 asks for every KPI to have a definition. `METRIC_DEFINITIONS` is where
 * they live — the cards render from it — and `docs/REPORTING.md` publishes the
 * same text. A definition that existed in only one of the two would be a
 * figure somebody could read two ways, which is the whole thing this phase is
 * trying to avoid.
 */
describe('reporting documentation', () => {
  const doc = readFileSync(join(process.cwd(), 'docs', 'REPORTING.md'), 'utf8');

  it('documents every metric the code defines', () => {
    const missing = Object.keys(METRIC_DEFINITIONS).filter(
      (key) => !doc.includes(`\`${key}\``),
    );

    expect(missing).toEqual([]);
  });

  it('publishes each definition verbatim, not a paraphrase', () => {
    // A paraphrase drifts. The table is generated from the same sentences the
    // cards show, so a change to one has to be a change to both.
    const drifted = Object.entries(METRIC_DEFINITIONS)
      .filter(([, metric]) => !doc.includes(metric.definition))
      .map(([key]) => key);

    expect(drifted).toEqual([]);
  });

  it('names the source of every metric', () => {
    const unsourced = Object.entries(METRIC_DEFINITIONS)
      .filter(([, metric]) => !doc.includes(metric.source))
      .map(([key]) => key);

    expect(unsourced).toEqual([]);
  });

  it('records the three terms the system will not use, and why', () => {
    expect(doc).toMatch(/## The terminology this system will not use/);
    expect(doc).toMatch(/\*\*Profit\.\*\*/);
    expect(doc).toMatch(/\*\*Cash at hand\.\*\*/);
    expect(doc).toMatch(/\*\*Wallet balance\.\*\*/);
  });

  it('states what was deliberately deferred', () => {
    // So a reader can tell a decision from an omission.
    expect(doc).toMatch(/### Deliberately deferred/);
    for (const deferred of ['Charts', 'Collection rate', 'As-at', 'PDF']) {
      expect(doc, deferred).toContain(deferred);
    }
  });

  it('carries the capability matrix and the per-report requirements', () => {
    for (const capability of [
      'reports:view_operational',
      'reports:view_financial',
      'reports:view_sensitive',
    ]) {
      expect(doc, capability).toContain(capability);
    }
  });
});
