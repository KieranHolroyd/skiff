import { parseArgs, rejectExtraPositionals, type FlagSpec } from '../args.ts';
import { UsageError } from '../errors.ts';
import { auditTable, type AuditEntryView } from '../log-drains.ts';
import { printJson } from '../output.ts';
import { authenticatedClient } from './common.ts';

/** The org audit log (DESIGN §6.3): who did what, from which surface, newest first. */

const usage = `Usage: skif audit [options]

Options:
      --from <when>            Oldest entry to show: 2026-11-01, an ISO timestamp or epoch ms
      --to <when>              Newest entry to show; a date covers that whole day (UTC)
      --action <action>        Only this action, e.g. project.delete or mcp.deploy_site
      --resource <type>        Only this resource type, e.g. project, secret, log_drain
  -n, --limit <n>              Entries per page, 1–200 (default 50)
      --cursor <cursor>        Continue from a previous page's cursor
      --all                    Follow every page (up to 10,000 entries)
      --json                   JSON output ({ entries, nextCursor })
  -h, --help                   Show this help

Examples:
  skif audit --from 2026-11-01 --to 2026-11-07
  skif audit --resource log_drain --all --json`;

const flags: FlagSpec = {
	from: { type: 'string' },
	to: { type: 'string' },
	action: { type: 'string' },
	resource: { type: 'string' },
	limit: { type: 'string', short: 'n' },
	cursor: { type: 'string' },
	all: { type: 'boolean' },
	json: { type: 'boolean' },
	help: { type: 'boolean', short: 'h' },
};

const MAX_ALL = 10_000;

export async function auditCommand(argv: string[]): Promise<void> {
	const args = parseArgs(argv, flags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 0, 'Usage: skif audit [--from <when>] [--to <when>] [--action <a>] [--resource <r>] [--all]');
	const rawLimit = args.string('limit');
	const limit = rawLimit === undefined ? undefined : Number(rawLimit);
	if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 200)) throw new UsageError('--limit must be a whole number from 1 to 200.');
	const filter = {
		from: args.string('from'),
		to: args.string('to'),
		action: args.string('action'),
		resource: args.string('resource'),
	};
	const client = await authenticatedClient();
	const entries: AuditEntryView[] = [];
	let cursor = args.string('cursor');
	let nextCursor: string | null = null;
	do {
		const page = await client.auditLog({ ...filter, limit: args.boolean('all') ? 200 : limit, ...(cursor ? { cursor } : {}) });
		entries.push(...page.entries);
		nextCursor = page.nextCursor;
		cursor = nextCursor ?? undefined;
	} while (args.boolean('all') && nextCursor && entries.length < MAX_ALL);

	if (args.boolean('json')) {
		printJson({ entries, nextCursor });
		return;
	}
	if (entries.length === 0) {
		console.log('No audit entries match.');
		return;
	}
	console.log(auditTable(entries));
	if (nextCursor) console.log(`\nOlder entries: skif audit${flagsFor(filter)} --cursor ${nextCursor}`);
}

function flagsFor(filter: Record<string, string | undefined>): string {
	return Object.entries(filter)
		.filter(([, value]) => value)
		.map(([key, value]) => ` --${key} ${/^[\w.:-]+$/.test(value!) ? value : JSON.stringify(value)}`)
		.join('');
}
