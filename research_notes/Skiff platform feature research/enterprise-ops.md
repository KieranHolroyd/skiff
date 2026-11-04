# Enterprise and operations features deployment platforms converge on (November 2026)

Scope: Vercel, Netlify, Cloudflare, Render, Railway, Fly.io, Heroku, Northflank, Coolify and Dokploy, with AWS/GCP/Azure used as the expectation-setting baseline. Evidence is primary vendor documentation and trust/security pages where possible; marketing pages are marked as such. Research date: 4 November 2026.

Skiff baseline used for the sketches (from the repo, not external research): SvelteKit control plane, SQLite + DuckDB, `packages/core` as the single service layer, orgs/RBAC in `packages/contracts`, audit table, API keys, Better Auth with passkeys/2FA/GitHub, share links, Litestream→R2 with monthly restore drills, email/webhook alerts, Prometheus `/metrics`, 7-day/500k-row workload logs, single control plane, MCP server, installer upgrade/rollback but no in-process updater yet — [Skiff README](https://github.com/KieranHolroyd/skiff/blob/main/README.md), [OPS.md](https://github.com/KieranHolroyd/skiff/blob/main/docs/OPS.md), [ROADMAP.md](https://github.com/KieranHolroyd/skiff/blob/main/docs/ROADMAP.md).

Two framing points that recur below:

1. **The market splits into two tiers.** SSO and audit logs are sold as enterprise/paid features almost everywhere, but the *definition* of enterprise varies wildly: Cloudflare gives dashboard SSO away free, Fly.io only supports Google/GitHub org login, and Render/Railway/Vercel gate SAML behind Scale/Enterprise/Pro add-ons. A small self-hosted product should treat OIDC SSO + audit export as team table stakes and SAML/SCIM as enterprise-only.
2. **Self-hosting changes the compliance story.** Skiff cannot become SOC 2 certified on behalf of its operators. What it can ship is the *evidence pack* and controls that let an operator pass their own review: immutable-enough audit logs, export, retention, DPA/subprocessor templates, restore evidence, access review exports, and documented data flow. Vercel's security page is a useful checklist of what buyers expect to be handed — SOC 2 Type 2, ISO 27001, PCI, HIPAA, GDPR/DPF, DPA, subprocessor list, pen-test reports, bug bounty, backup cadence and failover — [Vercel Security](https://vercel.com/security).

---

## Identity and access: SSO, SCIM, roles, service accounts, session policy, IP allowlists, domain capture, guests

### Takeaway

OIDC/SAML SSO plus enforced SSO is the single highest-leverage enterprise feature, and Better Auth already ships plugins for SSO (OIDC/OAuth2/SAML 2.0) and SCIM 2.0, so Skiff can add it without a new identity stack. SCIM, custom roles, IP allowlists and domain capture are enterprise-only. Service accounts with scoped tokens and project-scoped guest access are more valuable to small teams than custom roles.

### Cited Findings

- Vercel SAML is available on Enterprise and as a paid Pro add-on; it supports enforced SSO, a configurable `session_lifetime` of 1–30 days (default 24 hours), and JIT addition of new SAML users. Directory Sync (SCIM) is Enterprise-only and maps IdP groups to Vercel roles, with reserved group names to prevent owner lockout — [Vercel SAML](https://vercel.com/docs/saml), [Vercel Directory Sync](https://vercel.com/docs/directory-sync).
- Netlify Organization SSO is a prerequisite for SCIM Directory Sync; Directory Sync is Enterprise-only, maps directory groups to team + role + site access, and only Organization Owners can change provisioned users — [Netlify Directory Sync](https://docs.netlify.com/manage/security/secure-netlify-access/directory-sync/).
- Render SAML SSO and SCIM require Scale or Enterprise. Render supports **SAML 2.0 only**, one IdP per organization, JIT provisioning, and an enforcement flow that warns it will lock out non-SSO members and invalidate their API keys until they re-authenticate. Guests can be invited to a single workspace but cannot use SSO — [Render SAML SSO](https://render.com/docs/saml-sso).
- Railway SAML SSO is Enterprise-only but supports SAML **and OIDC**, trusted domains, enforcement, IdP-initiated login, and emits SSO lifecycle events (connected/disconnected/updated/certificate renewal) — [Railway SAML](https://docs.railway.com/enterprise/saml).
- Fly.io organization SSO supports only Google Workspace hosted-domain or GitHub organization membership; there is no documented SAML, OIDC, SCIM or custom-role story — [Fly.io SSO](https://docs.fly.io/security/sso).
- Cloudflare dashboard SSO is **free on all plans** (including Free), but requires control of a custom email domain, a Zero Trust organization, domain TXT verification, and applies to every user with that domain. It explicitly does not support plus-addressed emails and offers an API-based break-glass path — [Cloudflare Dashboard SSO](https://developers.cloudflare.com/fundamentals/manage-members/dashboard-sso/). Cloudflare SCIM provisioning is Enterprise-only and limited to Okta, Microsoft Entra and Authentik — [Cloudflare SCIM](https://developers.cloudflare.com/fundamentals/account/account-security/scim-setup/).
- Heroku Enterprise accounts configure SSO at the enterprise-account level; audit trails are a separate enterprise feature — [Heroku Enterprise Account Settings](https://devcenter.heroku.com/articles/enterprise-account-settings), [Heroku Audit Trail](https://devcenter.heroku.com/articles/audit-trail).
- Dokploy sells OIDC/SAML SSO, **custom roles built from individual permissions**, resource-level permissions across users/projects/services/servers/certs/env vars/domains/backups, deployment permission separate from configuration permission, and separate read permission for logs, audit entries and metrics — all Enterprise-only, while built-in Owner/Admin/Member roles are on paid plans — [Dokploy Security](https://dokploy.com/features/security).
- Coolify's documented self-hosted auth is OAuth (GitHub, GitLab, Google, Azure, Bitbucket, Discord, Infomaniak) plus "SSO guides" for Authentik, Clerk and Zitadel. It explicitly **does not map provider groups or claims to team roles**; roles are managed in Coolify, and changing a member's role revokes that user's team API tokens — [Coolify OAuth overview](https://coolify.io/docs/core/security/authentication/oauth/overview), [Coolify members](https://coolify.io/docs/core/team/members/manage-members).
- Better Auth's `@better-auth/sso` plugin supports OIDC, OAuth2 and SAML 2.0, domain-based sign-in, org-linked providers, JIT provisioning, custom role assignment from claims, IdP-initiated OIDC, and SAML certificate rotation with multiple certs — [Better Auth SSO](https://better-auth.com/docs/plugins/sso). `@better-auth/scim` provides an inbound SCIM 2.0 service for users and groups, requires interactive DB transactions, supports group→role projection, deletes sessions on deactivation, and warns that deactivation must also be persisted and enforced because deleting sessions alone does not block future sign-in — [Better Auth SCIM](https://better-auth.com/docs/plugins/scim).
- AWS's baseline is IAM Identity Center: one SAML 2.0 federation point, directory/SCIM synchronisation of users and groups, permission sets assigned to users/groups across accounts — [AWS IAM Identity Center](https://docs.aws.amazon.com/singlesignon/latest/userguide/what-is.html).
- Microsoft's baseline is Conditional Access: policies keyed on user/group, IP location, device state, application, and risk, with MFA/device-compliance/password-change decisions. It requires Entra ID P1 (P2 for risk-based policies) — [Entra Conditional Access](https://learn.microsoft.com/en-us/entra/identity/conditional-access/overview).

### Inferences

**Convergence:** every platform above has some SSO; the *protocol* and *enforcement* are what buyers compare. SAML is still the enterprise checkbox, but OIDC is cheaper to implement and covers Okta, Entra, Google, Keycloak, Authentik and Zitadel. SCIM is consistently Enterprise-only. Group→role mapping is the feature that makes SCIM worth having; provisioning users without role mapping creates manual work and lockout risk.

**Recommended Skiff scope:**

| Candidate | User problem | Verdict | Minimal Skiff implementation |
|---|---|---|---|
| **OIDC SSO** | A team already has Google Workspace/Entra/Okta and does not want another password database; offboarding must remove access centrally. | **P0 — team table stakes** | Add `@better-auth/sso`. New `sso_provider` table: `id, org_id, type(oidc), issuer, domain, client_id, client_secret_enc, enabled, enforce, jit_role, group_role_map JSON, created_at`. Encrypt secrets with `SKIFF_MASTER_KEY`. Owner-only settings page; "Test connection" button; sign-in page detects email domain and redirects. Keep GitHub/passkey login as fallback until enforcement is proven. |
| **SAML 2.0 SSO** | Larger/older enterprises have an IdP that only speaks SAML; procurement rejects OIDC-only. | **P1 — enterprise** | Same table/UX, `type(saml)`, `idp_metadata_xml`, SP metadata endpoint `/api/auth/sso/saml2/sp/metadata`. Reuse Better Auth's SAML support; do not write a SAML stack. Gate behind an `enterprise` capability flag rather than a license server. |
| **SSO enforcement + break-glass** | Optional SSO is a suggestion; auditors want "password login disabled for our domain". The bigger risk is locking the only owner out. | **P0 with SSO** | Org-level `require_sso`. Session hook rejects non-SSO sessions for members whose email domain matches an enforced provider, except a designated `break_glass_owner` who must use passkey + TOTP and whose use raises a `security.break_glass` alert + audit event. Require the enforcing owner to re-authenticate via SSO before saving, mirroring Vercel/Render. Show a pre-flight report of affected members and API keys. |
| **Verified domain / domain capture** | Without domain verification, anyone can claim `@company.com` and intercept join flows. | **P1** | TXT record `_skiff-sso.<platform-domain>` with a random value; store `verified_at`. Only verified domains can auto-join or enforce SSO. Since Skiff is single-install, this is per-org, not global SaaS domain capture. |
| **SCIM 2.0** | HR/IT offboarding must not depend on someone remembering the Skiff dashboard; role changes should follow directory groups. | **P2 — enterprise only** | Add `@better-auth/scim` with a per-org bearer token (hashed at rest), `/api/scim/v2`, group→role projection. On deactivate: revoke sessions, revoke API keys, keep audit history, block future sign-in via a persisted `disabled` flag. Never allow SCIM to remove the last owner; return a SCIM error instead. |
| **Granular built-in roles** | "Member" can currently do too much or too little; agencies need a deployer who cannot rotate keys. | **P1 — team table stakes** | Extend the existing permission matrix in `packages/contracts` with `deployer`, `viewer`, `billing`/`auditor` (read-only audit + usage), and enforce in `packages/core`. Add project-scoped grants (`project_member` table) so a contractor sees one project, not the org. |
| **Custom roles** | Enterprise wants a role per function (deploy-only, logs-only, env-var-hidden). | **P2 — enterprise only** | `role` + `role_permission` rows referencing the same capability constants used by built-ins; UI is a checkbox matrix. Refuse to delete a role in use. Do not build a policy language. |
| **Service accounts** | CI/MCP/automation should not use a human's API key; a departed employee's token should not keep working. | **P0/P1 — team table stakes** | New principal type `service_account` (`id, org_id, name, role_id, created_by, disabled_at`) and tokens with `scopes`, `expires_at`, `last_used_at`. No interactive login, no passkey. Audit actor is `service:<name>`. MCP OAuth tokens remain a separate grant type. Show "created by" and allow one-click revoke. |
| **Token scopes** | A deploy token should not be able to delete a project or read audit logs. | **P1** | Reuse the existing scopes ∩ role intersection. Add explicit scopes: `deploy:write`, `project:read`, `logs:read`, `audit:read`, `admin:*`. Display effective permissions on the token page; refuse to mint a token broader than the creator's role. |
| **Session policy** | Shared laptops and long-lived sessions are an audit finding. | **P1** | Org settings: `session_max_age` (default 7d, max 30d), `require_2fa_for_admins`, `idle_timeout`. Enforce in the Better Auth session hook. Owners already re-prove passkey/TOTP (D10) — extend that to sensitive actions (SSO config, key rotation, restore). |
| **IP allowlist** | Admin/API access should be limited to office/VPN ranges; public site traffic must stay open. | **P2 — enterprise** | CIDR list per org, enforced only on `/dashboard`, `/api` (excluding agent/node-token endpoints and public content). IPv4+IPv6, explicit "break-glass owner bypass" with alert. Reuse Caddy `remote_ip` only as defence-in-depth; enforce in the app. |
| **Guest access** | Clients/contractors need one project without an org seat or visibility into other projects. | **P1 — agencies** | Project-scoped invite with role `viewer`/`deployer`, expiry, and no org membership. Guest cannot list org projects or members. Audit `guest.invite`/`guest.accept`. Render's guest pattern (single workspace, no SSO) is the model — [Render](https://render.com/docs/saml-sso). |
| **Two-factor/passkeys** | Already present, but enforcement is uneven. | **P0 — already done** | Keep; add org-level "require 2FA for all members" and recovery-code regeneration. Do not add SMS. |

**What not to build:** a homegrown SAML parser, a full IdP, per-tenant identity silos, or a license server. Better Auth's plugins plus a small settings surface are enough. Avoid "domain capture" across installs — Skiff is single-control-plane, so this is just verified-domain auto-join.

### Gaps

- No primary source found showing **SCIM group→custom-role** support at Render or Railway; Vercel and Netlify document group→built-in-role only. Treat custom-role SCIM mapping as an enterprise differentiator, not table stakes.
- Could not confirm whether Railway's SSO events are delivered as webhooks/email or only in-app; docs list event names but not transport.
- No vendor documentation found for **per-org IP allowlists** on Render/Railway/Fly; Vercel documents Trusted IPs as Enterprise-only ([Vercel Trusted IPs](https://vercel.com/docs/deployment-protection/methods-to-protect-deployments/trusted-ips)), so this is an enterprise expectation rather than a broad convergence.
- Coolify's generic OIDC/SAML capability beyond the listed guides is unclear; do not state it as "no SAML", only that SAML/SCIM are not documented in the pages reviewed.

---

## Audit and compliance: immutability, export, retention, SIEM, SOC 2/GDPR artefacts, residency, DPA, legal hold, approvals

### Takeaway

Audit logs are table stakes only when they are **exportable and retained beyond the dashboard's default**. The market pattern is: owner/admin-only viewer, CSV or JSON export, 30–90 days on mid tiers, 18 months on enterprise, and a SIEM sink at the top tier. "Immutable" is usually achieved by append-only storage plus external export, not by a blockchain. For Skiff, a hash-chained SQLite audit table plus daily NDJSON export to R2 is the right cost/credibility trade-off.

### Cited Findings

- Vercel Audit Logs are Enterprise-only and owner-only. CSV export covers a chosen timeframe; exports for the last 90 days do not affect billing; the export link is emailed and valid for 24 hours. Custom SIEM streaming supports S3, Splunk, Datadog, GCS and generic HTTP with JSON or NDJSON bodies, and Vercel is migrating this to "Audit Log Drains" — [Vercel Audit Logs](https://vercel.com/docs/audit-log).
- Railway audit logs are workspace-admin-only and record event type, timestamp, workspace, project, environment, event data, and actor (user / Railway staff / Railway system). GraphQL export is available. Retention is **48 hours on Free/Trial/Hobby, 30 days on Pro, 18 months on Enterprise** — [Railway Audit Logs](https://docs.railway.com/enterprise/audit-logs).
- Netlify team audit logs are Pro/Enterprise, filterable by team/project events; the docs state that the oldest retained event depends on plan and defer the exact retention to the pricing page (one changelog snippet cites 90 days, but I could not verify that against the current docs) — [Netlify Team Audit Log](https://docs.netlify.com/manage/accounts-and-billing/team-management/team-audit-log/).
- Heroku Enterprise audit trails are monthly JSON archives, explicitly **not real-time**, exportable via CLI/dashboard for compliance and accountability — [Heroku Audit Trail](https://devcenter.heroku.com/articles/audit-trail).
- Northflank audit logs exist at organisation, team, project and resource scope, include parent/child events and before/after template diffs, and can be forwarded to S3 or S3-compatible storage as gzipped NDJSON. Sinks do not backfill earlier events and can develop gaps if paused across midnight UTC — [Northflank Audit Logs](https://northflank.com/docs/v1/application/observe/audit-logs). Northflank markets "immutable audit logs exported to SIEM systems" on its Enterprise page — [Northflank Enterprise](https://northflank.com/docs/v1/application/enterprise).
- Render added audit-log export for Organization and Enterprise plans, described as "material events" over a chosen timeframe — [Render changelog](https://render.com/changelog/audit-logs-for-organization-and-enterprise-plans).
- Google Cloud Audit Logs are explicitly **immutable**, Admin Activity logs are always written and cannot be disabled, Data Access logs are opt-in and volume-heavy, and log sinks route to external storage — [Google Cloud Audit Logs](https://cloud.google.com/logging/docs/audit).
- Vercel's public security posture includes SOC 2 Type 2, ISO 27001:2022, PCI DSS SAQ, HIPAA support for enterprise, GDPR, DPF, a public DPA, a subprocessor list, third-party pen tests, a HackerOne bug bounty, AES-256 at rest, backups every two hours retained 30 days with global replication, and documented failover — [Vercel Security](https://vercel.com/security).

### Inferences

**What buyers actually check:** (a) can I see who changed production access? (b) can I get the records out into my SIEM? (c) how long are they kept? (d) can an admin delete them? (e) do you have a DPA and a subprocessor list? Vercel and Northflank answer (b) with object storage + HTTP; Railway answers with GraphQL; Heroku with monthly files. Very few mid-tier platforms offer true WORM storage.

**Recommended Skiff scope:**

| Candidate | User problem | Verdict | Minimal Skiff implementation |
|---|---|---|---|
| **Append-only, tamper-evident audit log** | "An admin with DB access can rewrite history" is a real audit finding; a plain SQLite table is not credible. | **P0 — table stakes** | Keep the existing `audit_log` table but add `prev_hash`, `entry_hash = sha256(prev_hash \|\| canonical_json(entry))`, and a per-org (or global) `audit_chain_head`. Add SQLite triggers `BEFORE UPDATE/DELETE` that `RAISE(ABORT)`. Do not expose update/delete in `packages/core`. Document that root can still rewrite the DB — hash chain + external copies make that detectable, not impossible. |
| **CSV/NDJSON export** | Auditors want a file they can open; SIEM teams want machine-readable events. | **P0** | Owner/admin endpoint `GET /api/audit/export?from&to&format=csv\|ndjson`, streamed, audited itself (`audit.export.requested/downloaded`). Include actor, action, resource type/id, IP, user agent, request id, before/after (redacted), hash. Cap by row count and time range. |
| **Configurable retention** | Teams need 90 days; regulated buyers ask for 1 year/18 months; the default should not fill the disk. | **P0** | `audit_retention_days` org setting (default 90; max 400 or 550). A daily job deletes expired rows **only if** `legal_hold = false` and the row is older than retention; write a `audit.retention.purged` summary event (count + range), not one event per row. Show "oldest retained event" in the UI. |
| **SIEM/webhook export** | Security teams do not want to poll a dashboard; they want events in Splunk/Datadog/S3. | **P1 — team/enterprise** | Webhook sink with cursor, HMAC signature, exponential backoff, dead-letter table, and replay from cursor. Optional S3/R2 sink writing `audit/YYYY/MM/DD/*.ndjson.gz` daily. Do not build vendor-specific connectors; a generic NDJSON webhook + S3 covers Splunk/Datadog via their HTTP/S3 inputs. |
| **Approval workflows for dangerous actions** | One owner can delete a project, rotate the master key, disable SSO or restore a backup at 2am; change management wants a second pair of eyes. | **P1 — team table stakes** | `approval_request` table (`id, org_id, action, resource, requested_by, approved_by, reason, expires_at, status`). Gate a short list: project delete, master-key rotation, SSO enforcement change, backup restore, owner role change, legal-hold release. Requester cannot approve their own request. Both request and decision are audit events. UI: pending approvals card + email/webhook notification. |
| **Legal hold** | Litigation or an incident requires preserving logs/backups past normal retention. | **P2 — enterprise** | `legal_hold` flag on org/project; retention job skips held scopes; deletion endpoints return 409 with the hold id. Audit `legal_hold.set/cleared` with reason. Do not pretend to support per-user holds. |
| **Compliance artefact pack** | A self-hosted buyer must produce evidence to *their* auditor; the vendor saying "we're secure" is useless. | **P1 — high leverage, low cost** | Ship `docs/compliance/`: DPA template, subprocessor list (self-hosted default: none; R2/SMTP optional), data-flow/data-map, retention schedule, access-review export (members + roles + last login), incident-response runbook, backup/restore evidence template, SOC 2 control mapping (CC6/CC7/CC8), pen-test summary placeholder. Add a "Compliance" page that exports these as a zip with the current config snapshot. Never claim Skiff is SOC 2 certified; say "SOC 2-ready controls". |
| **Data residency / DPA** | Buyers ask where data lives and who can access it. For self-hosted, the answer is strong but undocumented. | **P2 — documentation, not code** | State plainly: data stays in the operator's infrastructure; Skiff the project has no access; optional R2/SMTP are the only subprocessors. Provide a DPA template the operator can sign with *their* customers. If Skiff ever offers a hosted/cloud option, region pinning becomes real work — do not build it for self-hosted. |
| **Audit of reads / data access** | Regulated buyers want "who viewed this secret/log", not just writes. | **P2 — selective** | Log reads only for high-sensitivity objects: secret reveal, audit export, backup download, share-link creation, support-access grant. Do not log every page view; it destroys the low-resource budget and creates noise. |

**Immutability reality check:** SQLite + Litestream to R2 can be tampered with by root. A hash chain detects edits; R2 object-lock/versioning (if the bucket supports it) prevents deletion of exported segments. State this honestly in the docs. Do not market "immutable" without the external copy.

**GDPR ergonomics:** add subject-access/export and erasure helpers that operate on *personal data* (user profile, sessions, invites) while preserving audit records under a legal-obligation basis. This is a documented policy + two admin commands, not a new subsystem.

### Gaps

- No primary documentation found for Render's audit-log **retention** or event schema; the changelog confirms export exists but not duration.
- Netlify's exact audit-log retention per plan is behind the pricing page; the 90-day figure comes from a changelog snippet, not the current docs page.
- No vendor documents **legal hold** as a first-class feature in this cohort; it is an enterprise expectation from the storage/backup world rather than a PaaS convergence.
- Could not verify whether Vercel's Audit Log Drains preserve events during an outage or provide replay; the migration page was not fetched.
- "SOC 2-ready" is an inference from the control set Skiff can realistically ship; no source defines that term universally.

---

## Observability: log search/retention, metrics, traces/OTLP, alert routing, SLOs, status pages, incident timelines, maintenance windows, on-call

### Takeaway

The convergence is **export, don't rebuild**: platforms keep a short hot window (3–90 days), expose structured logs and basic resource metrics, and push long-term retention/tracing to external tools. Alert routing to Slack/PagerDuty is expected; on-call scheduling, SLO engines and status pages are usually separate products. Skiff already has the right shape (Prometheus, DuckDB telemetry, email/webhook alerts) — it needs routing, silence/maintenance, and a status page that survives control-plane failure.

### Cited Findings

- Railway captures build/deploy/env/HTTP/DNS logs, supports a filter language (`@httpStatus:500`, `@responseTime:>500`), structured JSON logs, a 500-lines/sec/replica ingestion limit, and retention of 3/7/30/90 days by plan. It explicitly says it has **no log drain** and recommends Vector/Fluent Bit or OpenTelemetry for forwarding — [Railway Logs](https://docs.railway.com/observability/logs).
- Railway metrics cover CPU, memory, disk and network, retain 30 days, and explicitly do **not** collect application-level latency, error rate or business KPIs; those must go to a third party — [Railway Metrics](https://docs.railway.com/observability/metrics).
- Vercel offers 30-day runtime log retention on Observability Plus, and Vercel Drains stream logs, traces and Speed Insights to external endpoints; Trace Drains forward OpenTelemetry spans — [Vercel changelog](https://vercel.com/changelog/30-day-runtime-log-retention-now-available-in-observability-plus), [Vercel Tracing](https://vercel.com/docs/tracing), [Vercel Drains](https://vercel.com/blog/introducing-vercel-drains).
- Northflank offers log sinks and health checks as first-class platform features — [Northflank docs](https://northflank.com/docs/v1/application/observe/configure-health-checks).
- Skiff currently has Prometheus `/metrics` on control plane and agents, optional OTLP export pending, 7-day/500k-row workload logs, and alerts for node offline, disk >85%, backup/drill failure, cert expiry and post-promote 5xx spike — [Skiff OPS.md §7](https://github.com/KieranHolroyd/skiff/blob/main/docs/OPS.md).

### Inferences

**Convergence:** nobody in this cohort tries to be Datadog. They keep logs for days, metrics for 30 days, and integrate. The differentiator for a self-hosted product is that the operator *already owns* the observability stack; Skiff should be a good Prometheus/OTLP citizen, not a log warehouse.

**Recommended Skiff scope:**

| Candidate | User problem | Verdict | Minimal Skiff implementation |
|---|---|---|---|
| **Log search + retention tiers** | "Why did the deploy fail at 03:12?" requires filtering by project, level, request id, and time — not scrolling 500k rows. | **P1 — table stakes** | Keep SQLite/DuckDB; add indexed columns (`project_id, level, request_id, ts`) and a filter bar. Retention config 7/30/90 days per org with a row cap; oldest-first GC. Export a time range to NDJSON in R2. Do not add Elasticsearch. If full-text is needed, use SQLite FTS5 over the hot window only. |
| **Alert routing (Slack/PagerDuty/webhook)** | Email alerts go to one person's inbox; teams need a channel and an escalation path. | **P0 — table stakes** | `alert_route` table (`org_id, severity, kind(slack\|pagerduty\|webhook\|email), target_enc, enabled`). Slack incoming webhook is just a JSON POST; PagerDuty uses Events API v2 (`routing_key`, `event_action`, `dedup_key`). Send severity + runbook URL + dashboard link. HMAC-sign generic webhooks. |
| **Dedupe, grouping, silence, maintenance windows** | A flapping node sends 200 emails; a planned upgrade pages the on-call. | **P1 — table stakes** | Alert state machine with `fingerprint`, `first_seen`, `last_seen`, `count`, `status(open\|acked\|resolved)`, `silenced_until`. Suppress notifications while silenced but keep the alert visible. Maintenance window = time range + scope (org/project/node) that silences alerts and shows a banner. Audit `alert.silence`/`maintenance.create`. |
| **SLOs / error budgets** | Teams want "99.9% availability this month" and a burn-rate alert, not raw 5xx counts. | **P2 — enterprise-ish** | `slo` table (`project_id, name, target, window_days, metric(availability\|latency), threshold_ms`). Compute from existing traffic buckets in DuckDB on a schedule; store daily rollups. Alert at 2% and 5% budget burn. Show a simple SLO card; do not build a query language. |
| **Status page** | When the control plane is down, customers cannot see status because the status page is served by the control plane. | **P1 — high value** | Public `status.<platformDomain>` served by Caddy from a static JSON/HTML file, not SvelteKit. Control plane writes `status.json` atomically (components, incidents, maintenance, updated_at); Caddy serves it with a short cache and stale-if-error. Owner can post an incident update from the dashboard; if the control plane is down, the last file still serves. Optional email/webhook subscribers. |
| **Incident timeline** | Postmortems need a chronological record of what happened and what was communicated. | **P2 — team** | `incident` + `incident_update` tables (`title, severity, status(investigating\|identified\|monitoring\|resolved), started_at, resolved_at, updates[]`). Link alerts by fingerprint. Export a Markdown postmortem template. Do not build paging schedules. |
| **OTLP export** | Teams with an existing Grafana/Tempo/Honeycomb stack want traces and metrics there. | **P2 — integration** | Add an OTLP/HTTP exporter config (`endpoint, headers, sample_ratio`) for control-plane and agent spans/metrics. Export only; do not store traces. This is already on the roadmap — keep it optional and off by default to protect RAM. |
| **On-call scheduling / escalation policies** | Someone must be woken up. | **Never build** | Integrate with PagerDuty/Opsgenie/Alertmanager. Document the webhook contract. Building schedules, rotations and escalations is a product in itself and conflicts with the low-resource design. |
| **Full log/trace storage** | Long-term forensics. | **Never build** | Export to R2/S3 and let the operator use Loki/Tempo/ClickHouse. State a clear retention contract. |

**Status-page nuance:** a status page is also a trust artefact. Vercel, Render, Railway, Fly.io, Netlify and Cloudflare all publish external status pages (e.g. [Vercel Status](https://www.vercel-status.com/), [Render Status](https://status.render.com/)). For a self-hosted product, the equivalent is a per-install public page, not a vendor-hosted one.

### Gaps

- No primary source found showing **SLO/error-budget** features in Vercel, Netlify, Render, Railway or Fly.io dashboards; this is a Datadog/Nobl9 expectation rather than a PaaS convergence. Mark SLOs as opportunistic.
- Could not confirm whether Render or Railway expose a native PagerDuty integration or only generic webhooks; both document notifications/alerting but the exact routing matrix was not fetched.
- No evidence of first-class **maintenance windows** in these PaaS dashboards; the convergence is "deploy freeze + alert silence" rather than a formal change-calendar feature.
- Skiff's current 7-day/500k-row log limit is from repo docs; no external benchmark exists for what a self-hosted install "should" retain.

---

## Reliability: backup/PITR, restore drills, DR runbooks, multi-node failover, health checks, canary/blue-green, maintenance mode, upgrade windows

### Takeaway

PITR is now expected on managed databases, but the **recovery window is a paid tier** (3 days hobby, 7 days pro, longer on enterprise). Volume snapshots are a safety net, not a backup. For Skiff, the differentiator is not a bigger backup system — it already has Litestream with ~1s RPO — but **proof**: restore evidence, a tested runbook, health-gated upgrades, and a canary/rollback story. Multi-node active-active is the one item that genuinely conflicts with the single-control-plane design and should be explicitly out of scope.

### Cited Findings

- Render Postgres PITR windows are **3 days on Hobby, 7 days on Pro or higher**; restoring creates a new instance, cannot target within 10 minutes of now, and logical exports are retained 7 days regardless of plan — [Render Postgres Recovery](https://render.com/docs/postgresql-backups).
- Fly.io takes daily volume snapshots by default, retains them 5 days by default with configurable retention of 1–60 days, and explicitly says snapshots should not be the primary backup method; managed Postgres supports point-in-time restore — [Fly Volumes Snapshots](https://docs.fly.io/volumes/snapshots), [Fly PITR changelog](https://fly.io/changelog/managed-postgres-point-in-time-restore/).
- Vercel states backups run every two hours, are retained 30 days, are stored separately with global replication, and are periodically tested — [Vercel Security](https://vercel.com/security).
- Netlify rollbacks are instantaneous because deploys are immutable and publishing moves a pointer; locked deploys pin production while still building; deploy retention is 30 days (90 on paid, up to 365 on Enterprise) — [Netlify Manage Deploys](https://docs.netlify.com/deploy/manage-deploys/manage-deploys-overview/).
- Vercel Rolling Releases split traffic by percentage across configurable stages, use a cookie-based bucket for session stickiness, expose canary-vs-baseline metrics, and support instant rollback/abort — [Vercel Rolling Releases](https://vercel.com/docs/rolling-releases).
- Skiff's backup design is Litestream WAL sync ~1s, 24h snapshots, 30-day retention, RPO ≤ ~1s, monthly restore drill, `skiff-restore`, `skiff-restore-drill`, recovery kit, and pre-upgrade/pre-restore snapshots — [Skiff OPS.md §5–8](https://github.com/KieranHolroyd/skiff/blob/main/docs/OPS.md).
- Skiff's installer already snapshots the DB, keeps settings on re-run, and supports `--upgrade` and rollback; the signed release bundle is published but not verified at install time, and the in-process updater is still pending — [Skiff ROADMAP](https://github.com/KieranHolroyd/skiff/blob/main/docs/ROADMAP.md).

### Inferences

**Convergence:** PITR + immutable releases + instant pointer rollback are table stakes for a deploy platform. Actual HA/failover is reserved for enterprise and is usually regional (Northflank's "global disaster recovery", Vercel's edge failover), not single-node.

**Recommended Skiff scope:**

| Candidate | User problem | Verdict | Minimal Skiff implementation |
|---|---|---|---|
| **Backup catalogue + PITR UX** | Operators know Litestream is running but not "what can I restore to, and is it good?" | **P0 — table stakes** | Settings → Backups: list snapshots from R2 (`timestamp, size, sha256, litestream generation`), show "earliest/latest restorable", RPO/RTO, last drill result. One-click "restore to new data dir" (never in-place by default), then a promotion step. Keep the existing CLI. |
| **Restore drills with evidence** | A green backup job is not proof; the monthly drill result must be visible to a buyer. | **P0 — differentiator** | Persist every drill: `started_at, finished_at, backup_ts, row_counts, checksum, duration, result, log_excerpt`. Surface a green/red badge and a downloadable signed-ish JSON report (hash + timestamp). Alert on failure (already exists). Add a quarterly "restore into a clean VM" runbook test, not just a local restore. |
| **DR runbook + RTO/RPO statement** | During an incident nobody remembers the order of operations; buyers ask for a documented RTO. | **P0 — documentation** | `docs/DR.md` with: declare incident, freeze deploys, provision host, install Skiff, restore latest snapshot, replay WAL, verify row counts, rotate keys, repoint DNS, unfreeze. State RPO ≤1s (Litestream) and RTO target (e.g. <60 min single-node). Add a `skiff dr verify` command that checks the restored DB against expected migrations/table counts. |
| **Health-gated upgrades** | An upgrade that breaks the control plane takes down the dashboard and API; rollback must be automatic, not heroic. | **P0 — table stakes** | `/healthz` (liveness) and `/readyz` (DB writable, migrations current, R2 reachable, agent heartbeat fresh). Installer/updater: snapshot → migrate → start new release → poll `/readyz` for N seconds → on failure repoint `previous` and restart. Record the upgrade + result in audit. Add `--window` / maintenance mode. |
| **Canary / blue-green for static sites** | A bad deploy should affect 5% of users, not everyone; rollback should be instant. | **P1 — team** | Static sites are already immutable releases + symlink swap, so blue-green is nearly free: keep both release dirs, switch the Caddy `root`/pointer atomically, keep the old one for instant rollback. Add optional weighted canary via a Caddy selector (cookie or header) for 5–50%, with an observation window and auto-abort on 5xx/latency. Do not build per-request traffic splitting for tier-2 workloads yet. |
| **Maintenance mode** | Operators need to take a project or the whole install offline for a migration without showing a TLS error. | **P1 — table stakes** | Per-project and platform-wide toggle. Caddy returns a branded 503 + `Retry-After` (already the edge failure pattern) while the control plane stays reachable on a separate host/port. Audit `maintenance.enable/disable` with reason and end time. Show a banner in the dashboard. |
| **Upgrade windows / defer updates** | A small business cannot take a random Tuesday upgrade; they need to pin and schedule. | **P1 — team** | `SKIFF_UPDATE_CHANNEL=stable\|beta\|nightly`, `SKIFF_PIN_VERSION`, `SKIFF_UPDATE_WINDOW="Sun 02:00-04:00 UTC"`. Updater refuses outside the window unless `--force`. Show available version + changelog + "defer until". Verify the signed manifest before applying (close the roadmap gap). |
| **Multi-node failover / active-active control plane** | "What if the box dies?" | **P3 — out of scope, be explicit** | Do not build active-active. Offer a documented **warm standby**: second host with the same install, Litestream replica, DNS failover, agents pointed at the standby. Static content already survives control-plane loss at the edge (worker sites return 503 + Retry-After; static edge sites keep serving). State the limitation in the README and enterprise docs. |
| **Edge static mirror / backup ingress** | Control-plane or origin loss should not take static sites down. | **P2 — roadmap** | Keep the roadmap item: mirror releases to a second edge or object-store-backed Caddy; Cloudflare Tunnel backup ingress + DNS failover. This is the realistic HA story for a single-control-plane product. |

**Honest positioning:** Skiff's backup story is already better than many hobby tools (1s RPO, drills, recovery kit). The gap is *evidence and ergonomics*, not mechanism. Multi-node HA is where the low-resource design and the enterprise checkbox collide; say no clearly and offer warm standby + edge mirroring instead.

### Gaps

- No primary source found for **Render/Railway/Fly maintenance windows** as a platform feature; the observed pattern is deploy freeze + status page + alert silence.
- Could not confirm whether Vercel's "instant rollback" preserves in-flight requests or only moves the routing pointer; docs describe pointer semantics, not connection draining.
- No public RTO numbers from Vercel/Netlify/Render for control-plane recovery; their SLAs cover serving, not dashboard recovery. Skiff should publish its own RTO rather than benchmark against an unavailable number.
- Multi-node failover for a single-control-plane SQLite system was not found in any comparable self-hosted product; the warm-standby recommendation is an inference, not a documented pattern in this cohort.

---

## Cost and usage: spend caps, quotas, usage dashboards, per-project budgets, billing exports / chargeback

### Takeaway

For SaaS platforms, "spend management" means thresholds (50/75/100%), notifications, a webhook, and optionally pausing production. For self-hosted Skiff there is no metered bill, so the equivalent is **quota + showback**: per-project usage, budgets that alert, hard caps that stop new deploys (not serving), and CSV/JSON exports for internal chargeback. Do not build a billing engine.

### Cited Findings

- Vercel Spend Management is Pro/Enterprise, set per billing cycle, with notifications at 50/75/100%, SMS at 100%, a webhook, and an optional "pause production deployments" action. Checks run every few minutes, so pausing is not instantaneous; paused projects return `503 DEPLOYMENT_PAUSED`; unpausing is manual per project; storage charges continue — [Vercel Spend Management](https://vercel.com/docs/spend-management).
- Vercel exposes the same budget controls via CLI (`vercel budgets set --amount 200 --pause --webhook ...`) — [Vercel Spend Management](https://vercel.com/docs/spend-management).
- Northflank documents compute plans and quotas as a first-class billing/resource concept — [Northflank Compute Plans and Quota](https://northflank.com/docs/v1/application/billing/resource-plans-and-quotas).
- Railway publishes a production lock-down guide whose stated scope includes scoped API tokens, sealed variables, private networking and workspace-level access controls; I did not fetch the full page, so treat the specific mechanics as unverified — [Railway Lock Down Production](https://docs.railway.com/guides/lock-down-production-project).
- No primary source found for Netlify or Render "hard spend cap" semantics equivalent to Vercel's pause; both publish usage-based pricing but the exact cap behaviour was not verified.

### Inferences

**Convergence:** spend caps are a SaaS billing feature, not an operational primitive. The transferable ideas for self-hosted are (a) thresholds and alerts, (b) a hard stop that is explicit and reversible, (c) per-project attribution, (d) export. The dangerous part of Vercel's design is pausing production serving; Skiff should pause *deployments*, not traffic, unless the operator opts in.

**Recommended Skiff scope:**

| Candidate | User problem | Verdict | Minimal Skiff implementation |
|---|---|---|---|
| **Usage dashboard** | "Which project is eating disk/bandwidth/build minutes?" | **P1 — table stakes** | Per-project cards from existing telemetry: release storage GB, monthly bandwidth, request count, 5xx rate, build minutes, log rows, backup size. Daily rollups in DuckDB; 30/90-day views. Export CSV. Do not build real-time billing meters. |
| **Quotas + hard caps** | One project can fill the disk or exhaust the node budget and take down everyone. | **P1 — table stakes** | Extend the existing `quotas` table: `max_projects, max_releases, max_storage_bytes, max_bandwidth_bytes_month, max_build_minutes_month, max_log_rows`. Admission check at deploy finalize; over-quota returns a clear 429/402-style error with the limit and current usage. A hard cap stops new deploys and builds, never stops serving existing releases. |
| **Per-project budgets + alerts** | Teams want a warning at 80% before the cap bites. | **P1** | `budget` rows (`scope=org\|project, metric, limit, warn_at[]`). Evaluate hourly; emit `budget.threshold` alerts at 50/75/100% through the alert router. Show a burn-down chart. No money; use the metric's native unit (GB, requests, minutes). |
| **Chargeback export** | An internal platform team must bill departments or show cost allocation. | **P2 — enterprise/agency** | Monthly CSV/JSON: `project, owner, storage_gb_month, egress_gb, requests, build_minutes, estimated_cost` with a configurable unit-price table. Include a `cost_model_version`. This is showback, not invoicing. |
| **Billing engine / payment processing** | Selling Skiff as SaaS. | **Never build** | Out of scope for self-hosted. If a hosted offering appears, integrate Stripe; do not put billing logic in `packages/core`. |

**Design caution:** a hard cap that pauses production is a availability risk. Vercel does it and warns about the delay; for Skiff, default to "block new deploys + alert", with an explicit opt-in "pause serving at 100%" for operators who really want a spend ceiling.

### Gaps

- No primary source found for Netlify/Render/Railway **hard spend caps** with the same semantics as Vercel; do not claim convergence on "pause production at budget".
- No vendor documentation for **self-hosted chargeback** in Coolify/Dokploy; this is an inference from cloud FinOps practice, not a direct competitor feature.
- Skiff's current quota schema was not read in detail; the sketch assumes the table in `docs/ROADMAP.md` is the starting point.

---

## Governance: policy-as-code, required approvals, environment protection, deploy freezes, change management

### Takeaway

The strongest convergence is **deploy freeze** (Netlify's locked deploys, Vercel's rolling-release hold, GitHub environment approvals) and **separation of deploy vs configure**. First-class policy-as-code is rare in this cohort; Git-based approval gates live in GitHub/GitLab, not the PaaS. Skiff should ship a small, enforceable policy file plus approval gates and freezes, and integrate with Git rather than invent a change-management system.

### Cited Findings

- Netlify "locked deploys" pins production to the latest published deploy while continuing to build new ones; it is explicitly a stop-auto-publishing control, with email/webhook/Slack notifications for lock/unlock. "Stop builds" is a separate, stronger control — [Netlify Manage Deploys](https://docs.netlify.com/deploy/manage-deploys/manage-deploys-overview/).
- Vercel Rolling Releases require an active release to be resolved (completed or aborted) before another promotion can start; configuration changes only affect future releases; rollback/abort are explicit actions — [Vercel Rolling Releases](https://vercel.com/docs/rolling-releases).
- GitHub Environments support required reviewers (up to six people/teams, one approval suffices), wait timers, and branch/tag restrictions — the de facto approval-gate model developers already know — [GitHub deployment environments](https://docs.github.com/actions/deployment/targeting-different-environments/using-environments-for-deployment).
- Dokploy separates deployment permission from service-configuration permission, and separates log/metric read permission from configuration read — a clear separation-of-duties model — [Dokploy Security](https://dokploy.com/features/security).
- Vercel records rolling-release lifecycle events (`started`, `approved`, `completed`, `aborted`, `configured`, `deleted`) in audit logs — [Vercel Audit Logs](https://vercel.com/docs/audit-log).
- No primary source found for a **policy-as-code** file format in Vercel/Netlify/Render/Railway; the closest analogues are GitHub environment protection rules and Netlify's `netlify.toml` deploy contexts.

### Inferences

**Convergence:** teams want "production cannot change without a human or a freeze window", not a general-purpose policy engine. The minimum viable governance set is: freeze, approval, protected environment, separation of duties, and an audit trail that ties a deploy to a change/ticket.

**Recommended Skiff scope:**

| Candidate | User problem | Verdict | Minimal Skiff implementation |
|---|---|---|---|
| **Deploy freeze** | During a launch, incident or holiday, nobody should promote to production; previews should still work. | **P0 — table stakes** | `deploy_freeze` table (`scope=org\|project\|environment, starts_at, ends_at, reason, created_by`). Block `promote` and production deploys at the service layer; allow uploads/previews. Override requires owner + reason + audit (`freeze.override`). Show a banner and include the freeze in the deploy error. Notify on create/expire via existing alerts. |
| **Approval gates for production** | A junior deployer or an agent should not be able to push to production unreviewed. | **P1 — team table stakes** | Per-environment `require_approval` + `approver_role`. Deployment enters `pending_approval`; a different user with the role approves; requester cannot self-approve. Approvals expire (e.g. 24h). The approved deployment records `approved_by` and the approval id in the audit log. MCP/CLI deploys go through the same gate. |
| **Environment protection rules** | Staging and production need different rules; production may need a branch/ref restriction and a health gate. | **P1** | Environment record: `name, require_approval, approver_role, freeze_windows, allowed_refs[], health_gate_seconds, required_checks[]`. Evaluate in `packages/core` before promote. Start with production/staging only; do not build arbitrary environments yet. |
| **Separation of duties** | The person who writes the deploy should not also be the only person who can approve it or rotate keys. | **P1** | Enforce "approver ≠ requester" for approvals; restrict master-key rotation, SSO enforcement and restore to owners; give `deployer` role deploy-only. Add an org setting `require_two_owners_for_destructive_actions`. |
| **Change annotations** | Auditors want "deploy dpl_123 was change CHG-456". | **P1 — cheap** | Optional/required `change_ref` and `ticket_url` on production deploys, stored on the deployment and copied into the audit event. Policy can require them for production. Display in the deployment detail and export. |
| **Policy-as-code** | Teams want reviewable rules in Git, not clickops. | **P2 — differentiate** | `skiff.policy.json` (or a `policy` block in `skiff.json`) evaluated at finalize/promote: `production.require_approval`, `production.require_change_ref`, `freeze_windows`, `allowed_roles`, `required_headers`, `max_release_bytes`. Store the policy hash on the deployment. Fail closed with a machine-readable error. Do not build a general expression language; a small Zod schema is enough. |
| **Change calendar / maintenance windows** | Coordinating freezes and maintenance across teams. | **P2** | Reuse `deploy_freeze` + `maintenance_window`; expose iCal/JSON feed and a dashboard calendar. Do not build a full calendar UI in v1. |

**Why policy-as-code is P2:** the cohort does not converge on it, and a bad policy engine is worse than a clear settings page. Ship the enforceable primitives first; add the file format when teams ask to review rules in PRs.

### Gaps

- No primary source found for **Railway protected environments/deployment approvals**; a third-party security guide recommends approvals but the official docs page was not located. Do not assert Railway has native approval gates.
- No primary source found for **Vercel deploy freeze** as a named feature; Vercel's controls are rolling-release hold + pause + rollback, not a calendar freeze. Netlify's locked deploys is the clearest freeze analogue.
- No vendor documents **policy-as-code** for deployment governance in this cohort; GitHub/GitLab environment rules are the closest primary model.
- Change-management integration (Jira/ServiceNow) was not documented as a native feature in the reviewed pages; treat `change_ref` as a lightweight convention, not an integration.

---

## Support and lifecycle: in-app feedback, diagnostics bundles, support access, version/update channels

### Takeaway

Support features are where self-hosted products can beat SaaS: a redacted diagnostics bundle, a time-bound audited support grant, and signed update channels with rollback are cheap and highly valued. In-app feedback and a public status page are nice-to-have. Vendor "support access" is an enterprise expectation but must be consent-based and auditable, never a backdoor.

### Cited Findings

- Northflank Enterprise includes a dedicated Slack channel with engineering, a 99.99% uptime SLA, guaranteed response times, custom disaster recovery, and a forward-deployed control plane with versioned artefacts applied on the customer's schedule — [Northflank Enterprise](https://northflank.com/docs/v1/application/enterprise).
- Vercel provides a security portal and compliance document access (`security.vercel.com`), plus support/contact-sales paths; its security FAQ documents pen tests, subprocessors and DPA — [Vercel Security](https://vercel.com/security).
- Heroku Enterprise audit trails are accessed through the enterprise account's Settings tab with a `manage` permission, and support/compliance resources are linked from the enterprise docs — [Heroku Audit Trail](https://devcenter.heroku.com/articles/audit-trail).
- Skiff's installer already supports `--upgrade`, snapshots before upgrade, keeps settings, and can roll back; signed release artefacts are published but **not verified at install time**, and the in-process updater is pending — [Skiff ROADMAP](https://github.com/KieranHolroyd/skiff/blob/main/docs/ROADMAP.md), [Skiff OPS.md](https://github.com/KieranHolroyd/skiff/blob/main/docs/OPS.md).
- No primary source found for a standard **diagnostics bundle** format in this cohort; the pattern is common in self-hosted infrastructure products but not documented as a PaaS feature.

### Inferences

**Convergence:** SaaS support is a contract (SLA, Slack, response time); self-hosted support is a tooling problem (how do I get you the evidence without giving you my database?). Skiff should invest in the latter.

**Recommended Skiff scope:**

| Candidate | User problem | Verdict | Minimal Skiff implementation |
|---|---|---|---|
| **Diagnostics bundle** | A bug report needs version, config shape, health, recent errors and metrics — but the operator cannot paste secrets. | **P0 — table stakes** | `skiff diagnostics` / dashboard button produces `skiff-diag-<version>-<date>.tar.gz`: version + commit, OS/Bun/Caddy versions, migrations applied, redacted config (keys only, never values), `/readyz` output, last 500 error lines, 24h metrics snapshot, audit tail (last 50 events, actor emails hashed), node/agent status, release inventory. Redact tokens, emails, env values, domains if requested. Never auto-upload. Show a preview file list before download. |
| **Version/update channels + signed manifest** | Operators need stable vs beta, pinning, and proof the artefact is authentic. | **P0 — table stakes** | `SKIFF_UPDATE_CHANNEL`, `SKIFF_PIN_VERSION`; signed manifest (`version, sha256, min_migrations, changelog_url, signature`) verified with a pinned public key before download/apply. Close the roadmap gap. Expose current version + available version + changelog in Settings → Updates. |
| **Audited support access** | A vendor/consultant needs temporary access to diagnose an issue; a permanent admin account is unacceptable. | **P2 — enterprise** | `support_grant` (`id, org_id, granted_by, scope, expires_at, reason, revoked_at`). Creates a time-bound, read-only token (or an owner-approved impersonation session) that is prominently banner-flagged and audited on every request. Default off; requires owner + 2FA; auto-expires; cannot change SSO/billing/keys. Prefer diagnostics bundle over access. |
| **In-app feedback** | Users hit a papercut and do not file a GitHub issue. | **P2 — nice-to-have** | A small form capturing page, message, optional screenshot, version, org id, recent audit ids. POST to a configurable webhook (GitHub issue/Discord/email). Do not build a ticketing system. |
| **Status/health endpoint** | Monitoring and support need a single "is this install healthy?" URL. | **P0 — table stakes** | `GET /healthz` (process up) and `GET /readyz` (DB writable, migrations current, R2 reachable, agent heartbeat fresh, clock sane). Return JSON with component status and version. Do not expose secrets or internal IPs. |
| **Release notes / upgrade preflight** | Operators fear upgrades because they do not know what changed or whether it is safe. | **P1** | `skiff upgrade --check` prints current → target, breaking changes, migration count, disk/RAM preflight, backup status, and a rollback command. Dashboard shows the same. Link to the changelog. |

**Support-access principle:** for a self-hosted product, the vendor should almost never need production access. A diagnostics bundle + a screen-share is the default; a support grant is the exception, time-boxed and audited. This is a selling point versus SaaS.

### Gaps

- No primary documentation of a **diagnostics bundle** in Vercel/Netlify/Render/Railway/Fly/Heroku; the recommendation is inferred from self-hosted infrastructure practice, not a competitor feature.
- Could not verify whether any platform offers **customer-approved support impersonation** with an audit trail; do not claim convergence.
- No public evidence of Skiff's release-signing key distribution or manifest format; the sketch assumes a pinned key in the installer.

---

## Synthesis: what Skiff should add, in what order, and what to refuse

### Takeaway

Skiff should spend the next two releases on **identity + audit + governance primitives** (OIDC SSO with enforcement, audit export/retention/hash chain, service accounts, project-scoped guests, deploy freeze, approval gates, alert routing, diagnostics/update verification). These are cheap on the existing stack, unlock team/small-business trust, and are mostly table stakes. SCIM, custom roles, IP allowlists, SLOs, legal hold, SIEM sinks and support access are enterprise-only and should follow demand. Multi-node active-active, a log warehouse, a billing engine, on-call scheduling and a full policy language should be explicitly refused.

### Cited Findings

- The table-stakes pattern is consistent: OIDC/SAML + enforcement (Vercel, Netlify, Render, Railway, Cloudflare, Dokploy), audit export (Vercel, Railway, Heroku, Northflank, Render), deploy freeze/rollback (Netlify, Vercel), and Slack/webhook/email notifications for deploy events (Netlify) — sources above.
- The enterprise-only pattern is equally consistent: SCIM (Vercel, Netlify, Render, Northflank), custom roles (Dokploy), IP allowlists (Vercel Trusted IPs), 18-month retention (Railway Enterprise), 99.99% SLA + dedicated Slack (Northflank), forward-deployed control plane (Northflank) — sources above.
- Fly.io's Google/GitHub-only SSO and Coolify's OAuth-only, no-group-mapping model show that "SSO" alone is not a differentiator; enforcement, role mapping and audit are — [Fly.io SSO](https://docs.fly.io/security/sso), [Coolify OAuth](https://coolify.io/docs/core/security/authentication/oauth/overview).
- Better Auth's SSO and SCIM plugins make the identity layer a configuration exercise rather than a new subsystem, provided Skiff uses interactive transactions for SCIM — [Better Auth SSO](https://better-auth.com/docs/plugins/sso), [Better Auth SCIM](https://better-auth.com/docs/plugins/scim).
- Skiff already has the hard reliability parts (Litestream ~1s RPO, drills, recovery kit, Prometheus, alerts, installer rollback); the gaps are evidence, export, routing and governance — [Skiff OPS.md](https://github.com/KieranHolroyd/skiff/blob/main/docs/OPS.md), [Skiff ROADMAP](https://github.com/KieranHolroyd/skiff/blob/main/docs/ROADMAP.md).

### Inferences

**P0 — next 1–2 releases (team table stakes, low risk, high trust):**

1. **OIDC SSO + enforcement + break-glass** (Better Auth SSO; verified domain; owner re-auth; lockout report).
2. **Audit export + configurable retention + hash chain** (CSV/NDJSON, R2 daily export, append-only triggers, "oldest retained" badge).
3. **Service accounts + token scopes** (CI/MCP without human keys; expiry, last-used, revoke).
4. **Project-scoped guest access** (agency/contractor use case; no org-wide visibility).
5. **Deploy freeze + production approval gate** (freeze blocks promote not preview; approver ≠ requester; audit both).
6. **Alert routing to Slack/PagerDuty + silence/maintenance windows** (reuse existing alert engine; generic webhook + Events API v2).
7. **Diagnostics bundle + `/readyz` + signed update manifest verification** (support and safe upgrades).
8. **Restore evidence + DR runbook** (persist drill results, show RPO/RTO, `skiff dr verify`).

**P1 — next 2–4 releases (differentiators for small business):**

9. **SAML SSO** for IdPs that require it (same provider table, Enterprise flag).
10. **Granular built-in roles + custom roles UI** (deployer/viewer/auditor; project-scoped grants; capability matrix).
11. **SIEM/webhook audit sink** (generic NDJSON + S3/R2; no vendor connectors).
12. **Status page served by Caddy** (survives control-plane outage; incidents + maintenance).
13. **Canary/blue-green for static releases** (weighted promote, observation window, auto-abort).
14. **Usage/quota dashboard + budgets + chargeback CSV** (showback, hard cap on deploys not serving).
15. **Policy file (`skiff.policy.json`)** for production approvals/change refs/freeze windows (small Zod schema, policy hash on deployment).
16. **Compliance artefact pack** (DPA, subprocessor list, data map, access-review export, SOC 2 control mapping).

**P2 — enterprise/opportunistic:**

17. **SCIM 2.0 + group→role mapping** (only after SSO is solid; protect last owner).
18. **IP allowlists** (dashboard/API only; break-glass).
19. **SLOs/error budgets** (from existing telemetry; no new store).
20. **Incident timelines + postmortem export**.
21. **Legal hold**.
22. **Audited support access** (time-boxed, read-only).
23. **OTLP export** (already roadmap; export only).

**Refuse / explicitly out of scope:**

- **Multi-node active-active control plane** — conflicts with single-control-plane SQLite; offer warm standby + edge mirroring instead.
- **Full log/trace warehouse** — export to R2/Loki/Tempo; keep 7–90 days hot.
- **Billing/payment engine** — not a self-hosted concern.
- **On-call scheduling/escalation** — integrate with PagerDuty/Opsgenie.
- **General-purpose policy language / workflow engine** — a small enforceable schema beats a bad DSL.
- **Vendor backdoor** — support access must be consent-based and audited.
- **SOC 2 certification claims** — ship controls and evidence; the operator certifies their instance.

**Positioning sentence for the report:** Skiff does not need to out-feature Vercel; it needs to make a five-person team pass their customer's security questionnaire without hiring a compliance officer. OIDC SSO, exportable audit logs, approval gates, a restore drill report, and a diagnostics bundle do most of that work.

### Gaps

- No reliable public data on what small self-hosted buyers actually purchase; the prioritisation is inferred from vendor tiering and the Skiff architecture, not from customer interviews.
- The effort estimates behind P0/P1 are not researched; they assume Better Auth plugins and existing `packages/core` primitives are reused.
- "Table stakes vs enterprise-only" is a judgement from the 2026 vendor pages reviewed; it may shift if Vercel/Netlify bundle SSO into lower tiers or if Cloudflare's free SSO pressures the market.
- No source confirms Skiff's repo is public at the cited GitHub URLs; if it is private, the report writer should cite the local `docs/` paths instead.
