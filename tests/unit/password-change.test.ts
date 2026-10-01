import { describe, expect, it } from 'vitest';

import {
  performPasswordChange,
  type PasswordChangeSteps,
} from '@/lib/auth/password-change';

/**
 * The ordering half of the forced-password-change fix.
 *
 * The database guarantees that only a trusted server path can clear the flag
 * (tests/db/password-change.test.ts). It cannot guarantee that the trusted
 * path only does so *after* Supabase Auth has accepted a new password, because
 * it has no visibility into Supabase Auth. That guarantee is this function's,
 * and these tests are what make it a guarantee rather than an intention.
 *
 * Every assertion is made against a recorded call list, so "the flag was not
 * cleared" is observed rather than inferred from a return value.
 */

const VALID = {
  currentPassword: 'temporary-one-time-password',
  newPassword: 'a-properly-long-new-password',
  confirmPassword: 'a-properly-long-new-password',
};

interface Recorder {
  readonly calls: string[];
  readonly steps: PasswordChangeSteps;
}

/**
 * Steps that record what was called, with each outcome overridable.
 *
 * Defaults are the happy path, so each test states only the one failure it is
 * about.
 */
function recordingSteps(
  overrides: {
    verify?: boolean;
    update?: boolean;
    confirm?: boolean;
    recordThrows?: boolean;
  } = {},
): Recorder {
  const calls: string[] = [];

  return {
    calls,
    steps: {
      verifyCurrentPassword(password) {
        // The password is recorded only by length, never by value: a test
        // fixture that prints passwords is a habit that escapes into logging.
        calls.push(`verify(len=${String(password.length)})`);
        return Promise.resolve(overrides.verify ?? true);
      },
      updatePassword(password) {
        calls.push(`update(len=${String(password.length)})`);
        return Promise.resolve({ ok: overrides.update ?? true });
      },
      confirmChange() {
        calls.push('confirm');
        return Promise.resolve({ ok: overrides.confirm ?? true });
      },
      recordChange() {
        calls.push('record');
        return overrides.recordThrows === true
          ? Promise.reject(new Error('audit unavailable'))
          : Promise.resolve();
      },
    },
  };
}

describe('performPasswordChange', () => {
  describe('the successful path', () => {
    it('runs every step, in order, exactly once', async () => {
      const { calls, steps } = recordingSteps();

      const outcome = await performPasswordChange(VALID, steps);

      expect(outcome.ok).toBe(true);
      expect(calls).toEqual([
        `verify(len=${String(VALID.currentPassword.length)})`,
        `update(len=${String(VALID.newPassword.length)})`,
        'confirm',
        'record',
      ]);

      // Exactly once: a retry loop or a double-submit guard added later must
      // not turn one change into two confirmations.
      expect(calls.filter((call) => call === 'confirm')).toHaveLength(1);
    });

    it('confirms only after the update has returned successfully', async () => {
      const calls: string[] = [];
      let updateResolved = false;

      await performPasswordChange(VALID, {
        verifyCurrentPassword() {
          return Promise.resolve(true);
        },
        async updatePassword() {
          // Yield, so a confirmation racing ahead of the update would be
          // visible rather than hidden by synchronous resolution.
          await Promise.resolve();
          updateResolved = true;
          return { ok: true };
        },
        confirmChange() {
          calls.push(`confirm(updateResolved=${String(updateResolved)})`);
          return Promise.resolve({ ok: true });
        },
        recordChange() {
          return Promise.resolve();
        },
      });

      expect(calls).toEqual(['confirm(updateResolved=true)']);
    });

    it('tells the user plainly that it worked', async () => {
      const { steps } = recordingSteps();
      const outcome = await performPasswordChange(VALID, steps);

      expect(outcome.message).toMatch(/has been changed/i);
      expect(outcome.fieldErrors).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  describe('a wrong current password', () => {
    it('does not clear the flag, and does not change the password either', async () => {
      const { calls, steps } = recordingSteps({ verify: false });

      const outcome = await performPasswordChange(VALID, steps);

      expect(outcome.ok).toBe(false);
      // The whole point: `confirm` never ran, so nothing could have cleared.
      expect(calls).toEqual([`verify(len=${String(VALID.currentPassword.length)})`]);
      expect(calls).not.toContain('confirm');
      expect(calls).not.toContain('update');
    });

    it('says which field was wrong, without saying whether the account exists', async () => {
      const { steps } = recordingSteps({ verify: false });
      const outcome = await performPasswordChange(VALID, steps);

      expect(outcome.fieldErrors?.currentPassword).toBeDefined();
      expect(outcome.message).toMatch(/current password/i);
      // The caller is already authenticated here, so naming the field is safe;
      // what must not appear is anything about the account itself.
      expect(outcome.message).not.toMatch(/exist|found|unknown/i);
    });
  });

  // -------------------------------------------------------------------------
  describe('a refused password update', () => {
    it('does not clear the flag', async () => {
      const { calls, steps } = recordingSteps({ update: false });

      const outcome = await performPasswordChange(VALID, steps);

      expect(outcome.ok).toBe(false);
      expect(calls).toEqual([
        `verify(len=${String(VALID.currentPassword.length)})`,
        `update(len=${String(VALID.newPassword.length)})`,
      ]);
      expect(calls).not.toContain('confirm');
      expect(calls).not.toContain('record');
    });

    it('does not echo whatever Supabase said', async () => {
      const { steps } = recordingSteps({ update: false });
      const outcome = await performPasswordChange(VALID, steps);

      expect(outcome.message).toMatch(/not accepted/i);
      expect(outcome.fieldErrors?.newPassword).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  describe('a failed confirmation', () => {
    it('reports failure, but tells the truth about the password having changed', async () => {
      const { calls, steps } = recordingSteps({ confirm: false });

      const outcome = await performPasswordChange(VALID, steps);

      expect(outcome.ok).toBe(false);
      expect(calls).not.toContain('record');

      // The password HAS changed. "That didn't work" would leave the user
      // trying their old one and locked out of an account that is working.
      expect(outcome.message).toMatch(/password was changed/i);
      expect(outcome.message).toMatch(/administrator/i);
    });
  });

  // -------------------------------------------------------------------------
  describe('validation', () => {
    it('rejects a short new password before anything is attempted', async () => {
      const { calls, steps } = recordingSteps();

      const outcome = await performPasswordChange(
        {
          currentPassword: 'temporary-one-time',
          newPassword: 'short',
          confirmPassword: 'short',
        },
        steps,
      );

      expect(outcome.ok).toBe(false);
      expect(outcome.fieldErrors?.newPassword).toBeDefined();
      // Nothing ran at all: an invalid password must never reach Supabase, and
      // certainly never reach the confirmation.
      expect(calls).toEqual([]);
    });

    it('rejects a mismatched confirmation', async () => {
      const { calls, steps } = recordingSteps();

      const outcome = await performPasswordChange(
        { ...VALID, confirmPassword: 'a-properly-long-new-passwore' },
        steps,
      );

      expect(outcome.ok).toBe(false);
      expect(calls).toEqual([]);
    });

    it('rejects a new password identical to the current one', async () => {
      const { calls, steps } = recordingSteps();

      const outcome = await performPasswordChange(
        {
          currentPassword: VALID.newPassword,
          newPassword: VALID.newPassword,
          confirmPassword: VALID.newPassword,
        },
        steps,
      );

      // Otherwise a user under a forced change could "change" to the temporary
      // password their administrator already knows and clear the flag.
      expect(outcome.ok).toBe(false);
      expect(calls).toEqual([]);
    });

    it.each([
      ['missing', undefined],
      ['null', null],
      ['a number', 12345678901234],
      ['an object', { toString: () => 'a-properly-long-new-password' }],
    ])('rejects %s input without attempting anything', async (_label, value) => {
      const { calls, steps } = recordingSteps();

      const outcome = await performPasswordChange(
        { currentPassword: value, newPassword: value, confirmPassword: value },
        steps,
      );

      expect(outcome.ok).toBe(false);
      expect(calls).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  describe('audit', () => {
    it('records the change, and is never handed the password to record', async () => {
      const recorded: unknown[] = [];

      const outcome = await performPasswordChange(VALID, {
        verifyCurrentPassword() {
          return Promise.resolve(true);
        },
        updatePassword() {
          return Promise.resolve({ ok: true });
        },
        confirmChange() {
          return Promise.resolve({ ok: true });
        },
        recordChange(...args: unknown[]) {
          recorded.push(...args);
          return Promise.resolve();
        },
      });

      expect(outcome.ok).toBe(true);
      // `recordChange` takes no arguments by design, so there is no parameter
      // through which a password could reach the audit log.
      expect(recorded).toEqual([]);
    });

    it('does not fail the change when auditing throws', async () => {
      const { calls, steps } = recordingSteps({ recordThrows: true });

      const outcome = await performPasswordChange(VALID, steps);

      // The password has already changed by this point, and the flag has
      // already cleared. Reporting failure would send the user back to a
      // password that no longer works.
      expect(outcome.ok).toBe(true);
      expect(outcome.message).toMatch(/has been changed/i);

      // But the failure is not invisible: the caller is told, and logs it.
      expect(outcome.auditFailed).toBe(true);
      expect(calls).toContain('record');
    });

    it('leaves auditFailed unset when auditing works', async () => {
      const { steps } = recordingSteps();
      const outcome = await performPasswordChange(VALID, steps);

      expect(outcome.auditFailed).toBeUndefined();
    });
  });
});
