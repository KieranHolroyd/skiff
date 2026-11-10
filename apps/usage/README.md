# `@yoal/usage` — anonymous usage analytics collector

The small service behind `yoal-analytics-engine.kierancloud.dev`. It receives the opt-in, anonymous once-a-day ping that
a self-hosted Yoal install sends from **Settings → Usage analytics** (or the setup wizard).

The point of keeping it in this repository is that the people sending data can read exactly what
is sent and what happens to it:

- the wire format is [`packages/contracts/src/usage-analytics.ts`](../../packages/contracts/src/usage-analytics.ts);
- the full design, including the exact payload and retention, is [`docs/USAGE-ANALYTICS.md`](../../docs/USAGE-ANALYTICS.md).

It is a plain Bun process with one SQLite file. No third-party analytics, no cookies, no IP
storage, no user or organisation names.

## Run it

```sh
YOAL_USAGE_DATA_DIR=.data/usage bun run --cwd apps/usage dev
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `YOAL_USAGE_HOST` | `127.0.0.1` | Listen address; keep it on loopback behind Caddy. |
| `YOAL_USAGE_PORT` | `8790` | Listen port. |
| `YOAL_USAGE_DATA_DIR` | `/var/lib/yoal/usage` | Data directory (created 0700). |
| `YOAL_USAGE_DB` | `<dataDir>/usage.db` | SQLite file. |
| `YOAL_USAGE_ADMIN_TOKEN` | — | Bearer token for `GET /api/v1/stats`; unset disables the route. |
| `YOAL_USAGE_RETENTION_DAYS` | `400` | How long raw pings are kept (30–3650). |
| `YOAL_USAGE_TRUST_PROXY` | `1` | Read the client address from `X-Forwarded-For` (Caddy). |
| `YOAL_USAGE_VERSION` | `0.1.0` | Version shown by `/healthz`. |

## Routes

| Route | What it does |
| --- | --- |
| `POST /api/v1/ping` | Validate and store one ping. `202` accepted, `400` invalid, `413` too large, `429` rate-limited. |
| `GET /healthz` | `{ ok, version }`. |
| `GET /` | What this service is, and where the docs are. |
| `GET /api/v1/stats?days=30` | Operator view, `404` unless `YOAL_USAGE_ADMIN_TOKEN` is set; needs `Authorization: Bearer …`. |

Rate limiting is 60 requests a minute per client address, in memory. Pings are idempotent by their
`id`, so a sender may retry safely.

## Hosting it on Yoal

Deploy it as a **process** project with a volume mounted at `/var/lib/yoal/usage`:

1. Create a project from this repository with Dockerfile/builder settings that run
   `bun src/process.ts` in `apps/usage`.
2. Set the variables above. Keep `YOAL_USAGE_HOST=0.0.0.0` inside the container and put the
   project behind the normal project hostname.
3. Give the project a persistent volume at `/var/lib/yoal/usage`.
4. Point the platform at it with `YOAL_USAGE_ANALYTICS_ENDPOINT=https://<host>/api/v1/ping` on
   installs that should report somewhere other than the built-in endpoint.

The endpoint is public and anonymous by design. Give it a hostname of its own and keep the admin
token only on the collector.
