import { render, screen } from '@testing-library/react';
import { globSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  DataTable,
  NotRecorded,
  NotTotalled,
  TABLE_COLUMN_WIDTHS,
  TableCell,
  TableHead,
  TableLead,
  TableRow,
} from '@/components/ui/data-table';

/**
 * The shared table layer, and the defect it exists to prevent.
 *
 * Fourteen registers each wrote their own `<table class="w-full">` with
 * `whitespace-nowrap` on the header cells and nothing on the body cells.
 * Under auto layout that does not overflow — it compresses whichever column
 * compresses most, which is always a borrower's name or a product's, and the
 * data wraps while the headings hold their width.
 *
 * These tests are written against the rendered DOM rather than the source,
 * because the failure was visual. Each one names the property that, if it
 * stopped holding, would bring the squeeze back.
 */

function table(): HTMLElement {
  return screen.getByRole('table');
}

describe('the table shell', () => {
  it('scrolls inside itself rather than widening the page', () => {
    render(
      <DataTable caption="Loan register">
        <tbody>
          <TableRow>
            <TableCell>x</TableCell>
          </TableRow>
        </tbody>
      </DataTable>,
    );

    const shell = screen.getByRole('region', { name: 'Loan register' });
    expect(shell.className).toContain('scroll-area');
    expect(shell.className).toContain('scroll-x');
  });

  it('lets a keyboard reach the scroller, and says what it is', () => {
    // A box that scrolls and cannot be focused cannot be scrolled from a
    // keyboard at all — axe's `scrollable-region-focusable`. A focusable box
    // that has no name is announced as "group", which is no better.
    render(
      <DataTable caption="Payment register">
        <tbody>
          <TableRow>
            <TableCell>x</TableCell>
          </TableRow>
        </tbody>
      </DataTable>,
    );

    const shell = screen.getByRole('region', { name: 'Payment register' });
    expect(shell.getAttribute('tabindex')).toBe('0');
  });

  it('carries a caption, for a reader who navigates to the table directly', () => {
    render(
      <DataTable caption="Client directory">
        <tbody>
          <TableRow>
            <TableCell>x</TableCell>
          </TableRow>
        </tbody>
      </DataTable>,
    );

    expect(screen.getByText('Client directory').tagName.toLowerCase()).toBe('caption');
  });

  it('sizes columns to their content rather than dividing the container', () => {
    // `table-auto` is the half of the fix that lets the table grow past its
    // wrapper. `table-fixed`, or auto layout with no minimums, is the squeeze.
    render(
      <DataTable caption="Register">
        <tbody>
          <TableRow>
            <TableCell>x</TableCell>
          </TableRow>
        </tbody>
      </DataTable>,
    );

    expect(table().className).toContain('table-auto');
  });

  it('sets a readable density by default and a dense one on request', () => {
    // Three densities had grown by accident — registers at 14px, the shell
    // at 11px, reports at 11px. Two, chosen per table, is the whole scale:
    // 13px for a register read all day, 11px for an eighteen-column report.
    // A register that did not opt in must not silently shrink.
    const { unmount } = render(
      <DataTable caption="A">
        <tbody>
          <TableRow>
            <TableCell>x</TableCell>
          </TableRow>
        </tbody>
      </DataTable>,
    );
    expect(table().getAttribute('data-density')).toBe('comfortable');
    expect(table().className).toContain('text-[13px]');
    unmount();

    render(
      <DataTable caption="B" density="compact">
        <tbody>
          <TableRow>
            <TableCell>x</TableCell>
          </TableRow>
        </tbody>
      </DataTable>,
    );
    expect(table().getAttribute('data-density')).toBe('compact');
    expect(table().className).toContain('text-[11px]');
  });

  it('only marks a header sticky when there is a box for it to stick in', () => {
    // An element with `overflow-x: auto` computes `overflow-y` to `auto` too,
    // so a sticky header inside a wrapper that only scrolls sideways is
    // clipped to a box that never scrolls vertically. Bounding the height is
    // what makes it work, and the attribute should not claim otherwise.
    const { unmount } = render(
      <DataTable caption="Unbounded" stickyHeader>
        <tbody>
          <TableRow>
            <TableCell>x</TableCell>
          </TableRow>
        </tbody>
      </DataTable>,
    );
    expect(table().getAttribute('data-sticky-header')).toBeNull();
    unmount();

    render(
      <DataTable caption="Bounded" stickyHeader maxHeight="40rem">
        <tbody>
          <TableRow>
            <TableCell>x</TableCell>
          </TableRow>
        </tbody>
      </DataTable>,
    );
    expect(table().getAttribute('data-sticky-header')).toBe('');
  });
});

describe('a column', () => {
  it('cannot be squeezed below the floor its kind needs', () => {
    render(
      <DataTable caption="Register">
        <thead>
          <tr>
            <TableHead width="name">Client</TableHead>
          </tr>
        </thead>
        <tbody>
          <TableRow>
            <TableCell width="name">Nakabugo Ssemakula Nabukeera</TableCell>
          </TableRow>
        </tbody>
      </DataTable>,
    );

    const expected = `${String(TABLE_COLUMN_WIDTHS.name)}px`;
    expect(screen.getByRole('columnheader').style.minWidth).toBe(expected);
    expect(screen.getByRole('cell').style.minWidth).toBe(expected);
  });

  it('gives a name more room than a date, and prose more than either', () => {
    // The scale is only useful if it is ordered the way the content is.
    expect(TABLE_COLUMN_WIDTHS.name).toBeGreaterThan(TABLE_COLUMN_WIDTHS.date);
    expect(TABLE_COLUMN_WIDTHS.prose).toBeGreaterThan(TABLE_COLUMN_WIDTHS.name);
    expect(TABLE_COLUMN_WIDTHS.money).toBeGreaterThan(TABLE_COLUMN_WIDTHS.count);
  });

  it('keeps a body cell on one line unless it asks to wrap', () => {
    // The defect exactly: headers held their width, body cells did not.
    render(
      <DataTable caption="Register">
        <tbody>
          <TableRow>
            <TableCell>UGX 123,456,789</TableCell>
          </TableRow>
        </tbody>
      </DataTable>,
    );

    expect(screen.getByRole('cell').className).toContain('whitespace-nowrap');
  });

  it('stops a clamped value at two lines and keeps the whole of it reachable', () => {
    render(
      <DataTable caption="Register">
        <tbody>
          <TableRow>
            <TableCell wrap="clamp" title="Nakabugo Ssemakula Nabukeera">
              Nakabugo Ssemakula Nabukeera
            </TableCell>
          </TableRow>
        </tbody>
      </DataTable>,
    );

    const cell = screen.getByRole('cell');
    expect(cell.className).not.toContain('whitespace-nowrap');
    expect(cell.getAttribute('title')).toBe('Nakabugo Ssemakula Nabukeera');
    expect(cell.querySelector('.line-clamp-2')).toBeTruthy();
  });

  it('right-aligns a numeric column with tabular figures', () => {
    // A column of amounts only lines up on the thousands separator if the
    // digits are one width. Stated by the component so a column cannot
    // forget it.
    render(
      <DataTable caption="Register">
        <tbody>
          <TableRow>
            <TableCell align="numeric">1,250,000</TableCell>
          </TableRow>
        </tbody>
      </DataTable>,
    );

    const cell = screen.getByRole('cell');
    expect(cell.className).toContain('text-right');
    expect(cell.className).toContain('tabular');
  });

  it('marks a dropped column so the print sheet can bring it back', () => {
    // A sheet of A4 is narrower than every breakpoint, so without the marker
    // a printed register would silently be missing its columns.
    render(
      <DataTable caption="Register">
        <thead>
          <tr>
            <TableHead width="rate" hideBelow="xl">
              Rate
            </TableHead>
          </tr>
        </thead>
        <tbody>
          <TableRow>
            <TableCell width="rate" hideBelow="xl">
              24%
            </TableCell>
          </TableRow>
        </tbody>
      </DataTable>,
    );

    expect(screen.getByRole('columnheader').getAttribute('data-hide-below')).toBe('xl');
    expect(screen.getByRole('cell').getAttribute('data-hide-below')).toBe('xl');
  });
});

describe('absence, zero and no-total are three different statements', () => {
  it('says "not recorded" out loud rather than only drawing a dash', () => {
    render(<NotRecorded />);
    expect(screen.getByLabelText('Not recorded')).toBeTruthy();
  });

  it('says why a totals cell has no total, instead of leaving it blank', () => {
    // A blank cell under a column of bold figures reads as a zero.
    render(<NotTotalled />);
    const marker = screen.getByLabelText('Not totalled');
    expect(marker.getAttribute('title')).toContain('running balance');
  });
});

describe('TableLead', () => {
  it('clamps the name, never the identifier beneath it', () => {
    // An identifier split across two lines stops being an identifier.
    const { container } = render(
      <TableLead primary="Nakabugo Ssemakula Nabukeera" secondary="CL2600007" />,
    );

    const name = screen.getByTitle('Nakabugo Ssemakula Nabukeera');
    expect(name.className).toContain('line-clamp-2');

    const identifier = screen.getByText('CL2600007');
    expect(identifier.className).toContain('whitespace-nowrap');
    expect(container.textContent).toContain('CL2600007');
  });
});

describe('no screen writes its own table any more', () => {
  it('leaves the shared components as the only `<table>` in the app', () => {
    // The whole point. A table written by hand is a table that has not been
    // given column floors, a focusable scroller or a caption, and every one
    // of the fourteen that existed had lost at least one of the three.
    const sources = globSync('{app,components}/**/*.tsx', {
      exclude: (path) => path.includes('node_modules'),
    });

    const allowed = new Set([
      // The shared shell itself.
      'components/ui/data-table.tsx',
      // The report table, which is the same contract for a different shape:
      // column hints from the field set that the PDF and CSV also read.
      'components/reports/report-table.tsx',
      // A chart's visually hidden table of its own rows, so no figure is
      // available only as a picture.
      'components/charts/magnitude-chart.tsx',
    ]);

    const offenders = sources
      .map((path) => path.replaceAll('\\', '/'))
      .filter((path) => !allowed.has(path))
      .filter((path) => readFileSync(path, 'utf8').includes('<table'));

    expect(offenders).toEqual([]);
  });
});
