---
title: CLI reference
description: Install the yoal CLI, sign in, manage profiles, and use every command group with its flags, environment variables and exit codes.
---

The `yoal` command is the terminal client for a Yoal control plane. This page covers installation, signing in, profiles and settings, global options, and then every command group with its subcommands and flags. Each group links to the feature page that explains the concepts behind it.

## Install

```sh
npm install -g @yoal/cli
```

Bun works too: `bun add -g @yoal/cli`. To run it without installing, use `npx --package @yoal/cli yoal --help`. The CLI needs Node.js 20 or later.

The package installs the `yoal` command. This page uses `yoal`.

```sh
yoal --version
yoal --help
```

## Sign in

### Browser login

`yoal login` opens your dashboard so you can approve the CLI. Once you approve, the CLI stores a new API key in the selected profile and waits up to five minutes for approval.

```sh
yoal login --url https://control.example.com
yoal login --url https://control.example.com --no-browser   # print the URL instead of opening it
```

Use `--no-browser` on a machine without a browser, such as over SSH. Accounts, two-factor sign-in and key management are covered in [sign-in and 2FA](/accounts/sign-in-and-2fa) and [API keys and tokens](/accounts/api-keys-and-tokens).

### With an API key

Create a key in the dashboard, then store it directly with `--token`. The CLI checks the key with the server before saving it.

```sh
yoal login --url https://control.example.com --token yoal_...
```

### In CI and scripts

Set `YOAL_URL` and `YOAL_TOKEN` in the environment. No login and no config file are needed.

```sh
export YOAL_URL=https://control.example.com
export YOAL_TOKEN=yoal_...
yoal deploy ./dist --project my-site --json
```

When `YOAL_TOKEN` is set, `yoal login` stores that key rather than opening the browser. Add `--web` or `--no-browser` to force browser sign-in instead.

### Signing out

`yoal logout` removes the API key from the selected profile and keeps its URL and content domain, so the next `yoal login` remembers them. `yoal logout --all` deletes the whole config file.

## Profiles and settings

The CLI stores settings and credentials in `~/.config/yoal/config.json`, with file mode `0600`. Set `YOAL_CONFIG_DIR` to use a different directory, or `XDG_CONFIG_HOME` to change the base directory (the file is then `$XDG_CONFIG_HOME/yoal/config.json`).

Each profile holds one deployment: its control-plane URL, API key and content domain. Use a profile per Yoal installation, for example production and a local development server:

```sh
yoal login --profile prod --url https://control.example.com
yoal login --profile dev  --url http://localhost:5173

yoal profile use dev            # make dev the default
yoal --profile prod status      # one command against prod
YOAL_PROFILE=prod yoal deploy ./dist
```

A command picks its profile in this order:

1. `--profile <name>` on the command line.
2. `YOAL_PROFILE`.
3. The active profile set by `yoal profile use`.
4. The only profile, if you have exactly one.

If you have several profiles and none is active, the command stops and asks you to choose. When `YOAL_URL` and `YOAL_TOKEN` are both set, the CLI uses them and does not need a profile.

Profiles written by older CLI versions are read as a profile named `default` and upgraded the next time they are written.

### Settings

| Setting | Environment variable | What it is |
| --- | --- | --- |
| `url` | `YOAL_URL` | Control-plane URL, for example `https://control.example.com` |
| `contentDomain` | `YOAL_CONTENT_DOMAIN` | Domain that deployed sites are served from, used to build preview URLs |
| `token` | `YOAL_TOKEN` | API key |

`yoal config` accepts a few aliases, such as `platform` and `control` for `url`, `content-domain` for `contentDomain`, and `api-key` for `token`. A URL without a scheme gets `https://`, or `http://` for `localhost`.

```sh
yoal config list                                  # effective values and where each one comes from
yoal config set url https://control.example.com
yoal config get url                              # prints the value only, so it works in scripts
yoal config unset token                          # same as yoal logout
yoal config path
```

Environment variables override the stored settings for that process only.

## Global options and output

| Option | Meaning |
| --- | --- |
| `--profile <name>` | Use a saved profile. Accepted before or after the command. |
| `-h`, `--help` | Show help for the CLI or for one command. `yoal help <command>` also works. |
| `-v`, `--version` | Print the CLI version. |
| `--json` | Print the server response as JSON. Most commands accept it. Bulk, prune and `watch` runs print NDJSON events, one per line. |

Boolean flags have a `--no-` form, for example `--no-promote` and `--no-create`. Booleans also accept an explicit value, as in `--flag=false`.

Errors go to stderr, with suggestions on the lines after the message. With `--json`, the error is a JSON object instead:

```json
{
  "error": {
    "code": "project_missing",
    "message": "Project \"my-site\" does not exist. Create it in the dashboard or re-run without --no-create.",
    "suggestions": []
  }
}
```

Failed API calls also include `status` and `requestId`, which are useful when you report a problem. Set `YOAL_DEBUG=1` to print the full error object, including the stack trace.

## Environment variables

| Variable | Effect |
| --- | --- |
| `YOAL_URL` | Control-plane URL. Overrides the profile's URL. |
| `YOAL_TOKEN` | API key. Overrides the profile's key. Also makes `yoal login` store this key without opening the browser. |
| `YOAL_CONTENT_DOMAIN` | Content domain. Overrides the profile's value. |
| `YOAL_PROFILE` | Profile to use when `--profile` is not given. |
| `YOAL_CONFIG_DIR` | Directory that holds `config.json`. Takes precedence over `XDG_CONFIG_HOME`. |
| `XDG_CONFIG_HOME` | Base directory. The config file is `$XDG_CONFIG_HOME/yoal/config.json`. |
| `YOAL_DEBUG` | Set to `1` to print full error details. |

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The command succeeded. |
| `1` | The command failed. This covers API errors, usage errors, unknown commands, a declined confirmation, and a bulk or prune run that failed or was cancelled. |
| `3` | A bulk, prune, `blueprint apply` or `operations watch` run finished partially: some items succeeded and some failed. |
| `130` | You pressed Ctrl-C while following an operation. The CLI detached, and the operation keeps running on the server. |

`yoal function` exits `1` when the function answers with an error. `yoal run`, `yoal jobs run` and `yoal jobs logs -f` exit with the command's own status, `124` when it timed out and `130` when it was cancelled. `yoal wrangler` returns the exit code of the Wrangler process it ran.

## Command reference

Arguments in angle brackets are required. Arguments in square brackets are optional.

### login

```sh
yoal login [--url <platform>] [--profile <name>] [--token <key>] [--no-browser]
```

| Flag | Description |
| --- | --- |
| `-u`, `--url <platform>` | Control-plane URL. Defaults to the profile's saved URL, then `YOAL_URL`, then a prompt. |
| `--profile <name>` | Profile to save into. Created if it does not exist. |
| `-t`, `--token <key>` | Store this API key instead of signing in with the browser. |
| `--web` | Force browser sign-in, even when `YOAL_TOKEN` is set. |
| `--no-browser` | Print the approval URL instead of opening a browser. |
| `--json` | Print the signed-in user, organisation and permissions as JSON. |

`--web` and `--token` cannot be combined. Login keeps the URL and content domain already saved for the profile, and records the ones the server reports.

### logout

```sh
yoal logout [--profile <name>] [--all]
```

| Flag | Description |
| --- | --- |
| `--all` | Delete the whole config file, including every profile. |
| `--json` | Print the result as JSON. |

### config

```sh
yoal config <list|get|set|unset|path> [options]
```

| Subcommand | Arguments | Description |
| --- | --- | --- |
| `list` | none | Show each setting, its value (the token is masked) and its source. The default. |
| `get` | `<key>` | Print one value. Prints nothing when the value is unset. |
| `set` | `<key> <value>` | Save a value. Setting `token` stores the key without checking it. |
| `unset` | `<key>` | Remove a value. `unset token` is the same as `yoal logout`. |
| `path` | none | Print the config file path. |

Keys are `url`, `contentDomain` and `token`. `--json` works with every subcommand.

### profile

```sh
yoal profile <list|add|use|remove|show|current> [options]
```

| Subcommand | Arguments and flags | Description |
| --- | --- | --- |
| `list` | none | List profiles. `*` marks the one commands use. The default. |
| `add` | `<name>`, `-u, --url <url>`, `-t, --token <key>`, `--content-domain <domain>`, `--use`, `--force` | Add a profile without the browser. `--use` makes it active. `--force` replaces an existing profile. |
| `use` | `<name>` | Make a profile the active one. |
| `remove` | `<name>` | Delete a profile. Also `rm` and `delete`. |
| `show` | `[name]` | Show one profile. Defaults to the active profile. |
| `current` | none | Print the profile that commands use. |

```sh
yoal profile add staging --url https://staging.example.com --content-domain sites.staging.example.com --use
```

A profile added without `--token` has no key yet. Run `yoal login --profile <name>` to sign it in.

### deploy

```sh
yoal deploy [dir] [options]
```

Zips a directory, uploads it and creates a deployment. `dir` defaults to the current directory.

| Flag | Description |
| --- | --- |
| `-p`, `--project <slug>` | Target project. Defaults to a slug made from `--name`, or from the directory name. |
| `-n`, `--name <name>` | Name given to a project this deploy creates. Also used to derive the slug when `--project` is not set. |
| `--no-promote` | Create a preview only. Production does not move. |
| `-m`, `--message <text>` | Message stored with the deployment. |
| `--spa` | Set `"spa": true` in the deployed `yoal.json`. Static sites only. |
| `--no-create` | Fail if the project does not exist, rather than creating it. |
| `--wrangler <path>` | Use this Wrangler config instead of looking for one. |
| `--no-wrangler` | Deploy the directory as-is, even if a Wrangler config is present. |
| `--json` | Print the server response as JSON. |

If the directory has a `wrangler.jsonc` or `wrangler.json`, the deploy is treated as a Functions project. The Worker named by `main` is bundled with Yoal's own bundler, so Wrangler is not needed. Otherwise the directory is deployed as a static site. Each step prints a progress line to stderr, and the result shows the project, deployment, preview and production URLs.

```sh
yoal deploy ./dist --project my-site -m "Spring menu"
yoal deploy . --project api --no-promote
```

See [static sites](/deploying/static-sites), [git builds](/deploying/git-builds) and [functions](/compute/functions).

### status

```sh
yoal status [project] [--json]
```

Without a project, shows platform health, project and deployment counts, node status, and storage use. With a project, also shows its URL, access modes, production deployment and recent deployments.

### usage

```sh
yoal usage [project] [--json]
```

Shows current usage against each quota, with percentages. With a project, shows only that project's resources. Counts are current. Database and storage bytes are the latest samples. Egress is an estimate over the last 30 days.

### projects

```sh
yoal projects [list|delete|restore|purge|trash] [options]
```

| Subcommand | Arguments and flags | Description |
| --- | --- | --- |
| `list` | none | List projects. The default. Also `ls`. |
| `delete` | `<slug…>` or selectors | Move projects to the trash, where they can be restored for 7 days. Also `rm`. |
| `restore` | `<slug…>` or selectors | Bring projects back from the trash. |
| `purge` | `<slug…>` or selectors | Delete trashed projects permanently. |
| `trash` | none | List the trash, with when each project is purged. |

Selectors apply to `delete`, `restore` and `purge`:

| Selector | Meaning |
| --- | --- |
| `--match <glob>` | Slugs matching a glob, such as `'test-*'`. Quote it. |
| `--not-deployed` | Only projects with nothing in production. |
| `--older-than <duration>` | Created more than this long ago. In the trash, measured from deletion. Accepts `30d`, `12h` or `2w`. |
| `--stdin` | Read slugs from stdin, one per line. |

Selectors combine with AND, and named slugs are added to the result. A run covers at most 100 projects.

Bulk actions show the server's plan first, then ask you to confirm. The plan lists each project as `ok`, `skip` or `blocked`. Purging more than 10 projects asks you to type the count. Off a terminal, the CLI does not prompt, so pass `-y, --yes` or the plan is cancelled. Bulk runs are operations; see [operations](#operations).

```sh
yoal projects delete blog old-demo
yoal projects delete --match 'test-*' --not-deployed --yes
yoal projects trash
yoal projects restore --match 'test-*'
```

### deployments

```sh
yoal deployments <project> [--json]
```

Lists a project's deployments, newest first. The current production deployment is marked with `*`. Deployment IDs from this list are what `promote` takes.

### promote

```sh
yoal promote <project> <deploymentId> [--json]
```

Moves production to an existing deployment. Use it to point a preview you have tested at production.

### rollback

```sh
yoal rollback <project> [--json]
```

Moves production back to the previous deployment.

See [static sites](/deploying/static-sites) and [domains and environments](/deploying/domains-and-environments) for how promotion and previews fit together.

### logs

```sh
yoal logs <project> [-n, --lines <n>] [--json]
```

Shows recent runtime logs for a project. `--lines` takes an integer from 1 to 10,000 and defaults to 200. Each line is prefixed with its time and level when the server provides them.

### container

```sh
yoal container [inspect] <project> [-r, --replica <n>] [--json]
yoal container ls <project> [path] [--json]
yoal container cat <project> <path>
yoal container cp <project>:<path> [dest]
yoal container restart <project> [-y, --yes]
yoal shell <project> [--shell auto|/bin/bash|/bin/sh|/bin/ash] [--root] [-r, --replica <n>]
```

The [container console](/compute/apps-and-containers#container-console) for container projects. `ctr` is an alias of `container`.

- `inspect` (the default) prints the container's state, image, node, restarts and last exit, memory, CPU time, network and disk counters, command, environment variable names, ports, mounts and its processes.
- `ls` lists a directory inside the running container. Symlinks resolve inside the container; secret files and `tmpfs` mounts such as `/tmp` are refused.
- `cat` writes a file's bytes to stdout unchanged, so `yoal container cat my-api /data/app.db > app.db` works for binary files too.
- `cp` downloads a file. `dest` defaults to the file's name in the current directory; a directory there gets the file inside it.
- `restart` restarts every replica from the same image and configuration, after a prompt (`--yes` skips it).
- `shell` (also `yoal container shell`) opens an interactive terminal in the container. The terminal size follows yours; Ctrl-C goes to the remote shell. Leave with `exit` or Ctrl-D, and `yoal` exits with the shell's exit code. A dropped connection resumes where it left off. `--root` runs as root inside the container; capabilities stay dropped and the root filesystem read-only.

`--replica` picks one copy of a multi-replica workload; the default is the first. The key needs `container:inspect`, `container:files` (`ls`, `cat`, `cp`) or `container:exec` (`shell`); `restart` needs `project:update`. Shell opens and file reads are audited; keystrokes and file contents are not.

### open

```sh
yoal open <project> [--preview] [--json]
```

Opens the production site in your browser. With `--preview`, opens the most recent preview. If no browser can be launched, the URL is printed instead.

### prune

```sh
yoal prune [--apply] [--plan <op_id>] [--scope org|platform] [--only <categories>] [-y, --yes] [--json]
```

Finds and removes data that no live project references, such as leftover rows from deleted projects, orphaned domains, abandoned uploads and old deleted deployments. Without `--apply` it is a dry run: it scans, prints what it found by category, and prints the command that applies exactly that plan.

| Flag | Description |
| --- | --- |
| `--apply` | Delete what the scan found. Asks first, unless `--plan` or `--yes` is given. |
| `--plan <op_id>` | Apply an earlier plan rather than scanning again. Plans expire after one hour. |
| `--scope org` or `--scope platform` | `org` is the default. `platform` covers every organisation and needs a platform admin. |
| `--only <categories>` | Comma-separated categories to scan or apply. |
| `-y`, `--yes` | Do not ask for confirmation. Required when stdin is not a terminal. |
| `--json` | Print NDJSON progress events. |

```sh
yoal prune
yoal prune --apply --plan op_...
yoal prune --apply --only releases,deployments
```

### blueprint

```sh
yoal blueprint <validate|plan|apply> [file] [--prune] [--plan <hash>] [--confirm <stack>] [--all] [-y, --yes] [--json]
```

Plans and applies a blueprint: one file that declares a stack of projects, databases, storage, brokers and attachments. With no file, the first of `yoal.blueprint.yaml`, `yoal.blueprint.yml` and `yoal.blueprint.json` in the current directory is used; `-` reads stdin. The server needs the `BLUEPRINTS` feature flag. See [blueprints](/compute/apps-and-containers#blueprints).

| Subcommand | Description |
| --- | --- |
| `validate` | Check the file's schema, names and cross references without reading live state. Also `check`. |
| `plan` | Show what applying would create, update or delete, field by field. Changes nothing, and prints the command that applies exactly that plan. Also `diff`. |
| `apply` | Plan, show the plan, ask, then apply it and follow the progress. |

| Flag | Description |
| --- | --- |
| `--prune` | Also delete resources the stack manages that the file no longer lists. `apply` asks you to type the stack name. |
| `--plan <hash>` | `apply` only: apply an earlier plan by its hash instead of planning again. Plans last one hour and only their author can apply them. |
| `--confirm <stack>` | With `--plan`: the stack name, when that plan deletes resources. |
| `--all` | Also list resources that are up to date. |
| `-y`, `--yes` | Do not ask; for a pruning plan, confirms the stack name. Required when stdin is not a terminal. |
| `--json` | `validate` and `plan` print the server response; `apply` prints NDJSON events. |

`apply` exits `0` when everything applied or nothing needed to change, `3` when a step failed and the run stopped partway, and `1` when it failed or you declined.

```sh
yoal blueprint validate
yoal blueprint plan stack.yaml
yoal blueprint apply --yes
yoal blueprint apply --prune
```

### operations

```sh
yoal operations [list|show|watch|cancel] [options]
```

Bulk actions, prune runs and blueprint applies are server-side operations. These commands inspect them.

| Subcommand | Arguments and flags | Description |
| --- | --- | --- |
| `list` | `--kind bulk` or `--kind prune`, `--status <status>`, `--limit <n>` (1 to 200, default 50), `--scope platform` | Recent operations, newest first. The default. Also `ls`. |
| `show` | `<id>` | Status, counts, timings and items. |
| `watch` | `<id>` | Follow progress until the run ends. Ctrl-C detaches and leaves the run going. |
| `cancel` | `<id>` | Stop after the current item. The remaining items are cancelled. |

`--status` takes `queued`, `planning`, `planned`, `applying`, `succeeded`, `partial`, `failed`, `cancelled` or `expired`. `watch` exits `0` on success, `3` on partial, and `1` on failure or cancellation.

```sh
yoal operations
yoal operations show op_...
yoal operations watch op_...
```

### db

```sh
yoal db <command> [options]
```

Manages databases: PostgreSQL by default, and also MySQL, MariaDB, MongoDB, Valkey, Redis and ClickHouse. Databases run on one node. Attached projects receive connection variables named with a prefix, such as `DATABASE_URL`. See [databases](/data/databases) and [backups and point-in-time recovery](/data/backups-and-pitr).

| Command | Arguments and flags |
| --- | --- |
| `list` | `-a`, `--all` includes databases in the trash. The default. |
| `create <name>` | `-p, --project <slug>` attaches it at once. `--engine` is `postgres` (default), `mysql`, `mariadb`, `mongodb`, `valkey`, `redis` or `clickhouse`. `--version`, `--variant` (PostgreSQL 18 image: `standard`, `postgis` or `pg_cron`), `--prefix`, `--placement` (`auto`, `edge` or a node ID), `--memory` (default `256M`), `--cpus` (default `1`), `--storage` (default `10G`, the storage budget), `--disk` (`system`, `fast`, `bulk` or a disk name; default from **Settings → Storage**), `--[no-]pooler` (PostgreSQL only, default on), `--extension <name>` (repeatable, PostgreSQL only). |
| `info <name>` | none. Shows status, node, size against budget, attached projects and largest tables. |
| `update <name>` | `--memory`, `--cpus`, `--storage`, `--[no-]pooler` (PostgreSQL only), `--extension <name>` (repeatable, PostgreSQL only; adds to the enabled list), `--version` (a newer listed version, in place; MySQL, MariaDB, Valkey, Redis and ClickHouse only). `--version` asks to confirm; `-y, --yes` skips it. New limits apply at the next restart. |
| `attach <name>` | `-p, --project <slug>` (required), `--prefix <PREFIX>`, `--credential <id\|role>` connects as a named credential (PostgreSQL only). |
| `detach <name>` | `-p, --project <slug>` (required). The app restarts without the variables. |
| `delete <name>` | `-y, --yes`. Moves the database to the trash for 7 days. Refused while projects are attached. |
| `restore <name>` | none. Brings a database back from the trash. |
| `purge <name>` | `-y, --yes`. Deletes a trashed database and its data permanently. |
| `logs <name>` | `-f, --follow`, `--limit <n>` (1 to 2,000), `--level` (`debug`, `info`, `warn` or `error`), `--q <text>`, `--after <n>`. |
| `credentials <name>` | `--json` prints user, password, host and port separately. |
| `credentials list <name>` | none. Lists the owner, monitor and named credentials with status, expiry and last reveal. |
| `credentials create <name>` | `--role` (`app`, `readonly` or `backup`; default `app`), `--purpose <text>`, `--expires <ISO date or time>`. PostgreSQL only. |
| `credentials rotate <name> <id>` | none. Sets a new password; apps attached with it restart once the node confirms. |
| `credentials revoke <name> <id>` | `-y, --yes`. Disables the login. Refused while a project is attached with it. |
| `credentials reveal <name> <id>` | none. Prints the password. Audited. |
| `restart <name>` or `--all` | `--pooler` restarts only the pooler. |
| `upgrade <name>` | `--to <major>` (required). `--apply` queues a backup before the upgrade. `-y, --yes`. |
| `rotate <name>` | `--monitor` rotates the monitor role's password instead of the owner's. |
| `backups <name>` | none. Lists backups, the last verified restore and the target each backup was written to. |
| `backup <name>` or `--all` | `--pin` keeps the backup past retention. `--all` backs up every database. |
| `backup-delete <name> <backup-id>` | none. |
| `restore-backup <name> <backup-id>` | `--as <new-name>` (required). Restores into a new database. `--placement`, `-p, --project`, `--prefix`. |
| `backup-policy <name>` | `--schedule <schedule>` (UTC), `--retention <days>` (1 to 365), `--enable` or `--disable`. With no flags, shows the policy. |
| `pitr <name>` | `--enable`, or `--disable` with `-y, --yes`. With no flags, shows WAL archive health, the last base backup and the recoverable window. PostgreSQL 18 only, while the `PITR` feature is on. |
| `pitr-backup <name>` | `--type full`, `diff` or `incr` (default `full`). Queues a PITR base backup. |
| `restore-to <name>` | `--time <ISO 8601 with offset or Z>` and `--as <new-name>` (both required). Restores to that moment into a new database on the same node. |
| `replica list <name>` | Read replicas with status, lag, replay position and recent promotions. PostgreSQL only. |
| `replica add <name>` | `--node <id or name>` (required), `--disk <where>` (`system`, `fast`, `bulk` or a disk on that node; default: the primary's tier). Adds an async streaming replica on that node. |
| `replica remove <name> <id>` | `-y, --yes`. Stops the replica and deletes its copy. |
| `replica promote <name> <id>` | `--accept-data-loss`, `-y, --yes`. Makes the replica the primary; asks you to type the database name. See [promote a replica](/data/databases#promote-a-replica). |

Every command also takes `--json`. Reading credentials needs the `database:credentials` permission and is audited.

```sh
yoal db create main --project api
yoal db create cache --engine valkey --project api
yoal db info main
psql "$(yoal db credentials main)"
```

The connection URL points at `127.0.0.1` on the database's node. Run the client on that node, or tunnel to it first with `ssh -L <port>:127.0.0.1:<port> <node>`.

### storage

```sh
yoal storage <command> [options]
```

Manages S3-compatible object storage instances. Each instance runs on one node and holds buckets. Attached projects receive a scoped key. See [object storage](/data/object-storage).

| Command | Arguments and flags |
| --- | --- |
| `list` | `-a`, `--all` includes the trash. The default. |
| `create <name>` | `-b, --bucket <name>` (repeatable or comma-separated), `-p, --project`, `--prefix` (default `S3`), `--public`, `--version`, `--placement`, `--memory` (default `512M`), `--cpus` (default `1`), `--storage` (default `10G`, the storage budget), `--disk` (`system`, `fast`, `bulk` or a disk name; default from **Settings → Storage**). |
| `info <name>` | none. Status, endpoints, usage, buckets and attached projects. |
| `update <name>` | `--memory`, `--cpus`, `--storage`, `--version`, `--public` or `--no-public`. |
| `restart <name>` or `--all` | none. Buckets and objects are kept. |
| `logs <name>` | `-f, --follow`, `--limit`, `--level`, `--q`, `--after`. Same as `db logs`. |
| `delete <name>`, `restore <name>`, `purge <name>` | `-y, --yes` for `delete` and `purge`. Deletion is restorable for 7 days. |
| `credentials <name>` | `--prefix <PREFIX>`. Prints the root key as `AWS_*` lines, or everything as JSON with `--json`. |
| `rotate-root <name>` | `--cancel` abandons a rotation still waiting for the node. `-y, --yes`. Restarts RustFS with a new root key; the old key stops working once the node confirms the new one. |
| `keys <command>` | Subcommands below. |
| `move <name>` | `--node <node-id>` (required), `--disk <where>` (default: the instance's current tier), `-y, --yes`. Moves the instance empty: objects are not copied and the old copy is deleted. Asks you to type the name. |
| `metrics <name>` | `--since <duration>` (for example `1h`), or `--from` and `--to`. `--interval 1m` or `1h`. |
| `buckets <command>` | Subcommands below. |
| `objects <command>` | Subcommands below. |
| `attach <name>` | `-p, --project` (required), `-b, --bucket <name>[:read or :read-write]` (repeatable), `--prefix`. Without `--bucket`, grants read-write on the only bucket. |
| `grants <name>` | `-p, --project` (required), `-b, --bucket <name>[:read or :read-write]` (repeatable). Replaces the attachment's grants. |
| `detach <name>` | `-p, --project` (required). Revokes the key. |

`keys` subcommands manage named access keys for people and outside services:

| Subcommand | Arguments and flags |
| --- | --- |
| `list <storage>` | Lists keys with grants, status, expiry and purpose. The default. |
| `create <storage> <name>` | `-b, --bucket <name>[:read or :read-write]` (repeatable, required), `--purpose <text>`, `--expires <duration or ISO time>` (for example `90d`). Does not print the secret. |
| `reveal <storage> <key-id>` | `--prefix <PREFIX>` (default `AWS`). Prints the key as env lines. Needs `storage:credentials`; audited. |
| `revoke <storage> <key-id>` | `-y, --yes`. Attachment keys are revoked with `detach` instead. |

`buckets` subcommands:

| Subcommand | Arguments and flags |
| --- | --- |
| `list <storage>` | Lists buckets with access, state, size and object count. The default. |
| `create <storage> <bucket>` | `--access private` (default) or `public-read`. |
| `config <storage> <bucket>` | Shows versioning, lifecycle, CORS, quota, object lock and convergence. |
| `update <storage> <bucket>` | `--access`, `--versioning on` or `off`, `--quota <size>` or `none`, `--lifecycle <json or @file>`, `--cors <json or @file>`. |
| `delete <storage> <bucket>` | `--force` empties the bucket first. `-y, --yes`. |

`objects` subcommands. Each takes `-b, --bucket` (required):

| Subcommand | Arguments and flags |
| --- | --- |
| `ls <storage>` | `--prefix`, `--token` (continue a listing), `--limit` (1 to 1,000, default 100). The default. |
| `get <storage>` | `-k, --key <key>`, `-o, --output <path>`. Writes to stdout without `-o`. |
| `put <storage>` | `-k, --key <key>`, `-f, --file <path>`, `--content-type <type>`. |
| `rm <storage>` | `-k, --key <key>` or `--prefix <prefix>`, `-y, --yes`. |
| `mkdir <storage>` | `-k, --key <prefix>`. Creates a folder marker. |
| `presign <storage>` | `-k, --key <key>`, `--put`, `--expires <duration>` (default `1h`, maximum `7d`). Public instances only. |
| `share <storage>` | `-k, --key <key>`, `--expires` (default `1h`, maximum `7d`), `--downloads <n>`. Creates a signed link. |

```sh
yoal storage create media --bucket uploads --project api --prefix AWS
yoal storage buckets create media avatars --access public-read
yoal storage attach media --project worker --bucket uploads:read
yoal storage objects put media -b uploads -k photos/a.jpg -f ./a.jpg
set -a; eval "$(yoal storage credentials media)"; set +a
yoal storage keys create media backup-tool --bucket uploads:read --expires 90d
yoal storage rotate-root media --yes
```

Attached apps must use path-style addressing. A private instance serves apps on its own node only, and its endpoint is `127.0.0.1` on that node.

### volume

```sh
yoal volume <command> [options]
```

Manages persistent volumes mounted into a project's workload. See [volumes](/compute/volumes).

| Command | Arguments and flags |
| --- | --- |
| `list` | `-p, --project <slug>`. The default. Warns about volumes that are nearly full. |
| `show <name>` | `-p, --project` (required). Usage, attachments and the latest snapshots. Also `get`. |
| `create <name>` | `-p, --project` (required), `--size` (default `1G`), `--disk` (`system`, `fast`, `bulk` or a disk name; default from **Settings → Storage**), `--[no-]single-writer` (default on). |
| `attach <name>` | `-p, --project` (required), `-m, --mount <path>` (absolute path, for example `/var/lib/app`), `--workload <id or slug>`, `--env <name>` (default `production`), `--read-only`. |
| `detach <name>` | `-p, --project` (required), `--workload`, `--env`. The data is untouched. |
| `delete <name>` | `-p, --project` (required), `-y, --yes`. Refused while attached. The data is kept for 7 days. Also `rm`. |
| `snapshot <name>` | `-p, --project` (required), `--label <text>`, `--target <backup target>`, `--pin`, `--no-quiesce` (copy without pausing the app). |
| `snapshots <name>` | `-p, --project` (required). Lists the volume's snapshots. |
| `restore <name> <snapshot-id>` | `-p, --project` (required), `--to <new volume>` (required), `--size`. Always restores into a new volume. |
| `snapshot-delete <name> <snapshot-id>` | `-p, --project` (required), `-y, --yes`. Deletes the snapshot and its archive. |

```sh
yoal volume create app-data --project api --size 2G
yoal volume attach app-data --project api --mount /var/lib/app
yoal volume snapshot app-data --project api --label "before v2 migration"
yoal volume restore app-data avs_… --project api --to app-data-restored
```

### broker

```sh
yoal broker <command> [options]
```

Manages NATS brokers with JetStream. Queue commands also work on function queues. See [brokers and events](/data/brokers-and-events). Also available as `queue`.

| Command | Arguments and flags |
| --- | --- |
| `list` | `-a`, `--all` includes the trash. The default. |
| `create <name>` | `-p, --project`, `--prefix` (default `NATS`), `--engine` (`nats`), `--version` (`2.12` or `2.11`), `--placement`, `--memory` (default `256M`), `--cpus` (default `0.5`), `--storage` (default `2G`, the message store cap), `--disk` (`system`, `fast`, `bulk` or a disk name; default from **Settings → Storage**). |
| `info <name>` | none. Also `show`. |
| `update <name>` | `--version`, `--memory`, `--cpus`, `--storage`. |
| `attach <name>` | `-p, --project` (required), `--prefix`. |
| `detach <name>` | `-p, --project` (required). |
| `restart <name>` | none. Streams are kept. |
| `delete`, `restore`, `purge` `<name>` | `-y, --yes` for `delete` and `purge`. |
| `logs <name>` | `-f, --follow`, `--limit`, `--level`, `--q`, `--after`. |
| `metrics <name>` | `--since`, `--from`, `--to`, `--interval 1m` or `1h`, `--samples`. |
| `queues <name>` | none. Lists streams and consumers with their backlog. Also `streams`. |
| `credentials <name>` | `--json` for user, password, host and port. Needs `broker:credentials`. |
| `queue-create <name> <queue>` | Creates a function queue's stream now, instead of on first use. |
| `send <name> <queue> [body]` | `--body <text>`, `--file <path>`, `--text` (send plain text rather than JSON), `--delay <duration>` (for example `30s`), `--count <n>`. The body can also be piped on stdin. Also `publish`. |
| `peek <name> <queue>` | `--limit <n>` (default 20), `--from <seq>`. Reads without consuming. |
| `redrive <name> <dlq>` | `--to <queue>` (required), `--limit <n>`. Moves dead-lettered messages back into a queue. |
| `queue-purge <name> <queue>` | `-y, --yes`. Removes every message. The stream stays. |
| `queue-rm <name> <queue>` | `-y, --yes`. Deletes the stream and its messages. |
| `message-rm <name> <queue> <seq>` | `-y, --yes`. Deletes one message by sequence number. |

`peek`, `queue-purge`, `queue-rm` and `message-rm` accept `--stream <stream>` in place of `<queue>` for a stream your app created itself.

```sh
yoal broker create jobs --project api
yoal broker send jobs emails '{"to":"a@example.com"}' --count 5
yoal broker peek jobs emails-dlq
yoal broker redrive jobs emails-dlq --to emails
```

### events

```sh
yoal events <command> [options]
```

Publishes platform events, such as uploads, alerts, deployments and backups, to a queue on a broker. The function that consumes the queue receives each event. Also available as `event`. See [brokers and events](/data/brokers-and-events).

| Command | Arguments and flags |
| --- | --- |
| `list` | none. The default. Lists event rules. |
| `create <source>` | `--broker <name>` and `--queue <name>` (both required). `-e, --event <event>` (repeatable; default all of the source's events). `--description`, `--disabled`. Source-specific flags are below. |
| `info <id>` | none. Shows the rule, its delivery counts and last error. Also `show`. |
| `update <id>` | `--queue`, `-e, --event` (repeatable), `--prefix`, `--suffix`, `--description`, `--enable` or `--disable`. |
| `delete <id>` | none. Deletes the rule and its undelivered events. Also `rm`. |
| `test <id>` | none. Queues one synthetic event to check the consumer end to end. |
| `deliveries [<id>]` | `--status` (`pending`, `delivered` or `failed`), `--limit <n>`. Newest first. |

Source-specific flags for `create`:

| Source | Flags | Events |
| --- | --- | --- |
| `storage` | `--storage <name>`, `--bucket <name>` (both required), `--prefix`, `--suffix` | `object-create`, `object-delete` |
| `alerts` | `--rule <id>` | `firing`, `resolved` |
| `deployments` | `-p, --project <slug>` | `created`, `promoted`, `failed` |
| `database-backups` | `--database <name>` | `completed`, `failed` |

```sh
yoal events create storage --storage media --bucket uploads --suffix .jpg \
  --event object-create --broker jobs --queue images
yoal events create deployments --project shop --broker jobs --queue deploys
yoal events test evr_...
```

Attach the broker to the function project before the function can consume the queue: `yoal broker attach <broker> -p <function-project>`.

### email

```sh
yoal email <command> [options]
```

Sends email from your own domains through Yoal's built-in mail service. Also available as `mail`. See [email](/data/email).

| Command | Arguments and flags |
| --- | --- |
| `status` | none. Organisation limits, messages sent today, and bounce and complaint rates. The default. |
| `domains list` | none. |
| `domains add <name>` | `--auto-dns` or `--no-auto-dns`, `--sending` or `--no-sending`. Prints the DNS records to create. |
| `domains info <name>` | none. Shows the DNS records and what public DNS returns. |
| `domains check <name>` | none. Re-checks the DNS records now. |
| `domains rm <name>` | `-y, --yes`. Mail from the domain is refused at once. |
| `send` | `--from <address>` and `--subject <text>` (required), `--to`, `--cc`, `--bcc` (repeatable or comma-separated), `--text <text>` or `--text-file <path>`, `--html-file <path>`, `--tag <key=value>` (repeatable, at most 10). |
| `log` | `--limit <n>` (default 50, at most 200), `--recipient <address>`, `--status <status>`, `-f, --follow`. |
| `log <messageId>` | none. Each recipient's status and delivery timeline. |
| `suppressions list` | `--address <address>`, `--limit <n>`. |
| `suppressions add <address>` | `--reason manual` or `unsubscribe`. |
| `suppressions rm <address>` | none. Allows sending to the address again. |
| `addresses list` | none. Sandbox recipients, pending or verified, and when each link expires. |
| `addresses add <address>` | none. Emails the address a confirmation link, or a fresh one if it is still pending. |
| `addresses rm <address>` | none. The sandbox refuses mail to the address again. |
| `request-access` | `--use-case <text>` and `--volume <n>` (messages a day; `10k` and `2m` work), `--website <url>`. Asks a platform admin to move the organisation out of the sandbox. Without flags, shows the latest request and its answer. Owners and admins only. |
| `credentials list` | none. Passwords are not shown again. |
| `credentials create <name>` | `-p, --project <slug>`, `--from <domain>` (repeatable). |
| `credentials revoke <id>` | `-y, --yes`. Apps using the credential stop sending. |
| `attach` | `-p, --project` (required), `--prefix` (default `SMTP`). Injects `<PREFIX>_HOST`, `_USER` and the rest. |
| `detach` | `-p, --project` (required), `--prefix`. Removes the variables and revokes the credential. |

New organisations start in the sandbox. They can only send to their own verified domains and to sandbox recipients whose owners confirmed a link, up to 200 messages a day. Use `request-access` to leave it.

```sh
yoal email domains add example.com
yoal email domains check example.com
yoal email send --from hi@example.com --to you@example.com --subject Hello --text "It works"
yoal email attach --project api
yoal email log --follow
```

### backup-target

```sh
yoal backup-target <command> [options]
```

Configures where platform backups are written. Also available as `backupTargets`. See [platform backups](/self-hosting/platform-backups).

| Command | Arguments and flags |
| --- | --- |
| `list` | none. The default. |
| `add <name>` | `--kind local` or `s3` (default `s3`). For `local`: `--path <dir>`. For `s3`: `--endpoint <url>` (omit for AWS), `--bucket`, `--region` (default `us-east-1`), `--prefix` (default `yoal/backups`), `--access-key`, `--secret-key`, `--write-only`, `--object-lock`. `--platform` creates the platform default and needs a platform admin. |
| `test <id>` | none. Probes the target and shows the result. |
| `remove <id>` | `-y, --yes`, `--force`. Deletes the target. Refused while database backups are still stored on it. `--force` deletes it anyway and leaves those backups listed as unavailable. Objects are never deleted. Also `rm` and `delete`. |

Secrets are sealed with the organisation key. `add` prints them once, and `list` and `test` never return them. A new target is used by the next backup once it is the target that applies. Existing backups stay where they were written: each one records its target, and restores and retention read from that target. See [backup targets](/data/backups-and-pitr#backup-targets).

```sh
yoal backup-target add local --kind local --path /var/lib/yoal/backups
yoal backup-target test bt_abc123
```

### log-drain

```sh
yoal log-drain <command> [options]
```

Forwards the organisation's logs to a webhook or an OpenTelemetry (OTLP) receiver. Organisation owners and admins manage drains. Also available as `log-drains`. See [log drains](/observe/dashboards-and-logs#log-drains).

| Command | Arguments and flags |
| --- | --- |
| `list` | none. The default. Each drain's status, lines sent and dropped. Also `ls`. |
| `create <name>` | `--url <url>` (required). `--otlp` for an OTLP receiver instead of a webhook. `--format ndjson` or `json` (webhook only), `-p, --project <slug>`, `--source <source>` (repeatable or comma-separated: `build`, `runtime`, `system`, `services`), `--min-level <level>`, `-H, --header "Name: value"` (repeatable), `--disabled`. Prints a webhook drain's signing secret once. Also `add`. |
| `info <id>` | none. Target, filters, delivery counters and the last error. Also `show`. |
| `update <id>` | `--name`, `--url`, `--format`, `--source` or `--all-sources`, `--min-level` or `--all-levels`, `-H, --header` (replaces every header) or `--clear-headers`, `--enable` or `--disable`, `--rotate-secret` (prints the new secret once). |
| `test <id>` | none. Sends one test line and prints the receiver's answer. Exits 1 when it fails. |
| `delete <id>` | `-y, --yes`. Forwarding stops at once. Also `rm`. |

```sh
yoal log-drain create archive --url https://logs.example.com/yoal -H "Authorization: Bearer …"
yoal log-drain create shop-errors -p shop --source runtime --min-level error --url https://hooks.example.com/in
yoal log-drain test ldr_…
yoal log-drain update ldr_… --disable
```

### audit

```sh
yoal audit [options]
```

Prints the organisation's audit log, newest first. See [the audit log](/observe/dashboards-and-logs#audit-log).

| Flag | Meaning |
| --- | --- |
| `--from <when>`, `--to <when>` | The range: a date (`2026-11-07`), an ISO timestamp or epoch milliseconds. A date as `--to` covers that whole day, in UTC. |
| `--action <action>` | Only this action, for example `project.delete` or `mcp.deploy_site`. |
| `--resource <type>` | Only this resource type, for example `project` or `log_drain`. |
| `-n, --limit <n>` | Entries per page, 1 to 200. Default 50. |
| `--cursor <cursor>` | Continue from where a previous page ended. Without `--all`, the output ends with the command for the next page. |
| `--all` | Follow every page, up to 10,000 entries. |

```sh
yoal audit --from 2026-11-01 --to 2026-11-07
yoal audit --resource log_drain --all --json
```

### export

```sh
yoal export [options]
```

Writes your organisation's configuration to one file. The file covers every project's settings, environments, domains, workload spec, jobs, volumes and attachments. It also covers the managed databases, storage and brokers, IAM, service accounts, access keys, federation, access policies, user pools and their clients, log drains, backup targets, event and alert rules, email, pipelines, registry logins, forges, shares and templates.

The file holds configuration only. It has no deployments, database rows, objects, logs or pool users. Secrets appear by name and never by value. Each section is read with your own permissions. A section you cannot read, or whose feature is off, is listed under `skipped` and does not fail the export. You can download the same file from **Settings → Config export** in the dashboard. To recreate the configuration on another instance, use [`yoal import`](#import). The export is not a backup: to recover the whole platform with its data, see [platform backups](/self-hosting/platform-backups).

| Flag | Meaning |
| --- | --- |
| `-o`, `--out <file>` | Where to write. The default is `yoal-config-<org>-<date>.yaml` in the current directory, and `-` writes to stdout. The file is created with mode 0600. |
| `--format <yaml\|json>` | The output format. The default is YAML, or JSON when `--out` ends in `.json`. |
| `-p`, `--project <slug>` | Only these projects, repeated or comma-separated. Org-level configuration is still exported. |
| `--force` | Overwrite an existing file. |

```sh
yoal export
yoal export --out yoal-config.json
yoal export --project shop-web,shop-api --out -
```


### import

```sh
yoal import <file> [options]
```

Recreates the configuration in a `yoal export` file on the platform you are signed in to, for example when you move to a new server. Without `--apply` it only shows the plan.

Import only creates. Each resource is matched by its name: the project slug, the database, role or group name, the hostname, and so on. A resource that already exists is left exactly as it is, and nothing is updated or deleted. Running the import again only creates what is still missing, so you can fix a problem and run it again.

The export holds no secret values and no data. Pass the values with `--secrets`, or set them later and run the import again. Workload settings that need a missing secret are skipped until it exists. Databases, buckets and volumes start empty, and each app needs a deploy. Projects that had a password are imported as platform-only. People are matched by email, so invite your members first and their grants are imported with them. Anything the import cannot recreate is listed under **By hand afterwards**, with what to do.

| Flag | Meaning |
| --- | --- |
| `--apply` | Create everything the plan lists. It asks first unless you pass `--yes`. |
| `-y`, `--yes` | Do not ask for confirmation. |
| `--secrets <file>` | Secret values, one per line: `NAME=value` for the organisation, or `project-slug/NAME=value` for one project. |
| `--only <sections>`, `--skip <sections>` | Only these sections, or every section but these, for example `projects,databases`. |
| `-p`, `--project <slug>` | Only these projects, repeated or comma-separated. |
| `--all` | Also list the resources that already exist. |
| `--json` | Print the plan or the result as JSON. |

The command exits with code 3 when any step failed. The steps that depend on a failed step are skipped, and everything else is created.

```sh
yoal import yoal-config-acme-2026-11-09.yaml
yoal import yoal-config-acme-2026-11-09.yaml --secrets secrets.env --apply
```
### function

```sh
yoal function <command> [options]
```

Sends a test request to a function, or runs its `scheduled()` handler now. Both go straight to the function's node, bypassing domains, the proxy and access rules. An idle function starts for the request, shown as a cold start. Also available as `functions` and `fn`. See [functions](/compute/functions).

| Command | Arguments and flags |
| --- | --- |
| `invoke <project> [path]` | `-X, --method` (`GET` by default, or `POST` when a body is given), `-H, --header 'Name: value'` (repeatable), `-d, --data <body>`, `--data-file <path>` (`-` reads stdin), `-i, --include` (print the status line and headers). |
| `cron <project> <cron>` | none. Runs the `scheduled()` handler for one of the function's cron expressions. |

The response body goes to stdout, and a summary (status, time and cold start) goes to stderr. With `--json`, the task is printed with its raw result.

```sh
yoal function invoke api /health
yoal fn invoke api /users -X POST -H 'content-type: application/json' -d '{"name":"Ada"}'
yoal fn cron api '*/5 * * * *'
```

### jobs

```sh
yoal jobs <command> [options]
```

Cron jobs and manual commands on a process or container app. Each run uses the app's current release, environment, secrets and volumes on the app's node. The command goes after `--` and is passed as an argument list, never through a shell. Also available as `job`. See [app jobs](/compute/scheduled-jobs#app-jobs).

| Command | Arguments and flags |
| --- | --- |
| `list <project>` | none. `yoal jobs <project>` does the same. |
| `show <project> <job>` | none. |
| `create <project> <job> -- <command…>` | `-s, --schedule '<cron>'` (five fields, UTC; omit for a manual-only job), `-t, --timeout <duration>` (`90s`, `15m`, `2h`; default 10 minutes), `--concurrency forbid\|allow\|replace` (default `forbid`), `--retries <n>` (0–10), `--paused`. |
| `update <project> <job> [-- <command…>]` | The create flags, plus `--no-schedule` to make the job manual only. A command after `--` replaces the old one. |
| `run <project> <job>` | `-d, --detach`. Runs the job now and streams its output. |
| `runs <project> [job]` | `--one-off` (only `yoal run` commands), `-n, --limit <n>` (default 20, up to 200). |
| `logs <project> <run id>` | `-f, --follow` (keep printing until the run finishes). |
| `cancel <project> <run id>` | none. A running command gets `SIGTERM`, then `SIGKILL` after 30 seconds. |
| `pause <project> <job>`, `resume <project> <job>` | none. |
| `delete <project> <job>` | `-y, --yes`. Removes the job, its history and output. |

```sh
yoal jobs create shop tidy --schedule '0 3 * * *' -- bun scripts/tidy.ts --days 30
yoal jobs run shop tidy
yoal jobs runs shop tidy
yoal jobs update shop tidy --timeout 30m --retries 2
```

### run

```sh
yoal run <project> [options] -- <command…>
```

Runs one command once against the app's current release, in the app's sandbox with its environment, secrets and volumes, and streams its output: stdout to stdout, stderr to stderr. The command is not saved as a job. The CLI exits with the command's status (`124` for a timeout, `130` when cancelled). Options: `-t, --timeout <duration>` (default 10 minutes), `-d, --detach` (print the run id and return), `--json` (print the finished run instead of streaming). See [app jobs](/compute/scheduled-jobs#run-a-one-off-command).

```sh
yoal run shop -- bun run migrate
yoal run shop --timeout 1h -- bun scripts/backfill.ts --since 2026-01-01
```

### ha

```sh
yoal ha status [--events <n>] [--json]
```

Shows the failover controller, for platform admins: whether automatic failover is on, which control plane holds the lease and at which epoch, how long each node has been silent and when its replica copies would move, the ingress record set, databases whose primary is lost with the replica a promotion would use, and the most recent failover events (10 by default, at most 50). It only reads. See [automatic failover](/self-hosting/clustering#automatic-failover).

### upgrade

```sh
yoal upgrade <plan|apply|rollback> [options]
```

Checks, installs and rolls back the Yoal platform on a self-hosted installation. See [upgrades](/self-hosting/upgrades).

| Subcommand | Flags | Description |
| --- | --- | --- |
| `plan` | `--version <v>`, `--repo <owner/name>`, `--ref <ref>` | Preflight the next release: disk, backup target, migrations and PostgreSQL versions. Works remotely through the API. |
| `apply` | `--version <v>`, `--repo`, `--ref`, `--force`, `--with-agent`, `-y, --yes` | Install the new version, with a snapshot and a health-check rollback. |
| `rollback` | `--restore-db`, `--keep-db`, `--with-agent`, `-y, --yes` | Switch back to the previous release. `--restore-db` also restores the control database snapshot, which loses later writes. |

`apply` and `rollback` run on the Yoal host, as root. The CLI hands the work to the host's `yoal-update-self` command. An API key cannot perform a platform change.

### wrangler

```sh
yoal wrangler [args…]
```

Runs Wrangler, passing every argument through unchanged. If Wrangler is not installed, it is installed first. Use it for local development of a Functions project, for example `yoal wrangler dev`. Deployment does not need it, because `yoal deploy` bundles the Worker itself.
