import { parseArgs, rejectExtraPositionals, requirePositional, type FlagSpec } from '../args.ts';
import { parseMegabytes } from '../databases.ts';
import { CliError, UsageError } from '../errors.ts';
import { indent, printJson } from '../output.ts';
import {
	nearQuotaWarning,
	snapshotDetails,
	snapshotTable,
	volumeDetails,
	volumeTable,
} from '../volumes.ts';
import { authenticatedClient } from './common.ts';
import { pruneCommand } from './prune.ts';
import { confirmOrRefuse } from './run-operation.ts';

/**
 * App volumes (plan 07). Every rule lives on the server: this is a thin client. Mount paths are
 * paths inside the workload sandbox, never host paths.
 */

const usage = `Usage: yoal volume <command> [options]

Commands:
  list                         List a project's volumes (the default)
  show <name>                  Usage, attachments and recent snapshots of one volume
  create <name>                Create a volume with a size quota
  attach <name>                Mount a volume into the project's workload
  detach <name>                Unmount it; the data is untouched
  delete <name>                Soft-delete it (refused while attached; data kept 7 days)
  snapshot <name>              Snapshot it to a backup target (pauses the writer while copying)
  snapshots <name>             List its snapshots
  restore <name> <snapshot>    Restore a snapshot into a NEW volume (--to <new-name>)
  snapshot-delete <name> <snapshot>
                               Delete a snapshot and its archive
  prune                        Delete old unpinned snapshots by retention (dry run by default)

Create options:
  -p, --project <slug>         Project that owns the volume (required)
      --size <size>            Quota, e.g. 1G or 512M (default 1G)
      --disk <where>           system, fast, bulk or a disk name (default: Settings → Storage)
      --[no-]single-writer     Refuse a second read-write attachment (default on)

Attach/detach options:
  -p, --project <slug>         Project that owns the volume (required)
  -m, --mount <path>           Absolute sandbox path, e.g. /var/lib/app (attach only)
      --workload <id|slug>     Workload id or project slug (defaults to the project)
      --env <name>             Environment label (default production)
      --read-only              Mount read-only

Snapshot options:
  -p, --project <slug>         Project that owns the volume (required)
      --label <text>           A note to find it by later
      --target <name>          Backup target (default: the org's, then the platform's)
      --pin                    Mark it pinned
      --no-quiesce             Copy without pausing the writer (may be inconsistent)

Restore options:
  -p, --project <slug>         Project that owns the volume (required)
      --to <name>              Name of the new volume (required)
      --size <size>            Quota of the new volume (default and minimum: the source's)

Options:
  -y, --yes                    Don't ask before deleting (required without a terminal)
      --json                   JSON output
  -h, --help                   Show this help

Examples:
  yoal volume create app-data --project api --size 2G
  yoal volume attach app-data --project api --mount /var/lib/app
  yoal volume list --project api
  yoal volume snapshot app-data --project api --label "before v2 migration"
  yoal volume restore app-data avs_123 --project api --to app-data-copy
  yoal volume delete app-data --project api --yes`;

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
	disk: { type: 'string' },
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

const snapshotFlags: FlagSpec = {
	...projectFlags,
	label: { type: 'string' },
	target: { type: 'string' },
	pin: { type: 'boolean' },
	quiesce: { type: 'boolean' },
};

const restoreFlags: FlagSpec = { ...projectFlags, to: { type: 'string' }, size: { type: 'string' } };

const subcommands: Record<string, (argv: string[]) => Promise<void>> = {
	list: listVolumes,
	ls: listVolumes,
	show: showVolume,
	get: showVolume,
	create: createVolume,
	snapshot: snapshotVolume,
	snapshots: listSnapshots,
	restore: restoreVolume,
	'snapshot-delete': deleteSnapshot,
	prune: (argv) => pruneCommand(['--only', 'volume_snapshots', ...argv]),
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
	const line = `Usage: yoal volume ${command} <name> --project <slug>`;
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
	rejectExtraPositionals(args, 0, 'Usage: yoal volume list --project <slug> [--json]');
	const project = projectOf(args);
	const client = await authenticatedClient();
	const { volumes, raw } = await client.listVolumes(project);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	if (volumes.length === 0) {
		console.log(`No volumes in ${project}. Create one with \`yoal volume create <name> --project ${project}\`.`);
		return;
	}
	console.log(volumeTable(volumes));
	for (const volume of volumes) {
		const warning = nearQuotaWarning(volume);
		if (warning) console.error(`Warning: ${warning}`);
	}
}

/** `<name> <snapshot-id>` for the commands that act on one snapshot. */
function parseSnapshotTarget(argv: string[], spec: FlagSpec, command: string) {
	const args = parseArgs(argv, spec);
	if (args.boolean('help')) {
		console.log(usage);
		return null;
	}
	const line = `Usage: yoal volume ${command} <name> <snapshot-id> --project <slug>`;
	rejectExtraPositionals(args, 2, line);
	const name = requirePositional(args, 0, `volume name.\n\n${line}`);
	const snapshotId = requirePositional(args, 1, `snapshot id (see \`yoal volume snapshots ${name}\`).\n\n${line}`);
	return { args, name, snapshotId };
}

async function showVolume(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, projectFlags, 'show');
	if (!parsed) return;
	const { args, name } = parsed;
	const project = projectOf(args);
	const client = await authenticatedClient();
	const { volume, raw } = await client.getVolume(project, name);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(volumeDetails(volume));
}

async function snapshotVolume(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, snapshotFlags, 'snapshot');
	if (!parsed) return;
	const { args, name } = parsed;
	const project = projectOf(args);
	const client = await authenticatedClient();
	const { snapshot, warning, raw } = await client.snapshotVolume(project, name, {
		...(args.string('label') ? { label: args.string('label')! } : {}),
		...(args.string('target') ? { target: args.string('target')! } : {}),
		...(args.has('pin') ? { pinned: args.boolean('pin') } : {}),
		...(args.has('quiesce') ? { quiesce: args.boolean('quiesce') } : {}),
	});
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(
		`Queued snapshot ${snapshot.id} of ${name} to ${snapshot.target?.name ?? 'the platform object store'}. Its node picks it up within a few seconds.`,
	);
	if (warning) console.error(`Warning: ${warning}`);
	console.log(
		`\nNext steps:\n${indent([
			`Follow:  yoal volume snapshots ${name} --project ${project}`,
			`Restore: yoal volume restore ${name} ${snapshot.id} --project ${project} --to ${name}-restored`,
		])}`,
	);
}

async function listSnapshots(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, projectFlags, 'snapshots');
	if (!parsed) return;
	const { args, name } = parsed;
	const project = projectOf(args);
	const client = await authenticatedClient();
	const { snapshots, raw } = await client.listVolumeSnapshots(project, name);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	if (snapshots.length === 0) {
		console.log(`No snapshots of ${name}. Take one with \`yoal volume snapshot ${name} --project ${project}\`.`);
		return;
	}
	console.log(snapshotTable(snapshots));
	const failed = snapshots.find((item) => item.status === 'failed');
	if (failed) console.log(`\nLatest failure:\n${indent(snapshotDetails(failed).split('\n'))}`);
}

async function restoreVolume(argv: string[]): Promise<void> {
	const parsed = parseSnapshotTarget(argv, restoreFlags, 'restore');
	if (!parsed) return;
	const { args, name, snapshotId } = parsed;
	const project = projectOf(args);
	const target = args.string('to');
	if (!target) throw new UsageError('Name the new volume: --to <name>. A restore never overwrites the source.');
	const size = args.string('size');
	const client = await authenticatedClient();
	const { volume, raw } = await client.restoreVolumeSnapshot(project, name, snapshotId, {
		name: target,
		...(size ? { sizeMb: parseMegabytes(size, '--size') } : {}),
	});
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(
		`Restoring ${snapshotId} into new volume "${volume.name}" (${volume.sizeMb} MB). It can be attached once its node finishes.`,
	);
	console.log(
		`\nNext steps:\n${indent([
			`Follow: yoal volume show ${volume.name} --project ${project}`,
			`Attach: yoal volume attach ${volume.name} --project ${project} --mount /var/lib/app`,
		])}`,
	);
}

async function deleteSnapshot(argv: string[]): Promise<void> {
	const parsed = parseSnapshotTarget(argv, deleteFlags, 'snapshot-delete');
	if (!parsed) return;
	const { args, name, snapshotId } = parsed;
	const project = projectOf(args);
	const confirmed = await confirmOrRefuse(
		`Delete snapshot ${snapshotId} of "${name}" and its archive? This cannot be undone. [y/N] `,
		{
			yes: args.boolean('yes'),
			refusal: `Not confirmed: stdin is not a terminal, so there's no one to ask before deleting ${snapshotId}.`,
		},
	);
	if (!confirmed) {
		console.error('Cancelled. Nothing was changed.');
		process.exitCode = 1;
		return;
	}
	const client = await authenticatedClient();
	const { raw } = await client.deleteVolumeSnapshot(project, name, snapshotId);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(`Deleted snapshot ${snapshotId} of ${name}.`);
}

async function createVolume(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, createFlags, 'create');
	if (!parsed) return;
	const { args, name } = parsed;
	const project = projectOf(args);
	const input: {
		name: string;
		sizeMb?: number;
		storage?: string;
		singleWriter?: boolean;
	} = { name };
	const size = args.string('size');
	if (size) input.sizeMb = parseMegabytes(size, '--size');
	const disk = args.string('disk');
	if (disk) input.storage = disk;
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
			`Attach:  yoal volume attach ${volume.name} --project ${project} --mount /var/lib/app`,
			`Inspect: yoal volume list --project ${project}`,
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
					(item) => `yoal volume detach ${name} --project ${project} --env ${item.environment}`,
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
