import { and, eq, isNull } from 'drizzle-orm';
import { brokers, nodes, workloadReplicas, workloads } from '@yoal/db';
import {
	NODE_TASKS_CAPABILITY,
	brokerQueueCreateInputSchema,
	brokerQueueRedriveInputSchema,
	brokerQueueSendInputSchema,
	brokerStreamMessageTargetSchema,
	brokerStreamPeekInputSchema,
	brokerStreamTargetSchema,
	functionInvokeInputSchema,
	functionScheduledInputSchema,
	mutatingNodeTaskKinds,
	nodeTaskDone,
	nodeTaskLimits,
	nodeTaskResultSchemas,
	nodeTaskTargetType,
	parseWorkloadReplicaId,
	workloadReplicaId,
	type AgentNodeTaskLease,
	type AgentNodeTaskResult,
	type BrokerStreamStats,
	type NodeTaskKind,
	type NodeTaskSpec,
	type NodeTaskStatus,
	type NodeTaskStreamState,
	type NodeTaskView,
	type Permission,
	type Principal,
	type ResourceRef,
} from '@yoal/contracts';
import type { CoreContext } from './context.ts';
import { ConflictError, CoreError, NotFoundError, ValidationError } from './errors.ts';
import type { ProjectRow } from './projects.ts';
import { newId, parseJson } from './util.ts';

/**
 * Node tasks (D124): one-shot queue and function tools that only the target's node can run.
 *
 * - **Queue.** A caller asks for a typed task (`brokerTask`, `functionTask`). The service checks
 *   the permission, that the target is running and that its node's agent leases tasks, then
 *   inserts a `pending` row bound to that node.
 * - **Lease.** The node's agent long-polls `lease`; a conditional update hands each row to one
 *   caller and marks it `running` until `leaseSeconds` pass.
 * - **Result.** The agent posts `complete`; results are checked against the kind's schema, and a
 *   broker change patches the stored stream listing so the dashboard does not wait for the next
 *   once-a-minute sample (D123).
 * - **Sweep.** Unleased rows fail after `pickupMs`, lost leases after `leaseSeconds`, and finished
 *   rows are deleted after `retentionMs` (results can carry message bodies).
 */

interface TaskRow {
	id: string;
	org_id: string;
	node_id: string;
	kind: NodeTaskKind;
	target_type: 'broker' | 'workload';
	target_id: string;
	target_name: string;
	input_json: string;
	status: NodeTaskStatus;
	result_json: string | null;
	error: string | null;
	leased_until: number;
	created_by: string;
	created_at: number;
	started_at: number | null;
	finished_at: number | null;
}

const LEASE_BATCH = 10;

/** What each kind needs on top of reading the target. */
const KIND_PERMISSION: Record<NodeTaskKind, Permission> = {
	'broker.queue.create': 'broker:update',
	'broker.queue.send': 'broker:update',
	'broker.queue.redrive': 'broker:update',
	// Message bodies are data, not metadata: reading them is an operator's job, not a viewer's.
	'broker.stream.peek': 'broker:update',
	'broker.stream.purge': 'broker:delete',
	'broker.stream.delete': 'broker:delete',
	'broker.stream.deleteMessage': 'broker:delete',
	// Running the code is what a deployer can already do by shipping it.
	'function.invoke': 'deployment:create',
	'function.scheduled': 'deployment:create',
};

/** Raw caller input → the spec the agent runs. Each parse applies defaults and limits. */
const PARSERS: { [K in NodeTaskKind]: (raw: unknown) => Extract<NodeTaskSpec, { kind: K }>['input'] } = {
	'broker.queue.create': (raw) => brokerQueueCreateInputSchema.parse(raw),
	'broker.queue.send': (raw) => {
		const input = brokerQueueSendInputSchema.parse(raw);
		if (new TextEncoder().encode(input.body).byteLength > nodeTaskLimits.messageBytes)
			throw new ValidationError(`Message bodies are at most ${nodeTaskLimits.messageBytes / 1024} KiB.`);
		return { queue: input.queue, body: input.body, contentType: input.contentType, count: input.count, ...(input.delaySeconds ? { delaySeconds: input.delaySeconds } : {}) };
	},
	'broker.queue.redrive': (raw) => brokerQueueRedriveInputSchema.parse(raw),
	'broker.stream.peek': (raw) => brokerStreamPeekInputSchema.parse(raw),
	'broker.stream.purge': (raw) => brokerStreamTargetSchema.parse(raw),
	'broker.stream.delete': (raw) => brokerStreamTargetSchema.parse(raw),
	'broker.stream.deleteMessage': (raw) => brokerStreamMessageTargetSchema.parse(raw),
	'function.invoke': (raw) => {
		const input = functionInvokeInputSchema.parse(raw);
		// Yoal's internal header is the shim's own; a test request never carries it.
		const headers = Object.fromEntries(Object.entries(input.headers).filter(([name]) => name.toLowerCase() !== 'x-yoal-internal'));
		return { method: input.method, path: input.path, headers, ...(input.body !== undefined ? { body: input.body } : {}) };
	},
	'function.scheduled': (raw) => functionScheduledInputSchema.parse(raw),
};

export class NodeTaskService {
	constructor(private readonly ctx: CoreContext) {}

	// ---------------------------------------------------------------- queueing

	/** Queue a task against a managed broker's JetStream (docs/BROKERS.md §5). */
	brokerTask<K extends Extract<NodeTaskKind, `broker.${string}`>>(principal: Principal, name: string, kind: K, raw: unknown): NodeTaskView<K> {
		const row = this.ctx.db
			.select()
			.from(brokers)
			.where(and(eq(brokers.orgId, principal.orgId), eq(brokers.name, name)))
			.get();
		if (!row || row.deletedAt) throw new NotFoundError(`Broker "${name}"`);
		const resource: ResourceRef = { type: 'broker', id: row.id };
		this.ctx.iam.require(principal, 'broker:read', resource);
		this.ctx.iam.require(principal, KIND_PERMISSION[kind], resource);
		const input = PARSERS[kind](raw);
		if (row.status !== 'running')
			throw new ConflictError(`${name} is ${row.status}; queue tools need the broker running.`);
		this.requireTaskNode(row.nodeId);
		const view = this.insert(principal, { kind, input } as NodeTaskSpec, { type: 'broker', id: row.id, name: row.name, nodeId: row.nodeId });
		this.audit(principal, kind, 'broker', row.id, { broker: name, ...auditArgs(kind, input) });
		return view as NodeTaskView<K>;
	}

	/** Queue a test request or a cron run against a function's host (docs/FUNCTIONS.md §4.11). */
	functionTask<K extends Extract<NodeTaskKind, `function.${string}`>>(principal: Principal, project: ProjectRow, kind: K, raw: unknown): NodeTaskView<K> {
		const host = this.functionHost(project);
		const resource: ResourceRef = {
			type: 'deployment',
			id: host.deploymentId,
			projectId: host.projectId,
		};
		this.ctx.iam.require(principal, 'deployment:read', resource);
		this.ctx.iam.require(principal, KIND_PERMISSION[kind], resource);
		const input = PARSERS[kind](raw);
		if (kind === 'function.scheduled') {
			const cron = (input as { cron: string }).cron;
			if (!host.crons.includes(cron))
				throw new ValidationError(
					host.crons.length === 0
						? `${project.slug} has no cron triggers in its active deployment.`
						: `${project.slug} has no cron "${cron}". Its crons: ${host.crons.join(', ')}.`,
				);
		}
		this.requireTaskNode(host.nodeId);
		const view = this.insert(principal, { kind, input } as NodeTaskSpec, { type: 'workload', id: host.desiredId, name: project.slug, nodeId: host.nodeId });
		this.audit(principal, kind, 'project', project.id, { project: project.slug, ...auditArgs(kind, input) });
		return view as NodeTaskView<K>;
	}

	get(principal: Principal, id: string): NodeTaskView {
		const row = this.ctx.sqlite.query<TaskRow, [string, string]>('SELECT * FROM node_tasks WHERE id = ? AND org_id = ?').get(id, principal.orgId);
		if (!row) throw new NotFoundError(`Task "${id}"`);
		this.ctx.iam.require(
			principal,
			row.target_type === 'broker' ? 'broker:read' : 'deployment:read',
			this.taskResource(row),
		);
		return toView(row);
	}

	/** Wait up to `timeoutMs` for the task to finish; returns whatever state it is in by then. */
	async wait<K extends NodeTaskKind>(principal: Principal, task: NodeTaskView<K>, timeoutMs: number = nodeTaskLimits.waitMs): Promise<NodeTaskView<K>> {
		const deadline = Date.now() + Math.max(0, timeoutMs);
		let current = task;
		while (!nodeTaskDone(current) && Date.now() < deadline) {
			await Bun.sleep(Math.min(250, Math.max(1, deadline - Date.now())));
			current = this.get(principal, task.id) as NodeTaskView<K>;
		}
		return current;
	}

	/** Queue, then wait for the result; throws the task's own error when it failed. */
	async run<K extends NodeTaskKind>(principal: Principal, task: NodeTaskView<K>, timeoutMs?: number): Promise<NodeTaskView<K>> {
		const done = await this.wait(principal, task, timeoutMs);
		if (done.status === 'failed') throw new CoreError('node_task_failed', done.error ?? 'The task failed.', 502);
		return done;
	}

	// ---------------------------------------------------------------- node protocol

	/** Pending tasks for this node, leased to the caller. */
	lease(nodeId: string): AgentNodeTaskLease {
		const now = this.ctx.now();
		const rows = this.ctx.sqlite
			.query<TaskRow, [string, number]>(
				"SELECT * FROM node_tasks WHERE node_id = ? AND status = 'pending' ORDER BY created_at LIMIT ?",
			)
			.all(nodeId, LEASE_BATCH);
		const until = now + nodeTaskLimits.leaseSeconds * 1000;
		const claim = this.ctx.sqlite.prepare("UPDATE node_tasks SET status = 'running', leased_until = ?, started_at = ? WHERE id = ? AND status = 'pending'");
		const tasks: AgentNodeTaskLease['tasks'] = [];
		for (const row of rows) {
			// The conditional update is the lease: a second caller in the same window gets nothing.
			if (claim.run(until, now, row.id).changes === 0) continue;
			tasks.push({ id: row.id, targetId: row.target_id, kind: row.kind, input: parseJson(row.input_json, {}) } as AgentNodeTaskLease['tasks'][number]);
		}
		return { tasks, leaseSeconds: nodeTaskLimits.leaseSeconds };
	}

	/** True when a lease right now would hand out something (the long-poll checks this cheaply). */
	hasPending(nodeId: string): boolean {
		return (
			this.ctx.sqlite.query<{ n: number }, [string]>("SELECT 1 AS n FROM node_tasks WHERE node_id = ? AND status = 'pending' LIMIT 1").get(nodeId) !== null
		);
	}

	complete(nodeId: string, input: AgentNodeTaskResult): { ok: true } {
		const now = this.ctx.now();
		for (const item of input.results) {
			const row = this.ctx.sqlite.query<TaskRow, [string]>('SELECT * FROM node_tasks WHERE id = ?').get(item.id);
			// Another node's task, or one the sweep already failed: ignore.
			if (!row || row.node_id !== nodeId || row.status !== 'running') continue;
			if (!item.ok) {
				this.finish(row.id, 'failed', null, (item.error ?? 'The node could not run the task.').slice(0, 2000), now);
				continue;
			}
			const parsed = nodeTaskResultSchemas[row.kind].safeParse(item.result);
			if (!parsed.success) {
				this.finish(row.id, 'failed', null, 'The node returned a result this control plane does not understand.', now);
				continue;
			}
			this.finish(row.id, 'succeeded', JSON.stringify(parsed.data), null, now);
			if (row.target_type === 'broker' && mutatingNodeTaskKinds.includes(row.kind)) this.patchListing(row, parsed.data);
		}
		return { ok: true };
	}

	/** Maintenance: fail what no node picked up or reported, forget old results. */
	sweep(now = this.ctx.now()): { failed: number; removed: number } {
		const unclaimed = this.ctx.sqlite.run(
			"UPDATE node_tasks SET status = 'failed', finished_at = ?, error = 'The node did not pick this task up. Is it online and on a current agent?' WHERE status = 'pending' AND created_at <= ?",
			[now, now - nodeTaskLimits.pickupMs],
		).changes;
		const lost = this.ctx.sqlite.run(
			"UPDATE node_tasks SET status = 'failed', finished_at = ?, error = 'The node took the task but did not report a result in time.' WHERE status = 'running' AND leased_until <= ?",
			[now, now],
		).changes;
		const removed = this.ctx.sqlite.run('DELETE FROM node_tasks WHERE status IN (\'succeeded\', \'failed\') AND created_at <= ?', [now - nodeTaskLimits.retentionMs]).changes;
		return { failed: unclaimed + lost, removed };
	}

	// ---------------------------------------------------------------- internals

	private insert(principal: Principal, spec: NodeTaskSpec, target: { type: 'broker' | 'workload'; id: string; name: string; nodeId: string }): NodeTaskView {
		// Stale rows would otherwise count towards the cap until the next maintenance pass.
		this.sweep();
		const pending =
			this.ctx.sqlite
				.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM node_tasks WHERE org_id = ? AND status IN ('pending', 'running')")
				.get(principal.orgId)?.n ?? 0;
		if (pending >= nodeTaskLimits.pendingPerOrg)
			throw new ConflictError(`${pending} node tasks are already waiting for this organisation; try again once they finish.`);
		if (nodeTaskTargetType(spec.kind) !== target.type) throw new Error(`Task ${spec.kind} cannot target a ${target.type}`);
		const id = newId('ntk_');
		const now = this.ctx.now();
		this.ctx.sqlite.run(
			`INSERT INTO node_tasks (id, org_id, node_id, kind, target_type, target_id, target_name, input_json, status, leased_until, created_by, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
			[id, principal.orgId, target.nodeId, spec.kind, target.type, target.id, target.name, JSON.stringify(spec.input), principal.userId, now],
		);
		const row = this.ctx.sqlite.query<TaskRow, [string]>('SELECT * FROM node_tasks WHERE id = ?').get(id)!;
		return toView(row);
	}

	private finish(id: string, status: NodeTaskStatus, resultJson: string | null, error: string | null, now: number): void {
		this.ctx.sqlite.run('UPDATE node_tasks SET status = ?, result_json = ?, error = ?, finished_at = ?, leased_until = 0 WHERE id = ?', [status, resultJson, error, now, id]);
	}

	/** Refuse up front when nothing will ever lease the task. */
	private requireTaskNode(nodeId: string): void {
		const node = this.ctx.db.select({ id: nodes.id, name: nodes.name, status: nodes.status, capabilitiesJson: nodes.capabilitiesJson }).from(nodes).where(eq(nodes.id, nodeId)).get();
		if (!node) throw new ConflictError('The service has no node.');
		const label = node.name ?? node.id;
		if (node.status === 'offline') throw new ConflictError(`${label} is offline, so it cannot run the task.`);
		if (!parseJson<string[]>(node.capabilitiesJson, []).includes(NODE_TASKS_CAPABILITY))
			throw new ConflictError(`${label} runs an agent that predates queue and function tools. Update the node first.`);
	}

	/** The narrowest resource a stored task targets, for a permission check on `get`. */
	private taskResource(row: TaskRow): ResourceRef {
		if (row.target_type === 'broker') return { type: 'broker', id: row.target_id };
		const { workloadId } = parseWorkloadReplicaId(row.target_id);
		const workload = this.ctx.db
			.select({ projectId: workloads.projectId, deploymentId: workloads.deploymentId })
			.from(workloads)
			.where(eq(workloads.id, workloadId))
			.get();
		return { type: 'deployment', id: workload?.deploymentId ?? row.target_id, projectId: workload?.projectId };
	}

	/** Replica 0 of the function's active workload: the host whose crons and queues run (FN9). */
	private functionHost(project: ProjectRow): { nodeId: string; desiredId: string; crons: string[]; projectId: string; deploymentId: string } {
		const row = this.ctx.db.select().from(workloads).where(eq(workloads.projectId, project.id)).get();
		if (!row || (row.runtimeName ?? row.runtime) !== 'function')
			throw new ConflictError(`${project.slug} has no active function deployment yet. Deploy it first.`);
		const spec = parseJson<{ replicas?: number; runner?: unknown; function?: { triggers?: { crons?: string[] } } }>(row.specJson, {});
		const crons = spec.function?.triggers?.crons ?? [];
		const replica = this.ctx.db
			.select()
			.from(workloadReplicas)
			.where(and(eq(workloadReplicas.workloadId, row.id), eq(workloadReplicas.replicaIndex, 0)))
			.get();
		if (replica) return { nodeId: replica.nodeId, desiredId: workloadReplicaId(row.id, 0), crons, projectId: row.projectId, deploymentId: row.deploymentId };
		if (!row.nodeId) throw new ConflictError(`${project.slug} is not placed on a node yet.`);
		const single = (spec.replicas ?? 1) === 1 && !spec.runner;
		return { nodeId: row.nodeId, desiredId: single ? row.id : workloadReplicaId(row.id, 0), crons, projectId: row.projectId, deploymentId: row.deploymentId };
	}

	/** Fold a broker task's after-state into the stored listing (D123 keeps only the newest). */
	private patchListing(row: TaskRow, result: unknown): void {
		const broker = this.ctx.db.select().from(brokers).where(and(eq(brokers.id, row.target_id), isNull(brokers.deletedAt))).get();
		if (!broker) return;
		const streams = parseJson<BrokerStreamStats[]>(broker.queueStats, []);
		const value = result as { stream?: string; state?: NodeTaskStreamState | null; source?: NodeTaskStreamState | null; deleted?: boolean };
		let next = streams;
		if (row.kind === 'broker.stream.delete' && value.deleted && value.stream) next = streams.filter((item) => item.stream !== value.stream);
		for (const state of [value.state, value.source]) if (state) next = upsertStream(next, state);
		if (next === streams) return;
		this.ctx.db.update(brokers).set({ queueStats: JSON.stringify(next) }).where(eq(brokers.id, broker.id)).run();
	}

	private audit(principal: Principal, kind: NodeTaskKind, resource: string, resourceId: string, args: Record<string, unknown>): void {
		this.ctx.audit.record({ principal, action: `node_task.${kind}`, resource, resourceId, args, result: 'ok' });
	}
}

/** What the audit log keeps: names and sizes, never message or request bodies. */
function auditArgs(kind: NodeTaskKind, input: Record<string, unknown>): Record<string, unknown> {
	switch (kind) {
		case 'broker.queue.send':
			return { queue: input.queue, contentType: input.contentType, count: input.count, bytes: String(input.body ?? '').length };
		case 'function.invoke':
			return { method: input.method, path: String(input.path ?? '').split('?')[0], bytes: input.body === undefined ? 0 : String(input.body).length };
		default:
			return input;
	}
}

function upsertStream(streams: BrokerStreamStats[], state: NodeTaskStreamState): BrokerStreamStats[] {
	const index = streams.findIndex((item) => item.stream === state.stream);
	if (index >= 0) {
		const copy = [...streams];
		copy[index] = { ...copy[index]!, messages: state.messages, bytes: state.bytes, firstAt: state.firstAt, lastAt: state.lastAt };
		return copy;
	}
	const queue = state.stream.startsWith('YOAL_Q_') ? state.stream.slice('YOAL_Q_'.length) : null;
	const added: BrokerStreamStats = {
		stream: state.stream,
		queue,
		subjects: queue ? [`yoal.q.${queue}`] : [],
		storage: 'file',
		retention: queue ? 'workqueue' : 'limits',
		messages: state.messages,
		bytes: state.bytes,
		maxBytes: null,
		firstAt: state.firstAt,
		lastAt: state.lastAt,
		consumerCount: 0,
		pending: 0,
		ackPending: 0,
		redelivered: 0,
		consumers: [],
	};
	return [...streams, added].sort((a, b) => a.stream.localeCompare(b.stream));
}

function toView(row: TaskRow): NodeTaskView {
	return {
		id: row.id,
		kind: row.kind,
		status: row.status,
		target: { type: row.target_type, name: row.target_name, nodeId: row.node_id },
		input: parseJson(row.input_json, {}),
		result: row.result_json ? parseJson(row.result_json, null) : null,
		error: row.error,
		createdAt: new Date(row.created_at).toISOString(),
		startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
		finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
	};
}
