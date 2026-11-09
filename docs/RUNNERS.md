# Workers and GitHub Actions runners

Plan 21 · Decisions D89–D93

Skiff runs three kinds of project: static sites, HTTP apps (process or container), and **workers**.
A worker is a process or container with no public route and no port. It only makes outbound
connections: a queue consumer, a chat bot, a sync job, or a CI runner.

The first worker with built-in support is a **GitHub Actions self-hosted runner pool**, created from
the **GitHub Actions runner** template.

## Quick start

1. In GitHub, create a credential that can register self-hosted runners:
   - **Fine-grained personal access token**: repository permission *Administration: write* for one
     repository, or organisation permission *Self-hosted runners: write* for an organisation.
   - Or a **GitHub App** with the same permission, installed on the repository or organisation. You
     need its App ID, the installation ID (from the installation URL) and a private key (`.pem`).
2. In Skiff, open **Projects → From template → GitHub Actions runner** (or go straight to
   `/new/github-actions-runner`). Fill in the owner, the repository (or choose *A whole
   organisation*), the credential, the number of runners and memory per runner. The launch plan
   beside the form shows the secrets, the memory the pool reserves and the `runs-on:` line before
   anything is created; platform admins also see which nodes have room.
3. Skiff creates the project, stores the credential as a project secret, and deploys. Within a few
   seconds the runners appear under **Settings → Actions → Runners** in GitHub.
4. Use them in a workflow:

   ```yaml
   jobs:
     build:
       runs-on: [self-hosted, linux]
   ```

   Extra labels from the form (for example `X64` or `gpu`) can be added to `runs-on`.

The same flow is available over REST:

```sh
curl -X POST https://skiff.example.com/api/v1/templates/github-actions-runner \
  -H "Authorization: Bearer $SKIFF_TOKEN" -H 'content-type: application/json' \
  -d '{"values":{"name":"CI runners","owner":"acme","repo":"api","replicas":2,"existingSecret":"ACME_RUNNER_PAT"}}'
```

`existingSecret` names a project or organisation secret that already holds the token or key. Use it
to keep the credential out of request bodies and shell history.

## How it works

```
GitHub ◀── generate-jitconfig ── control plane ── activation (JIT config) ──▶ agent ──▶ helper ──▶ runner container
   ▲                                    │                                         │
   └──────────── long poll for jobs ────┼─────────────────────────────────────────┘
                                        └─ PAT / App key: read only here, never sent to a node
```

- **One container per job (D91).** Each replica is a Quadlet container with `Restart=no` that runs
  `/home/runner/run.sh` with a single-use JIT config. After one job the runner exits. The agent sees
  the clean exit on its next heartbeat (≤ 10 s), fetches a new activation, and the control plane
  mints a new JIT config for that replica. Quadlet recreates the container from the image, so no
  job ever sees another job's files.
- **The credential stays on the control plane (D93).** The PAT or App private key is a secret
  *reference* in the runner profile, not in `secrets`. Only the control plane reads it, to call
  GitHub. Nodes receive only the single-use JIT config, through the activation endpoint, and keep
  it in memory and a `0400` env file. Desired state never contains it.
- **Cleanup.** Before minting a replica's next runner, the control plane deletes that replica's
  previous registration. Deleting or purging the project deregisters whatever is left. GitHub also
  removes offline ephemeral runners on its own. `skif runners prune` (or
  `skif prune --only runner_registrations`) removes registrations a crash or a shrunk pool left
  behind after `runnerRegistrationRetentionDays` (default 7, Settings → Retention & defaults);
  registrations a live workload still expects are never touched.
- **Failures back off.** A clean exit (job done) is replaced immediately. A failed start (bad
  credential, broken image) takes the agent's normal 60 s retry. The project's Runtime tab shows the
  GitHub error, for example *GitHub rejected the credential*.

## Sizing and placement

- `memoryMb` and `cpus` apply **per runner**. Admission reserves `memoryMb × replicas` in the node's
  workload slice (D90). The whole pool runs on one node, chosen once at deploy time.
- Builds are heavy. Prefer a worker node with a large slice (`placement: auto` picks the worker with
  the most free budget).
- The image defaults to `ghcr.io/actions/actions-runner:latest`, pulled with `Pull=newer` on every
  recycle so runners stay current. A custom image must be based on `actions/runner` and keep
  `/home/runner/run.sh`.

## Limits in this version

- **No Docker inside jobs.** Runners are unprivileged containers in a user namespace of their own,
  with every capability dropped and `NoNewPrivileges`. `docker build`, `container:` jobs and
  `services:` do not work, and neither does `sudo`. Use actions that install toolchains into the
  workspace (`setup-node`, `setup-bun`, `setup-go`, …). An opt-in rootless Podman socket is the
  reserved follow-up (plan 21 §Later).
- **github.com only.** GitHub Enterprise Server is not supported yet.
- **Fixed pool.** Runners do not scale to zero on demand. Scale manually on the Worker card.
- **Public repositories.** GitHub advises against self-hosted runners on public repositories: a pull
  request from a fork can run code on your node. Keep runners on private repositories, or require
  approval for fork workflows.

## Generic workers

Any process or container project can become a worker on the **Runtime → Worker** card (or with
`"ingress": "none"` in `PUT /projects/:slug/workload`):

- no Caddy route, no preview URL, no published port;
- health is "the unit is active" instead of an HTTP probe;
- `replicas` (1–20) runs identical copies on the same node. Replica 0 keeps the workload id; the
  others are `<id>-r<n>` in desired state, logs and heartbeats.
