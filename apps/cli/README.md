# @skiffy/skiff

Command-line client for [Skiff](https://github.com/KieranHolroyd/skiff), a lightweight
self-hosted deploy platform. Installing the `@skiffy/skiff` package gives you two commands, `skif`
and `skiff`, which do the same thing.

```sh
npm install -g @skiffy/skiff   # or: bun add -g @skiffy/skiff / pnpm add -g @skiffy/skiff
npx @skiffy/skiff --help       # or run it without installing
```

Requires Node.js 20+ or Bun.

## Quick start

```sh
skif login --url https://control.example.com   # approve the CLI in your browser
skif deploy ./dist                              # zip, upload, and promote to production
skif status my-site
```

On CI or headless machines, skip the browser and use an API key from the dashboard:

```sh
export SKIFF_URL=https://control.example.com
export SKIFF_TOKEN=skif_...
skif deploy ./dist --project my-site --json
```

## Commands

| Command | What it does |
| --- | --- |
| `login [--url <platform>] [--token <key>]` | Sign in (browser by default, `--no-browser` prints the URL) |
| `logout [--all]` | Forget the API key; `--all` removes the whole config file |
| `config [list\|get\|set\|unset\|path]` | Inspect or change persistent settings |
| `profile [list\|add\|use\|remove\|show\|current]` | Manage profiles for multiple deployments |
| `deploy [dir]` | Zip a directory and deploy it (`--project`, `--name`, `--no-promote`, `--message`, `--spa`, `--no-create`) |
| `status [project]` | Fleet health, or one project's status |
| `projects` | List projects |
| `projects delete\|restore\|purge <slug…>` | Bulk actions: plan, confirm, apply (see below) |
| `projects trash` | List deleted projects and when each is purged |
| `deployments <project>` | List deployments |
| `promote <project> <deploymentId>` | Point production at a deployment |
| `rollback <project>` | Move production back one deployment |
| `logs <project>` | Show recent project logs |
| `open <project>` | Open the site in a browser |
| `prune [--apply] [--plan <id>]` | Find and remove orphaned data (dry run by default) |
| `operations [list\|show\|watch\|cancel]` | Inspect and follow bulk and prune operations |
| `blueprint <validate\|plan\|apply> [file]` | Declare a stack in one file; `plan` shows the diff, `apply` runs it |
| `db [list\|create\|info\|attach\|detach\|delete\|restore\|purge\|credentials]` | Managed PostgreSQL databases (see below) |
| `storage [list\|create\|info\|update\|buckets\|attach\|grants\|detach\|delete\|restore\|purge\|credentials\|metrics]` | Managed S3-compatible object storage (see below) |

Every command accepts `--help`, and most accept `--json` for scripting. Errors in `--json` mode
are printed to stderr as `{ "error": { "code", "message", "suggestions" } }`.

## Bulk actions and prune

Deleting, restoring and purging many projects, and pruning orphaned data, run as server-side
*operations*. Each one is planned first: the server decides, per project, what it will do, and
the CLI shows that plan before asking.

```sh
skif projects delete blog old-demo                       # named projects
skif projects delete --match 'test-*' --not-deployed     # selectors (combine with AND)
skif projects delete --older-than 90d --not-deployed --yes
cat slugs.txt | skif projects delete --stdin --yes       # one slug per line

skif projects trash                                      # what's deleted, and when it purges
skif projects restore --match 'test-*'                   # selectors resolve against the trash
skif projects purge old-demo                             # permanent; trash only
```

- Selectors (`--match <glob>`, `--not-deployed`, `--older-than 30d|12h|2w`, `--stdin`) are
  resolved by the CLI into an explicit list; the server only ever acts on that list. In the
  trash, `--older-than` compares the deletion time. At most 100 projects per run.
- The plan table shows each slug's verdict (`ok`, `skip`, `blocked`), flags (`live`,
  `workload`, `custom_domain`) and reason, then asks `Delete 12 projects (3 live)? [y/N]`.
  Purging more than 10 asks you to type the count.
- When stdin isn't a terminal, the CLI won't prompt: pass `--yes`, or it cancels the plan and exits 1.

```sh
skif prune                                   # dry run: scan, per-category table, apply command
skif prune --apply --plan op_…               # apply exactly that plan (within 1 hour)
skif prune --apply --only releases,deployments   # scan these, confirm, apply
skif prune --scope platform                  # every org, plus stored objects (platform admins)
```

Progress shows one redrawn line per category on a terminal
(`releases ▕████████░░▏ 384/480 · 46 MiB`), one line per phase in logs, and NDJSON events
(`plan`, `progress`, `items`, `done`) with `--json`. **Ctrl-C detaches**: the operation keeps
running on the server, and `skif operations watch <id>` picks it up again. Stop one with
`skif operations cancel <id>`. Exit codes: `0` succeeded, `3` partial (some items failed),
`1` failed, cancelled or expired.

```sh
skif operations                  # recent operations
skif operations show op_…        # status, counts and items
skif operations watch op_…       # follow to the end
```

## Databases

Managed PostgreSQL databases are org resources that run on one node. Attached process and
container projects get `<PREFIX>_URL`, `_HOST`, `_PORT`, `_USER`, `_PASSWORD` and `_NAME` at
activation (the prefix defaults to `DATABASE`) and are placed on the database's node.

```sh
skif db create main --project api                    # create and attach in one go
skif db create analytics --version 16 --memory 512M --storage 20G
skif db attach main --project worker --prefix DATABASE
skif db info main                                    # status, node, size vs budget, projects, top tables
skif db detach main --project worker
skif db delete main                                  # trash: restorable for 7 days
skif db restore main
skif db purge main                                   # permanent; asks you to type the name
psql "$(skif db credentials main)"                   # URL only; --json for everything
```

The URL points at `127.0.0.1` on the database's node: run it there, or tunnel first with
`ssh -L <port>:127.0.0.1:<port> <node>` (the port is in the URL).

`delete` is refused while projects are attached. `purge` only works on a database in the trash.
Off a terminal, `delete` and `purge` need `--yes`. `credentials` needs the
`database:credentials` permission, and every read is audited.

## Object storage

Managed object storage instances are S3-compatible servers (RustFS) that run on one node and hold
buckets. Each attached process or container project gets its own scoped key at activation:
`<PREFIX>_ENDPOINT_URL`, `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY`, `_REGION` and `_FORCE_PATH_STYLE`,
plus `_BUCKET` when exactly one bucket is granted and `_PUBLIC_ENDPOINT_URL` when the instance is
public. The prefix defaults to `S3`; `--prefix AWS` gives the names the AWS SDKs read on their own.
Clients must use path-style addressing. A private instance serves apps on its own node only (they
are placed there); `--public` serves it at `https://<name>--s3.<content domain>` for everyone else.

```sh
skif storage create media --bucket uploads --project api      # create, add a bucket, attach
skif storage create assets --bucket img,css --public --storage 50G
skif storage info media                                       # status, endpoints, buckets, projects
skif storage update media --public                            # or --no-public, --memory 1G, --storage 20G
skif storage buckets media                                    # list buckets with size and objects
skif storage buckets create media avatars --access public-read
skif storage buckets update media avatars --access private
skif storage buckets delete media avatars                     # only when empty; --force deletes objects
skif storage attach media --project worker                    # read-write on the only bucket
skif storage attach media --project cdn --bucket uploads:read --bucket avatars --prefix AWS
skif storage grants media --project cdn --bucket uploads:read-write
skif storage detach media --project cdn
skif storage metrics media --since 24h                        # --from/--to, --interval 1m|1h
skif storage delete media                                     # trash: restorable for 7 days
skif storage restore media
skif storage purge media                                      # permanent; asks you to type the name
set -a; eval "$(skif storage credentials media)"; set +a      # root key as AWS_* lines; --json for all
```

`attach` without `--bucket` grants read-write on the instance's only bucket, and asks for
`--bucket` when there are several. `grants` replaces an attachment's grants. `delete` is refused
while projects are attached, and a bucket can't be deleted while it is granted. Off a terminal,
`delete`, `purge` and `buckets delete` need `--yes`; `buckets delete --force` and `purge` ask you to
type the name. `credentials` prints the root key and needs the `storage:credentials` permission;
every read is audited. On a private instance its endpoint is `127.0.0.1` on the node, so run it
there or tunnel with `ssh -L <port>:127.0.0.1:<port> <node>`.

## Profiles

A profile is one deployment: its control-plane URL, API key and content domain. Keep a profile
per Skiff installation instead of juggling env vars.

```sh
skif login --profile prod --url https://control.example.com
skif login --profile dev  --url http://localhost:5173

skif profile list            # * marks the profile commands use
skif profile use dev         # switch the default
skif --profile prod status   # one command against another profile
SKIFF_PROFILE=prod skif deploy ./dist
```

With a single profile, commands use it automatically — no `--profile` needed. With several,
the active profile set by `skif profile use` is used. If several exist and none is active,
commands stop and ask you to choose. `skif profile add <name> --url <url> [--token <key>]
[--content-domain <domain>] [--use]` creates one without the browser, and
`skif profile remove <name>` deletes it. `skif logout --all` removes every profile.

Profiles written by older CLI versions (settings at the top level of the file) are read as a
profile named `default` and upgraded on the next write.

## Configuration

Settings and credentials are stored per profile in `~/.config/skiff/config.json` (mode `0600`).
`SKIFF_CONFIG_DIR` or `XDG_CONFIG_HOME` change the location.

| Environment variable | Overrides |
| --- | --- |
| `SKIFF_PROFILE` | Profile to use (overrides the active profile) |
| `SKIFF_URL` | Control-plane URL |
| `SKIFF_TOKEN` | API key |
| `SKIFF_CONTENT_DOMAIN` | Domain deployed sites are served from |
| `SKIFF_DEBUG=1` | Print full error details |

## Development

The CLI lives in `apps/cli` of the Skiff monorepo and is written in TypeScript for Bun.

```sh
bun src/main.ts --help   # run from source
bun test                 # unit tests
bun run build            # bundle to dist/skif.js (Node 20+ / Bun)
```

## Releasing

Run **Actions → Release CLI → Run workflow** on `main`. Pick a bump (`patch`, `minor`, `major`, or
a `pre*` bump for an `-rc.N` prerelease), or type an exact version. Tick *dry run* to rehearse
without publishing. The workflow tests and builds the CLI, commits the version bump to `main`,
tags `cli-v<version>`, publishes to npm with provenance (prereleases go to the `next` dist-tag)
and creates a GitHub release with the tarball attached. If a run fails part-way, run it again
with the same version: steps that already finished are skipped.

## License

MIT
