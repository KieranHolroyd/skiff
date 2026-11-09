/**
 * Typed control-plane client for the CLI.
 *
 * Every control-plane request sends `Authorization: Bearer <api-key>` and an
 * `Origin` header. The control plane's CSRF policy (DESIGN §6.3.1) requires an
 * origin for mutations; bearer requests are exempt from cookies but still pass
 * the same check. Presigned object-store PUTs are sent with the returned headers
 * only (they are authenticated by the signature in the URL).
 */
import { platformOrigin } from './config.ts';
import { ApiError, CliError } from './errors.ts';
import type {
	DatabaseFailoverView,
	DatabaseReplicaView,
	DatabaseAttachmentView,
	DatabaseBackupAllResult,
	DatabaseBackupView,
	DatabaseCreateInput,
	DatabaseUpdateInput,
	DatabaseCredentials,
	DatabaseCredentialView,
	DatabaseNamedCredentialRole,
	DatabasePitrTaskView,
	DatabasePitrView,
	DatabaseRotationView,
	DatabaseUpgradePlan,
	DatabaseView,
	ServiceRestartResult,
} from './databases.ts';
import type {
	BucketConfigInput,
	StorageAttachmentView,
	StorageBucketView,
	StorageObjectDeleteResult,
	StorageObjectList,
	StorageObjectStat,
	StorageCreateInput,
	StorageCredentials,
	StorageGrant,
	StorageKeyCreateInput,
	StorageKeyReveal,
	StorageKeyView,
	StorageMetricPoint,
	StorageMoveResult,
	StorageShareLink,
	StorageUpdateInput,
	StorageView,
} from './object-storage.ts';
import type {
	BrokerAttachmentView,
	BrokerCreateInput,
	BrokerCredentials,
	BrokerMetricPoint,
	BrokerQueuesView,
	BrokerUpdateInput,
	BrokerView,
} from './brokers.ts';
import type { EventDeliveryView, EventRuleCreateInput, EventRuleUpdateInput, EventRuleView } from './events.ts';
import type { AuditEntryView, LogDrainCreateInput, LogDrainTestResult, LogDrainUpdateInput, LogDrainView } from './log-drains.ts';
import type { BlueprintPlanView, BlueprintRunView, BlueprintValidation } from './blueprints.ts';
import type { ConfigExportDocument } from './config-export.ts';
import type { OperationItemView, OperationView } from './operations.ts';
import type { HaStatusView } from './ha.ts';
import type { AppVolumeSnapshotView, AppVolumeView } from './volumes.ts';
import type { JobLogPage, JobRunView, JobView } from './jobs.ts';
import {
	NODE_TASK_LIMITS,
	nodeTaskDone,
	type BrokerQueueCreateResult,
	type BrokerQueueRedriveResult,
	type BrokerQueueSendInput,
	type BrokerQueueSendResult,
	type BrokerStreamDeleteMessageResult,
	type BrokerStreamDeleteResult,
	type BrokerStreamPeekResult,
	type BrokerStreamPurgeResult,
	type FunctionInvokeInput,
	type FunctionInvokeResult,
	type FunctionScheduledResult,
	type NodeTaskView,
} from './node-tasks.ts';
import {
	listFrom,
	viewFrom,
	type EmailAccessRequestInput,
	type EmailAccessRequestView,
	type EmailCredentialCreateInput,
	type EmailCredentialSecret,
	type EmailCredentialView,
	type EmailDomainCreateInput,
	type EmailDomainView,
	type EmailMessageEvent,
	type EmailMessageView,
	type EmailOrgView,
	type EmailSendInput,
	type EmailSendResult,
	type EmailSandboxAddressView,
	type EmailSettingsView,
	type EmailSuppressionView,
} from './email.ts';

export interface ApiClientOptions {
	baseUrl: string;
	token: string;
	origin?: string;
	timeoutMs?: number;
	uploadTimeoutMs?: number;
	fetch?: typeof fetch;
	userAgent?: string;
	/** How long node-task calls (D124) poll for a result before giving up; default 2 minutes. */
	nodeTaskWaitMs?: number;
}

export interface UserView {
	id?: string;
	email?: string;
	name?: string;
}

export interface OrgView {
	id?: string;
	slug?: string;
	name?: string;
	role?: string;
}

export interface UsageMetricView {
	used: number;
	limit: number;
	unit: 'count' | 'bytes' | 'megabytes';
	percent: number | null;
}

export interface UsageView {
	orgId: string;
	projectId: string | null;
	projectSlug: string | null;
	at: string;
	periodDays: number;
	metrics: Record<string, UsageMetricView>;
	warnings: Array<{ metric: string; used: number; limit: number; percent: number }>;
}

export interface ProjectView {
	id?: string;
	slug: string;
	name?: string;
	runtime?: string;
	placement?: string;
	productionDeploymentId?: string | null;
	productionUrl?: string;
	previewPattern?: string;
	productionAccess?: string;
	previewAccess?: string;
	createdAt?: string;
	updatedAt?: string;
	deletedAt?: string | null;
	/** Trash only: when the maintenance sweep purges it for good. */
	purgeAt?: string | null;
}

export interface OperationCreateInput {
	action: 'project.delete' | 'project.restore' | 'project.purge' | 'prune';
	targets?: string[];
	scope?: 'org' | 'platform';
	categories?: string[];
	stage: 'plan' | 'apply';
}

export interface OperationItemsPage {
	operation: OperationView;
	items: OperationItemView[];
	cursor: number;
	hasMore: boolean;
}

export interface OperationItemsFilter {
	after?: number;
	limit?: number;
	status?: string;
	verdict?: string;
	category?: string;
}

export interface BackupTargetView {
	id: string;
	orgId: string | null;
	name: string;
	kind: 'local' | 's3';
	path: string | null;
	endpoint: string | null;
	bucket: string | null;
	region: string | null;
	pathPrefix: string;
	forcePathStyle: boolean;
	writeOnly: boolean;
	objectLock: boolean;
	hasCredentials: boolean;
	status: 'pending' | 'ok' | 'failed';
	lastCheckedAt: string | null;
	lastError: string | null;
	createdAt: string;
	updatedAt: string;
}

export type BackupTargetCreateInput =
	| { name: string; kind: 'local'; path: string; writeOnly?: boolean }
	| {
			name: string;
			kind: 's3';
			endpoint?: string;
			bucket: string;
			region?: string;
			pathPrefix?: string;
			forcePathStyle?: boolean;
			accessKeyId: string;
			secretAccessKey: string;
			writeOnly?: boolean;
			objectLock?: boolean;
	  };

export interface BackupTargetCredentials {
	targetId: string;
	name: string;
	kind: 'local' | 's3';
	accessKeyId: string;
	secretAccessKey: string;
	endpoint: string | null;
	bucket: string | null;
	region: string | null;
	note: string;
}

export interface BackupTargetTestResult {
	ok: boolean;
	checkedAt: string;
	message: string;
	latencyMs: number | null;
	versioning: boolean | null;
	objectLock: boolean | null;
}

export interface RegistryCredentialView {
	id: string;
	name: string;
	registry: string;
	username: string;
	createdAt: number;
	updatedAt: number;
	lastUsedAt: number | null;
}

export interface RegistryView {
	enabled: boolean;
	host: string;
	node: { id: string; name: string } | null;
	status: string;
	engine: string;
	version: string;
	keepTags: number;
}

export interface RegistryRepositoryView {
	name: string;
	projectSlug: string | null;
	pushes: number;
	lastTag: string | null;
	lastDigest: string | null;
	lastPushAt: number | null;
	createdAt: number;
	deploy?: { project: string | null; tag: string } | null;
}

/** The fields of a workload an image deploy reports back. */
export interface ImageWorkloadView {
	image: string | null;
	imageDigest: string | null;
	status?: string;
}

export interface DeploymentView {
	id?: string;
	shortId?: string;
	status?: string;
	message?: string;
	url?: string;
	previewUrl?: string;
	previewHost?: string;
	productionUrl?: string;
	projectSlug?: string;
	pinned?: boolean;
	production?: boolean;
	createdAt?: string;
	activatedAt?: string;
}

export interface NodeView {
	id?: string;
	name?: string;
	status?: string;
	version?: string;
	lastHeartbeat?: string;
	cpuPercent?: number;
	memoryUsedBytes?: number;
	memoryTotalBytes?: number;
	diskUsedPercent?: number;
}

export interface StatusView {
	platform?: { version?: string; origin?: string; uptimeSeconds?: number };
	versions?: { controlPlane?: string; agent?: string };
	nodes: NodeView[];
	counts: {
		projects?: number;
		deployments?: number;
		activeDeployments?: number;
		offlineNodes?: number;
		storageBytes?: number;
		nodes?: number;
		onlineNodes?: number;
	};
	health: string;
}

export interface UploadTicket {
	uploadId: string;
	url: string;
	method: string;
	headers: Record<string, string>;
	expiresAt?: string;
}

export interface ProjectCreateInput {
	slug: string;
	name?: string;
	/** `function` for a wrangler project (docs/FUNCTIONS.md); the server defaults to `static`. */
	runtime?: 'static' | 'process' | 'container' | 'function';
	productionAccess?: 'public' | 'password' | 'platform';
	previewAccess?: 'public' | 'password' | 'platform';
}

/** Secret metadata only; values never leave the control plane. */
export interface SecretView {
	id?: string;
	name: string;
	type?: 'secret' | 'env';
	version?: number;
	projectId?: string | null;
	createdAt?: string;
}

export interface FinalizeOutcome {
	deployment?: DeploymentView;
	project?: ProjectView;
	nextSteps: string[];
	promoted: boolean;
	deploymentUrl?: string;
	previewUrl?: string;
	productionUrl?: string;
	raw: unknown;
}

export interface LogLine {
	timestamp?: string;
	level?: string;
	message: string;
}

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_UPLOAD_TIMEOUT = 15 * 60_000;

export class ApiClient {
	readonly baseUrl: string;
	readonly origin: string;
	private readonly token: string;
	private readonly timeoutMs: number;
	private readonly uploadTimeoutMs: number;
	private readonly fetchImpl: typeof fetch;
	private readonly userAgent: string;
	private readonly nodeTaskWaitMs: number;

	constructor(options: ApiClientOptions) {
		this.baseUrl = options.baseUrl.replace(/\/+$/, '');
		this.token = options.token;
		this.origin = options.origin ?? platformOrigin(options.baseUrl);
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT;
		this.uploadTimeoutMs = options.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT;
		this.fetchImpl = options.fetch ?? globalThis.fetch;
		this.userAgent = options.userAgent ?? 'skif-cli';
		this.nodeTaskWaitMs = options.nodeTaskWaitMs ?? NODE_TASK_LIMITS.cliWaitMs;
	}

	async whoami(): Promise<{
		user: UserView;
		org: OrgView | null;
		permissions: string[];
		platform: string;
		contentDomain?: string;
		raw: unknown;
	}> {
		const raw = await this.request('GET', '/api/v1/whoami');
		const record = asRecord(unwrap(raw)) ?? {};
		const userRecord = asRecord(record.user) ?? record;
		const orgRecord =
			asRecord(record.org) ??
			asRecord(record.organization) ??
			(Array.isArray(record.organizations) ? asRecord(record.organizations[0]) : undefined) ??
			(userRecord.orgId || userRecord.org_id
				? { id: userRecord.orgId ?? userRecord.org_id, role: userRecord.role }
				: undefined) ??
			null;
		const user: UserView = {
			id: stringValue(userRecord.id ?? userRecord.userId ?? userRecord.user_id),
			email: stringValue(userRecord.email),
			name: stringValue(userRecord.name ?? userRecord.displayName),
		};
		if (!user.id && !user.email && !user.name)
			throw new CliError('The platform returned an unexpected whoami response.', { code: 'protocol' });
		const org: OrgView | null = orgRecord
			? {
					id: stringValue(orgRecord.id),
					slug: stringValue(orgRecord.slug),
					name: stringValue(orgRecord.name),
					role: stringValue(orgRecord.role ?? userRecord.role ?? record.role),
				}
			: null;
		const permissions = stringArray(record.permissions ?? userRecord.permissions);
		const platform = stringValue(record.platform) ?? this.origin;
		const contentDomain = stringValue(record.contentDomain ?? record.content_domain);
		return { user, org, permissions, platform, contentDomain, raw };
	}

	async getStatus(): Promise<{ status: StatusView; raw: unknown }> {
		const raw = await this.request('GET', '/api/v1/status');
		const record = asRecord(unwrap(raw)) ?? {};
		const nodeRecords = asArray(record.nodes);
		const nodes = (nodeRecords ?? []).map((node) => normalizeNode(node)).filter(isPresent);
		const countsRecord = asRecord(record.counts) ?? {};
		const nodeCounts = asRecord(record.nodes) ?? {};
		const deploymentCounts = asRecord(record.deployments) ?? {};
		const versionRecord = asRecord(record.versions);
		const counts = {
			projects: numberValue(countsRecord.projects ?? record.projects),
			deployments: numberValue(
				deploymentCounts.total ?? countsRecord.deployments ?? (nodeRecords ? undefined : record.deployments),
			),
			activeDeployments: numberValue(
				deploymentCounts.active ?? countsRecord.activeDeployments ?? countsRecord.active,
			),
			offlineNodes: numberValue(nodeCounts.offline ?? countsRecord.offlineNodes),
			storageBytes: numberValue(record.storageBytes ?? record.storage_bytes ?? countsRecord.storageBytes),
			nodes: numberValue(nodeCounts.total ?? countsRecord.nodes ?? record.nodeCount) ?? nodes.length,
			onlineNodes:
				numberValue(nodeCounts.online ?? countsRecord.onlineNodes ?? countsRecord.online ?? record.onlineNodes) ??
				nodes.filter((node) => node.status === 'online').length,
		};
		const platformRecord = asRecord(record.platform);
		const version = stringValue(versionRecord?.controlPlane ?? record.version);
		const origin = stringValue(record.platform ?? platformRecord?.origin ?? platformRecord?.url);
		const status: StatusView = {
			platform:
				platformRecord || version || origin
					? {
							version: stringValue(platformRecord?.version) ?? version,
							origin: stringValue(platformRecord?.origin ?? platformRecord?.url) ?? origin,
							uptimeSeconds: numberValue(
								platformRecord?.uptimeSeconds ?? platformRecord?.uptime_seconds,
							),
						}
					: undefined,
			versions: versionRecord
				? {
						controlPlane: stringValue(versionRecord.controlPlane),
						agent: stringValue(versionRecord.agent),
					}
				: undefined,
			nodes,
			counts,
			health:
				stringValue(record.health ?? record.status) ??
				(counts.onlineNodes >= counts.nodes ? 'ok' : 'degraded'),
		};
		return { status, raw };
	}

	async getUsage(project?: string): Promise<{ usage: UsageView; raw: unknown }> {
		const raw = await this.request(
			'GET',
			`/api/v1/usage${project ? `?project=${encodeURIComponent(project)}` : ''}`,
		);
		return { usage: raw as UsageView, raw };
	}

	/** The failover controller (platform admin): lease, lost nodes, ingress rotation, recent events. */
	async getHaStatus(): Promise<{ status: HaStatusView; raw: unknown }> {
		const raw = await this.request('GET', '/api/v1/ha/status');
		return { status: raw as HaStatusView, raw };
	}

	async getQuotas(project?: string): Promise<{ quotas: unknown; raw: unknown }> {
		const raw = await this.request(
			'GET',
			`/api/v1/quotas${project ? `?project=${encodeURIComponent(project)}` : ''}`,
		);
		return { quotas: raw, raw };
	}

	async listProjects(options: { trash?: boolean } = {}): Promise<{ projects: ProjectView[]; raw: unknown }> {
		const raw = await this.request('GET', `/api/v1/projects${options.trash ? '?trash=1' : ''}`);
		const unwrapped = unwrap(raw);
		const record = asRecord(unwrapped);
		const values = Array.isArray(unwrapped) ? unwrapped : asArray(record?.projects ?? record?.items);
		const projects = (values ?? []).map((value) => normalizeProject(value)).filter(isPresent);
		return { projects, raw };
	}

	async getProject(slug: string): Promise<{ project: ProjectView; raw: unknown }> {
		const raw = await this.request('GET', `/api/v1/projects/${encodeURIComponent(slug)}`);
		const record = asRecord(unwrap(raw)) ?? {};
		const project = normalizeProject(record.project ?? record, slug);
		if (!project) throw new CliError('The platform returned an unexpected project response.', { code: 'protocol' });
		return { project, raw };
	}

	async createProject(input: ProjectCreateInput): Promise<{ project: ProjectView; raw: unknown }> {
		const body: Record<string, unknown> = {
			slug: input.slug,
			productionAccess: input.productionAccess ?? 'public',
			previewAccess: input.previewAccess ?? 'platform',
		};
		if (input.name) body.name = input.name;
		if (input.runtime) body.runtime = input.runtime;
		const raw = await this.request('POST', '/api/v1/projects', { body });
		const record = asRecord(unwrap(raw)) ?? {};
		const project = normalizeProject(record.project ?? record, input.slug);
		if (!project) throw new CliError('The platform returned an unexpected project response.', { code: 'protocol' });
		return { project, raw };
	}

	/**
	 * Metadata for every secret visible to the caller. Values are never returned. Used to
	 * auto-bind a function project's own secrets; organisation-scoped entries are filtered out
	 * by the caller so an org secret is never exposed to one project.
	 */
	async listSecrets(): Promise<{ secrets: SecretView[]; raw: unknown }> {
		const raw = await this.request('GET', '/api/v1/secrets');
		const record = asRecord(unwrap(raw)) ?? {};
		const values = asArray(record.secrets ?? record.items) ?? [];
		const secrets: SecretView[] = [];
		for (const value of values) {
			const secret = asRecord(value);
			const name = stringValue(secret?.name);
			if (!secret || !name) continue;
			secrets.push({
				id: stringValue(secret.id),
				name,
				type: secret.type === 'env' ? 'env' : secret.type === 'secret' ? 'secret' : undefined,
				version: numberValue(secret.version),
				projectId:
					secret.projectId === null
						? null
						: (stringValue(secret.projectId ?? secret.project_id) ?? null),
				createdAt: stringValue(secret.createdAt ?? secret.created_at),
			});
		}
		return { secrets, raw };
	}

	async listDeployments(project: string): Promise<{ deployments: DeploymentView[]; raw: unknown }> {
		const raw = await this.request(
			'GET',
			`/api/v1/projects/${encodeURIComponent(project)}/deployments`,
		);
		const unwrapped = unwrap(raw);
		const record = asRecord(unwrapped);
		const values = Array.isArray(unwrapped) ? unwrapped : asArray(record?.deployments ?? record?.items);
		const deployments = (values ?? [])
			.map((value) => normalizeDeployment(value, { projectSlug: project }))
			.filter(isPresent)
			.sort((a, b) => timestamp(b.createdAt) - timestamp(a.createdAt));
		return { deployments, raw };
	}

	async createUpload(input: { project: string; fileCount: number; totalBytes: number }): Promise<UploadTicket> {
		const raw = await this.request('POST', '/api/v1/uploads', { body: input });
		const record = asRecord(unwrap(raw)) ?? {};
		const uploadId = stringValue(record.uploadId ?? record.upload_id ?? record.id);
		const url = stringValue(record.url ?? record.uploadUrl ?? record.upload_url);
		const method = stringValue(record.method ?? record.httpMethod) ?? 'PUT';
		if (!uploadId || !url)
			throw new CliError('The platform did not return an upload URL.', { code: 'protocol', details: raw });
		const headers: Record<string, string> = {};
		const headerRecord = asRecord(record.headers);
		if (headerRecord) {
			for (const [key, value] of Object.entries(headerRecord)) {
				if (typeof value === 'string') headers[key] = value;
				else if (typeof value === 'number' || typeof value === 'boolean') headers[key] = String(value);
			}
		}
		return {
			uploadId,
			url,
			method,
			headers,
			expiresAt: stringValue(record.expiresAt ?? record.expires_at),
		};
	}

	async putUpload(ticket: UploadTicket, bytes: Uint8Array): Promise<void> {
		let response: Response;
		try {
			response = await this.fetchImpl(ticket.url, {
				method: ticket.method,
				headers: ticket.headers,
				body: bytes as unknown as RequestInit['body'],
				signal: AbortSignal.timeout(this.uploadTimeoutMs),
			});
		} catch (error) {
			throw new CliError(
				`Upload failed: ${errorMessage(error)}`,
				{ code: 'upload_failed', cause: error, details: redactUrl(ticket.url) },
			);
		}
		if (response.ok) return;
		const suffix = (await response.text().catch(() => '')).slice(0, 500).trim();
		throw new ApiError(
			`Upload failed (${response.status})${suffix ? `: ${suffix}` : '.'}`,
			{
				status: response.status,
				method: ticket.method,
				url: redactUrl(ticket.url),
				code: 'upload_failed',
				body: suffix || undefined,
			},
		);
	}

	async finalizeUpload(
		uploadId: string,
		input: { project: string; promote: boolean; message?: string },
	): Promise<FinalizeOutcome> {
		// The path identifies the upload. `uploadId` is repeated in the body because the
		// shared `finalizeUploadSchema` requires it; unknown fields are stripped by servers
		// that only read the path.
		const body: Record<string, unknown> = {
			uploadId,
			project: input.project,
			promote: input.promote,
		};
		if (input.message) body.message = input.message;
		const raw = await this.request(
			'POST',
			`/api/v1/uploads/${encodeURIComponent(uploadId)}/finalize`,
			{ body },
		);
		return normalizeOutcome(raw, { projectSlug: input.project, requestedPromote: input.promote });
	}

	async promote(project: string, deploymentId: string): Promise<FinalizeOutcome> {
		const raw = await this.request(
			'POST',
			`/api/v1/projects/${encodeURIComponent(project)}/promote`,
			{ body: { project, deploymentId } },
		);
		return normalizeOutcome(raw, { projectSlug: project, requestedPromote: true });
	}

	async rollback(project: string): Promise<FinalizeOutcome> {
		const raw = await this.request(
			'POST',
			`/api/v1/projects/${encodeURIComponent(project)}/rollback`,
			{ body: {} },
		);
		return normalizeOutcome(raw, { projectSlug: project, requestedPromote: true });
	}

	async getLogs(project: string, options: { limit?: number } = {}): Promise<{ lines: LogLine[]; raw: unknown }> {
		const limit = options.limit ?? 200;
		const raw = await this.request(
			'GET',
			`/api/v1/projects/${encodeURIComponent(project)}/logs?limit=${encodeURIComponent(String(limit))}`,
		);
		if (typeof raw === 'string') {
			return {
				lines: raw
					.split(/\r?\n/)
					.filter((line) => line.length > 0)
					.map((message) => ({ message })),
				raw,
			};
		}
		const record = asRecord(unwrap(raw)) ?? {};
		const values = asArray(record.lines ?? record.logs ?? record.items) ?? [];
		const lines: LogLine[] = values.map((value) => {
			if (typeof value === 'string') return { message: value };
			const line = asRecord(value) ?? {};
			return {
				timestamp: stringValue(line.timestamp ?? line.ts ?? line.time),
				level: stringValue(line.level ?? line.severity),
				message: stringValue(line.message ?? line.msg ?? line.line) ?? JSON.stringify(value),
			};
		});
		return { lines, raw };
	}


	// --- operations (docs/OPERATIONS.md) ---------------------------------------------------

	/** `POST /operations`. `waitSeconds` (≤25) holds the response until planned or finished. */
	async createOperation(
		input: OperationCreateInput,
		options: { idempotencyKey?: string; waitSeconds?: number } = {},
	): Promise<OperationView> {
		const raw = await this.request('POST', `/api/v1/operations${waitQuery(options.waitSeconds)}`, {
			body: input,
			headers: options.idempotencyKey ? { 'idempotency-key': options.idempotencyKey } : undefined,
			timeoutMs: waitTimeout(this.timeoutMs, options.waitSeconds),
		});
		return operationFrom(raw);
	}

	async getOperation(id: string, options: { waitSeconds?: number } = {}): Promise<OperationView> {
		const raw = await this.request(
			'GET',
			`/api/v1/operations/${encodeURIComponent(id)}${waitQuery(options.waitSeconds)}`,
			{ timeoutMs: waitTimeout(this.timeoutMs, options.waitSeconds) },
		);
		return operationFrom(raw);
	}

	async getOperationItems(id: string, filter: OperationItemsFilter = {}): Promise<OperationItemsPage> {
		const params = new URLSearchParams({ items: '1' });
		for (const [key, value] of Object.entries(filter))
			if (value !== undefined && value !== '') params.set(key, String(value));
		const raw = await this.request('GET', `/api/v1/operations/${encodeURIComponent(id)}?${params}`);
		const record = asRecord(raw) ?? {};
		return {
			operation: operationFrom(raw),
			items: (asArray(record.items) ?? []) as OperationItemView[],
			cursor: numberValue(record.cursor) ?? filter.after ?? 0,
			hasMore: record.hasMore === true,
		};
	}

	/** Every item matching `filter`, following the cursor (bounded by `max`). */
	async listOperationItems(
		id: string,
		filter: Omit<OperationItemsFilter, 'after' | 'limit'> = {},
		max = 10_000,
	): Promise<{ operation: OperationView; items: OperationItemView[] }> {
		const items: OperationItemView[] = [];
		let after = 0;
		for (;;) {
			const page = await this.getOperationItems(id, { ...filter, after, limit: 1000 });
			items.push(...page.items);
			if (!page.hasMore || page.items.length === 0 || items.length >= max)
				return { operation: page.operation, items: items.slice(0, max) };
			after = page.cursor;
		}
	}

	async applyOperation(id: string, input: { categories?: string[] } = {}): Promise<OperationView> {
		const raw = await this.request('POST', `/api/v1/operations/${encodeURIComponent(id)}/apply`, { body: input });
		return operationFrom(raw);
	}

	async cancelOperation(id: string): Promise<OperationView> {
		const raw = await this.request('POST', `/api/v1/operations/${encodeURIComponent(id)}/cancel`, { body: {} });
		return operationFrom(raw);
	}

	async listOperations(
		filter: { kind?: string; status?: string; limit?: number; scope?: string } = {},
	): Promise<{ operations: OperationView[]; raw: unknown }> {
		const params = new URLSearchParams();
		for (const [key, value] of Object.entries(filter))
			if (value !== undefined && value !== '') params.set(key, String(value));
		const query = params.size > 0 ? `?${params}` : '';
		const raw = await this.request('GET', `/api/v1/operations${query}`);
		const operations = (asArray(asRecord(raw)?.operations) ?? []) as OperationView[];
		return { operations, raw };
	}

	/**
	 * Open the SSE progress stream. Has no timeout of its own: the caller aborts via `signal`
	 * (Ctrl-C, or its idle watchdog). `lastEventId` resumes after the items already seen.
	 */
	async openOperationStream(
		id: string,
		options: { untilDone: boolean; lastEventId?: string; signal?: AbortSignal },
	): Promise<ReadableStream<Uint8Array>> {
		const url = `${this.baseUrl}/api/v1/operations/${encodeURIComponent(id)}/stream${options.untilDone ? '?until=done' : ''}`;
		const headers = this.headers({ accept: 'text/event-stream' });
		if (options.lastEventId) headers.set('last-event-id', options.lastEventId);
		let response: Response;
		try {
			response = await this.fetchImpl(url, { method: 'GET', headers, signal: options.signal });
		} catch (error) {
			if (options.signal?.aborted) throw error;
			throw new CliError(`Could not reach ${this.baseUrl}: ${errorMessage(error)}`, { code: 'network', cause: error });
		}
		if (!response.ok) {
			const text = await response.text().catch(() => '');
			throw apiError(response, 'GET', url, text, parseJson(text));
		}
		if (!response.body) throw new CliError('The progress stream had no body.', { code: 'protocol' });
		return response.body;
	}

	/**
	 * One request whose body the caller reads itself (streams, downloads, raw input): container
	 * console calls (D127). Non-2xx responses throw an `ApiError`; there is no timeout unless the
	 * caller passes a signal.
	 */
	async raw(
		method: string,
		path: string,
		options: { body?: string | Uint8Array; headers?: Record<string, string>; signal?: AbortSignal } = {},
	): Promise<Response> {
		const url = `${this.baseUrl}${path}`;
		let response: Response;
		try {
			response = await this.fetchImpl(url, {
				method,
				headers: this.headers(options.headers),
				...(options.body !== undefined ? { body: options.body as RequestInit['body'] } : {}),
				...(options.signal ? { signal: options.signal } : {}),
			});
		} catch (error) {
			if (options.signal?.aborted) throw error;
			throw new CliError(`Could not reach ${this.baseUrl}: ${errorMessage(error)}`, { code: 'network', cause: error });
		}
		if (!response.ok) {
			const text = await response.text().catch(() => '');
			throw apiError(response, method, url, text, parseJson(text));
		}
		return response;
	}

	// --- blueprints (plan 11) ---------------------------------------------------------------

	/** `POST /blueprints/validate`: the server parses the YAML or JSON text. */
	async validateBlueprint(document: string): Promise<{ validation: BlueprintValidation; raw: unknown }> {
		const raw = await this.request('POST', '/api/v1/blueprints/validate', { body: { document } });
		return { validation: asRecord(raw)?.validation as BlueprintValidation, raw };
	}

	/** `POST /blueprints/plan`: changes nothing; the plan lasts an hour. */
	async planBlueprint(document: string, options: { prune?: boolean } = {}): Promise<{ plan: BlueprintPlanView; raw: unknown }> {
		const raw = await this.request('POST', '/api/v1/blueprints/plan', {
			body: { document, ...(options.prune ? { prune: true } : {}) },
		});
		const plan = asRecord(asRecord(raw)?.plan);
		if (!plan || typeof plan.planHash !== 'string')
			throw new CliError('The platform returned an unexpected blueprint plan.', { code: 'protocol', details: raw });
		return { plan: plan as unknown as BlueprintPlanView, raw };
	}

	/** `POST /blueprints/apply`; `waitSeconds` (≤25) holds the response until the run settles. */
	async applyBlueprint(
		input: { planHash: string; confirm?: string },
		options: { waitSeconds?: number } = {},
	): Promise<{ run: BlueprintRunView; raw: unknown }> {
		const raw = await this.request('POST', `/api/v1/blueprints/apply${waitQuery(options.waitSeconds)}`, {
			body: input,
			timeoutMs: waitTimeout(this.timeoutMs, options.waitSeconds),
		});
		return { run: blueprintRunFrom(raw), raw };
	}

	async getBlueprintRun(operationId: string): Promise<{ run: BlueprintRunView; raw: unknown }> {
		const raw = await this.request('GET', `/api/v1/blueprints/apply/${encodeURIComponent(operationId)}`);
		return { run: blueprintRunFrom(raw), raw };
	}

	// --- jobs (plan 09) -----------------------------------------------------------------------

	private jobsPath(project: string, rest = ''): string {
		return `/api/v1/projects/${encodeURIComponent(project)}/jobs${rest}`;
	}

	async listJobs(project: string): Promise<{ jobs: JobView[]; raw: unknown }> {
		const raw = await this.request('GET', this.jobsPath(project));
		return { jobs: (asArray(asRecord(raw)?.jobs) ?? []) as JobView[], raw };
	}

	async getJob(project: string, name: string): Promise<{ job: JobView; raw: unknown }> {
		const raw = await this.request('GET', this.jobsPath(project, `/${encodeURIComponent(name)}`));
		return { job: asRecord(raw)?.job as unknown as JobView, raw };
	}

	async createJob(project: string, input: Record<string, unknown>): Promise<{ job: JobView; raw: unknown }> {
		const raw = await this.request('POST', this.jobsPath(project), { body: input });
		return { job: asRecord(raw)?.job as unknown as JobView, raw };
	}

	async updateJob(project: string, name: string, input: Record<string, unknown>): Promise<{ job: JobView; raw: unknown }> {
		const raw = await this.request('PATCH', this.jobsPath(project, `/${encodeURIComponent(name)}`), { body: input });
		return { job: asRecord(raw)?.job as unknown as JobView, raw };
	}

	async setJobPaused(project: string, name: string, paused: boolean): Promise<{ job: JobView; raw: unknown }> {
		const raw = await this.request('POST', this.jobsPath(project, `/${encodeURIComponent(name)}/${paused ? 'pause' : 'resume'}`));
		return { job: asRecord(raw)?.job as unknown as JobView, raw };
	}

	async deleteJob(project: string, name: string): Promise<unknown> {
		return this.request('DELETE', this.jobsPath(project, `/${encodeURIComponent(name)}`));
	}

	async runJob(project: string, name: string): Promise<{ run: JobRunView; raw: unknown }> {
		const raw = await this.request('POST', this.jobsPath(project, `/${encodeURIComponent(name)}/run`));
		return { run: asRecord(raw)?.run as unknown as JobRunView, raw };
	}

	/** A one-off command against the current release (`skif run`). */
	async runCommand(project: string, input: { command: string[]; timeoutSeconds?: number }): Promise<{ run: JobRunView; raw: unknown }> {
		const raw = await this.request('POST', this.jobsPath(project, '/runs'), { body: input });
		return { run: asRecord(raw)?.run as unknown as JobRunView, raw };
	}

	async listJobRuns(
		project: string,
		options: { job?: string; oneOff?: boolean; limit?: number } = {},
	): Promise<{ runs: JobRunView[]; raw: unknown }> {
		const params = new URLSearchParams();
		if (options.limit) params.set('limit', String(options.limit));
		if (options.oneOff) params.set('oneOff', '1');
		const query = params.size > 0 ? `?${params.toString()}` : '';
		const path = options.job ? `/${encodeURIComponent(options.job)}/runs${query}` : `/runs${query}`;
		const raw = await this.request('GET', this.jobsPath(project, path));
		return { runs: (asArray(asRecord(raw)?.runs) ?? []) as JobRunView[], raw };
	}

	/** `waitSeconds` (up to 25) holds the request until the run finishes. */
	async getJobRun(project: string, runId: string, options: { waitSeconds?: number } = {}): Promise<{ run: JobRunView; raw: unknown }> {
		const raw = await this.request('GET', this.jobsPath(project, `/runs/${encodeURIComponent(runId)}${waitQuery(options.waitSeconds)}`), {
			timeoutMs: waitTimeout(this.timeoutMs, options.waitSeconds),
		});
		return { run: asRecord(raw)?.run as unknown as JobRunView, raw };
	}

	async cancelJobRun(project: string, runId: string): Promise<{ run: JobRunView; raw: unknown }> {
		const raw = await this.request('POST', this.jobsPath(project, `/runs/${encodeURIComponent(runId)}/cancel`));
		return { run: asRecord(raw)?.run as unknown as JobRunView, raw };
	}

	async jobRunLogs(project: string, runId: string, options: { after?: number; limit?: number } = {}): Promise<JobLogPage> {
		const params = new URLSearchParams();
		if (options.after !== undefined) params.set('after', String(options.after));
		if (options.limit !== undefined) params.set('limit', String(options.limit));
		const query = params.size > 0 ? `?${params.toString()}` : '';
		const raw = asRecord(await this.request('GET', this.jobsPath(project, `/runs/${encodeURIComponent(runId)}/logs${query}`))) ?? {};
		return {
			events: (asArray(raw.events) ?? []) as JobLogPage['events'],
			cursor: typeof raw.cursor === 'number' ? raw.cursor : (options.after ?? 0),
			hasMore: raw.hasMore === true,
		};
	}

	// --- app volumes (plan 07) ---------------------------------------------------------------

	async listVolumes(project: string): Promise<{ volumes: AppVolumeView[]; raw: unknown }> {
		const raw = await this.request('GET', `/api/v1/projects/${encodeURIComponent(project)}/volumes`);
		return { volumes: (asArray(asRecord(raw)?.volumes) ?? []) as AppVolumeView[], raw };
	}

	async getVolume(project: string, name: string): Promise<{ volume: AppVolumeView; raw: unknown }> {
		const raw = await this.request(
			'GET',
			`/api/v1/projects/${encodeURIComponent(project)}/volumes/${encodeURIComponent(name)}`,
		);
		return { volume: asRecord(raw)?.volume as unknown as AppVolumeView, raw };
	}

	async createVolume(
		project: string,
		input: {
			name: string;
			sizeMb?: number;
			/** `system`, `fast`, `bulk` or a disk name. */
			storage?: string;
			singleWriter?: boolean;
		},
	): Promise<{ volume: AppVolumeView; raw: unknown }> {
		const raw = await this.request('POST', `/api/v1/projects/${encodeURIComponent(project)}/volumes`, {
			body: input,
		});
		return { volume: raw as unknown as AppVolumeView, raw };
	}

	async attachVolume(
		project: string,
		name: string,
		input: { mountPath: string; workload?: string; environment?: string; readOnly?: boolean },
	): Promise<{ volume: AppVolumeView; raw: unknown }> {
		const raw = await this.request(
			'POST',
			`/api/v1/projects/${encodeURIComponent(project)}/volumes/${encodeURIComponent(name)}/attach`,
			{ body: { workload: input.workload ?? project, ...input } },
		);
		return { volume: raw as unknown as AppVolumeView, raw };
	}

	async detachVolume(
		project: string,
		name: string,
		input: { workload?: string; environment?: string } = {},
	): Promise<{ volume: AppVolumeView; raw: unknown }> {
		const raw = await this.request(
			'DELETE',
			`/api/v1/projects/${encodeURIComponent(project)}/volumes/${encodeURIComponent(name)}/attach`,
			{ body: { workload: input.workload ?? project, environment: input.environment ?? 'production' } },
		);
		return { volume: asRecord(raw)?.volume as unknown as AppVolumeView, raw };
	}

	async deleteVolume(project: string, name: string): Promise<{ purgeAt: string; raw: unknown }> {
		const raw = await this.request(
			'DELETE',
			`/api/v1/projects/${encodeURIComponent(project)}/volumes/${encodeURIComponent(name)}`,
		);
		return { purgeAt: stringValue(asRecord(raw)?.purgeAt) ?? 'seven days', raw };
	}

	private volumePath(project: string, name: string): string {
		return `/api/v1/projects/${encodeURIComponent(project)}/volumes/${encodeURIComponent(name)}`;
	}

	async listVolumeSnapshots(project: string, name: string): Promise<{ snapshots: AppVolumeSnapshotView[]; raw: unknown }> {
		const raw = await this.request('GET', `${this.volumePath(project, name)}/snapshots`);
		return { snapshots: (asArray(asRecord(raw)?.snapshots) ?? []) as AppVolumeSnapshotView[], raw };
	}

	async snapshotVolume(
		project: string,
		name: string,
		input: { label?: string; pinned?: boolean; quiesce?: boolean; target?: string } = {},
	): Promise<{ snapshot: AppVolumeSnapshotView; warning: string | null; raw: unknown }> {
		const raw = await this.request('POST', `${this.volumePath(project, name)}/snapshots`, { body: input });
		const record = asRecord(raw);
		return {
			snapshot: record?.snapshot as unknown as AppVolumeSnapshotView,
			warning: stringValue(record?.warning) ?? null,
			raw,
		};
	}

	async deleteVolumeSnapshot(project: string, name: string, snapshotId: string): Promise<{ raw: unknown }> {
		const raw = await this.request(
			'DELETE',
			`${this.volumePath(project, name)}/snapshots/${encodeURIComponent(snapshotId)}`,
		);
		return { raw };
	}

	async restoreVolumeSnapshot(
		project: string,
		name: string,
		snapshotId: string,
		input: { name: string; sizeMb?: number },
	): Promise<{ volume: AppVolumeView; raw: unknown }> {
		const raw = await this.request(
			'POST',
			`${this.volumePath(project, name)}/snapshots/${encodeURIComponent(snapshotId)}/restore`,
			{ body: input },
		);
		return { volume: asRecord(raw)?.volume as unknown as AppVolumeView, raw };
	}

	// --- managed databases (docs/DATABASES.md) ---------------------------------------------

	async listDatabases(options: { includeDeleted?: boolean } = {}): Promise<{ databases: DatabaseView[]; raw: unknown }> {
		const raw = await this.request('GET', `/api/v1/databases${options.includeDeleted ? '?includeDeleted=1' : ''}`);
		return { databases: (asArray(asRecord(raw)?.databases) ?? []) as DatabaseView[], raw };
	}

	async getDatabase(name: string, options: { includeDeleted?: boolean } = {}): Promise<{ database: DatabaseView; raw: unknown }> {
		const raw = await this.request(
			'GET',
			`/api/v1/databases/${encodeURIComponent(name)}${options.includeDeleted ? '?includeDeleted=1' : ''}`,
		);
		return { database: databaseFrom(raw), raw };
	}

	async createDatabase(input: DatabaseCreateInput): Promise<{ database: DatabaseView; raw: unknown }> {
		const raw = await this.request('POST', '/api/v1/databases', { body: input });
		return { database: databaseFrom(raw), raw };
	}

	/** Resize, toggle the pooler, set extensions, or move a version forward in place. */
	async updateDatabase(name: string, input: DatabaseUpdateInput): Promise<{ database: DatabaseView; raw: unknown }> {
		const raw = await this.request('PATCH', `/api/v1/databases/${encodeURIComponent(name)}`, { body: input });
		return { database: databaseFrom(raw), raw };
	}

	/** Soft delete (restorable for 7 days). */
	async deleteDatabase(name: string): Promise<{ database: DatabaseView; raw: unknown }> {
		const raw = await this.request('DELETE', `/api/v1/databases/${encodeURIComponent(name)}`);
		return { database: databaseFrom(raw), raw };
	}

	/** Permanently delete a database that is already in the trash. */
	async purgeDatabase(name: string): Promise<unknown> {
		return this.request('DELETE', `/api/v1/databases/${encodeURIComponent(name)}?purge=1`);
	}

	async restoreDatabase(name: string): Promise<{ database: DatabaseView; raw: unknown }> {
		const raw = await this.request('POST', `/api/v1/databases/${encodeURIComponent(name)}/restore`, { body: {} });
		return { database: databaseFrom(raw), raw };
	}

	async listDatabaseBackups(name: string): Promise<{ backups: DatabaseBackupView[]; raw: unknown }> {
		const raw = await this.request('GET', `/api/v1/databases/${encodeURIComponent(name)}/backups`);
		return { backups: (asArray(asRecord(raw)?.backups) ?? []) as DatabaseBackupView[], raw };
	}

	async createDatabaseBackup(name: string, input: { pinned?: boolean } = {}): Promise<{ backup: DatabaseBackupView; raw: unknown }> {
		const raw = await this.request('POST', `/api/v1/databases/${encodeURIComponent(name)}/backups`, { body: input });
		return { backup: asRecord(asRecord(raw)?.backup) as unknown as DatabaseBackupView, raw };
	}

	// ---------------------------------------------------------------- read replicas (docs/CLUSTERING.md §9.2)

	async databaseReplicas(name: string): Promise<{
		primaryGeneration: number;
		replicas: DatabaseReplicaView[];
		failovers: DatabaseFailoverView[];
		raw: unknown;
	}> {
		const raw = await this.request('GET', `/api/v1/databases/${encodeURIComponent(name)}/replicas`);
		const record = asRecord(raw);
		return {
			primaryGeneration: typeof record?.primaryGeneration === 'number' ? record.primaryGeneration : 0,
			replicas: (Array.isArray(record?.replicas) ? record.replicas : []) as DatabaseReplicaView[],
			failovers: (Array.isArray(record?.failovers) ? record.failovers : []) as DatabaseFailoverView[],
			raw,
		};
	}

	async addDatabaseReplica(
		name: string,
		input: { node: string; storage?: string },
	): Promise<{ replica: DatabaseReplicaView; raw: unknown }> {
		const raw = await this.request('POST', `/api/v1/databases/${encodeURIComponent(name)}/replicas`, { body: input });
		return { replica: asRecord(raw)?.replica as unknown as DatabaseReplicaView, raw };
	}

	async removeDatabaseReplica(name: string, replicaId: string): Promise<{ replica: DatabaseReplicaView; raw: unknown }> {
		const raw = await this.request(
			'DELETE',
			`/api/v1/databases/${encodeURIComponent(name)}/replicas/${encodeURIComponent(replicaId)}`,
		);
		return { replica: asRecord(raw)?.replica as unknown as DatabaseReplicaView, raw };
	}

	async promoteDatabaseReplica(
		name: string,
		replicaId: string,
		input: { acceptDataLoss: boolean; ifMatch: number },
	): Promise<{ failover: DatabaseFailoverView; raw: unknown }> {
		const raw = await this.request(
			'POST',
			`/api/v1/databases/${encodeURIComponent(name)}/replicas/${encodeURIComponent(replicaId)}/promote`,
			{ body: { confirm: true, acceptDataLoss: input.acceptDataLoss }, headers: { 'if-match': String(input.ifMatch) } },
		);
		return { failover: asRecord(raw)?.failover as unknown as DatabaseFailoverView, raw };
	}

	// ---------------------------------------------------------------- point-in-time recovery (docs/PITR.md)

	async databasePitr(name: string): Promise<{ pitr: DatabasePitrView; raw: unknown }> {
		const raw = await this.request('GET', `/api/v1/databases/${encodeURIComponent(name)}/pitr`);
		return { pitr: asRecord(raw)?.pitr as unknown as DatabasePitrView, raw };
	}

	async setDatabasePitr(name: string, enabled: boolean): Promise<{ pitr: DatabasePitrView; raw: unknown }> {
		const raw = await this.request('PATCH', `/api/v1/databases/${encodeURIComponent(name)}/pitr`, { body: { enabled } });
		return { pitr: asRecord(raw)?.pitr as unknown as DatabasePitrView, raw };
	}

	async createDatabasePitrBackup(
		name: string,
		type: 'full' | 'diff' | 'incr',
	): Promise<{ task: DatabasePitrTaskView; raw: unknown }> {
		const raw = await this.request('POST', `/api/v1/databases/${encodeURIComponent(name)}/pitr/backups`, { body: { type } });
		return { task: asRecord(raw)?.task as unknown as DatabasePitrTaskView, raw };
	}

	async restoreDatabaseToTime(
		name: string,
		input: { name: string; targetTime: string },
	): Promise<{ database: DatabaseView; raw: unknown }> {
		const raw = await this.request('POST', `/api/v1/databases/${encodeURIComponent(name)}/pitr/restore`, { body: input });
		return { database: databaseFrom(raw), raw };
	}

	async deleteDatabaseBackup(name: string, backupId: string): Promise<unknown> {
		return this.request('DELETE', `/api/v1/databases/${encodeURIComponent(name)}/backups/${encodeURIComponent(backupId)}`);
	}

	async restoreDatabaseBackup(
		name: string,
		backupId: string,
		input: { name: string; placement?: string; project?: string; envPrefix?: string },
	): Promise<{ database: DatabaseView; raw: unknown }> {
		const raw = await this.request(
			'POST',
			`/api/v1/databases/${encodeURIComponent(name)}/backups/${encodeURIComponent(backupId)}/restore`,
			{ body: input },
		);
		return { database: databaseFrom(raw), raw };
	}

	async databaseLogs(
		name: string,
		options: { after?: number; limit?: number; level?: string; q?: string } = {},
	): Promise<{
		events: Array<{ seq: number; ts: number; level: string; stream: string; message: string }>;
		cursor: number;
		hasMore: boolean;
		raw: unknown;
	}> {
		const params = new URLSearchParams();
		if (options.after !== undefined) params.set('after', String(options.after));
		if (options.limit !== undefined) params.set('limit', String(options.limit));
		if (options.level) params.set('level', options.level);
		if (options.q) params.set('q', options.q);
		const query = params.size > 0 ? `?${params.toString()}` : '';
		const raw = await this.request('GET', `/api/v1/databases/${encodeURIComponent(name)}/logs${query}`);
		const record = asRecord(raw);
		const events = (asArray(record?.events) ?? []).map((value) => {
			const event = asRecord(value) ?? {};
			return {
				seq: numberValue(event.seq) ?? 0,
				ts: numberValue(event.ts) ?? 0,
				level: stringValue(event.level) ?? 'info',
				stream: stringValue(event.stream) ?? 'stdout',
				message: stringValue(event.message) ?? '',
			};
		});
		return {
			events,
			cursor: numberValue(record?.cursor) ?? 0,
			hasMore: record?.hasMore === true,
			raw,
		};
	}

	async restartServices(input: {
		scope?: 'all' | 'databases' | 'storage';
		databases?: string[];
		storage?: string[];
	}): Promise<{ result: ServiceRestartResult; raw: unknown }> {
		const raw = await this.request('POST', '/api/v1/services/restart', { body: input });
		return { result: raw as ServiceRestartResult, raw };
	}

	async backupAllDatabases(): Promise<{ result: DatabaseBackupAllResult; raw: unknown }> {
		const raw = await this.request('POST', '/api/v1/services/backup-databases', { body: {} });
		return { result: raw as DatabaseBackupAllResult, raw };
	}

	// --- backup targets (plan 05, docs/BACKUPS.md) -----------------------------------------

	async listBackupTargets(): Promise<{ targets: BackupTargetView[]; raw: unknown }> {
		const raw = await this.request('GET', '/api/v1/backup-targets');
		return { targets: (asArray(asRecord(raw)?.targets) ?? []) as BackupTargetView[], raw };
	}

	async createBackupTarget(
		input: BackupTargetCreateInput,
		options: { platform?: boolean } = {},
	): Promise<{
		target: BackupTargetView;
		credentials: BackupTargetCredentials | null;
		raw: unknown;
	}> {
		const raw = await this.request(
			'POST',
			`/api/v1/backup-targets${options.platform ? '?platform=1' : ''}`,
			{ body: input },
		);
		const record = asRecord(raw);
		return {
			target: asRecord(record?.target) as unknown as BackupTargetView,
			credentials: (asRecord(record?.credentials) as unknown as BackupTargetCredentials) ?? null,
			raw,
		};
	}

	async testBackupTarget(id: string): Promise<{ result: BackupTargetTestResult; raw: unknown }> {
		const raw = await this.request('POST', `/api/v1/backup-targets/${encodeURIComponent(id)}/test`, { body: {} });
		return { result: asRecord(asRecord(raw)?.result) as unknown as BackupTargetTestResult, raw };
	}

	/** `force` deletes a target that still holds backups; they stay listed as unavailable. */
	async deleteBackupTarget(id: string, options: { force?: boolean } = {}): Promise<unknown> {
		const query = options.force ? '?force=1' : '';
		return this.request('DELETE', `/api/v1/backup-targets/${encodeURIComponent(id)}${query}`);
	}

	async restartDatabase(
		name: string,
		target: 'database' | 'pooler',
	): Promise<{ database: DatabaseView; target: string; raw: unknown }> {
		const raw = await this.request('POST', `/api/v1/databases/${encodeURIComponent(name)}/restart`, {
			body: { target },
		});
		return { database: databaseFrom(raw), target, raw };
	}

	async listDatabaseRotations(name: string): Promise<{ rotations: DatabaseRotationView[]; raw: unknown }> {
		const raw = await this.request('GET', `/api/v1/databases/${encodeURIComponent(name)}/rotate`);
		return {
			rotations: (asArray(asRecord(raw)?.rotations) ?? []) as DatabaseRotationView[],
			raw,
		};
	}

	async rotateDatabase(name: string, role: 'owner' | 'monitor'): Promise<{ rotation: DatabaseRotationView; raw: unknown }> {
		const raw = await this.request('POST', `/api/v1/databases/${encodeURIComponent(name)}/rotate`, {
			body: { role },
		});
		return { rotation: asRecord(asRecord(raw)?.rotation) as unknown as DatabaseRotationView, raw };
	}

	async databaseUpgradePlan(name: string, targetVersion: string): Promise<{ plan: DatabaseUpgradePlan; raw: unknown }> {
		const raw = await this.request(
			'GET',
			`/api/v1/databases/${encodeURIComponent(name)}/upgrade?to=${encodeURIComponent(targetVersion)}`,
		);
		const plan = asRecord(raw)?.plan as unknown as DatabaseUpgradePlan | undefined;
		if (!plan) throw new CliError('The platform returned an unexpected upgrade plan.', { code: 'protocol' });
		return { plan, raw };
	}

	async applyDatabaseUpgrade(name: string, targetVersion: string): Promise<{ plan: DatabaseUpgradePlan; raw: unknown }> {
		const raw = await this.request('POST', `/api/v1/databases/${encodeURIComponent(name)}/upgrade`, {
			body: { targetVersion, apply: true },
		});
		const plan = asRecord(raw)?.plan as unknown as DatabaseUpgradePlan | undefined;
		if (!plan) throw new CliError('The platform returned an unexpected upgrade plan.', { code: 'protocol' });
		return { plan, raw };
	}

	async platformUpgradePlan(version?: string): Promise<{ plan: unknown; snapshots: unknown; raw: unknown }> {
		const query = version ? `?version=${encodeURIComponent(version)}` : '';
		const raw = await this.request('GET', `/api/v1/platform/upgrade/plan${query}`);
		const record = asRecord(raw);
		return { plan: record?.plan, snapshots: record?.snapshots, raw };
	}

	async databaseBackupPolicy(name: string): Promise<{ policy: unknown; raw: unknown }> {		const raw = await this.request('GET', `/api/v1/databases/${encodeURIComponent(name)}/backup-policy`);
		return { policy: asRecord(raw)?.backup, raw };
	}

	async setDatabaseBackupPolicy(name: string, input: { enabled?: boolean; schedule?: string; retentionDays?: number }): Promise<unknown> {
		return this.request('PATCH', `/api/v1/databases/${encodeURIComponent(name)}/backup-policy`, { body: input });
	}

	// ---------------------------------------------------------------- event notifications (D122)

	async listEventRules(): Promise<{ rules: EventRuleView[]; raw: unknown }> {
		const raw = await this.request('GET', '/api/v1/events');
		return { rules: (asArray(asRecord(raw)?.rules) ?? []) as EventRuleView[], raw };
	}

	async getEventRule(id: string): Promise<{ rule: EventRuleView; raw: unknown }> {
		const raw = await this.request('GET', `/api/v1/events/${encodeURIComponent(id)}`);
		return { rule: asRecord(raw)?.rule as EventRuleView, raw };
	}

	async createEventRule(input: EventRuleCreateInput): Promise<{ rule: EventRuleView; raw: unknown }> {
		const raw = await this.request('POST', '/api/v1/events', { body: input });
		return { rule: asRecord(raw)?.rule as EventRuleView, raw };
	}

	async updateEventRule(id: string, input: EventRuleUpdateInput): Promise<{ rule: EventRuleView; raw: unknown }> {
		const raw = await this.request('PATCH', `/api/v1/events/${encodeURIComponent(id)}`, { body: input });
		return { rule: asRecord(raw)?.rule as EventRuleView, raw };
	}

	async deleteEventRule(id: string): Promise<unknown> {
		return this.request('DELETE', `/api/v1/events/${encodeURIComponent(id)}`);
	}

	async testEventRule(id: string): Promise<{ delivery: EventDeliveryView; raw: unknown }> {
		const raw = await this.request('POST', `/api/v1/events/${encodeURIComponent(id)}/test`);
		return { delivery: asRecord(raw)?.delivery as EventDeliveryView, raw };
	}

	// ---------------------------------------------------------------- container images (docs/REGISTRY.md)

	async listRegistryCredentials(): Promise<{ credentials: RegistryCredentialView[]; raw: unknown }> {
		const raw = await this.request('GET', '/api/v1/registry/credentials');
		return { credentials: (asArray(asRecord(raw)?.credentials) ?? []) as RegistryCredentialView[], raw };
	}

	async createRegistryCredential(input: {
		name: string;
		registry: string;
		username: string;
		password: string;
	}): Promise<{ credential: RegistryCredentialView; raw: unknown }> {
		const raw = await this.request('POST', '/api/v1/registry/credentials', { body: input });
		return { credential: asRecord(raw)?.credential as RegistryCredentialView, raw };
	}

	async updateRegistryCredential(
		name: string,
		input: { registry?: string; username?: string; password?: string },
	): Promise<{ credential: RegistryCredentialView; raw: unknown }> {
		const raw = await this.request('PATCH', `/api/v1/registry/credentials/${encodeURIComponent(name)}`, { body: input });
		return { credential: asRecord(raw)?.credential as RegistryCredentialView, raw };
	}

	async deleteRegistryCredential(name: string): Promise<void> {
		await this.request('DELETE', `/api/v1/registry/credentials/${encodeURIComponent(name)}`);
	}

	async getRegistry(): Promise<{ registry: RegistryView; raw: unknown }> {
		const raw = await this.request('GET', '/api/v1/registry');
		return { registry: asRecord(raw)?.registry as RegistryView, raw };
	}

	async listRegistryRepositories(): Promise<{ repositories: RegistryRepositoryView[]; raw: unknown }> {
		const raw = await this.request('GET', '/api/v1/registry/repositories');
		return { repositories: (asArray(asRecord(raw)?.repositories) ?? []) as RegistryRepositoryView[], raw };
	}

	async setRegistryAutoDeploy(input: { repository: string; project: string | null; tag?: string }): Promise<{ repository: RegistryRepositoryView; raw: unknown }> {
		const raw = await this.request('PATCH', '/api/v1/registry/repositories', { body: input });
		return { repository: asRecord(raw)?.repository as RegistryRepositoryView, raw };
	}

	async registryScan(repository: string, reference: string): Promise<{ report: { image: string; summary: Record<string, unknown> | null; cves: Array<{ Id: string; Severity: string; Title: string }> }; raw: unknown }> {
		const raw = await this.request('GET', `/api/v1/registry/scan?repository=${encodeURIComponent(repository)}&reference=${encodeURIComponent(reference)}`, { timeoutMs: 60_000 });
		return { report: raw as never, raw };
	}

	async listRegistryTrusts(): Promise<{ trusts: Array<{ id: string; githubRepository: string; ref: string | null; repository: string; push: boolean }>; raw: unknown }> {
		const raw = await this.request('GET', '/api/v1/registry/trusts');
		return { trusts: (asArray(asRecord(raw)?.trusts) ?? []) as never, raw };
	}

	async createRegistryTrust(input: { githubRepository: string; repository: string; ref?: string; push?: boolean }): Promise<{ trust: { id: string }; raw: unknown }> {
		const raw = await this.request('POST', '/api/v1/registry/trusts', { body: input });
		return { trust: asRecord(raw)?.trust as { id: string }, raw };
	}

	async deleteRegistryTrust(id: string): Promise<void> {
		await this.request('DELETE', `/api/v1/registry/trusts/${encodeURIComponent(id)}`);
	}

	async listRegistryTags(repository: string): Promise<{ tags: Array<{ tag: string }>; raw: unknown }> {
		const raw = await this.request('GET', `/api/v1/registry/tags?repository=${encodeURIComponent(repository)}`);
		return { tags: (asArray(asRecord(raw)?.tags) ?? []) as Array<{ tag: string }>, raw };
	}

	async deleteRegistryTag(repository: string, tag: string): Promise<void> {
		await this.request(
			'DELETE',
			`/api/v1/registry/tags?repository=${encodeURIComponent(repository)}&tag=${encodeURIComponent(tag)}`,
		);
	}

	/** Set a container project's image and deploy it; the server pins the tag to a digest. */
	async deployImage(
		project: string,
		input: { image: string; promote?: boolean; message?: string; environment?: string },
	): Promise<{ deployment: DeploymentView; workload: ImageWorkloadView | null; raw: unknown }> {
		const raw = await this.request('POST', `/api/v1/projects/${encodeURIComponent(project)}/deploy-image`, {
			body: input,
			timeoutMs: 120_000,
		});
		const record = asRecord(raw);
		return {
			deployment: (record?.deployment ?? {}) as DeploymentView,
			workload: (record?.workload ?? null) as ImageWorkloadView | null,
			raw,
		};
	}

	// ---------------------------------------------------------------- log drains and audit (DESIGN §8)

	async listLogDrains(): Promise<{ drains: LogDrainView[]; canEdit: boolean; raw: unknown }> {
		const raw = await this.request('GET', '/api/v1/log-drains');
		return { drains: (asArray(asRecord(raw)?.drains) ?? []) as LogDrainView[], canEdit: asRecord(raw)?.canEdit === true, raw };
	}

	async getLogDrain(id: string): Promise<{ drain: LogDrainView; raw: unknown }> {
		const raw = await this.request('GET', `/api/v1/log-drains/${encodeURIComponent(id)}`);
		return { drain: asRecord(raw)?.drain as LogDrainView, raw };
	}

	async createLogDrain(input: LogDrainCreateInput): Promise<{ drain: LogDrainView; signingSecret: string | null; raw: unknown }> {
		const raw = await this.request('POST', '/api/v1/log-drains', { body: input });
		const record = asRecord(raw);
		return { drain: record?.drain as LogDrainView, signingSecret: typeof record?.signingSecret === 'string' ? record.signingSecret : null, raw };
	}

	async updateLogDrain(id: string, input: LogDrainUpdateInput): Promise<{ drain: LogDrainView; signingSecret: string | null; raw: unknown }> {
		const raw = await this.request('PATCH', `/api/v1/log-drains/${encodeURIComponent(id)}`, { body: input });
		const record = asRecord(raw);
		return { drain: record?.drain as LogDrainView, signingSecret: typeof record?.signingSecret === 'string' ? record.signingSecret : null, raw };
	}

	async deleteLogDrain(id: string): Promise<unknown> {
		return this.request('DELETE', `/api/v1/log-drains/${encodeURIComponent(id)}`);
	}

	async testLogDrain(id: string): Promise<{ result: LogDrainTestResult; raw: unknown }> {
		const raw = await this.request('POST', `/api/v1/log-drains/${encodeURIComponent(id)}/test`, { timeoutMs: 30_000 });
		return { result: asRecord(raw)?.result as LogDrainTestResult, raw };
	}

	/** One page of the audit log, newest first; pass `nextCursor` back as `cursor` for older entries. */
	/** `GET /export`: the org's configuration, secrets by name only (OPERATIONS.md §13). */
	async configExport(options: { projects?: string[] } = {}): Promise<ConfigExportDocument> {
		const params = new URLSearchParams();
		for (const slug of options.projects ?? []) params.append('project', slug);
		const query = params.size > 0 ? `?${params}` : '';
		const record = asRecord(await this.request('GET', `/api/v1/export${query}`));
		const doc = asRecord(record?.export);
		if (!doc || typeof doc.apiVersion !== 'string') throw new Error('The platform returned no export. Is it running a version with `GET /api/v1/export`?');
		return { ...doc, skipped: (asArray(doc.skipped) ?? []) as ConfigExportDocument['skipped'] } as ConfigExportDocument;
	}

	async auditLog(
		options: { from?: string; to?: string; action?: string; resource?: string; limit?: number; cursor?: string } = {},
	): Promise<{ entries: AuditEntryView[]; nextCursor: string | null; raw: unknown }> {
		const params = new URLSearchParams();
		for (const key of ['from', 'to', 'action', 'resource', 'cursor'] as const) if (options[key]) params.set(key, options[key]);
		if (options.limit) params.set('limit', String(options.limit));
		const query = params.size > 0 ? `?${params}` : '';
		const raw = await this.request('GET', `/api/v1/audit${query}`);
		const record = asRecord(raw);
		return {
			entries: (asArray(record?.entries) ?? []) as AuditEntryView[],
			nextCursor: typeof record?.nextCursor === 'string' ? record.nextCursor : null,
			raw,
		};
	}

	async listEventDeliveries(options: { rule?: string; status?: string; limit?: number } = {}): Promise<{ deliveries: EventDeliveryView[]; raw: unknown }> {
		const params = new URLSearchParams();
		if (options.rule) params.set('rule', options.rule);
		if (options.status) params.set('status', options.status);
		if (options.limit) params.set('limit', String(options.limit));
		const query = params.size > 0 ? `?${params}` : '';
		const raw = await this.request('GET', `/api/v1/events/deliveries${query}`);
		return { deliveries: (asArray(asRecord(raw)?.deliveries) ?? []) as EventDeliveryView[], raw };
	}

	// ---------------------------------------------------------------- email (docs/EMAIL.md, D114–D120)
	// Single views may arrive bare or wrapped (`{ domain }`); lists bare or as `{ domains }`.

	async emailStatus(): Promise<{ org: EmailOrgView; settings: EmailSettingsView | null; raw: unknown }> {
		const raw = await this.request('GET', '/api/v1/email');
		const org = viewFrom<EmailOrgView>(raw, 'org', 'state');
		if (!org) throw new CliError('The platform returned an unexpected email status response.', { code: 'protocol', details: raw });
		const settings = asRecord(asRecord(raw)?.settings) as EmailSettingsView | null;
		return { org, settings, raw };
	}

	async listEmailDomains(): Promise<{ domains: EmailDomainView[]; raw: unknown }> {
		const raw = await this.request('GET', '/api/v1/email/domains');
		return { domains: listFrom<EmailDomainView>(raw, 'domains').map(withRecords), raw };
	}

	async getEmailDomain(name: string): Promise<{ domain: EmailDomainView; raw: unknown }> {
		const raw = await this.request('GET', `/api/v1/email/domains/${encodeURIComponent(name)}`);
		return { domain: emailDomainFrom(raw), raw };
	}

	async createEmailDomain(input: EmailDomainCreateInput): Promise<{ domain: EmailDomainView; raw: unknown }> {
		const raw = await this.request('POST', '/api/v1/email/domains', { body: input });
		return { domain: emailDomainFrom(raw), raw };
	}

	async checkEmailDomain(name: string): Promise<{ domain: EmailDomainView; raw: unknown }> {
		const raw = await this.request('POST', `/api/v1/email/domains/${encodeURIComponent(name)}/check`, { body: {} });
		return { domain: emailDomainFrom(raw), raw };
	}

	async deleteEmailDomain(name: string): Promise<unknown> {
		return this.request('DELETE', `/api/v1/email/domains/${encodeURIComponent(name)}`);
	}

	async sendEmail(input: EmailSendInput): Promise<{ result: EmailSendResult; raw: unknown }> {
		const raw = await this.request('POST', '/api/v1/email/send', { body: input });
		const result = viewFrom<EmailSendResult>(raw, 'message', 'accepted') ?? viewFrom<EmailSendResult>(raw, 'result', 'accepted');
		if (!result || typeof result.id !== 'string')
			throw new CliError('The platform returned an unexpected send response.', { code: 'protocol', details: raw });
		return { result: { ...result, accepted: stringArray(result.accepted), suppressed: stringArray(result.suppressed) }, raw };
	}

	async listEmailMessages(
		options: { limit?: number; before?: string; recipient?: string; status?: string } = {},
	): Promise<{ messages: EmailMessageView[]; raw: unknown }> {
		const params = new URLSearchParams();
		if (options.limit !== undefined) params.set('limit', String(options.limit));
		if (options.before) params.set('before', options.before);
		if (options.recipient) params.set('recipient', options.recipient);
		if (options.status) params.set('status', options.status);
		const query = params.size > 0 ? `?${params}` : '';
		const raw = await this.request('GET', `/api/v1/email/messages${query}`);
		return { messages: listFrom<EmailMessageView>(raw, 'messages').map(withRecipients), raw };
	}

	async getEmailMessage(id: string): Promise<{ message: EmailMessageView; events: EmailMessageEvent[]; raw: unknown }> {
		const raw = await this.request('GET', `/api/v1/email/messages/${encodeURIComponent(id)}`);
		const message = viewFrom<EmailMessageView>(raw, 'message', 'recipients');
		if (!message)
			throw new CliError('The platform returned an unexpected message response.', { code: 'protocol', details: raw });
		const events = (asArray(asRecord(raw)?.events) ?? asArray(asRecord(message)?.events) ?? []) as EmailMessageEvent[];
		return { message: withRecipients(message), events, raw };
	}

	async listEmailSuppressions(
		options: { limit?: number; address?: string } = {},
	): Promise<{ suppressions: EmailSuppressionView[]; raw: unknown }> {
		const params = new URLSearchParams();
		if (options.limit !== undefined) params.set('limit', String(options.limit));
		if (options.address) params.set('address', options.address);
		const query = params.size > 0 ? `?${params}` : '';
		const raw = await this.request('GET', `/api/v1/email/suppressions${query}`);
		return { suppressions: listFrom<EmailSuppressionView>(raw, 'suppressions'), raw };
	}

	async addEmailSuppression(input: { address: string; reason?: string }): Promise<{ suppression: EmailSuppressionView; raw: unknown }> {
		const raw = await this.request('POST', '/api/v1/email/suppressions', { body: input });
		const suppression = viewFrom<EmailSuppressionView>(raw, 'suppression', 'address');
		if (!suppression)
			throw new CliError('The platform returned an unexpected suppression response.', { code: 'protocol', details: raw });
		return { suppression, raw };
	}

	async removeEmailSuppression(address: string): Promise<unknown> {
		return this.request('DELETE', `/api/v1/email/suppressions/${encodeURIComponent(address)}`);
	}

	/** Sandbox recipients (EMAIL.md §4.3). */
	async listEmailAddresses(): Promise<{ addresses: EmailSandboxAddressView[]; raw: unknown }> {
		const raw = await this.request('GET', '/api/v1/email/addresses');
		return { addresses: listFrom<EmailSandboxAddressView>(raw, 'addresses'), raw };
	}

	/** Add a sandbox recipient (the server mails it a link), or re-send the link to a pending one. */
	async addEmailAddress(address: string): Promise<{ address: EmailSandboxAddressView; raw: unknown }> {
		const raw = await this.request('POST', '/api/v1/email/addresses', { body: { address } });
		const view = viewFrom<EmailSandboxAddressView>(raw, 'address', 'status');
		if (!view) throw new CliError('The platform returned an unexpected sandbox recipient response.', { code: 'protocol', details: raw });
		return { address: view, raw };
	}

	async removeEmailAddress(address: string): Promise<unknown> {
		return this.request('DELETE', `/api/v1/email/addresses/${encodeURIComponent(address)}`);
	}

	/** The org's latest production access request (EMAIL.md §7.3); null if it never asked. */
	async getEmailAccessRequest(): Promise<{ request: EmailAccessRequestView | null; raw: unknown }> {
		const raw = await this.request('GET', '/api/v1/email/access-request');
		return { request: viewFrom<EmailAccessRequestView>(raw, 'request', 'status'), raw };
	}

	async requestEmailAccess(input: EmailAccessRequestInput): Promise<{ request: EmailAccessRequestView; raw: unknown }> {
		const raw = await this.request('POST', '/api/v1/email/access-request', { body: input });
		const request = viewFrom<EmailAccessRequestView>(raw, 'request', 'status');
		if (!request) throw new CliError('The platform returned an unexpected access request response.', { code: 'protocol', details: raw });
		return { request, raw };
	}

	async listEmailCredentials(): Promise<{ credentials: EmailCredentialView[]; raw: unknown }> {
		const raw = await this.request('GET', '/api/v1/email/credentials');
		return {
			credentials: listFrom<EmailCredentialView>(raw, 'credentials').map((item) => ({
				...item,
				allowedFromDomains: stringArray(item.allowedFromDomains),
			})),
			raw,
		};
	}

	async createEmailCredential(input: EmailCredentialCreateInput): Promise<{ credential: EmailCredentialSecret; raw: unknown }> {
		const raw = await this.request('POST', '/api/v1/email/credentials', { body: input });
		const credential = viewFrom<EmailCredentialSecret>(raw, 'credential', 'password');
		if (!credential || !asRecord(credential.smtp))
			throw new CliError('The platform returned an unexpected credential response.', { code: 'protocol' });
		return { credential: { ...credential, allowedFromDomains: stringArray(credential.allowedFromDomains) }, raw };
	}

	async revokeEmailCredential(id: string): Promise<unknown> {
		return this.request('DELETE', `/api/v1/email/credentials/${encodeURIComponent(id)}`);
	}

	async attachEmail(
		project: string,
		input: { envPrefix?: string },
	): Promise<{ envPrefix: string | null; envNames: string[]; warning: string | null; raw: unknown }> {
		const raw = await this.request('POST', `/api/v1/projects/${encodeURIComponent(project)}/email`, { body: input });
		const record = asRecord(raw);
		const attachment = asRecord(record?.attachment) ?? record;
		return {
			envPrefix: stringValue(attachment?.envPrefix) ?? null,
			envNames: stringArray(attachment?.envNames),
			warning: stringValue(record?.warning) ?? null,
			raw,
		};
	}

	async detachEmail(project: string, envPrefix?: string): Promise<unknown> {
		const query = envPrefix ? `?envPrefix=${encodeURIComponent(envPrefix)}` : '';
		return this.request('DELETE', `/api/v1/projects/${encodeURIComponent(project)}/email${query}`);
	}

	// ---------------------------------------------------------------- queue brokers (D111)

	async listBrokers(options: { includeDeleted?: boolean } = {}): Promise<{ brokers: BrokerView[]; raw: unknown }> {
		const raw = await this.request('GET', `/api/v1/brokers${options.includeDeleted ? '?includeDeleted=1' : ''}`);
		return { brokers: ((asArray(asRecord(raw)?.brokers) ?? []) as BrokerView[]).map(withAttachments), raw };
	}

	async getBroker(name: string, options: { includeDeleted?: boolean } = {}): Promise<{ broker: BrokerView; raw: unknown }> {
		const raw = await this.request(
			'GET',
			`/api/v1/brokers/${encodeURIComponent(name)}${options.includeDeleted ? '?includeDeleted=1' : ''}`,
		);
		return { broker: brokerFrom(raw), raw };
	}

	async createBroker(input: BrokerCreateInput): Promise<{ broker: BrokerView; raw: unknown }> {
		const raw = await this.request('POST', '/api/v1/brokers', { body: input });
		return { broker: brokerFrom(raw), raw };
	}

	async updateBroker(name: string, input: BrokerUpdateInput): Promise<{ broker: BrokerView; raw: unknown }> {
		const raw = await this.request('PATCH', `/api/v1/brokers/${encodeURIComponent(name)}`, { body: input });
		return { broker: brokerFrom(raw), raw };
	}

	async deleteBroker(name: string): Promise<{ broker: BrokerView; raw: unknown }> {
		const raw = await this.request('DELETE', `/api/v1/brokers/${encodeURIComponent(name)}`);
		return { broker: brokerFrom(raw), raw };
	}

	async purgeBroker(name: string): Promise<unknown> {
		return this.request('DELETE', `/api/v1/brokers/${encodeURIComponent(name)}?purge=1`);
	}

	async restoreBroker(name: string): Promise<{ broker: BrokerView; raw: unknown }> {
		const raw = await this.request('POST', `/api/v1/brokers/${encodeURIComponent(name)}/restore`, { body: {} });
		return { broker: brokerFrom(raw), raw };
	}

	async restartBroker(name: string): Promise<{ broker: BrokerView; raw: unknown }> {
		const raw = await this.request('POST', `/api/v1/brokers/${encodeURIComponent(name)}/restart`, { body: {} });
		return { broker: brokerFrom(raw), raw };
	}

	/** Minute (or hourly) samples from the broker's node (D123); empty without the telemetry store. */
	async brokerMetrics(
		name: string,
		range: { from?: string; to?: string; interval?: string } = {},
	): Promise<{ points: BrokerMetricPoint[]; interval: string; raw: unknown }> {
		const query = new URLSearchParams();
		if (range.from) query.set('from', range.from);
		if (range.to) query.set('to', range.to);
		if (range.interval) query.set('interval', range.interval);
		const search = query.toString();
		const raw = await this.request('GET', `/api/v1/brokers/${encodeURIComponent(name)}/metrics${search ? `?${search}` : ''}`);
		const record = asRecord(raw) ?? {};
		return {
			points: (asArray(record.points) ?? []) as BrokerMetricPoint[],
			interval: stringValue(record.interval) ?? range.interval ?? '1m',
			raw,
		};
	}

	/** The newest JetStream stream listing (D123). */
	async brokerQueues(name: string): Promise<{ queues: BrokerQueuesView; raw: unknown }> {
		const raw = await this.request('GET', `/api/v1/brokers/${encodeURIComponent(name)}/queues`);
		const record = asRecord(raw);
		if (!record || !Array.isArray(record.streams))
			throw new CliError('The platform returned an unexpected queues response.', { code: 'protocol' });
		return { queues: record as unknown as BrokerQueuesView, raw };
	}

	async brokerCredentials(name: string): Promise<{ credentials: BrokerCredentials; raw: unknown }> {
		const raw = await this.request('GET', `/api/v1/brokers/${encodeURIComponent(name)}/credentials`);
		const credentials = asRecord(asRecord(raw)?.credentials);
		if (!credentials || typeof credentials.url !== 'string')
			throw new CliError('The platform returned an unexpected credentials response.', { code: 'protocol' });
		return { credentials: credentials as unknown as BrokerCredentials, raw };
	}

	async attachBroker(
		project: string,
		input: { broker: string; envPrefix?: string },
	): Promise<{ attachment: BrokerAttachmentView; warning: string | null; raw: unknown }> {
		const raw = await this.request('POST', `/api/v1/projects/${encodeURIComponent(project)}/brokers`, { body: input });
		const record = asRecord(raw);
		const attachment = asRecord(record?.attachment);
		if (!attachment || typeof attachment.brokerName !== 'string')
			throw new CliError('The platform returned an unexpected attachment response.', { code: 'protocol', details: raw });
		return {
			attachment: attachment as unknown as BrokerAttachmentView,
			warning: typeof record?.warning === 'string' ? record.warning : null,
			raw,
		};
	}

	async detachBroker(project: string, name: string): Promise<unknown> {
		return this.request(
			'DELETE',
			`/api/v1/projects/${encodeURIComponent(project)}/brokers/${encodeURIComponent(name)}`,
		);
	}

	async brokerLogs(
		name: string,
		options: { after?: number; limit?: number; level?: string; q?: string } = {},
	): Promise<{
		events: Array<{ seq: number; ts: number; level: string; stream: string; message: string }>;
		cursor: number;
		hasMore: boolean;
		raw: unknown;
	}> {
		const params = new URLSearchParams();
		if (options.after !== undefined) params.set('after', String(options.after));
		if (options.limit !== undefined) params.set('limit', String(options.limit));
		if (options.level) params.set('level', options.level);
		if (options.q) params.set('q', options.q);
		const query = params.size > 0 ? `?${params.toString()}` : '';
		const raw = await this.request('GET', `/api/v1/brokers/${encodeURIComponent(name)}/logs${query}`);
		const record = asRecord(raw);
		const events = (asArray(record?.events) ?? []).map((value) => {
			const event = asRecord(value) ?? {};
			return {
				seq: numberValue(event.seq) ?? 0,
				ts: numberValue(event.ts) ?? 0,
				level: stringValue(event.level) ?? 'info',
				stream: stringValue(event.stream) ?? 'stdout',
				message: stringValue(event.message) ?? '',
			};
		});
		return { events, cursor: numberValue(record?.cursor) ?? 0, hasMore: record?.hasMore === true, raw };
	}

	// ---------------------------------------------------------------- node tasks (D124)
	// Queue and function tools run on the service's node. Each call waits up to 20s for the
	// result, then polls `GET /node-tasks/:id` until it finishes (or `nodeTaskWaitMs` passes).

	/** Create a function queue's stream (`SKIFF_Q_<queue>`) now instead of on first use. */
	async brokerQueueCreate(name: string, queue: string): Promise<NodeTaskOutcome<BrokerQueueCreateResult>> {
		return this.nodeTask('POST', `/api/v1/brokers/${encodeURIComponent(name)}/queues`, { queue });
	}

	/** Publish a test message (or `count` copies) to a function queue. */
	async brokerQueueSend(name: string, queue: string, input: BrokerQueueSendInput): Promise<NodeTaskOutcome<BrokerQueueSendResult>> {
		return this.nodeTask(
			'POST',
			`/api/v1/brokers/${encodeURIComponent(name)}/queues/${encodeURIComponent(queue)}/messages`,
			input,
		);
	}

	/** Move messages from dead-letter queue `from` into `to`. */
	async brokerQueueRedrive(
		name: string,
		from: string,
		input: { to: string; limit?: number },
	): Promise<NodeTaskOutcome<BrokerQueueRedriveResult>> {
		return this.nodeTask(
			'POST',
			`/api/v1/brokers/${encodeURIComponent(name)}/queues/${encodeURIComponent(from)}/redrive`,
			input,
		);
	}

	/** Read messages without consuming them. */
	async brokerStreamPeek(
		name: string,
		stream: string,
		options: { limit?: number; from?: number } = {},
	): Promise<NodeTaskOutcome<BrokerStreamPeekResult>> {
		const query = new URLSearchParams();
		if (options.limit !== undefined) query.set('limit', String(options.limit));
		if (options.from !== undefined) query.set('from', String(options.from));
		const search = query.toString();
		return this.nodeTask(
			'GET',
			`/api/v1/brokers/${encodeURIComponent(name)}/streams/${encodeURIComponent(stream)}/messages${search ? `?${search}` : ''}`,
		);
	}

	/** Remove every message from a stream; the stream and its consumers stay. */
	async brokerStreamPurge(name: string, stream: string): Promise<NodeTaskOutcome<BrokerStreamPurgeResult>> {
		return this.nodeTask('POST', `/api/v1/brokers/${encodeURIComponent(name)}/streams/${encodeURIComponent(stream)}/purge`, {});
	}

	async brokerStreamDelete(name: string, stream: string): Promise<NodeTaskOutcome<BrokerStreamDeleteResult>> {
		return this.nodeTask('DELETE', `/api/v1/brokers/${encodeURIComponent(name)}/streams/${encodeURIComponent(stream)}`);
	}

	async brokerStreamDeleteMessage(
		name: string,
		stream: string,
		seq: number,
	): Promise<NodeTaskOutcome<BrokerStreamDeleteMessageResult>> {
		return this.nodeTask(
			'DELETE',
			`/api/v1/brokers/${encodeURIComponent(name)}/streams/${encodeURIComponent(stream)}/messages/${seq}`,
		);
	}

	/** One test HTTP request to the function's host on its node (no Caddy, no domains). */
	async functionInvoke(project: string, input: FunctionInvokeInput): Promise<NodeTaskOutcome<FunctionInvokeResult>> {
		return this.nodeTask('POST', `/api/v1/projects/${encodeURIComponent(project)}/function/invoke`, input);
	}

	/** Run the function's `scheduled()` handler now for one of its crons. */
	async functionScheduled(project: string, cron: string): Promise<NodeTaskOutcome<FunctionScheduledResult>> {
		return this.nodeTask('POST', `/api/v1/projects/${encodeURIComponent(project)}/function/scheduled`, { cron });
	}

	async getNodeTask(id: string, options: { waitSeconds?: number } = {}): Promise<{ task: NodeTaskView; raw: unknown }> {
		const raw = await this.request('GET', `/api/v1/node-tasks/${encodeURIComponent(id)}${waitQuery(options.waitSeconds)}`, {
			timeoutMs: waitTimeout(this.timeoutMs, options.waitSeconds),
		});
		return { task: nodeTaskFrom(raw), raw };
	}

	/**
	 * Start a node task and wait for its result: 200 is done, 502 `node_task_failed` is the node's
	 * failure, 202 means poll. A failed task becomes a CliError carrying the node's message.
	 */
	private async nodeTask<R>(method: string, path: string, body?: unknown): Promise<NodeTaskOutcome<R>> {
		const waitSeconds = NODE_TASK_POLL_SECONDS;
		const separator = path.includes('?') ? '&' : '?';
		const { response, url, text, parsed } = await this.exchange(method, `${path}${separator}wait=${waitSeconds}`, {
			...(body !== undefined ? { body } : {}),
			timeoutMs: waitTimeout(this.timeoutMs, waitSeconds),
		});
		const record = asRecord(parsed);
		if (response.status === 502 && record?.error === 'node_task_failed')
			throw nodeTaskError(stringValue(record.message) ?? stringValue(asRecord(record.task)?.error), record.task);
		if (!response.ok) throw apiError(response, method, url, text, parsed);
		let task = nodeTaskFrom(parsed);
		let raw = parsed;
		const deadline = Date.now() + this.nodeTaskWaitMs;
		while (!nodeTaskDone(task)) {
			const left = deadline - Date.now();
			if (left <= 0)
				throw new CliError(
					`Node ${task.target.nodeId} has not finished task ${task.id} (${task.status}) after ${Math.round(this.nodeTaskWaitMs / 1000)}s. It may still finish; its result is kept for an hour.`,
					{ code: 'node_task_timeout', details: task, suggestions: [`GET /api/v1/node-tasks/${task.id}`] },
				);
			({ task, raw } = await this.getNodeTask(task.id, { waitSeconds: Math.max(1, Math.min(waitSeconds, Math.ceil(left / 1000))) }));
		}
		if (task.status === 'failed') throw nodeTaskError(task.error ?? undefined, task);
		if (task.result === null || task.result === undefined)
			throw new CliError('The node finished the task without a result.', { code: 'protocol', details: raw });
		return { result: task.result as R, task: task as NodeTaskView<R>, raw };
	}

	async databaseCredentials(name: string): Promise<{ credentials: DatabaseCredentials; raw: unknown }> {
		const raw = await this.request('GET', `/api/v1/databases/${encodeURIComponent(name)}/credentials`);
		const credentials = asRecord(asRecord(raw)?.credentials);
		if (!credentials || typeof credentials.url !== 'string')
			throw new CliError('The platform returned an unexpected credentials response.', { code: 'protocol' });
		return { credentials: credentials as unknown as DatabaseCredentials, raw };
	}

	// Named credentials (docs/DATABASES.md §16): metadata everywhere except the audited reveal.
	private namedCredentialsPath(name: string, id?: string): string {
		const base = `/api/v1/databases/${encodeURIComponent(name)}/credentials/named`;
		return id ? `${base}/${encodeURIComponent(id)}` : base;
	}

	private namedCredential(raw: unknown): DatabaseCredentialView {
		const credential = asRecord(asRecord(raw)?.credential);
		if (!credential || typeof credential.id !== 'string')
			throw new CliError('The platform returned an unexpected credential response.', { code: 'protocol' });
		return credential as unknown as DatabaseCredentialView;
	}

	async listDatabaseCredentials(name: string): Promise<{ credentials: DatabaseCredentialView[]; raw: unknown }> {
		const raw = await this.request('GET', this.namedCredentialsPath(name));
		return { credentials: (asArray(asRecord(raw)?.credentials) ?? []) as DatabaseCredentialView[], raw };
	}

	async createDatabaseCredential(
		name: string,
		input: { role: DatabaseNamedCredentialRole; purpose?: string; expiresAt?: string },
	): Promise<{ credential: DatabaseCredentialView; raw: unknown }> {
		const raw = await this.request('POST', this.namedCredentialsPath(name), { body: input });
		return { credential: this.namedCredential(raw), raw };
	}

	async rotateDatabaseCredential(name: string, id: string): Promise<{ credential: DatabaseCredentialView; raw: unknown }> {
		const raw = await this.request('POST', `${this.namedCredentialsPath(name, id)}/rotate`, { body: {} });
		return { credential: this.namedCredential(raw), raw };
	}

	async revokeDatabaseCredential(name: string, id: string): Promise<{ credential: DatabaseCredentialView; raw: unknown }> {
		const raw = await this.request('DELETE', this.namedCredentialsPath(name, id));
		return { credential: this.namedCredential(raw), raw };
	}

	async revealDatabaseCredential(
		name: string,
		id: string,
	): Promise<{ credential: DatabaseCredentialView & { password: string }; raw: unknown }> {
		const raw = await this.request('GET', this.namedCredentialsPath(name, id));
		const credential = this.namedCredential(raw) as DatabaseCredentialView & { password?: unknown };
		if (typeof credential.password !== 'string')
			throw new CliError('The platform returned an unexpected credential response.', { code: 'protocol' });
		return { credential: credential as DatabaseCredentialView & { password: string }, raw };
	}

	async attachDatabase(
		project: string,
		input: { database: string; envPrefix?: string; credential?: string },
	): Promise<{ attachment: DatabaseAttachmentView; warning: string | null; raw: unknown }> {
		const raw = await this.request('POST', `/api/v1/projects/${encodeURIComponent(project)}/databases`, { body: input });
		const record = asRecord(raw) ?? {};
		const attachment = asRecord(record.attachment);
		if (!attachment) throw new CliError('The platform returned an unexpected attach response.', { code: 'protocol' });
		return {
			attachment: attachment as unknown as DatabaseAttachmentView,
			warning: stringValue(record.warning) ?? null,
			raw,
		};
	}

	async detachDatabase(project: string, name: string): Promise<unknown> {
		return this.request(
			'DELETE',
			`/api/v1/projects/${encodeURIComponent(project)}/databases/${encodeURIComponent(name)}`,
		);
	}

	// --- managed object storage (docs/OBJECT-STORAGE.md) ------------------------------------

	async listStorage(options: { includeDeleted?: boolean } = {}): Promise<{ storage: StorageView[]; raw: unknown }> {
		const raw = await this.request('GET', `/api/v1/storage${options.includeDeleted ? '?includeDeleted=1' : ''}`);
		return { storage: ((asArray(asRecord(raw)?.storage) ?? []) as StorageView[]).map(normalizeStorage), raw };
	}

	async getStorage(name: string, options: { includeDeleted?: boolean } = {}): Promise<{ storage: StorageView; raw: unknown }> {
		const raw = await this.request(
			'GET',
			`/api/v1/storage/${encodeURIComponent(name)}${options.includeDeleted ? '?includeDeleted=1' : ''}`,
		);
		return { storage: storageFrom(raw), raw };
	}

	async createStorage(input: StorageCreateInput): Promise<{ storage: StorageView; raw: unknown }> {
		const raw = await this.request('POST', '/api/v1/storage', { body: input });
		return { storage: storageFrom(raw), raw };
	}

	async storageLogs(
		name: string,
		options: { after?: number; limit?: number; level?: string; q?: string } = {},
	): Promise<{ events: Array<{ seq: number; ts: number; level: string; stream: string; message: string }>; cursor: number; hasMore: boolean; raw: unknown }> {
		const params = new URLSearchParams();
		if (options.after !== undefined) params.set('after', String(options.after));
		if (options.limit !== undefined) params.set('limit', String(options.limit));
		if (options.level) params.set('level', options.level);
		if (options.q) params.set('q', options.q);
		const query = params.size > 0 ? `?${params.toString()}` : '';
		const raw = await this.request('GET', `/api/v1/storage/${encodeURIComponent(name)}/logs${query}`);
		const record = asRecord(raw);
		const events = (asArray(record?.events) ?? []).map((value) => {
			const event = asRecord(value) ?? {};
			return {
				seq: numberValue(event.seq) ?? 0,
				ts: numberValue(event.ts) ?? 0,
				level: stringValue(event.level) ?? 'info',
				stream: stringValue(event.stream) ?? 'stdout',
				message: stringValue(event.message) ?? '',
			};
		});
		return {
			events,
			cursor: numberValue(record?.cursor) ?? 0,
			hasMore: record?.hasMore === true,
			raw,
		};
	}

	async restartStorage(name: string): Promise<{ storage: StorageView; raw: unknown }> {
		const raw = await this.request('POST', `/api/v1/storage/${encodeURIComponent(name)}/restart`);
		return { storage: storageFrom(raw), raw };
	}

	async updateStorage(name: string, input: StorageUpdateInput): Promise<{ storage: StorageView; raw: unknown }> {
		const raw = await this.request('PATCH', `/api/v1/storage/${encodeURIComponent(name)}`, { body: input });
		return { storage: storageFrom(raw), raw };
	}

	/** Soft delete (restorable for 7 days). */
	async deleteStorage(name: string): Promise<{ storage: StorageView; raw: unknown }> {
		const raw = await this.request('DELETE', `/api/v1/storage/${encodeURIComponent(name)}`);
		return { storage: storageFrom(raw), raw };
	}

	/** Permanently delete an instance that is already in the trash. */
	async purgeStorage(name: string): Promise<unknown> {
		return this.request('DELETE', `/api/v1/storage/${encodeURIComponent(name)}?purge=1`);
	}

	async restoreStorage(name: string): Promise<{ storage: StorageView; raw: unknown }> {
		const raw = await this.request('POST', `/api/v1/storage/${encodeURIComponent(name)}/restore`, { body: {} });
		return { storage: storageFrom(raw), raw };
	}

	async storageCredentials(name: string): Promise<{ credentials: StorageCredentials; raw: unknown }> {
		const raw = await this.request('GET', `/api/v1/storage/${encodeURIComponent(name)}/credentials`);
		const credentials = asRecord(asRecord(raw)?.credentials);
		if (!credentials || typeof credentials.secretAccessKey !== 'string')
			throw new CliError('The platform returned an unexpected credentials response.', { code: 'protocol' });
		return { credentials: credentials as unknown as StorageCredentials, raw };
	}

	// Named keys (plan 04b) and staged root key rotation (§5).

	async listStorageKeys(name: string): Promise<{ keys: StorageKeyView[]; raw: unknown }> {
		const raw = await this.request('GET', `/api/v1/storage/${encodeURIComponent(name)}/keys`);
		return { keys: ((asArray(asRecord(raw)?.keys) ?? []) as StorageKeyView[]).map(normalizeStorageKey), raw };
	}

	/** Create a named key; the response carries no secret (reveal it separately). */
	async createStorageKey(name: string, input: StorageKeyCreateInput): Promise<{ key: StorageKeyView; raw: unknown }> {
		const raw = await this.request('POST', `/api/v1/storage/${encodeURIComponent(name)}/keys`, { body: input });
		return { key: storageKeyFrom(raw), raw };
	}

	/** Reveal a named key's secret (audited; needs storage:credentials). */
	async revealStorageKey(name: string, id: string): Promise<{ key: StorageKeyReveal; raw: unknown }> {
		const raw = await this.request(
			'POST',
			`/api/v1/storage/${encodeURIComponent(name)}/keys/${encodeURIComponent(id)}/reveal`,
			{ body: {} },
		);
		const key = storageKeyFrom(raw) as StorageKeyReveal;
		if (typeof key.secretAccessKey !== 'string')
			throw new CliError('The platform returned an unexpected key response.', { code: 'protocol' });
		return { key, raw };
	}

	async revokeStorageKey(name: string, id: string): Promise<{ key: StorageKeyView; raw: unknown }> {
		const raw = await this.request('DELETE', `/api/v1/storage/${encodeURIComponent(name)}/keys/${encodeURIComponent(id)}`);
		return { key: storageKeyFrom(raw), raw };
	}

	/** Stage a new root key; RustFS restarts with it and the node confirms it. */
	async rotateStorageRootKey(name: string): Promise<{ storage: StorageView; raw: unknown }> {
		const raw = await this.request('POST', `/api/v1/storage/${encodeURIComponent(name)}/rotate-root`, { body: {} });
		return { storage: storageFrom(raw), raw };
	}

	async cancelStorageRootKeyRotation(name: string): Promise<{ storage: StorageView; raw: unknown }> {
		const raw = await this.request('DELETE', `/api/v1/storage/${encodeURIComponent(name)}/rotate-root`);
		return { storage: storageFrom(raw), raw };
	}

	/** Move to another node (D97). Objects are not copied, so this always sends `from: "empty"`. */
	async moveStorage(name: string, input: { node: string; storage?: string }): Promise<{ result: StorageMoveResult; raw: unknown }> {
		const raw = await this.request('POST', `/api/v1/storage/${encodeURIComponent(name)}/move`, {
			body: { node: input.node, ...(input.storage ? { storage: input.storage } : {}), from: 'empty' },
		});
		const record = asRecord(raw);
		if (!record || typeof record.storage !== 'string')
			throw new CliError('The platform returned an unexpected move response.', { code: 'protocol', details: raw });
		return {
			result: {
				...(record as unknown as StorageMoveResult),
				projects: (asArray(record.projects) ?? []) as string[],
				warnings: (asArray(record.warnings) ?? []) as string[],
			},
			raw,
		};
	}

	async storageMetrics(
		name: string,
		range: { from?: string; to?: string; interval?: string } = {},
	): Promise<{ points: StorageMetricPoint[]; interval: string; raw: unknown }> {
		const query = new URLSearchParams();
		if (range.from) query.set('from', range.from);
		if (range.to) query.set('to', range.to);
		if (range.interval) query.set('interval', range.interval);
		const search = query.toString();
		const suffix = search ? `?${search}` : '';
		const raw = await this.request('GET', `/api/v1/storage/${encodeURIComponent(name)}/metrics${suffix}`);
		const record = asRecord(raw) ?? {};
		return {
			points: (asArray(record.points) ?? []) as StorageMetricPoint[],
			interval: stringValue(record.interval) ?? range.interval ?? '1m',
			raw,
		};
	}

	async listBuckets(name: string): Promise<{ buckets: StorageBucketView[]; raw: unknown }> {
		const raw = await this.request('GET', `/api/v1/storage/${encodeURIComponent(name)}/buckets`);
		return { buckets: (asArray(asRecord(raw)?.buckets) ?? []) as StorageBucketView[], raw };
	}

	async createBucket(
		name: string,
		input: {
			name: string;
			access?: string;
			versioning?: boolean;
			lifecycle?: BucketConfigInput['lifecycle'];
			cors?: BucketConfigInput['cors'];
			quotaBytes?: number | null;
			objectLock?: { mode: 'governance' | 'compliance'; retainDays: number } | null;
		},
	): Promise<{ bucket: StorageBucketView; raw: unknown }> {
		const raw = await this.request('POST', `/api/v1/storage/${encodeURIComponent(name)}/buckets`, { body: input });
		return { bucket: bucketFrom(raw), raw };
	}

	async updateBucket(
		name: string,
		bucket: string,
		input: BucketConfigInput,
	): Promise<{ bucket: StorageBucketView; raw: unknown }> {
		const raw = await this.request(
			'PATCH',
			`/api/v1/storage/${encodeURIComponent(name)}/buckets/${encodeURIComponent(bucket)}`,
			{ body: input },
		);
		return { bucket: bucketFrom(raw), raw };
	}

	/** The desired configuration plus the node's last convergence report. */
	async getBucketConfig(name: string, bucket: string): Promise<{ config: StorageBucketView; raw: unknown }> {
		const raw = await this.request(
			'GET',
			`/api/v1/storage/${encodeURIComponent(name)}/buckets/${encodeURIComponent(bucket)}/config`,
		);
		return { config: bucketFrom({ bucket: asRecord(raw)?.config }), raw };
	}

	/** Mint a signed share link; the response never contains a key. */
	async signObject(
		name: string,
		bucket: string,
		input: { key: string; method?: 'GET' | 'PUT'; expiresIn?: number; maxDownloads?: number },
	): Promise<StorageShareLink> {
		return (await this.request(
			'POST',
			`/api/v1/storage/${encodeURIComponent(name)}/buckets/${encodeURIComponent(bucket)}/sign`,
			{
				body: {
					key: input.key,
					method: input.method ?? 'GET',
					...(input.expiresIn ? { expiresIn: input.expiresIn } : {}),
					...(input.maxDownloads ? { maxDownloads: input.maxDownloads } : {}),
				},
			},
		)) as StorageShareLink;
	}

	/** Ask the node to delete a bucket; `force` empties it first. */
	async deleteBucket(
		name: string,
		bucket: string,
		options: { force?: boolean } = {},
	): Promise<{ bucket: StorageBucketView; raw: unknown }> {
		const raw = await this.request(
			'DELETE',
			`/api/v1/storage/${encodeURIComponent(name)}/buckets/${encodeURIComponent(bucket)}${options.force ? '?force=1' : ''}`,
		);
		return { bucket: bucketFrom(raw), raw };
	}

	async attachStorage(
		project: string,
		input: { storage: string; envPrefix?: string; grants: StorageGrant[] },
	): Promise<{ attachment: StorageAttachmentView; warning: string | null; raw: unknown }> {
		const raw = await this.request('POST', `/api/v1/projects/${encodeURIComponent(project)}/storage`, { body: input });
		const record = asRecord(raw) ?? {};
		return { attachment: storageAttachmentFrom(record.attachment), warning: stringValue(record.warning) ?? null, raw };
	}

	/** Replace an attachment's bucket grants. */
	async updateStorageGrants(
		project: string,
		name: string,
		grants: StorageGrant[],
	): Promise<{ attachment: StorageAttachmentView; raw: unknown }> {
		const raw = await this.request(
			'PATCH',
			`/api/v1/projects/${encodeURIComponent(project)}/storage/${encodeURIComponent(name)}`,
			{ body: { grants } },
		);
		return { attachment: storageAttachmentFrom(asRecord(raw)?.attachment), raw };
	}

	async detachStorage(project: string, name: string): Promise<unknown> {
		return this.request('DELETE', `/api/v1/projects/${encodeURIComponent(project)}/storage/${encodeURIComponent(name)}`);
	}

	// --- object browser (D81) -------------------------------------------------

	async listObjects(
		name: string,
		options: { bucket: string; prefix?: string; token?: string; limit?: number },
	): Promise<StorageObjectList> {
		const params = new URLSearchParams({ bucket: options.bucket });
		if (options.prefix) params.set('prefix', options.prefix);
		if (options.token) params.set('token', options.token);
		if (options.limit) params.set('limit', String(options.limit));
		return (await this.request(
			'GET',
			`/api/v1/storage/${encodeURIComponent(name)}/objects?${params.toString()}`,
		)) as StorageObjectList;
	}

	async downloadObject(name: string, bucket: string, key: string): Promise<{ body: Uint8Array; contentType: string | null }> {
		const params = new URLSearchParams({ bucket, key });
		const response = await this.binaryRequest(
			'GET',
			`/api/v1/storage/${encodeURIComponent(name)}/objects/item?${params.toString()}`,
		);
		return {
			body: new Uint8Array(await response.arrayBuffer()),
			contentType: response.headers.get('content-type'),
		};
	}

	async uploadObject(
		name: string,
		bucket: string,
		key: string,
		body: Uint8Array,
		contentType = 'application/octet-stream',
	): Promise<StorageObjectStat> {
		const params = new URLSearchParams({ bucket, key });
		const response = await this.binaryRequest(
			'PUT',
			`/api/v1/storage/${encodeURIComponent(name)}/objects/item?${params.toString()}`,
			{
				body: body.slice().buffer as ArrayBuffer,
				headers: { 'content-type': contentType },
			},
		);
		const payload = asRecord(await response.json().catch(() => ({})));
		const object = asRecord(payload?.object);
		if (!object) throw new CliError('The control plane did not return the uploaded object.');
		return {
			key: stringValue(object.key) ?? key,
			sizeBytes: numberValue(object.sizeBytes ?? object.size_bytes ?? body.byteLength) ?? body.byteLength,
			etag: stringValue(object.etag) ?? null,
			lastModified: stringValue(object.lastModified ?? object.last_modified) ?? null,
			storageClass: stringValue(object.storageClass ?? object.storage_class) ?? null,
			contentType: stringValue(object.contentType ?? object.content_type) ?? contentType,
		};
	}

	async deleteObjects(name: string, bucket: string, keys: string[]): Promise<StorageObjectDeleteResult> {
		return (await this.request(
			'POST',
			`/api/v1/storage/${encodeURIComponent(name)}/objects/delete?bucket=${encodeURIComponent(bucket)}`,
			{ body: { keys } },
		)) as StorageObjectDeleteResult;
	}

	async createObjectFolder(name: string, bucket: string, prefix: string): Promise<{ prefix: string }> {
		return (await this.request(
			'POST',
			`/api/v1/storage/${encodeURIComponent(name)}/objects/folder?bucket=${encodeURIComponent(bucket)}`,
			{ body: { prefix } },
		)) as { prefix: string };
	}

	async presignObject(
		name: string,
		bucket: string,
		key: string,
		options: { method?: 'GET' | 'PUT'; expiresIn?: number } = {},
	): Promise<{ url: string; method: string; expiresIn: number }> {
		return (await this.request(
			'POST',
			`/api/v1/storage/${encodeURIComponent(name)}/objects/presign`,
			{
				body: {
					bucket,
					key,
					method: options.method ?? 'GET',
					...(options.expiresIn ? { expiresIn: options.expiresIn } : {}),
				},
			},
		)) as { url: string; method: string; expiresIn: number };
	}

	private async binaryRequest(
		method: string,
		path: string,
		options: { body?: ArrayBuffer; headers?: Record<string, string> } = {},
	): Promise<Response> {
		const url = `${this.baseUrl}${path}`;
		let response: Response;
		try {
			response = await this.fetchImpl(url, {
				method,
				headers: this.headers(options.headers),
				...(options.body ? { body: options.body } : {}),
				signal: AbortSignal.timeout(this.uploadTimeoutMs),
			});
		} catch (error) {
			if (isTimeout(error))
				throw new CliError(`Request to ${this.baseUrl} timed out.`, { code: 'timeout', cause: error });
			throw new CliError(`Could not reach ${this.baseUrl}: ${errorMessage(error)}`, {
				code: 'network',
				cause: error,
			});
		}
		if (!response.ok) {
			const text = await response.text().catch(() => '');
			throw apiError(response, method, url, text, parseJson(text));
		}
		return response;
	}

	private headers(extra: Record<string, string> = {}): Headers {
		return new Headers({
			accept: 'application/json, text/plain',
			authorization: `Bearer ${this.token}`,
			origin: this.origin,
			'user-agent': this.userAgent,
			...extra,
		});
	}

	private async request(
		method: string,
		path: string,
		options: { body?: unknown; headers?: Record<string, string>; timeoutMs?: number } = {},
	): Promise<unknown> {
		const { response, url, text, parsed } = await this.exchange(method, path, options);
		if (!response.ok) throw apiError(response, method, url, text, parsed);
		if (!text) return null;
		return parsed === undefined ? text : parsed;
	}

	/** One JSON request whose status the caller inspects; only network failures throw. */
	private async exchange(
		method: string,
		path: string,
		options: { body?: unknown; headers?: Record<string, string>; timeoutMs?: number } = {},
	): Promise<{ response: Response; url: string; text: string; parsed: unknown }> {
		const url = `${this.baseUrl}${path}`;
		const headers = this.headers(options.headers);
		const timeoutMs = options.timeoutMs ?? this.timeoutMs;
		let body: string | undefined;
		if (options.body !== undefined) {
			headers.set('content-type', 'application/json');
			body = JSON.stringify(options.body);
		}

		let response: Response;
		try {
			response = await this.fetchImpl(url, {
				method,
				headers,
				body,
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch (error) {
			if (isTimeout(error))
				throw new CliError(`Request to ${this.baseUrl} timed out after ${timeoutMs}ms.`, {
					code: 'timeout',
					cause: error,
				});
			throw new CliError(`Could not reach ${this.baseUrl}: ${errorMessage(error)}`, {
				code: 'network',
				cause: error,
			});
		}

		const text = await response.text().catch(() => '');
		return { response, url, text, parsed: parseJson(text) };
	}
}

function normalizeProject(value: unknown, fallbackSlug?: string): ProjectView | null {
	const record = asRecord(unwrap(value));
	if (!record) return null;
	const slug = stringValue(record.slug ?? record.projectSlug ?? record.project_slug) ?? fallbackSlug;
	if (!slug) return null;
	return {
		id: stringValue(record.id),
		slug,
		name: stringValue(record.name),
		runtime: stringValue(record.runtime),
		placement: stringValue(record.placement),
		productionDeploymentId:
			stringValue(record.productionDeploymentId ?? record.production_deployment_id) ?? null,
		productionUrl: stringValue(record.productionUrl ?? record.production_url ?? record.url),
		previewPattern: stringValue(record.previewPattern ?? record.preview_pattern),
		productionAccess: stringValue(record.productionAccess ?? record.production_access),
		previewAccess: stringValue(record.previewAccess ?? record.preview_access),
		createdAt: stringValue(record.createdAt ?? record.created_at),
		updatedAt: stringValue(record.updatedAt ?? record.updated_at),
		deletedAt: stringValue(record.deletedAt ?? record.deleted_at),
		purgeAt: stringValue(record.purgeAt ?? record.purge_at),
	};
}

function apiError(response: Response, method: string, url: string, text: string, parsed: unknown): ApiError {
	const details = extractError(parsed, text);
	return new ApiError(`${method} ${new URL(url).pathname} failed (${response.status}): ${details.message}`, {
		status: response.status,
		method,
		url: redactUrl(url),
		code: details.code,
		suggestions: details.suggestions,
		requestId: response.headers.get('x-request-id') ?? response.headers.get('request-id') ?? undefined,
		body: parsed ?? (text ? text.slice(0, 1000) : undefined),
	});
}

/** Seconds each node-task request holds for a result (the server caps it at 25). */
const NODE_TASK_POLL_SECONDS = 20;

export interface NodeTaskOutcome<R> {
	result: R;
	task: NodeTaskView<R>;
	/** The final `{ task }` response, for `--json`. */
	raw: unknown;
}

function nodeTaskFrom(raw: unknown): NodeTaskView {
	const task = asRecord(asRecord(raw)?.task);
	if (!task || typeof task.id !== 'string' || typeof task.status !== 'string')
		throw new CliError('The platform returned an unexpected node task response.', { code: 'protocol', details: raw });
	const target = asRecord(task.target) ?? {};
	return {
		...(task as unknown as NodeTaskView),
		target: {
			type: target.type === 'workload' ? 'workload' : 'broker',
			name: stringValue(target.name) ?? '',
			nodeId: stringValue(target.nodeId) ?? '',
		},
		result: task.result ?? null,
		error: typeof task.error === 'string' ? task.error : null,
	};
}

function nodeTaskError(message: string | undefined, task: unknown): CliError {
	return new CliError(message ?? 'The task failed on the node.', { code: 'node_task_failed', details: task });
}

/** Create/apply/cancel return the view itself; `GET /operations/:id` wraps it in `{ operation }`. */
function blueprintRunFrom(raw: unknown): BlueprintRunView {
	const run = asRecord(asRecord(raw)?.run);
	if (!run || typeof run.operationId !== 'string' || typeof run.status !== 'string')
		throw new CliError('The platform returned an unexpected blueprint run.', { code: 'protocol', details: raw });
	return { ...(run as unknown as BlueprintRunView), resources: (asArray(run.resources) ?? []) as BlueprintRunView['resources'] };
}

function operationFrom(raw: unknown): OperationView {
	const record = asRecord(raw);
	const view = asRecord(record?.operation) ?? record;
	if (!view || typeof view.id !== 'string' || typeof view.status !== 'string')
		throw new CliError('The platform returned an unexpected operation response.', { code: 'protocol', details: raw });
	const summary = asRecord(view.summary) ?? {};
	return {
		...(view as unknown as OperationView),
		summary: {
			verdicts: asRecord(summary.verdicts) ?? {},
			statuses: asRecord(summary.statuses) ?? {},
			flags: asRecord(summary.flags) ?? {},
			...(asRecord(summary.categories) ? { categories: asRecord(summary.categories)! } : {}),
			freedBytes: numberValue(summary.freedBytes) ?? 0,
		} as OperationView['summary'],
	};
}

/** Database endpoints wrap the view in `{ database }`. */
function brokerFrom(raw: unknown): BrokerView {
	const view = asRecord(asRecord(raw)?.broker);
	if (!view || typeof view.name !== 'string')
		throw new CliError('The platform returned an unexpected broker response.', { code: 'protocol', details: raw });
	return withAttachments(view as unknown as BrokerView);
}

function emailDomainFrom(raw: unknown): EmailDomainView {
	const view = viewFrom<EmailDomainView>(raw, 'domain', 'records');
	if (!view || typeof view.name !== 'string')
		throw new CliError('The platform returned an unexpected email domain response.', { code: 'protocol', details: raw });
	return withRecords(view);
}

function withRecords(view: EmailDomainView): EmailDomainView {
	return {
		...view,
		records: ((asArray(view.records) ?? []) as EmailDomainView['records']).map((record) => ({
			...record,
			found: stringArray(record.found),
		})),
	};
}

function withRecipients(view: EmailMessageView): EmailMessageView {
	return { ...view, recipients: (asArray(view.recipients) ?? []) as EmailMessageView['recipients'] };
}

function withAttachments(view: BrokerView): BrokerView {
	return { ...view, attachments: (asArray(view.attachments) ?? []) as BrokerAttachmentView[] };
}

function databaseFrom(raw: unknown): DatabaseView {
	const view = asRecord(asRecord(raw)?.database);
	if (!view || typeof view.name !== 'string')
		throw new CliError('The platform returned an unexpected database response.', { code: 'protocol', details: raw });
	return {
		...(view as unknown as DatabaseView),
		attachments: (asArray(view.attachments) ?? []) as DatabaseAttachmentView[],
		tables: (asArray(view.tables) ?? []) as DatabaseView['tables'],
	};
}

/** Storage endpoints wrap the view in `{ storage }`. */
function storageFrom(raw: unknown): StorageView {
	const view = asRecord(asRecord(raw)?.storage);
	if (!view || typeof view.name !== 'string')
		throw new CliError('The platform returned an unexpected storage response.', { code: 'protocol', details: raw });
	return normalizeStorage(view as unknown as StorageView);
}

function normalizeStorage(view: StorageView): StorageView {
	return {
		...view,
		buckets: (asArray(view.buckets) ?? []) as StorageBucketView[],
		attachments: ((asArray(view.attachments) ?? []) as StorageAttachmentView[]).map((item) => ({
			...item,
			grants: (asArray(item.grants) ?? []) as StorageGrant[],
		})),
	};
}

function storageKeyFrom(raw: unknown): StorageKeyView {
	const key = asRecord(asRecord(raw)?.key);
	if (!key || typeof key.id !== 'string')
		throw new CliError('The platform returned an unexpected key response.', { code: 'protocol', details: raw });
	return normalizeStorageKey(key as unknown as StorageKeyView);
}

function normalizeStorageKey(key: StorageKeyView): StorageKeyView {
	return { ...key, grants: (asArray(key.grants) ?? []) as StorageGrant[] };
}

function bucketFrom(raw: unknown): StorageBucketView {
	const bucket = asRecord(asRecord(raw)?.bucket);
	if (!bucket || typeof bucket.name !== 'string')
		throw new CliError('The platform returned an unexpected bucket response.', { code: 'protocol', details: raw });
	return bucket as unknown as StorageBucketView;
}

function storageAttachmentFrom(raw: unknown): StorageAttachmentView {
	const attachment = asRecord(raw);
	if (!attachment) throw new CliError('The platform returned an unexpected attach response.', { code: 'protocol' });
	return {
		...(attachment as unknown as StorageAttachmentView),
		envNames: (asArray(attachment.envNames) ?? []) as string[],
		grants: (asArray(attachment.grants) ?? []) as StorageGrant[],
	};
}

function waitQuery(seconds: number | undefined): string {
	if (!seconds || seconds <= 0) return '';
	return `?wait=${Math.min(Math.ceil(seconds), 25)}`;
}

/** A waiting request may legitimately take `wait` seconds before the server answers. */
function waitTimeout(base: number, seconds: number | undefined): number {
	return seconds && seconds > 0 ? Math.max(base, Math.min(seconds, 25) * 1000 + 15_000) : base;
}

function normalizeDeployment(
	value: unknown,
	options: { projectSlug?: string; productionDeploymentId?: string | null } = {},
): DeploymentView | null {
	const record = asRecord(unwrap(value));
	if (!record) return null;
	const id = stringValue(record.id ?? record.deploymentId ?? record.deployment_id);
	const shortId = stringValue(record.shortId ?? record.short_id);
	if (!id && !shortId) return null;
	const previewHost = stringValue(record.previewHost ?? record.preview_host);
	const previewUrl =
		stringValue(record.previewUrl ?? record.preview_url) ??
		(previewHost ? `https://${previewHost}` : undefined);
	return {
		id,
		shortId,
		status: stringValue(record.status),
		message: stringValue(record.message),
		url: stringValue(record.url ?? record.deploymentUrl ?? record.deployment_url),
		previewUrl,
		previewHost,
		productionUrl: stringValue(record.productionUrl ?? record.production_url),
		projectSlug:
			stringValue(record.projectSlug ?? record.project_slug) ??
			stringValue(asRecord(record.project)?.slug) ??
			options.projectSlug,
		pinned: booleanValue(record.pinned),
		production:
			booleanValue(record.production ?? record.isProduction ?? record.is_production) ??
			(options.productionDeploymentId ? id === options.productionDeploymentId : undefined),
		createdAt: stringValue(record.createdAt ?? record.created_at),
		activatedAt: stringValue(record.activatedAt ?? record.activated_at),
	};
}

function normalizeNode(value: unknown): NodeView | null {
	const record = asRecord(unwrap(value));
	if (!record) return null;
	const name = stringValue(record.name ?? record.nodeName ?? record.node_name ?? record.hostname);
	const id = stringValue(record.id ?? record.nodeId ?? record.node_id);
	if (!name && !id) return null;
	return {
		id,
		name,
		status: stringValue(record.status),
		version: stringValue(record.version ?? record.agentVersion ?? record.agent_version),
		lastHeartbeat: stringValue(
			record.lastHeartbeat ?? record.last_heartbeat ?? record.lastSeen ?? record.last_seen,
		),
		cpuPercent: numberValue(record.cpuPercent ?? record.cpu_percent ?? record.cpu),
		memoryUsedBytes: numberValue(
			record.memoryUsedBytes ?? record.memory_used_bytes ?? record.memoryUsed,
		),
		memoryTotalBytes: numberValue(
			record.memoryTotalBytes ?? record.memory_total_bytes ?? record.memoryTotal,
		),
		diskUsedPercent: numberValue(
			record.diskUsedPercent ?? record.disk_used_percent ?? record.diskPercent,
		),
	};
}

function normalizeOutcome(
	value: unknown,
	options: { projectSlug?: string; requestedPromote?: boolean },
): FinalizeOutcome {
	const record = asRecord(unwrap(value)) ?? {};
	const project = normalizeProject(record.project, options.projectSlug);
	const deploymentRecord =
		asRecord(record.deployment) ??
		(asRecord(record.result)?.deployment as Record<string, unknown> | undefined) ??
		(record.id || record.deploymentId || record.deployment_id ? record : undefined);
	const deployment = deploymentRecord
		? normalizeDeployment(deploymentRecord, {
				projectSlug: project?.slug ?? options.projectSlug,
				productionDeploymentId: project?.productionDeploymentId,
			})
		: undefined;

	const promotedValue =
		booleanValue(record.promoted) ??
		booleanValue(deploymentRecord?.promoted) ??
		(deployment?.id && project?.productionDeploymentId
			? deployment.id === project.productionDeploymentId
			: undefined) ??
		options.requestedPromote ??
		false;

	let previewUrl = deployment?.previewUrl;
	if (!previewUrl && project?.previewPattern && (deployment?.shortId || deployment?.id)) {
		previewUrl = project.previewPattern
			.replace('<id>', deployment.shortId ?? deployment.id ?? '')
			.replace('<shortid>', deployment.shortId ?? deployment.id ?? '');
	}

	const productionUrl =
		stringValue(record.productionUrl ?? record.production_url) ??
		deployment?.productionUrl ??
		project?.productionUrl ??
		(promotedValue && deployment?.url ? deployment.url : undefined);

	const nextSteps = stringArray(
		record.nextSteps ?? record.next_steps ?? asRecord(record.result)?.nextSteps,
	);

	return {
		deployment: deployment ?? undefined,
		project: project ?? undefined,
		nextSteps,
		promoted: promotedValue,
		deploymentUrl: deployment?.url ?? previewUrl ?? productionUrl,
		previewUrl,
		productionUrl,
		raw: value,
	};
}

function unwrap(value: unknown): unknown {
	const record = asRecord(value);
	if (record && 'data' in record && Object.keys(record).length === 1) return record.data;
	return value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] | null {
	return Array.isArray(value) ? value : null;
}

function stringValue(value: unknown): string | undefined {
	if (typeof value === 'string' && value.length > 0) return value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	return undefined;
}

function numberValue(value: unknown): number | undefined {
	const num = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
	return Number.isFinite(num) ? num : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
	return typeof value === 'boolean' ? value : undefined;
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function parseJson(text: string): unknown {
	if (!text) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function extractError(
	parsed: unknown,
	text: string,
): { message: string; code?: string; suggestions: string[] } {
	const record = asRecord(unwrap(parsed));
	if (!record) {
		const trimmed = text.trim();
		return { message: trimmed ? trimmed.slice(0, 500) : 'Unknown error.', suggestions: [] };
	}
	const errorField = record.error;
	const errorString = typeof errorField === 'string' ? errorField : undefined;
	const nested = asRecord(errorField);
	const source = nested ?? record;
	const issues = asArray(record.issues ?? nested?.issues ?? asRecord(record.details)?.issues) ?? [];
	const issueMessage = issues
		.map((issue) => stringValue(asRecord(issue)?.message))
		.filter((value): value is string => Boolean(value))
		.join('; ');
	const message =
		stringValue(source.message) ??
		stringValue(record.message) ??
		stringValue(record.detail) ??
		(issueMessage || undefined) ??
		errorString ??
		'Unknown error.';
	const code = errorString ?? stringValue(nested?.code ?? record.code ?? record.errorCode);
	const suggestions = stringArray(
		source.suggestions ??
			record.suggestions ??
			asRecord(source.details)?.suggestions ??
			asRecord(record.details)?.suggestions,
	);
	return { message, code, suggestions };
}

function isTimeout(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return error.name === 'TimeoutError' || error.name === 'AbortError' || /timed out/i.test(error.message);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function redactUrl(value: string): string {
	try {
		const url = new URL(value);
		url.search = '';
		url.hash = '';
		return url.toString();
	} catch {
		return value;
	}
}

function isPresent<T>(value: T | null): value is T {
	return value !== null;
}

function timestamp(value: string | undefined): number {
	if (!value) return 0;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : 0;
}
