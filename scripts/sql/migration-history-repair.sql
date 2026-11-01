-- POLYTOS migration-history repair - THE PERMANENT REPAIR OPERATION
--
--   *** NOT EXECUTED. REQUIRES EXPLICIT AUTHORIZATION FROM THE OWNER. ***
--
-- Removes the nine pre-rename rows from supabase_migrations.schema_migrations
-- so the recorded history matches the 159 migration files in the reviewed
-- source revision exactly. It touches NO application schema and NO business
-- data: the only table written is the migration-history ledger.
--
-- Before running, scripts/sql/migration-history-preflight.sql must report PASS
-- on all 21 checks, and docs/audit/polytos-migration-history-2026-11-01 must
-- hold the verified export of the nine rows (that export is the only copy of
-- the SQL for 20261012062453 and 20261012064058 - see the report).
--
-- SAFETY PROPERTIES OF THIS STATEMENT
--
--  * One statement, therefore one implicit transaction: it applies in full or
--    not at all. It needs no BEGIN/COMMIT and no psql.
--  * Each version is paired with the SHA-256 of the SQL that version is known
--    to carry. A row whose content differs is not matched and not deleted.
--  * The `(select count(*) from matched) = 9` guard means that if any one of
--    the nine rows is missing or has changed, ZERO rows are deleted. It is
--    self-verifying at execution time, so it does not depend on the preflight
--    having run moments earlier.
--  * RETURNING prints exactly which rows went. Expect nine rows back; anything
--    other than nine means nothing was deleted and the state must be re-read.
--  * The table has no triggers, rules, RLS policies or inbound foreign keys
--    (verified read-only), so nothing cascades from this delete.
--
-- ROLLBACK: node scripts/emit-migration-history-restore.mjs > restore.sql
-- regenerates the exact INSERT that puts all nine rows back, byte for byte,
-- from the verified artifact. Review it before use.

with expected(version, sha256) as (values
  ('20261010104426','98591dbae2ad3d9fc992759e6491399f71696cbae14d3f75d9b89f37a084508f'),
  ('20261010104529','e5753bf0571827b0b490bc0800e1b5624d3caad0f02aa6dd69ee2777c26c8ba0'),
  ('20261010104621','e3cdd816e9a7c627cf03ff7a524e61f2ccaa990ff7d0257dad464e7e0d8b66e2'),
  ('20261010104723','ad2067ba148daec602d1fc0145b59e29cafd3de37f38a273672b49575960909b'),
  ('20261011060140','0a7cc4d676b13667f3803e3c60f17864c1e26fd2676dd6d54ead9028e3ff563b'),
  ('20261011060324','990cc6926e12094485a1d192a8c9561970d0c3bc3fe1578f571ed1f055d2c8d0'),
  ('20261011061348','110fa53c76d3f4cf174721c4bc416d97a5b60b153ba1cc15101c1352b4b337ff'),
  ('20261012062453','702864d7b3505d0ef0777e0d8555769c150aae758ff7758c703757ffafdf67dd'),
  ('20261012064058','789049653cd3c6c7bdcbf293a105dcf9cceca2daad6790128f01b5a3b2f35006')
),
matched as (
  select m.version
    from supabase_migrations.schema_migrations m
    join expected e on e.version = m.version
   where coalesce(array_length(m.statements, 1), 0) = 1
     and encode(sha256(convert_to(m.statements[1], 'UTF8')), 'hex') = e.sha256
),
doomed as (
  select version from matched where (select count(*) from matched) = 9
)
delete from supabase_migrations.schema_migrations m
 using doomed d
 where m.version = d.version
returning m.version, m.name;
