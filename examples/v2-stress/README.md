# v2-stress

An example project that exercises every new axis of Skiff v2: process workloads, container
workloads, per-node placement and admission, just-in-time secrets, `/data` persistence, git builds,
named environments, custom domains, and the HTTP path through Caddy to a live app.

The app is deliberately dependency-free Bun. The scripts treat Skiff as a black box and use only
the public REST and agent APIs, so they double as a smoke test for a fresh install and as a
reproducer when a v2 feature misbehaves.

| Piece                  | What it is                                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| `src/server.ts`        | Tier-2 app: health, info, data, secrets, CPU/memory/SSE/large/status/crash endpoints                       |
| `scripts/provision.ts` | Creates the project, workload spec, secrets, environment, git source, domain and a deployment through REST |
| `scripts/stress.ts`    | Black-box conformance + load + distributed-state checks against the deployed URL                           |
| `container/`           | Tier-3 variant: Dockerfile and instructions                                                                |
| `.state.json`          | Local, gitignored, `0600` state (ids, secret **digests**, webhook secret)                                  |

## What it stresses

| v2 feature               | How this project exercises it                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Tier-2 process runtime   | `bun server.js` in a sandboxed unit, loopback port, health probe                                                |
| Tier-3 container runtime | Same app as a read-only, cap-drop-all Quadlet container                                                         |
| Placement + admission    | Explicit placement, memory/CPU budget recorded in the node slice                                                |
| `/data`                  | SQLite counter that survives restarts and redeploys                                                             |
| Env + secret injection   | Public env plus one env secret and one file secret (`*_FILE`)                                                   |
| JIT activation           | `--node-token` checks the desired state has refs only, then compares the activation digest with the running app |
| Resource limits          | `/api/cpu`, `/api/memory`, and `--crash` against `MemoryMax` / `CPUQuota` / restart policy                      |
| Health + readiness       | `/healthz` and `/healthz?strict=1` (fails when `/data` is unavailable)                                          |
| Proxy correctness        | Host header, 4xx/5xx passthrough, 512 KiB response digest, SSE streaming                                        |
| Git builds               | `--git-repo` configures a public HTTPS source, build command and output dir                                     |
| Environments             | Creates `staging` and verifies `<slug>--staging.<contentDomain>`                                                |
| Custom domains           | Attaches a hostname and prints the TXT/CNAME records                                                            |
| Load + concurrency       | Configurable request sample and concurrent SQLite writes                                                        |

## Quick start

From the repository root:

```sh
# 1. Build and run locally (no Skiff needed)
bun examples/v2-stress/src/server.ts            # http://127.0.0.1:3000
bun examples/v2-stress/scripts/stress.ts --base http://127.0.0.1:3000 --skip-load

# 2. Provision on a platform (API key with project/build/secret rights)
export SKIFF_URL=https://control.example.com
export SKIFF_TOKEN=skif_…
bun examples/v2-stress/scripts/provision.ts --slug v2-stress

# 3. Stress the deployed app
export SKIFF_NODE_TOKEN=…                       # optional: desired-state/activation checks
bun examples/v2-stress/scripts/stress.ts --base https://v2-stress.<contentDomain>
```

`provision.ts` writes `examples/v2-stress/.state.json` with the project id, workload id,
deployment id, secret digests and (when git is configured) the webhook secret. The stress script
reads it by default, so the second command usually needs only `--base` if you pass it explicitly
or nothing at all after provisioning.

### Local run details

The app binds `HOST`/`PORT` (`127.0.0.1:3000` by default). To exercise secrets locally:

```sh
printf 'local-file-secret' > /tmp/v2-stress-secret
STRESS_ENV_SECRET=local-env-secret \
STRESS_FILE_SECRET_FILE=/tmp/v2-stress-secret \
STRESS_ENV=local STRESS_BUILD=dev \
bun examples/v2-stress/src/server.ts
```

and pass `--secrets --expect-env local --secret-env-sha <sha256>` to the stress script. Without a
Skiff workload, `/data` is not mounted; the app falls back to `./.stress-data` (or memory) and says
so in `/api/info` and in the stress report.

## Provisioning options

```sh
bun examples/v2-stress/scripts/provision.ts --help
```

The important ones:

| Flag                             | Default              | Notes                                                                       |
| -------------------------------- | -------------------- | --------------------------------------------------------------------------- |
| `--slug`                         | `v2-stress`          | Project runtime cannot change after creation                                |
| `--runtime`                      | `process`            | `container` requires `--image`                                              |
| `--placement`                    | `edge`               | `edge`, `auto` or a node id/name                                            |
| `--memory` / `--cpus` / `--port` | `256` / `1` / `3000` | Admission and `MemoryMax`/`CPUQuota`                                        |
| `--data`                         | `128`                | `/data` size in MB; `0` disables the mount                                  |
| `--environment`                  | `staging`            | Creates `<slug>--staging.<contentDomain>`                                   |
| `--domain`                       | —                    | Attaches a custom host and prints the records                               |
| `--git-repo`                     | —                    | Public HTTPS repo; the Builder runs `bun run build` in `examples/v2-stress` |
| `--rotate-secrets`               | off                  | Creates a new version of both secrets                                       |
| `--no-deploy`                    | off                  | Configure only                                                              |
| `--require-running`              | off                  | Fail provisioning if the workload never reaches `running`                   |

Re-running is safe: the project is reused, the workload spec is updated, existing secrets and
environments are kept, and a fresh deployment is created. A workload spec change is applied on the
next deploy, which is exactly what the script does.

### Git builds

Point it at a public HTTPS copy of this repository:

```sh
bun examples/v2-stress/scripts/provision.ts --slug v2-stress \
  --git-repo https://github.com/<you>/<repo>.git \
  --git-branch main \
  --git-root examples/v2-stress \
  --git-command "bun run build" \
  --git-output dist
```

It prints the webhook URL (`/api/webhooks/github/<slug>`) and a generated secret. Add both to
GitHub and push; the Builder clones, runs `bun build src/server.ts --target=bun --outfile
dist/server.js`, uploads the artifact and finalises through the normal deploy path. `Build now` in
the dashboard (or `POST /api/v1/projects/<slug>/builds`) does the same without a push.

### Environments and promotion

The script creates `staging` but deploys production only. Deploy a second artifact into staging
with the REST API and promote it:

```sh
# build first
bun run --cwd examples/v2-stress build

# the deploy endpoint takes inline files; the CLI zips a directory instead
# (see docs/API.md for the presigned upload flow)
curl -sS -X POST "$SKIFF_URL/api/v1/projects/v2-stress/deploy" \
  -H "authorization: Bearer $SKIFF_TOKEN" \
  -H "origin: $SKIFF_URL" \
  -H 'content-type: application/json' \
  -d '{"environment":"staging","promote":true,"files":[{"path":"server.js","content":"…","encoding":"base64"}]}'
```

Only production moves `projects.productionDeploymentId`; staging has its own pointer. v2 runs one
workload per project, so environment hosts serve the project workload rather than a second unit.

### Custom domains

`--domain app.example.com` creates the domain and prints:

```
TXT   _skiff.app.example.com → skiff-verify=…
CNAME app.example.com        → v2-stress.<contentDomain>
```

Create the records, then `--check-domain` (or the dashboard's **Check DNS**) verifies them. A
verified host is served with on-demand TLS; the same production route answers.

## Running the stress suite

```sh
bun examples/v2-stress/scripts/stress.ts \
  --base https://v2-stress.<contentDomain> \
  --requests 500 --concurrency 32 --p95 750
```

Full checks:

- health, strict health, runtime identity, public env
- both secret digests (never the values)
- data read/write and concurrent writes without lost increments
- request echo, proxy Host header, 512 KiB response digest
- 404/418/500 status passthrough
- SSE ticks over a live stream
- CPU loop and optional memory allocation
- request sample with p50/p95/p99 and req/s
- optional control plane: project/workload/deployment/environment/capacity state
- optional node view: desired state contains refs only, activation values never leak, activation
  digests match the running app
- optional `--crash`: the app restarts, `/data` survives and the workload returns to `running`

The exit code is non-zero on any failed check, so it drops into CI or a deploy gate.

### Interpreting failures

| Symptom                                           | Likely cause                                                                                 |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `workload status: expected running, got starting` | Health path never answered, or the agent/helper is not installed on the node                 |
| `secret is not injected`                          | The project spec references a name with no value, or `delivery` mismatches (`env` vs `file`) |
| `activation matches the running app` fails        | A secret was rotated but the workload was not restarted (activation is JIT by design)        |
| `counter did not grow`                            | No `/data` mount (`--data 0`) or the app fell back to memory; see `config.data.kind`         |
| p95 above budget                                  | CPU quota too low, cold node, or the load generator shares the machine                       |
| 502/503 from the proxy                            | Workload is `failed`, restarting, or Caddy's upstream is stale; check the Runtime tab        |
| Host header mismatch                              | Testing the origin directly instead of the deployed host                                     |
| `capacity is platform-admin only`                 | Use an admin user's token, or drop the capacity check                                        |

`--memory 200` with a 256 MB workload is intentionally destructive: it either succeeds (the app
releases the buffer) or the kernel kills the unit and the report fails with a timeout. That is the
`MemoryMax` test, not a harness bug.

## Security notes

- This app is a test surface. `POST /api/crash`, `/api/exec`-style endpoints and unbounded-ish
  allocations do not belong in anything real; put it behind platform access or a private host.
- Secret values are never printed and never written to `.state.json`; only their SHA-256 digests
  are stored. The provision script generates values and sets them once.
- `.state.json` contains the GitHub webhook secret when git is configured. It is gitignored and
  written `0600`; rotate the secret if it leaks.
- The node token used for desired-state/activation checks is a machine credential. Keep it in the
  environment, not in a file that gets committed.

## Deliberate limits

- **`socketActivation: false`.** Bun 1.4 can listen on a unix path but cannot adopt systemd's
  inherited listen fd. The provision script opts into loopback instead of pretending the default
  works. If a future Bun release adds fd adoption, flip the field and remove the guard at the top of
  `src/server.ts`.
- **One workload per project.** Environments share the project workload (D44); preview runtimes are
  deferred. The staging check therefore verifies host/pointer state, not a second process.
- **Public HTTPS git only.** Per-project private-repo credentials are not in v2; use a public mirror
  or a Builder-side deploy key.
- **Bun must be on the workload PATH.** The spec runs `bun server.js`, so the node's Bun needs to be
  visible to systemd (`/usr/local/bin/bun` is the helper default; this repo's installer currently
  puts it in `/opt/skiff/runtime/bin/bun`). If yours differs, provision with
  `--command "/opt/skiff/runtime/bin/bun server.js"` or rely on the helper's default
  `bun run start` once the installer wiring lands.
- **DNS is manual.** The example prints the records; verification is on demand.
