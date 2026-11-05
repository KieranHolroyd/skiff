import { parseArgs, rejectExtraPositionals, requirePositional, type FlagSpec } from '../args.ts';
import { parseMegabytes } from '../databases.ts';
import { CliError, UsageError } from '../errors.ts';
import { indent, printJson } from '../output.ts';
import {
	volumeDetails,
	volumeTable,
	type AppVolumeView,
} from '../volumes.ts';
import { authenticatedClient } from './common.ts';
import { confirmOrRefuse } from './run-operation.ts';

/**
 * App volumes (plan 07). Every rule lives on the server: this is a thin client. Mount paths are
 * paths inside the workload sandbox, never host paths.
 */

const usage = `Usage: skif volume <command> [options]

Commands:
  list                         List a project's volumes (the default)
  create <name>                Create a volume with a size quota
  attach <name>                Mount a volume into the project's workload
  detach <name>                Unmount it; the data is untouched
  delete <name>                Soft-delete it (refused while attached; data kept 7 days)

Create options:
  -p, --project <slug>         Project that owns the volume (required)
      --size <size>            Quota, e.g. 1G or 512M (default 1G)
      --backing <kind>         state-dir (default) or node-volume
      --node-volume <name>     Registered node volume, required for --backing node-volume
      --[no-]single-writer     Refuse a second read-write attachment (default on)

Attach/detach options:
  -p, --project <slug>         Project that owns the volume (required)
  -m, --mount <path>           Absolute sandbox path, e.g. /var/lib/app (attach only)
      --workload <id|slug>     Workload id or project slug (defaults to the project)
      --env <name>             Environment label (default production)
      --read-only              Mount read-only

Options:
  -y, --yes                    Don't ask before deleting (required without a terminal)
      --json                   JSON output
  -h, --help                   Show this help

Examples:
  skif volume create app-data --project api --size 2G
  skif volume attach app-data --project api --mount /var/lib/app
  skif volume list --project api
  skif volume delete app-data --project api --yes`;

const baseFlags: FlagSpec = {
	json: { type: 'boolean' },
	help: { type: 'boolean', short: 'h' },
};

const projectFlags: FlagSpec = {
	...baseFlags,
	project: { type: 'string', short: 'p' },
};

const createFlags: FlagSpec = {
	...projectFlags,
	size: { type: 'string' },
	backing: { type: 'string' },
	'node-volume': { type: 'string' },
	'single-writer': { type: 'boolean' },
};

const attachFlags: FlagSpec = {
	...projectFlags,
	mount: { type: 'string', short: 'm' },
	workload: { type: 'string' },
	env: { type: 'string' },
	'read-only': { type: 'boolean' },
};

const detachFlags: FlagSpec = {
	...projectFlags,
	workload: { type: 'string' },
	env: { type: 'string' },
};

const deleteFlags: FlagSpec = { ...projectFlags, yes: { type: 'boolean', short: 'y' } };

const subcommands: Record<string, (argv: string[]) => Promise<void>> = {
	list: listVolumes,
	ls: listVolumes,
	create: createVolume,
	attach: attachVolume,
	detach: detachVolume,
	delete: deleteVolume,
	rm: deleteVolume,
};

export async function volumeCommand(argv: string[]): Promise<void> {
	const first = argv[0];
	if (first && !first.startsWith('-')) {
		const handler = subcommands[first];
		if (!handler) throw new UsageError(`Unknown volume command "${first}".\n\n${usage}`);
		await handler(argv.slice(1));
		return;
	}
	await listVolumes(argv);
}

function projectOf(args: ReturnType<typeof parseArgs>): string {
	const project = args.string('project');
	if (!project) throw new UsageError('Name the project: --project <slug>.');
	return project;
}

function parseNamed(argv: string[], spec: FlagSpec, command: string) {
	const args = parseArgs(argv, spec);
	if (args.boolean('help')) {
		console.log(usage);
		return null;
	}
	const line = `Usage: skif volume ${command} <name> --project <slug>`;
	rejectExtraPositionals(args, 1, line);
	const name = requirePositional(args, 0, `volume name.\n\n${line}`);
	return { args, name };
}

async function listVolumes(argv: string[]): Promise<void> {
	const args = parseArgs(argv, projectFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 0, 'Usage: skif volume list --project <slug> [--json]');
	const project = projectOf(args);
	const client = await authenticatedClient();
	const { volumes, raw } = await client.listVolumes(project);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	if (volumes.length === 0) {
		console.log(`No volumes in ${project}. Create one with \`skif volume create <name> --project ${project}\`.`);
		return;
	}
	console.log(volumeTable(volumes));
}

async function createVolume(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, createFlags, 'create');
	if (!parsed) return;
	const { args, name } = parsed;
	const project = projectOf(args);
	const input: {
		name: string;
		sizeMb?: number;
		backing?: 'state_dir' | 'node_volume';
		nodeVolume?: string;
		singleWriter?: boolean;
	} = { name };
	const size = args.string('size');
	if (size) input.sizeMb = parseMegabytes(size, '--size');
	const backing = args.string('backing');
	if (backing) {
		if (backing !== 'state-dir' && backing !== 'state_dir' && backing !== 'node-volume' && backing !== 'node_volume')
			throw new UsageError('--backing expects "state-dir" or "node-volume".');
		input.backing = backing.startsWith('node') ? 'node_volume' : 'state_dir';
	}
	const nodeVolume = args.string('node-volume');
	if (nodeVolume) input.nodeVolume = nodeVolume;
	if (args.has('single-writer')) input.singleWriter = args.boolean('single-writer');

	const client = await authenticatedClient();
	const { volume, raw } = await client.createVolume(project, input);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(`Created volume "${volume.name}" in ${project} (${volume.sizeMb} MB, ${volume.backing}).`);
	console.log(
		`\nNext steps:\n${indent([
			`Attach:  skif volume attach ${volume.name} --project ${project} --mount /var/lib/app`,
			`Inspect: skif volume list --project ${project}`,
		])}`,
	);
}

async function attachVolume(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, attachFlags, 'attach');
	if (!parsed) return;
	const { args, name } = parsed;
	const project = projectOf(args);
	const mountPath = args.string('mount');
	if (!mountPath) throw new UsageError('Choose a mount path: --mount /var/lib/app.');
	const client = await authenticatedClient();
	const { volume, raw } = await client.attachVolume(project, name, {
		mountPath,
		...(args.string('workload') ? { workload: args.string('workload')! } : {}),
		...(args.string('env') ? { environment: args.string('env')! } : {}),
		readOnly: args.boolean('read-only'),
	});
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	const attachment = volume.attachments.find((item) => item.mountPath === mountPath);
	console.log(
		`Attached ${volume.name} at ${mountPath}${attachment?.readOnly ? ' read-only' : ''} in ${project}. The workload restarts with the mount.`,
	);
}

async function detachVolume(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, detachFlags, 'detach');
	if (!parsed) return;
	const { args, name } = parsed;
	const project = projectOf(args);
	const client = await authenticatedClient();
	const { volume, raw } = await client.detachVolume(project, name, {
		...(args.string('workload') ? { workload: args.string('workload')! } : {}),
		...(args.string('env') ? { environment: args.string('env')! } : {}),
	});
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	const remaining = volume.attachments.length;
	console.log(
		remaining === 0
			? `Detached ${name}; the workload restarts without the mount. The volume and its data are untouched.`
			: `Detached ${name}; ${remaining} read-only attachment${remaining === 1 ? '' : 's'} remain.`,
	);
}

async function deleteVolume(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, deleteFlags, 'delete');
	if (!parsed) return;
	const { args, name } = parsed;
	const project = projectOf(args);
	const client = await authenticatedClient();
	const { volume: current } = await client.getVolume(project, name);
	if (current.attachments.length > 0)
		throw new CliError(
			`Volume "${name}" is still attached. Detach it first; its data is kept for 7 days after deletion.`,
			{
				code: 'conflict',
				suggestions: current.attachments.map(
					(item) => `skif volume detach ${name} --project ${project} --env ${item.environment}`,
				),
			},
		);
	const confirmed = await confirmOrRefuse(
		`Delete volume "${name}"? The data stays on its backing for 7 days; the volume can no longer be mounted. [y/N] `,
		{
			yes: args.boolean('yes'),
			refusal: `Not confirmed: stdin is not a terminal, so there's no one to ask before deleting "${name}".`,
		},
	);
	if (!confirmed) {
		console.error('Cancelled. Nothing was changed.');
		process.exitCode = 1;
		return;
	}
	const result = await client.deleteVolume(project, name);
	if (args.boolean('json')) {
		printJson(result.raw);
		return;
	}
	console.log(`Deleted ${name}. Its data is retained until ${result.purgeAt}.`);
}
