# Skiff — Mass actions and prune (design proposal)

Status: **implemented, 2026-11-04.** The decisions in §9 are recorded in [DECISIONS.md](./DECISIONS.md)
as D49–D54. This doc covers:

1. **Mass actions** on projects: delete, restore and purge many at once, built so that later actions
   (set access, move placement, pause, redeploy and so on) plug in without new plumbing.
2. **Prune**: an on-demand sweep that finds and removes anything no live owner references
   (orphaned rows, releases, snapshots, objects, DNS records). You can run it from the CLI and the
   dashboard, and it reports live progress.
3. **Blueprints** (§12): a declarative stack file whose plan is a `blueprint.apply` bulk operation.

Both are built on one primitive, the **Operation**. Everything still goes through `packages/core`.
REST, MCP, CLI and the dashboard stay thin surfaces (DESIGN §3).

---

## 1. Why now: what leaked

These were found while designing prune; mass delete would have made each of them N times worse.
All are fixed in the same change (§8, step 0). Prune cleans up anything they left behind on
existing installs.

| # | Leak | Where |
|---|---|---|
| L1 | The trash purge hard-deletes `deployments`, `upload_sessions`, `share_links`, `domains`, `slug_redirects` and `projects`, but leaves behind `environments`, `workloads`, `git_sources`, `builds`, `log_events`, project-scoped `secrets` and `share_redemptions`. | `packages/core/src/projects.ts` `purgeExpired` |
| L2 | The purge deletes `domains` rows with raw SQL, so it skips the Cloudflare record cleanup that `domains.delete` does. Managed DNS records outlive the project. | `projects.ts` `purgeExpired` vs `domains.ts:664` |
| L3 | `MaintenanceService.cleanupRows()` (hard-deletes soft-deleted deployments after 30 days, plus old redemptions and revoked links) is never called. | `packages/core/src/maintenance.ts` |
| L4 | `config_snapshots` are inserted and never deleted. | `packages/core/src/releases.ts:96` |
| L5 | Workload memory reservations ignored whether the project is deleted. A trashed or purged project's `pending/starting/running` workload row kept counting against the node budget (D42): the agent only reports workloads it still runs, so the row was never cleared. | `packages/core/src/workloads.ts` `reservedByNode` |
| L6 | `ObjectStore` has no `list()`, so objects with no row (a crash between the row delete and the object delete in `runGc`, or a failed finalize) can never be found. | `packages/core/src/object-store.ts` |
| L7 | The dashboard has no trash view. Restore exists only through `POST /projects/:slug/restore`. | `routes/(dashboard)/projects` |

---

## 2. The Operation primitive

An **Operation** is a server-side job that is long-running (or could be), runs item by item, is
audited, and streams its progress. Bulk project actions and prune are both Operations, and so is
any future mass action.

### 2.1 Lifecycle

```
            create (stage=plan)                  apply
  ┌────────┐      ┌──────────┐      ┌─────────┐ ─────► ┌──────────┐      ┌────────────────────────┐
  │ queued │ ───► │ planning │ ───► │ planned │        │ applying │ ───► │ succeeded │ partial    │
  └────────┘      └──────────┘      └─────────┘        └──────────┘      │ failed    │ cancelled  │
                                     expires 1 h                         └────────────────────────┘
            create (stage=apply) skips the stop at `planned`
```

- **Plan** resolves targets, checks permissions and computes a verdict for each item: `ok`,
  `skip` (with a reason such as `already_in_trash` or `not_found`) or `blocked` (such as
  `forbidden` or `has_custom_domain_pending`). Plan never mutates anything. Every surface shows
  the plan to the human before applying it, so the confirm dialog shows what the server decided,
  not what the client guessed.
- **Apply** runs only the `ok` items of *that plan*. Each item is checked again at apply time
  (the same pattern as `runGc`'s `DELETE … WHERE NOT EXISTS`), so an item that changed since the
  plan becomes `skipped: changed`, not a wrong delete.
- Bulk actions may be created with `stage: 'apply'` (plan and apply in one call) for scripts.
  **Prune must be planned first** (§5.3).

### 2.2 Semantics

- **Per-item success, not all-or-nothing.** Each item runs in its own transaction and gets its own
  audit row. Items are independent, and some have side effects outside SQLite (Cloudflare, agents,
  the object store) that no transaction can roll back. The final status is `succeeded` (no item
  failed; skips are reported in the summary), `partial` (some failed, some succeeded) or `failed`
  (every attempted item failed).
- **Idempotent and resumable.** Each item's status is persisted as it runs. On boot the runner
  re-claims operations that were `applying` with a stale heartbeat and continues from the first
  item that hasn't finished. Every item action must be idempotent: soft-deleting a project that
  is already deleted is `skipped: already_in_trash`.
- **Cancellable.** `cancel` stops after the current item. The remaining items become `cancelled`.
- **Concurrency.** At most one `applying` operation per org per kind (`bulk`, `prune`). Prune also
  takes the existing per-org `gcQueue` lock so it never races `gcReleases`.
- **Limits.** Up to 100 targets per bulk operation, and 25 through MCP (§6.3). Prune has no item
  cap and works in chunks of 500.

### 2.3 Schema (additive migration `0007_operations.sql`)

```sql
CREATE TABLE operations (
  id            TEXT PRIMARY KEY,           -- op_…
  org_id        TEXT,                       -- NULL for platform-scope prune
  kind          TEXT NOT NULL,              -- 'bulk' | 'prune'
  action        TEXT NOT NULL,              -- 'project.delete', 'prune', …
  status        TEXT NOT NULL,              -- queued|planning|planned|applying|succeeded|partial|failed|cancelled|expired
  params_json   TEXT,                       -- targets, prune categories/scope
  summary_json  TEXT,                       -- counts per verdict/status, bytes freed, per-category totals
  phase         TEXT,                       -- current category / step, for progress
  total         INTEGER NOT NULL DEFAULT 0,
  done          INTEGER NOT NULL DEFAULT 0,
  failed        INTEGER NOT NULL DEFAULT 0,
  actor_type    TEXT NOT NULL, actor_id TEXT, client_id TEXT,
  idempotency_key TEXT,                     -- unique per (org_id, actor_id)
  heartbeat_at  INTEGER, plan_expires_at INTEGER,
  created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER
);
CREATE TABLE operation_items (
  operation_id  TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  category      TEXT,                       -- prune category; NULL for bulk
  target_kind   TEXT NOT NULL,              -- project | release | object | workload | …
  target_id     TEXT NOT NULL,
  label         TEXT,                       -- slug / key, shown in UI
  verdict       TEXT NOT NULL,              -- ok | skip | blocked
  reason        TEXT,
  status        TEXT NOT NULL,              -- pending|succeeded|skipped|failed|cancelled
  error         TEXT,
  bytes         INTEGER,                    -- for prune: size freed
  PRIMARY KEY (operation_id, seq)
);
ALTER TABLE audit_log ADD COLUMN operation_id TEXT;  -- per-item audit rows link to their operation
```

Finished operations are kept for 90 days, then the maintenance sweep removes them.

### 2.4 Core shape (`packages/core/src/operations/`)

```ts
/** One registered mass action. Bulk actions and prune categories both implement this. */
interface ActionDefinition<Target> {
  id: string;                               // 'project.delete'
  kind: 'bulk' | 'prune';
  permission: Permission | 'platform:admin';
  destructive: boolean;
  reversible: boolean;                      // drives confirm UX and MCP exposure
  surfaces: { mcp: boolean; apiKey: boolean };  // session is always allowed
  plan(ctx, principal, targets: string[]): AsyncIterable<PlannedItem<Target>>;
  apply(ctx, principal, item: PlannedItem<Target>): Promise<ItemResult>;  // idempotent, re-verifies
}

class OperationService {
  create(principal, input: { action; targets?; params?; stage: 'plan' | 'apply'; idempotencyKey? }): OperationView;
  apply(principal, id): OperationView;
  cancel(principal, id): OperationView;
  get(principal, id, { items?: { after?: number; status?: string } }): OperationView;
  list(principal, filter): OperationView[];
  events(principal, id, afterSeq?): AsyncIterable<OperationEvent>;  // feeds SSE
}
```

Action definitions live in a registry (`operations/registry.ts`). `@skiff/contracts` exports the
public metadata (id, label, permission, destructive, reversible), so the dashboard bulk bar, the CLI
help and the MCP tool list are generated from it. **Adding a future mass action means writing one
`ActionDefinition`, with no new routes, tables or UI plumbing.**

The runner is in-process in the control plane: a small loop that claims `queued`/`applying`
operations with a heartbeat. Only the active control plane runs it (D5; standbys skip background
work, D107), and the heartbeat claim keeps a second instance safe.

### 2.5 Progress events

`GET /api/v1/operations/:id/stream` sends Server-Sent Events, using the same pattern as
`logs/stream` with `id: <seq>` so reconnects resume without a gap. Progress events are throttled
to about 4/s, and item events are batched.

```
event: progress  data: {"status":"applying","phase":"releases","done":120,"total":480,"failed":0,"freedBytes":48213992}
event: item      data: [{"seq":121,"label":"blog","status":"succeeded"},{"seq":122,"label":"old-demo","status":"failed","error":"…"}]
event: done      data: {"status":"partial","summary":{…}}
```

The dashboard uses `EventSource` with the session cookie. The CLI uses `fetch` with a streaming
body and the bearer key, because `EventSource` can't send headers. MCP has no stream: the tool waits
up to 20 s server-side and returns the summary or the operation id.

---

## 3. Bulk project actions (v1 set)

| Action | Permission | Reversible | MCP | Effect per item |
|---|---|---|---|---|
| `project.delete` | `project:delete` | yes (7-day trash) | yes, ≤25, elicitation | existing `softDelete` |
| `project.restore` | `project:update` | n/a | yes | existing `restore`, plus a quota check (missing today) |
| `project.purge` | `project:delete` | **no** | **no** | runs the same cascade as the trash purge (L1/L2 fixed) right away, only for projects already in the trash |

Plan verdicts that matter for the confirm UX:

- `ok` + `flags: ['live']`: production is serving, so deleting takes a site offline.
- `ok` + `flags: ['workload']`: a process/container app will be stopped.
- `ok` + `flags: ['custom_domain']`: custom domains will stop resolving to Skiff.
- `skip: already_in_trash | not_in_trash | not_found`
- `blocked: forbidden`: the principal lacks the permission for that item. This is per item so it
  stays correct when project-level roles arrive.

**Targets are always an explicit list of slugs or ids.** The server never deletes "everything
matching a filter". Filters (`test-*`, not deployed, idle 90 days) are resolved by the client into a
list, the human sees that list, and that list is what gets planned. This closes the race where a
project created after the confirmation matches the filter and gets deleted with the others.

### 3.1 Future actions (each one is a new `ActionDefinition`)

`project.set_access`, `project.set_placement`, `project.pause` / `resume` (stop serving without
deleting, which needs a `paused_at` column), `project.redeploy` / `rebuild`, `shareLink.revoke_all`,
`deployment.delete_unpinned`, `project.transfer` (to another org, once multi-org is used), and tags
once projects have them. Actions that change desired state call `bump()` **once at the end of a
chunk**, not once per item, so agents converge once.

---

## 4. Trash

The trash is the undo for mass delete, so it has to exist in the dashboard (L7).

- `/projects?view=trash` lists deleted projects with "purges in N days", the same table with
  checkboxes and the bulk actions **Restore** and **Delete permanently**.
- After a bulk delete completes, the result toast offers **Undo**. That creates a
  `project.restore` operation for exactly the items that succeeded.
- Slugs stay reserved while a project is in the trash (`takenSlugs` already counts deleted rows), so
  a restore never conflicts.

---

## 5. Prune

### 5.1 What counts as an orphan

Prune removes only things **no live owner references**. It never touches something a user owns and
might still want: a project with no deployments, an idle environment or an unused secret are still
connected. (A "find stale things" report is a separate, later feature that produces bulk-action
candidates, not prune items.)

Each category is a prune `ActionDefinition`, scanned and applied in this order (children before
parents, rows before objects):

| Category | Orphan when | Scope | Notes |
|---|---|---|---|
| `project_rows` | `environments`, `workloads`, `git_sources`, `builds`, `log_events`, `share_links`, `slug_redirects`, project `secrets` whose `project_id` has no `projects` row | org | cleans up after L1 |
| `domains` | `domains` row whose project is gone, **plus its managed Cloudflare record** | org | goes through `domains.delete` (L2). Shows the hostname in the plan |
| `workload_reservations` | workload of a deleted project still in `pending/starting/running` | org | sets status `stopped`, which frees the node budget (L5) |
| `share_redemptions` | redemption whose link is gone, or expired more than 30 days ago | org | |
| `deployments` | `status='deleted'` for more than 30 days | org | the logic of `cleanupRows` (L3) |
| `upload_sessions` | `expired/failed` for more than 24 h | org | the object is handled under `objects` |
| `config_snapshots` | not referenced by any deployment | org | L4 |
| `releases` | not referenced by any non-deleted deployment | org | reuses `runGc`'s guarded delete |
| `objects` | a key in the store under `releases/` or `uploads/` with no `releases`/`upload_sessions` row, **and older than 24 h** | platform | needs `ObjectStore.list(prefix)` (L6). Keys are content-addressed and shared across orgs, so this is platform-only |
| `node_caches` | release dirs on an agent that no desired state references | platform | **later**: an agent verb. Listed so the registry has the slot |

Never pruned: `audit_log`, `backup_runs`, Litestream generations and telemetry/Parquet (each has its
own retention), plus anything younger than the **24 h grace window**, which protects in-flight
uploads and finalize.

### 5.2 Scopes and permissions

- **Org prune** (`scope: org`, the default) covers the org-scoped categories for the principal's
  org. It requires `project:delete` (owner/admin by default; deployers don't have it) from a
  session or an API key.
- **Platform prune** (`scope: platform`) covers every category across all orgs, including
  `objects`. It requires a **platform admin dashboard session or a platform admin API key**, and
  it follows the existing rule (DESIGN §6.2) of no OAuth tokens for platform mutations. Whether API
  keys are also refused is open question Q2.
- Prune is **not exposed to MCP** in v1 (§6.3).

### 5.3 Plan, then apply

1. `scan`: create a prune operation with `stage: 'plan'`. The scan streams progress per category
   (`phase`, items found, bytes). Listing R2 is the slow part.
2. Review: per-category counts and bytes, expandable to individual items (paginated).
   Categories can be deselected.
3. `apply`: deletes exactly the planned items in the selected categories, re-checking each one.
   The plan expires after 1 hour, after which you have to scan again.

The two-step flow is mandatory for prune because "anything not connected" is a judgement the
human should see before it runs, and because the object listing can be large.

### 5.4 Prune and automatic maintenance

The 60-second maintenance sweep should keep doing the cheap, certain work automatically: the trash
purge with the fixed cascade, `cleanupRows`, upload expiry and `gcReleases`. Prune is the deep,
on-demand backstop. It catches drift, crashes mid-GC and data left behind by the old code, and it
is the only thing that lists the object store. Later, prune can run on a schedule (for example
monthly, plan-only, with a notification if it finds anything).

---

## 6. Surfaces

### 6.1 REST (`/api/v1`)

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/operations/actions` | — | registry metadata, filtered to what the principal can run |
| POST | `/operations` | per action | `{ action, targets?, params?, stage: plan\|apply }`, `Idempotency-Key` header → `202 { operation }` |
| GET | `/operations` | `project:read` | `?kind&status&limit`; platform admins can pass `?scope=platform` |
| GET | `/operations/:id` | creator or `project:read` | `?items=1&after&status` for paginated items |
| GET | `/operations/:id/stream` | same | SSE (§2.5) |
| POST | `/operations/:id/apply` | per action | only from `planned`. `{ categories? }` for prune |
| POST | `/operations/:id/cancel` | creator or org admin | |

Convenience aliases such as `POST /projects/bulk-delete` are not added. One generic endpoint keeps
future actions free.

### 6.2 CLI (`skif`)

```
skif projects delete <slug…> [--match <glob>] [--not-deployed] [--older-than 30d] [--stdin] [--yes] [--json]
skif projects restore <slug…> [--yes] [--json]
skif projects trash [--json]                       # list the trash with purge dates
skif projects purge <slug…> [--yes]                # irreversible; trash only
skif prune [--apply] [--scope org|platform] [--only releases,objects,…] [--yes] [--json]
skif operations [list | show <id> | watch <id> | cancel <id>]
```

- The selectors (`--match`, `--not-deployed`, `--older-than`, `--stdin`) are resolved **in the
  CLI** with `GET /projects`. The CLI then creates a plan and prints it (table: slug, live, flags,
  verdict) before asking `Delete 12 projects (3 live)? [y/N]`.
- If stdin isn't a TTY and `--yes` wasn't passed, the CLI refuses and says why. Purge with more than
  10 targets also asks you to type the count.
- `skif prune` without `--apply` is a dry run. It shows the scan's live progress, then a
  per-category table (items, size) and the command to apply that plan
  (`skif prune --apply --plan op_…`). `--apply` without `--plan` scans and then asks for
  confirmation.
- Progress: on a TTY there is one redrawn line per category (`releases ▕████████░░▏ 384/480 · 46 MB`)
  and failures print inline. Otherwise `--json` emits NDJSON events and plain mode prints one line
  per phase.
- **Ctrl-C detaches and does not cancel.** It prints `Still running: skif operations watch op_…`
  and exits 130. `skif operations cancel` is the explicit stop.
- Exit codes: 0 succeeded, 3 partial, 1 failed, cancelled, expired or declined at the prompt.

### 6.3 MCP

| Tool | Notes |
|---|---|
| `delete_projects({ projects: string[] })` | at most 25. Plans first, then elicitation lists every slug and flags the live ones: *"Delete 6 projects? 2 are serving production: blog, docs. Restorable for 7 days."* The signed `requestState` (D35) binds to the **operation id**, and the plan is fixed, so the confirmed set can't change. Legacy clients get the dashboard hand-off with a deep link to the trash/projects page filtered to those slugs. |
| `restore_projects({ projects: string[] })` | no confirmation needed |
| `get_operation({ id })` | read-only, for runs that outlast the 20 s wait |

`project.purge` and prune are **not** MCP tools: agents never trigger irreversible deletion (D29:
"humans gate destruction"). The single `delete_project` tool stays as it is.

### 6.4 Dashboard

**Projects list** (`routes/(dashboard)/projects/+page.svelte`)
- Checkbox column. The header checkbox selects all *filtered* rows (capped at 100, and says so).
  Shift-click selects a range. Selection clears when the search changes.
- A sticky bulk bar appears when anything is selected:
  `12 selected · [Delete] [⋯ more actions] · Clear`. "More actions" is filled from
  `/operations/actions`, so future actions appear without UI work.
- **Delete** plans first, then opens a confirm dialog built from the plan: counts by verdict, a
  live-sites warning listing those slugs, skipped and blocked items with reasons, and the first 10
  targets plus "and N more". If there are 5 or more items, or any are live, you have to type the
  number of projects to confirm.
- While it applies, a progress card replaces the bulk bar (bar, done/total, failures expandable).
  The result toast offers **Undo** (restore the ones that succeeded).

**Trash** (§4): the same table at `?view=trash`, with Restore and Delete permanently.

**Settings → Maintenance** (new page next to Backups/Updates)
- **Prune** card: a scope toggle (org; platform for admins) and a **Scan** button. The scan shows
  live per-category progress. The plan table has one row per category (items, size, checkbox),
  expandable to items. Then the **Prune N items (X MB)** button runs it with per-category progress
  bars and a running "freed" total.
- **History**: recent operations (bulk and prune) with status, actor, counts and duration, linking
  to `/settings/maintenance/operations/[id]`. That page shows the item list with filters, the error
  text and the linked audit rows.

---

## 7. Audit

- On the operation itself: `operation.create`, `operation.apply`, `operation.cancel` and
  `operation.finish` (with summary), recorded under `resource: 'operation'`.
- Each item writes its normal audit row (`project.delete`, `prune.release` and so on) with
  `operation_id` set, so the audit page can group "12 project deletes" under one expandable entry.
- MCP calls are still audited as `mcp.<tool>` (DESIGN §6.3).

---

## 8. Build order

0. **Fix the leaks** (L1–L5): a single cascade function used by both the trash purge and
   `project.purge`, with domains going through `domains.delete`; wire in `cleanupRows`; GC config
   snapshots; exclude deleted projects from reservations. Each fix gets a test. This is patch-level.
1. Migration `0007_operations.sql`, `OperationService`, the runner, the registry and SSE, tested
   against a fake action.
2. `project.delete` / `restore` / `purge` definitions. REST. Trash view and the bulk bar in the
   dashboard.
3. CLI `projects delete|restore|trash|purge` and `operations`.
4. `ObjectStore.list()` (local and R2), the prune categories, Settings → Maintenance, `skif prune`.
5. MCP `delete_projects`, `restore_projects`, `get_operation`.

Steps 1–5 are a feature and an additive migration, which means a **minor** bump
(`bun run version:minor`), to be confirmed before release. The CLI is versioned separately.

---

## 9. Decisions (D49–D54)

| # | Decision | Why | Rejected |
|---|---|---|---|
| D49 | Mass actions and prune share one **Operation** primitive (plan → apply, per-item status, resumable, SSE progress), with actions registered as `ActionDefinition`s. | One place for progress, audit, limits and cancel. Future mass actions are one definition each. | A `/projects/bulk-*` endpoint per action; client-side loops over single-item endpoints (no progress, no resumption, N audit entries without grouping). |
| D50 | **Explicit targets only.** Filters are resolved into a list on the client, and the server plans and applies that list. | You confirm exactly what gets deleted; no race with newly created projects. | Server-side filter selectors for destructive actions. |
| D51 | **Per-item success** (`partial` is a valid outcome); each item is idempotent and re-verified at apply time. | Items have side effects outside SQLite that can't be rolled back; a single failure shouldn't block 99 good deletes. | All-or-nothing transactions. |
| D52 | Prune removes only **unreferenced** things, always as **plan then apply**, with a 24 h grace window. Org scope needs `project:delete`; the object store is platform scope (platform admin). | "Not connected" has to be shown before it runs; content-addressed objects are shared across orgs. | Pruning "unused" but owned resources; a one-shot prune. |
| D53 | MCP gets `delete_projects` (≤25, elicitation bound to the operation id) and `restore_projects`. **No purge and no prune over MCP.** | Keeps D29: agents can do reversible things with confirmation, and humans gate irreversible ones. | Bulk purge for agents; no bulk tools at all. |
| D54 | The dashboard gets a **Trash** view, and bulk delete offers **Undo**. | Mass delete needs a visible, fast way back. | Restore through the API only. |

## 10. Resolved questions

- **Q1** Typed confirmation: required for 5 or more items or any live site, and always for
  permanent delete (purge).
- **Q2** Platform prune accepts a platform admin's dashboard session **or API key** (useful for
  cron/CI), never OAuth/MCP. Prune is plan-then-apply and only removes unreferenced data.
- **Q3** `project.pause` is deferred; it is the first candidate for §3.1.

## 11. Where it lives

| Piece | Path |
|---|---|
| Wire types, action metadata, limits | `packages/contracts/src/operations.ts` |
| Schema / migration | `packages/db/src/schema.ts`, `packages/db/migrations/0007_operations.sql` |
| Service, runner, resume | `packages/core/src/operations/service.ts` |
| Bulk project actions | `packages/core/src/operations/project-actions.ts` |
| Prune categories | `packages/core/src/operations/prune.ts` |
| Hard-delete cascade | `ProjectService.purgeRow` in `packages/core/src/projects.ts` |
| REST | `apps/control-plane/src/routes/api/v1/[...path]/+server.ts` (`operations` section) |
| SSE | `apps/control-plane/src/routes/api/v1/operations/[id]/stream/+server.ts` |
| MCP | `delete_projects`, `restore_projects`, `get_operation` in `apps/control-plane/src/lib/server/mcp.ts` |
| Blueprints (§12) | `packages/core/src/blueprints.ts` (`BlueprintService`, `blueprintApplyAction`), contracts `blueprint.ts`, migration `0066_blueprints.sql`, REST `routes/api/v1/blueprints/**`, CLI `skif blueprint`, MCP `plan_stack`/`apply_stack`/`get_task`, dashboard `/new/blueprint` |
| Dashboard | `routes/(dashboard)/_lib/operations/`, `projects/`, `settings/maintenance/` |
| CLI | `apps/cli/src/commands/{projects,prune,operations,run-operation}.ts`, `apps/cli/src/{sse,follow,selectors,operations}.ts` |
| Tests | `packages/core/src/operations.test.ts`, `apps/control-plane/tests/operations.e2e.ts`, MCP cases in `tests/mcp-oauth.e2e.ts`, CLI unit tests |

---

## 12. Blueprints (`blueprint.apply`)

Status: **implemented, 2026-11-07** (plan 11, v1 subset; behind `SKIFF_FEATURE_BLUEPRINTS`, off by
default). A blueprint is one declarative file (`skiff.blueprint.yaml|yml|json`, `apiVersion:
skiff/v1`) describing a *stack*: projects (environments, domains, workload settings), managed
databases, storage instances with buckets, brokers, and the attachments between them. Map keys are
the real resource names; unset fields are unmanaged (platform default on create, untouched after).
Secret references are names only. Contract: `packages/contracts/src/blueprint.ts`.

### 12.1 Plan

`BlueprintService.plan(principal, { document, prune })` parses (JSON when it starts with `{`, else
`Bun.YAML`), validates strictly, then diffs every resource against live state into **steps** keyed by
stable resource keys (`projects.web`, `projects.web.environments.staging`, `projects.web.service`,
`projects.web.domains.<host>`, `databases.db`, `storage.st`, `storage.st.buckets.b`, `brokers.mq`,
`attachments.<project>.<database|storage|broker>.<name>`). Order: projects → environments →
databases → storage → buckets → brokers → workload settings → domains → attachments; with prune,
deletes follow in reverse (attachments, domains, environments, buckets, brokers, storage, databases,
projects; children of a deleted project or storage are not listed separately).

Any problem fails the whole plan with its key: a missing permission for a non-noop step, a secret
name that does not resolve, an immutable change (project runtime, database engine/variant, broker
engine), a Postgres major change or any downgrade, a slug held by another org or a live rename
redirect, a domain on another project or a platform host, a trashed resource, an env-prefix clash,
or a prune target still attached outside the plan / a non-empty bucket. Plan never mutates.

The plan is stored as a **planned `blueprint.apply` operation** (kind `bulk`, one target: the stack
name; expires with the 1 h plan TTL). The document and steps live in the operation's internal
params (`OperationParams.blueprint`), which `OperationView` strips and `POST /operations` cannot set
(`authorize` refuses an operation without them). Each step becomes one item (`noop` → verdict
`skip`, reason `up to date`). `planHash` = sha256 of the canonical `{stack, prune, documentHash,
steps(key, kind, action, changes)}`, so it is stable for the same document and live state; reasons
and timestamps are not part of it.

### 12.2 Apply

`apply(principal, { planHash, confirm? })` finds the caller's planned operation with that hash and
calls `OperationService.apply`, whose new **`beforeApply` hook** re-checks the flag, each step's
permission, refuses MCP principals for a pruning plan, requires `confirm === stack` when the plan
deletes, and **recomputes the diff**: a different hash (live state moved) is a `409`. Identical
sibling plans are cancelled, so resubmitting the hash returns the started run.

Each item converges one resource through the normal service (re-reading live state; already equal
→ `skipped: up to date`). The **first failure stops the run**: later items are `skipped: an earlier
step failed`; nothing is rolled back (D51 semantics, `partial` is a valid outcome), and the next
plan lists only what is left. New databases, private storage and brokers are placed next to the
first project the file attaches them to (its attachment node, workload node, an already-created
sibling service, else its placement), so D56 co-location holds without a compensating move.
Workload settings are saved with `WorkloadService.setSpec` (no deploy).
A blueprint run is a `bulk` operation, so it shares the one-applying-per-org rule (§2.2) with bulk
project actions.

The `finish` hook upserts the **stack record** (`blueprints` table, 0071): `managed_json` (keys the
stack created or adopted; only these can ever be pruned), `last_operation_id`/`last_status`, and on
a clean run the normalised document, its hash, `applied_plan_hash/at/by`. Without prune, managed
keys missing from the file are kept and warned about; keys whose resource is gone drop out. An
audit row `blueprint.apply` (resource `blueprint`) records the outcome; each step writes its normal
audit row with the operation id.

### 12.3 Surfaces

- REST: `POST /blueprints/validate|plan|apply` (`?wait` on apply), `GET /blueprints/apply/:id`,
  `GET /blueprints`, `GET /blueprints/:name` (docs/API.md).
- CLI: `skif blueprint validate|plan|apply [file] [--prune] [--plan <hash>] [--confirm <stack>]
  [--yes] [--json]`; apply follows the operation stream and exits 0/3/1 like bulk runs.
- MCP: `plan_stack` (read-only, no prune), `apply_stack` (destructive; elicitation whose signed
  request state is bound to `stack:<name>:<planHash>`; pruning plans refused), `get_task` (polls
  any operation; blueprint runs return the per-step view). Assistant: `apply_stack` needs
  `project:update` to be offered.
- Dashboard: **New → Apply a blueprint** (`/new/blueprint`): paste or open a file, plan, review the
  diff, type the stack name for deletes, apply, follow per-step progress over SSE.

### 12.4 Not in v1

Jobs, app volumes, previews, static uploads (`path`), drift badges, `export`, JSON Schema
publishing, compensation on failure and Compose import (plan 14) are not implemented.

