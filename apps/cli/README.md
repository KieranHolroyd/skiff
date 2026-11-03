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

## Configuration

Settings and the API key are stored in `~/.config/skiff/config.json` (mode `0600`).
`SKIFF_CONFIG_DIR` or `XDG_CONFIG_HOME` change the location.

| Environment variable | Overrides |
| --- | --- |
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
