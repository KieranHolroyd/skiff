# Fix wave: complete (2026-11-07)

All 21 work packages from the documentation audit are implemented end to end (core → REST →
CLI/MCP → dashboard → docs), in two waves of agents. Everything is still **uncommitted** in the
shared working tree, alongside other sessions' work.

State at the end:

- `bun scripts/check-migrations.ts`: ok (66 migrations, gap-free). The unreleased 0052–0066 range was
  renumbered; every old id is aliased in `packages/db/src/index.ts`, so dev databases that applied
  the old names are fine.
- `bun test`: 3,843 pass, 0 fail.
- `bun run check`: clean except one type error in `packages/core/src/node-tasks.test.ts:114`, an
  untracked file from another session (the test passes at runtime).
- `docs/DECISIONS.md`: D58, D97, D103 and D111 amended; D129–D142 added for this work. The
  pre-existing duplicate D124 is left as is (IDs are never renumbered).
- `readme-tool-table.py` regenerates the README's MCP tool table from `mcp.ts`.
- `agent-brief.md` and `plans.md` are the briefs and designs the agents worked from.

## Off by default (deliberately)

| Feature | Flag | Why it stays off |
|---|---|---|
| App cron jobs and one-off jobs | `SKIFF_FEATURE_JOBS` | systemd/Podman sandbox not yet run on a real node |
| PostgreSQL PITR | `SKIFF_FEATURE_PITR` | Publish the `skiff-postgres-pitr` image, pin its digest in `packages/contracts/src/database.ts` and `apps/helper/src/validate.ts`, then pass `scripts/pitr-drill.sh` on Linux |
| Blueprints apply | `SKIFF_FEATURE_BLUEPRINTS` | New; needs a real-node apply |
| Automatic replica promotion | `SKIFF_FEATURE_DB_AUTO_PROMOTE` | No self-fencing for a cut-off primary |
| Failover controller | `failover.enabled` (cluster config) | Off by default; drains still move copies |

## Needs a live check (could not run on the Mac)

- **Read replicas:** pg_basebackup and the walreceiver through the read-only socket mount; the
  `pg_hba` rule; cross-node streaming over mTLS with the new firewall ranges; promotion, data-dir
  rename, old-primary purge; cross-node `READ_URL`.
- **PITR:** Quadlet `RunInit=true`; uid 70 reading the `:ro,z` config dir under AppArmor/SELinux;
  archive-push/get against S3, R2 and RustFS; full/diff/incr backups; restore on volume and
  state-dir targets; config restored after a reboot; amd64 under Podman.
- **Jobs:** systemd-run properties (empty capability sets, LoadCredential, BindPaths); `$` handling on
  systemd 252 vs 254+; dynamic uid shared with the app; Podman `--userns=container:` with
  `--cgroups=split`.
- **Containers:** `UserNS=auto` from the `containers` range; `:U` re-owning mounts across restarts;
  `ro,Z,U` secrets.
- **Volumes:** `systemctl freeze/thaw`; reflink on btrfs/XFS vs ext4 fallback; tar round trip;
  streaming to presigned S3 URLs.
- **Storage:** RustFS restarting with a rotated root key (IAM survival); replication through a
  worker's gateway with the `Host` header; the S3 operations the copier relies on.
- **Failover:** a real node loss with `MULTI_NODE_REPLICAS`; lease handover between two control
  planes during an update; Caddy accepting a non-5 s health interval.
- **Master key:** `systemd-creds encrypt --tpm2-pcrs=` (empty); empty `LoadCredential=` in a drop-in;
  installer sealing an existing prod key; `skiff-rotate-master-key` end to end; `skiff-uninstall`.
- **Valkey/Redis/ClickHouse backups:** `--rdb` and `check-rdb` on valkey 8.1/9.1 and redis 8;
  loading the AOF-base layout; ClickHouse `BACKUP`/`RESTORE` and `allowed_path`.
- **Email sandbox, password reset:** real SMTP delivery end to end; Better Auth's per-IP limits
  (production only).
- **Log drains:** real OTLP receivers; the delivery loop with a standby running.
- **Domains:** pending → verified → active on a real edge.

## Small known items

- The agent's built-in `SKIFF_DATA_DIR` default (`/var/lib/skiff-agent`) differs from the helper's
  replication-dir default (`/var/lib/skiff/agent/replication`). Installed hosts set
  `/var/lib/skiff/agent`, so they match; only hand-run agents would need
  `SKIFF_HELPER_REPLICATION_DIR`.
- Storage replication has no agent capability flag: an older agent silently ignores links and the
  rule stays `pending`.
- `docs/build-plan/README.md` still says "Rootless Podman/Quadlet" (historical plan, untouched).
