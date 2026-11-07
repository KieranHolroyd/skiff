import { fail } from '@sveltejs/kit';
import {
	eventRuleCreateSchema,
	eventSources,
	eventTypesBySource,
	hasPermission,
	type EventDeliveryView,
	type EventRuleView,
	type EventSource
} from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { features } from '#lib/server/config.js';
import { failStatus, formString, toFormFailure } from '../_lib/errors.js';
import { fieldErrorsFrom } from '../databases/_lib/forms.server.js';
import type { Actions, PageServerLoad } from './$types';

/**
 * Event notifications (docs/EVENTS.md, D122): rules that publish platform events into a function
 * queue, and their delivery history. Every check lives in `core.events`; the lists below only fill
 * the create form, and each one is optional (a missing permission just empties that source).
 */
export const load: PageServerLoad = ({ locals, url }) => {
	const principal = locals.principal!;
	const view =
		url.searchParams.get('view') === 'deliveries' ? ('deliveries' as const) : ('rules' as const);

	let rules: EventRuleView[] = [];
	let deliveries: EventDeliveryView[] = [];
	let denied = false;
	try {
		rules = core.events.list(principal);
		deliveries = core.events.deliveries(principal, { limit: 100 });
	} catch {
		denied = true;
	}

	const quietly = <T>(read: () => T, fallback: T): T => {
		try {
			return read();
		} catch {
			return fallback;
		}
	};
	const brokers = quietly(
		() =>
			core.brokers
				.list(principal)
				.map((broker) => ({
					name: broker.name,
					attachments: broker.attachments.map((item) => item.projectSlug)
				})),
		[] as Array<{ name: string; attachments: string[] }>
	);
	const storage = quietly(
		() =>
			core.storage
				.list(principal)
				.map((instance) => ({
					name: instance.name,
					buckets: instance.buckets.map((bucket) => bucket.name)
				})),
		[] as Array<{ name: string; buckets: string[] }>
	);
	const projects = quietly(
		() =>
			core.projects.list(principal).map((project) => ({ slug: project.slug, name: project.name })),
		[] as Array<{ slug: string; name: string }>
	);
	const databases = quietly(
		() => core.databases.list(principal).map((database) => database.name),
		[] as string[]
	);
	const alertRules = quietly(
		() => core.alerts.listRules(principal).map((rule) => ({ id: rule.id, name: rule.name })),
		[] as Array<{ id: string; name: string }>
	);

	return {
		view,
		denied,
		enabled: features.BROKERS,
		rules,
		deliveries,
		brokers,
		storage,
		projects,
		databases,
		alertRules,
		sources: eventSources.map((source) => ({ source, events: [...eventTypesBySource[source]] })),
		can: { update: hasPermission(principal, 'broker:update') }
	};
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const source = formString(data, 'source') as EventSource;
		const values = {
			source,
			storage: formString(data, 'storage'),
			bucket: formString(data, 'bucket'),
			prefix: formString(data, 'prefix'),
			suffix: formString(data, 'suffix'),
			project: formString(data, 'project'),
			database: formString(data, 'database'),
			alertRule: formString(data, 'alertRule'),
			broker: formString(data, 'broker'),
			queue: formString(data, 'queue'),
			description: formString(data, 'description')
		};
		const known: readonly string[] =
			(eventTypesBySource as Record<string, readonly string[]>)[source] ?? [];
		const events = data
			.getAll('events')
			.map(String)
			.filter((event) => known.includes(event));
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
			...(source === 'alerts' ? { alertRule: optional(values.alertRule) } : {})
		};
		if (known.length > 0 && events.length === 0)
			return fail(400, {
				message: 'Pick at least one event.',
				fieldErrors: { events: 'Pick at least one event.' },
				values
			});
		const parsed = eventRuleCreateSchema.safeParse(input);
		if (!parsed.success)
			return fail(400, {
				message: 'Check the highlighted fields.',
				fieldErrors: fieldErrorsFrom(parsed.error.issues),
				values
			});
		let rule: EventRuleView;
		try {
			rule = core.events.create(principal, input);
		} catch (error) {
			return fail(failStatus(error), { ...toFormFailure(error), values });
		}
		return {
			created: rule.id,
			success:
				rule.source === 'storage'
					? `Rule created. ${rule.filter.storage} restarts once to switch on bucket notifications.`
					: 'Rule created. Matching events now go to the queue.'
		};
	},

	test: async ({ request, locals }) => {
		const id = formString(await request.formData(), 'id');
		if (!id) return fail(400, { message: 'Missing rule id.' });
		try {
			const delivery = core.events.test(locals.principal!, id);
			return {
				success: `Queued test event ${delivery.id}. It shows under Deliveries once the broker's node publishes it.`
			};
		} catch (error) {
			return fail(failStatus(error), toFormFailure(error));
		}
	},

	toggle: async ({ request, locals }) => {
		const data = await request.formData();
		const id = formString(data, 'id');
		const enabled = formString(data, 'enabled') === 'true';
		if (!id) return fail(400, { message: 'Missing rule id.' });
		try {
			core.events.update(locals.principal!, id, { enabled });
		} catch (error) {
			return fail(failStatus(error), toFormFailure(error));
		}
		return {
			success: enabled ? 'Rule enabled.' : 'Rule disabled. Events from now on are not queued.'
		};
	},

	delete: async ({ request, locals }) => {
		const id = formString(await request.formData(), 'id');
		if (!id) return fail(400, { message: 'Missing rule id.' });
		try {
			core.events.delete(locals.principal!, id);
		} catch (error) {
			return fail(failStatus(error), toFormFailure(error));
		}
		return { success: 'Rule deleted. Its undelivered events were dropped.' };
	}
};
