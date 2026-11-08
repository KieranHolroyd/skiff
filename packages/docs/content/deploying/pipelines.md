---
title: Pipelines
description: Run GitHub-Actions-style workflows on your own build nodes to test, build images and binaries, and deploy.
---

Pipelines run workflows from your repository on Skiff's build nodes: tests on every push, container images, release binaries, and deploys to your projects. A workflow is a YAML file in `.skiff/workflows/` written in the same syntax as GitHub Actions, so most existing workflows move over with small edits. Use pipelines when a single build command (see [Git builds](/deploying/git-builds)) is not enough: several jobs, a matrix, secrets, caches or an image build.

## Quick start

1. Make sure at least one node has the **Builder** role (**Nodes → Edit node**). Pipelines run on the same nodes as git builds.
2. In the dashboard open **Pipelines → Add repository**. Give it a name, the clone URL and, for GitHub, a webhook secret of at least 16 characters.
3. Add a workflow to the repository:

   ```yaml
   # .skiff/workflows/ci.yml
   name: ci
   on:
     push: { branches: [main] }
     pull_request: {}
     workflow_dispatch: {}
   jobs:
     test:
       runs-on: linux
       steps:
         - uses: actions/checkout@v4
         - uses: actions/cache@v4
           with:
             path: ~/.bun/install/cache
             key: bun-${{ hashFiles('bun.lock') }}
         - run: bun install --frozen-lockfile
         - run: bun test
   ```

4. In GitHub, open **Settings → Webhooks → Add webhook**. Use the **Webhook URL** shown on the repository page, content type `application/json`, the same secret, and the **push** and **pull request** events.

Push a commit and the run appears under **Pipelines → your repository**. You can also start a run by hand with **Run workflow**, `skif workflow dispatch <repo> ci.yml`, or the REST API.

## How a run works

When a push, pull request, schedule or manual dispatch arrives, a build node clones the repository at that commit and reads `.skiff/workflows/*.yml`. Every workflow whose `on:` matches becomes a **run**. A run's jobs form a graph through `needs:`. A job is claimed by a build node whose labels include everything in its `runs-on:`, and its steps run one after another in the same workspace, so files, `PATH` changes and exported variables carry from step to step.

Invalid workflow files are not ignored: they show up as a failed run listing each problem with its location, such as `jobs.build.steps[2].uses`.

## Workflow syntax

Skiff supports this subset of GitHub Actions. An unsupported key is an error rather than being silently ignored.

| Area | Supported |
| --- | --- |
| Triggers | `push`, `pull_request` (with `types`), `workflow_dispatch` with typed `inputs`, `schedule` |
| Filters | `branches`, `tags`, `paths` and their `-ignore` forms |
| Jobs | `needs`, `if`, `runs-on`, `strategy.matrix` (with `include`/`exclude`), `fail-fast`, `max-parallel`, `outputs`, `env`, `defaults.run`, `timeout-minutes`, `continue-on-error`, `concurrency`, `environment`, `container`, `services` |
| Steps | `run`, `shell`, `working-directory`, `uses` (built-in, remote, local, composite and JavaScript actions), `with`, `env`, `id`, `if`, `continue-on-error`, `timeout-minutes` |
| Reuse | Job-level `uses: ./.skiff/workflows/<file>.yml` with `with` and `secrets` (see [Reusable workflows](#reusable-workflows)) |
| Expressions | `${{ }}` with the `skiff` (alias `github`), `env`, `vars`, `secrets`, `inputs`, `matrix`, `strategy`, `needs`, `steps`, `job` and `runner` contexts, and the functions `contains`, `startsWith`, `endsWith`, `format`, `join`, `toJSON`, `fromJSON`, `hashFiles`, `success`, `failure`, `always`, `cancelled` |

Steps can write `$SKIFF_OUTPUT`, `$SKIFF_ENV`, `$SKIFF_PATH` and `$SKIFF_STEP_SUMMARY`. The `GITHUB_*` names point to the same files, so existing scripts keep working. `::add-mask::`, `::group::`, `::error::` and `::warning::` work as on GitHub.

`runs-on: ubuntu-latest` (or any `ubuntu-*`/`debian-*` label) is treated as `linux`, and `self-hosted` always matches.

### Built-in actions

These built-in actions cover the common cases, and the GitHub names on the left run the Skiff version automatically, whatever version you wrote:

| You write | Runs | What it does |
| --- | --- | --- |
| `actions/checkout` | `skiff/checkout` | The workspace is already checked out at the run's commit; this step confirms it. |
| `actions/cache` | `skiff/cache` | Restores `path` by `key` / `restore-keys`, sets `cache-hit`, and saves at the end of a successful job. |
| `actions/upload-artifact` | `skiff/upload-artifact` | Stores files from `path` under `name` for 30 days (or `retention-days`). |
| `actions/download-artifact` | `skiff/download-artifact` | Fetches artifacts from earlier jobs of the same run. |
| — | `skiff/deploy` | Deploys to a linked project: `image` for a container project, or `path` (a directory) for a static, process or function project. |
| — | `skiff/build-image` | Builds a Dockerfile and pushes it; see below. |
| — | `skiff/image-index` | Joins per-architecture images into one multi-arch image. |
| — | `skiff/oidc-token` | Gives a trusted job an OIDC ID token for cloud federation. |

### Other actions

Any other `uses:` runs the action itself:

- `owner/repo@ref` or `owner/repo/path@ref` is downloaded from GitHub. Pin a full commit SHA: the log notes any action that isn't pinned. Private actions download with a repository secret named `ACTIONS_GITHUB_TOKEN`.
- `./path` runs an action from your own repository.
- **Composite** actions run their steps inside the calling step. **JavaScript** actions (`node16`, `node20`, `node24`) run with `node` from the job image, including `pre` and `post` steps, and the usual `@actions/core` features (outputs, `exportVariable`, `addPath`, `setSecret`, state) work.
- **Docker** actions do not run. Use a step with `run:`, or run that workflow on a [GitHub Actions runner pool](/compute/apps-and-containers) hosted on Skiff.

Actions that call the GitHub API with `${{ github.token }}` get an empty token, because Skiff has none to give them.

## Reusable workflows

A job can call another workflow file from the same commit instead of running steps:

```yaml
# .skiff/workflows/ci.yml
jobs:
  test: { runs-on: linux, outputs: { version: "${{ steps.v.outputs.version }}" }, steps: [{ id: v, run: ./version.sh }] }
  deploy:
    needs: test
    uses: ./.skiff/workflows/deploy.yml
    with: { version: "${{ needs.test.outputs.version }}" }
    secrets: inherit
```

```yaml
# .skiff/workflows/deploy.yml
on:
  workflow_call:
    inputs:
      version: { type: string, required: true }
    outputs:
      url: { value: "${{ jobs.release.outputs.url }}" }
jobs:
  release: { runs-on: linux, outputs: { url: "${{ steps.d.outputs.url }}" }, steps: [{ id: d, run: echo "url=…" >> "$SKIFF_OUTPUT" }] }
```

The called jobs appear in the run as `deploy--release` and see the call's `with:` as `inputs`. A called workflow gets no secrets unless the caller passes them, either `secrets: inherit` or a map such as `KEY: ${{ secrets.DEPLOY_KEY }}`. `needs.deploy.outputs.url` comes from the callee's `on.workflow_call.outputs`. Calls can nest four levels deep. Only local files (`./.skiff/workflows/…`) can be called, and a calling job cannot have a matrix yet.

## Secrets, variables and environments

Add secrets under **Pipelines → repository → Settings → Secrets** or with `skif secret set <repo> NAME`. Values are encrypted with your organisation's key and delivered only to running jobs, and every value is masked as `***` in logs. Variables (the `vars` context) are plain, visible configuration.

An **environment** gates the dangerous parts. A job that names `environment: production` gets that environment's secrets in addition to the repository's. The environment can:

- allow only some refs, for example `refs/heads/main` or `refs/tags/v*`;
- require approval: the job waits until an org owner or admin clicks **Approve**.

Release signing keys and production deploy credentials belong in an environment, not in repository secrets.

## Pull requests from forks and inline workflows

A pull request whose branch lives in another repository runs **untrusted**. It gets no secrets, cannot use environments, cannot deploy, and reads only the default branch's cache, never writing to it. Only open pipelines on public repositories if you accept that anyone can run code on your build nodes this way.

A workflow sent inline (`skif workflow run --file`, or **Run workflow → inline YAML**) is also untrusted, unless an org owner or admin starts it. Use it to try a workflow before committing it; the committed file is what gets secrets and deploys.

## Deploying from a workflow

First link the project under **Settings → Deploy targets**, optionally limited to one environment. Then:

```yaml
jobs:
  deploy:
    needs: test
    if: skiff.ref == 'refs/heads/main'
    environment: production
    runs-on: linux
    steps:
      - uses: actions/checkout@v4
      - run: bun install && bun run build
      - uses: skiff/deploy@v1
        with:
          project: my-site
          path: dist
          promote: true
```

For a container project, pass `image:` instead of `path:`. Skiff pins the image to its digest when it deploys.

## Building container images

`skiff/build-image` builds a Dockerfile and pushes it. On a node that runs jobs in containers, Skiff starts a private, rootless BuildKit for the job, with a build cache kept per repository and kept separate for untrusted runs. Elsewhere it falls back to Buildah, Podman or Docker, whichever the node has. Tags starting with `registry/` go to Skiff's own registry in your organisation's namespace, and the job signs in with its own short-lived credentials, so no password is needed.

Inputs: `context`, `file`, `target`, `tags`, `build-args`, `platforms`, `labels`, `push` (default true), `secrets` (lines of `id=value`, mounted with `RUN --mount=type=secret,id=…`, never baked into the image), `provenance` (`min` by default, `max` to opt in) and `sbom`. Outputs are `digest`, `image` (`repository@digest`) and `tags`.

For a multi-arch image, build each architecture on its own node and join them:

```yaml
jobs:
  image:
    strategy: { matrix: { arch: [x64, arm64] } }
    runs-on: [linux, "${{ matrix.arch }}"]
    steps:
      - uses: actions/checkout@v4
      - uses: skiff/build-image@v1
        with: { tags: "registry/api:${{ skiff.sha }}-${{ matrix.arch }}" }
  index:
    needs: image
    runs-on: linux
    steps:
      - uses: skiff/image-index@v1
        with:
          tag: registry/api:${{ skiff.sha }}
          sources: |
            registry/api:${{ skiff.sha }}-x64
            registry/api:${{ skiff.sha }}-arm64
```

```yaml
- id: image
  uses: skiff/build-image@v1
  with:
    context: .
    file: Dockerfile
    tags: ghcr.io/acme/api:${{ skiff.sha }}
    username: acme
    password: ${{ secrets.GHCR_TOKEN }}
- uses: skiff/deploy@v1
  with: { project: api, image: '${{ steps.image.outputs.image }}' }
```

> [!NOTE]
> The BuildKit setup has been verified on Fedora with SELinux, not yet on Debian or Ubuntu with AppArmor.

## Commit statuses, OIDC and Skiff events

- **Commit statuses.** Under **Settings → Commit statuses and isolation**, add a GitHub token with *Commit statuses: write* on the repository. Every run then appears as `skiff/<workflow name>` on its commit and pull request, linking back to the run.
- **OIDC tokens.** In a trusted job, `- id: oidc` / `uses: skiff/oidc-token@v1` / `with: { audience: sts.amazonaws.com }` sets `steps.oidc.outputs.token` to a ten-minute ID token for cloud federation (masked in logs), so no cloud keys need to be stored as secrets. The issuer is `https://<your Skiff>/api/pipeline/oidc` (discovery at `/.well-known/openid-configuration`, keys at `/jwks`). The `sub` claim follows GitHub's format: `repo:<org>/<repository>:environment:<env>`, `…:pull_request` or `…:ref:<ref>`, so existing trust policies translate directly. Untrusted runs cannot get one.
- **Skiff events.** `on: { skiff_event: { types: [deployments.failed] } }` starts a workflow on the default branch when a Skiff event happens in your organisation: `deployments.created`, `deployments.promoted`, `deployments.failed`, `alerts.firing`, `alerts.resolved`, `database-backups.completed` or `database-backups.failed`. The event is available as `skiff.event`. Leave `types` empty to run on every event.

## Runs, logs and artifacts

Each run page shows the job graph, live logs per step, outputs and artifacts. From the CLI:

```sh
skif run list my-app
skif run watch my-app 42
skif run logs my-app 42 --job build --follow
skif run rerun my-app 42 --failed
skif workflow run my-app --file .skiff/workflows/ci.yml --watch   # try an uncommitted file on Skiff
skif workflow run --local .skiff/workflows/ci.yml -j test           # run a job on this machine
skif workflow lint .skiff/workflows/ci.yml
skif workflow lint --import .github/workflows/ci.yml --out .skiff/workflows/ci.yml
```

`--local` runs a job in your working directory without a server: logs print as they happen, secrets come from `--secret NAME=value`, and artifacts and caches go to `.skiff/local/`. `lint --import` converts a GitHub Actions workflow, rewriting hosted runner labels and listing everything it changed or could not carry over.

Logs are kept for 90 days, artifacts for 30 days (up to 90 with `retention-days`), and caches until they go unused for 7 days or the repository exceeds 10 GB of cache.

## Build nodes

Jobs run on nodes with the Builder role. Each node advertises labels: its OS (`linux`), architecture (`x64` or `arm64`), its node name, `oci-build` when it can build images, and any extra labels the operator sets. Operators can change how many jobs a node runs at once; see [Nodes and fleet](/self-hosting/nodes-and-fleet).

Jobs are isolated at one of four levels, weakest first:

| Level | How the job runs | Needs on the node |
| --- | --- | --- |
| Sandbox | In the Builder's systemd sandbox as the unprivileged `skiff-build` user | Nothing |
| Container | In its own Podman container, user namespace and network, with no capabilities | Podman |
| gVisor | The same container under gVisor's user-space kernel | `runsc` registered with Podman |
| MicroVM | The same container inside a Kata Containers microVM | Kata Containers and `/dev/kvm` |

`container:` and `services:` need at least a container. Under **Settings → Commit statuses and isolation**, an org owner or admin can set the weakest level trusted and untrusted runs may use, for example *Untrusted runs: gVisor*. A job then waits until a node that can give that level picks it up.
