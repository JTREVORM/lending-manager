import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  asAnon,
  asUser,
  createTestUser,
  deleteTestUsers,
  type TestUser,
} from '../helpers/auth-fixtures';
import { closePool, hasDatabase, query, queryOne, skipReason } from '../helpers/db';

/**
 * Storage policies for client and guarantor documents.
 *
 * A photograph of someone's national ID card is among the most sensitive
 * things this system holds, and storage is the one place where the usual
 * protection — "the row is invisible" — does not apply, because an object is
 * reached by a path rather than by a query.
 *
 * So the path layout *is* the authorization model, and these tests attack it
 * the way an attacker would: by guessing paths. Every statement runs against
 * `storage.objects` as a real database role.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('client storage suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

/** Insert an object as the table owner, bypassing policies deliberately. */
async function putObject(bucket: string, name: string): Promise<void> {
  await query(
    `insert into storage.objects (bucket_id, name) values ($1, $2)
     on conflict (bucket_id, name) do nothing`,
    [bucket, name],
  );
}

describeDb('client and guarantor document storage', () => {
  let manager: TestUser;
  let secretary: TestUser;
  let borrower: TestUser;
  let clientId: string;
  let guarantorId: string;
  let photoPath: string;
  let idPath: string;
  let guarantorPhotoPath: string;

  beforeAll(async () => {
    await deleteTestUsers();
    manager = await createTestUser('manager');
    secretary = await createTestUser('secretary_treasurer');
    borrower = await createTestUser('client');

    const client = await queryOne<{ id: string }>(
      `insert into public.clients
         (full_name, sex, date_of_birth, phone, occupation, village_area, district)
       values ('Storage Client','female','1990-01-01','+256700101001','T','A','B')
       returning id`,
    );
    clientId = client.id;

    await query(`select public.link_client_profile($1, $2)`, [
      clientId,
      borrower.profileId,
    ]);

    const guarantor = await queryOne<{ id: string }>(
      `insert into public.guarantors
         (full_name, sex, date_of_birth, phone, occupation, location)
       values ('Storage Guarantor','male','1985-01-01','+256700101002','T','L')
       returning id`,
    );
    guarantorId = guarantor.id;

    photoPath = `clients/${clientId}/photo/abc123.jpg`;
    idPath = `clients/${clientId}/id/def456.pdf`;
    guarantorPhotoPath = `guarantors/${guarantorId}/photo/ghi789.jpg`;

    await putObject('client-documents', photoPath);
    await putObject('client-documents', idPath);
    await putObject('guarantor-documents', guarantorPhotoPath);
  });

  afterAll(async () => {
    await query(`delete from storage.objects where bucket_id like '%-documents'`);
    await deleteTestUsers();
    await closePool();
  });

  // -------------------------------------------------------------------------
  describe('the buckets are private', () => {
    it.each(['client-documents', 'guarantor-documents', 'company-assets'])(
      '%s is not public',
      async (bucket) => {
        const row = await queryOne<{ public: boolean }>(
          `select public from storage.buckets where id = $1`,
          [bucket],
        );

        // A public bucket serves every object over an unauthenticated URL and
        // no policy below would ever be consulted. This is the single setting
        // that would undo the whole model.
        expect(row.public, bucket).toBe(false);
      },
    );

    it('limits the accepted content types at the bucket', async () => {
      const row = await queryOne<{ allowed_mime_types: string[] | null }>(
        `select allowed_mime_types from storage.buckets where id = 'client-documents'`,
      );

      expect(row.allowed_mime_types).not.toBeNull();
      // SVG is absent deliberately: it is a document that can carry script,
      // so a stored SVG served from this origin would be a scripting vector
      // dressed as a picture.
      expect(row.allowed_mime_types).not.toContain('image/svg+xml');
      expect(row.allowed_mime_types).toContain('image/jpeg');
    });

    it('limits the file size at the bucket', async () => {
      const row = await queryOne<{ file_size_limit: string | null }>(
        `select file_size_limit::text as file_size_limit
           from storage.buckets where id = 'client-documents'`,
      );

      expect(row.file_size_limit).not.toBeNull();
      expect(Number(row.file_size_limit)).toBeLessThanOrEqual(10 * 1024 * 1024);
    });
  });

  // -------------------------------------------------------------------------
  describe('an anonymous visitor', () => {
    it('reads no object in either bucket', async () => {
      const result = await asAnon(
        `select name from storage.objects where bucket_id like '%-documents'`,
      );

      expect(result.rows).toEqual([]);
    });

    it('cannot upload', async () => {
      const result = await asAnon(
        `insert into storage.objects (bucket_id, name)
         values ('client-documents', $1)`,
        [`clients/${clientId}/photo/anon.jpg`],
      );

      expect(result.ok).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  describe('a manager', () => {
    it('reads a client photograph', async () => {
      const result = await asUser(
        manager,
        `select name from storage.objects where name = $1`,
        [photoPath],
      );

      expect(result.rows).toHaveLength(1);
    });

    it('reads a client identification document', async () => {
      const result = await asUser(
        manager,
        `select name from storage.objects where name = $1`,
        [idPath],
      );

      expect(result.rows).toHaveLength(1);
    });

    it('reads a guarantor photograph', async () => {
      const result = await asUser(
        manager,
        `select name from storage.objects where name = $1`,
        [guarantorPhotoPath],
      );

      expect(result.rows).toHaveLength(1);
    });

    it('uploads into an existing client folder', async () => {
      const result = await asUser(
        manager,
        `insert into storage.objects (bucket_id, name)
         values ('client-documents', $1)`,
        [`clients/${clientId}/photo/manager-upload.jpg`],
      );

      expect(result.ok).toBe(true);
    });

    it('cannot upload into a folder for a client that does not exist', async () => {
      const result = await asUser(
        manager,
        `insert into storage.objects (bucket_id, name)
         values ('client-documents', 'clients/00000000-0000-4000-8000-000000000000/photo/x.jpg')`,
      );

      // Otherwise an attacker could seed objects at paths that a future client
      // would later be given, or simply use the bucket as free storage.
      expect(result.ok).toBe(false);
    });

    it.each([
      ['a traversal path', 'clients/../../../etc/passwd'],
      ['a path with no client id', 'clients/photo/x.jpg'],
      ['a non-uuid client segment', 'clients/not-a-uuid/photo/x.jpg'],
      ['an unrecognised document kind', 'clients/REPLACE/exports/x.jpg'],
      ['a path in no known scope', 'secrets/REPLACE/photo/x.jpg'],
      ['an empty path', ''],
    ])('refuses %s', async (_label, template) => {
      const name = template.replace('REPLACE', clientId);

      const result = await asUser(
        manager,
        `insert into storage.objects (bucket_id, name) values ('client-documents', $1)`,
        [name],
      );

      expect(result.ok, name).toBe(false);
    });

    it('cannot delete an object — no DELETE policy exists', async () => {
      const result = await asUser(
        manager,
        `delete from storage.objects where name = $1`,
        [photoPath],
      );

      // Identity evidence is not freely destructible. A replaced file stays
      // until an operator removes it deliberately with the secret key, so a
      // bug cannot destroy the only scan of a client's national ID.
      expect(result.rowCount).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('a secretary or treasurer', () => {
    it('reads a client photograph', async () => {
      const result = await asUser(
        secretary,
        `select name from storage.objects where name = $1`,
        [photoPath],
      );

      expect(result.rows).toHaveLength(1);
    });

    it('cannot read a client identification document', async () => {
      const result = await asUser(
        secretary,
        `select name from storage.objects where name = $1`,
        [idPath],
      );

      // Gated on `clients:view_nin` rather than `clients:view`, matching the
      // policy on client_identities: a scan of a national ID is the same
      // evidence as the number printed on it.
      expect(result.rows).toEqual([]);
    });

    it('cannot upload anything', async () => {
      const result = await asUser(
        secretary,
        `insert into storage.objects (bucket_id, name)
         values ('client-documents', $1)`,
        [`clients/${clientId}/photo/secretary.jpg`],
      );

      expect(result.ok).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  describe('a borrower', () => {
    it('cannot read their own photograph through storage', async () => {
      const result = await asUser(
        borrower,
        `select name from storage.objects where name = $1`,
        [photoPath],
      );

      // The read policy requires `clients:view`, which a borrower does not
      // hold. The portal renders their photograph through a server-signed URL
      // generated for them, not by letting them query the bucket.
      expect(result.rows).toEqual([]);
    });

    it('cannot read their own identification document', async () => {
      const result = await asUser(
        borrower,
        `select name from storage.objects where name = $1`,
        [idPath],
      );

      expect(result.rows).toEqual([]);
    });

    it('cannot read a guarantor photograph by guessing the path', async () => {
      const result = await asUser(
        borrower,
        `select name from storage.objects where name = $1`,
        [guarantorPhotoPath],
      );

      // Including their own guarantor's. A guarantor's photograph is that
      // person's data, disclosed to the lender rather than to the borrower who
      // named them.
      expect(result.rows).toEqual([]);
    });

    it('cannot enumerate the buckets', async () => {
      const result = await asUser(
        borrower,
        `select name from storage.objects where bucket_id like '%-documents'`,
      );

      expect(result.rows).toEqual([]);
    });

    it('cannot upload', async () => {
      const result = await asUser(
        borrower,
        `insert into storage.objects (bucket_id, name)
         values ('client-documents', $1)`,
        [`clients/${clientId}/photo/borrower.jpg`],
      );

      expect(result.ok).toBe(false);
    });

    it('cannot delete', async () => {
      const result = await asUser(
        borrower,
        `delete from storage.objects where name = $1`,
        [photoPath],
      );

      expect(result.rowCount).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('the path helpers fail closed', () => {
    it.each([
      ['clients/not-a-uuid/photo/x.jpg'],
      ['clients'],
      ['clients/'],
      [''],
      ['../clients/x/photo/y.jpg'],
      ['guarantors/abc/photo/x.jpg'],
    ])('returns null for %s', async (name) => {
      const row = await queryOne<{ client: string | null; guarantor: string | null }>(
        `select public.storage_path_client_id($1) as client,
                public.storage_path_guarantor_id($1) as guarantor`,
        [name],
      );

      // NULL fails every policy closed, which is why a malformed path cannot
      // sneak past by being unparseable.
      expect(row.client, name).toBeNull();
      expect(row.guarantor, name).toBeNull();
    });

    it('parses a well-formed path', async () => {
      const row = await queryOne<{ client: string | null; kind: string | null }>(
        `select public.storage_path_client_id($1) as client,
                public.storage_path_kind($1) as kind`,
        [photoPath],
      );

      expect(row.client).toBe(clientId);
      expect(row.kind).toBe('photo');
    });
  });
});
