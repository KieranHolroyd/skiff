# Usage analytics

Yoal can send a small, anonymous usage ping to help us understand how the platform is actually
used — which features people turn on, which runtimes and engines they choose, and which parts are
never touched — so the next piece of work goes where it is useful. It is **off by default** and only
ever runs because a platform owner turned it on.

The collector, the protocol and this document all live in this repository. An operator can read
exactly what leaves their server and, if they prefer, run the collector themselves.

- Wire format: [`packages/contracts/src/usage-analytics.ts`](../packages/contracts/src/usage-analytics.ts)
- Collector: [`apps/usage`](../apps/usage)
- Sender: [`packages/core/src/usage-analytics.ts`](../packages/core/src/usage-analytics.ts)
- Decision: [D211](./DECISIONS.md)

## Consent

There are two ways to opt in, and both write the same setting:

1. **The setup wizard**, on the last step. A checkbox labelled "Send anonymous usage data", with a
   link to Settings, is unticked. Saving the step records the choice.
2. **Settings → Usage analytics**, for anyone who skipped it or wants to change their mind.

Either way the page shows the exact JSON body of the next ping before it is sent, built from the
install's current state. Turning the setting off stops sending immediately; the next maintenance
sweep is a settings read and nothing else. Only a user who can administer the platform
(`platform:settings`) can change it, and the change is audited as `usage.analytics.update`.

## What is sent

One ping a day at most. Every field is a fixed count, an enum or a random id:

| Field | Example | Meaning |
|---|---|---|
| `v` | `1` | Protocol version. |
| `id` | `usage9f2…` | Random per-ping id, so a retried POST is stored once. |
| `installId` | `4f1c…` (32 hex) | Random 128-bit id generated on this install when it is first enabled. Not derived from anything. |
| `sentAt` | `2026-11-10T12:00:00.000Z` | When the sender built the ping. |
| `version` | `0.4.2` | The Yoal release. |
| `os`, `arch` | `linux`, `x64` | Platform family, not a kernel or hostname. |
| `metrics` | `{ "projects": 4, … }` | Counts from the table below. |
| `features` | `["FUNCTIONS", "EMAIL"]` | Feature flags that are switched on. |
| `capabilities` | `["telemetryStore", "email"]` | Optional services that are actually configured. |

The metric keys are fixed. There is no map of arbitrary names and no string field other than the
version, the OS family and the protocol-level enums:

| Key | Counts |
|---|---|
| `orgs`, `users`, `members` | Organisations, platform user accounts, memberships. |
| `nodes`, `nodesOnline` | Registered nodes and nodes currently online. |
| `projects`, `projectsStatic`, `projectsProcess`, `projectsContainer` | Live projects by runtime. |
| `deployments`, `deploymentsActive`, `deployments30d` | Deployments, active ones, and those created in the last 30 days. |
| `databases`, `databaseEngines` | Live databases and how many distinct engines are in use. |
| `storageInstances`, `brokers`, `volumes` | Object storage, queue brokers and app volumes. |
| `functions`, `pipelines`, `registryRepositories` | Functions, pipeline repositories and registry repositories. |
| `emailDomains`, `ssoProviders`, `userPools` | Email domains, SSO providers and user pools. |
| `domains`, `shareLinks`, `accessKeys` | Custom domains, live share links and access keys. |

Features are the `YOAL_FEATURE_*` flags that are on. Capabilities are the opt-in services that are
configured: `telemetryStore`, `email`, `backups`, `githubApp`, `sentry`, `logDrains`, `sso`,
`userPools`, `registry`.

A representative body:

```json
{
  "v": 1,
  "id": "usage4c0f9d2e7b1a8e5f6d3c2b1a0f9e8d7c",
  "installId": "4f1c9a2b7d3e8f6a0c5b9d4e2f1a7c3b",
  "sentAt": "2026-11-10T12:00:00.000Z",
  "version": "0.4.2",
  "os": "linux",
  "arch": "x64",
  "metrics": {
    "orgs": 1, "users": 3, "members": 4, "nodes": 1, "nodesOnline": 1,
    "projects": 6, "projectsStatic": 4, "projectsProcess": 1, "projectsContainer": 1,
    "deployments": 41, "deploymentsActive": 6, "deployments30d": 7,
    "databases": 2, "databaseEngines": 1, "storageInstances": 0, "brokers": 0,
    "volumes": 1, "functions": 0, "pipelines": 1, "registryRepositories": 0,
    "emailDomains": 1, "ssoProviders": 0, "userPools": 0, "domains": 3,
    "shareLinks": 0, "accessKeys": 2
  },
  "features": ["FUNCTIONS", "EMAIL", "BACKUPS_RESTORE"],
  "capabilities": ["telemetryStore", "email"]
}
```

## What is never sent

The payload has no room for any of these, and the collector's schema is `strict`, so a field added
by mistake is refused with `400` rather than stored:

- hostnames, IP addresses, domain names, node names or labels;
- user, organisation, project, database, storage, broker or pipeline names and ids;
- file paths, environment variable names or values, secret names or values;
- request logs, page views, visitor addresses or cookies;
- email addresses, billing details or licence keys;
- anything derived from the server's identity: the `installId` is random bytes.

The collector does not store the client address. Rate limiting keys in memory only and the key is
discarded within a minute.

## Lifecycle

- Enabling generates `installId` once (`randomBytes(16)` as 32 hex characters) and stores it in the
  `settings` table under `usage.analytics`. It reaches the network only inside a ping.
- The first ping is sent within a minute of enabling, so "on" is observable. After that the
  maintenance loop (`MaintenanceService.run`, every 60 s) sends at most one a day.
- A failed ping records the reason on the settings page (an HTTP status or a short transport error)
  and is retried on the next day's tick — never in a loop. A collector outage costs one day.
- Disabling stops sending, clears the scheduled time and the recorded error, and keeps the id so a
  later opt-in does not look like a new install.
- The ping has a 10-second timeout, and the send is fire-and-forget from maintenance: a slow or
  unreachable collector cannot hold the loop open.
- Successful sends and setting changes are audit rows (`usage.analytics.send`,
  `usage.analytics.update`). The audit entry never contains the payload or the install id.

## Endpoint

The default is `https://yoal-analytics-engine.kierancloud.dev/api/v1/ping`.

- `YOAL_USAGE_ANALYTICS_ENDPOINT` on the control plane pins another endpoint and wins over the
  dashboard field. Use it when a host should never talk to the default collector.
- Settings → Usage analytics can set a different endpoint for one install without editing files.
- An endpoint must be an absolute `http(s)` URL with no credentials. `http://` is accepted so a
  collector on a private network works; the page warns that it is unencrypted.

Pointing every install at your own collector is supported and does not need a code change: run
`apps/usage` and set the variable or the dashboard field.

## The collector

`apps/usage` is a single Bun process with one SQLite file. It is deployed as a normal Yoal project,
so the same source that receives our pings can be run on your own install.

| Route | Purpose |
|---|---|
| `POST /api/v1/ping` | Validate against the schema and store. `202` accepted (also for a duplicate id), `400` invalid, `413` too large, `415` not JSON, `429` rate-limited, `405` wrong method. |
| `GET /healthz` | `{ ok, version }`. |
| `GET /` | What the service is and where the docs are. |
| `GET /api/v1/stats?days=30` | Operator view. `404` unless `YOAL_USAGE_ADMIN_TOKEN` is set; needs `Authorization: Bearer …`. |

Storage is two tables: `installs` (one row per anonymous install, first/last seen, version, OS,
arch, ping count) and `pings` (validated payloads, unique by ping id). Raw pings are kept for
`YOAL_USAGE_RETENTION_DAYS` (default 400); installs are kept so totals survive pruning. The stats
view aggregates each install's latest ping in the window, so a metric added later can still be
answered from stored payloads.

Limits: a 32 KiB body cap before parsing, 60 requests a minute per client address, and no CORS
header (no browser should post here). The listener is loopback-only behind Caddy.

### Running it yourself

```sh
bun install
YOAL_USAGE_DATA_DIR=.data/usage bun run --cwd apps/usage dev
```

Then set `YOAL_USAGE_ANALYTICS_ENDPOINT=http://127.0.0.1:8790/api/v1/ping` (or the dashboard field)
on the installs you want to report there. See [`apps/usage/README.md`](../apps/usage/README.md) for
every variable and the deployment shape on Yoal.

## Verifying it

- **Settings → Usage analytics → Send one ping now** sends a single ping and reports the result.
- The raw JSON panel on the same page is the body that would be sent; it is built live from the
  database.
- The audit log records each send, and the collector's `GET /api/v1/stats` (with the admin token)
  shows the install appearing.
