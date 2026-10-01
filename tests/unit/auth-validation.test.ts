import { describe, expect, it } from 'vitest';

import {
  MIN_PASSWORD_LENGTH,
  changePasswordSchema,
  createStaffUserSchema,
  passwordSchema,
  resetUserPasswordSchema,
  setUserStatusSchema,
  signInSchema,
  updateOwnDetailsSchema,
  userDirectoryFilterSchema,
} from '@/lib/validation/auth';

describe('passwordSchema', () => {
  it('requires length rather than a mix of character classes', () => {
    // A long passphrase is stronger than a short one with a symbol in it, and
    // mandated character classes push people towards writing passwords down —
    // which, for staff sharing a counter, is the realistic failure mode.
    expect(passwordSchema.safeParse('correct horse battery').success).toBe(true);
    expect(passwordSchema.safeParse('Ab1!').success).toBe(false);
  });

  it('enforces the documented minimum', () => {
    expect(passwordSchema.safeParse('a'.repeat(MIN_PASSWORD_LENGTH)).success).toBe(true);
    expect(passwordSchema.safeParse('a'.repeat(MIN_PASSWORD_LENGTH - 1)).success).toBe(
      false,
    );
  });

  it('refuses a password longer than bcrypt can hash', () => {
    // Beyond 72 bytes the tail is silently ignored, which would make two
    // different passwords interchangeable.
    expect(passwordSchema.safeParse('a'.repeat(73)).success).toBe(false);
  });
});

describe('signInSchema', () => {
  it('requires both fields', () => {
    expect(signInSchema.safeParse({ identifier: '', password: 'x' }).success).toBe(false);
    expect(
      signInSchema.safeParse({ identifier: '0772123456', password: '' }).success,
    ).toBe(false);
  });

  it('does not validate the identifier as a phone number', () => {
    // Deliberate: a message distinguishing "not a phone number" from "wrong
    // details" is the first step of an enumeration oracle. The action returns
    // one generic failure for every cause.
    expect(
      signInSchema.safeParse({ identifier: 'nonsense', password: 'x' }).success,
    ).toBe(true);
  });

  it('does not impose the password policy at sign-in', () => {
    // An existing password shorter than today's minimum must still be usable;
    // the policy applies when setting a password, not when checking one.
    expect(
      signInSchema.safeParse({ identifier: '0772123456', password: 'abc' }).success,
    ).toBe(true);
  });
});

describe('changePasswordSchema', () => {
  const valid = {
    currentPassword: 'old-password-here',
    newPassword: 'new-password-here',
    confirmPassword: 'new-password-here',
  };

  it('accepts a well-formed change', () => {
    expect(changePasswordSchema.safeParse(valid).success).toBe(true);
  });

  it('requires the two new passwords to match', () => {
    const result = changePasswordSchema.safeParse({
      ...valid,
      confirmPassword: 'something-else',
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['confirmPassword']);
  });

  it('refuses re-using the current password', () => {
    // The flow exists because an administrator knows the temporary password.
    // Setting it again would leave that true.
    const result = changePasswordSchema.safeParse({
      currentPassword: 'same-password-here',
      newPassword: 'same-password-here',
      confirmPassword: 'same-password-here',
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['newPassword']);
  });

  it('requires the current password, so an unlocked browser is not enough', () => {
    expect(
      changePasswordSchema.safeParse({ ...valid, currentPassword: '' }).success,
    ).toBe(false);
  });
});

describe('createStaffUserSchema', () => {
  const valid = {
    fullName: 'Aisha Nakato',
    phone: '0772123456',
    email: '',
    roleKey: 'manager',
    temporaryPassword: 'temporary-password',
  };

  it('normalises the phone number to the canonical form', () => {
    const parsed = createStaffUserSchema.parse(valid);
    expect(parsed.phone).toBe('+256772123456');
  });

  it('treats a blank email as absent rather than as an empty string', () => {
    // The column is UNIQUE, so a second blank would collide with the first.
    expect(createStaffUserSchema.parse(valid).email).toBeNull();
  });

  it('refuses an unknown role', () => {
    expect(
      createStaffUserSchema.safeParse({ ...valid, roleKey: 'superuser' }).success,
    ).toBe(false);
  });

  it('refuses a weak temporary password', () => {
    expect(
      createStaffUserSchema.safeParse({ ...valid, temporaryPassword: 'abc' }).success,
    ).toBe(false);
  });

  it('refuses a malformed phone number', () => {
    expect(createStaffUserSchema.safeParse({ ...valid, phone: '12345' }).success).toBe(
      false,
    );
  });
});

describe('setUserStatusSchema', () => {
  const profileId = '0f8fad5b-d9cb-469f-a165-70867728950e';

  it('accepts the three statuses an administrator may set', () => {
    for (const status of ['active', 'inactive', 'suspended']) {
      expect(setUserStatusSchema.safeParse({ profileId, status }).success, status).toBe(
        true,
      );
    }
  });

  it('refuses archiving through this route', () => {
    // Archiving is a retention decision with consequences beyond access, so it
    // is not offered alongside "turn this person off for a week".
    expect(setUserStatusSchema.safeParse({ profileId, status: 'archived' }).success).toBe(
      false,
    );
  });

  it('refuses an invented status', () => {
    expect(setUserStatusSchema.safeParse({ profileId, status: 'deleted' }).success).toBe(
      false,
    );
  });

  it('requires a well-formed profile id', () => {
    expect(
      setUserStatusSchema.safeParse({ profileId: 'not-a-uuid', status: 'active' })
        .success,
    ).toBe(false);
  });
});

describe('resetUserPasswordSchema', () => {
  it('holds the new password to the same policy', () => {
    const profileId = '0f8fad5b-d9cb-469f-a165-70867728950e';

    expect(
      resetUserPasswordSchema.safeParse({ profileId, temporaryPassword: 'abc' }).success,
    ).toBe(false);
    expect(
      resetUserPasswordSchema.safeParse({
        profileId,
        temporaryPassword: 'a-long-enough-one',
      }).success,
    ).toBe(true);
  });
});

describe('updateOwnDetailsSchema', () => {
  it('accepts a name and an optional email', () => {
    expect(
      updateOwnDetailsSchema.parse({ fullName: 'Aisha Nakato', email: '' }).email,
    ).toBeNull();
  });

  it('has no field for role, status or phone', () => {
    // None of those is a user's to change, and the schema simply drops them
    // rather than relying on the action to notice.
    const input: Record<string, unknown> = {
      fullName: 'Aisha Nakato',
      email: '',
      roleKey: 'owner_admin',
      status: 'active',
      phone: '+256700000000',
    };

    const parsed: Record<string, unknown> = updateOwnDetailsSchema.parse(input);

    expect(parsed.roleKey).toBeUndefined();
    expect(parsed.status).toBeUndefined();
    expect(parsed.phone).toBeUndefined();
  });
});

describe('userDirectoryFilterSchema', () => {
  it('defaults to showing everything the caller may see', () => {
    expect(userDirectoryFilterSchema.parse({})).toEqual({ role: 'all', status: 'all' });
  });

  it('refuses an unknown role or status filter', () => {
    expect(userDirectoryFilterSchema.safeParse({ role: 'superuser' }).success).toBe(
      false,
    );
    expect(userDirectoryFilterSchema.safeParse({ status: 'deleted' }).success).toBe(
      false,
    );
  });

  it('bounds the search term', () => {
    expect(userDirectoryFilterSchema.safeParse({ search: 'a'.repeat(200) }).success).toBe(
      false,
    );
  });
});
