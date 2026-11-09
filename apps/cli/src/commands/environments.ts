import { parseArgs, rejectExtraPositionals, requirePositional, type FlagSpec } from '../args.ts';
import { UsageError } from '../errors.ts';
import { environmentDetails, environmentTable, type EnvironmentView } from '../environments.ts';
import { printJson } from '../output.ts';
import { authenticatedClient } from './common.ts';
import { confirmOrRefuse } from './run-operation.ts';

/**
 * Named project environments (D13). Each has its own host and deployment pointer; production is
 * built in. A process/container app still runs one workload, so deploying to any environment
 * switches the running release.
 */

const usage = `Usage: yoal environments <command> [options]

Commands:
  list <project>                       List environments (the default)
  create <project> <name>              Add a named environment
  update <project> <env>               Rename it or change its access mode
  remove <project> <env>               Delete it (its deployments must be gone first)
  promote <project> <env> <deploy>     Point the environment at a deployment

Options:
  -p, --project <slug>                 Project slug (also accepted as an argument)
      --name <name>                    New display name (update)
      --slug <slug>                    Explicit slug (create; default: from the name)
      --access <mode>                  public, password, platform or access
      --password <value>               Password for password mode
      --policy <id>                    Yoal Access policy for access mode (none clears it)
  -y, --yes                            Don't ask before removing
      --json                           JSON output
  -h, --help                           Show this help

Examples:
  yoal environments list shop
  yoal environments create shop staging
  yoal environments create shop preview --access password --password 'correct horse'
  yoal environments update shop staging --access platform
  yoal environments promote shop staging dpl_abc123
  yoal environments remove shop staging --yes`;

const baseFlags: FlagSpec = {
	project: { type: 'string', short: 'p' },
	json: { type: 'boolean' },
	help: { type: 'boolean', short: 'h' },
};

const createFlags: FlagSpec = {
	...baseFlags,
	slug: { type: 'string' },
	access: { type: 'string' },
	password: { type: 'string' },
	policy: { type: 'string' },
};

const updateFlags: FlagSpec = { ...createFlags, name: { type: 'string' } };

const removeFlags: FlagSpec = { ...baseFlags, yes: { type: 'boolean', short: 'y' } };

const subcommands: Record<string, (argv: string[]) => Promise<void>> = {
	list: listEnvironments,
	ls: listEnvironments,
	create: createEnvironment,
	add: createEnvironment,
	update: updateEnvironment,
	remove: removeEnvironment,
	rm: removeEnvironment,
	delete: removeEnvironment,
	promote: promoteEnvironment,
};

export async function environmentsCommand(argv: string[]): Promise<void> {
	const first = argv[0];
	if (first && !first.startsWith('-')) {
		const handler = subcommands[first];
		if (!handler) throw new UsageError(`Unknown environments command "${first}".\n\n${usage}`);
		await handler(argv.slice(1));
		return;
	}
	await listEnvironments(argv);
}

function projectOf(args: ReturnType<typeof parseArgs>, index = 0): string {
	const flag = args.string('project');
	const positional = args.positionals[index];
	const project = flag ?? positional;
	if (!project) throw new UsageError('Name the project: yoal environments list <project>.');
	return project;
}

const ACCESS_MODES = ['public', 'password', 'platform', 'access'] as const;

function accessFlag(args: ReturnType<typeof parseArgs>): string | undefined {
	if (!args.has('access')) return undefined;
	const access = args.string('access') ?? '';
	if (!(ACCESS_MODES as readonly string[]).includes(access))
		throw new UsageError(`--access must be one of ${ACCESS_MODES.join(', ')}.`);
	return access;
}

async function listEnvironments(argv: string[]): Promise<void> {
	const args = parseArgs(argv, baseFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 1, 'Usage: yoal environments list <project> [--json]');
	const project = projectOf(args);
	const client = await authenticatedClient();
	const { environments, raw } = await client.listEnvironments(project);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	if (environments.length === 0) {
		console.log(`No environments in ${project} yet. Production is created on the next deploy.`);
		return;
	}
	console.log(environmentTable(environments));
}

async function createEnvironment(argv: string[]): Promise<void> {
	const args = parseArgs(argv, createFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 2, 'Usage: yoal environments create <project> <name>');
	const project = projectOf(args);
	const name = requirePositional(args, 1, 'environment name');
	const client = await authenticatedClient();
	const access = accessFlag(args);
	const { environment, raw } = await client.createEnvironment(project, {
		name,
		...(args.string('slug') ? { slug: args.string('slug')! } : {}),
		...(access ? { access } : {}),
		...(args.string('password') ? { password: args.string('password')! } : {}),
		...(args.string('policy') ? { policyId: args.string('policy')! } : {}),
	});
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(`Created environment "${environment.name}" in ${project}.`);
	console.log('');
	console.log(environmentDetails(environment).join('\n'));
}

async function updateEnvironment(argv: string[]): Promise<void> {
	const args = parseArgs(argv, updateFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 2, 'Usage: yoal environments update <project> <env> [options]');
	const project = projectOf(args);
	const env = requirePositional(args, 1, 'environment slug');
	const input: { name?: string; access?: string; password?: string; policyId?: string | null } = {};
	if (args.string('name')) input.name = args.string('name')!;
	const access = accessFlag(args);
	if (access) input.access = access;
	if (args.string('password')) input.password = args.string('password')!;
	if (args.has('policy')) {
		const policy = args.string('policy') ?? '';
		input.policyId = policy === '' || policy === 'none' ? null : policy;
	}
	if (Object.keys(input).length === 0)
		throw new UsageError('Nothing to change. Pass --name, --access, --password or --policy.');
	const client = await authenticatedClient();
	const { environment, raw } = await client.updateEnvironment(project, env, input);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(`Updated environment "${environment.name}".`);
	console.log('');
	console.log(environmentDetails(environment).join('\n'));
}

async function removeEnvironment(argv: string[]): Promise<void> {
	const args = parseArgs(argv, removeFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 2, 'Usage: yoal environments remove <project> <env> [--yes]');
	const project = projectOf(args);
	const env = requirePositional(args, 1, 'environment slug');
	await confirmOrRefuse(
		`Delete the "${env}" environment in ${project}? Its host stops serving. Deployments must be deleted first, and production cannot be removed. [y/N] `,
		{
			yes: args.boolean('yes'),
			refusal: 'Confirmation required to remove an environment. Re-run with --yes.',
		},
	);
	const client = await authenticatedClient();
	const raw = await client.deleteEnvironment(project, env);
	if (args.boolean('json')) printJson(raw);
	else console.log(`Removed environment "${env}" from ${project}.`);
}

async function promoteEnvironment(argv: string[]): Promise<void> {
	const args = parseArgs(argv, baseFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 3, 'Usage: yoal environments promote <project> <env> <deployment-id>');
	const project = projectOf(args);
	const env = requirePositional(args, 1, 'environment slug');
	const deploymentId = requirePositional(args, 2, 'deployment id');
	const client = await authenticatedClient();
	const { deployment, raw } = await client.promoteEnvironment(project, env, deploymentId);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(
		`Moved ${env} in ${project} to ${deployment.shortId ?? deployment.id ?? deploymentId}.`,
	);
}

/** Kept for callers that want one environment's details without a table. */
export function formatEnvironment(environment: EnvironmentView): string {
	return environmentDetails(environment).join('\n');
}
