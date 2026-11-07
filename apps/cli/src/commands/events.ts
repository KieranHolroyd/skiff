import { parseArgs, rejectExtraPositionals, requirePositional, type FlagSpec } from '../args.ts';
import { UsageError } from '../errors.ts';
import {
	EVENT_SOURCES,
	eventDeliveryTable,
	eventRuleDetails,
	eventRuleTable,
	watching,
	type EventRuleCreateInput,
	type EventRuleUpdateInput,
	type EventSourceName,
} from '../events.ts';
import { printJson } from '../output.ts';
import { authenticatedClient } from './common.ts';
import { confirmOrRefuse } from './run-operation.ts';

/**
 * Event notifications (docs/EVENTS.md, D122): publish platform events into a function queue.
 * Every check lives on the server; this is a thin client.
 */

const usage = `Usage: skif events <command> [options]

Commands:
  list                         List event rules (the default)
  create <source>              Publish a source's events to a queue (storage, alerts, deployments, database-backups)
  info <id>                    One rule, with its delivery counts and last error
  update <id>                  Change events, key filters, queue or description; --enable / --disable
  delete <id>                  Delete a rule (its undelivered events go with it)
  test <id>                    Queue one synthetic event, to check the consumer end to end
  deliveries [<id>]            Recent deliveries, newest first (--status pending|delivered|failed)

Create options:
      --broker <name>          Managed broker that holds the queue (required)
      --queue <name>           Queue to publish to (required); the function consumes it
  -e, --event <event>          Only this event; repeat for more (default: all of the source's events)
      --storage <name>         storage: the instance to watch (required)
      --bucket <name>          storage: the bucket to watch (required)
      --prefix <prefix>        storage: only keys that start with this (e.g. uploads/)
      --suffix <suffix>        storage: only keys that end with this (e.g. .jpg)
  -p, --project <slug>         deployments: only this project (default: every project)
      --database <name>        database-backups: only this database (default: every database)
      --rule <id>              alerts: only this alert rule (default: every rule)
      --description <text>     A note for the rule list

Events:
  storage            object-create, object-delete     (body: Cloudflare's R2 notification shape)
  alerts             firing, resolved
  deployments        created, promoted, failed
  database-backups   completed, failed

Options:
  -y, --yes                    Don't ask for confirmation (required when stdin isn't a terminal)
      --json                   JSON output
  -h, --help                   Show this help

The function consumes the queue like any other (wrangler \`queues.consumers\`) and receives each
event in \`queue()\`. Attach the broker to the function project first: skif broker attach <broker> -p <fn>.

Examples:
  skif events create storage --storage media --bucket uploads --suffix .jpg --event object-create \\
    --broker jobs --queue images
  skif events create alerts --event firing --broker jobs --queue pages
  skif events create deployments --project shop --broker jobs --queue deploys
  skif events test evr_…`;

const baseFlags: FlagSpec = {
	json: { type: 'boolean' },
	help: { type: 'boolean', short: 'h' },
};
const createFlags: FlagSpec = {
	...baseFlags,
	broker: { type: 'string' },
	queue: { type: 'string' },
	event: { type: 'string', short: 'e', multiple: true },
	storage: { type: 'string' },
	bucket: { type: 'string' },
	prefix: { type: 'string' },
	suffix: { type: 'string' },
	project: { type: 'string', short: 'p' },
	database: { type: 'string' },
	rule: { type: 'string' },
	description: { type: 'string' },
	disabled: { type: 'boolean' },
};
const updateFlags: FlagSpec = {
	...baseFlags,
	queue: { type: 'string' },
	event: { type: 'string', short: 'e', multiple: true },
	prefix: { type: 'string' },
	suffix: { type: 'string' },
	description: { type: 'string' },
	enable: { type: 'boolean' },
	disable: { type: 'boolean' },
};
const confirmFlags: FlagSpec = { ...baseFlags, yes: { type: 'boolean', short: 'y' } };
const deliveryFlags: FlagSpec = { ...baseFlags, status: { type: 'string' }, limit: { type: 'string' } };

const subcommands: Record<string, (argv: string[]) => Promise<void>> = {
	list: listRules,
	ls: listRules,
	create: createRule,
	info: showRule,
	show: showRule,
	update: updateRule,
	delete: deleteRule,
	rm: deleteRule,
	test: testRule,
	deliveries: listDeliveries,
};

export async function eventsCommand(argv: string[]): Promise<void> {
	const first = argv[0];
	if (first && !first.startsWith('-')) {
		const handler = subcommands[first];
		if (!handler) throw new UsageError(`Unknown events command "${first}".\n\n${usage}`);
		await handler(argv.slice(1));
		return;
	}
	await listRules(argv);
}

function parseOne(argv: string[], spec: FlagSpec, command: string, what = 'id') {
	const args = parseArgs(argv, spec);
	if (args.boolean('help')) {
		console.log(usage);
		return null;
	}
	const line = `Usage: skif events ${command} <${what}>`;
	rejectExtraPositionals(args, 1, line);
	return { args, value: requirePositional(args, 0, `rule ${what}.\n\n${line}`) };
}

async function listRules(argv: string[]): Promise<void> {
	const args = parseArgs(argv, baseFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 0, 'Usage: skif events list [--json]');
	const client = await authenticatedClient();
	const { rules, raw } = await client.listEventRules();
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	if (rules.length === 0) {
		console.log('No event rules yet. Create one with `skif events create <source> --broker <name> --queue <name>`.');
		return;
	}
	console.log(eventRuleTable(rules));
}

async function createRule(argv: string[]): Promise<void> {
	const parsed = parseOne(argv, createFlags, 'create', 'source');
	if (!parsed) return;
	const { args, value } = parsed;
	if (!(value in EVENT_SOURCES))
		throw new UsageError(`Unknown source "${value}". Use one of ${Object.keys(EVENT_SOURCES).join(', ')}.`);
	const source = value as EventSourceName;
	const broker = args.string('broker');
	const queue = args.string('queue');
	if (!broker || !queue) throw new UsageError('Name the target: --broker <name> --queue <name>.');
	const input: EventRuleCreateInput = { source, broker, queue };
	const events = args.strings('event');
	if (events.length > 0) input.events = events;
	for (const field of ['storage', 'bucket', 'prefix', 'suffix', 'project', 'database', 'description'] as const) {
		const given = args.string(field);
		if (given !== undefined) input[field] = given;
	}
	const rule = args.string('rule');
	if (rule) input.alertRule = rule;
	if (args.boolean('disabled')) input.enabled = false;

	const client = await authenticatedClient();
	const { rule: created, raw } = await client.createEventRule(input);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(`Created ${created.id}: ${created.source} (${watching(created)}) → queue ${created.queue} on ${created.broker}.`);
	console.log(`Consume it from a function: "queues": { "consumers": [{ "queue": "${created.queue}" }] } and skif broker attach ${created.broker} -p <fn>.`);
	if (created.source === 'storage')
		console.log('The storage instance restarts once to turn on bucket notifications.');
}

async function showRule(argv: string[]): Promise<void> {
	const parsed = parseOne(argv, baseFlags, 'info');
	if (!parsed) return;
	const client = await authenticatedClient();
	const { rule, raw } = await client.getEventRule(parsed.value);
	if (parsed.args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(eventRuleDetails(rule));
}

async function updateRule(argv: string[]): Promise<void> {
	const parsed = parseOne(argv, updateFlags, 'update');
	if (!parsed) return;
	const { args, value } = parsed;
	if (args.boolean('enable') && args.boolean('disable')) throw new UsageError('Pick one of --enable and --disable.');
	const input: EventRuleUpdateInput = {};
	const events = args.strings('event');
	if (events.length > 0) input.events = events;
	const queue = args.string('queue');
	if (queue) input.queue = queue;
	// An empty value clears the filter: --prefix "".
	for (const field of ['prefix', 'suffix', 'description'] as const) {
		const given = args.string(field);
		if (given !== undefined) input[field] = given === '' ? null : given;
	}
	if (args.boolean('enable')) input.enabled = true;
	if (args.boolean('disable')) input.enabled = false;
	if (Object.keys(input).length === 0)
		throw new UsageError('Nothing to update. Pass --event, --prefix, --suffix, --queue, --description, --enable or --disable.');
	const client = await authenticatedClient();
	const { rule, raw } = await client.updateEventRule(value, input);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(eventRuleDetails(rule));
}

async function deleteRule(argv: string[]): Promise<void> {
	const parsed = parseOne(argv, confirmFlags, 'delete');
	if (!parsed) return;
	const { args, value } = parsed;
	const client = await authenticatedClient();
	const { rule } = await client.getEventRule(value);
	const confirmed = await confirmOrRefuse(
		`Delete event rule ${rule.id} (${rule.source}: ${watching(rule)} → ${rule.queue})? ${rule.deliveries.pending} undelivered events are dropped. [y/N] `,
		{
			yes: args.boolean('yes'),
			accept: (answer) => /^y(es)?$/i.test(answer),
			refusal: `Not confirmed: stdin is not a terminal, so there's no one to ask before deleting ${rule.id}. Pass --yes.`,
		},
	);
	if (!confirmed) return;
	const raw = await client.deleteEventRule(value);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(`Deleted ${rule.id}.`);
}

async function testRule(argv: string[]): Promise<void> {
	const parsed = parseOne(argv, baseFlags, 'test');
	if (!parsed) return;
	const client = await authenticatedClient();
	const { delivery, raw } = await client.testEventRule(parsed.value);
	if (parsed.args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(`Queued test event ${delivery.id} (${delivery.type}). Watch it with: skif events deliveries ${parsed.value}`);
}

async function listDeliveries(argv: string[]): Promise<void> {
	const args = parseArgs(argv, deliveryFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 1, 'Usage: skif events deliveries [<id>] [--status pending|delivered|failed] [--limit n]');
	const status = args.string('status');
	if (status && !['pending', 'delivered', 'failed'].includes(status))
		throw new UsageError('--status must be pending, delivered or failed.');
	const limit = args.string('limit');
	const client = await authenticatedClient();
	const { deliveries, raw } = await client.listEventDeliveries({
		...(args.positionals[0] ? { rule: args.positionals[0] } : {}),
		...(status ? { status } : {}),
		...(limit ? { limit: Number(limit) } : {}),
	});
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	if (deliveries.length === 0) {
		console.log('No deliveries yet.');
		return;
	}
	console.log(eventDeliveryTable(deliveries));
}
