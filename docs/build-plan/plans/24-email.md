# 24 — Email (self-hosted SES)

**Priority:** P1 · **Effort:** L · **Lane:** N · **Wave:** —
**Depends on:** signed release artifacts (MTA binary pin), the platform-config helper, functions
(D110) for E2, storage attachments (D66) for bucket routes
**Blocks:** —
**Primary files:** `docs/EMAIL.md`, `packages/contracts/src/email.ts`, `packages/core/src/email.ts`,
`packages/db/migrations/0049_email.sql`, `apps/agent/src/mail/*`, `scripts/systemd/mta.ts`,
`scripts/platform-config/helper.ts`, `apps/control-plane/src/routes/api/v1/email/**`,
`apps/control-plane/src/routes/(dashboard)/email/**`, `apps/cli/src/commands/email.ts`,
`packages/function-bindings/src/email.js`

## Status (2026-11-07)

E0's code spike passed and the MTA is Yoal's own (`packages/mail`, D115; KumoMTA dropped). E1 is
built: contracts, `yoal-mail`, migration **0050** (0049 went to event notifications), `EmailService`,
agent routes and bridge, helper verbs, `yoal-mail.service`, REST, MCP, CLI, dashboard. Still open
in E1: automated preflight, ClickHouse `email_events`, built-in alert kinds, an admin view of every
org's email state, and the real delivery check from the prod IP once its PTR is set. The design
names below that say KumoMTA or `scripts/systemd/mta.ts` are superseded by `scripts/systemd/mail.ts`
and `packages/mail`.

## Goal

Apps send and receive mail on their own verified domains through Yoal's own MTA, with DKIM,
suppression, bounce/complaint handling, events and webhooks (docs/EMAIL.md, proposed D114–D120).

## Non-goals

Mailboxes/IMAP, marketing lists and campaigns, dedicated IPs per org, multiple mail nodes (E4), and
moving platform mail off `YOAL_SMTP_*` (D22 stays for it).

## Current state

- Platform mail is nodemailer → `YOAL_SMTP_*` (`packages/core/src/notify.ts`). No tenant email.
- The Cloudflare client only writes `CNAME | A` (`packages/core/src/domains.ts:47`).
- No public TCP listener exists on any node; Caddy is HTTP-only (no layer4).
- Node roles: `ingress | control | compute | data | build` (`packages/contracts/src/cluster.ts:12`);
  capabilities `studio-principal | node-update | functions | brokers`
  (`packages/contracts/src/agent.ts:201`).
- Optional platform services follow the ClickHouse pattern: `scripts/systemd/clickhouse.ts`, helper
  action `telemetry`, `yoal-platform-config telemetry on|off`, env-driven `installed`.
- `send_email`/`email()` are refused for functions (FUNCTIONS.md §4.5).
- Latest migration 0048 (brokers).

## Design

See docs/EMAIL.md. Summary of the moving parts:

| Part | Where |
|---|---|
| `authorizeSend`, `EmailSendInput`, event/route/domain schemas, desired-state `mail` section | `packages/contracts/src/email.ts` |
| `EmailService`: domains, DKIM keys, DNS checks, Cloudflare TXT/MX, outbox, send, credentials, attach `consumerEnv`, suppression, rates/pause, webhooks | `packages/core/src/email*.ts` |
| Tables: `email_domains`, `email_addresses`, `email_credentials`, `email_outbox`, `email_messages`, `email_suppressions`, `email_routes`, `email_webhooks`, `email_webhook_deliveries`, org email state/limits | `0049_email.sql` |
| MTA unit, pinned build, fixed `init.lua`, shaping file | `scripts/systemd/mta.ts`, `scripts/mta/policy/*.lua` |
| Helper action `email` (install/remove/preflight) | `scripts/platform-config/*` |
| Agent mail module: policy socket, outbox puller, Kumo injector, event normaliser, inbound router, cert hand-off, preflight probes | `apps/agent/src/mail/*` |
| Agent ↔ control plane: `email-outbox`, `email-events`, `email-send`, `email-keys` actions | `apps/control-plane/src/routes/api/agent/[...path]/+server.ts` |
| Function binding + `email()` shim | `packages/function-bindings/src/email.js`, `apps/agent/src/function-bindings/email.ts`, `function-shim.ts` |

## Implementation order

1. **E0 spike** (blocks everything after step 2): KumoMTA on Debian 13 at 2 vCPU / 4 GB; RSS idle
   and at 10 msg/s; Lua → unix-socket policy round trip; DKIM pass at Gmail/Outlook from the prod IP
   (Scaleway "Enable SMTP", PTR set); inbound to a stub webhook; OOB DSN + ARF parsing. Record in
   SPIKES.md. On failure, repeat with Postfix.
2. Contracts: `email.ts` schemas, `authorizeSend` + exhaustive unit tests, `mail` role and capability,
   permissions, `YOAL_FEATURE_EMAIL`.
3. Migration 0049 + `EmailService` domains: DKIM keygen (sealed), record set, checks via
   `DnsResolver` (add `resolveMx`), Cloudflare TXT/MX, daily re-check sweep (F4 scheduler).
4. MTA install path: `scripts/systemd/mta.ts`, helper action, installer `--email` prompt, converge and
   update-self hooks, Settings → Email with preflight.
5. Agent mail module: policy socket (auth, authorize, dkim), outbox puller + injector, event sink →
   `email-events`. Platform DNS publishing (`mx`, `mx1`, `_spf`, `bounces`, `smtp`).
6. Send paths: REST `send`/`send-batch`, SMTP submission listeners, credentials + attach env.
7. Events → `email_messages` + ClickHouse `email_events`; suppression from bounces/complaints;
   rates + auto-pause; sandbox/limits; built-in alert kinds.
8. Surfaces: REST, MCP, CLI, dashboard Email pages. **E1 done.**
9. E2: port-25 inbound with checks, routes, synchronous function delivery + `email()` shim,
   webhook/bucket delivery, `send_email` binding, tenant webhooks, address identities.
10. E3/E4 per docs/EMAIL.md §11.

## Acceptance criteria

- A fresh domain added through MCP gets its records created through Cloudflare, verifies, and a
  `send_email` call lands in a Gmail inbox with `dkim=pass`, `spf=pass` and `dmarc=pass`.
- The same message through SMTP 587 (nodemailer, STARTTLS + AUTH) and through a function binding
  produces the same event sequence (`accepted` → `delivered`).
- A send to a hard-bouncing address yields `bounced`, a suppression row, and `suppressed` on the next
  send without an SMTP attempt.
- An org crossing 8 % hard bounces over ≥ 200 messages is paused on all three paths within one
  event batch, and an alert fires.
- Port 25 refuses unknown recipient domains at `RCPT`; an unauthenticated relay attempt fails;
  submission without TLS refuses AUTH.
- With the control plane stopped, SMTP submission still authorises from the last desired state, and
  queued mail still delivers.
- E2: `message.setReject("no")` in an `email()` handler yields an SMTP `550 no` to the sender.

## Tests

- Unit: `authorizeSend` table tests; DKIM record and SPF-merge rendering; event normalisation from
  recorded Kumo log records; bounce classification → suppression; rate windows and pause.
- Core: domain lifecycle with fake `DnsResolver` + `CloudflareClient`; outbox ack/expiry; attach
  env; webhook signing and retry.
- Agent: policy socket against a fixed desired state; outbox puller against a fake inject endpoint.
- e2e (systemd harness): MTA install/remove; SMTP submission → loopback sink MX; inbound to a
  receiving domain → webhook; open-relay and AUTH-without-TLS refusals.

## Risks and mitigations

docs/EMAIL.md §12. The project-level risk is deliverability from the prod IP; E0 proves it before
any surface work.

## Rollout

Behind `YOAL_FEATURE_EMAIL` and an explicit install in Settings → Email. Nothing listens on 25/587/465
until the helper installs the MTA. D114–D120 move into DECISIONS.md when the design is agreed;
D22's row is amended in the same change.

## Open questions

docs/EMAIL.md §14.

## File ownership

This plan owns every `email*` / `mail/*` path above and the `email` helper action. Shared edits:
`cluster.ts` (role), `agent.ts` (capability, desired state), `permissions.ts`, `features.ts`,
`domains.ts` (record types + `resolveMx`), `function.ts` (binding kind), `workloads.ts`
(`consumerEnv` merge), the agent route switch, `+layout.svelte` (nav).
