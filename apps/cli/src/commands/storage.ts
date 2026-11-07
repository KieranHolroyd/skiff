import { parseArgs, rejectExtraPositionals, requirePositional, type FlagSpec, type ParsedArgs } from '../args.ts';
import { CliError, UsageError } from '../errors.ts';
import { assertEnvPrefix, parseCpus, parseMegabytes } from '../databases.ts';
import {
	bucketConfigDetails,
	bucketTable,
	credentialsEnv,
	defaultGrants,
	grantsLabel,
	metricsTable,
	nodeLabel,
	parseAccess,
	parseCorsRules,
	parseDuration,
	parseGrants,
	parseLifecycleRules,
	parseObjectLock,
	rootKeyLabel,
	splitList,
	storageDetails,
	storageKeyEnv,
	storageKeysTable,
	storageTable,
	usedVsBudget,
	type BucketConfigInput,
	type StorageKeyCreateInput,
	type StorageCreateInput,
	type StorageUpdateInput,
} from '../object-storage.ts';
import { formatTime, indent, plural, printJson } from '../output.ts';
import { authenticatedClient } from './common.ts';
import { storageObjectsCommand } from './storage-objects.ts';
import { confirmOrRefuse } from './run-operation.ts';

/** Managed object storage (docs/OBJECT-STORAGE.md). Every check lives on the server; this is a thin client. */

const usage = `Usage: skif storage <command> [options]

Commands:
  list                           List storage instances (the default); --all includes the trash
  create <name>                  Create an S3-compatible storage instance (RustFS)
  info <name>                    Status, node, endpoints, usage, buckets and attached projects
  update <name>                  Change limits, version or public access
  restart <name>|--all           Restart the RustFS container (buckets and objects are kept)
  delete <name>                  Move it to the trash (restorable for 7 days)
  restore <name>                 Bring it back from the trash
  purge <name>                   Permanently delete a trashed instance and its objects
  credentials <name>             Print the root key as env lines (--json for everything)
  rotate-root <name>             Replace the root key (RustFS restarts; --cancel abandons a rotation)
  keys <command>                 list|create|reveal|revoke named keys (\`skif storage keys --help\`)
  move <name> --node <id>        Move it to another node, empty (objects are not copied)
  metrics <name>                 Usage samples (--since 1h, or --from/--to; --interval 1m|1h)
  buckets <command>              list|create|update|delete buckets (\`skif storage buckets --help\`)
  objects <command>              Browse and manage bucket contents (\`skif storage objects --help\`)
  attach <name> -p <project>     Give a project a scoped key (injects <PREFIX>_ENDPOINT_URL, …)
  grants <name> -p <project>     Replace an attachment's bucket grants
  detach <name> -p <project>     Revoke it; the app restarts without the variables

Create options:
  -b, --bucket <name>            Create a private bucket (repeatable, or comma-separated)
  -p, --project <slug>           Attach to this project right away (read-write on every bucket)
      --prefix <PREFIX>          Env prefix for the attachment (default S3; AWS for AWS SDK names)
      --public                   Serve the S3 API at https://<name>--s3.<content domain>
      --placement <where>        auto (default), edge, or a node id
      --memory <size>            Memory limit, e.g. 512M or 1G (default 512M)
      --cpus <n>                 CPU limit (default 1)
      --storage <size>           Storage budget for alerts and the gauge (default 10G)

Update options:
      --memory <size>  --cpus <n>  --storage <size>  --version <v>  --public | --no-public

Attach and grants options:
  -p, --project <slug>           The project
  -b, --bucket <b>[:read|:read-write]
                                 Grant a bucket (repeatable; read-write by default). attach
                                 without --bucket grants the only bucket when there is one
      --prefix <PREFIX>          Env prefix (attach only; default S3)

Options:
  -y, --yes                      Don't ask for confirmation (required when stdin isn't a terminal)
      --json                     JSON output
  -h, --help                     Show this help

Attached apps get <PREFIX>_ENDPOINT_URL, _ACCESS_KEY_ID, _SECRET_ACCESS_KEY, _REGION and
_FORCE_PATH_STYLE at activation, plus _BUCKET with exactly one grant and _PUBLIC_ENDPOINT_URL when
public. Use path-style addressing. A private instance serves apps on its own node only. The root
key needs the storage:credentials permission and every read is audited.

Examples:
  skif storage create media --bucket uploads --project api --prefix AWS
  skif storage attach media --project worker --bucket uploads:read
  set -a; eval "$(skif storage credentials media)"; set +a; aws s3 ls`;

const keysUsage = `Usage: skif storage keys <command> <storage> [key id] [options]

Named keys are scoped to buckets, for a person or an outside service. Apps on Skiff get their own
key with \`skif storage attach\` instead.

Commands:
  list <storage>                     List keys with grants, status and expiry (the default)
  create <storage> <name>            Create a key (the secret is not printed; reveal it)
  reveal <storage> <key id>          Print a key as env lines (audited; needs storage:credentials)
  revoke <storage> <key id>          Revoke a key; the node removes it within a minute

Options:
  -b, --bucket <b>[:read|:read-write]
                                     Grant a bucket (create; repeatable; read-write by default)
      --purpose <text>               What the key is for (create)
      --expires <time>               Expiry as an ISO time, or a duration from now: 30d, 12h (create)
      --prefix <PREFIX>              Env prefix for reveal (default AWS)
  -y, --yes                          Don't ask for confirmation (revoke)
      --json                         JSON output
  -h, --help                         Show this help

Examples:
  skif storage keys create media backup-tool --bucket uploads:read --expires 90d
  skif storage keys reveal media stk_123 > .env`;

const bucketsUsage = `Usage: skif storage buckets <command> <storage> [bucket] [options]

Commands:
  list <storage>                     List buckets with access, state, size and objects (the default)
  create <storage> <bucket>          Create a bucket (--access private|public-read; default private)
  config <storage> <bucket>          Show versioning, lifecycle, CORS, quota, object lock and convergence
  update <storage> <bucket>          Change access or bucket configuration
  delete <storage> <bucket>          Delete an empty bucket; --force deletes its objects too

Options:
      --access <access>              private, or public-read (unsigned GETs of objects, no listing)
      --versioning <on|off>          Enable or suspend object versioning
      --quota <size|none>            Hard bucket quota, e.g. 1G, 500M; none removes it
      --lifecycle <json|@file>       Lifecycle rules as a JSON array
      --cors <json|@file>            CORS rules as a JSON array
      --object-lock <mode>:<days>    Create-only: governance:30 or compliance:365 (implies --versioning on)
      --force                        Empty the bucket first (needs storage:delete; cannot be undone)
  -y, --yes                          Don't ask for confirmation
      --json                         JSON output
  -h, --help                         Show this help

Object lock cannot be changed after creation. The node applies configuration within a minute and
reports configStatus (pending, converged, error or unsupported).`;

const baseFlags: FlagSpec = {
	json: { type: 'boolean' },
	help: { type: 'boolean', short: 'h' },
};

const listFlags: FlagSpec = { ...baseFlags, all: { type: 'boolean', short: 'a' } };
const restartFlags: FlagSpec = { ...baseFlags, all: { type: 'boolean' } };

const createFlags: FlagSpec = {
	...baseFlags,
	bucket: { type: 'string', short: 'b', multiple: true },
	project: { type: 'string', short: 'p' },
	prefix: { type: 'string' },
	public: { type: 'boolean' },
	version: { type: 'string' },
	placement: { type: 'string' },
	memory: { type: 'string' },
	cpus: { type: 'string' },
	storage: { type: 'string' },
};

const updateFlags: FlagSpec = {
	...baseFlags,
	public: { type: 'boolean' },
	version: { type: 'string' },
	memory: { type: 'string' },
	cpus: { type: 'string' },
	storage: { type: 'string' },
};

const attachFlags: FlagSpec = {
	...baseFlags,
	project: { type: 'string', short: 'p' },
	bucket: { type: 'string', short: 'b', multiple: true },
	prefix: { type: 'string' },
};

const grantsFlags: FlagSpec = {
	...baseFlags,
	project: { type: 'string', short: 'p' },
	bucket: { type: 'string', short: 'b', multiple: true },
};

const detachFlags: FlagSpec = { ...baseFlags, project: { type: 'string', short: 'p' } };

const confirmFlags: FlagSpec = { ...baseFlags, yes: { type: 'boolean', short: 'y' } };

const credentialsFlags: FlagSpec = { ...baseFlags, prefix: { type: 'string' } };

const metricsFlags: FlagSpec = {
	...baseFlags,
	since: { type: 'string' },
	from: { type: 'string' },
	to: { type: 'string' },
	interval: { type: 'string' },
};

const bucketFlags: FlagSpec = {
	...baseFlags,
	access: { type: 'string' },
	versioning: { type: 'string' },
	quota: { type: 'string' },
	lifecycle: { type: 'string' },
	cors: { type: 'string' },
	'object-lock': { type: 'string' },
	force: { type: 'boolean' },
	yes: { type: 'boolean', short: 'y' },
};

const keysFlags: FlagSpec = {
	...baseFlags,
	bucket: { type: 'string', short: 'b', multiple: true },
	purpose: { type: 'string' },
	expires: { type: 'string' },
	prefix: { type: 'string' },
	yes: { type: 'boolean', short: 'y' },
};

const moveFlags: FlagSpec = {
	...baseFlags,
	node: { type: 'string' },
	volume: { type: 'string' },
	yes: { type: 'boolean', short: 'y' },
};

const rotateFlags: FlagSpec = { ...baseFlags, cancel: { type: 'boolean' }, yes: { type: 'boolean', short: 'y' } };

const subcommands: Record<string, (argv: string[]) => Promise<void>> = {
	list: listStorage,
	ls: listStorage,
	create: createStorage,
	info: showStorage,
	show: showStorage,
	update: updateStorage,
	set: updateStorage,
	restart: restartStorage,
	logs: storageLogs,
	delete: deleteStorage,
	rm: deleteStorage,
	restore: restoreStorage,
	purge: purgeStorage,
	credentials: showCredentials,
	creds: showCredentials,
	'rotate-root': rotateRootKey,
	keys: keysCommand,
	key: keysCommand,
	move: moveStorage,
	metrics: showMetrics,
	buckets: bucketsCommand,
	bucket: bucketsCommand,
	objects: storageObjectsCommand,
	object: storageObjectsCommand,
	attach: attachStorage,
	grants: updateGrants,
	grant: updateGrants,
	detach: detachStorage,
};

export async function storageCommand(argv: string[]): Promise<void> {
	const first = argv[0];
	if (first && !first.startsWith('-')) {
		const handler = subcommands[first];
		if (!handler) throw new UsageError(`Unknown storage command "${first}".\n\n${usage}`);
		await handler(argv.slice(1));
		return;
	}
	await listStorage(argv);
}

/** Parse, handle --help, and return the single `<name>` positional. */
function parseNamed(argv: string[], spec: FlagSpec, command: string) {
	const args = parseArgs(argv, spec);
	if (args.boolean('help')) {
		console.log(usage);
		return null;
	}
	const line = `Usage: skif storage ${command} <name>`;
	rejectExtraPositionals(args, 1, line);
	const name = requirePositional(args, 0, `storage name.\n\n${line}`);
	return { args, name };
}

function requireProject(project: string | undefined, command: string, name: string): string {
	if (!project) throw new UsageError(`Name the project: skif storage ${command} ${name} --project <slug>`);
	return project;
}

function cancelled(): void {
	console.error('Cancelled. Nothing was changed.');
	process.exitCode = 1;
}

async function listStorage(argv: string[]): Promise<void> {
	const args = parseArgs(argv, listFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 0, 'Usage: skif storage list [--all] [--json]');
	const client = await authenticatedClient();
	const { storage, raw } = await client.listStorage({ includeDeleted: args.boolean('all') });
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	if (storage.length === 0) {
		console.log('No storage yet. Create one with `skif storage create <name> --bucket <bucket>`.');
		return;
	}
	console.log(storageTable(storage));
}

/** `--memory`, `--cpus`, `--storage`, `--version`: shared by create and update. */
function readLimits(args: ParsedArgs, input: StorageCreateInput | StorageUpdateInput): void {
	const version = args.string('version');
	if (version) input.version = version;
	const memory = args.string('memory');
	if (memory) input.memoryMb = parseMegabytes(memory, '--memory');
	const cpus = args.string('cpus');
	if (cpus) input.cpus = parseCpus(cpus);
	const storage = args.string('storage');
	if (storage) input.storageMb = parseMegabytes(storage, '--storage');
}

async function createStorage(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, createFlags, 'create');
	if (!parsed) return;
	const { args, name } = parsed;
	const prefix = args.string('prefix');
	const project = args.string('project');
	const buckets = splitList(args.strings('bucket'));
	if (prefix !== undefined) {
		if (!project) throw new UsageError('--prefix needs --project (it names the attachment).');
		assertEnvPrefix(prefix);
	}
	if (project && buckets.length === 0)
		throw new UsageError('--project needs at least one --bucket: the project is granted read-write on the buckets created here.');
	const input: StorageCreateInput = { name };
	if (buckets.length > 0) input.buckets = buckets;
	if (project) input.project = project;
	if (prefix) input.envPrefix = prefix;
	if (args.boolean('public')) input.public = true;
	const placement = args.string('placement');
	if (placement) input.placement = placement;
	readLimits(args, input);

	const client = await authenticatedClient();
	const { storage, raw } = await client.createStorage(input);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	const bucketNote = storage.buckets.length ? ` with ${plural(storage.buckets.length, 'bucket')}` : '';
	console.log(`Created storage "${storage.name}"${bucketNote} on node ${nodeLabel(storage)} (${storage.status}).`);
	if (storage.publicUrl) console.log(`Public endpoint: ${storage.publicUrl}`);
	const attached = storage.attachments[0];
	if (attached)
		console.log(
			`Attached to ${attached.projectSlug} as ${attached.envPrefix}: it receives ${attached.envNames.join(', ')} at its next activation.`,
		);
	const steps = [
		`Follow it:    skif storage info ${storage.name}`,
		...(storage.buckets.length ? [] : [`Add a bucket: skif storage buckets create ${storage.name} <bucket>`]),
		...(attached ? [] : [`Attach:       skif storage attach ${storage.name} --project <slug>`]),
		`Root key:     skif storage credentials ${storage.name}`,
	];
	console.log(`\nNext steps:\n${indent(steps)}`);
}

async function showStorage(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, baseFlags, 'info');
	if (!parsed) return;
	const { args, name } = parsed;
	const client = await authenticatedClient();
	const { storage, raw } = await client.getStorage(name, { includeDeleted: true });
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(storageDetails(storage));
	if (storage.deletedAt)
		console.log(
			`\nIn the trash. Restore with \`skif storage restore ${storage.name}\`; delete for good with \`skif storage purge ${storage.name}\`.`,
		);
}

async function updateStorage(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, updateFlags, 'update');
	if (!parsed) return;
	const { args, name } = parsed;
	const input: StorageUpdateInput = {};
	if (args.has('public')) input.public = args.boolean('public');
	readLimits(args, input);
	if (Object.keys(input).length === 0)
		throw new UsageError('Nothing to update. Pass --memory, --cpus, --storage, --version, --public or --no-public.');
	const client = await authenticatedClient();
	const { storage, raw } = await client.updateStorage(name, input);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(
		`Updated "${storage.name}": ${storage.memoryMb} MB memory, ${storage.cpus} CPU${storage.cpus === 1 ? '' : 's'}, ` +
			`${usedVsBudget(storage)}, ${storage.publicUrl ? `public at ${storage.publicUrl}` : 'private'}.`,
	);
}

async function restartStorage(argv: string[]): Promise<void> {
	if (argv.includes('--all')) {
		const args = parseArgs(argv, restartFlags);
		if (args.boolean('help')) {
			console.log(usage);
			return;
		}
		const client = await authenticatedClient();
		const { result, raw } = await client.restartServices({ scope: 'storage' });
		if (args.boolean('json')) {
			printJson(raw);
			return;
		}
		console.log(
			`Restarting ${result.restarted.storage.length} storage instance${result.restarted.storage.length === 1 ? '' : 's'}.`,
		);
		for (const item of result.skipped) console.log(`Skipped ${item.name}: ${item.reason}`);
		return;
	}
	const parsed = parseNamed(argv, restartFlags, 'restart');
	if (!parsed) return;
	const { args, name } = parsed;
	const client = await authenticatedClient();
	const { storage, raw } = await client.restartStorage(name);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(
		`Restarting "${name}" on node ${nodeLabel(storage)}. S3 requests fail briefly; buckets, objects and keys are kept.`,
	);
}

const logsFlags: FlagSpec = {
	...baseFlags,
	follow: { type: 'boolean', short: 'f' },
	limit: { type: 'string' },
	level: { type: 'string' },
	q: { type: 'string' },
	after: { type: 'string' },
};

async function storageLogs(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, logsFlags, 'logs');
	if (!parsed) return;
	const { args, name } = parsed;
	const client = await authenticatedClient();
	const level = args.string('level');
	if (level && !['debug', 'info', 'warn', 'error'].includes(level))
		throw new UsageError('--level must be debug, info, warn or error.');
	const limit = args.string('limit') ? Number(args.string('limit')) : undefined;
	if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 2000))
		throw new UsageError('--limit must be a whole number between 1 and 2000.');
	const after = args.string('after') ? Number(args.string('after')) : undefined;
	const follow = args.boolean('follow');
	let cursor = after;
	let first = true;

	do {
		const page = await client.storageLogs(name, {
			...(cursor !== undefined ? { after: cursor } : {}),
			limit: limit ?? (follow ? 200 : 500),
			...(level ? { level } : {}),
			...(args.string('q') ? { q: args.string('q') } : {}),
		});
		if (args.boolean('json') && !follow) {
			printJson(page.raw);
			return;
		}
		if (page.events.length > 0) {
			if (!first && follow) console.log('---');
			for (const event of page.events) {
				const time = new Date(event.ts).toISOString().slice(11, 19);
				console.log(`${time} ${event.level.toUpperCase().padEnd(5)} ${event.message}`);
			}
			first = false;
		} else if (!follow) {
			console.log(`No logs for "${name}" yet.`);
			return;
		}
		cursor = page.cursor;
		if (!follow) return;
		await Bun.sleep(2_000);
	} while (follow);
}

async function deleteStorage(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, confirmFlags, 'delete');
	if (!parsed) return;
	const { args, name } = parsed;
	const client = await authenticatedClient();
	// Fail before asking when the server would refuse anyway.
	const { storage: current } = await client.getStorage(name);
	if (current.attachments.length > 0)
		throw new CliError(
			`Storage "${name}" is attached to ${current.attachments.map((item) => item.projectSlug).join(', ')}. Detach it first.`,
			{
				code: 'conflict',
				suggestions: current.attachments.map((item) => `skif storage detach ${name} --project ${item.projectSlug}`),
			},
		);
	const confirmed = await confirmOrRefuse(
		`Delete storage "${name}" (${plural(current.buckets.length, 'bucket')})? Its container stops now; the data stays on node ` +
			`${nodeLabel(current)} and is restorable for 7 days. [y/N] `,
		{
			yes: args.boolean('yes'),
			refusal: `Not confirmed: stdin is not a terminal, so there's no one to ask before deleting "${name}".`,
		},
	);
	if (!confirmed) return cancelled();
	const { storage, raw } = await client.deleteStorage(name);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(`Deleted "${storage.name}".${storage.purgeAt ? ` It is purged for good after ${formatTime(storage.purgeAt)}.` : ''}`);
	console.log(`Undo: skif storage restore ${storage.name}`);
}

async function restoreStorage(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, baseFlags, 'restore');
	if (!parsed) return;
	const { args, name } = parsed;
	const client = await authenticatedClient();
	const { storage, raw } = await client.restoreStorage(name);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(
		`Restored "${storage.name}" on node ${nodeLabel(storage)} (${storage.status}). Re-attach projects with \`skif storage attach\`.`,
	);
}

async function purgeStorage(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, confirmFlags, 'purge');
	if (!parsed) return;
	const { args, name } = parsed;
	const client = await authenticatedClient();
	const { storage } = await client.getStorage(name, { includeDeleted: true });
	if (!storage.deletedAt)
		throw new CliError(`Storage "${name}" is not in the trash. Delete it first.`, {
			code: 'conflict',
			suggestions: [`skif storage delete ${name}`],
		});
	const confirmed = await confirmOrRefuse(
		`This permanently deletes storage "${name}" and every object in it on node ${nodeLabel(storage)}. It cannot be undone. Type ${name} to confirm: `,
		{
			yes: args.boolean('yes'),
			accept: (answer) => answer === name,
			refusal: `Not confirmed: stdin is not a terminal, so there's no one to ask before purging "${name}".`,
		},
	);
	if (!confirmed) return cancelled();
	const raw = await client.purgeStorage(name);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(`Purging "${name}": its node deletes the data, then it disappears from \`skif storage list --all\`.`);
}

async function showCredentials(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, credentialsFlags, 'credentials');
	if (!parsed) return;
	const { args, name } = parsed;
	const prefix = args.string('prefix') ?? 'AWS';
	assertEnvPrefix(prefix);
	const client = await authenticatedClient();
	const { credentials, raw } = await client.storageCredentials(name);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	// Env lines alone on stdout, so `eval "$(skif storage credentials media)"` and `> .env` work.
	console.log(credentialsEnv(credentials, prefix));
	if (process.stderr.isTTY && credentials.note) process.stderr.write(`${credentials.note}\n`);
}

/**
 * Stage a new root key (§5). RustFS restarts with it; the node proves it and the control plane
 * promotes it, or rolls back to the current key. Scoped keys and attached apps are unaffected.
 */
async function rotateRootKey(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, rotateFlags, 'rotate-root');
	if (!parsed) return;
	const { args, name } = parsed;
	const client = await authenticatedClient();
	if (args.boolean('cancel')) {
		const { storage, raw } = await client.cancelStorageRootKeyRotation(name);
		if (args.boolean('json')) {
			printJson(raw);
			return;
		}
		console.log(
			`Cancelled the root key rotation of "${storage.name}". It restarts with its current key${storage.rootKey ? ` (${storage.rootKey.accessKeyId})` : ''}.`,
		);
		return;
	}
	const confirmed = await confirmOrRefuse(
		`Rotate the root key of "${name}"? RustFS restarts (S3 requests fail briefly) and the current root key stops working ` +
			'once the node confirms the new one. Attached apps and named keys are not affected. [y/N] ',
		{
			yes: args.boolean('yes'),
			refusal: `Not confirmed: stdin is not a terminal, so there's no one to ask before rotating the root key of "${name}".`,
		},
	);
	if (!confirmed) return cancelled();
	const { storage, raw } = await client.rotateStorageRootKey(name);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(
		`Rotating the root key of "${storage.name}": ${storage.rootKey ? rootKeyLabel(storage.rootKey) : 'restarting with a new key'}.`,
	);
	console.log(
		'The node restarts RustFS with the new key and confirms it, usually within a minute. If it cannot, the previous key ' +
			'comes back within 10 minutes.',
	);
	const steps = [
		`Follow it:  skif storage info ${storage.name}`,
		`New key:    skif storage credentials ${storage.name}`,
		`Undo:       skif storage rotate-root ${storage.name} --cancel`,
	];
	console.log(`\nNext steps:\n${indent(steps)}`);
}

/** Move an instance to another node, empty: buckets, keys and attachments come back, objects do not (D97). */
async function moveStorage(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, moveFlags, 'move');
	if (!parsed) return;
	const { args, name } = parsed;
	const node = args.string('node');
	if (!node) throw new UsageError(`Name the target node: skif storage move ${name} --node <node id>`);
	const volume = args.string('volume');
	const client = await authenticatedClient();
	const { storage } = await client.getStorage(name);
	const objects = storage.objects === null ? 'its objects' : `its ${plural(storage.objects, 'object')}`;
	const confirmed = await confirmOrRefuse(
		`Move "${name}" from ${nodeLabel(storage)} to ${node}? Skiff does not copy objects: the new instance starts empty with the ` +
			`same buckets, keys and attachments, and ${objects} on ${nodeLabel(storage)} are deleted once it is up. ` +
			`Copy what you need first. Type ${name} to confirm: `,
		{
			yes: args.boolean('yes'),
			accept: (answer) => answer === name,
			refusal: `Not confirmed: stdin is not a terminal, so there's no one to ask before moving "${name}". Pass --yes to move it empty.`,
		},
	);
	if (!confirmed) return cancelled();
	const { result, raw } = await client.moveStorage(name, { node, ...(volume ? { volume } : {}) });
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	const label = (ref: { nodeId: string; name: string | null }) => ref.name ?? ref.nodeId;
	console.log(`Moving "${result.storage}" from ${label(result.from)} to ${label(result.to)}, empty.`);
	if (result.projects.length > 0) console.log(`Attached apps move with it: ${result.projects.join(', ')}.`);
	for (const warning of result.warnings) console.log(`Note: ${warning}`);
	console.log(`Follow it: skif storage info ${result.storage}`);
}

// --- named keys ------------------------------------------------------------------------------

const keySubcommands: Record<string, (argv: string[]) => Promise<void>> = {
	list: listKeys,
	ls: listKeys,
	create: createKey,
	reveal: revealKey,
	revoke: revokeKey,
	rm: revokeKey,
};

async function keysCommand(argv: string[]): Promise<void> {
	const first = argv[0];
	const handler = first ? keySubcommands[first] : undefined;
	// `skif storage keys media` lists, like `skif storage keys list media`.
	if (handler) await handler(argv.slice(1));
	else await listKeys(argv);
}

function parseKeyArgs(argv: string[], command: string, second: string | null) {
	const args = parseArgs(argv, keysFlags);
	if (args.boolean('help')) {
		console.log(keysUsage);
		return null;
	}
	const line = `Usage: skif storage keys ${command} <storage>${second ? ` <${second}>` : ''}`;
	rejectExtraPositionals(args, second ? 2 : 1, line);
	const name = requirePositional(args, 0, `storage name.\n\n${line}`);
	const value = second ? requirePositional(args, 1, `${second}.\n\n${line}`) : '';
	return { args, name, value };
}

/** `--expires`: an ISO time, or a duration from now (`30d`, `12h`, `90m`, `2w`). */
export function parseExpiry(value: string, now = Date.now()): string {
	const duration = /^(\d+)\s*([mhdw])$/i.exec(value.trim());
	if (duration) {
		const units = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 } as const;
		const unit = units[duration[2]!.toLowerCase() as keyof typeof units];
		return new Date(now + Number(duration[1]) * unit).toISOString();
	}
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) throw new UsageError(`--expires "${value}" is not a time or a duration like 30d.`);
	if (parsed <= now) throw new UsageError('--expires must be in the future.');
	return new Date(parsed).toISOString();
}

async function listKeys(argv: string[]): Promise<void> {
	const parsed = parseKeyArgs(argv, 'list', null);
	if (!parsed) return;
	const { args, name } = parsed;
	const client = await authenticatedClient();
	const { keys, raw } = await client.listStorageKeys(name);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	if (keys.length === 0) {
		console.log(`No named keys on "${name}". Create one with \`skif storage keys create ${name} <name> --bucket <bucket>\`.`);
		return;
	}
	console.log(storageKeysTable(keys));
}

async function createKey(argv: string[]): Promise<void> {
	const parsed = parseKeyArgs(argv, 'create', 'key name');
	if (!parsed) return;
	const { args, name, value } = parsed;
	const grants = parseGrants(args.strings('bucket'));
	if (grants.length === 0)
		throw new UsageError(`Name the buckets: skif storage keys create ${name} ${value} --bucket <b>[:read|:read-write] (repeatable).`);
	const input: StorageKeyCreateInput = { name: value, grants };
	const purpose = args.string('purpose');
	if (purpose) input.purpose = purpose;
	const expires = args.string('expires');
	if (expires) input.expiresAt = parseExpiry(expires);
	const client = await authenticatedClient();
	const { key, raw } = await client.createStorageKey(name, input);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(`Created key "${key.name}" (${key.id}, ${key.accessKeyId}) on "${name}" with ${grantsLabel(key.grants)}.`);
	console.log('The node adds it within a minute.');
	const steps = [`Secret:  skif storage keys reveal ${name} ${key.id}`, `Revoke:  skif storage keys revoke ${name} ${key.id}`];
	console.log(`\nNext steps:\n${indent(steps)}`);
}

async function revealKey(argv: string[]): Promise<void> {
	const parsed = parseKeyArgs(argv, 'reveal', 'key id');
	if (!parsed) return;
	const { args, name, value } = parsed;
	const prefix = args.string('prefix') ?? 'AWS';
	assertEnvPrefix(prefix);
	const client = await authenticatedClient();
	const { key, raw } = await client.revealStorageKey(name, value);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	const { storage } = await client.getStorage(name);
	// Env lines alone on stdout, so `> .env` and `eval` work.
	console.log(storageKeyEnv(key, storage.publicUrl ?? storage.internalEndpoint.process, storage.region, prefix));
	if (process.stderr.isTTY)
		process.stderr.write(
			`Key "${key.name}" (${grantsLabel(key.grants)}). ` +
				`${storage.publicUrl ? 'Use path-style addressing.' : `Private: reachable on node ${nodeLabel(storage)} only.`}\n`,
		);
}

async function revokeKey(argv: string[]): Promise<void> {
	const parsed = parseKeyArgs(argv, 'revoke', 'key id');
	if (!parsed) return;
	const { args, name, value } = parsed;
	const confirmed = await confirmOrRefuse(`Revoke key ${value} on "${name}"? Anything still signing with it is refused. [y/N] `, {
		yes: args.boolean('yes'),
		refusal: `Not confirmed: stdin is not a terminal, so there's no one to ask before revoking ${value}.`,
	});
	if (!confirmed) return cancelled();
	const client = await authenticatedClient();
	const { key, raw } = await client.revokeStorageKey(name, value);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(`Revoked key "${key.name}" (${key.accessKeyId}). The node removes it within a minute.`);
}

async function showMetrics(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, metricsFlags, 'metrics');
	if (!parsed) return;
	const { args, name } = parsed;
	const since = args.string('since');
	const from = args.string('from');
	if (since && from) throw new UsageError('Use --since or --from, not both.');
	const interval = args.string('interval');
	if (interval !== undefined && interval !== '1m' && interval !== '1h')
		throw new UsageError('--interval expects 1m or 1h.');
	const to = args.string('to');
	let start = from;
	if (since) {
		// The server validates --from/--to; --since needs the end time here to count back from.
		const end = to === undefined ? Date.now() : /^\d+$/.test(to.trim()) ? Number(to) : Date.parse(to);
		if (!Number.isFinite(end)) throw new UsageError('--to expects an ISO timestamp or epoch milliseconds.');
		start = new Date(end - parseDuration(since, '--since')).toISOString();
	}
	const client = await authenticatedClient();
	const { points, interval: used, raw } = await client.storageMetrics(name, { from: start, to, interval });
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	if (points.length === 0) {
		console.log(`No samples for "${name}" in that range yet. The agent reports once a minute while it runs.`);
		return;
	}
	console.log(`${plural(points.length, 'sample')} at ${used}:`);
	console.log(metricsTable(points));
}

async function attachStorage(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, attachFlags, 'attach');
	if (!parsed) return;
	const { args, name } = parsed;
	const project = requireProject(args.string('project'), 'attach', name);
	const prefix = args.string('prefix');
	if (prefix !== undefined) assertEnvPrefix(prefix);
	let grants = parseGrants(args.strings('bucket'));
	const client = await authenticatedClient();
	if (grants.length === 0) grants = defaultGrants((await client.getStorage(name)).storage);
	const { attachment, warning, raw } = await client.attachStorage(project, {
		storage: name,
		...(prefix ? { envPrefix: prefix } : {}),
		grants,
	});
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(
		`Attached "${attachment.storageName}" to ${attachment.projectSlug} as ${attachment.envPrefix} (${grantsLabel(attachment.grants)}).`,
	);
	console.log(
		`${attachment.projectSlug} receives ${attachment.envNames.join(', ')} at activation; a running app restarts on its own. Use path-style addressing.`,
	);
	if (warning) console.log(`Note: ${warning}`);
}

async function updateGrants(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, grantsFlags, 'grants');
	if (!parsed) return;
	const { args, name } = parsed;
	const project = requireProject(args.string('project'), 'grants', name);
	const grants = parseGrants(args.strings('bucket'));
	if (grants.length === 0)
		throw new UsageError(
			`Name the buckets: skif storage grants ${name} --project ${project} --bucket <b>[:read|:read-write] (repeatable). ` +
				'They replace the current grants.',
		);
	const client = await authenticatedClient();
	const { attachment, raw } = await client.updateStorageGrants(project, name, grants);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(`${attachment.projectSlug} now has ${grantsLabel(attachment.grants)} on "${attachment.storageName}".`);
	console.log(`Its key's policy changes in place; ${attachment.envNames.join(', ')} are refreshed at the next activation.`);
}

async function detachStorage(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, detachFlags, 'detach');
	if (!parsed) return;
	const { args, name } = parsed;
	const project = requireProject(args.string('project'), 'detach', name);
	const client = await authenticatedClient();
	const raw = await client.detachStorage(project, name);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(`Detached "${name}" from ${project}. Its key is revoked and the app restarts without its storage variables; the objects are untouched.`);
}

// --- buckets ---------------------------------------------------------------------------------

const bucketSubcommands: Record<string, (argv: string[]) => Promise<void>> = {
	list: listBuckets,
	ls: listBuckets,
	create: createBucket,
	config: showBucketConfig,
	update: updateBucket,
	set: updateBucket,
	delete: deleteBucket,
	rm: deleteBucket,
};

async function bucketsCommand(argv: string[]): Promise<void> {
	const first = argv[0];
	const handler = first ? bucketSubcommands[first] : undefined;
	// `skif storage buckets media` lists, like `skif storage buckets list media`.
	if (handler) await handler(argv.slice(1));
	else await listBuckets(argv);
}

/** Parse, handle --help, and return `<storage>` plus `<bucket>` when the command takes one. */
function parseBucketArgs(argv: string[], command: string, withBucket: boolean) {
	const args = parseArgs(argv, bucketFlags);
	if (args.boolean('help')) {
		console.log(bucketsUsage);
		return null;
	}
	const line = `Usage: skif storage buckets ${command} <storage>${withBucket ? ' <bucket>' : ''}`;
	rejectExtraPositionals(args, withBucket ? 2 : 1, line);
	const name = requirePositional(args, 0, `storage name.\n\n${line}`);
	const bucket = withBucket ? requirePositional(args, 1, `bucket name.\n\n${line}`) : '';
	return { args, name, bucket };
}

async function listBuckets(argv: string[]): Promise<void> {
	const parsed = parseBucketArgs(argv, 'list', false);
	if (!parsed) return;
	const { args, name } = parsed;
	const client = await authenticatedClient();
	const { buckets, raw } = await client.listBuckets(name);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	if (buckets.length === 0) {
		console.log(`No buckets in "${name}" yet. Create one with \`skif storage buckets create ${name} <bucket>\`.`);
		return;
	}
	console.log(bucketTable(buckets));
}

/** Read the shared configuration flags. Returns null when none were passed. */
function readBucketConfigInput(args: ParsedArgs): BucketConfigInput | null {
	const input: BucketConfigInput = {};
	const access = args.string('access');
	if (access) input.access = parseAccess(access);
	const versioning = args.string('versioning');
	if (versioning !== undefined) {
		if (versioning !== 'on' && versioning !== 'off')
			throw new UsageError('--versioning expects on or off.');
		input.versioning = versioning === 'on';
	}
	const quota = args.string('quota');
	if (quota !== undefined) {
		if (quota === 'none' || quota === 'unlimited' || quota === '0') input.quotaBytes = null;
		else input.quotaBytes = parseMegabytes(quota, '--quota') * 1024 * 1024;
	}
	const lifecycle = args.string('lifecycle');
	if (lifecycle !== undefined) input.lifecycle = parseLifecycleRules(lifecycle, '--lifecycle');
	const cors = args.string('cors');
	if (cors !== undefined) input.cors = parseCorsRules(cors, '--cors');
	return Object.keys(input).length > 0 ? input : null;
}

async function createBucket(argv: string[]): Promise<void> {
	const parsed = parseBucketArgs(argv, 'create', true);
	if (!parsed) return;
	const { args, name, bucket } = parsed;
	const config = readBucketConfigInput(args) ?? {};
	const objectLock = args.string('object-lock');
	if (objectLock && config.versioning === false)
		throw new UsageError('--object-lock requires versioning; omit --versioning off.');
	const client = await authenticatedClient();
	const { bucket: view, raw } = await client.createBucket(name, {
		name: bucket,
		...config,
		...(objectLock ? { objectLock: parseObjectLock(objectLock), versioning: true } : {}),
	});
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(`Created bucket "${view.name}" in "${name}" (${view.access}). The node creates it within a minute.`);
	if (view.objectLock)
		console.log(
			`Object lock is on (${view.objectLock.mode}, ${view.objectLock.retainDays} days) and cannot be undone.`,
		);
	console.log(`Follow it: skif storage bucket config ${name} ${view.name}`);
	console.log(`Grant it to an app: skif storage attach ${name} --project <slug> --bucket ${view.name}`);
}

async function showBucketConfig(argv: string[]): Promise<void> {
	const parsed = parseBucketArgs(argv, 'config', true);
	if (!parsed) return;
	const { args, name, bucket } = parsed;
	const client = await authenticatedClient();
	const { config, raw } = await client.getBucketConfig(name, bucket);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(bucketConfigDetails(config));
}

async function updateBucket(argv: string[]): Promise<void> {
	const parsed = parseBucketArgs(argv, 'update', true);
	if (!parsed) return;
	const { args, name, bucket } = parsed;
	if (args.string('object-lock'))
		throw new UsageError('Object lock can only be set when creating a bucket; it cannot be changed.');
	const input = readBucketConfigInput(args);
	if (!input)
		throw new UsageError(
			`Nothing to update: skif storage bucket update ${name} ${bucket} ` +
				'--access private|public-read --versioning on|off --quota 1G --lifecycle @rules.json --cors @cors.json',
		);
	const client = await authenticatedClient();
	const { bucket: config, raw } = await client.updateBucket(name, bucket, input);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	if (input.access)
		console.log(
			`Bucket "${config.name}" in "${name}" is now ${config.access}${config.access === 'public-read' ? ': anyone can GET its objects (not list them)' : ''}.`,
		);
	console.log(`Configuration saved (version ${config.configVersion}); the node applies it within a minute.`);
	console.log(bucketConfigDetails(config));
}

async function deleteBucket(argv: string[]): Promise<void> {
	const parsed = parseBucketArgs(argv, 'delete', true);
	if (!parsed) return;
	const { args, name, bucket } = parsed;
	const force = args.boolean('force');
	const confirmed = await confirmOrRefuse(
		force
			? `This deletes bucket "${bucket}" in "${name}" and every object in it. It cannot be undone. Type ${bucket} to confirm: `
			: `Delete bucket "${bucket}" in "${name}"? Only an empty bucket is deleted. [y/N] `,
		{
			yes: args.boolean('yes'),
			...(force ? { accept: (answer: string) => answer === bucket } : {}),
			refusal: `Not confirmed: stdin is not a terminal, so there's no one to ask before deleting bucket "${bucket}".`,
		},
	);
	if (!confirmed) return cancelled();
	const client = await authenticatedClient();
	const { bucket: view, raw } = await client.deleteBucket(name, bucket, { force });
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(
		force
			? `Deleting bucket "${view.name}" and its objects; the node empties and removes it within a minute.`
			: `Deleting bucket "${view.name}"; the node removes it within a minute if it is still empty.`,
	);
}
