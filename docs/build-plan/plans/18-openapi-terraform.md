# 18 — OpenAPI 3.1, typed SDK, and Terraform provider

**Priority:** P1 · **Effort:** S–M (OpenAPI/SDK), M–L (Terraform) · **Lane:** D · **Wave:** 3
**Depends on:** 11 blueprints (stable resource semantics)
**Blocks:** external IaC, generated clients, agent integrations
**Primary files:** `packages/contracts/src/openapi.ts`, `apps/control-plane/src/routes/api/openapi.json/+server.ts`,
`packages/sdk/**`, `terraform-provider-skiff/**`, `docs/API.md`

## Goal

Turn the Zod contracts into a real API contract: OpenAPI 3.1, a generated typed SDK, stable error
codes, idempotency keys, cursor pagination, and a Terraform provider generated from the spec.

## Non-goals

- GraphQL.
- A hand-written Terraform provider before the spec is stable.
- A public API gateway or rate-limiting product.
- SDKs for every language; start with TypeScript and a thin Go client for Terraform.

## Current state

- `packages/contracts` is the source of truth (Zod).
- `docs/API.md` is a markdown table; there is no OpenAPI document or SDK.
- REST routes are SvelteKit handlers; some return ad-hoc error shapes.
- No `Idempotency-Key`, request id, or cursor pagination standard.
- Railway/Render/Vercel/Appwrite have providers or generated clients; Skiff does not.

## Design

### Spec generation

- Add `@asteasolutions/zod-to-openapi` or a small generator that walks a registry of route
  definitions. Prefer an explicit **route registry** over inferring SvelteKit routes:
  - Each domain exports `openapiRoutes` with method, path, request/response schemas, scopes, and
    error codes.
  - The registry is composed in `packages/contracts/src/openapi.ts`.
- `GET /api/openapi.json` returns 3.1; `/api/docs` renders Scalar.
- CI check: generate the spec and fail if it differs from the committed `openapi.json` or if a route
  has no schema.
- Versioning: `info.version` follows the platform version; breaking changes need a new path or a
  major bump.

### Conventions

- **Errors:** `{ error: { code, message, details?, requestId } }`; stable codes
  (`insufficient_scope`, `not_found`, `conflict`, `quota_exceeded`, `approval_required`,
  `rate_limited`). HTTP status mapping documented.
- **Idempotency:** `Idempotency-Key` on POST create/apply/restore; store key + response hash for
  24 h; a replay returns the same response.
- **Request id:** `X-Request-Id` accepted or generated; echoed; included in errors and logs.
- **Pagination:** `cursor` + `limit` with `nextCursor`; no offset for large lists.
- **Scopes:** each operation lists the permission/scope; MCP and REST share it.
- **Content types:** JSON; streaming endpoints use `application/octet-stream`/`text/event-stream`.

### SDK

- Generate `@skiff/sdk` (TypeScript) from the spec with `openapi-typescript` + a small fetch wrapper:
  - Typed methods, `SkiffError` with `code`/`requestId`, retries for 429/5xx with backoff.
  - `Idempotency-Key` helper; cursor iterator.
  - No secrets in logs.
- Publish only after the spec is stable; keep it internal until then.
- A thin Go client for Terraform can be generated with `oapi-codegen`.

### Terraform provider

- Generate resources from the spec or hand-write a thin provider using the Go client.
- Resources: project, environment, database, storage, bucket, attachment, domain, volume, job,
  blueprint.
- Acceptance tests against a dev install; import support; drift detection from `plan`.
- Do not build a provider before 11 stabilizes; the provider is a compatibility tax.

## Implementation order

1. Route registry + OpenAPI generation + `/api/openapi.json` + CI diff.
2. Error envelope + request id + idempotency middleware.
3. Cursor pagination for list endpoints.
4. `@skiff/sdk` generation + tests.
5. Terraform provider skeleton + project/database/storage resources.
6. Acceptance tests + docs.

## Acceptance criteria

- [ ] `/api/openapi.json` validates as 3.1 and covers every public route; CI fails on drift.
- [ ] A generated TypeScript client can create a project, database, bucket, and attachment with
      typed requests/responses.
- [ ] A repeated POST with the same `Idempotency-Key` returns the same resource, not a duplicate.
- [ ] Errors include a stable code and `requestId`; 429 includes `Retry-After`.
- [ ] List endpoints use cursor pagination and a stable order.
- [ ] Terraform can create/import a project + database + bucket, and `plan` is empty after apply.
- [ ] No secret is present in the spec examples or SDK logs.

## Tests

- Unit: spec generation, error mapping, idempotency store, cursor.
- Contract: every route has a schema; every schema round-trips.
- Integration: SDK against a dev server; Terraform acceptance.
- Security: scopes match the service layer; no credential endpoints in the SDK by default.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Spec drift | CI generation diff; registry is the source |
| Provider maintenance | Generate from the spec; keep resources small |
| Idempotency storage growth | TTL 24 h; prune in maintenance |
| Error shape churn | Stable codes; versioned docs |
| Over-generation | Start with core resources; add pages |

## Rollout

OpenAPI + SDK first; Terraform after 11 is stable and the spec has no breaking changes for one
release. Keep `/api/docs` behind platform auth or public read-only as appropriate.

## Open questions

- Generate from Zod or hand-write the spec? Generate from a registry to keep types in sync.
- TypeScript SDK only, or also Python? TypeScript first; Python if requested.
- Should Terraform use the SDK or raw HTTP? Thin Go client generated from the spec.

## File ownership

Own: `packages/contracts/src/openapi.ts`, `apps/control-plane/src/routes/api/openapi.json/+server.ts`,
`packages/sdk/**`, `terraform-provider-skiff/**`, `docs/API.md`.

Integration-owned: route registry entries in each domain, error middleware, idempotency table,
CI spec check, docs nav.
