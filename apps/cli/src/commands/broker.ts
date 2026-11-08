import { readFile } from 'node:fs/promises';
import { parseArgs, rejectExtraPositionals, requirePositional, type FlagSpec } from '../args.ts';
import { CliError, UsageError } from '../errors.ts';
import {
	BROKER_ENGINES,
	assertQueueName,
	brokerDetails,
	brokerMetricsSummary,
	brokerMetricsTable,
	brokerQueuesTable,
	brokerTable,
	checkMessageBody,
	parseCount,
	parseDelaySeconds,
	peekReport,
	queueOfStream,
	resolveStream,
	sendSummary,
	trimFinalNewline,
	type BrokerCreateInput,
	type BrokerUpdateInput,
} from '../brokers.ts';
import { assertEnvPrefix, parseCpus, parseMegabytes } from '../databases.ts';
import { NODE_TASK_LIMITS } from '../node-tasks.ts';
import { parseDuration } from '../object-storage.ts';
import { formatBytes, formatTime, indent, plural, printJson } from '../output.ts';
import { readAllStdin } from '../prompt.ts';
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
  metrics <name>               Store, backlog, connections and message rates (--since 1h, or
                               --from/--to; --interval 1m|1h; --samples for every row)
  queues <name>                JetStream streams and consumers with their backlog
  credentials <name>           Print the connection URL (--json for user, password, host, port)

Queue tools (run on the broker's node; <queue> is a function queue, stored as SKIFF_Q_<queue>):
  queue-create <name> <queue>  Create a function queue's stream now instead of on first use
  send <name> <queue> [body]   Publish a test message: body as an argument, --body, --file <path>,
                               or piped on stdin; JSON unless --text (--delay 30s, --count 10)
  peek <name> <queue>          Read messages without consuming them (--limit 20, --from <seq>)
  redrive <name> <dlq> --to <queue>
                               Move dead-lettered messages back into a queue (--limit <n>)
  queue-purge <name> <queue>   Remove every message; the stream and its consumers stay
  queue-rm <name> <queue>      Delete the stream and its messages (a function queue's stream
                               comes back on its next use)
  message-rm <name> <queue> <seq>
                               Delete one message by sequence
  peek, queue-purge, queue-rm and message-rm take --stream <stream> instead of <queue> for a
  stream your app created itself (e.g. skif broker peek jobs --stream EVENTS).

Create options:
  -p, --project <slug>         Attach to this project right away (placed on its node)
      --engine <engine>        nats (default)
      --prefix <PREFIX>        Env prefix for the attachment (default NATS)
      --version <version>      Engine version (nats 2.12|2.11)
      --placement <where>      auto (default), edge, or a node id
      --memory <size>          Memory limit, e.g. 256M or 1G (default 256M)
      --cpus <n>               CPU limit (default 0.5)
      --storage <size>         Persistent message store cap (default 2G)
      --disk <where>           system, fast, bulk or a disk name (default: Settings → Storage)

Options:
  -y, --yes                    Don't ask for confirmation (required when stdin isn't a terminal)
      --json                   JSON output (queue tools print the task with its raw result)
  -h, --help                   Show this help

Attached apps get <PREFIX>_URL, _HOST, _PORT, _USER and _PASSWORD at activation and must run on
the broker's node (\`auto\` placement handles that). Credentials need the broker:credentials
permission and every read is audited.

Examples:
  skif broker create jobs --project api          # api receives NATS_URL
  skif broker attach jobs --project worker
  nats --server "$(skif broker credentials jobs)" stream ls   # on the node, or through ssh -L
  skif broker send jobs emails '{"to":"a@example.com"}' --count 5
  skif broker peek jobs emails-dlq
  skif broker redrive jobs emails-dlq --to emails`;

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
	disk: { type: 'string' },
	/** Deprecated alias of --disk. */
	volume: { type: 'string' },
};
const updateFlags: FlagSpec = { ...baseFlags, ...sizeFlags };
const attachFlags: FlagSpec = { ...baseFlags, project: { type: 'string', short: 'p' }, prefix: { type: 'string' } };
const detachFlags: FlagSpec = { ...baseFlags, project: { type: 'string', short: 'p' } };
const confirmFlags: FlagSpec = { ...baseFlags, yes: { type: 'boolean', short: 'y' } };
const metricsFlags: FlagSpec = {
	...baseFlags,
	since: { type: 'string' },
	from: { type: 'string' },
	to: { type: 'string' },
	interval: { type: 'string' },
	samples: { type: 'boolean' },
};
const logsFlags: FlagSpec = {
	...baseFlags,
	follow: { type: 'boolean', short: 'f' },
	limit: { type: 'string' },
	level: { type: 'string' },
	q: { type: 'string' },
	after: { type: 'string' },
};

const streamFlags: FlagSpec = { ...baseFlags, stream: { type: 'string' } };
const streamConfirmFlags: FlagSpec = { ...confirmFlags, stream: { type: 'string' } };
const sendFlags: FlagSpec = {
	...baseFlags,
	body: { type: 'string' },
	file: { type: 'string' },
	text: { type: 'boolean' },
	delay: { type: 'string' },
	count: { type: 'string' },
};
const peekFlags: FlagSpec = { ...streamFlags, limit: { type: 'string' }, from: { type: 'string' } };
const redriveFlags: FlagSpec = { ...baseFlags, to: { type: 'string' }, limit: { type: 'string' } };

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
	metrics: showMetrics,
	queues: showQueues,
	streams: showQueues,
	credentials: showCredentials,
	creds: showCredentials,
	'queue-create': createQueue,
	send: sendMessage,
	publish: sendMessage,
	peek: peekMessages,
	redrive: redriveQueue,
	'queue-purge': purgeStream,
	'queue-rm': deleteStream,
	'message-rm': deleteMessage,
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
	const disk = args.string('disk') ?? args.string('volume');
	if (disk) input.storage = disk;

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
	const [{ broker }, { points, interval: used, raw }] = await Promise.all([
		client.getBroker(name, { includeDeleted: true }),
		client.brokerMetrics(name, { from: start, to, interval }),
	]);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	if (points.length === 0) {
		console.log(
			`No samples for "${name}" in that range. The agent reports once a minute while the broker runs, and the platform keeps them only with the telemetry store installed; \`skif broker queues ${name}\` works without it.`,
		);
		return;
	}
	console.log(`${plural(points.length, 'sample')} at ${used}:\n`);
	console.log(brokerMetricsSummary(points, broker.storageMb));
	if (args.boolean('samples')) console.log(`\n${brokerMetricsTable(points)}`);
}

async function showQueues(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, baseFlags, 'queues');
	if (!parsed) return;
	const { args, name } = parsed;
	const client = await authenticatedClient();
	const { queues, raw } = await client.brokerQueues(name);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	if (!queues.at) {
		console.log(`No stream listing for "${name}" yet. Its node lists streams about a minute after the broker starts.`);
		return;
	}
	if (queues.streams.length === 0) {
		console.log(`"${name}" has no streams yet (listed ${formatTime(queues.at)}). A function queue creates its stream on first use.`);
		return;
	}
	console.log(brokerQueuesTable(queues));
	console.log(`\nListed ${formatTime(queues.at)}.${queues.truncated ? ` Only the first ${queues.streams.length} streams by name are shown.` : ''}`);
}

// --- queue tools (D124) -----------------------------------------------------

/** Parse, handle --help, and return exactly `count` positionals (broker name first). */
function parsePositionals(argv: string[], spec: FlagSpec, line: string, names: string[], optional = 0) {
	const args = parseArgs(argv, spec);
	if (args.boolean('help')) {
		console.log(usage);
		return null;
	}
	const full = `Usage: skif broker ${line}`;
	rejectExtraPositionals(args, names.length + optional, full);
	const values = names.map((name, index) => requirePositional(args, index, `${name}.\n\n${full}`));
	return { args, values };
}

/** `<name> <queue>` or `<name> --stream <stream>`, for the commands that take either. */
function parseStreamTarget(argv: string[], spec: FlagSpec, command: string, extra: string[] = []) {
	const args = parseArgs(argv, spec);
	if (args.boolean('help')) {
		console.log(usage);
		return null;
	}
	const rawStream = args.string('stream');
	const withStream = rawStream !== undefined;
	const tail = extra.map((name) => ` <${name}>`).join('');
	const line = `Usage: skif broker ${command} <name> <queue>${tail}  (or <name>${tail} --stream <stream>)`;
	const count = 1 + (withStream ? 0 : 1) + extra.length;
	rejectExtraPositionals(args, count, line);
	const name = requirePositional(args, 0, `broker name.\n\n${line}`);
	const queue = withStream ? undefined : requirePositional(args, 1, `queue name (or pass --stream <stream>).\n\n${line}`);
	const rest = extra.map((label, index) => requirePositional(args, 1 + (withStream ? 0 : 1) + index, `${label}.\n\n${line}`));
	return { args, name, rest, ...resolveStream(queue, rawStream) };
}

function cancelled(): void {
	console.error('Cancelled. Nothing was changed.');
	process.exitCode = 1;
}

async function createQueue(argv: string[]): Promise<void> {
	const parsed = parsePositionals(argv, baseFlags, 'queue-create <name> <queue>', ['broker name', 'queue name']);
	if (!parsed) return;
	const [name, queue] = parsed.values as [string, string];
	assertQueueName(queue);
	const client = await authenticatedClient();
	const { result, raw } = await client.brokerQueueCreate(name, queue);
	if (parsed.args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(
		result.created
			? `Created ${result.stream} on "${name}". Consumers and producers of queue ${queue} use it from now on.`
			: `${result.stream} already exists on "${name}"; nothing changed.`,
	);
}

/** The body from exactly one of: the argument, --body, --file, or stdin when it is piped. */
async function messageBody(positional: string | undefined, args: ReturnType<typeof parseArgs>): Promise<string> {
	const flag = args.string('body');
	const file = args.string('file');
	const given = [positional !== undefined, flag !== undefined, file !== undefined].filter(Boolean).length;
	if (given > 1) throw new UsageError('Give the body once: as an argument, with --body, or with --file.');
	if (positional !== undefined) return positional;
	if (flag !== undefined) return flag;
	if (file !== undefined) {
		try {
			return trimFinalNewline(file === '-' ? await readAllStdin() : await readFile(file, 'utf8'));
		} catch (error) {
			throw new UsageError(`Could not read --file ${file}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (!process.stdin.isTTY) {
		const piped = trimFinalNewline(await readAllStdin());
		if (piped !== '') return piped;
	}
	throw new UsageError('Give a message body: skif broker send <name> <queue> \'{"hello":"world"}\' (or --body, --file, or pipe it on stdin).');
}

async function sendMessage(argv: string[]): Promise<void> {
	const parsed = parsePositionals(argv, sendFlags, 'send <name> <queue> [body]', ['broker name', 'queue name'], 1);
	if (!parsed) return;
	const { args } = parsed;
	const [name, queue] = parsed.values as [string, string];
	assertQueueName(queue);
	const contentType = args.boolean('text') ? 'text' : 'json';
	const delay = args.string('delay');
	const delaySeconds = delay !== undefined ? parseDelaySeconds(delay) : undefined;
	const countFlag = args.string('count');
	const count = countFlag !== undefined ? parseCount(countFlag, '--count', 1, NODE_TASK_LIMITS.sendCount) : undefined;
	const body = await messageBody(args.positionals[2], args);
	checkMessageBody(body, contentType);
	const client = await authenticatedClient();
	const { result, raw } = await client.brokerQueueSend(name, queue, {
		body,
		contentType,
		...(delaySeconds ? { delaySeconds } : {}),
		...(count !== undefined ? { count } : {}),
	});
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(sendSummary(result, delaySeconds));
}

async function peekMessages(argv: string[]): Promise<void> {
	const parsed = parseStreamTarget(argv, peekFlags, 'peek');
	if (!parsed) return;
	const { args, name, stream } = parsed;
	const limitFlag = args.string('limit');
	const limit = limitFlag !== undefined ? parseCount(limitFlag, '--limit', 1, NODE_TASK_LIMITS.peekMessages) : undefined;
	const fromFlag = args.string('from');
	const from = fromFlag !== undefined ? parseCount(fromFlag, '--from', 1, Number.MAX_SAFE_INTEGER) : undefined;
	const client = await authenticatedClient();
	const { result, raw } = await client.brokerStreamPeek(name, stream, {
		...(limit !== undefined ? { limit } : {}),
		...(from !== undefined ? { from } : {}),
	});
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	const queue = queueOfStream(stream);
	const target = queue && args.string('stream') === undefined ? queue : `--stream ${stream}`;
	console.log(
		peekReport(result, (seq) => `skif broker peek ${name} ${target}${limit !== undefined ? ` --limit ${limit}` : ''} --from ${seq}`),
	);
}

async function redriveQueue(argv: string[]): Promise<void> {
	const parsed = parsePositionals(argv, redriveFlags, 'redrive <name> <dlq> --to <queue> [--limit <n>]', [
		'broker name',
		'dead-letter queue name',
	]);
	if (!parsed) return;
	const { args } = parsed;
	const [name, from] = parsed.values as [string, string];
	const to = args.string('to');
	if (!to) throw new UsageError(`Name the queue to move the messages to: skif broker redrive ${name} ${from} --to <queue>`);
	assertQueueName(from, 'dead-letter queue');
	assertQueueName(to);
	if (from === to) throw new UsageError('--to must be a different queue from the dead-letter queue.');
	const limitFlag = args.string('limit');
	const limit = limitFlag !== undefined ? parseCount(limitFlag, '--limit', 1, NODE_TASK_LIMITS.redriveMessages) : undefined;
	const client = await authenticatedClient();
	const { result, raw } = await client.brokerQueueRedrive(name, from, { to, ...(limit !== undefined ? { limit } : {}) });
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(`Moved ${plural(result.moved, 'message')} from ${from} to ${to}.`);
	if (result.remaining > 0)
		console.log(`${plural(result.remaining, 'message')} still in ${from}. Run it again to move more.`);
}

async function purgeStream(argv: string[]): Promise<void> {
	const parsed = parseStreamTarget(argv, streamConfirmFlags, 'queue-purge');
	if (!parsed) return;
	const { args, name, stream, label } = parsed;
	const confirmed = await confirmOrRefuse(
		`Remove every message from ${label} on broker "${name}"? The stream and its consumers stay. This cannot be undone. [y/N] `,
		{
			yes: args.boolean('yes'),
			refusal: `Not confirmed: stdin is not a terminal, so there's no one to ask before purging ${stream}.`,
		},
	);
	if (!confirmed) return cancelled();
	const client = await authenticatedClient();
	const { result, raw } = await client.brokerStreamPurge(name, stream);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(`Purged ${plural(result.purged, 'message')} from ${result.stream}.`);
}

async function deleteStream(argv: string[]): Promise<void> {
	const parsed = parseStreamTarget(argv, streamConfirmFlags, 'queue-rm');
	if (!parsed) return;
	const { args, name, stream, label } = parsed;
	const comesBack = queueOfStream(stream) ? ' A function queue gets a new, empty stream on its next use.' : '';
	const confirmed = await confirmOrRefuse(
		`Delete ${label} on broker "${name}" with every message and consumer in it?${comesBack} This cannot be undone. [y/N] `,
		{
			yes: args.boolean('yes'),
			refusal: `Not confirmed: stdin is not a terminal, so there's no one to ask before deleting ${stream}.`,
		},
	);
	if (!confirmed) return cancelled();
	const client = await authenticatedClient();
	const { result, raw } = await client.brokerStreamDelete(name, stream);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(result.deleted ? `Deleted ${result.stream} from "${name}".` : `${result.stream} was not on "${name}"; nothing changed.`);
}

async function deleteMessage(argv: string[]): Promise<void> {
	const parsed = parseStreamTarget(argv, streamConfirmFlags, 'message-rm', ['seq']);
	if (!parsed) return;
	const { args, name, stream, label } = parsed;
	const seq = parseCount(parsed.rest[0]!, '<seq>', 1, Number.MAX_SAFE_INTEGER);
	const confirmed = await confirmOrRefuse(`Delete message #${seq} from ${label} on broker "${name}"? [y/N] `, {
		yes: args.boolean('yes'),
		refusal: `Not confirmed: stdin is not a terminal, so there's no one to ask before deleting message #${seq}.`,
	});
	if (!confirmed) return cancelled();
	const client = await authenticatedClient();
	const { result, raw } = await client.brokerStreamDeleteMessage(name, stream, seq);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	if (!result.deleted) {
		console.log(`Message #${seq} is not in ${result.stream} (already consumed or deleted); nothing changed.`);
		return;
	}
	const left = result.state ? ` ${result.stream} now holds ${plural(result.state.messages, 'message')} (${formatBytes(result.state.bytes)}).` : '';
	console.log(`Deleted message #${seq} from ${result.stream}.${left}`);
}
