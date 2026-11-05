# 04 — Data-plane isolation and credential lifecycle

**Priority:** P0 · **Effort:** M · **Lane:** C · **Wave:** 1
**Depends on:** F1 contracts, F3 e2e
**Blocks:** 10 private networking, 12 preview data, 20 agent tools
**Primary files:** `packages/contracts/src/database.ts`, `packages/contracts/src/object-storage.ts`,
`packages/core/src/databases.ts`, `packages/core/src/storage-instances.ts`,
`apps/helper/src/units.ts`, `docs/DATABASES.md`, `docs/OBJECT-STORAGE.md`

> **Status update (5 Nov 2026):** credential rotation (`database_rotations`) is shipped. Remaining:
> per-org networks, TLS, named app/backup/read-only keys, encryption-at-rest proof, data-access
> audit. Verify before implementing.
>
> **Wave 1 04b update:** per-org networks, named database credentials and named storage keys are
> implemented behind `ORG_NETWORKS` (migration `0023_org_networks.sql`). Reveals are interactive-only
> and audited; MCP still has no secret-returning tool. TLS (`03b`) and the encryption-at-rest
> `doctor` check remain out of scope for this branch.

## Goal

Make it safe to run more than one tenant on a node: per-org networks, no public database ports,
TLS, named credentials, rotation, encryption at rest, and auditable reveals.

## Non-goals

- A full zero-trust mesh or mTLS between every workload.
- Per-tenant Linux users or VMs.
- Row-level security inside Postgres (the app's job).
- A secrets-manager product; the org key + sealed rows are enough.

## Current state

- Every container joins the global `skiff-workloads` network (`apps/helper/src/units.ts`
  `WORKLOAD_NETWORK`); every tenant shares L2/DNS on a node.
- Databases publish only `127.0.0.1:<port>:5432` (good), but any container on the node can reach
  any database by alias.
- Storage instances join the same network; scoped S3 keys limit access, but the root key is not the
  only risk.
- Credentials: owner + monitor sealed; no named app/read-only/backup keys; rotation is a follow-up.
- Audit: create/attach/credentials/delete are audited; no auth-failure or data-access events.
- Encryption at rest is the host disk's responsibility; RustFS SSE is not configured.

## Design

### Per-org network

- Add `networkName` to `WorkloadDesired` (or derive from `orgId`); the helper renders
  `skiff-org-<orgId>.network` and attaches only that org's workloads.
- Migration: existing workloads stay on `skiff-workloads` until their next activation; the helper
  creates the org network and re-attaches on reconcile. Do not delete the old network until no
  workload references it.
- Network aliases remain `db-<id>` / `s3-<id>`; uniqueness is per org network, so two orgs can have
  the same alias without collision.
- Caddy's proxy to a workload must join the org network or use the loopback upstream. The agent
  already proxies to a loopback port; keep that path, do not put Caddy on tenant networks.
- Network policy: default deny between org networks; only the helper/agent control plane is
  privileged. Podman/netavark supports isolated networks; no `--network=host`.

### Named credentials and rotation

Add `database_credentials` and `storage_keys` (see 02):

| Table | Purpose |
|---|---|
| `database_credentials` | id, databaseId, role (`owner`/`app`/`monitor`/`readonly`/`backup`), username, secretSealed, purpose, createdAt, lastUsedAt, expiresAt, revokedAt |
| `storage_keys` | id, storageId, name, accessKeyId, secretSealed, grants, purpose, lastUsedAt, expiresAt, createdBy, revokedAt |

- Owner and monitor rows are created on database create; app/read-only/backup are opt-in.
- Attachments reference a credential row, not a bare password. Activation resolves the row and
  seals the value in the activation payload.
- `rotate(principal, resource, role)`:
  1. Create a new credential row (version n+1).
  2. Apply it on the node (`ALTER ROLE` / create IAM user).
  3. Bump the attachment activation version so consumers restart with the new value.
  4. Mark the old row `revokedAt` after a grace period; optionally delete after consumers report
     healthy.
- `lastUsedAt` is updated by the agent sampler/list or by a lightweight connection probe; do not
  log every query.
- Reveal: `database:credentials` / `storage:credentials`, step-up auth, audit event; MCP never
  returns secrets.

### Encryption at rest

- RustFS: enable SSE-S3 if the pinned build supports it; otherwise document the host-disk
  encryption requirement and add a `skiff doctor --data` check for LUKS/dm-crypt on the backing
  volume.
- Postgres: data dir on a LUKS volume is the supported path (node volumes D72); document that an
  unencrypted ext4 volume is a known gap.
- Backups: client-side envelope encryption is in 01; do not rely on target at-rest encryption alone.
- Key rotation: org key rotation runbook; re-seal rows; recovery kit update.

### Audit

Add data-access events (not every query):

- `database.credentials.reveal`, `database.rotate`, `database.connect.denied` (auth failure).
- `storage.key.create`, `storage.key.reveal`, `storage.share.create`, `storage.object.delete`.
- `backup.download`, `backup.restore`, `sql.console.open`.
- Record actor, client (MCP/CLI/dashboard), token id, resource, result. Never the secret.

### Public exposure

- Databases: no public port, ever. The `public` toggle is for storage only.
- Storage: SigV4-only public route; no `forward_auth`; keep the bandwidth warning.
- Add a dashboard "exposure" panel: which resources are public, which are private, and the network
  path.

## Implementation order

1. Contract fields + migration for credentials/keys (contract PR).
2. Helper per-org network rendering + workload network field.
3. Migration for existing workloads; keep backward compatibility.
4. Named credential creation/reveal/rotation in services.
5. Attachments switch to credential refs; activation updates.
6. Audit events + dashboard exposure panel.
7. Encryption-at-rest check and docs.

## Acceptance criteria

- [ ] Two orgs on one node cannot resolve or connect to each other's database/storage aliases.
- [ ] A database has no public listening port; a port scan from outside the node finds nothing.
- [ ] An app can use a scoped `app` credential; revealing it requires step-up and is audited.
- [ ] Rotating a credential invalidates the old value after the grace period; consumers restart with
      the new one.
- [ ] A storage key can be named, scoped to buckets, and revoked independently of attachments.
- [ ] Existing single-org installs migrate without downtime beyond the normal activation restart.
- [ ] `skiff doctor --data` reports the encryption status of every data volume.

## Tests

- Unit: network name derivation, credential selection, rotation state machine, audit payloads.
- Integration: two orgs, cross-org connection attempt fails; same-org succeeds; alias collision.
- Real node: netavark network creation/removal; existing workload migration; no leaked rule.
- Security: no secret in audit/log; old credential rejected after revoke; MCP cannot reveal.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Network migration breaks running apps | Keep old network until no references; re-attach on next activation |
| Rotation restarts consumers | Grace period; schedule in a maintenance window; warn in UI |
| Credential sprawl | Named roles with purpose/expiry; list + revoke; audit |
| Encryption at rest is assumed, not proven | `doctor` check + docs; do not claim encryption without it |
| Per-org network limits | Test netavark with many orgs; cap or reuse a network pool if needed |

## Rollout

`SKIFF_FEATURE_ORG_NETWORKS` off by default. New installs get per-org networks; existing installs
opt in after a migration test. Credential rotation is opt-in per resource until stable.

## Open questions

- Do we need per-project networks inside an org, or is org-level enough for v1?
- Is RustFS SSE-S3 available in the pinned 1.0.4 image? Verify in the spike.
- Should `readonly` be a real Postgres role with `pg_read_all_data`, or a per-table grant? Start
  with `pg_read_all_data` and document.

## File ownership

Own: `packages/contracts/src/database.ts` / `object-storage.ts` (append-only),
`packages/core/src/databases.ts` / `storage-instances.ts`, `apps/helper/src/units.ts`,
`docs/DATABASES.md`, `docs/OBJECT-STORAGE.md`.

Integration-owned: schema/migration, helper server/systemd, agent main, audit registry, dashboard
layout, MCP/CLI registration, e2e harness.
