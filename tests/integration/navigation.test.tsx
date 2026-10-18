import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BOTTOM_BAR_SLOTS,
  DASHBOARD_ITEM,
  NAV_ITEMS,
  NAV_MODULES,
  NAV_MODULE_IDS,
  NOTIFICATIONS_ITEM,
  PORTAL_NAV_ITEMS,
  canReachNavItem,
  currentNavItem,
  currentNavModuleId,
  isNavItemActive,
  navPath,
  navQuery,
  splitForBottomBar,
  visibleNavItems,
  visibleNavModules,
} from '@/components/layout/nav-items';
import { PhasePlaceholder } from '@/components/layout/phase-placeholder';
import { PrimaryNav } from '@/components/layout/primary-nav';
import { ROUTES } from '@/config/app';
import { permissionForPath } from '@/lib/auth/routing';
import {
  LOAN_REGISTER_TITLE,
  LOAN_WORKFLOW_STAGES,
  isLoanWorkflowStage,
  loanRegisterTitle,
} from '@/lib/domain/loan';
import {
  REPORTS,
  REPORT_GROUPS,
  REPORT_GROUP_LABELS,
  REPORT_IDS,
} from '@/lib/reports/registry';
import { ROLE_PERMISSIONS, type RoleKey } from '@/lib/permissions';

/**
 * The staff rail, rebuilt as seven closed modules.
 *
 * ## What these assertions protect
 *
 * The rail is the only navigation the staff shell has, at every width, and it
 * now holds about fifty destinations in seven modules rather than eleven in
 * four open blocks. That shape has specific ways of going wrong, and there is
 * a test below for each:
 *
 *   - a module that opens onto nothing, because every entry in it was
 *     filtered out by capability;
 *   - an entry offered to somebody the destination would then refuse —
 *     `/loans/new` to a role without `loans:create`;
 *   - two entries lit at once, because several of them are filtered views of
 *     one register and every prefix matches;
 *   - nothing lit at all, because an entry pins a query parameter the page it
 *     points at does not carry;
 *   - the rail opening every module on arrival, which is the clutter it was
 *     restructured to remove;
 *   - the module holding the open page staying shut, which is the reader
 *     losing where they are.
 */

// `usePathname` and `useSearchParams` need a router context that does not
// exist in a bare jsdom render, so both are stubbed per test to drive the
// active-state logic.
const mockRoute = vi.hoisted(() => ({ pathname: '/', search: '' }));

vi.mock('next/navigation', () => ({
  usePathname: () => mockRoute.pathname,
  useSearchParams: () => new URLSearchParams(mockRoute.search),
}));

/** Point the stubbed router at an href, query string and all. */
function goTo(href: string): void {
  const [pathname, search = ''] = href.split('?');
  mockRoute.pathname = pathname ?? '/';
  mockRoute.search = search.split('#')[0] ?? '';
}

beforeEach(() => {
  goTo('/');
});

const OWNER = ROLE_PERMISSIONS.owner_admin;

/** Open one module by its header. */
async function openModule(label: string): Promise<HTMLElement> {
  const user = userEvent.setup();
  const header = screen.getByRole('button', { name: label });
  if (header.getAttribute('aria-expanded') === 'false') await user.click(header);
  return header;
}

// ===========================================================================
describe('navigation items', () => {
  it('points every entry at a canonical route', () => {
    const routes = new Set<string>(Object.values(ROUTES));

    for (const item of [...NAV_ITEMS, ...PORTAL_NAV_ITEMS]) {
      const path = navPath(item.href);
      // A path is canonical, or it is a canonical route's own child segment
      // — `/clients/new`, `/reports/arrears`. Nothing is hand-typed from
      // outside the route table.
      const canonical =
        routes.has(path) ||
        [...routes].some(
          (route) => route !== ROUTES.dashboard && path.startsWith(`${route}/`),
        );
      expect(canonical, item.href).toBe(true);
    }
  });

  it('lists no destination twice', () => {
    // Two entries on one href would both claim to be the open page, and the
    // reader would be told they are in two places at once.
    const hrefs = NAV_ITEMS.map((item) => item.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);

    const portal = PORTAL_NAV_ITEMS.map((item) => item.href);
    expect(new Set(portal).size).toBe(portal.length);
  });

  it('gives each entry a label and a phase', () => {
    for (const item of [...NAV_ITEMS, ...PORTAL_NAV_ITEMS]) {
      expect(item.label.trim()).not.toBe('');
      expect(item.phase).toBeGreaterThanOrEqual(1);
    }
  });

  it('keeps the portal labels short enough for a bottom bar', () => {
    // Only the portal renders a bar. At 320px each cell has roughly 78px.
    for (const item of PORTAL_NAV_ITEMS) {
      expect(item.shortLabel?.length ?? 0, item.label).toBeGreaterThan(0);
      expect(item.shortLabel?.length ?? 0, item.shortLabel).toBeLessThanOrEqual(8);
    }
  });

  /**
   * The failure this guards against: a menu entry hidden from a role while
   * the route behind it stays reachable by typing the URL. Both read the same
   * map, and this asserts they agree — on the *path*, because a query string
   * is a filter and the capability map gates routes.
   */
  it('requires the same capability the route guard requires', () => {
    for (const item of [...NAV_ITEMS, ...PORTAL_NAV_ITEMS]) {
      expect(permissionForPath(navPath(item.href)), item.href).toBe(item.permission);
    }
  });

  it('declares the extra capability a create screen guards', () => {
    // `/clients/new` sits under the `clients:view` prefix and guards
    // `clients:create`. An entry that did not say so would be an entry a
    // Secretary/Treasurer could click into a refusal.
    const requires = (href: string) =>
      NAV_ITEMS.find((item) => item.href === href)?.requires ?? [];

    expect(requires(`${ROUTES.clients}/new`)).toContain('clients:create');
    expect(requires(`${ROUTES.loans}/new`)).toContain('loans:create');
    expect(requires(`${ROUTES.payments}/new`)).toContain('payments:create');
    expect(requires(`${ROUTES.reports}/penalties`)).toContain('reports:view_financial');
  });

  it('pins only parameters the destination actually reads', () => {
    // A filter the page ignores is an entry that can never be the open page,
    // so nothing in the rail would ever light up for it.
    const reads: Readonly<Record<string, readonly string[]>> = {
      [ROUTES.clients]: ['status'],
      // Phase 13's workflow register: ten stages, one query.
      [ROUTES.loans]: ['stage'],
      [ROUTES.payments]: ['status'],
      // Phase 14's five views of Debt & Security.
      [ROUTES.recovery]: ['view'],
      [ROUTES.audit]: ['entity'],
      // Phase 16's four report groups.
      [ROUTES.reports]: ['group'],
      [`${ROUTES.reports}/collections`]: ['period'],
      [ROUTES.settings]: ['section'],
      [ROUTES.finance]: ['section'],
      [ROUTES.collectionSummary]: ['section'],
    };

    for (const item of NAV_ITEMS) {
      const params = navQuery(item.href);
      if (params.length === 0) continue;

      const allowed = reads[navPath(item.href)];
      expect(allowed, item.href).toBeDefined();
      for (const [key] of params) {
        expect(allowed, `${item.href} pins ?${key}`).toContain(key);
      }
    }
  });
});

// ===========================================================================
describe('the modules', () => {
  it('declares each module once, in the rail order', () => {
    expect(NAV_MODULES.map((module) => module.id)).toEqual([...NAV_MODULE_IDS]);
  });

  it('puts Reports on its own, not inside another module', () => {
    const reports = NAV_MODULES.find((module) => module.id === 'reports');
    expect(reports?.label).toBe('Reports');

    // And no other module carries the Reports Centre.
    for (const block of NAV_MODULES) {
      if (block.id === 'reports') continue;
      expect(
        block.items.map((item) => item.href),
        block.id,
      ).not.toContain(ROUTES.reports);
    }
  });

  it('puts the guarantor register under Debt & Security, not under Clients', () => {
    const debt = NAV_MODULES.find((module) => module.id === 'debt');
    const clients = NAV_MODULES.find((module) => module.id === 'clients');

    expect(debt?.label).toBe('Debt & Security');
    expect(debt?.items.map((item) => item.href)).toContain(ROUTES.guarantors);
    expect(clients?.items.map((item) => item.href)).not.toContain(ROUTES.guarantors);
  });

  it('keeps the dashboard out of every module', () => {
    for (const block of NAV_MODULES) {
      expect(
        block.items.map((item) => item.href),
        block.id,
      ).not.toContain(ROUTES.dashboard);
    }

    expect(DASHBOARD_ITEM.href).toBe(ROUTES.dashboard);
  });

  it('offers a report group only where a report exists in it', () => {
    // Otherwise a rail entry opens the Centre onto an empty list, which
    // reads as a broken module rather than as one not built yet. The groups
    // come from Phase 16's registry, which is also what the Centre renders,
    // so the two cannot offer different ones.
    const reports = NAV_MODULES.find((module) => module.id === 'reports');
    const groups = (reports?.items ?? [])
      .map((item) => navQuery(item.href).find(([key]) => key === 'group')?.[1])
      .filter((value): value is string => value !== undefined);

    expect(groups).toHaveLength(REPORT_GROUPS.length);

    for (const group of groups) {
      expect(REPORT_GROUPS as readonly string[], group).toContain(group);
      expect(
        REPORT_IDS.some((id) => REPORTS[id].group === group),
        group,
      ).toBe(true);
    }
  });

  it('exposes report groups rather than the ten report definitions', () => {
    // The Centre is where a report is chosen, filtered and exported from.
    // Ten report pages in the rail would be the contents of a module inside
    // its own menu.
    const reports = NAV_MODULES.find((module) => module.id === 'reports');
    const hrefs = (reports?.items ?? []).map((item) => item.href);

    for (const id of REPORT_IDS) {
      expect(hrefs, id).not.toContain(`${ROUTES.reports}/${id}`);
    }
  });

  it('drops a module that filters down to nothing', () => {
    for (const role of ['secretary_treasurer', 'manager', 'owner_admin'] as const) {
      for (const block of visibleNavModules(ROLE_PERMISSIONS[role])) {
        expect(block.items.length, `${role}/${block.id}`).toBeGreaterThan(0);
      }
    }

    // A borrower holds `account:view` and nothing else from this menu, so
    // the only module left is the one holding their own account — and they
    // never reach this shell in the first place, the route guard sends them
    // to the portal.
    const forBorrower = visibleNavModules(ROLE_PERMISSIONS.client);
    expect(forBorrower.map((module) => module.id)).toEqual(['administration']);
    expect(forBorrower[0]?.items.map((item) => item.href)).toEqual([ROUTES.account]);
  });

  it('gives every staff role something in every module they can use', () => {
    // Not a count — a floor. The point is that no role meets a rail of two
    // modules because the capability map and the entries disagree.
    for (const role of ['secretary_treasurer', 'manager', 'owner_admin'] as const) {
      const ids = visibleNavModules(ROLE_PERMISSIONS[role]).map((module) => module.id);

      for (const id of [
        'clients',
        'loans',
        'collections',
        'debt',
        'finance',
        'reports',
      ]) {
        expect(ids, `${role} cannot see ${id}`).toContain(id);
      }
    }
  });
});

// ===========================================================================
/**
 * What the modules must still carry.
 *
 * This pass restructured the rail over a system that had grown four modules
 * since the structure was last touched — Debt & Security (Phase 14),
 * notifications (Phase 15), the ten-report Centre (Phase 16) and the
 * dashboard's reads of all three (Phase 17). The failure worth a test is a
 * reorganisation that quietly drops one of them, which looks like a tidier
 * menu and is a feature nobody can reach.
 *
 * So these assert the destinations by href, against the routes the
 * application actually has.
 */
describe('the Phase 9 modules the rail must not lose', () => {
  const hrefsIn = (id: string) =>
    NAV_MODULES.find((block) => block.id === id)?.items.map((item) => item.href) ?? [];

  it('keeps Notifications reachable, as a row of its own', () => {
    expect(NOTIFICATIONS_ITEM.href).toBe(ROUTES.notifications);
    expect(NOTIFICATIONS_ITEM.permission).toBe('notifications:view');
    expect(NAV_ITEMS.map((item) => item.href)).toContain(ROUTES.notifications);

    // In no module, because it is about every module.
    for (const block of NAV_MODULES) {
      expect(
        block.items.map((item) => item.href),
        block.id,
      ).not.toContain(ROUTES.notifications);
    }
  });

  it('keeps every Debt & Security surface', () => {
    const hrefs = hrefsIn('debt');

    for (const href of [
      ROUTES.overdue,
      // Phase 14's five views, each a filter the page reads back.
      ROUTES.recovery,
      `${ROUTES.recovery}?view=risk`,
      `${ROUTES.recovery}?view=follow-ups`,
      `${ROUTES.recovery}?view=promises`,
      `${ROUTES.recovery}?view=security`,
      // Both guarantor surfaces: the undertakings and the people.
      ROUTES.guarantorRegister,
      ROUTES.guarantors,
      // And the three reports that answer for the chase.
      `${ROUTES.reports}/guarantors`,
      `${ROUTES.reports}/arrears`,
      `${ROUTES.reports}/penalties`,
      `${ROUTES.reports}/recovery`,
    ]) {
      expect(hrefs, href).toContain(href);
    }
  });

  it('keeps the guarantor register out of Clients', () => {
    expect(hrefsIn('clients')).not.toContain(ROUTES.guarantorRegister);
    expect(hrefsIn('clients')).not.toContain(ROUTES.guarantors);
  });

  it('keeps every Finance surface', () => {
    const hrefs = hrefsIn('finance');

    for (const href of [
      ROUTES.finance,
      ROUTES.transfers,
      ROUTES.expenses,
      ROUTES.otherIncome,
      ROUTES.reconciliation,
      ROUTES.ledger,
      // Phase 18.
      ROUTES.trialBalance,
    ]) {
      expect(hrefs, href).toContain(href);
    }
  });

  it('gives the trial balance one row, under Finance', () => {
    expect(hrefsIn('finance')).toContain(ROUTES.trialBalance);

    const entry = NAV_ITEMS.find((item) => item.href === ROUTES.trialBalance);
    expect(entry?.label).toBe('Trial Balance');
    // The ledger's own capability, because a trial balance says nothing the
    // general ledger does not.
    expect(entry?.permission).toBe('ledger:view');

    for (const block of NAV_MODULES) {
      if (block.id === 'finance') continue;
      expect(
        block.items.map((item) => item.href),
        block.id,
      ).not.toContain(ROUTES.trialBalance);
    }
  });

  it('gives Account Activity and Liquidity Position no row of their own', () => {
    // Account activity *is* the general ledger narrowed by `?account=`,
    // reached from the account chips on that page; the liquidity position is
    // the total on the cash position cards. Rows for them would be the same
    // screens under two more names, and two rows on one href would both claim
    // to be the open page.
    const labels = NAV_ITEMS.map((item) => item.label);

    expect(labels).not.toContain('Account Activity');
    expect(labels).not.toContain('Liquidity Position');

    // And neither screen gained a second entry.
    const hrefs = NAV_ITEMS.map((item) => item.href);
    expect(hrefs.filter((href) => href === ROUTES.ledger)).toHaveLength(1);
    expect(hrefs.filter((href) => href === ROUTES.finance)).toHaveLength(1);
  });

  it('keeps every loan workflow stage', () => {
    const hrefs = hrefsIn('loans');

    // Phase 13's ten stages, each a view over one query. Awaiting
    // disbursement is its own stage, not a second label on "approved".
    for (const stage of LOAN_WORKFLOW_STAGES) {
      expect(hrefs, stage).toContain(`${ROUTES.loans}?stage=${stage}`);
    }

    expect(hrefs).toContain(`${ROUTES.loans}/by-product`);
  });

  it('is the only stage navigation the loan module has', () => {
    // Phase 21. The register used to carry a horizontal strip of workflow
    // tabs on top of these entries — one navigation drawn twice, and the copy
    // that could fall out of step with the rail. The strip is gone, so the
    // rail is now load-bearing: every stage the register can show has to be
    // reachable from here, and each entry has to carry a stage the register
    // recognises. An entry pinning a stage `isLoanWorkflowStage` rejects would
    // silently land on the unfiltered book under the heading "Loan Register" —
    // a filtered view claiming to be the whole loan book.
    const loans = NAV_MODULES.find((module) => module.id === 'loans');
    const entries = loans?.items ?? [];

    const register = entries.filter((item) => item.href === ROUTES.loans);
    expect(register).toHaveLength(1);
    expect(register[0]?.label).toBe(LOAN_REGISTER_TITLE);

    const staged = entries.flatMap((item) => {
      const stage = new Map(navQuery(item.href)).get('stage');
      return stage === undefined ? [] : [{ label: item.label, stage }];
    });

    // Ten stage entries, no more: a second entry on one stage is two rail
    // rows that light together.
    expect(staged).toHaveLength(LOAN_WORKFLOW_STAGES.length);
    expect(new Set(staged.map((entry) => entry.stage)).size).toBe(staged.length);

    for (const entry of staged) {
      expect(isLoanWorkflowStage(entry.stage), entry.stage).toBe(true);

      // The heading the entry opens names that stage rather than the whole
      // register.
      const heading = loanRegisterTitle(
        isLoanWorkflowStage(entry.stage) ? entry.stage : null,
      );
      expect(heading, entry.label).not.toBe(LOAN_REGISTER_TITLE);
    }
  });

  it('keeps Branch Network on the branch functionality that exists', () => {
    const hrefs = hrefsIn('branches');

    // Four deep links into the places a branch question is answered. Phase 9
    // has no standalone branch screen, and a module of new screens would
    // have re-derived somebody else's figures.
    expect(hrefs).toEqual([
      `${ROUTES.settings}?section=branches#branches-heading`,
      `${ROUTES.finance}?section=cash#cash-position-heading`,
      `${ROUTES.collectionSummary}?section=branch#by-branch`,
      `${ROUTES.reports}/aging`,
    ]);
  });

  it('keeps the collection summary slices as sections of one page', () => {
    // One read summed five ways. Four screens would be four chances for the
    // totals to disagree.
    const collections = hrefsIn('collections');

    expect(collections).toContain(ROUTES.collectionSummary);
    for (const section of ['method', 'staff', 'product']) {
      expect(collections, section).toContain(
        `${ROUTES.collectionSummary}?section=${section}#by-${section}`,
      );
    }
  });

  it('keeps Phase 14 prefetch opt-out on the expensive destinations', () => {
    // Prefetching a dynamic route runs the page server-side, and Debt &
    // Security reads a grouping-sets aggregate over the whole active book.
    // Opening that module must not fire five of them.
    for (const item of NAV_ITEMS) {
      if (!navPath(item.href).startsWith(ROUTES.recovery)) continue;
      expect(item.prefetch, item.href).toBe(false);
    }

    const byProduct = NAV_ITEMS.find(
      (item) => item.href === `${ROUTES.loans}/by-product`,
    );
    expect(byProduct?.prefetch).toBe(false);
  });

  it('renders the prefetch opt-out onto the link itself', () => {
    // A field asserted in the data and never read by the component would be
    // a budget nobody is keeping.
    const nav = readFileSync(
      join(process.cwd(), 'components/layout/primary-nav.tsx'),
      'utf8',
    );
    const uses = nav.match(/prefetch=\{item\.prefetch\}/g)?.length ?? 0;
    expect(uses).toBeGreaterThanOrEqual(3);
  });
});

// ===========================================================================
describe('what each role sees', () => {
  const visibleFor = (role: RoleKey, items = NAV_ITEMS) =>
    visibleNavItems(items, ROLE_PERMISSIONS[role]).map((item) => item.href);

  it('shows an owner every staff section', () => {
    const visible = visibleFor('owner_admin');

    expect(visible).toContain(ROUTES.users);
    expect(visible).toContain(ROUTES.audit);
    expect(visible).toContain(ROUTES.settings);
    expect(visible).toContain(ROUTES.dashboard);
    expect(visible).toContain(ROUTES.reports);
  });

  it('shows a manager the directory but not the audit trail', () => {
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

  it('offers no entry a role would be refused on arrival', () => {
    // The whole reason `requires` exists. A Secretary/Treasurer holds
    // `clients:view` and no `clients:create`, and `reports:view_operational`
    // and no `reports:view_financial`.
    const visible = visibleFor('secretary_treasurer');

    expect(visible).not.toContain(`${ROUTES.clients}/new`);
    expect(visible).not.toContain(`${ROUTES.reports}/penalties`);
    expect(visible).not.toContain(`${ROUTES.reports}/guarantors`);
    // The security group's most reachable report needs
    // `reports:view_financial`, so the group is not offered either.
    expect(visible).not.toContain(`${ROUTES.reports}?group=security`);
    // The aging report needs it too, so Branch Network's portfolio entry is
    // withheld while the module's other three remain.
    expect(visible).not.toContain(`${ROUTES.reports}/aging`);
    // And the audit trail, which they hold no capability for at all.
    expect(visible).not.toContain(`${ROUTES.audit}?entity=client`);

    // Phase 14 gave the chase to the counter role, so Debt & Security's hub
    // *is* theirs — `recovery:view` is a Secretary/Treasurer's capability.
    // Asserting otherwise here would have been asserting the wrong model.
    expect(visible).toContain(ROUTES.recovery);

    // And the ones they do hold are offered.
    expect(visible).toContain(`${ROUTES.loans}/new`);
    expect(visible).toContain(`${ROUTES.payments}/new`);
    expect(visible).toContain(`${ROUTES.reports}?group=money-in`);
    // Whoever handles the cash reads the ledger, so the trial balance is
    // theirs: `ledger:view` is the treasurer's, not an administrator's.
    expect(visible).toContain(ROUTES.trialBalance);
  });

  it('shows every staff role the reporting module', () => {
    for (const role of ['secretary_treasurer', 'manager', 'owner_admin'] as const) {
      expect(visibleFor(role), role).toContain(ROUTES.reports);
    }
  });

  it('shows a client nothing from the staff menu', () => {
    const visible = visibleFor('client');

    for (const route of [
      ROUTES.dashboard,
      ROUTES.users,
      ROUTES.audit,
      ROUTES.settings,
      ROUTES.clients,
      ROUTES.loans,
      ROUTES.payments,
      ROUTES.reports,
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

  it('shows nothing at all without any capability', () => {
    expect(visibleNavItems(NAV_ITEMS, [])).toEqual([]);
  });

  it('requires the route capability and every extra one', () => {
    const newClient = NAV_ITEMS.find((item) => item.href === `${ROUTES.clients}/new`);
    expect(newClient).toBeDefined();
    if (newClient === undefined) return;

    expect(canReachNavItem(newClient, ['clients:view'])).toBe(false);
    expect(canReachNavItem(newClient, ['clients:create'])).toBe(false);
    expect(canReachNavItem(newClient, ['clients:view', 'clients:create'])).toBe(true);
  });
});

// ===========================================================================
describe('splitting an href', () => {
  it('separates the path from the query and the fragment', () => {
    expect(navPath('/clients?status=active')).toBe('/clients');
    expect(navPath('/settings?section=finance#finance-heading')).toBe('/settings');
    expect(navPath('/loans')).toBe('/loans');
  });

  it('reads the pinned parameters, and no fragment with them', () => {
    expect(navQuery('/clients?status=active')).toEqual([['status', 'active']]);
    expect(navQuery('/settings?section=finance#finance-heading')).toEqual([
      ['section', 'finance'],
    ]);
    expect(navQuery('/loans')).toEqual([]);
  });
});

// ===========================================================================
describe('isNavItemActive', () => {
  const params = (search: string) => new URLSearchParams(search);

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

  it('requires every pinned parameter to match', () => {
    expect(
      isNavItemActive('/clients?status=active', '/clients', params('status=active')),
    ).toBe(true);
    expect(
      isNavItemActive('/clients?status=active', '/clients', params('status=suspended')),
    ).toBe(false);
    expect(isNavItemActive('/clients?status=active', '/clients', params(''))).toBe(false);
  });

  it('ignores the fragment, which the browser never reports', () => {
    expect(
      isNavItemActive(
        '/settings?section=finance#finance-heading',
        '/settings',
        params('section=finance'),
      ),
    ).toBe(true);
  });
});

// ===========================================================================
describe('which entry is the open page', () => {
  const resolve = (href: string) => {
    const [pathname, search = ''] = href.split('?');
    return currentNavItem(
      NAV_ITEMS,
      pathname ?? '/',
      new URLSearchParams(search.split('#')[0]),
    )?.href;
  };

  it('picks the filtered view over the register it filters', () => {
    expect(resolve('/clients?status=suspended')).toBe('/clients?status=suspended');
    expect(resolve('/loans?stage=awaiting_disbursement')).toBe(
      '/loans?stage=awaiting_disbursement',
    );
    expect(resolve('/payments?status=reversed')).toBe('/payments?status=reversed');
    expect(resolve('/recovery?view=promises')).toBe('/recovery?view=promises');
  });

  it('picks the register when nothing is filtered', () => {
    expect(resolve('/clients')).toBe('/clients');
    expect(resolve('/loans')).toBe('/loans');
    // `/recovery` bare is the aging view, which is the module's default.
    expect(resolve('/recovery')).toBe('/recovery');
  });

  it('keeps the register lit on a detail page', () => {
    expect(resolve('/clients/0f8fad5b')).toBe('/clients');
    expect(resolve('/loans/0f8fad5b/statement')).toBe('/loans');
  });

  it('picks the longer path over a shorter one that also prefixes it', () => {
    expect(resolve('/loans/new')).toBe('/loans/new');
    expect(resolve('/finance/transfers')).toBe('/finance/transfers');
    expect(resolve('/settings/products')).toBe('/settings/products');
  });

  it('resolves exactly one entry for every entry in the rail', () => {
    // Every destination the rail offers must light itself up when opened,
    // and only itself. This is the assertion that would have caught a pinned
    // parameter the page does not read.
    for (const item of NAV_ITEMS) {
      expect(resolve(item.href), item.href).toBe(item.href);
    }
  });

  it('names the module holding the open page, and none for the dashboard', () => {
    const where = (href: string) => {
      const [pathname, search = ''] = href.split('?');
      return currentNavModuleId(
        NAV_MODULES,
        pathname ?? '/',
        new URLSearchParams(search.split('#')[0]),
      );
    };

    // The two pinned rows belong to no module.
    expect(where('/')).toBeNull();
    expect(where('/notifications')).toBeNull();

    expect(where('/finance/expenses')).toBe('finance');
    expect(where('/finance/trial-balance')).toBe('finance');
    expect(where('/clients?status=active')).toBe('clients');
    expect(where('/loans?stage=arrears')).toBe('loans');
    expect(where('/loans/by-product')).toBe('loans');
    expect(where('/payments/summary?section=staff')).toBe('collections');
    expect(where('/payments/summary?section=branch')).toBe('branches');
    expect(where('/recovery?view=risk')).toBe('debt');
    expect(where('/guarantors/register')).toBe('debt');
    expect(where('/guarantors')).toBe('debt');
    expect(where('/reports/recovery')).toBe('debt');
    expect(where('/reports?group=behind')).toBe('reports');
    expect(where('/reports/aging')).toBe('branches');
    expect(where('/settings?section=branches')).toBe('branches');
    expect(where('/settings?section=lending')).toBe('administration');
  });
});

// ===========================================================================
describe('the rail', () => {
  it('starts with every module closed', () => {
    // Fifty destinations at once is not navigation. On the dashboard — which
    // belongs to no module — nothing is open.
    render(<PrimaryNav variant="sidebar" menu="staff" permissions={OWNER} />);

    for (const block of NAV_MODULES) {
      expect(
        screen.getByRole('button', { name: block.label }),
        block.label,
      ).toHaveAttribute('aria-expanded', 'false');
    }
  });

  it('shows the two pinned rows without opening anything', () => {
    render(<PrimaryNav variant="sidebar" menu="staff" permissions={OWNER} />);

    expect(screen.getByRole('link', { name: 'Dashboard' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    // Dashboard and Notifications, and nothing else: no module is open, so
    // no child link is rendered at all. Both belong to no module — the
    // dashboard because it is reached constantly, notifications because it
    // is about every module and the header's bell is the usual way in.
    expect(screen.getAllByRole('link')).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'Notifications' })).toBeInTheDocument();
  });

  it('marks Notifications as the open page without opening a module', () => {
    goTo(ROUTES.notifications);
    render(<PrimaryNav variant="sidebar" menu="staff" permissions={OWNER} />);

    expect(screen.getByRole('link', { name: 'Notifications' })).toHaveAttribute(
      'aria-current',
      'page',
    );

    for (const block of NAV_MODULES) {
      expect(
        screen.getByRole('button', { name: block.label }),
        block.label,
      ).toHaveAttribute('aria-expanded', 'false');
    }
  });

  it('opens a module when its header is pressed', async () => {
    const user = userEvent.setup();
    render(<PrimaryNav variant="sidebar" menu="staff" permissions={OWNER} />);

    const finance = screen.getByRole('button', { name: 'Finance' });
    await user.click(finance);

    expect(finance).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('link', { name: 'General Ledger' })).toBeInTheDocument();
  });

  it('closes the module it opened when the header is pressed again', async () => {
    const user = userEvent.setup();
    render(<PrimaryNav variant="sidebar" menu="staff" permissions={OWNER} />);

    const finance = screen.getByRole('button', { name: 'Finance' });
    await user.click(finance);
    await user.click(finance);

    expect(finance).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('link', { name: 'General Ledger' })).toBeNull();
  });

  it('closes the last module when another is opened', async () => {
    // Accordion, not a set of independent panels: two open modules put the
    // thing you want below the fold again.
    const user = userEvent.setup();
    render(<PrimaryNav variant="sidebar" menu="staff" permissions={OWNER} />);

    const clients = screen.getByRole('button', { name: 'Clients' });
    const finance = screen.getByRole('button', { name: 'Finance' });

    await user.click(clients);
    expect(clients).toHaveAttribute('aria-expanded', 'true');

    await user.click(finance);
    expect(finance).toHaveAttribute('aria-expanded', 'true');
    expect(clients).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('link', { name: 'Client Register' })).toBeNull();
  });

  it('opens the module holding the open page, by itself', () => {
    goTo('/finance/expenses');
    render(<PrimaryNav variant="sidebar" menu="staff" permissions={OWNER} />);

    expect(screen.getByRole('button', { name: 'Finance' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByRole('link', { name: 'Expenses' })).toHaveAttribute(
      'aria-current',
      'page',
    );

    // And only that one.
    for (const block of NAV_MODULES.filter((m) => m.id !== 'finance')) {
      expect(
        screen.getByRole('button', { name: block.label }),
        block.label,
      ).toHaveAttribute('aria-expanded', 'false');
    }
  });

  it('opens Reports by itself on a report group', () => {
    goTo('/reports?group=behind');
    render(<PrimaryNav variant="sidebar" menu="staff" permissions={OWNER} />);

    expect(screen.getByRole('button', { name: 'Reports' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByRole('link', { name: 'Arrears & Risk Reports' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(REPORT_GROUP_LABELS.behind.title).toBe('Loans behind');
  });

  it('marks the current page with aria-current, not only a colour', () => {
    goTo('/users');
    render(<PrimaryNav variant="sidebar" menu="staff" permissions={OWNER} />);

    expect(screen.getByRole('link', { name: 'Users' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('link', { name: 'Dashboard' })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('marks exactly one entry as current, however many prefixes match', () => {
    // `/clients`, `/clients?status=active` and the client register all live
    // under one prefix. Two lit rows would tell the reader they are in two
    // places.
    for (const href of [
      '/clients?status=active',
      '/clients',
      '/clients/0f8fad5b',
      '/loans?status=cleared',
      '/settings?section=finance',
      '/audit?entity=client',
    ]) {
      goTo(href);
      const view = render(
        <PrimaryNav variant="sidebar" menu="staff" permissions={OWNER} />,
      );

      const current = view.container.querySelectorAll('[aria-current="page"]');
      expect(current, href).toHaveLength(1);
      view.unmount();
    }
  });

  it('keeps a section current on its detail pages', () => {
    goTo(`${ROUTES.users}/0f8fad5b-d9cb-469f-a165-70867728950e`);
    render(<PrimaryNav variant="sidebar" menu="staff" permissions={OWNER} />);

    expect(screen.getByRole('link', { name: 'Users' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('renders only the entries the viewer may use', async () => {
    render(
      <PrimaryNav
        variant="sidebar"
        menu="staff"
        permissions={ROLE_PERMISSIONS.secretary_treasurer}
      />,
    );

    // Opened first, so "not in the document" means filtered out rather than
    // merely inside a closed module.
    await openModule('Administration');

    expect(screen.queryByRole('link', { name: 'Users' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Audit Trail' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Loan Products' })).toBeInTheDocument();
  });

  it('renders no module a role cannot use', () => {
    render(
      <PrimaryNav
        variant="sidebar"
        menu="staff"
        permissions={ROLE_PERMISSIONS.secretary_treasurer}
      />,
    );

    const visible = visibleNavModules(ROLE_PERMISSIONS.secretary_treasurer).map(
      (module) => module.label,
    );

    for (const block of NAV_MODULES) {
      const header = screen.queryByRole('button', { name: block.label });
      if (visible.includes(block.label)) {
        expect(header, block.label).not.toBeNull();
      } else {
        expect(header, block.label).toBeNull();
      }
    }
  });

  it('renders every entry in an open module as a link', async () => {
    render(<PrimaryNav variant="sidebar" menu="staff" permissions={OWNER} />);

    await openModule('Collections');

    const collections = NAV_MODULES.find((module) => module.id === 'collections');
    for (const item of collections?.items ?? []) {
      expect(screen.getByRole('link', { name: item.label }), item.label).toHaveAttribute(
        'href',
        item.href,
      );
    }
  });

  it('names each module header as a disclosure, not a destination', () => {
    render(<PrimaryNav variant="sidebar" menu="staff" permissions={OWNER} />);

    for (const block of NAV_MODULES) {
      const header = screen.getByRole('button', { name: block.label });
      // A button, because it discloses a panel; and it names the panel, so a
      // screen reader hears why the other forty entries are missing.
      expect(header.tagName, block.label).toBe('BUTTON');
      expect(header.getAttribute('aria-controls'), block.label).not.toBeNull();
    }
  });

  it('keeps the reader where they are when they open another module', async () => {
    // Opening Clients while on an expense must not un-mark the expense: the
    // page has not changed, only what the rail is showing.
    const user = userEvent.setup();
    goTo('/finance/expenses');
    render(<PrimaryNav variant="sidebar" menu="staff" permissions={OWNER} />);

    await user.click(screen.getByRole('button', { name: 'Clients' }));

    expect(screen.getByRole('button', { name: 'Finance' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    // The rail no longer shows the row, but nothing else claims to be the
    // page either — the reader is told where they are by the module that
    // reopens the moment they stop browsing.
    expect(screen.queryByRole('link', { name: 'Expenses' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Clients' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });
});

// ===========================================================================
describe('the touch sizes inside the drawer', () => {
  it('gives every module header and entry a touch-sized row below lg', async () => {
    render(<PrimaryNav variant="sidebar" menu="staff" permissions={OWNER} />);
    await openModule('Clients');

    // `py-3` on the header and `py-2.5` on the entry at the drawer widths,
    // dropping to `lg:py-2` / `lg:py-1.5` on a desktop. The drawer is the
    // phone and the tablet, where a thumb is the pointer.
    const header = screen.getByRole('button', { name: 'Clients' });
    expect(header.className).toContain('py-3');
    expect(header.className).toContain('lg:py-2');

    const entry = screen.getByRole('link', { name: 'Client Register' });
    expect(entry.className).toContain('py-2.5');
    expect(entry.className).toContain('lg:py-1.5');
  });
});

// ===========================================================================
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
 * A Lucide icon is a React component, and a React component **cannot be
 * passed as a prop from a Server Component to a Client Component**: React
 * Server Components refuses it at render time with "Functions cannot be
 * passed directly to Client Components", and the error takes down the whole
 * page.
 *
 * The shells are Server Components and `PrimaryNav` is a Client Component, so
 * the menu has to be named across the boundary and resolved on the client
 * side. That is asserted here at the source level because it cannot be caught
 * by rendering: these tests run in jsdom, where there is no boundary to
 * cross, so `PrimaryNav` renders perfectly with items passed in — which is
 * exactly how this shipped broken and stayed broken.
 */
describe('the menu across the server/client boundary', () => {
  const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

  it('resolves the menu inside the client component, not in the shell', () => {
    const nav = read('components/layout/primary-nav.tsx');

    expect(nav).toContain("'use client'");
    // Imported here, on the client side, rather than received as a prop.
    expect(nav).toMatch(/import \{[\s\S]*?NAV_MODULES[\s\S]*?\} from '\.\/nav-items'/);
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
      expect(source).not.toContain('NAV_MODULES');
      expect(source).not.toContain('items={');
      expect(source).toContain('menu=');
    },
  );

  it('keeps every prop the shells do pass serialisable', () => {
    // `variant`, `menu` and `permissions` — a string, a string and an array
    // of strings. Anything else crossing this boundary needs the same
    // scrutiny.
    const nav = read('components/layout/primary-nav.tsx');
    const props =
      /export interface PrimaryNavProps \{([\s\S]*?)\n\}/.exec(nav)?.[1] ?? '';

    expect(props).toContain('variant:');
    expect(props).toContain('menu:');
    expect(props).toContain('permissions:');
    expect(props).not.toContain('NavItem[]');
  });
});

/**
 * The borrower portal's bottom bar.
 *
 * The staff shell has no bar — it has one rail at every width — so what these
 * protect is the portal's: the bar is small, the two lists together are
 * exactly what the role may reach, and nothing appears in both.
 */
describe('the portal bottom bar', () => {
  it('gives a borrower both entries in the bar and no sheet', () => {
    // Two entries fit. A "More" button that opens a list of nothing is worse
    // than no button, so the overflow must be empty rather than merely short.
    const { bar, overflow } = splitForBottomBar(
      PORTAL_NAV_ITEMS,
      ROLE_PERMISSIONS.client,
    );

    expect(bar.map((item) => item.href)).toEqual([ROUTES.portal, ROUTES.account]);
    expect(overflow).toEqual([]);
  });

  it('never puts more than four destinations plus More in the bar', () => {
    const { bar } = splitForBottomBar(PORTAL_NAV_ITEMS, ROLE_PERMISSIONS.client);
    expect(bar.length).toBeLessThanOrEqual(BOTTOM_BAR_SLOTS);
  });

  it('loses no destination to the split', () => {
    for (const role of ['client', 'owner_admin'] as const) {
      const { bar, overflow } = splitForBottomBar(
        PORTAL_NAV_ITEMS,
        ROLE_PERMISSIONS[role],
      );
      const combined = [...bar, ...overflow].map((item) => item.href).toSorted();
      const expected = visibleNavItems(PORTAL_NAV_ITEMS, ROLE_PERMISSIONS[role])
        .map((item) => item.href)
        .toSorted();

      expect(combined, role).toEqual(expected);
    }
  });

  it('uses the short labels and keeps the touch target', () => {
    goTo(ROUTES.portal);
    render(
      <PrimaryNav
        variant="bottom-bar"
        menu="portal"
        permissions={ROLE_PERMISSIONS.client}
      />,
    );

    const loans = screen.getByRole('link', { name: 'Loans' });
    expect(loans.className).toContain('min-h-touch');
    expect(loans).toHaveAttribute('aria-current', 'page');
  });

  it('offers staff nothing in the portal menu beyond their account', () => {
    for (const role of ['secretary_treasurer', 'manager', 'owner_admin'] as const) {
      expect(
        visibleNavItems(PORTAL_NAV_ITEMS, ROLE_PERMISSIONS[role]).map(
          (item) => item.href,
        ),
        role,
      ).toEqual([ROUTES.account]);
    }
  });
});
