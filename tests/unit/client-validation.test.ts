import { describe, expect, it } from 'vitest';

import {
  CLIENT_STATUSES,
  MINIMUM_CLIENT_AGE,
  ageOn,
  canBorrow,
  formatCalendarDate,
  isClientStatus,
  isNin,
  isSex,
  maskNin,
  ninAgreesWithSex,
  normalizeNin,
  statusRequiresReason,
} from '@/lib/domain/client';
import {
  changeClientStatusSchema,
  createClientSchema,
  createGuarantorSchema,
  createRemarkSchema,
  dateOfBirthSchema,
  isAllowedDocumentMimeType,
  isAllowedPhotoMimeType,
  linkGuarantorSchema,
  ninSchema,
  optionalNinSchema,
  updateClientSchema,
} from '@/lib/validation/client';
import { contentMatchesDeclaredType } from '@/lib/storage/file-types';

/** A registration payload that passes, for tests that vary one field. */
const VALID_CLIENT = {
  fullName: 'Nakato Beatrice',
  sex: 'female',
  dateOfBirth: '1990-05-12',
  phone: '0771234567',
  alternativePhone: '',
  occupation: 'Trader',
  businessType: 'Produce',
  villageArea: 'Kalerwe',
  district: 'Kampala',
  nin: '',
  notes: '',
};

describe('client status', () => {
  it('names exactly the five business states', () => {
    expect([...CLIENT_STATUSES]).toEqual([
      'active',
      'inactive',
      'suspended',
      'blacklisted',
      'archived',
    ]);
  });

  it('discriminates statuses', () => {
    expect(isClientStatus('blacklisted')).toBe(true);
    expect(isClientStatus('deleted')).toBe(false);
    expect(isClientStatus('')).toBe(false);
    expect(isClientStatus(undefined)).toBe(false);
  });

  it('demands a reason only for a deliberate restriction', () => {
    expect(statusRequiresReason('suspended')).toBe(true);
    expect(statusRequiresReason('blacklisted')).toBe(true);
    // No judgement is implied by these, so none needs explaining.
    expect(statusRequiresReason('active')).toBe(false);
    expect(statusRequiresReason('inactive')).toBe(false);
    expect(statusRequiresReason('archived')).toBe(false);
  });

  it('lets only an active client borrow', () => {
    expect(canBorrow('active')).toBe(true);

    for (const status of ['inactive', 'suspended', 'blacklisted', 'archived'] as const) {
      expect(canBorrow(status), status).toBe(false);
    }
  });
});

describe('sex', () => {
  it('matches the national identity document', () => {
    expect(isSex('female')).toBe(true);
    expect(isSex('male')).toBe(true);
    expect(isSex('Female')).toBe(false);
    expect(isSex('other')).toBe(false);
  });
});

describe('the National Identification Number', () => {
  it('accepts a well-formed number', () => {
    expect(isNin('CM91051234ABCD')).toBe(true);
    expect(isNin('CF88120000ZZZZ')).toBe(true);
  });

  it.each([
    ['too short', 'CM9105123ABC'],
    ['too long', 'CM91051234ABCDE'],
    ['wrong first letter', 'XM91051234ABCD'],
    ['wrong sex marker', 'CX91051234ABCD'],
    ['lowercase', 'cm91051234abcd'],
    ['with punctuation', 'CM-91051234ABC'],
    ['empty', ''],
  ])('rejects one that is %s', (_label, value) => {
    expect(isNin(value)).toBe(false);
  });

  it('normalises spacing and case, which is formatting rather than correction', () => {
    // Cards are read aloud and typed with spaces. The characters themselves
    // are never altered.
    expect(normalizeNin('cm 9105 1234 abcd')).toBe('CM91051234ABCD');
    expect(normalizeNin('CM-9105-1234-ABCD')).toBe('CM91051234ABCD');
    expect(normalizeNin('  CM91051234ABCD  '.trim())).toBe('CM91051234ABCD');
  });

  it('does not pad or repair a wrong-length number', () => {
    // The business works from the card in the person's hand. Silently
    // "fixing" identity data produces records that match nothing.
    const parsed = ninSchema.safeParse('CM123');
    expect(parsed.success).toBe(false);
  });

  it('accepts a normalisable number through the schema', () => {
    const parsed = ninSchema.safeParse('cm 9105 1234 abcd');
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toBe('CM91051234ABCD');
  });

  it('treats blank as absent rather than invalid', () => {
    // A client registered before their card is present still gets a record.
    const parsed = optionalNinSchema.safeParse('');
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toBeNull();
  });

  it('masks to the last three characters', () => {
    expect(maskNin('CM91051234ABCD')).toBe('***BCD');
    expect(maskNin('ABC')).toBe('***');
    expect(maskNin('')).toBe('***');
  });

  it('reports a sex disagreement without deciding which field is wrong', () => {
    expect(ninAgreesWithSex('CF91051234ABCD', 'female')).toBe(true);
    expect(ninAgreesWithSex('CM91051234ABCD', 'male')).toBe(true);
    // A mismatch means somebody mistyped one of the two — which one is a
    // person's judgement, not a form's.
    expect(ninAgreesWithSex('CF91051234ABCD', 'male')).toBe(false);
    expect(ninAgreesWithSex('CM91051234ABCD', 'female')).toBe(false);
  });
});

describe('age', () => {
  it('counts completed years', () => {
    expect(ageOn(new Date('1990-05-12'), new Date('2026-05-12'))).toBe(36);
    // The day before the birthday, they are still 35.
    expect(ageOn(new Date('1990-05-12'), new Date('2026-05-11'))).toBe(35);
    expect(ageOn(new Date('1990-05-12'), new Date('2026-05-13'))).toBe(36);
  });

  it('handles a birthday at the turn of the year', () => {
    expect(ageOn(new Date('2000-01-01'), new Date('2025-12-31'))).toBe(25);
    expect(ageOn(new Date('2000-12-31'), new Date('2025-01-01'))).toBe(24);
  });

  it('rejects a date of birth below the borrowing age', () => {
    const tooYoung = new Date();
    tooYoung.setFullYear(tooYoung.getFullYear() - (MINIMUM_CLIENT_AGE - 1));

    const parsed = dateOfBirthSchema.safeParse(tooYoung.toISOString().slice(0, 10));

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toMatch(/18 years old/);
    }
  });

  it('accepts somebody who turned 18 today', () => {
    const exactly = new Date();
    exactly.setFullYear(exactly.getFullYear() - MINIMUM_CLIENT_AGE);

    const parsed = dateOfBirthSchema.safeParse(exactly.toISOString().slice(0, 10));
    expect(parsed.success).toBe(true);
  });

  it.each([
    ['a mistyped year', '1890-01-01'],
    ['a non-date', 'yesterday'],
    ['the wrong format', '12/05/1990'],
    ['empty', ''],
  ])('rejects %s', (_label, value) => {
    expect(dateOfBirthSchema.safeParse(value).success).toBe(false);
  });

  it.each([
    ['30 February', '1990-02-30'],
    ['29 February in a common year', '1990-02-29'],
    ['31 April', '1990-04-31'],
    ['month 13', '1990-13-01'],
    ['day 00', '1990-01-00'],
    ['month 00', '1990-00-01'],
  ])('rejects %s rather than rolling it over', (_label, value) => {
    // JavaScript parses these and quietly moves them to a different day.
    // Recording a date of birth other than the one submitted is the quiet
    // corruption of identity data this module exists to prevent.
    expect(dateOfBirthSchema.safeParse(value).success, value).toBe(false);
  });

  it('accepts 29 February in a leap year', () => {
    expect(dateOfBirthSchema.safeParse('1988-02-29').success).toBe(true);
  });

  it('renders a stored calendar date without shifting it', () => {
    // A date of birth is a calendar date, not an instant. Converting it to
    // Kampala time would show the wrong day for anyone born before 03:00.
    expect(formatCalendarDate('1990-05-12')).toBe('12 May 1990');
    expect(formatCalendarDate('not a date')).toBe('—');
  });
});

describe('registering a client', () => {
  it('accepts the confirmed business fields', () => {
    const parsed = createClientSchema.safeParse(VALID_CLIENT);
    expect(parsed.success).toBe(true);
  });

  it('normalises the phone number to E.164', () => {
    const parsed = createClientSchema.safeParse({
      ...VALID_CLIENT,
      phone: '0771 234 567',
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.phone).toBe('+256771234567');
  });

  it.each([
    ['fullName', ''],
    ['sex', ''],
    ['dateOfBirth', ''],
    ['phone', ''],
    ['occupation', ''],
    ['villageArea', ''],
    ['district', ''],
  ])('requires %s', (field, value) => {
    const parsed = createClientSchema.safeParse({ ...VALID_CLIENT, [field]: value });
    expect(parsed.success, field).toBe(false);
  });

  it.each([
    ['alternativePhone', ''],
    ['businessType', ''],
    ['nin', ''],
    ['notes', ''],
  ])('treats %s as optional', (field, value) => {
    const parsed = createClientSchema.safeParse({ ...VALID_CLIENT, [field]: value });
    expect(parsed.success, field).toBe(true);
  });

  it('rejects an invalid phone number', () => {
    for (const phone of ['123', '+1555123456', '07712345', 'not a phone']) {
      const parsed = createClientSchema.safeParse({ ...VALID_CLIENT, phone });
      expect(parsed.success, phone).toBe(false);
    }
  });

  it('rejects an alternative number identical to the main one', () => {
    const parsed = createClientSchema.safeParse({
      ...VALID_CLIENT,
      phone: '0771234567',
      alternativePhone: '+256771234567',
    });

    // Written two ways, the same number. Normalising first is what lets this
    // be caught rather than stored as a second contact that is not one.
    expect(parsed.success).toBe(false);
  });

  it('trims surrounding whitespace', () => {
    const parsed = createClientSchema.safeParse({
      ...VALID_CLIENT,
      occupation: '  Trader  ',
      villageArea: '  Kalerwe ',
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.occupation).toBe('Trader');
      expect(parsed.data.villageArea).toBe('Kalerwe');
    }
  });

  it('rejects a whitespace-only required field', () => {
    const parsed = createClientSchema.safeParse({
      ...VALID_CLIENT,
      occupation: '   ',
    });

    expect(parsed.success).toBe(false);
  });

  it('bounds every free-text field', () => {
    for (const field of ['occupation', 'villageArea', 'district', 'notes']) {
      const parsed = createClientSchema.safeParse({
        ...VALID_CLIENT,
        [field]: 'x'.repeat(5000),
      });
      expect(parsed.success, field).toBe(false);
    }
  });

  it('has no client number field at all', () => {
    // A schema that accepted one would imply a caller could choose it. The
    // database mints it and refuses a supplied value.
    const parsed = createClientSchema.safeParse({
      ...VALID_CLIENT,
      clientNumber: 'CL26999',
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect('clientNumber' in parsed.data).toBe(false);
    }
  });

  it.each([
    ['a script tag in a name', '<script>alert(1)</script>'],
    ['an HTML entity attack', '"><img src=x onerror=alert(1)>'],
    ['a template injection', '${process.env.SUPABASE_SECRET_KEY}'],
  ])('rejects %s as a name, because names are letters', (_label, fullName) => {
    // The name pattern allows letters, spaces, hyphens, apostrophes and full
    // stops. That is not the XSS defence — React escaping is — but it means a
    // payload never reaches storage in the first place.
    const parsed = createClientSchema.safeParse({ ...VALID_CLIENT, fullName });
    expect(parsed.success).toBe(false);
  });

  it('accepts a real Ugandan name with an apostrophe or hyphen', () => {
    for (const fullName of [
      "N'gambwa Sarah",
      'Mary-Jane Nabukeera',
      'John Paul Okello',
    ]) {
      const parsed = createClientSchema.safeParse({ ...VALID_CLIENT, fullName });
      expect(parsed.success, fullName).toBe(true);
    }
  });

  it('allows a free-text field to contain markup, which the view escapes', () => {
    // Occupation and notes are genuinely free text — a trader might write
    // "Hardware & building". Rejecting angle brackets here would be the wrong
    // layer; React escapes on output, and the database stores text.
    const parsed = createClientSchema.safeParse({
      ...VALID_CLIENT,
      occupation: 'Hardware & building',
      notes: 'Shop is <next to> the mosque',
    });

    expect(parsed.success).toBe(true);
  });
});

describe('editing a client', () => {
  const VALID_UPDATE = {
    ...VALID_CLIENT,
    clientId: '11111111-2222-4333-8444-555555555555',
  };

  it('accepts a well-formed edit', () => {
    expect(updateClientSchema.safeParse(VALID_UPDATE).success).toBe(true);
  });

  it('carries no privileged field', () => {
    const parsed = updateClientSchema.safeParse({
      ...VALID_UPDATE,
      status: 'blacklisted',
      clientNumber: 'CL26999',
      profileId: '11111111-2222-4333-8444-666666666666',
      photoPath: 'clients/x/photo/y.jpg',
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      // The allowlist is the type. Each of these has its own operation and
      // its own capability, so none can ride along with a general edit.
      for (const field of ['status', 'clientNumber', 'profileId', 'photoPath']) {
        expect(field in parsed.data, field).toBe(false);
      }
    }
  });

  it('requires a well-formed client identifier', () => {
    const parsed = updateClientSchema.safeParse({
      ...VALID_UPDATE,
      clientId: 'not-a-uuid',
    });
    expect(parsed.success).toBe(false);
  });
});

describe('changing a status', () => {
  const CLIENT_ID = '11111111-2222-4333-8444-555555555555';

  it.each(['suspended', 'blacklisted'])('demands a reason for %s', (status) => {
    const parsed = changeClientStatusSchema.safeParse({
      clientId: CLIENT_ID,
      status,
      reason: '',
    });

    expect(parsed.success, status).toBe(false);
  });

  it('rejects a reason that is merely a keystroke', () => {
    const parsed = changeClientStatusSchema.safeParse({
      clientId: CLIENT_ID,
      status: 'blacklisted',
      reason: 'x',
    });

    expect(parsed.success).toBe(false);
  });

  it('accepts a restriction with a real reason', () => {
    const parsed = changeClientStatusSchema.safeParse({
      clientId: CLIENT_ID,
      status: 'blacklisted',
      reason: 'Defaulted on two loans and left the district.',
    });

    expect(parsed.success).toBe(true);
  });

  it.each(['active', 'inactive', 'archived'])('accepts %s without a reason', (status) => {
    const parsed = changeClientStatusSchema.safeParse({
      clientId: CLIENT_ID,
      status,
      reason: '',
    });
    expect(parsed.success, status).toBe(true);
  });

  it('rejects a status outside the vocabulary', () => {
    const parsed = changeClientStatusSchema.safeParse({
      clientId: CLIENT_ID,
      status: 'deleted',
      reason: 'because',
    });
    expect(parsed.success).toBe(false);
  });

  it('bounds the reason', () => {
    const parsed = changeClientStatusSchema.safeParse({
      clientId: CLIENT_ID,
      status: 'suspended',
      reason: 'x'.repeat(2000),
    });
    expect(parsed.success).toBe(false);
  });
});

describe('remarks', () => {
  const CLIENT_ID = '11111111-2222-4333-8444-555555555555';

  it('accepts a real remark', () => {
    const parsed = createRemarkSchema.safeParse({
      clientId: CLIENT_ID,
      body: 'Payment was two weeks late in March; promised to settle by Friday.',
      category: 'payment_concern',
    });

    expect(parsed.success).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['a single keystroke', 'x'],
  ])('rejects a remark that is %s', (_label, body) => {
    // This table cannot be edited afterwards, so a mis-click must not become
    // a permanent record.
    const parsed = createRemarkSchema.safeParse({
      clientId: CLIENT_ID,
      body,
      category: 'general',
    });
    expect(parsed.success).toBe(false);
  });

  it('bounds the length', () => {
    const parsed = createRemarkSchema.safeParse({
      clientId: CLIENT_ID,
      body: 'x'.repeat(2001),
      category: 'general',
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts exactly the maximum length', () => {
    const parsed = createRemarkSchema.safeParse({
      clientId: CLIENT_ID,
      body: 'x'.repeat(2000),
      category: 'general',
    });
    expect(parsed.success).toBe(true);
  });

  it('does not offer retraction as a category a person may choose', () => {
    // `retraction` is set by the retract action, which also records which
    // remark is being withdrawn. Choosing it by hand would produce a
    // retraction that retracts nothing.
    const parsed = createRemarkSchema.safeParse({
      clientId: CLIENT_ID,
      body: 'Withdrawing this',
      category: 'retraction',
    });
    expect(parsed.success).toBe(false);
  });

  it('stores markup as written, for the view to escape', () => {
    const parsed = createRemarkSchema.safeParse({
      clientId: CLIENT_ID,
      body: '<script>alert("remark")</script> said he would pay',
      category: 'general',
    });

    // A remark is free text about a real conversation. Rejecting angle
    // brackets would be the wrong layer: React escapes on output.
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.body).toContain('<script>');
    }
  });
});

describe('guarantors', () => {
  const VALID_GUARANTOR = {
    fullName: 'Okello John',
    sex: 'male',
    dateOfBirth: '1985-03-03',
    phone: '0781234567',
    alternativePhone: '',
    occupation: 'Teacher',
    location: 'Bweyogerere',
    district: 'Wakiso',
    nin: '',
  };

  it('accepts the confirmed guarantor fields', () => {
    expect(createGuarantorSchema.safeParse(VALID_GUARANTOR).success).toBe(true);
  });

  it.each([
    ['fullName', ''],
    ['sex', ''],
    ['dateOfBirth', ''],
    ['phone', ''],
    ['occupation', ''],
    ['location', ''],
  ])('requires %s', (field, value) => {
    const parsed = createGuarantorSchema.safeParse({
      ...VALID_GUARANTOR,
      [field]: value,
    });
    expect(parsed.success, field).toBe(false);
  });

  it('treats the district and identification number as optional', () => {
    const parsed = createGuarantorSchema.safeParse({
      ...VALID_GUARANTOR,
      district: '',
      nin: '',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a guarantor below 18', () => {
    const parsed = createGuarantorSchema.safeParse({
      ...VALID_GUARANTOR,
      dateOfBirth: '2020-01-01',
    });
    expect(parsed.success).toBe(false);
  });

  it('requires a relationship when attaching to a client', () => {
    const parsed = linkGuarantorSchema.safeParse({
      clientId: '11111111-2222-4333-8444-555555555555',
      guarantorId: '11111111-2222-4333-8444-666666666666',
      relationshipToClient: '',
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts a relationship', () => {
    const parsed = linkGuarantorSchema.safeParse({
      clientId: '11111111-2222-4333-8444-555555555555',
      guarantorId: '11111111-2222-4333-8444-666666666666',
      relationshipToClient: 'Brother',
    });
    expect(parsed.success).toBe(true);
  });
});

describe('upload types', () => {
  it('accepts the photograph formats phones produce', () => {
    for (const mime of ['image/jpeg', 'image/png', 'image/webp', 'image/heic']) {
      expect(isAllowedPhotoMimeType(mime), mime).toBe(true);
    }
  });

  it('excludes SVG from photographs', () => {
    // An SVG is a document that can contain script, so a stored SVG served
    // from this origin would be a scripting vector dressed as a picture.
    // Nobody photographs a client with a vector camera.
    expect(isAllowedPhotoMimeType('image/svg+xml')).toBe(false);
    expect(isAllowedDocumentMimeType('image/svg+xml')).toBe(false);
  });

  it.each([
    'application/x-msdownload',
    'text/html',
    'application/javascript',
    'application/zip',
    'application/octet-stream',
    '',
  ])('rejects %s', (mime) => {
    expect(isAllowedPhotoMimeType(mime), mime).toBe(false);
    expect(isAllowedDocumentMimeType(mime), mime).toBe(false);
  });

  it('accepts a PDF for an identity document but not for a photograph', () => {
    // A national ID is often scanned rather than photographed.
    expect(isAllowedDocumentMimeType('application/pdf')).toBe(true);
    expect(isAllowedPhotoMimeType('application/pdf')).toBe(false);
  });
});

describe('upload content, checked by its first bytes', () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
  // 'MZ' — a Windows executable.
  const exe = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]);
  // '<?xml' — an SVG renamed to .png.
  const svg = new Uint8Array([0x3c, 0x3f, 0x78, 0x6d, 0x6c, 0x20]);

  it('accepts content that matches its declared type', () => {
    expect(contentMatchesDeclaredType('image/jpeg', jpeg)).toBe(true);
    expect(contentMatchesDeclaredType('image/png', png)).toBe(true);
    expect(contentMatchesDeclaredType('application/pdf', pdf)).toBe(true);
  });

  it('refuses an executable renamed to a photograph', () => {
    // An extension is a claim; the first bytes are evidence.
    expect(contentMatchesDeclaredType('image/jpeg', exe)).toBe(false);
    expect(contentMatchesDeclaredType('image/png', exe)).toBe(false);
  });

  it('refuses an SVG declaring itself a PNG', () => {
    expect(contentMatchesDeclaredType('image/png', svg)).toBe(false);
  });

  it('refuses a JPEG declaring itself a PNG, and the reverse', () => {
    expect(contentMatchesDeclaredType('image/png', jpeg)).toBe(false);
    expect(contentMatchesDeclaredType('image/jpeg', png)).toBe(false);
  });

  it('refuses a type it has no signature for, rather than waving it through', () => {
    // Failing closed matters more here than supporting an exotic format.
    expect(contentMatchesDeclaredType('image/gif', jpeg)).toBe(false);
    expect(contentMatchesDeclaredType('image/svg+xml', svg)).toBe(false);
    expect(contentMatchesDeclaredType('', jpeg)).toBe(false);
  });

  it('refuses a file too short to carry a signature', () => {
    expect(contentMatchesDeclaredType('image/jpeg', new Uint8Array([0xff]))).toBe(false);
    expect(contentMatchesDeclaredType('image/png', new Uint8Array([]))).toBe(false);
  });

  it('requires both markers for a container format', () => {
    // RIFF without WEBP at byte 8 is some other RIFF file — an AVI, say.
    const riffOnly = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x41, 0x56, 0x49, 0x20,
    ]);
    expect(contentMatchesDeclaredType('image/webp', riffOnly)).toBe(false);

    const webp = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
    ]);
    expect(contentMatchesDeclaredType('image/webp', webp)).toBe(true);
  });
});
