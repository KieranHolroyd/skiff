import { fail } from '@sveltejs/kit';
import {
	eventRuleCreateSchema,
	eventSources,
	eventTypesBySource,
	hasPermission,
	type EventDeliveryView,
	type EventSource,
	type FunctionView,
	type Principal
} from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { features } from '#lib/server/config.js';
import { failStatus, formString, toFormFailure } from '../../_lib/errors.js';
import { fieldErrorsFrom } from '../../databases/_lib/forms.server.js';
import {
	eventTriggersFor,
	parseQueueKey,
	queueKey,
	type FunctionEventTrigger,
	type QueueTarget
} from './event-triggers.js';

type ProjectRow = ReturnType<typeof core.projects.requireRow>;

/** Run a read the viewer may not be allowed to make; a denied list just comes back empty. */
function quietly<T>(read: () => T, fallback: T): T {
	try {
		return read();
	} catch {
		return fallback;
	}
}

const DELIVERY_LIMIT = 200;
const SHOWN_DELIVERIES = 25;

/**
 * The event rules that deliver to this function: rules on its consumer queues, plus rules on a
 * broker attached to it whose queue no other function consumes yet.
 */
function functionRules(principal: Principal, row: ProjectRow, view: FunctionView | null) {
	const consumers = view?.triggers.queues ?? [];
	const brokers = quietly(() => core.brokers.list(principal), []);
	const attached = brokers.filter((broker) =>
		broker.attachments.some((item) => item.projectId === row.id)
	);
	const consumedElsewhere = new Set<string>();
	for (const broker of attached)
		for (const attachment of broker.attachments) {
			if (attachment.projectId === row.id) continue;
			const other = quietly(() => {
				const otherRow = core.projects.requireRow(principal, attachment.projectSlug);
				return core.functions.view(principal, otherRow);
			}, null);
			for (const consumer of other?.triggers.queues ?? [])
				if (consumer.broker === broker.name) consumedElsewhere.add(queueKey(consumer));
		}
	const attachedBrokers = attached.map((broker) => broker.name);
	const rules = eventTriggersFor(
		quietly(() => core.events.list(principal), []),
		{
			consumers,
			attachedBrokers,
			consumedElsewhere
		}
	);
	return { rules, attachedBrokers };
}

/**
 * A function's event triggers (docs/EVENTS.md, D122): the event rules that publish into queues it
 * consumes, their newest deliveries, and what the "Add trigger" dialog offers.
 */
export function loadEventTriggers(
	principal: Principal,
	row: ProjectRow,
	view: FunctionView | null
) {
	const enabled = features.BROKERS;
	const empty = {
		enabled,
		readable: false,
		rules: [] as FunctionEventTrigger[],
		deliveries: [] as EventDeliveryView[],
		consumers: [] as QueueTarget[],
		attachedBrokers: [] as string[],
		storage: [] as Array<{ name: string; buckets: string[] }>,
		projects: [] as Array<{ slug: string; name: string }>,
		databases: [] as string[],
		alertRules: [] as Array<{ id: string; name: string }>,
		sources: eventSources.map((source) => ({ source, events: [...eventTypesBySource[source]] })),
		can: { update: false }
	};
	if (!enabled || !hasPermission(principal, 'broker:read')) return empty;

	const consumers = view?.triggers.queues ?? [];
	const { rules, attachedBrokers } = functionRules(principal, row, view);
	const ruleIds = new Set(rules.map((rule) => rule.id));
	const deliveries =
		rules.length === 0
			? []
			: quietly(() => core.events.deliveries(principal, { limit: DELIVERY_LIMIT }), [])
					.filter((delivery) => ruleIds.has(delivery.ruleId))
					.slice(0, SHOWN_DELIVERIES);

	return {
		...empty,
		readable: true,
		rules,
		deliveries,
		consumers,
		attachedBrokers,
		storage: quietly(
			() =>
				core.storage.list(principal).map((instance) => ({
					name: instance.name,
					buckets: instance.buckets.map((bucket) => bucket.name)
				})),
			[]
		),
		projects: quietly(
			() =>
				core.projects
					.list(principal)
					.map((project) => ({ slug: project.slug, name: project.name })),
			[]
		),
		databases: quietly(() => core.databases.list(principal).map((database) => database.name), []),
		alertRules: quietly(
			() => core.alerts.listRules(principal).map((rule) => ({ id: rule.id, name: rule.name })),
			[]
		),
		can: { update: hasPermission(principal, 'broker:update') }
	};
}

export type FunctionEventTriggersData = ReturnType<typeof loadEventTriggers>;

/** The rule ids a function's console may act on, so a forged id can't reach another function's rule. */
function ownedRuleIds(principal: Principal, row: ProjectRow): Set<string> {
	const view = core.functions.view(principal, row);
	return new Set(functionRules(principal, row, view).rules.map((rule) => rule.id));
}

function requireOwnedRule(principal: Principal, row: ProjectRow, id: string) {
	if (!id) return fail(400, { message: 'Missing event trigger id.' });
	if (!ownedRuleIds(principal, row).has(id))
		return fail(404, { message: `That event trigger does not deliver to ${row.slug}.` });
	return null;
}

/** Create an event rule that publishes into a queue this function consumes (or will consume). */
export async function createEventTrigger(principal: Principal, row: ProjectRow, request: Request) {
	const data = await request.formData();
	const source = formString(data, 'source') as EventSource;
	const target = parseQueueKey(formString(data, 'target'));
	const values = {
		source,
		storage: formString(data, 'storage'),
		bucket: formString(data, 'bucket'),
		prefix: formString(data, 'prefix'),
		suffix: formString(data, 'suffix'),
		project: formString(data, 'project'),
		database: formString(data, 'database'),
		alertRule: formString(data, 'alertRule'),
		repository: formString(data, 'repository'),
		broker: target?.broker ?? formString(data, 'broker'),
		queue: target?.queue ?? formString(data, 'queue'),
		description: formString(data, 'description')
	};
	const known: readonly string[] =
		(eventTypesBySource as Record<string, readonly string[]>)[source] ?? [];
	const events = data
		.getAll('events')
		.map(String)
		.filter((event) => known.includes(event));
	if (known.length > 0 && events.length === 0)
		return fail(400, {
			message: 'Pick at least one event.',
			fieldErrors: { events: 'Pick at least one event.' }
		});

	const view = core.functions.view(principal, row);
	const consumes = (view?.triggers.queues ?? []).some(
		(item) => item.broker === values.broker && item.queue === values.queue
	);
	if (!consumes) {
		const attached = core.brokers
			.attachments(principal, row)
			.some((item) => item.brokerName === values.broker);
		if (!attached)
			return fail(400, {
				message: `Attach ${values.broker || 'a broker'} to ${row.slug} first, so the function can consume the queue.`,
				fieldErrors: { broker: 'Not attached to this function.' }
			});
	}

	const optional = (value: string) => value || undefined;
	const input = {
		source,
		// Every box ticked is the same rule as none: "all of this source's events".
		events: events.length === known.length ? [] : events,
		broker: values.broker,
		queue: values.queue,
		description: optional(values.description),
		...(source === 'storage'
			? {
					storage: optional(values.storage),
					bucket: optional(values.bucket),
					prefix: optional(values.prefix),
					suffix: optional(values.suffix)
				}
			: {}),
		...(source === 'deployments' ? { project: optional(values.project) } : {}),
		...(source === 'database-backups' ? { database: optional(values.database) } : {}),
		...(source === 'alerts' ? { alertRule: optional(values.alertRule) } : {}),
		...(source === 'registry' ? { repository: optional(values.repository) } : {})
	};
	const parsed = eventRuleCreateSchema.safeParse(input);
	if (!parsed.success)
		return fail(400, {
			message: 'Check the highlighted fields.',
			fieldErrors: fieldErrorsFrom(parsed.error.issues)
		});
	try {
		const rule = core.events.create(principal, input);
		const restart =
			rule.source === 'storage'
				? ` ${rule.filter.storage} restarts once to switch on bucket notifications.`
				: '';
		return {
			success: consumes
				? `Event trigger added. Matching events now reach ${row.slug} through ${rule.queue}.${restart}`
				: `Event trigger added. Add a consumer for ${rule.queue} to wrangler.jsonc and deploy to start receiving them.${restart}`
		};
	} catch (error) {
		return fail(failStatus(error), toFormFailure(error));
	}
}

export async function testEventTrigger(principal: Principal, row: ProjectRow, request: Request) {
	const id = formString(await request.formData(), 'id');
	const denied = requireOwnedRule(principal, row, id);
	if (denied) return denied;
	try {
		const delivery = core.events.test(principal, id);
		return {
			success: `Queued test event ${delivery.id}. It shows under Recent event deliveries once the broker's node publishes it.`
		};
	} catch (error) {
		return fail(failStatus(error), toFormFailure(error));
	}
}

export async function toggleEventTrigger(principal: Principal, row: ProjectRow, request: Request) {
	const data = await request.formData();
	const id = formString(data, 'id');
	const enabled = formString(data, 'enabled') === 'true';
	const denied = requireOwnedRule(principal, row, id);
	if (denied) return denied;
	try {
		core.events.update(principal, id, { enabled });
	} catch (error) {
		return fail(failStatus(error), toFormFailure(error));
	}
	return {
		success: enabled
			? 'Event trigger resumed.'
			: 'Event trigger paused. Events from now on are not queued.'
	};
}

export async function deleteEventTrigger(principal: Principal, row: ProjectRow, request: Request) {
	const id = formString(await request.formData(), 'id');
	const denied = requireOwnedRule(principal, row, id);
	if (denied) return denied;
	try {
		core.events.delete(principal, id);
	} catch (error) {
		return fail(failStatus(error), toFormFailure(error));
	}
	return { success: 'Event trigger removed. Its undelivered events were dropped.' };
}
