-- POLYTOS migration-history repair - READ-ONLY preflight
--
-- Replaces the psql-only transactional preflight. SELECT statements only: no
-- DELETE, UPDATE, INSERT, DDL, SET, transaction control or VACUUM. Runs through
-- the Supabase MCP connector or the dashboard SQL editor.
--
-- Returns one row per check. Every row must read PASS before the repair is
-- authorized. Target project: fszgwemtgyrbhngajpzm ("lending manager") - see 01.
--
-- repo = the 159 migration filenames in supabase/migrations at the reviewed
-- source revision. stale = the nine pre-rename history rows and the SHA-256 of
-- the SQL each one carries, as exported to the audit artifact.

with repo(version) as (
  select unnest(array[
    '20261001000100','20261001000200','20261001000300','20261001000400','20261001000500','20261001000600',
    '20261001000700','20261001000800','20261002000100','20261002000200','20261002000300','20261002000400',
    '20261002000500','20261002000600','20261002000700','20261002000800','20261003000100','20261003000200',
    '20261003000300','20261003000400','20261003000500','20261003000600','20261003000700','20261004000100',
    '20261004000200','20261004000300','20261004000400','20261004000500','20261004000600','20261004000700',
    '20261005000100','20261005000200','20261005000300','20261005000400','20261005000500','20261005000600',
    '20261006000100','20261006000200','20261006000300','20261006000400','20261006000500','20261006000600',
    '20261006000700','20261006000800','20261007000100','20261007000200','20261007000300','20261007000400',
    '20261007000500','20261007000600','20261007000700','20261007000800','20261007000900','20261007001000',
    '20261008000100','20261008000200','20261009000100','20261009000200','20261010000100','20261010000200',
    '20261010000300','20261010000400','20261011000100','20261011000200','20261011000210','20261011000220',
    '20261011000230','20261011000240','20261012000100','20261012000200','20261012000300','20261012000400',
    '20261012000500','20261012000600','20261012000700','20261013000100','20261013000200','20261013000300',
    '20261013000400','20261013000500','20261013000600','20261014000100','20261014000200','20261014000300',
    '20261014000400','20261015000100','20261015000200','20261015000300','20261016000100','20261016000200',
    '20261017000100','20261018000100','20261018000200','20261018000300','20261018000400','20261019000100',
    '20261019000200','20261019000300','20261019000400','20261019000500','20261019000600','20261019000700',
    '20261019000800','20261020000100','20261020000200','20261020000300','20261020000400','20261020000500',
    '20261020000600','20261020000700','20261020000800','20261020000900','20261020001000','20261020001100',
    '20261020001200','20261020001300','20261020001400','20261021000100','20261021000200','20261021000300',
    '20261021000400','20261021000500','20261021000600','20261021000700','20261021000800','20261021000900',
    '20261021001000','20261022000100','20261022000200','20261022000300','20261022000400','20261022000500',
    '20261022000600','20261022000700','20261022000800','20261022000900','20261022001000','20261022001100',
    '20261022001200','20261022001300','20261022001400','20261028000050','20261028000100','20261028000150',
    '20261028000200','20261028000250','20261028000300','20261028000400','20261028000500','20261028000600',
    '20261028000700','20261028000750','20261028000800','20261028000900','20261028001000','20261028001100',
    '20261028001200','20261028001300','20261030115530'
  ])
),
stale(version, name, sha256) as (values
  ('20261010104426','collateral',             '98591dbae2ad3d9fc992759e6491399f71696cbae14d3f75d9b89f37a084508f'),
  ('20261010104529','recovery_actions',       'e5753bf0571827b0b490bc0800e1b5624d3caad0f02aa6dd69ee2777c26c8ba0'),
  ('20261010104621','guarantee_release',      'e3cdd816e9a7c627cf03ff7a524e61f2ccaa990ff7d0257dad464e7e0d8b66e2'),
  ('20261010104723','risk_monitoring',        'ad2067ba148daec602d1fc0145b59e29cafd3de37f38a273672b49575960909b'),
  ('20261011060140','notifications',          '0a7cc4d676b13667f3803e3c60f17864c1e26fd2676dd6d54ead9028e3ff563b'),
  ('20261011060324','notification_triggers',  '990cc6926e12094485a1d192a8c9561970d0c3bc3fe1578f571ed1f055d2c8d0'),
  ('20261011061348','notification_backfill',  '110fa53c76d3f4cf174721c4bc416d97a5b60b153ba1cc15101c1352b4b337ff'),
  ('20261012062453','balance_as_of',          '702864d7b3505d0ef0777e0d8555769c150aae758ff7758c703757ffafdf67dd'),
  ('20261012064058','notify_what_still_waits','789049653cd3c6c7bdcbf293a105dcf9cceca2daad6790128f01b5a3b2f35006')
),
hist as (select version, name, statements from supabase_migrations.schema_migrations),
checks(seq, check_name, observed, expected) as (
  select '01','target database / role / engine',
         current_database()||' / '||current_user||' / '||substring(version() from 'PostgreSQL [0-9.]+'),
         'postgres / postgres / PostgreSQL 17.11'
  union all select '02','history row count', (select count(*)::text from hist), '168'
  union all select '03','repository migration files', (select count(*)::text from repo), '159'
  union all select '04','stale rows present',
         (select count(*)::text from hist h join stale s on s.version=h.version), '9'
  union all select '05','stale rows carry exactly one statement',
         (select count(*)::text from hist h join stale s on s.version=h.version
           where coalesce(array_length(h.statements,1),0)=1), '9'
  union all select '06','stale SQL checksums match the exported artifact',
         (select count(*)::text from hist h join stale s on s.version=h.version
           where encode(sha256(convert_to(h.statements[1],'UTF8')),'hex')=s.sha256), '9'
  union all select '07','canonical counterparts present',
         (select count(*)::text from hist h where h.name in (select name from stale)
            and h.version not in (select version from stale)), '9'
  union all select '08','canonical counterparts hold no SQL',
         (select count(*)::text from hist h where h.name in (select name from stale)
            and h.version not in (select version from stale)
            and coalesce(array_length(h.statements,1),0)=0), '9'
  union all select '09','history rows absent from the repository',
         (select count(*)::text from hist h where h.version not in (select version from repo)), '9'
  union all select '10','those rows are exactly the nine stale versions',
         (select count(*)::text from hist h where h.version not in (select version from repo)
            and h.version in (select version from stale)), '9'
  union all select '11','repository files missing from history',
         (select count(*)::text from repo r where r.version not in (select version from hist)), '0'
  union all select '12','POST-REPAIR: rows that would not match the repository',
         (select count(*)::text from (
            select version from hist where version not in (select version from stale)
            except select version from repo) x), '0'
  union all select '13','POST-REPAIR: repository files left uncovered',
         (select count(*)::text from (
            select version from repo
            except select version from hist where version not in (select version from stale)) x), '0'
  union all select '14','POST-REPAIR: history row count',
         (select (count(*) - 9)::text from hist), '159'
  union all select '15','POST-REPAIR: duplicate migration names remaining',
         (select count(*)::text from (
            select name from hist where version not in (select version from stale)
            group by name having count(*) > 1) x), '0'
  union all select '16','security migration 20261030180224 absent',
         (select count(*)::text from hist where version='20261030180224'), '0'
  union all select '17','readiness migration 20261030115530 present once',
         (select count(*)::text from hist where version='20261030115530'), '1'
  union all select '18','fingerprint: public columns',
         (select md5(string_agg(t.sig,'|' order by t.sig)) from (
            select c.table_name||'.'||c.column_name||':'||c.data_type||':'||c.is_nullable||':'||coalesce(c.column_default,'-') as sig
              from information_schema.columns c where c.table_schema='public') t),
         '7e42df13d874978c3996a2efc604ca48'
  union all select '19','fingerprint: public functions',
         (select md5(string_agg(t.sig,'|' order by t.sig)) from (
            select p.proname||'('||pg_get_function_identity_arguments(p.oid)||'):'||p.prosecdef::text||':'||coalesce(array_to_string(p.proconfig,','),'-')||':'||md5(coalesce(p.prosrc,'')) as sig
              from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public') t),
         'a5d2c1142da9c8f74eb637f80442b86e'
  union all select '20','fingerprint: public + storage policies',
         (select md5(string_agg(t.sig,'|' order by t.sig)) from (
            select schemaname||'.'||tablename||'.'||policyname||':'||cmd||':'||coalesce(qual,'-')||':'||coalesce(with_check,'-') as sig
              from pg_policies where schemaname in ('public','storage')) t),
         '96bfcae6171b2c92c34fa9299a58bd6c'
  union all select '21','financial row counts loans/payments/schedules/audit',
         (select (select count(*) from public.loans)||'/'||(select count(*) from public.loan_payments)||'/'||
                 (select count(*) from public.loan_schedules)||'/'||(select count(*) from public.audit_log)),
         '35/470/26/1671'
)
select seq, check_name, observed, expected,
       case when observed = expected then 'PASS' else 'FAIL' end as verdict
  from checks order by seq;
