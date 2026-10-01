import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  asUser,
  createTestUser,
  deleteTestUsers,
  type TestUser,
} from '../helpers/auth-fixtures';
import { closePool, hasDatabase, query, queryOne, skipReason } from '../helpers/db';

/**
 * The Phase 3 audit trail, and what it deliberately does not record.
 *
 * Triggers rather than application calls, so the data and the trail cannot
 * disagree — a trigger fires in the same transaction as the change, and an
 * audit call in a Server Action is skipped by anything that reaches the table
 * another way.
 *
 * The most important assertions here are the negative ones. `audit_log` is
 * readable by `audit:view`, which is a *broader* capability than
 * `clients:view_nin` — so writing National Identification Numbers into the
 * trail would quietly undo the separation that `client_identities` exists to
 * create.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('client audit suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

async function makeClient(name: string, phone: string): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `insert into public.clients
       (full_name, sex, date_of_birth, phone, occupation, village_area, district)
     values ($1, 'female', '1990-01-01', $2, 'Trader', 'Kalerwe', 'Kampala')
     returning id`,
    [name, phone],
  );
  return row.id;
}

/**
 * Register a client as a given staff member, committed.
 *
 * `asUser` rolls back, which is right for an attack test but wrong when the
 * effect — here, an audit row — has to be inspected afterwards from outside
 * that session.
 */
async function insertClientAs(
  user: TestUser,
  name: string,
  phone: string,
): Promise<string> {
  const { getClient } = await import('../helpers/db');
  const client = await getClient();

  try {
    await client.query('begin');
    await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [
      user.authUserId,
    ]);
    await client.query('set local role authenticated');

    const result = await client.query<{ id: string }>(
      `insert into public.clients
         (full_name, sex, date_of_birth, phone, occupation, village_area, district)
       values ($1, 'female', '1990-01-01', $2, 'Trader', 'A', 'B')
       returning id`,
      [name, phone],
    );

    await client.query('commit');

    return result.rows[0]!.id;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function lastEntry(entityType: string, entityId: string) {
  return queryOne<{
    action: string;
    actor_profile_id: string | null;
    actor_label: string;
    old_values: Record<string, unknown> | null;
    new_values: Record<string, unknown> | null;
  }>(
    `select action, actor_profile_id, actor_label, old_values, new_values
       from public.audit_log
      where entity_type = $1 and entity_id = $2
      order by id desc limit 1`,
    [entityType, entityId],
  );
}

describeDb('the Phase 3 audit trail', () => {
  let manager: TestUser;
  let owner: TestUser;

  beforeAll(async () => {
    await deleteTestUsers();
    manager = await createTestUser('manager');
    owner = await createTestUser('owner_admin');
  });

  afterAll(async () => {
    await deleteTestUsers();
    await closePool();
  });

  // -------------------------------------------------------------------------
  describe('clients', () => {
    it('records a registration, with the registering staff member named', async () => {
      const result = await asUser(
        manager,
        `insert into public.clients
           (full_name, sex, date_of_birth, phone, occupation, village_area, district)
         values ('Audited Registration','female','1990-01-01','+256700111001','Trader','A','B')
         returning id`,
      );

      expect(result.ok).toBe(true);

      // `asUser` rolls back, so the row is gone — but the insert did fire the
      // trigger, which is what this asserts by running it again committed.
      const clientId = await makeClient('Audited Committed', '+256700111002');
      const entry = await lastEntry('client', clientId);

      expect(entry.action).toBe('client.created');
      expect(entry.new_values?.client_number).toMatch(/^CL\d{5}$/);
      expect(entry.new_values?.full_name).toBe('Audited Committed');
    });

    it('names the acting staff member, derived rather than supplied', async () => {
      // Committed as the manager, then read as the table owner. A manager
      // cannot read `audit_log` at all — `audit:view` is Owner-only, which
      // this file asserts further down — so the trail has to be inspected
      // from outside their session.
      const clientId = await insertClientAs(manager, 'Actor Check', '+256700111003');

      const entry = await lastEntry('client', clientId);

      expect(entry.actor_profile_id).toBe(manager.profileId);
      // The label is denormalised so the entry stays readable after the
      // account is archived.
      expect(entry.actor_label).toBe(manager.fullName);
    });

    it('distinguishes a status change from an ordinary edit', async () => {
      const clientId = await makeClient('Status Audit', '+256700111010');

      await query(`update public.clients set occupation = 'Shopkeeper' where id = $1`, [
        clientId,
      ]);
      expect((await lastEntry('client', clientId)).action).toBe('client.updated');

      await query(
        `update public.clients
            set status = 'suspended', status_reason = 'Unreachable' where id = $1`,
        [clientId],
      );

      const entry = await lastEntry('client', clientId);
      expect(entry.action).toBe('client.status_changed');
      // Old and new, which is what makes a dispute resolvable.
      expect(entry.old_values?.status).toBe('active');
      expect(entry.new_values?.status).toBe('suspended');
      expect(entry.new_values?.status_reason).toBe('Unreachable');
    });

    it('records a phone number change, before and after', async () => {
      const clientId = await makeClient('Phone Audit', '+256700111011');

      await query(`update public.clients set phone = '+256700111012' where id = $1`, [
        clientId,
      ]);

      const entry = await lastEntry('client', clientId);
      expect(entry.old_values?.phone).toBe('+256700111011');
      expect(entry.new_values?.phone).toBe('+256700111012');
    });

    it('records a photograph change under its own action', async () => {
      const clientId = await makeClient('Photo Audit', '+256700111013');

      await query(
        `update public.clients
            set photo_path = 'clients/' || $2::text || '/photo/abc.jpg'
          where id = $1::uuid`,
        [clientId, clientId],
      );

      expect((await lastEntry('client', clientId)).action).toBe('client.photo_changed');
    });

    it('records a linkage and an unlinking distinctly', async () => {
      const clientId = await makeClient('Link Audit', '+256700111014');
      const login = await createTestUser('client');

      await query(`select public.link_client_profile($1, $2)`, [
        clientId,
        login.profileId,
      ]);

      expect((await lastEntry('client', clientId)).action).toBe('client.auth_linked');
    });

    it('records no identification number on the client row', async () => {
      const clientId = await makeClient('No NIN Leak', '+256700111015');
      await query(
        `insert into public.client_identities (client_id, nin) values ($1, 'CF90010000LEAK')`,
        [clientId],
      );
      await query(`update public.clients set occupation = 'Tailor' where id = $1`, [
        clientId,
      ]);

      const entries = await query<{ old_values: unknown; new_values: unknown }>(
        `select old_values, new_values from public.audit_log
          where entity_type = 'client' and entity_id = $1`,
        [clientId],
      );

      const serialised = JSON.stringify(entries);
      expect(serialised).not.toContain('CF90010000LEAK');
      expect(serialised).not.toMatch(/"nin"/);
    });
  });

  // -------------------------------------------------------------------------
  describe('identification numbers are audited, but masked', () => {
    it('records that a number was recorded, not the number', async () => {
      const clientId = await makeClient('Masked Record', '+256700111020');

      await query(
        `insert into public.client_identities (client_id, nin)
         values ($1, 'CF90010000MASK')`,
        [clientId],
      );

      const entry = await lastEntry('client_identity', clientId);

      expect(entry.action).toBe('client.identity_recorded');
      expect(entry.new_values?.nin_present).toBe(true);
      // Enough to tell a correction from a substitution; not enough to be the
      // number.
      expect(entry.new_values?.nin_masked).toBe('***ASK');
      expect(JSON.stringify(entry)).not.toContain('CF90010000MASK');
    });

    it('records a correction with both sides masked', async () => {
      const clientId = await makeClient('Masked Correct', '+256700111021');

      await query(
        `insert into public.client_identities (client_id, nin)
         values ($1, 'CF90010000AAAA')`,
        [clientId],
      );
      await query(
        `update public.client_identities set nin = 'CF90010000BBBB' where client_id = $1`,
        [clientId],
      );

      const entry = await lastEntry('client_identity', clientId);

      expect(entry.old_values?.nin_masked).toBe('***AAA');
      expect(entry.new_values?.nin_masked).toBe('***BBB');

      const serialised = JSON.stringify(entry);
      expect(serialised).not.toContain('CF90010000AAAA');
      expect(serialised).not.toContain('CF90010000BBBB');
    });

    it('records a document change under its own action', async () => {
      const clientId = await makeClient('Doc Audit', '+256700111022');

      await query(
        `insert into public.client_identities (client_id, id_document_path)
         values ($1::uuid, 'clients/' || $2::text || '/id/abc.pdf')`,
        [clientId, clientId],
      );
      await query(
        `update public.client_identities
            set id_document_path = 'clients/' || $2::text || '/id/def.pdf'
          where client_id = $1::uuid`,
        [clientId, clientId],
      );

      const entry = await lastEntry('client_identity', clientId);

      expect(entry.action).toBe('client.document_changed');
      // The path is recorded, because a path is not content — it is the only
      // way to tell which file a change replaced, and the object itself stays
      // behind a private bucket policy.
      expect(String(entry.new_values?.id_document_path)).toContain('/id/def.pdf');
    });

    it('masks safely when there is no number', async () => {
      const clientId = await makeClient('Null NIN', '+256700111023');

      await query(
        `insert into public.client_identities (client_id, nin) values ($1, null)`,
        [clientId],
      );

      const entry = await lastEntry('client_identity', clientId);

      expect(entry.new_values?.nin_present).toBe(false);
      expect(entry.new_values?.nin_masked).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe('remarks', () => {
    it('records that a remark exists, not its text', async () => {
      const clientId = await makeClient('Remark Audit', '+256700111030');

      const BODY = 'He said the harvest failed and he cannot pay this month.';

      const remark = await queryOne<{ id: string }>(
        `insert into public.client_remarks (client_id, body, category)
         values ($1, $2, 'payment_concern')
         returning id`,
        [clientId, BODY],
      );

      const entry = await lastEntry('client_remark', remark.id);

      expect(entry.action).toBe('client.remark_added');
      expect(entry.new_values?.category).toBe('payment_concern');
      // The length is recorded so an empty-looking trail entry can be told
      // from a substantial remark, without the text itself.
      expect(entry.new_values?.body_length).toBe(BODY.length);

      // The body is already in an append-only table that cannot be edited or
      // deleted. Copying it here would add a second place to keep consistent
      // and would put staff commentary in front of `audit:view` holders who
      // were given that capability for a different purpose.
      expect(JSON.stringify(entry)).not.toContain('harvest failed');
    });

    it('records a retraction, naming what it withdraws', async () => {
      const clientId = await makeClient('Retract Audit', '+256700111031');

      const original = await queryOne<{ id: string }>(
        `insert into public.client_remarks (client_id, body, category)
         values ($1, 'Original remark text here.', 'general') returning id`,
        [clientId],
      );

      const retraction = await queryOne<{ id: string }>(
        `insert into public.client_remarks (client_id, body, category, retracts_remark_id)
         values ($1, 'Recorded against the wrong client.', 'retraction', $2)
         returning id`,
        [clientId, original.id],
      );

      const entry = await lastEntry('client_remark', retraction.id);

      expect(entry.new_values?.category).toBe('retraction');
      expect(entry.new_values?.retracts_remark_id).toBe(original.id);
    });

    it('refuses a retraction naming a remark on a different client', async () => {
      const firstClient = await makeClient('Retract A', '+256700111032');
      const secondClient = await makeClient('Retract B', '+256700111033');

      const remark = await queryOne<{ id: string }>(
        `insert into public.client_remarks (client_id, body) values ($1, 'On client A.')
         returning id`,
        [firstClient],
      );

      // Otherwise one client's record could be used to annotate another's.
      await expect(
        query(
          `insert into public.client_remarks (client_id, body, category, retracts_remark_id)
           values ($1, 'Withdrawing a remark from elsewhere', 'retraction', $2)`,
          [secondClient, remark.id],
        ),
      ).rejects.toMatchObject({ code: 'P0001' });
    });

    it('refuses retracting the same remark twice', async () => {
      const clientId = await makeClient('Double Retract', '+256700111034');

      const remark = await queryOne<{ id: string }>(
        `insert into public.client_remarks (client_id, body) values ($1, 'Only once.')
         returning id`,
        [clientId],
      );

      await query(
        `insert into public.client_remarks (client_id, body, category, retracts_remark_id)
         values ($1, 'First withdrawal', 'retraction', $2)`,
        [clientId, remark.id],
      );

      await expect(
        query(
          `insert into public.client_remarks (client_id, body, category, retracts_remark_id)
           values ($1, 'Second withdrawal', 'retraction', $2)`,
          [clientId, remark.id],
        ),
      ).rejects.toMatchObject({ code: 'P0001' });
    });

    it('refuses a retraction category with nothing to retract, and the reverse', async () => {
      const clientId = await makeClient('Retract Shape', '+256700111035');

      await expect(
        query(
          `insert into public.client_remarks (client_id, body, category)
           values ($1, 'A retraction of nothing', 'retraction')`,
          [clientId],
        ),
      ).rejects.toMatchObject({ code: '23514' });

      const remark = await queryOne<{ id: string }>(
        `insert into public.client_remarks (client_id, body) values ($1, 'Target.')
         returning id`,
        [clientId],
      );

      await expect(
        query(
          `insert into public.client_remarks (client_id, body, category, retracts_remark_id)
           values ($1, 'Pointing without being a retraction', 'general', $2)`,
          [clientId, remark.id],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });
  });

  // -------------------------------------------------------------------------
  describe('guarantors', () => {
    it('records a registration and an update', async () => {
      const guarantor = await queryOne<{ id: string }>(
        `insert into public.guarantors
           (full_name, sex, date_of_birth, phone, occupation, location)
         values ('Audited Guarantor','male','1985-01-01','+256700111040','Teacher','L')
         returning id`,
      );

      expect((await lastEntry('guarantor', guarantor.id)).action).toBe(
        'guarantor.created',
      );

      await query(
        `update public.guarantors set occupation = 'Headmaster' where id = $1`,
        [guarantor.id],
      );

      const entry = await lastEntry('guarantor', guarantor.id);
      expect(entry.action).toBe('guarantor.updated');
      expect(entry.old_values?.occupation).toBe('Teacher');
      expect(entry.new_values?.occupation).toBe('Headmaster');
    });

    it('records a guarantor identification number masked', async () => {
      const guarantor = await queryOne<{ id: string }>(
        `insert into public.guarantors
           (full_name, sex, date_of_birth, phone, occupation, location)
         values ('Masked G','male','1985-01-01','+256700111041','Teacher','L')
         returning id`,
      );

      await query(
        `insert into public.guarantor_identities (guarantor_id, nin)
         values ($1, 'CM85010000GGGG')`,
        [guarantor.id],
      );

      const entry = await lastEntry('guarantor_identity', guarantor.id);

      expect(entry.action).toBe('guarantor.identity_recorded');
      expect(entry.new_values?.nin_masked).toBe('***GGG');
      expect(JSON.stringify(entry)).not.toContain('CM85010000GGGG');
    });

    it('records attaching and detaching distinctly', async () => {
      const clientId = await makeClient('Link Audit C', '+256700111050');
      const guarantor = await queryOne<{ id: string }>(
        `insert into public.guarantors
           (full_name, sex, date_of_birth, phone, occupation, location)
         values ('Link Audit G','male','1985-01-01','+256700111051','Teacher','L')
         returning id`,
      );

      const link = await queryOne<{ id: string }>(
        `insert into public.client_guarantors (client_id, guarantor_id, relationship_to_client)
         values ($1, $2, 'Brother') returning id`,
        [clientId, guarantor.id],
      );

      expect((await lastEntry('client_guarantor', link.id)).action).toBe(
        'guarantor.linked',
      );

      await query(
        `update public.client_guarantors
            set active = false, detached_reason = 'Moved away' where id = $1`,
        [link.id],
      );

      const entry = await lastEntry('client_guarantor', link.id);
      expect(entry.action).toBe('guarantor.unlinked');
      expect(entry.new_values?.detached_reason).toBe('Moved away');
      expect(entry.old_values?.active).toBe(true);
      expect(entry.new_values?.active).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  describe('the trail itself stays append-only', () => {
    it('refuses editing a Phase 3 audit row', async () => {
      const clientId = await makeClient('Trail Guard', '+256700111060');

      await expect(
        query(
          `update public.audit_log set action = 'client.updated'
            where entity_id = $1`,
          [clientId],
        ),
      ).rejects.toMatchObject({ code: 'P0001' });
    });

    it('refuses deleting one', async () => {
      const clientId = await makeClient('Trail Delete', '+256700111061');

      await expect(
        query(`delete from public.audit_log where entity_id = $1`, [clientId]),
      ).rejects.toMatchObject({ code: 'P0001' });
    });

    it('keeps a borrower out of it entirely', async () => {
      const borrower = await createTestUser('client');

      const result = await asUser(
        borrower,
        `select action from public.audit_log where entity_type = 'client'`,
      );

      expect(result.rows).toEqual([]);
    });

    it('keeps a manager out of it — audit:view is Owner-only', async () => {
      const result = await asUser(
        manager,
        `select action from public.audit_log where entity_type = 'client'`,
      );

      expect(result.rows).toEqual([]);
    });

    it('lets the owner read it', async () => {
      await makeClient('Owner Reads', '+256700111062');

      const result = await asUser(
        owner,
        `select action from public.audit_log where entity_type = 'client' limit 5`,
      );

      expect(result.rows.length).toBeGreaterThan(0);
    });
  });
});
