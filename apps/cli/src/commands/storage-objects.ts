import { parseArgs, rejectExtraPositionals, requirePositional, type FlagSpec } from '../args.ts';
import { CliError, UsageError } from '../errors.ts';
import { parseDuration } from '../object-storage.ts';
import { formatBytes, formatTime, printJson, renderTable, truncate } from '../output.ts';
import { authenticatedClient } from './common.ts';
import { confirmOrRefuse } from './run-operation.ts';

/** `skif storage objects` — browse and manage bucket contents through the control plane (D82). */

const usage = `Usage: skif storage objects <command> <storage> [options]

Commands:
  ls <storage> -b <bucket>       List objects and folders (the default)
  get <storage> -b <bucket> -k <key> [-o file]
                                 Download one object (stdout without -o)
  put <storage> -b <bucket> -k <key> -f <file>
                                 Upload one object
  rm <storage> -b <bucket> -k <key> [--prefix <prefix>] [--yes]
                                 Delete an object, or every object under a prefix
  mkdir <storage> -b <bucket> -k <prefix>
                                 Create a folder marker (a zero-byte object ending in /)
  presign <storage> -b <bucket> -k <key> [--put] [--expires 1h]
                                 Print a presigned URL (public instances only)

Options:
  -b, --bucket <name>            Bucket to operate on (required)
  -k, --key <key>                Object key or folder prefix
      --prefix <prefix>          List under this prefix (ls) or delete it (rm)
      --token <token>            Continue a truncated listing
      --limit <n>                Page size, 1–1000 (default 100)
  -f, --file <path>              Local file for put
  -o, --output <path>            Write the download to this path
      --content-type <type>      Upload content type (default from the file)
      --put                      Presign a PUT instead of a GET
      --expires <duration>       Presigned lifetime (default 1h, max 7d)
  -y, --yes                      Do not prompt for destructive actions
      --json                     Print the raw API response
  -h, --help                     Show this help

Examples:
  skif storage objects ls media -b uploads --prefix photos/
  skif storage objects put media -b uploads -k photos/a.jpg -f ./a.jpg
  skif storage objects get media -b uploads -k photos/a.jpg -o a.jpg
  skif storage objects rm media -b uploads --prefix photos/ --yes
  skif storage objects presign media -b uploads -k photos/a.jpg --expires 6h`;

const flags: FlagSpec = {
	bucket: { type: 'string', short: 'b' },
	key: { type: 'string', short: 'k' },
	prefix: { type: 'string' },
	token: { type: 'string' },
	limit: { type: 'string' },
	file: { type: 'string', short: 'f' },
	output: { type: 'string', short: 'o' },
	'content-type': { type: 'string' },
	put: { type: 'boolean' },
	expires: { type: 'string' },
	yes: { type: 'boolean', short: 'y' },
	json: { type: 'boolean' },
	help: { type: 'boolean', short: 'h' },
};

function parse(command: string, argv: string[], maxPositionals = 1) {
	const args = parseArgs(argv, flags);
	if (args.boolean('help')) {
		console.log(usage);
		return null;
	}
	const line = `Usage: skif storage objects ${command} <storage> [options]`;
	rejectExtraPositionals(args, maxPositionals, line);
	const name = requirePositional(args, 0, `storage name.\n\n${line}`);
	const bucket = args.string('bucket');
	if (!bucket) throw new UsageError(`${command} needs --bucket <name>.\n\n${line}`);
	return { args, name, bucket };
}

function keyOf(args: ReturnType<typeof parseArgs>, line: string): string {
	const key = args.string('key');
	if (!key) throw new UsageError(`This command needs --key <key>.\n\n${line}`);
	return key;
}

async function listObjects(argv: string[]): Promise<void> {
	const parsed = parse('ls', argv);
	if (!parsed) return;
	const { args, name, bucket } = parsed;
	const limit = args.string('limit') ? Number(args.string('limit')) : undefined;
	if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 1000))
		throw new UsageError('--limit must be a whole number between 1 and 1000.');
	const client = await authenticatedClient();
	const result = await client.listObjects(name, {
		bucket,
		prefix: args.string('prefix'),
		token: args.string('token'),
		limit,
	});
	if (args.boolean('json')) {
		printJson(result);
		return;
	}
	if (result.objects.length === 0 && result.prefixes.length === 0) {
		console.log(`No objects under "${result.prefix || '/'}" in ${bucket}.`);
		return;
	}
	const rows: string[][] = [
		...result.prefixes.map((prefix) => [`${prefix}`, '-', '-', 'folder']),
		...result.objects.map((object) => [
			object.key,
			formatBytes(object.sizeBytes),
			formatTime(object.lastModified ?? undefined),
			object.etag ? truncate(object.etag, 12) : '-',
		]),
	];
	console.log(renderTable(['KEY', 'SIZE', 'MODIFIED', 'ETAG'], rows));
	if (result.isTruncated && result.nextToken)
		console.log(`\nMore objects: add --token ${result.nextToken}`);
}

async function getObject(argv: string[]): Promise<void> {
	const parsed = parse('get', argv);
	if (!parsed) return;
	const { args, name, bucket } = parsed;
	const key = keyOf(args, usage);
	const client = await authenticatedClient();
	const { body } = await client.downloadObject(name, bucket, key);
	const output = args.string('output');
	if (output) {
		await Bun.write(output, body);
		console.log(`Wrote ${formatBytes(body.byteLength)} to ${output}.`);
		return;
	}
	process.stdout.write(body);
}

async function putObject(argv: string[]): Promise<void> {
	const parsed = parse('put', argv);
	if (!parsed) return;
	const { args, name, bucket } = parsed;
	const key = keyOf(args, usage);
	const file = args.string('file');
	if (!file) throw new UsageError(`put needs --file <path>.\n\n${usage}`);
	const handle = Bun.file(file);
	if (!(await handle.exists())) throw new CliError(`No such file: ${file}`);
	const body = new Uint8Array(await handle.arrayBuffer());
	const contentType = args.string('content-type') || handle.type || 'application/octet-stream';
	const client = await authenticatedClient();
	const object = await client.uploadObject(name, bucket, key, body, contentType);
	if (args.boolean('json')) {
		printJson(object);
		return;
	}
	console.log(`Uploaded ${object.key} (${formatBytes(object.sizeBytes)}).`);
}

async function removeObjects(argv: string[]): Promise<void> {
	const parsed = parse('rm', argv);
	if (!parsed) return;
	const { args, name, bucket } = parsed;
	const key = args.string('key');
	const prefix = args.string('prefix');
	if (!key && !prefix) throw new UsageError(`rm needs --key <key> or --prefix <prefix>.\n\n${usage}`);
	const client = await authenticatedClient();
	if (key) {
		const confirmed = await confirmOrRefuse(`Delete ${key} from ${bucket}?`, {
			yes: args.boolean('yes'),
			refusal: 'Refusing to delete without confirmation.',
		});
		if (!confirmed) {
			console.log('Cancelled.');
			return;
		}
		const result = await client.deleteObjects(name, bucket, [key]);
		if (result.errors.length > 0) throw new CliError(result.errors[0]!.message);
		console.log(`Deleted ${key}.`);
		return;
	}

	const keys: string[] = [];
	let token: string | undefined;
	do {
		const page = await client.listObjects(name, { bucket, prefix, token, limit: 1000 });
		keys.push(...page.objects.map((object) => object.key));
		token = page.isTruncated ? (page.nextToken ?? undefined) : undefined;
		if (keys.length > 10_000) throw new CliError('Refusing to delete more than 10,000 objects in one run.');
	} while (token);
	if (keys.length === 0) {
		console.log(`No objects under "${prefix}".`);
		return;
	}
	const confirmed = await confirmOrRefuse(
		`Delete ${keys.length} object${keys.length === 1 ? '' : 's'} under ${prefix} in ${bucket}?`,
		{ yes: args.boolean('yes'), refusal: 'Refusing to delete without confirmation.' },
	);
	if (!confirmed) {
		console.log('Cancelled.');
		return;
	}
	let deleted = 0;
	for (let index = 0; index < keys.length; index += 1000) {
		const result = await client.deleteObjects(name, bucket, keys.slice(index, index + 1000));
		deleted += result.deleted.length;
	}
	console.log(`Deleted ${deleted} object${deleted === 1 ? '' : 's'}.`);
}

async function makeFolder(argv: string[]): Promise<void> {
	const parsed = parse('mkdir', argv);
	if (!parsed) return;
	const { args, name, bucket } = parsed;
	const key = keyOf(args, usage);
	const client = await authenticatedClient();
	const result = await client.createObjectFolder(name, bucket, key);
	if (args.boolean('json')) {
		printJson(result);
		return;
	}
	console.log(`Created ${result.prefix}.`);
}

async function presignObject(argv: string[]): Promise<void> {
	const parsed = parse('presign', argv);
	if (!parsed) return;
	const { args, name, bucket } = parsed;
	const key = keyOf(args, usage);
	const expiresMs = args.string('expires') ? parseDuration(args.string('expires')!, '--expires') : 3_600_000;
	const expiresIn = Math.min(604_800, Math.max(60, Math.floor(expiresMs / 1000)));
	const client = await authenticatedClient();
	const result = await client.presignObject(name, bucket, key, {
		method: args.boolean('put') ? 'PUT' : 'GET',
		expiresIn,
	});
	if (args.boolean('json')) {
		printJson(result);
		return;
	}
	console.log(result.url);
}

export async function storageObjectsCommand(argv: string[]): Promise<void> {
	const first = argv[0];
	const handlers: Record<string, (rest: string[]) => Promise<void>> = {
		ls: listObjects,
		list: listObjects,
		get: getObject,
		download: getObject,
		put: putObject,
		upload: putObject,
		rm: removeObjects,
		delete: removeObjects,
		mkdir: makeFolder,
		folder: makeFolder,
		presign: presignObject,
		link: presignObject,
	};
	if (!first || first.startsWith('-')) {
		console.log(usage);
		return;
	}
	const handler = handlers[first];
	if (!handler) throw new UsageError(`Unknown storage objects command "${first}".\n\n${usage}`);
	await handler(argv.slice(1));
}
