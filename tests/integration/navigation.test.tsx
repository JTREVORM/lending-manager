import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  NAV_ITEMS,
  PORTAL_NAV_ITEMS,
  visibleNavItems,
} from '@/components/layout/nav-items';
import { PhasePlaceholder } from '@/components/layout/phase-placeholder';
import { PrimaryNav, isNavItemActive } from '@/components/layout/primary-nav';
import { ROUTES } from '@/config/app';
import { permissionForPath } from '@/lib/auth/routing';
import { ROLE_PERMISSIONS, type RoleKey } from '@/lib/permissions';

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
  it('points every entry at a canonical route', () => {
    const routes = new Set<string>(Object.values(ROUTES));

    for (const item of [...NAV_ITEMS, ...PORTAL_NAV_ITEMS]) {
      expect(routes.has(item.href), item.href).toBe(true);
    }
  });

  it('lists no route twice within a menu', () => {
    for (const [label, items] of [
      ['staff', NAV_ITEMS],
      ['portal', PORTAL_NAV_ITEMS],
    ] as const) {
      const hrefs = items.map((item) => item.href);
      expect(new Set(hrefs).size, label).toBe(hrefs.length);
    }
  });

  it('gives each item a label, a short label and a phase', () => {
    for (const item of [...NAV_ITEMS, ...PORTAL_NAV_ITEMS]) {
      expect(item.label.trim()).not.toBe('');
      expect(item.shortLabel.trim()).not.toBe('');
      expect(item.phase).toBeGreaterThanOrEqual(1);
    }
  });

  it('keeps mobile labels short enough for a bottom bar', () => {
    // At 320px each tab has roughly 45px once the staff menu is full; a long
    // label would wrap or clip.
    for (const item of [...NAV_ITEMS, ...PORTAL_NAV_ITEMS]) {
      expect(item.shortLabel.length, item.shortLabel).toBeLessThanOrEqual(8);
    }
  });

  /**
   * The failure this guards against: a menu entry hidden from a role while the
   * route behind it stays reachable by typing the URL. Both read the same map,
   * and this asserts they agree.
   */
  it('requires the same capability the route guard requires', () => {
    for (const item of [...NAV_ITEMS, ...PORTAL_NAV_ITEMS]) {
      expect(permissionForPath(item.href), item.href).toBe(item.permission);
    }
  });
});

describe('what each role sees in the menu', () => {
  const visibleFor = (role: RoleKey, items = NAV_ITEMS) =>
    visibleNavItems(items, ROLE_PERMISSIONS[role]).map((item) => item.href);

  it('shows an owner every staff section', () => {
    const visible = visibleFor('owner_admin');

    expect(visible).toContain(ROUTES.users);
    expect(visible).toContain(ROUTES.audit);
    expect(visible).toContain(ROUTES.settings);
    expect(visible).toContain(ROUTES.dashboard);
  });

  it('shows a manager the directory but not administration or the audit trail', () => {
    const visible = visibleFor('manager');

    expect(visible).toContain(ROUTES.users);
    expect(visible).not.toContain(ROUTES.audit);
    expect(visible).toContain(ROUTES.settings);
  });

  it('shows a secretary/treasurer no user administration and no audit trail', () => {
    const visible = visibleFor('secretary_treasurer');

    expect(visible).not.toContain(ROUTES.users);
    expect(visible).not.toContain(ROUTES.audit);
    expect(visible).toContain(ROUTES.dashboard);
    expect(visible).toContain(ROUTES.account);
  });

  it('shows every staff role the reporting section', () => {
    // `reports:view_operational` is the floor, and every staff role holds it.
    // What differs is which reports open inside, which the pages decide.
    for (const role of ['secretary_treasurer', 'manager', 'owner_admin'] as const) {
      expect(visibleFor(role), role).toContain(ROUTES.reports);
    }
  });

  it('shows a client nothing from the staff menu', () => {
    // A borrower should never be offered a staff surface, even one that would
    // be refused on arrival.
    const visible = visibleFor('client');

    for (const route of [
      ROUTES.dashboard,
      ROUTES.users,
      ROUTES.audit,
      ROUTES.settings,
      ROUTES.clients,
      ROUTES.loans,
      ROUTES.payments,
    ]) {
      expect(visible, route).not.toContain(route);
    }

    // Only their own account, which every signed-in user may see.
    expect(visible).toEqual([ROUTES.account]);
  });

  it('shows a client the portal menu', () => {
    const visible = visibleFor('client', PORTAL_NAV_ITEMS);

    expect(visible).toContain(ROUTES.portal);
    expect(visible).toContain(ROUTES.account);
  });

  it('shows staff nothing in the portal menu beyond their account', () => {
    for (const role of ['secretary_treasurer', 'manager', 'owner_admin'] as const) {
      expect(visibleFor(role, PORTAL_NAV_ITEMS), role).toEqual([ROUTES.account]);
    }
  });

  it('shows nothing at all without any capability', () => {
    expect(visibleNavItems(NAV_ITEMS, [])).toEqual([]);
  });
});

describe('isNavItemActive', () => {
  it('matches the dashboard only at the root', () => {
    expect(isNavItemActive(ROUTES.dashboard, ROUTES.dashboard)).toBe(true);
    expect(isNavItemActive(ROUTES.dashboard, ROUTES.users)).toBe(false);
    expect(isNavItemActive(ROUTES.dashboard, '/clients/abc')).toBe(false);
  });

  it('matches a section and its detail pages', () => {
    expect(isNavItemActive(ROUTES.users, ROUTES.users)).toBe(true);
    expect(isNavItemActive(ROUTES.users, `${ROUTES.users}/0f8fad5b`)).toBe(true);
  });

  it('does not match a sibling route that merely shares a prefix', () => {
    expect(isNavItemActive(ROUTES.clients, '/clients-archive')).toBe(false);
  });
});

describe('PrimaryNav', () => {
  const OWNER = ROLE_PERMISSIONS.owner_admin;

  it('marks the current page with aria-current, not only a colour', () => {
    mockPathname.current = ROUTES.users;
    render(<PrimaryNav variant="sidebar" menu="staff" permissions={OWNER} />);

    expect(screen.getByRole('link', { name: 'Users' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('link', { name: 'Dashboard' })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('marks exactly one item as current', () => {
    mockPathname.current = ROUTES.audit;
    render(<PrimaryNav variant="sidebar" menu="staff" permissions={OWNER} />);

    const current = screen
      .getAllByRole('link')
      .filter((link) => link.getAttribute('aria-current') === 'page');

    expect(current).toHaveLength(1);
    expect(current[0]).toHaveAccessibleName('Audit trail');
  });

  it('renders only the entries the viewer may use', () => {
    mockPathname.current = ROUTES.dashboard;
    render(
      <PrimaryNav
        variant="sidebar"
        menu="staff"
        permissions={ROLE_PERMISSIONS.secretary_treasurer}
      />,
    );

    expect(screen.queryByRole('link', { name: 'Users' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Audit trail' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Dashboard' })).toBeInTheDocument();
  });

  it('renders every entry as a link, since each changes the page', () => {
    mockPathname.current = ROUTES.dashboard;
    render(<PrimaryNav variant="sidebar" menu="staff" permissions={OWNER} />);

    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(visibleNavItems(NAV_ITEMS, OWNER).length);
  });

  it('uses the short labels in the bottom bar and keeps the touch target', () => {
    mockPathname.current = ROUTES.dashboard;
    render(<PrimaryNav variant="bottom-bar" menu="staff" permissions={OWNER} />);

    const home = screen.getByRole('link', { name: 'Home' });
    expect(home.className).toContain('min-h-touch');
    expect(home).toHaveAttribute('aria-current', 'page');
  });

  it('keeps a section active on its detail pages', () => {
    mockPathname.current = `${ROUTES.users}/0f8fad5b-d9cb-469f-a165-70867728950e`;
    render(<PrimaryNav variant="sidebar" menu="staff" permissions={OWNER} />);

    expect(screen.getByRole('link', { name: 'Users' })).toHaveAttribute(
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
        phase={4}
        summary="Loan origination arrives with Phase 4."
        planned={['Create a loan', 'Generate a schedule']}
      />,
    );

    expect(screen.getByRole('heading', { level: 1, name: 'Loans' })).toBeInTheDocument();
    expect(screen.getByText('Planned for Phase 4')).toBeInTheDocument();
    expect(screen.getByText('Not available yet')).toBeInTheDocument();
    expect(screen.getByText('Create a loan')).toBeInTheDocument();
  });
});

/**
 * The server/client boundary around the menu.
 *
 * A Lucide icon is a React component, and a React component **cannot be passed
 * as a prop from a Server Component to a Client Component**: React Server
 * Components refuses it at render time with "Functions cannot be passed
 * directly to Client Components", and the error takes down the whole page.
 *
 * The shells are Server Components and `PrimaryNav` is a Client Component, so
 * the menu has to be named across the boundary and resolved on the client
 * side. That is asserted here at the source level because it cannot be caught
 * by rendering: these tests run in jsdom, where there is no boundary to cross,
 * so `PrimaryNav` renders perfectly with items passed in — which is exactly
 * how this shipped broken and stayed broken.
 */
describe('the menu across the server/client boundary', () => {
  const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

  it('resolves the menu inside the client component, not in the shell', () => {
    const nav = read('components/layout/primary-nav.tsx');

    expect(nav).toContain("'use client'");
    // Imported here, on the client side, rather than received as a prop.
    expect(nav).toMatch(/import \{[^}]*NAV_ITEMS[^}]*\} from '\.\/nav-items'/);
    expect(nav).toContain("menu === 'portal'");
  });

  it.each([['components/layout/app-shell.tsx'], ['components/layout/portal-shell.tsx']])(
    'passes %s no component-valued prop to the menu',
    (file) => {
      const source = read(file);

      // The shells are Server Components: no 'use client' directive, and no
      // reference to the item arrays, whose entries hold icon components.
      expect(source.slice(0, 40)).not.toContain('use client');
      expect(source).not.toContain('NAV_ITEMS');
      expect(source).not.toContain('items={');
      expect(source).toContain('menu=');
    },
  );

  it('keeps every prop the shells do pass serialisable', () => {
    // `variant`, `menu` and `permissions` — a string, a string and an array of
    // strings. Anything else crossing this boundary needs the same scrutiny.
    const nav = read('components/layout/primary-nav.tsx');
    const props =
      /export interface PrimaryNavProps \{([\s\S]*?)\n\}/.exec(nav)?.[1] ?? '';

    expect(props).toContain('variant:');
    expect(props).toContain('menu:');
    expect(props).toContain('permissions:');
    expect(props).not.toContain('NavItem[]');
  });
});
