import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  asAnon,
  asServiceRole,
  asUser,
  asUserScript,
  createTestUser,
  deleteTestUsers,
  type TestUser,
} from '../helpers/auth-fixtures';
import { closePool, hasDatabase, query, queryOne, skipReason } from '../helpers/db';

/**
 * Client and guarantor Row Level Security, attacked directly.
 *
 * Every statement below runs as a real database role — `anon`, `authenticated`
 * or `service_role` — with a real JWT subject, exactly as a request arriving at
 * PostgREST would. Nothing goes through the application, so nothing the
 * application does can account for a pass here.
 *
 * The point is not to confirm that the interface hides things. It is to
 * confirm that someone holding a valid token and a copy of curl gets nothing
 * they should not have.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('client RLS suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

interface Fixtures {
  owner: TestUser;
  manager: TestUser;
  secretary: TestUser;
  /** A borrower linked to `linkedClientId`. */
  borrower: TestUser;
  /** A second borrower, linked to nothing. Used for cross-client attempts. */
  other: TestUser;
  linkedClientId: string;
  unlinkedClientId: string;
  guarantorId: string;
  linkId: string;
  remarkId: string;
}

/** Register a client as the table owner, bypassing policies deliberately. */
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

describeDb('client and guarantor row level security', () => {
  let f: Fixtures;

  beforeAll(async () => {
    await deleteTestUsers();

    const owner = await createTestUser('owner_admin');
    const manager = await createTestUser('manager');
    const secretary = await createTestUser('secretary_treasurer');
    const borrower = await createTestUser('client');
    const other = await createTestUser('client');

    const linkedClientId = await makeClient('Linked Borrower', '+256700061001');
    const unlinkedClientId = await makeClient('Unlinked Borrower', '+256700061002');

    // Linked through the sanctioned function, as the application does.
    await query(`select public.link_client_profile($1, $2)`, [
      linkedClientId,
      borrower.profileId,
    ]);

    await query(
      `insert into public.client_identities (client_id, nin)
       values ($1, 'CF90010000AAAA'), ($2, 'CF90010000BBBB')`,
      [linkedClientId, unlinkedClientId],
    );

    const guarantor = await queryOne<{ id: string }>(
      `insert into public.guarantors
         (full_name, sex, date_of_birth, phone, occupation, location)
       values ('Guarantor One', 'male', '1985-03-03', '+256700061003', 'Teacher', 'Bweyogerere')
       returning id`,
    );

    await query(
      `insert into public.guarantor_identities (guarantor_id, nin)
       values ($1, 'CM85030000CCCC')`,
      [guarantor.id],
    );

    const link = await queryOne<{ id: string }>(
      `insert into public.client_guarantors
         (client_id, guarantor_id, relationship_to_client)
       values ($1, $2, 'Brother') returning id`,
      [linkedClientId, guarantor.id],
    );

    const remark = await queryOne<{ id: string }>(
      `insert into public.client_remarks (client_id, body, category)
       values ($1, 'Payment was two weeks late in March.', 'payment_concern')
       returning id`,
      [linkedClientId],
    );

    f = {
      owner,
      manager,
      secretary,
      borrower,
      other,
      linkedClientId,
      unlinkedClientId,
      guarantorId: guarantor.id,
      linkId: link.id,
      remarkId: remark.id,
    };
  });

  afterAll(async () => {
    await deleteTestUsers();
    await closePool();
  });

  // =========================================================================
  describe('an anonymous visitor', () => {
    it.each([
      'clients',
      'client_identities',
      'guarantors',
      'guarantor_identities',
      'client_guarantors',
      'client_remarks',
    ])('reads nothing from %s', async (table) => {
      const result = await asAnon(`select * from public.${table}`);

      // Either refused outright or filtered to nothing. Both are closed; what
      // must never happen is a row coming back.
      expect(result.rows, table).toEqual([]);
    });

    it('writes nothing', async () => {
      const attempts = [
        `insert into public.clients (full_name, sex, date_of_birth, phone, occupation, village_area, district)
           values ('Anon Insert','female','1990-01-01','+256700061900','X','Y','Z')`,
        `update public.clients set full_name = 'Renamed'`,
        `delete from public.clients`,
        `insert into public.guarantors (full_name, sex, date_of_birth, phone, occupation, location)
           values ('Anon G','male','1990-01-01','+256700061901','X','Y')`,
        `insert into public.client_remarks (client_id, body) values (gen_random_uuid(), 'hello')`,
      ];

      for (const sql of attempts) {
        const result = await asAnon(sql);
        expect(result.ok, sql).toBe(false);
      }
    });
  });

  // =========================================================================
  describe('a borrower', () => {
    it('reads their own client record', async () => {
      const result = await asUser(
        f.borrower,
        `select id, client_number, full_name from public.clients`,
      );

      expect(result.ok).toBe(true);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.id).toBe(f.linkedClientId);
    });

    it('cannot read another client, even by naming its id', async () => {
      const result = await asUser(
        f.borrower,
        `select id from public.clients where id = $1`,
        [f.unlinkedClientId],
      );

      // Filtered rather than refused: the policy simply does not match, so the
      // borrower cannot even learn that the row exists.
      expect(result.rows).toEqual([]);
    });

    it('cannot read their own National Identification Number', async () => {
      // Deliberate: the policy on client_identities has no self-clause. The
      // borrower already knows their number, and a portal that never displays
      // one cannot leak one.
      const result = await asUser(
        f.borrower,
        `select nin from public.client_identities where client_id = $1`,
        [f.linkedClientId],
      );

      expect(result.rows).toEqual([]);
    });

    it('cannot read anybody else’s identification either', async () => {
      const result = await asUser(f.borrower, `select nin from public.client_identities`);
      expect(result.rows).toEqual([]);
    });

    it('cannot edit their own client record', async () => {
      const result = await asUser(
        f.borrower,
        `update public.clients set occupation = 'Something Else' where id = $1`,
        [f.linkedClientId],
      );

      // A borrower holds no client-editing capability, so the UPDATE policy
      // never opens the row. Corrections go through staff.
      expect(result.rowCount).toBe(0);

      const row = await queryOne<{ occupation: string }>(
        `select occupation from public.clients where id = $1`,
        [f.linkedClientId],
      );
      expect(row.occupation).toBe('Trader');
    });

    it('cannot change their own status', async () => {
      const result = await asUser(
        f.borrower,
        `update public.clients set status = 'active', status_reason = null where id = $1`,
        [f.linkedClientId],
      );

      expect(result.rowCount).toBe(0);
    });

    it('cannot change their own client number', async () => {
      const result = await asUser(
        f.borrower,
        `update public.clients set client_number = 'CL26999' where id = $1`,
        [f.linkedClientId],
      );

      expect(result.rowCount === 0 || !result.ok).toBe(true);

      const row = await queryOne<{ client_number: string }>(
        `select client_number from public.clients where id = $1`,
        [f.linkedClientId],
      );
      expect(row.client_number).toMatch(/^CL\d{5}$/);
    });

    it('cannot register a client', async () => {
      const result = await asUser(
        f.borrower,
        `insert into public.clients
           (full_name, sex, date_of_birth, phone, occupation, village_area, district)
         values ('Self Registered','female','1990-01-01','+256700061910','X','Y','Z')`,
      );

      expect(result.ok).toBe(false);
    });

    it('cannot delete a client — the privilege does not exist', async () => {
      const result = await asUser(
        f.borrower,
        `delete from public.clients where id = $1`,
        [f.linkedClientId],
      );

      expect(result.ok).toBe(false);
      expect(result.code, 'expected a privilege error, not a policy filter').toBe(
        '42501',
      );
    });

    it('reads no guarantors at all, including their own', async () => {
      const result = await asUser(f.borrower, `select * from public.guarantors`);

      // A guarantor's phone number and photograph are that person's data,
      // disclosed to the lender — not to the borrower who named them.
      expect(result.rows).toEqual([]);
    });

    it('reads no guarantor associations', async () => {
      const result = await asUser(f.borrower, `select * from public.client_guarantors`);
      expect(result.rows).toEqual([]);
    });

    it('reads no remarks written about them', async () => {
      const result = await asUser(f.borrower, `select body from public.client_remarks`);
      expect(result.rows).toEqual([]);
    });

    it('cannot write a remark about themselves', async () => {
      const result = await asUser(
        f.borrower,
        `insert into public.client_remarks (client_id, body) values ($1, 'I always pay on time')`,
        [f.linkedClientId],
      );

      expect(result.ok).toBe(false);
    });
  });

  // =========================================================================
  describe('a second borrower, linked to nothing', () => {
    it('reads no client rows whatsoever', async () => {
      const result = await asUser(f.other, `select id from public.clients`);

      // An unlinked login is the normal state for a client whose record staff
      // have not attached yet. It must not therefore see everything.
      expect(result.rows).toEqual([]);
    });

    it('cannot read the record belonging to the other borrower', async () => {
      const result = await asUser(
        f.other,
        `select full_name from public.clients where id = $1`,
        [f.linkedClientId],
      );

      expect(result.rows).toEqual([]);
    });
  });

  // =========================================================================
  describe('a secretary or treasurer', () => {
    it('reads the client directory', async () => {
      const result = await asUser(f.secretary, `select id from public.clients`);

      expect(result.ok).toBe(true);
      expect(result.rows.length).toBeGreaterThanOrEqual(2);
    });

    it('corrects ordinary details', async () => {
      const result = await asUser(
        f.secretary,
        `update public.clients set alternative_phone = '+256700062001' where id = $1`,
        [f.unlinkedClientId],
      );

      expect(result.ok).toBe(true);
      expect(result.rowCount).toBe(1);
    });

    it('reads NOT ONE National Identification Number', async () => {
      // The reason `client_identities` is a separate table. A Secretary reads
      // the directory all day; there is no query, view or export through which
      // they reach a NIN, because the number is not in the table they can read.
      const result = await asUser(
        f.secretary,
        `select nin from public.client_identities`,
      );

      expect(result.rows).toEqual([]);
    });

    it('cannot write an identification number either', async () => {
      const result = await asUser(
        f.secretary,
        `update public.client_identities set nin = 'CF90010000ZZZZ' where client_id = $1`,
        [f.unlinkedClientId],
      );

      expect(result.rowCount).toBe(0);
    });

    it('cannot change a client status', async () => {
      const result = await asUser(
        f.secretary,
        `update public.clients set status = 'inactive' where id = $1`,
        [f.unlinkedClientId],
      );

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/clients:status/);
    });

    it('cannot blacklist a client', async () => {
      const result = await asUser(
        f.secretary,
        `update public.clients set status = 'blacklisted', status_reason = 'no reason' where id = $1`,
        [f.unlinkedClientId],
      );

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/clients:blacklist/);
    });

    it('cannot register a client', async () => {
      const result = await asUser(
        f.secretary,
        `insert into public.clients
           (full_name, sex, date_of_birth, phone, occupation, village_area, district)
         values ('Secretary Made','female','1990-01-01','+256700062010','X','Y','Z')`,
      );

      expect(result.ok).toBe(false);
    });

    it('cannot change a client photograph', async () => {
      const result = await asUser(
        f.secretary,
        `update public.clients
            set photo_path = 'clients/' || $1::text || '/photo/forged.jpg'
          where id = $1`,
        [f.unlinkedClientId],
      );

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/clients:documents/);
    });

    it('reads remarks, but writes none', async () => {
      const read = await asUser(f.secretary, `select body from public.client_remarks`);
      expect(read.rows.length).toBeGreaterThanOrEqual(1);

      const write = await asUser(
        f.secretary,
        `insert into public.client_remarks (client_id, body) values ($1, 'Secretary note')`,
        [f.linkedClientId],
      );

      // A deliberate decision rather than an inheritance: a remark that will
      // later weigh on a lending decision should carry a Manager's name.
      expect(write.ok).toBe(false);
    });

    it('reads guarantors, but neither creates nor attaches one', async () => {
      const read = await asUser(f.secretary, `select id from public.guarantors`);
      expect(read.rows.length).toBeGreaterThanOrEqual(1);

      const create = await asUser(
        f.secretary,
        `insert into public.guarantors (full_name, sex, date_of_birth, phone, occupation, location)
         values ('Secretary G','male','1990-01-01','+256700062011','X','Y')`,
      );
      expect(create.ok).toBe(false);

      const link = await asUser(
        f.secretary,
        `insert into public.client_guarantors (client_id, guarantor_id, relationship_to_client)
         values ($1, $2, 'Friend')`,
        [f.unlinkedClientId, f.guarantorId],
      );
      expect(link.ok).toBe(false);
    });

    it('cannot detach a guarantor', async () => {
      const result = await asUserScript(f.secretary, [
        {
          sql: `update public.client_guarantors set active = false where id = $1`,
          params: [f.linkId],
        },
        {
          sql: `select active from public.client_guarantors where id = $1`,
          params: [f.linkId],
        },
      ]);

      // The UPDATE policy requires `guarantors:link`, which a Secretary does
      // not hold, so the row is filtered out rather than refused. Zero rows
      // changed is the closed outcome; the read confirms it inside the same
      // transaction, where a successful write would be visible.
      expect(result.rows[0]?.active).toBe(true);
    });

    it('reads no guarantor identification numbers', async () => {
      const result = await asUser(
        f.secretary,
        `select nin from public.guarantor_identities`,
      );
      expect(result.rows).toEqual([]);
    });
  });

  // =========================================================================
  describe('a manager', () => {
    it('registers a client, and the number is minted by the database', async () => {
      const result = await asUser(
        f.manager,
        `insert into public.clients
           (full_name, sex, date_of_birth, phone, occupation, village_area, district)
         values ('Manager Made','female','1990-01-01','+256700062100','Trader','A','B')
         returning client_number`,
      );

      expect(result.ok).toBe(true);
      expect(result.rows[0]?.client_number).toMatch(/^CL\d{5}$/);
    });

    it('cannot register a client already blacklisted', async () => {
      const result = await asUser(
        f.manager,
        `insert into public.clients
           (full_name, sex, date_of_birth, phone, occupation, village_area, district, status, status_reason)
         values ('Born Blacklisted','female','1990-01-01','+256700062101','X','Y','Z','blacklisted','arrived this way')`,
      );

      // Blacklisting is a decision made about an existing client, with a
      // reason and an Owner's name on it. Arriving pre-blacklisted would
      // bypass that entirely.
      expect(result.ok).toBe(false);
    });

    it('cannot register a client already linked to a login', async () => {
      const result = await asUser(
        f.manager,
        `insert into public.clients
           (full_name, sex, date_of_birth, phone, occupation, village_area, district, profile_id)
         values ('Born Linked','female','1990-01-01','+256700062102','X','Y','Z',$1)`,
        [f.other.profileId],
      );

      expect(result.ok).toBe(false);
    });

    it('reads and writes identification numbers', async () => {
      const read = await asUser(f.manager, `select nin from public.client_identities`);
      expect(read.rows.length).toBeGreaterThanOrEqual(2);

      const write = await asUser(
        f.manager,
        `update public.client_identities set nin = 'CF90010000DDDD' where client_id = $1`,
        [f.unlinkedClientId],
      );
      expect(write.ok).toBe(true);
      expect(write.rowCount).toBe(1);
    });

    it('suspends a client with a reason', async () => {
      const result = await asUser(
        f.manager,
        `update public.clients set status = 'suspended', status_reason = 'Phone unreachable for three weeks'
          where id = $1`,
        [f.unlinkedClientId],
      );

      expect(result.ok).toBe(true);
    });

    it('cannot blacklist a client', async () => {
      const result = await asUser(
        f.manager,
        `update public.clients set status = 'blacklisted', status_reason = 'defaulted'
          where id = $1`,
        [f.unlinkedClientId],
      );

      // Owner-only. A standing commercial judgement should carry an Owner's
      // name, not an operational one.
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/clients:blacklist/);
    });

    it('cannot archive a client', async () => {
      const result = await asUser(
        f.manager,
        `update public.clients set status = 'archived' where id = $1`,
        [f.unlinkedClientId],
      );

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/clients:archive/);
    });

    it('writes a remark, attributed to them by the database', async () => {
      const result = await asUser(
        f.manager,
        `insert into public.client_remarks (client_id, body, category)
         values ($1, 'Visited the stall; business is running.', 'business')
         returning created_by, created_by_label`,
        [f.linkedClientId],
      );

      expect(result.ok).toBe(true);
      expect(result.rows[0]?.created_by).toBe(f.manager.profileId);
      expect(result.rows[0]?.created_by_label).toBe(f.manager.fullName);
    });

    it('cannot attribute a remark to somebody else', async () => {
      const result = await asUser(
        f.manager,
        `insert into public.client_remarks (client_id, body, created_by, created_by_label)
         values ($1, 'Written by the owner, honestly', $2, 'Owner One')
         returning created_by, created_by_label`,
        [f.linkedClientId, f.owner.profileId],
      );

      // The trigger derives both from the session, overwriting whatever was
      // supplied. A remark attributed to somebody else is worse than none.
      expect(result.ok).toBe(true);
      expect(result.rows[0]?.created_by).toBe(f.manager.profileId);
      expect(result.rows[0]?.created_by_label).toBe(f.manager.fullName);
    });

    it('cannot edit or delete a remark', async () => {
      const update = await asUser(
        f.manager,
        `update public.client_remarks set body = 'Actually they were fine' where id = $1`,
        [f.remarkId],
      );
      expect(update.ok).toBe(false);

      const del = await asUser(
        f.manager,
        `delete from public.client_remarks where id = $1`,
        [f.remarkId],
      );
      expect(del.ok).toBe(false);
    });

    it('cannot link a client to a portal login', async () => {
      const direct = await asUser(
        f.manager,
        `update public.clients set profile_id = $2 where id = $1`,
        [f.unlinkedClientId, f.other.profileId],
      );
      expect(direct.ok).toBe(false);

      const viaFunction = await asUser(
        f.manager,
        `select public.link_client_profile($1, $2)`,
        [f.unlinkedClientId, f.other.profileId],
      );
      expect(viaFunction.ok).toBe(false);
      expect(viaFunction.code, 'expected a privilege error').toBe('42501');
    });
  });

  // =========================================================================
  describe('an owner or administrator', () => {
    it('blacklists a client, with a reason, and the attribution is stamped', async () => {
      const clientId = await makeClient('To Blacklist', '+256700062200');

      // One transaction, so the stamped attribution is observable. `asUser`
      // rolls back after each call, which would hide it.
      const result = await asUserScript(f.owner, [
        {
          sql: `update public.clients
                   set status = 'blacklisted',
                       status_reason = 'Defaulted on two loans and left the district'
                 where id = $1`,
          params: [clientId],
        },
        {
          sql: `select status, status_changed_by,
                       status_changed_at is not null as stamped
                  from public.clients where id = $1`,
          params: [clientId],
        },
      ]);

      expect(result.ok).toBe(true);
      expect(result.rows[0]?.status).toBe('blacklisted');
      // Derived from the session by the guard, never supplied by the caller.
      expect(result.rows[0]?.status_changed_by).toBe(f.owner.profileId);
      expect(result.rows[0]?.stamped).toBe(true);
    });

    it('cannot blacklist without a reason', async () => {
      const clientId = await makeClient('No Reason', '+256700062201');

      const result = await asUser(
        f.owner,
        `update public.clients set status = 'blacklisted' where id = $1`,
        [clientId],
      );

      expect(result.ok).toBe(false);
    });

    it('cannot forge the status attribution', async () => {
      const clientId = await makeClient('Forge Attribution', '+256700062202');

      const result = await asUser(
        f.owner,
        `update public.clients set status_changed_by = $2 where id = $1`,
        [clientId, f.manager.profileId],
      );

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/maintained by the database/i);
    });

    it('cannot delete a client — no role has that privilege', async () => {
      const result = await asUser(f.owner, `delete from public.clients where id = $1`, [
        f.unlinkedClientId,
      ]);

      expect(result.ok).toBe(false);
      expect(result.code).toBe('42501');
    });

    it('archives a client instead, which stamps archived_at', async () => {
      const clientId = await makeClient('To Archive', '+256700062203');

      const result = await asUserScript(f.owner, [
        {
          sql: `update public.clients set status = 'archived' where id = $1`,
          params: [clientId],
        },
        {
          sql: `select archived_at is not null as archived
                  from public.clients where id = $1`,
          params: [clientId],
        },
      ]);

      expect(result.ok).toBe(true);
      expect(result.rows[0]?.archived).toBe(true);
    });

    it('cannot rewrite a client’s provenance', async () => {
      const result = await asUser(
        f.owner,
        `update public.clients set created_by = $2 where id = $1`,
        [f.unlinkedClientId, f.manager.profileId],
      );

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/provenance/i);
    });
  });

  // =========================================================================
  describe('even the privileged client cannot forge a client number', () => {
    it('refuses a supplied number from service_role', async () => {
      const result = await asServiceRole(
        `insert into public.clients
           (client_number, full_name, sex, date_of_birth, phone, occupation, village_area, district)
         values ('CL26500','Privileged Forge','female','1990-01-01','+256700062300','X','Y','Z')`,
      );

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/assigned by the database/i);
    });

    it('refuses changing an issued number from service_role', async () => {
      const result = await asServiceRole(
        `update public.clients set client_number = 'CL26501' where id = $1`,
        [f.linkedClientId],
      );

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/cannot be changed once issued/i);
    });

    it('refuses a direct profile_id write from service_role', async () => {
      const result = await asServiceRole(
        `update public.clients set profile_id = $2 where id = $1`,
        [f.unlinkedClientId, f.other.profileId],
      );

      // The rule sits above the trusted-path exemption, so a leaked secret key
      // still cannot repoint a client at an arbitrary login by a plain UPDATE.
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/linking function/i);
    });

    it('refuses editing a remark from service_role', async () => {
      const result = await asServiceRole(
        `update public.client_remarks set body = 'rewritten' where id = $1`,
        [f.remarkId],
      );

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/append-only/i);
    });
  });
});
