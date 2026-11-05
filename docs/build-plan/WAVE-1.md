# Wave 1 — remaining data-platform gaps

Base: `main` at `abe9982` (Wave 0 foundations merged; 985 tests green, 18 migrations).
The Wave 1 worktrees were created from `feat/wave0-foundations` and should be rebased onto
`main` before integration.

## Worktrees and assignments

| Plan | Worktree | Branch | Migration reservation |
|---|---|---|---|
| 05 backup target | `wave1-05-backup-target` | `feat/wave1-05-backup-target` | `0019_backup_targets.sql` (merged `b065c71`) |
| 01b PITR | `wave1-01b-pitr` | `feat/wave1-01b-pitr` | `0020_database_pitr.sql` (merged `b90e6f9`) |
| 02b bucket config | `wave1-02b-bucket-config` | `feat/wave1-02b-bucket-config` | `0021_bucket_config.sql` |
| 03b TLS + UX | `wave1-03b-tls` | `feat/wave1-03b-tls` | `0022_database_tls.sql` (only if needed) |
| 04b per-org isolation | `wave1-04b-isolation` | `feat/wave1-04b-isolation` | `0023_org_networks.sql` (only if needed) |
| 07 app volumes | `wave1-07-app-volumes` | `feat/wave1-07-app-volumes` | `0024_app_volumes.sql` |
| 16 quotas | `wave1-16-quotas` | `feat/wave1-16-quotas` | `0025_quotas.sql` |
| 06 upgrade safety | `wave1-06-upgrade` | `feat/wave1-06-upgrade` | `0026_upgrade_safety.sql` (only if needed) |

Migration numbers are reserved to avoid the `0015` collision from Wave 0. If an agent finds a
different latest migration, it stops and reports rather than renumbering silently.

## Existing flags to use

Do not add new flags in these branches:

| Plan | Flag |
|---|---|
| 05 | `BACKUPS_RESTORE` (already default on) |
| 01b | `PITR` (default off) |
| 02b | `OBJECT_BROWSER` (default on) |
| 03b | `DB_TLS` (default off) |
| 04b | `ORG_NETWORKS` (default off) |
| 07 | `APP_VOLUMES` (default off) |
| 16 | `QUOTAS` (default on) |
| 06 | no new flag; readiness/preflight is safe by default |

## Already shipped — do not rebuild

- Logical database backups, restore-to-new, retention, `verified_at`
- Object browser list/upload/download/delete/presign and private gateway
- Per-database PgBouncer sidecar
- Credential rotation
- Postgres extensions and slow-query sampling
- Node volumes for managed instances
- MCP database backup/restore/rotation tools

## Known gaps from merged work

- **05 backup targets:** `database_backups` has no `target_id`; resolution happens at operation
  time, so changing/deleting a target can re-point old rows and orphan artifacts. Litestream still
  uses env config, not `backup_targets`. Write-only targets skip retention deletes, so expired rows
  remain. These are follow-ups, not blockers for the default path.

## Merge order

1. **05 backup target** — storage primitive, no shared contract changes beyond `backup-target.ts`.
2. **01b PITR** — consumes the target; may need a rebase after 05.
3. **02b bucket config** — object-storage contract append; independent.
4. **03b TLS** — database/helper changes; independent.
5. **04b isolation** — workload/helper network changes; rebase after 03b if both touch helper.
6. **07 app volumes** — workload/helper mount changes; rebase after 04b.
7. **16 quotas** — independent service/API.
8. **06 upgrade safety** — depends on 05/01; merge last.

## Known integration conflicts

- `packages/db/src/schema.ts` — append-only marker blocks from every agent; resolve by keeping all
  blocks and regenerating `packages/db/src/migrations.ts` with `bun scripts/generate-migrations.ts`.
- `packages/core/src/context.ts` and `index.ts` — add every service; order does not matter.
- `apps/helper/src/units.ts` / `systemd.ts` — 03b (TLS), 04b (networks), 07 (volumes) all touch
  these; one integration owner must resolve, not three.
- `apps/agent/src/main.ts` — new task loops (PITR, volumes) hook in one place.
- `packages/contracts/src/index.ts` — exports only; keep all.
- `packages/contracts/src/features.ts` — no new flags; if an agent added one, convert it to an
  existing flag.
- `VERSION` — ignore agent patch bumps; keep the repo version.
- `.github/workflows/ci.yml` — F3/F5 already touched it; rebase, do not overwrite.

## Verification

```sh
bun install --frozen-lockfile
bun test
bun run check
bun run check:migrations
bun scripts/check-migrations.ts
SKIFF_E2E_ENGINE=none bun tests/e2e/managed-data.e2e.ts   # skip path
```

For a real run, use Docker/Podman:

```sh
SKIFF_E2E_ENGINE=docker bun tests/e2e/managed-data.e2e.ts
```

## After integration

- Regenerate migrations and confirm the sequence 0001–0025.
- Run the full suite and the e2e harness.
- Update `docs/build-plan/README.md` status board.
- Leave `feat/wave1-foundations` for review; do not merge into `main` while the main worktree is
  dirty.
