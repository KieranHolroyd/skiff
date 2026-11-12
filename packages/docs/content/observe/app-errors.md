---
title: App errors
description: Sentry-compatible error tracking for every app in the organization, from one top-level Errors page.
---

The organization-level **Errors** page collects exceptions from Yoal projects and from off-platform
apps. A Sentry SDK works by changing one DSN, and a static site can use one script tag. Errors are
grouped into issues with a stack trace, an exact count and a resolve button. There are no
organisations, teams, replays, performance traces, crons or alert rules to configure.

## Link targets

Open **Observe → Errors → Targets**.

- **Automatic linking** gives every project in the organization a DSN and injects it into linked
  process apps and functions. New projects are linked as they are created. Turning it off disables
  the targets it created and keeps their data.
- **Attach an off-platform project** creates a standalone target with its own DSN for an app that
  Yoal does not deploy.
- Each target can be enabled, disabled, rotated, sampled, notified and deleted independently.

Copy the DSN from a target, or use its browser snippet. Press **Send test** to prove the pipe works.

## Connect an app

### A Sentry SDK

Replace the Sentry DSN with the target's DSN. Nothing else changes:

```ts
Sentry.init({
  dsn: 'https://<public-key>@<your-platform>/ingest/<target-number>',
  release: 'web@1.4.2',
  environment: 'production',
});
```

The same works for `@sentry/browser`, `@sentry/node`, `@sentry/bun`, `sentry/sentry` for PHP,
`sentry-go`, `sentry-python` and the other Sentry SDKs. Only error events are stored; a SDK's
sessions, transactions, replays, profiles, attachments and check-ins are accepted and discarded.

### A static site

Add one line before `</head>`:

```html
<script src="https://<your-platform>/e.js"
        data-dsn="https://<public-key>@<your-platform>/ingest/<target-number>"
        data-release="web@1.4.2"
        data-environment="production"></script>
```

The script catches `window.onerror` and unhandled promise rejections and sends them with
`sendBeacon` on page hide. `data-release` and `data-environment` are optional. If the site has a
Content Security Policy, allow the platform origin in `script-src` and `connect-src`.

### A process app or function

For a linked target, Yoal injects these into a process app's activation environment (and the DSN
into a function's bindings) unless the app already sets them:

| Variable | Value |
|---|---|
| `SENTRY_DSN` | the target DSN |
| `SENTRY_RELEASE` | the deployment id (process apps) |
| `SENTRY_ENVIRONMENT` | `production` or `preview` (process apps) |

A Sentry SDK that reads these variables needs no code change.

## What is recorded

Each event has an exception chain, a message, stack frames, tags, the request path, the user id,
the environment and the release. A `fatal`, `error`, `warning`, `info` or `debug` level is kept.

Messages and stacks are scrubbed of credentials, tokens, JWTs, AWS keys, PEM blocks and
`password=`/`token:` pairs before storage. Request headers, cookies, bodies, query strings, user
email, username and IP are never stored, even if a SDK sends them.

Issues group by target, platform, environment, exception type, normalised message, the top three
in-app frames and the culprit. Line numbers, build hashes, ids, numbers and quoted values are
ignored, so one bug stays one issue across deploys. Release is not part of the grouping; environment
is, so staging never reopens or inflates a production issue.

## Issues

The **Issues** tab has **Unresolved**, **Resolved**, **Ignored** and **All** filters, plus filters
for target, environment, release and time range (24 hours, 7 days, 30 days or all time) and a search
over the type, message, culprit and issue id. Older matches load with **Load older issues**.

Open an issue to see its target, 24-hour and 14-day charts, exception chain and the newest stored
events. **Resolve** marks it fixed; a new event reopens it and records that regression. **Ignore**
keeps counting but hides it from the default list. **Delete** removes the issue, its events and
counts.

Counts are exact. Stored events are sampled: at most one per issue per second, 50 kept per issue
and 500 per target per minute. Events and hourly counts are pruned after 30 days; issues not seen
for 90 days are removed.

## Limits

Ingest is rate limited per target (600 events a minute, burst 50) and globally. A target has a soft
cap of 100,000 accepted events a month; past it, events are rejected with a Sentry rate-limit
response and the target panel says so. It never blocks a deploy or a visitor.

Rotating the key creates a new DSN. The old key keeps working for 24 hours so a rollout is not a
race.

## Not included

Source maps are not uploaded yet, so a minified browser stack shows the minified location. There
are no performance traces, session replays, profiling, crons, uptime checks, issue comments,
assignment, teams or custom alert rules. A new or regressed issue can send one notification to the
organisation's configured channels; it is off by default.
