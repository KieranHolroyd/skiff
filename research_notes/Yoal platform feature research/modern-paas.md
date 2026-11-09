# Modern PaaS feature research for Yoal (November 2026)

Scope: Render, Railway, Fly.io, Heroku and Northflank, researched 4 November 2026 from official docs, pricing/limits pages, changelogs and product pages. Focus is runtime workloads, data services and operations, translated to a self-hosted, single-operator platform that deliberately avoids Kubernetes.

Method note: product docs are living pages and mostly undated; changelog entries dated 2026 were used to confirm currency. Beta/preview status is marked where the source marks it. Complexity is my estimate for one experienced engineer: **small** ≤ ~1 week, **medium** ~2–6 weeks, **large** > ~6 weeks. I read Yoal's `README.md` only, not its implementation, so "Yoal gap" means "not described in the README", not "definitely absent".

## 1. Apps and services: process/container deploys, builds, health, zero-downtime, scaling, regions, sleep

### Takeaway
All five platforms have converged on the same core: an immutable build artifact, multiple workload types from one repo (web/worker/cron), health-gated rollout, and one-click rollback. The features that most distinguish them in 2026 are process groups, pre-deploy release commands, blue/green and canary strategies, and scale-to-zero — not broader language support. Yoal's systemd + Caddy model can reproduce most of this without Kubernetes; the biggest product gap is treating a release as one process rather than a set of process groups.

### Cited Findings

- **Railway** organises compute into three primitives: persistent services (long-running web apps, APIs, workers), cron jobs, and single-file TypeScript functions; a service is a container deployed from a GitHub repo, local directory, or Docker image. — [Railway Build & Deploy](https://docs.railway.com/build-deploy); [Railway Services](https://docs.railway.com/services)
- **Railway** auto-uses a Dockerfile when present, otherwise builds with Railpack/Nixpacks; it also monitors Docker image tags, can stage image updates on a schedule inside a maintenance window, and warns that volume-attached services may see brief downtime (typically under 2 minutes) on update. — [Railway Services](https://docs.railway.com/services)
- **Railway** "Serverless" (formerly App Sleeping) puts a service to sleep after 5–10 minutes without *outbound* packets; the first request wakes it and may return a 502; the setting is fixed at container creation, applies to all replicas, and keeping DB pools or telemetry connections open prevents sleep. — [Railway Serverless](https://docs.railway.com/reference/app-sleeping)
- **Railway** supports horizontal replicas across regions, vertical autoscaling, multi-region deploys, per-second billing, configurable health checks and region selection. — [Railway Features](https://railway.com/features); [Railway Build & Deploy](https://docs.railway.com/build-deploy)
- **Railway** documents Pro-plan service ceilings of 24 vCPU / 24 GB RAM and up to 42 replicas, with limits raisable on request; it explicitly says it is not suited to GPU or heavily regulated workloads. — [Railway Use Cases](https://docs.railway.com/platform/use-cases)
- **Render** has six code service types — web, static, private, background worker, cron, and Workflow (Workflows are labelled Early Access) — plus Postgres and Key Value. — [Render Service Types](https://render.com/docs/service-types)
- **Render** promises zero-downtime Git/registry deploys with automatic health checks and instant rollback, preview environments, and infrastructure as code via Blueprints or Terraform. — [Render Platform](https://render.com/platform)
- **Render** autoscales on target CPU and/or memory with min/max instances; manual scaling is available on all plans, autoscaling requires Pro or above, and autoscaling is disabled in preview environments. — [Render Blueprint Spec](https://render.com/docs/blueprint-spec); [Render Features by Plan](https://render.com/docs/platform-features-by-plan)
- **Render** expanded its compute catalogue in August 2026 (including 12-CPU service tiers and memory-optimised plans); the Blueprint reference lists service plans up to 12 CPU / 96 GB and Postgres plans up to 128 CPU / 1 TB RAM. — [Render Changelog, 26 Aug 2026](https://render.com/changelog/new-compute-plans-and-new-ids-for-existing-plans); [Render Blueprint Spec](https://render.com/docs/blueprint-spec)
- **Render** Blueprints expose monorepo controls (`rootDir`, `buildFilter.paths`, `buildFilter.ignoredPaths`), Docker `dockerfilePath`/`dockerContext`, pre-deploy and first-deploy hooks, and `maxShutdownDelaySeconds` (default 30, max 300). — [Render Blueprint Spec](https://render.com/docs/blueprint-spec)
- **Fly.io** runs hardware-isolated Firecracker microVMs ("Machines") in 18+ regions, with Fly Launch as the app lifecycle orchestrator and `fly.toml` as config. — [Fly.io](https://fly.io/); [Fly.io Essentials](https://docs.fly.io/getting-started/essentials)
- **Fly.io** defaults new `fly launch` apps to scale-to-zero: `auto_stop_machines = "stop"`, `auto_start_machines = true`, `min_machines_running = 0`; cold start is about 2 seconds or more, suspend/resume is a few hundred milliseconds, and stopped Machines are billed only for rootfs. — [Fly Autostop/Autostart](https://docs.fly.io/launch/autostop-autostart)
- **Fly.io** offers four deploy strategies — rolling (default), immediate, canary, and blue/green; canary and blue/green require health checks and cannot be used with attached volumes; rolling supports `max_unavailable`. — [Fly App Configuration](https://docs.fly.io/reference/configuration)
- **Fly.io** `release_command` runs a one-off task such as migrations in a temporary Machine on the new image before any Machine takes traffic; a non-zero exit fails the deploy, it has no volume access, and it times out after 5 minutes by default. — [Fly App Configuration](https://docs.fly.io/reference/configuration)
- **Fly.io** supports HTTP, TCP and command-based checks, plus `machine_checks` that run an integration-test container against a candidate Machine before a deploy. — [Fly App Configuration](https://docs.fly.io/reference/configuration)
- **Fly.io** `fly.toml` defines process groups (`processes`) that HTTP services and volume mounts can target, enabling web/worker splits from one app. — [Fly App Configuration](https://docs.fly.io/reference/configuration)
- **Heroku** runs code in dynos, uses the Procfile to declare process types so web, worker and clock processes scale independently, and supports buildpacks or Docker. — [Heroku Reference](https://devcenter.heroku.com/categories/reference); [How Heroku Works](https://devcenter.heroku.com/articles/how-heroku-works)
- **Heroku** added Cloud Native Buildpacks support on Cedar-generation apps in October 2026; Fir is the Kubernetes-powered generation, Cedar the legacy one, and a pipeline cannot mix generations. — [Heroku October 2026 Update](https://www.heroku.com/blog/october-2026-update-heroku-innovations-features/); [Heroku Pipelines](https://devcenter.heroku.com/articles/pipelines)
- **Heroku** Pipelines model development → staging → production, promote the *same build artifact* downstream, re-run the release phase on promotion, and create ephemeral Review Apps per pull request. — [Heroku Pipelines](https://devcenter.heroku.com/articles/pipelines)
- **Northflank** runs long-running services, one-off/scheduled jobs, and managed databases; builds accept Dockerfiles, Buildpacks, or prebuilt images, with monorepo and custom build-context support. — [Northflank Platform Features](https://northflank.com/features/platform); [Northflank Application Layer](https://northflank.com/features/application-layer)
- **Northflank** offers rolling or blue-green deployments, instant rollback, health-check-validated zero-downtime deploys, and CPU/memory/HTTP-metric autoscaling with min/max replicas. — [Northflank Platform Features](https://northflank.com/features/platform)
- **Northflank** also runs sandboxes and microVMs for untrusted/AI-generated code, and GPU workloads; these are adjacent products rather than requirements for a small self-hosted PaaS. — [Northflank](https://northflank.com/); [Northflank Changelog, 24 Sep 2026](https://northflank.com/changelog)

### Inferences
- Table stakes for Yoal v2: immutable release identity (image digest + config hash), health-gated activation, automatic rollback on failed health, graceful drain, and one-click rollback to any prior release. The README already implies releases/rollback and health checks, so the gap is depth and policy, not concept.
- "Process groups" is the single highest-leverage compute feature to add: one release should be able to declare `web`, `worker`, and `cron` commands with independent replica counts, ports, health checks and resource limits. Heroku's Procfile, Fly's `processes`, and Render's service types all validate this model.
- Yoal can implement blue/green with systemd transient units plus two Caddy upstream pools (old/new) and a weight switch; canary is the same mechanism with a percentage. No service mesh is required.
- Scale-to-zero is only safe for HTTP request/response workloads. Workers and cron should use a separate "suspend when idle" or "run to completion" policy. Railway's outbound-packet heuristic is a useful warning: telemetry and DB pools defeat naive idle detection.
- A volume-backed app cannot be zero-downtime with a single-writer volume. All three of Railway, Render and Fly enforce or document this constraint; Yoal should make it explicit in the UI and scheduler rather than pretending otherwise.
- Buildpacks are optional. Dockerfile support plus monorepo path filters and build caching delivers most of the value at lower complexity; Buildpacks can be a later compatibility feature.
- Durable multi-step workflows (Render Workflows) are a separate orchestration product and a poor fit for Yoal's footprint; skip until there is demand.

### Gaps
- Render's Workflows are labelled Early Access in the service-types article but got Blueprint support in September 2026; I could not confirm whether they are GA as of November 2026.
- Railway Functions are documented as a compute primitive but I found no limits/maturity page; treat as new.
- Fly's process-group semantics are documented in `fly.toml` reference but I did not fetch the full section; details such as per-process scaling commands were not verified.
- Northflank has no single consolidated limits page comparable to Render's; plan quotas were not verified.

## 2. Managed services: databases, object storage, backups/PITR, pooling, volumes, cron, workers, queues

### Takeaway
Every peer sells managed Postgres/Redis with backups, HA and pooling, and most now add object storage. For a self-hosted single-operator product the correct translation is **not** a multi-tenant DBaaS: it is a curated "database recipe" (image + volume + backup job + pooled connection string) plus first-class backup/restore verification. That preserves portability and avoids the operational burden that makes managed DBs expensive.

### Cited Findings

- **Railway** offers one-click templates for Postgres, Redis, MongoDB, ClickHouse and full stacks; it describes its databases as "managed in the sense that" Railway maintains templates and ships security patches, while the customer enables HA, backups and point-in-time recovery; there is no SLA by default. — [Railway Features](https://railway.com/features); [Railway Use Cases](https://docs.railway.com/platform/use-cases)
- **Railway** volumes are limited to one per service, cannot be used with replicas, force a small downtime on redeploy because only one deployment may mount the volume, support live resize, and support manual and automated backups. — [Railway Volumes](https://docs.railway.com/reference/volumes)
- **Render** Postgres includes point-in-time recovery (3 days on Hobby, 7 days on paid plans), high availability, up to five read replicas, storage autoscaling, PgBouncer connection pooling, and IP allowlists. — [Render Pricing](https://render.com/pricing); [Render Blueprint Spec](https://render.com/docs/blueprint-spec)
- **Render** Key Value is Redis-compatible; in October 2026 it added 3 GB and 50 GB plans with up to 50,000 simultaneous connections and lowered prices on plans above 1 GB. — [Render Changelog, 1 Oct 2026](https://render.com/changelog/added-two-key-value-plans-and-lowered-prices-for-larger-existing-plans)
- **Render** persistent disks are single-instance only, block autoscaling and zero-downtime deploys, cannot attach to cron jobs, and are snapshotted every 24 hours with 7-day retention. — [Render Disks](https://render.com/docs/disks)
- **Fly.io** Managed Postgres includes HA with automatic failover, backups/recovery, pooling, metrics, encryption, pgvector and PostGIS, 1 TB maximum storage, and five plans from $38 to $1,922/month; major-version upgrades are not in place and there is no automated migration from other databases. — [Fly Managed Postgres](https://docs.fly.io/postgres)
- **Fly.io** deliberately composes rather than owning every data service: Redis via Upstash, S3-compatible object storage via Tigris, and local NVMe via Fly Volumes; unmanaged "Fly Postgres" is explicitly unsupported. — [Fly Databases and Storage](https://docs.fly.io/database-storage-guides); [Fly Pricing](https://docs.fly.io/about/pricing)
- **Fly.io** volumes are hardware-local, attached to one Machine at a time, and support daily snapshots (default retention 5 days, max 60), scheduled-snapshot toggles, and automatic size extension thresholds. — [Fly App Configuration](https://docs.fly.io/reference/configuration)
- **Heroku** offers Heroku Postgres, Key Value Store, Apache Kafka, and 200+ add-ons installed from the dashboard or CLI with integrated billing and credentials. — [Heroku Products](https://www.heroku.com/products/); [Heroku Add-ons](https://www.heroku.com/elements/addons/)
- **Heroku Postgres Advanced** (labelled Limited GA, October 2026) decouples compute and storage, supports follower instance pools for read scaling, and consolidates databases into one cluster; the comparison table lists server-side connection pooling and PGBackups as "to be added"/"evaluating" for Advanced. — [Heroku Postgres Advanced](https://devcenter.heroku.com/articles/heroku-postgres-advanced)
- **Heroku** made Postgres 18 the default across tiers in October 2026, and continues to offer followers, forks, rollbacks, dataclips, and pgvector. — [Heroku October 2026 Update](https://www.heroku.com/blog/october-2026-update-heroku-innovations-features/)
- **Northflank** provides PostgreSQL, MongoDB, MySQL, Redis and other data services with automatic backups, point-in-time recovery, connection pooling and resource scaling. — [Northflank Platform Features](https://northflank.com/features/platform)
- **Northflank** added managed object storage (May–June 2026), scheduled volume backups and container snapshots (August–September 2026). — [Northflank Changelog](https://northflank.com/changelog)
- **All three volume implementations enforce single-writer semantics**: Railway forbids replicas with volumes, Render allows one service instance, and Fly attaches a volume to one Machine. — [Railway Volumes](https://docs.railway.com/reference/volumes); [Render Disks](https://render.com/docs/disks); [Fly App Configuration](https://docs.fly.io/reference/configuration)

### Inferences
- Build "data services" as first-class **workload recipes**, not a proprietary DBaaS: a Postgres recipe = pinned image + volume at `/var/lib/postgresql/data` + generated superuser/app credentials + PgBouncer sidecar + backup job + restore procedure + health check. Same pattern for Redis/Valkey, MySQL/MariaDB, MongoDB, ClickHouse.
- PITR is the hardest promise to keep. A credible small-footprint approach is pgBackRest/WAL-G shipping WAL to S3-compatible storage, with a tested restore command and a visible "last verified restore" timestamp. If that cannot be tested continuously, ship daily logical dumps + volume snapshots and do not claim PITR.
- Connection pooling is cheap differentiation: provision PgBouncer automatically and inject both direct and pooled URLs (`DATABASE_URL`, `DATABASE_POOL_URL`). Render exposes `connectionPool: pgbouncer`; Heroku's Advanced tier still lacks server-side pooling, which shows the gap is real even for large providers.
- Single-writer volume constraints must be enforced by the scheduler (never place two replicas on one volume) and surfaced at deploy time ("this deploy will briefly stop the app"). Yoal's desired-state reconciler is the right place to encode this.
- Object storage should be an interface, not a product: keep local + R2, add any S3-compatible backend (MinIO/Garage) for self-hosters, and use it as the backup target. Do not build a distributed object store.
- Queues/Kafka are poor fits for a small operator. A Redis recipe plus a `worker` process group covers the common case; managed Kafka is enterprise scope.
- Backup verification is a stronger differentiator than backup creation. Peers advertise snapshots but rarely advertise automated restore drills.

### Gaps
- Northflank's persistent-volume limits and snapshot retention are not documented on a page I could fetch (the guessed docs URL 404s); only changelog-level claims were verified.
- Render does not state PITR granularity or restore-time objectives on the pricing page.
- No peer publishes backup *restore* SLOs in the docs reviewed; claims about "instant" restore are marketing-level.
- Heroku Postgres Advanced's GA status conflicts: the October 2026 blog says "available to all teams this week", while the docs page is titled "Limited GA". Treat as limited/rolling GA.

## 3. Configuration, environments and release workflows

### Takeaway
Peers treat configuration as part of the release, not as dashboard state: declarative files, environment-scoped variables, shared secret groups, references between resources, PR environments, protected environments and approvals. Yoal already has environments and immutable artifacts; the missing layer is a declarative app spec plus secret ergonomics and promotion semantics.

### Cited Findings

- **Render** `render.yaml` defines previews, services, databases, environment groups and projects/environments; supports `generateValue`, `sync: false` (prompt on creation), `fromDatabase`, `fromService`, `fromGroup`, `preDeployCommand`, `initialDeployHook`, `maintenanceMode`, `healthCheckPath`, `maxShutdownDelaySeconds`, `scaling`, `disk`, `buildFilter`, and per-environment network isolation and protection. — [Render Blueprint Spec](https://render.com/docs/blueprint-spec)
- **Render** Blueprints are validated by IDE schema (SchemaStore / JSON Schema), the Render CLI, and a dedicated API endpoint; syncing preserves existing environment variables that are omitted from the file rather than deleting them. — [Render Blueprint Spec](https://render.com/docs/blueprint-spec)
- **Render** supports automatic, manual, or off preview generation per service and per environment, with `expireAfterDays` to deprovision stale preview environments and per-preview plan/instance overrides. — [Render Blueprint Spec](https://render.com/docs/blueprint-spec)
- **Render** `autoDeployTrigger` can be `commit`, `checksPass`, or `off`, allowing deploys only after CI checks pass. — [Render Blueprint Spec](https://render.com/docs/blueprint-spec)
- **Railway** distinguishes persistent environments from temporary PR environments; PR environments are deleted when the PR closes, can auto-deploy only affected services via "Focused PR Environments" (documented with a priority-boarding banner), and can be enabled for bot PRs such as Dependabot, Renovate and coding agents. — [Railway Environments](https://docs.railway.com/environments)
- **Railway** environments can be duplicated (services, variables and configuration) or synced, with changes collected as staged changes requiring review before deploy; environment-scoped RBAC is Enterprise-only. — [Railway Environments](https://docs.railway.com/environments)
- **Railway** documents config as code with `railway.toml` and CLI commands `railway config init|pull|plan|apply`, plus `.railway/railway.ts`. — [Railway CLI](https://docs.railway.com/cli); [Railway Build & Deploy](https://docs.railway.com/build-deploy)
- **Heroku** promotes the same build artifact between pipeline stages; config vars, add-ons and Git repo are managed independently of the pipeline, and builds that bake in environment values ("stateful builds") are explicitly unsuitable for promotion. — [Heroku Pipelines](https://devcenter.heroku.com/articles/pipelines)
- **Heroku** runs the release phase on promotion even though no new build occurs, which is how migrations stay aligned with promoted artifacts. — [Heroku Pipelines](https://devcenter.heroku.com/articles/pipelines)
- **Northflank** implements bi-directional GitOps: infrastructure is JSON manifests in Git, UI edits commit back to Git, with audit trail and version history; templates compose services, databases, jobs and config, and drive both preview environments and production. — [Northflank Platform Features](https://northflank.com/features/platform)
- **Northflank** promotes the exact same configuration from staging to production while keeping environment-specific secrets and configuration. — [Northflank Platform Features](https://northflank.com/features/platform)
- **Fly.io** keeps non-secret config in `[env]` in `fly.toml` and secrets via the CLI, with secrets taking precedence; `release_command` runs before release with access to env and secrets but not volumes. — [Fly App Configuration](https://docs.fly.io/reference/configuration)
- **Yoal** currently describes deploys as "artifacts only in v1": an immutable content-addressed release, preview URL per deployment, and promote/rollback by pointer/symlink. — [Yoal README](../../README.md)

### Inferences
- Add a declarative `yoal.yaml` (or `yoal.toml`) that can express app, process groups, build, env, secrets references, volumes, domains, health, scaling and cron. Commands should be `yoal plan`, `yoal apply`, `yoal diff`, `yoal pull` — mirroring Render/Railway and fitting Yoal's CLI-first, agent-first positioning.
- Critical design choice: **do not delete unmanaged resources** on apply. Render preserves omitted env vars; Terraform-style destructive reconciliation is hostile to a single operator and to agents. Report drift, require explicit prune.
- Secret model: org → project → environment → app scopes; shared groups; secret files mounted read-only; generated values; references (`fromService`, `fromDatabase`) so connection strings are never copy-pasted; per-key audit of reads/reveals.
- Environment cloning should copy configuration and resource topology but require explicit secret re-entry or explicit "copy secrets" confirmation. Railway duplicates variables; that is convenient but risky for production→dev clones.
- Promotion should move the artifact digest plus a config hash, and show a diff of environment-specific values. Heroku's "stateful build" caveat is a useful warning to surface.
- Protected environments + approval gates are small to build and disproportionately valuable when agents can deploy. Render has `permissions.protection`; Yoal should add "require approval" and "deploy freeze" on top.
- Preview environments are valuable but expensive to build well (DB seeding, TTL, domain routing, teardown). Defer until process groups and config-as-code exist.

### Gaps
- Railway's exact `railway.toml` schema and precedence versus dashboard state were not verified.
- Render does not document how Blueprint drift is detected outside sync/validation.
- Northflank's JSON manifest schema and conflict resolution rules were not fetched.
- No peer documents an "agent-authored config" audit model; this is a Yoal opportunity, not a benchmark.

## 4. Networking: private networking, service discovery, domains/TLS, load balancing, egress

### Takeaway
Private service discovery, per-environment network isolation, TCP/UDP proxying and stable egress IPs are the meaningful gaps for Yoal. Global anycast, CDN and AWS PrivateLink are SaaS-scale features that do not fit a single-operator deployment.

### Cited Findings

- **Railway** provides private networking with internal DNS over IPv6, public HTTP/HTTPS with automatic SSL, TCP proxying for non-HTTP services, custom domains, static outbound IPs, and an edge network. — [Railway Networking](https://docs.railway.com/networking); [Railway Features](https://railway.com/features)
- **Railway** private-network bandwidth is unmetered, and public egress above 100 GB/month may be throttled pending review; there is no hard bandwidth cap. — [Railway Use Cases](https://docs.railway.com/platform/use-cases)
- **Render** offers private networking, network-isolated environments, dedicated outbound IPs (paid add-on), AWS PrivateLink, inbound IP rules (Scale+), custom domains with automatic TLS, HTTPS redirects, and a global CDN for static sites. — [Render Platform](https://render.com/platform); [Render Features by Plan](https://render.com/docs/platform-features-by-plan)
- **Render** can disable a service's `onrender.com` subdomain once a custom domain is attached, preventing bypass of custom-domain controls. — [Render Blueprint Spec](https://render.com/docs/blueprint-spec)
- **Fly.io** provides 6PN private networking, Flycast private proxy services, Anycast public IPs, per-app services on arbitrary TCP/UDP ports, TLS termination with configurable versions/ALPN, static egress IPs at ~$3.60/month, and dedicated IPv4 at $2/month. — [Fly App Configuration](https://docs.fly.io/reference/configuration); [Fly Pricing](https://docs.fly.io/about/pricing)
- **Fly.io** charges $0.10/month per single-hostname certificate and $1/month per wildcard, with the first 10 single-hostname certificates free. — [Fly Pricing](https://docs.fly.io/about/pricing)
- **Heroku** offers a common runtime plus Private Spaces with network isolation, custom domains and SSL. — [Heroku Products](https://www.heroku.com/products/); [Heroku Reference](https://devcenter.heroku.com/categories/reference)
- **Northflank** gives services internal DNS, project-isolated private networking by default, public HTTPS with automatic TLS, custom domains/CDN, network policies (UI added 2026), alias domains, TLS passthrough, and gradual rollouts with traffic splitting. — [Northflank Application Layer](https://northflank.com/features/application-layer); [Northflank Enterprise](https://northflank.com/docs/v1/application/enterprise); [Northflank Changelog](https://northflank.com/changelog)
- **Yoal** terminates TLS and routes content through Caddy, with edge-placed static sites served from local releases and worker-placed sites reverse-proxied over WireGuard; Caddy's admin API is a unix socket and wildcard certs use DNS-01. — [Yoal README](../../README.md)

### Inferences
- Add stable private DNS names per service/environment (e.g. `db.prod.svc.yoal.internal`) resolved on every node, never exposed publicly. This is the substrate for DB recipes, workers and multi-service apps. WireGuard already connects nodes; the missing piece is name resolution and policy.
- Per-environment isolation should be enforceable (nftables or network namespaces) and default-on for production vs preview. Render sells this as "network-isolated environments"; Northflank claims project isolation by default.
- TCP/UDP proxying is needed for databases, MQTT and game servers. Caddy's layer4 app can do this without a separate load balancer.
- Static egress IP is mostly configuration plus NAT: expose the node/zone egress addresses in the UI and docs so operators can allowlist them. Lower priority than private DNS but cheap.
- Domain polish (apex ↔ www redirect, HSTS, cert status, DNS verification, disable default subdomain) is small work with visible trust impact. Render's `renderSubdomainPolicy` is a good model.
- Load balancing across replicas should reuse Caddy upstream health state; do not introduce Envoy/Nginx.
- Skip anycast, global CDN, PrivateLink and cross-cloud private links. If needed, document Cloudflare Tunnel/Tailscale as external options.

### Gaps
- Yoal's existing private networking/service discovery is not described in the README; the recommendation may partly exist.
- Fly's SSO/audit and private-networking policy controls were not verified beyond the config/pricing pages.
- No peer documents egress IP sharing across apps or per-app egress identity in the reviewed pages.

## 5. Operations: metrics, logs, tracing, alerts, incidents, maintenance, usage/cost controls

### Takeaway
Yoal already collects logs and traffic telemetry, but peers compete on **alerting, retention, export and cost controls**. The highest-value ops additions are alert rules with notification channels, log search/retention plus OTLP/log drains, per-org quotas, a status/incident view, and visible backup/restore health. Full APM/tracing should be exported, not built.

### Cited Findings

- **Railway** retains service metrics (CPU, memory, disk, network) for up to 7 days and logs for up to 90 days on Pro; it overlays commits and deploy events on metrics and supports distributed tracing via a built-in OpenTelemetry collector. — [Railway Use Cases](https://docs.railway.com/platform/use-cases); [Railway Features](https://railway.com/features)
- **Railway** provides webhooks and alerting, audit logs for teams, and usage information at service and project level. — [Railway Features](https://railway.com/features); [Railway Services](https://docs.railway.com/services)
- **Render** provides service metrics and logs, Slack/email notifications for service events, SSH/shell access, OpenTelemetry export, log streams to Datadog/Sentry, and webhooks to PagerDuty-style tools; metrics retention is extended on Scale. — [Render Platform](https://render.com/platform); [Render Pricing](https://render.com/pricing)
- **Render** supports maintenance mode per web service with a default or custom maintenance page, configurable in `render.yaml`. — [Render Blueprint Spec](https://render.com/docs/blueprint-spec)
- **Render** shows disk usage over time and retains disk snapshots for 7 days; it explicitly warns against restoring a disk snapshot for a custom database because the DB may be corrupted. — [Render Disks](https://render.com/docs/disks)
- **Fly.io** Managed Postgres includes performance monitoring and metrics, and emails the organisation when maintenance starts and finishes, but explicitly has no CPU/storage alerts; operators must watch metrics themselves. — [Fly Managed Postgres](https://docs.fly.io/postgres)
- **Heroku** offers application metrics, language-runtime metrics, OpenTelemetry concepts and telemetry drains, Production Check, maintenance mode, and a separate status page (Salesforce status). — [Heroku Reference](https://devcenter.heroku.com/categories/reference)
- **Northflank** centralises logs for services, jobs and builds with search/filter and 60-day retention, CPU/memory/network/disk metrics, health-check alerts, and export to Datadog/Splunk. — [Northflank Platform Features](https://northflank.com/features/platform); [Northflank Application Layer](https://northflank.com/features/application-layer)
- **Northflank** surfaces cost visibility alongside logs/metrics/alerts in its platform overview. — [Northflank](https://northflank.com/)
- **Yoal** stores state in SQLite and telemetry in DuckDB, with logs, traffic telemetry and backups already listed as capabilities. — [Yoal README](../../README.md)

### Inferences
- Alerting is the biggest operational gap. Minimum viable rule set: deploy failed, health check failing, 5xx rate, p95 latency, CPU/memory saturation, disk >80%, certificate expiring, backup failed, node offline, desired-state drift. Channels: email, generic webhook (HMAC), Slack/Discord/ntfy.
- Retention tiers should be explicit and cheap: e.g. 7 days hot in DuckDB, 30/90 days rolled up, optional S3 archival. Railway's 7-day metrics / 90-day logs split is a reasonable reference.
- Log search and a live tail in the dashboard are table stakes once apps (not just static sites) exist. Add structured fields (app, env, release, process, node) and a `yoal logs --follow` CLI.
- Export beats build: OTLP endpoint + HTTP log drain + syslog covers users with Datadog/Grafana/Loki. Do not build distributed tracing storage.
- Usage/cost controls translate to **quotas**, not billing: per-org/project/app CPU, memory, disk, bandwidth, build minutes and backup storage; warn at thresholds; optional hard stop. This is essential for a single operator hosting others.
- Status/incident view is mostly UI over existing health data: current status per app/node, incident timeline, maintenance windows, subscriber notifications. Small and high trust.
- A "diagnostics" panel showing desired vs actual state, last reconcile time, failing conditions and recent events would be uniquely valuable for a reconciler-based platform and is cheaper than generic APM.
- Backup health deserves first-class UI: last backup, last successful restore test, size, retention, offsite status.

### Gaps
- No peer publishes a full alert-rule catalogue or evaluation semantics in the reviewed docs; feature depth is hard to compare.
- Render's exact metrics retention by plan was not enumerated.
- Heroku's current observability packaging (which metrics are included vs paid) was not verified.
- Yoal's existing telemetry schema was not inspected, so storage/retention estimates are speculative.

## 6. Developer experience and integrations: CLI, API, IaC, Git, webhooks, notifications, templates

### Takeaway
API/CLI parity, GitHub commit statuses with PR preview links, signed webhooks and a small parameterised template catalogue deliver more value at Yoal's stage than a hand-written Terraform provider. Peers increasingly ship agent skills and MCP, which aligns with Yoal's existing advantage.

### Cited Findings

- **Railway** CLI covers deploy (`up`), redeploy/restart/down, deployment history, cron list/run, template search, config init/pull/plan/apply, domains, scaling, SSH, volume browsing, static outbound IP enablement, private-network status, and agent tooling (`agent`, `mcp install`, `skills install`); CI uses project tokens (`RAILWAY_TOKEN`) or account tokens (`RAILWAY_API_TOKEN`). — [Railway CLI](https://docs.railway.com/cli)
- **Railway** exposes a GraphQL API with schema search/describe commands, plus templates for common stacks. — [Railway CLI](https://docs.railway.com/cli); [Railway Features](https://railway.com/features)
- **Render** offers a public REST API, webhooks, Terraform provider, Blueprints, CLI Blueprint validation, registry credentials, and SSH/SCP access. — [Render Platform](https://render.com/platform); [Render Blueprint Spec](https://render.com/docs/blueprint-spec); [Render Disks](https://render.com/docs/disks)
- **Render** documents managed OIDC federation for AWS (GA July 2026) and for Anthropic/OpenAI (July 2026), issuing short-lived credentials instead of long-lived API keys. — [Render Changelog, 15 Jul 2026](https://render.com/changelog/render-to-aws-oidc-authentication-now-generally-available); [Render Changelog, 24 Jul 2026](https://render.com/changelog/managed-oidc-now-supports-anthropic-and-openai)
- **Heroku** offers a CLI, Platform API, app webhooks, GitHub integration, Review Apps, Heroku CI, a VS Code extension, and ChatOps. — [Heroku Reference](https://devcenter.heroku.com/categories/reference)
- **Heroku** Pipelines + GitHub integration auto-deploy a branch to staging and create Review Apps per PR. — [Heroku Pipelines](https://devcenter.heroku.com/articles/pipelines)
- **Northflank** provides a REST API with full coverage, CLI (including port-forward and exec), TypeScript SDK, Python client, bi-directional GitOps, templates, and a skills repository for AI coding agents. — [Northflank Platform Features](https://northflank.com/features/platform); [Northflank Docs](https://northflank.com/docs/)
- **Fly.io** offers `flyctl`, the Machines REST API, `fly.toml`, deploy-time config, and CI/CD integration; its enterprise page advertises CI/CD integration and SOC2 Type 2. — [Fly.io Essentials](https://docs.fly.io/getting-started/essentials); [Fly.io](https://fly.io/)
- **Yoal** already has a REST API, `yoal` CLI (login, deploy, status, promote, rollback), MCP server with OAuth 2.1, and git builds in v2. — [Yoal README](../../README.md)

### Inferences
- Publish an OpenAPI spec and make it the source of truth for the dashboard, CLI, SDK and later Terraform. Add idempotency keys on mutating endpoints and cursor pagination; agents retry, so idempotency is not optional.
- CLI parity should include the operational verbs operators actually use: `logs -f`, `ps`, `restart`, `scale`, `exec`, `cp`, `env`, `domain`, `backup`, `restore`, `deploy --wait`, `rollback --to`.
- GitHub App (not just a webhook) with commit status checks and a PR comment containing the preview URL is high leverage. Render's `checksPass` auto-deploy trigger is the right default for production.
- Webhooks need HMAC signatures, retries with backoff, delivery logs and replay. This is small and unlocks ChatOps/CI integrations without building each integration.
- Templates/blueprints: versioned, parameterised, local-first (no marketplace), e.g. "Postgres + app", "static site + redirects", "worker + Redis". Northflank/Render templates validate demand; Yoal can keep it lightweight.
- Terraform provider can wait; `yoal apply` over a declarative file plus a generated Go/Python client covers most IaC needs. If built, generate from OpenAPI rather than hand-maintaining.
- Compose import (`docker-compose.yml` → Yoal app + services) could be a strong migration hook for self-hosters, but it is a medium project with many edge cases.
- Do not build ChatOps, Salesforce, white-label or a VS Code extension.

### Gaps
- Render's Terraform provider coverage and drift behaviour were not verified.
- Fly's first-party GitHub Actions integration was not fetched; only generic CI/CD claims were seen.
- Northflank's API rate limits and idempotency semantics were not verified.
- Yoal's current CLI/API surface was not audited beyond the README.

## 7. Access: teams, RBAC, SSO/SAML/SCIM, audit logs, API keys, deploy audit

### Takeaway
Enterprise peers compete on SSO/SCIM/advanced RBAC, but the valuable subset for Yoal is OIDC login, per-environment roles, protected environments, scoped service accounts and complete deploy/secret audit. SCIM, SAML and white-label are enterprise checkboxes that a single-operator product should defer.

### Cited Findings

- **Railway** provides SSO, role-based access control, encrypted secrets/private variables, audit logs for teams, and Enterprise-only environment RBAC that hides production resources from non-admins while still allowing git-push deploys. — [Railway Features](https://railway.com/features); [Railway Environments](https://docs.railway.com/environments)
- **Render** provides workspace RBAC, SSO and SCIM on Scale+, audit logs from Pro+, advanced RBAC and protected environments, and managed OIDC for workloads. — [Render Platform](https://render.com/platform); [Render Pricing](https://render.com/pricing); [Render Blueprint Spec](https://render.com/docs/blueprint-spec)
- **Render** Blueprint environments expose `permissions.protection` to prevent destructive actions by non-admins. — [Render Blueprint Spec](https://render.com/docs/blueprint-spec)
- **Heroku** shipped fine-grained access controls at application, pipeline and data-resource level in October 2026, plus Team Authorizations (team-owned API tokens/OAuth credentials), and native OS keychain storage for CLI credentials. — [Heroku October 2026 Update](https://www.heroku.com/blog/october-2026-update-heroku-innovations-features/)
- **Heroku** offers SSO, audit logging, Private Spaces and enterprise teams; pipeline-level access controls govern ephemeral Review Apps and CI apps separately from app-level permissions. — [Heroku Reference](https://devcenter.heroku.com/categories/reference); [Heroku Pipelines](https://devcenter.heroku.com/articles/pipelines)
- **Northflank** Enterprise includes SSO/SAML, SCIM and JIT provisioning, audit logs and SSO audit logs, infrastructure audit events, template drafts, WAF/DDoS, workload identities, per-port/path auth proxy, forward-deployed logging and control plane, and microVM sandboxing. — [Northflank Enterprise](https://northflank.com/docs/v1/application/enterprise)
- **Northflank** added organisation access controls, bring-your-own-key encryption and short-lived workload tokens in 2026. — [Northflank Changelog](https://northflank.com/changelog)
- **Yoal** already scopes tokens by intersection of token scopes and the user's current role, and routes every surface (dashboard, REST, MCP, CLI) through one core service layer. — [Yoal README](../../README.md)

### Inferences
- Add OIDC social/enterprise login via Better Auth; skip SAML and SCIM until a real customer asks. OIDC covers Google/GitHub/Okta and is medium effort.
- Per-environment roles + protected environments are the highest-value authorization additions: "member can deploy to staging, only admin/approver can deploy to production", and "agents can never approve their own production deploy".
- Service accounts with scopes, expiry, optional IP allowlist and last-used tracking are essential for CI and agents. Heroku's shift to team-owned tokens validates the need; Yoal's scope ∩ role model is already stronger than most.
- Deploy audit should record: actor (human/service account/agent), artifact digest, config diff, environment, approval, result, duration, and rollback link. This is a small extension of existing audit and a strong differentiator for agent operations.
- Secret access audit (read/reveal/rotate) is small and valuable; most peers audit admin actions but are vague about secret reads.
- BYOK/envelope encryption per org is a nice enterprise option but not needed for a single operator; the existing master key is sufficient if rotation is documented.
- Avoid building SCIM, SAML, white-label, per-port auth proxies and infrastructure-wide audit pipelines.

### Gaps
- Fly.io's SSO/SCIM/audit capabilities were not confirmed from primary docs; the fetched pages only cover orgs and tokens.
- Render's exact RBAC role matrix was not fetched.
- Heroku's audit-log retention and export options were not verified.
- No peer documents agent-specific identity/approval semantics in the reviewed docs.

## 8. Agent/AI: MCP servers, AI-assisted ops, agent sandboxes

### Takeaway
2026 competition has moved from "AI chat in the dashboard" to agent-facing control planes: MCP servers, skills, cloud agents and sandboxes for untrusted code. Yoal's MCP OAuth implementation is ahead of most peers on auth; the gaps are plan/approval semantics, per-agent identity, and an ephemeral sandbox primitive.

### Cited Findings

- **Railway** ships an MCP server, agent skills, plugins/connectors for Claude, Codex, ChatGPT and Cursor, cloud agents that run coding sessions on Railway, a dashboard "Railway Agent" that can inspect deployments and open PRs, and Slack/Discord connectors. — [Railway AI](https://docs.railway.com/ai); [Railway CLI](https://docs.railway.com/cli)
- **Railway** CLI includes `railway code --claude` for launching a coding-agent session and `railway setup agent` / `railway mcp install` / `railway skills install`. — [Railway CLI](https://docs.railway.com/cli)
- **Northflank** added "Harnesses" for coding agents and self-service microVMs on BYOC (August–September 2026), offers cloud coding-agent environments, sandboxes for untrusted code, and publishes skills for AI coding agents. — [Northflank Changelog, 24 Sep 2026](https://northflank.com/changelog); [Northflank Docs](https://northflank.com/docs/)
- **Fly.io** sells Sprites: self-contained hardware-isolated sandboxes for agents and AI-generated code, with checkpoints, sub-second start, and per-second billing. — [Fly.io](https://fly.io/)
- **Heroku** offers Managed Inference and Agents, hosts MCP servers on one-off dynos with pay-as-you-go billing, and documents using Claude Code with Heroku AI. — [Heroku Products](https://www.heroku.com/products/); [Heroku Reference](https://devcenter.heroku.com/categories/reference)
- **Render** does not advertise an MCP server in the pages reviewed, but added managed OIDC for Anthropic and OpenAI so services can call model APIs without long-lived keys. — [Render Changelog, 24 Jul 2026](https://render.com/changelog/managed-oidc-now-supports-anthropic-and-openai)
- **Yoal** implements MCP over OAuth 2.1 with CIMD/DCR discovery, PKCE, consent, scope step-up and elicitation; the MCP server is one of four equal surfaces over the same core service layer. — [Yoal README](../../README.md)

### Inferences
- Yoal's MCP auth is a genuine differentiator; productise it: per-agent OAuth clients with names, scopes, expiry, last-used and a visible consent/audit trail. Do not let agents reuse human API keys.
- Add a **plan/dry-run** mode to every mutating MCP tool and CLI command, returning a structured diff and cost/resource impact. Then require explicit approval (elicitation or dashboard) for production, destructive, secret-revealing and exec operations.
- Expose read-only MCP resources for logs, metrics, deploy history, diagnostics, docs/runbooks and backup status. Agents are much more useful when they can explain *why* a deploy failed.
- Guardrails: environment allowlists per token, protected environments, deploy freeze, rate limits, and a kill switch per agent/service account.
- Agent sandboxes are a plausible v3: an ephemeral app with TTL, no public ingress by default, CPU/mem/disk caps, egress allowlist, optional snapshot/restore, and automatic destruction. This mirrors Northflank microVMs and Fly Sprites without needing Firecracker initially — systemd + namespaces/cgroups can provide a weaker but useful boundary. Do not claim VM-grade isolation unless it is real.
- Do not build model inference. Integrate external providers with user-supplied keys or OIDC; keep the platform neutral.
- Agent skills/prompt packs are small and high leverage: encode "how to deploy on Yoal", "how to debug a failed release", "how to restore a backup" as versioned skills shipped with the product.

### Gaps
- No primary source confirms whether Railway's cloud agents are GA or preview.
- Northflank's Harnesses pricing/limits and isolation guarantees were not verified.
- Fly Sprites' current regional availability and checkpoint limits were not fetched.
- No peer publishes a threat model for agent-initiated production changes; Yoal would be pioneering here.

## 9. Synthesis: prioritised feature candidates for Yoal

### Takeaway
Prioritise **release safety, process groups, secret/config ergonomics, alerting and agent guardrails**. Treat managed DBaaS, enterprise compliance and global networking as recipes or integrations, not platform features. The recommended sequence is: trustworthy deploys → multi-process + declarative config → data/scale → agent sandboxes.

### Candidate table

Complexity: small ≤1 week, medium 2–6 weeks, large >6 weeks. "Fit" is judged for a self-hosted, single-operator, non-Kubernetes product.

| # | Candidate | User problem | Peer precedent | Complexity | Fit |
|---|---|---|---|---|---|
| 1 | Pre-deploy / release command with fail-fast | Migrations run before traffic; a broken migration must not produce a half-deployed app | Fly `release_command`; Render `preDeployCommand`; Heroku release phase | Small | Core |
| 2 | Health-gated activation + auto-rollback | Bad releases take traffic and stay up | Render zero-downtime + instant rollback; Fly health checks; Northflank health-gated deploys | Small–Medium | Core |
| 3 | Graceful drain + configurable shutdown timeout | In-flight requests and jobs are killed on deploy | Render `maxShutdownDelaySeconds` 1–300; Fly `kill_signal`/`kill_timeout` | Small | Core |
| 4 | Process groups (web / worker / cron) per release | One repo needs an HTTP server plus queue workers and schedulers | Heroku Procfile; Fly `processes`; Render service types | Medium | Core |
| 5 | Cron + one-off job runner with history, timeout, retries, concurrency policy | Scheduled maintenance and manual jobs have no first-class home | Railway cron jobs; Render cron; Northflank jobs | Medium | Core |
| 6 | Blue/green + canary traffic split | Deploys need instant rollback and gradual exposure | Fly rolling/canary/bluegreen; Northflank blue-green + gradual rollout | Medium | Strong |
| 7 | Horizontal autoscaling (CPU/memory/RPS/concurrency) with min/max/cooldown | Traffic spikes require manual scale changes | Render, Railway, Northflank HPA | Medium | Strong |
| 8 | Scale-to-zero for HTTP apps with wake queue and 502 retry | Idle apps waste the operator's small footprint | Railway Serverless; Fly autostop/autostart | Medium | Strong (HTTP only) |
| 9 | Persistent volumes with snapshots, restore and single-writer scheduling | Stateful apps and databases need durable local disk | Railway/Render/Fly volumes; all single-writer | Medium | Core |
| 10 | Volume/DB backup orchestration + restore verification | Backups exist but nobody knows if they restore | Render snapshots; Fly snapshots; Northflank scheduled volume backups | Medium | Core |
| 11 | Postgres/Redis "recipes" with pooling + backup sidecars | Users want a DB without becoming a DBA | Render/Railway/Northflank managed DBs; Fly MPG | Large (recipe + PITR); Medium for dumps | Strong |
| 12 | Private service DNS + per-environment isolation | Workers/DBs need to talk without public exposure | Railway private IPv6; Render network isolation; Northflank project isolation | Medium | Core |
| 13 | TCP/UDP proxy for non-HTTP services | Databases, MQTT, game servers cannot be exposed via HTTP | Railway TCP proxy; Fly arbitrary TCP/UDP services | Medium | Strong |
| 14 | Static egress IPs | Users must allowlist Yoal in third-party firewalls | Railway static outbound IPs; Render dedicated outbound IPs; Fly static egress | Small–Medium | Strong |
| 15 | Domain/TLS polish: apex↔www, HSTS, verification, cert status, disable default subdomain | Custom domains are the most visible part of "private cloud" | Render `renderSubdomainPolicy`; Railway/Render custom domains | Small | Core |
| 16 | Secret groups/scopes, secret files, generated values, cross-resource references | Copy-pasted connection strings and leaked secrets | Render env groups/`fromDatabase`/`sync:false`; Railway variables | Small–Medium | Core |
| 17 | Environment cloning + environment-scoped overrides | Staging is never quite like production | Railway duplicate/sync env; Render projects/environments | Medium | Core |
| 18 | Declarative `yoal.yaml` with plan/apply/diff + drift detection | Dashboard state is not reviewable or reproducible | Render Blueprints; Railway config plan/apply; Northflank GitOps | Medium | Core |
| 19 | Protected environments + deploy approvals + deploy freeze | Agents or juniors can break production | Render `permissions.protection`; Railway env RBAC; Heroku pipeline access | Small–Medium | Core |
| 20 | Preview environments per PR with TTL and seeded DB | Reviewing a change requires a full manual environment | Render previews; Railway PR envs; Heroku Review Apps; Northflank previews | Large | Strong |
| 21 | Alert rules + notification channels (email/webhook/Slack/Discord/ntfy) | Failures are discovered by users | Render notifications; Railway alerting; Northflank alerts | Medium | Core |
| 22 | Log search, retention tiers, live tail, OTLP/log drains | Debugging requires SSH and grep | Railway 7d metrics/90d logs; Northflank 60d logs; Render log streams | Medium | Core |
| 23 | Usage quotas and spend guards per org/project/app | One operator hosts others and needs guardrails | Railway/Render usage billing; Northflank cost view | Small–Medium | Core |
| 24 | Status/incident view + maintenance windows | Users cannot tell planned vs unplanned downtime | Render maintenance mode; Heroku maintenance mode | Small–Medium | Strong |
| 25 | Desired-vs-actual diagnostics panel | "Why is this app down?" requires reading logs and agent state | No direct peer equivalent | Small–Medium | Differentiator |
| 26 | CLI/API parity + OpenAPI + idempotency keys | Automation and agents retry and hit inconsistent surfaces | Railway CLI breadth; Render API; Northflank SDKs | Medium | Core |
| 27 | GitHub App: commit status, PR preview comment, deploy-on-checks-pass | CI/CD integration is expected | Render `checksPass`; Heroku GitHub integration; Railway GitHub autodeploys | Medium | Core |
| 28 | Signed webhooks with retries and delivery log | Integrations silently break | Render/Heroku/Railway webhooks | Small | Core |
| 29 | Template catalogue (parameterised, local registry) | Users rebuild the same Postgres+app stack | Render/Railway/Northflank templates | Medium | Strong |
| 30 | SSH/exec + file transfer into running apps | Debugging and data transfer need a shell | Render SSH/SCP; Northflank CLI exec/port-forward; Fly console | Medium | Strong (audited) |
| 31 | OIDC SSO | Teams want central identity | Render SSO; Railway SSO; Northflank SAML/SSO | Medium | Strong |
| 32 | Per-agent identity, scoped tokens, audit of agent actions | Agents currently act as humans and cannot be revoked precisely | Railway/Northflank agent tooling; no peer publishes this fully | Small–Medium | Differentiator |
| 33 | MCP plan/dry-run + approval for destructive tools | Agents can deploy/delete without a review step | No direct peer equivalent; Yoal has elicitation | Small–Medium | Differentiator |
| 34 | Agent sandboxes: TTL, no ingress, caps, egress allowlist, snapshot | Running AI-generated code safely | Fly Sprites; Northflank microVMs; Railway cloud agents | Large | Optional/Later |
| 35 | Terraform provider | IaC teams expect it | Render Terraform; Northflank API/SDK | Large | Optional/Later |
| 36 | Multi-node placement zones + failover | Single-node outages take everything down | Render/Railway/Fly regions | Large | Optional/Later |
| 37 | Buildpacks / zero-Dockerfile builds | Non-Docker users bounce | Heroku buildpacks; Fly/Railway/Render buildpacks | Medium | Optional |
| 38 | WAF / rate limiting / IP allowlists | Public apps get scanned and abused | Render DDoS/firewall; Northflank WAF; Caddy plugins | Medium | Optional |
| 39 | SCIM / SAML / white-label / HIPAA / SOC2 programme | Enterprise procurement checkboxes | Render Scale, Heroku Enterprise, Northflank Enterprise | Large | Avoid for now |
| 40 | Per-second billing, global CDN/anycast, PrivateLink, Kafka, Salesforce, GPU | SaaS-scale or partner-specific requirements | All peers, in different combinations | Large | Avoid |

### Recommended sequencing
- **Release A — trustworthy deploys (small, ~2–4 weeks):** release command, health-gated activation + auto-rollback, graceful drain, maintenance mode/deploy freeze, deploy audit detail, basic alert channels, domain/TLS status, diagnostics panel.
- **Release B — multi-process + declarative config (medium, ~6–10 weeks):** process groups, cron/one-off jobs, secret groups/files/references, `yoal.yaml` plan/apply/diff, environment cloning, protected environments + approvals, CLI/API parity and signed webhooks.
- **Release C — data and scale (medium–large, ~2–3 months):** volumes + snapshots/restore, Postgres/Redis recipes with pooling and backups, private DNS + per-env isolation, TCP/UDP proxy, autoscaling, scale-to-zero, static egress, preview environments.
- **Continuous — agent layer (small increments):** per-agent identity, dry-run/approval, MCP resources for diagnostics/logs, shipped skills. Sandboxes only after the core is trustworthy.

### Inferences
- The strongest positioning is not "Render clone"; it is "the private cloud an agent can safely operate". Release safety + approvals + per-agent audit are more defensible than matching 128-CPU instance catalogues.
- Yoal's reconciler is an asset for diagnostics and drift visibility; peers with imperative control planes cannot easily show "desired vs actual" the way Yoal can.
- The most dangerous gaps are not missing features but unsafe defaults: deploys without health gates, secrets without scoping, and agents without approval. Fixing those first protects the product's core promise.
- Managed-service lock-in should be avoided deliberately. Recipes + external S3 + standard protocols (Postgres, Redis, S3, OTLP) keep users portable, which is the point of self-hosting.

### Gaps
- No pricing/limits comparison was completed for Northflank, and no per-plan feature matrix exists in the docs I fetched.
- The research covers only five commercial PaaS products; self-hosted peers (Coolify, Dokploy, Kamal, Dokku) and "internal developer platform" tools were out of scope but are the more direct competitive set for Yoal.
- Several "zero-downtime" claims are vendor assertions; no independent verification or incident data was reviewed.
- Yoal's actual v2 implementation was not audited, so effort estimates may overlap with work already done.
