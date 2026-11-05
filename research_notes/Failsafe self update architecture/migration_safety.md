# Migration safety for rollback-able blue/green updates (SQLite focus)

Context: Skiff's control plane uses one SQLite DB. Numbered SQL migrations and Better Auth's `getMigrations().runMigrations()` both run at boot. Litestream replicates the DB. The updater snapshots before switching, a preflight refuses "destructive" migrations, and rollback restores the snapshot, which loses writes made after the switch.

Research done 2026-11-05. Primary sources fetched: GitLab dev docs (avoiding downtime, multi-version compatibility, post-deployment migrations, upgrade paths), sqlite.org (ALTER TABLE, PRAGMA, prepare), strong_migrations README, Atlas analyzers, Squawk rules, Litestream restore reference, Stripe's online-migrations post, Sentry self-hosted releases, Mattermost downgrade docs, Better Auth database docs.

## 1. Expand/contract (parallel change): how mature orgs describe it

### Takeaway
Every breaking schema change becomes three or more separately shipped steps: expand (additive only), migrate (backfill and switch code), contract (drop). Contract always ships at least one release after the code stops using the old shape. GitLab is the most explicit model for a self-hosted product. It requires code to stay compatible with the schema one monthly release either side, and it splits migrations into "regular" (pre-deploy, additive) and "post-deployment" (contracting) classes that can run hours or days later.

### Cited Findings
**GitLab: the principle**
- "Every breaking change is broken down in three phases: expand, migrate, and contract." Each phase belongs to a different milestone, and contract may wait for the next major release. [GitLab multi-version compatibility](https://docs.gitlab.com/development/multi_version_compatibility/)
- "Updating GitLab is not atomic. Therefore, many components must be backwards-compatible." For zero-downtime users, code must stay compatible for one monthly release. [GitLab multi-version compatibility](https://docs.gitlab.com/development/multi_version_compatibility/)
- Old code runs on the new schema. Pre-deployment migrations can run while web, API and Sidekiq nodes still run the previous release. [GitLab multi-version compatibility](https://docs.gitlab.com/development/multi_version_compatibility/)
- New code runs alongside old workers. New web nodes may enqueue jobs that old Sidekiq nodes execute, so adding a worker parameter in one milestone can cause an outage if Puma restarts before Sidekiq. [GitLab multi-version compatibility](https://docs.gitlab.com/development/multi_version_compatibility/)
- "Feature flags are a tool, not a strategy, for handling backward compatibility problems." [GitLab multi-version compatibility](https://docs.gitlab.com/development/multi_version_compatibility/)

**GitLab: real incidents from mixed versions**
- A `NOT NULL` constraint was added, but old servers kept inserting nulls, so CI artifacts failed. [GitLab multi-version compatibility](https://docs.gitlab.com/development/multi_version_compatibility/)
- A new `NOT NULL` column broke release creation in production while canary ran the new code. [GitLab multi-version compatibility](https://docs.gitlab.com/development/multi_version_compatibility/)
- A database trigger on old servers overwrote a new column written by new servers. [GitLab multi-version compatibility](https://docs.gitlab.com/development/multi_version_compatibility/)
- Mixed versions refreshed a Markdown cache in incompatible formats and corrupted saved descriptions. [GitLab multi-version compatibility](https://docs.gitlab.com/development/multi_version_compatibility/)

**GitLab: post-deployment migrations**
- They are "regular Rails migrations that can optionally be executed after a deployment," kept in `db/post_migrate`. [GitLab post-deployment migrations](https://docs.gitlab.com/development/database/post_deployment_migrations/)
- The sequence is: run `db:migrate` with `SKIP_POST_DEPLOYMENT_MIGRATIONS` set, deploy everywhere, then rerun without the variable on one server. GitLab.com runs them daily from a separate pipeline. [GitLab post-deployment migrations](https://docs.gitlab.com/development/database/post_deployment_migrations/)
- The post-deploy framework "allows us to bundle all three phases into one milestone." Code must tolerate post-deploy migrations that "don't get executed until a couple days later." [GitLab multi-version compatibility](https://docs.gitlab.com/development/multi_version_compatibility/)

**GitLab: concrete recipes**
- Drop a column over three releases:
  - M: add `ignore_column :col, remove_with: 'X.Y', remove_after: date` to the model.
  - M+1: drop the column in a post-deploy migration.
  - M+2: remove the ignore rule.
  - "Ignoring and dropping columns should not occur simultaneously in the same release." [GitLab avoiding downtime](https://docs.gitlab.com/development/database/avoiding_downtime_in_migrations/)
- Rename a column:
  - M: regular migration `rename_column_concurrently`, plus `ignore_column`, plus post-deploy `cleanup_concurrent_column_rename`.
  - M+1: remove the ignore rule.
  - Small tables only. Large tables need batched background migrations. [GitLab avoiding downtime](https://docs.gitlab.com/development/database/avoiding_downtime_in_migrations/)
- Change a type: regular `change_column_type_concurrently`, then post-deploy `cleanup_concurrent_column_type_change`. [GitLab avoiding downtime](https://docs.gitlab.com/development/database/avoiding_downtime_in_migrations/)
- Change NOT NULL: adding it is post-deploy, because the application changes must ship first. Removing it is a regular migration. [GitLab avoiding downtime](https://docs.gitlab.com/development/database/avoiding_downtime_in_migrations/)
- Drop a table: M removes all code that uses it. M+1 uses post-deploy migrations to drop the FKs, then the table. [GitLab avoiding downtime](https://docs.gitlab.com/development/database/avoiding_downtime_in_migrations/)
- Renaming a table "requires downtime" unless you follow a multi-release process. [GitLab avoiding downtime](https://docs.gitlab.com/development/database/avoiding_downtime_in_migrations/)
- Adding tables is safe. Adding indexes is safe when done concurrently (Postgres). [GitLab avoiding downtime](https://docs.gitlab.com/development/database/avoiding_downtime_in_migrations/)

**Discourse**
- Discourse adopted GitLab-style post-deployment migrations, run with `SKIP_POST_DEPLOYMENT_MIGRATIONS=1` then `=0`, to replace its older delayed column dropper. [Discourse Meta: Introducing Post Deployment Migration](https://meta.discourse.org/t/introducing-post-deployment-migration/98974?tl=nl)
- Failure mode: if the skip flag is set and pending migrations never get run, later releases can fail. One report was a duplicate-column error after a post-migrate dropped columns that an old add-column migration re-adds. [Discourse Meta thread](https://meta.discourse.org/t/failure-to-pay-attention-to-skip-post-deployment-migrations-causes-problems/221906?tl=en)

**Stripe: four-step dual-write**
- The steps are:
  1. "Dual writing to the existing and new tables to keep them in sync."
  2. "Changing all read paths… to read from the new table."
  3. "Changing all write paths… to only write to the new table."
  4. "Removing old data that relies on the outdated data model." [Stripe: Online migrations at scale](https://stripe.com/blog/online-migrations)
- Stripe verified with Scientist experiments that compared old and new reads and alerted on any mismatch. It made access to the old field a hard error so nothing could quietly keep depending on it. It changed only "a few hundred lines of code at one time." [Stripe](https://stripe.com/blog/online-migrations)
- The post never mentions rollback explicitly. Rollback safety comes from keeping both stores consistent until the final step. [Stripe](https://stripe.com/blog/online-migrations)

**strong_migrations (Rails)**
- It prescribes the same pattern for renaming a column or table, or changing a type: "create a new column, write to both, backfill, move reads, stop writing to the old column, then drop it." [strong_migrations](https://github.com/ankane/strong_migrations)

### Inferences
- For Skiff, a release N migration set should contain only expand operations. Any contract operation for a change introduced in N must ship in N+1 or later, after N-1 can no longer be rolled back to. This is GitLab's "regular vs post-deploy" split mapped onto a single-node updater:
  - "Pre" migrations run before the new version starts and must be safe for N-1.
  - "Post" (contract) migrations run only after the new version is committed (health checks passed, rollback window closed), or in the next release.
- GitLab's incident list maps directly onto the blue/green window, where old and new processes share one DB. The NOT NULL and trigger incidents are the most likely Skiff equivalents.
- Stripe's "hard error on old field access" generalises to TypeScript. Remove the column from the typed query layer one release before dropping it, which is the equivalent of `ignore_column`.

### Gaps
- I did not fetch first-hand GitHub (gh-ost and its schema-change process), Shopify (LHM, "online schema change"), or 37signals/ONCE write-ups on expand/contract. My searches for 37signals ONCE/Campfire SQLite migration and rollback practice found nothing authoritative ([search hit](https://once.beehiiv.com/p/weekly-digest-17-workbook-sqlite) only mentions DHH discussing the SQLite choice).
- Fly.io/LiteFS migration guidance was not fetched.

## 2. Lint rules for unsafe migrations, and which change classes break a running old version

### Takeaway
All the tools agree on the same core classes that break old code against a new schema:
- drop table or column
- rename table or column
- change a column's type
- add NOT NULL, a CHECK, a UNIQUE or a FK to existing data (data-dependent and write-restrictive)
- add a required column without a default

Atlas is the only one of these tools with SQLite support and an explicit "backward-incompatible" analyzer. Squawk is Postgres-only. strong_migrations covers Postgres, MySQL and MariaDB (Rails only). For Skiff, a small custom SQL linter in the updater preflight that copies Atlas's BC/DS/MF classes is cheap and enforceable.

### Cited Findings
**Atlas `migrate lint`**
- Analyzers include `destructive`, `data_depend`, `incompatible`, `restrictive` (Pro), `non_linear`, `naming` and `nestedtx` (Pro). [Atlas analyzers](https://atlasgo.io/lint/analyzers)
- Check codes:
  - Destructive: DS101 schema dropped, DS102 table dropped, DS103 non-virtual column dropped.
  - Data-dependent: MF101 unique index added to an existing column, MF103 non-nullable column added to an existing table, MF104 nullable column changed to non-nullable.
  - Backward-incompatible: BC101 table renamed, BC102 column renamed, BC103 table dropped, BC104 column dropped.
  - Constraint deletion (Pro): CD101–103.
  - [Atlas analyzers](https://atlasgo.io/lint/analyzers)
- `incompatible` "targets breakage for clients that still reference the old object, even when the object holds no data. This matters during rolling deployments." `restrictive` (Pro, off by default) flags changes that reject reads or writes from clients on the previous schema. [Atlas analyzers](https://atlasgo.io/lint/analyzers)
- The only SQLite-specific code is LT101: nullable column changed to non-nullable without a DEFAULT. [Atlas analyzers](https://atlasgo.io/lint/analyzers)
- Lint exits with code 1 on destructive changes by default. Checks can be suppressed per statement with `-- atlas:nolint BC101` or `-- atlas:nolint destructive incompatible`. [Atlas analyzers](https://atlasgo.io/lint/analyzers)

**strong_migrations**
- Checks that apply to every database:
  - remove column (needs `ignored_columns` first)
  - change column type
  - rename column or table
  - `create_table force: true`
  - add auto-increment column
  - add stored generated column
  - add FK
  - add check constraint
  - raw `execute` (unverifiable, so it needs `safety_assured`)
  - backfill inside the schema-change transaction
  - [strong_migrations](https://github.com/ankane/strong_migrations)
- Postgres-only checks: non-concurrent index, unique constraint, volatile default, setting NOT NULL on an existing column (use a NOT VALID check, then validate), json vs jsonb, renaming an enum value. [strong_migrations](https://github.com/ankane/strong_migrations)
- Features:
  - `safety_assured` is the explicit override.
  - `start_after` grandfathers older migrations.
  - `target_version` sets the production DB version for checks.
  - `check_down` (off by default) also checks down migrations.
  - The README does not list SQLite as supported. [strong_migrations](https://github.com/ankane/strong_migrations)

**Squawk**
- Squawk is "a linter for Postgres migrations" with about 88 rules. Relevant ones include:
  - adding-not-nullable-field, adding-required-field, adding-field-with-default, adding-foreign-key-constraint
  - ban-drop-column, ban-drop-table, ban-drop-not-null
  - changing-column-type, renaming-column, renaming-table
  - ban-new-write-restriction, constraint-missing-not-valid, require-timeout-settings, transaction-nesting
  - [Squawk rules](https://squawkhq.com/docs/rules)

**GitLab**
- Classifies by phase rather than lint code:
  - Additive changes (new table, nullable column, index) are regular or pre-deploy.
  - Drops and NOT NULL additions are post-deploy.
  - Table renames need downtime. [GitLab avoiding downtime](https://docs.gitlab.com/development/database/avoiding_downtime_in_migrations/)

### Inferences
Proposed Skiff migration classification, which the updater preflight can enforce by parsing SQL. It combines Atlas BC/DS/MF with GitLab's phases and SQLite specifics.

- **Safe for N-1 (allowed in "pre" migrations):**
  - `CREATE TABLE`, `CREATE INDEX` (non-unique)
  - `CREATE VIEW` or trigger only if it cannot change N-1's writes
  - `ALTER TABLE ADD COLUMN` that is nullable, or `NOT NULL DEFAULT <constant>`, with no UNIQUE/PK and no CHECK that fails on N-1 writes
  - `INSERT` of seed or reference rows
- **Unsafe for N-1 (refuse in pre; allow only as "post/contract" once rollback is impossible):**
  - `DROP TABLE`, `DROP COLUMN`, `DROP INDEX` (only if N-1 query plans need it, so low risk)
  - `RENAME TABLE`, `RENAME COLUMN`
  - table rebuild (`CREATE new_X … INSERT … DROP X … RENAME new_X`)
  - `CREATE UNIQUE INDEX` on existing columns
  - new NOT NULL, CHECK or FK on existing data
  - any trigger that writes on old-version inserts
  - `UPDATE`/`DELETE` that rewrites data into a format N-1 can't read
- **Data-dependent (validate against a snapshot copy before cutover):** unique index, NOT NULL changes, CHECK additions. SQLite ≥3.37 tests CHECK constraints against existing rows on ADD COLUMN (see section 3).
- Also guard against N-1 *writes* failing on the new schema, as in GitLab's NOT NULL incident. A new NOT NULL column must have a DEFAULT, otherwise old INSERTs that omit the column fail.
- Treat raw SQL with no parseable class as unsafe by default, with an explicit annotation override. That is the strong_migrations `safety_assured` pattern, or Atlas's `-- atlas:nolint`.

### Gaps
- I did not verify whether Atlas's SQLite driver detects a 12-step rebuild as a "table dropped" or "rename". It likely does flag DROP/RENAME statements, but I did not confirm this.
- I did not confirm `atlas migrate lint --latest` / `--git-base` flag semantics. The analyzers page doesn't document them.

## 3. SQLite-specific constraints

### Takeaway
SQLite ALTER TABLE supports only RENAME TABLE, RENAME COLUMN, ADD COLUMN, DROP COLUMN (3.35+), and ALTER COLUMN SET/DROP NOT NULL (new in 3.53.0, April 2026). Anything else needs the 12-step rebuild, which drops and replaces the table. A rebuild is atomic for readers, because DDL is transactional, but it is a contract operation from the old code's point of view whenever it removes, renames or tightens anything. ADD COLUMN costs no row rewrite and is the main N-1-safe tool.

### Cited Findings
**ADD COLUMN rules**
- The new column:
  - may not be PRIMARY KEY or UNIQUE
  - may not default to CURRENT_TIME/DATE/TIMESTAMP or a parenthesised expression
  - if NOT NULL, must have a non-NULL default
  - if FKs are enabled and it has a REFERENCES clause, must default to NULL
  - may not be GENERATED … STORED (VIRTUAL is allowed)
  - [SQLite ALTER TABLE](https://www.sqlite.org/lang_altertable.html)
- Since 3.37.0 (2021-11-27), CHECK constraints (and NOT NULL on generated columns) are tested against existing rows, and ADD COLUMN fails if any row fails. [SQLite ALTER TABLE](https://www.sqlite.org/lang_altertable.html)
- Renames and unconstrained column additions change only the schema text, so they take constant time regardless of table size. A CHECK addition reads every row. DROP COLUMN rewrites every row. [SQLite ALTER TABLE](https://www.sqlite.org/lang_altertable.html)

**DROP COLUMN rules**
- It fails if the column is:
  - a PK or part of one, UNIQUE, or indexed
  - in a partial-index WHERE clause
  - in another CHECK, a FK, a generated-column expression, a trigger or a view
- SQLite edits the CREATE TABLE text and reparses the whole schema. [SQLite ALTER TABLE](https://www.sqlite.org/lang_altertable.html)

**RENAME and legacy_alter_table**
- RENAME COLUMN updates the table, indexes, triggers and views. It fails, with no changes applied, if the rename would create ambiguity. [SQLite ALTER TABLE](https://www.sqlite.org/lang_altertable.html)
- Since 3.25.0, RENAME TABLE rewrites references in triggers and views. Since 3.26.0, FK parent references are always rewritten unless `legacy_alter_table=ON`. [SQLite ALTER TABLE](https://www.sqlite.org/lang_altertable.html)
- `legacy_alter_table` is per-connection, does not persist, and defaults to OFF. "New applications should leave this flag turned off." [SQLite PRAGMA](https://www.sqlite.org/pragma.html)

**ALTER COLUMN NOT NULL**
- `ALTER TABLE … ALTER COLUMN` (SET/DROP NOT NULL) was added in 3.53.0 (2026-04-09). [SQLite ALTER TABLE](https://www.sqlite.org/lang_altertable.html)

**The 12-step rebuild (verbatim order)**
1. `PRAGMA foreign_keys=OFF` if FKs are enabled.
2. BEGIN.
3. Save the indexes, triggers and views via `SELECT type, sql FROM sqlite_schema WHERE tbl_name='X'`.
4. CREATE TABLE new_X.
5. `INSERT INTO new_X SELECT … FROM X`.
6. DROP TABLE X.
7. `ALTER TABLE new_X RENAME TO X`.
8. Recreate indexes and triggers.
9. Drop and recreate affected views.
10. `PRAGMA foreign_key_check`.
11. COMMIT.
12. Re-enable FKs.

[SQLite ALTER TABLE](https://www.sqlite.org/lang_altertable.html)

- Order matters. Create new, then copy, then drop old, then rename new into place. Renaming the old table first "might corrupt references to that table in triggers, views, and foreign key constraints." [SQLite ALTER TABLE](https://www.sqlite.org/lang_altertable.html)
- The rebuild is needed for: dropping a column (when DROP COLUMN can't), reordering columns, adding or removing UNIQUE/PK, adding CHECK/FK/NOT NULL, and changing a datatype. [SQLite ALTER TABLE](https://www.sqlite.org/lang_altertable.html)
- A faster path edits `sqlite_schema` with `writable_schema=ON` and bumps `schema_version` by one. It suits removing CHECK/FK/NOT NULL and changing defaults. A syntax error "renders the database corrupt", so test on a blank DB first. [SQLite ALTER TABLE](https://www.sqlite.org/lang_altertable.html)

**Pragmas**
- `PRAGMA foreign_keys` "is a no-op within a transaction". It must be set outside BEGIN or SAVEPOINT. The default is OFF, and "applications should set the foreign key enforcement flag as required … and not depend on the default." [SQLite PRAGMA](https://www.sqlite.org/pragma.html)
- `defer_foreign_keys` delays FK enforcement until the outer COMMIT and switches itself off at each COMMIT or ROLLBACK. [SQLite PRAGMA](https://www.sqlite.org/pragma.html)
- `foreign_key_check` returns one row per violation. `integrity_check` "does not find FOREIGN KEY errors." `quick_check` is O(N) against integrity_check's O(N log N). [SQLite PRAGMA](https://www.sqlite.org/pragma.html)

**Schema versioning**
- `user_version` is an integer at header offset 60. "SQLite makes no use of the user-version itself." [SQLite PRAGMA](https://www.sqlite.org/pragma.html)
- `schema_version` is at offset 40 and auto-increments on every schema change. Writing it "can lead to incorrect answers and/or database corruption." It is always safe to read. [SQLite PRAGMA](https://www.sqlite.org/pragma.html)
- `application_id` is at offset 68 and identifies the file type. [SQLite PRAGMA](https://www.sqlite.org/pragma.html)

**How old code reacts to a schema change**
- With `sqlite3_prepare_v2/v3`, if the schema changes, `sqlite3_step()` automatically recompiles the statement and retries, up to `SQLITE_MAX_SCHEMA_RETRY` times. The legacy `sqlite3_prepare` returned SQLITE_SCHEMA instead. [sqlite3_prepare](https://www.sqlite.org/c3ref/prepare.html)

### Inferences
- **Rebuild vs old code.** A rebuilt table is semantically "the same table" only if it keeps every column N-1 reads or writes, with compatible types, and adds no constraint N-1's writes might violate. Old prepared statements re-prepare transparently (per the prepare docs). Statements that reference a dropped or renamed column fail at re-prepare, so the failure appears at runtime in the old process, not at migration time.
- **`SELECT *` and positional reads.** Code that uses `SELECT *` with positional mapping, or `INSERT INTO t VALUES (...)` without a column list, breaks when a rebuild reorders columns or an ADD COLUMN appends one. A linter or codegen rule should require explicit column lists so ADD COLUMN stays N-1-safe. This is inferred, not directly sourced.
- **Transactional DDL.** SQLite DDL is transactional. The 12-step procedure itself wraps CREATE/INSERT/DROP/RENAME in one BEGIN…COMMIT. So each numbered migration file should run in a single transaction, together with the bookkeeping row or `user_version` bump, which makes a crash mid-migration atomic. The exception is that the `foreign_keys` pragma must be toggled outside the transaction. The migration runner needs a per-file "requires FK off" flag, plus a `foreign_key_check` before COMMIT.
- **`user_version` vs a migrations table.** `user_version` is a single integer in the header: cheap, atomic with the transaction, and readable without parsing tables. It cannot record which named migrations ran, their checksums, or out-of-order application. A `schema_migrations(id, name, checksum, applied_at, app_version)` table can, and the updater can query it to compute exactly which migrations N+1 would add.
  - Recommended: use both. Set `user_version` as a fast "schema generation" guard, and keep the table for audit and checksums.
  - Optionally set `application_id` so tooling can identify a Skiff DB.
- **Downgrade guard.** Once a rollback window closes, an older binary started on a newer DB should refuse to start. Forgejo/Gitea do this. Within the rollback window, N-1 must accept a schema one step newer. So the guard should be "refuse if DB schema > my_max_tolerated", where each release declares the schema generations it tolerates, rather than "refuse if DB schema ≠ mine".
- **Better Auth.** Per its docs, `getMigrations()` only reports `toBeCreated` tables and `toBeAdded` columns. It appears additive-only, which is N-1-safe in principle, but it bypasses Skiff's numbered-migration linter and is not recorded in Skiff's migrations table. [Better Auth database docs](https://www.better-auth.com/docs/concepts/database)
  - The updater should run Better Auth's diff in preflight on the snapshot copy and treat any non-empty plan as a migration subject to the same rules.
  - Better still, generate Better Auth SQL into numbered migration files (`npx @better-auth/cli generate`) so a single runner owns the schema.

### Gaps
- I found no sqlite.org statement on the default `SQLITE_MAX_SCHEMA_RETRY` value.
- I did not verify Bun's `bun:sqlite` prepare and re-prepare behaviour. It presumably uses `prepare_v3`, but this is unverified.
- I did not verify which SQLite version Bun bundles, so whether 3.53 `ALTER COLUMN` is available to Skiff is unknown.
- Better Auth docs don't say whether it ever alters or drops columns, or whether it records migrations anywhere.

## 4. Rollback strategies compared, and what mature self-hosted products do

### Takeaway
Mature self-hosted products overwhelmingly do forward-only migrations, with "restore the pre-upgrade backup" as the only downgrade path. Gitea/Forgejo and Sentry fit this. GitLab relies on multi-version compatibility instead of down migrations. Mattermost is the notable exception: it ships down-migration SQL in the newer binary (`mattermost db downgrade`) and does not recommend going back more than one major version.

For lossless rollback, the most robust approach is "release N-1 must tolerate schema N". It is enforced by expand-only pre-migrations, so rolling back is just "start the old binary on the current DB" with no restore and no data loss. Snapshot restore should be the last-resort path for a migration that is itself broken.

### Cited Findings
- **Gitea/Forgejo** refuse to start when the DB version is newer than the binary. The error says the DB belongs to a newer release and tells the user not to edit the version by hand. The suggested path back is restoring the backup. Very old DBs must first upgrade to an intermediate version (v1.6.4). [Forgejo migrate.go mirror](https://git.fb1.uni-bremen.de/davrot/forgejo_backup/src/branch/landingpagedetails/models/forgejo_migrations/migrate.go). This comes from source-code mirrors, not official docs.
- **Mattermost** downgrades by stopping the service, running `mattermost db downgrade 128,127,126` with the *newer* binary (it "contains the downgrade SQL"), reverting config, then swapping in the older binary. `--save-plan` at upgrade time writes a plan file with "both forwards and backwards SQL scripts", which "allows you to use older versions of Mattermost to perform the downgrade". "We don't recommend downgrading more than one major version back." [Mattermost downgrade docs](https://docs.mattermost.com/administration-guide/upgrade/downgrading-mattermost-server.html)
- **Sentry self-hosted** documents no rollback or downgrade. It has hard stops and monthly CalVer releases, and says "If you upgrade infrequently, it's less likely that upgrading to the latest version will work." [Sentry self-hosted releases](https://develop.sentry.dev/self-hosted/releases/)
- **GitLab** requires each version to work with the adjacent schema for one monthly release, and drops data only in post-deploy migrations a release later. That is what makes mixed-version operation, and so rollback of code, possible. [GitLab multi-version compatibility](https://docs.gitlab.com/development/multi_version_compatibility/)
- **Sourcegraph** (a related self-hosted product) warns that schema downgrade alone isn't always enough. A newer version may have rewritten data in a format the old one can't read. [Sourcegraph rollback docs](https://docs-legacy.sourcegraph.com/admin/how-to/rollback_database) (via search snippet; not fetched in full)
- **Down migrations in other tooling.** One project notes down migrations shouldn't run automatically because of data-loss risk ([The Lounge commit](https://git.omada.cafe/crystals/thelounge/commit/3be805bd38018f4fa83778f00063b58746bfb175)). golang-migrate users note that failed SQLite migrations leave a "dirty" version that must be forced back by hand ([golang-migrate discussion](https://github.com/golang-migrate/migrate/discussions/701)).
- **Litestream point-in-time restore**
  - Use `litestream restore -timestamp <ts>` or `-txid <hex>` (inclusive). The `-timestamp` boundary is exclusive. [Litestream restore](https://litestream.io/reference/restore/)
  - Granularity is whole LTX files. Files that overshoot the target are skipped, so "not every transaction is a valid restore point". Granularity coarsens from L0 to L1 as L0 files expire. Use `-dry-run` and `litestream ltx -level all` to check targets. [Litestream restore](https://litestream.io/reference/restore/)
  - Restore refuses an existing non-empty output file unless `-force` (v0.5.12) is given. Each restore needs a new path. `-integrity-check` arrived in v0.5.10. The current model is v0.5.x LTX, and v0.5.7+ can read v0.3.x backups. [Litestream restore](https://litestream.io/reference/restore/)
- **Stripe dual-write** keeps old and new stores consistent through every intermediate step. This is the general technique for making a data-model change reversible until the final "remove old data" step. [Stripe](https://stripe.com/blog/online-migrations)

### Inferences
| Strategy | Data loss on rollback | Fit for Skiff |
|---|---|---|
| Down migrations (Mattermost style) | Loses data in new columns/tables; fails if N wrote data N-1 can't represent | Possible, but must be authored and tested per migration; must run from the *new* binary, or from a saved plan |
| Forward-only + snapshot restore (current Skiff) | Loses every write since the switch | Fine as a last resort for a broken migration; unacceptable as the normal rollback |
| Litestream PITR | Same as snapshot, with finer-grained choice of point; still loses post-switch writes | Better for disaster recovery than for rollback |
| N-1 tolerates schema N (expand-only pre-migrations, GitLab model) | None. Old binary runs on the current DB; data in new columns sits ignored | Best default. Requires the lint rules in section 2 and the N-1 CI test in section 5 |
| Dual-write (Stripe) | None during the transition | Only for model changes (rename, split table); costs code |

- Recommended updater policy:
  1. Preflight classifies pending migrations. If all are expand-only, rollback is "stop N, start N-1 on the same DB", with no restore.
  2. If any contract or rebuild is pending, either refuse it (it belongs in a later release) or mark the update "rollback = restore snapshot (data loss window)" and require explicit operator consent.
  3. Keep the snapshot anyway for broken-migration cases, but restore it only if the migration itself failed (the DB is untouched because of the transaction) or if N-1 fails health checks on the new schema.
  4. Run contract migrations only after N is "committed", meaning N-1 can no longer be selected for rollback. Ideally run them at the start of N+1 as "post" migrations, mirroring GitLab.
- Writes made in new columns during the window are preserved but ignored by N-1. On roll-forward again they're still there, so "lossless" holds as long as N-1 doesn't write rows that violate N's invariants. Example: N-1 inserts rows with NULL in a column that N assumes is populated. N must tolerate the nulls that N-1 can create, or run an idempotent backfill on every boot.
- Snapshot restore is lossless only if the updater can replay or diff writes, which is not realistic for a general DB. An alternative is to quiesce writes (read-only mode) during the health-check window, which makes restore lossless at the cost of brief write unavailability.

### Gaps
- I found no official Gitea/Forgejo docs page on downgrade or restore. Evidence is from source-code mirrors.
- I found no Discourse documentation on rollback or downgrade.
- I did not find the Sentry self-hosted backup/restore procedure.
- I have no direct source for how 37signals ONCE products handle rollback.

## 5. Testing migrations before cutover (prod-copy runs and N-1 compatibility in CI)

### Takeaway
The pieces exist: SQLite copies are cheap (VACUUM INTO, or the backup API), Litestream can restore to a new path, and Atlas has CI lint. I found no product that documents a formal "run the old binary against the new schema" CI gate. That is an inferred best practice, implied by GitLab's multi-version rules. For Skiff it is straightforward because both binaries and the DB are local files.

### Cited Findings
- Restore needs a fresh output path and refuses existing files without `-force`, which suits restoring a production copy to a scratch path for testing. `-integrity-check` is available from v0.5.10. [Litestream restore](https://litestream.io/reference/restore/)
- `PRAGMA integrity_check` returns 'ok' if clean but does not find FK errors, so pair it with `PRAGMA foreign_key_check`. [SQLite PRAGMA](https://www.sqlite.org/pragma.html)
- Data-dependent migration failures are what to look for on a prod copy:
  - Atlas MF101/MF103/MF104: unique index, non-nullable add, nullable to non-nullable. [Atlas analyzers](https://atlasgo.io/lint/analyzers)
  - SQLite ADD COLUMN with a CHECK fails if existing rows violate it (3.37+). [SQLite ALTER TABLE](https://www.sqlite.org/lang_altertable.html)
- Mattermost's `--save-plan` lets admins review forward and backward SQL before committing. [Mattermost downgrade docs](https://docs.mattermost.com/administration-guide/upgrade/downgrading-mattermost-server.html)
- Atlas lint runs in GitHub Actions or GitLab CI and exits 1 on destructive changes. [Atlas analyzers](https://atlasgo.io/lint/analyzers)
- GitLab's background-migration guidance assumes code must tolerate a week of incomplete migration, which a test matrix should cover. [GitLab multi-version compatibility](https://docs.gitlab.com/development/multi_version_compatibility/)

### Inferences
Proposed tests, none from a single source:

- **Preflight on device**, before switching:
  1. `VACUUM INTO '/tmp/preflight.db'`, or open a copy of the snapshot.
  2. Run N's migrations plus Better Auth's `runMigrations()` on the copy, all in one transaction.
  3. Run `PRAGMA integrity_check`, `PRAGMA foreign_key_check` and the lint classifier.
  4. Boot N against the copy in a sandbox, on a different port and with no side effects, and hit its health endpoint.
  5. Boot N-1 against the same migrated copy and hit its health endpoint plus a small smoke suite.
  6. Fail the update if either boot fails.
- **CI N-1 gate**, per release:
  - Check out tag N-1, build it, and run its integration test suite against a DB migrated by HEAD.
  - Also run HEAD's suite against a DB migrated by HEAD and then written to by N-1.
  - This catches "old code inserts NULL into new NOT NULL column" and "new code can't handle rows written by old code".
- **Schema snapshot diff in CI:**
  - Dump `sqlite_schema` after migrating from empty, and after migrating from the N-1 schema plus fixtures.
  - Assert both are identical, so the from-scratch and upgrade paths converge.
  - Assert the diff from N-1 contains only allowed classes.
- **Fixture realism.** Use a sanitised prod-shaped fixture (row counts, NULLs, duplicates) so MF-class failures show up.

### Gaps
- I found no published example of a self-hosted product running the N-1 binary against the new schema in CI, though GitLab's QA likely does something similar. I did not confirm this.
- I did not research tooling for anonymised prod copies for SQLite.

## 6. Version skew rules: skippable versions and required upgrade stops

### Takeaway
Products with long-lived self-hosted installs publish required "upgrade stops":
- GitLab: x.2, x.5, x.8, x.11 since 17.5
- Sentry: hard stops
- Gitea/Forgejo: intermediate versions for very old DBs

Stops exist so that post-deploy and background migrations finish, and so that migration code and compatibility shims can be deleted. For Skiff, the updater should enforce a declared minimum "upgrade-from" version per release and walk through intermediate stops.

### Cited Findings
- **GitLab**
  - "Upgrade to the required upgrade stop after your current version", then "Allow the background migrations for the upgrade to finish", then repeat. [GitLab upgrade paths](https://docs.gitlab.com/update/upgrade_paths/)
  - Since 17.5, stops are at x.2.z, x.5.z, x.8.z and x.11.z "to provide a predictable upgrade schedule." Current stops are 18.2, 18.5, 18.8, 18.11, and 19.2, 19.5, 19.8, 19.11. Earlier stops were ad hoc, for example 17.11.7, 17.8.7, 17.5.5, 17.3.7 and 17.1.8 (conditional). [GitLab upgrade paths](https://docs.gitlab.com/update/upgrade_paths/)
  - Always use the latest patch of a stop (16.8.7, not 16.8.0). [GitLab upgrade paths](https://docs.gitlab.com/update/upgrade_paths/)
  - Zero-downtime compatibility covers one monthly release. Users who skip releases accept some downtime, but the deployment must still reach a good state. [GitLab multi-version compatibility](https://docs.gitlab.com/development/multi_version_compatibility/)
- **Sentry self-hosted**
  - Hard stops: 9.1.2, 21.5.0, 21.6.3, 23.6.2, 23.11.0, 24.8.0, 25.5.1, 26.5.0, 26.7.0. They exist because they carry significant database changes.
  - Monthly CalVer, no backported patches. "The best upgrade interval is every month." [Sentry self-hosted releases](https://develop.sentry.dev/self-hosted/releases/)
  - A third-party guide lists releases to avoid for migration issues (25.9.0, 25.12.0, 26.3–26.4). Treat that as unverified. [SSD Nodes](https://www.ssdnodes.com/learn/lang/de/self-hosted-error-tracking-sentry-alternatives)
- **Gitea/Forgejo** require very old DBs to go through an intermediate version (v1.6.4) before auto-migration. [Forgejo migrate.go mirror](https://git.fb1.uni-bremen.de/davrot/forgejo_backup/src/branch/landingpagedetails/models/forgejo_migrations/migrate.go)
- **Mattermost** advises not downgrading more than one major version. [Mattermost](https://docs.mattermost.com/administration-guide/upgrade/downgrading-mattermost-server.html)

### Inferences
- Each Skiff release manifest should declare:
  - `min_upgrade_from` (the oldest version whose DB this release's migrations can migrate safely)
  - `rollback_target` (normally the immediately previous installed version)
  - `schema_tolerance` (the range of schema generations this binary can run on)
- The updater should then:
  - refuse to jump past a required stop, auto-chaining through stops instead
  - allow rollback only to a version whose `schema_tolerance` includes the current DB generation
- Rule for release engineering: contract migrations for changes expanded in N may ship in N+1 at the earliest. Once a release containing contract migrations is committed, rolling back below it falls back to snapshot restore. Making those releases periodic, predictable stops (the GitLab x.2/x.5/x.8/x.11 model) keeps the lossy-rollback situations rare and visible.
- Skipping releases is only safe if every pending "post" migration in the skipped range runs before the next release's "pre" migrations. Discourse's skip-flag failure shows what happens when they don't. So the runner must always apply pending post migrations from older releases first.

### Gaps
- GitLab's page says stops exist "because there are fixes for issues relating to the upgrade process". It doesn't explicitly say that migrations are squashed or finalized at stops, though that is widely understood. I did not confirm it from a primary source.
- I did not research Mattermost's required-upgrade or ESR skip rules.
