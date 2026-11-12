# Sentry SDK fixtures

Real envelopes captured from the harnesses in `tests/harnesses/error-tracker/`:

| File | SDK | Capture |
|---|---|---|
| `js-simple.envelope` | `@sentry/node` 11.12.0 | `simple` scenario, project 1 |
| `php-simple.envelope` | `sentry/sentry` 4.x | `simple` scenario, project 2 (captured gzipped; stored decompressed) |
| `go-simple.envelope` | `sentry-go` 0.50.0 | `simple` scenario, project 3 |

Only the harness key and the absolute workspace paths in frames are redacted; both replacements
keep the original byte lengths so the envelope item lengths still match. `app-errors-fixtures.test.ts`
replays them through the real parser and service.
