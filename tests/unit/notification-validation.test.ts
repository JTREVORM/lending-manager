import { describe, expect, it } from 'vitest';

import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CATEGORY_LABELS,
  NOTIFICATION_ENTITY_TYPES,
  NOTIFICATION_GROUPED_CATEGORIES,
  NOTIFICATION_GROUPS,
  NOTIFICATION_SEVERITIES,
  NOTIFICATION_SEVERITY_DESCRIPTIONS,
  NOTIFICATION_SEVERITY_LABELS,
  NOTIFICATION_SEVERITY_RANK,
  badgeCount,
  categoriesInGroup,
  isNotificationCategory,
  isNotificationEntityType,
  isNotificationGroup,
  isNotificationSeverity,
  notificationHref,
} from '@/lib/domain/notification';
import {
  markNotificationsReadSchema,
  notificationSearchSchema,
} from '@/lib/validation/notification';

const ROUTES = {
  loans: '/loans',
  payments: '/payments',
  clients: '/clients',
  guarantors: '/guarantors',
  transfers: '/finance/transfers',
  expenses: '/finance/expenses',
  reconciliation: '/finance/reconciliation',
  finance: '/finance',
} as const;

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

/**
 * Phase 15's vocabulary, as rules.
 *
 * The database decides what is raised and who may read it; these are the two
 * things only the application can get wrong — where a notification takes you,
 * and whether every category is reachable by a filter.
 */

// ---------------------------------------------------------------------------
describe('the category vocabulary', () => {
  it('labels every category', () => {
    for (const category of NOTIFICATION_CATEGORIES) {
      expect(NOTIFICATION_CATEGORY_LABELS[category], category).toBeTruthy();
    }
  });

  it('puts every category in exactly one filter group', () => {
    // The useful failure: a category added to the schema and to the labels but
    // left out of the chips is one a person can never filter to, and nothing
    // else would notice.
    const grouped = [...NOTIFICATION_GROUPED_CATEGORIES].sort();
    const all = [...NOTIFICATION_CATEGORIES].sort();

    expect(grouped).toEqual(all);
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  it('resolves a group to the categories the server will filter on', () => {
    expect(categoriesInGroup('decisions')).toContain('loan_awaiting_approval');
    expect(categoriesInGroup('money')).toContain('payment_reversed');
    expect(categoriesInGroup('money')).toContain('low_float');
    // Not a category that belongs to another group.
    expect(categoriesInGroup('money')).not.toContain('penalty_applied');
  });

  it('recognises its own values and nothing else', () => {
    for (const value of NOTIFICATION_CATEGORIES) {
      expect(isNotificationCategory(value)).toBe(true);
    }
    for (const value of NOTIFICATION_SEVERITIES) {
      expect(isNotificationSeverity(value)).toBe(true);
    }
    for (const value of NOTIFICATION_ENTITY_TYPES) {
      expect(isNotificationEntityType(value)).toBe(true);
    }
    for (const group of NOTIFICATION_GROUPS) {
      expect(isNotificationGroup(group.value)).toBe(true);
    }

    expect(isNotificationCategory('loan_went_late')).toBe(false);
    expect(isNotificationSeverity('critical')).toBe(false);
    expect(isNotificationEntityType('invoice')).toBe(false);
    expect(isNotificationGroup('everything')).toBe(false);
  });

  it('has no category for a loan merely becoming late', () => {
    // The rule the whole design rests on. Arrears is derived on every read so
    // that no column can go stale; a stored notification claiming a loan is
    // overdue would be right on Tuesday and wrong on Wednesday.
    //
    // Matched per underscore-separated word rather than by substring, because
    // a substring search for "late" finds it inside "col-late-ral".
    const forbidden = new Set(['overdue', 'late', 'arrears', 'aging', 'par']);

    for (const category of NOTIFICATION_CATEGORIES) {
      for (const word of category.split('_')) {
        expect(forbidden.has(word), `${category} / ${word}`).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
describe('severity', () => {
  it('describes all three, so they can be applied consistently', () => {
    for (const severity of NOTIFICATION_SEVERITIES) {
      expect(NOTIFICATION_SEVERITY_LABELS[severity], severity).toBeTruthy();
      expect(NOTIFICATION_SEVERITY_DESCRIPTIONS[severity], severity).toBeTruthy();
    }
  });

  it('ranks urgent above attention above information', () => {
    expect(NOTIFICATION_SEVERITY_RANK.urgent).toBeLessThan(
      NOTIFICATION_SEVERITY_RANK.attention,
    );
    expect(NOTIFICATION_SEVERITY_RANK.attention).toBeLessThan(
      NOTIFICATION_SEVERITY_RANK.info,
    );
  });

  it('offers three levels and not five', () => {
    // A fourth would be a judgement nobody could apply consistently, and a
    // bell where everything is urgent is a bell nobody reads.
    expect(NOTIFICATION_SEVERITIES).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
describe('where a notification takes you', () => {
  it('opens the loan for anything about a loan', () => {
    expect(notificationHref('loan', ID, ROUTES)).toBe(`/loans/${ID}`);
    // Security hangs off its loan: there is no page for an item on its own,
    // and the loan's own screen is where the item is shown.
    expect(notificationHref('collateral', ID, ROUTES)).toBe(`/loans/${ID}`);
  });

  it('opens the record for a payment, a client and a guarantor', () => {
    expect(notificationHref('payment', ID, ROUTES)).toBe(`/payments/${ID}`);
    expect(notificationHref('client', ID, ROUTES)).toBe(`/clients/${ID}`);
    expect(notificationHref('guarantor', ID, ROUTES)).toBe(`/guarantors/${ID}`);
  });

  it('opens the register for the money movements, which have no detail page', () => {
    expect(notificationHref('transfer', ID, ROUTES)).toBe('/finance/transfers');
    expect(notificationHref('expense', ID, ROUTES)).toBe('/finance/expenses');
    expect(notificationHref('reconciliation', ID, ROUTES)).toBe(
      '/finance/reconciliation',
    );
  });

  it('sends a low float to the cash position, which shows every account', () => {
    expect(notificationHref('ledger_account', ID, ROUTES)).toBe('/finance');
    // And with no id at all, because the screen is the subject.
    expect(notificationHref('ledger_account', null, ROUTES)).toBe('/finance');
  });

  it('returns nothing rather than a plausible path when there is no subject', () => {
    // A dead control is worse than no control.
    expect(notificationHref('loan', null, ROUTES)).toBeNull();
    expect(notificationHref('payment', null, ROUTES)).toBeNull();
  });

  it('has a destination for every entity type the schema allows', () => {
    for (const entityType of NOTIFICATION_ENTITY_TYPES) {
      expect(notificationHref(entityType, ID, ROUTES), entityType).not.toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
describe('the badge', () => {
  it('says nothing when there is nothing', () => {
    expect(badgeCount(0)).toBe('');
    expect(badgeCount(-1)).toBe('');
  });

  it('shows the count up to ninety-nine', () => {
    expect(badgeCount(1)).toBe('1');
    expect(badgeCount(99)).toBe('99');
  });

  it('caps above that, because a three-digit badge does not fit', () => {
    // "99+" tells a reader everything "137" would: there are more than you
    // are going to clear standing at the counter.
    expect(badgeCount(100)).toBe('99+');
    expect(badgeCount(4000)).toBe('99+');
  });
});

// ---------------------------------------------------------------------------
describe('marking read', () => {
  it('accepts a list of ids', () => {
    const parsed = markNotificationsReadSchema.safeParse({ ids: [ID] });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.ids).toEqual([ID]);
  });

  it('reads a missing list as "everything I can see"', () => {
    const parsed = markNotificationsReadSchema.safeParse({});

    expect(parsed.success).toBe(true);
    // Null, not an empty array: null is the "mark all read" control and an
    // empty array would be a request to mark nothing. The two controls stay
    // distinguishable to the server.
    expect(parsed.success && parsed.data.ids).toBeNull();
  });

  it('keeps an empty list distinct from no list', () => {
    const parsed = markNotificationsReadSchema.safeParse({ ids: [] });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.ids).toEqual([]);
  });

  it('refuses something that is not an identifier', () => {
    expect(markNotificationsReadSchema.safeParse({ ids: ['all'] }).success).toBe(false);
  });

  it('refuses more than one request should carry', () => {
    const many = Array.from({ length: 201 }, () => ID);
    expect(markNotificationsReadSchema.safeParse({ ids: many }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('the page filter', () => {
  it('reads an empty filter as no filter', () => {
    const parsed = notificationSearchSchema.safeParse({
      group: '',
      severity: '',
      unread: '',
      page: '',
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.group).toBeNull();
    expect(parsed.success && parsed.data.severity).toBeNull();
    expect(parsed.success && parsed.data.unread).toBe(false);
    expect(parsed.success && parsed.data.page).toBe(1);
  });

  it('reads the unread toggle from the one value the chip sets', () => {
    expect(
      notificationSearchSchema.safeParse({ unread: '1' }).success &&
        notificationSearchSchema.parse({ unread: '1' }).unread,
    ).toBe(true);
    expect(notificationSearchSchema.parse({ unread: '0' }).unread).toBe(false);
  });

  it('falls back to the first page rather than erroring on a hand-edited one', () => {
    const parsed = notificationSearchSchema.safeParse({ page: 'nonsense' });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.page).toBe(1);
  });

  it('refuses a group it does not know', () => {
    expect(notificationSearchSchema.safeParse({ group: 'everything' }).success).toBe(
      false,
    );
  });

  it('accepts every group the chips offer', () => {
    for (const group of NOTIFICATION_GROUPS) {
      expect(
        notificationSearchSchema.safeParse({ group: group.value }).success,
        group.value,
      ).toBe(true);
    }
  });
});
