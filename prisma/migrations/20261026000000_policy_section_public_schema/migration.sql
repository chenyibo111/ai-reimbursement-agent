DO $$
DECLARE
  source_schema text;
  source_count integer;
BEGIN
  IF to_regclass('public."PolicySection"') IS NOT NULL THEN
    RETURN;
  END IF;

  SELECT count(*)::integer, min(n.nspname)
    INTO source_count, source_schema
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relname = 'PolicySection'
     AND c.relkind = 'r'
     AND n.nspname NOT IN ('public', 'pg_catalog', 'information_schema');

  IF source_count <> 1 THEN
    RAISE EXCEPTION 'Expected one misplaced PolicySection table, found %', source_count;
  END IF;

  EXECUTE format('ALTER TABLE %I.%I SET SCHEMA public', source_schema, 'PolicySection');
END $$;
