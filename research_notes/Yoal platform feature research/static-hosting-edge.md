# Static Hosting and Edge/CDN Platforms — Feature Research for Yoal (November 2026)

*Method note: vendor facts in "Cited Findings" carry inline sources. "Inferences" are product/engineering proposals; where a proposal relies on a Caddy or vendor capability, the capability is cited in the section's Cited Findings and linked again only where the specific claim is easy to miss. Absence claims ("the docs do not document X") are limited to the pages actually reviewed and are repeated in Gaps.*

Scope: GitHub Pages, Firebase Hosting, Surge, Bunny.net, Fastly, AWS Amplify Hosting, and Cloudflare Pages. Vercel and Netlify are intentionally excluded. The objective is not a vendor ranking; it is a list of user-facing capabilities that make static delivery feel complete, with an implementation sketch that a single-node, Caddy + object-store platform can realistically ship.

## Deploy mechanics: atomic uploads, content addressing, git/CLI/API/drag-and-drop, hooks, pipelines, monorepos, rollback, retention

### Takeaway

Every mature platform converges on the same core model: an immutable version/release object plus a movable "live" pointer. Cloudflare Pages, Firebase Hosting, and Surge make rollback a near-instant pointer move; AWS Amplify makes rollback a redeploy of a previous build. Yoal's existing content-addressed releases are the right foundation. The missing "complete" pieces are git-driven builds, preview channels with expiry, a clear retention/GC policy, deploy hooks, and monorepo-aware build configuration.

### Cited Findings

- GitHub Pages publishes static HTML/CSS/JS from a repository branch, optionally running Jekyll; there are user/organization sites (one per account) and project sites (one per repository). — [GitHub Docs: What is GitHub Pages?](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)
- GitHub Pages limits: 1 GB published site size, a recommended 1 GB source repository, 10-minute deployment timeout, 100 GB/month soft bandwidth, and 10 builds/hour soft limit. The build limit does not apply when publishing with a custom GitHub Actions workflow; rate limiting can return HTTP 429. — [GitHub Docs: GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)
- GitHub Pages exposes a REST API to set the custom domain, `https_enforced`, build type (`legacy` or `workflow`), and source branch/path, plus a DNS health-check endpoint. — [GitHub REST API: Pages](https://docs.github.com/en/rest/pages/pages)
- Firebase Hosting has a permanent `live` channel plus optional preview channels. A preview URL looks like `SITE_ID--CHANNEL_ID-RANDOM_HASH.web.app`; preview channels are beta, default to a 7-day expiry, can be set up to 30 days, and the URL is public even though it contains a random hash. — [Firebase Docs: Manage live and preview channels](https://firebase.google.com/docs/hosting/manage-hosting-resources); [Firebase Docs: Test, preview, deploy](https://firebase.google.com/docs/hosting/test-preview-deploy)
- Firebase keeps prior releases for rollback. `retainedReleaseCount` is 1–100 and defaults to 10; rollback creates a new release that points at the same version as an earlier release, rather than mutating history. Preview channels do not support rollback. — [Firebase Docs: Manage live and preview channels](https://firebase.google.com/docs/hosting/manage-hosting-resources); [Firebase Hosting REST: sites.channels](https://firebase.google.com/docs/reference/hosting/rest/v1beta1/sites.channels)
- Firebase Hosting supports up to 36 sites per project and a maximum individual file size of 2 GB. — [Firebase Docs: Hosting FAQ](https://firebase.google.com/docs/hosting/faq-and-troubleshooting)
- Firebase Hosting storage is free to 10 GB, then $0.026/GB; data transfer is $0.15/GB beyond the allowance. The Hosting-specific page says 10 GB/month free transfer, while the main pricing table says 360 MB/day; these are not equivalent (~10.8 GB/month), and the discrepancy is worth flagging rather than reconciling silently. — [Firebase Docs: Hosting usage, quotas, pricing](https://firebase.google.com/docs/hosting/usage-quotas-pricing); [Firebase Pricing](https://firebase.google.com/pricing)
- Cloudflare Pages free plan: 500 builds/month, 1 concurrent build, 20-minute build timeout; Pro 5,000 builds/month and 5 concurrent; Business 20,000 and 20 concurrent. — [Cloudflare Docs: Pages limits](https://developers.cloudflare.com/pages/platform/limits/)
- Cloudflare Pages free plan supports 20,000 files per site; paid plans support 100,000 files with `PAGES_WRANGLER_MAJOR_VERSION=4`. Maximum single asset size is 25 MiB; larger files are directed to R2/public buckets. — [Cloudflare Docs: Pages limits](https://developers.cloudflare.com/pages/platform/limits/)
- Cloudflare Pages Direct Upload accepts a folder via Wrangler (20,000 files) or a zip/folder via drag-and-drop (1,000 files), 25 MiB per file. A Direct Upload project cannot later switch to Git integration; Git-integrated projects can use `wrangler deploy` but not dashboard drag-and-drop. — [Cloudflare Docs: Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/)
- Cloudflare Pages Git integration supports GitHub and GitLab only for automatic CI/CD; incremental builds are not supported; PRs from forks do not create previews. — [Cloudflare Docs: Pages known issues](https://developers.cloudflare.com/pages/platform/known-issues/)
- Cloudflare Pages rollback instantly reverts production to any successful production deployment; preview deployments are not valid rollback targets. The API is `POST /accounts/{account_id}/pages/projects/{project_name}/deployments/{deployment_id}/rollback`. — [Cloudflare Docs: Rollbacks](https://developers.cloudflare.com/pages/configuration/rollbacks/); [Cloudflare API: Roll back a Pages deployment](https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/deployments/methods/rollback/)
- Cloudflare Pages build configuration exposes build command, output directory, root directory (explicitly for monorepos), environment variables, and system variables such as `CF_PAGES_COMMIT_SHA`, `CF_PAGES_BRANCH`, and `CF_PAGES_URL`. — [Cloudflare Docs: Build configuration](https://developers.cloudflare.com/pages/configuration/build-configuration/)
- Surge is CLI-native and has no build service: the user builds locally/CI and publishes a directory. Publishing is cut over atomically, and the CLI waits until files have propagated to all ten regions. Every publish is a revision; the last 100 revisions are kept and instantly restorable. — [Surge](https://surge.sh/); [Surge Docs: Platform overview](https://surge.sh/docs/platform/)
- Surge limits: 450 MB and 10,100 files per project; publishing is rate-limited to 30 publishes per domain per 15 minutes and 200/day, or 60 per account per 15 minutes and 500/day. Hitting a limit pauses publishing, but already-published sites keep serving. There is no bandwidth billing. — [Surge Pricing](https://surge.sh/pricing)
- AWS Amplify Hosting connects a Git repository and builds/deploys on every push; each branch gets its own environment, PRs get preview URLs, and the service provisions SSL, manages custom domains, and handles cache invalidation automatically. — [AWS Amplify Docs: Amplify Hosting](https://docs.amplify.aws/javascript/deploy-and-host/amplify-hosting/)
- Amplify monorepos use an `applications` list in `amplify.yml` with an `appRoot` per app; it auto-detects npm/Yarn/Nx workspaces, while Turborepo and pnpm require additional `.npmrc` configuration (`node-linker=hoisted`). — [AWS Docs: Configuring monorepo build settings](https://docs.aws.amazon.com/amplify/latest/userguide/monorepo-configuration.html)
- Amplify manual deployments accept a drag-and-drop zip, an S3 object/prefix, or a public URL; the zip limit is 5 GB and manual deploys are not supported for SSR apps. — [AWS Docs: Deploying without a Git repository](https://docs.aws.amazon.com/amplify/latest/userguide/manual-deploys.html)
- Amplify does not document an instant rollback. A 2024 maintainer comment says "We do not support instant rollbacks"; AWS's August 2026 CLI walkthrough implements rollback by re-running `start-deployment` against a previous S3 prefix, i.e. a redeploy rather than a pointer flip. There are also reports of the console "Redeploy this version" action redeploying HEAD rather than the selected historical deployment. — [GitHub issue: Amplify rollback](https://github.com/aws-amplify/amplify-hosting/issues/542); [AWS builders.flash: Amplify Hosting CI/CD deploy and rollback (Aug 2026)](https://aws.amazon.com/jp/builders-flash/202608/amplify-hosting-cicd-deploy-rollback/); [GitHub issue: redeploy older deployment](https://github.com/aws-amplify/amplify-backend/issues/1464)

### Inferences

#### P0 — Formalise the release object and make promote/rollback a pointer move

**User problem.** A deploy that half-uploads, or a rollback that requires a rebuild, turns a small mistake into a long outage. Users also need to know exactly what is live and be able to return to any prior good state.

**Sketch.** Keep Yoal's content-addressed blob store, and add a first-class `release` record: `{id, site_id, manifest_hash, git_sha, branch, source, created_by, created_at, file_count, total_bytes, build_id, status, pinned, expires_at}`. Store the manifest (path → blob hash, content type, encoding variants, cache class) as an immutable object under `releases/<release_id>/manifest.json`. A release is `uploading → ready → live → superseded` (plus `failed`); rollback and promote only change the site's `live_release_id` and append an audit event. This mirrors Firebase's model, where a rollback creates a new release pointing at an old version rather than rewriting history.

For the data plane, a symlink `sites/<site>/current -> releases/<release_id>` swapped with `rename(2)` is atomic on a single node and needs no Caddy reload; point Caddy's `root` at `current`. For multi-node, write the pointer to Postgres and have each Caddy agent compare a version counter and reload via Caddy's admin API. Caddy supports zero-downtime graceful reloads and a config API ([Caddy Features](https://caddyserver.com/features)), so the reload is safe; the symlink path is simpler and faster for the single-node case. Keep the old release directory until GC so in-flight requests and range downloads do not break.

#### P0 — Rollback/promote UX with append-only audit

**User problem.** "Rollback" is often hidden in a provider console and leaves no record of who did it or why.

**Sketch.** `yoal releases`, `yoal promote <id>`, `yoal rollback [--to <id>]`, and a dashboard release timeline. Each action records actor, source (UI/CLI/API), previous and new release, timestamp, and optional reason. Show a diff summary (files added/removed/changed, config changes, size delta) before promoting. Add one-click "redeploy this release" for parity with providers that only support rebuild-based rollback. Auto-rollback can reuse the same pointer move after a failed health check (see Ops).

#### P0 — Retention, pinning, and garbage collection

**User problem.** Immutable releases plus previews grow storage without bound; deleting the wrong release breaks rollback or an active share link.

**Sketch.** Per-site retention policy: keep the live release, pinned releases, the last N releases (default 10, configurable 1–100, matching Firebase's range), and releases newer than X days. Mark releases referenced by an active preview/share link as pinned automatically. GC is a mark-and-sweep over manifests: delete blobs with no referencing manifest, then delete manifests/releases. Run GC asynchronously with a 24-hour grace period; show "reclaimable storage" in the dashboard before deletion. Never GC the live release or a release with an in-flight deployment.

#### P0 — Preview channels with expiry, branch aliases, and immutable URLs

**User problem.** Reviewers need a URL for a branch or commit without touching production, and old previews should disappear on their own.

**Sketch.** Every non-production deployment gets `https://<deployment-id>.<site>.preview.<domain>` (immutable) and a mutable branch alias `https://<branch>--<site>.preview.<domain>`. Lowercase and hyphenate branch names, as Cloudflare does. Default expiry 7 days, maximum 30, configurable via `yoal deploy --preview --expires 7d`; redeploying to an existing preview extends it. Preview channels are not valid rollback targets. Add `X-Robots-Tag: noindex` by default and protect previews with platform auth by default (see Access). Use a wildcard certificate for the preview domain rather than per-preview certs.

#### P0 — CLI, API, and drag-and-drop with missing-blob negotiation

**User problem.** Uploading a 20,000-file site repeatedly wastes time and bandwidth; CI needs a non-interactive, scoped credential.

**Sketch.** `yoal deploy ./dist --site <site> [--preview]` computes a manifest of `(path, size, sha256, content-type)` and sends it first. The control plane replies with the list of blobs it already has; the CLI uploads only missing blobs, then finalises the release. This is the same content-addressed dedupe pattern implied by immutable release stores, and it makes repeated deploys fast. Add `POST /v1/sites/:id/deployments` for a zip/tar stream and a dashboard drag-and-drop that accepts a zip (cap at 1,000 files for drag-and-drop, 20,000 for CLI, 25 MiB/file — Cloudflare's numbers are a sensible baseline). Use scoped deploy tokens (`site:deploy`, optional branch restriction, expiry, last-used IP), and make tokens revocable. Enforce zip-slip protection, symlink rejection, path length/name limits, and a per-site total-size cap.

#### P0 — Git builds: repo connection, build worker, framework presets, build logs

**User problem.** Users expect `git push` to deploy, not a local build plus manual upload.

**Sketch.** A GitHub App (then GitLab/Bitbucket) sends push/PR webhooks. The control plane enqueues a build with `{repo, ref, commit, site, environment}`. A single-node agent worker clones the repo into a sandboxed build directory (Docker container with CPU/memory/disk/time limits, no host network by default), runs install/build from `yoal.json`, and uploads the output directory as a new release. Stream logs to the dashboard and retain them per build. Support cancel, retry, and a 20-minute timeout (Cloudflare's limit). Detect the framework from lockfiles/config and provide presets for Vite, Astro, Next static export, Nuxt, SvelteKit, Hugo, Eleventy, Jekyll, and plain HTML. Build only one or a small number concurrently on a single node; expose queue position. Inject `YOAL_COMMIT_SHA`, `YOAL_BRANCH`, `YOAL_URL`, and `CI=true`, mirroring Cloudflare's system variables.

#### P0 — Monorepo configuration and selective builds

**User problem.** A monorepo push rebuilds every app, and the build fails because the command runs from the repo root.

**Sketch.** `yoal.json` gets `build.root` (app root), `build.command`, `build.output`, `build.install`, `build.node`, and `build.env`. Resolve all paths relative to `root`; run install/build there. Add `build.watch`/`ignore` globs so a push only builds apps whose files changed (Amplify advertises selective triggers; Cloudflare exposes a root directory). Store a per-app build cache keyed by lockfile hash plus Node version; mount it read-only or copy it into the sandbox. For pnpm/Turborepo, document `node-linker=hoisted` and install pnpm in the pre-build step, as Amplify does.

#### P1 — Deploy hooks and events

**User problem.** Teams need to purge a CDN, notify Slack, run a smoke test, or trigger a downstream job after a deploy — without polling.

**Sketch.** Incoming build hook: `POST /v1/hooks/build/<secret>` triggers a build of a named site/branch. Outgoing webhooks on `deployment.started`, `deployment.ready`, `deployment.promoted`, `deployment.failed`, `deployment.rolled_back`; sign with HMAC-SHA256, include event ID and timestamp, retry with exponential backoff, and expose delivery logs. A "post-deploy command" is tempting but unsafe on a shared node; prefer webhooks plus a small allowlisted set of built-in actions (purge CDN, run HTTP smoke tests).

#### P1 — Direct S3/URL import and migration helpers

**User problem.** Teams migrating from Amplify/S3 have artifacts in a bucket or behind a URL and do not want to rebuild locally.

**Sketch.** `yoal deploy --from-s3 s3://bucket/prefix` and `--from-url https://.../site.zip` (signed URL), streamed into the same manifest/upload path. This is table stakes for migrations, but lower priority than git and CLI because it is mostly a one-time operation.

#### P1 — Release metadata and build provenance

**User problem.** When something breaks, "which commit and which build produced this?" is the first question.

**Sketch.** Attach git commit, ref, repo URL, build ID, builder version, lockfile hash, and a signed manifest digest to every release. Show them in the release detail and expose via API. This also enables reproducible builds and supply-chain checks later.

#### P2 — Canary/percentage deploys

**User problem.** Some teams want 5% of traffic on a new release before full promotion.

**Sketch.** A Caddy `map` on a stable visitor cookie or a hash of client IP can select between two release roots; assign the cookie at the edge on first HTML response. This is doable for static HTML but awkward for assets that must stay consistent with the HTML. Start with "promote after preview smoke test" and "instant rollback"; add percentage canaries only if customers ask.

#### Platform snapshot (for synthesis)

| Platform | Deploy inputs | Preview model | Rollback model | Config surface | Notable limits | Source |
|---|---|---|---|---|---|---|
| GitHub Pages | Git branch or Actions | None native (use another host) | Git revert/redeploy | Jekyll config, `CNAME`, `404.html` | 1 GB site, 100 GB/mo soft, 10 builds/hr soft, 10-min deploy | [GH limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits), [GH Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages) |
| Firebase Hosting | CLI, GitHub Action, REST | Preview channels, 7d default/30d max, public URL | New release pointing at old version | `firebase.json` | 2 GB/file, 36 sites/project, 10 GB storage free | [Firebase channels](https://firebase.google.com/docs/hosting/manage-hosting-resources), [Firebase FAQ](https://firebase.google.com/docs/hosting/faq-and-troubleshooting) |
| Surge | CLI only, no build | Each publish is a revision; no branch previews | Last 100 revisions, instant | `CNAME`, `200.html`, `404.html`, `ROUTER`, `AUTH`, `CORS` | 450 MB/10,100 files, publish rate limits | [Surge](https://surge.sh/), [Surge pricing](https://surge.sh/pricing) |
| Cloudflare Pages | Git (GitHub/GitLab), Wrangler, drag-drop | Per-branch hash URL + branch alias, unlimited, public by default | Instant pointer to any successful production deploy | `_redirects`, `_headers`, build config | 500 builds/mo free, 20k files free, 25 MiB/file | [CF limits](https://developers.cloudflare.com/pages/platform/limits/), [CF rollbacks](https://developers.cloudflare.com/pages/configuration/rollbacks/) |
| AWS Amplify Hosting | Git, drag-drop zip, S3, URL | Branch environments + PR previews | Redeploy previous build (not instant) | `amplify.yml`, `customHttp.yml`, redirect rules | 5 GB manual zip, build container limits | [Amplify hosting](https://docs.amplify.aws/javascript/deploy-and-host/amplify-hosting/), [manual deploys](https://docs.aws.amazon.com/amplify/latest/userguide/manual-deploys.html) |
| Bunny/Fastly/Cloudflare CDN | N/A (pull zone/origin) | N/A | N/A | Edge rules/VCL/Workers | Purge rate limits, cache rules | [Bunny purge](https://bunny.net/docs/cdn/purge-cache), [Fastly purge](https://www.fastly.com/documentation/guides/full-site-delivery/purging/getting-started-with-purging/) |

#### Recommended build order

1. **Release model:** immutable release + manifest + live pointer, promote/rollback, retention/pinning/GC, audit. This underpins every other feature.
2. **Deploy inputs:** CLI/API/drag-and-drop with missing-blob negotiation and scoped tokens; then git builds, preview channels, monorepo roots, and build logs.
3. **Config compiler:** `yoal.json` + `_redirects` + `_headers` → Caddy routes; 404/SPA/clean URLs/trailing slashes; dry-run and route diff.
4. **Access:** versioned `AUTH`-style policy, basic auth, platform auth via `forward_auth`, previews protected by default, signed share links.
5. **Delivery:** custom domains/on-demand TLS, HTTP/3 verification, precompression, cache policy, range/large files, CDN integration and purge hooks.
6. **Ops:** per-site metering from logs, cost alarms, cache-hit-ratio definitions, log search/retention, health checks, auto-rollback, standby replication.
7. **Enhancements:** image variants/transform service, fonts, forms, privacy analytics, search; defer edge functions/A-B/WAF to CDN integrations.

### Gaps

- GitHub Pages has no first-class release retention, preview channels, or instant rollback; rollback is a git revert/redeploy. Its docs also do not expose a `_headers`/`_redirects` equivalent.
- Firebase's free transfer allowance is contradictory across official pages (10 GB/month vs 360 MB/day). Do not present a single reconciled number without checking a live project.
- Amplify's current console rollback behaviour is ambiguous: AWS documents redeploying a previous build, a 2024 maintainer says instant rollback is unsupported, and users report the console reselecting HEAD. Treat "instant rollback" as unproven for Amplify.
- No vendor publishes the internal blob-dedupe/manifest protocol, so the missing-blob negotiation sketch is an inference from content-addressed storage, not a documented API.

## Delivery: custom domains and TLS, apex/www, wildcard, HTTP/2/3, Brotli, cache invalidation/rules, geographic distribution, signed URLs, range requests, large files, precompression

### Takeaway

The table stakes are automatic TLS on customer domains (including apex), HTTP/2 and HTTP/3, Brotli, immutable caching for hashed assets, correct range/conditional requests, and a purge path for the few mutable URLs. A single-node Yoal can match all of these with Caddy. It cannot honestly match global anycast; the polished move is to make "bring your own CDN" a first-class, documented integration rather than pretending a single node is a global edge network.

### Cited Findings

- Caddy enables HTTPS automatically for all sites, redirects HTTP to HTTPS, obtains and renews certificates, and supports on-demand TLS for customer domains. On-demand TLS must be restricted with an `ask` endpoint so Caddy can check whether a domain is allowed before issuing a certificate. — [Caddy Docs: Automatic HTTPS](https://caddyserver.com/docs/automatic-https)
- Caddy can obtain wildcard certificates, but wildcard issuance requires the DNS challenge (and a DNS provider module). — [Caddy Docs: Automatic HTTPS — Wildcard certificates](https://caddyserver.com/docs/automatic-https)
- Caddy supports HTTP/1.1, HTTP/2, H2C, and HTTP/3, enabled by default (H2C excepted); TLS 1.2/1.3; zero-downtime graceful reloads; and a configuration API. — [Caddy Features](https://caddyserver.com/features)
- Caddy's static file server supports precompressed Brotli, Zstandard, and Gzip sidecar files, ETag/Last-Modified/If-None-Match/If-Modified-Since/If-Range, Range requests, canonical path redirects, custom error routes, and `sendfile` acceleration. — [Caddy Features — Static file server](https://caddyserver.com/features); [Caddy Docs: file_server](https://caddyserver.com/docs/caddyfile/directives/file_server)
- Caddy's `file_server` `precompressed` option searches for `.br`, `.zst`, and `.gz` sidecars after confirming the uncompressed file exists, and sets `Content-Encoding`; if `encode` is enabled it can compress on the fly when no sidecar exists. — [Caddy Docs: file_server](https://caddyserver.com/docs/caddyfile/directives/file_server)
- Caddy has an optional cache module with tag-based purge and local/distributed storage, and optional image filtering (crop/fit/flip/resize/rotate/sharpen). Its `encode` handler supports Gzip, Zstandard, and Brotli. — [Caddy Features](https://caddyserver.com/features)
- Firebase Hosting serves from a global CDN, includes SSL, and serves gzip or Brotli based on the client's capabilities. — [Firebase Hosting product page](https://firebase.google.com/products/hosting)
- GitHub Pages supports HTTPS for all sites, including custom domains, and an "Enforce HTTPS" setting that 301-redirects HTTP. Certificates are requested from Let's Encrypt after DNS validation. — [GitHub Docs: Securing your GitHub Pages site with HTTPS](https://docs.github.com/en/pages/getting-started-with-github-pages/securing-your-github-pages-site-with-https)
- Surge serves from ten regions, provisions managed certificates for custom domains, issues a single wildcard certificate for domains delegated to its name servers, and automatically folds `www` into the root (or vice versa). It applies gzip, ETags, and far-future caching automatically. — [Surge Docs: Custom domains](https://surge.sh/docs/platform/custom-domains); [Surge Docs: Platform overview](https://surge.sh/docs/platform/)
- Cloudflare Pages sites are served from Cloudflare's global network; custom-domain limits are 100 per project on Free, 250 on Pro, and 500 on Business. — [Cloudflare Docs: Pages overview](https://developers.cloudflare.com/pages/); [Cloudflare Docs: Pages limits](https://developers.cloudflare.com/pages/platform/limits/)
- Fastly's network has 16 listed POPs, 622 Tbps of connected capacity (as of 30 June 2026), sub-millisecond p99 TTFB, and <150 ms mean purge time (as of 31 December 2025). It supports HTTP/1.1, HTTP/2, HTTP/3, QUIC, and TLS 1.3. — [Fastly Network Map](https://www.fastly.com/network-map); [Fastly Docs: Using the global POP network](https://www.fastly.com/documentation/guides/getting-started/concepts/using-fastlys-global-pop-network/)
- Fastly supports static compression (pre-cache, VCL only) and dynamic compression (post-cache) with Gzip and Brotli; static compression is billed on compressed size, dynamic on uncompressed size. — [Fastly Docs: Delivering compressed content](https://www.fastly.com/documentation/guides/concepts/compression/)
- Fastly's Instant Purge supports URL, surrogate-key, and purge-all. Soft purge marks objects stale rather than making them inaccessible; purge-all is always hard. Up to 256 surrogate keys can be purged per batch, and distinct surrogate-key/URL purges are limited to an average of 100,000/hour per customer. — [Fastly Docs: Getting started with purging](https://www.fastly.com/documentation/guides/full-site-delivery/purging/getting-started-with-purging/); [Fastly API: Purging](https://www.fastly.com/documentation/reference/api/purging/)
- Fastly surrogate keys are case-sensitive, limited to 1 KB per key and 16 KB per `Surrogate-Key` header, and are stripped before delivery to end users. — [Fastly Docs: Working with surrogate keys](https://www.fastly.com/documentation/guides/full-site-delivery/purging/working-with-surrogate-keys)
- Bunny CDN has 100+ points of presence, origin shield, edge rules, token authentication, perma-cache, WebSocket support, and logging/analytics. — [Bunny Docs: Bunny CDN](https://bunny.net/docs/cdn)
- Bunny purge supports full pull-zone purge, tag purge via the `CDN-Tag` header (1024-byte limit), and URL exact/prefix purge. Default rate limits are roughly 300 exact purges/minute (120 burst, 5/s refill) and 30 prefix purges/minute (20 burst, 0.5/s refill); purging a large zone temporarily increases origin load. — [Bunny Docs: Purge Cache](https://bunny.net/docs/cdn/purge-cache)
- Bunny Edge Rules can force SSL, redirect, change origin, override cache time, block requests, set request/response headers, force download, toggle token authentication, override browser cache time, set network rate limits, and enable/disable request coalescing. — [Bunny Docs: Edge Rules](https://bunny.net/docs/cdn/edge-rules)
- Bunny Smart Cache only caches known static file extensions by default and never caches `text/html`, `application/json`, or `application/xml` unless an Edge Rule overrides it. Bunny describes >95% cache hit rate as healthy and <70% as usually a configuration problem. — [Bunny Docs: Smart Cache](https://bunny.net/docs/cdn/smart-cache)
- Bunny Dynamic Images transforms images via query parameters (width, height, crop, aspect ratio, face crop, format, quality, blur/sharpen, colour adjustments), processes each transformation once, and caches the result at the edge while preserving the original. — [Bunny Docs: Dynamic Images](https://bunny.net/docs/optimizer/dynamic-images/overview)
- Fastly Image Optimizer automatically optimizes JPEG/Progressive JPEG/WebP at quality 85, strips metadata, applies orientation, supports resize/crop/format/blur/brightness/contrast parameters, caches each variant, and enforces a 60-second minimum TTL on transformed images for services created on/after 2 May 2023. Purging the original purges all variants; a single variant cannot be purged. — [Fastly Docs: Image Optimizer reference](https://www.fastly.com/documentation/reference/io/)
- Fastly HTTP/3 is client-side only, requires TLS 1.3, and warns that 0-RTT early data makes client IP authenticity uncertain for ACLs; the mitigation is to return `425 Too Early` when `Early-Data: 1` matches an ACL. — [Fastly Docs: Enabling HTTP/3](https://www.fastly.com/documentation/guides/full-site-delivery/performance/enabling-http3-for-fastly-services/)
- AWS Amplify Hosting provisions SSL certificates, manages custom domains, and handles cache invalidation automatically. — [AWS Amplify Docs: Amplify Hosting](https://docs.amplify.aws/javascript/deploy-and-host/amplify-hosting/)

### Inferences

#### P0 — One-click custom domains with on-demand TLS and explicit DNS states

**User problem.** Pointing a domain at a host is still the most common setup failure: apex vs `www`, missing AAAA, proxy-in-front TLS, or a certificate that never issues.

**Sketch.** A domain onboarding flow: user enters `example.com` or `www.example.com`; control plane creates a verification token (`_yoal.example.com TXT`) and shows exact DNS records (A/AAAA for apex, CNAME for subdomain). Caddy is configured with `on_demand_tls { ask http://127.0.0.1:8081/internal/tls/ask }`; the ask endpoint validates that the domain is attached to a site, the verification TXT is present, and the domain is not over a per-account cert quota. Caddy then obtains the cert via HTTP-01 or TLS-ALPN-01 on first handshake. Surface states `pending_dns → verifying → issuing → active → error`, with the last error and a "recheck" button; auto-renew and show certificate expiry. This is exactly the use case Caddy's on-demand TLS documents (customer domains not known at config load).

For apex, require A/AAAA; for `www`, CNAME to the site's edge hostname. Offer a canonical-host choice (`apex` or `www`) and generate a 301 for the other, as Surge does automatically. Add HSTS only after the cert is active and all subdomains are HTTPS-ready; HSTS preload should be an explicit, warned opt-in.

Wildcard customer domains need DNS-01 and a provider integration; either support a curated set of DNS providers (Cloudflare, Route 53, etc.) or accept a user-uploaded certificate/key for wildcard. For Yoal's own preview domain, use a single wildcard cert (`*.preview.yoal.example`) so previews do not consume ACME rate limits. Caddy's docs note wildcard issuance requires DNS-01 ([Caddy Docs: Automatic HTTPS](https://caddyserver.com/docs/automatic-https)), so this is a real constraint, not a config detail.

#### P0 — HTTP/3 and HTTP/2 without a separate switch

**User problem.** Mobile and lossy-network users get better tail latency from QUIC, and users expect modern protocol support without tuning.

**Sketch.** Caddy enables HTTP/1.1, HTTP/2, and HTTP/3 by default; ensure UDP/443 is open and the host firewall allows it, and verify `Alt-Svc` in responses. Add protocol to the status page and to synthetic checks. For protected routes, handle the 0-RTT/ACL issue the way Fastly documents: if `Early-Data: 1` and the route has an IP allowlist or auth decision that depends on the client IP, return `425 Too Early` or disable 0-RTT for that route. Do not advertise HTTP/3 in environments where UDP is blocked; fall back cleanly.

#### P0 — Precompression pipeline with correct negotiation

**User problem.** Brotli at build time is much cheaper than compressing every request, but mis-negotiated `Content-Encoding`, stale ETags, and double-compressing images cause broken or slower sites.

**Sketch.** Yoal already produces `.br`/`.gz`; extend to `.zst` and make it universal:

- At upload/build finalisation, detect compressible MIME types (`text/*`, `application/javascript`, `application/json`, `application/xml`, `image/svg+xml`, fonts except `woff2`), skip files below ~1 KB and already-compressed formats (`woff2`, `avif`, `webp`, `png`, `jpg`, `mp4`, `zip`, `gz`, `br`, `zst`).
- Generate `.br` at quality 11 and `.gz` at level 9 as separate content-addressed blobs; record encodings in the manifest. Do not overwrite the original.
- Caddy: `file_server { precompressed br zstd gzip }`; add `encode zstd gzip` as fallback for dynamic/HTML responses. Caddy's docs confirm it checks the uncompressed file first, then the sidecars, and sets `Content-Encoding` ([Caddy Docs: file_server](https://caddyserver.com/docs/caddyfile/directives/file_server)).
- Set `Vary: Accept-Encoding` on negotiated responses; use a weak ETag or a variant-specific ETag so a gzip response does not validate a br response. Ensure `Content-Length` matches the encoded body.
- Report bytes saved per site ("Brotli saved 62% of text bytes") — this is a satisfying, visible polish feature.

Avoid compressing HTML that is already tiny or streaming; avoid compressing range responses (range + content-encoding is a compatibility trap). If a client sends `Range` and `Accept-Encoding: br`, either serve identity or handle the range on the encoded representation correctly.

#### P0 — Cache policy: immutable assets, revalidated HTML, purge only the mutable surface

**User problem.** Users see stale HTML after a deploy, or the CDN serves an old asset because a filename was reused. Conversely, purging everything on every deploy creates origin stampedes.

**Sketch.** Default policy:

- Hashed/immutable assets (`/assets/*`, fingerprinted names): `Cache-Control: public, max-age=31536000, immutable`.
- HTML: `Cache-Control: public, max-age=0, must-revalidate` plus strong `ETag`; optionally `stale-while-revalidate=60` at the CDN.
- 404: `public, max-age=300`; redirects: `public, max-age=3600`.
- User overrides via `_headers` or `yoal.json`, but show a warning if they set `immutable` on non-hashed paths or `no-store` on shared assets.

Because releases are content-addressed, assets need no purge; only the HTML/alias pointer changes. If Yoal is behind a CDN, expose `POST /v1/sites/:id/purge` with `{paths, tags, all}`. Tag every response with `Cache-Tag: site-<id>,release-<id>` (or `Surrogate-Key` for Fastly, `CDN-Tag` for Bunny). Prefer soft purge where supported (Fastly) to avoid a thundering herd; rate-limit purge requests and return the provider's request ID. For a local Caddy cache plugin, purge by tag; for no cache plugin, a deploy is already a new root, so only HTML needs a short TTL.

#### P0 — Range requests, conditional requests, and large-file escape hatch

**User problem.** Video, audio, PDFs, datasets, and resumable downloads need byte ranges; a 25 MiB per-file cap silently blocks legitimate use.

**Sketch.** Caddy's file server already supports `Range`, `If-Range`, ETag, and `Last-Modified` ([Caddy Features](https://caddyserver.com/features)), so keep it in the path and do not buffer responses. For local disk, `sendfile` is used; for a remote object store, `reverse_proxy` streams and should not buffer. Add `Accept-Ranges: bytes` explicitly and test `206 Partial Content`, multi-range, and resume.

Set a default per-file cap (25 MiB matches Cloudflare Pages) and a higher plan cap (2 GB matches Firebase). Files above the cap go to a `downloads` bucket served by a dedicated hostname or via a short-lived presigned URL; do not proxy multi-GB files through the control plane. Add resumable uploads (tus or S3 multipart) for the CLI, checksum verification, and `Content-Disposition` for downloads. Large-file bandwidth should be metered but not counted against the static-site HTML budget in a way that surprises users.

#### P1 — Bring-your-own-CDN integration instead of pretending to be global

**User problem.** A single origin in one region gives poor TTFB to distant users, and a single node is a availability risk. Building a global anycast network is not realistic.

**Sketch.** Ship a "CDN" panel with provider presets:

- **Bunny:** create a pull zone with origin `origin.<site>.yoal.example`, enable origin shield, set cache rules, token auth for private content, and a purge API key. Yoal writes `Cache-Tag`/`CDN-Tag` headers and calls Bunny's purge endpoint on promote.
- **Cloudflare:** CNAME `cdn.customer.com` to the Yoal origin through Cloudflare, cache rules for HTML vs assets, and purge-by-tag/URL via API. Use Cloudflare Access for previews if the customer already has it.
- **Fastly:** configure the Yoal origin as a backend, enable shielding, set `Surrogate-Key`, use soft purge on promote, and optionally enable Image Optimizer/Compute.

Require a shared secret header (`X-Yoal-Origin-Auth`) and/or mTLS on the origin so the CDN cannot be bypassed; restrict direct origin access by IP where the provider publishes ranges. Expose cache status (`X-Cache`, `CF-Cache-Status`, `Fastly-Cache-Status`, `Bunny-Cache-Status`) in logs and the dashboard. This turns "geographic distribution" into a supported integration rather than a missing core feature.

#### P1 — Signed URLs and share links at the edge

**User problem.** Private downloads, gated reports, and client previews need time-limited access without making the whole bucket public or putting the origin behind per-byte auth.

**Sketch.** Two mechanisms:

1. **Yoal-native HMAC token:** `?token=<base64url(payload)>.<sig>` where payload includes `site`, `release`, `path_prefix`, `exp`, optional `ip`, `method`, and `max_downloads`. Caddy `forward_auth` to the control plane validates and returns 2xx plus `X-Yoal-Share-Id` ([Caddy Docs: forward_auth](https://caddyserver.com/docs/caddyfile/directives/forward_auth)); Caddy then serves the file. Token in the path (`/s/<token>/...`) makes relative assets work. Keep TTL short (5–15 minutes), rate-limit validation, and audit each use.
2. **Object-store presigned URL:** for large files or when the object store is S3/R2, the control plane returns a 302 to a presigned GET with a short TTL. This avoids streaming bytes through the control plane and works with range requests.

For CDN-fronted sites, use the provider's token auth (Bunny's signed URLs/path tokens, Fastly surrogate keys + ACL, Cloudflare signed URLs/Workers). Never rely on an unguessable path alone; log and revoke tokens.

#### P1 — Safe security-header defaults

**User problem.** Most static sites ship without HSTS, `nosniff`, a referrer policy, or a frame policy; users should not have to remember every header.

**Sketch.** Apply defaults via Caddy `header`:

- `Strict-Transport-Security: max-age=31536000; includeSubDomains` (add `preload` only after explicit confirmation).
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `X-Frame-Options: SAMEORIGIN` (or `frame-ancestors 'self'` via CSP)
- `Permissions-Policy: camera=(), microphone=(), geolocation=()`
- `Cross-Origin-Opener-Policy: same-origin` only where it will not break OAuth popups.
- Remove `Server` and `X-Powered-By`.

Do not ship a default CSP; it breaks too many sites. Offer a report-only CSP template and a "security headers" score in the dashboard. Let `_headers` override, but warn when a user removes HSTS or sets `Access-Control-Allow-Origin: *` on authenticated content. For previews, always add `X-Robots-Tag: noindex`.

#### P2 — Early Hints / preload hints

**User problem.** Slow HTML TTFB leaves the browser idle instead of fetching critical CSS/fonts.

**Sketch.** Caddy does not expose 103 Early Hints as a first-class directive in the docs reviewed; a plugin or a small handler could emit `Link: </assets/app.css>; rel=preload` before the body. Lower priority than correct caching and precompression; start by letting `_headers` set `Link` preload headers, which is portable and works with HTTP/2/3.

### Gaps

- Cloudflare Pages' exact Brotli/HTTP/3 behaviour is not documented on the Pages pages reviewed; it is a platform-level Cloudflare CDN feature, so verify before claiming parity.
- GitHub Pages' CDN provider and POP count are not documented in the Pages docs reviewed.
- No vendor documents how it handles `Range` + `Content-Encoding` interactions; test this explicitly in Yoal rather than assuming.
- Pricing for Bunny Optimizer, Fastly IO, and Cloudflare image resizing was not fetched; treat image-optimization cost comparisons as incomplete.

## Site config: redirects, headers, rewrites, 404 fallbacks, SPA routing, clean URLs, trailing slashes, custom error pages, security-header defaults

### Takeaway

The winning pattern is a small, versioned config that travels with the release: Firebase's `firebase.json`, Cloudflare's `_redirects`/`_headers`, Surge's `ROUTER`/`AUTH`, Amplify's redirect rules and `customHttp.yml`. Yoal should compile `yoal.json` + `_redirects` + `_headers` into Caddy routes at deploy time, validate strictly, and show a preview of the compiled routing table. The highest-polish details are correct precedence, no soft-404s for missing assets, and deterministic clean-URL/trailing-slash behaviour.

### Cited Findings

- Firebase Hosting response priority is: reserved `/__/*` namespaces → configured redirects → exact-match static content → configured rewrites → custom 404 → default 404. Within `redirects` and `rewrites`, the first matching rule wins, so order matters. — [Firebase Docs: Full Hosting configuration](https://firebase.google.com/docs/hosting/full-config)
- Firebase redirects support glob or RE2 regex sources, 301/302 status, and captured segments (`:post`, `:id`, regex groups). Rewrites only apply when no file/directory exists at the source path, and can target a local file, a Cloud Function, or a Cloud Run container. — [Firebase Docs: Full Hosting configuration](https://firebase.google.com/docs/hosting/full-config)
- Firebase supports `cleanUrls` (301-strips `.html`) and `trailingSlash` (`true` adds, `false` removes; unset uses directory index behaviour). It serves a custom `404.html` and supports i18n rewrites based on language/country. — [Firebase Docs: Full Hosting configuration](https://firebase.google.com/docs/hosting/full-config)
- Firebase custom headers are matched before rewrites; matching rules apply in definition order; `Strict-Transport-Security` is overwritten on default `*.web.app` subdomains but honoured on custom domains. — [Firebase Docs: Full Hosting configuration](https://firebase.google.com/docs/hosting/full-config)
- Cloudflare Pages `_redirects`: maximum 2,000 static + 100 dynamic redirects (2,100 total), 1,000 characters per declaration; supports 301/302/303/307/308, splats, placeholders, and 200 proxying; does not support query-parameter matching, country, or cookie conditions; redirects execute before headers. — [Cloudflare Docs: Redirects](https://developers.cloudflare.com/pages/configuration/redirects/)
- Cloudflare Pages `_headers`: maximum 100 header rules, 2,000 characters per line; headers can be attached, detached with `!`, and multiple matching rules are inherited; redirects take precedence over headers. — [Cloudflare Docs: Headers](https://developers.cloudflare.com/pages/configuration/headers/)
- AWS Amplify redirects support 301, 302, 200 rewrite, and 404; rules apply top-down; query parameters are forwarded for 301/302 except when the source pins a query value or the destination includes query parameters. — [AWS Docs: Setting up redirects and rewrites](https://docs.aws.amazon.com/amplify/latest/userguide/redirects.html)
- Amplify custom headers are configured in `customHttp.yml` (or the console); the old buildspec/`amplify.yml` method is deprecated and should be migrated. — [AWS Docs: Setting custom headers](https://docs.aws.amazon.com/amplify/latest/userguide/custom-headers.html)
- Surge's project directory is the configuration: `CNAME` (domain), `.surgeignore`, `200.html` (SPA shell for unmatched paths), `404.html` (custom not-found), `ROUTER` (redirects), `AUTH` (password/protected paths), `CORS` (cross-origin). Control files are never served, and because they travel with each publish, rolling back the code rolls back the behaviour. — [Surge Docs: Platform overview](https://surge.sh/docs/platform/)
- Surge provides clean URLs automatically (`/about` serves `about.html`), canonical redirects, and folds `www` into the root domain. — [Surge Docs: Platform overview](https://surge.sh/docs/platform/); [Surge Docs: Custom domains](https://surge.sh/docs/platform/custom-domains)
- GitHub Pages supports a custom `404.html` page, but the Pages docs reviewed do not expose a `_headers`/`_redirects`-style configuration surface. — [GitHub Pages documentation index](https://docs.github.com/en/pages); [GitHub Docs: What is GitHub Pages?](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)
- Caddy's `try_files` rewrites to the first listed file that exists, supports a `=404` fallback, and can match directories with a trailing slash. `file_server` enforces canonical URIs by default (adds trailing slash for directories, removes it for files) and invokes error routes for 404/403. `handle_errors` defines custom error routes. — [Caddy Docs: try_files](https://caddyserver.com/docs/caddyfile/directives/try_files); [Caddy Docs: file_server](https://caddyserver.com/docs/caddyfile/directives/file_server)

### Inferences

#### P0 — A single `yoal.json` that compiles to Caddy, with strict validation

**User problem.** Users do not want to learn Caddyfile syntax, and a typo in routing config should fail the deploy, not produce a subtly broken site.

**Sketch.** Define a versioned JSON Schema:

```json
{
  "version": 1,
  "build": { "root": ".", "install": "npm ci", "command": "npm run build", "output": "dist", "node": "22" },
  "routing": {
    "cleanUrls": true,
    "trailingSlash": "never",
    "spa": false,
    "fallback": "200.html",
    "errorPage": "404.html"
  },
  "redirects": [{ "from": "/old", "to": "/new", "status": 301 }],
  "rewrites": [{ "from": "/api/*", "to": "https://api.example.com/:splat", "status": 200 }],
  "headers": [{ "path": "/*", "set": { "X-Frame-Options": "DENY" } }],
  "cache": { "html": "revalidate", "assets": "immutable" },
  "previews": { "expire": "7d", "noindex": true }
}
```

Validate on deploy, reject unknown top-level keys (warn on unknown leaf keys), and include the resolved config in the release manifest so a rollback restores routing too. Compile to Caddy JSON routes rather than string-concatenated Caddyfile; use the admin API/`caddy reload` and keep the previous config for instant revert. Provide `yoal deploy --dry-run` that prints the compiled matchers, precedence, and warnings.

#### P0 — `_redirects` parser with precedence, splats, and loop detection

**User problem.** Migrations and URL changes need redirects, but hand-written rules commonly shadow each other or create loops.

**Sketch.** Parse one rule per line: `from to [status]`, default 302, comments `#`, blank lines ignored. Support `*` splat and `:name` placeholders; preserve query strings unless the destination has its own; allow absolute external destinations; allow `200` only for allowlisted upstreams (proxy/rewrite). Cap at 2,000 static + 100 dynamic, 1,000 chars per rule (Cloudflare parity). Compile in file order, because first match wins in both Firebase and Cloudflare. Run static analysis: unreachable rule (shadowed by an earlier pattern), redirect chain > 5, loop, invalid status, external destination without `https`, and placeholder mismatch. Fail the deploy on errors; show warnings for suspicious rules. Test each rule against a sample URL and show the result in the UI.

#### P0 — `_headers` parser with merge/detach semantics

**User problem.** Security and cache headers are easy to get wrong, and a broad `/*` rule can accidentally remove a critical header.

**Sketch.** Support path patterns with splats/placeholders, multiple rules matching the same path (merge), and `! Header-Name` to detach. Cap 100 rules / 2,000 chars per line. Compile to Caddy `header` handlers ordered from least to most specific so specific rules win; apply platform security defaults first, then user rules. Warn when a user detaches HSTS, sets `Cache-Control: immutable` on a non-hashed path, or sets `Access-Control-Allow-Origin: *` on a path that also has auth. Never serve `_headers`, `_redirects`, `yoal.json`, `.git`, or dotfiles: add a Caddy `hide` rule and a 404 route (404 rather than 403 to avoid disclosure).

#### P0 — Correct 404 vs SPA fallback (no soft 404s for assets)

**User problem.** A blanket SPA rewrite to `index.html` makes missing `.js`/`.css` return HTML with a 200, producing cryptic MIME errors and polluting analytics; conversely, a missing route in an SPA should render the app shell.

**Sketch.** Generate routes in this order:

1. Exact static file → `file_server`.
2. If `cleanUrls`, try `{path}.html` and `{path}/index.html`.
3. If `spa`/`fallback` and the request accepts HTML (`Accept: text/html` or no extension), rewrite to `/200.html` or `/index.html` and serve 200.
4. Otherwise emit 404; `handle_errors` serves `/404.html` with status 404 (or a built-in page). Never serve the SPA shell for a request with an asset extension unless the user explicitly opts in.

Caddy's `try_files` can express the file/dir probe ([Caddy Docs: try_files](https://caddyserver.com/docs/caddyfile/directives/try_files)); the extension/`Accept` condition needs a matcher, so compile JSON routes rather than a single `try_files`. Preserve the original status in `handle_errors`; Caddy's `file_server` supports a `status` override for custom error pages.

#### P0 — Clean URLs and trailing slashes with deterministic redirects

**User problem.** `/about`, `/about/`, `/about.html`, and `/about/index.html` should not all be indexable duplicates, and a wrong setting causes redirect loops behind a proxy.

**Sketch.** Three modes: `trailingSlash: "always" | "never" | "auto"` and `cleanUrls: true|false`. Generate 301s: strip `.html` when clean URLs are on; add/remove trailing slash according to mode. Respect `X-Forwarded-Proto`/`Host` only from trusted proxies to avoid open redirects. Test the matrix (`/about`, `/about/`, `/about.html`, `/about/index.html`, query strings, encoded paths). Caddy enforces canonical URIs by default; use `disable_canonical_uris` only when the user's explicit rules conflict, and document why.

#### P1 — Rewrites and reverse-proxy routes

**User problem.** SPAs, API proxying, and migrations need internal rewrites and external proxies without exposing an open proxy.

**Sketch.** `rewrites` with status 200 compile to Caddy `rewrite` (internal) or `reverse_proxy` (external). For external targets, require an allowlist per site/org, set timeouts, preserve or override `Host`, support WebSocket upgrade, strip the matched prefix when requested, and never forward `Authorization` to a third party by default. Add a per-route auth policy so `/api/*` can be platform-protected while the site is public. Block proxying to link-local/metadata IPs (SSRF), and resolve DNS at config time with a re-check.

#### P1 — Custom error pages per status and per format

**User problem.** A branded 404 is table stakes; API routes need JSON errors, and a 500 page should not leak stack traces.

**Sketch.** Support `404.html`, `403.html`, `500.html`, and optional JSON variants for `Accept: application/json`. Caddy `handle_errors` can rewrite to the page and set the status. Cache 404s briefly (e.g. 5 minutes), never cache 500s. For previews, include a small "preview" banner via an injected script or an HTML transform; keep it out of production.

#### P2 — i18n rewrites and geo/language routing

**User problem.** Multi-language sites want `/` to resolve to a language based on `Accept-Language` or country without a client-side redirect flash.

**Sketch.** Caddy `map` on `{http.request.header.Accept-Language}` and optional GeoIP to pick a prefix, then `rewrite` to `/<lang>{path}`. Set `Content-Language` and `Vary: Accept-Language`; always allow an explicit `/en/...` path and a cookie override to avoid loops. Firebase documents i18n rewrites, so this is a credible differentiator for a self-hosted platform.

#### P2 — Config diff and preview of routing changes

**User problem.** A routing change can break more than a code change, and reviewers cannot see it in a git diff.

**Sketch.** On every deploy, store the resolved config and a normalized routing table. The release detail shows "Routing changes" (added/removed/redirect status changed/header changed) alongside file changes. Add a "Test URL" box that evaluates the compiled matchers and shows which route wins, including the final status/headers. This is a small feature with outsized perceived quality.

### Gaps

- GitHub Pages does not document a general redirect/header configuration mechanism; only a custom 404 is documented. Do not assume `_redirects` works there.
- Amplify's `customHttp.yml` schema details and monorepo header requirements were not fetched; only the existence and migration guidance are confirmed.
- Cloudflare Pages' `_redirects` limitations are explicit, but its behaviour for encoded paths, case sensitivity, and duplicate rules is not fully documented in the pages reviewed.
- No vendor documents the exact interaction between `cleanUrls`, `trailingSlash`, and proxy rewrites; Yoal should define and test its own precedence.

## Enhancements: image optimization, font optimization, forms, search, analytics, A/B testing, edge functions, geo/IP rules, bot management, WAF/DDoS

### Takeaway

Most vendors sell these as separate products or edge-compute features, not as part of static hosting. For a single-node Yoal, the realistic high-value wins are build-time image/font optimization, a first-party forms endpoint, privacy-friendly analytics, and declarative geo/IP/rate rules. Full edge functions, A/B testing, and volumetric WAF/DDoS should be integrations with a CDN/edge provider, not core promises.

### Cited Findings

- Bunny Dynamic Images supports resize, crop, aspect ratio, face detection, colour adjustments, blur/sharpen, rotation, quality, and JPEG/PNG/WebP/GIF conversion via query parameters; each transformation is processed once and cached at the edge, with the original preserved. — [Bunny Docs: Dynamic Images](https://bunny.net/docs/optimizer/dynamic-images/overview)
- Fastly Image Optimizer automatically optimizes JPEG/Progressive JPEG/WebP at quality 85, strips metadata, applies orientation, supports resize/crop/format/blur/brightness/contrast, caches variants, and has a 60-second minimum TTL for transformed images on services created on/after 2 May 2023. — [Fastly Docs: Image Optimizer reference](https://www.fastly.com/documentation/reference/io/)
- Cloudflare Pages Functions lets users deploy server-side code for dynamic functionality without a dedicated server; Function requests count toward the Workers plan quota. — [Cloudflare Docs: Pages overview](https://developers.cloudflare.com/pages/); [Cloudflare Docs: Pages limits](https://developers.cloudflare.com/pages/platform/limits/)
- Firebase Hosting rewrites can target Cloud Functions or Cloud Run containers, giving static sites a path to dynamic behaviour without a separate host. — [Firebase Docs: Full Hosting configuration](https://firebase.google.com/docs/hosting/full-config)
- Surge explicitly has no build service and positions itself as static files on a CDN; its documented platform features are publishing, custom domains, SSL, revisions, clean URLs, SPA/404 pages, CORS, and (Pro) redirects/password protection. It does not document forms, search, image optimization, or edge functions. — [Surge Docs: Platform overview](https://surge.sh/docs/platform/); [Surge Pricing](https://surge.sh/pricing)
- GitHub Pages is a static site host for HTML/CSS/JS, optionally built with Jekyll; the docs reviewed do not document forms, search, image optimization, or server-side code. — [GitHub Docs: What is GitHub Pages?](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)
- Amplify Hosting supports static and SSR apps/frameworks (Next.js, React, Vue, Angular, Nuxt, Gatsby), branch environments, PR previews, and environment variables; the docs reviewed do not document a native image optimizer or forms product. — [AWS Amplify Docs: Amplify Hosting](https://docs.amplify.aws/javascript/deploy-and-host/amplify-hosting/)
- Caddy has optional image filtering (crop, fit, flip, resize, rotate, sharpen), templates, rate limiting, a geo matcher, and Prometheus/OpenTelemetry metrics. — [Caddy Features](https://caddyserver.com/features)
- Bunny offers geo-blocking, network limits, token authentication, "Next-Gen AI WAF", DDoS protection, and hotlinking protection as CDN features. — [Bunny CDN Features](https://bunny.net/cdn/features/)
- Fastly supports HTTP/3, Brotli, shielding, and Image Optimizer; its POP architecture is designed around fewer, larger POPs with high cache hit ratios. — [Fastly Network Map](https://www.fastly.com/network-map); [Fastly Docs: Using the global POP network](https://www.fastly.com/documentation/guides/getting-started/concepts/using-fastlys-global-pop-network/)
- Cloudflare Pages preview deployments can be protected with Cloudflare Access; by default preview URLs are public. — [Cloudflare Docs: Preview deployments](https://developers.cloudflare.com/pages/configuration/preview-deployments/)

### Inferences

#### P1 — Image optimization: build-time variants plus an optional on-demand transformer

**User problem.** A 4 MB hero JPEG is the largest cause of poor LCP and wasted bandwidth; authors should not have to hand-generate five sizes and three formats.

**Sketch.** Two layers:

1. **Build-time (default, safe):** a `yoal images` build step (or framework plugin) scans `img`/`source` references or a configured glob, generates AVIF/WebP at widths 320/640/960/1280/1920 (and 2x where useful), stores them content-addressed, and emits a manifest. Provide a small `<Image>` component/snippet that emits `srcset`/`sizes` and a fallback. Do not rewrite arbitrary HTML automatically; it breaks inline styles and CMS output. Report estimated bytes saved per release.
2. **On-demand (opt-in):** run `imgproxy` (or a Caddy image-filter plugin) behind Caddy at `/_yoal/img/<release>/<path>?w=800&fm=avif&q=75`. Sign the URL with the release/path/size to prevent abuse; allowlist dimensions (e.g. 16–4096), formats, and quality; cap transforms per request/tenant; cache variants immutably with `Vary: Accept`; purge by release tag. This mirrors Bunny/Fastly behaviour (transform once, cache the variant, preserve the original) without building an image pipeline from scratch.

Cost/abuse controls matter: image transforms are CPU-heavy. Rate-limit per IP/site, reject upscaling by default, and consider a separate worker pool so image requests cannot starve static file serving. If the site is fronted by Bunny/Fastly/Cloudflare, prefer their image product and keep Yoal's origin clean.

#### P1 — Font optimization: self-host, subset, preload

**User problem.** Third-party font CSS adds a connection and render-blocking request; unsubsetted fonts waste hundreds of KB, especially for CJK.

**Sketch.** Build step: detect `@font-face` URLs, download/self-host fonts, convert to `woff2`, optionally subset with `pyftsubset`/`glyphhanger` to Latin + the site's actual glyph set, rewrite CSS to local paths, add `font-display: swap`, and emit a `Link: </fonts/x.woff2>; rel=preload; as=font; type=font/woff2; crossorigin` header for the critical face. Cache fonts `immutable`. Make subsetting opt-in for sites with dynamic/user-generated text; offer "Latin only", "Latin + punctuation", and custom Unicode ranges. Measure and show font bytes saved. This is a build-time feature, not a runtime one, so it fits a single node well.

#### P1 — Forms: a first-party endpoint for static sites

**User problem.** A static contact/feedback/waitlist form has no backend; users either embed a third-party form (privacy/design compromise) or deploy a serverless function.

**Sketch.** `POST /_yoal/forms/<form-id>` on the site's domain, routed by Caddy to the control plane. Accept JSON and `application/x-www-form-urlencoded`; enforce `Origin`/`Referer`, a honeypot field, optional Turnstile/hCaptcha/ALTCHA proof-of-work, per-IP and per-form rate limits, and a max body size. Store submissions in Postgres with `{site, form, release, fields, ip_hash, user_agent, created_at, spam_score}`; notify via email/webhook; expose a dashboard inbox, CSV export, retention policy, and delete-by-request. Never log full submission bodies by default. This is a genuine differentiator: GitHub Pages cannot do it, Surge does not document it, and Cloudflare/Firebase require Functions.

#### P2 — Search: build-time index, optional server-side FTS

**User problem.** Static sites either ship a third-party search widget or have no search at all.

**Sketch.** Run Pagefind (or a small indexer) at build time, emit `/_pagefind/*`, and serve it with long cache + a versioned path. Provide a drop-in search UI snippet and a `yoal.json` toggle. For large sites or PDFs, add an optional SQLite FTS5 index in the control plane with a `GET /v1/sites/:id/search?q=` endpoint; keep it per-release and rebuild on deploy. No external service, no API keys, works on a single node. Watch index size and build time; cap pages/documents.

#### P1 — Privacy-friendly analytics and Core Web Vitals

**User problem.** Teams need to know what is popular and what is broken without adopting a cookie banner or sending visitor data to an ad-tech-adjacent service.

**Sketch.** Yoal already has traffic telemetry; formalise it:

- Server-side from Caddy JSON logs: pageviews, unique visitors (daily salted hash of IP + UA, no cookie), top paths, referrers, status codes/404s, countries, devices, bytes, cache status.
- Optional JS beacon (`navigator.sendBeacon`) for Core Web Vitals (LCP, INP, CLS), client-side errors, and SPA route changes. Respect `DNT`/`GPC`; no cross-site ID; no fingerprinting; truncate IP before storage; retain raw logs 7–30 days and aggregates longer.
- Dashboard: "top content", "top 404s", "slowest pages", "bytes saved by compression", "cache hit ratio", "bandwidth by release". Export CSV/JSON. Add a public "analytics" disclosure page snippet.

This is a credible alternative to Cloudflare Web Analytics/Firebase Analytics for privacy-sensitive customers; the differentiator is that the data stays on the operator's infrastructure.

#### P2 — A/B testing at the edge (only if demand is real)

**User problem.** Marketing wants to test two heroes or two landing pages without a client-side flicker or a third-party tool.

**Sketch.** For static sites, the simplest robust approach is client-side: a small script assigns a variant from a stable `yoal_vid` cookie/localStorage, swaps content, and reports the variant in the analytics beacon. For edge-side, Caddy can set a `yoal_vid` cookie on first HTML response and `map` it to a release root; but asset consistency and caching make this tricky. A proper edge A/B test is a Compute/Worker feature. Recommend documenting "client-side A/B + analytics" now, and defer edge split until there is a real customer.

#### P3 — Edge functions / middleware: declarative first, code later

**User problem.** Some sites need auth, geo redirects, header injection, or personalization at request time, but running arbitrary code at the edge is a large security and ops surface.

**Sketch.** Do not build a general edge runtime. Ship declarative middleware: redirects, rewrites, headers, geo/IP allow/deny, basic auth/platform auth, rate limits, A/B cookie, and cache rules — all compiled to Caddy. For code, offer an optional sidecar (Deno/QuickJS/WASM) behind Caddy with strict CPU/memory/wall-clock limits, no filesystem/network by default, and only at the origin (not global edge). For true edge compute, integrate Cloudflare Workers/Fastly Compute and document the boundary. This keeps the core small and honest.

#### P2 — Geo/IP rules

**User problem.** Legal/compliance and licensing often require blocking or allowing countries, regions, or IP ranges; abuse response needs IP allowlists.

**Sketch.** Caddy's geo matcher (MaxMind GeoIP2 plugin) plus `remote_ip` matchers ([Caddy Features](https://caddyserver.com/features)). Store rules per site/path: `allow`/`deny` country codes, ASNs, CIDRs; default allow; combine with auth (`AND`) or as an alternative (`OR`). Trust `X-Forwarded-For` only from known CDN/proxy ranges. Handle IPv6, Tor exit lists (optional), and health-check bypass. Keep the GeoIP database updated (licensing/size), and expose the resolved country in logs for debugging. If fronted by Bunny/Fastly/Cloudflare, prefer their geo rules at the edge and mirror the decision at origin for defence in depth.

#### P1 (integration) / P3 (native) — Bot management, WAF, DDoS

**User problem.** A single node cannot absorb a volumetric DDoS, and scraping/hotlinking/credential stuffing degrade service for everyone.

**Sketch.** Be explicit about the boundary:

- **Origin baseline:** Caddy rate limiting per IP/site/path with `Retry-After`; request body size limits; header/read/write/idle timeouts; max concurrent connections; hotlink protection via `Referer`; block bad user agents; CrowdSec bouncer for community IP reputation; fail2ban on auth failures; HTTP/2 rapid-reset mitigations.
- **Edge:** recommend Cloudflare/Bunny/Fastly for L3/L4 DDoS, WAF, bot management, and geo rules. Provide a "protected by" mode that locks the origin to the CDN's IP ranges and requires a shared secret header.
- **Never** claim a single node provides DDoS protection. Document the residual risk and the recommended front door.

WAF rules should be opt-in and testable in log-only mode first; a false positive on a static site is still an outage.

### Gaps

- Cloudflare Pages' native image optimization/resizing story was not documented in the Pages pages reviewed; Cloudflare Images/Polish are separate products, so do not assume Pages includes them.
- Firebase Hosting does not document a native image optimizer, forms service, or search service in the pages reviewed; Functions/Cloud Run are the extension path.
- Amplify's image optimization and analytics capabilities were not documented in the pages reviewed; the docs focus on hosting/CI-CD.
- Pricing for Bunny Optimizer, Fastly IO, and Cloudflare image products was not fetched, so cost comparisons are incomplete.
- No vendor publishes a privacy-friendly analytics feature set in the docs reviewed; the analytics sketch is a product design, not a parity claim.

## Access: password protection, basic auth, IP allowlists, preview protection, signed previews

### Takeaway

Access is where a self-hosted platform can beat the giants: per-path password/email/SSO rules that travel with the release, previews protected by default, and signed share links. Surge's `AUTH` file is the clearest model. Caddy's built-in basic auth plus `forward_auth` can implement the whole thing without a separate auth proxy, and `forward_auth` is explicitly designed to delegate the allow/deny decision to an external service.

### Cited Findings

- Surge's `AUTH` file contains one rule per line: a path pattern followed by principals. Principals can be an exact email, `*@domain`, `collaborators`, or `user:password`. Email principals use a Surge sign-in page (Google/GitHub/Surge account) and last 12 hours per domain; credential principals use HTTP basic auth. The first matching rule decides; blank lines and `#` comments are ignored; a bare `*` covers the whole domain. — [Surge Docs: Password Protection & Protected Paths](https://surge.sh/docs/platform/auth)
- Surge `AUTH` is a Pro feature; `--private` (only people who can publish can view) is available on every plan. The `AUTH` file itself is never served; protection is versioned with the release, so rollback rolls back the rules; a malformed rule blocks the publish with a line-by-line explanation. — [Surge Docs: Password Protection & Protected Paths](https://surge.sh/docs/platform/auth); [Surge Docs: Plans](https://surge.sh/docs/platform/plans)
- Surge supports `/__surge/logout` to sign out and notes that removing someone takes effect on their next sign-in; existing sessions expire within 12 hours. — [Surge Docs: Password Protection & Protected Paths](https://surge.sh/docs/platform/auth)
- AWS Amplify supports basic auth per app/branch via `enableBasicAuth` and `basicAuthCredentials` (base64-encoded `user:password`). — [AWS Amplify API: App](https://docs.aws.amazon.com/amplify/latest/APIReference/API_App.html)
- Cloudflare Pages preview deployments are public by default; an Access policy can restrict preview URLs to Cloudflare account members or other Access policies. Enabling Access protects previews, not the production `*.pages.dev` or custom domain. — [Cloudflare Docs: Preview deployments](https://developers.cloudflare.com/pages/configuration/preview-deployments/)
- Firebase preview URLs are public even though they contain a random hash; the docs describe them as difficult to guess, not private. — [Firebase Docs: Test, preview, deploy](https://firebase.google.com/docs/hosting/test-preview-deploy)
- GitHub Pages is not intended for sensitive transactions such as sending passwords or credit card numbers, and the docs reviewed do not describe a password-protection feature. — [GitHub Docs: GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)
- Caddy includes HTTP basic authentication as a standard handler, hashes passwords when setting up basic auth, and supports `forward_auth` to an external authentication gateway. `forward_auth` sends a GET to the gateway; a 2xx grants access and copies configured headers to the original request, while any other status is returned to the client (typically a login redirect). — [Caddy Features](https://caddyserver.com/features); [Caddy Docs: forward_auth](https://caddyserver.com/docs/caddyfile/directives/forward_auth)
- Bunny's token authentication supports signed URLs, path tokens, query-string or path-based signing, IP range (/24) restrictions, expiry, and country/referrer allow/block lists. — [Bunny Blog: Token Authentication V2](https://bunny.net/blog/were-bringing-token-authentication-to-the-next-level/)
- Cloudflare Access is the mechanism Cloudflare documents for protecting Pages preview deployments; it is a separate Zero Trust product, not a Pages-native password field. — [Cloudflare Docs: Preview deployments](https://developers.cloudflare.com/pages/configuration/preview-deployments/)

### Inferences

#### P0 — A versioned access policy that travels with the release

**User problem.** Staging/client-review access is usually configured in a dashboard, divorced from the code, and easy to leave open after launch.

**Sketch.** Add `access` to `yoal.json` and/or an `AUTH` file:

```json
{
  "access": [
    { "path": "/*", "allow": ["platform"] },
    { "path": "/admin/*", "allow": ["email:@example.com", "user:ci-bot"] },
    { "path": "/reports/*", "allow": ["share"] }
  ]
}
```

First matching rule wins; `platform` means any authenticated Yoal user with site access; `email:` uses magic-link/OIDC; `user:password` uses basic auth for scripts; `share` requires a signed token. Store the policy in the release manifest, show a diff on deploy, and make rollback restore the previous policy. This is Surge's best idea: the config is versioned with the code.

#### P0 — Basic auth for simple gates and CI

**User problem.** A client review or staging site needs a password in 30 seconds, and CI needs a non-interactive credential.

**Sketch.** Caddy `basic_auth` with bcrypt hashes; support multiple users per site/path; send `WWW-Authenticate: Basic realm="<site>"`; rate-limit failed attempts per IP; constant-time comparison; never log the `Authorization` header. Generate credentials with `yoal auth add <site> <user>` (prints a one-time password) and store only the hash. Allow `user:password` in the policy for CI, but label it "basic auth, use HTTPS only". For a nicer end-user experience, offer a branded login page backed by `forward_auth` instead of the browser prompt.

#### P0 — Platform auth via `forward_auth`

**User problem.** Site owners want to restrict a site to their Yoal organisation or specific teammates, not share a password.

**Sketch.** Caddy:

```caddyfile
forward_auth 127.0.0.1:8081 {
  uri /internal/authz
  copy_headers X-Yoal-User X-Yoal-Role
}
```

The control plane checks the session cookie (`HttpOnly; Secure; SameSite=Lax`), org membership, site role (`viewer`/`editor`/`admin`), and path policy, then returns 200 with user headers or 302 to the login page with `?next=`. Sessions: 12 hours for email magic links (Surge's model), 7 days for "remember me"; rotate on privilege change; support logout and "sign out all devices". Add CSRF protection on login, rate limits, and audit events. For CLI/API, use a bearer token instead of a cookie; `forward_auth` can branch on `Authorization`.

#### P1 — Email-domain and SSO access

**User problem.** Agencies want to give a whole client domain access without maintaining a user list, or use the client's IdP.

**Sketch.** `email:@client.com` sends a magic link or OIDC login; verify the email domain, not just the address. For SSO, support OIDC (Google, Microsoft, Okta, Auth0) and later SAML. Map IdP groups to site roles. Keep a fallback password for emergencies. Session lifetime 12 hours; show "signed in as" and a logout link on protected pages.

#### P1 — IP allowlists

**User problem.** Internal tools, staging sites, and compliance regimes need network-level restriction, often combined with a password.

**Sketch.** Per site/path CIDR allow/deny lists, IPv4 and IPv6, with `allow` taking precedence or explicit `deny` first (document the order). Use Caddy `remote_ip` matchers; trust `X-Forwarded-For` only from configured CDN/load-balancer ranges; bypass health checks from localhost. Combine with auth via `AND` (both required) or `OR` (either). Show the resolved client IP in the access log and a "why was I denied?" diagnostic. For mobile users, warn that IP allowlists are brittle; offer a share link instead.

#### P0 — Preview protection by default (unguessable is not private)

**User problem.** Preview URLs leak unreleased content, and Firebase/Cloudflare explicitly treat preview URLs as public. A random hash is not an access control.

**Sketch.** Previews default to `platform` auth, not public. Add a signed preview token for external reviewers: `https://<deployment>.<site>.preview.example/?__yoal_preview=<token>` sets an `HttpOnly`, `Secure`, host-scoped cookie and redirects to the clean URL. Token payload: site, deployment, expiry (default 7 days, max 30), optional email, optional single-use. Add `X-Robots-Tag: noindex`, `robots.txt` disallow, and no sitemap inclusion. Use a separate preview hostname so production cookies are not sent to previews. Revoke by bumping a preview secret or deleting the deployment. This is a stronger default than Cloudflare/Firebase and a clear differentiator.

#### P1 — Signed share links for files and protected paths

**User problem.** Clients need a download link that expires, without a Yoal account and without making the bucket public.

**Sketch.** `yoal share <path> --expires 7d [--password ...] [--max-downloads 5]` returns `/s/<token>/...`. Token includes site, release, path prefix, expiry, optional password hash, optional IP, and a random ID for revocation. Caddy `forward_auth` validates and sets `X-Yoal-Share-Id` ([Caddy Docs: forward_auth](https://caddyserver.com/docs/caddyfile/directives/forward_auth)); the file server serves only the allowed prefix. For large files, 302 to a presigned object URL. Log views (IP hash, UA, bytes, status), show them in the dashboard, and allow revocation. Don't allow directory listing; return 404 for paths outside the prefix.

#### P2 — Session and password lifecycle

**User problem.** Removing a teammate or changing a password should take effect immediately, not after a 12-hour session expires.

**Sketch.** Store a `session_version` per user/site; increment on password change, role change, or "sign out everywhere"; include it in the session cookie/JWT and reject stale versions. For share links, store a revocation list/ID. Show active sessions with IP/UA and a revoke button. This is a small ops feature that makes access feel trustworthy.

#### P2 — CORS configuration per site

**User problem.** Fonts, APIs, and embeds need CORS, but a wildcard on authenticated content is dangerous.

**Sketch.** A `CORS` file or `access.cors` config: allowed origins, methods, headers, credentials, max-age. Compile to Caddy `header` rules and handle `OPTIONS` preflight. Refuse `Access-Control-Allow-Origin: *` with `Allow-Credentials: true`; warn on wildcard for HTML. This mirrors Surge's `CORS` file and is a small but frequently requested feature.

### Gaps

- Firebase Hosting does not document a built-in password gate for static content in the pages reviewed; Firebase Auth/Identity Platform is an app-level solution, not a host-level one.
- GitHub Pages has no documented password protection or IP allowlist; its docs explicitly warn against sensitive transactions.
- Cloudflare Access pricing and configuration details were not fetched; only its use for Pages previews is confirmed.
- Surge's `AUTH` docs are current as of the site content reviewed, but the exact behaviour of sessions after a password change (other than "expire within 12 hours") is not specified.

## Ops: bandwidth/usage caps, cost alarms, cache hit ratio, logs, status, health checks, multi-origin failover

### Takeaway

Self-hosted ops should make usage visible and enforceable at the edge, not just report it after the bill. Caddy's structured access logs, Prometheus metrics, and reverse-proxy health checks are enough to build per-site bandwidth, cache hit ratio, 5xx alarms, and origin failover. What a single node cannot fix is being a single node: true HA needs object-store replication plus a standby Caddy/control-plane, or a CDN in front.

### Cited Findings

- GitHub Pages: 100 GB/month soft bandwidth, 1 GB published site, 10 builds/hour soft, 429 rate limits, and GitHub may stop serving or contact the owner if limits are exceeded. — [GitHub Docs: GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)
- Firebase: 10 GB storage free, $0.026/GB after; data transfer free to 10 GB/month (or 360 MB/day per the pricing table), $0.15/GB after; Google recommends budget alerts in the Cloud console. Retained releases count toward Hosting storage. — [Firebase Docs: Hosting usage, quotas, pricing](https://firebase.google.com/docs/hosting/usage-quotas-pricing); [Firebase Pricing](https://firebase.google.com/pricing)
- Cloudflare Pages: 500 builds/month free, 20,000 files free, 25 MiB/file, 100 projects/account, 100 custom domains/project free; Functions requests count toward Workers quota. — [Cloudflare Docs: Pages limits](https://developers.cloudflare.com/pages/platform/limits/)
- Surge: no bandwidth billing and no overage charges; publish rate limits pause publishing but do not stop serving; project limit 450 MB/10,100 files. — [Surge Pricing](https://surge.sh/pricing)
- Fastly: Instant Purge averages <150 ms globally (as of 31 Dec 2025); distinct URL/surrogate-key purges are limited to an average of 100,000/hour per customer; purge-all is hard and contributes to global API rate limits. — [Fastly Network Map](https://www.fastly.com/network-map); [Fastly Docs: Getting started with purging](https://www.fastly.com/documentation/guides/full-site-delivery/purging/getting-started-with-purging/)
- Bunny: default purge rate limits are ~300 exact/minute and ~30 prefix/minute; purging a large zone temporarily increases origin load; >95% cache hit rate is healthy, <70% usually indicates a configuration issue. — [Bunny Docs: Purge Cache](https://bunny.net/docs/cdn/purge-cache); [Bunny Docs: Smart Cache](https://bunny.net/docs/cdn/smart-cache)
- Caddy provides structured access logs with request/response headers, remote IP, latency, and bytes; supports IP masking and hashing; exposes Prometheus metrics and OpenTelemetry; and has a reverse proxy with active/passive health checks, load balancing, retries, circuit breaking, streaming, and upstream health via the admin API. — [Caddy Features](https://caddyserver.com/features)
- Caddy's reverse proxy supports `first`/round-robin/least-conn/random/header/cookie/IP-hash policies, active and passive health checks, retries while upstreams change, and response streaming. — [Caddy Features — Reverse proxy](https://caddyserver.com/features)
- Caddy's admin API exposes upstream traffic counts and health status, and Caddy supports zero-downtime graceful reloads. — [Caddy Features](https://caddyserver.com/features)
- AWS Amplify Hosting handles cache invalidation automatically and supports custom domains/SSL; the docs reviewed do not describe a public per-site bandwidth cap or cost-alarm feature. — [AWS Amplify Docs: Amplify Hosting](https://docs.amplify.aws/javascript/deploy-and-host/amplify-hosting/)

### Inferences

#### P0 — Per-site usage metering from Caddy logs

**User problem.** A tenant can consume all the node's bandwidth or storage, and the operator finds out only when the server falls over or the bill arrives.

**Sketch.** A log agent tails Caddy's JSON access log, parses `{ts, host, site_id, release_id, status, size, duration, remote_ip, user_agent, cache_status, country}`, and writes idempotent per-minute aggregates to Postgres/ClickHouse. Define billable bandwidth as response body bytes for 2xx/3xx (decide whether 304 counts headers only), exclude health checks and internal previews by default, and separate "static", "downloads", and "image transforms". Dashboard: month-to-date, projected month-end, top assets, top referrers, bytes by release, requests by status. Alert at 80/100/120% of plan; soft cap sends email/Slack, hard cap serves a branded 503/402 page or pauses the site (configurable). Provide admin override and a grace period. This is the foundation for every other ops feature.

#### P0 — Cost alarms and chargeback

**User problem.** Self-hosted does not mean free: egress, object storage, build CPU, and image transforms have real costs, and teams need to see who is responsible.

**Sketch.** A pricing table per resource (`egress_per_gb`, `storage_per_gb_month`, `build_minute`, `image_transform`, `cdn_purge`), configurable by the operator. Compute estimated cost per site/org/month from the same aggregates; show a budget and forecast; alert at 50/80/100%; export CSV for chargeback. If a CDN is in front, pull the provider's usage API (Bunny/Fastly/Cloudflare) and reconcile with origin logs; show both "origin bytes" and "edge bytes" so cache efficiency is visible.

#### P0 — Cache hit ratio that means something

**User problem.** "Cache hit ratio" is meaningless if the origin is a local disk with no cache layer; teams need to know whether the CDN is actually absorbing traffic.

**Sketch.** Define three metrics: `edge_hit_ratio` (from CDN response headers: `CF-Cache-Status`, `Fastly-Cache-Status`, `Bunny-Cache-Status`, `X-Cache`), `origin_offload` (edge bytes / total bytes), and `asset_reuse` (requests served from content-addressed paths). For a direct Caddy site, report OS page-cache effectiveness only as an internal metric, not a customer-facing "hit ratio". If Yoal uses the optional Caddy cache module, expose its hits/misses and tag purges. Alert when edge hit ratio < 70% for static assets (Bunny's threshold) or when HTML hit ratio is unexpectedly high (stale content risk). Show the top misses by path to make it actionable.

#### P0 — Structured logs with retention, search, and redaction

**User problem.** Debugging a customer issue requires finding the exact request, but logs are noisy, contain PII, and disappear too fast.

**Sketch.** Caddy JSON logs to stdout and a rotating file; the agent enriches with `site_id`, `release_id`, `deployment_id`, `request_id`, and `edge_pop` (from CDN header). Fields: timestamp, method, host, URI, status, bytes, duration, remote IP (truncated/hashed), UA, referer, protocol, TLS version, cache status, country. Redact `Authorization`, `Cookie`, `Set-Cookie`, and query parameters matching `token|key|password|secret`. Retention tiers: 7 days hot search, 30 days warm, 90 days cold/S3; per-site log isolation; live tail in the dashboard; export a filtered CSV. Propagate `X-Request-ID` from the edge to the origin and show it in error pages so users can quote it.

#### P0 — Health checks, status page, and TLS expiry monitoring

**User problem.** A expired certificate, a full disk, or a dead build worker should page someone before customers notice.

**Sketch.** Control plane `/healthz` checks DB, object store, queue, Caddy admin, and disk space; Caddy `/metrics` for request rate/latency/5xx. Per-site synthetic checks from the agent: DNS resolves, TLS valid and >14 days to expiry, `/` returns 200, a known asset returns 200 with the right content type, a known 404 returns 404, redirects have the right status, security headers present. Run every 1–5 minutes from one or more vantage points; store results; public/private status page; incident timeline; alert via email/Slack/webhook. Add a "certificate renewals" panel with last success/next attempt/error. Alert on build queue depth, failed builds, disk >80%, and purge failures.

#### P1 — Automatic post-deploy smoke tests and auto-rollback

**User problem.** A deploy can be "successful" but serve a blank page, a broken asset path, or a 500 from a missing rewrite; manual rollback is too slow.

**Sketch.** Before promotion, run the same synthetic checks against the preview URL: `/`, top 10 pages from analytics, a hashed asset, a redirect, a 404, and a header check. Optionally run a headless browser for console errors and LCP. If any critical check fails, block promotion and show the diff. After promotion, run checks again and monitor 5xx rate/latency for 5–10 minutes; if thresholds are exceeded, automatically flip the pointer back and notify. This is a genuine differentiator: Cloudflare/Firebase document manual rollback, and Amplify's rollback is a redeploy.

#### P1 — Multi-origin failover and standby

**User problem.** A single node is a single point of failure: disk, power, network, or a bad Caddy config takes every site down.

**Sketch.** Several levels, in order of cost:

1. **Process-level:** run Caddy and the control plane under systemd/containers with restart policies; keep the Caddy config in the object store/DB so a new node can boot from it.
2. **Origin failover:** Caddy `reverse_proxy` with a primary local origin and a standby remote origin, `lb_policy first`, active health checks, `fail_duration`, and retries. If the primary is down, serve from the standby; if both are down and a cache module is enabled, serve stale.
3. **Data-level:** replicate the object store (S3 CRR/R2 replication) and Postgres (streaming replica/PITR). Release manifests are immutable, so replication is append-only and easy to verify.
4. **DNS-level:** a standby node with a low-TTL A/AAAA record; health-check-based DNS failover (or a load balancer/anycast) flips traffic. Avoid split-brain: only one writer for the live pointer.
5. **CDN-level:** put Bunny/Cloudflare/Fastly in front; their cache and failover absorb origin blips. This is the cheapest real HA for static content.

Be explicit in the UI: "single node" vs "standby" vs "CDN-fronted". Do not claim HA from a single process restart.

#### P1 — Rate limiting and abuse controls

**User problem.** Login attempts, form spam, image-transform abuse, and scraping can exhaust CPU/bandwidth; a static site is not immune.

**Sketch.** Caddy rate limiting per IP/site/path with token buckets, `Retry-After`, and burst limits; separate zones for auth, forms, search, and image transforms. Request body limits (e.g. 1 MB forms, 10 MB uploads unless configured), header/read/write/idle timeouts, max concurrent connections, and hotlink protection for large assets. CrowdSec bouncer for known bad IPs; fail2ban on auth failures. Log 429/403 with the rule ID; provide a "why was I limited?" diagnostic. On a CDN, mirror the rules at the edge so abusive traffic never reaches the origin.

#### P1 — Observability and SLOs

**User problem.** Operators need a small set of numbers that tell them whether the platform is healthy, not a wall of graphs.

**Sketch.** Prometheus metrics from Caddy and the control plane; Grafana dashboards for requests/s, p50/p95/p99 latency, 5xx %, 4xx %, bytes/s, cache hit ratio, build queue depth, deploy duration, TLS expiry, disk usage. Define SLOs: 99.9% successful static requests, p95 TTFB < 200 ms at origin, 99% deploys < 5 min, 99% builds < 10 min. Alert on burn rate, not just instantaneous thresholds. Trace deploys with OpenTelemetry (webhook → build → upload → promote) so a slow deploy has a waterfall.

#### P2 — Backup, restore, and disaster recovery

**User problem.** Immutable releases are not a backup if the bucket is deleted or the DB is corrupted.

**Sketch.** Object-store versioning + cross-region replication; Postgres PITR with daily base backups; config snapshots per release; encryption at rest and in transit; documented restore runbook with a quarterly drill. Test "restore a single release" and "restore the whole platform" separately. Keep an offline copy of the Caddy config and DNS records. For compliance, support legal hold/pinned releases that GC cannot delete.

#### P2 — Build/agent operations

**User problem.** A stuck build or a full disk on the build worker blocks every deploy, and build logs are the only evidence.

**Sketch.** Queue dashboard: pending/running/failed/cancelled, wait time, worker CPU/mem/disk, cache hit ratio. Per-build resource limits and timeouts; kill runaway processes; clean workspaces after N hours; cap artifact size; retain logs 30 days. Alert on queue depth > threshold and build failure rate > 10%. Restrict build network egress by default; allowlist package registries; never inject production secrets into untrusted PR builds.

### Gaps

- No vendor publishes a precise cache-hit-ratio formula or a standard for counting 304/HEAD bytes; Yoal must define its own and document it.
- Cloudflare/Fastly/Bunny pricing and current plan limits were only partially fetched; cost-alarm defaults should be configurable, not hard-coded.
- GitHub Pages' status/health tooling beyond the REST DNS health check was not researched; its docs focus on limits and HTTPS.
- Amplify's observability (CloudWatch integration, logs, alarms) was not fetched; the ops sketch is generic to Yoal, not a parity claim.
- True multi-region active-active for a single-node platform is not validated; the failover sketch assumes a standby/primary model or a CDN front, not consensus replication.
