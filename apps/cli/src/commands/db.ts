import { parseArgs, rejectExtraPositionals, requirePositional, type FlagSpec } from '../args.ts';
import { CliError, UsageError } from '../errors.ts';
import {
	assertEnvPrefix,
	databaseDetails,
	databaseTable,
	engineLabel,
	nodeLabel,
	parseCpus,
	parseMegabytes,
	type DatabaseCreateInput,
} from '../databases.ts';
import { formatTime, indent, printJson } from '../output.ts';
import { authenticatedClient } from './common.ts';
import { confirmOrRefuse } from './run-operation.ts';

/** Managed databases (docs/DATABASES.md). Every check lives on the server; this is a thin client. */

const usage = `Usage: skif db <command> [options]

Commands:
  list                         List databases (the default); --all includes the trash
  create <name>                Create a PostgreSQL database
  info <name>                  Status, node, size vs budget, attached projects, top tables
  attach <name> -p <project>   Connect a database to a project (injects <PREFIX>_URL, …)
  detach <name> -p <project>   Disconnect it; the app restarts without the variables
  delete <name>                Move it to the trash (restorable for 7 days)
  restore <name>               Bring it back from the trash
  purge <name>                 Permanently delete a trashed database and its data
  credentials <name>           Print the connection URL (--json for user, password, host, port)

Create options:
  -p, --project <slug>         Attach to this project right away (placed on its node)
      --prefix <PREFIX>        Env prefix for the attachment (default DATABASE)
      --version <16|17>        PostgreSQL major version (default 17)
      --placement <where>      auto (default), edge, or a node id
      --memory <size>          Memory limit, e.g. 256M or 1G (default 256M)
      --cpus <n>               CPU limit (default 1)
      --storage <size>         Storage budget for alerts and the gauge (default 10G)

Options:
  -y, --yes                    Don't ask for confirmation (required when stdin isn't a terminal)
      --json                   JSON output
  -h, --help                   Show this help

Attached apps get <PREFIX>_URL, _HOST, _PORT, _USER, _PASSWORD and _NAME at activation and must
run on the database's node (\`auto\` placement handles that). Credentials need the
database:credentials permission and every read is audited.

Examples:
  skif db create main --project api
  skif db attach main --project api --prefix DATABASE
  psql "$(skif db credentials main)"     # on the node, or through ssh -L <port>:127.0.0.1:<port>`;

const baseFlags: FlagSpec = {
	json: { type: 'boolean' },
	help: { type: 'boolean', short: 'h' },
};

const listFlags: FlagSpec = { ...baseFlags, all: { type: 'boolean', short: 'a' } };

const createFlags: FlagSpec = {
	...baseFlags,
	project: { type: 'string', short: 'p' },
	prefix: { type: 'string' },
	version: { type: 'string' },
	placement: { type: 'string' },
	memory: { type: 'string' },
	cpus: { type: 'string' },
	storage: { type: 'string' },
};

const attachFlags: FlagSpec = {
	...baseFlags,
	project: { type: 'string', short: 'p' },
	prefix: { type: 'string' },
};

const detachFlags: FlagSpec = { ...baseFlags, project: { type: 'string', short: 'p' } };

const confirmFlags: FlagSpec = { ...baseFlags, yes: { type: 'boolean', short: 'y' } };

const subcommands: Record<string, (argv: string[]) => Promise<void>> = {
	list: listDatabases,
	ls: listDatabases,
	create: createDatabase,
	info: showDatabase,
	show: showDatabase,
	attach: attachDatabase,
	detach: detachDatabase,
	delete: deleteDatabase,
	rm: deleteDatabase,
	restore: restoreDatabase,
	purge: purgeDatabase,
	credentials: showCredentials,
	creds: showCredentials,
};

export async function dbCommand(argv: string[]): Promise<void> {
	const first = argv[0];
	if (first && !first.startsWith('-')) {
		const handler = subcommands[first];
		if (!handler) throw new UsageError(`Unknown db command "${first}".\n\n${usage}`);
		await handler(argv.slice(1));
		return;
	}
	await listDatabases(argv);
}

/** Parse, handle --help, and return the single `<name>` positional. */
function parseNamed(argv: string[], spec: FlagSpec, command: string) {
	const args = parseArgs(argv, spec);
	if (args.boolean('help')) {
		console.log(usage);
		return null;
	}
	const line = `Usage: skif db ${command} <name>`;
	rejectExtraPositionals(args, 1, line);
	const name = requirePositional(args, 0, `database name.\n\n${line}`);
	return { args, name };
}

function requireProject(project: string | undefined, command: string, name: string): string {
	if (!project) throw new UsageError(`Name the project: skif db ${command} ${name} --project <slug>`);
	return project;
}

async function listDatabases(argv: string[]): Promise<void> {
	const args = parseArgs(argv, listFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 0, 'Usage: skif db list [--all] [--json]');
	const client = await authenticatedClient();
	const { databases, raw } = await client.listDatabases({ includeDeleted: args.boolean('all') });
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	if (databases.length === 0) {
		console.log('No databases yet. Create one with `skif db create <name> --project <slug>`.');
		return;
	}
	console.log(databaseTable(databases));
}

async function createDatabase(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, createFlags, 'create');
	if (!parsed) return;
	const { args, name } = parsed;
	const prefix = args.string('prefix');
	const project = args.string('project');
	if (prefix !== undefined) {
		if (!project) throw new UsageError('--prefix needs --project (it names the attachment).');
		assertEnvPrefix(prefix);
	}
	const input: DatabaseCreateInput = { name };
	if (project) input.project = project;
	if (prefix) input.envPrefix = prefix;
	const version = args.string('version');
	if (version) input.version = version;
	const placement = args.string('placement');
	if (placement) input.placement = placement;
	const memory = args.string('memory');
	if (memory) input.memoryMb = parseMegabytes(memory, '--memory');
	const cpus = args.string('cpus');
	if (cpus) input.cpus = parseCpus(cpus);
	const storage = args.string('storage');
	if (storage) input.storageMb = parseMegabytes(storage, '--storage');

	const client = await authenticatedClient();
	const { database, raw } = await client.createDatabase(input);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(`Created ${engineLabel(database)} database "${database.name}" on node ${nodeLabel(database)} (${database.status}).`);
	const attached = database.attachments[0];
	if (attached)
		console.log(
			`Attached to ${attached.projectSlug} as ${attached.envPrefix}: it receives ${attached.envNames.join(', ')} at its next activation.`,
		);
	const steps = [
		`Follow it:    skif db info ${database.name}`,
		...(attached ? [] : [`Attach:       skif db attach ${database.name} --project <slug>`]),
		`Connect:      skif db credentials ${database.name}`,
	];
	console.log(`\nNext steps:\n${indent(steps)}`);
}

async function showDatabase(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, baseFlags, 'info');
	if (!parsed) return;
	const { args, name } = parsed;
	const client = await authenticatedClient();
	const { database, raw } = await client.getDatabase(name, { includeDeleted: true });
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(databaseDetails(database));
	if (database.deletedAt)
		console.log(`\nIn the trash. Restore with \`skif db restore ${database.name}\`; delete for good with \`skif db purge ${database.name}\`.`);
}

async function attachDatabase(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, attachFlags, 'attach');
	if (!parsed) return;
	const { args, name } = parsed;
	const project = requireProject(args.string('project'), 'attach', name);
	const prefix = args.string('prefix');
	if (prefix !== undefined) assertEnvPrefix(prefix);
	const client = await authenticatedClient();
	const { attachment, warning, raw } = await client.attachDatabase(project, {
		database: name,
		...(prefix ? { envPrefix: prefix } : {}),
	});
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(`Attached "${attachment.databaseName}" to ${attachment.projectSlug} as ${attachment.envPrefix}.`);
	console.log(
		`${attachment.projectSlug} receives ${attachment.envNames.join(', ')} at activation; a running app restarts on its own.`,
	);
	if (warning) console.log(`Note: ${warning}`);
}

async function detachDatabase(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, detachFlags, 'detach');
	if (!parsed) return;
	const { args, name } = parsed;
	const project = requireProject(args.string('project'), 'detach', name);
	const client = await authenticatedClient();
	const raw = await client.detachDatabase(project, name);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(`Detached "${name}" from ${project}. The app restarts without its database variables; the data is untouched.`);
}

async function deleteDatabase(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, confirmFlags, 'delete');
	if (!parsed) return;
	const { args, name } = parsed;
	const client = await authenticatedClient();
	// Fail before asking when the server would refuse anyway.
	const { database: current } = await client.getDatabase(name);
	if (current.attachments.length > 0)
		throw new CliError(
			`Database "${name}" is attached to ${current.attachments.map((item) => item.projectSlug).join(', ')}. Detach it first.`,
			{
				code: 'conflict',
				suggestions: current.attachments.map((item) => `skif db detach ${name} --project ${item.projectSlug}`),
			},
		);
	const confirmed = await confirmOrRefuse(
		`Delete database "${name}"? Its container stops now; the data stays on node ${nodeLabel(current)} and is restorable for 7 days. [y/N] `,
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
	const { database, raw } = await client.deleteDatabase(name);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(`Deleted "${database.name}".${database.purgeAt ? ` It is purged for good after ${formatTime(database.purgeAt)}.` : ''}`);
	console.log(`Undo: skif db restore ${database.name}`);
}

async function restoreDatabase(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, baseFlags, 'restore');
	if (!parsed) return;
	const { args, name } = parsed;
	const client = await authenticatedClient();
	const { database, raw } = await client.restoreDatabase(name);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(`Restored "${database.name}" on node ${nodeLabel(database)} (${database.status}). Re-attach projects with \`skif db attach\`.`);
}

async function purgeDatabase(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, confirmFlags, 'purge');
	if (!parsed) return;
	const { args, name } = parsed;
	const client = await authenticatedClient();
	const { database } = await client.getDatabase(name, { includeDeleted: true });
	if (!database.deletedAt)
		throw new CliError(`Database "${name}" is not in the trash. Delete it first.`, {
			code: 'conflict',
			suggestions: [`skif db delete ${name}`],
		});
	const confirmed = await confirmOrRefuse(
		`This permanently deletes database "${name}" and its data on node ${nodeLabel(database)}. It cannot be undone. Type ${name} to confirm: `,
		{
			yes: args.boolean('yes'),
			accept: (answer) => answer === name,
			refusal: `Not confirmed: stdin is not a terminal, so there's no one to ask before purging "${name}".`,
		},
	);
	if (!confirmed) {
		console.error('Cancelled. Nothing was changed.');
		process.exitCode = 1;
		return;
	}
	const raw = await client.purgeDatabase(name);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(`Purging "${name}": its node deletes the data, then it disappears from \`skif db list --all\`.`);
}

async function showCredentials(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, baseFlags, 'credentials');
	if (!parsed) return;
	const { args, name } = parsed;
	const client = await authenticatedClient();
	const { credentials, raw } = await client.databaseCredentials(name);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	// The URL alone on stdout, so `psql "$(skif db credentials main)"` works.
	console.log(credentials.url);
	if (process.stderr.isTTY && credentials.note) process.stderr.write(`${credentials.note}\n`);
}
