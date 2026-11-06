-- Functions, the fourth runtime tier (docs/FUNCTIONS.md, D110). Additive only.
--
-- 0001 and 0003 gave `projects`, `deployments` and `workloads` a `runtime` column with a
-- CHECK (runtime IN ('static','process','container')) constraint. SQLite cannot change a CHECK
-- constraint without rebuilding the table, which the additive-migration rule forbids; 0028 solved
-- the same problem for database engines with a second column. So the legacy `runtime` columns keep
-- storing only the three original tiers and `runtime_name` holds the effective tier, including
-- 'function'. A function is written as `runtime = 'process'` with `runtime_name = 'function'`, so
-- a release rolled back to before Functions still reads a runtime its CHECK accepts and never
-- fails on a value it does not know.
--
-- The column is nullable: rows written before this migration leave it NULL, and
-- `effectiveRuntime` falls back to the legacy column. New rows always set it.

ALTER TABLE projects ADD COLUMN runtime_name TEXT;
UPDATE projects SET runtime_name = runtime;

ALTER TABLE deployments ADD COLUMN runtime_name TEXT;
UPDATE deployments SET runtime_name = runtime;

ALTER TABLE workloads ADD COLUMN runtime_name TEXT;
UPDATE workloads SET runtime_name = runtime;
