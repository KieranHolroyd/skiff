# Close the deploy loop before arming agents

Yoal should spend its next two releases finishing the deploy loop, not widening the platform. Across seven research streams covering more than 25 commercial, self-hosted, static-hosting, and agent-native products, the same pattern holds: Yoal's architecture — pull-based node agents, immutable content-addressed releases, scope∩role MCP authorization, a ~250 MB baseline, and verified restore drills — is already ahead of every self-hosted peer, while its adoption blockers are the ordinary edges teams touch every day. Git builds exist but pull requests get no preview comment, commit check, or deployment status. Releases are immutable but cannot be rolled back to an arbitrary retained release from the dashboard, annotated, or diffed. Previews exist but are not protected by default. Process apps can run but releases lack pre-deploy commands, health-gated activation, drain, and automatic rollback. Agents can deploy but cannot durably wait, approve after a disconnect, or see only the tools their token permits. The order is therefore P0 deploy loop, P0 release safety, P1 agent operations, P1 team trust, P1 operational evidence, P2 static depth, then P2 data depth — with 1.0 as a hardening release rather than a feature dump.

## The next ten features are unfinished edges, not new territory

**Executive summary.** The research does not support a new product category. It supports finishing five surfaces Yoal already owns and then making them safe for teams and agents. The first five are the build-next list because each removes a daily failure: a reviewer cannot find the preview, a developer cannot test redirects locally, an integrator cannot generate a client, an operator cannot return to Tuesday's release, and a client cannot share one deployment without exposing every preview. Each is small to medium work on existing primitives, and compounds: the GitHub App makes previews visible, the CLI makes them reproducible, the release timeline makes them reversible, and preview protection makes them shareable.

| # | Recommendation | Priority | Effort | Why it is next |
|---|---|---|---|---|
| 1 | GitHub App with sticky PR comment, commit check, deployment status, monorepo watch paths | P0 | M | Netlify updates one comment in place and posts status/checks ([Netlify](https://docs.netlify.com/deploy/deploy-notifications/)); GitHub statuses carry `environment_url` and `log_url` ([GitHub](https://docs.github.com/en/rest/deployments/statuses)) |
| 2 | CLI daily loop: `link`, `dev`, `env pull`, `logs -f`, `deploy --wait`, `whoami`, `doctor` | P0 | S–M | Vercel ships all of these ([Vercel CLI](https://vercel.com/docs/cli)); Render's `--wait` exits non-zero on failure ([Render CLI](https://render.com/docs/cli)) |
| 3 | OpenAPI 3.1 from Zod, typed SDK, idempotency keys, stable errors | P0 | S–M | Railway treats its schema as a contract with 429 and `traceId` semantics ([Railway](https://docs.railway.com/integrations/api)) |
| 4 | Release lifecycle: rollback to any retained release, annotations, diffs, changelog, pinning | P0 | S | Vercel Pro/Ent reaches any prior deploy ([Vercel](https://vercel.com/docs/deployments/rollback-production-deployment)); Netlify publishes any prior atomic deploy ([Netlify](https://docs.netlify.com/manage/deploys/manage-deploys-overview/)) |
| 5 | Preview access: protected by default, per-deployment share links, method×scope, bypass token | P0 | S–M | Vercel's method×scope model ([Vercel](https://vercel.com/docs/deployment-protection)); Firebase and Cloudflare previews are public by default ([Cloudflare](https://developers.cloudflare.com/pages/configuration/preview-deployments/)) |
| 6 | Process release safety: pre-deploy command, readiness gate, drain, auto-rollback | P0 | S–M | Fly fails the deploy on a non-zero `release_command` ([Fly](https://docs.fly.io/reference/configuration)); Render exposes `preDeployCommand` and `maxShutdownDelaySeconds` ([Render](https://render.com/docs/blueprint-spec)) |
| 7 | Secrets and config as a product: write-only secrets, env and build/runtime scopes, redaction | P0 | M | Vercel splits readable Config from write-only Secret and scopes by environment ([Vercel](https://vercel.com/docs/environment-variables)); Netlify separates build and runtime scopes ([Netlify](https://docs.netlify.com/manage/deploys/manage-deploys-overview/)) |
| 8 | Agent operations: scope-filtered tools, durable Tasks, staged destructive ops, activity view, quotas | P1 | M | MCP permits auth-varying `tools/list` and defines `input_required` ([MCP](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)); Railway stages `confirm: true` ([Railway](https://docs.railway.com/ai/mcp-server)) |
| 9 | Team governance: OIDC SSO, service accounts, production approvals, audit export, alert routing | P1 | M | Cloudflare gives SSO away free ([Cloudflare](https://developers.cloudflare.com/fundamentals/manage-members/dashboard-sso/)); Better Auth ships SSO/SCIM plugins ([Better Auth](https://better-auth.com/docs/plugins/sso)) |
| 10 | Operational evidence: drift diagnostics, Caddy-served status page, signed updates, restore reports | P1 | S–M | No peer exposes reconciler drift; Coolify's monitoring is explicitly shallow ([Coolify](https://coolify.io/docs/core/observability/monitoring/overview)) |

**Build next, in this order.** Ship 1–5 as the 0.4 "deploy loop" release, because they are mutually reinforcing UI/API work over primitives that already exist: git builds, deployment records, preview URLs, share links, and audit. Then ship 6–7 as 0.5 "release safety", because process apps are now real and a release that runs migrations without a gate is a liability. Only then invest in 8 and 9, because agents amplify a platform whose previews, approvals, and rollback semantics are already legible. Recommendation 10 is the evidence layer that makes the story sellable to an operator's auditor.

The temptation is to do agent features first because they are the differentiator. The research argues otherwise. Vercel and Netlify are converging on agent UX with complete deploy ergonomics; Yoal would be adding durable tasks and inline cards where a reviewer still cannot see a preview in the PR. Agent features are cheaper once the core verbs behave identically across CLI, REST, dashboard, and MCP.

## Scope, method, and what the evidence can bear

This report synthesizes seven notes accessed 4 November 2026: commercial deploy platforms (Vercel, Netlify, Cloudflare Pages/Workers); modern PaaS (Render, Railway, Fly.io, Heroku, Northflank); self-hosted PaaS and control panels (Coolify, Dokploy, CapRover, Dokku, Easypanel, Kamal, Portainer, Runtipi, Cosmos); static hosting and CDN (GitHub Pages, Firebase, Surge, Bunny, Fastly, AWS Amplify); AI/MCP-native deployment (Smithery, Cloudflare, Vercel, Railway, Fly, the MCP Registry, Replit, v0, sandbox vendors); enterprise and operations (plus AWS/GCP/Azure); and developer experience and integrations. Vendor pages change without notice.

Evidence is primary vendor docs, pricing pages, changelogs, repositories, and issue trackers. Pricing is directional and largely irrelevant to a self-hosted open-source product; plan gating separates table stakes from enterprise-only features. Effort is for one experienced engineer: **S** up to a week, **M** two to six weeks, **L** over six weeks. Priority uses **P0** (next one or two releases, blocks adoption or trust), **P1** (next quarter, unlocks teams or agent operations), **P2** (later or on demand), and **Skip** (explicitly will not build). P0 maps to Now, P1 to Next, P2 to Later.

Several caveats bound the conclusions. Vendor documentation is a claim, not a measurement: "zero-downtime", "instant rollback", and "immutable" are architectural assertions the notes record but do not verify. There are no Yoal user interviews, win/loss data, or usage telemetry, so fit is reasoned from the architecture and stated ICP. `docs/ROADMAP.md` lags the shipped surface in the brief — it still shows git builds, custom domains, and environment UI as unchecked — so the brief is treated as authoritative for current capability and the roadmap for known gaps. Tier-3 containers are least certain: the brief says "process/container apps", while the roadmap still lists the Podman Quadlet and optional Docker drivers, so process apps are the near-term v2 surface and container depth is P2. Negative claims are limited to the pages reviewed. The MCP landscape moves monthly: Tasks client support is unproven, MCP Apps is days old in Vercel's implementation, and the Registry is preview with possible data resets.

## Yoal already owns the hard half of the stack

The most important strategic finding is that Yoal's differentiators are architectural, not feature-level, and peers cannot copy them cheaply. That changes the build order: protect the architecture, finish the product surface around it, and avoid features that would force a second security or operations model.

### Pull, don't push, is the self-hosted moat

Coolify, Dokploy, and Kamal enrol servers over SSH and often expect root; Portainer's Edge Agent is the closest peer to Yoal's model ([Coolify](https://coolify.io/docs/core/what-is-coolify), [Dokploy](https://docs.dokploy.com/docs/core/features), [Kamal](https://kamal-deploy.org/docs/installation/), [Portainer](https://docs.portainer.io/start/requirements-and-prerequisites)). Yoal's agents dial out, hold a node token, cache desired state, and keep serving when the control plane is down ([Yoal DESIGN](https://github.com/KieranHolroyd/yoal/blob/main/docs/DESIGN.md)). That is a stronger security story for NAT'd homelabs and a stronger availability story for a single control plane. Reliability complaints also outrank feature requests in self-hosted reaction volume ([Coolify issues](https://github.com/coollabsio/coolify/issues?q=is%3Aissue+sort%3Areactions-desc), [Dokploy issues](https://github.com/Dokploy/dokploy/issues?q=is%3Aissue+sort%3Areactions-desc)). A pull-based reconciler is the right answer, provided Yoal makes drift visible.

### Immutable releases are at parity; the release story is not

Every mature platform has converged on an immutable artifact plus a movable pointer: Vercel and Netlify roll back at the routing layer without rebuilding, Cloudflare Pages rolls back instantly but forbids previews as targets, and Firebase models rollback as a new release pointing at an old version ([Vercel](https://vercel.com/docs/deployments/rollback-production-deployment), [Netlify](https://docs.netlify.com/manage/deploys/manage-deploys-overview/), [Cloudflare](https://developers.cloudflare.com/pages/configuration/rollbacks/), [Firebase](https://firebase.google.com/docs/hosting/manage-hosting-resources)). Yoal's content-addressed release plus pointer swap is architecturally equivalent. The gap is the product surface: Vercel lets Pro and Enterprise target any prior production deployment while Hobby only reaches the previous one; Firebase retains 1–100 releases, default 10; Cloudflare keeps immutable permalinks. Yoal's retention of 10 is in range, but UI, CLI, and MCP must expose rollback to any retained release, annotate who deployed what, and diff files and config before promotion.

### MCP governance is ahead; breadth and durability are behind

Yoal's OAuth 2.1 implementation — CIMD plus DCR, PKCE, consent with permission subsets, scope step-up, elicitation, and a `mcp.<tool>` audit event — is ahead of most self-hosted peers and comparable to Vercel and Cloudflare on auth ([Yoal DESIGN](https://github.com/KieranHolroyd/yoal/blob/main/docs/DESIGN.md)). The distinctive property is that tokens are always **scopes ∩ the user's current role**, so a role change immediately narrows live tokens. Railway scopes OAuth tokens to workspaces and projects but rejects project tokens for audit reasons; Fly lets users approve specific apps and hides the rest from discovery; Cloudflare logs tool, prompt, and resource activity through Access ([Railway](https://docs.railway.com/ai/mcp-server), [Fly](https://fly.io/blog/feng-shui-for-robots), [Cloudflare](https://developers.cloudflare.com/changelog/post/2026-09-24-mcp-portals-ga)). Yoal's model is more explainable. It is behind on breadth, durability, and inline UX; those are P1 additions, not reasons to change the auth model.

### The footprint buys a different customer

The control plane targets 80–150 MB RSS, the agent 30–50 MB, and Caddy 30–50 MB, for a baseline near 250 MB ([Yoal DESIGN](https://github.com/KieranHolroyd/yoal/blob/main/docs/DESIGN.md)). Most self-hosted peers run Docker or Swarm stacks ([Coolify](https://coolify.io/docs/core/what-is-coolify), [Dokploy](https://docs.dokploy.com/docs/core/features), [Portainer](https://docs.portainer.io/start/requirements-and-prerequisites)). Yoal's systemd-plus-Caddy design is a different operating point: a 2 vCPU / 4 GB VPS can host the platform and several small apps without a container daemon. Every recommendation must preserve that; adding Docker as a hard dependency, a Kubernetes scheduler, or a log warehouse would erase the advantage.

### Restore drills are evidence no peer ships

Yoal runs Litestream to R2 with roughly one-second RPO, a monthly restore drill, a recovery kit, `yoal-restore`, and pre-upgrade snapshots ([Yoal OPS](https://github.com/KieranHolroyd/yoal/blob/main/docs/OPS.md)). Peers advertise backups and snapshots but not scheduled restore drills: Coolify's users still ask for a unified backup manager, CapRover warns that configuration backups exclude database volumes, and Render and Fly document snapshot retention without publishing restore SLOs ([Coolify issue](https://github.com/coollabsio/coolify/issues/2389), [Render](https://render.com/docs/postgresql-backups), [Fly](https://docs.fly.io/volumes/snapshots)). The mechanism is better than most hobby tools; the missing piece is evidence — a persisted drill record, a visible timestamp, a downloadable report, and a documented RTO/RPO. That is a P1 differentiator with almost no new infrastructure.

### The trust boundary is a product feature

Platform and content live on separate registrable domains, preview and production cookies are host-only and HMAC-signed, protected sites use `forward_auth` to the local agent, Caddy's admin API is a unix socket, and deployed content is untrusted ([Yoal README](https://github.com/KieranHolroyd/yoal/blob/main/README.md)). That is exactly the boundary agent platforms struggle with: Vercel warns that MCP grants the client the user's access and that prompt injection can exfiltrate logs; Cloudflare sells a gateway and DLP layer to contain it ([Vercel MCP](https://vercel.com/docs/agent-resources/vercel-mcp), [Cloudflare](https://developers.cloudflare.com/changelog/post/2026-09-24-mcp-portals-ga)). Extend the same logic to tool output: site content, logs, and `_headers` are data, never instructions; cross-project reads are capped by default; every agent action is attributable. Do not add a second execution path — a shell, a sandbox, or Code Mode's `execute` — that bypasses the one-service-layer guarantee.

**What to protect, concretely.** Keep one control plane per install and refuse active-active. Keep the agent protocol backward-compatible for one minor version. Keep every surface on `packages/core` so MCP can never exceed the UI. Keep the tool catalog small and task-shaped rather than mirroring every REST endpoint. Keep deployed content off the platform domain. Keep the baseline under 250 MB by refusing bundled observability, a container daemon, and a message queue.

## The market converges on releases, previews, and governance

The landscape splits into saturated table stakes, differentiators that have moved to release safety and agent legibility, and enterprise features that are consistently gated. The matrix condenses the seven research streams.

| Theme | Table stakes | Differentiator | Enterprise-only | Yoal position |
|---|---|---|---|---|
| Release model | Immutable deploy, per-deploy URL, promote/rollback — Vercel, Netlify, Cloudflare, Render, Railway, Fly | Rollback to any prior release (Vercel Pro/Ent, Netlify), traffic splitting (Vercel, Cloudflare, Fly), skew protection | Long retention, rollback audit | Core parity; missing arbitrary-release rollback, annotations, diffs |
| Git and review | Git connect, PR preview, commit status — all SaaS; Coolify, Dokploy | Sticky PR comment, merge-queue checks, focused or bot PR envs (Railway) | Required checks via GitHub/GitLab | Git builds exist; no PR comment, check, or deployment status |
| Config and secrets | Env vars, encrypted secrets, per-environment scope — all | Write-only Secret vs readable Config (Vercel), build/runtime scopes (Netlify), references (Render) | External secret managers, BYOK | Design exists; UI/API/MCP and build/runtime split unfinished |
| Preview access | Password or SSO gate — Vercel, Netlify, Cloudflare Access | Method × scope plus automation bypass (Vercel), per-deployment share links, access requests | Trusted IPs, SAML | Password/platform/share links exist; no matrix, bypass, or per-deployment link |
| Domains and TLS | Custom domain and auto TLS — all | Wildcard, on-demand TLS, cert state machine, disable default subdomain | Cloudflare for SaaS, BYOIP | Caddy, wildcard, custom domains; missing state machine and canonicalization |
| Ops and alerting | Logs, metrics, email/webhook alerts — all self-hosted | Deploy markers, traffic analytics, drift diagnostics, native status page | SLOs, 18-month retention, SIEM | Strong telemetry; no routing, dedupe, status page, or drift UI |
| Data and state | Managed DB, volumes, backups — Render, Railway, Fly, Heroku, Northflank | PITR, pooling, restore verification, single-writer scheduling | HA, read replicas, 1 TB tiers | SQLite-per-project plan; no recipes or volume snapshots |
| Agent and MCP | Remote MCP and OAuth — Vercel, Netlify, Cloudflare, Railway, Coolify, Dokploy | Code Mode (Cloudflare), MCP Apps (Vercel), Tasks, capability-scoped discovery (Fly), agent audit | MCP portals, enterprise-managed auth | Ahead on auth and audit; behind on breadth, durability, inline UX |
| Identity and governance | Orgs, roles, 2FA — all | OIDC SSO, group→role mapping, service accounts, project guests | SAML, SCIM, custom roles, IP allowlists | Orgs/RBAC/audit/passkeys; missing SSO, service accounts, guests |
| DX and IaC | CLI, REST, webhooks — all | OpenAPI and SDK, config-as-code plan/apply, templates, agent setup | Terraform provider, SSO | CLI/REST/MCP; no OpenAPI, SDK, config plan, or templates |
| Delivery | HTTP/2/3, Brotli, cache headers — all | CDN integration and purge, image transforms, signed URLs | Global anycast, WAF | Caddy gives HTTP/3 and Brotli; no CDN presets, images, or forms |
| Onboarding | One-line install, guided setup — Coolify, CapRover, Easypanel, Dokploy | Templates, public demo, no-SSH node join | Cloud marketplace | Installer and join token; setup wizard and templates pending |

**Table stakes are the entry fee, not a moat.** Every SaaS platform has Git deploys, previews, rollback, env vars, domains, logs, and a CLI; self-hosted peers have closed most of the gap and compete on catalogue breadth — Coolify advertises 360+ one-click services and Easypanel 750+ ([Coolify](https://coolify.io/docs/llms.txt), [Easypanel](https://easypanel.io/)). Yoal should not chase that. The clearest unmet demand is CapRover's six-year-old request to upload static files through the UI — exactly Yoal's core ([CapRover issue #905](https://github.com/caprover/caprover/issues/905)). The position is not "more templates"; it is "the static-first platform that makes the last mile obvious".

**Differentiators have moved to release safety and agent legibility.** Vercel's Rolling Releases, Cloudflare's gradual deployments, Fly's canary and blue-green, and Northflank's health-gated rollouts all expose a change gradually and abort automatically ([Vercel](https://vercel.com/docs/rolling-releases), [Fly](https://docs.fly.io/reference/configuration), [Northflank](https://northflank.com/features/platform)). None requires Kubernetes; two Caddy upstream pools and a weight switch suffice. On the agent side, the differentiators are MCP Apps cards, durable Tasks, scope-filtered tools, and agent-attributed audit — not a hosted model. Vercel's card is a progressive enhancement with a text fallback: it renders the same release object, not a second control plane ([Vercel](https://vercel.com/changelog/monitor-vercel-deployments-in-chatgpt)).

**Enterprise gating is consistent, which makes it predictable.** SSO is universal but SAML is gated: Render requires Scale or Enterprise, Railway gates SAML/OIDC to Enterprise, Fly supports only Google Workspace or GitHub org login, while Cloudflare gives dashboard SSO away free ([Render](https://render.com/docs/saml-sso), [Railway](https://docs.railway.com/enterprise/saml), [Fly](https://docs.fly.io/security/sso), [Cloudflare](https://developers.cloudflare.com/fundamentals/manage-members/dashboard-sso/)). SCIM, custom roles, IP allowlists, legal hold, long retention, and SIEM sinks are enterprise-only almost everywhere. For Yoal, OIDC SSO plus enforcement, audit export, and approval gates are team table stakes; SAML, SCIM, custom roles, and legal hold can wait. The sharpest formulation is that Yoal does not need to out-feature Vercel; it needs to let a five-person team pass their customer's security questionnaire without hiring a compliance officer.

## Recommendations: finish the loop, then make agents safe

Each row names the problem, evidence, fit, minimal implementation, effort, and the risk that could sink it. Rows are ordered by dependency.

### P0: close the static-first deploy loop

| Feature | Problem | Evidence | Why it fits / minimal sketch | Effort | Risks |
|---|---|---|---|---|---|
| GitHub App with sticky PR comment, check, deployment status, watch paths | Reviewers cannot see a preview or build result in the PR; every repo needs a hand-made webhook secret | Netlify updates one comment in place and posts status/checks ([Netlify](https://docs.netlify.com/deploy/deploy-notifications/)); merge queues need `merge_group` checks ([GitHub](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)) | Git builds and deployment records exist; this adds collaboration signal. One App with `contents:read`, `checks:write`, `pull_requests:write`, `deployments:write`; PATCH one comment per project+PR; explicit `productionBranch`/`autoPromote`; `build.watch/ignore`; dedupe by tree SHA | M | Fork PR secrets; duplicate deploy on merge queue; GitLab later |
| CLI daily loop | Every command needs `--project`; redirects and headers only test after deploy; agents poll | Vercel ships `link`, `dev`, `env`, `logs`, `doctor` ([Vercel CLI](https://vercel.com/docs/cli)); Render's `--wait` exits non-zero ([Render CLI](https://render.com/docs/cli)) | Profiles, login, deploy, logs, promote, rollback already exist. `.yoal/project.json` with walk-up; `yoal dev` local proxy applying compiled routes; `env pull/push/run`; `logs -f`; `deploy --wait`; `whoami --json`; `doctor`; stable JSON envelope | S–M | Dev/prod rule drift; `.env.local` leakage |
| OpenAPI 3.1, typed SDK, idempotency | The API is a markdown table; clients guess; agents hallucinate fields and retry duplicates | Railway treats its schema as a contract with rate-limit headers, 429, error codes, and `traceId` ([Railway](https://docs.railway.com/integrations/api)) | Zod contracts are already the source of truth. Generate 3.1; `/api/openapi.json` plus Scalar; CI route/spec diff; `@yoal/sdk`; `Idempotency-Key`; `X-Request-Id`; cursor pagination | S–M | Spec drift; do not add GraphQL |
| Release lifecycle completion | "What is live, what changed, can I return to Tuesday's release?" is not answerable in UI, CLI, or MCP | Vercel Pro/Ent reaches any prior deploy, Hobby only previous ([Vercel](https://vercel.com/docs/deployments/rollback-production-deployment)); Firebase retains 1–100, default 10 ([Firebase](https://firebase.google.com/docs/hosting/manage-hosting-resources)) | Pointer swap makes it cheap. `rollback --to`; release timeline; annotation and `change_ref`; file plus config diff; changelog from commits; pin and retention UI; draft vs published; immutable permalink | S | GC versus pinned releases; audit completeness |
| Preview access hardening | Preview links leak; reviewers need one deployment; automation needs a bypass | Vercel protects by method × scope with a bypass token ([Vercel](https://vercel.com/docs/deployment-protection)); Firebase and Cloudflare previews are public by default ([Cloudflare](https://developers.cloudflare.com/pages/configuration/preview-deployments/)) | HMAC host-only cookies and share links exist. Previews protected by default; per-deployment share link with expiry, views, password, emails; method × scope; bypass token; `noindex`; separate preview hostname; access request page | S–M | Cookie scope; revocation latency; email |

### P0: make v2 releases safe before making them numerous

| Feature | Problem | Evidence | Why it fits / minimal sketch | Effort | Risks |
|---|---|---|---|---|---|
| Pre-deploy, readiness gate, drain, auto-rollback, canary, maintenance | Migrations run against live traffic; a bad release takes traffic and stays up; a change should reach 5% before 100% | Fly fails the deploy on a non-zero `release_command` ([Fly](https://docs.fly.io/reference/configuration)); Render exposes `preDeployCommand` and `maxShutdownDelaySeconds` 1–300 ([Render](https://render.com/docs/blueprint-spec)); Vercel Rolling Releases can abort ([Vercel](https://vercel.com/docs/rolling-releases)) | A one-off systemd unit before activation, readiness probe, `TimeoutStopSec` drain, pointer rollback on failed health, weighted promote 5–50% by cookie/IP hash with auto-abort, and a branded 503 maintenance page. Record all in audit | S–M | Irreversible migrations; single-writer volumes; false negatives; asset consistency |
| Process groups and cron | One repo needs a web server, a worker, and a scheduler; one release is treated as one process | Heroku's Procfile; Fly's `processes`; Render's six service types ([Heroku](https://devcenter.heroku.com/articles/how-heroku-works), [Fly](https://docs.fly.io/reference/configuration), [Render](https://render.com/docs/service-types)) | `yoal.json processes` with command, port, health, replicas, resources; render one unit per process; cron with history, timeout, retries, concurrency; one-off jobs via REST/CLI/MCP | M | Admission budget; log routing; scheduler complexity |
| Secrets and config as a product | Keys live in git; previews and production share values; agents read secrets they should not | Vercel splits readable Config from write-only Secret and scopes by environment ([Vercel](https://vercel.com/docs/environment-variables)); Netlify separates build and runtime ([Netlify](https://docs.netlify.com/manage/deploys/manage-deploys-overview/)) | Envelope encryption and config snapshots are designed. Secret vs plain env; env and build/runtime scopes; version refs; `yoal env pull/run`; redaction; audit reveal; groups and references later | M | Key rotation; agent delivery; redaction gaps |

### P1: make agent operations durable, scoped, and legible

| Feature | Problem | Evidence | Why it fits / minimal sketch | Effort | Risks |
|---|---|---|---|---|---|
| Scope-filtered `tools/list` | Agents see destructive tools they cannot use; prompt bloat; wrong tool selection | MCP permits auth-varying lists and recommends deterministic order plus cache hints ([MCP](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)); Fly hides unapproved apps ([Fly](https://fly.io/blog/feng-shui-for-robots)) | Scopes ∩ role already computes the set. Build the list per token; stable order; hide promote/rollback/delete from viewers; direct call returns `403 insufficient_scope` | S | Client caches after role change |
| Durable Tasks and staged destructive ops | Long builds exceed timeouts; approval arrives after disconnect; one-shot promote misfires on retry | MCP defines Tasks plus `input_required`/`requestState` ([MCP](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)); Railway stages `confirm: true` and marks destructive tools ([Railway](https://docs.railway.com/ai/mcp-server)) | `taskId` plus poll tool and TTL; `input_required` for promote/delete; sync fallback; `prepare_promote` returns diff and token, `confirm_promote(token)` applies it; bind user, client, tool, target | M | Tasks support unproven; duplicate retries; token replay |
| Agent activity view and token quotas | Operators cannot answer "what did the agent do?" or stop a looping agent | Vercel's Agent Runs has developer and business views plus OTel ([Vercel](https://vercel.com/docs/agent-runs)); Cloudflare portals log tool, prompt, and resource activity ([Cloudflare](https://developers.cloudflare.com/changelog/post/2026-09-24-mcp-portals-ga)) | Audit already records `mcp.<tool>`. Add client/CIMD, token, scopes, project/env, latency, result, release; plain-English and JSON; per-token rate limit, concurrent deploys, builds/min, domains | S–M | Secret args in logs; retention |
| MCP Apps card and one-click onboarding | Chat says "deployed" but the operator cannot see it; client setup requires hand-editing JSON | Vercel's card shows status, logs, commit, Visit, Promote/Rollback with text fallback ([Vercel](https://vercel.com/changelog/monitor-vercel-deployments-in-chatgpt)); MCP Apps uses a sandboxed iframe ([MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview)) | Card with screenshot, release, env, status, actions; mandatory text fallback; `yoal setup agent`, `yoal mcp install`, `AGENTS.md`, registry `server.json`, per-client snippets | M | Host CSP may block iframes; client support |

### P1: sell trust to a five-person team

| Feature | Problem | Evidence | Why it fits / minimal sketch | Effort | Risks |
|---|---|---|---|---|---|
| OIDC SSO with enforcement and break-glass | A team already has Google, Entra, or Okta and must remove access centrally | Cloudflare gives SSO free; Render gates SAML to Scale/Ent; Railway gates SAML/OIDC to Ent; Fly is Google/GitHub only ([Cloudflare](https://developers.cloudflare.com/fundamentals/manage-members/dashboard-sso/), [Render](https://render.com/docs/saml-sso), [Railway](https://docs.railway.com/enterprise/saml)); Better Auth supports OIDC/SAML/JIT ([Better Auth](https://better-auth.com/docs/plugins/sso)) | Provider table with issuer, domain, encrypted secret, JIT role, enforce; email-domain detection; TXT-verified domain; break-glass owner with passkey+TOTP and alert; preflight lockout report | M | Owner lockout; IdP variance; SAML later |
| Service accounts and scoped tokens | CI and MCP use a human key; a departed employee's token works; a deploy token can delete a project | Railway separates account/workspace/project/OAuth tokens and rejects project tokens for audit ([Railway](https://docs.railway.com/integrations/api)); Heroku added team-owned tokens ([Heroku](https://www.heroku.com/blog/october-2026-update-heroku-innovations-features/)) | `service_account` principal with name, role, disabled flag; tokens with scopes, expiry, last-used, optional IP; audit actor `service:<name>`; GitHub Actions OIDC exchange; one-click revoke | S–M | Token sprawl; role drift |
| Production approvals, change refs, deploy freeze | A junior deployer or agent can promote unreviewed; auditors want a ticket on the deploy; launches need a freeze | GitHub Environments require reviewers ([GitHub](https://docs.github.com/actions/deployment/targeting-different-environments/using-environments-for-deployment)); Netlify locked deploys; Dokploy separates deploy from configure ([Netlify](https://docs.netlify.com/manage/deploys/manage-deploys-overview/), [Dokploy](https://dokploy.com/features/security)) | Per-env `require_approval` and `approver_role`; approver ≠ requester; 24h expiry; required `change_ref`; freeze blocks promote only; audit both; MCP/CLI return `409 approval_required` | S–M | Approval fatigue; emergency override |
| Audit hash chain, export, retention | An admin can rewrite SQLite history; auditors want a file or SIEM feed | Vercel gates audit to Ent, exports CSV, streams to SIEM; Railway retains 48h/30d/18mo; Northflank writes NDJSON to S3 ([Vercel](https://vercel.com/docs/audit-log), [Railway](https://docs.railway.com/enterprise/audit-logs), [Northflank](https://northflank.com/docs/v1/application/observe/audit-logs)) | `prev_hash`/`entry_hash`, triggers blocking update/delete, daily NDJSON to R2, CSV/NDJSON export, 90-day default, export itself audited, generic SIEM webhook | S–M | Root can still rewrite; PII; legal hold later |
| Alert routing, status page, incident updates | Alerts go to one inbox; a flapping node sends 200 emails; the status page dies with the control plane | Netlify fans out to Slack, email, signed webhooks; Railway has no log drain ([Netlify](https://docs.netlify.com/deploy/deploy-notifications/), [Railway](https://docs.railway.com/observability/logs)) | `alert_route` for Slack/PagerDuty/webhook/email; fingerprint dedupe, ack, silence, maintenance windows; `status.<domain>` written by the control plane and served by Caddy with stale-if-error | S–M | Must survive control-plane failure; no on-call schedules |

### P1: turn architecture into evidence

| Feature | Problem | Evidence | Why it fits / minimal sketch | Effort | Risks |
|---|---|---|---|---|---|
| Desired-vs-actual diagnostics | "Why is this app down?" requires reading logs and agent state; imperative peers cannot show drift | No peer exposes reconciler drift; Coolify's monitoring is explicitly shallow ([Coolify](https://coolify.io/docs/core/observability/monitoring/overview)); CapRover added runtime health ([CapRover](https://github.com/caprover/caprover/releases/tag/v1.16.0)) | Per-node and per-project desired vs actual, last reconcile, failing conditions, agent version, cache state, events; `get_diagnostics` MCP tool and `yoal doctor --platform` | S–M | Exposing internals; stale state |
| Signed updates, `/readyz`, diagnostics bundle | Operators fear upgrades; support needs evidence without a database dump | Yoal's roadmap lists signed-bundle verification and an in-process updater as pending ([Yoal ROADMAP](https://github.com/KieranHolroyd/yoal/blob/main/docs/ROADMAP.md)) | Verify a signed manifest with a pinned key; `/healthz` and `/readyz`; redacted diagnostics tarball (versions, config keys, health, errors, metrics, audit tail); channels, pinning, windows | S–M | Key distribution; redaction errors; never auto-upload |
| Restore evidence and DR runbook | A green backup job is not proof; buyers ask for an RTO; drill results are invisible | Yoal has ~1s RPO, monthly drills, recovery kit, `yoal-restore` ([Yoal OPS](https://github.com/KieranHolroyd/yoal/blob/main/docs/OPS.md)); Render PITR is 3/7 days; Fly snapshots default 5 days ([Render](https://render.com/docs/postgresql-backups), [Fly](https://docs.fly.io/volumes/snapshots)) | Persist drill rows (backup timestamp, counts, checksum, duration, result, log excerpt); badge; JSON report; earliest/latest restorable; restore to new data dir; `yoal dr verify`; `docs/DR.md` | S | Accidental production restore |

### P2: static depth, then data depth

| Feature | Problem | Evidence | Why it fits / minimal sketch | Effort | Risks |
|---|---|---|---|---|---|
| Image variants and first-party forms | A 4 MB hero image hurts LCP; a static contact form has no backend, and third-party forms compromise privacy | Vercel, Netlify, Cloudflare, Bunny, and Fastly sell image optimization; Netlify Forms scans HTML and stores submissions, while GitHub Pages and Surge document no equivalent ([Netlify](https://docs.netlify.com/build/image-cdn/overview/), [Netlify Forms](https://docs.netlify.com/manage/forms/setup/), [Bunny](https://bunny.net/docs/optimizer/dynamic-images/overview)) | `yoal images` build step generating AVIF/WebP at five widths with a manifest and `<Image>` snippet; optional `imgproxy` with signed URLs and rate limits. A `/_yoal/forms/*` route to the control plane with Origin check, honeypot, Turnstile/ALTCHA, rate limits, hashed IP, inbox, CSV | M | CPU abuse; spam; PII; don't rewrite arbitrary HTML |
| Volumes, snapshots, single-writer scheduling | Stateful apps need durable disk; two replicas on one volume corrupt it | Railway, Render, and Fly enforce single-writer; Render disks block zero-downtime; Fly snapshots default 5 days ([Railway](https://docs.railway.com/reference/volumes), [Render](https://render.com/docs/disks), [Fly](https://docs.fly.io/volumes/snapshots)) | Volume per project on one node; snapshot to R2; restore to new volume; scheduler refuses two replicas; deploy-time warning | M | Data loss; snapshot consistency |
| Postgres/Redis recipes with pooling and verified backups | Users want a database without becoming a DBA; copied connection strings leak | Render exposes PgBouncer and PITR; Railway ships templates; Fly sells managed Postgres ([Render](https://render.com/docs/blueprint-spec), [Railway](https://railway.com/features), [Fly](https://docs.fly.io/postgres)) | Pinned image, volume, generated credentials, PgBouncer, pgBackRest/WAL-G to R2, health check, restore drill; inject `DATABASE_URL` and `DATABASE_POOL_URL`; don't claim PITR unless tested | L | PITR promises; ops burden; upgrades |

## From 0.4 to 1.0: six themes and a hardening release

The plan assumes the shipped v2 surface lands as 0.4. It is front-loaded with small, reversible work and ends with a quality bar rather than a new category. Each release is independently shippable; none requires a schema rewrite or a second control plane.

| Release | Theme | Contents | Exit criteria |
|---|---|---|---|
| 0.4 | Deploy loop | GitHub App and PR surface; CLI `link`/`dev`/`env`/`logs -f`/`--wait`/`doctor`; OpenAPI and SDK; release timeline, annotations, diffs, rollback-to-any, pinning; preview protection and per-deployment share links | A reviewer goes PR → preview → promote without leaving GitHub or the terminal; an integrator generates a client from the spec |
| 0.5 | Release safety | Pre-deploy command, readiness gate, drain, auto-rollback; process groups and cron; secrets/config scopes and redaction; canary and maintenance; domain state machine | A process app runs a migration, fails safely, and rolls back without touching a symlink; secrets never appear in logs or MCP |
| 0.6 | Agent-grade operations | Scope-filtered tools, Tasks, `input_required`, staged destructive ops, agent activity/quotas, MCP Apps card with fallback, `yoal setup agent`, templates | An agent deploys, waits, asks approval, survives disconnect, and is audited by client, token, and scope |
| 0.7 | Team adoption | OIDC SSO and enforcement, service accounts, approvals, change refs, freeze, audit chain/export/retention, alert routing, status page | A five-person team passes a security questionnaire with an export, an approval record, and a status page that survives an outage |
| 0.8 | Evidence and static depth | Signed update verification, `/readyz`, diagnostics bundle, drift panel, restore evidence; images, forms, KV, scheduled jobs | An operator proves what runs, what changed, and that restore works; a static site needs no third-party form or image service |
| 0.9 | Apps and data depth | Volumes and snapshots, Postgres/Redis recipes, private DNS, TCP/UDP, static egress | A team runs a stateful service with a tested backup and private connection string, without Kubernetes |
| 1.0 | Hardening | Performance, upgrade compatibility, docs, accessibility, security review, migration rehearsal; no new surface | Every feature has a documented failure mode, restore path, and support runbook |

Three dependencies are hard. Preview protection and the release timeline must land before agent Tasks, because an agent that can promote needs a readable preview and a reversible target. Secrets/config scoping must land before production approvals, because an approval is meaningless if the requester can read the production secret. OpenAPI must land before any Terraform or SDK work; a provider built on a hand-written API is a permanent compatibility tax. Vercel's provider is a full Go repository with acceptance tests and Cloudflare's is auto-generated yet still carries a long issue tail, so Terraform should ride on a stable spec ([Vercel provider](https://github.com/vercel/terraform-provider-vercel), [Cloudflare provider](https://github.com/cloudflare/terraform-provider-cloudflare)).

## What not to build, and what would change the plan

Every item below would erase the footprint advantage, create a second security model, or duplicate a commodity. Refuse.

| Do not build | Why not | Closest alternative |
|---|---|---|
| Kubernetes, Swarm, HPA, general scheduler | Contradicts the no-Kubernetes, tiny-footprint design | Node labels, manual placement, vertical resize, workload-slice admission |
| Global anycast CDN or WAF/bot engine | One node cannot absorb volumetric DDoS; an edge network is a different company | CDN presets, Caddy rate limits, CrowdSec, Cloudflare/Bunny/Fastly |
| Full APM, trace storage, log warehouse | Export beats build; Railway and Coolify both defer to external tools | OTLP/Prometheus export, short hot window, log drains |
| Billing, payments, metered SaaS pricing | Self-hosted has no bill; quotas and showback are the useful translation | Quotas, budgets, chargeback CSV |
| On-call scheduling and escalation | A product in itself; conflicts with low-resource operations | PagerDuty/Alertmanager webhook |
| General workflow or queue engine | Vercel Queues and Cloudflare Workflows are large products | Cron, one-off jobs, webhooks |
| Agent sandbox shell or hosted coding agent | Creates a second security model for egress, persistence, and secrets | External agents via MCP; document E2B/Daytona/Fly Sprites |
| Code Mode at Yoal's tool count | The 52-to-2 tool, 9,400-to-600 token win applies to a 2,500-endpoint API, not ~20 tools ([Cloudflare](https://blog.cloudflare.com/code-mode/)) | Small task-shaped catalog, scope filtering |
| GraphQL | Doubles the surface for a small team | REST plus OpenAPI |
| Terraform before OpenAPI and config-as-code | Permanent compatibility surface; the Vercel and Cloudflare providers show the cost | `yoal plan/apply`, generated SDK |
| In-page comments and screenshot diffs | Large product bet requiring a toolbar, DOM anchoring, storage, and fan-out | PR comment, per-deployment share link |
| Template marketplace or hosted registry | Supply-chain and availability risk for a self-hosted product | First-party templates plus `gh:owner/repo` sources |
| Multi-node active-active control plane | Conflicts with one control plane and SQLite; no comparable self-hosted product ships it | Warm standby, Litestream replica, DNS failover, edge mirror |
| SAML, SCIM, custom roles, legal hold in year one | Consistently enterprise-only and demand-gated | OIDC SSO, built-in roles, project guests |

### Open questions and research gaps

The plan is the best-supported reading, not a measured demand curve. Six questions could change it. There are no Yoal user interviews or usage data, so the balance between static polish and v2 app depth is judgement; if most users only ship static sites, 0.9 should slip. MCP Tasks and MCP Apps client support is unproven — the community matrix was empty for Tasks across major clients, and Vercel's card was two days old at the time of research ([MCP matrix](https://modelcontextprotocol.io/extensions/client-matrix.md)). It is unknown whether agents retry failed deploys often enough to justify durable Tasks; instrument retries first. Enterprise willingness to pay for SSO/SCIM is inferred from vendor tiering, not buyer interviews. The R2-only object store is an adoption risk for operators who want local-only or Garage/MinIO; the `ObjectStore` interface should precede the data-depth release. SQLite write concurrency and DuckDB telemetry growth under a multi-user team are unmeasured; the 250 MB baseline was measured on a mostly idle control plane. A seventh question is whether the market rewards a self-hosted platform that is *better governed* than Coolify/Dokploy rather than *broader*; the research suggests yes, because reliability and trust complaints outrank feature requests, but it is a hypothesis to test with design partners.

## Conclusion

The surprising finding is that Yoal's roadmap is not behind; it is ahead on the parts that are expensive to copy and behind on the parts that are cheap to finish. Pull-based reconciliation, immutable releases, scope∩role MCP, a 250 MB baseline, and verified restores are structural advantages that Vercel, Coolify, and Dokploy cannot match without changing their architecture. The deploy loop, preview protection, release annotations, pre-deploy gates, secret scoping, SSO, and audit export are ordinary product work that sits directly on top of those advantages. Doing the ordinary work first is not a concession to competitors; it is what makes the structural advantages legible to a team and safe for an agent. The test for every future feature is whether it strengthens "the agent can only do what you can do, and you can see everything it did" without adding a second control plane, security model, or container daemon; if not, it belongs on the do-not-build list.

## Sources

### Commercial deploy platforms

- Vercel rollback: https://vercel.com/docs/deployments/rollback-production-deployment
- Vercel deployment protection: https://vercel.com/docs/deployment-protection
- Vercel environment variables: https://vercel.com/docs/environment-variables
- Vercel deployment card changelog: https://vercel.com/changelog/monitor-vercel-deployments-in-chatgpt
- Vercel Agent Runs: https://vercel.com/docs/agent-runs
- Vercel Rolling Releases: https://vercel.com/docs/rolling-releases
- Vercel audit log: https://vercel.com/docs/audit-log
- Vercel SAML: https://vercel.com/docs/saml
- Vercel CLI: https://vercel.com/docs/cli
- Netlify deploy notifications: https://docs.netlify.com/deploy/deploy-notifications/
- Netlify manage deploys: https://docs.netlify.com/manage/deploys/manage-deploys-overview/
- Netlify CLI: https://docs.netlify.com/api-and-cli-guides/cli-guides/get-started-with-cli/
- Netlify local development: https://docs.netlify.com/api-and-cli-guides/cli-guides/local-development/
- Netlify Forms: https://docs.netlify.com/manage/forms/setup/
- Netlify Image CDN: https://docs.netlify.com/build/image-cdn/overview/
- Cloudflare Pages rollbacks: https://developers.cloudflare.com/pages/configuration/rollbacks/
- Cloudflare Pages previews: https://developers.cloudflare.com/pages/configuration/preview-deployments/
- Cloudflare Custom Domains: https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
- Cloudflare dashboard SSO: https://developers.cloudflare.com/fundamentals/manage-members/dashboard-sso/
- Cloudflare Secrets Store: https://developers.cloudflare.com/secrets-store/

### Modern PaaS

- Render service types: https://render.com/docs/service-types
- Render Blueprint spec: https://render.com/docs/blueprint-spec
- Render disks: https://render.com/docs/disks
- Render Postgres recovery: https://render.com/docs/postgresql-backups
- Render SAML SSO: https://render.com/docs/saml-sso
- Render CLI: https://render.com/docs/cli
- Railway build and deploy: https://docs.railway.com/build-deploy
- Railway volumes: https://docs.railway.com/reference/volumes
- Railway environments: https://docs.railway.com/environments
- Railway networking: https://docs.railway.com/networking
- Railway audit logs: https://docs.railway.com/enterprise/audit-logs
- Railway API: https://docs.railway.com/integrations/api
- Railway IaC: https://docs.railway.com/infrastructure-as-code
- Railway CLI: https://docs.railway.com/cli
- Railway SAML: https://docs.railway.com/enterprise/saml
- Fly configuration: https://docs.fly.io/reference/configuration
- Fly Managed Postgres: https://docs.fly.io/postgres
- Fly SSO: https://docs.fly.io/security/sso
- Fly volume snapshots: https://docs.fly.io/volumes/snapshots
- Heroku pipelines: https://devcenter.heroku.com/articles/pipelines
- Heroku Postgres Advanced: https://devcenter.heroku.com/articles/heroku-postgres-advanced
- Heroku October 2026 update: https://www.heroku.com/blog/october-2026-update-heroku-innovations-features/
- Northflank platform: https://northflank.com/features/platform
- Northflank audit logs: https://northflank.com/docs/v1/application/observe/audit-logs

### Self-hosted PaaS and control panels

- Coolify docs index: https://coolify.io/docs/llms.txt
- Coolify overview: https://coolify.io/docs/core/what-is-coolify
- Coolify monitoring: https://coolify.io/docs/core/observability/monitoring/overview
- Coolify v4.5.1: https://github.com/coollabsio/coolify/releases/tag/v4.5.1
- Coolify issues: https://github.com/coollabsio/coolify/issues?q=is%3Aissue+sort%3Areactions-desc
- Dokploy features: https://docs.dokploy.com/docs/core/features
- Dokploy enterprise: https://docs.dokploy.com/docs/core/enterprise
- Dokploy AI: https://docs.dokploy.com/docs/core/ai
- Dokploy MCP: https://github.com/Dokploy/mcp
- Dokploy issues: https://github.com/Dokploy/dokploy/issues?q=is%3Aissue+sort%3Areactions-desc
- CapRover getting started: https://caprover.com/docs/get-started.html
- CapRover static upload issue: https://github.com/caprover/caprover/issues/905
- CapRover v1.16.0: https://github.com/caprover/caprover/releases/tag/v1.16.0
- Dokku installation: https://dokku.com/docs/getting-started/installation/
- Kamal installation: https://kamal-deploy.org/docs/installation/
- Portainer requirements: https://docs.portainer.io/start/requirements-and-prerequisites
- Runtipi how it works: https://runtipi.io/docs/learn/how-it-works
- Cosmos docs: https://cosmos-cloud.io/docs/
- Easypanel docs: https://easypanel.io/docs

### Static hosting and CDN

- GitHub Pages limits: https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits
- Firebase Hosting channels: https://firebase.google.com/docs/hosting/manage-hosting-resources
- Firebase Hosting config: https://firebase.google.com/docs/hosting/full-config
- Surge platform: https://surge.sh/docs/platform/
- Surge auth: https://surge.sh/docs/platform/auth
- Surge custom domains: https://surge.sh/docs/platform/custom-domains
- Bunny purge: https://bunny.net/docs/cdn/purge-cache
- Bunny dynamic images: https://bunny.net/docs/optimizer/dynamic-images/overview
- Fastly purging: https://www.fastly.com/documentation/guides/full-site-delivery/purging/getting-started-with-purging/
- AWS Amplify Hosting: https://docs.amplify.aws/javascript/deploy-and-host/amplify-hosting/
- Caddy automatic HTTPS: https://caddyserver.com/docs/automatic-https
- Caddy features: https://caddyserver.com/features

### Agent, MCP, and AI-native deployment

- MCP specification 2026-07-28: https://modelcontextprotocol.io/specification/2026-07-28
- MCP tools: https://modelcontextprotocol.io/specification/2026-07-28/server/tools
- MCP security best practices: https://modelcontextprotocol.io/specification/2026-07-28/basic/security_best_practices
- MCP Apps: https://modelcontextprotocol.io/extensions/apps/overview
- MCP client support matrix: https://modelcontextprotocol.io/extensions/client-matrix.md
- MCP Registry quickstart: https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/quickstart.mdx
- Vercel MCP: https://vercel.com/docs/agent-resources/vercel-mcp
- Railway MCP: https://docs.railway.com/ai/mcp-server
- Fly Sprites: https://fly.io/blog/feng-shui-for-robots
- Cloudflare MCP servers: https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/
- Cloudflare Code Mode: https://blog.cloudflare.com/code-mode/
- Cloudflare MCP Portals: https://developers.cloudflare.com/changelog/post/2026-09-24-mcp-portals-ga

### Enterprise, identity, and operations

- GitHub deployment environments: https://docs.github.com/actions/deployment/targeting-different-environments/using-environments-for-deployment
- Better Auth SSO: https://better-auth.com/docs/plugins/sso
- Better Auth SCIM: https://better-auth.com/docs/plugins/scim

### Developer experience and integrations

- GitHub App permissions: https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app
- GitHub merge queue: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue
- GitHub deployment statuses: https://docs.github.com/en/rest/deployments/statuses
- Vercel Terraform provider: https://github.com/vercel/terraform-provider-vercel
- Cloudflare Terraform provider: https://github.com/cloudflare/terraform-provider-cloudflare

### Yoal project documentation

- Yoal README: https://github.com/KieranHolroyd/yoal/blob/main/README.md
- Yoal design: https://github.com/KieranHolroyd/yoal/blob/main/docs/DESIGN.md
- Yoal roadmap: https://github.com/KieranHolroyd/yoal/blob/main/docs/ROADMAP.md
- Yoal operations: https://github.com/KieranHolroyd/yoal/blob/main/docs/OPS.md
