# Self-hosted PaaS and control panels: feature sets and roadmap demand (November 2026)

Scope: Coolify, Dokploy, CapRover, Dokku, Easypanel, Kamal, Portainer, Runtipi, Cosmos. Snapshot date 4 Nov 2026. Method: official docs, GitHub repo metadata, release notes and GitHub issue search sorted by total reactions (all emoji). Star/fork/issue counts are a same-day GitHub API snapshot. Vendor comparison pages are flagged where used.

## Setup, onboarding and templates

### Takeaway
One-line install and a guided first deploy are table stakes. The leaders compete on catalogue breadth (Coolify 360+, Easypanel 750+, Cosmos 250+ services) and on distribution via cloud marketplaces. Almost everyone enrols servers over SSH with root; Yoal's join-token agent model is therefore a genuine differentiator, not a catch-up feature.

### Cited Findings
- **Coolify** installs with one command on a fresh server, then offers three guided "first" paths: first app (nginx image), first database (Redis), first one-click service (Umami) — [Coolify docs index](https://coolify.io/docs/llms.txt); [What is Coolify](https://coolify.io/docs/core/what-is-coolify).
- Coolify can also provision Hetzner, DigitalOcean, Vultr and Hostinger servers from the dashboard using stored cloud tokens and cloud-init, removing the "SSH into a box first" step — [Coolify docs index](https://coolify.io/docs/llms.txt).
- **CapRover** installs via `curl … get.caprover.com`, exposes the dashboard on port 3000 with the well-known initial password `captain42`, requires wildcard DNS (`*.apps.example.com`) and a CLI alternative (`caprover serversetup`). Its 1.16.0 release (3 Nov 2026) added a redesigned dashboard with "Overview, guided Setup, and reorganized Settings" plus a "safer server installer with preflight diagnostics" — [CapRover getting started](https://caprover.com/docs/get-started.html); [CapRover v1.16.0](https://github.com/caprover/caprover/releases/tag/v1.16.0).
- **Dokku** is SSH-first: bootstrap script, add an SSH key, set a global domain, then `git push`. No web UI — [Dokku installation](https://dokku.com/docs/getting-started/installation/).
- **Kamal** is CLI-first: `gem install kamal`, `kamal init`, edit `config/deploy.yml`, `kamal setup`. Setup installs Docker over SSH, logs into the registry, builds/pushes/pulls, starts kamal-proxy, waits for `GET /up`, swaps traffic and prunes old images — [Kamal installation](https://kamal-deploy.org/docs/installation/).
- **Easypanel** installs with `curl -sSL https://get.easypanel.io | sh` on a fresh Ubuntu server with ≥2 GB RAM; the script installs Docker, initialises Docker Swarm and starts Easypanel. It also lists one-click marketplace images for DigitalOcean, AWS, Vultr, Linode, Hostinger, Kamatera, Cloudzy and LetsCloud, and a public demo at `demo.easypanel.io` — [Easypanel docs](https://easypanel.io/docs); [Easypanel home](https://easypanel.io/).
- **Cosmos** installs with one curl script and a web setup wizard ("Get started in 5 minutes"), with a hosted demo UI — [Cosmos home](https://cosmos-cloud.io/); [Cosmos docs](https://cosmos-cloud.io/docs/).
- **Runtipi** markets "one command setup, one click installs"; its own docs describe the product as an app-store-like layer over Docker, with a CLI for start/stop/update/backup — [Runtipi repo](https://github.com/runtipi/runtipi); [How Runtipi works](https://runtipi.io/docs/learn/how-it-works).
- **Portainer** requires ports 9443 (UI/API), 8000 (Edge tunnel) and 9001 (agent); it supports server, agent and Edge Agent topologies. A one-time setup token printed to the server log is now required to create the first admin or restore a backup on an uninitialised instance — [Portainer requirements](https://docs.portainer.io/start/requirements-and-prerequisites); [Portainer 2.43.0 release notes](https://docs.portainer.io/release-notes).
- Coolify hardened first-run onboarding in v4.5.1: self-hosted first-root registration is limited to ten minutes after startup, and a restart reopens the window — [Coolify v4.5.1](https://github.com/coollabsio/coolify/releases/tag/v4.5.1).
- Catalogue scale: Coolify's repo describes "360+ one-click services"; its docs index lists categories across AI, analytics, databases, CMS and monitoring — [Coolify repo](https://github.com/coollabsio/coolify); [Coolify service catalogue](https://coolify.io/docs/services/all).
- Easypanel claims "more than 750 open-source services"; Cosmos claims "250+ pre-configured applications" from official and unofficial stores; CapRover supports third-party one-click repositories; Runtipi supports community and custom app stores — [Easypanel home](https://easypanel.io/); [Cosmos home](https://cosmos-cloud.io/); [CapRover one-click apps](https://caprover.com/docs/one-click-apps.html); [Runtipi introduction](https://runtipi.io/docs/introduction).
- Template lifecycle is a known failure point: CapRover warns that some template variables (e.g. initial database passwords) apply only on first startup, and that configuration backups do not contain database volumes. Runtipi 4.11 added ordered, one-time app-store migrations that run during app updates and back up app data first — [CapRover one-click apps](https://caprover.com/docs/one-click-apps.html); [Runtipi v4.11.0](https://github.com/runtipi/runtipi/releases/tag/v4.11.0).
- **Enrolment models differ sharply.** Coolify and Dokploy connect existing Linux servers over SSH and validate the Docker environment; Kamal uses SSH as root by default; Portainer uses an agent or Edge Agent with a tunnel. None of the reviewed docs describe a pull-based desired-state agent like Yoal's — [Coolify What is Coolify](https://coolify.io/docs/core/what-is-coolify); [Dokploy features](https://docs.dokploy.com/docs/core/features); [Kamal installation](https://kamal-deploy.org/docs/installation/); [Portainer requirements](https://docs.portainer.io/start/requirements-and-prerequisites).

### Inferences
- The minimum viable onboarding is now: one command → browser → guided checklist → deploy a real app in under five minutes. Coolify's "choose your path" and CapRover 1.16's guided Setup show the industry converging on a checklist rather than a blank dashboard.
- Catalogue breadth is a moat but an expensive one. Yoal should not chase 360 templates. A curated 20–40 static-first templates (landing page, docs, blog, Astro/SvelteKit/Next static export, image proxy, redirect map, status page) plus a documented "bring your own Dockerfile/Compose" escape hatch would cover most time-to-value with far less supply-chain risk.
- Yoal's agent + join token is a stronger security story than "give the control plane root SSH". It should be marketed as such: no inbound SSH, revocable node identity, and an auditable enrolment event.
- Copy the first-admin protections: a short registration window (Coolify) or a one-time setup token in logs (Portainer) prevents the classic unauthenticated-instance takeover.
- Demo/sandbox environments matter for evaluation: Easypanel and Cosmos both host public demos. A disposable "try Yoal" static site is cheap and fits the product.

### Gaps
- No public activation/conversion data for any product, so "guided setup improves activation" is inference, not measured fact.
- Could not confirm whether Easypanel supports multi-server clusters; its docs describe a single fresh server and per-server pricing only.
- No data on which templates are actually used, or on template abandonment/upgrade failure rates.

## App management and deployment surface

### Takeaway
The feature floor is Git → build → deploy with env vars, domains, logs, terminal, volumes, health checks, cron, rollback and preview environments. Buildpack support is table stakes for Dokku/Coolify/Dokploy but is heavy and opaque. The clearest unmet demand in the whole dataset is CapRover's six-year-old request to upload static files via the UI and have the proxy serve them — exactly Yoal's core.

### Cited Findings
- **Coolify** supports Git sources (GitHub App, deploy key, GitLab, Gitea, Bitbucket, generic Git), Dockerfile, Docker Compose, prebuilt images, a "Static" build that packages prebuilt files in an Nginx image, Nixpacks and Railpack (beta). It also has Smart Scan (detect Dockerfile/Compose/ports/env), build servers, preview deployments, rolling updates, rollbacks, health checks, resource limits, volume/bind/file mounts, scheduled tasks, tags and deploy-by-tag, a web terminal and a container file browser — [Coolify docs index](https://coolify.io/docs/llms.txt).
- Coolify's deployment model replaces running containers; rolling updates and a configurable drain time were specifically improved to stop 502s during swaps (v4.5.1). Rollback redeploys an older image still present on the server. It also supports per-resource maintenance pages and a custom proxy 503 fallback — [Coolify v4.5.1](https://github.com/coollabsio/coolify/releases/tag/v4.5.1); [Coolify docs index](https://coolify.io/docs/llms.txt).
- **Dokploy** splits "Applications" (single app, near plug-and-play) from "Docker Compose" (full compose control). Build types are Docker, Nixpacks, Heroku Buildpacks and Paketo Buildpacks. It ships a container terminal, CPU/memory/disk/network monitoring, real-time logs, deployment history, cancellation of queued deployments, domain generation, resource limits, volumes, redirects, security headers and per-app Traefik config — [Dokploy features](https://docs.dokploy.com/docs/core/features).
- Dokploy also has one-click MySQL, PostgreSQL, MongoDB, Redis, MariaDB and LibSQL, manual/scheduled backups, schedule jobs, file "patches", watch paths and volume backups — [Dokploy features](https://docs.dokploy.com/docs/core/features); [Dokploy MCP tool inventory](https://github.com/Dokploy/mcp).
- **CapRover** deploys via a `captain-definition` file, image name, Dockerfile, tarball or CLI; Docker Compose support is explicitly "experimental". One-click templates create ordinary apps that can then be configured normally — [CapRover getting started](https://caprover.com/docs/get-started.html); [CapRover one-click apps](https://caprover.com/docs/one-click-apps.html).
- CapRover's highest-reaction open request (26 reactions, opened Nov 2020) asks for a zip/tar upload of static files through the web UI, with nginx configured automatically and no CLI or definition file. A commenter adds that the documented flow runs a second nginx container on memory-constrained servers — [CapRover issue #905](https://github.com/caprover/caprover/issues/905).
- **Dokku** supports git-push builds with Herokuish/Cloud Native buildpacks, Dockerfile, Nixpacks, Railpack, Lambda and a null builder; Procfile process types (web/worker), one-off tasks, cron, persistent storage, resource management, zero-downtime checks, and pluggable proxies (Caddy, HAProxy, Nginx, OpenResty, Traefik). Schedulers include Docker local, K3s, Nomad and null — [Dokku installation](https://dokku.com/docs/getting-started/installation/).
- **Kamal** deploys a Dockerfile-built image to one or many servers, with "accessories" for supporting containers (databases, Redis), roles, cron, hooks, and kamal-proxy doing health-gated traffic switching. There is no UI, no app catalogue and no per-tenant model — [Kamal installation](https://kamal-deploy.org/docs/installation/); [Kamal proxy](https://kamal-deploy.org/docs/configuration/proxy/).
- **Easypanel** advertises automatic GitHub deploys with zero downtime, managed Postgres/MySQL/MongoDB/Redis, automatic backups and one-click restores, monitoring, logs and application shells — [Easypanel home](https://easypanel.io/).
- **Portainer** is a container/Kubernetes management plane, not a buildpack PaaS: Git-based stacks, GitOps workflows, Helm, Compose/Swarm stacks, kubectl shell and Edge stacks are the deployment surface — [Portainer release notes](https://docs.portainer.io/release-notes).
- **Cosmos** manages individual Docker containers ("ServApps"): start/stop/restart/pause/recreate/kill/update, image/env/label editing, networks/ports, bind and named volumes, logs with level filtering, and a terminal that can either attach to the main TTY or open a new shell. Compose and its own "cosmos-compose" can be imported. "Lazy start" stops idle containers and starts them on the next request — [Cosmos ServApps](https://cosmos-cloud.io/docs/servapps/).
- **Runtipi** installs apps from a store of Compose definitions, generates `docker-compose.generated.yml`, wires Traefik labels, runs a health check, and stores app data under `app-data`. Custom compose and dynamic compose are supported; the pitch is "no YAML editing" — [How Runtipi works](https://runtipi.io/docs/learn/how-it-works).
- Demand for deployment flexibility is visible in Dokploy's issue tracker: preview deployments for Compose apps (89 reactions, open), Caddy support (70, open), rollback (69, closed), Pulumi support (64, open), OIDC (63, closed), external secret managers (60, closed), backups (59, closed), multiple admins (58, closed), Compose replicas/HPA autoscaling (55, open), custom build server (50, closed), cron (48, closed), pre/post-deploy commands (42, open), project import/export (40, open) — [Dokploy issues sorted by reactions](https://github.com/Dokploy/dokploy/issues?q=is%3Aissue+sort%3Areactions-desc).
- Coolify's long-running asks include a backup manager in the UI (38 reactions, open), background/cron jobs (22, closed) and Kubernetes integration (29 and 49, both closed) — [Coolify issues sorted by reactions](https://github.com/coollabsio/coolify/issues?q=is%3Aissue+sort%3Areactions-desc).

### Inferences
- Yoal should make **static deployment the primary path**, not a build-method dropdown: drag-and-drop or Git-connected static build, atomic release directory, instant rollback, preview URLs per branch. CapRover's #905 proves users will choose a product that removes the nginx/CLI/definition step.
- Buildpacks (Heroku/Paketo/Nixpacks/Railpack) are a maintenance tax with opaque failures. For v2 process apps, support Dockerfile and Compose and stop there; let users bring a built image. This keeps the "tiny footprint" promise and avoids reimplementing Dokku.
- Preview environments are the highest-leverage app feature after rollback. Dokploy's 89-reaction open issue is specifically about Compose parity, meaning simple-app previews already exist — users expect them everywhere.
- Rollback should be framed as a release property (immutable releases + pointer swap), which Yoal already models, rather than "redeploy an old image".
- Per-app "pre/post deploy commands" (42 reactions) and watch paths are cheap, high-value additions for monorepos.
- Avoid Compose-as-the-core-abstraction. Cosmos and Dokploy show the cost: partial compatibility warnings, ignored fields, and a second config language. Offer Compose as an advanced workload type, not the product model.

### Gaps
- No data on what share of users deploy static vs container vs Compose, so prioritisation between static polish and v2 app depth is judgement.
- No public benchmark of build resource use or deploy duration across products.
- Could not verify CapRover's real Compose coverage; its docs call it experimental while Dokploy's comparison table simply marks it unsupported (vendor-authored, likely stale).

## Infrastructure, networking and data protection

### Takeaway
Multi-server is expected, but almost everyone implements it as SSH fan-out (Coolify, Dokploy, Kamal) or Docker Swarm/Kubernetes (CapRover, Portainer, Cosmos Pro). Caddy remains a minority choice: Coolify added it, and Dokploy's 70-reaction Caddy request is still open. S3/R2 backups are standard; verified restores are not.

### Cited Findings
- **Coolify** manages one or many servers over SSH, with server roles, dedicated build servers, GitHub Actions runners on build servers, Docker network "destinations", a beta server-transfer between instances, and provider provisioning. It explicitly deprecates Docker Swarm and offers multi-server deployments via a shared image/registry plus a cloud load balancer rather than an orchestrator — [Coolify docs index](https://coolify.io/docs/llms.txt).
- Coolify's proxy layer supports Traefik (default), Caddy, or a custom proxy, with per-resource domains, path routing, redirects, basic auth, custom middlewares, DNS-01, wildcard certs and custom certificates — [Coolify docs index](https://coolify.io/docs/llms.txt).
- **Dokploy** has remote deploy servers, separate build servers, a Swarm-based "Cluster" section, Traefik configuration, DNS providers, certificate management, S3 destinations, volume backups, Cloudflare Tunnels and Tailscale guides — [Dokploy docs nav](https://docs.dokploy.com/docs/core); [Dokploy features](https://docs.dokploy.com/docs/core/features).
- **CapRover** documents a "Server & Clusters" section and uses Docker Swarm under the hood; the installer initialises Swarm even on a single node — [CapRover getting started](https://caprover.com/docs/get-started.html).
- **Dokku** is single-server by default but can use K3s or Nomad schedulers; the K3s path requires ≥2 GB RAM per node — [Dokku installation](https://dokku.com/docs/getting-started/installation/).
- **Kamal** targets many servers through roles (`web`, `workers`, …), with the proxy enabled on the primary role by default and optionally on others. It has no scheduler, placement engine or private-network abstraction; a load balancer is the user's problem — [Kamal proxy](https://kamal-deploy.org/docs/configuration/proxy/); [Kamal installation](https://kamal-deploy.org/docs/installation/).
- **Portainer** manages Docker, Swarm, Kubernetes and Podman, including Edge Agents that need no inbound ports. Its 2.45.0 release claims scale testing against 500,000 simulated Edge devices, and adds scoped, read-only kubeconfigs and a Kubernetes-native additive RBAC mode — [Portainer release notes](https://docs.portainer.io/release-notes).
- **Cosmos Pro** adds multi-provider clustering ("Hetzner, OVH, bare metal"), encrypted inter-cluster networking via "Constellation VPN", managed databases, S3-compatible object storage, package registries, cloud functions and CI/CD — [Cosmos docs](https://cosmos-cloud.io/docs/); [Cosmos home](https://cosmos-cloud.io/).
- **Runtipi** is explicitly single-server, with Traefik handling routing and certificates, plus guides for Cloudflare Tunnels, local CA certificates and Cloudflare DNS-01 — [How Runtipi works](https://runtipi.io/docs/learn/how-it-works); [Runtipi docs nav](https://runtipi.io/docs/introduction).
- **Backups:** Coolify schedules local and S3 backups for volume/directory mounts with retention and per-run verification, and supports Amazon S3, Cloudflare R2, Neon and Supabase storage. Dokploy has database and volume backups to S3-compatible destinations. Easypanel advertises automatic backups and one-click restores. Runtipi 4.12 made CLI backup/restore preserve symlinks and report job progress; 4.11 made backup/update tracked, cancellable jobs — [Coolify docs index](https://coolify.io/docs/llms.txt); [Dokploy MCP inventory](https://github.com/Dokploy/mcp); [Easypanel home](https://easypanel.io/); [Runtipi v4.12.0](https://github.com/runtipi/runtipi/releases/tag/v4.12.0).
- **Restore is the weak point.** CapRover explicitly warns that configuration backups do not contain database volumes and that persistent services need separate application-data backups. Coolify documents restore of the instance and of database backups, but its own users still ask for a unified backup manager (38 reactions, open). No reviewed product advertises scheduled *restore drills* — [CapRover one-click apps](https://caprover.com/docs/one-click-apps.html); [Coolify issue #2389](https://github.com/coollabsio/coolify/issues/2389).
- **DNS/TLS automation:** Coolify supports DNS-01, wildcard certificates and per-server resolvers; Runtipi has Cloudflare DNS-01 and Cloudflare Tunnel guides; Cosmos has an open request for automatic Cloudflare DNS records (6 reactions); CapRover requires the user to create wildcard DNS manually — [Coolify docs index](https://coolify.io/docs/llms.txt); [Runtipi docs nav](https://runtipi.io/docs/introduction); [Cosmos issue #51](https://github.com/azukaar/Cosmos-Server/issues/51).
- **Host maintenance:** Coolify can check and install OS package updates, enable automatic security updates, inspect Docker image disk usage and schedule Docker cleanup. CapRover 1.16 added disk-usage monitoring with persistent low-space alerts and Docker API compatibility checks before upgrades — [Coolify docs index](https://coolify.io/docs/llms.txt); [CapRover v1.16.0](https://github.com/caprover/caprover/releases/tag/v1.16.0).

### Inferences
- Yoal's node-agent reconciliation is architecturally closer to Portainer Edge (pull, no inbound ports) than to Coolify/Dokploy (push over SSH). That is a defensible advantage for NAT'd, home-lab and edge nodes, and should shape the story: "enrol, don't expose SSH".
- Caddy-native automatic HTTPS plus DNS-01/Cloudflare is a wedge. Users are asking Dokploy for Caddy by name (70 reactions), and Coolify's Caddy support is comparatively new. Yoal should expose wildcard certs, per-site custom certs and DNS-01 as first-class UI, not YAML.
- Keep placement simple: node labels/constraints (region, size, tags) and per-app pinning cover most self-hosted needs. Do not build a scheduler. Explicitly market "no Kubernetes, no Swarm".
- Private networking is the hard part of multi-node. Options: per-node Caddy upstreams over TLS, or an optional WireGuard mesh; avoid making it mandatory for single-node users.
- Backups are commodity; **restore verification** is not. Yoal already has "backup/restore drills" — turn that into a visible, scheduled, pass/fail artefact with the last successful drill timestamp. This directly answers the distrust created by Coolify's missing backup manager and CapRover's volume warning.
- Alert on disk pressure and cert expiry by default. CapRover's low-space alert is a small feature that prevents the most common self-hosted outage.

### Gaps
- No public data on how many users actually run multi-server; vendor emphasis may overstate demand.
- Could not establish whether Coolify's Caddy support reaches parity with Traefik (middlewares, load balancing, dashboard); docs list fewer Caddy subpages.
- No documented private-networking model for Easypanel; unclear whether it supports multiple servers at all.
- No benchmark of agent-based vs SSH-based reconciliation reliability or resource overhead.
- Snapshot semantics are thinly documented across the field; Portainer mentions Edge snapshots only in passing and none of the reviewed products describe filesystem/volume snapshotting with a retention policy.

## Operations: logs, metrics, alerts and scheduled work

### Takeaway
Built-in observability is deliberately shallow everywhere: live logs, CPU/RAM/disk/network charts, notification fan-out and log drains, with vendors telling users to bring their own system for retention and threshold alerting. Coolify's proxy-level traffic analytics is the standout differentiator. Yoal should ship "good enough" metrics plus alerts and export, not an observability suite.

### Cited Findings
- **Coolify Sentinel** provides server-to-control-plane health, container state and disk checks; enabling metrics adds historical CPU, memory, disk, network and load charts. Coolify explicitly says built-in monitoring is not a complete observability system and that threshold alerts, external endpoint checks, log retention/querying and log-based alerting require external tools — [Coolify monitoring overview](https://coolify.io/docs/core/observability/monitoring/overview).
- Coolify's traffic analytics adds request, bandwidth, visitor, latency and traffic breakdowns for **Traefik and Caddy**, enabled per server and off by default — [Coolify monitoring overview](https://coolify.io/docs/core/observability/monitoring/overview).
- Coolify forwards container logs via log drains to Axiom, New Relic, Amazon CloudWatch or custom Fluent Bit. Notifications go to email, Discord, Telegram, Slack, Mattermost, Pushover and generic webhooks, with per-event selection across deployments, backups, scheduled tasks, containers and servers — [Coolify docs index](https://coolify.io/docs/llms.txt).
- Coolify has scheduled commands inside app/service containers with execution history and downloadable logs, plus server patching and automated Docker cleanup — [Coolify docs index](https://coolify.io/docs/llms.txt).
- **Dokploy** exposes real-time logs and CPU/memory/disk/network metrics per app, Compose service and database, plus deployment logs and queue cancellation. Notifications cover Slack, Discord, Telegram, Email, Teams, Gotify, Ntfy, Pushover, Lark, Mattermost, Resend and custom webhooks (41 notification tools in its MCP inventory) — [Dokploy features](https://docs.dokploy.com/docs/core/features); [Dokploy MCP](https://github.com/Dokploy/mcp).
- **CapRover 1.16** added app runtime health and diagnostics (instance counts, task history), disk-usage monitoring with persistent low-space alerts, and Docker API compatibility checks before upgrades — [CapRover v1.16.0](https://github.com/caprover/caprover/releases/tag/v1.16.0).
- **Portainer** added an Observability policy that deploys OneUptime monitoring agents and surfaces Logs and Metrics tabs on applications, namespaces and Helm releases; it also has built-in alerts, activity logs and S3/Azure backup targets — [Portainer 2.44.0 release notes](https://docs.portainer.io/release-notes).
- **Runtipi 4.11/4.12** turned backups and app updates into tracked jobs with phase, elapsed time, failures and cancellation, and fixed memory reporting inside LXC containers — [Runtipi v4.11.0](https://github.com/runtipi/runtipi/releases/tag/v4.11.0); [Runtipi v4.12.0](https://github.com/runtipi/runtipi/releases/tag/v4.12.0).
- **Cosmos** checks for new image versions every six hours, auto-updates containers in auto-update mode, and offers monitoring/alerts plus automated backups — [Cosmos ServApps](https://cosmos-cloud.io/docs/servapps/); [Cosmos home](https://cosmos-cloud.io/).
- **Kamal 2.12** added native OpenTelemetry support for deploy logs; kamal-proxy exposes a Prometheus metrics port. There is no built-in alerting or dashboard — [Kamal v2.12.0](https://github.com/basecamp/kamal/releases/tag/v2.12.0); [Kamal proxy](https://kamal-deploy.org/docs/configuration/proxy/).
- Security/update management is part of ops: Coolify shipped an advisory for "PHP2Shell" (CVE-2026-109618/109619) via a GitHub security issue, and CapRover marked a Node.js CVE update "IMMEDIATELY UPGRADE" — [Coolify issue #12266](https://github.com/coollabsio/coolify/issues/12266); [CapRover v1.15.5](https://github.com/caprover/caprover/releases/tag/v1.15.5).

### Inferences
- The expected ops bundle is: live logs, 5-minute-resolution CPU/RAM/disk/net charts, per-site request/latency/bandwidth, threshold alerts to email/Slack/Discord/webhook, cron with run history, and an export path (OTel/Prometheus/log drain). Everything beyond that is a separate product.
- Yoal's existing traffic telemetry is a stronger differentiator than another Grafana clone. Surface it per site and per app, and make "top paths / 4xx / latency / bytes" a first-class screen.
- Alerting should be opinionated out of the box: disk >85%, cert expiring <14 days, deploys failing repeatedly, node offline, backup/drill failed. Users should not have to write queries.
- Scheduled tasks with history are cheap and expected; for a static-first platform the core jobs are cache purge, cert renewal, backup/drill and content refresh.
- Update management is a trust feature. Publish a security advisory feed, show installed vs available agent/control-plane versions, and support staged rollout plus rollback. Coolify's update regressions (see demand section) show what happens when this is weak.
- Do not build log storage. Offer drains/export and keep a short local ring buffer for debugging.

### Gaps
- No data on retention periods or metric resolution used by competitors; docs are vague.
- No evidence on which notification channel mix matters most, only that breadth is marketed.
- No public postmortems quantifying downtime from control-plane updates.

## Access control, identity and multi-tenancy

### Takeaway
Teams, roles and audit logs are now expected in the open-source tier (Coolify). SSO, SCIM and custom roles are monetised (Dokploy Enterprise). 2FA is baseline, passkeys are emerging, and setup tokens/first-admin windows are becoming a security norm. Yoal's orgs/RBAC/audit already exceeds most of the field; the gaps are 2FA enforcement, scoped tokens and SSO.

### Cited Findings
- **Coolify** has team roles Owner/Admin/Member with documented differences across team management, resources, servers, credentials and API tokens; team/project/environment/server-scoped shared variables; and a searchable audit log. All are in the open-source docs — [Coolify docs index](https://coolify.io/docs/llms.txt).
- Coolify supports OAuth sign-in with GitHub, GitLab, Google, Azure, Bitbucket, Discord and Infomaniak; OIDC SSO plus Authentik, Clerk and Zitadel integrations; TOTP 2FA with recovery codes; passkeys; and scoped API tokens. Team owners/admins can require 2FA for all members (v4.5.1) — [Coolify docs index](https://coolify.io/docs/llms.txt); [Coolify v4.5.1](https://github.com/coollabsio/coolify/releases/tag/v4.5.1).
- Coolify API/MCP tokens carry abilities such as `read:sensitive`, `write` and `delete`; since v4.6.0 every delete through the API or MCP requires the `delete` ability or `root`, and only an instance admin can enable/disable the API or MCP server — [Coolify v4.6.0](https://github.com/coollabsio/coolify/releases/tag/v4.6.0).
- **Dokploy** has organisations, invitations, member roles, API keys and 2FA. SSO (OIDC/SAML), SCIM provisioning, custom roles, audit logs, application forward-auth and whitelabeling are **Enterprise**, available via a self-hosted licence key or Enterprise Cloud — [Dokploy enterprise](https://docs.dokploy.com/docs/core/enterprise).
- **Portainer** publishes CE and BE editions. The 2.45 release notes (BE) cover roles, teams, namespace-scoped RBAC, scoped kubeconfigs, activity logs and FIPS mode; pricing is per node with a free start for 3 nodes (Starter from $1,045/yr for 5 nodes) — [Portainer release notes](https://docs.portainer.io/release-notes); [Portainer pricing](https://www.portainer.io/pricing).
- **CapRover**'s 2FA request was closed (16 reactions); its docs describe a single-admin dashboard model. Dokploy's vendor comparison claims CapRover has no user-permission management — treat that as a vendor claim, not verified — [CapRover issue #493](https://github.com/caprover/caprover/issues/493); [Dokploy comparison](https://docs.dokploy.com/docs/core/comparison).
- **Cosmos** has users, OpenID, 2FA and (Pro) groups and permissions. An open request asks for per-user selection of which routes/containers are accessible (7 reactions), i.e. route-level authorisation beyond coarse groups — [Cosmos docs](https://cosmos-cloud.io/docs/); [Cosmos issue #72](https://github.com/azukaar/Cosmos-Server/issues/72).
- **Runtipi** has dashboard users and a guest dashboard; a 2FA/TOTP request was closed (5 reactions) — [Runtipi issue #250](https://github.com/runtipi/runtipi/issues/250).
- **Dokku** uses SSH keys as its user model and has no web RBAC; **Kamal** has no user model at all — [Dokku installation](https://dokku.com/docs/getting-started/installation/); [Kamal installation](https://kamal-deploy.org/docs/installation/).
- **First-admin security patterns:** Coolify limits first-root registration to ten minutes after startup; Portainer requires a one-time setup token from the logs before creating the first admin or restoring a backup — [Coolify v4.5.1](https://github.com/coollabsio/coolify/releases/tag/v4.5.1); [Portainer 2.43.0](https://docs.portainer.io/release-notes).
- **Public status pages:** none of the reviewed product docs describe a native public status page; the pattern is a separate monitoring app (Portainer integrates OneUptime, others rely on one-click monitoring templates) — [Portainer 2.44.0](https://docs.portainer.io/release-notes).

### Inferences
- Yoal is already ahead on orgs/RBAC/audit relative to CapRover, Dokku, Kamal and Runtipi. It should not spend early effort on SCIM; instead close the cheap gaps: enforced 2FA, passkeys, per-environment token scopes, and session/device management.
- Route/site-level permissions are the agency/team use case: "this client can deploy this site but cannot see the node, env vars or other orgs". Cosmos's open issue shows demand; Yoal's org model is the right shape.
- A read-only public status page generated from existing health/telemetry is a natural static-first feature and a differentiator, since nobody ships one natively. It also dogfoods static hosting.
- Token design matters more in an MCP world: separate read-only, deploy-only, secrets-read and destructive abilities, with per-org/per-environment scope and audit on every call.

### Gaps
- No verified CE-vs-BE feature matrix for Portainer; the release notes are BE-centric.
- No public pricing for Dokploy Enterprise self-hosted; cannot assess how much SSO/SCIM gates adoption.
- Could not confirm CapRover's current multi-user capabilities; docs do not document teams.
- No evidence on whether buyers actually require SSO at Yoal's likely scale.

## Agentic AI and MCP

### Takeaway
The 2026 differentiator is a first-party, well-governed MCP server plus bring-your-own-model assistance, not a proprietary copilot. Coolify and Dokploy both ship MCP; Dokploy auto-generates 508 tools from its OpenAPI spec with redaction on by default and read-only/destructive annotations. Yoal's first-class MCP is ahead of the field if it ships scoped permissions, read-only defaults and audit.

### Cited Findings
- **Coolify MCP** connects AI clients over Streamable HTTP. On self-hosted instances it is disabled by default and must be enabled under Settings → Advanced → "API and MCP"; Cloud has it on. Authentication is team-scoped, and the docs frame capabilities as tools, resources and prompts, with a recommended starting point of help/infrastructure-overview/search tools — [Coolify MCP overview](https://coolify.io/docs/mcp/overview).
- Coolify hardened MCP in v4.6.0: deletes require the `delete` ability or `root`, locked env values are hidden from resource-list endpoints, and enabling/disabling MCP is admin-only. v4.5.3 fixed MCP tokens with `read:sensitive` not seeing app commands/config — [Coolify v4.6.0](https://github.com/coollabsio/coolify/releases/tag/v4.6.0); [Coolify v4.5.3](https://github.com/coollabsio/coolify/releases/tag/v4.5.3).
- **Dokploy MCP** is an official Apache-2.0 package exposing "508 tools across 49 categories", auto-generated from the Dokploy OpenAPI spec. It supports stdio and Streamable HTTP (plus legacy SSE), tool presets (`minimal`, `core`, `deploy`, `databases`, `git`), tag include/exclude filters, per-call semantic annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`), retries and timeouts — [Dokploy MCP](https://github.com/Dokploy/mcp).
- Dokploy MCP redacts secret-bearing fields by default (`DOKPLOY_REDACT_ENV=true`), covering env vars, compose files, passwords, tokens, keys and SSH material, with configurable extra fields. It also supports custom headers for Cloudflare Access — [Dokploy MCP](https://github.com/Dokploy/mcp).
- **Dokploy AI Assistant** is bring-your-own-provider: any OpenAI-compatible endpoint (OpenAI, Anthropic, Ollama, OpenRouter, Azure). It generates Docker Compose from natural language and analyses deployment/runtime logs, optionally reading source with a read-only agent — [Dokploy AI](https://docs.dokploy.com/docs/core/ai).
- Dokploy's log analysis sends 200 lines by default (1–10,000 configurable, 1 MiB cap), and source inspection is bounded to 8 tool rounds, 20 file reads, 64 KiB per file and 256 KiB total. The agent cannot edit files, execute commands or redeploy; `.env`, credentials, git internals, dependencies, binaries and symlinks are excluded — [Dokploy AI](https://docs.dokploy.com/docs/core/ai).
- **Adoption signal:** Dokploy's MCP repo has 421 stars and 91 forks, and search results show multiple third-party Coolify MCP servers plus Reddit discussion, indicating demand beyond the vendors — [Dokploy MCP](https://github.com/Dokploy/mcp); [Coolify MCP search results](https://coolify.io/docs/mcp/overview).
- **Portainer** markets a separate `portainer.ai` property but the reviewed Portainer docs/release notes do not describe an MCP server; **Runtipi, Cosmos, CapRover, Dokku, Kamal and Easypanel** likewise have no official MCP server in the docs reviewed — [Portainer pricing footer](https://www.portainer.io/pricing); [Runtipi docs](https://runtipi.io/docs/introduction); [Cosmos docs](https://cosmos-cloud.io/docs/); [CapRover docs](https://caprover.com/docs/get-started.html); [Dokku docs](https://dokku.com/docs/getting-started/installation/); [Kamal docs](https://kamal-deploy.org/docs/installation/); [Easypanel docs](https://easypanel.io/docs).

### Inferences
- Yoal should position MCP as a **governed operations API**, not a chat toy: per-org/per-environment tokens, read-only by default, explicit destructive ability, redaction of secrets/env/compose, tool presets to fit small context windows, and an audit entry per tool call.
- The strongest low-risk AI feature is log/deploy-failure analysis with a BYO key, because it is read-only and demonstrably useful. Natural-language deploys should be "propose a plan → diff → human confirms", never autonomous.
- Tool-list bloat is a real failure mode (Dokploy ships 508 tools and therefore presets). Yoal should ship a small, task-shaped tool surface (`list_sites`, `get_release`, `deploy`, `rollback`, `read_logs`, `get_metrics`) rather than mirroring every REST endpoint.
- Agents will be a primary consumer of Yoal. Design for machine clients: stable IDs, idempotency keys, structured errors, pagination, and a machine-readable capability manifest.

### Gaps
- No usage data for Coolify/Dokploy MCP; stars and docs do not prove active use.
- No standard for MCP authentication/authorisation yet; vendor designs are ad hoc.
- Could not verify whether Portainer has an MCP server outside the docs reviewed; absence of evidence, not proof of absence.
- No evidence that AI features influence purchase decisions in this category.

## Community demand and roadmap signals, 2025–2026

### Takeaway
Demand clusters around production reliability (zero-downtime, rollback, backups/restore, autoscaling), deployment flexibility (Compose previews, Caddy, GitLab), portability (node transfer, project import/export) and UX polish. Reliability complaints outrank feature requests in reaction volume. Static deploy simplification is CapRover's top open ask and has been since 2020 — direct validation of Yoal's wedge.

### Cited Findings
- **Coolify top reactions** (GitHub search, 4 Nov 2026): v5.x meta-announcement 691 (open); "Who is using Coolify?" 127 (open); Traefik proxy broken after update 73 (closed bug); "Full Kubernetes support with autoscale" 49 (closed); IPv6 server add 43 (closed bug); "Backup Manager in the UI" 38 (open); update issue 4.5.3→4.5.4 33 (closed); unexplained high CPU after deploy 30 (closed); Kubernetes integration 29 (closed); PostHog template broken 28 (closed); container labels 27 (closed); PHP2Shell security advisory 26 (closed); macOS server support 24 (closed); pgBackRest for Postgres 24 (closed); background/cron jobs 22 (closed) — [Coolify issues by reactions](https://github.com/coollabsio/coolify/issues?q=is%3Aissue+sort%3Areactions-desc).
- **Coolify v5 status:** announced Apr 2025 as a full rewrite (Vue/Inertia, test-first, "one-click scaling"), still not shipped by Nov 2026. The maintainer describes burnout, a replan, and a new approach where v5 arrives at a `/v5` URL on the existing instance with direct DB access for migration. v4.6.0 shipped 2 Nov 2026 — [Coolify issue #5685](https://github.com/coollabsio/coolify/issues/5685); [Coolify v4.6.0](https://github.com/coollabsio/coolify/releases/tag/v4.6.0).
- **Dokploy top reactions:** transfer apps to a different node 89 (closed); preview deployments on Compose apps 89 (open); Caddy support 70 (open); rollback service deployments 69 (closed); Pulumi support 64 (open); OIDC auth 63 (closed); external secret managers (Vault/AWS) 60 (closed); backups for Dokploy 59 (closed); multiple admins 58 (closed); Compose replicas + HPA autoscaling 55 (open); custom build server 50 (closed); cronjobs 48 (closed); pre/post deploy commands 42 (open); project import/export 40 (open); pull updated images via UI 39 (closed) — [Dokploy issues by reactions](https://github.com/Dokploy/dokploy/issues?q=is%3Aissue+sort%3Areactions-desc).
- **CapRover top reactions:** simplify static file deploy 26 (open since 2020); enforce HTTPS 23 (closed); webhook or alert 22 (closed); custom one-click app repositories 20 (closed); 2FA 16 (closed); database migration best practices 14 (open); Docker Hub webhook deploy 11 (open); HTTPS enabled by default 11 (open); scheduled disk cleanup 11 (closed); Netdata in Swarm mode 10 (open) — [CapRover issues by reactions](https://github.com/caprover/caprover/issues?q=is%3Aissue+sort%3Areactions-desc).
- **Runtipi top reactions:** configurable data storage path 11 (open); reverse proxy request 9 (closed); multiple instances of an app 9 (closed); edit compose in UI 5 (closed); 2FA 5 (closed); prune unused images 5 (open); user-config git repo 5 (closed); external link on guest dashboard 5 (closed); app-store filter for new apps 5 (open); general backup/restore in UI 5 (open); Traefik whitelist for FQDN access 4 (open) — [Runtipi issues by reactions](https://github.com/runtipi/runtipi/issues?q=is%3Aissue+sort%3Areactions-desc).
- **Cosmos top reactions:** see new ServApps in market 17 (open); test SMTP setup button 16 (open); clean old images 12 (closed); YubiKey 2FA 11 (open); Podman/rootless 11 (open); Cosmos Tunnels 7 (closed); per-user route/container permissions 7 (open); automatic Cloudflare DNS records 6 (open); VM support 5 (open); LDAP server 5 (open) — [Cosmos issues by reactions](https://github.com/azukaar/Cosmos-Server/issues?q=is%3Aissue+sort%3Areactions-desc).
- **Release themes 2025–26 — Coolify:** 2FA enforcement, custom themes with share codes, draggable canvas, live CPU/memory in the server table, synced metric tooltips, compact traffic metrics, file-browser container picker, S3 path-style URLs, rolling-update retries and configurable drain, one-Sentinel-command metrics, MCP permission hardening — [Coolify v4.5.1](https://github.com/coollabsio/coolify/releases/tag/v4.5.1); [Coolify v4.6.0](https://github.com/coollabsio/coolify/releases/tag/v4.6.0).
- **Release themes — CapRover:** dashboard redesign, guided setup, preflight installer diagnostics, runtime health/diagnostics, disk alerts, 11 themes, Compose compatibility warnings, WebSocket on by default, Docker API compatibility checks — [CapRover v1.16.0](https://github.com/caprover/caprover/releases/tag/v1.16.0).
- **Release themes — Dokploy:** 0.30.x is mostly maintenance (Node 24 security bump, Railpack versions, billing/trial warnings); the product's energy is in MCP/AI and Enterprise — [Dokploy v0.30.10](https://github.com/Dokploy/dokploy/releases/tag/v0.30.10); [Dokploy AI](https://docs.dokploy.com/docs/core/ai).
- **Release themes — Runtipi:** ordered app-store migrations with pre-migration backup, tracked/cancellable jobs, symlink-preserving backups, separate internal network for core DB/queue, local CA for Firefox HTTPS, LXC memory-reporting fix — [Runtipi v4.11.0](https://github.com/runtipi/runtipi/releases/tag/v4.11.0); [Runtipi v4.12.0](https://github.com/runtipi/runtipi/releases/tag/v4.12.0).
- **Release themes — Kamal:** 2.12 (Jun 2026) added OpenTelemetry deploy logs, `stop_timeout`, `forward_agent`, `--raw` exec; 2.10 added mount options, accessory file ownership/permissions, proxy run config in YAML, parallel boot — [Kamal v2.12.0](https://github.com/basecamp/kamal/releases/tag/v2.12.0).
- **Release themes — Portainer:** add-ons marketplace, OneUptime observability policy, Pod Security Standards and network-security policies, SSRF allow-list, scoped kubeconfigs, Edge fleet scale work, node-drain options — [Portainer release notes](https://docs.portainer.io/release-notes).
- **Release themes — Cosmos:** the GitHub release feed shows only `0.24.0-unstableNNN` builds through Oct 2026; no stable 0.24 release appears in the last four entries. The site advertises 250+ apps and 2,500+ servers (vendor claims) — [Cosmos releases](https://github.com/azukaar/Cosmos-Server/releases); [Cosmos home](https://cosmos-cloud.io/).
- **Licence/business model where it gates features:** Dokploy is Apache-2.0 except `/proprietary`, with SSO/SCIM/custom roles/audit/app-auth behind an Enterprise licence. Portainer is Zlib CE plus paid BE per node. Cosmos is Apache-2.0 + Commons Clause + Anti-Tampering, with clustering/managed DB/object storage/CI-CD in Pro. Easypanel is commercial with a free tier of 3 projects and per-server paid plans. Coolify, CapRover, Dokku and Kamal are permissively licensed; Dokku also sells a separate Pro product. Runtipi is GPL-3.0 — [Dokploy licence](https://github.com/Dokploy/dokploy/blob/main/LICENSE.MD); [Dokploy enterprise](https://docs.dokploy.com/docs/core/enterprise); [Portainer pricing](https://www.portainer.io/pricing); [Cosmos licence](https://github.com/azukaar/Cosmos-Server/blob/master/LICENCE); [Easypanel pricing](https://easypanel.io/pricing); [Coolify repo](https://github.com/coollabsio/coolify); [CapRover repo](https://github.com/caprover/caprover); [Dokku repo](https://github.com/dokku/dokku); [Kamal repo](https://github.com/basecamp/kamal); [Runtipi repo](https://github.com/runtipi/runtipi).

### Inferences
- **Reliability is the top unmet need.** The highest-reaction non-meta items across Coolify are a proxy regression and a broken update; CapRover's top items include HTTPS enforcement and disk cleanup; Dokploy's include rollback and node transfer. Users reward stability more than catalogue size. For Yoal: immutable releases, one-click control-plane rollback, staged agent updates, and a public changelog/advisory feed.
- **Portability is a recurring theme:** Dokploy node transfer (89), project import/export (40), Coolify server transfer (beta), Runtipi export/import. Yoal should support export/import of a site/app as a directory + manifest, and node draining/migration.
- **Proxy choice is political.** Dokploy users ask for Caddy by name (70). Yoal should make "Caddy, automatic HTTPS, DNS-01" a headline rather than an implementation detail.
- **Backups are expected; verified restores are not.** Coolify's open backup-manager request and CapRover's volume warning show the gap. Yoal's restore drills are a credible, defensible feature if surfaced.
- **Autoscaling is loud but a poor fit.** Dokploy's HPA request (55) and Coolify's K8s/autoscale requests (49/29, closed) come from users running production SaaS. Chasing them pulls Yoal toward Kubernetes, which contradicts its stated non-goal. Better to support vertical resize, multiple nodes with manual placement, and honest "this is not for hyperscale" positioning.
- **The v5 cautionary tale:** a two-year rewrite with a promised "one-click scale" stalled, burned out a maintainer and eroded trust. Yoal should ship incremental, reversible changes and keep the control plane boring.

### Feature shortlist for Yoal (problem → fit)

| Candidate | User problem | Fit for static-first Yoal | Notes / priority |
|---|---|---|---|
| Guided setup checklist + first-deploy wizard | Blank dashboard; "what now?" | **Strong** | Copy CapRover 1.16 / Coolify paths; 5-minute goal. P0 |
| One-command node enrolment with join token, no inbound SSH | SSH keys/root exposure; NAT'd nodes | **Strong, differentiator** | Agent model already exists; market it. P0 |
| Curated static-first template gallery (20–40) | Time-to-value; nginx boilerplate | **Strong** | Astro/SvelteKit/Next export, docs, blog, redirects, image proxy, status page. P0 |
| Third-party template registries | Long-tail apps | **Conditional** | Supply-chain review, signing, pinning; not early. P2 |
| Git deploy + per-branch/PR preview environments | Review and staging workflows | **Strong** | Dokploy's top open ask is Compose previews; static previews are cheap. P0 |
| Dockerfile / Compose workloads | Non-static apps (v2) | **Conditional (v2)** | Keep as advanced path; no Compose-as-core. P1 |
| Buildpacks / Nixpacks / Railpack | Polyglot builds without Dockerfiles | **Poor fit** | Heavy, opaque, maintenance sink. Skip. |
| One-click managed databases | Stateful dependencies | **Poor fit as core** | Template/partner only; conflicts with tiny footprint. P3 |
| Persistent volumes + file browser | State and debugging | **Conditional (v2)** | File browser should reuse source viewer; high security bar. P1 |
| Cron / scheduled tasks with run history | Recurring jobs, cache purge, cert renewal | **Strong** | systemd timers are a natural fit. P0 |
| Workers / process types | Background jobs | **Conditional (v2)** | Model as extra systemd units per app. P1 |
| Health checks + zero-downtime release swap | Bad deploys cause outages | **Strong** | Caddy upstream flip + readiness gate. P0 |
| Rollback to prior release | Bad deploy recovery | **Strong** | Immutable releases already exist; one-click. P0 |
| Resource limits (cgroups) | Noisy neighbours | **Conditional (v2)** | systemd MemoryMax/CPUQuota. P1 |
| Horizontal autoscaling / HPA | Traffic spikes | **Poor fit** | Contradicts no-Kubernetes, tiny footprint. Explicit non-goal. |
| Multi-server placement + node labels | Growth beyond one box | **Strong** | Simple constraints (region/tag/size), manual pinning. P1 |
| Private networking between nodes/apps | App→DB traffic | **Conditional** | Per-node TLS upstreams first; optional WireGuard mesh later. P2 |
| Caddy-native automatic HTTPS | TLS toil | **Strong, differentiator** | Dokploy users request Caddy (70); make it headline. P0 |
| DNS-01 / Cloudflare / wildcard certs | SaaS-style custom domains | **Strong** | Wildcard + per-site custom certs; DNS provider tokens. P0 |
| S3/R2 backups + retention | Data loss | **Strong** | Already present; add per-site/app policy UI. P0 |
| Restore drills + verification | Untested backups | **Strong, differentiator** | Schedule, record pass/fail, show last drill. P0 |
| Live logs + CPU/RAM/disk/net + per-site traffic | Visibility | **Strong** | Traffic telemetry is the standout; keep charts light. P0 |
| Threshold alerts → email/Slack/Discord/webhook | Incident response | **Strong** | Opinionated defaults (disk, cert, node, backup). P0 |
| Log drains / OTel / Prometheus export | Retention and existing stacks | **Conditional** | Export, don't build storage. P1 |
| Server patching + update management + advisories | CVEs, update regressions | **Strong** | Staged agent updates, rollback, security feed. P0 |
| Audit log | Compliance, debugging | **Strong** | Already present; add MCP/API coverage. P0 |
| Orgs / RBAC / custom roles | Multi-team, agencies | **Strong** | Custom roles later; site-level grants first. P1 |
| SSO / SCIM | Enterprise procurement | **Conditional / paid** | Dokploy gates it; only when enterprise demand is proven. P2 |
| 2FA / passkeys / setup token | Account takeover | **Strong** | Enforceable 2FA, passkeys, first-admin token. P0 |
| Scoped API tokens + MCP abilities | Automation safety | **Strong** | read-only / deploy / secrets / destructive scopes. P0 |
| Public status page | Customer trust | **Conditional, differentiator** | Static-generated from health data; nobody ships it natively. P2 |
| MCP server, read-only default, presets, audit | Agent operations | **Strong, differentiator** | Small task-shaped tool surface; per-env tokens. P0 |
| AI log/deploy-failure analysis (BYO key) | Debugging time | **Strong** | Read-only, redacted, bounded. P1 |
| NL compose/deploy generation | Authoring speed | **Conditional** | Propose-plan-confirm only; never autonomous. P2 |
| Kubernetes / Swarm orchestration | Hyperscale scheduling | **Poor fit** | Explicit non-goal; say so in comparisons. |
| Public demo / sandbox | Evaluation | **Strong** | Easypanel/Cosmos both do it. P1 |
| Cloud provider provisioning (Hetzner/DO) | Server setup friction | **Conditional** | API tokens + cloud-init; only after core. P2 |

### Gaps
- No Reddit/HN sentiment analysis was performed; demand signals here are GitHub reactions, which skew toward engaged power users and bugs.
- Reaction counts include all emoji and are a snapshot; GitHub search also surfaces meta/announcement issues (Coolify's 691-reaction v5 post), which inflates "feature demand" if read naively.
- Portainer, Dokku and Kamal top-reaction issues were not queried; their UI/feature-request surface is smaller and less comparable.
- Dokploy's own comparison table is vendor-authored and appears stale (e.g. marks Compose and GitLab unsupported for competitors that document them); it was used only for feature-existence hints, not as ground truth.
- No adoption, revenue or churn data; cannot say which features actually drive purchases.
- No direct interviews with Yoal users; fit judgements are based on the product's stated architecture and positioning, not measured demand.
