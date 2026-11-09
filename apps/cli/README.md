# @yoal/cli

Command-line client for [Yoal](https://github.com/KieranHolroyd/yoal), a lightweight
self-hosted deploy platform. Installing the `@yoal/cli` package gives you the `yoal`
command.

```sh
npm install -g @yoal/cli   # or: bun add -g @yoal/cli / pnpm add -g @yoal/cli
npx @yoal/cli --help       # or run it without installing
```

Requires Node.js 20+ or Bun.

## Quick start

```sh
yoal login --url https://control.example.com   # approve the CLI in your browser
yoal deploy ./dist                              # zip, upload, and promote to production
yoal status my-site
```

On CI or headless machines, skip the browser and use an API key from the dashboard:

```sh
export YOAL_URL=https://control.example.com
export YOAL_TOKEN=yoal_...
yoal deploy ./dist --project my-site --json
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
| `workload [show\|set\|reset\|capacity]` | Runtime spec: command, image, port, memory, idle stop, workers and node capacity |
| `environments [list\|create\|update\|remove\|promote]` | Named environments and their deployment pointers |
| `domains [list\|add\|check\|remove]` | Custom domains, DNS records and verification |
| `promote <project> <deploymentId>` | Point production at a deployment |
| `rollback <project>` | Move production back one deployment |
| `logs <project>` | Show recent project logs |
| `open <project>` | Open the site in a browser |
| `prune [--apply] [--plan <id>]` | Find and remove orphaned data (dry run by default) |
| `operations [list\|show\|watch\|cancel]` | Inspect and follow bulk and prune operations |
| `blueprint <validate\|plan\|apply> [file]` | Declare a stack in one file; `plan` shows the diff, `apply` runs it |
| `import <file> [--apply] [--secrets <file>]` | Recreate an export's configuration on this platform; create-only and repeatable, plan by default |
| `export [--out <file>\|-] [--format yaml\|json] [--project <slug>]` | Write the org's configuration (projects, services, IAM, drains, pipelines, …) to one file; no data, secrets by name only |
| `db [list\|create\|info\|attach\|detach\|delete\|restore\|purge\|credentials]` | Managed PostgreSQL databases (see below) |
| `storage [list\|create\|info\|update\|buckets\|attach\|grants\|detach\|delete\|restore\|purge\|credentials\|metrics]` | Managed S3-compatible object storage (see below) |

Every command accepts `--help`, and most accept `--json` for scripting. Errors in `--json` mode
are printed to stderr as `{ "error": { "code", "message", "suggestions" } }`.

## Bulk actions and prune

Deleting, restoring and purging many projects, and pruning orphaned data, run as server-side
*operations*. Each one is planned first: the server decides, per project, what it will do, and
the CLI shows that plan before asking.

```sh
yoal projects delete blog old-demo                       # named projects
yoal projects delete --match 'test-*' --not-deployed     # selectors (combine with AND)
yoal projects delete --older-than 90d --not-deployed --yes
cat slugs.txt | yoal projects delete --stdin --yes       # one slug per line

yoal projects trash                                      # what's deleted, and when it purges
yoal projects restore --match 'test-*'                   # selectors resolve against the trash
yoal projects purge old-demo                             # permanent; trash only
```

- Selectors (`--match <glob>`, `--not-deployed`, `--older-than 30d|12h|2w`, `--stdin`) are
  resolved by the CLI into an explicit list; the server only ever acts on that list. In the
  trash, `--older-than` compares the deletion time. At most 100 projects per run.
- The plan table shows each slug's verdict (`ok`, `skip`, `blocked`), flags (`live`,
  `workload`, `custom_domain`) and reason, then asks `Delete 12 projects (3 live)? [y/N]`.
  Purging more than 10 asks you to type the count.
- When stdin isn't a terminal, the CLI won't prompt: pass `--yes`, or it cancels the plan and exits 1.

```sh
yoal prune                                   # dry run: scan, per-category table, apply command
yoal prune --apply --plan op_…               # apply exactly that plan (within 1 hour)
yoal prune --apply --only releases,deployments   # scan these, confirm, apply
yoal prune --scope platform                  # every org, plus stored objects (platform admins)
```

Progress shows one redrawn line per category on a terminal
(`releases ▕████████░░▏ 384/480 · 46 MiB`), one line per phase in logs, and NDJSON events
(`plan`, `progress`, `items`, `done`) with `--json`. **Ctrl-C detaches**: the operation keeps
running on the server, and `yoal operations watch <id>` picks it up again. Stop one with
`yoal operations cancel <id>`. Exit codes: `0` succeeded, `3` partial (some items failed),
`1` failed, cancelled or expired.

```sh
yoal operations                  # recent operations
yoal operations show op_…        # status, counts and items
yoal operations watch op_…       # follow to the end
```

## Databases

Managed PostgreSQL databases are org resources that run on one node. Attached process and
container projects get `<PREFIX>_URL`, `_HOST`, `_PORT`, `_USER`, `_PASSWORD` and `_NAME` at
activation (the prefix defaults to `DATABASE`) and are placed on the database's node.

```sh
yoal db create main --project api                    # create and attach in one go
yoal db create analytics --version 16 --memory 512M --storage 20G
yoal db attach main --project worker --prefix DATABASE
yoal db info main                                    # status, node, size vs budget, projects, top tables
yoal db detach main --project worker
yoal db delete main                                  # trash: restorable for 7 days
yoal db restore main
yoal db purge main                                   # permanent; asks you to type the name
psql "$(yoal db credentials main)"                   # URL only; --json for everything
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
yoal storage create media --bucket uploads --project api      # create, add a bucket, attach
yoal storage create assets --bucket img,css --public --storage 50G
yoal storage info media                                       # status, endpoints, buckets, projects
yoal storage update media --public                            # or --no-public, --memory 1G, --storage 20G
yoal storage buckets media                                    # list buckets with size and objects
yoal storage buckets create media avatars --access public-read
yoal storage buckets update media avatars --access private
yoal storage buckets delete media avatars                     # only when empty; --force deletes objects
yoal storage attach media --project worker                    # read-write on the only bucket
yoal storage attach media --project cdn --bucket uploads:read --bucket avatars --prefix AWS
yoal storage grants media --project cdn --bucket uploads:read-write
yoal storage detach media --project cdn
yoal storage metrics media --since 24h                        # --from/--to, --interval 1m|1h
yoal storage delete media                                     # trash: restorable for 7 days
yoal storage restore media
yoal storage purge media                                      # permanent; asks you to type the name
set -a; eval "$(yoal storage credentials media)"; set +a      # root key as AWS_* lines; --json for all
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
per Yoal installation instead of juggling env vars.

```sh
yoal login --profile prod --url https://control.example.com
yoal login --profile dev  --url http://localhost:5173

yoal profile list            # * marks the profile commands use
yoal profile use dev         # switch the default
yoal --profile prod status   # one command against another profile
YOAL_PROFILE=prod yoal deploy ./dist
```

With a single profile, commands use it automatically — no `--profile` needed. With several,
the active profile set by `yoal profile use` is used. If several exist and none is active,
commands stop and ask you to choose. `yoal profile add <name> --url <url> [--token <key>]
[--content-domain <domain>] [--use]` creates one without the browser, and
`yoal profile remove <name>` deletes it. `yoal logout --all` removes every profile.

Profiles written by older CLI versions (settings at the top level of the file) are read as a
profile named `default` and upgraded on the next write.

## Configuration

Settings and credentials are stored per profile in `~/.config/yoal/config.json` (mode `0600`).
`YOAL_CONFIG_DIR` or `XDG_CONFIG_HOME` change the location.

| Environment variable | Overrides |
| --- | --- |
| `YOAL_PROFILE` | Profile to use (overrides the active profile) |
| `YOAL_URL` | Control-plane URL |
| `YOAL_TOKEN` | API key |
| `YOAL_CONTENT_DOMAIN` | Domain deployed sites are served from |
| `YOAL_DEBUG=1` | Print full error details |

## Development

The CLI lives in `apps/cli` of the Yoal monorepo and is written in TypeScript for Bun.

```sh
bun src/main.ts --help   # run from source
bun test                 # unit tests
bun run build            # bundle to dist/yoal.js (Node 20+ / Bun)
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
