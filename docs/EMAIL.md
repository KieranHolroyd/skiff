# Skiff — Email (a self-hosted SES)

Status: **design proposed, 2026-11-07, pending review.** Nothing here is built. The decisions are
written as **proposed D114–D120** (§13); they move into [DECISIONS.md](./DECISIONS.md) once agreed,
and D114 amends D22. Execution plan: [plan 24](./build-plan/plans/24-email.md).

Skiff Email lets apps send and receive mail on their own domains: verified sending domains with
DKIM, a REST send API, SMTP submission, a `send_email` binding and an `email()` handler for
functions, inbound routing, a suppression list, bounce and complaint handling, delivery events and
signed webhooks. It is Amazon SES's job done on the user's own nodes, by **Skiff's own MTA
delivering straight to recipients' MX hosts**.

Everything tenant-facing goes through `packages/core` (`EmailService`); REST, MCP, CLI and the
dashboard (**Email** in the sidebar) stay thin surfaces, as with brokers (D111).

---

## 1. Goals and non-goals

**Goals**

- Send from `anything@<verified domain>` with DKIM, SPF and DMARC passing at Gmail, Outlook and
  Yahoo, through one HTTP call, plain SMTP or a function binding.
- Never deliver to an address that hard-bounced or complained. Pause a sender before it burns the
  shared IP, not after.
- Receive mail on verified domains and route it to a function, a webhook or a bucket.
- One event stream (accepted → delivered / deferred / bounced / complained …) in the dashboard,
  ClickHouse and tenant webhooks.
- Optional and opt-in, like the telemetry store: an install that doesn't enable Email pays nothing.

**Non-goals (v1)**

- Mailboxes, IMAP/POP or webmail. Skiff routes inbound mail; it does not store it for humans.
- Marketing features: contact lists, campaigns, a template designer, open/click tracking (tracking
  is phase 3, §11).
- Dedicated IPs per org, IP warm-up automation across many IPs, or multi-region sending.
- Replacing the platform's own mail. Sign-in links, invites and alerts keep `SKIFF_SMTP_*` (D22),
  so they still work when the mail node is down (§10).

---

## 2. Delivery reality (why this is harder than the rest of Skiff)

D22 rejected self-hosted delivery because mail from a fresh VPS IP lands in spam. Choosing our own
MTA (D114) means owning the things SES hides. The design makes each one explicit:

| Requirement | Who enforces it | Where |
|---|---|---|
| Port 25 egress allowed by the provider (Scaleway: security group "Enable SMTP", after KYC) | Operator, checked by preflight | §3.3 |
| Forward-confirmed reverse DNS: the IP's PTR names the HELO host and that host resolves back to the IP | Operator sets the PTR at the provider; Skiff publishes the A record and checks the round trip | §3.3 |
| IP not on major blocklists (Spamhaus, Barracuda, …) | Preflight + daily check, alert on listing | §3.3, §7.2 |
| DKIM on every message, aligned with `From:` | Skiff (per-domain keys, signed in the MTA) | §4 |
| SPF covering the sending IPs | Skiff publishes `_spf.<platformDomain>`; domains include it | §4.2 |
| DMARC record on the `From:` domain (Gmail/Yahoo bulk rules) | Domain owner; Skiff checks and suggests | §4.2 |
| TLS to recipient MX when offered; valid cert on our MX and submission ports | MTA; cert from Caddy | §3.2 |
| Bounce rate < 5 %, complaint rate < 0.3 % (Gmail's line) | Suppression + automatic pause per org | §7 |
| One-click unsubscribe (RFC 8058) on bulk mail | Sender (we pass headers through), optional helper in the send API | §5.1 |
| Gradual ramp on a new IP | Per-destination traffic shaping + org sandbox | §3.2, §7.3 |
| Escape hatch when port 25 is blocked or the IP is listed | Optional smarthost relay per destination (SES, any SMTP) | §3.4 |

Skiff cannot make a bad IP good. Preflight refuses to enable direct delivery until port 25, FCrDNS
and the blocklist check pass, and says which one failed.

---

## 3. Topology and the MTA

### 3.1 Placement: the `mail` role

A new node role, `mail`, joins `ingress | control | compute | data | build`
(`packages/contracts/src/cluster.ts`). A mail node runs the MTA and accepts SMTP on public
**25** (inbound MX, bounces, complaint reports), **587** (submission, STARTTLS) and **465**
(submission, implicit TLS). It must have a public IPv4 with a PTR record; IPv6 egress is off unless
its own PTR checks out (Gmail is strict on IPv6).

v1 supports **one** mail node, normally the edge. A homelab node behind residential IP space is
refused as a mail node (preflight's blocklist check catches PBL listings). More than one mail node,
weighted MX records and spool failover are a clustering phase (§11, E4).

Agents advertise a `mail` capability in the heartbeat (as `brokers` does); only those nodes can
take the role.

### 3.2 The engine: KumoMTA under Skiff policy (D115)

**KumoMTA** (Apache-2.0, Rust; release `2026.09.29` at writing) is the engine, subject to spike E0
(§11). It was built for multi-tenant sending: per-tenant DKIM, egress sources and pools,
per-destination traffic shaping, bounce classification, ARF complaint parsing, HTTP injection, an
admin API (suspend, bounce, rebind, inspect) and webhook log hooks. Its DKIM signers cover RSA and
ed25519.

It runs as a **platform service**, not a tenant workload: `skiff-mta.service`, installed and removed
by the root helper (`skiff-platform-config email on|off`, the ClickHouse pattern in
`scripts/systemd/clickhouse.ts`), with the upstream build pinned by sha512 and shipped in the signed
release. It is not in `skiff-workloads.slice`; it has its own `MemoryMax` (default 512 MB) and
counts against the node's platform budget, which preflight reports.

**Skiff owns the policy; the MTA owns the queue.** The Lua policy (`init.lua`) is fixed, shipped
with the release and holds no tenant data. Every tenant decision is a call to the **node agent's
mail policy endpoint** on a unix socket, cached in Kumo with `kumo.memoize` and invalidated by a
generation number:

| Kumo hook | Agent call | Decides |
|---|---|---|
| `smtp_server_auth_plain` | `POST /mail/auth` | Credential valid, which org/project it belongs to |
| `smtp_server_message_received` (submission listeners) | `POST /mail/authorize` | `From` domain verified for that org, recipients not suppressed, org not paused, quota/rate, size, recipient count. Same pure function as the REST path (§5.3). |
| DKIM signing in `smtp_server_message_received` / `http_message_generated` | `GET /mail/dkim/<domain>` | Selector + key, delivered to the node opened for this node (§4.1) |
| `smtp_server_message_received` (port 25) | `POST /mail/inbound` | Is the recipient domain receiving here? Route? For function routes, the verdict (§6) |
| `get_queue_config` / `get_egress_path_config` | none (static + shaping file) | Egress source, HELO, TLS policy, per-provider rates; smarthost per destination when configured (§3.4) |
| Log hook (every record) | `POST /mail/events` | Event normalisation (§8) |

The agent answers from the **mail section of desired state** (§3.5), so a control-plane outage does
not stop queued mail from flowing, or submission from being authorised against the last known state.

**Spool.** RocksDB under `/var/lib/skiff/mail/spool`, or `<volume>/skiff/mail` when an operator pins
a node volume (D74). Queued mail survives restarts and an agent outage; it does not survive losing
the node (§12).

**Shaping.** Kumo's maintained per-provider shaping rules (Gmail, Microsoft, Yahoo, …) plus Skiff's
own per-org caps. New installs start with conservative per-destination rates that a platform admin
can raise.

**TLS.** Caddy already obtains certificates (DNS-01). The agent asks Caddy for `mx.<platformDomain>`
and `smtp.<platformDomain>` and hands the files to Kumo, reloading Kumo on renewal. Submission
requires TLS before AUTH (Kumo refuses AUTH in clear). Outbound uses opportunistic TLS, upgraded to
required for MTA-STS domains (phase 3).

**Fallback engine.** If E0 fails (Kumo's documented floor is 4 cores / 4 GB and our edge is
2 vCPU / 4 GB; idle RSS is undocumented; there is no Debian package), the fallback is **Postfix**:
policy over the Postfix policy-delegation protocol to the same agent endpoints, DKIM through a small
milter in the agent, and events from the journal by queue id. The control plane, API, DNS and data
model don't change; only `apps/agent/src/mail/engine-*.ts` and the helper unit do.

### 3.3 Preflight and the Settings → Email page

A platform admin enables Email from **Settings → Email** (owner-only, validate-then-restart, like
Notifications). Choosing the mail node runs preflight from that node, and every check is re-runnable
and shown as a list:

1. Port 25 egress: an `EHLO` to two large providers' MX hosts (no `MAIL FROM`).
2. Inbound reachability: the control plane connects to `<node ip>:25` from outside the node.
3. FCrDNS: `PTR(ip)` = `mx1.<platformDomain>` and `A(mx1.<platformDomain>)` = ip. Skiff creates the
   A record through Cloudflare; the PTR is a provider-console step, with the exact value to paste.
4. Blocklists: Spamhaus ZEN (queried with a DQS key when given; public resolvers get refused),
   Barracuda, SpamCop, and the IPv6 equivalents when v6 is on.
5. Budget: free memory against the MTA's `MemoryMax`.
6. Platform DNS that Skiff publishes: `mx.<platformDomain>` (A), `mx1.<platformDomain>` (A),
   `_spf.<platformDomain>` (TXT `v=spf1 ip4:<ips> -all`), `bounces.<platformDomain>` (MX →
   `mx.<platformDomain>`, plus SPF), `smtp.<platformDomain>` (A, for submission).

Direct delivery is refused until 1, 3 and 4 pass. Inbound is refused until 2 passes. The page also
holds org sandbox/limits (§7.3), the smarthost relay (§3.4), the global pause switch and the
reputation summary (§7.2).

### 3.4 Smarthost relay (optional)

Per destination pattern (`*` or e.g. `outlook.com, hotmail.com`), Kumo can hand mail to a smarthost
(SES SMTP, any relay) instead of the MX. It covers a blocked port 25, a listed IP while delisting,
or a provider that keeps junking a new IP. Credentials are sealed platform secrets. Through SES, the
domain must also be verified in SES; Skiff can register it there with its own DKIM key (SES
"BYODKIM") when SES API keys are given (phase 3).

### 3.5 Desired state for mail nodes

`DesiredState.mail` (only for the node holding the role):

```ts
mail: {
  generation: number;                  // bumps on any change; Kumo's memoize key
  hostnames: { helo: string; mx: string; submission: string; bounce: string };
  domains: Array<{ id; orgId; name; sending: boolean; receiving: boolean;
                   dkim: { selector; algorithm: 'rsa-sha256' | 'ed25519-sha256'; keyRef } [] }>;
  credentials: Array<{ id; orgId; projectId?; username; hash; allowedFromDomains: string[] }>;
  orgs: Array<{ orgId; state: 'sandbox' | 'active' | 'paused'; perSecond; perDay; verifiedRecipients?: string[] }>;
  suppressionVersion: number;          // the list itself is pulled incrementally (§7.1)
  routes: Array<InboundRoute>;         // §6
  relay?: Array<{ match: string[]; host; port; credentialRef }>;
}
```

Private keys and credentials are never in desired state as plaintext. `keyRef` and `credentialRef`
are fetched over the existing agent channel, opened by the control plane for that node (the D43
activation-env path), and held in agent memory only.

---

## 4. Sending identities

### 4.1 Domains (D116)

An **email domain** is an org resource (`email_domains`): a DNS name the org proves it controls and
then sends from, receives on, or both. Subdomains are separate identities (`mail.example.com`).
Unique across the platform; a second org claiming a verified domain gets 409.

- **DKIM key.** On create, the control plane generates an RSA-2048 key, sealed with the org key
  (`ctx.secrets`, D18). Selector `skf<yyyymm>`. An optional ed25519 key is dual-signed alongside
  (phase 3; not every receiver verifies ed25519).
- **Verification = DKIM.** The domain is verified when `<selector>._domainkey.<domain>` resolves to
  our public key, which proves control, as SES does. No separate TXT token.
- **Re-checks.** Daily. A record that stays missing for 72 h pauses sending for that domain and
  raises an alert. It resumes on the next good check.
- **Rotation.** `rotate_dkim` creates the next selector, publishes or shows its record, signs with
  both until the new one verifies, then retires the old key after 7 days.
- **Cloudflare.** When the domain sits in the platform's Cloudflare zone, or the org supplies a
  zone-scoped token, Skiff creates the records itself (grey, `comment: skiff-email`). Otherwise the
  dashboard and `get_email_domain` show them to copy. The Cloudflare client widens from
  `CNAME | A` to `CNAME | A | TXT | MX` (`packages/core/src/domains.ts`).

### 4.2 Records per domain

| Record | Value | Required for | Created by Skiff |
|---|---|---|---|
| `skf<yyyymm>._domainkey.<domain>` TXT | `v=DKIM1; k=rsa; p=<key>` | Verification, sending | When the zone is reachable |
| `<domain>` TXT (SPF) | `v=spf1 include:_spf.<platformDomain> ~all`, merged into an existing SPF record, never a second one | Sending (SPF pass for custom MAIL FROM; recommended always) | Only when no SPF record exists; otherwise shown as an edit |
| `_dmarc.<domain>` TXT | `v=DMARC1; p=none; rua=mailto:dmarc@<domain>` suggested | Gmail/Yahoo bulk rules | Never overwritten; suggested if missing |
| `<domain>` MX | `10 mx.<platformDomain>` | Receiving | Only on explicit opt-in, refused while other MX records exist unless confirmed (§6.1) |
| `<mailfrom>.<domain>` MX + TXT | `mx.<platformDomain>` + SPF | Custom MAIL FROM (phase 3) | When the zone is reachable |

**Return path.** By default the envelope sender is a VERP address on the platform's bounce domain:
`b-<messageId>@bounces.<platformDomain>`. DMARC then aligns through DKIM (relaxed), which is
enough, and no per-domain MX is needed to collect bounces. Custom MAIL FROM (`bounce.<domain>`)
adds SPF alignment and comes in phase 3.

### 4.3 Single addresses

An **email address identity** (`email_addresses`) is verified by a link sent to it. It does not let
an org send *from* the address (that needs the domain). It exists for the sandbox: an org in sandbox
may only send to addresses at its own verified domains or to verified addresses (§7.3).

---

## 5. Sending

### 5.1 One message shape

```ts
EmailSendInput = {
  from: string | { name?: string; address: string };   // address on a verified sending domain
  to: Recipient[]; cc?: Recipient[]; bcc?: Recipient[];  // ≤ 50 recipients in total
  replyTo?: Recipient[];
  subject: string;
  text?: string; html?: string;                          // at least one
  attachments?: Array<{ filename; contentType; content: base64; contentId? }>;
  headers?: Record<string, string>;                      // allowlisted; no From/Sender/DKIM/Return-Path
  tags?: Record<string, string>;                         // ≤ 10, echoed in events and webhooks
  unsubscribe?: { url: string; oneClick?: boolean };     // List-Unsubscribe (+ RFC 8058 Post header)
  idempotencyKey?: string;                               // 24 h dedupe per org
  raw?: string;                                          // full MIME instead of the fields above
}
```

The control plane builds MIME with nodemailer's `MailComposer` (already a dependency) and sets
`Message-ID: <<messageId>@<sending domain>>`. The message id (`em_<26 base32>`) is returned
immediately and threads every event. Limits: 10 MB encoded, 50 recipients, 998-char lines; `raw`
must carry a `From:` on a verified domain.

### 5.2 Three ways in (D117)

| Path | Auth | Enters at | Notes |
|---|---|---|---|
| **REST** `POST /api/v1/email/send` | Skiff API key with `email:send`, or an email credential as Bearer | Control plane `EmailService.send` → **outbox** | Batch form `POST /api/v1/email/send-batch` (≤ 100 messages) |
| **SMTP submission** `smtp.<platformDomain>:587/465` | AUTH PLAIN/LOGIN with an email credential | Kumo directly; authorised by the agent | For any framework mailer |
| **Function `send_email` binding** | The binding itself (project + binding name) | Local agent's mail sink → control plane `/api/agent/email-send` → outbox | §5.5 |

**The outbox.** REST and binding sends land in `email_outbox` (SQLite, the body as a blob) in the
same transaction as the `email_messages` row. The mail node's agent long-polls
`/api/agent/email-outbox`, injects each message into Kumo's loopback
`POST /api/inject/v1` with its message id in the meta, and acknowledges it. The row is then
deleted. This keeps the pull model (agents dial the control plane, never the reverse), lets the API
accept mail while the mail node restarts, and survives a mail node that isn't the control plane's
node. Outbox rows older than 24 h fail with `rejected: mail node unavailable`.

### 5.3 One policy function

`authorizeSend(snapshot, envelope) → { ok } | { reason }` lives in `packages/contracts` (pure, no
I/O) and runs in both places: in `EmailService.send` against the database, and in the agent against
desired state for SMTP. It checks, in order: org state (paused → refuse; sandbox → recipients
allowed?), `From` domain verified and sending-enabled for the org (and in the credential's
`allowedFromDomains`), recipient count and size, rate and daily quota, then suppression. Suppressed
recipients are **dropped with a `suppressed` event**, not an error (SES behaviour), unless every
recipient is suppressed, which returns 422.

### 5.4 Credentials and project attachment

An **email credential** (`email_credentials`): username `skf_<id>`, a 40-byte secret shown once,
stored as a scrypt hash for authentication plus a sealed copy for injection. It is scoped to an org,
optionally to a project, and optionally to a list of from-domains.

`skif email attach --project api [--prefix SMTP]` creates a project-scoped credential and injects at
activation (the brokers pattern, `consumerEnv`):

```
SMTP_HOST=smtp.<platformDomain>  SMTP_PORT=587  SMTP_SECURE=starttls
SMTP_USER=skf_…  SMTP_PASSWORD=…  SMTP_URL=smtp://skf_…:…@smtp.<platformDomain>:587
SKIFF_EMAIL_API=https://<platformDomain>/api/v1/email   # the same credential works as Bearer
```

Apps on the mail node use the public name too: the certificate matches, and nothing depends on
where the app runs.

### 5.5 Functions: `send_email` binding

Wrangler's `send_email` config maps directly:

```jsonc
{ "send_email": [{ "name": "MAILER", "allowed_sender_addresses": ["hi@example.com"],
                   "allowed_destination_addresses": [] }] }
```

The binding accepts both Cloudflare shapes: `env.MAILER.send(new EmailMessage(from, to, raw))`
(`cloudflare:email`) and the structured `env.MAILER.send({ from, to, subject, html, text })`. The
binding worker (`packages/function-bindings/src/email.js`, ported from Miniflare's email worker
where it fits) POSTs to the local agent's mail sink over an `external` service, the
`analytics-sink.ts` pattern. The agent adds the project id and binding name and forwards to the
control plane, which checks that the binding exists in the project's active spec and applies the
binding's allowlists before `authorizeSend`. The binding is refused at deploy time when Email is not
enabled or the project's org has no verified sending domain.

---

## 6. Receiving (D118)

### 6.1 Turning it on

Receiving is per domain and opt-in: `receiving: true` adds the MX record (or shows it). If the domain
already has MX records (Google Workspace, Microsoft 365), Skiff refuses unless the request says
`replaceMx: true`. The dashboard suggests a subdomain (`in.example.com`) instead. Kumo accepts mail
on port 25 only for recipient domains that are verified, receiving-enabled and have at least one
route; everything else gets `550 5.1.1` at `RCPT`, so the mail node is never an open relay.

### 6.2 Inbound checks

At `RCPT`/`DATA` time, before anything is routed:

- Connecting IP against Spamhaus ZEN (DQS key) → `554` on a listing.
- SPF, DKIM and DMARC evaluated and written as an `Authentication-Results` header. A DMARC `reject`
  policy failure is rejected; `quarantine` is marked (`X-Skiff-Spam: dmarc-quarantine`).
- Size ≤ 25 MB; per-IP connection and message rate limits.
- rspamd is an optional add-on in phase 3, because it costs roughly 150 MB of RSS.

### 6.3 Routes

An **inbound route** (`email_routes`) matches a recipient: an exact address, `*@domain`, or a
plus-tag pattern. The most specific match wins, and every receiving domain may have a catch-all.
Actions:

| Action | Delivery | Failure behaviour |
|---|---|---|
| `function` | **Synchronous, during SMTP `DATA`.** The agent POSTs the raw message and envelope to the function shim's `/__skiff/email` and waits ≤ 30 s. `message.setReject(reason)` → `550 <reason>`. A crash or timeout → `451` and the sender retries. Same semantics as Cloudflare Email Workers. | Sender's retry queue |
| `webhook` | Accepted (`250`), then queued in Kumo and POSTed by the agent as JSON (envelope, parsed headers, text/html, attachment metadata, and the raw message as base64 or a presigned URL above 1 MB), signed (§8.2) | Retried for 24 h, then `dropped` event |
| `bucket` | Accepted, then the raw `.eml` is written to a storage bucket attached to the org (`<prefix>/<yyyy>/<mm>/<dd>/<messageId>.eml`) with a scoped key | Retried for 24 h |
| `drop` | Accepted and discarded (for routes that only silence a catch-all) | — |

Function and bucket routes need their target on the **mail node** until cross-node service endpoints
(C2) exist; creating one that points elsewhere is refused and names the node. Webhook routes work
from any node.

**The `email()` handler.** The shim builds a `ForwardableEmailMessage`: `from`, `to`, `headers`,
`raw` (stream), `rawSize`, `setReject()`, `forward(rcpt, headers?)` and `reply(EmailMessage)`.
`forward` and `reply` go back through `authorizeSend`. `forward` may only target verified addresses
(§4.3), as on Cloudflare; it rewrites the envelope sender to our bounce domain and keeps the
original DKIM signature. `reply` must come from the receiving domain.

### 6.4 Bounces and complaints arriving on port 25

`bounces.<platformDomain>` is handled before routing: DSNs for `b-<messageId>@…` become `bounced`
events (Kumo's out-of-band DSN parsing). ARF complaint reports (Yahoo CFL, Microsoft JMRP and other
feedback loops, which the operator must enrol in by hand; preflight links to them) become
`complained` events. Neither is ever routed to a tenant.

---

## 7. Suppression and reputation (D119)

### 7.1 Suppression list

`email_suppressions` is per org: `(org, address)` with a reason, `bounce` | `complaint` | `manual` |
`unsubscribe`, plus a source message id and a date.

- A hard bounce (Kumo class `InvalidRecipient`, `BadDomain`, … → 5xx permanent) adds the address
  immediately. Soft bounces add it after 3 consecutive failed messages over at least 72 h.
- A complaint adds the address immediately.
- RFC 8058 one-click unsubscribe POSTs to our `List-Unsubscribe` endpoint (when the send used
  `unsubscribe.oneClick` with Skiff hosting it) and add an `unsubscribe` suppression.
- Entries stay until removed (`manual` removal is audited). Bounce entries can carry an expiry.
- The agent holds the list as a versioned set (incremental pulls, sized for tens of thousands of
  rows), so SMTP authorisation stays local.

Platform-wide, an address that hard-bounces for two different orgs within 30 days also enters a
**platform suppression list** that every org honours. The shared IP pays for every org's mistakes,
so this matches SES's global list.

### 7.2 Rates and automatic pause

For each org, over a rolling window of the last 10,000 messages, or 14 days when fewer are sent,
and only once at least 200 messages have been sent:

| Metric | Warning (alert, banner) | Pause (sending refused until a platform admin resumes) |
|---|---|---|
| Hard-bounce rate | 4 % | 8 % |
| Complaint rate | 0.1 % | 0.3 % |

A paused org gets `403 email_paused` on every path, while already-queued mail drains. The built-in
alerts (D109's per-kind configuration) carry `email.bounce_rate`, `email.complaint_rate`,
`email.domain_unverified`, `email.blocklisted` and `email.queue_backlog`.

### 7.3 Sandbox and limits

Every org starts in **sandbox**: it may only send to its own verified domains and verified addresses,
200 messages a day, 1 a second. A platform admin moves an org to `active` with explicit limits
(default 10,000 a day, 10 a second). The owner's first org (the setup wizard's) starts `active`. The
limits are org quota fields alongside the existing quotas (plan 16).

---

## 8. Events, logs and webhooks (D120)

### 8.1 Events

Kumo log records are normalised by the agent into `EmailEvent`:
`accepted | delivered | deferred | bounced | complained | rejected | suppressed | received | dropped`
(phase 3 adds `opened | clicked | unsubscribed`), with message id, org, project, domain, recipient,
attempt number, remote MX and response, bounce class, TLS, tags, and timestamps.

- **ClickHouse** `email_events` (when telemetry is installed): rates, charts and the activity search
  over 90 days, with the standard rollups.
- **SQLite** `email_messages`: one row per message with its latest status per recipient, kept 30
  days (configurable), so the dashboard's message log and `get_email_message` work without
  ClickHouse. Bodies are never kept after injection, except inbound mail a `bucket` route wrote.
- Rates for §7.2 come from counters in `email_messages`, not ClickHouse, so pausing works without
  telemetry.

### 8.2 Webhooks (event destinations)

`email_webhooks` per org: URL, event kinds, optional domain/tag filter and a signing secret. The
control plane delivers them with the **Standard Webhooks** headers (`webhook-id`,
`webhook-timestamp`, `webhook-signature` = HMAC-SHA256), retries with backoff for 24 h, and disables
a destination after 3 days of failure with an alert. Inbound `webhook` routes (§6.3) use the same
signer.

---

## 9. Surfaces

**Permissions** (`packages/contracts/src/permissions.ts`): `email:read` (domains, events,
suppressions), `email:send`, `email:update` (domains, routes, webhooks, suppressions),
`email:delete` and `email:credentials` (create/reveal credentials; not granted to API keys by
default, never on MCP, D58). Platform-level controls (mail node, sandbox, pause, relay) are platform
admin only.

**REST** (`/api/v1/email/*`): `domains` (CRUD, `:name/check`, `:name/rotate-dkim`), `addresses`,
`send`, `send-batch`, `messages` (list/search, `:id` with events), `suppressions`, `credentials`,
`routes`, `webhooks`, and `projects/:slug/email` for attach/detach. Documented in API.md when built.

**MCP:** `list_email_domains`, `get_email_domain` (records + check results, so an agent can tell the
user exactly what to paste), `create_email_domain`, `check_email_domain`, `send_email` (requires
human confirmation by elicitation and is refused while the org is in sandbox to non-verified
recipients), `list_email_messages`, `get_email_message`, `list_email_suppressions`,
`remove_email_suppression` (confirmed), and `list/create/delete_email_route`. There are no credential
tools.

**CLI:** `skif email domains add|list|check|rotate|rm`, `skif email send --from … --to … --subject …
[--html file] [--text file]`, `skif email log [--follow]`, `skif email suppressions
list|add|rm`, `skif email credentials create|list|revoke`, `skif email attach|detach`, `skif email
routes …`, `skif email webhooks …`.

**Dashboard: Email.**
- **Domains:** a records table with copy buttons and a live check per record, "Create in
  Cloudflare", DKIM rotation, and sending/receiving toggles.
- **Activity:** message log with search by recipient, message id or tag, and a per-message event
  timeline.
- **Suppressions.**
- **Routes.**
- **Webhooks.**
- **Sending:** credentials, attachments, the org's state, limits and bounce/complaint gauges.
- **Settings → Email** (platform admin): §3.3.

**Flag:** `SKIFF_FEATURE_EMAIL`, default on. Every Email page shows a calm "not set up" state with a
link to Settings → Email until a mail node is configured, which is the telemetry pattern.

---

## 10. Platform mail stays on D22

Sign-in links, invites and alerts keep the platform's own SMTP settings (`SKIFF_SMTP_*`, normally
SES). The alert path must work while the mail node is down or the IP is listed. Once Email is
healthy, an owner *may* point `SKIFF_SMTP_*` at `smtp.<platformDomain>` with a platform credential;
Settings shows the trade-off.

---

## 11. Phases

| Phase | Scope |
|---|---|
| **E0 spike** | KumoMTA on Debian 13 (2 vCPU / 4 GB): install from the pinned upstream build, idle and 10 msg/s RSS, policy round trip to a stub agent socket, DKIM pass at Gmail and Outlook from the prod IP (port 25 enabled, PTR set), inbound to a stub webhook, OOB DSN and ARF parsing. Measure Postfix with the same harness only if Kumo fails. Write the results in SPIKES.md. |
| **E1 outbound** | `mail` role + capability, helper install/remove, preflight, platform DNS, domains + DKIM + Cloudflare TXT/MX, outbox + REST send, SMTP submission, `authorizeSend`, credentials + attach, events → SQLite (+ ClickHouse), suppression from bounces/complaints, sandbox/limits/auto-pause, alerts, the dashboard pages, MCP, CLI. |
| **E2 inbound + functions** | Port-25 inbound for receiving domains, inbound checks, routes (function/webhook/bucket/drop), the `email()` handler, the `send_email` binding, tenant webhooks, address identities. |
| **E3 polish** | Custom MAIL FROM, ed25519 dual-signing, MTA-STS/TLS-RPT, DMARC aggregate report ingestion and a per-domain report view, smarthost relay with SES BYODKIM, optional rspamd, templates (`{{var}}` stored per org), open/click tracking (opt-in, `<slug>--t.<contentDomain>`), a platform-hosted unsubscribe page. |
| **E4 HA** | Several mail nodes: weighted MX, outbox fan-out, spool on replicated volumes or drained on handover, SPF covering every node ([CLUSTERING.md](./CLUSTERING.md) C4/C5). |

---

## 12. Risks

| Risk | Mitigation |
|---|---|
| The prod IP has poor or no reputation; mail goes to spam even with a perfect setup | Sandbox + low default rates as an implicit warm-up; Gmail Postmaster Tools and Microsoft SNDS enrolment linked from preflight; the smarthost relay per destination as the escape hatch |
| One org burns the shared IP for everyone | Sandbox by default, auto-pause thresholds below the providers' lines, platform suppression list, global pause |
| KumoMTA too heavy for the edge | E0 measures it first; Postfix fallback behind the same agent contract; or a dedicated small mail node |
| Losing the mail node loses queued mail | Outbox only deletes after Kumo's acceptance; spool on a node volume; E4 for real HA. Documented as an L0 resource in CLUSTERING terms |
| Open relay or open submission by mistake | Port 25 accepts only receiving domains with routes; submission requires TLS + AUTH; tests enforce both, and preflight probes an open-relay attempt from outside |
| Backscatter (bouncing spam to forged senders) | Reject at SMTP time (`RCPT`/`DATA`) rather than accept-then-bounce, except for webhook/bucket retry exhaustion, which drops with an event and never sends a DSN to an unauthenticated sender |
| Function email handler latency holds SMTP sessions open | 30 s budget, per-route concurrency cap, `451` on overflow |
| Private keys leaking through desired state or logs | Keys sealed per org, opened for the mail node only into agent memory, never in desired state or logs; Kumo receives them over the unix socket |

---

## 13. Proposed decisions

These become rows in DECISIONS.md once agreed.

- **D114 (amends D22).** Tenant email is delivered by Skiff's own MTA directly to recipients' MX
  hosts. D22 keeps the platform's own mail (sign-in, invites, alerts) on an external SMTP relay so
  that it works when the mail node does not. *Why:* the user wants SES's job on their own nodes, and
  SES's tenant model (identities, suppression, events) can't be layered on a relay we don't
  control. *Rejected:* SES as the only transport (keeps the D22 constraint, but tenants on a shared
  AWS account); Postal (Ruby + MariaDB + RabbitMQ, too heavy); a hand-written MTA in Bun (queueing,
  retries, MX/TLS and shaping are years of edge cases).
- **D115.** KumoMTA is the engine (Postfix is the fallback if spike E0 fails), run as a platform
  service on the one `mail`-role node with a fixed Lua policy. Every tenant decision is a call to the
  node agent, which answers from desired state. *Why:* the MTA owns the queue and Skiff owns tenancy,
  so swapping the engine changes one module. *Rejected:* tenant data in Lua or Kumo config files
  (two sources of truth); a per-org MTA container (one IP, so one reputation, anyway).
- **D116.** A domain is verified by its DKIM record alone. Skiff generates per-domain RSA keys sealed
  with the org key, and the default return path is VERP on `bounces.<platformDomain>`, with DMARC
  aligned through DKIM. Records are created through Cloudflare when the zone is reachable, never
  overwriting SPF or DMARC. *Rejected:* a separate TXT token (the DKIM record already proves
  control); requiring custom MAIL FROM in v1 (one more record per domain for little gain).
- **D117.** Three send paths share one pure `authorizeSend`. REST and binding sends go through a
  SQLite outbox that the mail node's agent pulls; SMTP submission enters Kumo directly and is
  authorised by the agent. *Rejected:* the control plane pushing to Kumo (breaks the pull model);
  everything through SMTP (the binding and REST would need credentials).
- **D118.** Inbound is opt-in per domain and refused over existing MX records unless confirmed. Mail
  is accepted only for routed recipients. Function routes run synchronously during `DATA`, so
  `setReject` is a real SMTP rejection; webhook and bucket routes are accept-then-deliver. Function
  and bucket targets must be on the mail node until C2. *Rejected:* store-and-forward for functions
  (no real reject; backscatter).
- **D119.** Every org has a suppression list fed by hard bounces, complaints and unsubscribes, plus a
  platform list for cross-org hard bounces. Orgs start in sandbox (the owner's first org excepted)
  and pause automatically at an 8 % bounce rate or 0.3 % complaint rate. *Rejected:* trusting every
  org on a shared IP.
- **D120.** Email events live in SQLite (30-day message log and the rate counters, so the product
  works without ClickHouse) and in ClickHouse when installed. Tenant webhooks use Standard Webhooks
  signing. *Rejected:* ClickHouse as a hard dependency.

## 14. Open questions

1. Should the MTA run as a native unit (pinned upstream binary, like ClickHouse) or as a Quadlet
   container (official image)? E0 decides on footprint and update path; the native unit is preferred.
2. Templates: store them per org in v1 (SES parity), or leave rendering to the app? (Proposed: E3.)
3. Whether to accept `raw` MIME on REST at all in v1, or only through SMTP and the binding.
4. Dedicated IPs per org once more than one IP exists (egress pools make this cheap in Kumo).
