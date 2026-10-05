import { render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { MagnitudeChart } from '@/components/charts/magnitude-chart';

/**
 * The charts Phase 9 introduced.
 *
 * §17 asks for four things of every chart: the values must match the report
 * exactly, an accessible text or table equivalent must exist, the axis must
 * not mislead, and no financial calculation may live in chart code. Each is
 * asserted below, because each is a way a picture can lie about money while
 * looking perfectly reasonable.
 */

const ROWS = [
  { label: '1 Oct 2026', value: 41_636, note: '2 payments' },
  { label: '2 Oct 2026', value: 341_006, note: '5 payments' },
  { label: '3 Oct 2026', value: 41_637, note: '2 payments' },
  { label: '4 Oct 2026', value: 219_322, note: '6 payments' },
];

const source = readFileSync(
  join(process.cwd(), 'components/charts/magnitude-chart.tsx'),
  'utf8',
);

describe('the magnitude chart', () => {
  it('draws exactly the values it was given', () => {
    render(
      <MagnitudeChart
        title="Collected, by day"
        caption="Money received each day."
        valueHeading="Collected"
        format="money"
        rows={ROWS}
      />,
    );

    for (const row of ROWS) {
      // Once in the picture, once in the table. Both are the report's figure.
      expect(
        screen.getAllByText(row.value.toLocaleString('en-UG')).length,
      ).toBeGreaterThan(0);
    }
  });

  it('carries a table of the same rows', () => {
    // §17. Nothing may be available only as a picture.
    render(
      <MagnitudeChart
        title="Collected, by day"
        caption="Money received each day."
        valueHeading="Collected"
        format="money"
        rows={ROWS}
      />,
    );

    const table = screen.getByRole('table');
    expect(within(table).getByText('Collected')).toBeInTheDocument();

    for (const row of ROWS) {
      expect(within(table).getByText(new RegExp(row.label))).toBeInTheDocument();
    }
  });

  it('hides the drawn bars from assistive technology', () => {
    // The bars say nothing a screen reader can use, and the table beside them
    // says it properly. Two readings of the same rows would be read twice.
    const { container } = render(
      <MagnitudeChart
        title="t"
        caption="c"
        valueHeading="v"
        format="count"
        rows={ROWS}
      />,
    );

    expect(container.querySelector('ul[aria-hidden="true"]')).not.toBeNull();
  });

  it('scales every bar from the same zero baseline', () => {
    // A truncated axis is the classic way to make a chart lie. The widest bar
    // is 100% and a bar of half the value is half the width — so the picture
    // is proportional to the figure, not to the gap between figures.
    const { container } = render(
      <MagnitudeChart
        title="t"
        caption="c"
        valueHeading="v"
        format="count"
        rows={[
          { label: 'full', value: 100 },
          { label: 'half', value: 50 },
          { label: 'none', value: 0 },
        ]}
      />,
    );

    const widths = Array.from(container.querySelectorAll('[style*="width"]')).map(
      (element) => (element as HTMLElement).style.width,
    );

    expect(widths).toEqual(['100%', '50%', '0%']);
  });

  it('draws nothing rather than dividing by zero when every row is empty', () => {
    const { container } = render(
      <MagnitudeChart
        title="t"
        caption="c"
        valueHeading="v"
        format="count"
        rows={[
          { label: 'a', value: 0 },
          { label: 'b', value: 0 },
        ]}
      />,
    );

    const widths = Array.from(container.querySelectorAll('[style*="width"]')).map(
      (element) => (element as HTMLElement).style.width,
    );

    expect(widths).toEqual(['0%', '0%']);
  });

  it('says so when there is nothing to draw', () => {
    render(
      <MagnitudeChart
        title="t"
        caption="c"
        valueHeading="v"
        format="count"
        rows={[]}
        empty="Nothing is behind."
      />,
    );

    expect(screen.getByText('Nothing is behind.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('renders money through the shared primitive', () => {
    render(
      <MagnitudeChart
        title="t"
        caption="c"
        valueHeading="v"
        format="money"
        rows={[{ label: 'a', value: 1_250_000 }]}
      />,
    );

    expect(document.querySelectorAll('[data-money]').length).toBeGreaterThan(0);
  });

  it('never puts sr-only on the table element itself', () => {
    // `sr-only` hides by shrinking to 1px and clipping with
    // `overflow: hidden`, and `overflow` has no effect on `display: table`. A
    // table wearing `sr-only` lays itself out at full width and — being
    // absolutely positioned — drags the page sideways with it: 390px of phone
    // showed 617px of document. The wrapper is a block, which clips.
    expect(source).not.toMatch(/<table[^>]*className="[^"]*sr-only/);
    expect(source).toContain('<div className="sr-only print:not-sr-only">');
  });

  it('keeps the table reachable to a screen reader and in print', () => {
    render(
      <MagnitudeChart
        title="t"
        caption="A caption."
        valueHeading="Loans"
        format="count"
        rows={ROWS}
      />,
    );

    // Hidden visually, not hidden from assistive technology: `sr-only` is not
    // `display: none`, and the wrapper carries no `aria-hidden`.
    const table = screen.getByRole('table');
    expect(table).toBeInTheDocument();
    expect(table.closest('[aria-hidden="true"]')).toBeNull();
  });

  it('computes no money of its own', () => {
    // §17. The one rule. The component works out widths; the query works out
    // figures. A chart that summed its own rows could disagree with the table
    // beside it, and the table is the authority.
    for (const forbidden of [
      'toFixed(',
      'Math.round',
      'parseFloat',
      'reduce((sum',
      '+ row.value',
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });

  it('uses one hue rather than a categorical palette', () => {
    // The project's own `success` and `warning` separate by ΔE 5.8 under
    // protanopia — below the floor at which colour may carry meaning at all,
    // even with labels. One hue has no such failure mode, and identity comes
    // from the row label.
    for (const forbidden of ['bg-success', 'bg-warning', 'bg-danger', 'bg-info']) {
      expect(source, forbidden).not.toContain(forbidden);
    }

    expect(source).toContain('bg-accent');
  });

  it('labels every bar in words, so colour is never the only channel', () => {
    render(
      <MagnitudeChart
        title="t"
        caption="c"
        valueHeading="v"
        format="count"
        rows={[{ label: 'Penalty due', value: 2 }]}
      />,
    );

    expect(screen.getAllByText(/Penalty due/).length).toBeGreaterThan(0);
  });
});

describe('where the charts are used', () => {
  it('draws the collections chart from the rows the table renders', () => {
    // Parity, at the only place it can be asserted without a browser: the
    // chart and the table are handed the same array.
    const view = readFileSync(
      join(process.cwd(), 'components/reports/collection-report-view.tsx'),
      'utf8',
    );

    expect(view).toContain('rows={report.byDay.map(');
    expect(view).toContain('rows={report.byDay}');
    expect(view).toContain('value: row.collected');
  });

  it('draws the delinquency chart from the counts the summary renders', () => {
    const view = readFileSync(
      join(process.cwd(), 'components/delinquency/overdue-list.tsx'),
      'utf8',
    );

    for (const state of [
      'counts.penalty_due',
      'counts.expired_unpaid',
      'counts.grace_period',
      'counts.in_arrears',
    ]) {
      // Each count appears twice: once in the summary, once in the chart.
      expect(view.split(state).length - 1, state).toBeGreaterThanOrEqual(2);
    }
  });

  it('adds no chart library to the bundle', () => {
    // §94. A bar is a div with a width. Pulling in a charting package for two
    // charts would be a large dependency for a small need.
    const manifest = JSON.parse(
      readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };

    for (const library of ['recharts', 'chart.js', 'd3', 'victory', 'nivo', 'echarts']) {
      expect(Object.keys(manifest.dependencies ?? {}), library).not.toContain(library);
    }
  });
});
