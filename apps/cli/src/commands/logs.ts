import { parseArgs, rejectExtraPositionals, requirePositional, type FlagSpec } from '../args.ts';
import { UsageError } from '../errors.ts';
import { formatTime, printJson } from '../output.ts';
import { authenticatedClient } from './common.ts';

const flags: FlagSpec = {
	lines: { type: 'string', default: '200', short: 'n' },
	json: { type: 'boolean' },
	help: { type: 'boolean', short: 'h' },
};

const usage = 'Usage: yoal logs <project> [--lines <n>] [--json]\n\nShow recent runtime logs for a project.';

export async function logsCommand(argv: string[]): Promise<void> {
	const args = parseArgs(argv, flags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 1, usage);
	const projectSlug = requirePositional(args, 0, 'project slug');
	const rawLimit = args.string('lines') ?? '200';
	const limit = Number(rawLimit);
	if (!Number.isInteger(limit) || limit < 1 || limit > 10_000)
		throw new UsageError('--lines must be an integer between 1 and 10000.');

	const client = await authenticatedClient();
	const { lines, raw } = await client.getLogs(projectSlug, { limit });
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	if (lines.length === 0) {
		console.log(`No logs for ${projectSlug}.`);
		return;
	}
	for (const line of lines) {
		const prefix = [line.timestamp ? formatTime(line.timestamp) : undefined, line.level?.toUpperCase()]
			.filter(Boolean)
			.join(' ');
		console.log(prefix ? `${prefix}  ${line.message}` : line.message);
	}
}
