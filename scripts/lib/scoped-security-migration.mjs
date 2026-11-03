import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const securityVersion = '20261030180224';
export const securityName = 'forced_password_authorization_boundary';
export const securitySql = readFileSync(
  new URL(
    '../../supabase/migrations/20261030180224_forced_password_authorization_boundary.sql',
    import.meta.url,
  ),
  'utf8',
);
export const securitySha256 =
  '25a45d120ba0083bf5b1af1e983e0f0313088ccc359bf257bb13b274cc4c2c5e';

/** The caller supplies an explicitly approved connection; importing runs no SQL. */
export async function applyScopedSecurityMigration(client, { beforeCommit } = {}) {
  if (createHash('sha256').update(securitySql).digest('hex') !== securitySha256) {
    throw new Error('The reviewed security migration checksum changed.');
  }
  await client.query('begin');
  try {
    await client.query("set local lock_timeout = '5s'");
    await client.query("set local statement_timeout = '60s'");
    await client.query(
      "select pg_advisory_xact_lock(hashtext('polytos.security.20261030180224'))",
    );
    const prior = await client.query(
      'select version from supabase_migrations.schema_migrations where version=$1',
      [securityVersion],
    );
    if (prior.rowCount)
      throw new Error('Security migration already recorded; refusing replay.');
    await client.query(securitySql);
    await client.query(
      'insert into supabase_migrations.schema_migrations(version,name,statements) values($1,$2,$3)',
      [securityVersion, securityName, [securitySql]],
    );
    if (beforeCommit) await beforeCommit();
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}
