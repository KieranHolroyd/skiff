# 17 — Data import, export, and portability

**Priority:** P1 · **Effort:** S–M · **Lane:** D · **Wave:** 3
**Depends on:** 01 backups, 02 object-storage surface, 05 backup target
**Blocks:** nothing, but it is the exit/switch feature
**Primary files:** `packages/contracts/src/portability.ts`, `packages/core/src/portability.ts`,
`apps/cli/src/commands/import.ts`, `apps/control-plane/src/routes/api/v1/portability/**`,
`docs/PORTABILITY.md`

## Goal

Make it easy to move data in and out: import a Postgres dump, sync an S3 bucket, export a project
as a `skiff.yaml` plus data, and document a tested exit path. Portability is a trust feature, not
an afterthought.

## Non-goals

- A general ETL/data-migration tool.
- Cross-engine schema translation (Postgres → MySQL).
- Continuous replication (that is a P2 feature).
- Exporting secrets in plaintext.

## Current state

- Restore creates a new database from an artifact (01); there is no arbitrary dump import or
  object sync.
- `skif` has no import/export commands.
- `skiff.yaml` can describe a stack (11); no bundle format.
- Zeabur's shutdown and the general vendor-risk argument make export a differentiator.

## Design

### Database import/export

- `skif db import <file|s3-url> --database <name> [--format dump|csv] [--dry-run]`
  - Stream the file to the node; `pg_restore` or `psql` into a **new** database by default.
  - `--dry-run` validates the dump header and lists objects without applying.
  - Reject a dump whose database name does not match unless `--remap`.
  - For CSV: `--table <name> --columns ...`; use `COPY`, not a shell.
- `skif db export <name> [--format dump|sql|parquet?] --out <file|s3-url>`
  - `pg_dump -Fc` streamed to stdout or a presigned URL.
  - `--schema-only`, `--data-only`, `--table`.
- REST: `POST /databases/:name/import`, `POST /databases/:name/export`.
- MCP: `export_database` (read-only), `import_database` (confirmed, new target only).
- Never overwrite an existing database by default.

### Object storage sync

- `skif storage sync <source> <destination>` using an S3 client:
  - Source/destination can be a Skiff storage instance (bucket/prefix), an external S3 endpoint, or
    a local directory.
  - `--delete` is opt-in; default copy only.
  - `--dry-run` lists changes; `--include/--exclude` globs.
  - Preserve metadata/key; multipart for large objects.
- `skif storage export <instance>/<bucket> --out <dir|s3-url>`.
- REST/MCP equivalents; stream, never buffer.
- For a Skiff instance, use a scoped key or the root key with an audited operation; prefer a
  temporary key.

### Project bundle

- `skif export <project> --out project.tar.gz`:
  - `skiff.yaml` (blueprint, no secrets), release artifacts or a pointer, database dump(s), object
    manifest, job definitions, domain list, env **names**.
  - `manifest.json` with versions, checksums, and a `secrets` section listing names only.
- `skif import <bundle>`:
  - Validate manifest/checksums, create a new project, apply the blueprint, restore dumps, sync
    objects, prompt for secrets (never include them), and leave the source untouched.
- This is the "leave Skiff" path; document it and test it in CI.

### Safety

- Import into a new resource by default; overwrite requires typed confirmation and a pre-import
  snapshot.
- Checksums; resumable for large files; progress in CLI/SSE.
- Secrets are never exported. A bundle without secrets is not directly runnable; the import prompts.
- Audit import/export/sync, including the object count/bytes.
- Rate limit; a huge import should not block the control plane.

## Implementation order

1. Contract + CLI skeleton + `db export` (safe, read-only) first.
2. `db import` into a new database; dry-run; checksum.
3. Storage sync/export with a local dir and an S3 target.
4. Project bundle export.
5. Project bundle import (blueprint apply + dump restore + object sync).
6. REST/MCP; docs; CI exit test.

## Acceptance criteria

- [ ] `skif db export` streams a 1 GB dump to a file/S3 without buffering in the control plane.
- [ ] `skif db import` creates a new database and verifies row counts; the source is untouched.
- [ ] `skif storage sync` copies a bucket to local/S3, supports `--dry-run`, and `--delete` is opt-in.
- [ ] `skif export` produces a bundle with a manifest/checksums but no secret values.
- [ ] `skif import` recreates the stack and prompts for secrets; a checksum mismatch fails safely.
- [ ] A CI test exports and imports a fixture project end-to-end.
- [ ] No import overwrites an existing resource without typed confirmation.

## Tests

- Unit: dump header, checksum, path/remap, sync diff, bundle manifest.
- Integration: Postgres dump/restore, S3 copy, bundle export/import.
- Failure: truncated dump, wrong database, checksum mismatch, missing secret.
- Security: no secret in bundle/log; temp key scoped; audit.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Large files | Stream to/from target; resumable; progress |
| Wrong target overwrite | New resource default; typed confirmation; snapshot |
| Secrets leak | Names only; prompt on import; redact logs |
| Engine version mismatch | Warn/refuse; dump/restore is portable across majors |
| S3 metadata loss | Preserve content-type/metadata; test |

## Rollout

Export/sync (read-only) first; import behind `SKIFF_FEATURE_IMPORT`. Document the exit path in
`docs/PORTABILITY.md` and test it every release.

## Open questions

- Do we support a full project bundle import in v1, or only DB/storage? Start with DB/storage, then
  the bundle.
- Should `skif export` include release artifacts? Include a pointer and optionally the files; a
  bundle with artifacts is large.
- Do we need Parquet export for analytics? Not in v1.

## File ownership

Own: `packages/contracts/src/portability.ts`, `packages/core/src/portability.ts` + test,
`apps/cli/src/commands/import.ts` / `export.ts`, `apps/control-plane/src/routes/api/v1/portability/**`,
`docs/PORTABILITY.md`.

Integration-owned: schema/migration (if any), core context/index, helper/agent stream verbs,
dashboard project page, MCP/CLI registration, CI exit test.
