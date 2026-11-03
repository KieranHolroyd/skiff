import { parseArgs, rejectExtraPositionals, requirePositional, type FlagSpec } from '../args.ts';
import { printJson } from '../output.ts';
import { authenticatedClient, printOutcome } from './common.ts';

const flags: FlagSpec = {
	json: { type: 'boolean' },
	help: { type: 'boolean', short: 'h' },
};

const usage = 'Usage: skif promote <project> <deploymentId> [--json]\n\nMove production to an existing deployment.';

export async function promoteCommand(argv: string[]): Promise<void> {
	const args = parseArgs(argv, flags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 2, usage);
	const projectSlug = requirePositional(args, 0, 'project slug');
	const deploymentId = requirePositional(args, 1, 'deployment id');

	const client = await authenticatedClient();
	const outcome = await client.promote(projectSlug, deploymentId);
	if (args.boolean('json')) {
		printJson(outcome.raw);
		return;
	}
	printOutcome(outcome, projectSlug);
}
