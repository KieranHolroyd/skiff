import {
	eventRuleCreateSchema,
	eventRuleUpdateSchema,
	eventTypesBySource,
	type Principal,
	type AgentEventAck,
	type AgentEventLease,
	type EventDeliveryStatus,
	type EventDeliveryView,
	type EventRuleCreate,
	type EventRuleUpdate,
	type EventRuleView,
	type EventSource,
	type PlatformEventBody,
	type StorageEventBody,
} from '@skiff/contracts';
import type { CoreContext } from './context.ts';
import { ConflictError, CoreError, NotFoundError, ValidationError } from './errors.ts';
import { hmac, newId, parseJson, safeEqual } from './util.ts';

/**
 * Event notifications (docs/EVENTS.md, D122).
 *
 * A rule watches one platform source and publishes each matching event to a queue on a managed
 * broker; a function consumes the queue with its ordinary queue trigger. This service owns the
 * rules and an outbox of deliveries:
 *
 * - **Emit.** Sources call `emit*` after their own work is done. Matching is in-process and cheap;
 *   an emit never throws into the caller, so a broken rule can't fail a deploy or an alert.
 * - **Publish.** The node that runs the target broker leases pending deliveries over the agent
 *   protocol, publishes each one to `skiff.q.<queue>` (JetStream dedupes on the delivery id) and
 *   acks. A failure backs off up to 5 minutes; a delivery still pending after 24 hours fails.
 * - **Storage** events come from RustFS itself: the instance's `skiff` webhook target posts to
 *   `/api/webhooks/storage/<id>` with a token derived from the master key and the instance id.
 */

/** Stored ids next to the names the caller gave, so a rename never re-targets a rule. */
interface StoredFilter {
	storage?: string;
	bucket?: string;
	prefix?: string;
	suffix?: string;
	project?: string;
	database?: string;
	alertRule?: string;
	repository?: string;
	storageId?: string;
	projectId?: string;
	databaseId?: string;
}

interface RuleRow {
	id: string;
	org_id: string;
	source: EventSource;
	events_json: string;
	filter_json: string;
	broker_id: string;
	queue: string;
	description: string | null;
	enabled: number;
	created_by: string;
	created_at: number;
	updated_at: number;
}

interface DeliveryRow {
	id: string;
	org_id: string;
	rule_id: string;
	broker_id: string;
	queue: string;
	event_type: string;
	body_json: string;
	status: EventDeliveryStatus;
	attempts: number;
	next_attempt_at: number;
	leased_until: number;
	last_error: string | null;
	created_at: number;
	delivered_at: number | null;
}

/** How long a leased delivery is the agent's before another lease may take it. */
export const EVENT_LEASE_SECONDS = 60;
const LEASE_LIMIT = 200;
const RETRY_MAX_MS = 5 * 60_000;
/** A delivery that could not be published for this long is marked failed. */
export const EVENT_EXPIRY_MS = 24 * 60 * 60_000;
/** Delivered and failed rows are kept this long for the history view. */
const KEEP_MS = 7 * 24 * 60 * 60_000;
/** Backpressure: a broker that is down for a day must not grow the outbox without bound. */
const MAX_PENDING_PER_ORG = 50_000;
const MAX_RULES_PER_ORG = 200;
const MAX_STORAGE_RECORDS = 100;

/** RustFS (S3) event names → R2's `action`. Anything else (tagging, retention, …) is not an event. */
const STORAGE_ACTIONS: Record<string, { type: 'object-create' | 'object-delete'; action: StorageEventBody['action'] }> = {
	'ObjectCreated:Put': { type: 'object-create', action: 'PutObject' },
	'ObjectCreated:Post': { type: 'object-create', action: 'PutObject' },
	'ObjectCreated:Copy': { type: 'object-create', action: 'CopyObject' },
	'ObjectCreated:CompleteMultipartUpload': { type: 'object-create', action: 'CompleteMultipartUpload' },
	'ObjectRemoved:Delete': { type: 'object-delete', action: 'DeleteObject' },
	'ObjectRemoved:DeleteMarkerCreated': { type: 'object-delete', action: 'DeleteObject' },
};

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

export class EventService {
	constructor(private readonly ctx: CoreContext) {}

	// ---------------------------------------------------------------- rules

	list(principal: Principal): EventRuleView[] {
		// TODO(IAM I2): narrow this list with scopeFilter once it returns broker ids; it
		// currently returns only project and environment ids.
		this.ctx.iam.require(principal, 'broker:read', { type: 'org' });
		const rows = this.ctx.sqlite
			.query<RuleRow, [string]>('SELECT * FROM event_rules WHERE org_id = ? ORDER BY created_at')
			.all(principal.orgId);
		return rows.map((row) => this.view(row));
	}

	get(principal: Principal, id: string): EventRuleView {
		const row = this.requireRule(principal, id);
		this.ctx.iam.require(principal, 'broker:read', { type: 'broker', id: row.broker_id });
		return this.view(row);
	}

	create(principal: Principal, raw: EventRuleCreate): EventRuleView {
		const input = eventRuleCreateSchema.parse(raw);
		const broker = this.ctx.brokers.requireRow(principal, input.broker);
		this.ctx.iam.require(principal, 'broker:update', { type: 'broker', id: broker.id });
		const count = this.ctx.sqlite
			.query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM event_rules WHERE org_id = ?')
			.get(principal.orgId)?.n ?? 0;
		if (count >= MAX_RULES_PER_ORG) throw new ConflictError(`An org can have at most ${MAX_RULES_PER_ORG} event rules.`);
		const filter = this.resolveFilter(principal, input);
		const now = this.ctx.now();
		const row: RuleRow = {
			id: newId('evr_'),
			org_id: principal.orgId,
			source: input.source,
			events_json: JSON.stringify(input.events),
			filter_json: JSON.stringify(filter),
			broker_id: broker.id,
			queue: input.queue,
			description: input.description ?? null,
			enabled: input.enabled ? 1 : 0,
			created_by: principal.userId,
			created_at: now,
			updated_at: now,
		};
		this.ctx.audit.wrap(
			{
				principal,
				action: 'event-rule.create',
				resource: 'event-rule',
				resourceId: row.id,
				args: { source: input.source, broker: input.broker, queue: input.queue },
			},
			() => {
				this.ctx.sqlite.run(
					`INSERT INTO event_rules (id, org_id, source, events_json, filter_json, broker_id, queue, description, enabled, created_by, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					[row.id, row.org_id, row.source, row.events_json, row.filter_json, row.broker_id, row.queue, row.description, row.enabled, row.created_by, row.created_at, row.updated_at],
				);
			},
		);
		// Turning on a bucket's notifications is desired state for its storage node.
		if (row.source === 'storage') this.ctx.projects.bump(principal.orgId);
		return this.view(row);
	}

	update(principal: Principal, id: string, raw: EventRuleUpdate): EventRuleView {
		const patch = eventRuleUpdateSchema.parse(raw);
		const row = this.requireRule(principal, id);
		this.ctx.iam.require(principal, 'broker:update', { type: 'broker', id: row.broker_id });
		const next: RuleRow = { ...row, updated_at: this.ctx.now() };
		if (patch.events !== undefined) {
			const known: readonly string[] = eventTypesBySource[row.source];
			const bad = patch.events.find((event) => !known.includes(event));
			if (bad) throw new ValidationError(`"${bad}" is not a ${row.source} event (use ${known.join(', ')}).`);
			next.events_json = JSON.stringify(patch.events);
		}
		if (patch.prefix !== undefined || patch.suffix !== undefined) {
			if (row.source !== 'storage') throw new ValidationError('`prefix` and `suffix` only apply to storage rules.');
			const filter = parseJson<StoredFilter>(row.filter_json, {});
			if (patch.prefix !== undefined) setOrDrop(filter, 'prefix', patch.prefix);
			if (patch.suffix !== undefined) setOrDrop(filter, 'suffix', patch.suffix);
			next.filter_json = JSON.stringify(filter);
		}
		if (patch.queue !== undefined) next.queue = patch.queue;
		if (patch.description !== undefined) next.description = patch.description;
		if (patch.enabled !== undefined) next.enabled = patch.enabled ? 1 : 0;
		this.ctx.audit.wrap(
			{ principal, action: 'event-rule.update', resource: 'event-rule', resourceId: id, args: { ...patch } },
			() => {
				this.ctx.sqlite.run(
					'UPDATE event_rules SET events_json = ?, filter_json = ?, queue = ?, description = ?, enabled = ?, updated_at = ? WHERE id = ?',
					[next.events_json, next.filter_json, next.queue, next.description, next.enabled, next.updated_at, id],
				);
			},
		);
		if (row.source === 'storage' && row.enabled !== next.enabled) this.ctx.projects.bump(principal.orgId);
		return this.view(next);
	}

	delete(principal: Principal, id: string): void {
		const row = this.requireRule(principal, id);
		this.ctx.iam.require(principal, 'broker:update', { type: 'broker', id: row.broker_id });
		this.ctx.audit.wrap(
			{ principal, action: 'event-rule.delete', resource: 'event-rule', resourceId: id, args: { source: row.source } },
			() => {
				this.ctx.sqlite.run('DELETE FROM event_rules WHERE id = ?', [id]);
				// Undelivered events go with the rule; delivered history is swept on its own clock.
				this.ctx.sqlite.run("DELETE FROM event_deliveries WHERE rule_id = ? AND status = 'pending'", [id]);
			},
		);
		if (row.source === 'storage') this.ctx.projects.bump(principal.orgId);
	}

	/** Publish one synthetic event through the rule, so a consumer can be checked end to end. */
	test(principal: Principal, id: string): EventDeliveryView {
		const row = this.requireRule(principal, id);
		this.ctx.iam.require(principal, 'broker:update', { type: 'broker', id: row.broker_id });
		const now = this.ctx.now();
		const filter = parseJson<StoredFilter>(row.filter_json, {});
		const type = `${row.source}.${this.ruleEvents(row)[0]}`;
		const body: PlatformEventBody | StorageEventBody =
			row.source === 'storage'
				? {
						account: row.org_id,
						action: 'PutObject',
						bucket: filter.bucket ?? 'test',
						object: { key: `${filter.prefix ?? ''}skiff-test-event${filter.suffix ?? ''}`, size: 0, eTag: 'd41d8cd98f00b204e9800998ecf8427e' },
						eventTime: new Date(now).toISOString(),
						skiff: { type: 'storage.object-create', storage: filter.storage ?? '', eventName: 's3:TestEvent' },
					}
				: { type, id: newId('evt_'), time: new Date(now).toISOString(), account: row.org_id, data: { test: true } };
		const deliveryId = this.enqueue(row, type, body, now);
		if (!deliveryId) throw new ConflictError('The outbox for this org is full; deliveries resume once the broker catches up.');
		return this.deliveryView(this.ctx.sqlite.query<DeliveryRow, [string]>('SELECT * FROM event_deliveries WHERE id = ?').get(deliveryId)!);
	}

	deliveries(principal: Principal, options: { ruleId?: string; status?: EventDeliveryStatus; limit?: number } = {}): EventDeliveryView[] {
		if (options.ruleId) {
			const rule = this.requireRule(principal, options.ruleId);
			this.ctx.iam.require(principal, 'broker:read', { type: 'broker', id: rule.broker_id });
		} else {
			// TODO(IAM I2): narrow this list with scopeFilter once it returns broker ids.
			this.ctx.iam.require(principal, 'broker:read', { type: 'org' });
		}
		const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
		const where = ['org_id = ?'];
		const params: Array<string | number> = [principal.orgId];
		if (options.ruleId) {
			where.push('rule_id = ?');
			params.push(options.ruleId);
		}
		if (options.status) {
			where.push('status = ?');
			params.push(options.status);
		}
		params.push(limit);
		return this.ctx.sqlite
			.query<DeliveryRow, Array<string | number>>(
				`SELECT * FROM event_deliveries WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`,
			)
			.all(...params)
			.map((row) => this.deliveryView(row));
	}

	// ---------------------------------------------------------------- sources

	/** An alert rule notified (firing or resolved). Same payload the notifiers receive. */
	emitAlert(orgId: string, ruleId: string, status: 'firing' | 'resolved', data: Record<string, unknown>): void {
		this.emitPlatform(orgId, 'alerts', status, data, (filter) => !filter.alertRule || filter.alertRule === ruleId);
	}

	emitDeployment(orgId: string, projectId: string, event: 'created' | 'promoted' | 'failed', data: Record<string, unknown>): void {
		this.emitPlatform(orgId, 'deployments', event, data, (filter) => !filter.projectId || filter.projectId === projectId);
	}

	/** A push to the platform registry (docs/REGISTRY.md §5.3); `data` names repository, tag and digest. */
	emitRegistryPush(orgId: string, repository: string, data: Record<string, unknown>): void {
		this.emitPlatform(orgId, 'registry', 'push', data, (filter) => !filter.repository || filter.repository === repository);
	}

	emitBackup(orgId: string, databaseId: string, event: 'completed' | 'failed', data: Record<string, unknown>): void {
		this.emitPlatform(orgId, 'database-backups', event, data, (filter) => !filter.databaseId || filter.databaseId === databaseId);
	}

	/**
	 * A RustFS webhook delivery for one instance. The token is checked before the body is parsed.
	 * Returns how many deliveries were queued (0 for an unwatched bucket or an ignored event name).
	 */
	ingestStorage(instanceId: string, authorization: string | null, rawBody: string): number {
		const instance = this.ctx.sqlite
			.query<{ id: string; org_id: string; name: string; deleted_at: number | null }, [string]>(
				'SELECT id, org_id, name, deleted_at FROM storage_instances WHERE id = ?',
			)
			.get(instanceId);
		const given = (authorization ?? '').replace(/^Bearer\s+/i, '').trim();
		// The same answer for an unknown instance and a wrong token: ids are not secrets, but probing
		// them should not be cheaper than probing tokens.
		if (!instance || instance.deleted_at || !given || !safeEqual(given, this.storageNotifyToken(instance.id)))
			throw new CoreError('unauthorized', 'Unknown storage instance or bad token.', 401);
		let parsed: unknown;
		try {
			parsed = JSON.parse(rawBody);
		} catch {
			throw new ValidationError('The event body is not JSON.');
		}
		const records = Array.isArray((parsed as { Records?: unknown })?.Records)
			? ((parsed as { Records: unknown[] }).Records.slice(0, MAX_STORAGE_RECORDS) as Array<Record<string, any>>)
			: [];
		const rules = this.rulesFor(instance.org_id, 'storage').filter((rule) => parseJson<StoredFilter>(rule.filter_json, {}).storageId === instance.id);
		if (rules.length === 0) return 0;
		let queued = 0;
		const now = this.ctx.now();
		for (const record of records) {
			const eventName = String(record?.eventName ?? '').replace(/^s3:/, '');
			const mapped = STORAGE_ACTIONS[eventName];
			const bucket = record?.s3?.bucket?.name;
			const rawKey = record?.s3?.object?.key;
			if (!mapped || typeof bucket !== 'string' || typeof rawKey !== 'string') continue;
			const key = decodeS3Key(rawKey);
			const size = Number(record.s3.object.size);
			const eTag = typeof record.s3.object.eTag === 'string' ? record.s3.object.eTag : undefined;
			const body: StorageEventBody = {
				account: instance.org_id,
				action: mapped.action,
				bucket,
				object: {
					key,
					...(mapped.type === 'object-create' && Number.isFinite(size) ? { size } : {}),
					...(eTag ? { eTag } : {}),
				},
				eventTime: typeof record.eventTime === 'string' ? record.eventTime : new Date(now).toISOString(),
				skiff: { type: `storage.${mapped.type}`, storage: instance.name, eventName: `s3:${eventName}` },
			};
			for (const rule of rules) {
				const filter = parseJson<StoredFilter>(rule.filter_json, {});
				if (filter.bucket !== bucket) continue;
				if (!this.ruleEvents(rule).includes(mapped.type)) continue;
				if (filter.prefix && !key.startsWith(filter.prefix)) continue;
				if (filter.suffix && !key.endsWith(filter.suffix)) continue;
				if (this.enqueue(rule, body.skiff.type, body, now)) queued += 1;
			}
		}
		return queued;
	}

	/** The bearer token RustFS sends: derived, so nothing new is stored or rotated per instance. */
	storageNotifyToken(instanceId: string): string {
		return hmac(this.ctx.config.masterKey, `storage-events:${instanceId}`);
	}

	storageNotifyEndpoint(instanceId: string): string {
		return `${this.ctx.config.platformOrigin}/api/webhooks/storage/${instanceId}`;
	}

	/** Buckets of one instance that an enabled rule watches; drives the bucket's desired state. */
	watchedBuckets(storageId: string): Set<string> {
		const rows = this.ctx.sqlite
			.query<{ filter_json: string }, []>("SELECT filter_json FROM event_rules WHERE source = 'storage' AND enabled = 1")
			.all();
		const out = new Set<string>();
		for (const row of rows) {
			const filter = parseJson<StoredFilter>(row.filter_json, {});
			if (filter.storageId === storageId && filter.bucket) out.add(filter.bucket);
		}
		return out;
	}

	// ---------------------------------------------------------------- node protocol

	/** Pending deliveries for live brokers on this node, leased to the caller. */
	lease(nodeId: string, limit = LEASE_LIMIT): AgentEventLease {
		const now = this.ctx.now();
		const rows = this.ctx.sqlite
			.query<DeliveryRow, [string, number, number, number]>(
				`SELECT d.* FROM event_deliveries d JOIN brokers b ON b.id = d.broker_id
				 WHERE b.node_id = ? AND b.deleted_at IS NULL AND d.status = 'pending'
				   AND d.next_attempt_at <= ? AND d.leased_until <= ?
				 ORDER BY d.created_at LIMIT ?`,
			)
			.all(nodeId, now, now, Math.min(Math.max(limit, 1), LEASE_LIMIT));
		const until = now + EVENT_LEASE_SECONDS * 1000;
		const update = this.ctx.sqlite.prepare('UPDATE event_deliveries SET leased_until = ?, attempts = attempts + 1 WHERE id = ? AND leased_until <= ?');
		const items: AgentEventLease['items'] = [];
		for (const row of rows) {
			// The conditional update is the lease: a second caller in the same window gets nothing.
			if (update.run(until, row.id, now).changes === 0) continue;
			items.push({ id: row.id, brokerId: row.broker_id, queue: row.queue, body: parseJson(row.body_json, null) });
		}
		return { items, leaseSeconds: EVENT_LEASE_SECONDS };
	}

	ack(nodeId: string, input: AgentEventAck): { ok: true } {
		const now = this.ctx.now();
		for (const result of input.results) {
			const row = this.ctx.sqlite
				.query<DeliveryRow & { node_id: string }, [string]>(
					'SELECT d.*, b.node_id FROM event_deliveries d JOIN brokers b ON b.id = d.broker_id WHERE d.id = ?',
				)
				.get(result.id);
			if (!row || row.node_id !== nodeId || row.status !== 'pending') continue;
			if (result.ok) {
				this.ctx.sqlite.run("UPDATE event_deliveries SET status = 'delivered', delivered_at = ?, leased_until = 0, last_error = NULL WHERE id = ?", [now, row.id]);
				continue;
			}
			const error = (result.error ?? 'publish failed').slice(0, 500);
			if (now - row.created_at >= EVENT_EXPIRY_MS) {
				this.ctx.sqlite.run("UPDATE event_deliveries SET status = 'failed', leased_until = 0, last_error = ? WHERE id = ?", [error, row.id]);
				continue;
			}
			const backoff = Math.min(1000 * 2 ** Math.max(0, row.attempts - 1), RETRY_MAX_MS);
			this.ctx.sqlite.run('UPDATE event_deliveries SET next_attempt_at = ?, leased_until = 0, last_error = ? WHERE id = ?', [now + backoff, error, row.id]);
		}
		return { ok: true };
	}

	/** Maintenance: fail what could not be published for a day, forget old history. */
	sweep(now = this.ctx.now()): { expired: number; removed: number } {
		const expired = this.ctx.sqlite.run(
			"UPDATE event_deliveries SET status = 'failed', last_error = COALESCE(last_error, 'No node published this event within 24 hours.') WHERE status = 'pending' AND created_at <= ?",
			[now - EVENT_EXPIRY_MS],
		).changes;
		const removed = this.ctx.sqlite.run("DELETE FROM event_deliveries WHERE status != 'pending' AND created_at <= ?", [now - KEEP_MS]).changes;
		return { expired, removed };
	}

	// ---------------------------------------------------------------- internals

	private emitPlatform(
		orgId: string,
		source: Exclude<EventSource, 'storage'>,
		event: string,
		data: Record<string, unknown>,
		matches: (filter: StoredFilter) => boolean,
	): void {
		// Workflows subscribed with `on: skiff_event` (docs/PIPELINES.md); never throws.
		this.ctx.pipelines?.onPlatformEvent(orgId, `${source}.${event}`, data);
		try {
			const rules = this.rulesFor(orgId, source).filter((rule) => this.ruleEvents(rule).includes(event) && matches(parseJson<StoredFilter>(rule.filter_json, {})));
			if (rules.length === 0) return;
			const now = this.ctx.now();
			const body: PlatformEventBody = {
				type: `${source}.${event}`,
				id: newId('evt_'),
				time: new Date(now).toISOString(),
				account: orgId,
				data,
			};
			for (const rule of rules) this.enqueue(rule, body.type, body, now);
		} catch (error) {
			// A broken rule must never fail the deploy, backup or alert that produced the event.
			console.error(`[events] ${source}.${event} for ${orgId} not queued:`, error);
		}
	}

	/** Insert one delivery; null when the org's outbox is full (logged once per call). */
	private enqueue(rule: RuleRow, type: string, body: unknown, now: number): string | null {
		const pending = this.ctx.sqlite
			.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM event_deliveries WHERE org_id = ? AND status = 'pending'")
			.get(rule.org_id)?.n ?? 0;
		if (pending >= MAX_PENDING_PER_ORG) {
			console.error(`[events] outbox full for ${rule.org_id} (${pending} pending); dropping ${type}`);
			return null;
		}
		const id = newId('evd_');
		this.ctx.sqlite.run(
			`INSERT INTO event_deliveries (id, org_id, rule_id, broker_id, queue, event_type, body_json, status, attempts, next_attempt_at, leased_until, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, 0, ?)`,
			[id, rule.org_id, rule.id, rule.broker_id, rule.queue, type, JSON.stringify(body), now, now],
		);
		return id;
	}

	private rulesFor(orgId: string, source: EventSource): RuleRow[] {
		return this.ctx.sqlite
			.query<RuleRow, [string, string]>('SELECT * FROM event_rules WHERE org_id = ? AND source = ? AND enabled = 1')
			.all(orgId, source);
	}

	private ruleEvents(rule: RuleRow): string[] {
		const events = parseJson<string[]>(rule.events_json, []);
		return events.length > 0 ? events : [...eventTypesBySource[rule.source]];
	}

	private requireRule(principal: Principal, id: string): RuleRow {
		const row = this.ctx.sqlite.query<RuleRow, [string, string]>('SELECT * FROM event_rules WHERE id = ? AND org_id = ?').get(id, principal.orgId);
		if (!row) throw new NotFoundError('Event rule');
		return row;
	}

	/** Check the source's resource exists and the caller may see it; keep its id. */
	private resolveFilter(principal: Principal, input: ReturnType<typeof eventRuleCreateSchema.parse>): StoredFilter {
		switch (input.source as EventSource) {
			case 'storage': {
				const storage = this.ctx.storage.requireRow(principal, input.storage!);
				this.ctx.iam.require(principal, 'storage:read', { type: 'storage', id: storage.id });
				const bucket = this.ctx.sqlite
					.query<{ name: string }, [string, string]>('SELECT name FROM storage_buckets WHERE storage_id = ? AND name = ?')
					.get(storage.id, input.bucket!);
				if (!bucket) throw new NotFoundError(`Bucket "${input.bucket}" on ${storage.name}`);
				return {
					storage: storage.name,
					storageId: storage.id,
					bucket: input.bucket!,
					...(input.prefix ? { prefix: input.prefix } : {}),
					...(input.suffix ? { suffix: input.suffix } : {}),
				};
			}
			case 'alerts': {
				this.ctx.iam.require(principal, 'metrics:read', { type: 'org' });
				if (!input.alertRule) return {};
				const rule = this.ctx.sqlite
					.query<{ id: string }, [string, string]>('SELECT id FROM alert_rules WHERE id = ? AND org_id = ?')
					.get(input.alertRule, principal.orgId);
				if (!rule) throw new NotFoundError('Alert rule');
				return { alertRule: rule.id };
			}
			case 'deployments': {
				if (!input.project) {
					this.ctx.iam.require(principal, 'deployment:read', { type: 'org' });
					return {};
				}
				const project = this.ctx.projects.requireRow(principal, input.project);
				this.ctx.iam.require(principal, 'deployment:read', { type: 'project', id: project.id });
				return { project: project.slug, projectId: project.id };
			}
			case 'database-backups': {
				if (!input.database) {
					this.ctx.iam.require(principal, 'database:read', { type: 'org' });
					return {};
				}
				const database = this.ctx.databases.requireRow(principal, input.database);
				this.ctx.iam.require(principal, 'database:read', { type: 'database', id: database.id });
				return { database: database.name, databaseId: database.id };
			}
			case 'registry': {
				// TODO(IAM I2): resolve a repository binding once `listRepositories` is scoped; a
				// repository name is not yet an IAM resource id this module can check directly.
				this.ctx.iam.require(principal, 'image:pull', { type: 'org' });
				if (!input.repository) return {};
				if (!this.ctx.registry.listRepositories(principal).some((repo) => repo.name === input.repository))
					throw new NotFoundError(`Repository "${input.repository}"`);
				return { repository: input.repository };
			}
		}
		throw new ValidationError(`Unknown event source "${input.source}".`);
	}

	private view(row: RuleRow): EventRuleView {
		const filter = parseJson<StoredFilter>(row.filter_json, {});
		const since = this.ctx.now() - 24 * 60 * 60_000;
		const counts = this.ctx.sqlite
			.query<{ status: EventDeliveryStatus; n: number }, [string, number]>(
				"SELECT status, COUNT(*) AS n FROM event_deliveries WHERE rule_id = ? AND (status = 'pending' OR created_at >= ?) GROUP BY status",
			)
			.all(row.id, since);
		const last = this.ctx.sqlite
			.query<{ delivered_at: number | null }, [string]>(
				"SELECT MAX(delivered_at) AS delivered_at FROM event_deliveries WHERE rule_id = ? AND status = 'delivered'",
			)
			.get(row.id);
		const lastError = this.ctx.sqlite
			.query<{ last_error: string | null }, [string]>(
				'SELECT last_error FROM event_deliveries WHERE rule_id = ? AND last_error IS NOT NULL ORDER BY created_at DESC LIMIT 1',
			)
			.get(row.id);
		const broker = this.ctx.sqlite.query<{ name: string }, [string]>('SELECT name FROM brokers WHERE id = ?').get(row.broker_id);
		const { storageId: _storageId, projectId, databaseId, ...shown } = filter;
		// Show current names: a project or database can be renamed after the rule was made.
		if (projectId) shown.project = this.ctx.sqlite.query<{ slug: string }, [string]>('SELECT slug FROM projects WHERE id = ?').get(projectId)?.slug ?? shown.project;
		if (databaseId) shown.database = this.ctx.sqlite.query<{ name: string }, [string]>('SELECT name FROM databases WHERE id = ?').get(databaseId)?.name ?? shown.database;
		return {
			id: row.id,
			source: row.source,
			events: this.ruleEvents(row),
			filter: shown,
			broker: broker?.name ?? '(deleted broker)',
			queue: row.queue,
			description: row.description,
			enabled: row.enabled === 1,
			createdAt: new Date(row.created_at).toISOString(),
			updatedAt: new Date(row.updated_at).toISOString(),
			deliveries: {
				pending: counts.find((count) => count.status === 'pending')?.n ?? 0,
				delivered: counts.find((count) => count.status === 'delivered')?.n ?? 0,
				failed: counts.find((count) => count.status === 'failed')?.n ?? 0,
			},
			lastDeliveredAt: iso(last?.delivered_at ?? null),
			lastError: lastError?.last_error ?? null,
		};
	}

	private deliveryView(row: DeliveryRow): EventDeliveryView {
		return {
			id: row.id,
			ruleId: row.rule_id,
			type: row.event_type,
			status: row.status,
			attempts: row.attempts,
			createdAt: new Date(row.created_at).toISOString(),
			deliveredAt: iso(row.delivered_at),
			lastError: row.last_error,
			body: parseJson(row.body_json, null),
		};
	}
}

function setOrDrop(filter: StoredFilter, field: 'prefix' | 'suffix', value: string | null): void {
	if (value) filter[field] = value;
	else delete filter[field];
}

/** S3 event keys are URL-encoded (`uploads%2Fcat.jpg`, `+` for a space). */
export function decodeS3Key(raw: string): string {
	try {
		return decodeURIComponent(raw.replace(/\+/g, ' '));
	} catch {
		return raw;
	}
}
