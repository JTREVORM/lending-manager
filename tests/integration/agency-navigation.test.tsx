/**
 * The Agency rail: three branches, data-driven, and authorised at every depth.
 *
 * ## What these protect
 *
 * The redesign's whole claim is that the Agency module is now a tree whose
 * shape comes from the business rather than from this repository: Agent
 * Banking and Mobile Money are separate branches, each configured bank and
 * each Mobile Money network is a branch built from the provider register, and
 * each registered agent account or line is a destination under its provider.
 *
 * Every one of those sentences is falsifiable, and the ways it could quietly
 * become false are specific:
 *
 *   * a provider code hard-coded somewhere, so a bank registered next year
 *     does not appear;
 *   * a destination in the rail whose route guards a capability the entry does
 *     not declare, so the rail offers a refusal;
 *   * a branch that survives the capability filter for a reader who may see
 *     nothing in it — which happened, and is the reason
 *     `visibleNavGroup` distinguishes "no data" from "not yours";
 *   * an icon on a data-driven branch, which would be a React component
 *     crossing the server/client boundary and would fail every page in the
 *     application.
 *
 * `tests/integration/navigation.test.tsx` holds the rail's general
 * guarantees — permission-to-route parity over every entry, the module filter,
 * the boundary. This file is about the Agency tree in particular.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  NAV_ITEMS,
  NAV_MODULES,
  activeNavGroupIds,
  currentNavItem,
  groupItems,
  moduleItems,
  visibleNavModules,
  withAgencyNavData,
  type AgencyNavData,
  type NavGroup,
  type NavModule,
} from '@/components/layout/nav-items';
import { ROUTES } from '@/config/app';
import { permissionForPath } from '@/lib/auth/routing';
import { ROLE_PERMISSIONS } from '@/lib/permissions';
import { navPath } from '@/components/layout/nav-items';

/** The Agency module, as declared. */
function agencyModule(): NavModule {
  const block = NAV_MODULES.find((m) => m.id === 'agency');
  if (block === undefined) throw new Error('the Agency module is gone');
  return block;
}

function groupById(groups: readonly NavGroup[], id: string): NavGroup {
  for (const group of groups) {
    if (group.id === id) return group;
    const deeper = group.groups === undefined ? null : findDeep(group.groups, id);
    if (deeper !== null) return deeper;
  }
  throw new Error(`no group ${id}`);
}

function findDeep(groups: readonly NavGroup[], id: string): NavGroup | null {
  for (const group of groups) {
    if (group.id === id) return group;
    const deeper = group.groups === undefined ? null : findDeep(group.groups, id);
    if (deeper !== null) return deeper;
  }
  return null;
}

/**
 * Two banks and two networks, one of each with no account registered.
 *
 * Deliberately not MTN and Airtel: a fixture naming the real providers would
 * pass just as well against an implementation that had their codes written
 * into it, which is the exact failure these tests exist to catch.
 */
const FIXTURE: AgencyNavData = {
  banks: [
    {
      code: 'TESTBANK_A',
      name: 'Test Bank A',
      accounts: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          label: 'Main counter',
          status: 'active',
        },
        {
          id: '22222222-2222-4222-8222-222222222222',
          label: 'Market branch',
          status: 'suspended',
        },
      ],
    },
    { code: 'TESTBANK_B', name: 'Test Bank B', accounts: [] },
  ],
  mobileMoney: [
    {
      code: 'TESTNET_1',
      name: 'Test Network One',
      accounts: [
        { id: '33333333-3333-4333-8333-333333333333', label: 'Line 1', status: 'active' },
        { id: '44444444-4444-4444-8444-444444444444', label: 'Line 2', status: 'closed' },
      ],
    },
    { code: 'TESTNET_2', name: 'Test Network Two', accounts: [] },
  ],
};

const OWNER = ROLE_PERMISSIONS.owner_admin;

/** The Agency module as the Owner sees it, with the fixture grafted on. */
function ownerAgency(data: AgencyNavData = FIXTURE): NavModule {
  const modules = withAgencyNavData(visibleNavModules(OWNER), data);
  const block = modules.find((m) => m.id === 'agency');
  if (block === undefined) throw new Error('the Owner cannot see the Agency module');
  return block;
}

describe('the Agency rail — its shape', () => {
  it('has exactly three branches and no loose entries of its own', () => {
    const block = agencyModule();

    // No direct items: every Agency destination belongs to one of the three
    // branches, and a loose row above them would belong to none of them.
    expect(block.items).toHaveLength(0);
    expect((block.groups ?? []).map((g) => g.id)).toEqual([
      'agency-banking',
      'agency-money',
      'agency-consolidated',
    ]);
  });

  it('separates Agent Banking from Mobile Money, with no destination in both', () => {
    const groups = agencyModule().groups ?? [];
    const banking = groupById(groups, 'agency-banking');
    const money = groupById(groups, 'agency-money');

    const bankingHrefs = new Set(groupItems(banking).map((i) => i.href));
    const moneyHrefs = groupItems(money).map((i) => i.href);

    // The counter is shared by design — one engine records a deposit whatever
    // the provider is — so it is in Agent Banking and reached from there. What
    // must not happen is the same *href* appearing in both branches, which
    // would light two rows at once and tell the reader they are in two places.
    for (const href of moneyHrefs) {
      expect(bankingHrefs.has(href), `${href} is in both branches`).toBe(false);
    }
  });

  it('puts the client-requested operations in the Agent Banking branch', () => {
    const banking = groupById(agencyModule().groups ?? [], 'agency-banking');
    const hrefs = banking.items.map((i) => i.href);

    // §3's Agent Banking list, by route. Overview, the counter, the
    // verification queue, history, float top-ups, transfers, cash banking,
    // commissions, settlements, reconciliation and the banking reports.
    for (const href of [
      ROUTES.agencyBanking,
      ROUTES.agencyRecord,
      ROUTES.agencyPending,
      ROUTES.agencyHistory,
      ROUTES.agencyReplenish,
      ROUTES.agencyTransfers,
      ROUTES.agencyCashBanking,
      ROUTES.agencyCommission,
      ROUTES.agencyPayables,
      ROUTES.agencyCashCount,
      ROUTES.agencyFloatCount,
    ]) {
      expect(hrefs, href).toContain(href);
    }
  });

  it('gives the consolidated reports a section each, and an export centre', () => {
    const reports = groupById(agencyModule().groups ?? [], 'agency-consolidated');
    const hrefs = reports.items.map((i) => i.href);

    for (const section of [
      'transactions',
      'cash-float',
      'commission',
      'settlements',
      'reconciliation',
      'performance',
      'export',
    ]) {
      expect(hrefs, section).toContain(`${ROUTES.agencyReports}?section=${section}`);
    }

    // The overview, and the audit/exception report, which has a screen of its
    // own rather than a section.
    expect(hrefs).toContain(ROUTES.agencyReports);
    expect(hrefs).toContain(ROUTES.agencyExceptions);
  });
});

describe('the Agency rail — the data-driven branches', () => {
  it('names no provider code in the source', () => {
    /*
      The strongest assertion in this file, and the bluntest.

      Every other test here would pass against an implementation with STANBIC,
      MTN_MOMO or AIRTEL_MONEY written into the navigation, because the
      fixtures would still graft on correctly beside them. This reads the file.

      `agency-nav.ts` names the two *categories* — `agency_banking` and
      `mobile_money` — which is the point: a category is the database's own
      vocabulary and admits providers nobody has registered yet. A provider
      code is a specific business, and naming one is how STANBIC becomes the
      only bank the application can ever have.
    */
    // Comments are stripped first. The files explain the rule by naming the
    // provider it exists to protect against — "hard-coding it is how STANBIC
    // becomes the only bank the application can ever have" — and prose
    // describing the rule is not a breach of it. What this asserts is that no
    // provider code appears in anything that *runs*.
    const withoutComments = (source: string): string =>
      source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    for (const file of [
      'components/layout/nav-items.ts',
      'components/layout/primary-nav.tsx',
      'lib/data/agency-nav.ts',
    ]) {
      const code = withoutComments(readFileSync(join(process.cwd(), file), 'utf8'));
      for (const provider of ['STANBIC', 'MTN_MOMO', 'AIRTEL_MONEY']) {
        expect(code, `${file} names ${provider} in code`).not.toContain(provider);
      }
    }
  });

  it('builds a branch per configured bank, under Banks & Agent Accounts', () => {
    const banks = groupById(ownerAgency().groups ?? [], 'agency-banking-banks');

    expect((banks.groups ?? []).map((g) => g.label)).toEqual([
      'Test Bank A',
      'Test Bank B',
    ]);
  });

  it('builds a branch per Mobile Money network, each with its own operations', () => {
    const money = groupById(ownerAgency().groups ?? [], 'agency-money');

    expect((money.groups ?? []).map((g) => g.label)).toEqual([
      'Test Network One',
      'Test Network Two',
    ]);

    const one = groupById(money.groups ?? [], 'agency-money-TESTNET_1');
    const hrefs = one.items.map((i) => i.href);

    // §3's Mobile Money list for a provider: a dashboard, transactions, float,
    // commissions, reconciliation and that provider's reports. Every one of
    // them carries the provider's own code, which is what makes this one
    // screen rather than two that would drift.
    expect(hrefs).toContain(`${ROUTES.agencyMoney}/TESTNET_1`);
    expect(hrefs).toContain(`${ROUTES.agencyHistory}?provider=TESTNET_1`);
    expect(hrefs).toContain(`${ROUTES.agencyMoney}/TESTNET_1/commission`);
    expect(hrefs).toContain(`${ROUTES.agencyMoney}/TESTNET_1/statements`);
    expect(hrefs).toContain(`${ROUTES.agencyReports}?provider=TESTNET_1`);
  });

  it('lists each registered line under its provider, at its own page', () => {
    const lines = groupById(ownerAgency().groups ?? [], 'agency-money-TESTNET_1-lines');

    expect(lines.items.map((i) => i.href)).toEqual([
      `${ROUTES.agencyAccounts}/33333333-3333-4333-8333-333333333333`,
      `${ROUTES.agencyAccounts}/44444444-4444-4444-8444-444444444444`,
    ]);
  });

  it('says in the label when a line takes no new business', () => {
    // A rail where a suspended line looks exactly like a trading one means the
    // first anybody hears of it is a refusal at the counter.
    const lines = groupById(ownerAgency().groups ?? [], 'agency-money-TESTNET_1-lines');
    expect(lines.items.map((i) => i.label)).toEqual(['Line 1', 'Line 2 — closed']);

    const bankA = groupById(ownerAgency().groups ?? [], 'agency-bank-TESTBANK_A');
    expect(bankA.items.map((i) => i.label)).toContain('Market branch — suspended');
  });

  it('shows a configured provider with no accounts, with an empty state', () => {
    // A bank the Owner configured and has not yet staffed must not look
    // identical to a bank nobody set up.
    const bankB = groupById(ownerAgency().groups ?? [], 'agency-bank-TESTBANK_B');
    expect(bankB.emptyLabel).toBeDefined();
    // It still carries the register link for this bank, so the branch is not
    // a dead end.
    expect(bankB.items.map((i) => i.href)).toEqual([
      `${ROUTES.agencyBankingAccounts}?provider=TESTBANK_B`,
    ]);

    const net2 = groupById(ownerAgency().groups ?? [], 'agency-money-TESTNET_2-lines');
    expect(net2.items).toHaveLength(0);
    expect(net2.emptyLabel).toBe('No agent line registered yet');
  });

  it('invents nothing when nothing is configured', () => {
    // The requirement in terms: "Do not invent MTN or Airtel lines simply to
    // populate the menu."
    const block = ownerAgency({ banks: [], mobileMoney: [] });

    const banks = groupById(block.groups ?? [], 'agency-banking-banks');
    expect(banks.groups ?? []).toHaveLength(0);
    expect(banks.emptyLabel).toBe('No bank is configured yet');

    const money = groupById(block.groups ?? [], 'agency-money');
    expect(money.groups ?? []).toHaveLength(0);

    // And the branch is still reachable, with its registration action, so the
    // Owner can act on the emptiness.
    expect(banks.items.map((i) => i.href)).toContain(ROUTES.agencyProviders);
  });

  it('carries no icon on a data-driven branch', () => {
    /*
      A Lucide icon is a React component, and a component cannot cross the
      Server/Client boundary — React Server Components refuses it at render
      time and the error takes down the whole page. The dynamic branches are
      built from data the shell read, so an icon on one would be exactly that.
    */
    const check = (group: NavGroup): void => {
      if (group.id.startsWith('agency-bank-') || group.id.startsWith('agency-money-')) {
        expect(group.icon, group.id).toBeUndefined();
      }
      for (const child of group.groups ?? []) check(child);
    };

    for (const group of ownerAgency().groups ?? []) check(group);
  });
});

describe('the Agency rail — authorization', () => {
  it('declares, for every destination at every depth, the capability its route guards', () => {
    /*
      The parity guarantee, applied to the dynamic entries as well.

      `navigation.test.tsx` asserts this over `NAV_ITEMS`, which is the static
      tree. The branches built from the database are not in `NAV_ITEMS` — they
      cannot be, they do not exist until a request reads them — so the same
      assertion is made here over a grafted tree.
    */
    for (const item of moduleItems(ownerAgency())) {
      expect(permissionForPath(navPath(item.href)), item.href).toBe(item.permission);
    }
  });

  it('keeps every Agency destination in the flat NAV_ITEMS the parity test reads', () => {
    // `NAV_ITEMS` used to be `block.items` alone. Leaving it that way after
    // the rail grew a third level would have dropped every Agency destination
    // out of the parity test — silently, by passing.
    const flat = new Set(NAV_ITEMS.map((i) => i.href));
    for (const item of moduleItems(agencyModule())) {
      expect(flat, item.href).toContain(item.href);
    }
  });

  it('shows a borrower no Agency branch at all', () => {
    // A borrower holds no agency capability. The branch must not survive on
    // an empty state: "Mobile Money exists and is empty" is both untrue and
    // none of their business.
    const modules = withAgencyNavData(
      visibleNavModules(ROLE_PERMISSIONS.client),
      FIXTURE,
    );
    expect(modules.map((m) => m.id)).not.toContain('agency');
  });

  it('gives a Secretary/Treasurer the counter and not the configuration', () => {
    const permissions = ROLE_PERMISSIONS.secretary_treasurer;
    const modules = withAgencyNavData(visibleNavModules(permissions), FIXTURE);
    const agency = modules.find((m) => m.id === 'agency');
    expect(agency).toBeDefined();

    const hrefs = agency === undefined ? [] : moduleItems(agency).map((i) => i.href);

    // They record transactions and cash bankings: both need `agency:write`.
    expect(hrefs).toContain(ROUTES.agencyRecord);
    expect(hrefs).toContain(ROUTES.agencyCashBanking);

    // They do not configure providers or register accounts: `agency:providers`
    // is the Owner's.
    expect(permissions).not.toContain('agency:providers');
    expect(hrefs).not.toContain(ROUTES.agencyProviders);
    expect(hrefs).not.toContain(ROUTES.agencyLines);

    // Nor do they fund float, which needs `agency:settlements`.
    expect(hrefs).not.toContain(ROUTES.agencyReplenish);
  });

  it('gives a Manager the verification and reversal work', () => {
    const permissions = ROLE_PERMISSIONS.manager;
    const modules = withAgencyNavData(visibleNavModules(permissions), FIXTURE);
    const agency = modules.find((m) => m.id === 'agency');
    const hrefs = agency === undefined ? [] : moduleItems(agency).map((i) => i.href);

    expect(hrefs).toContain(ROUTES.agencyPending);
    expect(hrefs).toContain(ROUTES.agencyReplenish);
    expect(hrefs).toContain(ROUTES.agencyTransfers);
    // Configuration is still the Owner's.
    expect(hrefs).not.toContain(ROUTES.agencyProviders);
  });

  it('hides a branch nobody in it can reach, rather than emptying it', () => {
    // The configuration branch's three entries need `agency:providers` or
    // `agency:reports`. A Secretary holds `agency:reports`, so the branch
    // survives — with the two Owner-only entries gone, not greyed out.
    const banks = groupById(
      withAgencyNavData(
        visibleNavModules(ROLE_PERMISSIONS.secretary_treasurer),
        FIXTURE,
      ).find((m) => m.id === 'agency')?.groups ?? [],
      'agency-banking-banks',
    );

    expect(banks.items.map((i) => i.href)).toEqual([ROUTES.agencyBankingAccounts]);
  });
});

describe('the Agency rail — which branches open', () => {
  it('opens every branch on the path to the page being viewed', () => {
    /*
      Arriving at a line's page should reveal the line under its provider under
      Mobile Money — three headers. A reader who had to open three branches to
      find where they already are is being asked to navigate to their own
      location, and a branch whose parent is closed is not visible however open
      it claims to be.
    */
    const block = ownerAgency();
    const lineHref = `${ROUTES.agencyAccounts}/33333333-3333-4333-8333-333333333333`;

    const current = currentNavItem(moduleItems(block), lineHref, null);
    expect(current?.href).toBe(lineHref);

    expect(activeNavGroupIds(block, current)).toEqual([
      'agency-money',
      'agency-money-TESTNET_1',
      'agency-money-TESTNET_1-lines',
    ]);
  });

  it('opens the bank branch on the path to a bank agent account', () => {
    const block = ownerAgency();
    const accountHref = `${ROUTES.agencyAccounts}/11111111-1111-4111-8111-111111111111`;
    const current = currentNavItem(moduleItems(block), accountHref, null);

    expect(activeNavGroupIds(block, current)).toEqual([
      'agency-banking',
      'agency-banking-banks',
      'agency-bank-TESTBANK_A',
    ]);
  });

  it('opens only the outer branch for an operation that is not in one', () => {
    const block = ownerAgency();
    const current = currentNavItem(moduleItems(block), ROUTES.agencyCashBanking, null);
    expect(activeNavGroupIds(block, current)).toEqual(['agency-banking']);
  });

  it('lights exactly one entry for a reporting section', () => {
    // Nine entries share the `/agency/reports` prefix and differ only by
    // `?section=`. Two lit rows would tell the reader they are in two places.
    const block = ownerAgency();
    const params = new URLSearchParams('section=commission');
    const current = currentNavItem(moduleItems(block), ROUTES.agencyReports, params);

    expect(current?.href).toBe(`${ROUTES.agencyReports}?section=commission`);
  });

  it('lights the overview, not a section, when no section is asked for', () => {
    const block = ownerAgency();
    const current = currentNavItem(moduleItems(block), ROUTES.agencyReports, null);
    expect(current?.href).toBe(ROUTES.agencyReports);
  });
});
