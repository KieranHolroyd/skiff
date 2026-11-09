import { parseArgs, rejectExtraPositionals, requirePositional, type FlagSpec } from '../args.ts';
import { UsageError } from '../errors.ts';
import { formatTime, renderTable } from '../output.ts';
import { authenticatedClient } from './common.ts';
import { confirmOrRefuse } from './run-operation.ts';
import type { BackupTargetCreateInput, BackupTargetView } from '../api.ts';

/** Backup targets (plan 05, docs/BACKUPS.md). Checks live on the server; this is a thin client. */

const usage = `Usage: yoal backup-target <command> [options]

Commands:
  list                         List backup targets (the default)
  add <name>                   Add a local or S3-compatible target
  test <id>                    Probe a target and show the result
  remove <id>                  Delete a target that holds no retained backups (--force to override)

Add options:
      --kind <local|s3>        Target kind (default s3)
      --path <dir>             Local directory, e.g. /var/lib/yoal/backups
      --endpoint <url>         S3 endpoint (R2, MinIO, RustFS, Garage); omit for AWS
      --bucket <name>          S3 bucket
      --region <region>        SigV4 region (default us-east-1; R2 uses auto)
      --prefix <path>          Key prefix inside the bucket (default yoal/backups)
      --access-key <id>        S3 access key id
      --secret-key <secret>    S3 secret access key (shown once by the server)
      --write-only             The key can put/list but not delete; retention uses a privileged key
      --object-lock            The bucket has object lock enabled
      --platform               Create the platform default (platform admins only)

Remove options:
      --force                  Delete even though backups were written to the target. They stay
                               listed but cannot be restored until a target with the same location
                               is added again. Objects are never deleted.

Options:
  -y, --yes                    Don't ask for confirmation (required when stdin isn't a terminal)
      --json                   JSON output
  -h, --help                   Show this help

Secrets are sealed with the org key. \`add\` prints them once when they were supplied; list and
test never return them. A target is used by the next backup after it becomes the one that
applies (the org's oldest target, else the platform default). Existing backups stay where they
were written: each backup records its target and exact location, and restore and retention use
that record. So a target that still holds retained backups cannot be removed (without --force)
or have its path, endpoint, bucket or prefix changed.

Examples:
  yoal backup-target add local --kind local --path /var/lib/yoal/backups
  yoal backup-target add garage --kind s3 --endpoint https://s3.internal:3900 --bucket yoal \\
    --access-key "$KEY" --secret-key "$SECRET" --write-only
  yoal backup-target test bt_abc123`;

const baseFlags: FlagSpec = {
	json: { type: 'boolean' },
	help: { type: 'boolean', short: 'h' },
};

const addFlags: FlagSpec = {
	...baseFlags,
	kind: { type: 'string' },
	path: { type: 'string' },
	endpoint: { type: 'string' },
	bucket: { type: 'string' },
	region: { type: 'string' },
	prefix: { type: 'string' },
	'access-key': { type: 'string' },
	'secret-key': { type: 'string' },
	'write-only': { type: 'boolean' },
	'object-lock': { type: 'boolean' },
	platform: { type: 'boolean' },
};

const removeFlags: FlagSpec = { ...baseFlags, yes: { type: 'boolean', short: 'y' }, force: { type: 'boolean' } };

export async function backupTargetCommand(argv: string[]): Promise<void> {
	const first = argv[0];
	if (first && !first.startsWith('-')) {
		const handler = subcommands[first];
		if (!handler) throw new UsageError(`Unknown backup-target command "${first}".\n\n${usage}`);
		await handler(argv.slice(1));
		return;
	}
	await listTargets(argv);
}

const subcommands: Record<string, (argv: string[]) => Promise<void>> = {
	list: listTargets,
	ls: listTargets,
	add: addTarget,
	create: addTarget,
	test: testTarget,
	remove: removeTarget,
	rm: removeTarget,
	delete: removeTarget,
};

async function listTargets(argv: string[]): Promise<void> {
	const args = parseArgs(argv, baseFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 0, 'Usage: yoal backup-target list [--json]');
	const client = await authenticatedClient();
	const { targets, raw } = await client.listBackupTargets();
	if (args.boolean('json')) {
		console.log(JSON.stringify(raw ?? null, null, 2));
		return;
	}
	if (targets.length === 0) {
		console.log('No backup targets. Backups use the platform object store until one is added.');
		return;
	}
	console.log(
		renderTable(
			['ID', 'NAME', 'KIND', 'SCOPE', 'STATUS', 'CHECKED', 'LOCATION'],
			targets.map((target) => [
				target.id,
				target.name,
				target.kind,
				target.orgId === null ? 'platform' : 'org',
				target.status,
				formatTime(target.lastCheckedAt ?? undefined),
				location(target),
			]),
		),
	);
}

async function addTarget(argv: string[]): Promise<void> {
	const args = parseArgs(argv, addFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 1, 'Usage: yoal backup-target add <name> [options]');
	const name = requirePositional(args, 0, `backup target name.\n\n${usage}`);
	const kind = args.string('kind') ?? 's3';
	let input: BackupTargetCreateInput;
	if (kind === 'local') {
		const path = args.string('path');
		if (!path) throw new UsageError('A local target needs --path, e.g. /var/lib/yoal/backups.');
		input = { name, kind: 'local', path, ...(args.boolean('write-only') ? { writeOnly: true } : {}) };
	} else if (kind === 's3') {
		const bucket = args.string('bucket');
		const accessKeyId = args.string('access-key');
		const secretAccessKey = args.string('secret-key');
		if (!bucket || !accessKeyId || !secretAccessKey)
			throw new UsageError('An S3 target needs --bucket, --access-key and --secret-key.');
		input = {
			name,
			kind: 's3',
			bucket,
			accessKeyId,
			secretAccessKey,
			...(args.string('endpoint') ? { endpoint: args.string('endpoint')! } : {}),
			...(args.string('region') ? { region: args.string('region')! } : {}),
			...(args.string('prefix') ? { pathPrefix: args.string('prefix')! } : {}),
			...(args.boolean('write-only') ? { writeOnly: true } : {}),
			...(args.boolean('object-lock') ? { objectLock: true } : {}),
		};
	} else {
		throw new UsageError('--kind must be "local" or "s3".');
	}
	const client = await authenticatedClient();
	const { target, credentials, raw } = await client.createBackupTarget(input, {
		platform: args.boolean('platform'),
	});
	if (args.boolean('json')) {
		console.log(JSON.stringify(raw ?? null, null, 2));
		return;
	}
	console.log(`Created backup target ${target.id} (${target.name}, ${target.kind}).`);
	if (credentials) {
		console.log('');
		console.log(`Access key  ${credentials.accessKeyId}`);
		console.log(`Secret key  ${credentials.secretAccessKey}`);
		console.log('');
		console.log(credentials.note);
	}
	console.log(`Test it with: yoal backup-target test ${target.id}`);
}

async function testTarget(argv: string[]): Promise<void> {
	const args = parseArgs(argv, baseFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 1, 'Usage: yoal backup-target test <id>');
	const id = requirePositional(args, 0, `backup target id.\n\n${usage}`);
	const client = await authenticatedClient();
	const { result, raw } = await client.testBackupTarget(id);
	if (args.boolean('json')) {
		console.log(JSON.stringify(raw ?? null, null, 2));
		return;
	}
	console.log(`${result.ok ? 'OK' : 'FAILED'}  ${result.message}`);
	if (result.versioning !== null) console.log(`Versioning   ${result.versioning ? 'enabled' : 'disabled'}`);
	if (result.objectLock !== null) console.log(`Object lock  ${result.objectLock ? 'enabled' : 'disabled'}`);
}

async function removeTarget(argv: string[]): Promise<void> {
	const args = parseArgs(argv, removeFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 1, 'Usage: yoal backup-target remove <id> [--force] [--yes]');
	const id = requirePositional(args, 0, `backup target id.\n\n${usage}`);
	const force = args.boolean('force');
	const confirmed = await confirmOrRefuse(
		force
			? `Delete backup target ${id} even if backups were written to it? They stay listed but cannot be restored until a target with the same location is added again.`
			: `Delete backup target ${id}? Existing backups are not deleted.`,
		{
			yes: args.boolean('yes'),
			refusal: 'A backup target needs confirmation.',
		},
	);
	if (!confirmed) {
		console.log('Cancelled.');
		return;
	}
	const client = await authenticatedClient();
	const raw = await client.deleteBackupTarget(id, { force });
	if (args.boolean('json')) {
		console.log(JSON.stringify(raw ?? null, null, 2));
		return;
	}
	const unavailable = Number((raw as { unavailableBackups?: unknown } | null)?.unavailableBackups ?? 0);
	console.log(`Deleted backup target ${id}.`);
	if (unavailable > 0)
		console.log(
			`${unavailable} backup${unavailable === 1 ? ' is' : 's are'} now unavailable. Their objects were not removed; add a target with the same location to reconnect them.`,
		);
}

function location(target: BackupTargetView): string {
	if (target.kind === 'local') return target.path ?? '-';
	return `${target.endpoint ?? 'aws'} ${target.bucket ?? '-'}/${target.pathPrefix}`.trim();
}
