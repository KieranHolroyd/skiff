---
title: Scheduled jobs
description: Run commands in your app on a cron schedule or once, run a Function's cron triggers, and see how Skiff fires, skips, retries and logs each run.
---

Skiff runs scheduled work in two ways. **App jobs** run a command inside a process or container app: a nightly cleanup on a cron schedule, a report you start by hand, or a one-off migration with `skif run`. **Function cron triggers** call a Function's `scheduled()` handler at the times listed in its Wrangler config. Both use the same five-field UTC cron syntax. Database backups also run on a schedule (see [backups and PITR](/data/backups-and-pitr)), but you configure those on the database, not here.

> [!NOTE]
> App jobs are on unless a platform admin sets `SKIFF_FEATURE_JOBS=0` (see [configuration](/self-hosting/configuration)). The app's node must also run a current agent. Function cron triggers are always available.

## App jobs

A job is a named command on a [process or container app](/compute/apps-and-containers), with an optional cron schedule. Each time it runs, Skiff starts the command once on the app's node, records the exit status and keeps the output. A job without a schedule runs only when you ask.

### Create a job

From the CLI, put the command after `--`:

```sh
skif jobs create shop tidy --schedule '0 3 * * *' -- bun scripts/tidy.ts --days 30
skif jobs create shop report -- bun scripts/report.ts
```

The first job runs daily at 03:00 UTC. The second has no schedule, so it runs only with `skif jobs run shop report`. Quote the schedule so the shell passes it as one argument.

In the dashboard, open **Projects → shop → Jobs** and choose **New job**. The form shows how it splits the command into arguments as you type.

The command is an argument list, not a shell string. Each argument reaches your program exactly as written, so `$HOME`, `*` and `&&` are not expanded. If you need a shell, say so: `-- sh -c 'cd sub && ./run.sh'`. A bare program name such as `bun` or `node` is looked up on `PATH`, and a relative path such as `./bin/migrate` is resolved in the release directory.

| Option | CLI flag | Default | Meaning |
|---|---|---|---|
| `name` | positional | (required) | Lowercase letters, digits and single hyphens, up to 40 characters. Unique in the project. `runs` is reserved. |
| `command` | after `--` | (required) | 1 to 64 arguments, each up to 1,024 characters, no newlines. |
| `schedule` | `--schedule` | none | A five-field cron expression in UTC (see [cron syntax](#cron-syntax)). None means manual only. |
| `timeoutSeconds` | `--timeout` (`90s`, `15m`, `2h`) | 600 | 10 seconds to 24 hours. The run is stopped after this. |
| `concurrency` | `--concurrency` | `forbid` | What happens when a scheduled run is due while the previous one is still going. See [overlap, timeouts and retries](#overlap-timeouts-and-retries). |
| `maxRetries` | `--retries` | 0 | Extra attempts after a failure or a timeout, 0 to 10. |
| `enabled` | `--paused` to start paused | on | A paused job keeps its history and can still be run by hand. |

### Run a one-off command

Use `skif run` for a command you want once, such as a migration. It is not saved as a job:

```sh
skif run shop -- bun run migrate
skif run shop --timeout 1h -- bun scripts/backfill.ts --since 2026-01-01
```

The CLI streams the output as the node sends it: the command's stdout to stdout and its stderr to stderr. It then prints a summary line and exits with the command's own exit status. A timeout exits `124` and a cancelled run exits `130`. Use `--detach` to print the run id and return straight away, then `skif jobs logs shop <run id> -f` to follow it. Ctrl-C stops following but leaves the run going.

In the dashboard, **Projects → shop → Jobs → Run command** does the same. `skif jobs run <project> <job>` runs a saved job now in the same way, whatever its schedule.

### What a run gets

A run uses the app's **current production release**: the deployment its workload runs now, recorded on the run. It runs on the app's node (the first replica's node when the app has several), with:

- the app's environment variables and secrets, including file secrets (`<NAME>_FILE`);
- the app's volumes, mounted at the same paths;
- the app's memory and CPU limits, and the same sandbox as the app itself;
- no published port. A run does not receive traffic, and `PORT` is not set.

For a **process app** the run also sees the app's private state directory, as the same user, so files the app wrote are readable. For a **container app** the run starts a new container from the app's image, with your command as its arguments (after the image's entrypoint, as in `docker run image cmd`). It sees the app's `/data` and volumes. The app's container must be running, because the run joins its user namespace so that file ownership matches.

> [!WARNING]
> A run uses production data with production credentials. A migration or cleanup runs against the live database. There is no automatic rollback.

### When a run happens

Skiff checks schedules every ten seconds, so a scheduled run starts within about ten seconds of its time, plus the time the node takes to start it. If the control plane was down when a run was due, the job runs **once** when it comes back, then continues from the next occurrence after that. Missed occurrences are never replayed one by one.

Runs wait in a queue until the node starts them. A node runs up to 8 job runs at a time, and the rest wait. A run that no node starts within five minutes fails with "The node did not pick this run up". This happens when the node is offline or its agent predates jobs. Manual runs are refused up front in those cases.

### Overlap, timeouts and retries

`concurrency` decides what a scheduled run does when the job's previous run is still queued or running:

| Policy | Behaviour |
|---|---|
| `forbid` (default) | The new run is recorded as **skipped** and does not start. |
| `allow` | Both run. |
| `replace` | The running one is stopped and recorded as **cancelled**, then the new one starts. |

Manual runs, one-off commands and retries always start, whatever the policy.

When a run reaches its timeout, the node sends `SIGTERM`, then `SIGKILL` 30 seconds later, and the run is recorded as **timeout**. Cancelling a run works the same way.

A **failed** or **timeout** run is retried if the job has retries left. Attempt 2 starts 30 seconds later, attempt 3 a minute after that, then 2 minutes, doubling up to an hour. A cancelled run is not retried, and neither is a run of a paused job. A run whose node stopped reporting (for example, an agent restart that lost track of it) fails after 90 seconds and is retried in the same way.

### History and output

Each run has a status:

| Status | Meaning |
|---|---|
| `queued` | Waiting for the node, or for a retry's backoff. |
| `running` | The node started it. |
| `succeeded` | Exited with status 0. |
| `failed` | Exited with another status, could not start, or the node stopped reporting. The error says which. |
| `timeout` | Stopped at its timeout. |
| `cancelled` | Stopped by you, replaced by a newer run, or its job was deleted. |
| `skipped` | Not started: the previous run was still going, or the daily run quota was used up. |

```sh
skif jobs list shop
skif jobs runs shop tidy
skif jobs logs shop jr_8f3c… -f
```

In the dashboard, the **Runs** list on the **Jobs** tab shows the newest 50 runs. Select one to see its command, outcome and output, and to stop it. Skiff keeps the newest 100 finished runs of each job, and of one-off commands per project, together with their output. A run keeps its first 10,000 lines of output. A run's output is shown with the run, not in the app's own logs. Older output also ages out with the platform's [log retention](/observe/dashboards-and-logs).

### Pause, edit and delete

```sh
skif jobs pause shop tidy
skif jobs resume shop tidy
skif jobs update shop tidy --schedule '30 2 * * 1-5' --retries 2
skif jobs update shop tidy --no-schedule
skif jobs update shop tidy -- bun scripts/tidy.ts --days 60
skif jobs delete shop tidy --yes
```

After a resume, or a change of schedule, the job next runs at the first occurrence after now. Deleting a job removes its history and output and stops a run in progress. Cancel a single run with `skif jobs cancel shop <run id>`.

### Permissions and limits

| Action | Permission |
|---|---|
| List jobs and runs | `project:read` |
| Read a run's output | `project:read` and `logs:read` |
| Create, edit or delete a job | `project:update` and `deployment:create` |
| Pause or resume a job | `project:update` |
| Run a job, run a one-off command, cancel a run | `deployment:create` |

See [organisations and roles](/accounts/organizations-and-roles). An organisation's [quotas](/self-hosting/quotas-and-limits#jobs) can cap the number of jobs and the job runs per day. A project can have at most 50 jobs.

The [REST API](/clients/rest-api) and the [MCP server](/clients/mcp) expose the same actions.

## Cron syntax

Skiff uses five fields, separated by spaces: minute, hour, day of month, month and day of week.

| Field | Allowed values |
|---|---|
| Minute | `0`–`59` |
| Hour | `0`–`23` |
| Day of month | `1`–`31` |
| Month | `1`–`12` |
| Day of week | `0`–`6`, where `0` is Sunday |

Each field accepts:

- `*`, meaning every value in the field.
- A single value, such as `15`.
- A range, such as `9-17`.
- A step, such as `*/15` (every 15), `9-17/2` (every second value from 9 to 17) or `5/15` (from 5 onwards, every 15: minutes 5, 20, 35 and 50).
- A comma-separated list of any of the above, such as `0,30` or `1-5,8`.

Skiff does **not** accept:

- Seconds, or a sixth field.
- Names such as `MON` or `jan`.
- Macros such as `@daily` or `@hourly`.
- The `?`, `L` or `#` characters.
- `7` for Sunday. Use `0`.

Two behaviours differ from some other cron implementations:

- **Times are UTC.** There is no per-schedule time zone.
- **Day of month and day of week must both match.** Classic cron fires when either field matches. In Skiff, `0 3 1 * 1` fires only at 03:00 UTC on a Monday that is also the 1st of the month.

Some examples:

| Expression | Fires |
|---|---|
| `*/5 * * * *` | Every five minutes |
| `0 * * * *` | At the start of every hour |
| `30 2 * * *` | Daily at 02:30 UTC |
| `0 9-17 * * 1-5` | On the hour, 09:00 to 17:00 UTC, Monday to Friday |
| `0 0 1,15 * *` | At midnight UTC on the 1st and 15th of each month |

A schedule that can never match, such as `0 0 31 2 *` (31 February), is refused for a job. In a Function's `triggers.crons` it is accepted at deploy time but never fires, and the dashboard shows no next run for it.

## Function cron triggers

A Function exports a `scheduled()` handler, and Skiff calls it at the times you list in its Wrangler config. These triggers are part of the Function's deployment, not jobs: they don't appear on the **Jobs** tab and don't count towards the job quotas.

### Declare a cron trigger

Add the expressions under `triggers.crons` in your `wrangler.jsonc` (or `wrangler.json`). Skiff reads them at deploy time.

```jsonc
{
  "name": "nightly-tidy",
  "main": "src/index.ts",
  "compatibility_date": "2026-11-01",
  "triggers": {
    "crons": ["*/15 * * * *", "0 3 * * 1-5"]
  }
}
```

Export a `scheduled()` handler next to your `fetch()` handler (if you have one):

```ts
export default {
  async scheduled(controller, env, ctx) {
    // controller.cron is the expression that fired.
    console.log('tick', controller.cron);
  },
};
```

Deploy the Function as usual (see [Functions](/compute/functions)). Each expression in `triggers.crons` is a separate schedule, and each one calls the same `scheduled()` handler. Use `controller.cron` to tell them apart.

A deploy fails if any expression is invalid. A Function can list at most **8** cron expressions, and each expression is at most **120** characters.

### When a function cron runs

The node that hosts your Function checks the schedules about every ten seconds, and fires each occurrence once. The handler starts within about ten seconds of its scheduled time. Some further details:

- **Replicas.** If the Function runs more than one replica on a node, only the first replica fires the schedule, so each occurrence runs once.
- **Idle Functions.** A cron run starts a Function that has been stopped for inactivity, in the same way a request does.
- **Missed occurrences are skipped.** If the agent is down at an occurrence, Skiff does not replay it. After a restart, an occurrence more than a minute old is dropped. Your handler should not assume every tick ran.
- **No overlap check.** Skiff does not wait for a previous run to finish before starting the next occurrence. If a run is still going when the next one is due, both run. Keep handlers short, or make them safe to run twice.
- **Timeouts.** A run that takes longer than **60 seconds** is aborted, and the agent logs the failure.
- **No retries.** A failed or timed-out run is not retried. The next occurrence is the next attempt.

If you need guaranteed completion for long work, have the handler start the work and record its progress, rather than doing it all inside the 60-second window.

### Run a schedule now

Trigger any of the Function's crons on demand to test the handler. The run goes straight to the Function's host, so it runs your production code with its side effects.

With the CLI, pass the expression exactly as it appears in `triggers.crons`, and quote it so the shell passes it as one argument:

```sh
skif function cron my-worker '*/15 * * * *'
```

The command prints the status code, duration, and any error from the handler. It exits with status `1` when the handler fails. Add `--json` to print the raw task.

Over REST, send the expression in a JSON body:

```sh
curl -X POST https://control.example.com/api/v1/projects/my-worker/function/scheduled \
  -H "authorization: Bearer skif_…" \
  -H "content-type: application/json" \
  -d '{"cron": "*/15 * * * *"}'
```

The response is `200` with the finished task when the handler succeeds, `502` when it fails, and `202` with a `location` header to poll if it is still running. Add `?wait=<seconds>` (up to 25) to control how long the request waits. See the [REST API](/clients/rest-api) page for authentication.

The [MCP](/clients/mcp) server exposes the same action as `run_function_cron`.

The request must be a cron that is listed in the active deployment. Otherwise Skiff rejects it with a validation error that lists the crons it does have.

### Function cron permissions

Running a cron by hand needs the `deployment:read` and `deployment:create` permissions, the same as deploying a Function. See [organisations and roles](/accounts/organizations-and-roles).

### Function run history and logs

Skiff does not keep a history of scheduled firings. The dashboard shows each cron with its next run time, and the result of a manual run is returned to you when you make it. Anything your handler writes with `console.log` goes to the Function's logs; see [dashboards and logs](/observe/dashboards-and-logs).

Failures that happen before the handler runs, such as a host that is not responding, are written to the agent's log on the node rather than shown on the Function's page.
