import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { BUSINESS_DEFAULTS } from '@/config/defaults';
import { ValidationError } from '@/lib/errors';
import {
  basisPointsSchema,
  businessDateSchema,
  businessSettingsSchema,
  companySettingsSchema,
  createProfileSchema,
  currencyCodeSchema,
  formDataToObject,
  fullNameSchema,
  localeSchema,
  optionalEmailSchema,
  paginationSchema,
  parseOrThrow,
  parseSafely,
  positiveUgxAmountSchema,
  storagePathSchema,
  timezoneSchema,
  toFieldErrors,
  ugandanPhoneSchema,
  ugxAmountSchema,
  updateProfileSchema,
} from '@/lib/validation';

describe('ugandanPhoneSchema', () => {
  it('normalises to the canonical stored form', () => {
    // Validation and normalisation in one step, so a form and an API endpoint
    // cannot disagree about what gets written.
    expect(ugandanPhoneSchema.parse('0772123456')).toBe('+256772123456');
    expect(ugandanPhoneSchema.parse('+256 772 123 456')).toBe('+256772123456');
  });

  it('reports a staff-readable message on failure', () => {
    const result = ugandanPhoneSchema.safeParse('+254712345678');
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/non-Ugandan/);
  });

  it('rejects a blank', () => {
    expect(ugandanPhoneSchema.safeParse('').success).toBe(false);
  });
});

describe('fullNameSchema', () => {
  it('accepts the names Ugandan clients actually have', () => {
    for (const name of [
      'Aisha Nakato',
      "O'Brien Mukasa",
      'Jean-Pierre Ssemakula',
      'Nalubega Sarah Nakimuli',
      'Dr. Okello',
      'Zoë Nabirye',
    ]) {
      expect(fullNameSchema.safeParse(name).success, name).toBe(true);
    }
  });

  it('rejects input that signals a mis-filled field', () => {
    for (const name of ['', ' ', 'A', '12345', 'client@example.com', '<script>']) {
      expect(fullNameSchema.safeParse(name).success, name).toBe(false);
    }
  });

  it('trims surrounding whitespace', () => {
    expect(fullNameSchema.parse('  Aisha Nakato  ')).toBe('Aisha Nakato');
  });
});

describe('monetary and rate schemas', () => {
  it('requires whole shillings', () => {
    expect(ugxAmountSchema.safeParse(100_000).success).toBe(true);
    expect(ugxAmountSchema.safeParse(100_000.5).success).toBe(false);
    expect(ugxAmountSchema.safeParse(-1).success).toBe(false);
    expect(ugxAmountSchema.safeParse(0).success).toBe(true);
  });

  it('requires a positive amount where zero is meaningless', () => {
    expect(positiveUgxAmountSchema.safeParse(0).success).toBe(false);
    expect(positiveUgxAmountSchema.safeParse(1).success).toBe(true);
  });

  it('requires whole basis points and explains the 15-versus-1500 trap', () => {
    expect(basisPointsSchema.safeParse(1_500).success).toBe(true);
    expect(basisPointsSchema.safeParse(0.15).success).toBe(false);
    expect(basisPointsSchema.safeParse(-1).success).toBe(false);

    const result = basisPointsSchema.safeParse(15.5);
    expect(result.error?.issues[0]?.message).toContain('15% is 1500');
  });
});

describe('email schema', () => {
  it('lowercases and treats a blank as absent', () => {
    // Many clients have no email, and the column is UNIQUE, so '' must become
    // null rather than colliding with every other blank.
    expect(optionalEmailSchema.parse('Client@Example.COM')).toBe('client@example.com');
    expect(optionalEmailSchema.parse('')).toBeNull();
    expect(optionalEmailSchema.parse(null)).toBeNull();
  });

  it('rejects a malformed address', () => {
    expect(optionalEmailSchema.safeParse('not-an-email').success).toBe(false);
  });
});

describe('format schemas', () => {
  it('validates currency codes', () => {
    expect(currencyCodeSchema.parse('ugx')).toBe('UGX');
    expect(currencyCodeSchema.safeParse('UGXX').success).toBe(false);
    expect(currencyCodeSchema.safeParse('U1X').success).toBe(false);
  });

  it('validates timezones against the host database, not a list we maintain', () => {
    expect(timezoneSchema.safeParse('Africa/Kampala').success).toBe(true);
    expect(timezoneSchema.safeParse('UTC').success).toBe(true);
    expect(timezoneSchema.safeParse('Africa/Nowhere').success).toBe(false);
  });

  it('validates locales', () => {
    expect(localeSchema.safeParse('en-UG').success).toBe(true);
    expect(localeSchema.safeParse('en').success).toBe(true);
    expect(localeSchema.safeParse('English').success).toBe(false);
  });

  it('validates business dates', () => {
    expect(businessDateSchema.safeParse('2026-01-14').success).toBe(true);
    expect(businessDateSchema.safeParse('2026-02-30').success).toBe(false);
    expect(businessDateSchema.safeParse('14/01/2026').success).toBe(false);
  });
});

describe('storagePathSchema', () => {
  it('accepts a conforming object path', () => {
    expect(
      storagePathSchema.safeParse(
        '0f8fad5b-d9cb-469f-a165-70867728950e/id-front/abc123.jpg',
      ).success,
    ).toBe(true);
  });

  it('rejects traversal and absolute paths', () => {
    // A crafted value must not be able to escape its bucket prefix. The same
    // rule is a CHECK constraint on company_settings.logo_path.
    for (const path of [
      '../secrets/key.pem',
      'client-documents/../../etc/passwd',
      '/etc/passwd',
      'a/../../b',
    ]) {
      expect(storagePathSchema.safeParse(path).success, path).toBe(false);
    }
  });

  it('rejects characters that do not belong in an object path', () => {
    for (const path of ['file name.jpg', 'file;rm -rf.jpg', 'a\\b.jpg', '']) {
      expect(storagePathSchema.safeParse(path).success, path).toBe(false);
    }
  });
});

describe('paginationSchema', () => {
  it('applies safe defaults and bounds', () => {
    expect(paginationSchema.parse({})).toEqual({ page: 1, pageSize: 25 });
    // An unbounded page size is a trivial denial-of-service.
    expect(paginationSchema.safeParse({ page: 1, pageSize: 10_000 }).success).toBe(false);
    expect(paginationSchema.safeParse({ page: 0, pageSize: 25 }).success).toBe(false);
  });
});

describe('createProfileSchema', () => {
  it('accepts a profile with no auth account, as staff registration produces', () => {
    const parsed = createProfileSchema.parse({
      fullName: 'Aisha Nakato',
      phone: '0772123456',
    });

    expect(parsed.phone).toBe('+256772123456');
    expect(parsed.status).toBe('active');
    // A client registered at the counter has no portal login yet.
    expect(parsed.authUserId).toBeUndefined();
  });

  it('accepts a linked auth account', () => {
    const parsed = createProfileSchema.parse({
      fullName: 'Aisha Nakato',
      phone: '0772123456',
      authUserId: '0f8fad5b-d9cb-469f-a165-70867728950e',
    });

    expect(parsed.authUserId).toBe('0f8fad5b-d9cb-469f-a165-70867728950e');
  });

  it('rejects a malformed auth user id', () => {
    expect(
      createProfileSchema.safeParse({
        fullName: 'Aisha Nakato',
        phone: '0772123456',
        authUserId: 'not-a-uuid',
      }).success,
    ).toBe(false);
  });

  it('requires a name and a phone', () => {
    expect(createProfileSchema.safeParse({ phone: '0772123456' }).success).toBe(false);
    expect(createProfileSchema.safeParse({ fullName: 'Aisha Nakato' }).success).toBe(
      false,
    );
  });
});

describe('updateProfileSchema', () => {
  it('accepts a partial update', () => {
    expect(updateProfileSchema.parse({ fullName: 'New Name' }).fullName).toBe('New Name');
  });

  it('rejects an empty submission rather than writing a no-op row', () => {
    // An empty update would still fire the updated_at trigger, making the
    // record look edited when nothing changed.
    expect(updateProfileSchema.safeParse({}).success).toBe(false);
  });

  it('does not accept authUserId, which is an identity operation', () => {
    // `parse` accepts `unknown`, so the extra key needs no cast; it is simply
    // dropped, which is what this test asserts.
    const parsed = updateProfileSchema.parse({
      fullName: 'New Name',
      authUserId: '0f8fad5b-d9cb-469f-a165-70867728950e',
    }) as Record<string, unknown>;

    expect(parsed.authUserId).toBeUndefined();
  });
});

describe('companySettingsSchema', () => {
  it('accepts a name alone, since registration is still in progress', () => {
    const parsed = companySettingsSchema.parse({ companyName: 'Example Lending Ltd' });

    expect(parsed.companyName).toBe('Example Lending Ltd');
    expect(parsed.currencyCode).toBe('UGX');
    expect(parsed.timezone).toBe('Africa/Kampala');
    expect(parsed.locale).toBe('en-UG');
  });

  it('validates the brand colour as a six-digit hex value', () => {
    expect(
      companySettingsSchema.safeParse({
        companyName: 'Example',
        brandPrimaryColor: '#1F6F54',
      }).success,
    ).toBe(true);

    expect(
      companySettingsSchema.safeParse({
        companyName: 'Example',
        brandPrimaryColor: 'green',
      }).success,
    ).toBe(false);
  });

  it('rejects a too-short company name', () => {
    expect(companySettingsSchema.safeParse({ companyName: 'A' }).success).toBe(false);
  });
});

describe('businessSettingsSchema', () => {
  const valid = {
    minLoanAmount: BUSINESS_DEFAULTS.minLoanAmount,
    maxLoanAmount: BUSINESS_DEFAULTS.maxLoanAmount,
    defaultMonthlyInterestRateBps: BUSINESS_DEFAULTS.defaultMonthlyInterestRateBps,
    minLoanTermMonths: BUSINESS_DEFAULTS.minLoanTermMonths,
    maxLoanTermMonths: BUSINESS_DEFAULTS.maxLoanTermMonths,
    gracePeriodDays: BUSINESS_DEFAULTS.gracePeriodDays,
    penaltyRateBps: BUSINESS_DEFAULTS.penaltyRateBps,
    maxActiveLoansPerClient: BUSINESS_DEFAULTS.maxActiveLoansPerClient,
    defaultRepaymentFrequency: BUSINESS_DEFAULTS.defaultRepaymentFrequency,
  };

  it('accepts the seeded business defaults', () => {
    // The values the application seeds must satisfy the validator that guards
    // the settings screen, or the first edit would be impossible.
    expect(businessSettingsSchema.safeParse(valid).success).toBe(true);
  });

  it('encodes the confirmed business rules', () => {
    expect(BUSINESS_DEFAULTS.minLoanAmount).toBe(100_000);
    expect(BUSINESS_DEFAULTS.defaultMonthlyInterestRateBps).toBe(1_500); // 15%
    expect(BUSINESS_DEFAULTS.gracePeriodDays).toBe(3);
    expect(BUSINESS_DEFAULTS.penaltyRateBps).toBe(5_000); // 50%
    expect(BUSINESS_DEFAULTS.maxActiveLoansPerClient).toBe(1);
    expect(BUSINESS_DEFAULTS.maxLoanTermMonths).toBe(3);
  });

  it('rejects a maximum below the minimum, and reports it on the right field', () => {
    const result = businessSettingsSchema.safeParse({
      ...valid,
      maxLoanAmount: 50_000,
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['maxLoanAmount']);
  });

  it('rejects an inverted term range', () => {
    const result = businessSettingsSchema.safeParse({
      ...valid,
      minLoanTermMonths: 6,
      maxLoanTermMonths: 3,
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['maxLoanTermMonths']);
  });

  it('allows equal minimum and maximum', () => {
    expect(
      businessSettingsSchema.safeParse({
        ...valid,
        minLoanAmount: 100_000,
        maxLoanAmount: 100_000,
      }).success,
    ).toBe(true);
  });

  it('requires at least one active loan to be permitted', () => {
    expect(
      businessSettingsSchema.safeParse({ ...valid, maxActiveLoansPerClient: 0 }).success,
    ).toBe(false);
  });

  it('allows a zero grace period and a zero penalty', () => {
    // The business may legitimately decide to charge neither.
    expect(
      businessSettingsSchema.safeParse({
        ...valid,
        gracePeriodDays: 0,
        penaltyRateBps: 0,
      }).success,
    ).toBe(true);
  });
});

describe('toFieldErrors', () => {
  it('keys messages by dotted field path', () => {
    const schema = z.object({
      phone: z.string().min(5),
      nested: z.object({ a: z.number() }),
    });
    const result = schema.safeParse({ phone: 'x', nested: { a: 'no' } });

    const fields = toFieldErrors(result.error!);
    expect(Object.keys(fields)).toContain('phone');
    expect(Object.keys(fields)).toContain('nested.a');
  });

  it('files whole-object refinements under _form', () => {
    const fields = toFieldErrors(updateProfileSchema.safeParse({}).error!);
    expect(fields._form).toBeDefined();
  });
});

describe('parseOrThrow and parseSafely', () => {
  it('throws a ValidationError carrying field errors', () => {
    try {
      parseOrThrow(createProfileSchema, { fullName: 'A' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).fieldErrors.fullName).toBeDefined();
      // The user-facing text never names a schema or a field path.
      expect((error as ValidationError).toPublic().message).toBe(
        'Please check the highlighted fields and try again.',
      );
    }
  });

  it('returns the parsed value on success', () => {
    expect(
      parseOrThrow(createProfileSchema, { fullName: 'Aisha Nakato', phone: '0772123456' })
        .phone,
    ).toBe('+256772123456');
  });

  it('returns a result instead of throwing, for Server Actions', () => {
    const failure = parseSafely(createProfileSchema, { fullName: 'A' });
    expect(failure.success).toBe(false);
    if (!failure.success) {
      expect(failure.error).toBeInstanceOf(ValidationError);
    }

    const success = parseSafely(createProfileSchema, {
      fullName: 'Aisha Nakato',
      phone: '0772123456',
    });
    expect(success.success).toBe(true);
  });
});

describe('formDataToObject', () => {
  it('converts a flat form', () => {
    const formData = new FormData();
    formData.set('fullName', 'Aisha Nakato');
    formData.set('phone', '0772123456');

    expect(formDataToObject(formData)).toEqual({
      fullName: 'Aisha Nakato',
      phone: '0772123456',
    });
  });

  it('collects repeated keys into an array, so multi-selects survive', () => {
    const formData = new FormData();
    formData.append('roles', 'manager');
    formData.append('roles', 'owner_admin');

    expect(formDataToObject(formData).roles).toEqual(['manager', 'owner_admin']);
  });

  it('preserves an empty string rather than coercing it', () => {
    // Clearing a field is a deliberate act; the individual schema decides
    // whether '' means "absent".
    const formData = new FormData();
    formData.set('email', '');

    expect(formDataToObject(formData).email).toBe('');
  });
});
