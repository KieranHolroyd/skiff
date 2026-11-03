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
- [ ] Monorepo: `control-plane`, `agent`, `cli`, `contracts`, `core`, `site-config`, `db`
- [ ] Drizzle schema: orgs, members, roles, projects, uploads, releases, config snapshots, deployments, nodes, share links, audit log, quotas, domains (table only)
- [ ] Service layer with RBAC checks used by every surface

**Nodes**
- [ ] Agent: desired-state pull, on-disk cache, heartbeat, `systemd` driver (static only)
- [ ] Caddy management via admin API (unix socket), wildcard DNS-01 cert
- [ ] WireGuard join flow (`skif agent join`), single-node mode over a unix socket
- [ ] Edge health checks + branded offline page; optional static mirror to edge

**Deploy**
- [ ] Upload sessions: inline `deploy_files` (≤5 MB) and presigned R2 upload
- [ ] Finalize: limits, `_redirects` / `_headers` / `skiff.json` parse + compile, sha256, precompress
- [ ] Deployments with preview URLs, production pointer, promote/rollback, retention GC
- [ ] Slug rules, reserved names, collision suggestions, rename redirects

**Access**
- [ ] Better Auth: passkeys, GitHub, 2FA, orgs + access control, admin, API keys, OAuth provider
- [ ] Protected sites (`public / password / platform`) via `forward_auth` → agent
- [ ] Share links with limits + revocation push
- [ ] Two-domain and shared-domain modes (with mandatory hardening)

**MCP & CLI**
- [ ] MCP server: tools per DESIGN §6.3, annotations, resources/guides, elicitation for deletes
- [ ] `skif` CLI (npm `skif`, commands `skif` + `skiff`): login, deploy (presigned), status

**Ops**
- [ ] Agent telemetry (OTLP) → DuckDB; access-log aggregation; rollups + Parquet to R2
- [ ] Dashboard: fleet, projects, deployments, traffic/errors, live logs, audit log
- [ ] `/metrics` + optional OTLP exporter
- [ ] Alerts: email (SES SMTP) + webhook
- [ ] Backups: Litestream → R2, recovery kit, `skif restore`, monthly restore drill

**Release**
- [ ] CI: signed releases (control plane, agent, prebuilt Caddy)
- [ ] `install.sh` + browser setup wizard (Cloudflare records incl. SES DKIM/SPF/DMARC)
- [ ] Self-update with snapshot, migrations, health check, auto-rollback

## v2
- [ ] Tier 2 process apps (sandboxed systemd units, privileged helper, socket activation)
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
