/**
 * The notification vocabulary, and the one piece of arithmetic the bell needs.
 *
 * Pure. The database decides what gets raised, to whom, and whether a given
 * reader may see it; this module is how the fourteen categories are written on
 * screen and where each one links to.
 *
 * ## Why the deep link lives here and not in the row
 *
 * `notifications` carries `entity_type` and `entity_id` — the *subject* — and
 * not a URL. A stored path would be a route committed to a table: rename
 * `/overdue` and every notification raised before the rename points at a 404,
 * with nothing to fix it but a data migration. The subject is stable; the
 * route is this application's business, and `notificationHref` is where that
 * mapping is written once.
 */

/* ------------------------------------------------------------------ */
/* Categories                                                          */
/* ------------------------------------------------------------------ */

export const NOTIFICATION_CATEGORIES = [
  'loan_awaiting_approval',
  'loan_awaiting_disbursement',
  'loan_decided',
  'loan_disbursed',
  'loan_cleared',
  'payment_reversed',
  'penalty_applied',
  'promise_recorded',
  'guarantor_released',
  'collateral_realised',
  'approval_pending',
  'reconciliation_variance',
  'low_float',
  'client_blacklisted',
] as const;

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export function isNotificationCategory(value: unknown): value is NotificationCategory {
  return (
    typeof value === 'string' &&
    (NOTIFICATION_CATEGORIES as readonly string[]).includes(value)
  );
}

export const NOTIFICATION_CATEGORY_LABELS: Readonly<
  Record<NotificationCategory, string>
> = {
  loan_awaiting_approval: 'Awaiting approval',
  loan_awaiting_disbursement: 'Awaiting disbursement',
  loan_decided: 'Application decided',
  loan_disbursed: 'Disbursed',
  loan_cleared: 'Cleared',
  payment_reversed: 'Payment reversed',
  penalty_applied: 'Penalty charged',
  promise_recorded: 'Promise to pay',
  guarantor_released: 'Guarantor released',
  collateral_realised: 'Security sold',
  approval_pending: 'Awaiting a decision',
  reconciliation_variance: 'Cash count',
  low_float: 'Float running low',
  client_blacklisted: 'Borrower blacklisted',
};

/**
 * The filter chips, in the order a staff member would work through them.
 *
 * Not one chip per category — fourteen chips do not fit and most people want
 * one of four questions answered. Each group names the categories it covers,
 * so the server filters on the real column rather than on a label.
 */
export const NOTIFICATION_GROUPS = [
  {
    value: 'decisions',
    label: 'Needs a decision',
    categories: [
      'loan_awaiting_approval',
      'loan_awaiting_disbursement',
      'approval_pending',
      'reconciliation_variance',
    ],
  },
  {
    value: 'collections',
    label: 'Collections',
    categories: ['penalty_applied', 'promise_recorded', 'collateral_realised'],
  },
  {
    value: 'lending',
    label: 'Lending',
    categories: [
      'loan_decided',
      'loan_disbursed',
      'loan_cleared',
      'guarantor_released',
      'client_blacklisted',
    ],
  },
  {
    value: 'money',
    label: 'Money',
    categories: ['payment_reversed', 'low_float'],
  },
] as const satisfies readonly {
  readonly value: string;
  readonly label: string;
  readonly categories: readonly NotificationCategory[];
}[];

export type NotificationGroup = (typeof NOTIFICATION_GROUPS)[number]['value'];

export function isNotificationGroup(value: unknown): value is NotificationGroup {
  return (
    typeof value === 'string' &&
    NOTIFICATION_GROUPS.some((group) => (group.value as string) === value)
  );
}

/** The categories a group covers, for the server-side filter. */
export function categoriesInGroup(
  group: NotificationGroup,
): readonly NotificationCategory[] {
  return (
    NOTIFICATION_GROUPS.find((candidate) => candidate.value === group)?.categories ?? []
  );
}

/**
 * Every category belongs to exactly one group.
 *
 * Asserted by a test rather than enforced by a type, because the useful
 * failure is "a category you added shows up under no chip and is therefore
 * unreachable by filter" — which a type cannot say and a one-line test can.
 */
export const NOTIFICATION_GROUPED_CATEGORIES: readonly NotificationCategory[] =
  NOTIFICATION_GROUPS.flatMap((group) => [...group.categories]);

/* ------------------------------------------------------------------ */
/* Severity                                                            */
/* ------------------------------------------------------------------ */

export const NOTIFICATION_SEVERITIES = ['info', 'attention', 'urgent'] as const;

export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];

export function isNotificationSeverity(value: unknown): value is NotificationSeverity {
  return (
    typeof value === 'string' &&
    (NOTIFICATION_SEVERITIES as readonly string[]).includes(value)
  );
}

export const NOTIFICATION_SEVERITY_LABELS: Readonly<
  Record<NotificationSeverity, string>
> = {
  info: 'For information',
  attention: 'Needs attention',
  urgent: 'Urgent',
};

/**
 * Three levels, and what each one means.
 *
 * Written down because the whole value of a severity is that it is applied
 * consistently: a bell where everything is urgent is a bell nobody reads.
 */
export const NOTIFICATION_SEVERITY_DESCRIPTIONS: Readonly<
  Record<NotificationSeverity, string>
> = {
  info: 'Something happened. Nobody has to do anything about it.',
  attention: 'Somebody has to do something about this.',
  urgent: 'Something is wrong, or money is unaccounted for.',
};

/** Worst first, which is the order the page shows them in. */
export const NOTIFICATION_SEVERITY_RANK: Readonly<Record<NotificationSeverity, number>> =
  {
    urgent: 0,
    attention: 1,
    info: 2,
  };

/* ------------------------------------------------------------------ */
/* Deep links                                                          */
/* ------------------------------------------------------------------ */

export const NOTIFICATION_ENTITY_TYPES = [
  'loan',
  'payment',
  'client',
  'guarantor',
  'collateral',
  'transfer',
  'expense',
  'reconciliation',
  'ledger_account',
] as const;

export type NotificationEntityType = (typeof NOTIFICATION_ENTITY_TYPES)[number];

export function isNotificationEntityType(
  value: unknown,
): value is NotificationEntityType {
  return (
    typeof value === 'string' &&
    (NOTIFICATION_ENTITY_TYPES as readonly string[]).includes(value)
  );
}

/**
 * Where a notification takes you.
 *
 * `null` where there is nothing specific to open — a float is an account
 * balance, and the cash position screen shows all four at once, so the link
 * goes there rather than to a per-account page that does not exist. Returning
 * null rather than a plausible-looking path is deliberate: a dead control is
 * worse than no control.
 */
export function notificationHref(
  entityType: NotificationEntityType,
  entityId: string | null,
  routes: {
    readonly loans: string;
    readonly payments: string;
    readonly clients: string;
    readonly guarantors: string;
    readonly transfers: string;
    readonly expenses: string;
    readonly reconciliation: string;
    readonly finance: string;
  },
): string | null {
  if (entityId === null) {
    // Only the two that are about a screen rather than a record.
    return entityType === 'ledger_account' ? routes.finance : null;
  }

  switch (entityType) {
    case 'loan':
    case 'collateral':
      return `${routes.loans}/${entityId}`;
    case 'payment':
      return `${routes.payments}/${entityId}`;
    case 'client':
      return `${routes.clients}/${entityId}`;
    case 'guarantor':
      return `${routes.guarantors}/${entityId}`;
    case 'transfer':
      return routes.transfers;
    case 'expense':
      return routes.expenses;
    case 'reconciliation':
      return routes.reconciliation;
    case 'ledger_account':
      // The cash position shows every account's balance, which is what a low
      // float is about. There is no per-account page to link to.
      return routes.finance;
  }
}

/**
 * What the bell's badge says.
 *
 * Capped, because a three-digit badge does not fit the dot and "99+" tells a
 * reader everything "137" would: there are more than you are going to clear
 * standing at the counter.
 */
export function badgeCount(unread: number): string {
  if (unread <= 0) return '';
  return unread > 99 ? '99+' : String(unread);
}
