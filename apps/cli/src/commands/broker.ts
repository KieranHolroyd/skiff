import { parseArgs, rejectExtraPositionals, requirePositional, type FlagSpec } from '../args.ts';
import { CliError, UsageError } from '../errors.ts';
import { BROKER_ENGINES, brokerDetails, brokerTable, type BrokerCreateInput, type BrokerUpdateInput } from '../brokers.ts';
import { assertEnvPrefix, parseCpus, parseMegabytes } from '../databases.ts';
import { formatTime, indent, printJson } from '../output.ts';
import { authenticatedClient } from './common.ts';
import { confirmOrRefuse } from './run-operation.ts';

/** Managed queue brokers (docs/BROKERS.md, D111). Every check lives on the server; this is a thin client. */

const usage = `Usage: skif broker <command> [options]

Commands:
  list                         List brokers (the default); --all includes the trash
  create <name>                Create a broker (NATS with JetStream)
  info <name>                  Status, node, limits, internal hosts, attached projects
  update <name>                Resize (--memory, --cpus, --storage) or move to a newer --version
  attach <name> -p <project>   Connect a broker to a project (injects <PREFIX>_URL, …)
  detach <name> -p <project>   Disconnect it; the app restarts without the variables
  restart <name>               Restart the broker container (streams are kept)
  delete <name>                Move it to the trash (restorable for 7 days)
  restore <name>               Bring it back from the trash
  purge <name>                 Permanently delete a trashed broker and its streams
  logs <name>                  Broker container logs (--follow to stream)
  credentials <name>           Print the connection URL (--json for user, password, host, port)

Create options:
  -p, --project <slug>         Attach to this project right away (placed on its node)
      --engine <engine>        nats (default)
      --prefix <PREFIX>        Env prefix for the attachment (default NATS)
      --version <version>      Engine version (nats 2.12|2.11)
      --placement <where>      auto (default), edge, or a node id
      --memory <size>          Memory limit, e.g. 256M or 1G (default 256M)
      --cpus <n>               CPU limit (default 0.5)
      --storage <size>         Persistent message store cap (default 2G)
      --volume <name>          Node volume for the data (default: the node's default volume)

Options:
  -y, --yes                    Don't ask for confirmation (required when stdin isn't a terminal)
      --json                   JSON output
  -h, --help                   Show this help

Attached apps get <PREFIX>_URL, _HOST, _PORT, _USER and _PASSWORD at activation and must run on
the broker's node (\`auto\` placement handles that). Credentials need the broker:credentials
permission and every read is audited.

Examples:
  skif broker create jobs --project api          # api receives NATS_URL
  skif broker attach jobs --project worker
  nats --server "$(skif broker credentials jobs)" stream ls   # on the node, or through ssh -L`;

const baseFlags: FlagSpec = {
	json: { type: 'boolean' },
	help: { type: 'boolean', short: 'h' },
};
const listFlags: FlagSpec = { ...baseFlags, all: { type: 'boolean', short: 'a' } };
const sizeFlags: FlagSpec = {
	version: { type: 'string' },
	memory: { type: 'string' },
	cpus: { type: 'string' },
	storage: { type: 'string' },
};
const createFlags: FlagSpec = {
	...baseFlags,
	...sizeFlags,
	project: { type: 'string', short: 'p' },
	prefix: { type: 'string' },
	engine: { type: 'string' },
	placement: { type: 'string' },
	volume: { type: 'string' },
};
const updateFlags: FlagSpec = { ...baseFlags, ...sizeFlags };
const attachFlags: FlagSpec = { ...baseFlags, project: { type: 'string', short: 'p' }, prefix: { type: 'string' } };
const detachFlags: FlagSpec = { ...baseFlags, project: { type: 'string', short: 'p' } };
const confirmFlags: FlagSpec = { ...baseFlags, yes: { type: 'boolean', short: 'y' } };
const logsFlags: FlagSpec = {
	...baseFlags,
	follow: { type: 'boolean', short: 'f' },
	limit: { type: 'string' },
	level: { type: 'string' },
	q: { type: 'string' },
	after: { type: 'string' },
};

const subcommands: Record<string, (argv: string[]) => Promise<void>> = {
	list: listBrokers,
	ls: listBrokers,
	create: createBroker,
	info: showBroker,
	show: showBroker,
	update: updateBroker,
	attach: attachBroker,
	detach: detachBroker,
	restart: restartBroker,
	delete: deleteBroker,
	rm: deleteBroker,
	restore: restoreBroker,
	purge: purgeBroker,
	logs: brokerLogs,
	credentials: showCredentials,
	creds: showCredentials,
};

export async function brokerCommand(argv: string[]): Promise<void> {
	const first = argv[0];
	if (first && !first.startsWith('-')) {
		const handler = subcommands[first];
		if (!handler) throw new UsageError(`Unknown broker command "${first}".\n\n${usage}`);
		await handler(argv.slice(1));
		return;
	}
	await listBrokers(argv);
}

/** Parse, handle --help, and return the single `<name>` positional. */
function parseNamed(argv: string[], spec: FlagSpec, command: string) {
	const args = parseArgs(argv, spec);
	if (args.boolean('help')) {
		console.log(usage);
		return null;
	}
	const line = `Usage: skif broker ${command} <name>`;
	rejectExtraPositionals(args, 1, line);
	const name = requirePositional(args, 0, `broker name.\n\n${line}`);
	return { args, name };
}

function requireProject(project: string | undefined, command: string, name: string): string {
	if (!project) throw new UsageError(`Name the project: skif broker ${command} ${name} --project <slug>`);
	return project;
}

/** The size flags shared by create and update. */
function sizes(args: ReturnType<typeof parseArgs>): BrokerUpdateInput {
	const out: BrokerUpdateInput = {};
	const version = args.string('version');
	if (version) out.version = version;
	const memory = args.string('memory');
	if (memory) out.memoryMb = parseMegabytes(memory, '--memory');
	const cpus = args.string('cpus');
	if (cpus) out.cpus = parseCpus(cpus);
	const storage = args.string('storage');
	if (storage) out.storageMb = parseMegabytes(storage, '--storage');
	return out;
}

async function listBrokers(argv: string[]): Promise<void> {
	const args = parseArgs(argv, listFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 0, 'Usage: skif broker list [--all] [--json]');
	const client = await authenticatedClient();
	const { brokers, raw } = await client.listBrokers({ includeDeleted: args.boolean('all') });
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	if (brokers.length === 0) {
		console.log('No brokers yet. Create one with `skif broker create <name> --project <slug>`.');
		return;
	}
	console.log(brokerTable(brokers));
}

async function createBroker(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, createFlags, 'create');
	if (!parsed) return;
	const { args, name } = parsed;
	const prefix = args.string('prefix');
	const project = args.string('project');
	if (prefix !== undefined) {
		if (!project) throw new UsageError('--prefix needs --project (it names the attachment).');
		assertEnvPrefix(prefix);
	}
	const input: BrokerCreateInput = { name, ...sizes(args) };
	const engine = args.string('engine');
	if (engine !== undefined) {
		if (!(BROKER_ENGINES as readonly string[]).includes(engine))
			throw new UsageError(`--engine must be one of ${BROKER_ENGINES.join(', ')}.`);
		input.engine = engine;
	}
	if (project) input.project = project;
	if (prefix) input.envPrefix = prefix;
	const placement = args.string('placement');
	if (placement) input.placement = placement;
	const volume = args.string('volume');
	if (volume) input.volume = volume;

	const client = await authenticatedClient();
	const { broker, raw } = await client.createBroker(input);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(
		`Created ${broker.engineLabel} ${broker.version} broker "${broker.name}" on node ${broker.nodeName ?? broker.nodeId} (${broker.status}).`,
	);
	const attached = broker.attachments[0];
	if (attached)
		console.log(
			`Attached to ${attached.projectSlug} as ${attached.envPrefix}: it receives ${attached.envNames.join(', ')} at its next activation.`,
		);
	const steps = [
		`Follow it:    skif broker info ${broker.name}`,
		...(attached ? [] : [`Attach:       skif broker attach ${broker.name} --project <slug>`]),
		`Connect:      skif broker credentials ${broker.name}`,
	];
	console.log(`\nNext steps:\n${indent(steps)}`);
}

async function showBroker(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, baseFlags, 'info');
	if (!parsed) return;
	const { args, name } = parsed;
	const client = await authenticatedClient();
	const { broker, raw } = await client.getBroker(name, { includeDeleted: true });
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(brokerDetails(broker));
	if (broker.deletedAt)
		console.log(`\nIn the trash. Restore with \`skif broker restore ${broker.name}\`; delete for good with \`skif broker purge ${broker.name}\`.`);
}

async function updateBroker(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, updateFlags, 'update');
	if (!parsed) return;
	const { args, name } = parsed;
	const patch = sizes(args);
	if (Object.keys(patch).length === 0)
		throw new UsageError('Nothing to update. Pass --memory, --cpus, --storage or --version.');
	const client = await authenticatedClient();
	const { broker, raw } = await client.updateBroker(name, patch);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(`Updated "${broker.name}"; it restarts on node ${broker.nodeName ?? broker.nodeId} with the new settings.`);
}

async function attachBroker(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, attachFlags, 'attach');
	if (!parsed) return;
	const { args, name } = parsed;
	const project = requireProject(args.string('project'), 'attach', name);
	const prefix = args.string('prefix');
	if (prefix !== undefined) assertEnvPrefix(prefix);
	const client = await authenticatedClient();
	const { attachment, warning, raw } = await client.attachBroker(project, {
		broker: name,
		...(prefix ? { envPrefix: prefix } : {}),
	});
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(`Attached "${attachment.brokerName}" to ${attachment.projectSlug} as ${attachment.envPrefix}.`);
	console.log(`${attachment.projectSlug} receives ${attachment.envNames.join(', ')} at activation; a running app restarts on its own.`);
	if (warning) console.log(`Note: ${warning}`);
}

async function detachBroker(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, detachFlags, 'detach');
	if (!parsed) return;
	const { args, name } = parsed;
	const project = requireProject(args.string('project'), 'detach', name);
	const client = await authenticatedClient();
	const raw = await client.detachBroker(project, name);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(`Detached "${name}" from ${project}. The app restarts without its broker variables; streams are untouched.`);
}

async function restartBroker(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, baseFlags, 'restart');
	if (!parsed) return;
	const { args, name } = parsed;
	const client = await authenticatedClient();
	const { broker, raw } = await client.restartBroker(name);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(`Restarting "${broker.name}" on node ${broker.nodeName ?? broker.nodeId}. Follow it with \`skif broker info ${broker.name}\`.`);
}

async function deleteBroker(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, confirmFlags, 'delete');
	if (!parsed) return;
	const { args, name } = parsed;
	const client = await authenticatedClient();
	// Fail before asking when the server would refuse anyway.
	const { broker: current } = await client.getBroker(name);
	if (current.attachments.length > 0)
		throw new CliError(
			`Broker "${name}" is attached to ${current.attachments.map((item) => item.projectSlug).join(', ')}. Detach it first.`,
			{
				code: 'conflict',
				suggestions: current.attachments.map((item) => `skif broker detach ${name} --project ${item.projectSlug}`),
			},
		);
	const confirmed = await confirmOrRefuse(
		`Delete broker "${name}"? Its container stops now; its streams stay on node ${current.nodeName ?? current.nodeId} and it is restorable for 7 days. [y/N] `,
		{
			yes: args.boolean('yes'),
			accept: (answer) => /^y(es)?$/i.test(answer),
			refusal: `Not confirmed: stdin is not a terminal, so there's no one to ask before deleting "${name}".`,
		},
	);
	if (!confirmed) {
		console.error('Cancelled. Nothing was changed.');
		process.exitCode = 1;
		return;
	}
	const { broker, raw } = await client.deleteBroker(name);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(`Deleted "${broker.name}".${broker.purgeAt ? ` It is purged for good after ${formatTime(broker.purgeAt)}.` : ''}`);
	console.log(`Undo: skif broker restore ${broker.name}`);
}

async function restoreBroker(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, baseFlags, 'restore');
	if (!parsed) return;
	const { args, name } = parsed;
	const client = await authenticatedClient();
	const { broker, raw } = await client.restoreBroker(name);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(`Restored "${broker.name}" on node ${broker.nodeName ?? broker.nodeId} (${broker.status}). Re-attach projects with \`skif broker attach\`.`);
}

async function purgeBroker(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, confirmFlags, 'purge');
	if (!parsed) return;
	const { args, name } = parsed;
	const client = await authenticatedClient();
	const { broker } = await client.getBroker(name, { includeDeleted: true });
	if (!broker.deletedAt)
		throw new CliError(`Broker "${name}" is not in the trash. Delete it first.`, {
			code: 'conflict',
			suggestions: [`skif broker delete ${name}`],
		});
	const confirmed = await confirmOrRefuse(
		`This permanently deletes broker "${name}" and its streams on node ${broker.nodeName ?? broker.nodeId}. It cannot be undone. Type ${name} to confirm: `,
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
	const raw = await client.purgeBroker(name);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(`Purging "${name}": its node deletes the data, then it disappears from \`skif broker list --all\`.`);
}

async function showCredentials(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, baseFlags, 'credentials');
	if (!parsed) return;
	const { args, name } = parsed;
	const client = await authenticatedClient();
	const { credentials, raw } = await client.brokerCredentials(name);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	// The URL alone on stdout, so `nats --server "$(skif broker credentials jobs)"` works.
	console.log(credentials.url);
	if (process.stderr.isTTY && credentials.note) process.stderr.write(`${credentials.note}\n`);
}

async function brokerLogs(argv: string[]): Promise<void> {
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
		const page = await client.brokerLogs(name, {
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
