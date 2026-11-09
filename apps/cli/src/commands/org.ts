import { parseArgs, rejectExtraPositionals, requirePositional, type FlagSpec } from '../args.ts';
import { CliError, UsageError } from '../errors.ts';
import { printJson } from '../output.ts';
import { authenticatedClient } from './common.ts';
import { asRecord, requestJson, stringValue } from './iam.ts';

/**
 * The active organisation (docs/IAM.md I5, §8.1). The choice lives on the dashboard session, so
 * only a browser session can switch; a CLI key is already bound to one org. `yoal org switch`
 * calls `/api/v1/org/switch` with the target id.
 */

const usage = `Usage: yoal org <command> [options]

Commands:
  switch <org-id>              Make that organisation the active one for this session

Options:
      --json                   JSON output
  -h, --help                   Show this help

A key is bound to the org it was minted in and cannot switch. The dashboard's org switcher calls
the same endpoint, and the choice is remembered for the next sign-in.

Examples:
  yoal org switch org_abc123`;

const baseFlags: FlagSpec = {
	json: { type: 'boolean' },
	help: { type: 'boolean', short: 'h' },
};

export async function orgCommand(argv: string[]): Promise<void> {
	const first = argv[0];
	if (!first || first === 'help' || first === '--help' || first === '-h') {
		console.log(usage);
		return;
	}
	if (first.startsWith('-')) throw new UsageError(`Unknown option ${first}.\n\n${usage}`);
	switch (first) {
		case 'switch':
		case 'use':
			return switchOrg(argv.slice(1));
		default:
			throw new UsageError(`Unknown org command "${first}".\n\n${usage}`);
	}
}

async function switchOrg(argv: string[]): Promise<void> {
	const args = parseArgs(argv, baseFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 1, 'Usage: yoal org switch <org-id>');
	const organizationId = requirePositional(args, 0, `organisation id.\n\n${usage}`);
	const client = await authenticatedClient();
	const raw = await requestJson(client, 'POST', '/api/v1/org/switch', { organizationId });
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	const org = asRecord(asRecord(raw)?.org);
	const name = stringValue(org?.name);
	if (!name)
		throw new CliError('The platform returned an unexpected organisation response.', {
			code: 'protocol',
			details: raw,
		});
	console.log(`Switched to ${name} (${organizationId}).`);
}
