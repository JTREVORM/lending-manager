import { afterAll, describe, expect, it } from 'vitest';

import { parseReference } from '@/lib/domain/reference';
import {
  closePool,
  expectError,
  hasDatabase,
  inRollbackTransaction,
  query,
  queryOne,
  skipReason,
} from '../helpers/db';

/**
 * Behavioural verification: do the constraints, triggers and functions
 * actually do what the schema claims?
 *
 * A `CHECK` constraint that is never exercised is a comment. Each test here
 * attempts the thing that must fail and asserts that it does.
 */
const describeDb = hasDatabase ? describe : describe.skip;

afterAll(async () => {
  await closePool();
});

if (!hasDatabase) {
  describe('behaviour suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

describeDb('profiles constraints are enforced, not merely declared', () => {
  it('accepts a well-formed profile', async () => {
    await inRollbackTransaction(async (client) => {
      const result = await client.query<{ id: string; status: string }>(
        `insert into public.profiles (full_name, phone, email)
         values ($1, $2, $3) returning id, status`,
        ['Aisha Nakato', '+256772123456', 'aisha@example.com'],
      );

      expect(result.rows[0]?.status).toBe('active');
    });
  });

  it('rejects a phone number that is not canonical E.164', async () => {
    // The application normalises before writing; this is the backstop for any
    // write that bypassed it.
    for (const phone of [
      '0772123456',
      '772123456',
      '+256 772 123 456',
      '+254712345678',
    ]) {
      const error = await expectError(
        `insert into public.profiles (full_name, phone) values ('Test', $1)`,
        [phone],
      );

      expect(error?.code, phone).toBe('23514');
      expect(error?.constraint, phone).toBe('profiles_phone_e164');
    }
  });

  it('rejects a duplicate phone number', async () => {
    await inRollbackTransaction(async (client) => {
      await client.query(
        `insert into public.profiles (full_name, phone) values ('First', '+256772100001')`,
      );

      await expect(
        client.query(
          `insert into public.profiles (full_name, phone) values ('Second', '+256772100001')`,
        ),
      ).rejects.toMatchObject({ code: '23505' });
    });
  });

  it('rejects a duplicate email', async () => {
    await inRollbackTransaction(async (client) => {
      await client.query(
        `insert into public.profiles (full_name, phone, email)
         values ('First', '+256772100002', 'dup@example.com')`,
      );

      await expect(
        client.query(
          `insert into public.profiles (full_name, phone, email)
           values ('Second', '+256772100003', 'dup@example.com')`,
        ),
      ).rejects.toMatchObject({ code: '23505' });
    });
  });

  it('rejects a non-lowercase email, so the unique index is case-insensitive in effect', async () => {
    const error = await expectError(
      `insert into public.profiles (full_name, phone, email)
       values ('Test', '+256772100004', 'Mixed@Example.com')`,
    );

    expect(error?.constraint).toBe('profiles_email_lowercase');
  });

  it('rejects a malformed email', async () => {
    const error = await expectError(
      `insert into public.profiles (full_name, phone, email)
       values ('Test', '+256772100005', 'not-an-email')`,
    );

    expect(error?.constraint).toBe('profiles_email_shape');
  });

  it('rejects a blank or over-long name', async () => {
    expect(
      (
        await expectError(
          `insert into public.profiles (full_name, phone) values ('   ', '+256772100006')`,
        )
      )?.code,
    ).toBe('23514');

    expect(
      (
        await expectError(
          `insert into public.profiles (full_name, phone) values ($1, '+256772100007')`,
          ['x'.repeat(121)],
        )
      )?.constraint,
    ).toBe('profiles_full_name_length');
  });

  it('rejects a status outside the application vocabulary', async () => {
    const error = await expectError(
      `insert into public.profiles (full_name, phone, status)
       values ('Test', '+256772100008', 'deleted')`,
    );

    // There is no 'deleted' status, because records are archived, not deleted.
    expect(error?.constraint).toBe('profiles_status_valid');
  });

  it('keeps status and archived_at consistent in both directions', async () => {
    // Archived without a timestamp.
    expect(
      (
        await expectError(
          `insert into public.profiles (full_name, phone, status)
           values ('Test', '+256772100009', 'archived')`,
        )
      )?.constraint,
    ).toBe('profiles_archived_at_consistent');

    // A timestamp without being archived.
    expect(
      (
        await expectError(
          `insert into public.profiles (full_name, phone, status, archived_at)
           values ('Test', '+256772100010', 'active', now())`,
        )
      )?.constraint,
    ).toBe('profiles_archived_at_consistent');

    // Both together is accepted.
    await inRollbackTransaction(async (client) => {
      const result = await client.query(
        `insert into public.profiles (full_name, phone, status, archived_at)
         values ('Test', '+256772100011', 'archived', now()) returning id`,
      );
      expect(result.rowCount).toBe(1);
    });
  });

  it('refuses to delete a profile that an audit record references', async () => {
    // The whole point of ON DELETE RESTRICT: a person referenced by financial
    // or audit history cannot be made to vanish.
    await inRollbackTransaction(async (client) => {
      const profile = await client.query<{ id: string }>(
        `insert into public.profiles (full_name, phone)
         values ('Referenced', '+256772100012') returning id`,
      );
      const profileId = profile.rows[0]?.id;

      await client.query(
        `insert into public.audit_log (actor_profile_id, actor_label, action, entity_type)
         values ($1, 'Referenced', 'test.action', 'profile')`,
        [profileId],
      );

      await expect(
        client.query(`delete from public.profiles where id = $1`, [profileId]),
      ).rejects.toMatchObject({ code: '23503' });
    });
  });
});

describeDb('updated_at trigger', () => {
  it('advances updated_at on a later update, whatever issued it', async () => {
    // Insert and update must be in separate transactions. PostgreSQL's `now()`
    // is the TRANSACTION start time, so a row inserted and updated in one
    // transaction legitimately keeps one timestamp — see the next test.
    const PHONE = '+256772200001';
    try {
      const inserted = await queryOne<{ id: string; timestamps_match: boolean }>(
        `insert into public.profiles (full_name, phone)
         values ('Trigger Test', $1)
         returning id, (created_at = updated_at) as timestamps_match`,
        [PHONE],
      );

      expect(inserted.timestamps_match).toBe(true);

      const updated = await queryOne<{ advanced: boolean }>(
        `update public.profiles
            set full_name = 'Trigger Test Renamed'
          where id = $1
         returning (updated_at > created_at) as advanced`,
        [inserted.id],
      );

      expect(updated.advanced).toBe(true);
    } finally {
      await query(`delete from public.profiles where phone = $1`, [PHONE]);
    }
  });

  it('gives every row touched by one transaction the same timestamp, by design', async () => {
    // `now()` rather than `clock_timestamp()` is deliberate: an atomic change
    // should be stamped with one instant across every row it touches, so a
    // multi-row financial write cannot appear to have happened over an
    // interval. Within a transaction the timestamp therefore does not advance.
    await inRollbackTransaction(async (client) => {
      const inserted = await client.query<{ id: string }>(
        `insert into public.profiles (full_name, phone)
         values ('Same Transaction', '+256772200003') returning id`,
      );

      const updated = await client.query<{ unchanged: boolean }>(
        `update public.profiles
            set full_name = 'Same Transaction Renamed'
          where id = $1
         returning (updated_at = created_at) as unchanged`,
        [inserted.rows[0]?.id],
      );

      expect(updated.rows[0]?.unchanged).toBe(true);
    });
  });

  it('ignores an updated_at supplied by the caller, so it cannot be faked', async () => {
    await inRollbackTransaction(async (client) => {
      const inserted = await client.query<{ id: string }>(
        `insert into public.profiles (full_name, phone)
         values ('Trigger Test', '+256772200002') returning id`,
      );

      const updated = await client.query<{ in_the_past: boolean }>(
        `update public.profiles
            set full_name = 'Renamed', updated_at = '2000-01-01T00:00:00Z'
          where id = $1
         returning (updated_at < '2020-01-01T00:00:00Z') as in_the_past`,
        [inserted.rows[0]?.id],
      );

      expect(updated.rows[0]?.in_the_past).toBe(false);
    });
  });

  it('maintains updated_at on the settings tables too', async () => {
    await inRollbackTransaction(async (client) => {
      const result = await client.query<{ advanced: boolean }>(
        `update public.business_settings
            set grace_period_days = 4
          where id = 1
         returning (updated_at > created_at) as advanced`,
      );

      expect(result.rows[0]?.advanced).toBe(true);
    });
  });
});

describeDb('settings constraints', () => {
  it('rejects a second row in each singleton table', async () => {
    expect(
      (
        await expectError(
          `insert into public.company_settings (id, company_name) values (2, 'Second')`,
        )
      )?.constraint,
    ).toBe('company_settings_singleton');

    expect(
      (
        await expectError(
          `insert into public.business_settings
             (id, min_loan_amount, max_loan_amount, default_monthly_interest_rate_bps,
              min_loan_term_months, max_loan_term_months, grace_period_days,
              penalty_rate_bps, default_repayment_frequency)
           values (2, 1, 2, 1, 1, 1, 0, 0, 'daily')`,
        )
      )?.constraint,
    ).toBe('business_settings_singleton');
  });

  it('rejects a maximum loan below the minimum', async () => {
    const error = await expectError(
      `update public.business_settings set max_loan_amount = 50000 where id = 1`,
    );

    expect(error?.constraint).toBe('business_settings_loan_amount_order');
  });

  it('rejects an inverted term range', async () => {
    const error = await expectError(
      `update public.business_settings
          set min_loan_term_months = 6, max_loan_term_months = 3
        where id = 1`,
    );

    expect(error?.constraint).toBe('business_settings_term_order');
  });

  it('rejects a non-positive minimum loan', async () => {
    expect(
      (
        await expectError(
          `update public.business_settings set min_loan_amount = 0 where id = 1`,
        )
      )?.constraint,
    ).toBe('business_settings_min_loan_positive');
  });

  it('rejects an absurd rate, catching a basis-point data-entry slip', async () => {
    // Typing 15000000 where 1500 was meant.
    const error = await expectError(
      `update public.business_settings
          set default_monthly_interest_rate_bps = 15000000 where id = 1`,
    );

    expect(error?.constraint).toBe('business_settings_interest_rate_range');
  });

  it('rejects a negative rate and a negative grace period', async () => {
    expect(
      (
        await expectError(
          `update public.business_settings set penalty_rate_bps = -1 where id = 1`,
        )
      )?.code,
    ).toBe('23514');

    expect(
      (
        await expectError(
          `update public.business_settings set grace_period_days = -1 where id = 1`,
        )
      )?.code,
    ).toBe('23514');
  });

  it('rejects a repayment frequency that does not exist', async () => {
    const error = await expectError(
      `update public.business_settings set default_repayment_frequency = 'weekly' where id = 1`,
    );

    expect(error?.code).toBe('23503');
  });

  it('refuses to delete a frequency that business settings reference', async () => {
    const error = await expectError(
      `delete from public.repayment_frequencies where key = 'daily'`,
    );

    // Retiring a cadence is `is_active = false`, never a delete.
    expect(error?.code).toBe('23503');
  });

  it('rejects a malformed brand colour and an unsafe logo path', async () => {
    expect(
      (
        await expectError(
          `update public.company_settings set brand_primary_color = 'green' where id = 1`,
        )
      )?.constraint,
    ).toBe('company_settings_brand_color_hex');

    for (const path of ['../../etc/passwd', '/etc/passwd', 'logo/../../secret']) {
      const error = await expectError(
        `update public.company_settings set logo_path = $1 where id = 1`,
        [path],
      );
      expect(error?.constraint, path).toBe('company_settings_logo_path_safe');
    }
  });

  it('accepts a conforming logo path', async () => {
    await inRollbackTransaction(async (client) => {
      const result = await client.query(
        `update public.company_settings set logo_path = 'logo/abc-123.png' where id = 1`,
      );
      expect(result.rowCount).toBe(1);
    });
  });
});

describeDb('audit log is append-only', () => {
  it('accepts an insert through the write function and derives the actor', async () => {
    await inRollbackTransaction(async (client) => {
      const result = await client.query<{ id: string }>(
        `select public.record_audit_event(
                  'settings.changed', 'business_settings', '1',
                  null, '{"grace_period_days": 4}'::jsonb
                )::text as id`,
      );

      expect(result.rows[0]?.id).toBeTruthy();

      const row = await client.query<{
        actor_label: string;
        action: string;
        actor_profile_id: string | null;
      }>(
        `select actor_label, action, actor_profile_id
           from public.audit_log
          order by id desc limit 1`,
      );

      // No session, so the action is attributed to 'system' — never blank,
      // and never to a caller-supplied value.
      expect(row.rows[0]?.actor_label).toBe('system');
      expect(row.rows[0]?.action).toBe('settings.changed');
      expect(row.rows[0]?.actor_profile_id).toBeNull();
    });
  });

  it('blocks UPDATE, DELETE and TRUNCATE', async () => {
    // Each attempt needs its own transaction: the first raise aborts the
    // transaction, after which every later statement fails with 25P02 and
    // would mask whether the trigger actually fired.
    for (const statement of [
      `update public.audit_log set action = 'tampered'`,
      `delete from public.audit_log`,
      `truncate public.audit_log`,
    ]) {
      const error = await expectError(statement);
      expect(error, statement).not.toBeNull();
      expect(error?.code, statement).toBe('P0001');
      expect(error?.message, statement).toContain('append-only');
    }
  });

  it('blocks an UPDATE that would match an existing row', async () => {
    await inRollbackTransaction(async (client) => {
      await client.query(
        `insert into public.audit_log (actor_label, action, entity_type)
         values ('system', 'test.action', 'profile')`,
      );

      await expect(
        client.query(`update public.audit_log set action = 'tampered'`),
      ).rejects.toMatchObject({ code: 'P0001' });
    });
  });

  it('blocks a mutation even when it would match no rows, so it fails loudly', async () => {
    // A statement-level trigger fires regardless of row count, which means a
    // tampering attempt cannot appear to succeed silently.
    await inRollbackTransaction(async (client) => {
      await expect(
        client.query(`delete from public.audit_log where id = -1`),
      ).rejects.toMatchObject({ code: 'P0001' });
    });
  });

  it('enforces the action and entity_type naming vocabulary', async () => {
    for (const action of ['Loan.Created', 'loan created', '1loan', 'loan..created']) {
      const error = await expectError(
        `insert into public.audit_log (actor_label, action, entity_type)
         values ('system', $1, 'loan')`,
        [action],
      );
      expect(error?.constraint, action).toBe('audit_log_action_format');
    }

    expect(
      (
        await expectError(
          `insert into public.audit_log (actor_label, action, entity_type)
           values ('system', 'loan.created', 'Loan')`,
        )
      )?.constraint,
    ).toBe('audit_log_entity_type_format');
  });

  it('accepts a dotted action name', async () => {
    await inRollbackTransaction(async (client) => {
      for (const action of [
        'loan.created',
        'payment.reversed',
        'settings.business.updated',
      ]) {
        const result = await client.query(
          `insert into public.audit_log (actor_label, action, entity_type)
           values ('system', $1, 'loan')`,
          [action],
        );
        expect(result.rowCount, action).toBe(1);
      }
    });
  });

  it('requires an actor label, so no record is unattributed', async () => {
    expect(
      (
        await expectError(
          `insert into public.audit_log (actor_label, action, entity_type)
           values ('  ', 'loan.created', 'loan')`,
        )
      )?.constraint,
    ).toBe('audit_log_actor_label_not_blank');

    expect(
      (
        await expectError(
          `insert into public.audit_log (action, entity_type)
           values ('loan.created', 'loan')`,
        )
      )?.code,
    ).toBe('23502');
  });

  it('requires jsonb columns to hold objects, so queries have a predictable shape', async () => {
    for (const value of ['"a string"', '42', '[1,2,3]']) {
      const error = await expectError(
        `insert into public.audit_log (actor_label, action, entity_type, new_values)
         values ('system', 'loan.created', 'loan', $1::jsonb)`,
        [value],
      );
      expect(error?.constraint, value).toBe('audit_log_new_values_is_object');
    }
  });
});

describeDb('next_reference', () => {
  it('produces exactly the formats the business specified', async () => {
    await inRollbackTransaction(async (client) => {
      const result = await client.query<{
        client_ref: string;
        loan_ref: string;
        payment_ref: string;
      }>(
        `select public.next_reference('client')  as client_ref,
                public.next_reference('loan')    as loan_ref,
                public.next_reference('payment') as payment_ref`,
      );

      const row = result.rows[0]!;
      expect(row.client_ref).toMatch(/^CL\d{2}\d{3,}$/);
      expect(row.loan_ref).toMatch(/^LN\d{2}\d{4,}$/);
      expect(row.payment_ref).toMatch(/^PAY\d{2}\d{4,}$/);
    });
  });

  it('agrees with the TypeScript parser, so the two sides share one format', async () => {
    await inRollbackTransaction(async (client) => {
      const result = await client.query<{ reference: string }>(
        `select public.next_reference('client') as reference`,
      );

      const parsed = parseReference(result.rows[0]!.reference);
      expect(parsed).not.toBeNull();
      expect(parsed?.scope).toBe('client');
    });
  });

  it('increments monotonically within a scope', async () => {
    await inRollbackTransaction(async (client) => {
      const result = await client.query<{ reference: string }>(
        `select public.next_reference('client') as reference
           from generate_series(1, 5)`,
      );

      const sequences = result.rows.map(
        (row) => parseReference(row.reference)?.sequence ?? -1,
      );

      for (let index = 1; index < sequences.length; index += 1) {
        expect(sequences[index]).toBe(sequences[index - 1]! + 1);
      }
    });
  });

  it('keeps scopes independent', async () => {
    await inRollbackTransaction(async (client) => {
      await client.query(
        `select public.next_reference('client') from generate_series(1, 3)`,
      );

      const result = await client.query<{ reference: string }>(
        `select public.next_reference('loan') as reference`,
      );

      // Advancing clients must not advance loans.
      expect(parseReference(result.rows[0]!.reference)?.sequence).toBe(1);
    });
  });

  it('rejects an unknown scope rather than inventing a prefix', async () => {
    const error = await expectError(`select public.next_reference('guarantor')`);

    expect(error?.code).toBe('P0001');
    expect(error?.message).toContain('Unknown reference scope');
  });

  it('uses the business timezone from company_settings for the year', async () => {
    await inRollbackTransaction(async (client) => {
      const expected = await client.query<{ two_digit_year: string }>(
        `select to_char(timezone(c.timezone, now()), 'YY') as two_digit_year
           from public.company_settings c where c.id = 1`,
      );

      const result = await client.query<{ reference: string }>(
        `select public.next_reference('client') as reference`,
      );

      const year = parseReference(result.rows[0]!.reference)?.twoDigitYear;
      expect(String(year).padStart(2, '0')).toBe(expected.rows[0]?.two_digit_year);
    });
  });

  it('never issues the same reference twice under genuine concurrency', async () => {
    // The failure this guards against is two cashiers registering a client at
    // the same moment. Each call runs on its own connection, concurrently, so
    // they genuinely contend for the counter row.
    const CALLS = 60;

    const before = await queryOne<{ last_value: string }>(
      `select coalesce(max(last_value), 0)::text as last_value
         from public.reference_sequences where scope = 'client'`,
    );

    const results = await Promise.all(
      Array.from({ length: CALLS }, () =>
        queryOne<{ reference: string }>(
          `select public.next_reference('client') as reference`,
        ),
      ),
    );

    const references = results.map((row) => row.reference);

    expect(references).toHaveLength(CALLS);
    expect(new Set(references).size).toBe(CALLS);

    // Gapless as well as distinct, since no transaction rolled back.
    const sequences = references
      .map((reference) => parseReference(reference)?.sequence ?? -1)
      .sort((a, b) => a - b);
    const start = Number(before.last_value) + 1;

    expect(sequences).toEqual(Array.from({ length: CALLS }, (_, index) => start + index));
  });

  it('does not let a direct write rewind the counter', async () => {
    // No application role holds write access to reference_sequences — only
    // next_reference(), which is SECURITY DEFINER — precisely so the counter
    // cannot be moved backwards into already-issued territory.
    const grants = await query(
      `select 1
         from information_schema.role_table_grants
        where table_schema = 'public'
          and table_name = 'reference_sequences'
          and grantee in ('anon', 'authenticated')`,
    );

    expect(grants).toEqual([]);
  });
});

describeDb('role assignments', () => {
  it('prevents the same role being granted twice to one profile', async () => {
    await inRollbackTransaction(async (client) => {
      const profile = await client.query<{ id: string }>(
        `insert into public.profiles (full_name, phone)
         values ('Role Test', '+256772300001') returning id`,
      );
      const profileId = profile.rows[0]?.id;

      await client.query(
        `insert into public.user_roles (profile_id, role_key) values ($1, 'manager')`,
        [profileId],
      );

      await expect(
        client.query(
          `insert into public.user_roles (profile_id, role_key) values ($1, 'manager')`,
          [profileId],
        ),
      ).rejects.toMatchObject({ code: '23505' });
    });
  });

  it('allows a profile to hold several roles', async () => {
    await inRollbackTransaction(async (client) => {
      const profile = await client.query<{ id: string }>(
        `insert into public.profiles (full_name, phone)
         values ('Multi Role', '+256772300002') returning id`,
      );

      const result = await client.query(
        `insert into public.user_roles (profile_id, role_key)
         values ($1, 'manager'), ($1, 'owner_admin')`,
        [profile.rows[0]?.id],
      );

      expect(result.rowCount).toBe(2);
    });
  });

  it('rejects a role that does not exist', async () => {
    await inRollbackTransaction(async (client) => {
      const profile = await client.query<{ id: string }>(
        `insert into public.profiles (full_name, phone)
         values ('Bad Role', '+256772300003') returning id`,
      );

      await expect(
        client.query(
          `insert into public.user_roles (profile_id, role_key) values ($1, 'superuser')`,
          [profile.rows[0]?.id],
        ),
      ).rejects.toMatchObject({ code: '23503' });
    });
  });

  it('records who granted the role and when', async () => {
    await inRollbackTransaction(async (client) => {
      const granter = await client.query<{ id: string }>(
        `insert into public.profiles (full_name, phone)
         values ('Owner', '+256772300004') returning id`,
      );
      const grantee = await client.query<{ id: string }>(
        `insert into public.profiles (full_name, phone)
         values ('Staff', '+256772300005') returning id`,
      );

      const result = await client.query<{ granted_by: string; granted_at: string }>(
        `insert into public.user_roles (profile_id, role_key, granted_by)
         values ($1, 'secretary_treasurer', $2)
         returning granted_by, granted_at::text`,
        [grantee.rows[0]?.id, granter.rows[0]?.id],
      );

      // "Who gave this person the ability to record payments, and when" is an
      // audit question a lending business must be able to answer.
      expect(result.rows[0]?.granted_by).toBe(granter.rows[0]?.id);
      expect(result.rows[0]?.granted_at).toBeTruthy();
    });
  });

  it('refuses to delete a role still assigned to someone', async () => {
    await inRollbackTransaction(async (client) => {
      const profile = await client.query<{ id: string }>(
        `insert into public.profiles (full_name, phone)
         values ('Holder', '+256772300006') returning id`,
      );
      await client.query(
        `insert into public.user_roles (profile_id, role_key) values ($1, 'manager')`,
        [profile.rows[0]?.id],
      );

      await expect(
        client.query(`delete from public.roles where key = 'manager'`),
      ).rejects.toMatchObject({ code: '23503' });
    });
  });
});

describeDb('session helper functions', () => {
  it('resolves nothing when there is no session', async () => {
    const row = await queryOne<{ profile_id: string | null; roles: string[] }>(
      `select public.current_profile_id() as profile_id,
              public.current_user_role_keys() as roles`,
    );

    // Fails closed: no session means no identity and no roles.
    expect(row.profile_id).toBeNull();
    expect(row.roles).toEqual([]);
  });

  it('resolves the profile and roles of the impersonated user', async () => {
    await inRollbackTransaction(async (client) => {
      const authUser = await client.query<{ id: string }>(
        `insert into auth.users (email) values ('staff@example.com') returning id`,
      );
      const authUserId = authUser.rows[0]!.id;

      const profile = await client.query<{ id: string }>(
        `insert into public.profiles (full_name, phone, auth_user_id)
         values ('Session Test', '+256772400001', $1) returning id`,
        [authUserId],
      );

      await client.query(
        `insert into public.user_roles (profile_id, role_key)
         values ($1, 'manager')`,
        [profile.rows[0]?.id],
      );

      await client.query(`set local "request.jwt.claim.sub" = '${authUserId}'`);

      const row = await client.query<{
        profile_id: string;
        roles: string[];
        is_manager: boolean;
        at_least_secretary: boolean;
        at_least_owner: boolean;
        is_owner: boolean;
      }>(
        `select public.current_profile_id() as profile_id,
                public.current_user_role_keys() as roles,
                public.user_has_role('manager') as is_manager,
                public.user_has_at_least_role('secretary_treasurer') as at_least_secretary,
                public.user_has_at_least_role('owner_admin') as at_least_owner,
                public.user_has_role('owner_admin') as is_owner`,
      );

      const result = row.rows[0]!;
      expect(result.profile_id).toBe(profile.rows[0]?.id);
      expect(result.roles).toEqual(['manager']);
      expect(result.is_manager).toBe(true);
      // A manager outranks a secretary/treasurer.
      expect(result.at_least_secretary).toBe(true);
      // But not an owner/administrator.
      expect(result.at_least_owner).toBe(false);
      expect(result.is_owner).toBe(false);
    });
  });

  it('gives a suspended or archived account no identity at all', async () => {
    // A suspended account must not retain its permissions just because its
    // auth session is still valid.
    for (const status of ['inactive', 'suspended']) {
      await inRollbackTransaction(async (client) => {
        const authUser = await client.query<{ id: string }>(
          `insert into auth.users (email) values ($1) returning id`,
          [`${status}@example.com`],
        );
        const authUserId = authUser.rows[0]!.id;

        const profile = await client.query<{ id: string }>(
          `insert into public.profiles (full_name, phone, auth_user_id, status)
           values ('Blocked', '+256772400002', $1, $2) returning id`,
          [authUserId, status],
        );

        await client.query(
          `insert into public.user_roles (profile_id, role_key) values ($1, 'owner_admin')`,
          [profile.rows[0]?.id],
        );

        await client.query(`set local "request.jwt.claim.sub" = '${authUserId}'`);

        const row = await client.query<{ profile_id: string | null; is_owner: boolean }>(
          `select public.current_profile_id() as profile_id,
                  public.user_has_role('owner_admin') as is_owner`,
        );

        expect(row.rows[0]?.profile_id, status).toBeNull();
        expect(row.rows[0]?.is_owner, status).toBe(false);
      });
    }
  });

  it('returns false for an unknown role key rather than erroring', async () => {
    const row = await queryOne<{ unknown_role: boolean }>(
      `select public.user_has_at_least_role('not_a_role') as unknown_role`,
    );

    expect(row.unknown_role).toBe(false);
  });

  it('attributes an audit record to the session user, not to a supplied value', async () => {
    await inRollbackTransaction(async (client) => {
      const authUser = await client.query<{ id: string }>(
        `insert into auth.users (email) values ('actor@example.com') returning id`,
      );
      const authUserId = authUser.rows[0]!.id;

      const profile = await client.query<{ id: string }>(
        `insert into public.profiles (full_name, phone, auth_user_id)
         values ('Grace Akello', '+256772400003', $1) returning id`,
        [authUserId],
      );

      await client.query(`set local "request.jwt.claim.sub" = '${authUserId}'`);
      await client.query(
        `select public.record_audit_event('settings.changed', 'business_settings', '1')`,
      );

      const row = await client.query<{
        actor_profile_id: string;
        actor_label: string;
        actor_auth_user_id: string;
      }>(
        `select actor_profile_id, actor_label, actor_auth_user_id
           from public.audit_log order by id desc limit 1`,
      );

      // The caller cannot forge an actor: it is read from the session.
      expect(row.rows[0]?.actor_profile_id).toBe(profile.rows[0]?.id);
      expect(row.rows[0]?.actor_label).toBe('Grace Akello');
      expect(row.rows[0]?.actor_auth_user_id).toBe(authUserId);
    });
  });
});
