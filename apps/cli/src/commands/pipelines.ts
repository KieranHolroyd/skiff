import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs, rejectExtraPositionals, requirePositional, type FlagSpec, type ParsedArgs } from '../args.ts';
import { CliError, UsageError } from '../errors.ts';
import { indent, printJson } from '../output.ts';
import {
	PipelinesApi,
	assertVariableName,
	bunYaml,
	formatImportNotes,
	formatIssues,
	importGithubWorkflow,
	lintDocument,
	formatLogLine,
	isFailed,
	lintWorkflow,
	parseInputs,
	parseLimit,
	repositoryDetails,
	repositoryTable,
	runDetails,
	runExitCode,
	runTable,
	runTransitions,
	secretTable,
	selectJob,
	statusFilter,
	statusLabel,
	toYaml,
	variableTable,
	workflowPath,
	type PipelineJobView,
	type PipelineTriggerView,
	type RunView,
} from '../pipelines.ts';
import { promptText, readAllStdin } from '../prompt.ts';
import { authenticatedClient } from './common.ts';
import { runCommand as jobRunCommand } from './jobs.ts';
import { confirmOrRefuse } from './run-operation.ts';

/**
 * Pipelines (docs/PIPELINES.md §8): `skif repo`, `skif run`, `skif workflow`, `skif secret` and
 * `skif var`. A thin client over `/api/v1/repositories`; the server owns every rule.
 */

const POLL_MS = 2_000;
const LOG_PAGE = 1_000;

export interface PollDeps {
	sleep: (ms: number) => Promise<void>;
	print: (line: string) => void;
}

const defaultDeps: PollDeps = {
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	print: (line) => console.log(line),
};

async function api(): Promise<PipelinesApi> {
	return new PipelinesApi(await authenticatedClient());
}

const baseFlags: FlagSpec = {
	json: { type: 'boolean' },
	help: { type: 'boolean', short: 'h' },
};

function dispatchTable(argv: string[], usage: string, table: Record<string, (argv: string[]) => Promise<void>>, fallback?: string): Promise<void> {
	const first = argv[0];
	if (!first || first === '--help' || first === '-h' || first === 'help') {
		if (!first && fallback) return table[fallback]!([]);
		console.log(usage);
		return Promise.resolve();
	}
	const handler = table[first];
	if (!handler) throw new UsageError(`Unknown command "${first}".\n\n${usage}`);
	return handler(argv.slice(1));
}

function parse(argv: string[], spec: FlagSpec, usage: string): ParsedArgs | null {
	const args = parseArgs(argv, { ...baseFlags, ...spec });
	if (args.boolean('help')) {
		console.log(usage);
		return null;
	}
	return args;
}

// ================================================================ skif repo

const repoUsage = `Usage: skif repo <command> [options]

Commands:
  list                          Repositories with their last run (the default)
  show <name>                   Clone URL, branch, webhook URL and last run
  add <name> --url <clone-url>  Connect a git repository
  remove <name> --yes           Delete it with its runs, secrets and variables

Add options:
      --url <clone-url>         https:// or ssh:// (git@…) URL the build nodes clone
      --branch <branch>         Default branch (default main)
      --provider <provider>     github (default) or generic
      --webhook-secret <s>      GitHub webhook secret (at least 16 characters)
      --image <image>           Default job image for container isolation

Options:
  -y, --yes                     Don't ask before removing (required without a terminal)
      --json                    JSON output
  -h, --help                    Show this help

Workflows live in .skiff/workflows/*.yml in the repository (GitHub Actions syntax).`;

export async function repoCommand(argv: string[]): Promise<void> {
	return dispatchTable(argv, repoUsage, { list: repoList, ls: repoList, show: repoShow, get: repoShow, add: repoAdd, create: repoAdd, remove: repoRemove, rm: repoRemove, delete: repoRemove }, 'list');
}

async function repoList(argv: string[]): Promise<void> {
	const args = parse(argv, {}, repoUsage);
	if (!args) return;
	rejectExtraPositionals(args, 0, 'Usage: skif repo list');
	const raw = await (await api()).listRepositories();
	if (args.boolean('json')) return printJson(raw);
	if (raw.repositories.length === 0) return void console.log('No repositories yet. Connect one with: skif repo add <name> --url <clone-url>');
	console.log(repositoryTable(raw.repositories));
}

async function repoShow(argv: string[]): Promise<void> {
	const args = parse(argv, {}, repoUsage);
	if (!args) return;
	rejectExtraPositionals(args, 1, 'Usage: skif repo show <name>');
	const name = requirePositional(args, 0, 'repository. Usage: skif repo show <name>');
	const client = await api();
	const raw = await client.getRepository(name);
	if (args.boolean('json')) return printJson(raw);
	console.log(repositoryDetails(raw.repository, client.baseUrl).join('\n'));
}

async function repoAdd(argv: string[]): Promise<void> {
	const line = 'Usage: skif repo add <name> --url <clone-url> [--branch main] [--provider github|generic] [--webhook-secret <s>] [--image <img>]';
	const args = parse(
		argv,
		{ url: { type: 'string' }, branch: { type: 'string' }, provider: { type: 'string' }, 'webhook-secret': { type: 'string' }, image: { type: 'string' } },
		repoUsage,
	);
	if (!args) return;
	rejectExtraPositionals(args, 1, line);
	const name = requirePositional(args, 0, `repository name. ${line}`);
	const url = args.string('url');
	if (!url) throw new UsageError(`--url is required.\n\n${line}`);
	const provider = args.string('provider');
	if (provider !== undefined && provider !== 'github' && provider !== 'generic') throw new UsageError('--provider must be github or generic.');
	const secret = args.string('webhook-secret');
	if (secret !== undefined && secret.length < 16) throw new UsageError('--webhook-secret must be at least 16 characters.');
	const input: Record<string, unknown> = { name, cloneUrl: url };
	if (provider) input.provider = provider;
	if (args.string('branch')) input.defaultBranch = args.string('branch');
	if (secret) input.webhookSecret = secret;
	if (args.string('image')) input.defaultImage = args.string('image');
	const client = await api();
	const raw = await client.createRepository(input);
	if (args.boolean('json')) return printJson(raw);
	console.log(`Connected ${raw.repository.name}.`);
	console.log(indent(repositoryDetails(raw.repository, client.baseUrl)));
	const next = [`Run a workflow:  skif workflow dispatch ${name} ci.yml`];
	if (raw.repository.provider === 'github')
		next.unshift(`Webhook:         add ${client.baseUrl}${raw.repository.webhookPath} to the GitHub repository (push and pull_request events)`);
	console.log(`\nNext steps:\n${indent(next)}`);
}

async function repoRemove(argv: string[]): Promise<void> {
	const args = parse(argv, { yes: { type: 'boolean', short: 'y' } }, repoUsage);
	if (!args) return;
	const line = 'Usage: skif repo remove <name> --yes';
	rejectExtraPositionals(args, 1, line);
	const name = requirePositional(args, 0, `repository. ${line}`);
	const confirmed = await confirmOrRefuse(`Remove repository ${name} with its runs, logs, artifacts, secrets and variables? [y/N] `, {
		yes: args.boolean('yes'),
		refusal: `Refusing to remove repository ${name} without confirmation.`,
	});
	if (!confirmed) return void console.log('Cancelled.');
	const raw = await (await api()).deleteRepository(name);
	if (args.boolean('json')) return printJson(raw);
	console.log(`Removed ${name}.`);
}

// ================================================================ skif run

const runUsage = `Usage: skif run <command> <repo> [run] [options]

Pipeline runs (<run> is a run number like 42 or #42, or a run id):
  list <repo>                  Runs, newest first (--status, --workflow, --limit)
  view <repo> <run>            Jobs and steps (the failing step marked) and artifacts
  watch <repo> <run>           Follow a run until it finishes; exits 1 unless it succeeded
  logs <repo> <run>            One job's log (--job <key|id>; default: the first failed job,
                               else the last); -f follows it until the job finishes
  cancel <repo> <run>          Cancel a queued or running run
  rerun <repo> <run>           Run it again (--failed: only failed jobs and their dependents)

Options:
      --status <status>        (list) queued, in_progress, completed, or a conclusion
                               (success, failure, cancelled, skipped, timed_out)
      --workflow <file>        (list) ci.yml or .skiff/workflows/ci.yml
  -n, --limit <n>              (list) At most n runs (default 20, max 100)
      --job <key|id>           (logs) Which job
  -f, --follow                 (logs) Keep printing until the job finishes
      --failed                 (rerun) Only failed jobs
      --watch                  (rerun) Watch the new attempt
      --json                   JSON output
  -h, --help                   Show this help

\`skif run <project> -- <command…>\` still runs a one-off command on an app (skif run <project> --help).`;

const RUN_SUBCOMMANDS: Record<string, (argv: string[]) => Promise<void>> = {
	list: runList,
	ls: runList,
	view: runView,
	show: runView,
	watch: runWatch,
	logs: runLogs,
	log: runLogs,
	cancel: runCancel,
	rerun: runRerun,
};

/**
 * `skif run` is shared: `skif run <subcommand> <repo> …` is a pipeline run, `skif run <project> --
 * <command…>` (anything with `--`) is a one-off job run (plan 09).
 */
export async function runOrPipelineCommand(argv: string[]): Promise<void> {
	const first = argv[0];
	if (!first || ((first === '--help' || first === '-h' || first === 'help') && argv.length === 1)) {
		console.log(runUsage);
		return;
	}
	const handler = RUN_SUBCOMMANDS[first];
	if (handler && !argv.includes('--')) return handler(argv.slice(1));
	return jobRunCommand(argv);
}

function runRef(value: string): string {
	return value.replace(/^#/, '');
}

async function runList(argv: string[]): Promise<void> {
	const args = parse(argv, { status: { type: 'string' }, workflow: { type: 'string' }, limit: { type: 'string', short: 'n' }, ref: { type: 'string' } }, runUsage);
	if (!args) return;
	const line = 'Usage: skif run list <repo> [--status s] [--workflow w] [--limit n]';
	rejectExtraPositionals(args, 1, line);
	const repo = requirePositional(args, 0, `repository. ${line}`);
	const filter = statusFilter(args.string('status'));
	const limit = parseLimit(args.string('limit'), 20);
	const workflow = args.string('workflow');
	const raw = await (await api()).listRuns(repo, {
		...(filter.status ? { status: filter.status } : {}),
		...(workflow ? { workflow: workflowPath(workflow) } : {}),
		...(args.string('ref') ? { ref: args.string('ref') } : {}),
		// A conclusion is filtered here, so ask for a full page to filter from.
		limit: filter.conclusion ? 100 : limit,
	});
	const runs = filter.conclusion ? raw.runs.filter((run) => run.conclusion === filter.conclusion).slice(0, limit) : raw.runs;
	if (args.boolean('json')) return printJson({ runs });
	if (runs.length === 0) return void console.log('No runs.');
	console.log(runTable(runs));
}

async function runView(argv: string[]): Promise<void> {
	const args = parse(argv, {}, runUsage);
	if (!args) return;
	const line = 'Usage: skif run view <repo> <run>';
	rejectExtraPositionals(args, 2, line);
	const repo = requirePositional(args, 0, `repository. ${line}`);
	const ref = runRef(requirePositional(args, 1, `run. ${line}`));
	const raw = await (await api()).getRun(repo, ref);
	if (args.boolean('json')) return printJson(raw);
	console.log(runDetails(raw.run).join('\n'));
}

async function runWatch(argv: string[]): Promise<void> {
	const args = parse(argv, {}, runUsage);
	if (!args) return;
	const line = 'Usage: skif run watch <repo> <run>';
	rejectExtraPositionals(args, 2, line);
	const repo = requirePositional(args, 0, `repository. ${line}`);
	const ref = runRef(requirePositional(args, 1, `run. ${line}`));
	await watchAndExit(await api(), repo, ref, args.boolean('json'));
}

async function watchAndExit(client: PipelinesApi, repo: string, ref: string, json: boolean, deps: PollDeps = defaultDeps): Promise<void> {
	const run = await watchRun(client, repo, ref, json ? { ...deps, print: () => {} } : deps);
	if (json) printJson({ run });
	else {
		const failed = run.jobs.find(isFailed);
		if (failed && runExitCode(run) !== 0) console.error(`See the log: skif run logs ${repo} ${run.number} --job ${failed.id}`);
	}
	process.exitCode = runExitCode(run);
}

/** Poll a run every 2 s, printing job and step transitions, until it completes. */
export async function watchRun(client: PipelinesApi, repo: string, ref: string, deps: PollDeps = defaultDeps): Promise<RunView> {
	let prev: RunView | null = null;
	let id = ref;
	for (;;) {
		const { run } = await client.getRun(repo, id);
		if (!prev) {
			id = run.id;
			deps.print(`Run #${run.number} ${run.workflowName} (${run.title}): ${statusLabel(run)}`);
		}
		for (const line of runTransitions(prev, run)) deps.print(line);
		if (run.status === 'completed') {
			if (!prev) deps.print(`Run #${run.number} ${statusLabel(run)}.`);
			return run;
		}
		prev = run;
		await deps.sleep(POLL_MS);
	}
}

async function runLogs(argv: string[]): Promise<void> {
	const args = parse(argv, { job: { type: 'string' }, follow: { type: 'boolean', short: 'f' } }, runUsage);
	if (!args) return;
	const line = 'Usage: skif run logs <repo> <run> [--job <key|id>] [-f]';
	rejectExtraPositionals(args, 2, line);
	const repo = requirePositional(args, 0, `repository. ${line}`);
	const ref = runRef(requirePositional(args, 1, `run. ${line}`));
	const client = await api();
	const { run } = await client.getRun(repo, ref);
	const job = selectJob(run, args.string('job'));
	if (args.boolean('json')) {
		const lines = [];
		let after = 0;
		for (;;) {
			const page = await client.jobLogs(repo, run.id, job.id, { after, limit: LOG_PAGE });
			lines.push(...page.lines);
			after = page.next;
			if (page.lines.length < LOG_PAGE) return printJson({ job: { id: job.id, key: job.key, name: job.name, status: job.status, conclusion: job.conclusion }, lines, complete: page.complete });
		}
	}
	console.error(`${job.name} (${statusLabel(job)}) — run #${run.number}`);
	const done = await printJobLogs(client, repo, run.id, job, { follow: args.boolean('follow') });
	if (args.boolean('follow') && isFailed(done)) process.exitCode = 1;
}

/** Print a job's log from the start; with `follow`, keep polling (`after=` cursor) until the job completes. */
export async function printJobLogs(
	client: PipelinesApi,
	repo: string,
	runId: string,
	job: PipelineJobView,
	options: { follow: boolean },
	deps: PollDeps = defaultDeps,
): Promise<PipelineJobView> {
	let after = 0;
	let current = job;
	for (;;) {
		const page = await client.jobLogs(repo, runId, job.id, { after, limit: LOG_PAGE });
		for (const entry of page.lines) deps.print(formatLogLine(current, entry));
		after = page.next;
		if (page.lines.length >= LOG_PAGE) continue;
		if (!options.follow || page.complete) {
			if (page.complete && current.status !== 'completed') current = await refreshJob(client, repo, runId, current);
			return current;
		}
		await deps.sleep(POLL_MS);
		// Step names are resolved as steps start; refresh them for the prefixes.
		current = await refreshJob(client, repo, runId, current);
	}
}

async function refreshJob(client: PipelinesApi, repo: string, runId: string, job: PipelineJobView): Promise<PipelineJobView> {
	const { run } = await client.getRun(repo, runId);
	return run.jobs.find((entry) => entry.id === job.id) ?? job;
}

async function runCancel(argv: string[]): Promise<void> {
	const args = parse(argv, {}, runUsage);
	if (!args) return;
	const line = 'Usage: skif run cancel <repo> <run>';
	rejectExtraPositionals(args, 2, line);
	const repo = requirePositional(args, 0, `repository. ${line}`);
	const ref = runRef(requirePositional(args, 1, `run. ${line}`));
	const raw = await (await api()).cancelRun(repo, ref);
	if (args.boolean('json')) return printJson(raw);
	console.log(`Cancelling run #${raw.run.number}; running jobs stop after their always() steps.`);
}

async function runRerun(argv: string[]): Promise<void> {
	const args = parse(argv, { failed: { type: 'boolean' }, watch: { type: 'boolean', short: 'w' } }, runUsage);
	if (!args) return;
	const line = 'Usage: skif run rerun <repo> <run> [--failed] [--watch]';
	rejectExtraPositionals(args, 2, line);
	const repo = requirePositional(args, 0, `repository. ${line}`);
	const ref = runRef(requirePositional(args, 1, `run. ${line}`));
	const client = await api();
	const raw = await client.rerun(repo, ref, args.boolean('failed'));
	if (args.boolean('watch')) return watchAndExit(client, repo, raw.run.id, args.boolean('json'));
	if (args.boolean('json')) return printJson(raw);
	console.log(`Re-running ${args.boolean('failed') ? 'failed jobs of ' : ''}run #${raw.run.number} (attempt ${raw.run.attempt}).`);
	console.log(`Watch it: skif run watch ${repo} ${raw.run.number}`);
}

// ================================================================ skif workflow

const workflowUsage = `Usage: skif workflow <command> [options]

Commands:
  dispatch <repo> <workflow>   Run a workflow with a workflow_dispatch trigger (ci.yml or
                               .skiff/workflows/ci.yml) at --ref (default: the default branch)
  run <repo> --file <file.yml> Run a local workflow file against --ref without committing it
  run --local <file.yml>       Run the workflow's jobs on this machine, no control plane
                               (needs Bun or the standalone binary)
  lint <file.yml>              Check a workflow locally with the platform's parser
  lint --import <gh.yml>       Convert a .github/workflows file to Skiff and list what does not
                               carry over (--out writes the converted file)

Dispatch/run options:
      --ref <ref>              Branch, tag or sha (default: the repository's default branch)
  -f, --field <key=value>      A workflow_dispatch input; repeat for more
      --file <path>            (run) The workflow file to send
  -w, --watch                  Wait for the run to start and watch it; exits 1 unless it succeeded
      --json                   JSON output
  -h, --help                   Show this help

Local run options (run --local):
  -j, --job <id>               Only this job (its needs count as succeeded, with no outputs)
  -f, --field <key=value>      A workflow_dispatch input; repeat for more
      --secret <NAME[=VALUE]>  A secret (without =VALUE, read from $NAME); repeat for more
      --var <NAME=VALUE>       A variable (vars.NAME); repeat for more
      --matrix <key=value>     Only matrix combinations with this value; repeat for more
      --event <name>           skiff.event_name (default workflow_dispatch)
      --copy                   Run in a temporary copy of this directory
  Steps run directly here (container:/services: are not started); artifacts and caches are
  kept under .skiff/local/. skiff/deploy and skiff/oidc-token need a control plane.

Lint options:
      --import <gh.yml>        The GitHub workflow to convert
      --out <file>             Write the converted workflow here (default: print it)

Examples:
  skif workflow dispatch shop deploy.yml --ref main -f environment=staging --watch
  skif workflow run shop --file .skiff/workflows/ci.yml --ref my-branch --watch
  skif workflow run --local .skiff/workflows/ci.yml -j test --secret NPM_TOKEN
  skif workflow lint .skiff/workflows/ci.yml
  skif workflow lint --import .github/workflows/ci.yml --out .skiff/workflows/ci.yml`;

const dispatchFlags: FlagSpec = {
	ref: { type: 'string' },
	field: { type: 'string', short: 'f', multiple: true },
	watch: { type: 'boolean', short: 'w' },
};

export async function workflowCommand(argv: string[]): Promise<void> {
	return dispatchTable(argv, workflowUsage, { dispatch: workflowDispatch, run: workflowRun, lint: workflowLint });
}

async function workflowDispatch(argv: string[]): Promise<void> {
	const args = parse(argv, dispatchFlags, workflowUsage);
	if (!args) return;
	const line = 'Usage: skif workflow dispatch <repo> <workflow> [--ref r] [-f key=value …] [--watch]';
	rejectExtraPositionals(args, 2, line);
	const repo = requirePositional(args, 0, `repository. ${line}`);
	const workflow = requirePositional(args, 1, `workflow file (e.g. ci.yml). ${line}`);
	await startDispatch(repo, { workflow }, args);
}

const localFlags: FlagSpec = {
	local: { type: 'string' },
	job: { type: 'string', short: 'j' },
	secret: { type: 'string', multiple: true },
	var: { type: 'string', multiple: true },
	matrix: { type: 'string', multiple: true },
	event: { type: 'string' },
	copy: { type: 'boolean' },
};

/** `NAME=VALUE` pairs; with `fromEnv`, a bare `NAME` reads `$NAME`. */
export function parsePairs(pairs: string[], flag: string, fromEnv = false, env: Record<string, string | undefined> = process.env): Record<string, string> {
	const out: Record<string, string> = {};
	for (const pair of pairs) {
		const equals = pair.indexOf('=');
		if (equals < 0 && fromEnv) {
			const value = env[pair];
			if (value === undefined) throw new UsageError(`--${flag} ${pair}: $${pair} is not set (use --${flag} ${pair}=VALUE).`);
			out[pair] = value;
			continue;
		}
		if (equals <= 0) throw new UsageError(`--${flag} takes NAME=VALUE, got "${pair}".`);
		out[pair.slice(0, equals)] = pair.slice(equals + 1);
	}
	return out;
}

async function workflowRunLocal(args: ParsedArgs, file: string): Promise<void> {
	rejectExtraPositionals(args, 0, 'Usage: skif workflow run --local <file.yml> [-j job] [-f k=v] [--secret NAME[=VALUE]] [--copy]');
	const { runLocalWorkflow } = await import('../pipelines-local.ts');
	const json = args.boolean('json');
	const result = await runLocalWorkflow({
		file,
		cwd: process.cwd(),
		job: args.string('job'),
		inputs: parseInputs(args.strings('field')),
		secrets: parsePairs(args.strings('secret'), 'secret', true),
		vars: parsePairs(args.strings('var'), 'var'),
		matrix: parsePairs(args.strings('matrix'), 'matrix'),
		event: args.string('event'),
		copy: args.boolean('copy'),
		print: json ? (line) => console.error(line) : (line) => console.log(line),
	});
	if (json) printJson(result);
	if (!result.ok) process.exitCode = 1;
}

async function workflowRun(argv: string[]): Promise<void> {
	const args = parse(argv, { ...dispatchFlags, file: { type: 'string' }, ...localFlags }, workflowUsage);
	if (!args) return;
	const local = args.string('local');
	if (local !== undefined) return workflowRunLocal(args, local);
	const line = 'Usage: skif workflow run <repo> --file <local.yml> [--ref r] [-f key=value …] [--watch]';
	rejectExtraPositionals(args, 1, line);
	const repo = requirePositional(args, 0, `repository. ${line}`);
	const file = args.string('file');
	if (!file) throw new UsageError(`--file is required.\n\n${line}`);
	const workflowText = await readText(file);
	await startDispatch(repo, { workflowText }, args);
}

async function startDispatch(repo: string, target: { workflow?: string; workflowText?: string }, args: ParsedArgs): Promise<void> {
	const inputs = parseInputs(args.strings('field'));
	const ref = args.string('ref');
	const client = await api();
	const raw = await client.dispatch(repo, { ...target, ...(ref ? { ref } : {}), inputs });
	const json = args.boolean('json');
	if (!args.boolean('watch')) {
		if (json) return printJson(raw);
		console.log(raw.trigger.id);
		console.error(`Dispatched on ${raw.trigger.ref}. A build node reads the workflow, then the run starts; see skif run list ${repo}.`);
		return;
	}
	const trigger = await waitForTrigger(client, repo, raw.trigger, json ? { ...defaultDeps, print: () => {} } : { ...defaultDeps, print: (text) => console.error(text) });
	const [first, ...others] = trigger.runIds;
	if (others.length > 0 && !json) console.error(`Started ${trigger.runIds.length} runs; watching the first. Others: ${others.join(', ')}`);
	await watchAndExit(client, repo, first!, json);
}

/** Poll a trigger until a build node has read the workflow and runs exist; throw if it failed or matched nothing. */
export async function waitForTrigger(client: PipelinesApi, repo: string, trigger: PipelineTriggerView, deps: PollDeps = defaultDeps): Promise<PipelineTriggerView> {
	let current = trigger;
	let announced = false;
	for (;;) {
		if (current.status === 'failed') throw new CliError(`The workflow did not start: ${current.error ?? 'unknown error'}`, { code: 'dispatch_failed' });
		if (current.runIds.length > 0) return current;
		if (current.status === 'resolved')
			throw new CliError(current.error ?? 'No run started: the workflow has no workflow_dispatch trigger, or it does not match this ref.', { code: 'no_runs' });
		if (!announced) {
			deps.print('Waiting for a build node to read the workflow…');
			announced = true;
		}
		await deps.sleep(POLL_MS);
		current = (await client.getTrigger(repo, current.id)).trigger;
	}
}

async function workflowLint(argv: string[]): Promise<void> {
	const args = parse(argv, { import: { type: 'string' }, out: { type: 'string' } }, workflowUsage);
	if (!args) return;
	const source = args.string('import');
	if (source !== undefined) return workflowImport(args, source);
	const line = 'Usage: skif workflow lint <file.yml>';
	rejectExtraPositionals(args, 1, line);
	const file = requirePositional(args, 0, `workflow file. ${line}`);
	const result = await lintWorkflow(await readText(file), file);
	if (args.boolean('json')) printJson({ file, ...result });
	else if (result.ok) console.log(`${file}: ok — "${result.name}", ${result.jobs!.length} job${result.jobs!.length === 1 ? '' : 's'} (${result.jobs!.join(', ')})`);
	else console.error(formatIssues(file, result.issues).join('\n'));
	if (!result.ok) process.exitCode = 1;
}

/** `skif workflow lint --import`: convert a GitHub workflow, list what changed, lint the result. */
async function workflowImport(args: ParsedArgs, source: string): Promise<void> {
	rejectExtraPositionals(args, 0, 'Usage: skif workflow lint --import <.github/workflows/x.yml> [--out <file>]');
	const yaml = bunYaml('skif workflow lint --import');
	const raw = await readText(source);
	let doc: unknown;
	try {
		doc = yaml.parse(raw);
	} catch (error) {
		throw new CliError(`${source}: YAML: ${(error as Error).message}`);
	}
	const { workflow, notes } = importGithubWorkflow(doc);
	const out = args.string('out');
	const target = out ?? `.skiff/workflows/${source.split('/').pop()}`;
	const text = `# Imported from ${source} by skif workflow lint --import; review the notes it printed.\n${toYaml(workflow)}\n`;
	const result = await lintDocument(yaml.parse(text), target);
	if (out) await writeFile(out, text);
	if (args.boolean('json')) {
		printJson({ source, out: out ?? null, ok: result.ok, notes, issues: result.issues, ...(out ? {} : { workflow: text }) });
	} else {
		if (!out) process.stdout.write(text);
		const lines = formatImportNotes(source, notes);
		if (lines.length) console.error(lines.join('\n'));
		if (!result.ok) console.error(formatIssues(target, result.issues).join('\n'));
		const unsupported = notes.filter((entry) => entry.kind === 'unsupported').length;
		console.error(
			`${out ? `Wrote ${out}. ` : ''}${notes.length} note${notes.length === 1 ? '' : 's'} (${unsupported} unsupported); ` +
				(result.ok ? 'the converted workflow passes the parser.' : `${result.issues.length} parser issue${result.issues.length === 1 ? '' : 's'} left to fix.`),
		);
	}
	if (!result.ok) process.exitCode = 1;
}

async function readText(file: string): Promise<string> {
	try {
		return await readFile(file, 'utf8');
	} catch (error) {
		throw new CliError(`Could not read ${file}: ${(error as Error).message}`);
	}
}

// ================================================================ skif secret / skif var

const secretUsage = `Usage: skif secret <command> <repo> [options]

Commands:
  list <repo>                  Secret names and scopes (values are never shown)
  set <repo> <NAME>            Create or replace a secret: --value, or piped on stdin, or
                               typed at a hidden prompt
  rm <repo> <NAME>             Delete a secret (--env for an environment-scoped one)

Options:
      --env <environment>      Scope the secret to jobs in this environment only
      --value <value>          The value (prefer stdin: it stays out of shell history)
      --json                   JSON output
  -h, --help                   Show this help

Workflows read secrets as \${{ secrets.NAME }}. Runs from forks never get them.`;

export async function secretCommand(argv: string[]): Promise<void> {
	return dispatchTable(argv, secretUsage, { list: secretList, ls: secretList, set: secretSet, rm: secretRemove, remove: secretRemove, delete: secretRemove });
}

async function secretList(argv: string[]): Promise<void> {
	const args = parse(argv, {}, secretUsage);
	if (!args) return;
	rejectExtraPositionals(args, 1, 'Usage: skif secret list <repo>');
	const repo = requirePositional(args, 0, 'repository. Usage: skif secret list <repo>');
	const raw = await (await api()).listSecrets(repo);
	if (args.boolean('json')) return printJson(raw);
	if (raw.secrets.length === 0) return void console.log(`${repo} has no secrets. Set one with: skif secret set ${repo} NAME`);
	console.log(secretTable(raw.secrets));
}

async function secretSet(argv: string[]): Promise<void> {
	const args = parse(argv, { env: { type: 'string' }, value: { type: 'string' } }, secretUsage);
	if (!args) return;
	const line = 'Usage: skif secret set <repo> <NAME> [--env e] [--value v | stdin]';
	rejectExtraPositionals(args, 2, line);
	const repo = requirePositional(args, 0, `repository. ${line}`);
	const name = requirePositional(args, 1, `secret name. ${line}`);
	assertVariableName(name, 'secret');
	const value = await readValue(args, `Value for ${name}: `, true);
	const environment = args.string('env');
	const raw = await (await api()).setSecret(repo, name, { value, ...(environment ? { environment } : {}) });
	if (args.boolean('json')) return printJson(raw);
	console.log(`Set secret ${name} on ${repo}${environment ? ` for environment ${environment}` : ''}.`);
}

async function secretRemove(argv: string[]): Promise<void> {
	const args = parse(argv, { env: { type: 'string' } }, secretUsage);
	if (!args) return;
	const line = 'Usage: skif secret rm <repo> <NAME> [--env e]';
	rejectExtraPositionals(args, 2, line);
	const repo = requirePositional(args, 0, `repository. ${line}`);
	const name = requirePositional(args, 1, `secret name. ${line}`);
	const raw = await (await api()).deleteSecret(repo, name, args.string('env'));
	if (args.boolean('json')) return printJson(raw);
	console.log(`Deleted secret ${name} from ${repo}.`);
}

const varUsage = `Usage: skif var <command> <repo> [options]

Commands:
  list <repo>                  Variables with their values
  set <repo> <NAME> [value]    Create or replace a variable (value as an argument, --value,
                               or piped on stdin)
  rm <repo> <NAME>             Delete a variable

Options:
      --value <value>          The value
      --json                   JSON output
  -h, --help                   Show this help

Workflows read variables as \${{ vars.NAME }}. They are not secret: use skif secret for credentials.`;

export async function varCommand(argv: string[]): Promise<void> {
	return dispatchTable(argv, varUsage, { list: varList, ls: varList, set: varSet, rm: varRemove, remove: varRemove, delete: varRemove });
}

async function varList(argv: string[]): Promise<void> {
	const args = parse(argv, {}, varUsage);
	if (!args) return;
	rejectExtraPositionals(args, 1, 'Usage: skif var list <repo>');
	const repo = requirePositional(args, 0, 'repository. Usage: skif var list <repo>');
	const raw = await (await api()).listVariables(repo);
	if (args.boolean('json')) return printJson(raw);
	if (raw.variables.length === 0) return void console.log(`${repo} has no variables. Set one with: skif var set ${repo} NAME value`);
	console.log(variableTable(raw.variables));
}

async function varSet(argv: string[]): Promise<void> {
	const args = parse(argv, { value: { type: 'string' } }, varUsage);
	if (!args) return;
	const line = 'Usage: skif var set <repo> <NAME> [value | --value v | stdin]';
	rejectExtraPositionals(args, 3, line);
	const repo = requirePositional(args, 0, `repository. ${line}`);
	const name = requirePositional(args, 1, `variable name. ${line}`);
	assertVariableName(name, 'variable');
	const positional = args.positionals[2];
	if (positional !== undefined && args.string('value') !== undefined) throw new UsageError('Give the value as an argument or with --value, not both.');
	const value = positional ?? (await readValue(args, `Value for ${name}: `, false));
	const raw = await (await api()).setVariable(repo, name, value);
	if (args.boolean('json')) return printJson(raw);
	console.log(`Set variable ${name} on ${repo}.`);
}

async function varRemove(argv: string[]): Promise<void> {
	const args = parse(argv, {}, varUsage);
	if (!args) return;
	const line = 'Usage: skif var rm <repo> <NAME>';
	rejectExtraPositionals(args, 2, line);
	const repo = requirePositional(args, 0, `repository. ${line}`);
	const name = requirePositional(args, 1, `variable name. ${line}`);
	const raw = await (await api()).deleteVariable(repo, name);
	if (args.boolean('json')) return printJson(raw);
	console.log(`Deleted variable ${name} from ${repo}.`);
}

/** `--value`, else stdin when piped (one trailing newline dropped), else a prompt (hidden for secrets). */
async function readValue(args: ParsedArgs, question: string, secret: boolean): Promise<string> {
	const flag = args.string('value');
	if (flag !== undefined) return flag;
	if (!process.stdin.isTTY) return (await readAllStdin()).replace(/\r?\n$/, '');
	return promptText(question, { secret });
}
