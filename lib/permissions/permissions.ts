/**
 * The permission matrix.
 *
 * ## Capabilities, not role-name comparisons
 *
 * Authorization is expressed as named capabilities (`users:create`), never as
 * `role === 'owner_admin'` scattered through components. That matters for a
 * reason beyond tidiness: when the business later decides a Manager may reset
 * passwords, the change is one line in this table, not a hunt through every
 * screen and endpoint for role checks that happened to encode the old rule.
 *
 * ## Grants are explicit, never derived from rank
 *
 * `ROLE_RANK` exists, and it is deliberately **not** used to decide
 * permissions. A Manager outranks a Secretary/Treasurer, but a Manager does
 * not therefore receive every capability a future Owner-only feature adds.
 * Each role's grants are listed by hand, so a new permission defaults to being
 * held by nobody until somebody decides who should have it.
 *
 * Rank is used for two narrow things, both documented where they happen:
 * ordering roles in the interface, and the rule that an administrator may not
 * assign a role outranking their own.
 *
 * ## Multiple roles are additive
 *
 * A profile may hold several roles. The effective permission set is the
 * **union** of every held role's grants; there are no deny rules, so adding a
 * role can only ever widen access. `can()` returns true if any held role
 * grants the capability.
 *
 * ## This is one of two enforcement layers, not the boundary
 *
 * These checks decide whether a control renders and whether a Server Action
 * proceeds. A caller holding a valid token can skip all of it by calling the
 * Supabase REST API directly, so **Row Level Security is the real boundary**.
 *
 * Every grant here is mirrored into `public.role_permissions` by migration
 * `20261002000100`, and RLS policies are written against
 * `public.user_has_permission(...)`. A database test asserts the two
 * representations are identical, so this file and the policies cannot drift
 * apart.
 */

import { ROLE_KEYS, type RoleKey } from './roles';

/**
 * Named capabilities, as `resource:action`.
 *
 * The colon separator is the Phase 1 convention and is kept deliberately —
 * `resource:action` reads unambiguously because resources never contain a
 * colon, whereas a dot is also how nested fields are written elsewhere in the
 * codebase.
 *
 * Permissions for unbuilt lending functionality are **not** declared here.
 * A permission nothing enforces is a false assurance, and the matrix is
 * cheaper to extend than to audit.
 */
export const PERMISSIONS = [
  // --- Application shell ---------------------------------------------------
  /** Reach the authenticated staff shell and its dashboard. */
  'dashboard:view',

  // --- Own account ---------------------------------------------------------
  /** View one's own profile and account details. */
  'account:view',
  /** Change one's own non-privileged details (name, contact email). */
  'account:update',

  // --- Client portal -------------------------------------------------------
  /** Reach the client portal. Borrowers only. */
  'portal:view',

  // --- User administration -------------------------------------------------
  /** See the staff directory and individual user records. */
  'users:view',
  /** Create a staff account and its linked authentication identity. */
  'users:create',
  /** Change another user's name or contact details. */
  'users:update',
  /** Activate, suspend or archive another user's account. */
  'users:disable',
  /** Grant or revoke role assignments. */
  'users:assign_role',
  /** Set another user's password to a temporary value. */
  'users:reset_password',

  // --- Settings ------------------------------------------------------------
  /** Read company and business settings. */
  'settings:view',
  /** Change company or business settings. */
  'settings:update',

  // --- Audit ---------------------------------------------------------------
  /** Read the audit trail. */
  'audit:view',

  // --- Branch network ------------------------------------------------------
  /** See the branch network, its branches and their performance. */
  'branches:view',
  /** Open a new branch. */
  'branches:create',
  /** Change a branch's details, its manager or its status. */
  'branches:update',

  // --- Financial ledger ----------------------------------------------------
  // Reading the ledger is separated from posting to it because almost nobody
  // should post. An operational act — taking a payment, releasing money,
  // moving cash to the bank — writes its own balanced journal; a person
  // hand-constructing one is correcting something, and that is the Owner's.
  /** Read account balances, journals, the general ledger and the trial balance. */
  'ledger:view',
  /** Hand-post a journal entry. Corrections only. */
  'ledger:post',

  // --- Money movement ------------------------------------------------------
  // Phase 11. Recording a movement and agreeing to it are separate
  // capabilities throughout, because an approval step where the same person
  // holds both is not a control, it is paperwork. `record_transfer` and
  // `record_expense` additionally refuse an approval from the person who
  // asked for it, so holding both capabilities still does not let one person
  // move money above the threshold alone.
  /** See transfers between the company's own accounts. */
  'transfers:view',
  /** Move money between the company's own accounts. */
  'transfers:create',
  /** Approve, reject or reverse a transfer. */
  'transfers:approve',
  /** See what the business has spent. */
  'expenses:view',
  /** Record an expense. */
  'expenses:create',
  /** Approve, reject or reverse an expense. */
  'expenses:approve',
  /** See non-loan income. */
  'income:view',
  /** Record a fee or other non-loan income. */
  'income:create',
  /** See account reconciliations and their differences. */
  'reconciliation:view',
  /** Count an account and record what was found. */
  'reconciliation:perform',
  /** Approve a reconciliation difference, writing it off to Cash Over and Short. */
  'reconciliation:approve',
  /** Change approval thresholds, overdraft policy and low-balance levels. */
  'finance:settings',
  /** Add or retire a ledger account, including an expense or income category. */
  'finance:accounts',

  // --- Loan products -------------------------------------------------------
  // Phase 12. Reading the catalogue is ordinary work — a loan officer has to
  // know what the business sells. Changing it is pricing, which is the
  // Owner's for the same reason `settings:update` is: a Manager who could
  // reprice a product could lend at a rate nobody agreed.
  /** See the loan products and their terms. */
  'products:view',
  /** Create a loan product, change its terms, or retire it. */
  'products:manage',

  // --- Clients -------------------------------------------------------------
  // The spelling is `resource:action` with one colon, which is the format the
  // `permissions` table constrains. Where the Phase 3 specification suggested
  // a nested `clients:remarks:view`, the capability is named
  // `clients:remarks_view` instead; the grant is the same.
  /** See the client directory, search clients, and open a client record. */
  'clients:view',
  /** Register a new client. */
  'clients:create',
  /** Change a client's ordinary details. */
  'clients:update',
  /** Move a client between active, inactive and suspended. */
  'clients:status',
  /** Blacklist a client, or lift a blacklisting. */
  'clients:blacklist',
  /** Archive a client record, which replaces deletion. */
  'clients:archive',
  /** Upload or replace a client's photograph and identity document. */
  'clients:documents',
  /** Read a client's National Identification Number and identity document. */
  'clients:view_nin',
  /** Link or unlink a client record and a portal login. */
  'clients:link_auth',
  /** Read internal staff remarks on a client. */
  'clients:remarks_view',
  /** Add an internal staff remark to a client. */
  'clients:remarks_create',

  // --- Guarantors ----------------------------------------------------------
  /** See the guarantor directory and open a guarantor record. */
  'guarantors:view',
  /** Register a new guarantor. */
  'guarantors:create',
  /** Change a guarantor's details. */
  'guarantors:update',
  /** Upload or replace a guarantor's photograph. */
  'guarantors:documents',
  /** Read a guarantor's National Identification Number. */
  'guarantors:view_nin',
  /** Attach a guarantor to a client, or detach one. */
  'guarantors:link',

  // --- Loans ---------------------------------------------------------------
  // The lifecycle is split across several capabilities rather than one
  // `loans:manage`, because the separation between *entering* a loan,
  // *approving* it and *releasing the money* is the main internal control a
  // lending business of this size has. One capability would collapse all
  // three into the same person.
  /** See the loan register and open a loan record. */
  'loans:view',
  /** Start a loan draft and enter its details. */
  'loans:create',
  /** Change a loan while it is still a draft. */
  'loans:update_draft',
  /** Submit a completed draft for approval. */
  'loans:submit',
  /** Approve a loan, or return it to draft for correction. */
  'loans:approve',
  /** Release the money and activate an approved loan. */
  'loans:disburse',
  /** Cancel a loan before it is disbursed. */
  'loans:cancel',
  /** Read the identity snapshots captured against a loan. */
  'loans:view_sensitive',

  // Phase 5. One capability, not a `schedules:view` / `schedules:view_all`
  // pair: a schedule is visible exactly when its loan is, and every staff
  // role that reads schedules already reads the whole loan register, so the
  // two would grant the same thing under different names. A capability that
  // cannot be told apart from another is a false promise about what the
  // system enforces. See migration 20261005000100.
  //
  // There is no create, edit or delete counterpart. The schedule is generated
  // by the database inside the disbursement transaction and is then
  // contractual history; no role may write one, so no capability exists to be
  // granted by mistake.
  /** See the repayment collection schedule generated for a loan. */
  'schedules:view',

  // Phase 6. Recording a payment and *un*recording one are deliberately
  // separate capabilities, and reversal is the Owner's alone — the direct
  // analogue of Phase 4 withholding `loans:disburse` from the Manager. A
  // staff member who could both post and reverse could pocket a cash payment,
  // hand over a receipt and withdraw the record afterwards, leaving a trail
  // they wrote themselves.
  //
  // There is no `payments:view_receipt`: a receipt is a rendering of a
  // payment, so anybody who can read the payment already reads every figure
  // on it. And no edit or delete capability, because financial history is
  // corrected by reversing, never by rewriting.
  /** See the payment register, a payment record and its receipt. */
  'payments:view',
  /** Record a payment received from a borrower. */
  'payments:create',
  /** Reverse a payment recorded in error. */
  'payments:reverse',

  // Phase 7. Both read-only, because nothing in delinquency is entered by a
  // person: arrears are derived from the schedule and the ledger, and the
  // penalty is calculated by a trusted database function from the loan's own
  // snapshotted terms.
  //
  // There is deliberately no `penalties:create`, `penalties:edit`,
  // `penalties:delete` or `penalties:waive`. A penalty amount a staff member
  // could type would not be a penalty — it would be a charge, and the
  // business rule says 50% of what the borrower owed when the grace period
  // ran out, which is a figure only the ledger knows.
  //
  // They are separate from each other because they answer different questions:
  // the overdue list is the collections team's working tool, while a penalty
  // is a charge against a borrower's account and the kind of figure a business
  // may later want to restrict. Separating them now costs one entry.
  /** See arrears, missed collections and the overdue list across loans. */
  'delinquency:view',
  /** See a loan's expiry penalty: its basis, rate, amount and what remains. */
  'penalties:view',

  // Phase 8. Reporting is split by *what the figures reveal*, not by which
  // screen they appear on. One `reports:view` would have meant that the person
  // who counts cash over the counter and the person who owns the business see
  // the same screens, and the first financial report shipped behind it would
  // have handed the portfolio's interest income to the counter.
  //
  // A reporting capability grants the reporting *surface*, never the rows: the
  // arrears report also needs `delinquency:view`, the collection report also
  // needs `payments:view`, and Row Level Security decides what comes back in
  // either case. So these three widen nobody's access to a record they could
  // not already open one at a time.
  //
  // There is no `reports:export` apart from viewing. A holder who may read a
  // report may take the CSV of exactly the rows it showed them; denying that
  // would be denying copy-and-paste rather than enforcing anything. What
  // export does need is the same check on the server, which the route
  // handlers perform.
  /** Open the operational reports: collections, today's list, arrears, grace. */
  'reports:view_operational',
  /** Open portfolio-wide reports: the loan register, cleared loans, penalties. */
  'reports:view_financial',
  /** Open the executive summary: interest and penalty collected, principal lent. */
  'reports:view_sensitive',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && (PERMISSIONS as readonly string[]).includes(value);
}

/**
 * Grants per role.
 *
 * Every role is listed explicitly — including an empty set, were one empty —
 * so that adding a role to `ROLE_KEYS` without deciding its grants is a type
 * error rather than a silent denial.
 *
 * ### Why the Manager's set stops where it does
 *
 * A Manager supervises lending operations and needs to see who works here, so
 * they hold `users:view`. They deliberately do **not** hold `users:create`,
 * `users:assign_role`, `users:disable` or `users:reset_password`: those are
 * the capabilities that would let a Manager promote themselves, manufacture an
 * Owner account, or lock the Owner out. Concentrating account administration
 * in one role is the point of having the role.
 *
 * `settings:update` and `audit:view` are Owner-only for the same reason — the
 * first changes the rates money is lent at, the second is the record of who
 * changed them.
 */
export const ROLE_PERMISSIONS: Readonly<Record<RoleKey, readonly Permission[]>> = {
  // A borrower reaches the portal and their own account. Nothing else. They
  // must never see the staff shell, other clients, or any administration.
  // A borrower reaches the portal and their own account. Nothing else.
  //
  // Note what is *not* here: `clients:view`. A borrower does read their own
  // client record, but through the identity clause in the RLS policy on
  // `public.clients`, which is keyed on their profile and grants exactly one
  // row. `clients:view` means "read the directory" everywhere else in the
  // system, and granting it here would mean exactly that.
  client: ['portal:view', 'account:view', 'account:update'],

  secretary_treasurer: [
    'dashboard:view',
    'account:view',
    'account:update',
    'settings:view',

    // Whoever handles the cash has to be able to see where it is. Reading
    // the ledger is not an administrative privilege here; it is the thing a
    // treasurer is for.
    'branches:view',
    'ledger:view',

    // Phase 11. The treasurer is the person who physically moves the money,
    // so they record transfers, expenses, fees and the daily count. They
    // approve none of it: the threshold exists precisely so that a second
    // person sees anything large, and `reconciliation:approve` is what turns
    // a counted difference into a write-off.
    'transfers:view',
    'transfers:create',
    'expenses:view',
    'expenses:create',
    'income:view',
    'income:create',
    'reconciliation:view',
    'reconciliation:perform',
    'products:view',

    // Operational client work: find a client, check their details, correct a
    // phone number, read the remarks left for them to act on.
    //
    // Deliberately absent: `clients:create` (registration mints a client
    // number and is a Manager act), every status capability,
    // `clients:view_nin`, `clients:link_auth`, and `clients:remarks_create` —
    // the specification asks for that last one to be a decision rather than an
    // inheritance, and the decision is no. A Secretary records payments; a
    // remark that will later weigh on a lending decision should carry a
    // Manager's name.
    'clients:view',
    'clients:update',
    'clients:remarks_view',
    'guarantors:view',

    // The business's own description of this role is that they record loan
    // details and amounts. So: everything up to asking for a decision, and
    // nothing that makes one.
    'loans:view',
    'loans:create',
    'loans:update_draft',
    'loans:submit',

    // The Secretary/Treasurer collects the money, so the schedule is the
    // document they work from daily.
    'schedules:view',

    // Records what comes over the counter. Cannot unrecord it.
    'payments:view',
    'payments:create',

    // Chasing collections is this role's daily work.
    'delinquency:view',
    'penalties:view',

    // The collection sheet and the arrears list are this role's working
    // documents all day. Deliberately nothing beyond: portfolio-wide
    // outstanding, business-wide interest income and the executive summary are
    // not needed to take money over a counter, and §42 asks for that to be a
    // decision rather than an inheritance.
    'reports:view_operational',
  ],

  manager: [
    'dashboard:view',
    'account:view',
    'account:update',
    'settings:view',
    'users:view',

    // A Manager runs a branch, so they may correct its details and its
    // manager, and read the money it holds. Opening a new branch is not
    // theirs: it is a commercial act with a cash float behind it.
    'branches:view',
    'branches:update',
    'ledger:view',

    // Phase 11. A Manager is the second pair of eyes on money movement, and
    // may also record it — the posting functions refuse an approval from the
    // person who asked, so holding both does not collapse the control.
    // `finance:settings` and `finance:accounts` are not theirs: changing a
    // threshold or adding an account would let a Manager widen what they may
    // approve without asking.
    'transfers:view',
    'transfers:create',
    'transfers:approve',
    'expenses:view',
    'expenses:create',
    'expenses:approve',
    'income:view',
    'income:create',
    'reconciliation:view',
    'reconciliation:perform',
    'reconciliation:approve',
    'products:view',

    // The Manager runs lending operations, so clients and guarantors are
    // theirs to register, correct and comment on.
    //
    // Two are withheld, both commercial rather than technical decisions.
    // `clients:blacklist` is the business permanently refusing to lend to
    // someone — the one status that is a standing judgement rather than an
    // operational state, and it should carry an Owner's name.
    // `clients:link_auth` decides who can sign in and see a client's data,
    // which is the same class of act as creating a staff account.
    'clients:view',
    'clients:create',
    'clients:update',
    'clients:status',
    'clients:documents',
    'clients:view_nin',
    'clients:remarks_view',
    'clients:remarks_create',
    'guarantors:view',
    'guarantors:create',
    'guarantors:update',
    'guarantors:documents',
    'guarantors:view_nin',
    'guarantors:link',

    // Reviews and approves, and may return a draft for correction.
    //
    // Deliberately **not** `loans:disburse`. A Manager also holds
    // `loans:create`, so granting disbursement as well would let one person
    // originate a loan, approve it and hand over the cash with nobody else
    // involved. Withholding it means the money is released by somebody who
    // did not approve it, which is the whole value of having two roles.
    //
    // Also not `loans:cancel`: cancelling an approved loan reverses a
    // decision, and the person who made it should not be the only one who can
    // unmake it.
    'loans:view',
    'loans:create',
    'loans:update_draft',
    'loans:submit',
    'loans:approve',
    'loans:view_sensitive',

    'schedules:view',

    // The same as the Secretary/Treasurer. A Manager approves loans; that
    // does not extend to withdrawing a payment a borrower holds a receipt for.
    'payments:view',
    'payments:create',

    'delinquency:view',
    'penalties:view',

    // Supervising lending is not possible without seeing the book: what is
    // outstanding, what is late, what has been charged. Still not
    // `reports:view_sensitive` — what the business *earns* is the Owner's
    // figure, and a Manager needs none of it to chase a payment or approve a
    // loan.
    'reports:view_operational',
    'reports:view_financial',
  ],

  owner_admin: [
    'dashboard:view',
    'account:view',
    'account:update',
    'settings:view',
    'settings:update',
    'users:view',

    'branches:view',
    'branches:create',
    'branches:update',
    'ledger:view',
    'ledger:post',

    'transfers:view',
    'transfers:create',
    'transfers:approve',
    'expenses:view',
    'expenses:create',
    'expenses:approve',
    'income:view',
    'income:create',
    'reconciliation:view',
    'reconciliation:perform',
    'reconciliation:approve',
    'finance:settings',
    'finance:accounts',
    'products:view',
    'products:manage',

    'users:create',
    'users:update',
    'users:disable',
    'users:assign_role',
    'users:reset_password',
    'audit:view',

    'clients:view',
    'clients:create',
    'clients:update',
    'clients:status',
    'clients:blacklist',
    'clients:archive',
    'clients:documents',
    'clients:view_nin',
    'clients:link_auth',
    'clients:remarks_view',
    'clients:remarks_create',
    'guarantors:view',
    'guarantors:create',
    'guarantors:update',
    'guarantors:documents',
    'guarantors:view_nin',
    'guarantors:link',

    'loans:view',
    'loans:create',
    'loans:update_draft',
    'loans:submit',
    'loans:approve',
    'loans:disburse',
    'loans:cancel',
    'loans:view_sensitive',

    'schedules:view',

    'payments:view',
    'payments:create',
    'payments:reverse',

    'delinquency:view',
    'penalties:view',

    'reports:view_operational',
    'reports:view_financial',
    'reports:view_sensitive',
  ],
} as const;

/**
 * Does any of these roles grant `permission`?
 *
 * Fails closed: no roles, an unknown role, or an ungranted permission all
 * return `false`.
 */
export function can(roles: readonly RoleKey[], permission: Permission): boolean {
  return roles.some((role) => ROLE_PERMISSIONS[role]?.includes(permission) === true);
}

/** Every permission these roles grant between them, deduplicated. */
export function permissionsFor(roles: readonly RoleKey[]): readonly Permission[] {
  const granted = new Set<Permission>();
  for (const role of roles) {
    for (const permission of ROLE_PERMISSIONS[role] ?? []) granted.add(permission);
  }
  return [...granted];
}

/** Do these roles grant every one of `permissions`? */
export function canAll(
  roles: readonly RoleKey[],
  permissions: readonly Permission[],
): boolean {
  return permissions.every((permission) => can(roles, permission));
}

/** Do these roles grant at least one of `permissions`? */
export function canAny(
  roles: readonly RoleKey[],
  permissions: readonly Permission[],
): boolean {
  return permissions.some((permission) => can(roles, permission));
}

/**
 * Exhaustiveness guard, evaluated at module load.
 *
 * If a role is added to `ROLE_KEYS` without an entry in `ROLE_PERMISSIONS`,
 * the `Record<RoleKey, …>` type already fails to compile. This runtime check
 * covers the reverse direction and the case of types being bypassed.
 */
const missingRoles = ROLE_KEYS.filter((role) => ROLE_PERMISSIONS[role] === undefined);
if (missingRoles.length > 0) {
  throw new Error(
    `ROLE_PERMISSIONS is missing an entry for: ${missingRoles.join(', ')}. Every role must declare its grants, even if empty.`,
  );
}

/**
 * Flattened `(role, permission)` pairs, sorted deterministically.
 *
 * This is the shape seeded into `public.role_permissions`, and the shape a
 * database test compares against. Keeping the projection here means the
 * migration and the test read from one definition.
 */
export function rolePermissionPairs(): readonly {
  role: RoleKey;
  permission: Permission;
}[] {
  return ROLE_KEYS.flatMap((role) =>
    [...ROLE_PERMISSIONS[role]].sort().map((permission) => ({ role, permission })),
  ).sort((a, b) =>
    a.role === b.role
      ? a.permission.localeCompare(b.permission)
      : a.role.localeCompare(b.role),
  );
}
