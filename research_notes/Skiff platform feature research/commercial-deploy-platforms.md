# Commercial deploy platforms: Vercel, Netlify, Cloudflare Pages/Workers — feature research for Skiff

**Scope and method.** Research conducted 2026-11-04 from primary vendor documentation (`vercel.com/docs`, `docs.netlify.com`, `developers.cloudflare.com`), vendor pricing/limits pages, and vendor changelogs. Docs pages carry `last_updated` dates between 2026-04 and 2026-11 unless noted. Pricing is list price in USD, excludes tax, and is plan/region dependent; treat it as directional. "GA" means the vendor documents it as generally available; "Beta/Preview" is called out explicitly.

**Skiff context used for relevance filtering.** Skiff is a self-hosted, static-first platform: immutable content-addressed releases, preview URL per deploy, promote/rollback by pointer swap, Caddy TLS, SQLite/DuckDB control plane, R2/local object store, and an OAuth 2.1 MCP server (`README.md`, repo). The notes therefore weight deploy/rollback semantics, preview access, domains/TLS, agent surfaces, and operational guardrails over framework runtime depth.

---

## Deploy workflow: Git, CLI, hooks, monorepos, build caching/limits, previews, drafts, rollback, annotations

### Takeaway
All three treat a deploy as an immutable, addressable artifact plus a movable production pointer; the table stakes are Git/PR previews, CLI/API deploys, deploy hooks, per-deploy URLs, instant rollback, and annotations. The meaningful gaps for Skiff are **draft-vs-production semantics, monorepo build skipping, build caching/queueing, release annotations, and rollback to any prior release** — not the basic artifact model Skiff already has.

### Cited Findings

**Git, CLI, API, hooks**

| Capability | Vercel | Netlify | Cloudflare Pages/Workers |
|---|---|---|---|
| Git providers | GitHub, GitLab, Bitbucket, Azure DevOps; commit/PR deploys; shallow clone `--depth=10` ([docs](https://vercel.com/docs/deployments), updated 2026-09-03; [builds](https://vercel.com/docs/builds), 2026-09-03) | GitHub, GitLab, Bitbucket, Azure DevOps, Cursor Origin; push-to-build; PR Deploy Previews by default ([build config](https://docs.netlify.com/build/configure-builds/overview/)) | GitHub, GitLab, Artifacts; push-to-build; PR preview URL ([Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/), 2026-10-28; [Pages previews](https://developers.cloudflare.com/pages/configuration/preview-deployments/), 2026-10-12) |
| CLI | `vercel deploy`, `--prod`, `--temporary` no-account deploy ([docs](https://vercel.com/docs/deployments)) | `netlify deploy` creates a **draft by default**; `--prod` publishes; `--alias` gives predictable draft URL ([CLI deploy](https://cli.netlify.com/commands/deploy/)) | `wrangler deploy` (prod), `wrangler versions upload` (version, not live), `wrangler preview` (branch Preview) ([versions](https://developers.cloudflare.com/workers/versions-and-deployments/), 2026-09-22; [previews](https://developers.cloudflare.com/workers/previews/), 2026-09-24) |
| Drag/drop or no-git | **Vercel Drop**: drag a folder, works without an account, can claim site ([docs](https://vercel.com/docs/deployments)) | Netlify Drop (docs reference; not separately verified here) | Dashboard upload / direct upload (Pages docs; not separately verified) |
| Deploy hooks | Unique URL per project; HTTP GET or POST; requires connected Git repo ([docs](https://vercel.com/docs/deployments)) | Build hook: unique URL, POST, optional `trigger_branch`, `trigger_title`, `clear_cache`; payload exposed as `INCOMING_HOOK_BODY` ([build hooks](https://docs.netlify.com/build/configure-builds/build-hooks/)) | Pages: unique POST URL per hook, branch selected at creation, no auth on URL ([deploy hooks](https://developers.cloudflare.com/pages/configuration/deploy-hooks/), 2026-04-21); Workers: 10/min per Worker, 100/min per account ([limits](https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/), 2026-10-28) |
| Programmatic API | REST API: hash files, upload, create deployment; used by agents/services ([docs](https://vercel.com/docs/deployments)) | Netlify API + CLI; MCP wraps API/CLI ([MCP overview](https://docs.netlify.com/build/build-with-ai/agent-setup-guides/agent-setup-overview/)) | Cloudflare API; API MCP can call 2,500+ endpoints ([MCP servers](https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/), 2026-10-27) |

**Monorepos and build skipping**

- Vercel creates one project per directory/root directory, then automatically skips unaffected projects. Conditions: project source changed, internal dependency changed, or lockfile change affecting only that project. Only GitHub is supported; workspace must use npm/yarn/pnpm/Bun workspaces; packages need unique names and explicit dependency edges. Skipped builds do **not** consume concurrent build slots ([monorepos](https://vercel.com/docs/monorepos), 2026-08-11).
- Vercel Related Projects: up to 3 projects in the same repo; previews of a frontend can automatically reference matching previews of a backend via `VERCEL_RELATED_PROJECTS`; CLI deploys unsupported ([monorepos](https://vercel.com/docs/monorepos)).
- Netlify uses **base directory** (install/build root) and **package directory** (site source, `netlify.toml`), auto-detects monorepos, and supports ignore-builds ([build config](https://docs.netlify.com/build/configure-builds/overview/)). It also has per-project “ignore builds” customization (docs link).
- Cloudflare Pages uses a **root directory** for monorepos; build command and output directory are configured per project ([Pages build config](https://developers.cloudflare.com/pages/configuration/build-configuration/), 2026-09-18). Workers Builds has root directory/build settings and autoconfig ([Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/)).
- Cloudflare Workers Builds creates an **automatic configuration PR** when a repo lacks a Wrangler config, generates a preview deployment, and configures the project after merge ([Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/)).

**Build caching, minutes, concurrency, timeouts**

| Limit | Vercel | Netlify | Cloudflare |
|---|---|---|---|
| Build timeout | 45 minutes ([builds](https://vercel.com/docs/builds)) | Not stated in fetched build config page (gap) | 20 minutes ([limits](https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/); [Pages limits](https://developers.cloudflare.com/pages/platform/limits/), 2026-09-05) |
| Build cache | 1.5 GB Basic/Standard, 3 GB Enhanced, 4.75 GB Turbo; retained 1 month ([builds](https://vercel.com/docs/builds)) | Dependency caching; “clear cache and retry” supported ([manage deploys](https://docs.netlify.com/deploy/manage-deploys/manage-deploys-overview/)) | Build cache not documented on fetched pages (gap) |
| Build resources | Hobby 2 vCPU/8 GB/32 GB disk; Pro 4 vCPU/8 GB/32 GB ([builds](https://vercel.com/docs/builds)) | Build image selection; concurrent builds 1 Free/1 Personal/3 Pro, add-ons ([credit plans](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/credit-based-pricing-plans/)) | Free 2 vCPU/8 GB/20 GB; Paid 4 vCPU/8 GB/20 GB; 1 vs 6 concurrent ([limits](https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/)) |
| Build allowance/price | $0.007 per build minute Basic ($0.0035/CPU-min); Hobby Basic included ([pricing](https://vercel.com/docs/pricing), 2026-09-14) | **Production deploy = 15 credits**; deploy previews, branch deploys, failed deploys are not metered; production deploy cost applies only when published ([credit plans](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/credit-based-pricing-plans/)) | **Pages**: 500 builds/mo Free, 5,000 Pro, 20,000 Business ([Pages limits](https://developers.cloudflare.com/pages/platform/limits/)). **Workers Builds**: 3,000 min/mo Free; 6,000 min/mo Paid then $0.005/min ([limits](https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/)) |
| Queue behavior | Concurrency slots; same-branch queue skips older queued builds; on-demand concurrency available ([builds](https://vercel.com/docs/builds)) | Concurrent builds limited by plan; builds queue | Concurrent builds limited; builds retained 90 days ([limits](https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/)) |

**Previews, drafts, permalinks**

- Vercel: every deploy gets a unique URL; Preview is the default for non-production branches; Production on `--prod`/production branch. Preview URLs are protected under Standard Protection but production domains are not ([deployments](https://vercel.com/docs/deployments); [deployment protection](https://vercel.com/docs/deployment-protection), 2026-09-15).
- Netlify: Deploy Preview URL `deploy-preview-<PR#>--site.netlify.app`; branch deploy `branch--site.netlify.app`; every successful deploy gets an immutable permalink `<deployID>--site.netlify.app`. Deploy Previews get `X-Robots-Tag: noindex`; the latest branch deploy does not ([deploy overview](https://docs.netlify.com/deploy/deploy-overview/)). Agent-run previews use `agent-<runID>--site.netlify.app`.
- Netlify CLI `netlify deploy` **creates a draft by default**; `--prod` publishes; `--alias` creates a predictable draft URL and explicitly does **not** create a branch deploy ([CLI deploy](https://cli.netlify.com/commands/deploy/)).
- Cloudflare Pages: each branch gets a random hash URL `<hash>.<project>.pages.dev`, immutable; a branch alias `<branch>.<project>.pages.dev` tracks the latest commit; previews default public and are `X-Robots-Tag: noindex` ([Pages previews](https://developers.cloudflare.com/pages/configuration/preview-deployments/)).
- Cloudflare Workers **Previews** are isolated, production-like environments under the same Worker: own variables/secrets/bindings, own URL (workers.dev or custom domain), own observability. Limits: 100 previews/Worker Free, 500 paid; 100 deployments per Preview; oldest auto-deleted ([Workers previews](https://developers.cloudflare.com/workers/previews/), 2026-09-24).
- Cloudflare `wrangler versions upload` creates a version plus Version URL without promoting it — a draft-deploy primitive distinct from branch Previews ([versions](https://developers.cloudflare.com/workers/versions-and-deployments/)).

**Static hosting limits (relevant to Skiff’s release/artifact model)**

- Cloudflare Pages: 20,000 files Free, 100,000 files paid (requires `PAGES_WRANGLER_MAJOR_VERSION=4`), 25 MiB max single file, 100 projects/account, 100/250/500/500 custom domains per project by plan; unlimited preview deployments ([Pages limits](https://developers.cloudflare.com/pages/platform/limits/), 2026-09-05).
- Cloudflare Workers static assets: 20,000 files Free / 100,000 paid per Worker version, 25 MiB per file; `_headers` 100 rules; `_redirects` 2,000 static + 100 dynamic ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/); [Pages limits](https://developers.cloudflare.com/pages/platform/limits/)).
- Netlify: no total file count limit, but **54,000 files per directory**; exceeding it fails the deploy; atomic deploys and skew protection are documented at the deploy layer ([deploy overview](https://docs.netlify.com/deploy/deploy-overview/)).
- Vercel static asset limits were not fetched (gap); Vercel’s deployment model uploads static files + functions, with per-function bundle limits ([limits](https://vercel.com/docs/functions/limitations)).

**Promote/rollback semantics**

- Vercel Instant Rollback points production traffic at a prior deployment **without rebuilding**, at the routing layer, effective “within seconds.” Hobby can only roll back to the immediately previous production deploy; Pro/Enterprise can target any prior production deployment by URL/ID ([rollback guide](https://vercel.com/docs/deployments/rollback-production-deployment), 2026-09-11). `vercel promote <deployment>` promotes any existing deployment ([same](https://vercel.com/docs/deployments/rollback-production-deployment)).
- Vercel `vercel rollback status`, `vercel promote status`, and `vercel bisect` support incident workflows; `bisect --run ./test.sh` binary-searches deploys with exit codes 0/non-zero/125 ([rollback guide](https://vercel.com/docs/deployments/rollback-production-deployment)).
- Netlify “Publish Deploy” publishes a previous atomic deploy, **does not trigger a new deploy**, and is “instantaneous.” If auto-publishing is on, the next Git deploy overwrites the rollback. “Locked deploys” stop auto-publishing while still building ([manage deploys](https://docs.netlify.com/deploy/manage-deploys/manage-deploys-overview/)).
- Cloudflare: a deployment maps versions to traffic; `wrangler versions deploy` can split traffic or set 100%; rollback reverts to a previously deployed version ([versions](https://developers.cloudflare.com/workers/versions-and-deployments/); [gradual deployments](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/), 2026-10-18).
- Vercel **Rolling Releases** (Pro/Enterprise; Pro one project) sends a configurable fraction of traffic to a canary, exposes Speed Insights comparison, supports stages, abort, and CLI/REST start/complete. Cookie bucketing is client/IP-derived; `vcrrForceCanary`/`vcrrForceStable` force a bucket; 0% canaries are not securely hidden ([rolling releases](https://vercel.com/docs/rolling-releases), 2026-09-15).
- Vercel **Skew Protection** pins framework-managed client requests to the deployment that served the page via `?dpl=`, `x-deployment-id`, or `__vdpl`; max age default 1 day, configurable up to retention; Pro/Enterprise only; supported for Next.js, SvelteKit, Qwik, Astro, Nuxt ([skew protection](https://vercel.com/docs/skew-protection), 2026-09-16).

**Release annotations and retention**

- Vercel `vercel deploy --meta/-m` attaches metadata to a deployment; Git metadata is read from the local checkout ([Vercel CLI deploy](https://vercel.com/docs/cli/deploy), search result; docs page not fetched in full). Deployment details show commit SHA, branch, build time ([rollback guide](https://vercel.com/docs/deployments/rollback-production-deployment)).
- Netlify CLI `--message` adds a deploy-log message; build hook `trigger_title` replaces the default deploy message ([CLI deploy](https://cli.netlify.com/commands/deploy/); [build hooks](https://docs.netlify.com/build/configure-builds/build-hooks/)). Deploy summary shows file count, headers/redirects status, function/edge-function counts ([deploy overview](https://docs.netlify.com/deploy/deploy-overview/)).
- Cloudflare Workers versions optionally accept a **message and tag** at upload; the version tracks who/when/from where ([versions](https://developers.cloudflare.com/workers/versions-and-deployments/)). This is the clearest first-class “release annotation” among the three.
- Netlify auto-deletes deploys after 30 days (90 days paid); Enterprise can set retention up to 365 days; the published deploy, latest successful production deploy, and latest successful branch deploy are retained ([manage deploys](https://docs.netlify.com/deploy/manage-deploys/manage-deploys-overview/)). Vercel has a deployment retention policy page referenced by Skew Protection (not fetched in detail). Cloudflare keeps the 100 most recent versions for gradual deployment and 90 days of build logs ([limits](https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/)).

### Inferences
- Skiff’s immutable release + pointer swap is architecturally equivalent to the core of all three. The missing product surface is **deploy lifecycle ergonomics**: draft vs published, per-deploy permalink, annotation/message, deploy hooks, monorepo skip, and rollback-to-any-release.
- Vercel’s routing-layer rollback (no rebuild, seconds) and Netlify’s “publish previous atomic deploy” are the UX bar. Skiff already swaps symlinks/pointers, so it can match this cheaply and should expose rollback in CLI, dashboard, REST, and MCP with the same audit event.
- Netlify’s credit model has an important design lesson: **previews and failed deploys are free; only published production deploys are metered**. This aligns cost with value and encourages preview-heavy workflows.
- Vercel’s Skew Protection solves a problem Skiff will hit as soon as it serves tier-2/3 apps: old client bundles calling new APIs. Skiff’s static-first v1 can defer it, but release-pinned asset URLs are a cheap precursor.

### Gaps
- Vercel exact build concurrency per plan and build-minute included allowances were not on the fetched pages; pricing table references a missing matrix component.
- Netlify build-minute limits in the credit era are not stated as minutes; the docs meter production deploys in credits (15 each) and leave previews/branch deploys unmetered.
- Cloudflare Workers Builds build-cache behavior and monorepo change-detection were not documented on the fetched pages.
- Vercel’s formal “release annotation” API (beyond `--meta`) and Netlify’s deploy annotation API were not verified.
- Cloudflare Pages deployment retention and rollback UX (as opposed to Workers versions) were not fully verified.

---

## Runtime/platform: functions, edge, cron, queues, background jobs, images, ISR/caching, routing, middleware, forms, config, flags

### Takeaway
The three platforms have converged on “static assets + functions + scheduled/background work + edge routing.” The differentiators are **durable queues/workflows, ISR with a durable cache, edge image transformation, global config/KV, first-party forms, and feature flags**. For a static-first Skiff, routing/caching/image primitives and a small scheduled-job story are high-leverage; a full serverless runtime is not.

### Cited Findings

**Functions and edge compute**

| Dimension | Vercel Functions | Netlify Functions / Edge Functions | Cloudflare Workers |
|---|---|---|---|
| Runtime | Node.js, Bun, Python; Fluid compute default for new projects ([limits](https://vercel.com/docs/functions/limitations), 2026-08-24) | Modern `Request`/`Response` handlers; Fetchable module convention; platform-event handlers ([functions overview](https://docs.netlify.com/build/functions/overview/)) | V8 isolates; JS/TS, Python, Rust/WASM; 128 MB/isolate ([limits](https://developers.cloudflare.com/workers/platform/limits/), 2026-10-29) |
| Duration | 300 s default/max Hobby; Pro/Ent 300 s default, 800 s max, **1,800 s extended max Beta**; Edge must start response in 25 s, stream up to 300 s ([limits](https://vercel.com/docs/functions/limitations)) | Background Functions and Scheduled Functions exist ([functions overview](https://docs.netlify.com/build/functions/overview/); links) | HTTP no wall-time limit while client connected; Cron/Queue/DO alarm 15 min; `waitUntil` +30 s ([limits](https://developers.cloudflare.com/workers/platform/limits/)) |
| CPU | Active CPU billing; 4 GB/2 vCPU max Pro/Ent ([limits](https://vercel.com/docs/functions/limitations)) | GB-hour metering: 10 credits/GB-hour ([credit plans](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/credit-based-pricing-plans/)) | Free 10 ms/invocation; Paid 30 s default, 5 min max CPU ([limits](https://developers.cloudflare.com/workers/platform/limits/)) |
| Bundle/body | 250 MB uncompressed (500 MB Python); **5 GB Large Functions Beta**; 4.5 MB request/response body ([limits](https://vercel.com/docs/functions/limitations)) | Not stated on fetched overview (gap) | 64 MiB uncompressed; request body 100 MB Free/Pro, 200 MB Business, up to 5 GB Enterprise ([limits](https://developers.cloudflare.com/workers/platform/limits/)) |
| Edge functions | Edge runtime; 25 s to first byte, 300 s stream ([limits](https://vercel.com/docs/functions/limitations)) | Deno-based Edge Functions at edge PoP; can cache responses; versioned/deployed with site ([Edge Functions](https://docs.netlify.com/build/edge-functions/overview/)) | Workers are the edge runtime; routes, custom domains, `run_worker_first` ([static assets](https://developers.cloudflare.com/workers/static-assets/), 2026-10-12) |
| Concurrency | Auto-scale to 30,000 (Hobby/Pro), 100,000+ Enterprise ([limits](https://vercel.com/docs/functions/limitations)) | Automatic scaling (docs) | No general RPS limit; Free 100k requests/day then error 1027 ([limits](https://developers.cloudflare.com/workers/platform/limits/)) |

**Cron, queues, background work**

- Vercel Cron Jobs on **all plans**, up to 100 per project (changelog link on docs), configured in `vercel.json`/Build Output API; Vercel issues an HTTP GET to the production deployment, with `vercel-cron/1.0` UA and `x-vercel-cron-schedule` header; expressions are 5-field UTC, no `MON`/`JAN`, cannot set both day-of-month and day-of-week ([cron jobs](https://vercel.com/docs/cron-jobs), 2026-09-16).
- Vercel **Queues** are **Beta on all plans**: durable append-only topics, fan-out consumer groups, retries/visibility timeouts, at-least-once delivery, push or poll consumers, idempotency keys, delay up to retention, 7-day TTL support (changelog), SDK/HTTP API, observability. Queues underpin Workflows and durable agent harness turns ([queues](https://vercel.com/docs/queues), 2026-09-03). Vercel Workflows provides durable steps/sleep/hooks for minutes-to-months ([limits](https://vercel.com/docs/functions/limitations)).
- Netlify has Background Functions and Scheduled Functions, plus functions triggered by platform events such as `deploySucceeded` ([functions overview](https://docs.netlify.com/build/functions/overview/)). No first-party durable queue/workflow product appears in the fetched docs (gap).
- Cloudflare Cron Triggers: 5 per account Free, 250 Paid; Quartz-like 5-field expressions incl. `L`, `W`, `#`; UTC; 15-min wall time; changes propagate up to 15 min; 100 most recent events; Green Compute option ([cron triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/), 2026-10-17).
- Cloudflare Queues: Free 10,000 ops/day, 24 h retention; Paid 1M ops/mo included, 4-day default / 14-day max retention, DLQ, 10,000 queues default ([pricing](https://developers.cloudflare.com/workers/platform/pricing/), 2026-10-02). Workflows adds durable steps with unlimited per-step wall time and step/storage billing ([pricing](https://developers.cloudflare.com/workers/platform/pricing/); [limits](https://developers.cloudflare.com/workers/platform/limits/)).

**Caching, ISR, and routing**

- Vercel **ISR on all plans**: stale-while-revalidate; durable per-deployment ISR cache in the Function region; caches from previous deployments are not purged, so rollback retains that deployment’s generated content, but a new deployment does **not** reuse the prior deployment’s cache; unaccessed content expires after 31 days; request collapsing per region; **global purge within 300 ms**; failed revalidation serves stale and retries in 30 s; supported in Next.js, SvelteKit, Nuxt, Astro, Gatsby, Build Output API ([ISR](https://vercel.com/docs/incremental-static-regeneration), 2026-08-28).
- Vercel ISR has a distinct cache per deployment, so rollback does not lose previously generated content ([ISR](https://vercel.com/docs/incremental-static-regeneration)).
- Netlify: atomic deploys invalidate CDN automatically; caching docs cover cache control, cache tags, purge, stale-while-revalidate (agent-skills list links these; not all pages fetched). Netlify explicitly warns that Split Testing does not work reliably with functions/proxies/SSR/ISR ([split testing](https://docs.netlify.com/manage/monitoring/split-testing/)).
- Cloudflare: static assets are cached automatically at edge, with tiered caching; static asset requests are free/unlimited; `not_found_handling` supports SPA/404-page; `run_worker_first` gives selective Worker-before-asset routing ([static assets](https://developers.cloudflare.com/workers/static-assets/); [pricing](https://developers.cloudflare.com/workers/platform/pricing/)).
- Cloudflare Workers Caching and Cache API exist (Cache API limits: 512 MB object, 50/1,000 calls per request Free/Paid) ([limits](https://developers.cloudflare.com/workers/platform/limits/)). Cloudflare’s docs describe “Workers Caching” with cache hits billed as requests but no CPU ([pricing](https://developers.cloudflare.com/workers/platform/pricing/)).
- Vercel routing: config redirects (`vercel.json`/framework), bulk redirects (Pro 1,000 included, Enterprise 10,000; $0.002/mo per 25k), Vercel Functions, Middleware, domain redirects, firewall redirects; automatic 308 normalization of consecutive slashes; paths are case-sensitive ([redirects](https://vercel.com/docs/routing/redirects), 2026-09-18).
- Netlify routing: `_redirects` and `netlify.toml`; first match wins; `_redirects` before TOML; supports status, force, query, country/language/role/cookie conditions, signed proxy redirects, custom headers; edge functions run before redirects ([redirects](https://docs.netlify.com/manage/routing/redirects/overview/)).
- Cloudflare static asset routing limits: `_headers` max 100 rules, 2,000 chars/line; `_redirects` max 2,000 static + 100 dynamic = 2,100, 1,000 chars/rule ([limits](https://developers.cloudflare.com/pages/platform/limits/); [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)).
- Middleware equivalents: Vercel Routing Middleware; Netlify Edge Functions (Deno); Cloudflare Workers `run_worker_first`/routes. Netlify Edge Functions can rewrite, set headers, geolocate, A/B test via cookies, and cache responses ([Edge Functions](https://docs.netlify.com/build/edge-functions/overview/)).

**Images, forms, config, flags**

- Vercel Image Optimization on all plans: transforms/caches at CDN, `/_next/image` or `/_vercel/image`, width/quality params, WebP/AVIF; Hobby 5k transformations/month, then $0.05–$0.0812/1k; cache reads/writes metered; local cache up to 31 days ([image optimization](https://vercel.com/docs/image-optimization), 2026-08-13; [pricing](https://vercel.com/docs/pricing)).
- Netlify Image CDN: request-time transforms at `/.netlify/images` with `url`, `w`, `h`, `fit`, `position`, `fm` (avif/jpg/png/webp/gif/blurhash), `q`; content negotiation prefers WebP then AVIF; results cached at edge; respects atomic deploys so changed source re-transforms; remote images require `[images] remote_images` regex allowlist ([Image CDN](https://docs.netlify.com/build/image-cdn/overview/)).
- Cloudflare Images Transformations: URL-based transforms on a zone or via Workers; cache hit avoids origin; each unique source+params combo is one billable “unique transformation” per calendar month; supports source origins, transformation flows, rewrite rules ([Images overview](https://developers.cloudflare.com/images/optimization/transformations/overview/), 2026-10-15). Pricing was not fetched (gap).
- Netlify Forms: build-time HTML scan, `data-netlify="true"`/`netlify` attribute, hidden `form-name`, AJAX URL-encoded submissions, file uploads (8 MB max, 30 s timeout), spam filters, email/webhook notifications; form submissions are **free/unmetered** in credit plans ([Forms setup](https://docs.netlify.com/manage/forms/setup/); [credit plans](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/credit-based-pricing-plans/)).
- Vercel **Global Config** (formerly Edge Config): low-latency global key-value; Hobby first 100k reads/100 writes; on-demand $3/1M reads, $1/100 writes ([pricing](https://vercel.com/docs/pricing)). Vercel audit log lists `edge_config.*` actions ([audit log](https://vercel.com/docs/audit-log), 2026-08-26).
- Cloudflare KV: Free 100k reads/day, 1k writes/day, 1 GB; Paid 10M reads/mo, 1M writes/mo, 1 GB included, $0.50/GB-month ([pricing](https://developers.cloudflare.com/workers/platform/pricing/)).
- Netlify Blobs: key-value/binary object storage, **Beta** per credit-plan table ([credit plans](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/credit-based-pricing-plans/)).
- Vercel Flags: platform-native flags with targeting rules, segments, splits, environment controls; Flags Explorer for local/toolbar overrides; Flags SDK for Next.js/SvelteKit; Marketplace providers (LaunchDarkly, Statsig, Split); flag evaluation visible in Runtime Logs and Web Analytics ([Flags](https://vercel.com/docs/flags), 2026-09-15). Flags Explorer is a **$250/month** Pro add-on ([pricing](https://vercel.com/docs/pricing)).
- Netlify Split Testing: **no longer addable to new projects as of 2026-08-26**; never left Beta, no further development; existing tests keep working on all plans. It splits branch-deploy traffic via `nf_ab` cookie, doesn’t support functions/proxies reliably, disables Edge Functions and Agent Runners ([Split Testing](https://docs.netlify.com/manage/monitoring/split-testing/)).
- Cloudflare has no first-party feature-flag product in the fetched docs (gap); Workers KV/Global Config-like primitives can implement flags manually.

### Inferences
- Skiff should not chase Vercel/Netlify on full serverless. The highest-value platform primitives for a static-first product are: **headers/redirects/rewrites with tests**, **cache-control/purge**, **image transforms**, **a small global config/KV**, **scheduled deploys/jobs**, and **forms endpoints**.
- ISR is strategically attractive but expensive: it requires a durable cache, request collapsing, tag purge, and framework integration. A “stale-while-revalidate + tag purge” subset could serve static sites with dynamic fragments without a full ISR engine.
- Netlify’s retirement of Split Testing is a signal: experimentation is hard to keep first-party. Skiff should expose flags via a provider-agnostic config/API rather than build a full experimentation suite.
- Cloudflare’s free static-asset requests and unlimited egress make “static-first” economics obvious; Skiff’s self-hosted equivalent is Caddy + object store, so the product moat is workflow and agent UX, not raw serving cost.

### Gaps
- Netlify ISR/on-demand builder behavior and exact cache-tag/purge API were not fetched; do not assume parity with Vercel.
- Cloudflare Images transformation pricing and plan gating were not fetched.
- Cloudflare’s first-party flag/experimentation offering (if any) was not found in fetched docs.
- Vercel Flags base-plan inclusion and limits beyond the Flags Explorer add-on were not fully verified.
- Netlify function bundle/body limits and edge-function limits were not on the fetched overview pages.

---

## Domains/TLS: custom domains, wildcard, apex/www, verification, on-demand TLS, transfer

### Takeaway
Custom domain + automatic TLS + apex/www canonicalization + ownership verification are table stakes. **Wildcard domains and per-customer on-demand TLS** are the differentiators that matter for a multi-tenant/self-hosted platform; Vercel supports wildcards with DNS-01 delegation, Cloudflare supports per-hostname certs via Cloudflare for SaaS, and Netlify offers domain registration/DNS/transfer plus branch subdomains.

### Cited Findings

- Vercel Hobby teams have a **50 custom domains per project** limit ([add a domain](https://vercel.com/docs/domains/working-with-domains/add-a-domain), 2026-09-16). Apex domains use an A record; subdomains a CNAME; nameservers are an alternative. Adding an apex prompts adding `www` and Vercel redirects between them; explicit redirect is recommended ([same](https://vercel.com/docs/domains/working-with-domains/add-a-domain)).
- Vercel **wildcard domains** are added as `*.acme.com`. Vercel needs DNS challenge access to issue/renew wildcard certs: use Vercel nameservers, or delegate `_acme-challenge` NS records to `ns1/ns2.vercel-dns.com` at the external DNS provider and add a wildcard CNAME to `cname.vercel-dns-0.com` ([add a domain](https://vercel.com/docs/domains/working-with-domains/add-a-domain)).
- Vercel domain verification: if a domain is already in use by another account/team, add a `TXT` record at `_vercel` on the apex; this enables subdomain delegation (e.g. `ai.example.com` in one team while `example.com` stays in another). Re-adding a domain generates a new TXT value ([add a domain](https://vercel.com/docs/domains/working-with-domains/add-a-domain)).
- Vercel sells domains and supports transfer-in/transfer-out; audit log actions include `domain.buy`, `domain.transfer_in.*`, `domain.moved_in/out`, `domain.delegated` ([audit log](https://vercel.com/docs/audit-log)).
- Netlify supports registering/buying a domain, bringing an existing domain, Netlify DNS, delegating a standalone subdomain, alias domains, domain redirects, and domain transfer ([domains getting started](https://docs.netlify.com/manage/domains/get-started-with-domains/)). Branch subdomains (`staging.yourcustomdomain.com`) require Netlify DNS; branch deploys otherwise use `branch--site.netlify.app` ([deploy overview](https://docs.netlify.com/deploy/deploy-overview/)).
- Netlify supports an **automatic subdomain for deploys** (shared custom subdomain for preview environments), useful when a tool requires a shared subdomain rather than per-deploy hashes ([domains getting started](https://docs.netlify.com/manage/domains/get-started-with-domains/)).
- Netlify HTTPS/SSL is documented separately; custom domains with SSL are available on all plans ([credit plans](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/credit-based-pricing-plans/)).
- Cloudflare Workers **Custom Domains** create DNS records and certificates automatically; the Worker is the origin. Exact-hostname matching only; **wildcard DNS is not supported** for Custom Domains. Multi-level subdomains (e.g. `realms.app.example.com`) get an Advanced Certificate automatically, no ACM subscription required. www/root must be handled with an explicit redirect rule plus a proxied placeholder record ([Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/), 2026-09-29).
- Cloudflare Pages preview aliases are hash URLs plus branch-name aliases; preview aliases can be attached to custom domains via “custom domains to a branch” ([Pages previews](https://developers.cloudflare.com/pages/configuration/preview-deployments/)).
- **Cloudflare for SaaS** supports customer-owned custom hostnames routed to a fallback origin; standard config is available on all plans, bundled with non-Enterprise plans and an Enterprise add-on. Apex proxying and BYOIP are Enterprise add-ons. Custom hostnames cannot use some Cloudflare features (Argo, Early Hints, client-side security, Spectrum, wildcard DNS) ([Cloudflare for SaaS](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/), 2026-04-29).
- Cloudflare for SaaS is the closest first-party “on-demand TLS” mechanism: custom hostnames are added to the zone and Cloudflare issues/serves certificates for them. The docs do not use the phrase “on-demand TLS” on the fetched page; treat the mapping as an inference (see Gaps).
- Vercel wildcard cert issuance and Cloudflare custom-hostname cert issuance both require a control point over DNS or a delegated challenge; this is the core constraint for Skiff’s per-customer domains.

### Inferences
- Skiff already has wildcard `*.contentDomain` via DNS-01, which covers platform previews. The missing piece for customer domains is a **custom hostname state machine**: add hostname → show TXT/CNAME instructions → verify ownership → issue cert (HTTP-01 or DNS-01 delegation) → route to release → renew → remove. This is exactly the Cloudflare for SaaS / Vercel wildcard pattern.
- Apex/www is not a detail: every platform explicitly handles it because users type both. Skiff should make apex + `www` a single domain object with a canonical redirect, not two unrelated domains.
- Domain transfer is low-frequency but high-trust; if Skiff self-hosts, integrate with registrar APIs rather than becoming a registrar.

### Gaps
- Vercel wildcard domain plan gating (whether wildcard is available on Hobby/Pro or Enterprise only) was not explicit on the fetched page; the page describes the mechanism, not the plan matrix.
- Netlify wildcard domains and on-demand TLS for customer-owned domains were not found; Netlify’s model appears to be bring-your-own-domain + Netlify DNS rather than a SaaS custom-hostname API.
- Cloudflare’s exact “on-demand TLS” API/feature name and pricing for custom hostnames beyond the plan bundle were not verified.
- Cloudflare Registrar transfer flow was not fetched (only Custom Domains/for SaaS).

---

## Access/security: password protection, SSO, deployment protection, preview access, IP allowlists, env vars/secrets, DDoS/WAF, bot protection

### Takeaway
Preview protection is table stakes; per-project password/SSO, IP allowlists, and managed WAF are paid or enterprise features. The most reusable pattern for Skiff is **protection method × protection scope** (who × what), with bypass tokens for automation and a separate secret type that is write-only after save.

### Cited Findings

**Deployment/preview protection**

- Vercel Deployment Protection is configured per project as **method × scope**. Methods: Vercel Authentication (all plans), Passport/IdP (Enterprise), Password Protection (Pro $20/mo/project; included Enterprise; not Hobby), Trusted IPs (Enterprise). Scopes: Standard Protection (all deployments except production domains; all plans), All Deployments (all plans), legacy Standard/Pre-Production, and “only production” via Trusted IPs (Enterprise) ([deployment protection](https://vercel.com/docs/deployment-protection), 2026-09-15).
- Vercel team-level defaults for new projects; Vercel Authentication for All Deployments and Deployment Protection Exceptions are free; Protection Bypass for Automation exists for non-browser clients ([deployment protection](https://vercel.com/docs/deployment-protection); [pricing](https://vercel.com/docs/pricing)).
- Vercel protects source maps behind Vercel Authentication so production `.map` files can ship without exposing source ([deployment protection](https://vercel.com/docs/deployment-protection)).
- Netlify has three visitor-access models: **Public**, **Password** (shared password), **Private** (Netlify team login). A project has one visibility setting plus a scope: “Production and previews” or “Previews only.” On credit plans, Password is available on Pro, not Free/Personal; Private on Free/Personal is owner-only, Pro invites unlimited members ([password protection](https://docs.netlify.com/manage/security/secure-access-to-sites/password-protection/); [credit plans](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/credit-based-pricing-plans/)).
- Netlify team login protection can enforce SSO (Organization/Team SAML SSO; strict “Only SSO allowed” for SSO-only). SSO auth tokens expire after 1 hour; `Netlify-Site-Protection-Expires-In` header tells clients seconds remaining ([password protection](https://docs.netlify.com/manage/security/secure-access-to-sites/password-protection/)).
- Netlify Reviewers can be invited unlimited and can review deploys; Reviewer SSO login is **Beta** on Enterprise. Git Contributors cannot access team-login-protected sites ([password protection](https://docs.netlify.com/manage/security/secure-access-to-sites/password-protection/)).
- Netlify protects all site deploys or only non-production deploys; “protect only non-production” with Password Protection is Enterprise-only ([password protection](https://docs.netlify.com/manage/security/secure-access-to-sites/password-protection/)).
- Cloudflare Pages previews are public by default; “Enable access policy” puts preview URLs behind **Cloudflare Access**, but does not protect the `*.pages.dev` domain or custom domain unless separately configured ([Pages previews](https://developers.cloudflare.com/pages/configuration/preview-deployments/)).
- Cloudflare Workers Previews are public by default; Access can protect all previews on an account, one Worker’s previews, or specific hostnames ([Workers previews](https://developers.cloudflare.com/workers/previews/)).
- Cloudflare Access policy model: action (Allow/Block/Bypass/Service Auth), rule type (Include/Require/Exclude), selector (email, email domain, IP range, country, Everyone, common name, valid client cert, service token, service-token tag, user risk score Enterprise, login method, MFA method, IdP group, SAML group, OIDC claim, device posture, WARP, Gateway, Cloudflare account member). Policy order: Service Auth/Bypass first, then Allow/Block in order; first Allow/Block match stops evaluation ([Access policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/), 2026-11-02).
- Cloudflare Access supports service tokens and mTLS for machine access without an IdP login ([Access policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/)).

**IP allowlists, WAF, DDoS, bot**

- Vercel WAF is available on **all plans**. Limits: project IP blocks 10 Hobby/40 Pro/250 Enterprise; custom rules 3/40/250; OWASP Core Ruleset Enterprise only; account-level IP blocking Enterprise; rate-limit algorithm fixed window on Hobby/Pro, token bucket Enterprise. Changes apply globally within 300 ms and can be rolled back ([Vercel WAF](https://vercel.com/docs/vercel-firewall/vercel-waf), 2026-07-29).
- Vercel has firewall redirects that execute before CDN/config redirects, and WAF audit/restore ([WAF](https://vercel.com/docs/vercel-firewall/vercel-waf); [redirects](https://vercel.com/docs/routing/redirects)).
- Netlify Firewall Traffic Rules block/allow by IP/CIDR and country/subregion; separate rulesets for published vs unpublished deploys; limit 2 rules on Free/Personal, 10 on Pro/Enterprise, 500 on Enterprise with High-Performance Edge; 50 IPs/geolocations per rule on Pro/Enterprise, 500 on HP Edge ([traffic rules](https://docs.netlify.com/manage/security/secure-access-to-sites/traffic-rules/)).
- Netlify also offers rate limiting and WAF; team audit log records WAF rule updates ([deploy overview](https://docs.netlify.com/deploy/deploy-overview/); [audit log](https://docs.netlify.com/manage/accounts-and-billing/team-management/team-audit-log/)).
- Cloudflare WAF is available on all plans: custom rules all plans; rate limiting 1 rule Free, more on paid; managed rules Free only free ruleset, Pro/Business/Enterprise fuller; attack score Business+; malicious uploads Enterprise add-on; AI Security for Apps Enterprise add-on; account-level config Enterprise ([WAF](https://developers.cloudflare.com/waf/), 2026-08-19).
- Cloudflare provides DDoS protection and bot solutions as separate products ([WAF related products](https://developers.cloudflare.com/waf/)). Exact bot plan gating not fetched (gap).

**Environment variables and secrets**

- Vercel environment variables are encrypted at rest; **Config** values remain readable to authorized members, **Secret** values are write-only after save. Variables can be team- or project-scoped, per environment (Production/Preview/Custom/Development), and preview variables can be branch-specific. Changes apply only to new deployments. Limit 64 KB total per deployment (5 KB per variable on edge runtime). Secrets ≥32 chars appearing in build logs are redacted; `VERCEL_AUTOMATION_BYPASS_SECRET` and `VERCEL_OIDC_TOKEN` always redacted ([environment variables](https://vercel.com/docs/environment-variables), 2026-09-17; [builds](https://vercel.com/docs/builds)).
- Netlify environment variables have **Builds, Functions, Runtime, Post processing** scopes; team-level shared variables are Pro+; `netlify.toml` variables are not available to the deploy environment; CLI supports per-deploy `--env` and masked `--secret-env`; smart secret detection is Personal+ ([manage deploys](https://docs.netlify.com/deploy/manage-deploys/manage-deploys-overview/); [credit plans](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/credit-based-pricing-plans/); [CLI deploy](https://cli.netlify.com/commands/deploy/)).
- Netlify sensitive-variable policy can block deploys from public repos until a member approves ([deploy overview](https://docs.netlify.com/deploy/deploy-overview/)).
- Cloudflare Workers: 64 env vars Free / 128 Paid per Worker, 5 KB each; secrets are separate from text vars ([limits](https://developers.cloudflare.com/workers/platform/limits/)). **Secrets Store** is an account-level encrypted secret store, **open beta**, compatible with Workers and AI Gateway, unavailable in China ([Secrets Store](https://developers.cloudflare.com/secrets-store/), 2026-08-14).
- Cloudflare Previews do not inherit production settings; variables/secrets/bindings must be defined per Preview, and secrets must be applied via commands rather than config ([Workers previews](https://developers.cloudflare.com/workers/previews/)).

### Inferences
- Skiff’s existing HMAC host-only cookie for protected sites is a good foundation, but the product needs the **method × scope** matrix: public / password / team SSO / IP allowlist, each with production-and-previews vs previews-only, plus automation bypass tokens. This is the single most requested “private preview” workflow.
- Secret scoping is a differentiator that is cheap to implement: write-only secret type, per-environment/per-branch scoping, redaction in build/runtime logs, and an audit event on read/write. Vercel’s Config vs Secret split is the cleanest model to copy.
- Do not build a WAF. For self-hosted Skiff, expose Caddy/Coraza/Cloudflare-fronted options and focus on IP allowlists, rate limits, and basic bot blocking at the edge.
- Per-preview resource isolation (Cloudflare Previews) is a strong idea for tier-2/3 apps: separate env vars, bindings, and data per branch. Skiff’s release-per-deploy model can approximate this by scoping env to the release.

### Gaps
- Vercel bot-protection/DDoS specifics and whether bot management is included on Pro were not fetched.
- Netlify WAF/rate-limit plan pricing and exact rule limits were not fully fetched.
- Cloudflare Bot Management plan gating and pricing were not fetched.
- Netlify SSO pricing (SAML) was not fetched; Vercel SAML is listed at $300/month ([pricing](https://vercel.com/docs/pricing)).
- Cloudflare Access pricing (free seat count) was not fetched.

---

## Collaboration/ops: comments/review, deploy notifications, logs, analytics, observability/tracing, usage/cost controls, status pages, team roles, audit logs

### Takeaway
Comments and deploy notifications are cheap table stakes; request-level observability, log drains, and audit logs are increasingly paid/enterprise. **None of the three ships a customer-facing status page product** — status pages are a gap/partner integration, not a feature to copy. For Skiff, preview comments + webhook/Slack notifications + request logs + an audit trail are the right first tranche.

### Cited Findings

**Comments/review**

- Vercel Comments are available on **all plans, free**, enabled by default on all preview deployments; comments attach to any UI location/text, open threads, link to Slack threads, notify PR owners by email, and support external collaborators on Pro/Enterprise. The Vercel Toolbar must be active; a browser extension can keep it always on; comments can be managed via CLI ([comments](https://vercel.com/docs/comments), 2026-08-19).
- Netlify Drawer is enabled by default on Deploy Previews (and configurable on branch deploys); stakeholders can leave context-rich feedback with image/video/browser metadata and sync to GitHub, GitLab, Jira, Azure DevOps, Trello, etc. Unlimited Reviewers can be invited ([deploy overview](https://docs.netlify.com/deploy/deploy-overview/)).
- Cloudflare has no first-party preview-comment feature in the fetched docs (gap).

**Deploy notifications**

- Netlify emits deploy events: started, succeeded, failed, deleted, locked, unlocked, request pending/accepted/rejected, restored, previously successful→failed, previously failed→succeeded. Channels: Slack, email (Pro/Enterprise), outgoing webhook (JSON POST, optional JWS `X-Webhook-Signature` with `iss: netlify` + SHA-256), GitHub commit statuses/PR comments/checks, GitLab commit statuses/MR comments, Bitbucket, Azure DevOps, Cursor Origin; ChatGPT automations and Zapier/n8n integrations ([deploy notifications](https://docs.netlify.com/deploy/deploy-notifications/)).
- Netlify email deploy notifications are Pro/Enterprise; Slack notifications are Pro+ in the credit table ([deploy notifications](https://docs.netlify.com/deploy/deploy-notifications/); [credit plans](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/credit-based-pricing-plans/)).
- Vercel has Slack integration for comments and Agent chat; deploy notifications/email/Slack are referenced in comments/agent docs but a single authoritative notification matrix was not fetched (gap).
- Cloudflare has deploy hooks but no first-party deploy-notification product in fetched docs; Logpush/Workers Logs can feed external alerting (gap).

**Logs, analytics, observability**

- Vercel Observability available on all plans; Observability Plus Pro/Enterprise adds features, higher limits, longer retention, priced $1.20 per 1M events. Insights cover Functions, External APIs, CDN Requests, Middleware, Fast Data Transfer, Image Optimization, ISR, Blob, Build Diagnostics, AI Gateway, Queues, External Rewrites, Microfrontends, AI Traffic. CLI supports `vercel logs --json`, `vercel curl --trace --json`, `vercel metrics schema` ([observability](https://vercel.com/docs/observability), 2026-09-10; [pricing](https://vercel.com/docs/pricing)).
- Vercel Web Analytics: 50k events/month Hobby; Pro $0.03/1k events; 12-month reporting Pro, 24-month Enterprise/Plus; custom events and properties ([pricing](https://vercel.com/docs/pricing)).
- Vercel Speed Insights: first 10k events Hobby, $0.65/10k; Speed Insights Plus $10/mo/project ([pricing](https://vercel.com/docs/pricing)).
- Netlify Observability: near-real-time request/bandwidth/compute data; retention Free/Personal 24 h, Pro 7 days, Enterprise 30 days; filters by status, method, content type, cache status, UA category, function/edge name, block reason; quick insights incl. “Top AI searches”; **no programmatic access**; no alerting; log drains recommended for long-term/SIEM ([observability](https://docs.netlify.com/manage/monitoring/observability/overview/)).
- Netlify Web Analytics/RUM retention: Free current/past day, Personal 24 h, Pro 30 days ([credit plans](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/credit-based-pricing-plans/)).
- Cloudflare Workers Logs: Free 200k events/day, 3-day retention; Paid 20M/month included, 7-day retention, +$0.60/M; **pricing moves to Cloudflare Observability pricing on 2026-12-01** (announced) ([pricing](https://developers.cloudflare.com/workers/platform/pricing/)). Workers Logpush is Paid only, 10M requests/month included, +$0.05/M ([pricing](https://developers.cloudflare.com/workers/platform/pricing/)).
- Cloudflare log size limit 256 KB/request; Cron Events stores 100 most recent invocations; GraphQL Analytics API available ([limits](https://developers.cloudflare.com/workers/platform/limits/); [cron triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)).

**Usage/cost controls**

- Netlify credit plans: Free 300 credits/month with a **hard limit**; Personal 1,000 with auto-recharge 500 credits/$5; Pro 3,000+ with auto-recharge 1,500/$10; unused monthly credits roll over only on Pro ≥5,000; production deploy = 15 credits; web requests 2 credits/10k; bandwidth 20 credits/GB; functions/agent compute 10 credits/GB-hour; AI inference 180 credits/$1 ([credit plans](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/credit-based-pricing-plans/)).
- Vercel uses included allowances + on-demand pricing; Hobby has hard included amounts; Pro has a monthly usage credit then on-demand; flat-rate CDN option; build/function/image/analytics/observability all metered ([pricing](https://vercel.com/docs/pricing)).
- Cloudflare allows per-Worker CPU limits to prevent runaway bills/denial-of-wallet ([pricing](https://developers.cloudflare.com/workers/platform/pricing/)); Workers Paid is $5/month minimum with included requests/CPU ([pricing](https://developers.cloudflare.com/workers/platform/pricing/)).

**Roles, audit, status pages**

- Vercel roles referenced: owner, admin, member, viewer, developer, security ([WAF](https://vercel.com/docs/vercel-firewall/vercel-waf); [audit log](https://vercel.com/docs/audit-log)). Audit Logs are **Enterprise only**, owner-accessible; CSV export for last 90 days is free of billing impact; SIEM streaming is Enterprise and being replaced by Audit Log Drains (S3/Splunk/Datadog/GCS/HTTP) ([audit log](https://vercel.com/docs/audit-log)).
- Netlify roles: Team Owner, Developer, Billing Admin, Reviewer, Git Contributor; team audit log on **Pro/Enterprise**, retention varies by plan (Pro table says 7-day history); events split into team vs project ([credit plans](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/credit-based-pricing-plans/); [audit log](https://docs.netlify.com/manage/accounts-and-billing/team-management/team-audit-log/)).
- Cloudflare account members/roles exist, but the fetched docs did not provide a role matrix or audit-log plan gating (gap).
- Status pages: Vercel, Netlify, and Cloudflare each publish their **own** platform status page, but none of the fetched docs describe a customer-facing status-page product or a “status page for your site” feature. Treat this as a gap/partner integration (Statuspage/Better Stack), not a platform feature.

### Inferences
- Preview comments are a high-signal, low-cost differentiator for Skiff because the product is agent-centric: comments become agent context (“fix this thread”). Building comments on top of the preview URL + a threaded annotation store is feasible.
- Deploy notifications should be webhook-first with signed payloads and a Slack adapter; Netlify’s event taxonomy is a good checklist (including locked/unlocked and pending approval).
- Observability is a bottomless pit. Skiff should ship **request logs + build logs + basic metrics** and expose them through MCP/CLI; deep tracing/APM should be an integration (OTel/Datadog/Grafana), not a first-party build.
- Audit logging is a differentiator for self-hosted/private-cloud buyers even if Vercel gates it to Enterprise; Skiff should make it available by default with retention controls.
- Cost controls matter less for self-hosted but quotas/limits per project still matter for multi-tenant operators; Netlify’s hard-limit + auto-recharge pattern is a good UX reference.

### Gaps
- Vercel’s authoritative deploy-notification matrix (email/Slack/webhook events) was not fetched.
- Cloudflare’s team-role matrix and audit-log availability/pricing were not fetched.
- Netlify audit-log retention beyond the Pro 7-day table entry was not verified.
- No vendor offers a customer-facing status page in the fetched docs; this may exist as a marketplace integration rather than a platform feature.

---

## Agent/AI features: MCP servers, AI SDK, agents, deploy-from-agent, v0, natural-language ops

### Takeaway
By November 2026 all three ship **remote MCP servers with OAuth**, and Vercel/Netlify layer hosted agents on top. Cloudflare’s differentiator is **Code Mode** (two tools, ~1,000 tokens, full API) plus an Agents SDK for building agents on Workers. For Skiff, MCP is already the moat; the gap is **tool-surface parity, one-click client onboarding, scoped deploy-from-agent, and an auditable agent-run primitive**.

### Cited Findings

**Vercel**

- Vercel MCP is available on all plans at `https://mcp.vercel.com`; remote MCP with OAuth, implements MCP Authorization and Streamable HTTP; supports CIMD (Client ID Metadata Document) so clients can connect without review; supported clients include Claude Code/Claude.ai/ChatGPT/Codex/Cursor/VS Code/Devin/Raycast/Goose/Windsurf/Gemini/OpenCode/Pi ([Vercel MCP](https://vercel.com/docs/agent-resources/vercel-mcp), 2026-09-15).
- Vercel MCP tool catalog spans Access Groups, Agent Runs, Billing/Purchases, Caching, Checks, Deployments, Documentation/CLI/Feedback, Domains/DNS, Drains, Environment Variables, Feature Flags, Firewall/Security, Global Config, Integrations, Key Management, Microfrontends, Networking, Observability, Projects, Rolling Releases, Routing, Sandboxes, Storage, Teams/Users, Toolbar, Vercel CI, Web Analytics. Frequently used: `list_deployments`, `get_deployment`, `web_fetch_vercel_url`, `get_runtime_logs`, `list_projects`, `list_teams`, `get_project`, `get_runtime_errors` ([tools](https://vercel.com/docs/agent-resources/vercel-mcp/tools), 2026-09-15).
- Vercel MCP can **deploy code** (changelog “Vercel MCP can now deploy code”), render deployments as interactive cards, support purchases, send feedback, and supports CIMD ([MCP related changelog links](https://vercel.com/docs/agent-resources/vercel-mcp)).
- Vercel MCP OAuth grants the AI client the **same access as the Vercel user account**; docs recommend human confirmation, trusted clients, and warn about prompt injection/confused-deputy attacks ([Vercel MCP](https://vercel.com/docs/agent-resources/vercel-mcp)).
- **Vercel Agent** is **Public Beta on Pro/Enterprise**: dashboard chat and Slack chat, Code Review (Sandbox-validated PR suggestions), Security Review (starts from push events, covers direct/force pushes), Investigations (anomaly alerts, failed deploys, runtime errors, cost/performance), Installation (adds products via PR). Read-only by default; write actions require a scoped plan + approval; token-based pricing ([Vercel Agent](https://vercel.com/docs/agent), 2026-09-18).
- Vercel’s broader AI stack: AI SDK, AI Gateway, Sandbox, Workflows, Queues, Agent Harnesses (Pi/fx/OpenCode/eve/Claude Code/Codex) with durable session logs ([queues](https://vercel.com/docs/queues); [limits](https://vercel.com/docs/functions/limitations) links). v0 deploys to Vercel and has its own MCP server ([v0 MCP docs](https://v0.app/docs/api/v1/adapters/mcp-server) linked from Vercel MCP docs; not fetched).

**Netlify**

- Netlify offers a **remote MCP server** at `https://netlify-mcp.netlify.app/mcp` and a local server via `npx -y @netlify/mcp`; one-click installs for Cursor/LM Studio/VS Code; agent setup guide covers Claude Code, Codex, Claude Web/Desktop, ChatGPT, Grok, Antigravity ([agent setup](https://docs.netlify.com/build/build-with-ai/agent-setup-guides/agent-setup-overview/)).
- Netlify publishes **agent skills** (`npx skills add netlify/context-and-tools --skill '*' --yes`) covering functions, edge functions, Blobs, Database, Image CDN, Forms, config, CLI/deploy, frameworks, caching, AI Gateway; also a JSON schema for `netlify.toml` for agent validation ([agent setup](https://docs.netlify.com/build/build-with-ai/agent-setup-guides/agent-setup-overview/)).
- The Netlify MCP server follows MCP to let code agents use the Netlify API and CLI — create projects, build, deploy, manage environment variables, etc. ([Netlify MCP GitHub](https://github.com/netlify/netlify-mcp), linked from docs).
- **Agent Runners** are available on Credit-based plans (Free/Personal/Pro); supported agents: Claude Code, OpenAI Codex, Google Antigravity, Meta Muse, OpenCode. Build mode makes changes + Deploy Preview; Ask mode answers without changes. Runs start on an automated branch off production (or a chosen branch via CLI `--branch`); preview URL `agent-<runID>--site.netlify.app`; can pause and ask questions; can redeploy the preview without re-running AI inference; GitHub-only for Git-connected projects; not compatible with Split Testing; credits meter AI inference + compute ([Agent Runners](https://docs.netlify.com/build/build-with-ai/agent-runners/overview/)).
- Netlify **AI Gateway** proxies OpenAI/Anthropic/Google SDKs; AI inference is 180 credits/$1 ([credit plans](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/credit-based-pricing-plans/); agent skills list).

**Cloudflare**

- Cloudflare runs managed remote MCP servers with OAuth. The **Cloudflare API MCP server** at `https://mcp.cloudflare.com/mcp` exposes the entire Cloudflare API (2,500+ endpoints across DNS, Workers, R2, Zero Trust) plus docs, using **Code Mode**: `search()` and `execute()` tools plus `docs()`. The model writes JS against a typed OpenAPI/Cloudflare API client, executed in an isolated **Dynamic Worker** sandbox. Token cost ~1,000 regardless of endpoint count, vs ~1,170,000 for 2,594 native tools (~244,000 with required params only) ([Cloudflare MCP servers](https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/), 2026-10-27).
- Cloudflare API MCP supports OAuth for interactive use and **API tokens as bearer** for CI/CD/automation (user and account tokens) ([same](https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/)).
- Product-specific MCP servers: docs search, containers/sandbox, browser rendering, digital experience monitoring, CASB, Agents SDK docs. Cloudflare also publishes a **Skills plugin** for Claude Code/Cursor/OpenCode/Codex/Pi (`npx skills add https://github.com/cloudflare/skills`) ([same](https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/)).
- Cloudflare **Agents SDK**: stateful agents on Workers/Durable Objects with memory, scheduling, email, WebSockets, MCP client/server, web fetch/search, browser automation, sandboxed code execution, AI Search, payments; `createMcpHandler` builds stateless MCP servers on Workers ([Agents docs](https://developers.cloudflare.com/agents/), linked from search; [MCP handler](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/), linked).
- Cloudflare Workers AI and AI Gateway exist (docs), but exact model/pricing was not fetched (gap).

**Cross-platform patterns**

- All three support **`npx add-mcp <url>`** style one-command client setup and publish agent skills/plugins; Vercel’s `add-mcp` detects installed clients and can install globally ([Vercel MCP](https://vercel.com/docs/agent-resources/vercel-mcp); [Netlify agent setup](https://docs.netlify.com/build/build-with-ai/agent-setup-guides/agent-setup-overview/); [Cloudflare MCP](https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/)).
- All three frame agent access as **the user’s existing permissions**, with OAuth consent; Vercel explicitly warns about prompt injection/confused deputy and recommends human confirmation ([Vercel MCP](https://vercel.com/docs/agent-resources/vercel-mcp)).
- Cloudflare’s Code Mode is a direct response to tool-catalog bloat: expose a search/execute pair rather than hundreds of tools. This is highly relevant to Skiff’s MCP surface as it grows.

### Inferences
- Skiff’s MCP server is ahead of most self-hosted platforms but behind the commercial three on **breadth**: deploy, promote, rollback, logs, env vars, domains, access, analytics, audit, and “what changed” should all be tools. Vercel’s catalog is the checklist; Cloudflare’s Code Mode is the scalability answer.
- The killer agent flow is not “chat with dashboard” but **deploy → preview → inspect logs → fix → promote**, with a scoped, auditable token. Netlify’s Agent Runners and Vercel Agent both implement a version of this; Skiff can differentiate by making the agent a first-class API client rather than a hosted model.
- Agent skills/one-click install are distribution, not product depth. Skiff should ship a `skiff` skill + `add-mcp` snippet + CIMD to reduce onboarding friction.
- A hosted “agent run” (branch, diff, preview, approval) is a differentiator but requires sandboxing and billing; Skiff can start with an external-agent workflow (MCP tools + preview URLs) and add a hosted run later.
- Agent audit is a gap across all three: Vercel has audit actions for agent security findings and MCP purchases, but not a clear “agent did X” event taxonomy. Skiff can lead here by logging every MCP tool call with actor, token, scope, project, and result.

### Gaps
- Netlify MCP’s exact tool list and whether it can deploy arbitrary artifacts (vs Git/CLI) were not fetched.
- Cloudflare’s first-party natural-language operations agent (as opposed to MCP + Agents SDK) was not found.
- Vercel v0’s deploy flow and its relationship to Vercel MCP/Agent were not fetched in detail.
- Cloudflare Workers AI / AI Gateway pricing and model catalog were not fetched.
- Vercel Agent pricing rates/included usage were not fetched (docs link only).

---

## Synthesis: table stakes vs differentiators (with the user problem each solves)

**How to read this table.** “Table stakes” = a credible deploy platform is expected to have it; absence causes evaluation loss. “Differentiator” = buyers switch/upgrade for it, or it unlocks a new workflow. “Skiff call” is a recommendation for sequencing, not a commitment: **Now** (next 1–2 releases), **Next** (quarter), **Later** (post-PMF), **Skip/Integrate** (don’t build).

### Table stakes

| Feature | User problem it solves | Who ships it | Skiff call |
|---|---|---|---|
| Git connect + PR previews | “I want every PR to have a URL I can review before merge.” | Vercel, Netlify, Cloudflare | **Now** — preview per branch/PR, immutable URL |
| CLI + API/artifact deploy | “I want to deploy from CI or an agent without a Git push.” | All three | **Now** (Skiff has CLI; add token-scoped REST + presigned upload docs) |
| Immutable deploy + permalink | “I need to know exactly what is live and reproduce it.” | All three | **Now** (already core) |
| Promote/rollback | “A bad deploy is live; restore the last good one in seconds.” | All three | **Now** (already pointer swap; expose in all surfaces) |
| Deploy hooks | “Rebuild when my CMS/content changes.” | All three | **Now** (signed/secret URL, branch param, idempotency) |
| Custom domain + automatic TLS | “Put my site on my domain without cert wrangling.” | All three | **Now** (Caddy + ACME; add per-domain status) |
| Apex/www canonical redirect | “Users type www and apex; don’t serve duplicates.” | All three | **Now** (single domain object with redirect) |
| Domain ownership verification | “Prove I control this domain before you route it.” | Vercel TXT, Cloudflare custom hostname, Netlify DNS | **Now** (TXT + CNAME instructions) |
| Env vars + secrets | “Keep API keys out of git and scope them per env.” | All three | **Now** (write-only secret type, preview/prod scopes, redaction) |
| Build logs + runtime logs | “Why did the build/deploy fail, and what is erroring now?” | All three | **Now** (build log per deploy; request log query) |
| Deploy notifications | “Tell Slack/my webhook when a deploy succeeds/fails.” | Netlify deep; Vercel/CF partial | **Now** (webhook + Slack; signed payload) |
| Preview protection | “Don’t let the public see unreleased work.” | All three | **Now** (password/SSO/IP × preview-only/all) |
| Monorepo root dir + skip unaffected | “Don’t rebuild every app on every commit.” | Vercel, Netlify, Cloudflare (root dir) | **Next** (path/dependency diff; skip without consuming slot) |
| Headers/redirects/rewrites | “Migrate URLs and set security/cache headers without code.” | All three | **Now** (Skiff has `_redirects`/`_headers`; add tests + limits) |
| Cache-control + purge | “Fix a stale asset/page without a redeploy.” | All three | **Next** (tag/path purge API + CLI/MCP) |
| Build cache + timeout/queue | “Builds are slow/flaky and pile up.” | All three | **Next** (dependency cache, per-project concurrency, cancel) |
| Basic roles + audit trail | “Who changed production, and who can?” | All three (audit often paid) | **Now** (RBAC already; add append-only audit + export) |
| MCP server + token auth | “Let my agent inspect/deploy without screen-scraping.” | All three | **Now** (Skiff differentiator; keep OAuth 2.1) |

### Differentiators

| Feature | User problem it solves | Who ships it | Skiff call |
|---|---|---|---|
| Instant rollback to **any** prior release, no rebuild | “The last 5 deploys are bad; go back to Tuesday’s build.” | Vercel Pro/Ent; Netlify any prior; Cloudflare versions | **Now** — cheap on Skiff’s pointer model; make it explicit in UI/CLI/MCP |
| Rolling releases / gradual traffic + auto-abort | “Ship to 5% first, watch errors, then promote.” | Vercel Rolling Releases (Pro/Ent); Cloudflare gradual deployments (2 versions, %) | **Later** — needs traffic splitting + metrics; can start with header/cookie canary |
| Skew protection / version affinity | “Old tabs break after deploy because client/server versions differ.” | Vercel Skew Protection (Pro/Ent); Cloudflare version affinity | **Later** — release-pinned asset URLs first |
| Per-deployment/per-branch env vars | “Preview should use staging keys, production uses prod keys.” | Vercel branch env; Cloudflare Preview-specific vars; Netlify deploy contexts | **Now** — high value, low cost |
| Write-only secret type + scoped secrets | “I need to rotate keys without exposing them to teammates/agents.” | Vercel Secret; Netlify secret-env/shared vars; CF Secrets Store (beta) | **Now** — combine with MCP scope enforcement |
| Wildcard domains | “Give every customer/tenant a subdomain without adding each one.” | Vercel wildcard; Cloudflare custom hostnames; Netlify branch subdomains | **Now/Next** — Skiff already has `*.contentDomain`; expose customer wildcard |
| On-demand TLS for customer domains | “Let customers bring `app.customer.com` and get a cert automatically.” | Cloudflare for SaaS; Vercel wildcard/delegation | **Next** — per-hostname cert state machine |
| Edge image optimization | “Stop shipping 4 MB hero images; resize per device.” | Vercel, Netlify, Cloudflare | **Next** — integrate libvips/Cloudflare Images or Caddy transform; charge by transform |
| ISR / stale-while-revalidate + tag purge | “Content changes hourly; don’t rebuild the whole site.” | Vercel ISR; Netlify cache primitives; Cloudflare cache API | **Later** — start with SWR + purge, not full ISR |
| Durable queues/workflows | “Run reliable background jobs/agent turns that survive crashes.” | Vercel Queues/Workflows (Beta/GA mix); Cloudflare Queues/Workflows; Netlify background functions only | **Later/Integrate** — don’t build a queue; expose job hooks/webhooks |
| Cron/scheduled jobs | “Rebuild or run a task every hour/day.” | All three | **Next** — scheduled deploy hook + signed cron endpoint |
| Global config / edge KV | “Change a flag/redirect without redeploying.” | Vercel Global Config; Cloudflare KV; Netlify Blobs (beta) | **Next** — small KV with audit + MCP tool |
| First-party forms | “Collect a contact form without a backend.” | Netlify only | **Next** — simple form endpoint + spam filter + email/webhook |
| Feature flags + experimentation | “Ship dark, ramp %, A/B test.” | Vercel Flags; Netlify Split Testing (closed to new); Cloudflare none first-party | **Integrate/Next** — provider-agnostic flag config, don’t build stats engine |
| Preview comments/annotations | “Reviewers need to point at the exact element and discuss.” | Vercel Comments (free); Netlify Drawer | **Now** — high-signal, agent-friendly |
| Request-level observability + drains | “Find the slow/erroring route and stream logs to my SIEM.” | Vercel Observability/Plus; Netlify Observability; Cloudflare Workers Logs/Logpush | **Next** — request logs + OTel export; don’t build APM |
| Audit logs + SIEM export | “Prove who deployed/rolled back and when.” | Vercel Enterprise; Netlify Pro; Cloudflare (gap) | **Now** — differentiator for private cloud; export JSON/CSV |
| Hosted agent runs (branch → preview → approval) | “Ask an agent to fix this and give me a preview, not a diff I must run.” | Vercel Agent (Beta); Netlify Agent Runners | **Later** — external agents first; hosted run after sandbox/billing |
| Code review / security review / investigations | “Catch bugs/vulns and explain prod incidents automatically.” | Vercel Agent (Beta); Netlify “Why did it fail?” + fix | **Later/Integrate** — integrate existing agents via MCP; don’t train models |
| MCP Code Mode (search/execute) | “Expose a huge API to agents without 1M tokens of tool schemas.” | Cloudflare | **Next** — add `search`/`execute` over Skiff API when tool count grows |
| Agent skills + one-click MCP install | “Make my coding agent productive in one command.” | All three | **Now** — ship `skiff` skill, `add-mcp` snippet, CIMD |
| Deploy-from-agent with scoped approval | “Let the agent deploy, but require my approval for prod.” | Vercel MCP deploy + Agent approvals; Netlify MCP/Agent Runners | **Now** — scoped token, preview-only default, explicit prod approval |
| Natural-language ops (chat/Slack) | “Ask what’s broken and have it investigate.” | Vercel Agent chat/Slack; Netlify Agent Runners; Cloudflare via MCP | **Later** — Slack bot over MCP is a cheap MVP |
| Usage/cost controls | “Don’t let a runaway build/agent bill me.” | Netlify credits/hard limit; Vercel on-demand; Cloudflare CPU limits | **Next** — per-project quotas, build concurrency caps, agent token budgets |
| Customer-facing status page | “Show my users uptime/incidents.” | **None of the three** (gap) | **Skip/Integrate** — Statuspage/Better Stack; not a platform moat |

### Cross-cutting recommendations for Skiff

1. **Ship the deploy lifecycle before runtime depth.** Draft vs published, per-deploy permalink, annotation/message, deploy hook, promote/rollback to any release, retention. This is where Skiff is closest to parity and where agents need deterministic verbs.
2. **Make previews private by default with a method × scope matrix.** Password/SSO/IP × preview-only/all, plus automation bypass tokens. This is the #1 evaluation blocker for agencies/enterprises.
3. **Treat secrets as a product, not env vars.** Write-only type, per-environment/branch scope, redaction, audit, MCP scope intersection (Skiff already enforces scopes ∩ role).
4. **Agent parity is the moat.** Tool catalog: projects, deployments, logs, env, domains, access, audit, analytics, rollback, promote. Add CIMD, `add-mcp`, agent skills, and a scoped “deploy preview” tool. Log every MCP call.
5. **Add a small global config/KV + scheduled jobs + image transforms** as the next platform primitives. They unlock real sites without a serverless runtime.
6. **Do not build:** a general WAF/bot engine, a full APM/tracing stack, a stats/experimentation engine, a customer status page, or a durable queue. Integrate or defer.
7. **Borrow Netlify’s metering philosophy:** previews/failed deploys free, production publishes metered; hard limits + auto-recharge. It aligns cost with value and makes preview-heavy agent workflows safe.

### Announcement/GA status watchlist (as of 2026-11-04)

| Item | Status | Source |
|---|---|---|
| Vercel Queues | **Public Beta**, all plans | [queues](https://vercel.com/docs/queues) |
| Vercel Large Functions (5 GB) | **Beta** | [limits](https://vercel.com/docs/functions/limitations) |
| Vercel 1,800 s function max duration | **Beta** | [limits](https://vercel.com/docs/functions/limitations) |
| Vercel Agent (chat, Code Review, Security Review, Investigations, Installation) | **Public Beta**, Pro/Enterprise | [agent](https://vercel.com/docs/agent) |
| Vercel Rolling Releases | GA (Pro/Enterprise) | [rolling releases](https://vercel.com/docs/rolling-releases) |
| Vercel Skew Protection | GA (Pro/Enterprise) | [skew protection](https://vercel.com/docs/skew-protection) |
| Netlify Split Testing | **Closed to new projects** 2026-08-26; existing only; never left Beta | [split testing](https://docs.netlify.com/manage/monitoring/split-testing/) |
| Netlify Agent Runners | Available on Credit-based plans; docs do not label Beta | [agent runners](https://docs.netlify.com/build/build-with-ai/agent-runners/overview/) |
| Netlify Blobs | **Beta** per credit-plan table | [credit plans](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/credit-based-pricing-plans/) |
| Netlify Reviewer SSO | **Beta**, Enterprise | [password protection](https://docs.netlify.com/manage/security/secure-access-to-sites/password-protection/) |
| Cloudflare Secrets Store | **Open Beta**, Workers + AI Gateway | [Secrets Store](https://developers.cloudflare.com/secrets-store/) |
| Cloudflare for SaaS | Bundled non-Enterprise; Enterprise add-on; eligible Enterprise preview as non-contract service | [Cloudflare for SaaS](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/) |
| Cloudflare Workers Logs pricing change | Announced: moves to Observability pricing **2026-12-01** | [pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| Cloudflare Workers Previews | Requires Wrangler ≥4.135.0; documented as available (no Beta label) | [previews](https://developers.cloudflare.com/workers/previews/) |

### Source-quality notes
- Vercel docs pages include explicit `last_updated` metadata (2026-07 to 2026-09), which is unusually reliable for “current state.” Netlify and Cloudflare pages include “Last updated” dates (2026-04 to 2026-11). Pricing pages are dynamic and were accessed 2026-11-04.
- Where a fact came from a changelog link embedded in a docs page (e.g. “Vercel MCP can now deploy code,” “7-day queue TTL,” “Cron 100/project”), the changelog itself was not fetched; treat the capability as documented but the exact date/limits as secondary.
- No vendor blog posts were used as primary evidence; a few search-result pages (Vercel CLI `--meta`, Netlify CLI `--alias`) were used only to confirm a docs behavior and are marked as such.
- Absence of a feature in fetched docs is not proof it doesn’t exist. The Gaps sections call out where a negative claim would be unsafe.
