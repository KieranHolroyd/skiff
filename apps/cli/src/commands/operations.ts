import { parseArgs, rejectExtraPositionals, requirePositional, type FlagSpec, type ParsedArgs } from '../args.ts';
import { UsageError } from '../errors.ts';
import {
	ProgressTracker,
	formatDurationShort,
	isTerminal,
	itemsTable,
	operationsTable,
	outcomeLine,
	pruneTable,
	type OperationView,
} from '../operations.ts';
import { formatTime, printJson } from '../output.ts';
import { authenticatedClient } from './common.ts';
import { emit, followWithProgress, outputMode, settleExitCode } from './run-operation.ts';

const flags: FlagSpec = {
	kind: { type: 'string' },
	status: { type: 'string' },
	limit: { type: 'string' },
	scope: { type: 'string' },
	json: { type: 'boolean' },
	help: { type: 'boolean', short: 'h' },
};

const usage = `Usage: skif operations [list|show|watch|cancel] [options]

Mass actions (\`skif projects delete|restore|purge\`) and prune runs are operations that run
on the server. These commands inspect and steer them.

Commands:
  list                       Recent operations, newest first (the default)
  show <id>                  One operation: status, counts and its items
  watch <id>                 Follow progress until it finishes (Ctrl-C detaches)
  cancel <id>                Stop after the current item; the rest are cancelled

List options:
      --kind bulk|prune      Only one kind
      --status <status>      queued, planning, planned, applying, succeeded, partial, failed, cancelled, expired
      --limit <n>            How many (default 50, at most 200)
      --scope platform       Platform-scope prunes (platform admins)

Options:
      --json                 JSON output (NDJSON events for watch)
  -h, --help                 Show this help

watch exits 0 when the operation succeeded, 3 when partial, 1 when failed or cancelled.`;

export async function operationsCommand(argv: string[]): Promise<void> {
	const first = argv[0];
	const subcommand = first && !first.startsWith('-') ? first : 'list';
	const rest = first && !first.startsWith('-') ? argv.slice(1) : argv;
	const args = parseArgs(rest, flags);
	if (args.boolean('help') || subcommand === 'help') {
		console.log(usage);
		return;
	}
	switch (subcommand) {
		case 'list':
		case 'ls':
			await list(args);
			return;
		case 'show':
		case 'get':
			await show(args);
			return;
		case 'watch':
		case 'follow':
			await watch(args);
			return;
		case 'cancel':
			await cancel(args);
			return;
		default:
			throw new UsageError(`Unknown operations command "${subcommand}".\n\n${usage}`);
	}
}

async function list(args: ParsedArgs): Promise<void> {
	rejectExtraPositionals(args, 0, usage);
	const rawLimit = args.string('limit');
	const limit = rawLimit === undefined ? undefined : Number(rawLimit);
	if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 200))
		throw new UsageError('--limit must be an integer between 1 and 200.');
	const client = await authenticatedClient();
	const { operations, raw } = await client.listOperations({
		kind: args.string('kind'),
		status: args.string('status'),
		limit,
		scope: args.string('scope'),
	});
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	if (operations.length === 0) {
		console.log('No operations yet.');
		return;
	}
	console.log(operationsTable(operations, formatTime));
}

async function show(args: ParsedArgs): Promise<void> {
	rejectExtraPositionals(args, 1, usage);
	const id = requirePositional(args, 0, 'operation id');
	const client = await authenticatedClient();
	// A prune can have thousands of items; its detail is the per-category table plus failures.
	const operation = await client.getOperation(id);
	const { items } =
		operation.kind === 'prune'
			? await client.listOperationItems(id, { status: 'failed' }, 200)
			: await client.listOperationItems(id);
	if (args.boolean('json')) {
		printJson({ operation, items });
		return;
	}
	console.log(describe(operation).join('\n'));
	if (operation.kind === 'prune') {
		console.log(`\n${pruneTable(operation.summary)}`);
		if (items.length > 0) console.log(`\nFailed items:\n${itemsTable(items, { categories: true })}`);
	} else if (items.length > 0) {
		console.log(`\n${itemsTable(items, { categories: false })}`);
	}
}

async function watch(args: ParsedArgs): Promise<void> {
	rejectExtraPositionals(args, 1, usage);
	const id = requirePositional(args, 0, 'operation id');
	const json = args.boolean('json');
	const client = await authenticatedClient();
	const operation = await client.getOperation(id);

	if (operation.status === 'planned') {
		if (json) emit({ type: 'planned', operation });
		else console.log(waitingForApply(operation));
		return;
	}
	if (isTerminal(operation.status)) {
		if (json) emit({ type: 'done', operation });
		else console.log(outcomeLine(operation));
		settleExitCode(operation);
		return;
	}

	const tracker = new ProgressTracker(operation);
	// Following to `planned` also follows a plan-and-apply run to its end: it never stops there.
	const final = await followWithProgress(client, operation, outputMode(json), {
		untilDone: operation.status === 'applying',
		tracker,
	});
	if (final.status === 'planned') {
		if (json) emit({ type: 'planned', operation: final });
		else console.log(waitingForApply(final));
		return;
	}
	settleExitCode(final);
	if (json) emit({ type: 'done', operation: final });
	else console.log(outcomeLine(final));
}

async function cancel(args: ParsedArgs): Promise<void> {
	rejectExtraPositionals(args, 1, usage);
	const id = requirePositional(args, 0, 'operation id');
	const client = await authenticatedClient();
	const operation = await client.cancelOperation(id);
	if (args.boolean('json')) {
		printJson(operation);
		return;
	}
	if (operation.status === 'cancelled') console.log(`Cancelled ${id}.`);
	else if (isTerminal(operation.status)) console.log(`${id} had already finished (${operation.status}).`);
	else console.log(`Cancel requested for ${id}: it stops after the current item. Follow it with \`skif operations watch ${id}\`.`);
}

function describe(operation: OperationView): string[] {
	const lines = [
		`Operation  ${operation.id}`,
		`Action     ${operation.action}${operation.scope ? ` (${operation.scope} scope)` : ''}`,
		`Status     ${operation.status}${operation.phase ? ` — ${operation.phase}` : ''}`,
	];
	if (operation.total > 0)
		lines.push(`Progress   ${operation.done}/${operation.total}${operation.failed ? ` (${operation.failed} failed)` : ''}`);
	lines.push(`Created    ${formatTime(operation.createdAt)}`);
	if (operation.startedAt) lines.push(`Started    ${formatTime(operation.startedAt)}`);
	if (operation.finishedAt) lines.push(`Finished   ${formatTime(operation.finishedAt)}`);
	if (operation.planExpiresAt) lines.push(`Expires    ${formatTime(operation.planExpiresAt)}`);
	if (isTerminal(operation.status)) lines.push(`Result     ${outcomeLine(operation)}`);
	return lines;
}

function waitingForApply(operation: OperationView): string {
	const left = operation.planExpiresAt ? formatDurationShort(Date.parse(operation.planExpiresAt) - Date.now()) : undefined;
	const apply =
		operation.action === 'prune'
			? `Apply it: skif prune --apply --plan ${operation.id}`
			: 'Bulk plans are applied by the command that made them; plan again to run it.';
	return `${operation.id} is planned and waiting to be applied${left ? ` (expires in ${left})` : ''}.\n${apply}`;
}
