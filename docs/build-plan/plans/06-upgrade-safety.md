# 06 — Upgrade safety: snapshots, rollback, and major-version guard

**Priority:** P0 · **Effort:** S–M · **Lane:** A · **Wave:** 1
**Depends on:** F1 contracts, 01 backups (snapshot hook), 05 backup target (soft)
**Blocks:** nothing, but required before the 0.5 release
**Primary files:** `scripts/install/main.ts`, `apps/control-plane/src/lib/server/self-update.ts`,
`packages/core/src/maintenance.ts`, `docs/OPS.md`

## Goal

Make a bad update recoverable. Before any control-plane or managed-data upgrade, take a verified
snapshot, record the release/migration version, check compatibility, and offer one-command rollback
that includes the control DB, secrets, and data. Refuse unsafe Postgres major-version changes.

## Non-goals

- Zero-downtime control-plane upgrades.
- Automatic Postgres major upgrades without an operator.
- A general package manager or arbitrary version pinning.
- Multi-node rolling upgrades.

## Current state

- The installer has `--upgrade`, a snapshot, an atomic release switch, and rollback. The in-process
  updater is pending (`docs/ROADMAP.md`).
- `apps/control-plane/src/lib/server/self-update.ts` exists; the dashboard exposes update/rollback.
- There is no data-layer compatibility check, no managed-data pre-upgrade snapshot, and no
  major-version guard for Postgres.
- Coolify's failure modes are the design input: `coolify-db` corruption, broken Redis, no working
  rollback, PG18 path changes, and image-tag changes that brick volumes.

## Design

### Upgrade preflight

`UpgradeService.preflight()` returns a plan:

- Current version, target version, release channel, migration list, and whether any migration is
  destructive.
- Control DB size, backup target reachability, free disk, and last verified restore age.
- Managed data: Postgres versions, `pg_upgrade` required?, RustFS version, volume mounts healthy.
- `/readyz`: app version, schema version, helper version, agent version, Podman/Quadlet, backup
  target, data dirs.
- Refuse if: backup target unreachable, free disk < 2× DB size, any data volume missing, or a
  Postgres major change is requested without the wizard.

### Snapshot and rollback

- Before the release switch:
  1. Snapshot the control SQLite via the existing Litestream/LocalObjectStore path.
  2. Copy `.env`, APP_KEY, and platform config to a sealed, versioned archive.
  3. Record the helper/agent versions and the desired-state version.
  4. For managed data, run the pre-upgrade backup from 01 (if enabled) or a volume snapshot from 07.
- If the new release fails `/readyz` or a smoke test:
  - Switch back to the previous release; restore the control snapshot only if the schema changed
    incompatibly; restart agents; re-verify.
  - Never restore data automatically; surface the artifact and require a human decision.
- Keep the last N upgrade snapshots; pin the pre-upgrade one until the next successful upgrade.

### Postgres major-version guard

- `DatabaseService.update` rejects a `version` change that crosses a major.
- Add `POST /databases/:name/upgrade` with a plan:
  - Preflight: backup, disk, extension compatibility, `pg_upgrade --check`.
  - Execute: stop consumers, run `pg_upgrade` (or dump/restore), verify, start, run canary.
  - Rollback: keep the old data dir until the new one passes; re-point on failure.
- If `pg_upgrade` is not available in the image, use dump/restore and document the downtime.
- Do not auto-upgrade on image tag change; pin the major and require an explicit request.

### Channels

- `stable` and `edge` channels; stable is the default. Edge gets a warning and a shorter support
  window.
- Dashboard shows release notes, migration count, and the rollback point.
- `/api/setup/status` exposes `channel`, `version`, `ready`, `lastUpgradeSnapshot`.

## Implementation order

1. `/readyz` + version/schema/helper checks (contract PR).
2. Preflight service + CLI `skif upgrade plan`.
3. Snapshot bundle (control DB, env/APP_KEY, config) + retention.
4. Self-update flow uses preflight/snapshot/readyz/rollback.
5. Postgres major guard in `DatabaseService.update`.
6. `upgrade` wizard (plan/apply/rollback) for Postgres.
7. Dashboard release/rollback panel; docs.

## Acceptance criteria

- [ ] An upgrade to a deliberately broken release fails `/readyz` and rolls back automatically.
- [ ] The rollback restores the control DB, `.env`, and APP_KEY; the dashboard is reachable.
- [ ] A pre-update snapshot is retained and listed; the operator can download it.
- [ ] Changing a Postgres image from 16 to 17 is refused with a clear message and a wizard link.
- [ ] The wizard backs up, upgrades, verifies a canary, and can roll back to the old data dir.
- [ ] The upgrade preflight refuses when the backup target is unreachable or disk is insufficient.
- [ ] No data restore happens automatically; the UI always asks.

## Tests

- Unit: version comparison, preflight rules, snapshot retention, rollback selection.
- Integration: fake release that fails health; migration failure; rollback; missing backup target.
- Real node: Debian 13, control DB with real rows, upgrade/rollback, Postgres 16→17 on a fixture.
- Security: snapshot encrypted/sealed; `.env` not world-readable; audit upgrade/rollback.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Rollback does not cover data | Snapshot bundle includes control DB + secrets; data artifacts listed separately |
| `pg_upgrade` fails midway | Keep old data dir; pre-upgrade backup; typed confirmation; do not delete until verified |
| Migration is irreversible | Preflight marks destructive migrations; require explicit approval |
| Snapshot fills disk | Retention + free-space check + target offload |
| Channel confusion | Stable default; edge warning; version visible |

## Rollout

Ship `/readyz` and preflight first; enable automatic rollback for the control plane only. The
Postgres wizard stays opt-in until tested on Debian 13. Keep `SKIFF_FEATURE_UPGRADE_ROLLBACK` off
until the integration test passes.

## Open questions

- Can the installer snapshot `.env`/APP_KEY without root? It already runs as root.
- Do we support downgrade across a schema change? No; restore the snapshot instead.
- Is `pg_upgrade` available in the Postgres alpine images? Verify; fall back to dump/restore.

## File ownership

Own: `apps/control-plane/src/lib/server/self-update.ts`, `scripts/install/main.ts` (upgrade path),
`packages/core/src/upgrades.ts` + test, `docs/OPS.md`.

Integration-owned: `/readyz` route, schema/migration, core context/index, dashboard settings,
CLI registration, e2e harness.
