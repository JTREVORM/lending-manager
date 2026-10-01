import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestUser, deleteTestUsers } from '../helpers/auth-fixtures';
import {
  closePool,
  getClient,
  hasDatabase,
  query,
  queryOne,
  skipReason,
} from '../helpers/db';

/**
 * Phase 3 under genuine concurrency.
 *
 * Two staff members at a counter really do register clients at the same
 * moment, and the failure modes are the expensive kind: two clients holding
 * the same number, or one guarantor attached twice so a Phase 4 loan has two
 * conflicting records of who vouched for it.
 *
 * Every test here opens real parallel connections. Nothing is simulated —
 * there is no way to test a race by calling a function twice in sequence.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('client concurrency suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

describeDb('client operations under concurrency', () => {
  beforeAll(async () => {
    await deleteTestUsers();
  });

  afterAll(async () => {
    await deleteTestUsers();
    await closePool();
  });

  // -------------------------------------------------------------------------
  describe('client numbering', () => {
    it('issues 40 distinct, gapless numbers to 40 parallel registrations', async () => {
      const COUNT = 40;

      const results = await Promise.all(
        Array.from({ length: COUNT }, (_, index) =>
          queryOne<{ client_number: string }>(
            `insert into public.clients
               (full_name, sex, date_of_birth, phone, occupation, village_area, district)
             values ($1, 'female', '1990-01-01', $2, 'Trader', 'A', 'B')
             returning client_number`,
            [`Parallel ${String(index)}`, `+2567000911${String(index).padStart(2, '0')}`],
          ),
        ),
      );

      const numbers = results.map((row) => row.client_number);

      // Distinct: the whole point of the atomic generator.
      expect(new Set(numbers).size).toBe(COUNT);

      // Every one well-formed.
      for (const number of numbers) {
        expect(number).toMatch(/^CL\d{5}$/);
      }

      // Gapless: the sequence values form a contiguous run, so nothing was
      // skipped or double-counted under contention.
      const sequences = numbers
        .map((number) => Number.parseInt(number.slice(-3), 10))
        .sort((a, b) => a - b);

      for (let index = 1; index < sequences.length; index += 1) {
        expect(sequences[index]! - sequences[index - 1]!).toBe(1);
      }
    });

    it('uses the configured prefix and the registration year', async () => {
      const row = await queryOne<{ client_number: string }>(
        `insert into public.clients
           (full_name, sex, date_of_birth, phone, occupation, village_area, district)
         values ('Year Check','male','1990-01-01','+256700091200','Trader','A','B')
         returning client_number`,
      );

      const format = await queryOne<{ prefix: string; padding: number }>(
        `select prefix, padding from public.reference_formats where scope = 'client'`,
      );

      const year = await queryOne<{ yy: string }>(
        `select to_char((now() at time zone 'Africa/Kampala'), 'YY') as yy`,
      );

      expect(row.client_number.startsWith(format.prefix)).toBe(true);
      expect(row.client_number.slice(2, 4)).toBe(year.yy);
      // Prefix + two year digits + padded sequence.
      expect(row.client_number).toHaveLength(2 + 2 + format.padding);
    });
  });

  // -------------------------------------------------------------------------
  describe('duplicate identification numbers', () => {
    it('lets exactly one of two parallel inserts win', async () => {
      const first = await queryOne<{ id: string }>(
        `insert into public.clients
           (full_name, sex, date_of_birth, phone, occupation, village_area, district)
         values ('NIN Race A','female','1990-01-01','+256700091300','T','A','B')
         returning id`,
      );
      const second = await queryOne<{ id: string }>(
        `insert into public.clients
           (full_name, sex, date_of_birth, phone, occupation, village_area, district)
         values ('NIN Race B','female','1990-01-01','+256700091301','T','A','B')
         returning id`,
      );

      const NIN = 'CF90010000RACE';

      const outcomes = await Promise.allSettled([
        query(`insert into public.client_identities (client_id, nin) values ($1, $2)`, [
          first.id,
          NIN,
        ]),
        query(`insert into public.client_identities (client_id, nin) values ($1, $2)`, [
          second.id,
          NIN,
        ]),
      ]);

      const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
      const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');

      // One NIN identifies one person, so two client records sharing one is a
      // duplicate or a transcription error — never a legitimate pair.
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const row = await queryOne<{ count: string }>(
        `select count(*)::text as count from public.client_identities where nin = $1`,
        [NIN],
      );
      expect(row.count).toBe('1');
    });

    it('permits many clients with no number recorded', async () => {
      // The uniqueness is partial, so a NULL does not collide with another
      // NULL. A client registered before their card is present still gets a
      // record, and so does the next one.
      const clientIds = await Promise.all(
        Array.from({ length: 5 }, (_, index) =>
          queryOne<{ id: string }>(
            `insert into public.clients
               (full_name, sex, date_of_birth, phone, occupation, village_area, district)
             values ($1, 'male', '1990-01-01', $2, 'T', 'A', 'B')
             returning id`,
            [`No NIN ${String(index)}`, `+2567000914${String(index).padStart(2, '0')}`],
          ),
        ),
      );

      const inserts = await Promise.allSettled(
        clientIds.map((client) =>
          query(
            `insert into public.client_identities (client_id, nin) values ($1, null)`,
            [client.id],
          ),
        ),
      );

      expect(inserts.every((outcome) => outcome.status === 'fulfilled')).toBe(true);

      const row = await queryOne<{ count: string }>(
        `select count(*)::text as count from public.client_identities
          where nin is null and client_id = any($1::uuid[])`,
        [clientIds.map((client) => client.id)],
      );
      expect(row.count).toBe('5');
    });
  });

  // -------------------------------------------------------------------------
  describe('guarantor associations', () => {
    it('lets exactly one of two parallel attachments of the same pair win', async () => {
      const client = await queryOne<{ id: string }>(
        `insert into public.clients
           (full_name, sex, date_of_birth, phone, occupation, village_area, district)
         values ('Link Race','female','1990-01-01','+256700091500','T','A','B')
         returning id`,
      );
      const guarantor = await queryOne<{ id: string }>(
        `insert into public.guarantors
           (full_name, sex, date_of_birth, phone, occupation, location)
         values ('Race Guarantor','male','1985-01-01','+256700091501','T','L')
         returning id`,
      );

      const outcomes = await Promise.allSettled([
        query(
          `insert into public.client_guarantors (client_id, guarantor_id, relationship_to_client)
           values ($1, $2, 'Brother')`,
          [client.id, guarantor.id],
        ),
        query(
          `insert into public.client_guarantors (client_id, guarantor_id, relationship_to_client)
           values ($1, $2, 'Cousin')`,
          [client.id, guarantor.id],
        ),
      ]);

      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(
        1,
      );

      const row = await queryOne<{ count: string }>(
        `select count(*)::text as count from public.client_guarantors
          where client_id = $1 and guarantor_id = $2 and active`,
        [client.id, guarantor.id],
      );
      expect(row.count).toBe('1');
    });

    it('allows re-attaching after a detachment, which the partial index permits', async () => {
      const client = await queryOne<{ id: string }>(
        `insert into public.clients
           (full_name, sex, date_of_birth, phone, occupation, village_area, district)
         values ('Reattach','female','1990-01-01','+256700091600','T','A','B')
         returning id`,
      );
      const guarantor = await queryOne<{ id: string }>(
        `insert into public.guarantors
           (full_name, sex, date_of_birth, phone, occupation, location)
         values ('Reattach G','male','1985-01-01','+256700091601','T','L')
         returning id`,
      );

      const link = await queryOne<{ id: string }>(
        `insert into public.client_guarantors (client_id, guarantor_id, relationship_to_client)
         values ($1, $2, 'Neighbour') returning id`,
        [client.id, guarantor.id],
      );

      await query(`update public.client_guarantors set active = false where id = $1`, [
        link.id,
      ]);

      // The index is partial on `active`, so the history does not block a new
      // association — a client and a guarantor may have a past.
      await expect(
        query(
          `insert into public.client_guarantors (client_id, guarantor_id, relationship_to_client)
           values ($1, $2, 'Neighbour again')`,
          [client.id, guarantor.id],
        ),
      ).resolves.toBeDefined();

      const rows = await query<{ active: boolean }>(
        `select active from public.client_guarantors
          where client_id = $1 and guarantor_id = $2 order by created_at`,
        [client.id, guarantor.id],
      );
      expect(rows).toHaveLength(2);
    });

    it('refuses reviving a detached association', async () => {
      const client = await queryOne<{ id: string }>(
        `insert into public.clients
           (full_name, sex, date_of_birth, phone, occupation, village_area, district)
         values ('No Revive','female','1990-01-01','+256700091700','T','A','B')
         returning id`,
      );
      const guarantor = await queryOne<{ id: string }>(
        `insert into public.guarantors
           (full_name, sex, date_of_birth, phone, occupation, location)
         values ('No Revive G','male','1985-01-01','+256700091701','T','L')
         returning id`,
      );
      const link = await queryOne<{ id: string }>(
        `insert into public.client_guarantors (client_id, guarantor_id, relationship_to_client)
         values ($1, $2, 'Friend') returning id`,
        [client.id, guarantor.id],
      );

      await query(`update public.client_guarantors set active = false where id = $1`, [
        link.id,
      ]);

      // Reviving would make the history unreadable: a Phase 4 loan issued
      // against this association needs to be explicable afterwards.
      await expect(
        query(`update public.client_guarantors set active = true where id = $1`, [
          link.id,
        ]),
      ).rejects.toMatchObject({ code: 'P0001' });
    });
  });

  // -------------------------------------------------------------------------
  describe('linking a login under contention', () => {
    it('lets exactly one of two parallel links to the same profile succeed', async () => {
      const login = await createTestUser('client');

      const first = await queryOne<{ id: string }>(
        `insert into public.clients
           (full_name, sex, date_of_birth, phone, occupation, village_area, district)
         values ('Contend A','female','1990-01-01','+256700091800','T','A','B')
         returning id`,
      );
      const second = await queryOne<{ id: string }>(
        `insert into public.clients
           (full_name, sex, date_of_birth, phone, occupation, village_area, district)
         values ('Contend B','female','1990-01-01','+256700091801','T','A','B')
         returning id`,
      );

      // Two real connections, each committing. Without the advisory lock
      // inside link_client_profile, both could read "profile unused" and both
      // proceed — and one login would then read two clients' records.
      const outcomes = await Promise.allSettled([
        runCommitted(`select public.link_client_profile($1, $2)`, [
          first.id,
          login.profileId,
        ]),
        runCommitted(`select public.link_client_profile($1, $2)`, [
          second.id,
          login.profileId,
        ]),
      ]);

      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(
        1,
      );

      const row = await queryOne<{ count: string }>(
        `select count(*)::text as count from public.clients where profile_id = $1`,
        [login.profileId],
      );
      expect(row.count).toBe('1');
    });

    it('lets exactly one of two parallel links to the same client succeed', async () => {
      const firstLogin = await createTestUser('client');
      const secondLogin = await createTestUser('client');

      const client = await queryOne<{ id: string }>(
        `insert into public.clients
           (full_name, sex, date_of_birth, phone, occupation, village_area, district)
         values ('One Client','female','1990-01-01','+256700091900','T','A','B')
         returning id`,
      );

      const outcomes = await Promise.allSettled([
        runCommitted(`select public.link_client_profile($1, $2)`, [
          client.id,
          firstLogin.profileId,
        ]),
        runCommitted(`select public.link_client_profile($1, $2)`, [
          client.id,
          secondLogin.profileId,
        ]),
      ]);

      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(
        1,
      );
    });
  });
});

/**
 * Run a statement on its own connection and commit it.
 *
 * `query` uses the shared pool and autocommits, which is enough for most
 * tests. A race needs two connections holding transactions open at the same
 * time, which is what this provides.
 */
async function runCommitted(sql: string, params: readonly unknown[]): Promise<void> {
  const client = await getClient();

  try {
    await client.query('begin');
    await client.query(sql, [...params]);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
