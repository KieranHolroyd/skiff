# skif

Command-line client for [Skiff](https://github.com/KieranHolroyd/skiff), a lightweight
self-hosted deploy platform. Installing it gives you two commands, `skif` and `skiff`, which do
the same thing.

```sh
npm install -g skif     # or: bun add -g skif / pnpm add -g skif
npx skif --help         # or run it without installing
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
| `deployments <project>` | List deployments |
| `promote <project> <deploymentId>` | Point production at a deployment |
| `rollback <project>` | Move production back one deployment |
| `logs <project>` | Show recent project logs |
| `open <project>` | Open the site in a browser |

Every command accepts `--help`, and most accept `--json` for scripting. Errors in `--json` mode
are printed to stderr as `{ "error": { "code", "message", "suggestions" } }`.

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
