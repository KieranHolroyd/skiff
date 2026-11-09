import { error, fail, redirect } from '@sveltejs/kit';
import {
	CoreError,
	ValidationError,
	isFunctionTier,
	nextCronTime,
	type SecretView
} from '@skiff/core';
import {
	FUNCTION_STATEFUL_REPLICA_MESSAGE,
	MAX_WORKLOAD_REPLICAS,
	functionBindingIsStateful,
	hasPermission,
	workloadSpecSchema,
	type DatabaseAttachmentView,
	type DomainView,
	type StorageAttachmentView,
	type UserPoolAttachmentView,
	type FunctionView,
	type NodeCapacityView,
	type WorkloadView
} from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { features } from '#lib/server/config.js';
import { parseTrafficRange, trafficRangeHref, trafficRanges } from '#lib/server/traffic-range.js';
import { failStatus, formRawString, formString, toFormFailure } from '../../_lib/errors.js';
import { actions as projectActions } from '../../projects/[slug]/+page.server.js';
import { nodeTaskAction } from '#lib/server/node-tasks.js';
import { parseHeaderLines } from '../_lib/test-request.js';
import {
	createEventTrigger,
	deleteEventTrigger,
	loadEventTriggers,
	testEventTrigger,
	toggleEventTrigger
} from '../_lib/event-triggers.server.js';
import type { Actions, PageServerLoad } from './$types';

/** Run a read the viewer may not be allowed to make without taking the page down. */
function safely<T>(read: () => T, fallback: T): T {
	try {
		return read();
	} catch {
		return fallback;
	}
}

/**
 * One function's console (D110). Functions are stored as projects with `runtime: "function"`, but
 * they are their own product in the UI: this page owns their deployments, bindings, secrets, logs,
 * domains and settings, and a non-function slug is sent back to Projects.
 */
export const load: PageServerLoad = async ({ locals, params, url }) => {
	const principal = locals.principal!;
	if (!features.FUNCTIONS) error(404, 'Functions are not enabled on this platform.');
	let project;
	let row;
	try {
		project = await core.projects.get(principal, params.slug);
		row = core.projects.requireRow(principal, params.slug);
	} catch (caught) {
		if (caught instanceof CoreError)
			error(caught.status === 404 ? 404 : caught.status, caught.message);
		throw caught;
	}
	if (project.runtime !== 'function')
		redirect(307, `/projects/${encodeURIComponent(project.slug)}`);

	const view: FunctionView | null = safely(() => core.functions.view(principal, row), null);
	const workload: WorkloadView | null = safely(() => core.workloads.get(principal, row), null);
	const spec = safely(() => core.workloads.projectSpec(row), null);
	const deployments = safely(() => core.deployments.list(principal, row, { limit: 100 }), []);
	const domains: DomainView[] = safely(() => core.domains.list(principal, row), []);
	const secrets: SecretView[] = safely(
		() => core.secrets.list(principal, { visibleTo: row.id }),
		[]
	);
	const capacity: NodeCapacityView[] =
		principal.platformAdmin === true ? safely(() => core.workloads.capacity(principal), []) : [];

	const cronNext: Record<string, string | null> = {};
	for (const cron of view?.triggers.crons ?? []) {
		const next = safely(() => nextCronTime(cron, Date.now()), null);
		cronNext[cron] = next === null ? null : new Date(next).toISOString();
	}

	const trafficRange = parseTrafficRange(url.searchParams.get('range'));
	const traffic = await core.metrics
		.trafficForProject(principal, params.slug, {
			from: trafficRange.from,
			to: trafficRange.to,
			interval: trafficRange.interval
		})
		.catch(() => null);
	const trafficLinks = Object.fromEntries(
		trafficRanges.map((range) => [range.key, trafficRangeHref(url, range.key, { tab: 'overview' })])
	);

	// Hyperdrive and R2 bindings resolve through attachments (§4.5): the attachment is what puts
	// the credentials in the host's activation env, so the console manages them here.
	const databaseAttachments: DatabaseAttachmentView[] = safely(
		() => core.databases.attachments(principal, row),
		[]
	);
	const attachableDatabases = safely(() => core.databases.list(principal), [])
		.filter((db) => !databaseAttachments.some((item) => item.databaseId === db.id))
		.map((db) => ({
			name: db.name,
			engine: db.engine,
			version: db.version,
			engineLabel: db.engineLabel,
			nodeName: db.nodeName ?? db.nodeId
		}));
	const storageAttachments: StorageAttachmentView[] = safely(
		() => core.storage.attachments(principal, row),
		[]
	);
	const storageInstances = safely(() => core.storage.list(principal), []);
	const readyBuckets = (item: (typeof storageInstances)[number]) =>
		item.buckets.filter((bucket) => bucket.state === 'ready').map((bucket) => bucket.name);
	const attachableStorage = storageInstances
		.filter((item) => !storageAttachments.some((attached) => attached.storageId === item.id))
		.map((item) => ({
			name: item.name,
			engineLabel: item.engineLabel,
			version: item.version,
			nodeName: item.nodeName ?? item.nodeId,
			public: item.public,
			buckets: readyBuckets(item)
		}))
		.filter((item) => item.buckets.length > 0);
	const storageBuckets: Record<string, string[]> = Object.fromEntries(
		storageInstances
			.filter((item) => storageAttachments.some((attached) => attached.storageId === item.id))
			.map((item) => [item.name, readyBuckets(item)])
	);
	// User pools (IAM.md I28): an attached pool also gives the function `env.AUTH`.
	const userPoolAttachments: UserPoolAttachmentView[] = safely(
		() => core.userPools.attachments(principal, row),
		[]
	);
	const attachableUserPools = safely(
		() =>
			core.userPools
				.list(principal)
				.filter((pool) => !userPoolAttachments.some((attached) => attached.poolId === pool.id))
				.map((pool) => ({
					name: pool.name,
					issuer: pool.issuer,
					disabled: pool.disabled,
					clients: safely(() => core.userPools.listClients(principal, pool.id), [])
						.filter((client) => !client.public)
						.map((client) => ({ name: client.name, clientId: client.clientId }))
				}))
				.filter((pool) => !pool.disabled && pool.clients.length > 0),
		[]
	);

	// Invocations (tail workers, phase 3): a 24-hour headline now, the newest items streamed.
	const now = Date.now();
	const invocationSummary = await core.functions
		.invocationSummary(principal, row, { from: now - 24 * 3_600_000, to: now })
		.catch(() => ({
			available: false,
			summary: { total: 0, byOutcome: {} as Record<string, number> }
		}));
	const invocations = core.functions
		.invocations(principal, row, { from: now - 7 * 86_400_000, to: now, limit: 50 })
		.catch(() => ({ available: false, rows: [] }));
	// Share-link visitor sessions, ended one by one or all at once with "Sign out everyone".
	const siteSessions = hasPermission(principal, 'shareLink:read')
		? safely(() => core.access.listSessions(principal, row), [])
		: [];
	// Event triggers (D122): platform events published into the queues this function consumes.
	const eventTriggers = loadEventTriggers(principal, row, view);

	return {
		project,
		view,
		workload,
		spec,
		deployments,
		domains,
		secrets,
		capacity,
		cronNext,
		traffic,
		trafficRange,
		trafficRanges,
		trafficLinks,
		databaseAttachments,
		attachableDatabases,
		storageAttachments,
		attachableStorage,
		storageBuckets,
		userPoolAttachments,
		attachableUserPools,
		invocationSummary,
		invocations,
		siteSessions,
		eventTriggers,
		maxReplicas: MAX_WORKLOAD_REPLICAS,
		can: {
			update: hasPermission(principal, 'project:update'),
			delete: hasPermission(principal, 'project:delete'),
			deploy: hasPermission(principal, 'deployment:create'),
			/** Send test messages into the queues this function consumes (D124). */
			sendQueue: hasPermission(principal, 'broker:update'),
			promote: hasPermission(principal, 'deployment:promote'),
			rollback: hasPermission(principal, 'deployment:rollback'),
			deleteDeployment: hasPermission(principal, 'deployment:delete'),
			revokeSession: hasPermission(principal, 'shareLink:revoke'),
			readLogs: hasPermission(principal, 'logs:read'),
			createDomain: hasPermission(principal, 'domain:create'),
			deleteDomain: hasPermission(principal, 'domain:delete'),
			createSecret: hasPermission(principal, 'secret:create'),
			updateSecret: hasPermission(principal, 'secret:update'),
			deleteSecret: hasPermission(principal, 'secret:delete'),
			viewCapacity: principal.platformAdmin === true,
			readDatabases: hasPermission(principal, 'database:read'),
			createDatabase: hasPermission(principal, 'database:create'),
			attachDatabase:
				hasPermission(principal, 'database:update') && hasPermission(principal, 'project:update'),
			readStorage: hasPermission(principal, 'storage:read'),
			createStorage: hasPermission(principal, 'storage:create'),
			attachStorage:
				hasPermission(principal, 'storage:update') && hasPermission(principal, 'project:update'),
			readUserPools: hasPermission(principal, 'userPool:read'),
			attachUserPool:
				hasPermission(principal, 'userPool:update') && hasPermission(principal, 'project:update')
		}
	};
};

/** Where a function lives; every mutation below is scoped to a function project. */
function requireFunction(principal: NonNullable<App.Locals['principal']>, slug: string) {
	const row = core.projects.requireRow(principal, slug);
	if (!isFunctionTier(row)) throw new ValidationError(`"${slug}" is not a function.`);
	return row;
}

/**
 * A project action reused as-is. They read only `params.slug`, request and locals, so the route id
 * in their type is the only difference; core still checks every permission.
 */
const reuse = (action: unknown) => action as Actions[string];

export const actions: Actions = {
	deploy: reuse(projectActions.deploy),
	promote: reuse(projectActions.promote),
	rollback: reuse(projectActions.rollback),
	pin: reuse(projectActions.pin),
	deleteDeployment: reuse(projectActions.deleteDeployment),
	setAccess: reuse(projectActions.setAccess),
	revokeSiteSession: reuse(projectActions.revokeSiteSession),
	signOutVisitors: reuse(projectActions.signOutVisitors),
	move: reuse(projectActions.move),
	addDomain: reuse(projectActions.addDomain),
	checkDomain: reuse(projectActions.checkDomain),
	deleteDomain: reuse(projectActions.deleteDomain),
	removeWorkload: reuse(projectActions.removeWorkload),
	deleteSecret: reuse(projectActions.deleteSecret),
	attachDatabase: reuse(projectActions.attachDatabase),
	detachDatabase: reuse(projectActions.detachDatabase),
	attachStorage: reuse(projectActions.attachStorage),
	updateStorageGrants: reuse(projectActions.updateStorageGrants),
	detachStorage: reuse(projectActions.detachStorage),
	attachUserPool: reuse(projectActions.attachUserPool),
	detachUserPool: reuse(projectActions.detachUserPool),

	/**
	 * Scale a stateless function across replicas on its node (phase 4). The count lives on the
	 * function, not the bundle, so later deploys keep it; stateful bindings cap it at one (FN11).
	 */
	setReplicas: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const replicas = Number(formString(await request.formData(), 'replicas'));
		if (!Number.isInteger(replicas) || replicas < 1 || replicas > MAX_WORKLOAD_REPLICAS)
			return fail(400, {
				message: `Choose between 1 and ${MAX_WORKLOAD_REPLICAS} replicas.`,
				fieldErrors: { replicas: `1–${MAX_WORKLOAD_REPLICAS}` }
			});
		try {
			const row = requireFunction(principal, params.slug);
			const spec = core.workloads.projectSpec(row);
			if (!spec?.function)
				return fail(400, { message: 'Deploy the function once before scaling it.' });
			if (replicas > 1 && spec.function.bindings.some((b) => functionBindingIsStateful(b.type)))
				return fail(400, { message: FUNCTION_STATEFUL_REPLICA_MESSAGE });
			const parsed = workloadSpecSchema.safeParse({ ...spec, replicas });
			if (!parsed.success)
				return fail(400, { message: parsed.error.issues[0]?.message ?? 'Invalid replica count.' });
			core.workloads.setSpec(principal, row, parsed.data);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		return {
			success:
				replicas === 1
					? 'Scaled to one host. Extra replicas stop on the next reconcile.'
					: `Scaling to ${replicas} replicas. Caddy balances across them once they start.`
		};
	},

	/** Rename or re-place a function; a new slug moves the console to its new address. */
	update: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const name = formString(data, 'name');
		const slug = formString(data, 'slug');
		const placement = formString(data, 'placement');
		const fieldErrors: Record<string, string> = {};
		if (!name) fieldErrors.name = 'Give the function a name.';
		else if (name.length > 120) fieldErrors.name = 'Keep the name to 120 characters or fewer.';
		if (slug && !/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(slug))
			fieldErrors.slug =
				'Use 3–40 lowercase letters, digits and single hyphens; start and end with a letter or digit.';
		if (Object.keys(fieldErrors).length > 0)
			return fail(400, { message: 'Check the highlighted fields.', fieldErrors });
		const renamed = Boolean(slug) && slug !== params.slug;
		try {
			const row = requireFunction(principal, params.slug);
			await core.projects.update(principal, row.slug, {
				name,
				...(renamed ? { slug } : {}),
				...(placement ? { placement } : {})
			});
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		if (renamed) redirect(303, `/functions/${encodeURIComponent(slug)}?tab=settings`);
		return { success: 'Function settings saved. Routes converge within seconds.' };
	},

	/** Store a project secret a `secret` binding can name; the running spec is never touched. */
	setSecret: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const name = formString(data, 'name');
		const value = formRawString(data, 'value');
		if (!name)
			return fail(400, { message: 'Name the secret.', fieldErrors: { name: 'Required.' } });
		if (!value)
			return fail(400, {
				message: 'Give the secret a value.',
				fieldErrors: { value: 'Required.' }
			});
		try {
			const row = requireFunction(principal, params.slug);
			const existing = core.secrets
				.list(principal, { visibleTo: row.id })
				.some((secret) => secret.name === name && secret.projectId === row.id);
			await core.secrets.set(principal, { name, value, projectId: row.id });
			return {
				success: existing
					? `${name} updated. The function picks up the new value when its host next activates.`
					: `${name} stored. Bind it with { "name": "${name}", "type": "secret" } and deploy.`
			};
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	// --- test tools: run on the function's node (D124) ------------------------------------------

	/** One HTTP request to the live host, straight to its socket (no domain, Caddy or access rules). */
	invoke: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		let headers: Record<string, string> = {};
		try {
			headers = parseHeaderLines(formRawString(data, 'headers'));
		} catch (caught) {
			return fail(400, { message: (caught as Error).message });
		}
		const body = formRawString(data, 'body');
		const method = formString(data, 'method') || 'GET';
		return nodeTaskAction(principal, () =>
			core.nodeTasks.functionTask(
				principal,
				requireFunction(principal, params.slug),
				'function.invoke',
				{
					method,
					path: formString(data, 'path') || '/',
					headers,
					...(body && method !== 'GET' && method !== 'HEAD' ? { body } : {})
				}
			)
		);
	},

	/** Run `scheduled()` now for one cron, as the node's scheduler would at its next occurrence. */
	runCron: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const cron = formRawString(await request.formData(), 'cron');
		return nodeTaskAction(principal, () =>
			core.nodeTasks.functionTask(
				principal,
				requireFunction(principal, params.slug),
				'function.scheduled',
				{ cron }
			)
		);
	},

	/** Publish a test message into a queue this function consumes, on that queue's broker. */
	sendQueueMessage: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const queue = formString(data, 'queue');
		const row = requireFunction(principal, params.slug);
		const consumer = core.functions
			.view(principal, row)
			?.triggers.queues.find((item) => item.queue === queue);
		if (!consumer)
			return fail(400, { message: `${params.slug} does not consume a queue called ${queue}.` });
		const count = formString(data, 'count');
		return nodeTaskAction(
			principal,
			() =>
				core.nodeTasks.brokerTask(principal, consumer.broker, 'broker.queue.send', {
					queue,
					body: formRawString(data, 'body'),
					contentType: formString(data, 'contentType') || 'json',
					...(count ? { count: Number(count) } : {})
				}),
			(task) =>
				`Sent ${task.result?.sent ?? 0} message${task.result?.sent === 1 ? '' : 's'} to ${queue}. The function receives ${task.result?.sent === 1 ? 'it' : 'them'} in its next batch; see Logs for the run.`
		);
	},

	// --- event triggers: rules that publish platform events into this function's queues (D122) ---

	createEventTrigger: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		try {
			return await createEventTrigger(principal, requireFunction(principal, params.slug), request);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},
	testEventTrigger: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		try {
			return await testEventTrigger(principal, requireFunction(principal, params.slug), request);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},
	toggleEventTrigger: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		try {
			return await toggleEventTrigger(principal, requireFunction(principal, params.slug), request);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},
	deleteEventTrigger: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		try {
			return await deleteEventTrigger(principal, requireFunction(principal, params.slug), request);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	/** Move the function to the trash; it is purged after the platform's trash period. */
	delete: async ({ locals, params }) => {
		const principal = locals.principal!;
		try {
			requireFunction(principal, params.slug);
			await core.projects.softDelete(principal, params.slug);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		redirect(303, '/functions?deleted=1');
	}
};
