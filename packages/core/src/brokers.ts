import { and, eq, inArray, isNotNull, isNull, lte } from 'drizzle-orm';
import { brokerAttachments, brokerLogEvents, brokers, nodes, projects, workloads } from '@skiff/db';
import {
	BROKER_ID_PREFIX,
	BROKER_PORT_MAX,
	BROKER_PORT_MIN,
	brokerAlias,
	brokerAttachSchema,
	brokerConnectionSnippets,
	brokerConnectionUrl,
	brokerCreateSchema,
	brokerEngineRegistry,
	brokerEnvNames,
	brokerIdentifier,
	brokerImage,
	brokerUpdateSchema,
	brokerUpgradeVersions,
	orgNetworkName,
	requirePermission,
	type BrokerAttach,
	brokerStreamStatsSchema,
	type BrokerAttachmentView,
	type BrokerCreate,
	type BrokerCredentials,
	type BrokerMetricBucket,
	type BrokerMetricPoint,
	type BrokerQueueSnapshot,
	type BrokerQueuesView,
	type BrokerStreamStats,
	type BrokerStatus,
	type BrokerUpdate,
	type BrokerView,
	type Principal,
	type WorkloadActivation,
	type WorkloadDesired,
	type WorkloadRuntime,
	type WorkloadStatus,
} from '@skiff/contracts';
import { featureEnabled } from './config.ts';
import type { CoreContext } from './context.ts';
import { ConflictError, CoreError, NotFoundError, ValidationError } from './errors.ts';
import { resolvePlacement } from './placement.ts';
import { isFunctionTier } from './runtime-tier.ts';
import type { ProjectRow } from './projects.ts';
import type { VolumeRow } from './volumes.ts';
import { newId, parseJson, randomBytes, sha256Hex } from './util.ts';

export type BrokerRow = typeof brokers.$inferSelect;

const ACTIVE: BrokerStatus[] = ['pending', 'starting', 'running'];
/** The agent capability a node must advertise before it is handed a broker (older agents drop it). */
const BROKER_CAPABILITY = 'brokers';

/**
 * Managed queue brokers (docs/BROKERS.md, D111). A broker is an org resource that runs as a tier-3
 * container on one node, exactly like a managed database: placement and admission at create time,
 * the helper's fixed profile on the node, a sealed password that reaches attached apps only at
 * activation (D18, D56, D58), and a soft delete with a node-side purge (D59).
 */
export class BrokerService {
	constructor(private readonly ctx: CoreContext) {}

	// ---------------------------------------------------------------- reads

	list(principal: Principal, options: { includeDeleted?: boolean } = {}): BrokerView[] {
		requirePermission(principal, 'broker:read');
		const filters = [eq(brokers.orgId, principal.orgId)];
		if (!options.includeDeleted) filters.push(isNull(brokers.deletedAt));
		return this.ctx.db
			.select()
			.from(brokers)
			.where(and(...filters))
			.all()
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((row) => this.toView(row));
	}

	get(principal: Principal, name: string, options: { includeDeleted?: boolean } = {}): BrokerView {
		requirePermission(principal, 'broker:read');
		return this.toView(this.requireRow(principal, name, options));
	}

	requireRow(principal: Principal, name: string, options: { includeDeleted?: boolean } = {}): BrokerRow {
		const row = this.ctx.db
			.select()
			.from(brokers)
			.where(and(eq(brokers.orgId, principal.orgId), eq(brokers.name, name)))
			.get();
		if (!row || (row.deletedAt && !options.includeDeleted)) throw new NotFoundError(`Broker "${name}"`);
		return row;
	}

	// ---------------------------------------------------------------- metrics (D123)

	/** Minute series from ClickHouse; empty without telemetry. Deleted brokers keep their history. */
	async metrics(
		principal: Principal,
		name: string,
		input: { from: string | number | Date; to: string | number | Date; interval?: '1m' | '1h' },
	): Promise<BrokerMetricPoint[]> {
		requirePermission(principal, 'broker:read');
		const row = this.requireRow(principal, name, { includeDeleted: true });
		if (!this.ctx.telemetry) return [];
		return this.ctx.telemetry.queryBrokerMetrics({
			brokerId: row.id,
			from: input.from,
			to: input.to,
			interval: input.interval ?? '1m',
		});
	}

	/** The newest stream listing the broker's node reported (SQLite, so it works without ClickHouse). */
	queues(principal: Principal, name: string): BrokerQueuesView {
		requirePermission(principal, 'broker:read');
		const row = this.requireRow(principal, name, { includeDeleted: true });
		return {
			brokerId: row.id,
			name: row.name,
			at: row.statsAt ? new Date(row.statsAt).toISOString() : null,
			truncated: row.queueStatsTruncated,
			streams: storedStreams(row.queueStats),
		};
	}

	/**
	 * Samples and stream listings from a node. Anything for a broker not placed on that node is
	 * dropped, so a node can never write another node's (or org's) numbers. The newest totals and
	 * listing go to SQLite; the time series goes to ClickHouse when it is installed.
	 */
	async ingestTelemetry(
		nodeId: string,
		samples: BrokerMetricBucket[],
		snapshots: BrokerQueueSnapshot[],
	): Promise<{ stored: number }> {
		if (samples.length === 0 && snapshots.length === 0) return { stored: 0 };
		const owned = new Set(
			this.ctx.db
				.select({ id: brokers.id })
				.from(brokers)
				.where(and(eq(brokers.nodeId, nodeId), isNull(brokers.purgeRequestedAt)))
				.all()
				.map((row) => row.id),
		);
		const accepted = samples.filter((sample) => owned.has(sample.brokerId));
		const latest = new Map<string, BrokerMetricBucket>();
		for (const sample of accepted) {
			const previous = latest.get(sample.brokerId);
			if (!previous || previous.bucket < sample.bucket) latest.set(sample.brokerId, sample);
		}
		for (const [id, sample] of latest) {
			if (!sample.up) continue;
			this.ctx.db
				.update(brokers)
				.set({ storeBytes: sample.storeBytes, messages: sample.messages })
				.where(eq(brokers.id, id))
				.run();
		}
		for (const snapshot of snapshots) {
			if (!owned.has(snapshot.brokerId)) continue;
			const parsed = Date.parse(snapshot.at);
			this.ctx.db
				.update(brokers)
				.set({
					queueStats: JSON.stringify(snapshot.streams),
					queueStatsTruncated: snapshot.truncated,
					statsAt: Number.isFinite(parsed) ? Math.min(parsed, this.ctx.now()) : this.ctx.now(),
				})
				.where(eq(brokers.id, snapshot.brokerId))
				.run();
		}
		if (accepted.length === 0 || !this.ctx.telemetry) return { stored: 0 };
		const result = await this.ctx.telemetry.ingestBrokerMetrics(accepted);
		return { stored: result.inserted };
	}

	/** Live brokers whose JetStream store is at or above `threshold` of the budget (system alert). */
	alertCandidates(threshold = 0.85): Array<{ row: BrokerRow; ratio: number }> {
		return this.ctx.db
			.select()
			.from(brokers)
			.where(and(isNull(brokers.deletedAt), isNotNull(brokers.storeBytes)))
			.all()
			.flatMap((row) => {
				const ratio = (row.storeBytes ?? 0) / (row.storageMb * 1024 * 1024);
				return ratio >= threshold ? [{ row, ratio }] : [];
			});
	}

	// ---------------------------------------------------------------- lifecycle

	create(principal: Principal, raw: BrokerCreate): BrokerView {
		requirePermission(principal, 'broker:create');
		this.requireFeature();
		const input = brokerCreateSchema.parse(raw);
		const info = brokerEngineRegistry[input.engine];
		const version = input.version ?? info.defaultVersion;
		const memoryMb = input.memoryMb ?? info.defaultMemoryMb;

		const existing = this.ctx.db
			.select({ id: brokers.id, deletedAt: brokers.deletedAt })
			.from(brokers)
			.where(and(eq(brokers.orgId, principal.orgId), eq(brokers.name, input.name)))
			.get();
		if (existing)
			throw new ConflictError(
				existing.deletedAt
					? `Broker "${input.name}" is in the trash. Restore it or pick another name.`
					: `Broker "${input.name}" already exists.`,
			);

		let project: ProjectRow | null = null;
		let requested = input.placement;
		if (input.project) {
			requirePermission(principal, 'project:update');
			project = this.ctx.projects.requireRow(principal, input.project);
			this.assertConsumer(project);
			// Co-locate with the app (D56): its pinned node, else its current workload node, else its request.
			const workloadNode = this.ctx.db
				.select({ nodeId: workloads.nodeId })
				.from(workloads)
				.where(eq(workloads.projectId, project.id))
				.get()?.nodeId;
			requested = this.ctx.workloads.attachmentNode(project.id) ?? workloadNode ?? project.placement;
		}

		// A named volume pins the node: the data dir has to be on the same node as the container.
		let volume: VolumeRow | null = null;
		if (input.volume) {
			volume = this.ctx.volumes.findByName(input.volume);
			const edgeNodeId = this.ctx.workloads.edgeNode();
			const target = requested === 'auto' ? null : requested === 'edge' ? edgeNodeId : requested;
			if (target && target !== volume.nodeId)
				throw new ValidationError(
					`Volume "${volume.name}" is on another node; place this broker there or pick a volume on the target node.`,
				);
			requested = volume.nodeId;
		}

		const nodeId = this.place(requested, memoryMb);
		if (!volume) volume = this.ctx.volumes.defaultFor(nodeId);
		if (volume) this.ctx.volumes.assertRoom(volume, input.storageMb);
		this.ctx.quota.assertCanAdmitMemory(principal.orgId, project?.id, memoryMb);

		const id = newId(BROKER_ID_PREFIX);
		const now = this.ctx.now();
		const hostPort = this.allocatePort(nodeId);
		const ownerSecret = this.ctx.secrets.seal(principal.orgId, password());
		const envPrefix = input.envPrefix ?? info.defaultEnvPrefix;
		this.ctx.sqlite.transaction(() => {
			this.ctx.db
				.insert(brokers)
				.values({
					id,
					orgId: principal.orgId,
					name: input.name,
					engine: input.engine,
					version,
					nodeId,
					hostPort,
					memoryMb,
					cpus: input.cpus,
					storageMb: input.storageMb,
					volumeId: volume?.id ?? null,
					status: 'pending',
					ownerSecret,
					createdBy: principal.userId,
					createdAt: now,
					updatedAt: now,
				})
				.run();
			if (project) this.insertAttachment(principal, id, project, envPrefix);
		})();
		this.ctx.audit.record({
			principal,
			action: 'broker.create',
			resource: 'broker',
			resourceId: id,
			args: {
				name: input.name,
				engine: input.engine,
				version,
				nodeId,
				memoryMb,
				storageMb: input.storageMb,
				...(volume ? { volume: volume.name } : {}),
				...(project ? { project: project.slug, envPrefix } : {}),
			},
			result: 'ok',
		});
		this.ctx.projects.bump(principal.orgId);
		return this.toView(this.requireRow(principal, input.name));
	}

	update(principal: Principal, name: string, raw: BrokerUpdate): BrokerView {
		requirePermission(principal, 'broker:update');
		const patch = brokerUpdateSchema.parse(raw);
		const row = this.requireRow(principal, name);
		const info = brokerEngineRegistry[row.engine];
		if (patch.version !== undefined && patch.version !== row.version) {
			if (!info.versions.includes(patch.version))
				throw new ValidationError(`${info.label} versions: ${info.versions.join(', ')}.`);
			if (!brokerUpgradeVersions(row.engine, row.version).includes(patch.version))
				throw new ConflictError(
					`${info.label} cannot be downgraded in place (${row.version} → ${patch.version}). Create a new broker on ${patch.version} instead.`,
				);
		}
		if (patch.memoryMb !== undefined) {
			if (patch.memoryMb < info.minMemoryMb)
				throw new ValidationError(`${info.label} needs at least ${info.minMemoryMb} MB.`);
			if (patch.memoryMb > row.memoryMb) {
				this.admit(row, patch.memoryMb);
				this.ctx.quota.assertCanAdmitMemory(
					row.orgId,
					this.attachmentsOf(row.id)[0]?.projectId,
					patch.memoryMb - row.memoryMb,
				);
			}
		}
		if (patch.storageMb !== undefined && patch.storageMb > row.storageMb && row.volumeId)
			this.ctx.volumes.assertVolumeReady(row.volumeId, patch.storageMb - row.storageMb);
		this.ctx.db
			.update(brokers)
			.set({ ...patch, updatedAt: this.ctx.now() })
			.where(eq(brokers.id, row.id))
			.run();
		this.ctx.audit.record({
			principal,
			action: 'broker.update',
			resource: 'broker',
			resourceId: row.id,
			args: { name, ...patch },
			result: 'ok',
		});
		this.ctx.projects.bump(principal.orgId);
		return this.toView(this.requireRow(principal, name));
	}

	/** Soft delete (D59): the container stops, the data dir stays on the node for the trash window. */
	delete(principal: Principal, name: string): BrokerView {
		requirePermission(principal, 'broker:delete');
		const row = this.requireRow(principal, name);
		const attached = this.attachmentsOf(row.id);
		if (attached.length > 0)
			throw new ConflictError(
				`Broker "${name}" is attached to ${attached.map((item) => item.projectSlug).join(', ')}. Detach it first.`,
			);
		const now = this.ctx.now();
		this.ctx.db
			.update(brokers)
			.set({ deletedAt: now, purgeAt: now + this.ctx.policies.trashMs(), status: 'stopped', updatedAt: now })
			.where(eq(brokers.id, row.id))
			.run();
		this.ctx.audit.record({
			principal,
			action: 'broker.delete',
			resource: 'broker',
			resourceId: row.id,
			args: { name },
			result: 'ok',
		});
		this.ctx.projects.bump(principal.orgId);
		return this.toView(this.requireRow(principal, name, { includeDeleted: true }));
	}

	restore(principal: Principal, name: string): BrokerView {
		requirePermission(principal, 'broker:delete');
		const row = this.requireRow(principal, name, { includeDeleted: true });
		if (!row.deletedAt) return this.toView(row);
		if (row.purgeRequestedAt)
			throw new ConflictError(`Broker "${name}" is being purged and can no longer be restored.`);
		this.requireFeature();
		this.ctx.quota.assertCanAdmitMemory(principal.orgId, null, row.memoryMb);
		this.admit(row, row.memoryMb);
		this.ctx.volumes.assertVolumeReady(row.volumeId, row.storageMb);
		this.ctx.db
			.update(brokers)
			.set({ deletedAt: null, purgeAt: null, status: 'pending', message: null, updatedAt: this.ctx.now() })
			.where(eq(brokers.id, row.id))
			.run();
		this.ctx.audit.record({
			principal,
			action: 'broker.restore',
			resource: 'broker',
			resourceId: row.id,
			args: { name },
			result: 'ok',
		});
		this.ctx.projects.bump(principal.orgId);
		return this.toView(this.requireRow(principal, name));
	}

	/** Permanently delete a trashed broker now. The node deletes the data, then the row goes. */
	purgeNow(principal: Principal, name: string): void {
		requirePermission(principal, 'broker:delete');
		const row = this.requireRow(principal, name, { includeDeleted: true });
		if (!row.deletedAt) throw new ConflictError(`Broker "${name}" must be deleted before it can be purged.`);
		const now = this.ctx.now();
		this.ctx.db
			.update(brokers)
			.set({ purgeAt: now, purgeRequestedAt: now, updatedAt: now })
			.where(eq(brokers.id, row.id))
			.run();
		this.ctx.audit.record({
			principal,
			action: 'broker.purge',
			resource: 'broker',
			resourceId: row.id,
			args: { name },
			result: 'ok',
		});
		this.ctx.projects.bump(principal.orgId);
	}

	/** Maintenance sweep: hand expired trash to its node. Returns how many purges were requested. */
	requestExpiredPurges(): number {
		const now = this.ctx.now();
		const due = this.ctx.db
			.select({ id: brokers.id })
			.from(brokers)
			.where(
				and(
					isNotNull(brokers.deletedAt),
					isNotNull(brokers.purgeAt),
					lte(brokers.purgeAt, now),
					isNull(brokers.purgeRequestedAt),
				),
			)
			.all();
		if (due.length === 0) return 0;
		this.ctx.db
			.update(brokers)
			.set({ purgeRequestedAt: now })
			.where(inArray(brokers.id, due.map((row) => row.id)))
			.run();
		this.ctx.projects.bump();
		return due.length;
	}

	/**
	 * Reveal the connection URL and password (as D58). Interactive only: MCP and API-key principals
	 * never receive the secret; attached apps get it at activation instead. Every read is audited.
	 */
	credentials(principal: Principal, name: string): BrokerCredentials {
		requirePermission(principal, 'broker:credentials');
		if (principal.kind !== 'user')
			throw new CoreError('forbidden', 'Credential reveal needs an interactive user session.', 403);
		const row = this.requireRow(principal, name);
		const info = brokerEngineRegistry[row.engine];
		const user = brokerIdentifier(row.name);
		const pass = this.ctx.secrets.open(row.orgId, row.ownerSecret);
		const node = this.ctx.db.select({ name: nodes.name }).from(nodes).where(eq(nodes.id, row.nodeId)).get();
		const url = brokerConnectionUrl({ scheme: info.scheme, user, pass, host: '127.0.0.1', port: row.hostPort });
		this.ctx.audit.record({
			principal,
			action: 'broker.credentials',
			resource: 'broker',
			resourceId: row.id,
			args: { name },
			result: 'ok',
		});
		return {
			brokerId: row.id,
			name: row.name,
			username: user,
			password: pass,
			url,
			host: '127.0.0.1',
			port: row.hostPort,
			connectionSnippets: brokerConnectionSnippets(row.engine, url),
			note: `Connections are unencrypted; ${info.label} is reachable only on loopback and the private container network of node "${node?.name ?? row.nodeId}". From elsewhere, tunnel: ssh -L ${row.hostPort}:127.0.0.1:${row.hostPort} <node>.`,
		};
	}

	/** Restart the broker container by bumping the restart generation (folded into its activation). */
	restart(principal: Principal, name: string): BrokerView {
		requirePermission(principal, 'broker:update');
		const row = this.requireRow(principal, name);
		const now = this.ctx.now();
		this.ctx.db
			.update(brokers)
			.set({ restartGeneration: row.restartGeneration + 1, message: 'Restart requested.', updatedAt: now })
			.where(eq(brokers.id, row.id))
			.run();
		this.ctx.logs.appendServiceSystem({
			kind: 'broker',
			serviceId: row.id,
			orgId: row.orgId,
			nodeId: row.nodeId,
			message: 'Restart requested; the broker container will restart.',
		});
		this.ctx.audit.record({
			principal,
			action: 'broker.restart',
			resource: 'broker',
			resourceId: row.id,
			args: { name },
			result: 'ok',
		});
		this.ctx.projects.bump(principal.orgId);
		return this.toView(this.requireRow(principal, name));
	}

	// ---------------------------------------------------------------- attachments

	attachments(principal: Principal, project: ProjectRow): BrokerAttachmentView[] {
		requirePermission(principal, 'broker:read');
		return this.attachmentsForProject(project.id);
	}

	attach(
		principal: Principal,
		project: ProjectRow,
		raw: BrokerAttach,
	): { attachment: BrokerAttachmentView; warning: string | null } {
		requirePermission(principal, 'broker:update');
		requirePermission(principal, 'project:update');
		const input = brokerAttachSchema.parse(raw);
		this.assertConsumer(project);
		const row = this.requireRow(principal, input.broker);
		const envPrefix = input.envPrefix ?? brokerEngineRegistry[row.engine].defaultEnvPrefix;
		const current = this.attachmentsForProject(project.id);
		if (current.some((item) => item.brokerId === row.id))
			throw new ConflictError(`Broker "${row.name}" is already attached to "${project.slug}".`);
		if (current.some((item) => item.envPrefix === envPrefix))
			throw new ConflictError(
				`"${project.slug}" already uses the env prefix ${envPrefix}. Pick another, e.g. ${envPrefix}_2.`,
			);
		// One node for everything an app is attached to (D56): brokers, databases and private storage.
		const pinned = (() => {
			try {
				return this.ctx.workloads.attachmentNode(project.id);
			} catch {
				return null;
			}
		})();
		if (pinned && pinned !== row.nodeId)
			throw new ValidationError(
				`"${project.slug}" is already attached to services on another node. Attached brokers, databases and private storage must share a node (D56).`,
			);
		const placementProblem = this.placementConflict(project, row.nodeId);
		if (placementProblem) throw new ValidationError(placementProblem);

		this.insertAttachment(principal, row.id, project, envPrefix);
		this.ctx.audit.record({
			principal,
			action: 'broker.attach',
			resource: 'broker',
			resourceId: row.id,
			args: { name: row.name, project: project.slug, envPrefix },
			result: 'ok',
		});
		this.ctx.projects.bump(principal.orgId);

		const workloadNode = this.ctx.db
			.select({ nodeId: workloads.nodeId })
			.from(workloads)
			.where(eq(workloads.projectId, project.id))
			.get()?.nodeId;
		const warning =
			workloadNode && workloadNode !== row.nodeId
				? `"${project.slug}" currently runs on another node. Redeploy it to move it next to "${row.name}"; until then it gets no ${envPrefix}_URL.`
				: workloadNode
					? null
					: `"${project.slug}" has no running workload yet. Its next deploy is placed next to "${row.name}".`;
		const attachment = this.attachmentsForProject(project.id).find((item) => item.brokerId === row.id)!;
		return { attachment, warning };
	}

	detach(principal: Principal, project: ProjectRow, name: string): void {
		requirePermission(principal, 'broker:update');
		requirePermission(principal, 'project:update');
		const row = this.requireRow(principal, name, { includeDeleted: true });
		const result = this.ctx.sqlite.run('DELETE FROM broker_attachments WHERE broker_id = ? AND project_id = ?', [
			row.id,
			project.id,
		]);
		if (result.changes === 0) throw new NotFoundError(`Attachment of "${name}" to "${project.slug}"`);
		this.ctx.audit.record({
			principal,
			action: 'broker.detach',
			resource: 'broker',
			resourceId: row.id,
			args: { name, project: project.slug },
			result: 'ok',
		});
		this.ctx.projects.bump(principal.orgId);
	}

	/**
	 * The node every broker attached to this project lives on, or null with none. WorkloadService
	 * pins the project's placement to it at deploy time (D56). Brokers have no cross-node service
	 * endpoint yet, so this pin holds even when C2 endpoints let a process app float.
	 */
	requiredNode(projectId: string): string | null {
		const nodeIds = [...new Set(this.liveAttachmentRows(projectId).map(({ broker }) => broker.nodeId))];
		if (nodeIds.length > 1)
			throw new ValidationError('Attached brokers live on different nodes; detach one so they share a node.');
		return nodeIds[0] ?? null;
	}

	/** Problem message when a project's explicit placement can't reach a broker on `nodeId`. */
	placementConflict(project: ProjectRow, nodeId: string): string | null {
		if (project.placement === 'auto' || project.placement === nodeId) return null;
		if (project.placement === 'edge' && this.ctx.workloads.edgeNode() === nodeId) return null;
		const node = this.ctx.db.select({ name: nodes.name }).from(nodes).where(eq(nodes.id, nodeId)).get();
		return `"${project.slug}" is placed on "${project.placement}" but the broker runs on "${node?.name ?? nodeId}". Set the project's placement to "auto" or that node; brokers are reachable on their own node only (D56).`;
	}

	/**
	 * Env vars one consumer workload receives, resolved for its node and runtime. A broker on
	 * another node is skipped (the next deploy moves the app next to it).
	 */
	consumerEnv(projectId: string, nodeId: string | null, runtime: WorkloadRuntime): Record<string, string> {
		const env: Record<string, string> = {};
		for (const item of this.resolveForConsumer(projectId, nodeId, runtime)) {
			const info = brokerEngineRegistry[item.row.engine];
			const user = brokerIdentifier(item.row.name);
			const pass = this.ctx.secrets.open(item.row.orgId, item.row.ownerSecret);
			env[`${item.prefix}_URL`] = brokerConnectionUrl({ scheme: info.scheme, user, pass, host: item.host, port: item.port });
			env[`${item.prefix}_HOST`] = item.host;
			env[`${item.prefix}_PORT`] = String(item.port);
			env[`${item.prefix}_USER`] = user;
			env[`${item.prefix}_PASSWORD`] = pass;
		}
		return env;
	}

	/**
	 * Stable fingerprint of a consumer's broker attachments (no secret values), folded into its
	 * activation version so attach/detach re-activates the app. Empty when nothing applies, so
	 * projects without brokers keep their activation version on upgrade.
	 */
	consumerVersion(projectId: string, nodeId: string | null, runtime: WorkloadRuntime): string {
		const items = this.resolveForConsumer(projectId, nodeId, runtime).map((item) => ({
			id: item.row.id,
			prefix: item.prefix,
			host: item.host,
			port: item.port,
			secret: sha256Hex(item.row.ownerSecret),
		}));
		return items.length === 0 ? '' : sha256Hex(JSON.stringify({ brokers: items }));
	}

	// ---------------------------------------------------------------- node protocol

	/** Live brokers placed on a node, as container workloads with the broker profile. */
	desiredForNode(nodeId: string): WorkloadDesired[] {
		const isolated = featureEnabled(this.ctx.config, 'ORG_NETWORKS');
		return this.ctx.db
			.select()
			.from(brokers)
			.where(and(eq(brokers.nodeId, nodeId), isNull(brokers.deletedAt)))
			.all()
			.map((row) => ({
				id: row.id,
				projectId: row.id,
				projectSlug: row.name,
				deploymentId: row.id,
				...(isolated ? { orgId: row.orgId, networkName: orgNetworkName(row.orgId) } : {}),
				runtime: 'container' as const,
				// Desired, not observed: echoing a reported `stopped` back would make the agent remove it.
				status: 'running' as const,
				release: null,
				image: brokerImage(row.engine, row.version),
				upstream: `127.0.0.1:${row.hostPort}`,
				memoryMb: row.memoryMb,
				cpus: row.cpus,
				port: row.hostPort,
				healthPath: '/',
				socketActivation: false,
				activationVersion: brokerActivationVersion(row),
				env: {},
				secrets: [],
				dataSizeMb: null,
				...(row.volumeId ? { volumeId: row.volumeId } : {}),
				broker: { engine: row.engine, version: row.version, storageMb: row.storageMb },
			}));
	}

	/** Trashed brokers whose purge is due on this node (D59). */
	purgesForNode(nodeId: string): string[] {
		return this.ctx.db
			.select({ id: brokers.id })
			.from(brokers)
			.where(and(eq(brokers.nodeId, nodeId), isNotNull(brokers.deletedAt), isNotNull(brokers.purgeRequestedAt)))
			.all()
			.map((row) => row.id);
	}

	isBrokerId(id: string): boolean {
		return id.startsWith(BROKER_ID_PREFIX);
	}

	/** The broker's user and password, for the helper-written server config. Node-authenticated only. */
	activation(nodeId: string, id: string): WorkloadActivation {
		const row = this.rowById(id);
		if (!row || row.deletedAt) throw new NotFoundError('Broker');
		if (row.nodeId !== nodeId) throw new CoreError('forbidden', 'This broker is placed on another node.', 403);
		return {
			workloadId: row.id,
			activationVersion: brokerActivationVersion(row),
			env: {
				SKIFF_BROKER_USER: brokerIdentifier(row.name),
				SKIFF_BROKER_PASSWORD: this.ctx.secrets.open(row.orgId, row.ownerSecret),
			},
			files: {},
		};
	}

	applyHeartbeat(nodeId: string, reports: Array<{ id: string; status: WorkloadStatus; restarts: number }>): void {
		for (const report of reports) {
			if (!this.isBrokerId(report.id)) continue;
			const row = this.rowById(report.id);
			if (!row || row.nodeId !== nodeId || row.deletedAt) continue;
			const status: BrokerStatus = report.status === 'running' && report.restarts >= 5 ? 'failed' : report.status;
			if (status === row.status) {
				if (status === 'running' && row.message === 'Restart requested.')
					this.ctx.db
						.update(brokers)
						.set({ message: null, updatedAt: this.ctx.now() })
						.where(eq(brokers.id, row.id))
						.run();
				continue;
			}
			this.ctx.db
				.update(brokers)
				.set({
					status,
					message: report.restarts >= 5 ? `Restart loop (${report.restarts} restarts)` : null,
					updatedAt: this.ctx.now(),
				})
				.where(eq(brokers.id, row.id))
				.run();
		}
	}

	/** The node deleted these data dirs; drop the rows (D59). */
	applyPurged(nodeId: string, ids: string[]): void {
		let changed = false;
		for (const id of ids) {
			const row = this.rowById(id);
			if (!row || row.nodeId !== nodeId || !row.deletedAt || !row.purgeRequestedAt) continue;
			this.ctx.sqlite.transaction(() => {
				this.ctx.db.delete(brokerAttachments).where(eq(brokerAttachments.brokerId, id)).run();
				this.ctx.db.delete(brokerLogEvents).where(eq(brokerLogEvents.brokerId, id)).run();
				this.ctx.db.delete(brokers).where(eq(brokers.id, id)).run();
			})();
			this.ctx.audit.record({
				orgId: row.orgId,
				action: 'broker.purged',
				resource: 'broker',
				resourceId: id,
				args: { name: row.name, nodeId },
				result: 'ok',
			});
			changed = true;
		}
		if (changed) this.ctx.projects.bump();
	}

	/** Memory reserved by live brokers per node (D42 admission). */
	reservedByNode(): Map<string, number> {
		const rows = this.ctx.sqlite
			.query<{ nodeId: string; total: number | null }, [string, string, string]>(
				`SELECT node_id AS nodeId, SUM(memory_mb) AS total FROM brokers
				 WHERE deleted_at IS NULL AND status IN (?, ?, ?) GROUP BY node_id`,
			)
			.all(...(ACTIVE as [string, string, string]));
		return new Map(rows.map((row) => [row.nodeId, row.total ?? 0]));
	}

	countByNode(): Map<string, number> {
		const rows = this.ctx.sqlite
			.query<{ nodeId: string; n: number }, []>(
				'SELECT node_id AS nodeId, COUNT(*) AS n FROM brokers WHERE deleted_at IS NULL GROUP BY node_id',
			)
			.all();
		return new Map(rows.map((row) => [row.nodeId, row.n]));
	}

	/** Memory reserved by an org's live brokers (quota accounting). */
	reservedMemoryForOrg(orgId: string, projectId?: string | null): number {
		const ids = projectId
			? this.ctx.db
					.select({ id: brokerAttachments.brokerId })
					.from(brokerAttachments)
					.where(eq(brokerAttachments.projectId, projectId))
					.all()
					.map((row) => row.id)
			: null;
		if (ids && ids.length === 0) return 0;
		const filters = [eq(brokers.orgId, orgId), isNull(brokers.deletedAt)];
		if (ids) filters.push(inArray(brokers.id, ids));
		return this.ctx.db
			.select({ memoryMb: brokers.memoryMb })
			.from(brokers)
			.where(and(...filters))
			.all()
			.reduce((total, row) => total + row.memoryMb, 0);
	}

	/** Free host port on a node. Trashed brokers keep theirs, so a restore gets it back. */
	allocatePort(nodeId: string): number {
		const used = new Set(
			this.ctx.db
				.select({ port: brokers.hostPort })
				.from(brokers)
				.where(eq(brokers.nodeId, nodeId))
				.all()
				.map((row) => row.port),
		);
		for (let port = BROKER_PORT_MIN; port <= BROKER_PORT_MAX; port++) if (!used.has(port)) return port;
		throw new ValidationError('This node has no free broker ports left.');
	}

	// ---------------------------------------------------------------- logs

	/** Store a drained runtime-log batch from the node that owns this broker. */
	appendRuntimeLogs(
		nodeId: string,
		brokerId: string,
		rows: Array<{ stream: 'stdout' | 'stderr' | 'system'; level: 'debug' | 'info' | 'warn' | 'error'; message: string; ts: number }>,
	): number {
		const row = this.rowById(brokerId);
		if (!row) return 0;
		if (row.nodeId !== nodeId) throw new CoreError('forbidden', 'This service is placed on another node.', 403);
		if (rows.length === 0) return 0;
		this.ctx.db
			.insert(brokerLogEvents)
			.values(rows.map((line) => ({ orgId: row.orgId, brokerId: row.id, nodeId, source: 'runtime' as const, ...line })))
			.run();
		return rows.length;
	}

	// ---------------------------------------------------------------- internals

	private requireFeature(): void {
		if (!featureEnabled(this.ctx.config, 'BROKERS'))
			throw new ValidationError('Queue brokers are not enabled on this platform (SKIFF_FEATURE_BROKERS).');
	}

	private assertConsumer(project: ProjectRow): void {
		// Functions use a broker for their queues (D112); only static sites have nothing to connect.
		if (project.runtime === 'static' && !isFunctionTier(project))
			throw new ValidationError(
				`Project "${project.slug}" is static; only process, container and function projects can use a broker.`,
			);
	}

	/**
	 * Resolve placement among nodes whose agent can run a broker. An older agent would hand the
	 * helper a plain container without the broker profile, so it is never a candidate.
	 */
	private place(requested: string, memoryMb: number): string {
		const all = this.ctx.workloads.placementCandidates();
		const capable = new Set(
			this.ctx.db
				.select({ id: nodes.id, capabilitiesJson: nodes.capabilitiesJson })
				.from(nodes)
				.all()
				.filter((node) => parseJson<string[]>(node.capabilitiesJson, []).includes(BROKER_CAPABILITY))
				.map((node) => node.id),
		);
		const candidates = all.filter((node) => capable.has(node.id));
		const edgeNodeId = this.ctx.workloads.edgeNode();
		const target = requested === 'edge' ? edgeNodeId : requested === 'auto' ? null : requested;
		if (target && all.some((node) => node.id === target) && !capable.has(target)) {
			const name = all.find((node) => node.id === target)?.name ?? target;
			throw new ValidationError(`Node "${name}" does not support queue brokers yet; update its agent first.`);
		}
		if (candidates.length === 0)
			throw new ValidationError('No node supports queue brokers yet; update the node agents first.');
		const decision = resolvePlacement({ runtime: 'container', requested, memoryMb, edgeNodeId, candidates });
		if (!decision.ok)
			throw new ValidationError(decision.message.replace('this app reserves', 'this broker reserves'), decision.freeByNode);
		return decision.nodeId;
	}

	/** Admission for a broker growing to (or coming back with) `memoryMb` on its node. */
	private admit(row: BrokerRow, memoryMb: number): void {
		const capacity = this.ctx.workloads.capacityInternal().find((item) => item.nodeId === row.nodeId);
		if (!capacity) throw new ValidationError('The broker node is no longer registered.');
		const counted = !row.deletedAt && ACTIVE.includes(row.status) ? row.memoryMb : 0;
		const free = capacity.freeMemoryMb + counted;
		if (free < memoryMb)
			throw new ValidationError(
				`Node "${capacity.name}" only has ${free} MB of workload budget free, but this broker needs ${memoryMb} MB.`,
			);
	}

	private rowById(id: string): BrokerRow | undefined {
		return this.ctx.db.select().from(brokers).where(eq(brokers.id, id)).get();
	}

	private insertAttachment(principal: Principal, brokerId: string, project: ProjectRow, envPrefix: string): void {
		this.ctx.db
			.insert(brokerAttachments)
			.values({
				id: newId('mqa_'),
				orgId: project.orgId,
				brokerId,
				projectId: project.id,
				envPrefix,
				createdBy: principal.userId,
				createdAt: this.ctx.now(),
			})
			.run();
	}

	private attachmentsOf(brokerId: string): BrokerAttachmentView[] {
		return this.attachmentViews(eq(brokerAttachments.brokerId, brokerId));
	}

	private attachmentsForProject(projectId: string): BrokerAttachmentView[] {
		return this.attachmentViews(eq(brokerAttachments.projectId, projectId));
	}

	private attachmentViews(filter: ReturnType<typeof eq>): BrokerAttachmentView[] {
		return this.ctx.db
			.select({ attachment: brokerAttachments, broker: brokers, project: projects })
			.from(brokerAttachments)
			.innerJoin(brokers, eq(brokers.id, brokerAttachments.brokerId))
			.innerJoin(projects, eq(projects.id, brokerAttachments.projectId))
			.where(and(filter, isNull(projects.deletedAt)))
			.all()
			.map(({ attachment, broker, project }) => ({
				brokerId: broker.id,
				brokerName: broker.name,
				projectId: project.id,
				projectSlug: project.slug,
				envPrefix: attachment.envPrefix,
				envNames: brokerEnvNames(attachment.envPrefix),
				createdAt: new Date(attachment.createdAt).toISOString(),
			}))
			.sort((a, b) => a.projectSlug.localeCompare(b.projectSlug) || a.brokerName.localeCompare(b.brokerName));
	}

	private liveAttachmentRows(projectId: string): Array<{ broker: BrokerRow; prefix: string }> {
		return this.ctx.db
			.select({ attachment: brokerAttachments, broker: brokers })
			.from(brokerAttachments)
			.innerJoin(brokers, eq(brokers.id, brokerAttachments.brokerId))
			.where(and(eq(brokerAttachments.projectId, projectId), isNull(brokers.deletedAt)))
			.all()
			.map(({ attachment, broker }) => ({ broker, prefix: attachment.envPrefix }))
			.sort((a, b) => a.prefix.localeCompare(b.prefix));
	}

	private resolveForConsumer(
		projectId: string,
		nodeId: string | null,
		runtime: WorkloadRuntime,
	): Array<{ row: BrokerRow; prefix: string; host: string; port: number }> {
		if (!nodeId) return [];
		const container = runtime === 'container';
		return this.liveAttachmentRows(projectId)
			.filter(({ broker }) => broker.nodeId === nodeId)
			.map(({ broker, prefix }) => ({
				row: broker,
				prefix,
				host: container ? brokerAlias(broker.id) : '127.0.0.1',
				port: container ? brokerEngineRegistry[broker.engine].containerPort : broker.hostPort,
			}));
	}

	private toView(row: BrokerRow): BrokerView {
		const info = brokerEngineRegistry[row.engine];
		const node = this.ctx.db.select({ name: nodes.name }).from(nodes).where(eq(nodes.id, row.nodeId)).get();
		return {
			id: row.id,
			name: row.name,
			engine: row.engine,
			engineLabel: info.label,
			protocol: info.protocol,
			capabilities: info.capabilities,
			version: row.version,
			upgradeVersions: brokerUpgradeVersions(row.engine, row.version),
			status: row.status,
			message: row.message,
			nodeId: row.nodeId,
			nodeName: node?.name ?? null,
			memoryMb: row.memoryMb,
			cpus: row.cpus,
			storageMb: row.storageMb,
			username: brokerIdentifier(row.name),
			internalHost: {
				process: `127.0.0.1:${row.hostPort}`,
				container: `${brokerAlias(row.id)}:${info.containerPort}`,
			},
			volume: this.ctx.volumes.summary(row.volumeId),
			attachments: this.attachmentsOf(row.id),
			storeBytes: row.storeBytes ?? null,
			messages: row.messages ?? null,
			statsAt: row.statsAt ? new Date(row.statsAt).toISOString() : null,
			createdAt: new Date(row.createdAt).toISOString(),
			updatedAt: new Date(row.updatedAt).toISOString(),
			deletedAt: row.deletedAt ? new Date(row.deletedAt).toISOString() : null,
			purgeAt: row.purgeAt ? new Date(row.purgeAt).toISOString() : null,
		};
	}
}

/** The stored listing, re-validated on read so a bad row can never break the page. */
function storedStreams(json: string | null): BrokerStreamStats[] {
	if (!json) return [];
	const raw = parseJson<unknown>(json, []);
	if (!Array.isArray(raw)) return [];
	const out: BrokerStreamStats[] = [];
	for (const item of raw) {
		const parsed = brokerStreamStatsSchema.safeParse(item);
		if (parsed.success) out.push(parsed.data);
	}
	return out;
}

function password(): string {
	// base64url only: the helper validates it before writing the server config.
	return Buffer.from(randomBytes(24)).toString('base64url');
}

function brokerActivationVersion(row: BrokerRow): string {
	return sha256Hex(
		JSON.stringify({
			id: row.id,
			// Bump when the helper's fixed broker profile changes and units must be re-rendered.
			profile: 1,
			engine: row.engine,
			version: row.version,
			port: row.hostPort,
			memoryMb: row.memoryMb,
			storageMb: row.storageMb,
			restartGeneration: row.restartGeneration,
			secret: sha256Hex(row.ownerSecret),
		}),
	);
}
