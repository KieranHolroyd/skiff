import { readFile } from 'node:fs/promises';
import { parseArgs, type FlagSpec } from '../args.ts';
import { listFlag, parseSecretsFile, renderImport } from '../config-import.ts';
import { UsageError } from '../errors.ts';
import { printJson } from '../output.ts';
import { askTerminal } from '../prompt.ts';
import { authenticatedClient } from './common.ts';

/** Config import (docs/OPERATIONS.md §14): recreate an export's configuration on this instance. */

const usage = `Usage: yoal import <file> [options]

Recreate the configuration in a \`yoal export\` file (YAML or JSON) on the platform
you are signed in to, for example when moving to a new instance.

Import only creates. A resource that already exists under the same name (project
slug, database name, role name, …) is left exactly as it is, so running it again
only does what is still missing. Nothing is updated or deleted.

The export holds no secret values and no data. Pass the secret values with
--secrets, or set them afterwards and run the import again: workload settings that
need a missing secret are skipped until it exists. Databases, buckets and volumes
start empty, and each app needs a deploy. Anything the import cannot recreate is
listed under "By hand afterwards".

Without --apply this only shows the plan.

Options:
      --apply                Create everything the plan lists
  -y, --yes                  With --apply, do not ask for confirmation
      --secrets <file>       Secret values, one per line: NAME=value (org-wide)
                             or project-slug/NAME=value
      --only <sections>      Only these sections, e.g. projects,databases
      --skip <sections>      Leave these sections out
  -p, --project <slug>       Only these projects (repeatable or comma-separated)
      --all                  Also list resources that already exist
      --json                 JSON output
  -h, --help                 Show this help

Examples:
  yoal import yoal-config-acme-2026-11-09.yaml
  yoal import yoal-config-acme-2026-11-09.yaml --secrets secrets.env --apply`;

const flags: FlagSpec = {
	apply: { type: 'boolean' },
	yes: { type: 'boolean', short: 'y' },
	secrets: { type: 'string' },
	only: { type: 'string', multiple: true },
	skip: { type: 'string', multiple: true },
	project: { type: 'string', short: 'p', multiple: true },
	all: { type: 'boolean' },
	json: { type: 'boolean' },
	help: { type: 'boolean', short: 'h' },
};

/** Applying a whole org can take a while (databases, storage and brokers are provisioned). */
const APPLY_TIMEOUT_MS = 15 * 60 * 1000;

export async function importCommand(argv: string[]): Promise<void> {
	const args = parseArgs(argv, flags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	const [file, ...extra] = args.positionals;
	if (!file || extra.length) throw new UsageError('Usage: yoal import <file> [--apply] [--secrets <file>]');

	let document: string;
	try {
		document = await readFile(file, 'utf8');
	} catch (error) {
		throw new UsageError(`Cannot read ${file}: ${(error as Error).message}`);
	}
	let secrets: Record<string, string> | undefined;
	const secretsFile = args.string('secrets');
	if (secretsFile) {
		try {
			secrets = parseSecretsFile(await readFile(secretsFile, 'utf8'));
		} catch (error) {
			throw new UsageError(`${secretsFile}: ${(error as Error).message}`);
		}
	}
	const request = {
		document,
		...(args.strings('only').length ? { only: listFlag(args.strings('only')) } : {}),
		...(args.strings('skip').length ? { skip: listFlag(args.strings('skip')) } : {}),
		...(args.strings('project').length ? { projects: listFlag(args.strings('project')) } : {}),
		...(secrets ? { secrets } : {}),
	};

	const client = await authenticatedClient();
	const plan = await client.configImport('plan', request);
	const json = args.boolean('json');
	if (!args.boolean('apply')) {
		if (json) printJson({ plan });
		else {
			console.log(renderImport(plan, { all: args.boolean('all') }));
			if (plan.summary.planned > 0) console.log('\nRun again with --apply to create it.');
		}
		return;
	}
	if (plan.summary.planned === 0) {
		if (json) printJson({ plan, result: null });
		else console.log(renderImport(plan, { all: args.boolean('all') }));
		return;
	}
	if (!json) console.log(renderImport(plan, { all: args.boolean('all') }));
	if (!args.boolean('yes')) {
		if (!process.stdin.isTTY) throw new UsageError('Refusing to apply without a terminal to confirm on; pass --yes.');
		const answer = await askTerminal(`\nCreate ${plan.summary.planned} resources on ${client.baseUrl}? [y/N] `);
		if (!/^y(es)?$/i.test(answer)) {
			console.log('Nothing was changed.');
			return;
		}
	}
	const result = await client.configImport('apply', request, { timeoutMs: APPLY_TIMEOUT_MS });
	if (json) printJson({ result });
	else console.log(`\n${renderImport(result, { all: args.boolean('all') })}`);
	if (result.summary.failed > 0) process.exitCode = 3;
}
