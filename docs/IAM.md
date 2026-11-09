# Yoal — Identity and access management (IAM)

Status: **Agreed (2026-11-08, D168) and built (2026-11-09, D181–D207).** Both parts are in:
platform IAM (Part A) and Yoal Access plus user pools (Part B). Part B's pools run in the control
plane behind the `UserPoolEngine` seam; the standalone identity process is built as a scaffold on
one selected node. The remaining gaps are listed in §13 and are deliberately small. Proposals are
numbered I1–I30 and took D-numbers as they shipped; the next free ID is D208.
[STEP-UP.md](./STEP-UP.md) was agreed and built with this plan (D186) and is no longer a separate
proposal.

This plan turns Yoal's fixed four-role RBAC (D9, DESIGN §6.2) into a full IAM service, in two parts:

- **Part A, platform IAM (I1–I24):** who may do what to which Yoal resource. This covers people,
  groups, custom roles, resource-scoped grants, service accounts, workload identity, a token service,
  SSO/SCIM, and governance.
- **Part B, identity for tenant apps (I25–I30):** an identity-aware proxy in front of sites and apps,
  and managed user pools (Cognito/Auth0-style) that deployed apps sign their own users into.

Part A comes first. Part B reuses its token service and audit.

---

## 0. Summary

| # | What | Why |
|---|---|---|
| I1 | **A permission catalog with metadata.** Each permission records its resource, the scopes it can be granted at, its risk class, its step-up level and its token rule, all in one registry in `@yoal/contracts`. | Today the same facts live in four places: `statements`, `destructivePermissions`, `defaultAgentScopes`, and the step-up table in STEP-UP.md. |
| I2 | **Principal v2.** Kinds are `user`, `serviceAccount`, `workload`, `job`, `node`, `mcp` and `system`. Each carries a stable `id`, the `orgId`, the `credential` used, and `actingFor` when it acts on someone's behalf. | Six machine identities live outside `Principal`. Internal actors fake `role: 'owner'`. |
| I3 | **Named system principals with least privilege** replace `kind:'system', role:'owner'`. Examples are `system:pipeline-deploy`, `system:registry-autodeploy` and `system:failover`, each with a fixed permission set and `actingFor`. | A pipeline deploy, a registry auto-deploy or an alert currently runs as an org owner. |
| I4 | **No authorization by role name.** About 50 `role === 'owner'` comparisons become permissions. Owner-only power becomes explicit permissions (`org:delete`, `org:transfer`, `iam:manage-owners`), so owner and admin really differ. | Role-name checks bypass the permission model, and custom roles can't work while they remain. |
| I5 | **Every credential is bound to one org when it's created.** The dashboard honours `activeOrganizationId` and gets an org switcher. | `readMembership` takes the user's first membership, so a key's org can change under it. |
| I6 | **Authorization moves out of Better Auth into Yoal tables.** Better Auth keeps authentication: sessions, passkeys, 2FA, the OAuth provider, SSO and SCIM. | Better Auth's access control has no resource scopes and builds its roles statically at boot. |
| I7 | **Bindings:** `(user / group / service account) → role @ scope`, where scope is `platform`, `org`, `project`, `environment` or one org resource. Bindings can carry an expiry and conditions. | This is GCP's IAM shape. It gives per-project access, guests and time-boxed grants with one table. |
| I8 | **Custom roles** are named sets of permissions in an org. The built-in roles become read-only rows. | Planned since D9 ("custom roles later via the same tables"). |
| I9 | **Groups** are org-local, manually managed or synced from SCIM or SSO, and roles are bound to them. | Teams grant access once instead of per member. They are also the target for an IdP's groups. |
| I10 | **One pure decision function**, `authorize(principal, permission, resource) → Decision`, compiled into a per-principal grant index and cached by an org `iam_version`. It sits behind an `AuthorizationEngine` seam. | One place to test, explain and swap. It costs O(1) for org-wide checks. |
| I11 | **Deny guardrails.** Org-level (and platform-level) deny rules beat any allow. An example is "service accounts never get `*:credentials`". | Like AWS SCPs or GCP deny policies, these are guardrails that a role editor can't undo. |
| I12 | **Explain and simulate.** "Why can (or can't) X do Y on Z", "who can do Y on Z", and a dry run of a proposed binding. | Scoped IAM is unusable without them. |
| I13 | **Service accounts** are org-owned principals (`sa_…`) with a name, an owner group and a disabled flag. People holding `serviceAccount:impersonate` can mint short tokens for one. | CI and agents currently use a human's key. When that person leaves, the key dies, or worse, it keeps working. |
| I14 | **Access keys move to a Yoal table.** They are bound to an org and a principal, can be limited to resources, and support a maximum TTL, CIDR allowlists and last-used tracking. Better Auth's `apikey` rows are migrated across. | Keys need an org, a non-user owner and resource limits. Better Auth's `metadata.scopes` JSON is a poor fit. |
| I15 | **One signing-key ring and one issuer** for every token Yoal mints (registry, pipeline OIDC, workload, STS). Keys have a `kid`, are rotated as next → active → retired, are sealed with the `platform` data key, and are published at `/.well-known/jwks.json`. | Today there are two unrotated keys with different sealing, and two JWKS endpoints. |
| I16 | **A token service (STS) built on RFC 8693 token exchange.** A trusted external or Yoal-issued token is exchanged for a short-lived Yoal token for a service account. | This generalises the GitHub OIDC trust in `registry_oidc_trusts` to every API. |
| I17 | **Federation trusts:** issuer, audience, subject pattern and claim conditions, mapped to a service account. GitHub Actions, Yoal pipelines and any OIDC issuer (GitLab, Kubernetes, another Yoal) are supported. | Keyless CI from anywhere. |
| I18 | **Workload identity.** Every deployed workload runs as a service account. The agent delivers a short-lived, audience-bound JWT through a rotated file and a node-local metadata endpoint. | It replaces the registry's HMAC logins and gives apps keyless access to Yoal's API, to attached storage, and to AWS/GCP/Azure through their federation. |
| I19 | **SSO:** OIDC first, then SAML, configured per org, on a domain verified by TXT record. It does JIT provisioning, maps IdP groups to Yoal groups, and can be enforced, with a break-glass owner. | FEATURE-RESEARCH P1, "sell trust to a five-person team". |
| I20 | **SCIM 2.0** user and group provisioning and deprovisioning. | Leavers lose access when HR removes them, not when someone remembers. |
| I21 | **Org auth policy:** require 2FA for everyone (extending the owner-only rule in D10), allowed sign-in methods, session maximum age and idle timeout, and an IP allowlist. | These are standard questions on a security questionnaire. |
| I22 | **Just-in-time access.** Someone requests a role at a scope for a duration with a reason. An approver who isn't the requester grants a time-bound binding that expires on its own. | Standing production access is the common audit finding. |
| I23 | **Access reviews and right-sizing.** Periodic recertification of bindings, plus per-permission last-used data from audit that suggests what to remove. | Least privilege only holds up if it's maintained. |
| I24 | **Platform IAM.** Platform roles bound at `platform` scope (`platform-admin`, `platform-operator`, `platform-viewer`), with D129's session-only rule kept as a condition. | `user.role = admin` is all-or-nothing today. |
| I25 | **Yoal Access**, an identity-aware proxy: Caddy `forward_auth` in front of any site, app or environment, with policies by org group, IdP, email domain or user pool. | This extends D132's protection modes to "only my team" without a VPN. It's Cloudflare Access for a homelab. |
| I26 | **User pools** are an org resource: a hosted OIDC provider for a deployed app's own end users, with hosted sign-in, passkeys, social login, MFA, and email through yoal-mail. | Yoal runs the database, storage, queue and mail. Auth is the missing building block for a full app. |
| I27 | **A pool engine seam.** The native `yoal-identity` engine ships first; the standalone process is one SQLite file today, with per-pool files as the target. Managed Keycloak or Authentik are later entries. | This follows "support all, ship one first" and keeps the homelab footprint small. |
| I28 | **Pools attach like databases.** Attaching injects `<P>_ISSUER`, `<P>_CLIENT_ID` and `<P>_CLIENT_SECRET`, adds a function binding `env.AUTH`, and sends pool events to queues (D122). | This reuses the attachment and event plumbing. |
| I29 | **Pool admin surfaces:** users, groups, sessions, MFA resets, impersonation for support, import and export, over REST, MCP, CLI and the dashboard. | The same four surfaces as every other managed service. |
| I30 | **B2B in pools**, later: organisations inside a pool, SAML/OIDC federation per tenant, and SCIM in. | It lets a Yoal-hosted SaaS sell to companies. |

---

## 1. Where things stand

The code was audited on 2026-11-08. This table is the **pre-build baseline** kept for context;
§13 is the current status.

| Area | Today | Gap |
|---|---|---|
| Authentication | Better Auth 1.7.15 on the shared `bun:sqlite` handle, with `organization`, `admin`, `passkey`, `twoFactor`, `apiKey`, `mcp`, `cimd`, `jwt` and `magicLink`. GitHub is the only social provider (`apps/control-plane/src/lib/server/auth.ts`). | No SSO, SAML or SCIM. 2FA is enforced for owners only. |
| Permissions | 54 `resource:action` strings across 16 resources (`packages/contracts/src/permissions.ts`). | Pipelines, alerts, log drains, dashboards, volumes, environments, audit and IAM itself have no resources. They check role names instead. |
| Roles | `owner`, `admin`, `deployer`, `viewer` in a closed TypeScript union. Owner and admin are identical. An unknown role string becomes `viewer` (`packages/core/src/orgs.ts:29`). | No custom roles. Owner-only power is spread across about 50 `role ===` checks. |
| Enforcement | `requirePermission(principal, perm)` at about 366 call sites and about 80 platform checks, in 45 core modules. Resources are only filtered by `orgId`. | No resource argument, so no per-project access. |
| Principal | `{kind: user\|apiKey\|mcp\|system, userId, orgId, role, permissions}` (`packages/contracts/src/principal.ts`). | Nodes, jobs, triggers, workloads and GitHub OIDC are checked ad hoc. System actors are synthesised as owners. |
| Org resolution | The first membership by `createdAt`. `activeOrganizationId` is never read. | Multi-org exists in the schema (limit 10) but doesn't work. |
| API keys | Better Auth `apikey` with `referenceId = userId`, scopes in `metadata.scopes`, and no org binding. CLI keys have no scopes and no expiry. | No service accounts. There's no org-wide key view for admins. |
| MCP OAuth | Scopes are the permission strings. The effective set is scope ∩ current role. Tokens die with their grant (D140). | No resource limits at consent. |
| Signing keys | Registry ES256 is in `settings`, sealed with the platform org key (D155). Pipeline OIDC ES256 is in `settings`, sealed directly with the master key (D162). Better Auth's EdDSA keys sit in its `jwks` table. | Three keys, three storage schemes, no rotation, two public JWKS endpoints. |
| Audit | `audit_log` with `actor_type ∈ {user, apiKey, mcp, system, agent}`. `actor_id` is always the human, and `client_id` holds either the MCP client or the key id. | Service accounts and machines can't be told apart, and denied checks aren't recorded consistently. |
| Step-up | Only the owner second-factor gate exists (`second-factor-policy.ts`). | STEP-UP.md is proposed and not built. |

The two schema systems stay as they are. Better Auth tables are created at boot. Yoal's tables
come from `packages/db/migrations` (latest `0079_flows.sql`). Every new IAM table in this plan is a
Yoal migration. Better Auth tables are only read, or written through its API.

---

## 2. Concepts

| Term | Meaning |
|---|---|
| **Principal** | Whoever is acting: a user, service account, workload, pipeline job, node, MCP client acting for a user, or a named system actor. |
| **Credential** | How the principal proved itself: a session, access key, OAuth token, STS token, node token, job token or workload token. It's recorded on every decision and every audit row. |
| **Permission** | `resource:action` from the catalog (I1). |
| **Role** | A named set of permissions. Built-in roles are read-only; custom roles are per org. |
| **Scope** | Where a binding applies: `platform` › `org` › `project` › `environment`, or one org resource (`database`, `storage`, `broker`, `repository`, `pipelineRepository`, `emailDomain`, `userPool`). |
| **Binding** | Principal or group → role @ scope, with an optional `expiresAt` and `condition`. |
| **Restriction** | A ceiling carried by a credential: a token's scopes and resource limits. It never adds access. |
| **Guardrail** | A deny rule at org or platform scope. It beats every allow. |

**The rule (it keeps D9):**

```
allowed = some binding grants `permission` at a scope that contains `resource`
          (directly, or through a group the principal is in)
      AND the binding's condition holds (time, IP, credential kind, fresh auth)
      AND the credential's restriction permits (permission ∈ scopes, resource ∈ limits)
      AND no guardrail denies
```

Scopes nest: a binding at `org` covers every project, environment and org resource. A binding at
`project` covers that project and its environments. Attachments never confer access: holding
`project:update` on `web` doesn't grant anything on the database attached to it.

---

## 3. Permission catalog (I1)

`packages/contracts/src/iam/catalog.ts` replaces `statements`, `destructivePermissions`,
`defaultAgentScopes` and the proposed `STEP_UP_ACTIONS`:

```ts
definePermission('database:credentials', {
  resource: 'database',
  scopes: ['org', 'database'],       // where it may be granted
  risk: 'secret',                    // read | write | destructive | secret | admin
  stepUp: 'window',                  // none | window | always   (STEP-UP.md §4)
  tokens: 'allow',                   // allow | deny | session-only
  mcp: false,                        // refused to MCP principals (D58)
  agentDefault: false,               // pre-ticked on consent
  description: 'Reveal the owner password and connection URL',
});
```

New resources fill the gaps in §1:

| Resource | Actions |
|---|---|
| org | read, update, delete, transfer |
| iam | read, manage-roles, manage-bindings, manage-groups, manage-owners, manage-guardrails, review |
| serviceAccount | create, read, update, delete, impersonate, manage-keys |
| accessKey | read-all, revoke-any (org-wide key admin) |
| federation | create, read, update, delete |
| sso | read, manage (providers, domains, auth policy) |
| audit | read, export |
| environment | create, read, update, delete, approve |
| pipeline | read, dispatch, cancel, manage, approve |
| alert, logDrain, dashboard, volume | create, read, update, delete (plus `alert:acknowledge`) |
| userPool (Part B) | create, read, update, delete, credentials, manage-users, impersonate-user |
| accessPolicy (Part B) | create, read, update, delete |

`member:*` stays. `apiKey:*` becomes `accessKey:*` and is aliased for one release.

Custom roles may use `resource:*` wildcards, which are expanded when a role is compiled, so a role
picks up new actions as the catalog grows. `*:*` is reserved for `owner`.

---

## 4. Data model

These are Yoal migrations, `0080_iam_*` onward.

| Table | Columns (main) |
|---|---|
| `iam_roles` | `id`, `org_id` (null = built-in or platform), `name`, `description`, `permissions_json`, `built_in`, `created_by`, `updated_at` |
| `iam_groups` | `id`, `org_id`, `name`, `description`, `source` (`local`\|`scim`\|`sso`), `external_id` |
| `iam_group_members` | `group_id`, `user_id`, `source`, `expires_at` |
| `iam_bindings` | `id`, `org_id` (null = platform), `principal_type` (`user`\|`group`\|`serviceAccount`), `principal_id`, `role_id`, `scope_type`, `scope_id`, `scope_parent_id` (the project an environment or resource scope belongs to), `condition_json`, `expires_at`, `reason`, `access_request_id`, `created_by`, `created_at` |
| `iam_guardrails` | `id`, `org_id` (null = platform), `name`, `principal_selector_json`, `permissions_json`, `scope_type`, `scope_id`, `condition_json`, `enabled` |
| `service_accounts` | `id` (`sa_…`), `org_id`, `name` (slug, unique per org), `description`, `owner_group_id`, `disabled_at`, `created_by` |
| `access_keys` | `id`, `org_id`, `principal_type` (`user`\|`serviceAccount`), `principal_id`, `name`, `prefix`, `start`, `hash`, `hash_scheme` (`sha256`\|`better-auth`), `restriction_json` (permissions + resource limits), `allowed_cidrs`, `expires_at`, `last_used_at`, `last_used_ip_hash`, `created_by`, `revoked_at` |
| `federation_trusts` | `id`, `org_id`, `service_account_id`, `issuer`, `audiences`, `subject_pattern`, `claim_conditions_json`, `max_ttl_seconds`, `restriction_json` |
| `signing_keys` | `kid`, `alg`, `purpose` (`sts`\|`registry`\|`oidc`\|`workload`\|`pool:<id>`), `public_jwk`, `private_sealed`, `state` (`next`\|`active`\|`retired`), `created_at`, `activated_at`, `retire_after` |
| `org_auth_policies` | `org_id`, `require_sso`, `require_2fa`, `allowed_methods_json`, `session_max_age`, `idle_timeout`, `ip_allowlist_json`, `break_glass_user_ids_json` |
| `sso_domains` | `org_id`, `domain`, `txt_token`, `verified_at`, `last_checked_at` |
| `access_requests` | `id`, `org_id`, `requester_id`, `role_id`, `scope_type`, `scope_id`, `duration_seconds`, `reason`, `change_ref`, `status`, `decided_by`, `decided_at`, `binding_id` |
| `access_reviews`, `access_review_items` | campaign, reviewer, binding snapshot, decision (`keep`\|`revoke`\|`shorten`), `decided_at` |
| `iam_permission_usage` | `org_id`, `principal_type`, `principal_id`, `permission`, `scope_type`, `scope_id`, `last_used_at`, `count_30d` (daily rollup from audit) |

Better Auth's SSO and SCIM plugins add their own boot-migrated tables (`ssoProvider`,
`scimProvider`). `iam_state` holds each org's `iamVersion`; it is bumped in the same transaction as
every IAM write and invalidates compiled grants (§5.2). A dedicated row is used rather than
`organization.metadata` because the counter must exist before Better Auth's tables and must survive
its writes. Built-in roles are seeded as `org_id IS NULL, built_in = 1` rows from the code catalog on
first use, so the role lists have one source; custom roles live per org.

**Migration of existing data (I0 → I1):**

- Each `member.role` becomes an org-scope binding to the built-in role.
- `member.role` stays as a denormalised "base role" so Better Auth's org endpoints keep working, but
  it's no longer read for authorization.
- `apikey` rows copy into `access_keys`, keeping their hash format (spike S1), with `org_id` set to
  the owner's current first membership. Users are told once that keys are now org-bound.
- `registry_oidc_trusts` copy into `federation_trusts`, each with a generated service account per
  org (`github-actions`).

---

## 5. Decision engine (I10)

### 5.1 API

```ts
// packages/contracts/src/iam/authorize.ts (pure)
authorize(grants: CompiledGrants, req: { permission, resource: ResourceRef, ctx }) → Decision
type ResourceRef = { type: 'org' } | { type: 'project'; id; } | { type: 'environment'; projectId; id }
                 | { type: 'database' | 'storage' | …; id }
type Decision = { allow: boolean; reason: 'binding' | 'no-binding' | 'restricted' | 'guardrail'
                  | 'condition' | 'step-up'; via?: BindingId | GuardrailId; stepUp?: Level }

// packages/core (impure: loads and caches)
iam.require(principal, permission, resource)        // throws Forbidden / StepUpRequired
iam.can(principal, permission, resource)            // boolean
iam.scopeFilter(principal, permission, 'project')   // 'all' | Set<id>, for list queries
iam.explain(principal, permission, resource)        // Decision plus the chain, for I12
```

`requirePermission(principal, perm)` stays as a compatibility alias for
`iam.require(principal, perm, { type: 'org' })`, which checks for a grant at org scope. It's deleted
once I2 finishes.

### 5.2 Compilation and caching

When a principal is built, its bindings (direct and through groups) are compiled into
`Map<permission, ScopeSet>`. `ScopeSet` is `org-wide` or a set of `{scope_type, id}`. The guardrails
for the org and platform are compiled alongside it. The cache key is
`(principalType, principalId, orgId, iamVersion)`. Org-wide checks are a single map lookup, and a
resource check walks at most three levels (environment → project → org). Expired bindings drop out
because `expiresAt` is checked at evaluation and the maintenance sweep deletes them and bumps
`iamVersion`.

### 5.3 Engine seam and alternatives

`AuthorizationEngine` has two methods, `compile` and `authorize`. The native engine above ships.
These were considered:

| Option | Verdict |
|---|---|
| **Native RBAC-with-scopes on SQLite** | **Recommended.** The hierarchy is three levels deep, the data already lives in SQLite (replicated by Litestream, part of HA in D107), and there's no new service. |
| Cedar (`@cedar-policy/cedar-wasm`) | A good later engine for conditions and guardrails. Its schema and entity model map onto §2 cleanly. It needs spike S5 for WASM size and latency in Bun. |
| OpenFGA / SpiceDB (Zanzibar) | Rejected for now. It's another stateful service to make HA, and ReBAC's depth isn't needed until sharing between orgs exists. |
| Better Auth dynamic access control | Rejected. It has org roles only, with no resource scopes or conditions. |
| Casbin | Rejected. Its string policies duplicate the catalog's metadata. |

### 5.4 Conditions

`condition_json` is a small typed AND-list, not an expression language:

| Condition | Example |
|---|---|
| `before` / `after` | time-boxed binding (JIT uses `expires_at` instead) |
| `ipIn` | `["10.0.0.0/8"]`, checked against the request's IP (hashed in audit) |
| `credentialIn` | `["session"]`, which expresses D129's "own dashboard session only" |
| `environmentIn` | `["preview", "staging"]` on a project binding |
| `freshAuth` | `"strong"`, which needs step-up within the window (STEP-UP.md §3) |

A condition the engine doesn't recognise denies (fail closed). Cedar (§5.3) is the upgrade path if
the list keeps growing.

---

## 6. Enforcement migration (I2, I4)

This is most of the work: about 366 call sites and about 50 role checks. It's done module by module,
behind the compatibility alias, so every step ships on its own.

1. **Role-name checks → permissions (I4).** Each `role === 'owner' | 'admin'` becomes a catalog
   permission (for example `pipelines.ts:197` → `pipeline:manage`, `alerts.ts:389` →
   `alert:update`). Each `kind === 'user'` interactive check becomes the catalog's
   `tokens: 'session-only'`. A lint rule (`scripts/lint-iam.ts` in `bun run check`) bans
   `.role ===` and `principal.kind ===` outside `packages/core/src/iam/`.
2. **Thread the resource through.** `projects.requireRow(principal, slug)` already loads the row, so
   it becomes `iam.require(principal, perm, { type: 'project', id: row.id })` after the load. Unknown
   and forbidden both return 404 for resources the principal can't read at all, so names don't leak.
3. **Lists.** Every list query takes `iam.scopeFilter(...)` and adds `AND id IN (…)` when the
   principal isn't org-wide.
4. **Order.** Projects, deployments, environments and domains go first (most used for guests). Then
   databases, storage, brokers and email, then pipelines and the registry, then the rest.
5. **Tests.** A table-driven matrix in `packages/core/test/iam-matrix.test.ts` runs every catalog
   permission against each of `org binding`, `other-project binding`, `group binding`,
   `restricted token`, `guardrail` and `expired`. Each module's PR has to turn its rows green.

---

## 7. Machine identities (I2, I3, I13–I18)

### 7.1 Principal kinds

| Kind | Proves with | Permissions come from | Audit `actor_type` / `actor_id` |
|---|---|---|---|
| `user` | session, access key, OAuth/MCP token | bindings ∩ credential restriction | `user` / user id (plus `credential_id`) |
| `serviceAccount` | access key, STS token, impersonation token | bindings ∩ restriction | `serviceAccount` / `sa_…` |
| `workload` | workload JWT | its service account's bindings ∩ the workload's fixed ceiling | `workload` / `wl:<project>/<env>` |
| `job` | `pjt_` job token | the pipeline repository's service account ∩ trust tier (D152) | `job` / job id, `actingFor` = run trigger |
| `node` | node token (later the node certificate, CLUSTERING C2) | the fixed `system:node` role: agent API only | `node` / node id |
| `mcp` | OAuth JWT | the user's bindings ∩ consent scopes ∩ consent resource limits | `mcp` / user id, `client_id` |
| `system` | n/a (in process) | a named system role (I3) | `system` / `system:<name>`, `actingFor` |

`audit_log` gains `credential_id`, `acting_for_type` and `acting_for_id`. `client_id` is then only
the OAuth client again. `actor_id` keeps its meaning for `user` rows, so existing queries keep
working.

### 7.2 Service accounts and keys (I13, I14)

- Created at Settings → Access → Service accounts, with `yoal sa create` or `create_service_account`.
  They're bound like any principal.
- Keys are `yoal_` keys owned by the service account. They're shown once, have a maximum TTL from
  org policy (default 90 days for service accounts, never for nothing), and can be limited by CIDR.
  The list shows last used and its IP.
- **Impersonation:** with `serviceAccount:impersonate` on that service account, a user mints a
  token of at most 1 hour (`yoal sa token <name>`). It's audited with `actingFor` = the user.
  Debugging a CI permission then needs no key.
- **Pipelines** run as their repository's service account, `pipeline-<repo>` (migration `0108`;
  D205). The account is bound to `pipeline:*` at that repository, `deployment:create` and
  `project:update` at each linked project, and `image:push` on `<org>/<repo>`; link and unlink
  reconcile those bindings. This replaces `buildPrincipal({kind:'system', userId: run.createdBy,
  role:'owner'})` (`pipeline-engine.ts:1757`). `pipeline_project_links` stays as an extra gate, and
  a deploy still records the run's creator as `actingFor`.
- **CLI login (D39)** mints a user key bound to the active org, with a 90-day default expiry,
  replacing "no scopes, no expiry".

### 7.3 Key ring and STS (I15–I17)

- `signing_keys` holds one ring per purpose. A `next` key is published in JWKS 24 hours before it
  becomes `active`. A retired key stays published for the longest TTL it signed for, plus a margin.
  Rotation is a flow (D167) run monthly by the sweep, and on demand with
  `yoal iam keys rotate --purpose sts`.
- **The issuer is the platform origin.** `/.well-known/openid-configuration` and
  `/.well-known/jwks.json` publish every purpose except `pool:*`, which have their own issuers in
  Part B. `/api/pipeline/oidc/*` stays as an alias for one release for clouds already configured
  against it (D162). Better Auth's OAuth keys stay in its own `jwks` table for now (§15, open 8).
- **STS endpoint:** `POST /api/iam/token` with
  `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`.
  - `subject_token` may be a GitHub Actions OIDC token, a Yoal pipeline OIDC token, a Yoal
    workload JWT, or any token whose `iss` matches a `federation_trust`.
  - The response is a 15-minute (configurable, ≤ 1 hour) ES256 access token for the trust's service
    account, narrowed by the trust's `restriction_json` and an optional `scope` parameter.
  - The REST API, registry realm and MCP accept it as `Bearer`.
- **The registry realm** accepts STS tokens, so `job.<id>`, `github-oidc` and the `workload.<id>`
  HMAC logins (D158) collapse into "present a token". The old logins stay for one release.
- **Cloud identity federation:** AWS, GCP and Azure trust the platform issuer directly, and the
  workload metadata endpoint mints audience-bound tokens for them. See
  [CLOUD-IDENTITY.md](./CLOUD-IDENTITY.md).

### 7.4 Workload identity (I18)

- Every process or container workload gets a service account. By default that's
  `wl-<project>-<env>`, created on first deploy with no bindings, and can be overridden in the spec
  (`identity: { serviceAccount: "deployer-bot" }`).
- **Delivery:** the agent fetches a workload JWT (`aud` = `yoal`, 1-hour TTL, refreshed at 50%)
  over its node-authenticated channel. It writes it to
  `/run/yoal/identity/<workload>/token` (0400, owned by the workload uid) and mounts it at
  `/var/run/yoal/token` for containers. A node-local metadata endpoint on the loopback service
  address (CLUSTERING H6) serves `GET /identity/token?audience=…` for audiences other than Yoal,
  such as `sts.amazonaws.com`, each minted by the control plane.
- **Uses:**
  - Calling Yoal's API as the workload (`YOAL_TOKEN_FILE` is injected).
  - Registry pulls, replacing the HMAC login.
  - Short-lived credentials for attached storage, if RustFS supports
    `AssumeRoleWithWebIdentity` (spike S3: RustFS 1.0.4 supports it). Attachments get
    `<P>_ACCESS_KEY_ID`/`_SECRET_ACCESS_KEY`/`_SESSION_TOKEN` from STS at activation, with the
    sealed static key as the fallback for older nodes, an older RustFS build or a failed call
    (D66, D201). The node advertises `storage-sts`; there is no public mint route.
  - AWS, GCP and Azure workload identity federation trusting the Yoal issuer
    ([CLOUD-IDENTITY.md](./CLOUD-IDENTITY.md)).
- Database attachments keep passwords (D58, D86). Postgres has no native OIDC auth, and a pgbouncer
  auth hook is out of scope.

---

## 8. Human identity (I5, I19–I21)

### 8.1 Orgs and switching (I5)

- `principalFromSession` reads `session.activeOrganizationId` (set at sign-in to the last used org,
  else the first) and checks the membership.
- The dashboard header gets an org switcher. Keys and tokens carry `org_id`, and MCP consent picks
  the org.
- Self-service org creation stays off (DESIGN §6.2). Raising it is a platform policy.

### 8.2 Guests

A user with a binding at project scope but none at org scope is a **guest**. They're invited from a
project's Access tab (`member:invite` on the project) and see only the projects they're bound to.
Org-level lists (databases, nodes, members) are empty for them, apart from resources they're bound
to directly. Better Auth needs a `member` row for sign-in to resolve an org, so guests get
`member.role = 'guest'`, a built-in role with no permissions.

### 8.3 SSO (I19)

- This uses Better Auth's `sso` plugin (spike S2 for 1.7.15 maturity and the invite-only hook at
  `auth.ts:233`). OIDC and SAML both run in the same plugin.
- Providers are per org: issuer, client id, client secret (sealed with the org key) and claim
  mapping. `/login` asks for the email first. A verified domain routes the user to its IdP.
- **Presets (D180):** adding a provider starts from Microsoft Entra ID, Google Workspace, Okta,
  Auth0, OneLogin, JumpCloud, PingOne, Keycloak, authentik or a custom OIDC issuer
  (`apps/control-plane/src/lib/sso-presets.ts`). A preset asks only for what identifies the tenant
  (Entra tenant GUID, Okta domain and optional authorization server, Auth0 domain, OneLogin
  subdomain, PingOne region and environment, Keycloak URL and realm, authentik URL and slug). It
  derives the exact issuer, discovery URL, scopes (`groups` only where the IdP accepts it) and
  claims, and shows that IdP's console steps next to the redirect URI. The provider id is reserved
  when the page loads, so that URI is final before the provider exists. The server resolves the
  preset again and checks the discovery document as usual. The issuer is stored as discovery
  publishes it, including the trailing slash Auth0, JumpCloud and authentik use, because ID-token
  `iss` checks are exact. A saved provider reopens in its preset, which is detected from the issuer.
- **Domain verification** is a TXT record `yoal-verify=<token>` on the domain, re-checked daily.
  This mirrors the email domain checks (D116).
- **JIT provisioning:** the first SSO sign-in from a verified domain creates the user and a member
  row. IdP group claims map to Yoal groups (`sso_group_mappings`), so roles follow the IdP. With no
  mapping, the user gets the org's default role (`viewer`, configurable).
- **Enforcement:** with `require_sso`, members on verified domains can sign in only through the IdP.
  Their passwords, magic links and GitHub sign-in are refused.
  - **Break-glass:** owners listed in `break_glass_user_ids` keep passkey + TOTP. Each use alerts
    every owner and is audited as `sso.break_glass`.
  - **Preflight:** turning enforcement on runs a lockout report first: who would lose access, and
    whether at least one break-glass owner with a strong factor exists. It refuses if none does.
- **SAML details:** a provider accepts a metadata URL or manual entity id, entry point and
  certificate, and publishes an ACS URL and an SP metadata URL. Metadata import collects every IdP
  signing certificate; `certs`/`secondaryCerts` keep the old and new certificates trusted during a
  rollover. Each provider has an RSA SP key and self-signed certificate, sealed in `settings` and
  published in SP metadata, and `authnRequestsSigned` makes the plugin sign AuthnRequests and
  logout messages; rotating the SP key keeps the previous certificate published for 30 days.
  `GET`/`POST /sso/logout` clears the platform session, audits `sso.logout`, and redirects to the
  provider's configured SLO URL. The plugin's SLO endpoints are enabled, so an IdP-initiated
  `LogoutRequest` also deletes the session. Encrypted assertions are deferred.

### 8.4 SCIM (I20)

Better Auth's `scim` plugin serves `/api/auth/scim/v2` with a per-org bearer token (shown once,
rotatable).
- Users: create (as members with the default role), update, and deactivate. Deactivating revokes
  sessions, OAuth grants (D140) and the user's access keys at once. Service-account keys are
  untouched.
- Groups map to `iam_groups` with `source = 'scim'`, and their membership can't be edited in the
  dashboard.

### 8.5 Org auth policy (I21)

- `require_2fa` extends the owner gate in `second-factor-policy.ts` from `role === 'owner'` to
  "policy says so". The owner rule stays as a floor.
- `allowed_methods` limits sign-in methods to a subset of password, passkey, GitHub, magic link and
  SSO.
- `session_max_age` and `idle_timeout` are checked in `hooks.server.ts` against `session.createdAt`
  and a `lastSeenAt` that is written at most once a minute.
- `ip_allowlist` applies to sessions and user keys. Service-account keys have their own CIDR lists.

---

## 9. Governance (I11, I12, I22, I23)

### 9.1 Step-up

STEP-UP.md was adopted as written and built in phase I7 (D186), with one change: its
`STEP_UP_ACTIONS` registry became the catalog's `stepUp` and `tokens` fields (I1). `iam.require`
throws `StepUpRequired` when the decision says so, so every surface gets it through one path.

### 9.2 Guardrails (I11)

Guardrails ship as templates, and custom ones are allowed:

| Template | Rule |
|---|---|
| No secrets to robots | deny `*:credentials` and `container:exec` to `serviceAccount`, `workload`, `job` |
| Production needs a human | deny `deployment:promote` on `environment=production` unless `credentialIn: [session]` |
| No destructive MCP | deny every `risk: destructive` permission to `mcp` |
| Office only | deny everything unless `ipIn: [...]` (break-glass users exempt) |

Platform guardrails (I24) apply across every org, for example "no org may grant `email:send` to a
workload".

### 9.3 Explain and simulate (I12)

- `GET /api/v1/iam/explain?principal=…&permission=…&resource=…` returns the decision and its chain:
  bindings considered, the group path, the restriction, and the guardrail.
- `GET /api/v1/iam/who-can?permission=…&resource=…` lists principals.
- `POST /api/v1/iam/simulate` takes a draft binding or custom-role edit for one sample user or
  service account and returns only the permissions whose decision would flip, with `before` and
  `after`; nothing is saved and platform bindings are refused as org drafts.
- MCP gets `explain_access`, `who_can`, read-only `simulate_access` and `list_roles`, plus the
  write tools in §12 that use the same engine (`create_service_account`, `bind_role`,
  `request_access`, `unbind_role`). The dashboard binding editor's inline diff is still not built.

### 9.4 Just-in-time access (I22)

- A request names a role, a scope, a duration (≤ the org's maximum, default 8 hours), a reason, and
  an optional `change_ref`.
- Approvers are principals holding `iam:manage-bindings` at that scope, excluding the requester.
  Requests expire after 24 hours.
- Approval creates a binding with `expires_at` and `access_request_id`. Notifications go through
  alert routes, and the requester can end the binding early.
- Surfaces: the dashboard, `yoal access request|approve`, and MCP `request_access`. An agent can ask,
  but only a human session can approve.

### 9.5 Reviews and right-sizing (I23)

- The maintenance sweep rolls audit rows into `iam_permission_usage` daily.
- A review campaign (quarterly by default, or on demand) snapshots bindings in scope and assigns
  each to its scope's managers.
- Items carry "unused for 90 days" hints. Undecided items at the deadline follow the campaign's
  default (`keep` or `revoke`).
- Service accounts unused for 90 days are flagged, and org policy can auto-disable them (`auto_disable_unused_service_accounts`, migration `0104`).

### 9.6 Audit

- Denials are recorded for every surface, not just MCP. Each records the decision `reason` and
  `via`.
- IAM writes are audited as `iam.*`, with before and after snapshots in `args_json`.
- Hash chaining, export and SIEM streaming are FEATURE-RESEARCH P1 ("Audit hash chain, export,
  retention"). They're out of scope here, but they share `audit:export`.

---

## 10. Platform IAM (I24)

- `user.role = admin` becomes a binding to `platform-admin` at `platform` scope. `ensurePlatformAdmin`
  writes the binding.
- Two new built-in platform roles: `platform-operator` (nodes, drain, storage, HA, updates; no
  settings, domains or quotas) and `platform-viewer` (the fleet read views that `canViewPlatform`
  allows today).
- `canAdministerPlatform`'s "own session only" rule (D129) becomes the condition
  `credentialIn: [session]` on those bindings. The quota-write exception for API keys becomes a
  binding without that condition, scoped to `platform:quotas`.
- Platform principals never get org access through platform roles. A platform admin who needs org
  access gets an org binding, which is audited and visible to the org's owners.

---

## 11. Part B: identity for tenant apps

### 11.1 Yoal Access, the identity-aware proxy (I25)

- A new protection mode, `access` (next to `password`, `platform` and share links, D132), can be set
  per production, preview or environment scope.
- An **access policy** is an ordered list of allow and deny rules, each matching on: Yoal org group,
  any org member, email or email domain, an SSO provider, a user pool and its groups, a CIDR, or a
  service token (a header pair, for machines).
- **Caddy** gets a `forward_auth` to the edge's local `yoal-access` handler (inside the agent, like
  the studio and console paths), which answers from a signed session cookie scoped to the site's
  host.
  - **Service tokens:** a named `yoal_svc_…` secret is minted in Settings → Access policies
    (shown once) and stored as a header name plus its SHA-256 in `access_service_tokens`, with a
    name, last-used time and revoke action (migration `0106`). Legacy `serviceToken` matchers in the
    policy's rule JSON still work and the edge merges both. Desired state carries only the header
    name, hash and action, and the agent decides a matching machine before any browser redirect; a
    matching deny wins, and a machine-only policy ends in deny rather than a login.
  - **Login:** a redirect to the platform origin, which authenticates against the org's IdP or the
    chosen pool, then redirects back with a single-use code bound to the host. A `userPool` rule
    accepts the pool's session cookie or bearer access token and matches its `groups`/`poolGroups`
    metadata; an SSO session is attributed to the provider that created it.
  - **Upstream headers:** the app receives `Yoal-Access-Jwt` (signed with the `access` key purpose)
    and `Yoal-Access-Email`, which it can verify against JWKS. A service-token request adds
    `Yoal-Access-Identity: service` and `Yoal-Access-Service: <header>` and carries no email.
- Sessions are revocable per host and per policy. Editing or removing a rule, disabling a policy,
  revoking a service token, or reassigning a host bumps that policy's `version`, which is part of
  the site key of every host using it, so their cookies and callback tokens stop verifying while
  hosts on another policy keep theirs. Edge latency matters, so the agent caches verified decisions
  keyed by host, site key and cookie; spike S6 tracks a Caddy-side cache.

### 11.2 User pools (I26–I29)

A **user pool** is an org resource, like a database. It's an OIDC provider for one app's end users.

| Area | Shape |
|---|---|
| Issuer | `https://auth.<sitesDomain>/<pool>`, or a custom domain verified like project domains |
| Sign-in | email + password, passkeys, TOTP MFA with recovery codes, magic link, six-digit email OTP, email verification/invites, and social login through Google, GitHub, Microsoft or Apple (built). Social uses sealed per-pool OAuth clients, server-side `state`/PKCE and verified-email linking |
| Clients | per-app OIDC clients (confidential or public with PKCE), redirect allowlists, token TTLs, custom claims from user metadata and groups |
| Hosted UI | themed sign-in, sign-up, reset, magic-link, OTP, passkey and MFA pages (logo, colours, copy), with optional self-service sign-up or invite-only; enabled social providers appear as buttons on the hosted login |
| Users | pool-local groups, metadata, sessions, passkey list/remove, TOTP enrolment/reset, block, delete (GDPR); support impersonation is not built |
| Security | per-pool rate limits, TOTP replay protection, passkey counter/clone refusal, generic refusals, social state/PKCE with verified-email linking, email OTP (10-minute, five-attempt, per-address/IP limits), a Have I Been Pwned k-anonymity check on new/reset passwords (3-second timeout, fail open), a per-pool+email lockout after five failures with a doubling backoff capped at an hour, and a new-device/country email notice that never blocks sign-in (D204) |
| Integration | attachment injects `<P>_ISSUER`, `<P>_CLIENT_ID` and `<P>_CLIENT_SECRET`. The function binding `env.AUTH.verify(request)` returns the user or null. Pool events (`user.created`, `user.signed_in`, `user.deleted`, `mfa.enabled`) go to queues (D122). Yoal Access can use a pool as an identity source. |
| Data | export as versioned `yoal.user-pool/v1` JSON (users with argon2id/bcrypt/portable-scrypt hashes, groups, clients and providers with secrets omitted) and import from Yoal, Auth0, Cognito and Firebase exports, dry-run first, skip existing emails, regenerate client secrets, import providers disabled and force a reset when a hash cannot be verified (D204) |
| Surfaces | REST `/api/v1/user-pools/*` (lifecycle, clients, users, invites, export/import, the OAuth code flow and the social callback; no group, TOTP or provider administration), MCP (lifecycle, clients and user admin; no secrets), `yoal pool …`, Settings → Identity (pools, groups, MFA/breach switches, social providers and import), and the hosted account page for a user's own passkeys/TOTP |

**Engine (I27).** `UserPoolEngine` follows the same seam as databases and brokers:

| Engine | Verdict |
|---|---|
| **Native `yoal-identity`** | **Built: in-process for control-plane pools, plus a standalone process for assigned pools.** `UserPoolEngineService` owns the pool's users, sessions, codes, passkeys (migration `0101`), TOTP (migration `0102`), groups (migration `0103`), social accounts/clients (migration `0105`), OTP/lockout/suspicious-sign-in state and import/export (D204) in the `user_pool_*` tables, with `pool:<id>` signing keys and argon2id passwords. The control-plane hosted pages are `/pool/<id>/{login,signup,reset,magic,logout,verify,otp}` plus the passkey endpoints, the account page and the social callback. The separate `yoal-identity.service` (agent `identity` entrypoint, one SQLite file, a Litestream unit, Caddy `auth.<sitesDomain>` routes, migration-free projection in desired state) is built as a scaffold on one selected node: it serves password, magic-link, reset, verification, MFA, logout, discovery/JWKS and the OIDC code/token/userinfo flow. Passkeys, social login, OTP, account/groups pages, invites, the breach-check switch and confidential-client secrets are not projected to it yet, its database starts empty, and per-pool placement/HA are deferred (D206). |
| Managed Keycloak | A later engine as a tier-3 container, for SAML IdP or LDAP federation needs. It takes about 512 MB or more. |
| Managed Authentik / Zitadel | Template candidates (D92) rather than first-class engines. |
| Embedding pools in the control plane | The current slice (the engine runs in-process). D107's reason to move tenant sign-in onto its own service still stands as the identity-process target. |

Control-plane pools follow the control plane's HA. A pool assigned to `yoal-identity` follows that
one node, with its own Litestream unit; per-pool placement and a replica with a Litestream-restored
standby are CLUSTERING work and still deferred.

### 11.3 B2B (I30, later)

- Organisations inside a pool, with members and roles that the app defines.
- Per-tenant SAML and OIDC federation, so an app's customers bring their own IdP.
- SCIM into the pool.
- Separate phase, and only on demand.

---

## 12. Surfaces

| Surface | Live |
|---|---|
| Dashboard | Settings → **Access** (Roles, Bindings, Groups, Guardrails, Access requests, Access reviews, Service accounts with keys and impersonation tokens, Federation trusts, explain), Settings → **Identity** (SSO providers with SLO, SP signing, IdP certificate and SP encryption key rollover, domains, group mappings, auth policy, SCIM tokens, user pools with passkeys, import, the MFA/breach switches and groups), Settings → **Access policies** (rules, machine tokens, revocation), Settings → **Platform access**, Settings → **Members**, a project's **Access** tab, and the org switcher. Every 403 offers "Why can't I?" through explain. User access keys have REST and CLI surfaces; service-account keys are also in Settings → Access. |
| REST | `/api/v1/iam/{roles,groups,bindings,explain,who-can,simulate,guardrails,access-requests,access-reviews,usage,keys,keys/rotate}`, `/api/v1/service-accounts` (plus `/keys` and `/token`), `/api/v1/federation-trusts`, `/api/v1/access-keys`, `/api/v1/sso/{providers,domains,presets,resolve,policy,group-mappings,scim}`, `/api/v1/access-policies` (plus `/:id/service-tokens`), `/api/v1/access/service-tokens/touch`, `/api/v1/user-pools` (clients, users, invites, export/import, `oauth/*` including the social callback, discovery and JWKS), `/api/v1/platform/iam/{roles,bindings,guardrails}`, `/api/v1/access/authorize`, `/api/v1/org/switch`, `/api/iam/token` (STS), `/.well-known/jwks.json` and `/.well-known/openid-configuration`. Browser routes outside `/api/v1`: `/sso/logout`, the hosted `/pool/:id/*` pages, and an assigned pool's `auth.<sitesDomain>/<pool>/*` surface served by `yoal-identity`. |
| CLI | `yoal iam roles\|bindings\|groups\|bind\|unbind\|explain\|who-can\|keys list\|keys rotate`, `yoal sa` (`token`, `keys`), `yoal key`, `yoal federation`, `yoal pool`, `yoal access-policy`, `yoal access request\|approve`, `yoal org switch`, `yoal identity token`, `yoal sts exchange`. |
| MCP | Read: `whoami`, `explain_access`, `who_can`, `simulate_access`, `list_roles`, `list_service_accounts`, `list_federation_trusts`. Write: `create_service_account`, `bind_role`, `request_access`, `unbind_role` (confirmed; platform bindings and approval stay off MCP). |
| Scope-filtered `tools/list` | Not built; it becomes cheap once the compiled grants are used by the MCP registry. |

**Not built:** the dashboard binding editor's inline simulation diff, a Caddy-side Yoal Access
decision cache (S6), B2B, the SAML encrypted-key rollover limitation (the previous certificate is
published but only the current private key decrypts), the Better Auth `apikey` migration (S1),
automatic cloud-provider setup, token revocation lists, and scope-filtered `tools/list`. The
identity process is built but a scaffold: passkeys, social login, OTP, account/groups pages,
invites, the breach-check switch and confidential-client secrets are not projected to it, and
existing pool rows are not moved into its database (D206). Storage STS is built but
activation-only. Pool import/export, email OTP, breach checks, lockout, suspicious-sign-in mail,
social login, SAML encrypted assertions, named Yoal Access machine tokens and per-repository
pipeline service accounts are built.

Workload and STS tokens are accepted as `Bearer` by the REST API, MCP and the registry realm, and
as the registry's Basic password.

---

## 13. Phases

Each phase ships on its own and leaves the system working.

Built between 2026-11-08 and 2026-11-09. The catalog, principal v2 and the role-name migration are
in `packages/contracts/src/iam/{catalog,authorize}.ts`, `packages/contracts/src/principal.ts` and
`packages/core/src/iam/service.ts`; the governance and identity phases followed on migrations
`0080`–`0108`. What remains is a short list of gaps, not a phase.

| Phase | Proposals | Status | Remaining |
|---|---|---|---|
| **I0 Foundations** | I1–I5 | Built | the `compat:legacy-role` grant until every member seeds a binding |
| **I1 Engine at org scope** | I6–I10, I12 | Built | the dashboard binding editor's inline simulation diff |
| **I2 Resource scopes** | I7 | Built | list filtering on queries that cannot express a scope |
| **I3 Service accounts** | I13–I14 | Built | Better Auth `apikey` migration (S1, deliberately deferred); an org key-TTL policy |
| **I4 Token service** | I15–I17 | Built | none |
| **I5 Workload identity** | I18 | Built | automatic cloud-provider setup; a token revocation list |
| **I6 Enterprise sign-in** | I19–I21 | Built | the SAML encrypted-key rollover limitation (previous certificate published, previous private key not used for decryption) |
| **I7 Governance** | I11, I12, I22–I23 | Built | step-up on by default |
| **I8 Platform IAM** | I24 | Built | a dedicated platform IAM page |
| **I9 Yoal Access** | I25 | Built | Caddy-side decision caching (S6); an authenticated agent path for machine-token last-used reporting |
| **I10 User pools** | I26–I29 | Built (in-process engine with import/export and auth hardening; standalone identity process built as a scaffold) | projecting confidential-client secrets, the passkey/social/OTP/account/invite pages and the breach-check switch into the identity process, moving existing pool rows, and per-pool HA |
| **I11 Pool extras** | I30 | Deferred (on demand) | B2B organisations, tenant federation, SCIM in, the Keycloak engine |

What is built now:

- **I0/I1** — catalog, principal v2, named system principals, audit actor columns, the lint guard
  (the baseline is now empty), the owner/admin split, roles/groups/bindings, `/api/v1/iam`,
  Settings → Access, explain/who-can/simulate, and the MCP reads and writes (`explain_access`,
  `who_can`, `simulate_access`, `list_roles`, `create_service_account`, `bind_role`,
  `request_access`, `unbind_role`).
- **I2** — the core modules authorize through `iam.require` with a resource (projects, deployments,
  domains, databases, pipelines, builds, registry, storage, brokers, shares, app volumes, email,
  jobs, events, alerts, workloads, functions, templates, environments, access, studio, node tasks,
  replicas, moves, metrics, backups, usage, uploads, logs, secrets, console, flows, releases,
  GitHub), with `scopeFilter` on the lists that can express it. The `compat:legacy-role` grant
  remains; no role/kind check is baselined.
- **I3** — service accounts, org-bound `access_keys` with SHA-256 hashes, expiry, CIDR and
  restriction, creation/revocation routes, `serviceAccount:manage-keys` and `yoal key` /
  `yoal sa keys`, plus impersonation: `POST /api/v1/service-accounts/:id/token` mints an STS token
  of at most an hour with `act` and `impersonated_by`, audited as `service_account.impersonate`.
  Each pipeline repository gets `pipeline-<repo>` with least-privilege bindings and deploys act as
  it (D205). The Better Auth `apikey` migration is deliberately deferred until S1 settles hash
  portability, and old keys keep working (D207).
- **I4** — the ES256 key ring with a monthly rotation sweep and operator routes
  (`/api/v1/iam/keys`, `/api/v1/iam/keys/rotate`), shared JWKS, federation-trust CRUD
  (`/api/v1/federation-trusts`) and RFC 8693 token exchange. The registry realm, REST and MCP
  accept a workload or STS token with its `scope`/`resources` ceiling; the registry also takes one
  as the Basic password. The old keys stay readable for their TTL overlap and are removed later.
- **I5** — active-organization sessions, the header switcher, org-bound key metadata, and workload
  identity: one service account per workload, a 1-hour token delivered through activation, a
  loopback metadata endpoint and `YOAL_TOKEN_FILE`. The registry accepts that token. Attached
  storage gets short-lived RustFS STS credentials at activation when the node advertises
  `storage-sts`, with the sealed static attachment key as the fallback (D201).
- **I6** — OIDC and SAML sign-in through `@better-auth/sso`, provider sync, JIT membership, domain
  routing, org auth policy, SCIM 2.0 with deactivation and group mirroring, SSO group mapping,
  IdP certificate rollover, SP request signing with a per-provider sealed SP key and published
  certificate, and SAML single logout: the plugin's SLO endpoints handle IdP-initiated logout, and
  `/sso/logout` clears the local session and redirects to the IdP's SLO endpoint. SAML assertions
  can be encrypted to a separate sealed SP encryption key, published with `use="encryption"` and
  rotated with a 30-day previous-certificate overlap (D202); the previous private key is not used
  for decryption, which is the remaining rollover limitation.
- **I7** — guardrail templates and CRUD, JIT access requests, usage rollup, access reviews, and
  step-up: the catalog's `stepUp`/`tokens` fields, the `/api/auth/step-up/*` plugin and the
  VerifyDialog. Enforcement is off unless `YOAL_STEP_UP=1`.
- **I8** — platform roles at platform scope, D129 as a session condition, platform guardrails,
  seeded admin bindings, user and group bindings at `/api/v1/platform/iam/*`.
- **I9** — access policies, the `access` protection mode, the agent's `forward_auth` handler, the
  Settings page, service tokens evaluated at the edge before any login redirect, user-pool session
  and bearer identity with groups, SSO-provider attribution, and per-policy revocation that bumps
  only the edited policy's version so hosts on other policies keep their cookies. Named machine
  tokens are rows with a name, last-used time and revoke action; legacy rule matchers still work
  (D203). Caddy-side decision caching remains.
- **I10** — user pools and OIDC clients with discovery/JWKS, plus the native engine: email +
  password, pool sessions, magic links, password reset, email verification and invites,
  authorization codes, access/ID tokens, userinfo, RP-initiated logout, hosted sign-in pages,
  WebAuthn passkeys with counter/clone checks, TOTP MFA with sealed secrets and hashed recovery
  codes, pool-local groups carried in the `groups` claim, and social login through Google, GitHub,
  Microsoft and Apple with sealed per-pool clients, server-side state/PKCE and verified-email
  linking (D200), email OTP, a HIBP breach check, per-pool+email lockout and new-device/country
  notices (D204). Import/export covers Yoal, Auth0, Cognito and Firebase with a dry run, skipped
  duplicates, regenerated client secrets and forced resets (D204). Attachments inject `<P>_*` env,
  set `env.AUTH.verify` and emit `pools` events. The control-plane engine is in-process; the
  standalone `yoal-identity.service` is a built scaffold that projects only the basic hosted
  flows, so passkeys, social login, OTP, account/groups pages, invites and confidential-client
  secrets remain control-plane-side (D206).

---

## 14. Spikes

| # | Question | Decides | Result |
|---|---|---|---|
| S1 | Can Better Auth 1.7.15 `apikey` hashes be verified by Yoal code (same algorithm and encoding), so keys migrate without being reissued? | I14 migration path | **Yes.** Better Auth stores `base64url(sha256(raw))` (43 chars); `access_keys.hash_scheme` accepts `sha256` and `better-auth`, and `migrateBetterAuthKeys` copies rows without reissue. Unmigrated rows still fall back to Better Auth (D207). |
| S2 | Better Auth `sso` and `scim` plugins at 1.7.15: SQLite support, how they work with the invite-only sign-up hook and the owner 2FA gate, and how mature SAML is | I19/I20 on the plugins or hand-rolled | **Answered: the plugin is used.** `@better-auth/sso` serves OIDC and SAML with Yoal-owned verification, SP signing and SLO, and `@better-auth/scim` serves the directory. Yoal's own code owns providers, domains, presets, group mapping and the SP keys. |
| S3 | Does RustFS support STS `AssumeRoleWithWebIdentity` with an external OIDC issuer? | Short-lived storage credentials in I18 | **Yes.** RustFS 1.0.4 serves `AssumeRoleWithWebIdentity`; attached workloads get 1-hour credentials at activation, falling back to the sealed attachment key on an older node or a failed exchange (D201). |
| S4 | The cost of compile + cache at 1k bindings / 100 groups, and of `scopeFilter` on list queries | Whether to precompute and persist compiled grants | **Open, not benchmarked.** Compiled grants are cached in memory by `iamVersion`; no persisted precompute and no recorded load result. |
| S5 | Cedar WASM in Bun: size, cold start, per-check latency | Whether Cedar becomes an engine for conditions and guardrails | **Open, not adopted.** The native engine remains; no WASM measurement is recorded. |
| S6 | Caddy `forward_auth` to an agent-local handler: added p50 and p99, behaviour when the agent restarts | Whether I25 caches decisions in Caddy | **Partly answered.** The agent caches verified decisions with host, policy and site key in the cache key, service tokens are decided before any redirect, and the new tests cover token precedence and last-used throttling; no Caddy-side cache and no latency measurement. |
| S7 | Many Better Auth instances in one Bun process (one per pool): memory per instance and isolation of plugins and secrets | I27 native engine shape (one process versus one per pool) | **Partial.** One native engine with its own tables is the chosen shape, and `yoal-identity.service` now runs as one process with one SQLite file per node and a 256 MB cgroup (D206); memory per additional pool and per-pool placement are unmeasured, and the projection is a scaffold. |
| S8 | Delivering workload tokens to Podman containers: a bind-mounted rotated file versus Podman secrets, and how rootless uid mapping affects them | I18 delivery | **Partial.** The rotated file is delivered: the helper writes `/run/yoal/identity/<workload>/token` (0400) and mounts it at `/var/run/yoal/token`, and the loopback metadata endpoint serves other audiences. Rootless uid mapping has not been exercised on a real Podman host. |

---

## 15. Questions and answers

Answered on 2026-11-08. Recommendations that weren't overridden stand; each is marked either
**Decided** or **Open** so a later change is a visible edit rather than an assumption.

**Decided:**

1. **Scope.** Both parts, with Part A first. Part B (I9–I11) starts after I4, because it needs the
   key ring.
2. **Owner vs admin.** Admin loses `org:delete`, `org:transfer`, `iam:manage-owners` and
   `iam:manage-guardrails`. Admin keeps everything else. That split is I4's, and the owner-only
   permission set is now closed: new owner-only powers are added to the catalog deliberately, not by
   a `role === 'owner'` check.
3. **Guests.** Project-only members are allowed (§8.2). They get `member.role = 'guest'`, a built-in
   role with no permissions.
4. **Pipeline identity.** A pipeline deploy runs as a service account per repository
   (`pipeline-<repo>`), not the run's creator (§7.2). The account is backfilled on the first deploy
   for older repositories; the run's creator is `actingFor` in audit and `pipeline_project_links`
   remains the extra gate (D205).
5. **Pool engine.** The native `yoal-identity` engine ships first (§11.2); the standalone process
   uses one SQLite file today, with per-pool files as the target. Keycloak stays a later engine for
   SAML IdP and LDAP needs.

**Open (recommendation stands until changed):**

6. **Custom roles and secret permissions.** Can a custom role include `*:credentials`,
   `container:exec` or `iam:*`? **Yes, but those are flagged `risk: secret | admin` in the editor
   and need step-up to save.**
7. **MCP consent resource limits.** Should consent let you pick projects? **Yes in I2, stored on the
   consent grant. Scopes stay bare permission strings, so consent and D140 are unchanged.**
8. **Better Auth's OAuth keys.** Should they move onto the Yoal key ring? **Not yet. Revisit when
   the Better Auth `jwt` plugin supports external key providers.**
9. **Guardrails in v1.** Should guardrails ship in I1 or wait until I7? **I7. Built-in templates
   aren't useful until scoped bindings exist.**
10. **Default for SSO-provisioned users.** Should they get the `viewer` role or no access until
    mapped? **`viewer`, configurable to none.**

---

## 16. Not in this plan

- Sharing resources between orgs (ReBAC, Zanzibar-style).
- Hash chaining and SIEM export for audit (FEATURE-RESEARCH P1).
- Database IAM authentication: Postgres has no OIDC support, so passwords and rotation stay (D58,
  D86).
- Hardware-key attestation policies, device trust and posture checks.
- LDAP as a sign-in source for the platform. Keycloak in Part B covers LDAP for tenant apps.
