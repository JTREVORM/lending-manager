import { describe, expect, it } from 'vitest';

import {
  AGING_BUCKETS,
  AGING_BUCKET_LABELS,
  PAR_THRESHOLDS,
  bucketForDaysPastDue,
  formatRatioBps,
  isAgingBucket,
  ratioSeverity,
} from '@/lib/domain/risk';
import {
  COLLATERAL_ITEM_TYPES,
  COLLATERAL_STATUSES,
  GUARANTEE_STATUSES,
  PROMISE_STATUSES,
  RECORDABLE_RECOVERY_KINDS,
  RECOVERY_ACTION_KINDS,
  RECOVERY_OUTCOMES,
  guaranteeIsLive,
  isCollateralItemType,
  isCollateralStatus,
  isGuaranteeStatus,
  isPromiseStatus,
  isRecoveryActionKind,
  isRecoveryOutcome,
  recoveryKindTakesOutcome,
} from '@/lib/domain/security';
import {
  correctRecoveryActionSchema,
  guarantorRegisterSearchSchema,
  realiseCollateralSchema,
  recordCollateralSchema,
  recordRecoveryActionSchema,
  recoverySearchSchema,
  releaseCollateralSchema,
  releaseGuarantorSchema,
  updateCollateralSchema,
} from '@/lib/validation/security';

const LOAN_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const ITEM_ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const GUARANTEE_ID = '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e';
const ACTION_ID = '3c4d5e6f-7a8b-4c9d-8e0f-2a3b4c5d6e7f';

/**
 * Phase 14 as rules rather than as screens.
 *
 * Everything here is pure. The database holds the authoritative copy of every
 * one of these rules — the item guard, the append-only triggers, the release
 * function's guarantor floor — and these tests are about the other half of the
 * promise: that the form says so beside the field, rather than after a round
 * trip, and that it says the same thing the database will.
 */

// ---------------------------------------------------------------------------
describe('recording security', () => {
  const VALID = {
    loanId: LOAN_ID,
    itemType: 'motorcycle',
    description: 'Red Bajaj Boxer, fair condition',
    estimatedValue: '1,500,000',
    valuedOn: '2026-10-01',
    serialNumber: 'MD2A11CZ8RWF12345',
    ownershipDocument: 'Logbook UBK 123X',
    location: 'Held at the Kyebando office',
  };

  it('accepts a complete item and reads the amount as whole shillings', () => {
    const parsed = recordCollateralSchema.safeParse(VALID);

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.estimatedValue).toBe(1_500_000);
  });

  it('requires a description somebody could identify the item from', () => {
    const parsed = recordCollateralSchema.safeParse({ ...VALID, description: 'a' });
    expect(parsed.success).toBe(false);
  });

  it('refuses a fractional valuation rather than rounding it', () => {
    // 1,500,000.50 is either a mistype or a figure in another currency, and
    // rounding would hide which.
    const parsed = recordCollateralSchema.safeParse({
      ...VALID,
      estimatedValue: '1500000.50',
    });
    expect(parsed.success).toBe(false);
  });

  it('refuses a valuation of zero — an item worth nothing secures nothing', () => {
    const parsed = recordCollateralSchema.safeParse({ ...VALID, estimatedValue: '0' });
    expect(parsed.success).toBe(false);
  });

  it('requires a valuation date', () => {
    const parsed = recordCollateralSchema.safeParse({ ...VALID, valuedOn: '' });
    expect(parsed.success).toBe(false);
  });

  it('treats the optional fields as absent rather than empty', () => {
    const parsed = recordCollateralSchema.safeParse({
      ...VALID,
      serialNumber: '',
      ownershipDocument: '',
      location: '',
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.serialNumber).toBeNull();
    expect(parsed.success && parsed.data.ownershipDocument).toBeNull();
    expect(parsed.success && parsed.data.location).toBeNull();
  });

  it('refuses an item type it does not know', () => {
    const parsed = recordCollateralSchema.safeParse({ ...VALID, itemType: 'spaceship' });
    expect(parsed.success).toBe(false);
  });

  it('asks for every field on an edit, so a cleared value is not mistaken for an unchanged one', () => {
    // Deliberately not a partial. A form that submitted only what changed
    // could not tell "left blank" from "cleared", and a serial number that
    // silently survived being deleted is worse than one that must be retyped.
    const partial = updateCollateralSchema.safeParse({
      collateralId: ITEM_ID,
      description: 'Red Bajaj Boxer',
    });

    expect(partial.success).toBe(false);

    const whole = updateCollateralSchema.safeParse({
      collateralId: ITEM_ID,
      itemType: 'motorcycle',
      description: 'Red Bajaj Boxer, fair condition',
      estimatedValue: '1400000',
      valuedOn: '2026-10-02',
    });

    expect(whole.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('releasing and realising security', () => {
  it('requires a reason for a release', () => {
    expect(
      releaseCollateralSchema.safeParse({
        collateralId: ITEM_ID,
        loanId: LOAN_ID,
        releaseReason: '',
      }).success,
    ).toBe(false);

    expect(
      releaseCollateralSchema.safeParse({
        collateralId: ITEM_ID,
        loanId: LOAN_ID,
        releaseReason: 'Returned — the loan is secured on land instead',
      }).success,
    ).toBe(true);
  });

  it('accepts proceeds of zero, because an item that fetched nothing is a real outcome', () => {
    const parsed = realiseCollateralSchema.safeParse({
      collateralId: ITEM_ID,
      loanId: LOAN_ID,
      realisedAmount: '0',
      releaseReason: 'No bidder at the auction; disposed of',
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.realisedAmount).toBe(0);
  });

  it('still refuses negative proceeds', () => {
    const parsed = realiseCollateralSchema.safeParse({
      collateralId: ITEM_ID,
      loanId: LOAN_ID,
      realisedAmount: '-5000',
      releaseReason: 'Sold at a loss',
    });

    expect(parsed.success).toBe(false);
  });

  it('requires a reason to release a guarantor', () => {
    expect(
      releaseGuarantorSchema.safeParse({
        loanGuarantorId: GUARANTEE_ID,
        loanId: LOAN_ID,
        releaseReason: '  ',
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('recording a recovery action', () => {
  const VALID = {
    loanId: LOAN_ID,
    actionKind: 'call',
    outcome: 'no_answer',
    notes: 'Phone off all morning; will try the shop this afternoon',
    actionDate: '2026-10-08',
    followUpOn: '2026-10-10',
    promisedAmount: '',
    promisedOn: '',
  };

  it('accepts a call with an outcome and a follow-up', () => {
    const parsed = recordRecoveryActionSchema.safeParse(VALID);

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.promisedAmount).toBeNull();
    expect(parsed.success && parsed.data.followUpOn).toBe('2026-10-10');
  });

  it('accepts a note with no outcome at all', () => {
    const parsed = recordRecoveryActionSchema.safeParse({
      ...VALID,
      actionKind: 'note',
      outcome: '',
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.outcome).toBeNull();
  });

  it('tells somebody choosing "promise" that it needs an amount', () => {
    const parsed = recordRecoveryActionSchema.safeParse({
      ...VALID,
      actionKind: 'promise',
      promisedAmount: '',
      promisedOn: '',
    });

    expect(parsed.success).toBe(false);
    expect(
      !parsed.success &&
        parsed.error.issues.some((issue) => issue.path[0] === 'promisedAmount'),
    ).toBe(true);
  });

  it('refuses an amount with no date, and a date with no amount', () => {
    const amountOnly = recordRecoveryActionSchema.safeParse({
      ...VALID,
      actionKind: 'promise',
      promisedAmount: '200000',
      promisedOn: '',
    });

    expect(amountOnly.success).toBe(false);
    expect(
      !amountOnly.success &&
        amountOnly.error.issues.some((issue) => issue.path[0] === 'promisedOn'),
    ).toBe(true);

    const dateOnly = recordRecoveryActionSchema.safeParse({
      ...VALID,
      actionKind: 'promise',
      promisedAmount: '',
      promisedOn: '2026-10-12',
    });

    expect(dateOnly.success).toBe(false);
  });

  it('refuses a promised amount on anything that is not a promise', () => {
    const parsed = recordRecoveryActionSchema.safeParse({
      ...VALID,
      actionKind: 'note',
      outcome: '',
      promisedAmount: '200000',
      promisedOn: '2026-10-12',
    });

    expect(parsed.success).toBe(false);
  });

  it('refuses a promised date before the day of the action', () => {
    const parsed = recordRecoveryActionSchema.safeParse({
      ...VALID,
      actionKind: 'promise',
      promisedAmount: '200000',
      promisedOn: '2026-10-01',
    });

    expect(parsed.success).toBe(false);
  });

  it('refuses a follow-up before the day of the action', () => {
    const parsed = recordRecoveryActionSchema.safeParse({
      ...VALID,
      followUpOn: '2026-10-01',
    });

    expect(parsed.success).toBe(false);
  });

  it('accepts a promise dated the same day', () => {
    const parsed = recordRecoveryActionSchema.safeParse({
      ...VALID,
      actionKind: 'promise',
      outcome: 'promised_to_pay',
      promisedAmount: '200000',
      promisedOn: VALID.actionDate,
    });

    expect(parsed.success).toBe(true);
  });

  it('requires something to have been said', () => {
    expect(recordRecoveryActionSchema.safeParse({ ...VALID, notes: 'x' }).success).toBe(
      false,
    );
  });

  it('does not offer "correction" as something to set out to do', () => {
    // A correction is recorded against the action it corrects, from that
    // action's own row — the only place the pointer can be filled in
    // honestly — so it is absent from the list a form renders.
    expect(RECORDABLE_RECOVERY_KINDS).not.toContain('correction');
    expect(RECOVERY_ACTION_KINDS).toContain('correction');

    const parsed = recordRecoveryActionSchema.safeParse({
      ...VALID,
      actionKind: 'correction',
      outcome: '',
    });

    expect(parsed.success).toBe(false);
  });

  it('requires a correction to name what it corrects', () => {
    expect(
      correctRecoveryActionSchema.safeParse({
        loanId: LOAN_ID,
        notes: 'That call was about a different borrower',
        actionDate: '2026-10-09',
      }).success,
    ).toBe(false);

    expect(
      correctRecoveryActionSchema.safeParse({
        loanId: LOAN_ID,
        correctsActionId: ACTION_ID,
        notes: 'That call was about a different borrower',
        actionDate: '2026-10-09',
      }).success,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('the worklist filters', () => {
  it('reads an empty filter as no filter rather than as a value', () => {
    const parsed = recoverySearchSchema.safeParse({
      query: '',
      bucket: '',
      productId: '',
      branchId: '',
      followUp: '',
      page: '',
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.bucket).toBeNull();
    expect(parsed.success && parsed.data.productId).toBeNull();
    expect(parsed.success && parsed.data.page).toBe(1);
  });

  it('falls back to the first page rather than erroring on a hand-edited page', () => {
    const parsed = recoverySearchSchema.safeParse({ page: 'nonsense' });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.page).toBe(1);
  });

  it('refuses a bucket it does not know', () => {
    expect(recoverySearchSchema.safeParse({ bucket: '2_5' }).success).toBe(false);
  });

  it('accepts every guarantee status the register can show', () => {
    for (const status of GUARANTEE_STATUSES) {
      expect(
        guarantorRegisterSearchSchema.safeParse({ guaranteeStatus: status }).success,
        status,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
describe('the security vocabulary', () => {
  it('labels every value it enumerates', () => {
    for (const bucket of AGING_BUCKETS) {
      expect(AGING_BUCKET_LABELS[bucket], bucket).toBeTruthy();
    }
  });

  it('recognises its own values and nothing else', () => {
    for (const value of COLLATERAL_ITEM_TYPES)
      expect(isCollateralItemType(value)).toBe(true);
    for (const value of COLLATERAL_STATUSES) expect(isCollateralStatus(value)).toBe(true);
    for (const value of GUARANTEE_STATUSES) expect(isGuaranteeStatus(value)).toBe(true);
    for (const value of PROMISE_STATUSES) expect(isPromiseStatus(value)).toBe(true);
    for (const value of RECOVERY_ACTION_KINDS)
      expect(isRecoveryActionKind(value)).toBe(true);
    for (const value of RECOVERY_OUTCOMES) expect(isRecoveryOutcome(value)).toBe(true);

    expect(isCollateralItemType('spaceship')).toBe(false);
    expect(isCollateralStatus('pawned')).toBe(false);
    expect(isGuaranteeStatus('maybe')).toBe(false);
    expect(isPromiseStatus('late')).toBe(false);
    expect(isRecoveryActionKind('telepathy')).toBe(false);
    expect(isRecoveryOutcome('shrugged')).toBe(false);
    expect(isAgingBucket('2_5')).toBe(false);
  });

  it('gives an outcome only to an attempt at contact', () => {
    expect(recoveryKindTakesOutcome('call')).toBe(true);
    expect(recoveryKindTakesOutcome('visit')).toBe(true);
    expect(recoveryKindTakesOutcome('promise')).toBe(true);
    // A note has no outcome — it is one.
    expect(recoveryKindTakesOutcome('note')).toBe(false);
    expect(recoveryKindTakesOutcome('correction')).toBe(false);
  });

  it('counts only a guarantee that still binds as live', () => {
    expect(guaranteeIsLive('binding')).toBe(true);
    expect(guaranteeIsLive('unsigned')).toBe(true);
    // Discharged and released both ended, for different reasons.
    expect(guaranteeIsLive('discharged')).toBe(false);
    expect(guaranteeIsLive('released')).toBe(false);
    expect(guaranteeIsLive('void')).toBe(false);
    expect(guaranteeIsLive('proposed')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('aging and PAR, as arithmetic', () => {
  it('mirrors the view at every boundary', () => {
    // The authoritative copy is one `case` in `loan_aging`, and
    // `tests/db/security-and-recovery.test.ts` drives the same boundaries
    // against the database. This is the other half of that pairing: the two
    // definitions have to agree, or a screen and a report will not.
    expect(bucketForDaysPastDue(null)).toBe('current');
    expect(bucketForDaysPastDue(-3)).toBe('current');
    expect(bucketForDaysPastDue(0)).toBe('current');
    expect(bucketForDaysPastDue(1)).toBe('1_7');
    expect(bucketForDaysPastDue(7)).toBe('1_7');
    expect(bucketForDaysPastDue(8)).toBe('8_30');
    expect(bucketForDaysPastDue(30)).toBe('8_30');
    expect(bucketForDaysPastDue(31)).toBe('31_60');
    expect(bucketForDaysPastDue(60)).toBe('31_60');
    expect(bucketForDaysPastDue(61)).toBe('61_90');
    expect(bucketForDaysPastDue(90)).toBe('61_90');
    expect(bucketForDaysPastDue(91)).toBe('90_plus');
    expect(bucketForDaysPastDue(400)).toBe('90_plus');
  });

  it('quotes a ratio to one decimal place', () => {
    expect(formatRatioBps(0)).toBe('0.0%');
    expect(formatRatioBps(1234)).toBe('12.3%');
    expect(formatRatioBps(10000)).toBe('100.0%');
  });

  it('shows a dash where there is no portfolio, never 0.0%', () => {
    // A branch with no active loans has no PAR. Zero would read as perfect
    // health, which is a different and much more flattering claim.
    expect(formatRatioBps(null)).toBe('—');
    expect(ratioSeverity(null)).toBe('unknown');
  });

  it('separates a healthy ratio from one to watch and one that is bad', () => {
    expect(ratioSeverity(0)).toBe('ok');
    expect(ratioSeverity(499)).toBe('ok');
    expect(ratioSeverity(500)).toBe('watch');
    expect(ratioSeverity(1499)).toBe('watch');
    expect(ratioSeverity(1500)).toBe('bad');
  });

  it('quotes PAR at the five thresholds the business states', () => {
    expect([...PAR_THRESHOLDS]).toEqual([1, 7, 30, 60, 90]);
  });
});
