import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NAV_ITEMS } from '@/components/layout/nav-items';
import { PrimaryNav, isNavItemActive } from '@/components/layout/primary-nav';
import { PhasePlaceholder } from '@/components/layout/phase-placeholder';
import { ROUTES } from '@/config/app';

// `usePathname` needs a router context that does not exist in a bare jsdom
// render, so it is stubbed per test to drive the active-state logic.
const mockPathname = vi.hoisted(() => ({ current: '/' }));

vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname.current,
}));

beforeEach(() => {
  mockPathname.current = '/';
});

describe('navigation items', () => {
  it('covers every canonical route exactly once', () => {
    const hrefs = NAV_ITEMS.map((item) => item.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);

    for (const route of Object.values(ROUTES)) {
      expect(hrefs).toContain(route);
    }
  });

  it('gives each item a label, a short label and a phase', () => {
    for (const item of NAV_ITEMS) {
      expect(item.label.trim()).not.toBe('');
      expect(item.shortLabel.trim()).not.toBe('');
      expect(item.phase).toBeGreaterThanOrEqual(1);
    }
  });

  it('keeps mobile labels short enough for a five-item bottom bar', () => {
    // At 320px each tab has roughly 60px; a long label would wrap or clip.
    for (const item of NAV_ITEMS) {
      expect(item.shortLabel.length, item.shortLabel).toBeLessThanOrEqual(8);
    }
  });
});

describe('isNavItemActive', () => {
  it('matches the dashboard only at the root', () => {
    // The dashboard lives at '/', so a prefix match would light it up on every
    // page.
    expect(isNavItemActive(ROUTES.dashboard, ROUTES.dashboard)).toBe(true);
    expect(isNavItemActive(ROUTES.dashboard, ROUTES.loans)).toBe(false);
    expect(isNavItemActive(ROUTES.dashboard, '/clients/abc')).toBe(false);
  });

  it('matches a section and its detail pages', () => {
    expect(isNavItemActive(ROUTES.clients, ROUTES.clients)).toBe(true);
    expect(
      isNavItemActive(
        ROUTES.clients,
        `${ROUTES.clients}/0f8fad5b-d9cb-469f-a165-70867728950e`,
      ),
    ).toBe(true);
  });

  it('does not match a sibling route that merely shares a prefix', () => {
    expect(isNavItemActive(ROUTES.clients, '/clients-archive')).toBe(false);
  });

  it('does not match an unrelated route', () => {
    expect(isNavItemActive(ROUTES.clients, ROUTES.loans)).toBe(false);
  });
});

describe('PrimaryNav', () => {
  it('marks the current page with aria-current, not only a colour', () => {
    mockPathname.current = ROUTES.clients;
    render(<PrimaryNav variant="sidebar" />);

    expect(screen.getByRole('link', { name: 'Clients' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('link', { name: 'Loans' })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('marks exactly one item as current', () => {
    mockPathname.current = ROUTES.loans;
    render(<PrimaryNav variant="sidebar" />);

    const current = screen
      .getAllByRole('link')
      .filter((link) => link.getAttribute('aria-current') === 'page');

    expect(current).toHaveLength(1);
    expect(current[0]).toHaveAccessibleName('Loans');
  });

  it('renders every nav item as a link, since each changes the page', () => {
    mockPathname.current = ROUTES.dashboard;
    render(<PrimaryNav variant="sidebar" />);

    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(NAV_ITEMS.length);

    for (const item of NAV_ITEMS) {
      expect(
        links.some((link) => link.getAttribute('href') === item.href),
        item.href,
      ).toBe(true);
    }
  });

  it('uses the short labels in the bottom bar and keeps the touch target', () => {
    mockPathname.current = ROUTES.dashboard;
    render(<PrimaryNav variant="bottom-bar" />);

    const home = screen.getByRole('link', { name: 'Home' });
    expect(home.className).toContain('min-h-touch');
    expect(home).toHaveAttribute('aria-current', 'page');
  });

  it('keeps a section active on its detail pages', () => {
    mockPathname.current = `${ROUTES.clients}/0f8fad5b-d9cb-469f-a165-70867728950e`;
    render(<PrimaryNav variant="sidebar" />);

    expect(screen.getByRole('link', { name: 'Clients' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
});

describe('PhasePlaceholder', () => {
  it('states plainly that the section is not built, and when it will be', () => {
    render(
      <PhasePlaceholder
        title="Loans"
        phase={3}
        summary="Loan origination arrives with Phase 3."
        planned={['Create a loan', 'Generate a schedule']}
      />,
    );

    expect(screen.getByRole('heading', { level: 1, name: 'Loans' })).toBeInTheDocument();
    expect(screen.getByText('Planned for Phase 3')).toBeInTheDocument();
    expect(screen.getByText('Not available yet')).toBeInTheDocument();
  });

  it('lists what is planned, so expectations are concrete', () => {
    render(
      <PhasePlaceholder
        title="Payments"
        phase={4}
        summary="Payments arrive with Phase 4."
        planned={['Record a cash payment', 'Issue a receipt number']}
      />,
    );

    expect(screen.getByText('Record a cash payment')).toBeInTheDocument();
    expect(screen.getByText('Issue a receipt number')).toBeInTheDocument();
  });
});
