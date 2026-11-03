# Skiff — Roadmap

## v0: Spikes (de-risk first). Results: [SPIKES.md](./SPIKES.md)
- [x] DuckDB (`@duckdb/node-api`) under Bun: ingest + time-bucket query + Parquet export
- [x] Better Auth MCP/OAuth provider: CIMD + DCR, PKCE, consent with permission subsets, scope step-up (e2e 15/15)
- [x] MCP human confirmation via multi-round-trip input (2026-07-28); dashboard hand-off for 2025-era clients
- [x] Caddy admin API over a unix socket: route upsert, `forward_auth` → agent, `precompressed br gzip`
- [x] SvelteKit 3 + adapter-bun (unix socket behind Caddy) + shadcn-svelte
- [ ] Litestream → R2 + scripted restore (needs R2 credentials)
- [ ] Re-measure RSS on Debian 13; connect real Claude Code / Claude.ai to a deployed instance

## v1: Static platform
**Foundation**
- [x] Monorepo: `control-plane`, `agent`, `cli`, `contracts`, `core`, `site-config`, `db`
- [x] Drizzle schema: orgs, members, roles, projects, uploads, releases, config snapshots, deployments, nodes, share links, audit log, quotas, domains (table only)
- [x] Service layer with RBAC checks used by every surface

**Nodes**
- [x] Agent: desired-state pull, on-disk cache, heartbeat, static driver (atomic release symlinks)
- [x] Caddy management via admin API (unix socket), wildcard DNS-01 cert
- [x] Node join flow (`skiff-agent join`), single-node mode over a unix socket; WireGuard itself is host provisioned
- [x] Edge proxy failures serve a branded 503 + `Retry-After` (active health checks and static mirror remain v2)

**Deploy**
- [x] Upload sessions: inline `deploy_files` (≤5 MB) and presigned R2 upload
- [x] Finalize: limits, `_redirects` / `_headers` / `skiff.json` parse + compile, sha256, precompress
- [x] Deployments with preview URLs, production pointer, promote/rollback, retention GC
- [x] Slug rules, reserved names, collision suggestions, rename redirects

**Access**
- [x] Better Auth: passkeys, GitHub, 2FA, orgs + access control, admin, API keys, OAuth provider
- [x] Protected sites (`public / password / platform`) via `forward_auth` → agent
- [x] Share links with limits + revocation push
- [x] Two-domain and shared-domain modes (with mandatory hardening)

**MCP & CLI**
- [x] MCP server: tools per DESIGN §6.3, annotations, resources/guides, elicitation for deletes
- [x] `skif` CLI (npm `skif`, commands `skif` + `skiff`): login, deploy (presigned), status

**Ops**
- [x] Agent telemetry: pre-aggregated access buckets → DuckDB; rollups + Parquet to R2 (OTLP wire export remains)
- [x] Dashboard: fleet, projects, deployments, traffic/errors, audit log (live logs arrive with v2 runtime)
- [x] Prometheus `/metrics` on control plane and agents (optional OTLP exporter remains)
- [x] Alerts: email (SES SMTP) + webhook
- [x] Backups: Litestream config → R2, recovery kit, restore script, monthly restore drill (needs R2 credentials to run)

**Release**
- [x] CI: signed releases (control plane, agent, prebuilt Caddy)
- [x] `install.sh` + hosted release bundle
- [ ] Browser setup wizard (first-user sign-up and `/api/setup/status` are backend-complete)
- [ ] Self-update with snapshot, migrations, health check, auto-rollback (installer upgrade path + rollback exist; in-process updater pending)

## v2
- [ ] Tier 2 process apps (sandboxed systemd units, privileged helper, socket activation), placeable on any node including the edge (D41)
- [ ] `skiff-workloads.slice` budget per node, deploy-time admission, runtime-aware `auto` placement
- [ ] Env vars & secrets UI/API/MCP (design already in place)
- [ ] Tier 3 containers (Podman Quadlet)
- [ ] Git builds on the homelab Builder + GitHub webhooks
- [ ] Custom domains (TXT verify, on-demand TLS, Cloudflare auto-records, apex↔www)
- [ ] `ObjectStore`: local fs, Garage/MinIO, multi-target replication
- [ ] Optional `docker` runtime driver
- [ ] Named environments (staging, …)

## Later / maybe
- Backup ingress (Cloudflare Tunnel from the homelab + DNS failover)
- Importing external Prometheus datasources
- Custom roles UI
- Templates/scaffolding tool for agents
