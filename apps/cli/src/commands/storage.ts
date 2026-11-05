import { parseArgs, rejectExtraPositionals, requirePositional, type FlagSpec, type ParsedArgs } from '../args.ts';
import { CliError, UsageError } from '../errors.ts';
import { assertEnvPrefix, parseCpus, parseMegabytes } from '../databases.ts';
import {
	bucketTable,
	credentialsEnv,
	defaultGrants,
	grantsLabel,
	metricsTable,
	nodeLabel,
	parseAccess,
	parseDuration,
	parseGrants,
	splitList,
	storageDetails,
	storageTable,
	usedVsBudget,
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

const bucketsUsage = `Usage: skif storage buckets <command> <storage> [bucket] [options]

Commands:
  list <storage>                     List buckets with access, state, size and objects (the default)
  create <storage> <bucket>          Create a bucket (--access private|public-read; default private)
  update <storage> <bucket>          Change its anonymous access: --access private|public-read
  delete <storage> <bucket>          Delete an empty bucket; --force deletes its objects too

Options:
      --access <access>              private, or public-read (unsigned GETs of objects, no listing)
      --force                        Empty the bucket first (needs storage:delete; cannot be undone)
  -y, --yes                          Don't ask for confirmation
      --json                         JSON output
  -h, --help                         Show this help`;

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
	force: { type: 'boolean' },
	yes: { type: 'boolean', short: 'y' },
};

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

async function createBucket(argv: string[]): Promise<void> {
	const parsed = parseBucketArgs(argv, 'create', true);
	if (!parsed) return;
	const { args, name, bucket } = parsed;
	const access = args.string('access');
	const client = await authenticatedClient();
	const { bucket: view, raw } = await client.createBucket(name, {
		name: bucket,
		...(access ? { access: parseAccess(access) } : {}),
	});
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(`Created bucket "${view.name}" in "${name}" (${view.access}). The node creates it within a minute.`);
	console.log(`Grant it to an app: skif storage attach ${name} --project <slug> --bucket ${view.name}`);
}

async function updateBucket(argv: string[]): Promise<void> {
	const parsed = parseBucketArgs(argv, 'update', true);
	if (!parsed) return;
	const { args, name, bucket } = parsed;
	const access = args.string('access');
	if (!access) throw new UsageError(`Nothing to update: skif storage buckets update ${name} ${bucket} --access private|public-read`);
	const client = await authenticatedClient();
	const { bucket: view, raw } = await client.updateBucket(name, bucket, { access: parseAccess(access) });
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(
		`Bucket "${view.name}" in "${name}" is now ${view.access}${view.access === 'public-read' ? ': anyone can GET its objects (not list them)' : ''}.`,
	);
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
