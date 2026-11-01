-- 0004 — drop orphaned tables from a superseded schema iteration.
--
-- The `ignis` schema contains a second, plural-named set of tables
-- (documents, chunks, experiments, findings, insights, sources, materials,
-- test_conditions, experiment_materials, ingest_runs, query_log) that is not
-- created by any migration in db/migrations and is not referenced anywhere in
-- the pipeline or the API. The canonical, code-referenced tables are the
-- singular ones (document, chunk, finding, experiment, insight, ...).
--
-- Keeping both invites silent drift: a query against `ignis.documents` returns
-- plausible-looking stale rows instead of failing. Drop the orphans so the
-- schema has exactly one source of truth.

DROP TABLE IF EXISTS ignis.experiment_materials CASCADE;
DROP TABLE IF EXISTS ignis.test_conditions      CASCADE;
DROP TABLE IF EXISTS ignis.query_log            CASCADE;
DROP TABLE IF EXISTS ignis.ingest_runs          CASCADE;
DROP TABLE IF EXISTS ignis.materials            CASCADE;
DROP TABLE IF EXISTS ignis.sources              CASCADE;
DROP TABLE IF EXISTS ignis.insights             CASCADE;
DROP TABLE IF EXISTS ignis.findings             CASCADE;
DROP TABLE IF EXISTS ignis.experiments          CASCADE;
DROP TABLE IF EXISTS ignis.chunks               CASCADE;
DROP TABLE IF EXISTS ignis.documents            CASCADE;
