# `skiff-identity` — the user-pool identity process

This app is the standalone user-pool issuer described in [`docs/IAM.md` §11.2](../../docs/IAM.md)
(I27). It is one Bun HTTP process per install (one node for now), launched by the static
`skiff-identity.service` unit as `skiff-agent identity`, with its own cgroup, data directory and
Litestream companion. It reuses the control plane's `UserPoolService` and `UserPoolEngineService`
from `@skiff/core`: there is no second auth implementation.

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
| `/<pool>/login`, `/signup`, `/verify`, `/reset`, `/magic` | Hosted pages (`/mfa` is the TOTP step) |

The engine also emits links as `/pool/<pool>/…`; both shapes are parsed, and Caddy routes both to
this process. Hosted pages are dependency-free HTML with the pool's theme colours and logo.

## Database and projection

One SQLite file per **node**, not per pool:

```
/var/lib/skiff/identity/identity.db   (WAL, 0600, owned by skiff)
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
   (`selectIdentityNode` in `@skiff/contracts`).
2. It builds `DesiredState.identity` from the pool/client rows (`identityDesiredForNode` in
   `@skiff/core`): pool id, org, host, issuer, name, signup mode, verification/MFA switches, theme
   and OIDC clients (ids, redirect URIs, public flag). **No secrets**: no client secret, private
   key or user row is in desired state.
3. That node's agent (`IdentityBridge`) starts the unit through the helper and `PUT`s the
   projection to `unix:/run/skiff/identity.sock/state`.
4. The process applies it in one transaction: writes `identity_pools`, upserts
   `user_pools`/`user_pool_clients`, mirrors the verification/MFA settings, and deletes pools and
   clients that left the projection. It answers health with the applied generation, so the agent
   only pushes when the content hash changes.

Clients in the projection have no sealed secret, so **public clients with PKCE work today**;
confidential clients fail closed until a later slice adds an authenticated per-node secret fetch
(the skiff-mail `GET /state` pattern, with the control plane opening the sealed secret for that
node only). That is the deliberate next step, not an auth reimplementation.

### Signing keys and mail

Pool tokens are signed by `pool:<id>` keys in this database, sealed with a local master key
(`/var/lib/skiff/identity/master.key`, generated 0600 on first boot, or
`SKIFF_IDENTITY_MASTER_KEY`). No other process verifies them, so the identity node is
self-contained. Pool mail (verification, magic link, reset, invite) uses
`SKIFF_IDENTITY_MAIL_URL` + optional `SKIFF_IDENTITY_MAIL_TOKEN` to hand the rendered message to
the control plane / mail path; without it, a development process logs the link and a production
process refuses (`platform_mail_unavailable`), the same rule as the in-process engine.

## Node placement and files

- Unit: `scripts/systemd/skiff-identity.service` (static, never enabled).
- Data dir: `StateDirectory=skiff/identity` → `/var/lib/skiff/identity`.
- Replication: `scripts/litestream-identity.yml` and `skiff-litestream-identity.service`, separate
  from the platform database. Replicas live under `skiff/identity-sqlite/`.
- Helper verbs: `POST /v1/identity/start|stop`; the agent bridge owns start/stop and state.
- Capability: agents now advertise `identity`; `DesiredState.identity` is present only on the
  selected node. Caddy proxies `auth.<sitesDomain>/<assigned-pool>/…` to
  `127.0.0.1:8788`; unassigned pools keep the existing control-plane routes (the dev fallback).

## Scale-out (later)

Everything above assumes one identity node. Real multi-node HA needs:

- per-pool placement (a pool's node id in its row) instead of "all pools on one node";
- a Litestream-restored standby per identity node, with a promotion step and a Caddy upstream
  change (the CLUSTERING C7/C8 pattern);
- a confidential-client secret fetch over the node channel;
- idempotent state application already exists, so a standby can be fed the same projection;
- sticky sessions or a shared session store if pools move while users are signed in.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `SKIFF_IDENTITY_DATA_DIR` | `/var/lib/skiff/identity` | Database and master key |
| `SKIFF_IDENTITY_DB` | `<data dir>/identity.db` | SQLite file |
| `SKIFF_IDENTITY_SOCKET` | `/run/skiff/identity.sock` | Agent control socket |
| `SKIFF_IDENTITY_HOST` / `_PORT` | `127.0.0.1` / `8788` | Loopback listener for Caddy |
| `SKIFF_IDENTITY_CONTENT_DOMAIN` | `SKIFF_CONTENT_DOMAIN` or `localhost` | Issuer host `auth.<domain>` |
| `SKIFF_IDENTITY_ORIGIN` | `https://auth.<content domain>` | Link origin and cookie security |
| `SKIFF_IDENTITY_MASTER_KEY` | generated file | 32 bytes, base64 or raw |
| `SKIFF_IDENTITY_MAIL_URL` / `_TOKEN` | unset | Forward pool mail; otherwise dev log / refusal |

## Tests

`test/http.test.ts` covers path parsing (both issuer shapes), cookie scope, safe redirects and
client credentials. The auth behaviour itself stays covered by the existing engine tests in
`packages/core`; this app is only the process and HTTP shell.
