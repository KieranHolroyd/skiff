# Error tracker harnesses — JS, PHP, Go

Real Sentry SDKs sending real errors at the Yoal app error tracker. They are integration harnesses,
not SDKs: if a language already uses Sentry, the only difference should be the DSN.

The harnesses run against either:

1. a **capture sink** (default), which records every request to `captures/` so the parser can be
   built and tested against actual SDK output; or
2. a **real endpoint** (`--dsn`), which is the acceptance test for the tracker itself.

See [docs/APP-ERRORS.md](../../../docs/APP-ERRORS.md) for the feature plan.

## Quick start

```sh
cd tests/harnesses/error-tracker
./setup.sh          # npm install, composer install, go mod tidy
./run.sh            # sink + all three languages
```

The DSN project id is numeric (`/ingest/1`) because the Sentry SDKs validate it as a number. Yoal's
`prj_…` id is mapped to a numeric error-tracker id per project; the harness sink uses `1`, `2` and
`3` for JS, PHP and Go.

Run one language, or run twice to check grouping:

```sh
./run.sh --only go
./run.sh --repeat 2
```

Against a real tracker:

```sh
./run.sh --dsn 'https://<public-key>@<host>/ingest/<numeric-project-id>'
```

Against a Sentry project (to prove the harness itself is honest):

```sh
./run.sh --dsn 'https://<key>@o123.ingest.sentry.io/456'
```

## What each harness sends

Every harness sets `release=<lang>-harness@1.0.0`, `environment=harness` and tags
`lang=<js|php|go>` / `harness=error-tracker`, then sends the same six scenarios:

| Label | What it is | What the tracker should do |
|---|---|---|
| `simple` | `new Error("…: simple failure")` | One issue, one stored event |
| `chained` | An exception with a cause/previous exception | One issue, the chain visible |
| `message` | A warning message with no stack | One issue (or message event), no crash |
| `tags` | Scoped event with tags, `user.id`, extra `orderId` and a fake `sk_test_…` token | Store the tags/user; scrub the token |
| `normalize` | A message containing an order number, UUID and count | Group across runs despite the changing-looking values |
| `telemetry` | A transaction (performance item) | Accept `200`, discard it, count it as ignored |

Running `--repeat 2` should leave each stable scenario at **one issue with a count of 2**, not two
issues. Telemetry should not create issues.

A sink run ends with a verification line per language:

```
verify: js  project 1: 10 event(s), 4 telemetry item(s), ok
verify: php project 2: 10 event(s), 2 telemetry item(s), ok
verify: go  project 3: 10 event(s), 2 telemetry item(s), ok
```

`verify.ts` reads the run's manifest and checks the expected event and telemetry captures; it fails
the run if an SDK stopped sending.

The fake secret is deliberate. It is not a credential; it exists to prove scrubbing.

## Captures

Without `--dsn`, the sink writes one JSON file per request plus `manifest.jsonl`:

```
captures/
  20261111T193800-12345-001-project-1-envelope.json
  20261111T193800-12345-002-project-1-envelope.json
  ...
  manifest.jsonl
  sink.log
```

Each capture contains the request headers, the raw body (base64), the decoded body, and a
best-effort envelope parse (header + items). These are the fixtures for the parser tests: they are
produced by the SDKs, not hand-written.

`--keep` appends to an existing captures directory; the default clears it.

## Layout

```
tests/harnesses/error-tracker/
  sink/server.ts     Sentry-shaped capture sink (no database)
  js/                @sentry/node
  php/               sentry/sentry
  go/                github.com/getsentry/sentry-go
  setup.sh           install dependencies
  run.sh             start sink and run the harnesses
```

## Requirements

- Bun (sink and runner)
- Node 22+ (JS harness)
- PHP 8.2+ and Composer (PHP harness)
- Go 1.24+ (Go harness)

## Limits

- The JS harness is Node, not a browser. Browser CORS and `sendBeacon` need a separate browser
  harness; the Node envelope is otherwise the same wire format.
- Sentry's native/mobile minidump endpoints are not exercised.
- Source maps are not exercised; `sentry-cli sourcemaps upload` uses a separate artifact-bundle API.
- The sink is a debugging tool. It never validates auth, rate limits or retention; the real tracker
  tests do that.
