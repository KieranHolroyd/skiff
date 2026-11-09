import { parseArgs, rejectExtraPositionals, requirePositional, type FlagSpec } from '../args.ts';
import { UsageError } from '../errors.ts';
import {
	LOG_DRAIN_FORMATS,
	LOG_DRAIN_KINDS,
	LOG_LEVELS,
	logDrainDetails,
	logDrainTable,
	parseChoice,
	parseHeaderFlags,
	parseSources,
	type LogDrainCreateInput,
	type LogDrainUpdateInput,
} from '../log-drains.ts';
import { printJson } from '../output.ts';
import { authenticatedClient } from './common.ts';
import { confirmOrRefuse } from './run-operation.ts';

/**
 * Log drains (DESIGN §8): forward the org's log lines to a webhook or an OTLP receiver. Every
 * check lives on the server; this is a thin client.
 */

const usage = `Usage: yoal log-drain <command> [options]

Commands:
  list                         List drains with their status and counters (the default)
  create <name>                Forward logs from now on (--url, and --otlp for an OTLP receiver)
  info <id>                    One drain: target, filters, delivered and dropped lines, last error
  update <id>                  Change the URL, filters or headers; --enable / --disable; --rotate-secret
  test <id>                    Send one test line now and show what the receiver answered
  delete <id>                  Delete a drain (forwarding stops at once)

Create and update options:
      --url <url>              Receiver (https://). OTLP: the collector; /v1/logs is added to a bare origin
      --otlp                   create: send OTLP/HTTP JSON instead of a webhook
      --format ndjson|json     Webhook body: one JSON object per line (default) or a JSON array
  -p, --project <slug>         create: only this project's logs (default: every project and managed services)
      --source <source>        Only build, runtime, system or services; repeat or comma-separate (default: all)
      --all-sources            update: forward every source again
      --min-level <level>      Only this level and above: debug, info, warn, error
      --all-levels             update: forward every level again
  -H, --header "Name: value"   Sent with every request, e.g. an API key; repeat for more. Values are write-only
      --clear-headers          update: remove every header
      --name <name>            update: rename the drain
      --disabled               create: create it switched off
      --enable, --disable      update: switch forwarding on (from now on) or off
      --rotate-secret          update: issue a new webhook signing secret (printed once)

Options:
  -y, --yes                    Don't ask for confirmation (required when stdin isn't a terminal)
      --json                   JSON output
  -h, --help                   Show this help

Webhook requests carry X-Yoal-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>.
The secret is printed once, on create and on --rotate-secret. Org owners and admins manage drains;
a drain to a private address can only be set up by a platform admin in the dashboard.

Examples:
  yoal log-drain create archive --url https://logs.example.com/yoal -H "Authorization: Bearer …"
  yoal log-drain create grafana --otlp --url https://otlp-gateway.grafana.net/otlp \\
    -H "Authorization: Basic …" --min-level info
  yoal log-drain create shop-errors -p shop --source runtime --min-level error --url https://hooks.example.com/in
  yoal log-drain test ldr_…`;

const baseFlags: FlagSpec = {
	json: { type: 'boolean' },
	help: { type: 'boolean', short: 'h' },
};
const editFlags: FlagSpec = {
	...baseFlags,
	url: { type: 'string' },
	format: { type: 'string' },
	source: { type: 'string', multiple: true },
	'min-level': { type: 'string' },
	header: { type: 'string', short: 'H', multiple: true },
};
const createFlags: FlagSpec = {
	...editFlags,
	otlp: { type: 'boolean' },
	project: { type: 'string', short: 'p' },
	disabled: { type: 'boolean' },
};
const updateFlags: FlagSpec = {
	...editFlags,
	name: { type: 'string' },
	'all-sources': { type: 'boolean' },
	'all-levels': { type: 'boolean' },
	'clear-headers': { type: 'boolean' },
	enable: { type: 'boolean' },
	disable: { type: 'boolean' },
	'rotate-secret': { type: 'boolean' },
};
const confirmFlags: FlagSpec = { ...baseFlags, yes: { type: 'boolean', short: 'y' } };

const subcommands: Record<string, (argv: string[]) => Promise<void>> = {
	list: listDrains,
	ls: listDrains,
	create: createDrain,
	add: createDrain,
	info: showDrain,
	show: showDrain,
	update: updateDrain,
	test: testDrain,
	delete: deleteDrain,
	rm: deleteDrain,
};

export async function logDrainCommand(argv: string[]): Promise<void> {
	const first = argv[0];
	if (first && !first.startsWith('-')) {
		const handler = subcommands[first];
		if (!handler) throw new UsageError(`Unknown log-drain command "${first}".\n\n${usage}`);
		await handler(argv.slice(1));
		return;
	}
	await listDrains(argv);
}

function parseOne(argv: string[], spec: FlagSpec, command: string, what = 'id') {
	const args = parseArgs(argv, spec);
	if (args.boolean('help')) {
		console.log(usage);
		return null;
	}
	const line = `Usage: yoal log-drain ${command} <${what}>`;
	rejectExtraPositionals(args, 1, line);
	return { args, value: requirePositional(args, 0, `drain ${what}.\n\n${line}`) };
}

function printSecret(secret: string | null): void {
	if (!secret) return;
	console.log(`\nSigning secret (shown once; store it with the receiver):\n  ${secret}`);
	console.log('Verify X-Yoal-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>.');
}

async function listDrains(argv: string[]): Promise<void> {
	const args = parseArgs(argv, baseFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 0, 'Usage: yoal log-drain list [--json]');
	const client = await authenticatedClient();
	const { drains, raw } = await client.listLogDrains();
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	if (drains.length === 0) {
		console.log('No log drains yet. Create one with `yoal log-drain create <name> --url https://…`.');
		return;
	}
	console.log(logDrainTable(drains));
}

async function createDrain(argv: string[]): Promise<void> {
	const parsed = parseOne(argv, createFlags, 'create', 'name');
	if (!parsed) return;
	const { args, value } = parsed;
	const url = args.string('url');
	if (!url) throw new UsageError('Name the receiver: --url https://….');
	const kind = args.boolean('otlp') ? LOG_DRAIN_KINDS[1] : LOG_DRAIN_KINDS[0];
	const format = parseChoice(args.string('format'), LOG_DRAIN_FORMATS, '--format');
	if (format && kind === 'otlp') throw new UsageError('--format is for webhook drains; OTLP drains always send OTLP/JSON.');
	const input: LogDrainCreateInput = { name: value, kind, url };
	if (format) input.format = format;
	const project = args.string('project');
	if (project) input.project = project;
	const sources = parseSources(args.strings('source'));
	if (sources.length) input.sources = sources;
	const minLevel = parseChoice(args.string('min-level'), LOG_LEVELS, '--min-level');
	if (minLevel) input.minLevel = minLevel;
	const headers = parseHeaderFlags(args.strings('header'));
	if (Object.keys(headers).length) input.headers = headers;
	if (args.boolean('disabled')) input.enabled = false;

	const client = await authenticatedClient();
	const { drain, signingSecret, raw } = await client.createLogDrain(input);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(`Created ${drain.id} (${drain.name}) → ${drain.url}. Lines logged from now on are forwarded within a few seconds.`);
	printSecret(signingSecret);
	console.log(`\nCheck the receiver: yoal log-drain test ${drain.id}`);
}

async function showDrain(argv: string[]): Promise<void> {
	const parsed = parseOne(argv, baseFlags, 'info');
	if (!parsed) return;
	const client = await authenticatedClient();
	const { drain, raw } = await client.getLogDrain(parsed.value);
	if (parsed.args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(logDrainDetails(drain));
}

async function updateDrain(argv: string[]): Promise<void> {
	const parsed = parseOne(argv, updateFlags, 'update');
	if (!parsed) return;
	const { args, value } = parsed;
	const pick = (a: string, b: string) => {
		if (args.boolean(a) && args.boolean(b)) throw new UsageError(`Pick one of --${a} and --${b}.`);
	};
	pick('enable', 'disable');
	const input: LogDrainUpdateInput = {};
	const name = args.string('name');
	if (name) input.name = name;
	const url = args.string('url');
	if (url) input.url = url;
	const format = parseChoice(args.string('format'), LOG_DRAIN_FORMATS, '--format');
	if (format) input.format = format;
	const sources = parseSources(args.strings('source'));
	if (sources.length && args.boolean('all-sources')) throw new UsageError('Pick one of --source and --all-sources.');
	if (sources.length) input.sources = sources;
	if (args.boolean('all-sources')) input.sources = [];
	const minLevel = parseChoice(args.string('min-level'), LOG_LEVELS, '--min-level');
	if (minLevel && args.boolean('all-levels')) throw new UsageError('Pick one of --min-level and --all-levels.');
	if (minLevel) input.minLevel = minLevel;
	if (args.boolean('all-levels')) input.minLevel = null;
	const headers = parseHeaderFlags(args.strings('header'));
	if (Object.keys(headers).length && args.boolean('clear-headers')) throw new UsageError('Pick one of --header and --clear-headers.');
	// Headers are replaced as a set: pass every header the drain should keep.
	if (Object.keys(headers).length) input.headers = headers;
	if (args.boolean('clear-headers')) input.headers = null;
	if (args.boolean('enable')) input.enabled = true;
	if (args.boolean('disable')) input.enabled = false;
	if (args.boolean('rotate-secret')) input.rotateSigningSecret = true;
	if (Object.keys(input).length === 0)
		throw new UsageError('Nothing to update. Pass --url, --source, --min-level, --header, --name, --enable, --disable or --rotate-secret.');

	const client = await authenticatedClient();
	const { drain, signingSecret, raw } = await client.updateLogDrain(value, input);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(logDrainDetails(drain));
	printSecret(signingSecret);
}

async function testDrain(argv: string[]): Promise<void> {
	const parsed = parseOne(argv, baseFlags, 'test');
	if (!parsed) return;
	const client = await authenticatedClient();
	const { result, raw } = await client.testLogDrain(parsed.value);
	if (parsed.args.boolean('json')) printJson(raw);
	else console.log(result.ok ? `OK: ${result.message}` : `Failed: ${result.message}`);
	if (!result.ok) process.exitCode = 1;
}

async function deleteDrain(argv: string[]): Promise<void> {
	const parsed = parseOne(argv, confirmFlags, 'delete');
	if (!parsed) return;
	const { args, value } = parsed;
	const client = await authenticatedClient();
	const { drain } = await client.getLogDrain(value);
	const confirmed = await confirmOrRefuse(`Delete log drain ${drain.id} (${drain.name} → ${drain.url})? Forwarding stops at once. [y/N] `, {
		yes: args.boolean('yes'),
		accept: (answer) => /^y(es)?$/i.test(answer),
		refusal: `Not confirmed: stdin is not a terminal, so there's no one to ask before deleting ${drain.id}. Pass --yes.`,
	});
	if (!confirmed) return;
	const raw = await client.deleteLogDrain(value);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(`Deleted ${drain.id}.`);
}
