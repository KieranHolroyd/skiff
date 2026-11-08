# Skiff — Container registry

Status: **G0–G6 built 2026-11-08** (R1 → D145, R2 → D146, R3 → D147, R4/R5 → D154, R6/R8 → D155,
push events → D156, G2 → D157, G3/G4 logins → D158, G4–G6 → D159). What is not built is listed in §13. The other
proposals (R4–R14) become D-numbers as they ship. §10's questions were answered with the
recommendations (zot, one install-wide registry, platform hostname, G0 first).

[PIPELINES.md](./PIPELINES.md) plans the same registry from the build side (W7–W9, phase WP2):
image builds push to it, job tokens authenticate to it. This document owns the registry; the
pipelines plan consumes it. Note for WP2: zot verifies tokens against an X.509 certificate, so
registry tokens are ES256 signed by `RegistryService` (W9 proposed Ed25519 with JWKS); a job
token should be exchanged at the realm or minted with `RegistryService.internalToken`.

Skiff runs container apps, but it cannot store an image, build one or pull a private one. Today a
container workload names a public image and the node pulls it straight from its registry. Cairn's
private GHCR image reaches prod only through `docker save | ssh podman load`, because Skiff has no
registry credentials (`cairn/deploy/skiff/deploy.sh`). This document plans an
install-wide **OCI registry** run by Skiff. It also plans the smaller fixes that make any registry,
Skiff's or someone else's, safe to deploy from.

---

## 0. Summary

| # | What | Why |
|---|---|---|
| R1 | Deploys **resolve a tag to a digest** and the node runs `repo@sha256:…` | Deployments are immutable (D13) and rollback restores the exact image. Today `Pull=` is unset, so a re-pushed tag is never picked up. |
| R2 | **Registry credentials** for external registries (GHCR, Docker Hub, ECR …), org-owned and sealed, delivered as a per-workload `AuthFile=` | Private images work without SSH. This is also the transport R6 reuses. |
| R3 | **Node image prune**, an agent verb that keeps every image in desired state plus the previous image per workload | Nothing prunes images today, and the prod VPS has about 4.5 GB free. |
| R4 | The registry is a **platform service** (one per install, like skiff-mail), not one instance per org | Layers deduplicate across projects. There is one hostname, one place to back up, and one pull path. |
| R5 | The engine is **zot**, run by the helper under a new `registry` profile and pinned by digest (D61), behind a `RegistryEngine` seam | zot is OCI-native, Apache-2.0, one binary, with online GC, retention, pull-through sync and signature checks. A native Bun engine can replace it later (§9). |
| R6 | **Skiff owns auth.** The control plane is the Docker token realm and issues short-lived ES256 JWTs. zot only verifies them. | One identity system. `skif_` API keys, roles and audit work unchanged. |
| R7 | Repositories are **`<org>/<name>`**, owned by an org, optionally linked to a project, and created on first push | Matches GHCR. The org is the tenancy boundary. |
| R8 | A new permission resource **`image: pull, push, delete`** | Same model as `database:*`. API keys can be scoped to push only (CI). |
| R9 | **Nodes pull over the overlay** through a loopback mirror (`127.0.0.1:8085`), with the public host as fallback | Pulls skip the internet round trip and keep working over WireGuard. Same pattern as the H6 loopback endpoints. |
| R10 | Blobs live on a **disk**, through a future `registry` storage kind (D169). S3 on a RustFS instance comes with HA. | Filesystem storage deduplicates without Redis. The storage defaults already decide where bulk data goes. |
| R11 | **Retention is deployment-aware.** Skiff keeps a hidden `skiff-d-<deploymentId>` tag on every retained deployment's digest. zot deletes untagged manifests after a grace period. | GC can never remove a rollback target. |
| R12 | **Builders produce images.** A Dockerfile build runs under buildah and pushes with a token scoped to that job. | Git → image → deploy without GitHub Actions. |
| R13 | **Pull-through cache** for docker.io, ghcr.io and quay.io, used by every node through `registries.conf` mirrors | Avoids Docker Hub's anonymous limit (100 pulls per 6 h per IP). Engine images keep pulling when upstream is down. |
| R14 | **HA later:** zot on S3 (a replicated RustFS bucket, C9) with a Valkey dedupe cache and two replicas | Fits D107. A single registry copy (L0) is acceptable first, because nodes cache what they run. |

R1–R3 do not need a registry. They fix real problems today, and they are phase G0.

---

## 1. Where things stand

| Area | Today | Source |
|---|---|---|
| Image reference | `workloadSpecSchema.image`, length check only. The helper's `assertImage` regex accepts any registry, tag or digest. | `packages/contracts/src/workload.ts:152`, `apps/helper/src/validate.ts:826` |
| Pull policy | App containers have no `Pull=` line, so Quadlet uses `missing`. Runners use `Pull=newer`. Jobs use `--pull=missing`. | `apps/helper/src/units.ts:712-717`, `apps/helper/src/jobs.ts:298` |
| Re-pushed tag | `image` is part of `activationVersion`. Saving the same tag does nothing, and a restart reuses the cached image. | `packages/core/src/workloads.ts:1129` |
| Registry auth | None: no `AuthFile=`, `auth.json` or pull secrets | — |
| Builds | The Builder clones, runs a shell command and zips `outputDir`. No image path. | `apps/builder/src/runner.ts`, `packages/contracts/src/build.ts` |
| CLI | `skif deploy` uploads a zip. A container's image is set only through `PUT /projects/:slug/workload` or the dashboard. | `apps/cli/src/commands/deploy.ts` |
| Engine images | The helper's own registry. RustFS and pgbouncer are pinned by digest; databases and brokers by tag only. Nothing is mirrored. | `apps/helper/src/validate.ts:262-530` |
| Disk | No image prune. `node_caches` is a placeholder. | `docs/OPERATIONS.md:240` |
| First-party images | `skiff-postgres(-pitr)` are built in GitHub Actions and pushed to GHCR | `.github/workflows/postgres-pitr-image.yml` |
| Large-body proxying | The S3 route already streams with `flush_interval -1` and long timeouts. The platform route has Caddy defaults. | `apps/agent/src/caddy-config.ts:162-200` |

---

## 2. Engine choice (R5)

| | zot v2.1.23 | CNCF Distribution v3.1.2 | Harbor v2.15 | Native Bun |
|---|---|---|---|---|
| Licence | Apache-2.0 | Apache-2.0 | Apache-2.0 | ours |
| Footprint | One static binary. A "minimal" build covers the spec only. | One binary | PostgreSQL, Redis, Distribution and several services; 2 CPU / 4 GB minimum | Inside the control plane, or a sidecar |
| GC | **Online**, with `gcDelay` (default 1 h) and retention rules (`keepTags`, `deleteUntagged`) | **Stop-the-world.** The registry must be read-only, or uploads can corrupt images. | Online | We write it |
| Auth | htpasswd, OIDC, API keys, mTLS, **bearer token** (realm/service/cert) | One provider at a time (htpasswd or token) | Its own users and robots | Native RBAC |
| Pull-through | `sync` on demand, multiple upstreams | One upstream per instance; no pushes in proxy mode | Proxy projects | We write it |
| Signatures | Trust extension (cosign incl. v3 bundles, notation) | No | Yes | Later |
| Storage | Filesystem (dedupe via a local cache), or S3 (dedupe needs a Redis cache) | Filesystem or S3, with presigned redirects | Through Distribution | Our `ObjectStore` |

**Recommendation: zot**, run like RustFS. It is a helper-derived, digest-pinned image, locked
down, inside `skiff-workloads.slice`. Distribution's offline GC rules it out for a platform that
pushes on every build. Harbor duplicates Skiff's database, auth and UI and does not fit a 4 GB
VPS. A native engine is attractive but not the first step (§9).

Everything Skiff-specific stays in the control plane: token issuing, naming, permissions,
deployment pins, quotas, events and UI. zot is used only for OCI storage and serving. Because of
that, swapping zot for a native engine later changes only data and the helper profile, which is
the D61/D95 pattern.

```ts
interface RegistryEngine {
  resolve(repo: string, ref: string): Promise<{ digest: string; mediaType: string; size: number }>;
  tags(repo: string): Promise<string[]>;
  tag(repo: string, digest: string, tag: string): Promise<void>;  // R11 pins
  untag(repo: string, tag: string): Promise<void>;
  deleteManifest(repo: string, digest: string): Promise<void>;
  usage(): Promise<{ repo: string; bytes: number; uniqueBytes: number }[]>;
}
```

The control plane reaches zot with a platform token it mints for itself. `tag` uses plain OCI
calls (GET the manifest, PUT it under a new tag), so no zot-specific API leaks through the seam.
Usage reads zot's search extension if the spike confirms it, and otherwise walks manifests.

---

## 3. Model

### 3.1 Tables (SQLite, `packages/db`)

```text
registry_repositories(id rr_<hex>, org_id, name, project_id NULL, description,
                      created_by, created_at, last_push_at, bytes, deleted_at)
                      UNIQUE(org_id, name)
registry_pins(repository_id, digest, deployment_id, tag)      -- R11, one per retained deployment
registry_credentials(id rc_<hex>, org_id, name, host, username, sealed_secret,
                     created_at, last_used_at, deleted_at)    -- R2, external registries
deployments.image_digest                                       -- R1
settings['registry.*']                                         -- host, node, mirrors, retention
```

Tags and manifests are **not** copied into SQLite. zot is the truth for content. Skiff keeps
ownership, links, pins and a usage snapshot, the same split as storage buckets.

### 3.2 Naming (R7)

- **Reference:** `<registryHost>/<org-slug>/<name>[:tag|@digest]`, for example
  `registry.kieran.dev/kieran/cairn:2026-11-07`.
- **The first path segment is always the org slug**, so authorization is a prefix check. `name`
  follows OCI rules: lowercase, `[a-z0-9._-]` segments, `/` allowed (`cairn/web`, `cairn/worker`),
  at most 3 segments after the org.
- **Created on first push** when the pusher holds `image:push` in that org. Deleting a repository
  is a soft delete (trash, D-trash cascade) and purge removes its manifests.
- **Project link:** `skif deploy --image` and the build path create `<org>/<project-slug>` linked to
  the project. The project's Runtime tab lists its linked repositories first.

### 3.3 Hostname and edge

- **Built:** `registry.<contentDomain>` by default, changeable in Settings. Planned as a platform
  host, it moved to the content domain because the content wildcard certificate already covers it
  and, like public S3 (D64), the registry authenticates with bearer tokens, never cookies, so the
  content domain's cookie scope gains nothing. The slug `registry` is reserved.
- **The DNS record must be DNS-only (grey cloud).** Cloudflare's proxy caps request bodies (about
  100 MB on Free and Pro), and Docker and Podman usually send a whole layer in one PATCH. The
  installer and Settings warn if the record is proxied. *(Verify the cap in spike S2.)*
- The Caddy route copies the S3 route (`compileProxyRoute`): no `max_size`, `flush_interval -1`,
  `response_header_timeout 5m`, `Host` preserved, and an upstream on the registry node over the
  overlay. Blob bytes never pass through the control plane, so the 520 MB `BODY_SIZE_LIMIT` does
  not apply.

---

## 4. Auth (R6, R8)

### 4.1 Token flow

```text
docker push registry.x/kieran/cairn:v1
  → zot: 401 WWW-Authenticate: Bearer realm="https://control.x/api/registry/token",
                                      service="registry.x", scope="repository:kieran/cairn:pull,push"
  → GET /api/registry/token?service=…&scope=…   (Basic: any-user : skif_…)
  ← { token: <ES256 JWT, 5 min, access:[{type:repository,name:kieran/cairn,actions:[pull,push]}]> }
  → zot verifies against the public cert the helper wrote into its config
```

- The token endpoint is a thin SvelteKit route over `RegistryAuthService` in `packages/core`. It
  takes Basic auth whose password is a `skif_` API key, or a dashboard session for the UI's own
  calls. It returns the **intersection** of the requested scope and the principal's effective
  permissions (key scopes ∩ current role), so a token may grant less than was asked for, as the
  token spec allows.
- **Signing key:** ES256 (P-256), sealed in SQLite. The public cert is rendered into zot's config
  by the helper. Rotating the key restarts zot (seconds) and invalidates outstanding tokens, which
  live five minutes anyway.
- **Audit:** `registry.push` (repo, tag, digest), `registry.delete`, `registry.credential.*`. Pulls
  are counted in metrics, not audited.

### 4.2 Permissions

`packages/contracts/src/permissions.ts` gains `image: ['pull', 'push', 'delete']`.

| Role | Grants |
|---|---|
| owner, admin | pull, push, delete |
| deployer | pull, push |
| viewer | pull |

`image:delete` joins `destructivePermissions`. Agent scopes (`defaultAgentScopes`) get `image:pull`
only. A CI key is minted with `image:push` (+ `deployment:create` for push-to-deploy).

### 4.3 Principals that are not users

| Principal | Credential | Can |
|---|---|---|
| **Node** | A per-node registry secret (not the node token, per D47), minted at join and rotatable | Pull only repositories referenced by its own desired state. The token service checks this against `WorkloadDesired`. |
| **Build job** | A job token minted when the build is claimed, TTL = build wall clock | Push only to the project's repository |
| **Control plane** | Self-minted platform token | `RegistryEngine` calls (resolve, tag, delete, usage) |
| **CI with OIDC** (later) | GitHub Actions OIDC token exchanged at the realm, trust set per project | Push to the linked repository, with no stored secret |

---

## 5. Deploying from an image

### 5.1 Digest pinning (R1, phase G0)

1. `WorkloadService` (or the build finalizer) resolves `image` to a digest when the deployment is
   created. Skiff's registry uses `RegistryEngine.resolve`. External registries get a manifest HEAD
   with the org's matching credential (R2).
2. The deployment stores `image` (as typed) and `image_digest`. `WorkloadDesired.image` becomes
   `<repo>@sha256:…`, so the existing `assertImage` regex already accepts it.
3. A failed resolution fails the deploy with the upstream's error. For an external image that
   cannot be resolved (rare: registries that refuse HEAD), the deploy goes ahead with the tag and
   `Pull=newer`, and the UI flags it "not pinned".
4. Rollback and promote reuse the stored digest. "Redeploy" re-resolves, which is how a moved tag
   gets picked up deliberately.

### 5.2 Credentials on the node (R2, R9)

- The helper writes `/run/skiff-workloads/<id>/auth.json` (0400 root, like D43 secrets). It merges
  the node's registry secret for `registryHost` with any external credential the workload's org
  holds for the image's host. The Quadlet gets `AuthFile=` pointing at it.
- External credentials travel through the **authenticated activation endpoint**, never through
  desired state (same rule as PITR keys and secrets).
- `registries.conf.d/50-skiff.conf`, written by the helper on every node:

```toml
[[registry]]
location = "registry.kieran.dev"
[[registry.mirror]]
location = "127.0.0.1:8085"      # loopback front → registry node over the overlay
insecure = true                  # plain HTTP on loopback only
```

  A mirror failure falls back to the public host, so a broken overlay slows pulls but does not
  break them. Port `8085` joins the CLUSTERING §4.3 range table as "registry front".

### 5.3 Surfaces

| Surface | What |
|---|---|
| CLI | `skif registry login` (calls `podman`/`docker login` with a freshly minted push-scoped key, or prints the command); `skif image ls [repo]`; `skif image rm`; `skif deploy --image <ref>` sets the workload image and deploys; `skif image push <local-ref> [--deploy]` tags into the org namespace and pushes |
| REST | `GET /registry` (host, usage); `GET/DELETE /registry/repositories[/:name]`; `GET /registry/repositories/:name/tags`; `DELETE …/tags/:tag`; `PATCH …` (project link, description); `GET/POST/DELETE /registry/credentials` |
| MCP | Read-only `list_images` / `image_tags`. Deploying an image goes through the existing workload tools. No push or delete (D29/D53). |
| Dashboard | **Registry** (sidebar, `/registry`; built): repositories with size, pushes and deploy on push, GitHub OIDC trusts, push snippet; `/registry/<org>/<name>`: tags with digest and the projects running them, pinning deployments, deploy a tag, deploy on push, CVE scan, delete tag. **Project → Runtime**: image picker from linked and org repos with tag dropdown and resolved digest. **Settings → Container registries**: platform setup (host, node, mirrors, retention, signatures, CVE, S3) and the org's external registry credentials. |
| Events | `registry.push` joins EVENTS.md sources. An optional **deploy on push** per project and tag (like the GitHub webhook path) triggers a deployment of the new digest. zot event sink if the spike confirms one, otherwise the control plane learns of pushes from the token flow plus a tag poll. |

---

## 6. Runtime and storage (R5, R10)

- **Helper profile `registry`.** Engine `zot`, version → `ghcr.io/project-zot/zot…@sha256:…` (exact
  image and digest from spike S1). Unprivileged uid, `DropCapability=all`, `NoNewPrivileges`,
  `ReadOnly=true`, `Tmpfs=/tmp`, `PublishPort=127.0.0.1:<port>:5000`, `MemoryMax` default 256 MB.
  The helper renders `config.json` itself: storage root, bearer realm and cert, GC and retention,
  sync upstreams. Nothing comes from the wire except the triple and the settings it validates.
- **Placement:** the operator picks the node in Settings → Registry, or `auto` picks a node with a
  ready disk of the `registry` kind's default tier. It is not movable on its own. A move uses the
  D97 pattern (stop → copy → verify → start).
- **Storage kind `registry`** (not built) joins STORAGE.md §2.1, with no default (the system disk)
  and a suggested `bulk`. On this fleet that means the homelab's HDD. **The prod VPS root disk
  (about 4.5 GB free) cannot hold it.**
- **Dedupe:** zot's filesystem dedupe stores each blob once across every repo *(confirm the
  mechanism and its cache in S1)*. Since v2.1.21 a blob is readable in a repo only after it was
  pushed or mounted there, which closes the cross-org "does this layer exist" probe. Pin ≥ 2.1.23.
- **Backups:** the registry directory is a backup source for the existing backup targets.
  Restoring the registry restores images; the SQLite rows already sit in the control-plane backup.

### 6.1 Retention and GC (R11)

- zot: `gcDelay 1h`, `deleteUntagged: true` after 24 h, and `keepTags: [{patterns: ["^skiff-d-"]}]`
  plus per-repo defaults (keep the newest 20 tags, keep anything pulled in 30 days). Each is
  editable in Settings.
- Skiff: when a deployment is created on a registry image it writes `skiff-d-<deploymentId>` →
  digest and a `registry_pins` row. When D13 retention drops the deployment, it removes both. So a
  digest stays while any retained or pinned deployment uses it, whatever happens to the user's
  tags.
- `skiff-d-*` tags are hidden in every list and refused for user pushes by the token service.

### 6.2 Nodes (R3)

An agent verb `pruneImages` runs after each reconcile at most hourly. It removes images not used
by any container on the node, not referenced by desired state, and not one of the last two digests
per workload (fast rollback). Images younger than 1 h are never pruned. This is also the
`node_caches` slot in OPERATIONS.md, and the planned `images` storage kind (podman `graphroot` on a
disk, STORAGE.md §8) builds on it.

### 6.3 Quotas

`usage()` feeds a per-org snapshot (`bytes` counts each unique blob once per org) into QUOTAS.md
as a new `registryBytes` dimension. Over quota, the token service refuses `push` with a clear
error; pulls are never blocked.

---

## 7. Builds that produce images (R12)

- **Build source** gains `kind: 'dockerfile'` (path, context, target, build args from project
  secrets marked build-time) beside the existing command + `outputDir`.
- **Builder:** `buildah build` runs as the unprivileged `skiff-build` user inside the D47 sandbox.
  Rootless needs subuid/subgid for `skiff-build` and user namespaces. If the sandbox blocks nested
  namespaces, fall back to `--isolation chroot` *(spike S4)*. Layer cache lives in the `builds`
  storage kind.
- **Push:** with the job token (§4.3) to `<org>/<project>:build-<buildId>`, then the build
  finalizer creates the deployment from the pushed **digest**. No zip, no release download.
- **Not now:** Railpack (needs BuildKit, pre-1.0), multi-arch builds, kaniko (archived June 2025).
  The first-party `skiff-postgres*` images stay on GHCR; Skiff's registry is for user workloads.

---

## 8. Pull-through cache (R13) and HA (R14)

**Pull-through.** zot `sync` in on-demand mode for `docker.io` (with `http.compat: ["docker2s2"]`),
`ghcr.io` and `quay.io`, each under its own prefix (`/docker.io/...`). It has optional upstream
credentials (an authenticated Docker Hub account gets 200 pulls per 6 h instead of 100). Each node's
`registries.conf` lists the loopback front as a mirror for those hosts, so engine images (D61) and
public app images come through the cache, and upstream stays the fallback. The helper's own image
pins keep their digests, so a poisoned cache cannot substitute content.

**HA.** At L0 a registry outage blocks only pulls of images a node does not already have: new
deploys of new digests, moves and fresh nodes. Running and restarting workloads are unaffected.
L1, after CLUSTERING C9:

- zot on S3 storage in a replicated RustFS bucket;
- a managed Valkey instance as zot's remote dedupe cache;
- two zot replicas on different zones behind the edge route;
- the token signing key already lives in the replicated control-plane state.

---

## 9. Alternatives considered

| Option | Verdict |
|---|---|
| **GHCR + pull secrets only** (R2 alone) | Cheap, and shipped anyway in G0. But it keeps an external dependency and costs, and git builds → image would still need GitHub. Not enough on its own for a self-hosted platform. |
| **One registry instance per org** (like RustFS, D55) | Isolation by process, but no cross-org dedupe, N copies of the same base layers, N hostnames or ports. The noisy-neighbour risk is bounded by quotas instead. Revisit for a hard multi-tenant tier. |
| **Native Bun registry** | Fits "Bun everywhere", owns the index in SQLite, can 307-redirect blob GETs to presigned RustFS URLs (HEAD must stay local), and knows deployments natively. Cost: chunked uploads, GC under concurrent pushes, referrers, client quirks, and the OCI conformance suite as the gate. The `RegistryEngine` seam keeps it possible. Revisit if zot's footprint, config model or auth integration disappoint in S1. There is no mature TS implementation to start from; olareg and go-containerregistry's `pkg/registry` are the references. |
| **Distribution v3** | Stop-the-world GC, one auth provider, no retention rules. Rejected. |
| **Harbor** | Bundles its own Postgres, Redis and UI; 4 GB RAM minimum. Rejected. |

---

## 10. Open questions

| # | Question | Recommendation |
|---|---|---|
| Q1 | zot first, or go straight to a native Bun registry? | zot behind the seam (R5) |
| Q2 | One install-wide registry, or one per org? | Install-wide (R4) |
| Q3 | Hostname: `registry.<platformDomain>`, or on the content domain? | Platform domain, DNS-only |
| Q4 | Ship G0 (digests, external credentials, prune) before the registry? | Yes. It fixes Cairn's deploy today. |
| Q5 | Allow anonymous public repositories? | Not in G1. Later, a per-repo `public` flag like D64. |
| Q6 | Should Skiff's own first-party images move off GHCR? | No. Installs bootstrap before their registry exists. |

---

## 11. Spikes

| # | Prove | Pass |
|---|---|---|
| S1 | zot in the `registry` profile on Debian 13: RSS idle and under a 2 GB push, filesystem dedupe across two repos, online GC during a push, `keepTags` regex, the exact image and digest, and whether the search extension gives sizes | < 150 MB idle; no corrupt pull after GC; dedupe halves stored bytes for a shared base |
| S2 | Push and pull of a 1.5 GB layer through edge Caddy over WireGuard, with Docker 28 and Podman 6.1 clients; a Cloudflare-proxied hostname as a negative test | Grey-cloud passes and proxied fails, with a clear error |
| S3 | Token realm: Docker, Podman, buildah, `crane` and GitHub's `docker/login-action` against Skiff-issued ES256 tokens, including reduced-scope grants | All push and pull. A reduced scope gives a 403, not a hang. |
| S4 | buildah rootless inside the D47 sandbox (subuid, userns, `--isolation chroot`), plus layer cache reuse | A Dockerfile build pushes and deploys by digest |
| S5 | `registries.conf` loopback mirror + `AuthFile=` per Quadlet, and fallback when the overlay is down | A pull succeeds both ways. The auth file is never readable by the workload. |
| S6 | OCI conformance suite (`OCI_VERSION=1.1`) against the deployed zot with Skiff tokens | Pull, push, discovery and management all pass |

---

## 12. Phases

| Phase | Scope |
|---|---|
| **G0** | **Done:** R1 digest pinning (`imageDigest` on the deployment spec, D145); R2 org registry credentials + per-workload `--authfile` via activation (D146; REST, `skif registry credentials`, Settings → Container registries); R3 hourly node image prune (D147); `POST /projects/:slug/deploy-image` and `skif registry deploy`. Moves Cairn off `docker save \| ssh`. Not yet: one-off jobs (`podman run --pull=missing`) reuse the app's already-pulled image but carry no auth file. |
| **G1** | **Done:** spikes S1–S3 on zot 2.1.23 under Docker (ES256 tokens from Skiff's realm, scoped push/pull, `docker2s2`, the events extension, ~48 MiB idle, locked-down run as uid 65532); `registry` helper profile (D154); Settings → Container registries (enable, node, host, retention; repositories); token realm + `image:*` + per-workload node logins (D155); repositories table and push events (D156); Caddy route via the public-S3 route type; deploy-time pinning against the own registry; `skif registry status|login|repos|tags|untag|deploy`. **Not yet:** the loopback mirror (R9; nodes pull through the public host), a `registry` storage kind (the data dir is the node's helper state dir, so choose a node with disk), S5/S6 (Podman node pull and the OCI conformance suite on a Linux node). |
| **G2** | **Done (D157):** `skiff-d-<deployment>` pins on every own-registry deployment (`registry_pins`, swept when the deployment row goes); deploy on push (`registry_repositories.deploy_project_id/deploy_tag`, `PATCH /registry/repositories`, `skif registry autodeploy`); `registry.push` events; hourly size sampling and the `registryBytes` quota (push refused at the realm); project image picker; MCP `list_images` / `image_tags`. |
| **G3** | **Done (D158):** images build in Pipelines (`skiff/build-image`, docs/PIPELINES.md; BuildKit/buildah/podman/docker backends) and push with the job's own login (`job.<jobId>`); `registry/<name>` tags; GitHub Actions OIDC trusts (`/registry/trusts`, `skif registry trust`). |
| **G4** | **Done (D159):** zot `sync` on demand for docker.io/ghcr.io/quay.io under `<upstream>/…`; nodes get `registryMirror` in desired state and the helper writes `registries.conf.d/50-skiff-mirror.conf` plus a `node.<id>` login in `/run/containers/0/auth.json`; workload logins cover the mirrors. |
| **G5** | **Done (D159):** zot trust extension; cosign keys uploaded as the htpasswd admin; `signatures: off|warn|enforce` checked at deploy through zot's search API; CVE scanning toggle with `GET /registry/scan` and `skif registry scan`. Not built: Podman `policy.json` verification on nodes. |
| **G6** | **Done (D159), single replica:** S3 storage with a Redis/Valkey cache, so moving the registry to another node needs no data copy. Not built: zot `cluster` mode (several active replicas). |

---

## Sources (accessed 2026-11-07)

- OCI distribution spec and conformance suite: https://github.com/opencontainers/distribution-spec
- Docker token auth: https://distribution.github.io/distribution/spec/auth/token/
- zot storage, retention, auth, mirroring, signatures: https://zotregistry.dev/v2.1.23/articles/storage/ · /retention/ · /authn-authz/ · /mirroring/ · https://zotregistry.dev/v2.1.22/articles/verifying-signatures/
- zot releases: https://github.com/project-zot/zot/releases
- Distribution GC and S3 driver: https://distribution.github.io/distribution/about/garbage-collection/ · https://distribution.github.io/distribution/storage-drivers/s3/
- Harbor prerequisites: https://goharbor.io/docs/main/install-config/installation-prereqs/
- Docker Hub pull limits: https://docs.docker.com/docker-hub/usage/pulls/
- registries.conf, auth.json, policy.json: https://github.com/containers/image/tree/main/docs
- Quadlet units: https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html
- BuildKit rootless: https://github.com/moby/buildkit/blob/master/docs/rootless.md · kaniko archive: https://github.com/GoogleContainerTools/kaniko · Railpack: https://github.com/railwayapp/railpack
- Reference implementations: https://github.com/olareg/olareg · https://pkg.go.dev/github.com/google/go-containerregistry/pkg/registry

---

## 13. What is not built

| Item | Why |
|---|---|
| Several active registry replicas (zot `cluster`) | zot's scale-out mode drops the trust and CVE extensions and needs members reachable on the overlay; S3 + moving the single replica covers node loss today. |
| Podman `policy.json` signature checks on nodes | Podman's reading of cosign v3 referrer bundles is unconfirmed; Skiff checks signatures at deploy time instead. |
| A `registry` storage kind (STORAGE.md) | The data dir is the registry node's helper state dir; choose a node with disk, or S3. |
| R9 loopback mirror for own-registry pulls | Nodes pull own images through the public host; the G4 mirror covers upstream registries. |
| S5/S6 on a Linux node | Podman node pulls and the OCI conformance suite were not run on Debian; the end-to-end test (`tests/e2e/registry-pipeline.e2e.ts`) uses Docker on macOS. |
