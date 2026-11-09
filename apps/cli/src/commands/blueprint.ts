import { readFile } from 'node:fs/promises';
import { parseArgs, rejectExtraPositionals, type FlagSpec, type ParsedArgs } from '../args.ts';
import type { ApiClient } from '../api.ts';
import {
	BLUEPRINT_FILE_NAMES,
	BLUEPRINT_MAX_BYTES,
	findBlueprintFile,
	hasChanges,
	issueLines,
	planLines,
	planSummary,
	runOutcome,
	runTable,
	type BlueprintPlanView,
} from '../blueprints.ts';
import { ApiError, CliError, UsageError } from '../errors.ts';
import { exitCodeFor, type OperationStatus } from '../operations.ts';
import { printJson } from '../output.ts';
import { readAllStdin } from '../prompt.ts';
import { authenticatedClient } from './common.ts';
import { confirmOrRefuse, discardPlan, emit, followWithProgress, outputMode } from './run-operation.ts';

/**
 * `yoal blueprint validate|plan|apply` (plan 11, docs/OPERATIONS.md §12). The file is sent as
 * text; the server parses it, diffs it against live state and runs the plan as one operation, so
 * this command never decides anything itself.
 */

const usage = `Usage: yoal blueprint <validate|plan|apply> [file] [options]

Declare a stack (projects, environments, domains, workload settings, databases, storage buckets,
brokers and attachments) in one file, then plan and apply it. A second apply of the same file is
a no-op. Blueprints hold secret names, never values. Needs YOAL_FEATURE_BLUEPRINTS on the server.

Commands:
  validate [file]        Check the file (schema, names, cross references); reads no live state
  plan [file]            Show what applying would change; changes nothing
  apply [file]           Plan, show it, ask, then apply and follow the progress

With no file, the first of ${BLUEPRINT_FILE_NAMES.join(', ')} in the current directory is used.
Pass - to read the file from stdin.

Options:
      --prune            Also delete resources this stack manages that the file no longer lists
                         (apply asks you to type the stack name; --yes confirms it for you)
      --plan <hash>      apply: apply this plan (from \`yoal blueprint plan\`) without planning again
      --confirm <stack>  apply --plan: the stack name, when that plan deletes resources
      --all              plan/apply: also list resources that are up to date
  -y, --yes              Don't ask (required when stdin isn't a terminal)
      --json             JSON (plan, validate) or NDJSON progress events (apply)
  -h, --help             Show this help

Exit codes: 0 applied (or nothing to do), 3 partial, 1 failed, declined or invalid.
Ctrl-C while applying detaches; the run carries on (\`yoal operations watch <id>\`).`;

const flags: FlagSpec = {
	prune: { type: 'boolean' },
	plan: { type: 'string' },
	confirm: { type: 'string' },
	all: { type: 'boolean' },
	yes: { type: 'boolean', short: 'y' },
	json: { type: 'boolean' },
	help: { type: 'boolean', short: 'h' },
};

export async function blueprintCommand(argv: string[]): Promise<void> {
	const [subcommand, ...rest] = argv;
	if (!subcommand || subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
		console.log(usage);
		return;
	}
	const args = parseArgs(rest, flags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 1, usage);
	switch (subcommand) {
		case 'validate':
		case 'check':
			return validate(args);
		case 'plan':
		case 'diff':
			return plan(args);
		case 'apply':
			return apply(args);
		default:
			throw new UsageError(`Unknown blueprint command "${subcommand}".\n\n${usage}`);
	}
}

/** Read the blueprint text: a path, `-` for stdin, or a default file name in the current directory. */
async function readDocument(args: ParsedArgs): Promise<{ text: string; source: string }> {
	const given = args.positionals[0];
	if (given === '-') return { text: await readAllStdin(), source: 'stdin' };
	const path = findBlueprintFile(given, process.cwd());
	if (!path)
		throw new UsageError(`No blueprint file here. Pass a path, or create one of: ${BLUEPRINT_FILE_NAMES.join(', ')}.`);
	let text: string;
	try {
		text = await readFile(path, 'utf8');
	} catch (error) {
		throw new CliError(`Could not read ${path}: ${(error as Error).message}`, { code: 'file' });
	}
	if (Buffer.byteLength(text) > BLUEPRINT_MAX_BYTES) throw new CliError(`${path} is larger than 512 KB.`, { code: 'file' });
	return { text, source: path };
}

/** A 422 lists every problem with its path; print them all, not just the first. */
async function withIssues<T>(work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (error) {
		if (error instanceof ApiError && error.status === 422) {
			const lines = issueLines(error.body);
			if (lines.length > 1) throw new CliError(`${error.message}\n${lines.join('\n')}`, { code: error.code });
		}
		throw error;
	}
}

async function validate(args: ParsedArgs): Promise<void> {
	const { text, source } = await readDocument(args);
	const client = await authenticatedClient();
	const { validation, raw } = await withIssues(() => client.validateBlueprint(text));
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	const counts = Object.entries(validation.resources)
		.filter(([, count]) => count > 0)
		.map(([kind, count]) => `${count} ${kind}`);
	console.log(`${source} is a valid blueprint for stack "${validation.stack}"${counts.length ? ` (${counts.join(', ')})` : ''}.`);
}

function printPlan(plan: BlueprintPlanView, all: boolean): void {
	console.log(planSummary(plan));
	const lines = planLines(plan, { all });
	if (lines.length) console.log(`\n${lines.join('\n')}`);
	for (const warning of plan.warnings) console.log(`\nwarning: ${warning}`);
}

async function plan(args: ParsedArgs): Promise<void> {
	const { text } = await readDocument(args);
	const client = await authenticatedClient();
	const { plan: view, raw } = await withIssues(() => client.planBlueprint(text, { prune: args.boolean('prune') }));
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	printPlan(view, args.boolean('all'));
	if (!hasChanges(view)) return;
	console.log(
		`\nPlan ${view.planHash.slice(0, 12)} (expires ${view.expiresAt ?? 'in an hour'}). Apply it with:\n  yoal blueprint apply --plan ${view.planHash}${view.summary.delete ? ` --confirm ${view.stack}` : ''}`,
	);
}

async function apply(args: ParsedArgs): Promise<void> {
	const json = args.boolean('json');
	const mode = outputMode(json);
	const yes = args.boolean('yes');
	const planHash = args.string('plan');
	const client = await authenticatedClient();

	let view: BlueprintPlanView | null = null;
	if (planHash) {
		if (args.positionals.length) throw new UsageError('--plan applies an existing plan; drop the file argument.');
		if (!/^[a-f0-9]{64}$/.test(planHash)) throw new UsageError('--plan takes the 64-character plan hash from `yoal blueprint plan`.');
	} else {
		const { text } = await readDocument(args);
		view = (await withIssues(() => client.planBlueprint(text, { prune: args.boolean('prune') }))).plan;
		if (json) emit({ type: 'plan', plan: view });
		else printPlan(view, args.boolean('all'));
		if (!hasChanges(view)) {
			await discardPlan(client, view.operationId);
			if (json) emit({ type: 'nothing_to_do', stack: view.stack });
			else console.log('\nEverything is up to date.');
			return;
		}
	}

	// A pruning plan deletes resources: type the stack name back (or --yes to confirm it).
	let confirm = args.string('confirm');
	const deletes = view ? view.summary.delete : 0;
	if (view && deletes > 0) {
		if (yes) confirm = view.stack;
		else {
			const stack = view.stack;
			const accepted = await confirmOrRefuse(`\nThis deletes ${deletes} resource${deletes === 1 ? '' : 's'}. Type the stack name "${stack}" to apply: `, {
				yes: false,
				accept: (answer) => answer.trim() === stack,
				refusal: `Not applied: stdin is not a terminal. Re-run with --yes, or apply this plan within the hour with \`yoal blueprint apply --plan ${view.planHash} --confirm ${stack}\`.`,
			});
			if (!accepted) return declined(client, view);
			confirm = stack;
		}
	} else if (view) {
		const accepted = await confirmOrRefuse(`\nApply these changes to "${view.stack}"? [y/N] `, {
			yes,
			refusal: `Not applied: stdin is not a terminal. Re-run with --yes, or apply this plan within the hour with \`yoal blueprint apply --plan ${view.planHash}\`.`,
		});
		if (!accepted) return declined(client, view);
	}

	const started = (
		await withIssues(() => client.applyBlueprint({ planHash: planHash ?? view!.planHash, ...(confirm ? { confirm } : {}) }))
	).run;
	const operation = await client.getOperation(started.operationId);
	const final = await followWithProgress(client, operation, mode, { untilDone: true });
	const { run } = await client.getBlueprintRun(final.id);
	if (json) emit({ type: 'run', run });
	else {
		console.log(`\n${runTable(run)}\n\n${runOutcome(run)}`);
	}
	process.exitCode = exitCodeFor(final.status as OperationStatus);
}

async function declined(client: ApiClient, view: BlueprintPlanView): Promise<void> {
	await discardPlan(client, view.operationId);
	console.log('Not applied.');
	process.exitCode = 1;
}
