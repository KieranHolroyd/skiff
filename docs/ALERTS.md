# Alerts

Yoal has two kinds of alert, and both arrive through the same notifiers (email, webhook, SMS,
Discord, Slack, Telegram, ntfy and Web Push; see [OPS.md §7](./OPS.md)):

- **System alerts** are built in and need no setup: node offline, disk above 85%, certificate
  expiry, a 5xx spike after a promote, failed backups and restore drills, database and storage
  budgets, quotas, and new or returning control-plane errors
  ([SERVER-ERRORS.md](./SERVER-ERRORS.md)). The maintenance loop raises them from heartbeats and SQLite state, so they
  work without the telemetry store.
- **Metric alert rules** (D109) are user-defined outage and threshold alerts over the ClickHouse
  telemetry store: "a site returns mostly 5xx", "a database stopped reporting", "p95 latency above
  2 s". This document describes them.

Both kinds appear on **Alerts** in the dashboard. System alerts show in the history for platform
admins only.

## 0. Where alert settings live

| What | Where |
|---|---|
| Delivery channels: SMTP, Twilio, chat webhooks, push keys, alert recipients | Settings → Notifications. These write the host environment through the root helper. |
| Channel status and per-channel tests | Alerts → Channels (platform admins) |
| Built-in alerts: on/off, channels, thresholds and repeat interval per kind | Alerts → System alerts (platform admins read, the platform owner edits) |
| Metric rules, silences, acknowledgements, history | Alerts → Rules, Silences, Active and History (org members, §1–§5) |

**System alert settings.** Every built-in kind (`node_offline`, `disk`, `cert`, `promote_5xx`,
`backup`, `database_storage`, `database_connections`, `database_pool`, `storage_usage`,
`broker_store`, `quota`, `telemetry`) can be turned off or sent to particular channels. The routing is stored as one JSON
row in `settings` (`system_alert_routing`). A kind that is not listed is on and goes to every
channel. Thresholds are platform policies: `nodeAlertMinutes`, `diskAlertPercent` (85),
`certWarnDays`/`certCriticalDays` (14/3), `databaseStorageAlertPercent` (85),
`databaseConnectionsAlertPercent` (90), `poolSaturationAlertPercent` (90),
`storageAlertPercent` (85) and `brokerStoreAlertPercent` (85; a queue broker's JetStream store
against its budget, from the SQLite totals, D123). `systemAlertRepeatMinutes` (30) is how often a still-true built-in
alert repeats. The maintenance loop reads all of these on every sweep, so a change applies within
a minute. A turned-off kind sends nothing and is not recorded. `OnFailure=` alerts from systemd
(`yoal-alert`) still go to every channel, because they must work with the control plane down.

## 1. Rules

A rule runs **one query** over a **trailing window** on its own **interval** and compares **one
number per series** with a **threshold**.

| Field | Default | Meaning |
|---|---|---|
| `query` | | A builder query with exactly one metric, or SQL (platform admins only). Each `groupBy` combination is one series; with no group-by the rule has one series. SQL: each row is a series; string columns are labels and the last numeric column is the value. A grouped or SQL query that returns no rows has no series. |
| `condition` | | `{ op: gt\|gte\|lt\|lte\|eq\|neq, threshold }`, in the metric's raw unit (`percentunit` is 0–1, so 5% is `0.05`). |
| `windowSeconds` | 300 | The query reads `[now − window, now]`. |
| `intervalSeconds` | 60 | How often the rule runs (60–3600 s). |
| `forSeconds` | 120 | The condition must hold this long before the series fires. |
| `keepFiringSeconds` | 0 | A firing series resolves only after the condition has been clear this long (anti-flap). |
| `noData` | `ok` | What a missing series means (§2). |
| `repeatMinutes` | 240 | Re-notify a series that is still firing; 0 notifies once. |
| `notifyOnResolve` | true | Send a "Resolved" message when a notified series recovers. |
| `channels` | `[]` | Platform notifier names (`email`, `webhook`, `sms`, `discord`, `slack`, `telegram`, `ntfy`, `push`). Empty means all. |
| `emails` | `[]` | Extra recipients for this rule, sent through the platform's SMTP settings. |
| `runbook` | | Text or a link included in every firing notification. |
| `severity` | `warning` | `info`, `warning` or `critical`; notifiers use it for priority and colour. |

Builder rules see only the rule's org: its projects, databases and storage instances, exactly
like a dashboard panel. SQL rules run as ClickHouse's read-only reader and see every org, so only
platform admins can write them. Other owners can still edit the other fields of a SQL rule.

### Outage templates

The editor and `create_alert_rule` start from presets. After creation each one is an ordinary rule.

| Template | Query | Condition |
|---|---|---|
| `site_down` | traffic `error_rate` by host, 3 min | > 50% for 2 min, keep firing 2 min, critical |
| `high_error_rate` | traffic `error_rate` by host, 5 min | > 5% for 5 min |
| `slow_responses` | traffic `duration_p95_ms` by host, 5 min | > 2 s for 5 min |
| `traffic_stopped` | traffic `requests` by project, 10 min | < 1, no data = alerting, critical |
| `database_down` | databases `min(up)` by database, 2 min | < 1 for 2 min, no data = alerting, critical |
| `pooler_down` | databases `max(pooler_up)` by database | < 1 for 2 min, critical |
| `database_connections` | databases `connection_utilization` | > 90% for 5 min |
| `database_deadlocks` | databases `sum(deadlocks)`, 5 min | > 0, repeat hourly |
| `storage_down` | storage `min(up)` by instance, 2 min | < 1 for 2 min, no data = alerting, critical |
| `broker_down` | brokers `min(up)` by broker, 2 min | < 1 for 2 min, no data = alerting, critical |
| `broker_store_full` | brokers `store_utilization` by broker, 5 min | > 85% for 5 min |
| `broker_backlog_stale` | brokers `min(oldest_age_seconds)` by broker, 10 min | > 15 min (a draining queue's oldest message) |

## 2. States

Each series keeps a small state machine in `alert_instances`:

```
            condition met                    held for `forSeconds`
  normal ─────────────────▶ pending ─────────────────────────────▶ firing
    ▲                          │                                     │
    └──────── condition clear ─┘◀──── clear for `keepFiringSeconds` ─┘
```

`forSeconds: 0` goes straight to firing. A series the query no longer returns has **no data**,
and `noData` decides what that means:

| `noData` | Missing data is… | Use for |
|---|---|---|
| `ok` | the condition clearing | error-rate and latency rules (a quiet site is fine) |
| `alerting` | the condition holding (pending → firing) | outage rules: a database or host that stops reporting is down |
| `nodata` | its own `nodata` state, notified as "No data" | an exporter you expect to report |
| `keep` | ignored; the last state holds | flaky sources |

A series whose project, database or storage instance has been deleted is dropped, not reported
as down. A normal series that has been missing for 24 hours is forgotten.

## 3. Notifications

- **Grouping.** Each evaluation of a rule sends at most one firing message and one resolved
  message, listing up to ten series. Ten hosts failing at once send one message.
- **When.** A series notifies when it enters `firing` or `nodata`, again every `repeatMinutes`
  while it stays there, and once when it recovers if `notifyOnResolve` is set.
- **Payload.** Notifiers receive `{ key, title, detail, severity, status, url, labels }`. `status`
  is `firing` or `resolved`, and resolved messages have severity `info`. `url` links to the rule.
  `key` is `alert_rule:<id>`, so a webhook receiver can deduplicate on it. The generic webhook
  (`YOAL_ALERT_WEBHOOK`) POSTs JSON `{ title, message, severity, key, status, url, labels }`:
  `message` is the detail, and `title`/`message`/`severity`/`key` are the original fields, so
  receivers written for them keep working. `url` is null only where no dashboard page exists.
  A Discord or Slack URL there gets that service's own payload instead.
- **Signature.** With `YOAL_ALERT_WEBHOOK_SECRET` set (Settings → Notifications), each generic
  webhook request carries `X-Yoal-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret,
  "<t>.<raw body>")>` (Stripe's scheme, `packages/core/src/webhook-signature.ts`). The timestamp
  is inside the MAC, so a receiver that rejects a `t` older than five minutes also rejects replays.
  Several `v1` values may appear during a rotation; any match is valid. Log drains (DESIGN §8) sign
  their webhook batches the same way, each drain with its own secret.
- **Delivery** is recorded per channel on the history event (`{ webhook: 'ok', sms: 'Twilio
  returned 400 …' }`). A failing channel never blocks the others, and each send has a 20 s timeout.
- **Acknowledging** a firing series stops its repeats until it resolves. Org owners, admins and
  deployers can do this.
- **Silences** mute notifications for a period. A silence covers one rule or every rule in the
  org, optionally narrowed by label matchers such as `host = shop.example.com`. States still
  change while a silence is on. If a series is still firing when the silence ends and nobody has
  been told, it notifies then. Silences last at most 90 days.

## 4. Failure handling

The evaluator fails safe. It never resolves or fires anything because of its own problems.

- **A rule's query fails** (bad SQL, a removed field). Every series keeps its state, the rule
  shows `health: error` with the message, and after 10 minutes of failures the rule's channels
  get one "Alert rule failing" message per failure streak.
- **ClickHouse is unavailable.** Rules are skipped and keep their states. After 10 minutes the
  platform notifiers get one critical "Alert rules cannot evaluate" message, and one more when the
  store is back.
- **Concurrency.** Each rule is claimed with a conditional `UPDATE` on `next_eval_at`, so a
  standby or a second process never evaluates a rule twice. Standbys do not run the loop (see
  `YOAL_STANDBY`).

The control plane checks for due rules every 20 seconds, so a rule runs at most about 20 s after
its interval. The time from failure to page is roughly the window filling, plus `forSeconds`,
plus up to one interval. For `site_down` that is about 3–5 minutes.

## 5. Surfaces

- **Dashboard.** Alerts has tabs for Active, Rules, Silences and History, plus a page per rule
  with a chart and its threshold. Any builder panel on a dashboard has **Create alert…** in its
  menu. Firing and no-data series have **Ask AI** when the assistant is configured: it opens the
  panel with the rule, series, value and duration and asks it to explain the alert.
- **REST.** `/api/v1/alerts/*` ([API.md](./API.md#alerts)).
- **MCP and the assistant.** `list_alerts`, `get_alert_rule`, `create_alert_rule` (templates),
  `update_alert_rule`, `silence_alerts`, `acknowledge_alert`, `get_alert_history`, and
  `delete_alert_rule` (asks for confirmation).

## 6. Storage

Migration `0038_alert_rules.sql` adds four tables: `alert_rules` (spec JSON, health, schedule),
`alert_instances` (one row per series), `alert_events` (history, kept 90 days) and
`alert_silences` (kept 30 days after they end). The tables are in the platform SQLite database,
so Litestream replicates them, and the alert history survives a restore.

## 7. Limits and follow-ups

- Metric rules cover what ClickHouse holds: traffic, database and storage samples. Node health is
  heartbeat-based and stays a system alert.
- One threshold per rule. For warning and critical levels, make two rules.
- No synthetic HTTP checks. Traffic rules only see requests that reach the edge, so for an
  outside-in view use `traffic_stopped` with `noData: alerting`.
- Planned: annotations of firing periods on dashboard time series, per-org notification channels,
  and a public status page ([FEATURE-RESEARCH.md](./FEATURE-RESEARCH.md)).
