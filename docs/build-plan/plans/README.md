# Plan index

Read [`../README.md`](../README.md) first. It defines the invariants, dependency graph, file
ownership, and agent protocol.

| ID | Plan | Priority | Wave | Lane | Depends on | Blocks |
|---|---|---|---|---|---|---|
| F1–F5 | [Foundations: contracts, streaming, e2e, scheduler, flags](00-foundations.md) | P0 | 0 | integration | — | all |
| 01 | [Backups, PITR, restore](01-backups-pitr-restore.md) | P0 | 1 | A | F1, F2, F4, 05 | 06, 07, 12, 17, 20 |
| 02 | [Object-storage surface](02-object-storage-surface.md) | P0 | 1 | B | F1, F3 | 15, 17, 20 |
| 03 | [Pooling and TLS](03-pooling-tls.md) | P0 | 1 | C | F1, F3 | 10, 12, 20 |
| 04 | [Isolation and credentials](04-isolation-credentials.md) | P0 | 1 | C | F1, F3 | 10, 12, 20 |
| 05 | [Backup target](05-backup-target.md) | P0 | 1 | A | F1, F2 | 01, 06, 17 |
| 06 | [Upgrade safety](06-upgrade-safety.md) | P0 | 1 | A | F1, 01 | — |
| 07 | [App volumes](07-app-volumes.md) | P1 | 2 | C | F1, F3, 01/05 (snapshots) | 12, 14, 19 |
| 08 | [Valkey](08-valkey.md) | P1 | 2 | C | F1 | 11, 14, 19 |
| 09 | [Jobs and cron](09-jobs-scheduler.md) | P1 | 2 | C | F1, F4 | 11, 12, 14, 19 |
| 10 | [Private networking](10-private-networking.md) | P1 | 2 | C | 03, 04 | 12 |
| 11 | [Blueprints](11-blueprints.md) | P1 | 2–3 | D | F1, 08, 09, 13 | 12, 14, 18 |
| 12 | [Preview data](12-preview-data.md) | P1 | 3 | D | 01, 04, 07, 09, 11, 03, 10 | 20 |
| 13 | [Postgres extensions](13-pg-extensions.md) | P1 | 2 | E | F1 | 11, 14 |
| 14 | [Stacks and Compose](14-stacks-compose.md) | P1 | 3 | D | 07, 08, 09, 11, 13 | — |
| 15 | [Image transforms](15-image-transforms.md) | P1 | 3 | B | 02 | 14 |
| 16 | [Quotas and showback](16-quotas-showback.md) | P1 | 2 | E | F1 | 12, 20 |
| 17 | [Data portability](17-data-portability.md) | P1 | 3 | D | 01, 02, 05 | — |
| 18 | [OpenAPI and Terraform](18-openapi-terraform.md) | P1 | 3 | D | 11 | — |
| 19 | [Process groups](19-process-groups.md) | P1 | 2 | C | F1, 08, 09 | 14 |
| 20 | [Agent data tools](20-agent-data-tools.md) | P1 | 3 | E | 01, 02, 03, 04, 11, 12, 16 | — |
| P2 | [Later bets](P2-later-bets.md) | P2 | 4+ | — | varies | — |

## Start order for a new agent

1. Read `docs/build-plan/README.md` and the plan.
2. Check the status board for the plan and its dependencies.
3. If the plan is `not started` and its dependencies are merged, claim it.
4. If a dependency is missing, do not start; report `blocked: <ID>`.
5. If the plan needs a contract change, open the contract PR first and wait.

## Current highest-leverage parallel set

After F1–F5 merge, these six can run at once:

- **01** backups/PITR (lane A)
- **02** object-storage surface (lane B)
- **03** pooling/TLS (lane C)
- **04** isolation/rotation (lane C — pair with 03, different files)
- **05** backup target (lane A — do this before 01's remote path)
- **09** scheduler primitive + jobs (lane C — scheduler first)
- **16** quota schema/usage (lane E)

Do not start **06** until 01's snapshot hook exists. Do not start **10** until 03 and 04 are
merged. Do not start **12** until 11's plan/apply is stable.
