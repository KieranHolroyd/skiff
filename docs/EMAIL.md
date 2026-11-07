# Skiff — Email (a self-hosted SES)

Status: **E1 (outbound) built 2026-11-07**, not yet exercised on the prod node (the PTR still has
to be set, §2). Decisions **D114–D120** in [DECISIONS.md](./DECISIONS.md); D114 amends D22.
Execution plan and what's left: [plan 24](./build-plan/plans/24-email.md). Inbound routes, the
function binding and tenant webhooks (E2) are designed here but not built.

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

### 3.1 Placement: the mail node

The mail node is a platform setting (Settings → Email, `settings` key `email.node_id`), not a
placement role: a platform admin picks one node whose agent advertises the `mail` capability, and
its public IPv4 (`email.ipv4`). That IP is its own setting because `nodes.public_address` is the
WireGuard upstream the edge proxies to, which the edge itself never has. Left blank, Skiff uses a
public IPv4 in the node's address, or for the edge the platform host's A record in the managed
Cloudflare zone (its origin, even when proxied), and otherwise asks. It never takes it from public
DNS (a proxied host answers with Cloudflare's IPs). Private, CGNAT and loopback ranges are refused. It runs the MTA and accepts SMTP on public
**25** (inbound MX, bounces, complaint reports), **587** (submission, STARTTLS) and **465**
(submission, implicit TLS). It must have a public IPv4 with a PTR record; IPv6 egress is off unless
its own PTR checks out (Gmail is strict on IPv6).

v1 supports **one** mail node, normally the edge. A homelab node behind residential IP space is
refused as a mail node (preflight's blocklist check catches PBL listings). More than one mail node,
weighted MX records and spool failover are a clustering phase (§11, E4).

Agents advertise a `mail` capability in the heartbeat (as `brokers` does); only those nodes can
be chosen. Desired state carries `mail` (generation + hostnames, no secrets) only for that node.

### 3.2 The engine: `skiff-mail`, Skiff's own MTA (D115)

The MTA is Skiff code: `packages/mail`, run as **`skiff-agent mail`** under its own unit,
`skiff-mail.service`. This is the studio pattern: the same signed binary as the agent, with its own
cgroup and sandbox, and the agent as its only client. It needs no new release artifact or upstream
pin. The protocol work comes from the nodemailer family (MIT / MIT-0, one maintainer, all mature):
`smtp-server` for the listeners, nodemailer's `SMTPConnection` for outbound, `mailauth` for DKIM
sign and verify, SPF and DMARC, and `mailparser` for inbound parsing. Skiff writes the rest.

| Part | What it does | Module |
|---|---|---|
| Listeners | Port 25 (bounces, complaints, receiving domains), 587 STARTTLS and 465 implicit TLS submission; TLS before AUTH; size, recipient and connection limits | `smtp.ts` |
| Policy | `authorizeSend` (§5.3) in-process, against the state the agent pushed; credentials checked against scrypt hashes | `policy.ts` |
| DKIM | Signs each message once, before it is spooled, with the `From:` domain's key | `dkim.ts` |
| Spool | `bun:sqlite` (WAL) plus one `.eml` file per message; "250 OK" only after both are fsynced | `spool.ts` |
| Scheduler | Per-recipient state, retries at 1, 5, 15, 30 min, then hourly, expiry after 3 days (`bounced`, class `expired`) | `queue.ts` |
| Delivery | MX lookup (null MX, A/AAAA fallback, priority order), one connection per destination host with reuse, all recipients for a domain in one transaction, opportunistic STARTTLS, HELO `mx1.<platformDomain>` | `deliver.ts` |
| Shaping | Per-destination connection and message-rate limits (Gmail, Microsoft, Yahoo and a default), backing off on `421`/`4.7.x` throttling replies | `shaping.ts` |
| Classification | SMTP replies → `delivered` / transient / permanent with a bounce class (`invalid-recipient`, `bad-domain`, `mailbox-full`, `spam-block`, `policy`, `auth`, `throttled`, `expired`, …) | `classify.ts` |
| Bounces and complaints | VERP replies on `bounces.<platformDomain>` (RFC 3464 DSN) and ARF complaint reports become events | `inbound.ts` |
| Events | Append-only table; the agent pulls by cursor and acknowledges | `events.ts` |
| Control socket | `PUT /state`, `POST /inject`, `GET /events`, `POST /events/ack`, `GET /health` on `/run/skiff/mail.sock` | `control.ts` |

**The agent drives it; skiff-mail holds no credentials.** It never talks to the control plane. The
agent pushes the mail state (§3.5) with the DKIM keys and credential hashes it fetched for this node,
injects outbox messages, and pulls events. DKIM keys stay in memory. After a restart, `skiff-mail`
answers `451 4.3.0` to submissions and holds deliveries until the agent pushes state again; the
agent checks `GET /health` every few seconds and pushes immediately.

**Spool.** `/var/lib/skiff/mail` (or `<volume>/skiff/mail`, D74). Queued mail survives restarts of
`skiff-mail` and of the agent, but not the loss of the node (§12).

**TLS.** Caddy already obtains certificates (DNS-01). The agent asks Caddy to manage
`mx.<platformDomain>` and `smtp.<platformDomain>`, copies the files to `/run/skiff/mail-tls/`, and
pushes a reload when they change. Outbound uses opportunistic STARTTLS. Required TLS for MTA-STS
domains comes in phase 3.

**Why our own.** KumoMTA was the first candidate. Its documented floor is 4 cores / 4 GB, it has no
Debian package, and its policy would have been Lua calling back into the agent for every decision.
Most of its machinery (egress pools, a throttle daemon shared across a fleet, millions of messages
an hour) serves a volume Skiff doesn't have. Spike E0 (SPIKES.md) showed the pieces Skiff needs
work under Bun 1.4: STARTTLS and implicit TLS on `smtp-server`, AUTH, DKIM sign and verify, and
200 messages over TLS in 149 ms at about 130 MB RSS with every library loaded.

### 3.3 Preflight and the Settings → Email page

A platform admin enables Email from **Settings → Email** by choosing the mail node. It's a setting
(no restart): the node's agent sees `mail` in its desired state and starts `skiff-mail`, and Skiff
publishes the platform records below through Cloudflare. **Not built yet:** the automated preflight
checks. Until they are, the operator runs them by hand. The checks, each re-runnable and shown as a list:

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

Per destination pattern (`*` or e.g. `outlook.com, hotmail.com`), `skiff-mail` can hand mail to a smarthost
(SES SMTP, any relay) instead of the MX. It covers a blocked port 25, a listed IP while delisting,
or a provider that keeps junking a new IP. Credentials are sealed platform secrets. Through SES, the
domain must also be verified in SES; Skiff can register it there with its own DKIM key (SES
"BYODKIM") when SES API keys are given (phase 3).

### 3.5 Desired state for mail nodes

`DesiredState.mail` (only for the node holding the role):

```ts
mail: {
  generation: number;                  // bumps on any change; skiff-mail ignores a push it already has
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
  dashboard and `get_email_domain` show them to copy. The setup guide's **Set up for me** button
  (`publishDomain`) writes them on demand when the zone is covered, for a domain added with
  automatic records off or before the token was saved; unlike the quiet publish in `checkDomain`,
  Cloudflare errors reach the user. The Cloudflare client widens from
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

An **email address identity** (`email_addresses`), shown to users as a *sandbox recipient*, is
verified by a link sent to it. It does not let an org send *from* the address (that needs the
domain). It exists for the sandbox: an org in sandbox may only send to addresses at its own verified
domains or to verified addresses (§7.3).

- **Adding** one (`email:update`) stores the lowercased address with the SHA-256 of a single-use
  32-byte token and mails `<platform origin>/verify-email-address?token=…` through the **platform's
  own SMTP** (D22, `SKIFF_SMTP_*`), never the org's mail node: the org isn't trusted yet. Without
  platform SMTP the add is refused (`409 platform_mail_unavailable`); if the send fails nothing is
  stored. Adding an address that is already verified changes nothing.
- **The link** lasts 24 hours. Adding a pending address again sends a fresh link and voids the old
  one, at most once a minute and 5 times per link lifetime (`sent_at`, `send_count`, migration 0066).
  An org holds at most 50 addresses, 10 of them pending (`EMAIL_SANDBOX_ADDRESS_LIMITS`).
- **The public page** shows the address and the org's name and asks for a click; only the POST
  confirms, so mail scanners that fetch links can't. Confirming sets `verified_at`, clears the token
  and bumps the pushed mail state so SMTP submissions see the address within seconds. Expired links
  answer `410 link_expired`, used or unknown ones `404 invalid_link`.
- **Removing** one makes sends to it refused again while the org is in sandbox; adding it back
  needs a new confirmation. Every step is audited (`email.address.add|resend|verify|remove`).

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
| **REST** `POST /api/v1/email/send` | Skiff API key (or session) with `email:send`. Email credentials as Bearer are not accepted yet | Control plane `EmailService.send` → **outbox** | Batch form `POST /api/v1/email/send-batch` (≤ 100 messages) |
| **SMTP submission** `smtp.<platformDomain>:587/465` | AUTH PLAIN/LOGIN with an email credential | `skiff-mail` directly; authorised in-process against the pushed state | For any framework mailer |
| **Function `send_email` binding** | The binding itself (project + binding name) | Local agent's mail sink → control plane `/api/agent/email-send` → outbox | §5.5 |

**The outbox.** REST and binding sends land in `email_outbox` (SQLite, the body as a blob) in the
same transaction as the `email_messages` row. The mail node's agent long-polls
`/api/agent/email-outbox`, injects each message into `skiff-mail` (`POST /inject` on its control socket, message id
included), and acknowledges it once `skiff-mail` has spooled it. The row is then
deleted. This keeps the pull model (agents dial the control plane, never the reverse), lets the API
accept mail while the mail node restarts, and survives a mail node that isn't the control plane's
node. Outbox rows older than 24 h fail with `rejected: mail node unavailable`.

### 5.3 One policy function

`authorizeSend(snapshot, envelope) → { ok } | { reason }` lives in `packages/contracts` (pure, no
I/O) and runs in both places: in `EmailService.send` against the database, and in `skiff-mail` against
the pushed state for SMTP. It checks, in order: org state (paused → refuse; sandbox → recipients
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
`replaceMx: true`. The dashboard suggests a subdomain (`in.example.com`) instead. `skiff-mail` accepts mail
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
| `webhook` | Accepted (`250`), then spooled by `skiff-mail` and POSTed by the agent as JSON (envelope, parsed headers, text/html, attachment metadata, and the raw message as base64 or a presigned URL above 1 MB), signed (§8.2) | Retried for 24 h, then `dropped` event |
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
events (RFC 3464 DSN parsing in `skiff-mail`). ARF complaint reports (Yahoo CFL, Microsoft JMRP and other
feedback loops, which the operator must enrol in by hand; preflight links to them) become
`complained` events. Neither is ever routed to a tenant.

---

## 7. Suppression and reputation (D119)

### 7.1 Suppression list

`email_suppressions` is per org: `(org, address)` with a reason, `bounce` | `complaint` | `manual` |
`unsubscribe`, plus a source message id and a date.

- A hard bounce (class `invalid-recipient` or `bad-domain`, a permanent 5xx) adds the address
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
(default 10,000 a day, 10 a second). An org whose email a platform admin sets up (first domain or credential) starts `active`. The
limits are org quota fields alongside the existing quotas (plan 16).

**Production access requests** (`email_access_requests`, migration 0066) are how an org asks:

- An org **owner or admin** (`email:update` and the role) submits a use case (20–2,000 characters),
  the expected messages a day and optionally a website. Refused when the org is already `active`,
  while it is `paused` (a platform admin resumes it first), or while another request is pending (one
  pending request per org, a partial unique index). Every platform admin gets a notification that
  links to `/email/requests`.
- A **platform admin** (own dashboard session, `canAdministerPlatform`) approves or denies it.
  Approving moves the org to `active` with the limits given (the active defaults otherwise) in one
  transaction; denying needs a reason and leaves the org in sandbox, free to ask again. Moving an
  org out by hand in Settings → Email answers its pending request as approved. The requester is
  emailed the outcome (and the reason or note) through platform SMTP.
- Requests are kept: the org sees its latest (`GET /email/access-request`), platform admins the
  queue, pending first (`GET /email/access-requests`). Audited as
  `email.access_request.create|approve|deny`.

---

## 8. Events, logs and webhooks (D120)

### 8.1 Events

`skiff-mail` writes each attempt as an `EmailEvent`, and the agent forwards them:
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

**REST** (`/api/v1/email/*`): `domains` (CRUD, `:name/check`, `:name/rotate-dkim`), `addresses`
(sandbox recipients: list, add or re-send, `DELETE :address`), `access-request` (the org's latest
request, `POST` to ask), `access-requests` (platform admin queue, `?status`, `POST :id` to decide),
`send`, `send-batch`, `messages` (list/search, `:id` with events), `suppressions`, `credentials`,
`routes`, `webhooks`, and `projects/:slug/email` for attach/detach. Documented in API.md when built.

**MCP:** `list_email_domains`, `get_email_domain` (records + check results, so an agent can tell the
user exactly what to paste), `create_email_domain`, `check_email_domain`, `send_email` (requires
human confirmation by elicitation and is refused while the org is in sandbox to non-verified
recipients), `list_email_messages`, `get_email_message`, `list_email_suppressions`,
`remove_email_suppression` (confirmed), `list_email_addresses`, `add_email_address` and
`remove_email_address` (both confirmed: adding mails a third party), and
`list/create/delete_email_route`. There are no credential tools, and none to request or decide
production access; `get_email_status` points a sandboxed org at the request.

**CLI:** `skif email domains add|list|check|rotate|rm`, `skif email send --from … --to … --subject …
[--html file] [--text file]`, `skif email log [--follow]`, `skif email suppressions
list|add|rm`, `skif email addresses list|add|rm`, `skif email request-access --use-case …
--volume … [--website …]` (no flags: show the latest request), `skif email credentials
create|list|revoke`, `skif email attach|detach`, `skif email routes …`, `skif email webhooks …`.

**Dashboard: Email.**
- **Setup guide** (`/email/setup`): a seven-step checklist from a fresh install to an app sending
  real mail, each step judged from live state. The steps: choose the mail node, point reverse DNS
  at it (checked live from the control plane: PTR names the HELO host and that host resolves back,
  preflight check 3), add a domain, publish its records (the first unverified domain's records
  inline, with Check DNS now), send a test (done on the first `delivered`), connect an app (an SMTP
  credential exists or mail arrived other than from the dashboard), and leave the sandbox.
  Platform-admin steps say so and tell other members whom to ask. The "not set up" state and the
  overview, while no domain is verified, link to it.
- **Domains:** a records table with copy buttons and a live check per record, "Create in
  Cloudflare", DKIM rotation, and sending/receiving toggles.
- **Activity:** message log with search by recipient, message id or tag, and a per-message event
  timeline.
- **Sandbox** (`/email/sandbox`): the org's state; the production access request (form for owners
  and admins, the pending request, or the last denial's reason); and the sandbox recipients with
  add, resend and remove. The overview's Sending panel and the setup guide's last step link to it.
- **Access requests** (`/email/requests`, platform admin, in the Platform group of the Email nav):
  pending requests with their use case and volume, approve (with limits) or deny (with a reason),
  and the decided history.
- **Suppressions.**
- **Routes.**
- **Webhooks.**
- **Sending:** credentials, attachments, the org's state, limits and bounce/complaint gauges.
- **Send a test:** compose one message (from a verified sending domain, to, subject, text or
  HTML) through `EmailService.send`, so limits, suppressions and the sandbox apply; it is tagged
  `source=dashboard-test` and opens the message's timeline in Activity. Domain pages link to it.
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
| **E0 spike** | Done 2026-11-07 (SPIKES.md): `smtp-server` STARTTLS/465/AUTH, `mailauth` DKIM sign + verify and `mailparser` under Bun 1.4; port 25 egress from the prod IP works. Still open: set the PTR, then a DKIM/SPF/DMARC pass at Gmail and Outlook. |
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
| Our MTA gets a delivery edge case wrong | Tests against a fake MX for every reply class; conservative retries and expiry; the smarthost relay as the escape hatch; per-attempt events make every failure visible |
| Losing the mail node loses queued mail | Outbox only deletes after `skiff-mail` has spooled the message; spool on a node volume; E4 for real HA. Documented as an L0 resource in CLUSTERING terms |
| Open relay or open submission by mistake | Port 25 accepts only receiving domains with routes; submission requires TLS + AUTH; tests enforce both, and preflight probes an open-relay attempt from outside |
| Backscatter (bouncing spam to forged senders) | Reject at SMTP time (`RCPT`/`DATA`) rather than accept-then-bounce, except for webhook/bucket retry exhaustion, which drops with an event and never sends a DSN to an unauthenticated sender |
| Function email handler latency holds SMTP sessions open | 30 s budget, per-route concurrency cap, `451` on overflow |
| Private keys leaking through desired state or logs | Keys sealed per org, opened for the mail node only, held in agent and `skiff-mail` memory, never in desired state, the spool or logs; passed over the 0660 unix socket |

---

## 13. Decisions (as recorded in DECISIONS.md)

These are summaries; the rows in [DECISIONS.md](./DECISIONS.md) are authoritative.

- **D114 (amends D22).** Tenant email is delivered by Skiff's own MTA directly to recipients' MX
  hosts. D22 keeps the platform's own mail (sign-in, invites, alerts) on an external SMTP relay so
  that it works when the mail node does not. *Why:* the user wants SES's job on their own nodes, and
  SES's tenant model (identities, suppression, events) can't be layered on a relay we don't
  control. *Rejected:* SES as the only transport (keeps the D22 constraint, but tenants on a shared
  AWS account); Postal (Ruby + MariaDB + RabbitMQ, too heavy).
- **D115.** The MTA is Skiff's own: `packages/mail`, run as `skiff-agent mail` under
  `skiff-mail.service` (the studio pattern), built on `smtp-server`, nodemailer's SMTP client,
  `mailauth` and `mailparser`. Skiff writes the spool, scheduler, delivery, shaping, classification
  and policy. The agent pushes state, injects outbox mail and pulls events over a unix socket;
  `skiff-mail` holds no credentials. *Why:* one language and one binary, in-process policy, no
  upstream pin, and a footprint that fits the edge. *Rejected:* KumoMTA (4-core floor, no Debian
  package, Lua calling back into the agent for every decision); Postfix (policy and events through
  log parsing); a per-org MTA (one IP, so one reputation anyway).
- **D116.** A domain is verified by its DKIM record alone. Skiff generates per-domain RSA keys sealed
  with the org key, and the default return path is VERP on `bounces.<platformDomain>`, with DMARC
  aligned through DKIM. Records are created through Cloudflare when the zone is reachable, never
  overwriting SPF or DMARC. *Rejected:* a separate TXT token (the DKIM record already proves
  control); requiring custom MAIL FROM in v1 (one more record per domain for little gain).
- **D117.** Three send paths share one pure `authorizeSend`. REST and binding sends go through a
  SQLite outbox that the mail node's agent pulls and injects; SMTP submission enters `skiff-mail`
  directly and is authorised there against the pushed state. *Rejected:* the control plane pushing to the MTA (breaks the pull model);
  everything through SMTP (the binding and REST would need credentials).
- **D118.** Inbound is opt-in per domain and refused over existing MX records unless confirmed. Mail
  is accepted only for routed recipients. Function routes run synchronously during `DATA`, so
  `setReject` is a real SMTP rejection; webhook and bucket routes are accept-then-deliver. Function
  and bucket targets must be on the mail node until C2. *Rejected:* store-and-forward for functions
  (no real reject; backscatter).
- **D119.** Every org has a suppression list fed by hard bounces, complaints and unsubscribes, plus a
  platform list for cross-org hard bounces. Orgs start in sandbox (orgs set up by a platform admin excepted)
  and pause automatically at an 8 % bounce rate or 0.3 % complaint rate. *Rejected:* trusting every
  org on a shared IP.
- **D120.** Email events live in SQLite (30-day message log and the rate counters, so the product
  works without ClickHouse) and in ClickHouse when installed. Tenant webhooks use Standard Webhooks
  signing. *Rejected:* ClickHouse as a hard dependency.

## 14. Open questions

1. Resolved by D115: `skiff-agent mail` as a native unit.
2. Templates: store them per org in v1 (SES parity), or leave rendering to the app? (Proposed: E3.)
3. Whether to accept `raw` MIME on REST at all in v1, or only through SMTP and the binding.
4. Dedicated IPs per org once more than one IP exists.
