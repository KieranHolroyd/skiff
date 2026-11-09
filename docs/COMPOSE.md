# Compose stacks (level 4)

Yoal has four deploy levels. The level is a **product** view of a project's runtime; the runtime
column, the helper and the security model are unchanged.

| Level | Runtime | What runs | Deploy input |
|---|---|---|---|
| 1 | `static` | Files served by Caddy from an immutable release | A directory or zip |
| 2 | `process` (and `function`) | One sandboxed Bun/Node systemd unit, or a managed workerd bundle | A release; functions add `wrangler.jsonc` |
| 3 | `container` | One OCI image in a rootless Podman Quadlet | An image reference |
| 4 | `compose` | A group of containers from a `docker-compose.yml`, on one private network | The compose file |

Level 4 is for the long tail prose that is awkward to split into several projects: a web app plus
its worker, a small database, a cache, an object-store sidecar. Every service is still a level-3
container; compose only adds grouping, ordering and routing.

## Creating and deploying

```sh
# A project is created with the level-4 runtime once.
yoal projects create shop --runtime compose

# A compose file in the directory is detected and deployed; `--no-compose` deploys the
# directory as a static site instead.
cd shop
yoal deploy

# Or name the file explicitly.
yoal deploy --compose ./docker-compose.yml
```

The REST surface is `POST /api/v1/projects/:slug/deploy-compose` with `{ document, promote,
message, environment }`. The CLI and REST both call the same core service. A deploy is a normal
deployment: it gets a preview URL, can be promoted, and rollback restores the whole stack (the
workload snapshot contains every service).

## Supported subset

A compose file is a deployment input, not a general escape hatch. The parser maps this subset and
reports every other key at its exact path:

- `services.<name>.image` — a prebuilt image; `build:` is not supported.
- `command` — an argv list, or a simple shell-form string split without expansion. There is no
  shell in the container command; `sh -c "…"` only works if you ask for it explicitly.
- `environment` — a mapping or `KEY=value` list. A bare `KEY` with no value is ignored with a
  warning; set it in the project environment instead.
- `depends_on` — list or mapping. Ordering is `After=` + `Requires=`, not a health wait.
- `ports` / `expose` — the **container** port only (`"8080"` or `"8080:80"`). A port is reachable
  inside the stack network either way; only a port named in `x-yoal.routes` is public. Host ports
  and host IPs are assigned by Yoal; UDP, ranges and `127.0.0.1:…` bindings are refused.
- `volumes` — named volumes only (`uploads:/app/uploads`, optional `:ro`). A top-level `volumes:`
  declaration is preferred; an implicit one is accepted with a warning. Bind mounts, host paths,
  anonymous volumes and device paths are refused.
- `deploy.resources.limits.memory` and `.cpus` — translated to the same `MemoryMax`/`CPUQuota`
  and whole-stack admission as a level-3 project.
- `x-yoal.healthPath` per service and `x-yoal.routes` at the top level (below).

Presentational keys (`container_name`, `restart`, `labels`, `healthcheck`, `tty`, …) are ignored
with a warning because systemd owns the lifecycle. Anything that widens the container's privilege
or reaches the host is unsupported: `build`, `privileged`, `network_mode`, `cap_add`/`cap_drop`,
`devices`, `pid`, `ipc`, `env_file`, `secrets`, `configs`, `extends`, `profiles`, `entrypoint`,
`platform` and unknown keys. A deploy refuses when there is at least one unsupported entry; it
never runs a partial stack.

## Routing

Every service joins the project's workload network and is addressable by its service name:
`web` can reach `postgres:5432` or `redis:6379` without any extra configuration. A route says which
service port is public:

```yaml
x-yoal:
  routes:
    - service: web
      port: 3000
      primary: true          # serves <slug>.<contentDomain> and the project's custom domains
      healthPath: /healthz
    - service: api
      port: 8080
      host: api-app.examplecloud.com
```

- The **primary** route serves the project's own host (`<slug>.<contentDomain>`), its preview
  URLs and its verified custom domains. Exactly one route is primary; when no route is marked,
  the first one is.
- A secondary route with a `host` serves that hostname; without one it serves
  `<slug>--<service>.<contentDomain>`. Hosts must be a single label under the content domain so
  the existing wildcard certificate covers them. Verified per-service custom domains are a later
  surface; today a project's custom domain follows the primary service.
- Each exposed route gets a stable loopback port (30000–39999) assigned at deploy. Only that
  service publishes a host port; every other container is reachable only from the stack network.
- `healthPath` is the HTTP probe for that route. Caddy routes by `Host`; path-based routing is not
  part of this slice.

If the file declares no routes, the first service with a `ports:` entry is exposed on the project
host and a warning says so.

## Networking and isolation

Services use the same private Podman network as every other workload in the organisation
(`yoal-org-<orgId>`, or the shared `yoal-workloads` network when `ORG_NETWORKS` is off). Attached
managed databases, storage and brokers are reachable by their normal aliases, so
`DATABASE_URL=postgres://…@db-<id>:5432/…` works exactly as it does for a level-2 or level-3 app.
Cross-stack traffic inside an organisation is already possible for every runtime; a per-stack
network is a later hardening step, not a promise this slice makes.

Containers keep every level-3 confinement: rootless user namespace, `DropCapability=all`,
`NoNewPrivileges`, read-only root, no host paths. Named volumes are directories under the
workload's private state directory, not host bind mounts.

## Resource accounting

Admission sums every service's `memoryMb` and `cpus`; the stack is one workload row and one
slice reservation. Per-service limits are still enforced by each Quadlet (`MemoryMax`,
`CPUQuota`). A stack that does not fit the node fails at deploy with the normal admission error,
before anything is written.

## Secrets and environment

The compose file carries **plain configuration only**. A service's `secrets:` list names project
or organisation secrets (UPPER_SNAKE_CASE); the value is resolved at activation and delivered as an
environment variable. A compose stack shares one project secret store, so every service in the
stack can see the activation environment; that is the stack's trust boundary. File-delivery
secrets are not supported by compose yet.

`environment` values are visible configuration and must not hold credentials. Use a project secret
reference instead.

## Rollback and previews

The release of a compose deploy is a one-file marker (`yoal-compose.json`) that records the
normalised stack; the services live in the deployment's workload snapshot. Promote, rollback and
environment pointers work like every other runtime. A preview URL serves the primary route only;
secondary service hosts follow the production pointer.

## Limits and next steps

- No image digest pinning yet: services run the tag in the file. Pinning each image is the next
  step and will use the same registry path as level 3.
- No per-service custom domains or path-based routing. Both need a verified domain record per
  service rather than a hostname string in the compose file.
- No `build:`, no host mounts, no privileged containers, no compose `secrets`/`configs`.
- One replica per service. Scaling a single service is a compose-file change; horizontal replicas
  of a stack are out of scope.
