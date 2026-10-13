/**
 * Security taken against a loan, and the work of recovering one that has gone
 * bad.
 *
 * Pure vocabulary. Every rule it names is enforced in the database —
 * `loan_collateral_guard` freezes an item's identity at disbursement,
 * `loan_recovery_actions` refuses every UPDATE and DELETE, and
 * `release_loan_guarantor` checks the capability and the product's minimum.
 * What lives here is how the screens say those things to the person at the
 * counter.
 *
 * ## Why a promise has no stored status
 *
 * `PROMISE_STATUSES` describes a value the database *derives* — posted
 * payments between the promise and its date, against the amount promised. No
 * column holds it, nothing has to remember to mark a promise broken, and a
 * reversal that undoes a payment un-keeps the promise by itself. The labels
 * below are therefore the only place a promise status is ever written down,
 * and none of them may imply a contractual consequence: a broken promise is a
 * borrower who did not do what they said, not a borrower in default, and the
 * two must not read the same.
 */

/* ------------------------------------------------------------------ */
/* Collateral                                                          */
/* ------------------------------------------------------------------ */

export const COLLATERAL_ITEM_TYPES = [
  'land_title',
  'building',
  'motor_vehicle',
  'motorcycle',
  'bicycle',
  'electronics',
  'furniture',
  'machinery',
  'livestock',
  'stock_in_trade',
  'household_goods',
  'other',
] as const;

export type CollateralItemType = (typeof COLLATERAL_ITEM_TYPES)[number];

export function isCollateralItemType(value: unknown): value is CollateralItemType {
  return (
    typeof value === 'string' &&
    (COLLATERAL_ITEM_TYPES as readonly string[]).includes(value)
  );
}

export const COLLATERAL_ITEM_TYPE_LABELS: Readonly<Record<CollateralItemType, string>> = {
  land_title: 'Land title',
  building: 'Building',
  motor_vehicle: 'Motor vehicle',
  motorcycle: 'Motorcycle',
  bicycle: 'Bicycle',
  electronics: 'Electronics',
  furniture: 'Furniture',
  machinery: 'Machinery',
  livestock: 'Livestock',
  stock_in_trade: 'Stock in trade',
  household_goods: 'Household goods',
  other: 'Other',
};

/**
 * Which item types carry a serial or registration number worth asking for.
 *
 * A hint for the form, not a rule: the column is nullable for every type,
 * because a goat has no serial number and a second-hand television's plate
 * has usually rubbed off.
 */
export const COLLATERAL_TYPES_WITH_SERIAL: readonly CollateralItemType[] = [
  'motor_vehicle',
  'motorcycle',
  'electronics',
  'machinery',
];

export const COLLATERAL_STATUSES = ['held', 'released', 'realised'] as const;

export type CollateralStatus = (typeof COLLATERAL_STATUSES)[number];

export function isCollateralStatus(value: unknown): value is CollateralStatus {
  return (
    typeof value === 'string' &&
    (COLLATERAL_STATUSES as readonly string[]).includes(value)
  );
}

export const COLLATERAL_STATUS_LABELS: Readonly<Record<CollateralStatus, string>> = {
  held: 'Held',
  released: 'Released',
  realised: 'Realised',
};

export const COLLATERAL_STATUS_DESCRIPTIONS: Readonly<Record<CollateralStatus, string>> =
  {
    held: 'The business holds this item as security for the loan.',
    released: 'Returned to the borrower. It no longer secures anything.',
    realised: 'Sold to recover the debt. What it fetched was banked as a payment.',
  };

/* ------------------------------------------------------------------ */
/* Guarantees                                                          */
/* ------------------------------------------------------------------ */

export const GUARANTEE_STATUSES = [
  'proposed',
  'unsigned',
  'binding',
  'released',
  'discharged',
  'void',
] as const;

export type GuaranteeStatus = (typeof GUARANTEE_STATUSES)[number];

export function isGuaranteeStatus(value: unknown): value is GuaranteeStatus {
  return (
    typeof value === 'string' && (GUARANTEE_STATUSES as readonly string[]).includes(value)
  );
}

export const GUARANTEE_STATUS_LABELS: Readonly<Record<GuaranteeStatus, string>> = {
  proposed: 'Proposed',
  unsigned: 'Not signed',
  binding: 'Binding',
  released: 'Released',
  discharged: 'Discharged',
  void: 'Void',
};

/**
 * What each status means to the guarantor standing in front of you.
 *
 * "Discharged" and "released" are deliberately different sentences. A
 * discharged guarantee ended because the borrower paid; a released one ended
 * because the business decided to let the guarantor out. A guarantor asking
 * "am I still liable?" is owed the reason as well as the answer.
 */
export const GUARANTEE_STATUS_DESCRIPTIONS: Readonly<Record<GuaranteeStatus, string>> = {
  proposed: 'Named on an application that has not been disbursed.',
  unsigned: 'Attached to the loan, but the undertaking has not been signed.',
  binding: 'Signed, and the loan is still owed.',
  released: 'Let out of the guarantee by the business, with a recorded reason.',
  discharged: 'Ended when the borrower cleared the loan.',
  void: 'Ended when the loan was cancelled. Nothing was ever lent against it.',
};

/** A guarantee that still binds is the only kind worth chasing. */
export function guaranteeIsLive(status: GuaranteeStatus): boolean {
  return status === 'binding' || status === 'unsigned';
}

/* ------------------------------------------------------------------ */
/* Recovery                                                            */
/* ------------------------------------------------------------------ */

export const RECOVERY_ACTION_KINDS = [
  'call',
  'visit',
  'message',
  'letter',
  'note',
  'promise',
  'correction',
] as const;

export type RecoveryActionKind = (typeof RECOVERY_ACTION_KINDS)[number];

export function isRecoveryActionKind(value: unknown): value is RecoveryActionKind {
  return (
    typeof value === 'string' &&
    (RECOVERY_ACTION_KINDS as readonly string[]).includes(value)
  );
}

export const RECOVERY_ACTION_KIND_LABELS: Readonly<Record<RecoveryActionKind, string>> = {
  call: 'Phone call',
  visit: 'Field visit',
  message: 'SMS or WhatsApp',
  letter: 'Written notice',
  note: 'Internal note',
  promise: 'Promise to pay',
  correction: 'Correction',
};

/**
 * The kinds a staff member chooses from.
 *
 * `correction` is absent because it is not something you set out to do: a
 * correction is recorded against the action it corrects, from that action's
 * own row, which is the only place the pointer can be filled in honestly.
 */
export const RECORDABLE_RECOVERY_KINDS = [
  'call',
  'visit',
  'message',
  'letter',
  'note',
  'promise',
] as const satisfies readonly RecoveryActionKind[];

export type RecordableRecoveryKind = (typeof RECORDABLE_RECOVERY_KINDS)[number];

/** The kinds that are an attempt at contact, and so can have an outcome. */
export const CONTACT_RECOVERY_KINDS: readonly RecoveryActionKind[] = [
  'call',
  'visit',
  'message',
  'letter',
  'promise',
];

export function recoveryKindTakesOutcome(kind: RecoveryActionKind): boolean {
  return CONTACT_RECOVERY_KINDS.includes(kind);
}

export const RECOVERY_OUTCOMES = [
  'reached',
  'no_answer',
  'wrong_number',
  'refused_to_pay',
  'not_found',
  'promised_to_pay',
  'paid',
  'disputed',
  'deceased',
] as const;

export type RecoveryOutcome = (typeof RECOVERY_OUTCOMES)[number];

export function isRecoveryOutcome(value: unknown): value is RecoveryOutcome {
  return (
    typeof value === 'string' && (RECOVERY_OUTCOMES as readonly string[]).includes(value)
  );
}

export const RECOVERY_OUTCOME_LABELS: Readonly<Record<RecoveryOutcome, string>> = {
  reached: 'Reached the borrower',
  no_answer: 'No answer',
  wrong_number: 'Wrong number',
  refused_to_pay: 'Refused to pay',
  not_found: 'Not found at the address',
  promised_to_pay: 'Promised to pay',
  paid: 'Paid at the time',
  disputed: 'Disputes the balance',
  deceased: 'Reported deceased',
};

export const PROMISE_STATUSES = ['pending', 'kept', 'broken'] as const;

export type PromiseStatus = (typeof PROMISE_STATUSES)[number];

export function isPromiseStatus(value: unknown): value is PromiseStatus {
  return (
    typeof value === 'string' && (PROMISE_STATUSES as readonly string[]).includes(value)
  );
}

export const PROMISE_STATUS_LABELS: Readonly<Record<PromiseStatus, string>> = {
  pending: 'Awaiting',
  kept: 'Kept',
  broken: 'Not kept',
};

/**
 * "Not kept" rather than "broken".
 *
 * The register is read aloud to borrowers, and a promise is a thing somebody
 * said at a difficult moment. The system's job is to record whether the money
 * arrived, not to characterise the person.
 */
export const PROMISE_STATUS_DESCRIPTIONS: Readonly<Record<PromiseStatus, string>> = {
  pending: 'The date has not passed yet.',
  kept: 'Payments reaching the promised amount were posted in time.',
  broken: 'The date passed without the promised amount being paid.',
};
