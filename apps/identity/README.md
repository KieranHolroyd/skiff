# `yoal-identity` — the user-pool identity process

This app is the standalone user-pool issuer described in [`docs/IAM.md` §11.2](../../docs/IAM.md)
(I27). It is one Bun HTTP process per install (one node for now), launched by the static
`yoal-identity.service` unit as `yoal-agent identity`, with its own cgroup, data directory and
Litestream companion. It reuses the control plane's `UserPoolService` and `UserPoolEngineService`
from `@yoal/core`: there is no second auth implementation.

## What it serves

At `https://auth.<sitesDomain>/<poolId>` (the issuer Caddy routes to this process):

| Path | Purpose |
|---|---|
| `/<pool>/.well-known/openid-configuration` | OIDC discovery (`UserPoolService.discovery`) |
| `/<pool>/.well-known/jwks.json` | The pool's `pool:<id>` public keys |
| `/<pool>/oauth2/authorize` | Authorization-code redirect, or the hosted login page |
| `/<pool>/oauth2/token` | Code + PKCE/secret exchange |
| `/<pool>/oauth2/userinfo` | Bearer access-token claims |
| `/<pool>/oauth2/logout` | End the pool session |
| `/<pool>/login`, `/signup`, `/verify`, `/reset`, `/magic`, `/otp`, `/account` | Hosted pages (`/mfa` is the TOTP step) |
| `/<pool>/passkeys/{login,register}/{options,verify}` | WebAuthn sign-in and enrolment JSON |
| `/<pool>/oauth/callback/<provider>` and `/api/v1/user-pools/<pool>/oauth/callback/<provider>` | Social sign-in callback (the engine builds the latter) |
| `/health`, `/readyz` | Pool count, applied state/secrets generations and readiness |
| `/metrics` | Prometheus text: readiness, pool/generation gauges and request counters |

The hosted pages mirror the control plane's `/pool/<id>/*` pages: password, sign-up, verify,
reset, magic link, email OTP, TOTP MFA, passkeys, social buttons, the account page (passkeys,
TOTP, groups, resend verification, sign-out) and logout. Every form carries a double-submit CSRF
token scoped to the pool path, and each flow has its own rolling-window rate limit. The theme's
`displayName`, `primaryColor`, `backgroundColor` and `https` logo are applied; copy is fixed.

The engine also emits links as `/pool/<pool>/…`; both shapes are parsed, and Caddy routes both to
this process. Hosted pages are dependency-free HTML with the pool's theme colours and logo.

## Database and projection

One SQLite file per **node**, not per pool:

```
/var/lib/yoal/identity/identity.db   (WAL, 0600, owned by yoal)
```

`packages/db`'s `openIdentityDb` opens it with the same forward-only migrations as the control
plane, so the existing `user_pool_users`, `user_pool_sessions`, `user_pool_codes`, `user_pool_*`
passkey/TOTP/group tables are reused unchanged. It also creates `identity_pools`, the projection
marker:

| Column | Meaning |
|---|---|
| `pool_id` | Pool id, same as the control plane |
| `org_id` | Owning org (for event/mail routing) |
| `host`, `issuer` | `auth.<sitesDomain>` and the exact issuer URL |
| `generation` | Content hash of the projection last applied |
| `synced_at` | When the agent pushed it |

### How the control plane syncs it

1. `NodeService.desiredState` picks one identity node: the `identity.node_id` setting if that node
   still advertises the `identity` capability, else the edge, else the first online capable node
   (`selectIdentityNode` in `@yoal/contracts`).
2. It builds `DesiredState.identity` from the pool/client rows (`identityDesiredForNode` in
   `@yoal/core`): pool id, org, host, issuer, name, signup mode, verification/MFA switches, theme
   and OIDC clients (ids, redirect URIs, public flag). **No secrets**: no client secret, private
   key or user row is in desired state.
3. That node's agent (`IdentityBridge`) starts the unit through the helper and `PUT`s the
   projection to `unix:/run/yoal/identity.sock/state`.
4. The process applies it in one transaction: writes `identity_pools`, upserts
   `user_pools`/`user_pool_clients`, mirrors the verification/MFA settings, and deletes pools and
   clients that left the projection. It answers health with the applied generation, so the agent
   only pushes when the content hash changes.

Clients in the projection have no sealed secret. Public clients with PKCE work from the projection
alone; confidential clients are filled in by the authenticated per-node secret fetch:

5. `IdentityBridge` calls `GET /api/agent/identity/secrets` with its node bearer, and only for the
   pools in this node's `DesiredState.identity`. The control plane opens each
   `client_secret_sealed` (and each enabled social provider's secret) for that one node.
6. The bridge relays the bundle over the private unix socket (`PUT /secrets`, mode 0660) and never
   logs it. The identity process seals each value with its own master key before writing
   `user_pool_clients` / `user_pool_oauth_providers`, then reports `secretsGeneration`.
7. The fetch repeats after a restart, whenever the process reports a different generation, and at
   most once a minute so a rotated secret reaches the pool. A failed fetch leaves public clients
   working and confidential clients failing closed.

Neither the desired state nor a log line ever carries a client secret.

### Signing keys and mail

Pool tokens are signed by `pool:<id>` keys in this database, sealed with a local master key
(`/var/lib/yoal/identity/master.key`, generated 0600 on first boot, or
`YOAL_IDENTITY_MASTER_KEY`). No other process verifies them, so the identity node is
self-contained.

**Moving a pool without invalidating tokens.** The control socket exposes
`GET /keys/export[?pool=<id>]` and `PUT /keys/import`. Export returns a versioned bundle of the
`signing_keys` rows for the pool (`next`, `active` and `retired`), base64-encoded; the private JWKs
stay sealed with this node's master key, so the bundle contains no plaintext key material. Import
replaces the rows and restores `user_pools.signing_key_id`, so tokens signed before the move keep
verifying. The destination node must be configured with the same `YOAL_IDENTITY_MASTER_KEY` (or
the same `master.key` file) to open them. A bundle larger than 64 KiB is reported with
`tooLarge: true` and is not returned, which keeps it out of desired state; a projection may carry
`keyBundle` (already sealed) for a move.

Pool mail (verification, magic link, reset, invite, OTP) uses
`YOAL_IDENTITY_MAIL_URL` + optional `YOAL_IDENTITY_MAIL_TOKEN` to hand the rendered message to
the control plane / mail path; without it, a development process logs the link and a production
process refuses (`platform_mail_unavailable`), the same rule as the in-process engine.

### Health, metrics and fallback

`GET /health` returns `{ ok, ready, status, generation, secretsGeneration, pools, version,
lastStateAt }`; `GET /readyz` is the cheap readiness probe. `GET /metrics` is Prometheus text with
`yoal_identity_ready`, pool/generation gauges and `yoal_identity_requests_total{route,status}`.
The agent reports the unit's status, version, generation, pool count and restart count in the
heartbeat. While the unit is unhealthy, the agent omits the identity Caddy routes so the assigned
pools fall back to the control plane's `/api/v1/user-pools/*` and `/pool/*` routes; they move back
when a health check succeeds. The bridge starts the unit when assignment appears, stops it when
assignment disappears, and restarts it after three consecutive failed health checks.

## Node placement and files

- Unit: `scripts/systemd/yoal-identity.service` (static, never enabled).
- Data dir: `StateDirectory=yoal/identity` → `/var/lib/yoal/identity`.
- Replication: `scripts/litestream-identity.yml` and `yoal-litestream-identity.service`, separate
  from the platform database. Replicas live under `yoal/identity-sqlite/`.
- Helper verbs: `POST /v1/identity/start|stop`; the agent bridge owns start/stop and state.
- Capability: agents now advertise `identity`; `DesiredState.identity` is present only on the
  selected node. Caddy proxies `auth.<sitesDomain>/<assigned-pool>/…` to
  `127.0.0.1:8788`; unassigned pools keep the existing control-plane routes (the dev fallback).

## Scale-out (later)

Everything above assumes one identity node. Real multi-node HA needs:

- per-pool placement (a pool's node id in its row) instead of "all pools on one node";
- a Litestream-restored standby per identity node, with a promotion step and a Caddy upstream
  change (the CLUSTERING C7/C8 pattern);
- a confidential-client and social-provider secret fetch over the node channel (implemented as
  `GET /api/agent/identity/secrets`, opened at the control plane, re-sealed in the process);
- idempotent state application already exists, so a standby can be fed the same projection;
- sealed signing-key export/import for a moved pool (implemented on the control socket);
- sticky sessions or a shared session store if pools move while users are signed in;
- per-pool placement: today one node receives every pool, so its failure stops all assigned pools
  until the agent falls back to the control-plane routes. True HA needs one identity unit (or
  replica set) per pool group and a Caddy upstream per placement.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `YOAL_IDENTITY_DATA_DIR` | `/var/lib/yoal/identity` | Database and master key |
| `YOAL_IDENTITY_DB` | `<data dir>/identity.db` | SQLite file |
| `YOAL_IDENTITY_SOCKET` | `/run/yoal/identity.sock` | Agent control socket |
| `YOAL_IDENTITY_HOST` / `_PORT` | `127.0.0.1` / `8788` | Loopback listener for Caddy |
| `YOAL_IDENTITY_CONTENT_DOMAIN` | `YOAL_CONTENT_DOMAIN` or `localhost` | Issuer host `auth.<domain>` |
| `YOAL_IDENTITY_ORIGIN` | `https://auth.<content domain>` | Link origin and cookie security |
| `YOAL_IDENTITY_MASTER_KEY` | generated file | 32 bytes, base64 or raw |
| `YOAL_IDENTITY_VERSION` | `YOAL_AGENT_VERSION` or `dev` | Reported in health and the heartbeat |
| `YOAL_IDENTITY_MAIL_URL` / `_TOKEN` | unset | Forward pool mail; otherwise dev log / refusal |

## Tests

`test/http.test.ts` covers path parsing (both issuer shapes, passkeys, social callbacks, health and
metrics), cookie scope, CSRF shape, safe redirects, client credentials, themed rendering and rate
limits. `test/secrets.test.ts` covers sealing a fetched secret bundle, preserving a sealed secret
across a desired-state push, provider replacement, health and key export/import.
`apps/agent/src/identity-bridge.test.ts` covers the authenticated fetch, secret relay without
logging, state push and unit start/restart/stop. The auth behaviour itself stays covered by the
existing engine tests in `packages/core`; this app is only the process and HTTP shell.
