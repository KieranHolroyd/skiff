# Shared brief for every Skiff fix agent

Repository: /Users/kieranholroyd/Github/private-cloud-deploys (Skiff: a self-hosted deploy platform,
Bun monorepo). Read README.md "Architecture" first if you are new to it.

## Wave 2 context

This is the second wave. The first wave was paused mid-work; read `reports/fix-handoff/README.md`
(status + remaining work per package) and, for large packages, `reports/fix-handoff/plans.md`
(the detailed designs). The code in the tree is the source of truth for what exists: inspect it
(`git diff`, `git status`, reading the files) before building on a plan.

## You are one of ~16 agents working IN THE SAME CHECKOUT at the same time

Two other sessions are also editing this tree right now with uncommitted work: "Container Runtime
Management Features" (container runtime / helper units / workloads area) and "Add Ask AI to
Triggering Alerts" (alerts area). Expect files to change under you there.

- NEVER run `git checkout`, `git stash`, `git reset`, `git restore`, `git clean`, `git commit`, or
  any command that changes git state. Read-only git (`git diff`, `git log`, `git status`) is fine.
- NEVER revert, rewrite or reformat code you didn't write. Don't run `prettier --write` or
  `eslint --fix` on files you didn't create; for files you edit, format only your own hunks.
- Edit shared files (mcp.ts, schema.ts, contracts index, core index, routes, CLI main) with small,
  targeted Edit-tool replacements. Re-read a file right before editing it: someone may have changed
  it. If an edit fails because the file changed, re-read and retry. Never overwrite a whole
  existing file with Write.
- Stay inside your work package. If you find something outside it that's broken, report it; don't
  fix it.

## How Skiff code is organised (follow it)

- Every surface (dashboard, REST, MCP, assistant, CLI) calls the service layer in `packages/core`.
  RBAC permissions are strings in `packages/contracts/src/permissions.ts`; core methods check them
  and record audit entries. Never put business logic in a route.
- REST: `apps/control-plane/src/routes/api/v1/**/+server.ts` using `route()`/`readJson()` from
  `#lib/server/api.js` and `requirePrincipal`. MCP tools: `apps/control-plane/src/lib/server/mcp.ts`
  (`tool(...)` with annotations and `scopeChallenge: requires(...)`; destructive ones use the
  existing confirmation pattern). CLI: `apps/cli/src/commands/*.ts`. Dashboard: SvelteKit 3 +
  Svelte 5 runes + shadcn-svelte + TanStack Query under
  `apps/control-plane/src/routes/(dashboard)`; copy the conventions of a neighbouring page.
- Contracts/schemas: zod in `packages/contracts/src`. DB: Drizzle schema
  `packages/db/src/schema.ts` + forward-only SQL migrations in `packages/db/migrations`.
- Node agent: `apps/agent`; privileged root helper: `apps/helper` (fixed verbs, strict validation);
  builder: `apps/builder`; installer: `scripts/install`.

## Migrations

If you need schema changes, use ONLY the migration number assigned to you in your task (one file,
`packages/db/migrations/NNNN_<name>.sql`), additive statements only. You MAY amend a first-wave
migration that belongs to your own package (0053, 0054_site_access, 0059, 0060, 0061, 0063, 0064,
0065, 0066 — all uncommitted and unreleased) instead of adding a new file; never touch 0067/0068 or
anything older. Numbering gaps are expected; they are closed at the end. Use additive statements (see existing files and
`scripts/check-migrations.ts`), then regenerate with `bun run --cwd packages/db generate`
(it rebuilds `packages/db/src/migrations.ts` from all files, so concurrent runs are safe). If you
end up not needing your number, say so in your report. Never edit an existing migration.

## Design docs and user docs

- `docs/*.md` are design docs (source of truth for design). If your change makes a design doc
  stale, update that section. Do NOT add or renumber rows in `docs/DECISIONS.md`; instead list any
  design decision you made in your final report.
- User docs live in `packages/docs/content/**.md` (rules: `packages/docs/WRITING.md`). Update the
  pages that describe what you changed (remove "not available yet" notes for things you built,
  document new commands/flags/routes/tools). Run `bun packages/docs/scripts/check-page.ts <slug>`
  for each page you edit. Several agents may touch `clients/cli.md`, `clients/mcp.md` and
  `clients/rest-api.md`: use small Edit replacements there. Don't touch the "There are N tools"
  count line in clients/mcp.md (it's fixed up at the end).

## Quality bar

- Write or extend tests next to the code (bun:test). Run the relevant tests:
  `bun test <paths>`; type-check what you touched: `bun run --cwd packages/<pkg> check`,
  `bun run --cwd apps/<app> check` (control-plane uses svelte-check and takes a minute or two).
  Fix every error your change introduces. Don't "fix" pre-existing failures outside your area,
  but mention them.
- If part of your task needs real infrastructure you can't run here (Linux, systemd, Podman,
  Postgres replication, TPM2…), implement it fully with unit tests around the generated
  units/configs/commands, and state exactly what still needs a live check.
- No placeholder or stub code. If something is genuinely too large to finish, finish a coherent,
  working slice end to end (core → REST → CLI/MCP → UI → docs) and report what remains.

## If you are told to stop

Finish only the edit in progress so nothing is half-written, regenerate migrations if you changed
any, and report DONE / PARTIAL (exact files and what's left) / NOT STARTED.

## Final report (keep it under ~20 lines)

1. What you changed, by file area. 2. Tests/checks you ran and their results. 3. Migration number
used (or "none"). 4. Design decisions to record. 5. What still needs a live check, and anything
you found outside your scope.
