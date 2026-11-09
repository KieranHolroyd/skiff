import { parseArgs, rejectExtraPositionals, requirePositional, type FlagSpec } from '../args.ts';
import type { ApiClient } from '../api.ts';
import { UsageError } from '../errors.ts';
import {
	jobDetails,
	jobRunDone,
	jobTable,
	parseConcurrency,
	parseDuration,
	parseRetries,
	runExitCode,
	runSummary,
	runTable,
	splitCommand,
	type JobRunView,
} from '../jobs.ts';
import { indent, printJson } from '../output.ts';
import { authenticatedClient } from './common.ts';
import { confirmOrRefuse } from './run-operation.ts';

/**
 * Jobs (plan 09): cron jobs and one-off commands on a process or container project. A thin
 * client; every rule (names, cron, limits, permissions) lives on the server.
 */

const usage = `Usage: yoal jobs <command> [options]

Commands:
  list <project>                          List the project's jobs (the default)
  show <project> <job>                    One job and its last run
  create <project> <job> [options] -- <command…>
                                          Define a job; omit --schedule to run it only by hand
  update <project> <job> [options] [-- <command…>]
                                          Change a job (--no-schedule makes it manual only)
  run <project> <job>                     Run it now and stream its output
  runs <project> [job]                    Run history, newest first (--one-off: \`yoal run\` runs only)
  logs <project> <run id>                 A run's output (-f follows a running one)
  cancel <project> <run id>               Cancel a queued run or stop a running one
  pause|resume <project> <job>            Stop or restart the schedule; history is kept
  delete <project> <job>                  Delete a job and its history

Create/update options:
  -s, --schedule '<cron>'                 Five-field cron in UTC, e.g. '*/15 * * * *' or '0 3 * * 1-5'
      --no-schedule                       (update) Remove the schedule; the job stays runnable by hand
  -t, --timeout <duration>                Kill the run after this long: 90s, 15m, 2h (default 10m)
      --concurrency <policy>              When a run is due while the last is going: forbid (default,
                                          records it skipped), allow, or replace (cancels the old one)
      --retries <n>                       Retry a failed or timed-out run up to n times (0–10) with backoff
      --paused                            (create) Start paused

Run/logs options:
  -d, --detach                            (run) Print the run id and return without waiting
  -f, --follow                            (logs) Keep printing until the run finishes

Options:
  -y, --yes                               Don't ask before deleting (required without a terminal)
      --json                              JSON output
  -h, --help                              Show this help

The command after \`--\` is an argv list, never a shell string: arguments are passed exactly as your
shell split them. Use \`-- sh -c '…'\` if you need a shell. Runs use the app's current release, env,
secrets and volumes, on the app's node.

Examples:
  yoal jobs create shop tidy --schedule '0 3 * * *' -- bun scripts/tidy.ts --days 30
  yoal jobs run shop tidy
  yoal jobs runs shop tidy
  yoal jobs update shop tidy --timeout 30m --retries 2
  yoal run shop -- bun run migrate`;

const runUsage = `Usage: yoal run <project> [options] -- <command…>

Run one command once against the project's current release, in the app's sandbox with its env,
secrets and volumes, and stream its output. It is not saved as a job. The exit status is the
command's own (124 for a timeout, 130 when cancelled).

Options:
  -t, --timeout <duration>   Kill it after this long: 90s, 15m, 2h (default 10m)
  -d, --detach               Print the run id and return without waiting
      --json                 Print the finished run as JSON instead of streaming
  -h, --help                 Show this help

Examples:
  yoal run shop -- bun run migrate
  yoal run shop --timeout 1h -- bun scripts/backfill.ts --since 2026-01-01
  yoal run api -- sh -c 'echo $DATABASE_URL | cut -d@ -f2'`;

const baseFlags: FlagSpec = {
	json: { type: 'boolean' },
	help: { type: 'boolean', short: 'h' },
};

const definitionFlags: FlagSpec = {
	...baseFlags,
	schedule: { type: 'string', short: 's' },
	timeout: { type: 'string', short: 't' },
	concurrency: { type: 'string' },
	retries: { type: 'string' },
	paused: { type: 'boolean' },
};

const runFlags: FlagSpec = {
	...baseFlags,
	detach: { type: 'boolean', short: 'd' },
	timeout: { type: 'string', short: 't' },
};

const subcommands: Record<string, (argv: string[]) => Promise<void>> = {
	list: listJobs,
	ls: listJobs,
	show: showJob,
	get: showJob,
	create: createJob,
	add: createJob,
	update: updateJob,
	edit: updateJob,
	run: runJob,
	runs: listRuns,
	history: listRuns,
	logs: runLogs,
	cancel: cancelRun,
	pause: (argv) => setPaused(argv, true),
	resume: (argv) => setPaused(argv, false),
	delete: deleteJob,
	rm: deleteJob,
};

export async function jobsCommand(argv: string[]): Promise<void> {
	const first = argv[0];
	if (!first || first === '--help' || first === '-h' || first === 'help') {
		console.log(usage);
		return;
	}
	const handler = subcommands[first];
	// `yoal jobs <project>` lists, like `yoal logs <project>`.
	if (!handler) {
		if (!first.startsWith('-') && argv.length === 1) return listJobs(argv);
		throw new UsageError(`Unknown jobs command "${first}".\n\n${usage}`);
	}
	await handler(argv.slice(1));
}

/** `yoal run <project> [options] -- <command…>` */
export async function runCommand(argv: string[]): Promise<void> {
	const { before, command } = splitCommand(argv);
	const args = parseArgs(before, runFlags);
	if (args.boolean('help') || argv.length === 0) {
		console.log(runUsage);
		return;
	}
	rejectExtraPositionals(args, 1, runUsage);
	const project = requirePositional(args, 0, `project.\n\n${runUsage}`);
	if (!command || command.length === 0) throw new UsageError(`Give the command after --, e.g. yoal run ${project} -- bun run migrate`);
	const timeout = args.string('timeout');
	const client = await authenticatedClient();
	const { run } = await client.runCommand(project, {
		command,
		...(timeout !== undefined ? { timeoutSeconds: parseDuration(timeout, '--timeout') } : {}),
	});
	await finish(client, project, run, { detach: args.boolean('detach'), json: args.boolean('json') });
}

// ---------------------------------------------------------------- definitions

async function listJobs(argv: string[]): Promise<void> {
	const args = parseArgs(argv, baseFlags);
	if (args.boolean('help')) return void console.log(usage);
	rejectExtraPositionals(args, 1, 'Usage: yoal jobs list <project>');
	const project = requirePositional(args, 0, 'project. Usage: yoal jobs list <project>');
	const { jobs, raw } = await (await authenticatedClient()).listJobs(project);
	if (args.boolean('json')) return printJson(raw);
	if (jobs.length === 0) {
		console.log(`${project} has no jobs. Create one with: yoal jobs create ${project} <name> --schedule '0 3 * * *' -- <command…>`);
		return;
	}
	console.log(jobTable(jobs));
}

async function showJob(argv: string[]): Promise<void> {
	const args = parseArgs(argv, baseFlags);
	if (args.boolean('help')) return void console.log(usage);
	const line = 'Usage: yoal jobs show <project> <job>';
	rejectExtraPositionals(args, 2, line);
	const project = requirePositional(args, 0, `project. ${line}`);
	const name = requirePositional(args, 1, `job name. ${line}`);
	const { job, raw } = await (await authenticatedClient()).getJob(project, name);
	if (args.boolean('json')) return printJson(raw);
	console.log(jobDetails(job).join('\n'));
}

function definitionInput(args: ReturnType<typeof parseArgs>): Record<string, unknown> {
	const input: Record<string, unknown> = {};
	const schedule = args.string('schedule');
	if (schedule !== undefined) {
		if (schedule.trim().split(/\s+/).length !== 5)
			throw new UsageError(`--schedule takes a five-field cron in UTC; quote it so the shell passes it as one argument, e.g. --schedule '*/15 * * * *'.`);
		input.schedule = schedule;
	}
	const timeout = args.string('timeout');
	if (timeout !== undefined) input.timeoutSeconds = parseDuration(timeout, '--timeout');
	const concurrency = args.string('concurrency');
	if (concurrency !== undefined) input.concurrency = parseConcurrency(concurrency);
	const retries = args.string('retries');
	if (retries !== undefined) input.maxRetries = parseRetries(retries);
	return input;
}

async function createJob(argv: string[]): Promise<void> {
	const { before, command } = splitCommand(argv);
	const args = parseArgs(before, definitionFlags);
	if (args.boolean('help')) return void console.log(usage);
	const line = "Usage: yoal jobs create <project> <job> [--schedule '<cron>'] -- <command…>";
	if (args.positionals.length > 2)
		throw new UsageError(`Put the command after --, and quote the schedule.\n\n${line}`);
	const project = requirePositional(args, 0, `project. ${line}`);
	const name = requirePositional(args, 1, `job name. ${line}`);
	if (!command || command.length === 0) throw new UsageError(`Give the command after --.\n\n${line}`);
	const input = { name, command, ...definitionInput(args), ...(args.boolean('paused') ? { enabled: false } : {}) };
	const { job, raw } = await (await authenticatedClient()).createJob(project, input);
	if (args.boolean('json')) return printJson(raw);
	console.log(`Created job ${job.name} on ${project}.`);
	console.log(indent(jobDetails(job)));
	if (!job.schedule) console.log(`\nRun it with: yoal jobs run ${project} ${job.name}`);
}

async function updateJob(argv: string[]): Promise<void> {
	const { before, command } = splitCommand(argv);
	const args = parseArgs(before, { ...definitionFlags, 'no-schedule': { type: 'boolean' } });
	if (args.boolean('help')) return void console.log(usage);
	const line = 'Usage: yoal jobs update <project> <job> [options] [-- <command…>]';
	rejectExtraPositionals(args, 2, line);
	const project = requirePositional(args, 0, `project. ${line}`);
	const name = requirePositional(args, 1, `job name. ${line}`);
	const input = definitionInput(args);
	if (args.boolean('no-schedule')) {
		if (input.schedule !== undefined) throw new UsageError('Use --schedule or --no-schedule, not both.');
		input.schedule = null;
	}
	if (args.boolean('paused')) input.enabled = false;
	if (command) {
		if (command.length === 0) throw new UsageError('Give the new command after --.');
		input.command = command;
	}
	if (Object.keys(input).length === 0) throw new UsageError(`Nothing to update.\n\n${line}`);
	const { job, raw } = await (await authenticatedClient()).updateJob(project, name, input);
	if (args.boolean('json')) return printJson(raw);
	console.log(`Updated job ${job.name}.`);
	console.log(indent(jobDetails(job)));
}

async function setPaused(argv: string[], paused: boolean): Promise<void> {
	const args = parseArgs(argv, baseFlags);
	if (args.boolean('help')) return void console.log(usage);
	const line = `Usage: yoal jobs ${paused ? 'pause' : 'resume'} <project> <job>`;
	rejectExtraPositionals(args, 2, line);
	const project = requirePositional(args, 0, `project. ${line}`);
	const name = requirePositional(args, 1, `job name. ${line}`);
	const { job, raw } = await (await authenticatedClient()).setJobPaused(project, name, paused);
	if (args.boolean('json')) return printJson(raw);
	console.log(paused ? `Paused ${job.name}; it can still be run by hand.` : `Resumed ${job.name}; next run ${job.nextRunAt ?? '(manual only)'}.`);
}

async function deleteJob(argv: string[]): Promise<void> {
	const args = parseArgs(argv, { ...baseFlags, yes: { type: 'boolean', short: 'y' } });
	if (args.boolean('help')) return void console.log(usage);
	const line = 'Usage: yoal jobs delete <project> <job> [--yes]';
	rejectExtraPositionals(args, 2, line);
	const project = requirePositional(args, 0, `project. ${line}`);
	const name = requirePositional(args, 1, `job name. ${line}`);
	const confirmed = await confirmOrRefuse(`Delete job ${name} from ${project}, with its run history? [y/N] `, {
		yes: args.boolean('yes'),
		refusal: `Refusing to delete job ${name} without confirmation.`,
	});
	if (!confirmed) {
		console.log('Cancelled.');
		return;
	}
	const raw = await (await authenticatedClient()).deleteJob(project, name);
	if (args.boolean('json')) return printJson(raw);
	console.log(`Deleted job ${name}.`);
}

// ---------------------------------------------------------------- runs

async function runJob(argv: string[]): Promise<void> {
	const args = parseArgs(argv, runFlags);
	if (args.boolean('help')) return void console.log(usage);
	const line = 'Usage: yoal jobs run <project> <job> [--detach]';
	rejectExtraPositionals(args, 2, line);
	const project = requirePositional(args, 0, `project. ${line}`);
	const name = requirePositional(args, 1, `job name. ${line}`);
	const client = await authenticatedClient();
	const { run } = await client.runJob(project, name);
	await finish(client, project, run, { detach: args.boolean('detach'), json: args.boolean('json') });
}

async function listRuns(argv: string[]): Promise<void> {
	const args = parseArgs(argv, { ...baseFlags, 'one-off': { type: 'boolean' }, limit: { type: 'string', short: 'n' } });
	if (args.boolean('help')) return void console.log(usage);
	const line = 'Usage: yoal jobs runs <project> [job] [--one-off] [-n <limit>]';
	rejectExtraPositionals(args, 2, line);
	const project = requirePositional(args, 0, `project. ${line}`);
	const job = args.positionals[1];
	const limit = args.string('limit') ? Number(args.string('limit')) : 20;
	if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new UsageError('--limit must be from 1 to 200.');
	const { runs, raw } = await (await authenticatedClient()).listJobRuns(project, { ...(job ? { job } : {}), oneOff: args.boolean('one-off'), limit });
	if (args.boolean('json')) return printJson(raw);
	if (runs.length === 0) return void console.log('No runs yet.');
	console.log(runTable(runs));
}

async function runLogs(argv: string[]): Promise<void> {
	const args = parseArgs(argv, { ...baseFlags, follow: { type: 'boolean', short: 'f' } });
	if (args.boolean('help')) return void console.log(usage);
	const line = 'Usage: yoal jobs logs <project> <run id> [-f]';
	rejectExtraPositionals(args, 2, line);
	const project = requirePositional(args, 0, `project. ${line}`);
	const runId = requirePositional(args, 1, `run id (jr_…; see yoal jobs runs). ${line}`);
	const client = await authenticatedClient();
	if (args.boolean('json')) return printJson(await client.jobRunLogs(project, runId, { limit: 2000 }));
	if (!args.boolean('follow')) {
		const page = await client.jobRunLogs(project, runId, { limit: 2000 });
		for (const event of page.events) printLine(event);
		return;
	}
	const { run } = await client.getJobRun(project, runId);
	const done = await follow(client, project, run);
	console.error(runSummary(done));
	process.exitCode = runExitCode(done);
}

async function cancelRun(argv: string[]): Promise<void> {
	const args = parseArgs(argv, baseFlags);
	if (args.boolean('help')) return void console.log(usage);
	const line = 'Usage: yoal jobs cancel <project> <run id>';
	rejectExtraPositionals(args, 2, line);
	const project = requirePositional(args, 0, `project. ${line}`);
	const runId = requirePositional(args, 1, `run id. ${line}`);
	const { run, raw } = await (await authenticatedClient()).cancelJobRun(project, runId);
	if (args.boolean('json')) return printJson(raw);
	console.log(jobRunDone(run.status) ? `Run ${run.id} is ${run.status}.` : `Stopping run ${run.id}; the node sends SIGTERM, then SIGKILL after 30 s.`);
}

// ---------------------------------------------------------------- following

/** Stream a run's output until it finishes (or detach), then exit with its status. */
async function finish(client: ApiClient, project: string, run: JobRunView, options: { detach: boolean; json: boolean }): Promise<void> {
	if (options.detach) {
		if (options.json) return printJson({ run });
		console.log(run.id);
		console.error(`Queued. Follow it with: yoal jobs logs ${project} ${run.id} -f`);
		return;
	}
	const done = options.json ? await waitFor(client, project, run) : await follow(client, project, run);
	if (options.json) printJson({ run: done });
	else console.error(runSummary(done));
	process.exitCode = runExitCode(done);
}

async function waitFor(client: ApiClient, project: string, run: JobRunView): Promise<JobRunView> {
	let current = run;
	while (!jobRunDone(current.status)) current = (await client.getJobRun(project, run.id, { waitSeconds: 20 })).run;
	return current;
}

/** Print new lines every second; the agent drains a run's last lines before it reports the exit. */
export async function follow(client: ApiClient, project: string, run: JobRunView, sleep = (ms: number) => Bun.sleep(ms)): Promise<JobRunView> {
	let cursor: number | undefined;
	let current = run;
	let announced = false;
	for (;;) {
		const page = await client.jobRunLogs(project, run.id, cursor === undefined ? { limit: 2000 } : { after: cursor, limit: 2000 });
		for (const event of page.events) printLine(event);
		cursor = page.cursor;
		if (jobRunDone(current.status) && !page.hasMore) return current;
		if (!announced && current.status === 'queued') {
			console.error(`Waiting for the node to start ${run.id}…`);
			announced = true;
		}
		if (!page.hasMore) {
			await sleep(1000);
			current = (await client.getJobRun(project, run.id)).run;
		}
	}
}

function printLine(event: { stream: string; message: string }): void {
	if (event.stream === 'stderr') process.stderr.write(`${event.message}\n`);
	else process.stdout.write(`${event.message}\n`);
}
