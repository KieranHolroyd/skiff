# 20 — Agent data tools

**Priority:** P1 · **Effort:** S–M · **Lane:** E · **Wave:** 3
**Depends on:** 01 backups, 02 storage surface, 03 pooling/TLS, 04 isolation, 11 blueprints,
12 preview data, 16 quotas
**Blocks:** nothing; this is the differentiator
**Primary files:** `apps/control-plane/src/lib/server/mcp/tools/data.ts`,
`packages/contracts/src/mcp-data.ts`, `docs/MCP.md`

> **Status update (5 Nov 2026):** MCP database backup/restore/rotation tools are shipped.
> Remaining: read-only SQL, presigned URLs, plan/apply stack, fork, data health, durable tasks,
> server-enforced approval for in-place restore. Verify before implementing.

## Goal

Let an agent do what a careful operator can do with data, and nothing more: plan/apply a full
stack, read data health, run a read-only query, mint a presigned URL, restore a backup, and fork a
database for a preview — with server-enforced confirmation, scope ∩ role ∩ environment, durable
tasks, and an audit trail.

## Non-goals

- A shell or arbitrary code execution.
- Returning credentials to an agent.
- Unbounded SQL or DDL over MCP.
- A hosted coding agent or sandbox.
- Replacing the human dashboard for destructive infrastructure.

## Current state

- MCP tools for DB/storage: list/get/create/attach/detach/delete; `delete_*` uses a confirmation
  token and `requestState`; `get_*` includes a last-hour summary.
- Credentials are never returned by MCP (D58/S6).
- No `restore`, `fork`, `query`, `presign`, `plan_stack`, or `get_data_health`.
- Coolify's `confirm=true` is client-enforced; research finds most destructive MCP tools lack
  server-side confirmation. Yoal's existing confirmation token is a good base.

## Design

### Tool surface

| Tool | Input | Output | Safety |
|---|---|---|---|
| `plan_stack` | blueprint doc or path | resource graph, diff, cost estimate, warnings | read-only; no secrets |
| `apply_stack` | plan hash + `confirm` | operation id, resource ids, preview URL | server-side confirmation; idempotent; scope ∩ role |
| `get_data_health` | resource id/name | backup age, last verified restore, pool saturation, disk/quota, TLS, replication lag | read-only |
| `query_database` | database, SQL, params, `maxRows`, `timeoutMs` | rows, columns, row count, truncated flag | `database:query` scope; read-only transaction; no DDL/DML; row/time limits; audit; redact |
| `create_presigned_url` | storage, bucket, key, method, ttl | URL + expiry | object-scoped; max 7 days; audited; no root key |
| `list_backups` | resource | artifacts, timestamps, sizes, verified flag | read-only |
| `restore_backup` | artifact, target name, mode `new` (default) | operation id, new resource | server-side confirmation; in-place requires human |
| `fork_database` | source, target name, mode `schema`/`data` | operation id, clone id | quota-checked; data policy; TTL; audit |

### Server-side confirmation

- Reuse the existing confirmation token mechanism, but bind it to: principal, client id, tool,
  resource, arguments hash, and a 5-minute expiry.
- A destructive call without a valid token returns `409 approval_required` with a `requestState`
  that the client must complete; the server verifies the token, not the client's `confirm: true`
  boolean.
- For high-risk actions (in-place restore, force bucket delete, data fork), require a **second**
  human approval in the dashboard (`approval_required`) and record both actors.
- Confirmation is single-use; replay returns `409`.

### Scope and tenancy

- Token scope ∩ role ∩ environment. Add `environment` to the MCP token claims; a token scoped to
  `staging` cannot read production data.
- `database:query` is a separate scope, never pre-ticked; read-only. A `database:write` scope does
  not exist in v1.
- `read_only=true` is a server-side filter that hides write tools from `tools/list` and rejects them
  on call.
- Cross-project reads are capped; a token for one project cannot list another's data resources.

### Read-only SQL

- Execute inside a `READ ONLY` transaction with `statement_timeout`, `idle_in_transaction_session_timeout`,
  and a row limit (e.g. 1,000). Reject multiple statements, `COPY`, `SET`, `LISTEN`, and DDL/DML by
  parsing or by transaction mode + a conservative allowlist (`SELECT`, `WITH`, `EXPLAIN`).
- Redact literals from the audit record; store the query fingerprint, not the raw SQL with values.
- Return column metadata and a truncated flag; never stream unbounded rows.
- If the database has a read-only role (04), use it; otherwise use a dedicated `yoal_query` role
  with `pg_read_all_data` and no write grants.

### Presigned URLs

- Use the root key only in the control plane/agent service; the tool returns a URL, never keys.
- Bind method, bucket, key, expiry (≤7 days), and optionally content-type/size for PUT.
- Audit creation; rate-limit per token; revoke by rotating the storage signing key.

### Durable tasks

- `plan_stack`/`apply_stack`, `restore_backup`, and `fork_database` return a `taskId` with
  `get_task` polling, TTL, and `input_required` for approvals. MCP 2026-07-28 Tasks is the target;
  provide a synchronous fallback for older clients.
- Tasks are stored in `mcp_tasks` with principal/client/tool/resource/args hash/status/result.

### Audit and quotas

- Every tool call records `mcp.<tool>` with client id (CIMD/DCR), token id, scopes, resource,
  result, latency, and approval actor. Never secrets or raw row data.
- Quotas (16): a token cannot exceed the org's database/storage/preview quotas; `query_database`
  has a per-token QPS/row budget; `fork_database` counts against preview/database quotas.

## Implementation order

1. Contract tool schemas + `mcp_tasks` + confirmation binding (contract PR).
2. `get_data_health`, `list_backups`, `create_presigned_url` (read-only, lowest risk).
3. `query_database` with read-only role, limits, redaction.
4. `plan_stack`/`apply_stack` on top of 11.
5. `restore_backup` (new target only) on top of 01.
6. `fork_database` on top of 12 (or a standalone clone).
7. Durable task handles + `get_task`.
8. Server-side approval UI; audit view; rate limits.
9. Docs + client matrix.

## Acceptance criteria

- [ ] An agent can plan and apply a stack (site + Postgres + bucket) in one flow, with a resource
      graph and a preview URL.
- [ ] A destructive call without a valid server token fails with `409 approval_required`; a replay
      fails.
- [ ] `query_database` rejects DDL/DML/multiple statements and returns at most the row limit.
- [ ] A scoped token cannot read another project's data or a different environment.
- [ ] `create_presigned_url` returns a URL that expires and cannot be reused for another key.
- [ ] `restore_backup` creates a new resource; in-place requires a human approval in the dashboard.
- [ ] `fork_database` is quota-checked and expires with the preview.
- [ ] `tools/list` is filtered by scope; a direct call to a hidden tool returns `403
      insufficient_scope`.
- [ ] Every call is audited with client, token, scope, resource, result; no secrets.

## Tests

- Unit: tool schemas, confirmation binding, scope filter, SQL validation, redaction.
- Integration: MCP OAuth matrix; plan/apply; restore/fork; query limits; presign.
- Security: replay, cross-tenant, raw SQL injection, prompt injection in logs/metadata.
- Real node: end-to-end with Claude Code/another MCP client.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Confused deputy | Server-side confirmation; scope ∩ role ∩ env; no raw execute |
| SQL exfiltration | Read-only role, row/time limits, no writes, audit |
| Preview data leak | Schema/seed default; fork permission; TTL |
| Task duplication | Idempotency key + args hash; single-use confirmation |
| Context blow-up | Small task-shaped catalog; scope filtering; no 67-tool mirror |
| Audit gaps | Log every call; client/token/resource; immutable export later |

## Rollout

Read-only tools first (`get_data_health`, `list_backups`, `create_presigned_url`), then
`query_database`, then `plan_stack`/`apply_stack`, then restore/fork. `YOAL_FEATURE_AGENT_DATA_WRITE`
off by default; destructive tools require the feature flag and a human approval.

## Open questions

- Should `query_database` use a dedicated role or the monitor role? A dedicated `yoal_query` role
  with `pg_read_all_data` is cleaner; add it in 04.
- Do we support SQL parameters? Yes, `$1` params, never string interpolation.
- How do we handle MCP Tasks on clients that do not support them? Synchronous fallback with a
  polling tool.

## File ownership

Own: `packages/contracts/src/mcp-data.ts`, `apps/control-plane/src/lib/server/mcp/tools/data.ts`,
`packages/core/src/mcp-tasks.ts` + test, `docs/MCP.md`.

Integration-owned: MCP registry, confirmation token implementation, audit registry, schema/migration,
dashboard approvals page, CLI `yoal mcp` docs, e2e harness.
