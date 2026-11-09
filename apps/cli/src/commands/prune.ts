import { parseArgs, rejectExtraPositionals, type FlagSpec } from '../args.ts';
import { CliError, UsageError } from '../errors.ts';
import {
	ProgressTracker,
	isPlanning,
	isTerminal,
	outcomeLine,
	pruneCategoryIds,
	pruneConfirmQuestion,
	pruneTable,
	pruneTotals,
	type OperationView,
} from '../operations.ts';
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

const flags: FlagSpec = {
	apply: { type: 'boolean' },
	plan: { type: 'string' },
	scope: { type: 'string' },
	only: { type: 'string' },
	'older-than': { type: 'string' },
	'keep-tags': { type: 'string' },
	yes: { type: 'boolean', short: 'y' },
	json: { type: 'boolean' },
	help: { type: 'boolean', short: 'h' },
};

const usage = `Usage: skif prune [--apply] [--plan <op_id>] [--scope org|platform] [--only <categories>]
                  [--older-than <days>] [--keep-tags <n>] [--yes] [--json]

Find and remove data no live project references: leftover rows of deleted projects, orphaned
domains, stale workload reservations, old deleted deployments, abandoned uploads, unused
config snapshots and releases, old registry images, stale GitHub runner registrations, old
unpinned volume snapshots, and (platform scope) unreferenced stored objects.

Without --apply this is a dry run: it scans, prints what it found per category, and prints
the command that applies exactly that plan. Plans expire after 1 hour.

Options:
      --apply                Delete what the scan found (asks first unless --plan or --yes)
      --plan <op_id>         Use an existing scan instead of scanning again
      --scope org|platform   org (default) or platform; platform needs a platform admin
      --only <list>          Comma-separated categories to scan or apply
      --older-than <days>    Override the retention window for every selected category
      --keep-tags <n>        Keep at least this many newest tags per registry repository
  -y, --yes                  Don't ask for confirmation (required when stdin isn't a terminal)
      --json                 NDJSON progress events on stdout
  -h, --help                 Show this help

Categories: ${pruneCategoryIds.join(', ')}

Exit codes: 0 succeeded, 3 partial, 1 failed or cancelled. Ctrl-C detaches; the run carries
on (\`skif operations watch <id>\`).`;

export async function pruneCommand(argv: string[]): Promise<void> {
	const args = parseArgs(argv, flags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 0, usage);
	const json = args.boolean('json');
	const mode = outputMode(json);
	const only = parseCategories(args.string('only'));
	const scope = args.string('scope');
	if (scope !== undefined && scope !== 'org' && scope !== 'platform')
		throw new UsageError('--scope must be org or platform.');
	const olderThanDays = parsePositiveInt(args.string('older-than'), '--older-than', 3650);
	const keepTags = parsePositiveInt(args.string('keep-tags'), '--keep-tags', 1000, true);
	const planId = args.string('plan');
	if (planId !== undefined && scope !== undefined)
		throw new UsageError('--scope is fixed by the plan; drop it when you pass --plan.');
	if (planId !== undefined && (olderThanDays !== undefined || keepTags !== undefined))
		throw new UsageError('--older-than and --keep-tags are fixed by the plan; drop them when you pass --plan.');

	const client = await authenticatedClient();
	let plan: OperationView;
	if (planId) {
		plan = await client.getOperation(planId);
		if (plan.action !== 'prune') throw new UsageError(`${planId} is a ${plan.action} operation, not a prune plan.`);
		if (isPlanning(plan.status)) plan = await followWithProgress(client, plan, mode, { untilDone: false });
		if (plan.status !== 'planned') throw notApplicable(plan);
	} else {
		plan = await createPlan(
			client,
			{
				action: 'prune',
				...(scope ? { scope: scope as 'org' | 'platform' } : {}),
				...(only ? { categories: only } : {}),
				...(olderThanDays !== undefined ? { olderThanDays } : {}),
				...(keepTags !== undefined ? { keepTags } : {}),
			},
			mode,
			{ waitSeconds: 1, showProgress: true },
		);
		if (plan.status !== 'planned') throw notApplicable(plan);
	}

	const shown = only ? narrow(plan, only) : plan;
	const totals = pruneTotals(shown.summary);
	if (json) emit({ type: 'plan', operation: plan });
	if (totals.items === 0) {
		if (!planId) await discardPlan(client, plan.id);
		if (json) emit({ type: 'nothing_to_do', id: plan.id });
		else console.log(`Nothing to prune (${plan.scope ?? 'org'} scope${only ? `, ${only.join(', ')}` : ''}).`);
		return;
	}
	if (!json) {
		console.log(`Prune plan ${plan.id} (${plan.scope ?? 'org'} scope)\n`);
		console.log(pruneTable(shown.summary));
	}

	if (!args.boolean('apply')) {
		if (!json) {
			const onlyFlag = only && planId ? ` --only ${only.join(',')}` : '';
			console.log(`\nThis was a dry run. To delete exactly this plan (within 1 hour):\n  skif prune --apply --plan ${plan.id}${onlyFlag}`);
		}
		return;
	}

	// `--apply --plan` names the plan the human already reviewed; a fresh scan asks first.
	if (!planId) {
		// Off a terminal this refuses, but the scan is kept: it's a valid dry run to apply by id.
		const confirmed = await confirmOrRefuse(pruneConfirmQuestion(shown.summary), {
			yes: args.boolean('yes'),
			refusal: `Not confirmed: stdin is not a terminal. The scan was kept as a dry run; apply it within 1 hour with \`skif prune --apply --plan ${plan.id}\`.`,
		});
		if (!confirmed) {
			await discardPlan(client, plan.id);
			if (json) emit({ type: 'declined', id: plan.id });
			else console.error('Cancelled. Nothing was changed.');
			process.exitCode = 1;
			return;
		}
	}

	const applied = await client.applyOperation(plan.id, only ? { categories: only } : {});
	const tracker = new ProgressTracker(applied);
	if (!json) console.log('');
	const final = await followWithProgress(client, applied, mode, { untilDone: true, tracker });
	settleExitCode(final);
	if (json) {
		emit({ type: 'done', operation: final });
		return;
	}
	console.log(outcomeLine(final));
	if (final.status !== 'succeeded') console.log(`Details: skif operations show ${final.id}`);
}

/** A whole number; `allowZero` lets `--keep-tags 0` mean "keep only in-use tags and latest". */
function parsePositiveInt(value: string | undefined, flag: string, max: number, allowZero = false): number | undefined {
	if (value === undefined) return undefined;
	const number = Number(value);
	const min = allowZero ? 0 : 1;
	if (!Number.isInteger(number) || number < min || number > max)
		throw new UsageError(`${flag} must be a whole number from ${min} to ${max}.`);
	return number;
}

function parseCategories(value: string | undefined): string[] | undefined {
	if (value === undefined) return undefined;
	const list = value
		.split(',')
		.map((part) => part.trim())
		.filter(Boolean);
	if (list.length === 0) throw new UsageError('--only needs at least one category.');
	const unknown = list.filter((id) => !pruneCategoryIds.includes(id));
	if (unknown.length > 0)
		throw new UsageError(`Unknown prune categor${unknown.length === 1 ? 'y' : 'ies'}: ${unknown.join(', ')}. Valid: ${pruneCategoryIds.join(', ')}.`);
	return [...new Set(list)];
}

/** The plan as it will run with `--only`: deselected categories are left out. */
function narrow(plan: OperationView, only: string[]): OperationView {
	const categories = Object.fromEntries(
		Object.entries(plan.summary.categories ?? {}).filter(([id]) => only.includes(id)),
	);
	return { ...plan, summary: { ...plan.summary, categories } };
}

function notApplicable(plan: OperationView): CliError {
	if (plan.status === 'applying')
		return new CliError(`${plan.id} is already being applied.`, { suggestions: [`Follow it: skif operations watch ${plan.id}`] });
	if (isTerminal(plan.status))
		return new CliError(`${plan.id} is ${plan.status}; it can no longer be applied.`, {
			suggestions: ['Scan again: skif prune'],
		});
	return new CliError(`${plan.id} is ${plan.status}, not planned.`);
}
