import { parseArgs, requirePositional, type FlagSpec } from '../args.ts';
import { UsageError } from '../errors.ts';
import { formatHaStatus } from '../ha.ts';
import { printJson } from '../output.ts';
import { authenticatedClient } from './common.ts';

const flags: FlagSpec = {
	json: { type: 'boolean' },
	events: { type: 'string' },
	help: { type: 'boolean', short: 'h' },
};

const usage = `Usage: yoal ha status [--events <n>] [--json]

Show the failover controller (platform admin): whether automatic failover is on, the
controller lease, how long each node has been silent, the ingress record set, databases
whose primary is lost and the replica a promotion would pick, and recent failover events.

Options:
  --events <n>  Recent events to list (default 10, at most 50)
  --json        Print the raw status`;

export async function haCommand(argv: string[]): Promise<void> {
	const args = parseArgs(argv, flags);
	if (args.boolean('help') || args.positionals.length === 0) {
		console.log(usage);
		return;
	}
	const action = requirePositional(args, 0, 'action');
	if (action !== 'status') throw new UsageError(`Unknown ha action "${action}".\n\n${usage}`);
	if (args.positionals.length > 1) throw new UsageError(usage);
	const events = args.string('events');
	const count = events === undefined ? 10 : Number(events);
	if (!Number.isInteger(count) || count < 0 || count > 50) throw new UsageError('--events must be a whole number from 0 to 50.');
	const client = await authenticatedClient();
	const { status, raw } = await client.getHaStatus();
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(formatHaStatus(status, { events: count }));
}
