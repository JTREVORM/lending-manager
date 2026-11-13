-- Production security-advisor cleanup: remove an untracked one-column probe view.
-- Safe on freshly migrated databases (the view is absent there).
-- Live deployment must pass normal reviewed migration/CI release gates.
-- No business rows, accounts, settings, roles, grants on other objects,
-- authentication identities, or audit records are modified.
DO $drop_untracked_probe$
DECLARE
  v_definition text;
BEGIN
  SELECT pg_catalog.pg_get_viewdef(c.oid)
    INTO v_definition
    FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname = '__gate_probe'
     AND c.relkind = 'v';

  IF v_definition IS NULL THEN
    RETURN;
  END IF;

  -- This stray view was inspected in production on 2026-11-04 and had
  -- exactly: SELECT 1 AS one; Refuse to remove a later, different view.
  IF pg_catalog.lower(
       pg_catalog.regexp_replace(v_definition, '[[:space:]]+', '', 'g')
     ) <> 'select1asone;' THEN
    RAISE EXCEPTION
      'Refusing to remove public.__gate_probe: its definition changed';
  END IF;

  -- RESTRICT is deliberate: any unexpected dependency fails this migration.
  DROP VIEW public.__gate_probe RESTRICT;
END;
$drop_untracked_probe$;
