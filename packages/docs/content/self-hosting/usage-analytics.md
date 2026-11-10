---
title: Usage analytics
description: The optional anonymous usage ping — what it sends, how to turn it on or off, and how to point it at your own collector.
---

Yoal can send one small anonymous ping a day so we can see how the platform is used and where to
add features. It is **off by default**. Nothing is sent unless a platform owner ticks **Send
anonymous usage data**.

## Turning it on or off

There are two places, and both save the same setting:

- On the last step of the setup wizard, tick or leave unticked **Send anonymous usage data**.
- Later, open **Settings → Usage analytics** and use the switch.

Only a platform administrator can change it. Turning it off stops sending immediately; the next
background sweep only reads the setting.

The settings page shows the exact JSON body of the next ping before you turn it on, built from your
install right now. There is also **Send one ping now**, which is useful after changing a firewall.

## What it sends

Counts, the release, the OS family, the feature flags that are on, the optional services you have
configured, and a random install id. It never sends a hostname, IP address, domain name, user,
organisation, project or database name, or any file path, secret or log line.

The full field list, an example payload and the collector's rules are in
[Usage analytics](https://github.com/KieranHolroyd/yoal/blob/main/docs/USAGE-ANALYTICS.md) in the
repository, beside the source that builds it.

The install id is 128 random bits, generated when you first turn the setting on. It exists only to
count one install once. It is not derived from your server, and turning the setting off keeps it so
that opting in again does not look like a new install.

## Pointing it elsewhere

The default collector is `https://yoal-analytics-engine.kierancloud.dev/api/v1/ping`. If you would rather run your own:

1. Deploy [`apps/usage`](https://github.com/KieranHolroyd/yoal/tree/main/apps/usage) — a single Bun process
   with one SQLite file — as a normal Yoal project with a volume.
2. Set **Collector endpoint** under **Settings → Usage analytics**, or set
   `YOAL_USAGE_ANALYTICS_ENDPOINT` in `/etc/yoal/yoal.env` and restart the control plane.

The environment variable wins over the dashboard field, so a host can be pinned to a private
collector without the field being changeable.

## If a ping fails

The settings page shows the HTTP status or transport error from the last attempt. The sender tries
once a day, not in a loop: an outage or a blocked egress rule costs one day, and the dashboard keeps
working. Nothing else in the platform depends on the ping.
