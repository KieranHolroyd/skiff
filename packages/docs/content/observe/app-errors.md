---
title: App errors
description: Sentry-compatible error tracking for every app in the organization, from one top-level Errors page.
---

The organization-level **Errors** page collects exceptions from Yoal projects and from off-platform
apps. A Sentry SDK works by changing one DSN, and a static site can use one script tag. Errors are
grouped into issues with a stack trace, an exact count and a resolve button. There are no
organisations, teams, replays, performance traces, crons or alert rules to configure.

## Set up

Open **Observe → Errors**. The sidebar switches to the Errors sections: **Issues**, **Targets** and
**Setup**. A fresh organization lands on **Setup**, a three-step guide:

1. **Choose where errors go.** Link every Yoal project at once (recommended), link one project, or
   create a target for an app outside Yoal. Once targets exist, pick one from the list.
2. **Add the SDK.** Pick Node/Bun, Browser, Static site, PHP, Go or Python to get the install command
   and an init snippet with the target's real DSN. For a linked Yoal project the snippet reads the
   injected `SENTRY_DSN` instead, so it holds no secret. Optionally tag events with an environment
   and release.
3. **Send your first error.** Send a test error from Yoal, add one `captureException` line to the
   app, or `curl` an event straight at the DSN from a terminal. The page listens for the event and
   updates the moment it lands; then it offers the target's issues and new-issue notifications.

Already using Sentry? Swap the DSN in your existing `Sentry.init` and skip to step 3.

## Targets

The **Targets** section lists every target with its health (reporting, quiet, waiting for its first
event, or disabled), a seven-day sparkline, unresolved and 24-hour counts, and its DSN with a copy
button.

- **Automatic linking** gives every project in the organization a target and injects its DSN into
  process apps and functions. New projects are linked as they are created. Turning it off disables
  the targets it created and keeps their data.
- **Add target** links one Yoal project by hand, or creates a standalone target for an app that Yoal
  does not deploy.
- Each target's **⋯** menu opens its issues or setup guide, copies the DSN, sends a test error, edits
  settings (name, stored-event sample rate, notifications, monthly usage), rotates the key,
  enables or disables it, or deletes it.

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

The **Issues** section opens with unresolved, 24-hour, reporting-target and resolved counts and
14-day charts of events and new issues (hover a bar for its value). Status tabs (**Unresolved**,
**Resolved**, **Ignored**, **All**) show their counts. Filter by target, level, environment, release
and when it was last seen (24 hours, 7 days, 30 days or all), search the type, message, culprit or
issue id, and sort by last seen, first seen or most events. Active filters show as chips you can
remove one at a time.

Each row shows the level, type, message, culprit, target, environment and release, with **New**
(first seen in the last day) and **Regressed** flags, the total and today's event counts, and when it
was last and first seen. Hover a row to resolve, ignore or reopen it; tick rows for bulk actions.

Open an issue to see its status and any regression, its counts and releases, a 24-hour or 14-day
chart, and one stored event at a time: request, release and user, the exception chain with your own
frames shown and library frames folded (**Full stack** opens them), and the tags, context and
extra. Step through occurrences with the arrows or the list beside it. **Resolve** marks it fixed; a
new event reopens it and flags the regression. **Ignore** keeps counting but hides it from the
default list. The **⋯** menu copies a link or the issue id, and deletes the issue with its events and
counts.

### Keyboard shortcuts

| Key | In the list | On an issue |
|---|---|---|
| `/` | Search | |
| `j` / `k` | Next / previous issue | Older / newer event |
| `x` | Select the issue | |
| `o` | Open the issue | |
| `r`, `i`, `u` | Resolve, ignore or reopen the selection (or the current issue) | Resolve, ignore or reopen |
| `Esc` | Clear the selection | Back to the list |

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
