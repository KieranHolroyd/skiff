import { parseArgs, rejectExtraPositionals, requirePositional, type FlagSpec } from '../args.ts';
import { printJson } from '../output.ts';
import { authenticatedClient, printOutcome } from './common.ts';

const flags: FlagSpec = {
	json: { type: 'boolean' },
	help: { type: 'boolean', short: 'h' },
};

const usage = 'Usage: skif rollback <project> [--json]\n\nMove production back to the previous deployment.';

export async function rollbackCommand(argv: string[]): Promise<void> {
	const args = parseArgs(argv, flags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 1, usage);
	const projectSlug = requirePositional(args, 0, 'project slug');

	const client = await authenticatedClient();
	const outcome = await client.rollback(projectSlug);
	if (args.boolean('json')) {
		printJson(outcome.raw);
		return;
	}
	printOutcome(outcome, projectSlug);
}
