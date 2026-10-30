import { afterAll, describe, expect, it } from 'vitest';

import { closePool, hasDatabase, inRollbackTransaction } from '../helpers/db';

afterAll(closePool);

describe.skipIf(!hasDatabase)('policy reference safety', () => {
  it('grows the client serial beyond three digits without reusing 100', async () => {
    await inRollbackTransaction(async (client) => {
      await client.query(`insert into public.reference_sequences
        (scope, period_year, last_value)
        values ('client', (extract(year from now() at time zone 'Africa/Kampala')::int % 100)::smallint, 999)
        on conflict (scope, period_year) do update set last_value = 999`);
      const result = await client.query<{ first: string; second: string }>(
        `select public.next_reference('client') as first,
                public.next_reference('client') as second`,
      );
      expect(result.rows[0]?.first).toMatch(/^CL[0-9]{2}1000$/);
      expect(result.rows[0]?.second).toMatch(/^CL[0-9]{2}1001$/);
    });
  });

  it('gives fine and registration receipts distinct prefixes', async () => {
    await inRollbackTransaction(async (client) => {
      const result = await client.query<{ count: string }>(
        `select count(*) from (
          select prefix from public.reference_formats group by prefix having count(*) > 1
        ) duplicates`,
      );
      expect(result.rows[0]?.count).toBe('0');
    });
  });
});
