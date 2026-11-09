import { parseArgs, rejectExtraPositionals, type FlagSpec, type ParsedArgs } from '../args.ts';
import type { ApiClient } from '../api.ts';
import { CliError, UsageError } from '../errors.ts';
import {
	ProgressTracker,
	bulkVerbs,
	confirmQuestion,
	formatDurationShort,
	outcomeLine,
	planSummaryLine,
	planTable,
	typedConfirmQuestion,
	type BulkAction,
} from '../operations.ts';
import { formatTime, printJson, renderTable } from '../output.ts';
import { readAllStdin } from '../prompt.ts';
import { assertTargetCount, hasSelectors, parseDuration, parseSlugList, resolveTargets } from '../selectors.ts';
import { authenticatedClient } from './common.ts';
import {
	confirmOrRefuse,
	createPlan,
	discardPlan,
	emit,
	followWithProgress,
	outputMode,
	settleExitCode,
} from './run-operation.ts';

const listFlags: FlagSpec = {
	json: { type: 'boolean' },
	help: { type: 'boolean', short: 'h' },
};

const bulkFlags: FlagSpec = {
	match: { type: 'string' },
	'not-deployed': { type: 'boolean' },
	'older-than': { type: 'string' },
	stdin: { type: 'boolean' },
	yes: { type: 'boolean', short: 'y' },
	json: { type: 'boolean' },
	help: { type: 'boolean', short: 'h' },
};

/** Typing the count is required above this many purges (docs/OPERATIONS.md §6.2). */
const PURGE_TYPED_CONFIRM_OVER = 10;

const usage = `Usage: yoal projects [list|delete|restore|trash|purge] [options]

Commands:
  list                       List projects (the default)
  delete <slug…>             Move projects to the trash (restorable for 7 days)
  restore <slug…>            Bring projects back from the trash
  trash                      List the trash with purge dates
  purge <slug…>              Permanently delete projects already in the trash

Selecting projects (delete, restore, purge):
      --match <glob>         Slugs matching a glob, e.g. 'test-*' (quote it)
      --not-deployed         Only projects with nothing in production
      --older-than <dur>     Created (in the trash: deleted) more than <dur> ago: 30d, 12h, 2w
      --stdin                Read slugs from stdin, one per line
  Selectors combine with AND; named slugs are added on top. At most 100 per run.

Options:
  -y, --yes                  Don't ask for confirmation (required when stdin isn't a terminal)
      --json                 JSON output (NDJSON events for delete, restore and purge)
  -h, --help                 Show this help

Every bulk command shows the server's plan first, then asks. Exit codes: 0 succeeded,
3 partial, 1 failed or cancelled. Ctrl-C while it runs detaches; it keeps going on the
server (\`yoal operations watch <id>\`).`;

const subcommands: Record<string, (argv: string[]) => Promise<void>> = {
	list: listProjects,
	ls: listProjects,
	delete: (argv) => bulk('project.delete', argv),
	rm: (argv) => bulk('project.delete', argv),
	restore: (argv) => bulk('project.restore', argv),
	purge: (argv) => bulk('project.purge', argv),
	trash: listTrash,
};

export async function projectsCommand(argv: string[]): Promise<void> {
	const first = argv[0];
	if (first && !first.startsWith('-')) {
		const handler = subcommands[first];
		if (!handler) throw new UsageError(`Unknown projects command "${first}".\n\n${usage}`);
		await handler(argv.slice(1));
		return;
	}
	await listProjects(argv);
}

async function listProjects(argv: string[]): Promise<void> {
	const args = parseArgs(argv, listFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 0, 'Usage: yoal projects [--json]');

	const client = await authenticatedClient();
	const { projects, raw } = await client.listProjects();
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	if (projects.length === 0) {
		console.log('No projects yet. Deploy one with `yoal deploy`.');
		return;
	}
	const rows = projects.map((project) => [
		project.slug,
		project.name ?? '-',
		project.productionUrl ?? '-',
		`${project.productionAccess ?? '-'} / ${project.previewAccess ?? '-'}`,
		formatTime(project.createdAt),
	]);
	console.log(renderTable(['SLUG', 'NAME', 'PRODUCTION URL', 'ACCESS (PROD/PREVIEW)', 'CREATED'], rows));
}

async function listTrash(argv: string[]): Promise<void> {
	const args = parseArgs(argv, listFlags);
	if (args.boolean('help')) {
		console.log('Usage: yoal projects trash [--json]\n\nList deleted projects and when each is purged for good.');
		return;
	}
	rejectExtraPositionals(args, 0, 'Usage: yoal projects trash [--json]');

	const client = await authenticatedClient();
	const { projects, raw } = await client.listProjects({ trash: true });
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	if (projects.length === 0) {
		console.log('The trash is empty.');
		return;
	}
	const now = Date.now();
	const rows = projects.map((project) => [
		project.slug,
		project.name ?? '-',
		formatTime(project.deletedAt ?? undefined),
		project.purgeAt ? formatDurationShort(Date.parse(project.purgeAt) - now) : '-',
	]);
	console.log(renderTable(['SLUG', 'NAME', 'DELETED', 'PURGES IN'], rows));
	console.log('\nRestore with `yoal projects restore <slug…>`; purge now with `yoal projects purge <slug…>`.');
}

async function bulk(action: BulkAction, argv: string[]): Promise<void> {
	const args = parseArgs(argv, bulkFlags);
	const words = bulkVerbs[action];
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	const json = args.boolean('json');
	const mode = outputMode(json);
	const inTrash = action !== 'project.delete';

	const selection = await readSelection(args);
	const client = await authenticatedClient();
	const targets = await resolveSelection(client, selection, inTrash);

	const plan = await createPlan(client, { action, targets }, mode);
	const { items } = await client.listOperationItems(plan.id);
	const ok = items.filter((item) => item.verdict === 'ok');
	if (json) emit({ type: 'plan', operation: plan, items });
	else {
		console.log(planTable(items));
		console.log(`\n${planSummaryLine(action, items)}.`);
	}

	if (plan.status !== 'planned') {
		throw new CliError(`The plan ended as ${plan.status} before it could be reviewed.`, { code: 'plan_failed' });
	}
	if (ok.length === 0) {
		await discardPlan(client, plan.id);
		if (json) emit({ type: 'nothing_to_do', id: plan.id });
		else console.log(`Nothing to ${words.noun}: every target was skipped or blocked.`);
		return;
	}

	const typed = action === 'project.purge' && ok.length > PURGE_TYPED_CONFIRM_OVER;
	let confirmed: boolean;
	try {
		confirmed = await confirmOrRefuse(typed ? typedConfirmQuestion(ok.length) : confirmQuestion(action, ok), {
			yes: args.boolean('yes'),
			accept: typed ? (answer) => answer === String(ok.length) : undefined,
			refusal: `Not confirmed: stdin is not a terminal, so there's no one to ask before ${words.noun === 'restore' ? 'restoring' : 'deleting'} ${ok.length} project${ok.length === 1 ? '' : 's'}. The plan was cancelled.`,
		});
	} catch (error) {
		await discardPlan(client, plan.id);
		throw error;
	}
	if (!confirmed) {
		await discardPlan(client, plan.id);
		if (json) emit({ type: 'declined', id: plan.id });
		else console.error('Cancelled. Nothing was changed.');
		process.exitCode = 1;
		return;
	}

	const applied = await client.applyOperation(plan.id);
	const tracker = new ProgressTracker(applied);
	const final = await followWithProgress(client, applied, mode, { untilDone: true, tracker });
	settleExitCode(final);
	if (json) {
		emit({ type: 'done', operation: final });
		return;
	}
	console.log(outcomeLine(final));
	const succeeded = tracker.succeeded;
	if (action === 'project.delete' && succeeded.length > 0) {
		console.log(
			succeeded.length <= 20
				? `Undo: yoal projects restore ${succeeded.join(' ')}`
				: 'Undo: restore them from the trash with `yoal projects restore` (see `yoal projects trash`).',
		);
	}
	if (final.status !== 'succeeded') console.log(`Details: yoal operations show ${final.id}`);
}

interface Selection {
	explicit: string[];
	match?: string;
	notDeployed: boolean;
	olderThanMs?: number;
}

/** Named slugs, `--stdin` and the selector flags, validated before anything touches the network. */
async function readSelection(args: ParsedArgs): Promise<Selection> {
	const explicit = [...args.positionals];
	const olderThan = args.string('older-than');
	const selection: Selection = {
		explicit,
		match: args.string('match'),
		notDeployed: args.boolean('not-deployed'),
		olderThanMs: olderThan !== undefined ? parseDuration(olderThan) : undefined,
	};
	if (args.boolean('stdin')) {
		if (process.stdin.isTTY)
			throw new UsageError('--stdin needs slugs piped in, e.g. `cat slugs.txt | yoal projects delete --stdin --yes`.');
		explicit.push(...parseSlugList(await readAllStdin()));
	}
	if (explicit.length === 0 && !hasSelectors(selection))
		throw new UsageError(
			'Name at least one project, or select some with --match, --not-deployed, --older-than or --stdin.',
		);
	return selection;
}

/** Explicit slugs plus whatever the selectors match in the project list (or trash), capped. */
async function resolveSelection(client: ApiClient, selection: Selection, inTrash: boolean): Promise<string[]> {
	const used = hasSelectors(selection);
	const projects = used ? (await client.listProjects({ trash: inTrash })).projects : [];
	const targets = resolveTargets(projects, { ...selection, ageField: inTrash ? 'deletedAt' : 'createdAt', now: Date.now() });
	assertTargetCount(targets, { usedSelectors: used, where: inTrash ? 'in the trash' : '' });
	return targets;
}
