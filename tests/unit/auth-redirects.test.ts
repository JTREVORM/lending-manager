import { describe, expect, it } from 'vitest';

import { ROUTES } from '@/config/app';
import { safeNextPath, signInRedirectPath } from '@/lib/auth/routing';

/**
 * The redirect helpers.
 *
 * Both exist to stop one specific abuse: an attacker crafting a link to the
 * lender's own sign-in page that bounces the visitor somewhere else after they
 * authenticate. A URL beginning with the real domain is exactly what makes a
 * phishing link persuasive, so the `next` parameter has to be a plain in-site
 * path and nothing else.
 */
describe('safeNextPath', () => {
  it('accepts an in-site path', () => {
    expect(safeNextPath('/users')).toBe('/users');
    expect(safeNextPath('/users/0f8fad5b')).toBe('/users/0f8fad5b');
  });

  it('refuses an absolute URL', () => {
    for (const value of [
      'https://evil.example/steal',
      'http://evil.example',
      '//evil.example',
      'javascript:alert(1)',
    ]) {
      expect(safeNextPath(value), value).toBeNull();
    }
  });

  it('refuses a backslash, which some browsers normalise to a slash', () => {
    expect(safeNextPath('/\\evil.example')).toBeNull();
    expect(safeNextPath('\\\\evil.example')).toBeNull();
  });

  it('refuses a missing or absurdly long value', () => {
    expect(safeNextPath(null)).toBeNull();
    expect(safeNextPath(undefined)).toBeNull();
    expect(safeNextPath('')).toBeNull();
    expect(safeNextPath(`/${'a'.repeat(600)}`)).toBeNull();
  });
});

describe('signInRedirectPath', () => {
  it('returns the bare sign-in page with nothing to carry', () => {
    expect(signInRedirectPath()).toBe(ROUTES.login);
    expect(signInRedirectPath(ROUTES.dashboard)).toBe(ROUTES.login);
  });

  it('carries an in-site destination', () => {
    expect(signInRedirectPath(ROUTES.users)).toBe(`${ROUTES.login}?next=%2Fusers`);
  });

  it('never carries an off-site destination', () => {
    for (const value of ['https://evil.example', '//evil.example', 'evil.example']) {
      expect(signInRedirectPath(value), value).toBe(ROUTES.login);
    }
  });

  it('does not point back at the sign-in page itself', () => {
    expect(signInRedirectPath(ROUTES.login)).toBe(ROUTES.login);
  });

  it('carries a reason when there is one to explain', () => {
    expect(signInRedirectPath(undefined, 'no_roles')).toBe(
      `${ROUTES.login}?reason=no_roles`,
    );
  });

  it('carries both when both apply', () => {
    const result = signInRedirectPath(ROUTES.users, 'no_active_profile');
    expect(result).toContain('next=%2Fusers');
    expect(result).toContain('reason=no_active_profile');
  });
});
