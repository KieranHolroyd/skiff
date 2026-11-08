import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
	McpServer,
	acceptedContent,
	createMcpHandler,
	inputRequired,
	isInputRequiredResult,
	type AuthInfo,
	type ScopeChallengeHandler,
	type StandardSchemaWithJSON,
	type ToolAnnotations,
	type ToolCallback,
} from '@modelcontextprotocol/server';
import * as z from 'zod';
import {
	backupTargetCreateSchema,
	jobCommandSchema,
	jobConcurrencyPolicies,
	jobCreateSchema,
	jobRunDone,
	jobTimeoutSchema,
	jobUpdateSchema,
	type JobRunView,
	appVolumeAttachSchema,
	appVolumeDetachSchema,
	appVolumeRestoreSchema,
	appVolumeSnapshotCreateSchema,
	bucketCreateSchema,
	bucketUpdateSchema,
	bucketNameSchema,
	brokerAttachSchema,
	brokerCreateSchema,
	eventDeliveryStatuses,
	eventRuleCreateSchema,
	type EventRuleView,
	brokerUpdateSchema,
	databaseAttachSchema,
	databaseBackupCreateSchema,
	databaseBackupPolicySchema,
	databasePitrBackupSchema,
	databasePitrPolicySchema,
	databasePitrRestoreSchema,
	databaseCreateSchema,
	databaseRestartSchema,
	databaseReplicaCreateSchema,
	databaseRestoreSchema,
	databaseUpdateSchema,
	databaseRotateSchema,
	databaseCredentialCreateSchema,
	serviceRestartSchema,
	deployFilesSchema,
	deploySiteSchema,
	effectivePermissions,
	environmentCreateSchema,
	inlineFileSchema,
	isTerminalOperation,
	limits,
	operationLimits,
	projectCreateSchema,
	projectUpdateSchema,
	requirePermission,
	setAccessSchema,
	shareLinkCreateSchema,
	storageAttachSchema,
	storageKeyCreateSchema,
	storageCreateSchema,
	storageObjectKeySchema,
	workloadSpecSchema,
	planStackInputSchema,
	applyStackInputSchema,
	getTaskInputSchema,
	dashboardTemplateIds,
	dashboardTemplates,
	dashboardVariableSchema,
	panelDraftSchema,
	panelOptionsSchema,
	panelQuerySchema,
	panelSizes,
	vizTypes,
	alertMatcherSchema,
	alertRuleInputSchema,
	alertRuleTemplate,
	alertRuleTemplates,
	type AlertInstanceView,
	type AlertRuleSummary,
	type DashboardPanel,
	type DashboardView,
	type DatabaseMetricPoint,
	type DatabaseView,
	type DatabaseReplicaView,
	type DatabaseCredentialView,
	EMAIL_MAX_RECIPIENTS,
	EMAIL_SANDBOX_ADDRESS_LIMITS,
	emailEventKinds,
	emailSandboxAddressCreateSchema,
	type EmailSandboxAddressView,
	functionQueueNameSchema,
	functionRequestMethods,
	jetStreamNameSchema,
	nodeTaskLimits,
	queueMessageContentTypes,
	type NodeTaskResultMap,
	type NodeTaskView,
	emailSendSchema,
	type EmailDomainView,
	type FeatureName,
	type StorageGrant,
	type BrokerMetricPoint,
	type StorageMetricPoint,
	type StorageView,
	type StorageKeyView,
	type OperationView,
	type Permission,
	type Principal,
	type Role,
	logDrainFormats,
	logDrainKinds,
	logDrainLevels,
	logDrainSources,
	type LogDrainView,
} from '@skiff/contracts';
import { featureEnabled, parseAuditTime } from '@skiff/core';
import { authSecret } from './config';
import { core } from './core';
import { principalFromMcp } from './principal';
import { consoleJson } from './container-console';
import { containerConsoleDeps } from './container-console-deps';
import { pipelineTools } from './mcp-pipelines';

/**
 * Skiff's MCP server (DESIGN §6.3, D11, D29, D35).
 *
 * Every tool calls the service layer — never the database — so permissions and behaviour match
 * the dashboard, REST API and CLI. Scopes are RBAC permissions; a token missing one gets a
 * `403 insufficient_scope` challenge so the client re-authorizes and the user explicitly grants it.
 */

type PrincipalResult = Principal;

/** `assistant` runs the same tools behind the dashboard chat, where the UI owns confirmation. */
export type SkiffToolEra = 'legacy' | 'modern' | 'assistant';

/** A registered Skiff tool, captured for the in-dashboard assistant (docs/ASSISTANT.md). */
export interface SkiffToolDefinition {
	name: string;
	config: Record<string, unknown> & {
		title?: string;
		description?: string;
		inputSchema?: z.ZodType;
		annotations?: {
			readOnlyHint?: boolean;
			destructiveHint?: boolean;
			idempotentHint?: boolean;
		};
	};
	handler: (...args: unknown[]) => unknown;
}

/**
 * `registerTool` for a tool that is only offered while a platform feature flag is on
 * (`feature: 'EMAIL'`); `buildServer`'s `tool` skips it entirely when the flag is off.
 */
type FeatureGatedTool = <
	OutputArgs extends StandardSchemaWithJSON,
	InputArgs extends StandardSchemaWithJSON | undefined = undefined,
>(
	name: string,
	config: {
		title?: string;
		description?: string;
		inputSchema?: InputArgs;
		outputSchema?: OutputArgs;
		annotations?: ToolAnnotations;
		scopeChallenge?: ScopeChallengeHandler;
		_meta?: Record<string, unknown>;
		feature: FeatureName;
	},
	cb: ToolCallback<InputArgs>,
) => unknown;

function principalFor(authInfo: AuthInfo | undefined): PrincipalResult {
	const principal = principalFromMcp(authInfo, new Request('https://mcp.local/mcp'));
	if (!principal) throw new Error('Unauthenticated MCP request');
	return principal;
}

/**
 * Ask the client to step up its grant when the token lacks a permission the tool needs.
 * The challenge lists the *complete* scope set (existing + required) per RFC 6750.
 */
const requires =
	(...needed: Permission[]): ScopeChallengeHandler =>
	({ authInfo }) => {
		const granted = new Set(authInfo?.scopes ?? []);
		const missing = needed.filter((permission) => !granted.has(permission));
		if (missing.length === 0) return undefined;
		return {
			scopes: [...new Set([...granted, ...missing])] as [string, ...string[]],
			errorDescription: `This tool needs ${missing.join(', ')}. Re-authorize to grant it.`,
		};
	};

/** `requires` plus permissions that depend on the call's arguments (e.g. attaching on create). */
const requiresWith =
	(base: Permission[], extra: (args: Record<string, unknown>) => Permission[]): ScopeChallengeHandler =>
	(context) => {
		const args = (context.request.params as { arguments?: unknown } | undefined)?.arguments;
		const record = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
		return requires(...base, ...extra(record))(context);
	};

const round = (value: number, digits: number) => Number(value.toFixed(digits));

/**
 * Last-hour health for `get_database`, from the agent's 1-minute samples (D57). Telemetry
 * failures degrade to a note: the database view itself is still useful.
 */
async function databaseLastHour(principal: Principal, name: string, storageMb: number) {
	const to = Date.now();
	let points: DatabaseMetricPoint[];
	try {
		points = await core.databases.metrics(principal, name, { from: to - 3_600_000, to, interval: '1m' });
	} catch (error) {
		return { note: `Metrics are unavailable: ${(error as Error).message ?? String(error)}` };
	}
	if (points.length === 0)
		return { note: 'No samples in the last hour yet. The agent reports once a minute after the database is running.' };
	const sorted = [...points].sort((a, b) => a.bucket.localeCompare(b.bucket));
	const latest = sorted[sorted.length - 1]!;
	const sum = (key: keyof Omit<DatabaseMetricPoint, 'bucket'>) => sorted.reduce((total, point) => total + point[key], 0);
	const hit = sum('blksHit');
	const read = sum('blksRead');
	return {
		samples: sorted.length,
		latestAt: latest.bucket,
		up: latest.up >= 0.5,
		sizeBytes: latest.sizeBytes,
		storageBudgetBytes: storageMb * 1024 * 1024,
		storageUsedRatio: round(latest.sizeBytes / (storageMb * 1024 * 1024), 4),
		connections: {
			total: latest.connectionsTotal,
			active: latest.connectionsActive,
			idle: latest.connectionsIdle,
			max: latest.maxConnections,
			usedRatio: latest.maxConnections > 0 ? round(latest.connectionsTotal / latest.maxConnections, 4) : null,
		},
		commitsPerMinute: round(sum('xactCommit') / sorted.length, 1),
		rollbacksPerMinute: round(sum('xactRollback') / sorted.length, 1),
		cacheHitRatio: hit + read > 0 ? round(hit / (hit + read), 4) : null,
		deadlocks: sum('deadlocks'),
	};
}

/** Last-hour usage for `get_storage`, from the agent's 1-minute samples (S7). Failures degrade to a note. */
async function storageLastHour(principal: Principal, name: string, storageMb: number) {
	const to = Date.now();
	let points: StorageMetricPoint[];
	try {
		points = await core.storage.metrics(principal, name, { from: to - 3_600_000, to, interval: '1m' });
	} catch (error) {
		return { note: `Metrics are unavailable: ${(error as Error).message ?? String(error)}` };
	}
	if (points.length === 0)
		return { note: 'No samples in the last hour yet. The agent reports once a minute after the instance is running.' };
	const sorted = [...points].sort((a, b) => a.bucket.localeCompare(b.bucket));
	const latest = sorted[sorted.length - 1]!;
	const budget = storageMb * 1024 * 1024;
	return {
		samples: sorted.length,
		latestAt: latest.bucket,
		up: latest.up >= 0.5,
		usedBytes: latest.usedBytes,
		storageBudgetBytes: budget,
		storageUsedRatio: round(latest.usedBytes / budget, 4),
		objects: latest.objects,
		buckets: latest.bucketCount,
		memoryBytes: latest.memoryBytes,
	};
}

/** Last-hour summary for `get_broker_metrics`, from the agent's 1-minute samples (D123). */
async function brokerLastHour(principal: Principal, name: string, storageMb: number) {
	const to = Date.now();
	let points: BrokerMetricPoint[];
	try {
		points = await core.brokers.metrics(principal, name, { from: to - 3_600_000, to, interval: '1m' });
	} catch (error) {
		return { note: `Metrics are unavailable: ${(error as Error).message ?? String(error)}` };
	}
	if (points.length === 0)
		return {
			note: 'No samples in the last hour. The agent reports once a minute while the broker runs, and only when the telemetry store is installed.',
		};
	const sorted = [...points].sort((a, b) => a.bucket.localeCompare(b.bucket));
	const latest = sorted[sorted.length - 1]!;
	const budget = storageMb * 1024 * 1024;
	const sum = (key: 'published' | 'messagesIn' | 'messagesOut' | 'slowConsumers') =>
		sorted.reduce((total, point) => total + point[key], 0);
	return {
		samples: sorted.length,
		latestAt: latest.bucket,
		up: latest.up >= 0.5,
		uptimeRatio: round(sorted.reduce((total, point) => total + point.up, 0) / sorted.length, 4),
		connections: latest.connections,
		streams: latest.streams,
		consumers: latest.consumers,
		storeBytes: latest.storeBytes,
		storeBudgetBytes: budget,
		storeUsedRatio: round(latest.storeBytes / budget, 4),
		messages: latest.messages,
		pending: latest.pending,
		ackPending: latest.ackPending,
		redelivered: latest.redelivered,
		oldestMessageAgeSeconds: latest.oldestAgeSeconds,
		peakBacklog: Math.max(...sorted.map((point) => point.pending + point.ackPending)),
		lastHour: {
			published: sum('published'),
			messagesIn: sum('messagesIn'),
			messagesOut: sum('messagesOut'),
			slowConsumers: sum('slowConsumers'),
		},
		memoryBytes: latest.memoryBytes,
	};
}

/** Seconds `get_node_task` may hold the call open, as the REST `?wait=` cap. */
const NODE_TASK_MAX_WAIT_SECONDS = 25;

/** `SKIFF_Q_<queue>` is the JetStream stream behind a function queue (D112). */
const queueStream = (queue: string) => `SKIFF_Q_${queue}`;

/**
 * A node task (D124) as an agent sees it: id, status, the node's result once it has one, and
 * what to do next. A task still pending/running after the wait points at `get_node_task`.
 */
/** A job run for an MCP reply: the run, its newest output once it finished, and what to do next. */
function describeJobRun(principal: Principal, project: ReturnType<typeof core.projects.requireRow>, run: JobRunView) {
	if (!jobRunDone(run.status))
		return {
			run,
			nextSteps: [
				`The run is ${run.status}. Call get_job_run with project "${project.slug}", runId "${run.id}" and waitSeconds up to ${NODE_TASK_MAX_WAIT_SECONDS} for the result; do not run it again, that would start a second run.`,
			],
		};
	let output: string[] | undefined;
	try {
		output = core.jobs.runLogs(principal, project, run.id, { limit: 100 }).events.map((event) => `${event.stream === 'stderr' ? '[stderr] ' : ''}${event.message}`);
	} catch {
		// Without logs:read the run itself is still useful.
	}
	return { run, ...(output ? { output } : {}) };
}

function describeNodeTask(task: NodeTaskView) {
	const base = { taskId: task.id, kind: task.kind, status: task.status, target: task.target };
	if (task.status === 'failed')
		return { ...base, error: task.error, nextSteps: ['The node reported a failure; fix the cause above and run the tool again.'] };
	if (task.status !== 'succeeded' || task.result === null)
		return {
			...base,
			nextSteps: [
				`The node has not reported a result yet (${task.status}). Call get_node_task with id "${task.id}" and waitSeconds up to ${NODE_TASK_MAX_WAIT_SECONDS} to get it; do not re-run the tool, that would queue it twice.`,
			],
		};
	return { ...base, result: task.result, nextSteps: nodeTaskNextSteps(task) };
}

function nodeTaskNextSteps(task: NodeTaskView): string[] {
	const broker = task.target.name;
	switch (task.kind) {
		case 'broker.queue.create': {
			const result = task.result as NodeTaskResultMap['broker.queue.create'];
			return [
				result.created ? `Created stream ${result.stream} on ${broker}.` : `Stream ${result.stream} already existed on ${broker}; nothing changed.`,
				'Functions bind it with a queue producer/consumer of the same name (the broker must be attached to the function project). Send a test message with send_queue_message.',
			];
		}
		case 'broker.queue.send': {
			const result = task.result as NodeTaskResultMap['broker.queue.send'];
			const input = task.input as { queue?: string };
			return [
				`Stored ${result.sent} message${result.sent === 1 ? '' : 's'} in ${result.stream} (seq ${result.seqs.slice(0, 10).join(', ')}${result.seqs.length > 10 ? ', …' : ''}). A consumer function attached to queue "${input.queue ?? ''}" receives ${result.sent === 1 ? 'it' : 'them'} like any other message.`,
				`Call peek_queue_messages({ broker: "${broker}", queue: "${input.queue ?? ''}" }) to see messages still waiting (a work queue drops acknowledged ones), or get_broker_queues for counts and consumer backlog. Check the consumer's get_logs for its handling.`,
			];
		}
		case 'broker.queue.redrive': {
			const result = task.result as NodeTaskResultMap['broker.queue.redrive'];
			const input = task.input as { from?: string; to?: string };
			return [
				`Moved ${result.moved} message${result.moved === 1 ? '' : 's'} from "${input.from ?? ''}" to "${input.to ?? ''}".`,
				result.remaining > 0
					? `${result.remaining} remain in "${input.from ?? ''}"; call redrive_queue again to move more.`
					: `"${input.from ?? ''}" is empty now. Follow the consumer with get_broker_queues and get_logs.`,
			];
		}
		case 'broker.stream.peek': {
			const result = task.result as NodeTaskResultMap['broker.stream.peek'];
			return [
				`${result.messages.length} of ${result.total} message${result.total === 1 ? '' : 's'} held in ${result.stream} (seq ${result.firstSeq}–${result.lastSeq}). Peeking does not consume or acknowledge anything.`,
				...(result.messages.some((message) => message.truncated) ? [`Bodies over ${nodeTaskLimits.peekBodyBytes / 1024} KiB are cut (truncated: true).`] : []),
				...(result.messages.some((message) => message.encoding === 'base64') ? ['Bodies that are not UTF-8 are base64 (encoding: "base64").'] : []),
				result.nextSeq !== null ? `More messages follow: call peek_queue_messages with fromSeq ${result.nextSeq}.` : 'That is the end of the stream.',
			];
		}
		case 'function.invoke': {
			const result = task.result as NodeTaskResultMap['function.invoke'];
			return [
				`${result.status} ${result.statusText} in ${Math.round(result.durationMs)} ms${result.coldStart ? ' (cold start: this request started the idle host)' : ''}.`,
				...(result.truncated ? [`The response body was cut at ${nodeTaskLimits.responseBodyBytes / 1024} KiB of ${result.size} bytes.`] : []),
				...(result.encoding === 'base64' ? ['The body is not UTF-8, so it is base64.'] : []),
				...(result.status >= 500 ? [`Read the function's errors with get_logs({ project: "${task.target.name}", level: "error" }).`] : []),
			];
		}
		case 'function.scheduled': {
			const result = task.result as NodeTaskResultMap['function.scheduled'];
			return [
				result.error
					? `The scheduled handler failed (${result.status}): ${result.error}. See get_logs({ project: "${task.target.name}" }).`
					: `The scheduled handler finished in ${Math.round(result.durationMs)} ms${result.coldStart ? ' (cold start)' : ''}. Its console output is in get_logs({ project: "${task.target.name}" }).`,
			];
		}
		default:
			return ['Done.'];
	}
}

/** `attach_storage` without grants: read-write on the instance's only bucket, else ask for grants. */
function defaultStorageGrants(principal: Principal, name: string): StorageGrant[] {
	const buckets = core.storage.get(principal, name).buckets.filter((bucket) => bucket.state === 'ready');
	if (buckets.length === 1) return [{ bucket: buckets[0]!.name, mode: 'read-write' }];
	throw new Error(
		buckets.length === 0
			? `Storage "${name}" has no buckets yet. Create one with create_bucket, then attach.`
			: `Storage "${name}" has ${buckets.length} buckets (${buckets.map((bucket) => bucket.name).join(', ')}). Pass grants to pick which ones.`,
	);
}

const text = (value: unknown) => ({
	content: [
		{
			type: 'text' as const,
			text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
		},
	],
});

async function run(handler: () => Promise<unknown> | unknown) {
	try {
		return text(await handler());
	} catch (error) {
		const message = (error as { message?: string }).message ?? String(error);
		const suggestions = (error as { suggestions?: string[] }).suggestions;
		return {
			isError: true,
			...text(suggestions?.length ? `${message}\n\nTry: ${suggestions.join(', ')}` : message),
		};
	}
}

// --- audit ------------------------------------------------------------------

/** Results the user declined in a confirmation prompt; audited as such rather than as success. */
const declined = new WeakSet<object>();

/** Inline file contents can be megabytes: keep paths and sizes, never bodies, in the audit log. Message and request bodies likewise. */
function summarizeArgs(input: unknown): unknown {
	if (!input || typeof input !== 'object') return input;
	const out: Record<string, unknown> = { ...(input as Record<string, unknown>) };
	// Queue messages and test requests (D124): sizes and header names only, as core's own audit.
	if (typeof out.body === 'string') out.body = { bytes: out.body.length };
	if (out.headers && typeof out.headers === 'object' && !Array.isArray(out.headers))
		out.headers = Object.keys(out.headers as Record<string, unknown>);
	if (Array.isArray(out.files)) {
		const files = out.files as Array<{ path?: unknown; content?: unknown }>;
		out.files = {
			count: files.length,
			bytes: files.reduce((sum, file) => sum + (typeof file?.content === 'string' ? file.content.length : 0), 0),
			paths: files.slice(0, 20).map((file) => file?.path),
		};
	}
	return out;
}

function resultError(result: unknown): string | undefined {
	const value = result as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
	if (!value?.isError) return undefined;
	return value.content?.find((part) => part.type === 'text')?.text?.slice(0, 500) ?? 'error';
}

/** Every MCP tool call lands in the audit log: user, client, tool, args and result (DESIGN §6.3). */
function auditTool(
	principal: Principal,
	tool: string,
	input: unknown,
	error?: string,
	prefix: 'mcp' | 'assistant' = 'mcp',
): void {
	try {
		const project = (input as { project?: unknown; name?: unknown } | undefined)?.project;
		core.audit.record({
			principal,
			action: `${prefix}.${tool}`,
			resource: prefix === 'assistant' ? 'assistant' : 'mcp',
			resourceId: typeof project === 'string' ? project : undefined,
			args: summarizeArgs(input),
			result: error ? 'error' : 'ok',
			error,
		});
	} catch (auditError) {
		console.error('[mcp] audit failed:', auditError);
	}
}

// --- confirmations ------------------------------------------------------------

const CONFIRM_TTL_MS = 10 * 60_000;

function confirmationMac(payload: string): string {
	return createHmac('sha256', authSecret).update(`skiff-mcp-confirm:${payload}`).digest('base64url');
}

/**
 * Server-minted `requestState` for a confirmation prompt (MCP multi-round-trip). It binds the
 * answer to this user, client, tool and target, so a client can't skip the prompt by pre-filling
 * `inputResponses` on the first call: an answer only counts with a state we issued.
 */
function mintConfirmation(principal: Principal, tool: string, target: string): string {
	const payload = Buffer.from(
		JSON.stringify({ t: tool, r: target, u: principal.userId, c: principal.clientId ?? '', e: Date.now() + CONFIRM_TTL_MS }),
	).toString('base64url');
	return `${payload}.${confirmationMac(payload)}`;
}

function verifyConfirmation(state: unknown, principal: Principal, tool: string, target: string): boolean {
	if (typeof state !== 'string') return false;
	const [payload, mac] = state.split('.');
	if (!payload || !mac) return false;
	const expected = Buffer.from(confirmationMac(payload));
	const given = Buffer.from(mac);
	if (expected.length !== given.length || !timingSafeEqual(expected, given)) return false;
	try {
		const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
		return (
			claims.t === tool &&
			claims.r === target &&
			claims.u === principal.userId &&
			claims.c === (principal.clientId ?? '') &&
			typeof claims.e === 'number' &&
			claims.e > Date.now()
		);
	} catch {
		return false;
	}
}

/** The target a confirmation state names, before verification (verify it with `verifyConfirmation`). */
function confirmationTarget(state: unknown): string | undefined {
	if (typeof state !== 'string') return undefined;
	try {
		const claims = JSON.parse(Buffer.from(state.split('.')[0] ?? '', 'base64url').toString('utf8')) as { r?: unknown };
		return typeof claims.r === 'string' ? claims.r : undefined;
	} catch {
		return undefined;
	}
}

function buildServer(
	principal: Principal,
	era: SkiffToolEra,
	sink?: SkiffToolDefinition[],
	auditPrefix: 'mcp' | 'assistant' = 'mcp',
) {
	// The assistant reuses the exact MCP definitions by capturing them instead of serving them.
	const server = sink
		? ({
				registerTool: (name: string, config: Record<string, unknown>, handler: (...args: unknown[]) => unknown) => {
					sink.push({ name, config, handler });
					return {};
				},
				registerResource: () => ({})
			} as unknown as McpServer)
		: new McpServer({ name: 'skiff', version: '0.1.0' });

	/**
	 * `server.registerTool` with auditing of every call, including scope denials. A tool whose config
	 * names a `feature` is not offered at all while that platform flag is off.
	 */
	const tool = ((name: string, rawConfig: Record<string, unknown>, callback: (...args: unknown[]) => unknown) => {
		const { feature, ...config } = rawConfig as Record<string, unknown> & { feature?: FeatureName };
		if (feature && !featureEnabled(core.ctx.config, feature)) return {};
		const challenge = config.scopeChallenge as ScopeChallengeHandler | undefined;
		const scopeChallenge: ScopeChallengeHandler | undefined = challenge
			? async (context) => {
					const result = await challenge(context);
					if (result)
						auditTool(
							principal,
							name,
							(context.request.params as { arguments?: unknown } | undefined)?.arguments,
							`insufficient_scope: ${result.errorDescription ?? 'missing scope'}`,
							auditPrefix,
						);
					return result;
				}
			: undefined;
		return server.registerTool(name, { ...config, scopeChallenge } as never, (async (...args: unknown[]) => {
			const input = config.inputSchema ? args[0] : undefined;
			try {
				const result = await callback(...args);
				// A pending confirmation is audited when the follow-up call completes.
				if (isInputRequiredResult(result)) return result;
				auditTool(
					principal,
					name,
					input,
					resultError(result) ?? (declined.has(result as object) ? 'declined by the user' : undefined),
					auditPrefix,
				);
				return result;
			} catch (error) {
				auditTool(principal, name, input, (error as Error).message ?? String(error), auditPrefix);
				throw error;
			}
		}) as never);
	}) as unknown as McpServer['registerTool'] & FeatureGatedTool;

	tool(
		'whoami',
		{
			title: 'Who am I',
			description: 'Show the authenticated user, MCP client and effective Skiff permissions.',
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
		},
		async () =>
			run(() => ({
				userId: principal.userId,
				clientId: principal.clientId,
				orgId: principal.orgId,
				role: principal.role,
				permissions: [...principal.permissions].sort(),
				platform: core.ctx.config.platformOrigin,
			})),
	);

	// --- documentation ------------------------------------------------------
	// The docs ship inside each build, so these always describe the running version. Imported
	// lazily: the module inlines the Markdown through Vite, which plain `bun test` runs lack.
	const docsDb = async () => (await import('./docs')).docsDatabase;

	tool(
		'search_docs',
		{
			title: 'Search Skiff docs',
			description:
				'Full-text search over the Skiff documentation for this platform version: how-to guides, concepts, CLI, REST and MCP reference, self-hosting and troubleshooting runbooks. Returns ranked sections with links and excerpts; read one in full with read_docs. Use it for "how do I…", "what does … mean" and "why does … happen" questions before guessing.',
			inputSchema: z.object({
				query: z.string().min(1).max(200).describe('What to look for, in plain words'),
				limit: z.number().int().min(1).max(20).optional().describe('Results to return (default 8)'),
				section: z
					.string()
					.max(60)
					.optional()
					.describe('Only search one docs section by title, e.g. "Self-hosting" or "Data services"'),
			}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
		},
		async ({ query, limit, section }) =>
			run(async () => {
				const db = await docsDb();
				const results = await db.search(query, { limit, section });
				const { version } = await db.info();
				return {
					version,
					results,
					hint: results.length
						? 'Call read_docs with a result\'s slug (and anchor) for the full text.'
						: 'No matches. Try fewer or different words, or call read_docs without a slug for the table of contents.',
				};
			}),
	);

	tool(
		'read_docs',
		{
			title: 'Read Skiff docs',
			description:
				'Read a Skiff documentation page as Markdown, or just one section of it (pass the anchor from search_docs). Without a slug, returns the table of contents and index details.',
			inputSchema: z.object({
				slug: z
					.string()
					.max(120)
					.optional()
					.describe('Page slug, e.g. "deploying/static-sites"; omit for the table of contents'),
				anchor: z.string().max(120).optional().describe('Section anchor on that page, e.g. "promote-and-roll-back"'),
			}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
		},
		async ({ slug, anchor }) =>
			run(async () => {
				const db = await docsDb();
				if (!slug) return { ...(await db.info()), sections: db.outline() };
				const page = await db.read(slug, anchor);
				if (!page) {
					throw new Error(
						anchor
							? `No section "${anchor}" on docs page "${slug}". Call read_docs with just the slug to list its sections.`
							: `No docs page "${slug}". Call read_docs without a slug for the table of contents, or search_docs.`,
					);
				}
				return page;
			}),
	);

	// --- projects -----------------------------------------------------------
	tool(
		'list_projects',
		{
			title: 'List projects',
			description: 'List projects you can access, with their production and preview URLs.',
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('project:read'),
		},
		async () => run(() => ({ projects: core.projects.list(principal) })),
	);

	tool(
		'get_project',
		{
			title: 'Get project',
			description: 'Get one project by slug, including access modes and deployment counts.',
			inputSchema: z.object({ project: z.string().describe('Project slug') }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('project:read'),
		},
		async ({ project }) =>
			run(() => {
				const view = core.projects.get(principal, project);
				const row = core.projects.requireRow(principal, project);
				return {
					...view,
					deployments: core.deployments.list(principal, row, { limit: 10 }),
				};
			}),
	);

	tool(
		'create_project',
		{
			title: 'Create project',
			description: 'Create a project. Slugs are globally unique; collisions return suggestions.',
			inputSchema: projectCreateSchema,
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
			scopeChallenge: requires('project:create'),
		},
		async (input) => run(() => core.projects.create(principal, input)),
	);

	tool(
		'update_project',
		{
			title: 'Update project',
			description: 'Rename, re-place or change access modes for a project.',
			inputSchema: projectUpdateSchema.extend({ project: z.string(), slug: z.string().optional() }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('project:update'),
		},
		async ({ project, ...input }) => run(() => core.projects.update(principal, project, input)),
	);

	tool(
		'delete_project',
		{
			title: 'Delete project',
			description:
				'Soft-delete a project (stops serving immediately; restorable for the trash period, 7 days by default). Requires confirmation.',
			inputSchema: z.object({ project: z.string().describe('Project slug') }),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
			scopeChallenge: requires('project:delete'),
		},
		async ({ project }, ctx) => {
			// The dashboard assistant gates destructive tools in the chat UI before they reach here.
			if (era === 'assistant')
				return run(async () => {
					await core.projects.softDelete(principal, project);
					return {
						ok: true,
						project,
						restorable: true,
						restoreBefore: new Date(Date.now() + core.policies.trashMs()).toISOString(),
					};
				});
			if (era === 'legacy')
				return {
					isError: true,
					...text(
						`Deleting "${project}" needs your confirmation, which this MCP client can't show. ` +
							`Ask the user to delete it from the Skiff dashboard (Projects → ${project} → Delete).`,
					),
				};
			const key = `confirm_delete:${project}`;
			const schema = z.object({ confirm: z.boolean() });
			// Only an answer to a prompt we issued (signed requestState bound to this target) counts.
			const prompted = verifyConfirmation(ctx.mcpReq.requestState(), principal, 'delete_project', project);
			const answer = prompted ? acceptedContent(ctx.mcpReq.inputResponses, key, schema) : undefined;
			const responded = prompted && ctx.mcpReq.inputResponses?.[key] !== undefined;
			if (responded && answer?.confirm !== true) {
				const cancelled = text(`Cancelled: "${project}" was not deleted (the user did not confirm).`);
				declined.add(cancelled);
				return cancelled;
			}
			if (answer?.confirm !== true) {
				return inputRequired({
					inputRequests: {
						[key]: inputRequired.elicit({
							message: `Delete project "${project}"? It stops serving immediately and can be restored for ${core.policies.get().trashDays} days.`,
							requestedSchema: schema,
						}),
					},
					requestState: mintConfirmation(principal, 'delete_project', project),
				});
			}
			return run(async () => {
				await core.projects.softDelete(principal, project);
				return {
					ok: true,
					project,
					restorable: true,
					restoreBefore: new Date(Date.now() + core.policies.trashMs()).toISOString(),
				};
			});
		},
	);

	// --- mass actions (docs/OPERATIONS.md §6.3) ------------------------------
	/** Wrap a finished operation as a compact tool result agents can act on. */
	const operationResult = (operation: OperationView) => {
		const items = core.operations.items(principal, operation.id, { limit: 200 }).items;
		const by = (status: string) => items.filter((item) => item.status === status);
		return {
			operationId: operation.id,
			status: operation.status,
			succeeded: by('succeeded').map((item) => item.label),
			skipped: by('skipped').map((item) => ({ project: item.label, reason: item.reason })),
			failed: by('failed').map((item) => ({ project: item.label, error: item.error })),
			...(isTerminalOperation(operation.status)
				? {}
				: { nextSteps: [`Still running. Call get_operation with id "${operation.id}" to follow it.`] }),
		};
	};
	const projectListSchema = z
		.array(z.string().min(1))
		.min(1)
		.max(operationLimits.mcpTargets)
		.describe(`Project slugs (at most ${operationLimits.mcpTargets})`);

	tool(
		'delete_projects',
		{
			title: 'Delete several projects',
			description:
				`Soft-delete up to ${operationLimits.mcpTargets} projects at once (each stops serving immediately; restorable with restore_projects for the trash period, 7 days by default). ` +
				'The user confirms the exact list. Prefer this over repeated delete_project calls.',
			inputSchema: z.object({ projects: projectListSchema }),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
			scopeChallenge: requires('project:delete'),
		},
		async ({ projects }, ctx) => {
			const wanted = [...new Set(projects.map((slug) => slug.trim()))].sort();
			if (era === 'assistant')
				return run(async () => {
					const created = core.operations.create(principal, {
						action: 'project.delete',
						targets: wanted,
						stage: 'apply'
					});
					const done = await core.operations.wait(principal, created.id, 20_000);
					return {
						...operationResult(done),
						restoreBefore: new Date(Date.now() + core.policies.trashMs()).toISOString()
					};
				});
			if (era === 'legacy') {
				const link = `${core.ctx.config.platformOrigin}/projects?select=${encodeURIComponent(wanted.join(','))}`;
				return {
					isError: true,
					...text(
						`Deleting ${wanted.length} projects needs your confirmation, which this MCP client can't show. ` +
							`Ask the user to delete them from the Skiff dashboard: ${link}`,
					),
				};
			}
			const key = 'confirm_delete_projects';
			const schema = z.object({ confirm: z.boolean() });
			// The prompt is bound to a planned operation: the confirmed list can't change afterwards.
			const state = ctx.mcpReq.requestState();
			const target = confirmationTarget(state);
			const prompted =
				target?.startsWith('op:') && verifyConfirmation(state, principal, 'delete_projects', target) ? target.slice(3) : undefined;
			if (prompted) {
				let planned: OperationView;
				try {
					planned = core.operations.get(principal, prompted);
				} catch {
					return { isError: true, ...text('That confirmation no longer matches an operation. Call delete_projects again.') };
				}
				const same = [...(planned.params.targets ?? [])].sort().join('\n') === wanted.join('\n');
				if (!same) return { isError: true, ...text('The project list changed after the user was asked. Call delete_projects again.') };
				const answer = acceptedContent(ctx.mcpReq.inputResponses, key, schema);
				if (ctx.mcpReq.inputResponses?.[key] !== undefined && answer?.confirm !== true) {
					core.operations.cancel(principal, planned.id);
					const cancelled = text(`Cancelled: none of the ${wanted.length} projects were deleted (the user did not confirm).`);
					declined.add(cancelled);
					return cancelled;
				}
				if (answer?.confirm === true)
					return run(async () => {
						core.operations.apply(principal, planned.id);
						const done = await core.operations.wait(principal, planned.id, 20_000);
						return {
							...operationResult(done),
							restoreBefore: new Date(Date.now() + core.policies.trashMs()).toISOString(),
						};
					});
			}
			// The prompt itself must be returned as-is (not through `run`, which serialises results).
			let plan: OperationView;
			try {
				const created = core.operations.create(principal, { action: 'project.delete', targets: wanted });
				plan = await core.operations.wait(principal, created.id, 10_000);
			} catch (error) {
				return run(() => {
					throw error;
				});
			}
			if (plan.status !== 'planned')
				return run(() => ({ operationId: plan.id, status: plan.status, nextSteps: ['Planning did not finish; try again.'] }));
			const items = core.operations.items(principal, plan.id, { limit: 200 }).items;
			const ok = items.filter((item) => item.verdict === 'ok');
			if (ok.length === 0) {
				core.operations.cancel(principal, plan.id);
				return run(() => ({
					deleted: [],
					skipped: items.map((item) => ({ project: item.label, reason: item.reason })),
					message: 'Nothing to delete.',
				}));
			}
			const live = ok.filter((item) => item.flags.includes('live')).map((item) => item.label);
			const skipped = items.filter((item) => item.verdict !== 'ok');
			const message = [
				`Delete ${ok.length} project${ok.length === 1 ? '' : 's'}: ${ok.map((item) => item.label).join(', ')}?`,
				live.length ? `${live.length} ${live.length === 1 ? 'is' : 'are'} serving production: ${live.join(', ')}.` : '',
				skipped.length ? `Skipped: ${skipped.map((item) => `${item.label} (${item.reason})`).join(', ')}.` : '',
				`They stop serving immediately and can be restored for ${core.policies.get().trashDays} days.`,
			]
				.filter(Boolean)
				.join(' ');
			return inputRequired({
				inputRequests: { [key]: inputRequired.elicit({ message, requestedSchema: schema }) },
				requestState: mintConfirmation(principal, 'delete_projects', `op:${plan.id}`),
			});
		},
	);

	tool(
		'restore_projects',
		{
			title: 'Restore projects from the trash',
			description: `Restore up to ${operationLimits.mcpTargets} soft-deleted projects; production comes straight back.`,
			inputSchema: z.object({ projects: projectListSchema }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('project:update'),
		},
		async ({ projects }) =>
			run(async () => {
				const created = core.operations.create(principal, { action: 'project.restore', targets: projects, stage: 'apply' });
				return operationResult(await core.operations.wait(principal, created.id, 20_000));
			}),
	);

	tool(
		'get_operation',
		{
			title: 'Get a mass operation',
			description: 'Status, progress and per-item results of a bulk operation (e.g. one started by delete_projects).',
			inputSchema: z.object({ id: z.string().describe('Operation id (op_…)') }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('project:read'),
		},
		async ({ id }) =>
			run(() => {
				const operation = core.operations.get(principal, id);
				return { ...operationResult(operation), progress: { done: operation.done, total: operation.total, phase: operation.phase } };
			}),
	);

	// --- blueprints (plan 11, docs/OPERATIONS.md §12) -------------------------
	/** Operation status → the MCP task status `get_task` reports. */
	const taskStatus = (status: OperationView['status']) =>
		status === 'queued' || status === 'planning'
			? ('queued' as const)
			: status === 'planned'
				? ('input_required' as const)
				: status === 'applying'
					? ('running' as const)
					: status === 'succeeded'
						? ('succeeded' as const)
						: status === 'cancelled'
							? ('cancelled' as const)
							: status === 'expired'
								? ('expired' as const)
								: ('failed' as const);
	const stackNextSteps = (run: { operationId: string; status: OperationView['status'] }) =>
		isTerminalOperation(run.status) ? {} : { nextSteps: [`Still running. Call get_task with taskId "${run.operationId}" to follow it.`] };

	tool(
		'plan_stack',
		{
			title: 'Plan a blueprint',
			description:
				'Diff a Skiff blueprint (YAML or JSON, `apiVersion: skiff/v1`: projects, environments, domains, workload settings, databases, storage buckets, brokers and attachments) against live state. ' +
				'Changes nothing. Returns every resource step (create, update, noop) with field-level changes and a planHash to pass to apply_stack within an hour. ' +
				'Any problem (a missing permission or secret, an immutable field, a taken name) fails the plan with its resource path. Blueprints hold secret names, never values. Pruning is not available over MCP.',
			inputSchema: planStackInputSchema,
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('project:read'),
			feature: 'BLUEPRINTS',
		},
		async ({ blueprint }) =>
			run(async () => {
				const plan = await core.blueprints.plan(principal, { document: blueprint });
				const pending = plan.summary.create + plan.summary.update;
				return {
					...plan,
					nextSteps: pending
						? [`Show the user this plan, then call apply_stack with planHash "${plan.planHash}" (it asks them to confirm).`]
						: ['Everything is already up to date; there is nothing to apply.'],
				};
			}),
	);

	tool(
		'apply_stack',
		{
			title: 'Apply a blueprint plan',
			description:
				'Apply a plan from plan_stack by its planHash. The user confirms the exact plan; live state is re-read first and a plan whose state moved is refused (plan again). ' +
				'Steps run in order through the normal services; the first failure stops the run and later steps are skipped (nothing is rolled back). Plans that delete resources (prune) are refused here. Requires confirmation.',
			inputSchema: applyStackInputSchema,
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
			scopeChallenge: requires('project:update'),
			feature: 'BLUEPRINTS',
		},
		async ({ planHash }, ctx) => {
			const applyNow = () =>
				run(async () => {
					const result = await core.blueprints.applyAndWait(principal, { planHash }, 20_000);
					return { ...result, ...stackNextSteps(result) };
				});
			// The dashboard assistant gates destructive tools in the chat UI before they reach here.
			if (era === 'assistant') return applyNow();
			let plan: ReturnType<typeof core.blueprints.pendingPlan>;
			try {
				plan = core.blueprints.pendingPlan(principal, planHash);
			} catch (error) {
				return run(() => {
					throw error;
				});
			}
			if (!plan)
				return {
					isError: true,
					...text('There is no pending plan with that hash (plans last an hour, apply once, and belong to whoever made them). Call plan_stack again.'),
				};
			if (plan.prune && plan.summary.delete > 0)
				return {
					isError: true,
					...text('This plan deletes resources. Pruning is a human action: apply it from the Skiff dashboard (New → Blueprint) or with `skif blueprint apply --prune`.'),
				};
			if (era === 'legacy')
				return {
					isError: true,
					...text(
						`Applying blueprint "${plan.stack}" needs your confirmation, which this MCP client can't show. ` +
							`Ask the user to apply it from the Skiff dashboard (${core.ctx.config.platformOrigin}/new/blueprint) or with \`skif blueprint apply\`.`,
					),
				};
			const target = `stack:${plan.stack}:${planHash}`;
			const key = 'confirm_apply_stack';
			const schema = z.object({ confirm: z.boolean() });
			// Only an answer to a prompt we issued (signed requestState bound to this stack and plan) counts.
			const prompted = verifyConfirmation(ctx.mcpReq.requestState(), principal, 'apply_stack', target);
			const answer = prompted ? acceptedContent(ctx.mcpReq.inputResponses, key, schema) : undefined;
			const responded = prompted && ctx.mcpReq.inputResponses?.[key] !== undefined;
			if (responded && answer?.confirm !== true) {
				const cancelled = text(`Cancelled: blueprint "${plan.stack}" was not applied (the user did not confirm).`);
				declined.add(cancelled);
				return cancelled;
			}
			if (answer?.confirm === true) return applyNow();
			const changing = plan.resources.filter((resource) => resource.action !== 'noop');
			const listed = changing.slice(0, 12).map((resource) => `${resource.action} ${resource.key}`);
			const message = [
				`Apply blueprint "${plan.stack}"? ${plan.summary.create} to create, ${plan.summary.update} to update.`,
				listed.length ? `${listed.join('; ')}${changing.length > listed.length ? `; and ${changing.length - listed.length} more` : ''}.` : '',
				'Steps stop at the first failure; nothing is rolled back.',
			]
				.filter(Boolean)
				.join(' ');
			return inputRequired({
				inputRequests: { [key]: inputRequired.elicit({ message, requestedSchema: schema }) },
				requestState: mintConfirmation(principal, 'apply_stack', target),
			});
		},
	);

	tool(
		'get_task',
		{
			title: 'Get a durable task',
			description:
				'Poll durable work by its taskId: a blueprint run started by apply_stack (taskId is the operation id) or any other operation. Returns its status, progress and, for blueprint runs, every resource step.',
			inputSchema: getTaskInputSchema,
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('project:read'),
		},
		async ({ taskId }) =>
			run(() => {
				const operation = core.operations.get(principal, taskId);
				const result =
					operation.action === 'blueprint.apply' ? core.blueprints.applyView(principal, taskId) : operationResult(operation);
				const failed = operation.status === 'failed' || operation.status === 'partial';
				return {
					id: operation.id,
					tool: operation.action === 'blueprint.apply' ? 'apply_stack' : operation.action,
					status: taskStatus(operation.status),
					progress: operation.total > 0 ? Math.round((operation.done / operation.total) * 100) : null,
					result,
					error: failed ? ('error' in result && result.error ? result.error : `The operation ${operation.status}.`) : null,
					approval: {
						required: operation.status === 'planned',
						requestState: null,
						expiresAt: operation.planExpiresAt,
					},
					createdAt: operation.createdAt,
					updatedAt: operation.finishedAt ?? operation.startedAt ?? operation.createdAt,
					expiresAt: operation.planExpiresAt,
				};
			}),
	);

	// --- deploying ----------------------------------------------------------
	tool(
		'deploy_site',
		{
			title: 'Deploy a site',
			description:
				'One-shot deploy: creates the project if missing, then deploys inline files (≤5 MB) or a finalized upload. Promotes to production by default.',
			inputSchema: deploySiteSchema,
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
			scopeChallenge: requires('project:create', 'deployment:create'),
		},
		async (input) =>
			run(async () => {
				const result = await core.deploy.deploySite(principal, input);
				return {
					...result,
					nextSteps: [
						`Production: ${result.productionUrl}`,
						`Preview: ${result.previewUrl}`,
						...(result.hint ? [result.hint] : []),
					],
				};
			}),
	);

	tool(
		'deploy_files',
		{
			title: 'Deploy files',
			description: 'Deploy inline files (≤5 MB total) to an existing project.',
			inputSchema: deployFilesSchema,
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
			scopeChallenge: requires('deployment:create'),
		},
		async (input) => run(() => core.deploy.deployFiles(principal, input)),
	);

	tool(
		'create_upload',
		{
			title: 'Create upload',
			description:
				'Create a presigned upload session for large sites. PUT a zip of the site to the returned URL, then call finalize_upload.',
			inputSchema: z.object({
				project: z.string(),
				fileCount: z.number().int().positive().optional(),
				totalBytes: z.number().int().positive().optional(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
			scopeChallenge: requires('deployment:create'),
		},
		async ({ project, fileCount, totalBytes }) =>
			run(async () => {
				const row = core.projects.requireRow(principal, project);
				const session = await core.uploads.create(principal, row, { fileCount, totalBytes });
				return {
					...session,
					instructions: `PUT the zip archive as ${session.method} to the URL with the given headers, then call finalize_upload({ project: "${project}", uploadId: "${session.uploadId}" }).`,
					limits: { artifactBytes: limits.artifactBytes, files: limits.files, fileBytes: limits.fileBytes },
				};
			}),
	);

	tool(
		'finalize_upload',
		{
			title: 'Finalize upload',
			description: 'Validate an uploaded zip, create the release and deployment, and optionally promote.',
			inputSchema: z.object({
				project: z.string(),
				uploadId: z.string(),
				promote: z.boolean().default(true),
				message: z.string().max(500).optional(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
			scopeChallenge: requires('deployment:create'),
		},
		async ({ project, uploadId, promote, message }) =>
			run(async () => {
				const row = core.projects.requireRow(principal, project);
				return core.uploads.finalize(principal, row, uploadId, { promote, message });
			}),
	);

	tool(
		'list_deployments',
		{
			title: 'List deployments',
			description: 'List deployments for a project, newest first, with preview URLs.',
			inputSchema: z.object({ project: z.string(), limit: z.number().int().min(1).max(200).default(20) }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('deployment:read'),
		},
		async ({ project, limit }) =>
			run(() => {
				const row = core.projects.requireRow(principal, project);
				return { deployments: core.deployments.list(principal, row, { limit }) };
			}),
	);

	tool(
		'get_deployment',
		{
			title: 'Get deployment',
			description: 'Get one deployment by id or short id.',
			inputSchema: z.object({ project: z.string(), deployment: z.string() }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('deployment:read'),
		},
		async ({ project, deployment }) =>
			run(() => core.deployments.get(principal, core.projects.requireRow(principal, project), deployment)),
	);

	tool(
		'promote_deployment',
		{
			title: 'Promote deployment',
			description:
				'Point an environment (production by default) at an existing deployment. Instant; no rebuild. Production also re-points a process/container workload; other environments only move their pointer.',
			inputSchema: z.object({
				project: z.string(),
				deployment: z.string(),
				environment: z.string().optional().describe('Environment slug; defaults to production'),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('deployment:promote'),
		},
		async ({ project, deployment, environment }) =>
			run(() =>
				core.deployments.promote(
					principal,
					core.projects.requireRow(principal, project),
					deployment,
					environment,
				),
			),
	);

	tool(
		'rollback',
		{
			title: 'Roll back an environment',
			description: 'Point an environment (production by default) at its previous deployment (code and config together).',
			inputSchema: z.object({
				project: z.string(),
				environment: z.string().optional().describe('Environment slug; defaults to production'),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('deployment:rollback'),
		},
		async ({ project, environment }) =>
			run(() => core.deployments.rollback(principal, core.projects.requireRow(principal, project), environment)),
	);

	// --- environments -------------------------------------------------------
	tool(
		'list_environments',
		{
			title: 'List environments',
			description:
				'List a project\'s named environments (production is built in) with host, access mode and current deployment.',
			inputSchema: z.object({ project: z.string() }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('project:read'),
		},
		async ({ project }) =>
			run(() => ({
				environments: core.environments.list(principal, core.projects.requireRow(principal, project)),
			})),
	);

	tool(
		'create_environment',
		{
			title: 'Create environment',
			description:
				'Create a named environment. It serves at <project>--<env>.<contentDomain>; access defaults to the project preview mode.',
			inputSchema: environmentCreateSchema.extend({ project: z.string() }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
			scopeChallenge: requires('project:update'),
		},
		async ({ project, ...input }) =>
			run(() => core.environments.create(principal, core.projects.requireRow(principal, project), input)),
	);

	tool(
		'deploy_to_environment',
		{
			title: 'Deploy to an environment',
			description:
				'Deploy inline files or a finalized upload into a named environment. Moves only that environment\'s pointer and leaves production untouched. For process/container projects only the latest deployment is active, so the running app switches to this release.',
			inputSchema: z.object({
				project: z.string(),
				environment: z.string().describe('Environment slug (production is allowed explicitly)'),
				files: z.array(inlineFileSchema).min(1).max(20000).optional(),
				uploadId: z.string().optional(),
				promote: z.boolean().default(true),
				message: z.string().max(500).optional(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
			scopeChallenge: requires('deployment:create', 'project:read'),
		},
		async ({ project, environment, files, uploadId, promote, message }) =>
			run(async () => {
				if (!files && !uploadId) throw new Error('Provide `files` or an `uploadId`.');
				if (files && uploadId) throw new Error('Provide either `files` or `uploadId`, not both.');
				const row = core.projects.requireRow(principal, project);
				const view = files
					? await core.uploads.deployInline(principal, row, files, { promote, message, environment })
					: await core.uploads.finalize(principal, row, uploadId!, { promote, message, environment });
				return {
					...view,
					nextSteps: [`Environment: ${view.productionUrl}`, `Preview: ${view.previewUrl}`],
				};
			}),
	);

	// --- workloads ----------------------------------------------------------
	tool(
		'get_workload',
		{
			title: 'Get workload',
			description: 'Get the current tier 2/3 runtime spec and status for a project.',
			inputSchema: z.object({ project: z.string() }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('deployment:read'),
		},
		async ({ project }) =>
			run(() => {
				const row = core.projects.requireRow(principal, project);
				return { workload: core.workloads.get(principal, row), spec: core.workloads.projectSpec(row) };
			}),
	);

	tool(
		'get_function',
		{
			title: 'Get function',
			description:
				'Get a Functions project (D110): main module, compatibility date/flags, resolved bindings (names, not secret values), assets and run_worker_first, idle stop and the pinned workerd version. Returns `function: null` for a project that is not a function.',
			inputSchema: z.object({ project: z.string() }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('deployment:read'),
		},
		async ({ project }) =>
			run(() => {
				const row = core.projects.requireRow(principal, project);
				return { function: core.functions.view(principal, row) };
			}),
	);

	// Test requests and cron runs on the function's own host (D124, docs/FUNCTIONS.md §4.11).
	tool(
		'invoke_function',
		{
			title: 'Invoke function',
			description:
				'Send one real HTTP request to a function\'s live production host on its node, bypassing domains, Caddy and access rules ' +
				'(so private projects answer too). It runs the deployed code for real: a POST, PUT or DELETE has the same side effects as ' +
				'production traffic (database writes, outgoing calls, queue messages). Only send what the user asked for. Paths under ' +
				`/__skiff/ are refused; request bodies are at most ${nodeTaskLimits.requestBodyBytes / 1024 / 1024} MiB. The result is the ` +
				`response status, headers and body (cut at ${nodeTaskLimits.responseBodyBytes / 1024} KiB), durationMs and coldStart ` +
				`(true when the request woke an idle host). Waits up to ${nodeTaskLimits.waitMs / 1000} s, then returns a task id for get_node_task.`,
			inputSchema: z.object({
				project: z.string().describe('Function project slug'),
				method: z.enum(functionRequestMethods).default('GET'),
				path: z.string().max(4096).default('/').describe('Path and query, e.g. /api/users?limit=5'),
				headers: z.record(z.string(), z.string()).default({}).describe('Request headers (at most 50)'),
				body: z.string().max(nodeTaskLimits.requestBodyBytes).optional().describe('Request body; not for GET or HEAD'),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
			scopeChallenge: requires('deployment:create'),
		},
		async ({ project, ...input }) =>
			run(async () => {
				const row = core.projects.requireRow(principal, project);
				return describeNodeTask(await core.nodeTasks.run(principal, core.nodeTasks.functionTask(principal, row, 'function.invoke', input)));
			}),
	);

	tool(
		'run_function_cron',
		{
			title: 'Run function cron now',
			description:
				'Run a function\'s scheduled() handler once now, as if one of its cron triggers fired; the handler sees `cron` as ' +
				'controller.cron. `cron` must be one of the triggers.crons of the active deployment (get_function lists them). It runs the ' +
				'production code for real, with its side effects. The result is the status, the handler\'s error if any, durationMs and coldStart.',
			inputSchema: z.object({
				project: z.string().describe('Function project slug'),
				cron: z.string().min(1).max(120).describe('One of the function\'s cron expressions, e.g. */5 * * * *'),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
			scopeChallenge: requires('deployment:create'),
		},
		async ({ project, cron }) =>
			run(async () => {
				const row = core.projects.requireRow(principal, project);
				return describeNodeTask(await core.nodeTasks.run(principal, core.nodeTasks.functionTask(principal, row, 'function.scheduled', { cron })));
			}),
	);

	// --- jobs (plan 09, docs/SCHEDULER.md §Jobs): cron and one-off commands on a process/container app ---

	const jobProject = z.string().describe('Process or container project slug');
	const jobName = z.string().min(1).max(40).describe('Job name, unique in the project');
	const jobWait = z
		.number()
		.int()
		.min(0)
		.max(NODE_TASK_MAX_WAIT_SECONDS)
		.default(20)
		.describe('Seconds to wait for the run to finish before returning it as queued/running');

	tool(
		'list_jobs',
		{
			feature: 'JOBS',
			title: 'List jobs',
			description:
				'The cron and manual jobs of a process or container project: command (argv), schedule (five-field UTC cron, null = manual only), ' +
				'timeout, concurrency policy, retries, enabled, next run and the last run.',
			inputSchema: z.object({ project: jobProject }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('project:read'),
		},
		async ({ project }) => run(() => ({ jobs: core.jobs.list(principal, core.projects.requireRow(principal, project)) })),
	);

	tool(
		'create_job',
		{
			feature: 'JOBS',
			title: 'Create job',
			description:
				'Define a job on a process or container project. `command` is an argv array run in the app\'s sandbox against its current release ' +
				'(no shell: ["bun","scripts/tidy.ts","--days","30"], or ["sh","-c","…"] if you really need one). `schedule` is a five-field UTC ' +
				'cron (minute hour day month weekday; no names or macros; day-of-month AND day-of-week must both match), or null for a job you run ' +
				'by hand. concurrency: forbid (default; an overlapping run is recorded skipped), allow, or replace (cancels the running one). ' +
				'maxRetries retries a failed or timed-out run with backoff (30 s, 1 min, 2 min, …).',
			inputSchema: jobCreateSchema.extend({ project: jobProject }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
			scopeChallenge: requires('project:update'),
		},
		async ({ project, ...input }) => run(() => core.jobs.create(principal, core.projects.requireRow(principal, project), input)),
	);

	tool(
		'update_job',
		{
			feature: 'JOBS',
			title: 'Update job',
			description:
				'Change a job\'s command, schedule (null removes it; the job stays runnable by hand), timeoutSeconds, concurrency, maxRetries or enabled.',
			inputSchema: z.object({
				project: jobProject,
				job: jobName,
				command: jobCommandSchema.optional(),
				schedule: jobCreateSchema.shape.schedule.unwrap().nullable().optional(),
				timeoutSeconds: jobTimeoutSchema.optional(),
				concurrency: z.enum(jobConcurrencyPolicies).optional(),
				maxRetries: jobCreateSchema.shape.maxRetries.unwrap().optional(),
				enabled: z.boolean().optional(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('project:update'),
		},
		async ({ project, job, ...input }) =>
			run(() => core.jobs.update(principal, core.projects.requireRow(principal, project), job, jobUpdateSchema.parse(input))),
	);

	tool(
		'pause_job',
		{
			feature: 'JOBS',
			title: 'Pause or resume job',
			description:
				'Pause a job\'s schedule (paused: true) or resume it (paused: false; it next fires at the first occurrence after now, missed ones are not replayed). ' +
				'A paused job keeps its history and can still be run with run_job.',
			inputSchema: z.object({ project: jobProject, job: jobName, paused: z.boolean().default(true) }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('project:update'),
		},
		async ({ project, job, paused }) =>
			run(() => core.jobs.setEnabled(principal, core.projects.requireRow(principal, project), job, !paused)),
	);

	tool(
		'run_job',
		{
			feature: 'JOBS',
			title: 'Run job now',
			description:
				'Run a job once now, whatever its schedule or pause state, on the project\'s node with the app\'s env, secrets and volumes. It runs production ' +
				'code for real. Waits up to waitSeconds for the exit and returns the run (status, exitCode, error) and its last output lines.',
			inputSchema: z.object({ project: jobProject, job: jobName, waitSeconds: jobWait }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
			scopeChallenge: requires('deployment:create'),
		},
		async ({ project, job, waitSeconds }) =>
			run(async () => {
				const row = core.projects.requireRow(principal, project);
				const started = core.jobs.run(principal, row, job);
				return describeJobRun(principal, row, await core.jobs.wait(principal, row, started.id, waitSeconds * 1000));
			}),
	);

	tool(
		'run_command',
		{
			feature: 'JOBS',
			title: 'Run one-off command',
			description:
				'Run one command once against the current release of a process or container app (a migration, a console script), in the app\'s sandbox ' +
				'with its env, secrets and volumes; it is not saved as a job. `command` is an argv array, never a shell string. It runs against production ' +
				'data for real. Waits up to waitSeconds and returns the run and its last output lines.',
			inputSchema: z.object({
				project: jobProject,
				command: jobCommandSchema,
				timeoutSeconds: jobTimeoutSchema.default(600),
				waitSeconds: jobWait,
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
			scopeChallenge: requires('deployment:create'),
		},
		async ({ project, command, timeoutSeconds, waitSeconds }) =>
			run(async () => {
				const row = core.projects.requireRow(principal, project);
				const started = core.jobs.runOneOff(principal, row, { command, timeoutSeconds });
				return describeJobRun(principal, row, await core.jobs.wait(principal, row, started.id, waitSeconds * 1000));
			}),
	);

	tool(
		'get_job_runs',
		{
			feature: 'JOBS',
			title: 'Get job runs',
			description:
				'Run history, newest first: one job\'s runs (job), only one-off commands (oneOff), or every run of the project. Each has trigger ' +
				'(schedule/manual/retry), attempt, status (queued/running/succeeded/failed/timeout/cancelled/skipped), exitCode, error and timings.',
			inputSchema: z.object({
				project: jobProject,
				job: jobName.optional(),
				oneOff: z.boolean().default(false),
				limit: z.number().int().min(1).max(200).default(20),
			}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('project:read'),
		},
		async ({ project, job, oneOff, limit }) =>
			run(() => ({ runs: core.jobs.runs(principal, core.projects.requireRow(principal, project), { ...(job ? { job } : {}), oneOff, limit }) })),
	);

	tool(
		'get_job_run',
		{
			feature: 'JOBS',
			title: 'Get job run',
			description:
				'One run with its last output lines (needs logs:read). waitSeconds holds the call until the run finishes, for a run that was still going.',
			inputSchema: z.object({
				project: jobProject,
				runId: z.string().regex(/^jr_[a-f0-9]{32}$/).describe('Run id (jr_…)'),
				waitSeconds: jobWait.default(0),
			}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('project:read'),
		},
		async ({ project, runId, waitSeconds }) =>
			run(async () => {
				const row = core.projects.requireRow(principal, project);
				return describeJobRun(principal, row, await core.jobs.wait(principal, row, runId, waitSeconds * 1000));
			}),
	);

	tool(
		'cancel_job_run',
		{
			feature: 'JOBS',
			title: 'Cancel job run',
			description: 'Cancel a queued run, or stop a running one (SIGTERM, then SIGKILL after 30 s; cancelRequested shows until the node confirms).',
			inputSchema: z.object({ project: jobProject, runId: z.string().regex(/^jr_[a-f0-9]{32}$/).describe('Run id (jr_…)') }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('deployment:create'),
		},
		async ({ project, runId }) => run(() => core.jobs.cancelRun(principal, core.projects.requireRow(principal, project), runId)),
	);

	tool(
		'delete_job',
		{
			feature: 'JOBS',
			title: 'Delete job',
			description: 'Delete a job with its run history and output; a run in progress is stopped. To stop it firing for a while, pause_job instead. Requires confirmation.',
			inputSchema: z.object({ project: jobProject, job: jobName }),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
			scopeChallenge: requires('project:update'),
		},
		async ({ project, job }, ctx) => {
			const target = `${project}/${job}`;
			const remove = () => run(() => core.jobs.remove(principal, core.projects.requireRow(principal, project), job));
			if (era === 'assistant') return remove();
			if (era === 'legacy')
				return {
					isError: true,
					...text(`Deleting job "${job}" needs your confirmation, which this MCP client can't show. Delete it from the Skiff dashboard (${project} → Jobs).`),
				};
			const key = `confirm_delete_job:${target}`;
			const schema = z.object({ confirm: z.boolean() });
			const prompted = verifyConfirmation(ctx.mcpReq.requestState(), principal, 'delete_job', target);
			const answer = prompted ? acceptedContent(ctx.mcpReq.inputResponses, key, schema) : undefined;
			const responded = prompted && ctx.mcpReq.inputResponses?.[key] !== undefined;
			if (responded && answer?.confirm !== true) {
				const cancelled = text(`Cancelled: job "${job}" was not deleted (the user did not confirm).`);
				declined.add(cancelled);
				return cancelled;
			}
			if (answer?.confirm !== true)
				return inputRequired({
					inputRequests: {
						[key]: inputRequired.elicit({
							message: `Delete job "${job}" from ${project}? Its schedule, run history and output are removed; a run in progress is stopped.`,
							requestedSchema: schema,
						}),
					},
					requestState: mintConfirmation(principal, 'delete_job', target),
				});
			return remove();
		},
	);

	tool(
		'set_workload',
		{
			title: 'Set workload',
			description:
				'Set the runtime spec for a process/container project. Secrets are references only; values never leave the platform. A reference resolves to the project\'s own secret, then the organisation\'s; unknown names, missing pinned versions and names set both as plain env and by a secret are refused.',
			inputSchema: workloadSpecSchema.extend({ project: z.string() }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('project:update'),
		},
		async ({ project, ...input }) =>
			run(() => core.workloads.setSpec(principal, core.projects.requireRow(principal, project), input)),
	);

	tool(
		'get_node_capacity',
		{
			title: 'Get node capacity',
			description: 'Per-node workload-slice budget and reservation (platform admin view).',
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('project:read'),
		},
		async () => run(() => ({ capacity: core.workloads.capacity(principal) })),
	);

	// --- app volumes (plan 07; ids and mount paths only, never a host path) -----------------
	tool(
		'list_volumes',
		{
			title: 'List app volumes',
			description:
				'List the persistent app volumes for one project, with size, usage, status, attachments and the current read-write owner. No host path or device is returned.',
			inputSchema: z.object({ project: z.string().describe('Project slug') }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('project:read'),
		},
		async ({ project }) =>
			run(() => {
				const row = core.projects.requireRow(principal, project);
				return { project, volumes: core.appVolumes.list(principal, row) };
			}),
	);

	tool(
		'create_volume',
		{
			title: 'Create app volume',
			description:
				'Create a project-owned persistent volume with a size quota. It is backed by the helper state directory by default, or by a registered node volume (`backing: "node_volume"` plus `nodeVolume`). Disk admission reserves at most 90% of free space. Attach it with attach_volume.',
			inputSchema: z.object({
				project: z.string().describe('Project slug'),
				name: z.string().min(3).max(40).describe('Volume name (slug rules)'),
				sizeMb: z.number().int().min(1).max(1_048_576).default(1024).describe('Quota in MB'),
				backing: z.enum(['state_dir', 'node_volume']).default('state_dir'),
				nodeVolume: z.string().optional().describe('Node volume name, required for backing "node_volume"'),
				singleWriter: z.boolean().default(true),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
			scopeChallenge: requires('project:update'),
		},
		async ({ project, ...input }) =>
			run(() => {
				const row = core.projects.requireRow(principal, project);
				const view = core.appVolumes.create(principal, row, input);
				return {
					volume: view,
					nextSteps: [
						`Attach it with attach_volume({ project: "${project}", volume: "${view.name}", mountPath: "/var/lib/app" }).`,
						'Mount paths are inside the workload; they are never host paths.',
					],
				};
			}),
	);

	tool(
		'attach_volume',
		{
			title: 'Attach app volume',
			description:
				'Mount a volume into a project workload at an absolute sandbox path. A single-writer volume refuses a second read-write attachment; read-only attachments are unlimited. The app restarts with the mount.',
			inputSchema: appVolumeAttachSchema.extend({
				project: z.string().describe('Project slug'),
				volume: z.string().describe('Volume name'),
				workload: z.string().optional().describe('Workload id or project slug; defaults to the project'),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
			scopeChallenge: requires('project:update'),
		},
		async ({ project, volume, workload, ...input }) =>
			run(() => {
				const row = core.projects.requireRow(principal, project);
				const view = core.appVolumes.attach(principal, row, volume, {
					...input,
					workload: workload ?? project,
				});
				return {
					volume: view,
					nextSteps: [
						'The workload restarts with the mount on its node; a missing backing mount fails the start.',
					],
				};
			}),
	);

	tool(
		'detach_volume',
		{
			title: 'Detach app volume',
			description:
				'Unmount a volume from a project workload. The volume and its data are untouched and can be attached again.',
			inputSchema: appVolumeDetachSchema.extend({
				project: z.string().describe('Project slug'),
				volume: z.string().describe('Volume name'),
				workload: z.string().optional().describe('Workload id or project slug; defaults to the project'),
			}),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
			scopeChallenge: requires('project:update'),
		},
		async ({ project, volume, workload, ...input }) =>
			run(() => {
				const row = core.projects.requireRow(principal, project);
				core.appVolumes.detach(principal, row, volume, {
					...input,
					workload: workload ?? project,
				});
				return { ok: true, project, volume };
			}),
	);

	tool(
		'list_volume_snapshots',
		{
			title: 'List app volume snapshots',
			description:
				'List the snapshots of one app volume, newest first: status, size, sha256 checksum, how the node copied it (`reflink`, `paused`, `idle` or `live`), the backup target it was written to and when a restore last verified it. ' +
				'A trashed volume keeps its snapshots until it is purged.',
			inputSchema: z.object({
				project: z.string().describe('Project slug'),
				volume: z.string().describe('Volume name'),
			}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('project:read'),
		},
		async ({ project, volume }) =>
			run(() => {
				const row = core.projects.requireRow(principal, project);
				return { project, volume, snapshots: core.appVolumes.lifecycle.listSnapshots(principal, row, volume) };
			}),
	);

	tool(
		'snapshot_volume',
		{
			title: 'Snapshot app volume',
			description:
				"Queue a snapshot of an app volume. Its node pauses the read-write writer (a cgroup freeze, not a restart) while it copies, then streams a gzip tar to the backup target that applies now (or `target`). " +
				'`quiesce: false` copies without pausing and may be inconsistent. Agents should call this before a risky migration; follow it with list_volume_snapshots.',
			inputSchema: appVolumeSnapshotCreateSchema.extend({
				project: z.string().describe('Project slug'),
				volume: z.string().describe('Volume name'),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
			scopeChallenge: requires('project:update'),
		},
		async ({ project, volume, ...input }) =>
			run(() => {
				const row = core.projects.requireRow(principal, project);
				const snapshot = core.appVolumes.lifecycle.createSnapshot(principal, row, volume, input);
				return {
					snapshot,
					nextSteps: [
						...(snapshot.quiesce ? [] : ['quiesce is off: the copy may be inconsistent if the app writes while it runs.']),
						'The volume\'s node picks the task up on its next pull; poll list_volume_snapshots until status is ok or failed.',
					],
				};
			}),
	);

	tool(
		'restore_volume',
		{
			title: 'Restore app volume snapshot',
			description:
				'Restore a completed snapshot into a NEW volume in the same project (never over the source), on the same backing and at least the same size. ' +
				'Quotas and disk admission apply. The new volume cannot be attached until its node has extracted the archive and matched its checksum.',
			inputSchema: appVolumeRestoreSchema.extend({
				project: z.string().describe('Project slug'),
				volume: z.string().describe('Source volume name'),
				snapshotId: z.string().describe('Snapshot id (avs_…) from list_volume_snapshots'),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
			scopeChallenge: requires('project:update'),
		},
		async ({ project, volume, snapshotId, ...input }) =>
			run(() => {
				const row = core.projects.requireRow(principal, project);
				const view = core.appVolumes.lifecycle.restore(principal, row, volume, snapshotId, input);
				return {
					volume: view,
					nextSteps: [
						`Poll list_volumes until "${view.name}" is ready (restoringFrom is null).`,
						`Then attach it with attach_volume({ project: "${project}", volume: "${view.name}", mountPath: "/var/lib/app" }).`,
					],
				};
			}),
	);

	// --- managed databases (docs/DATABASES.md; no credentials or purge over MCP, D58/D53) ----
	const connectionNote =
		'Attached apps get <PREFIX>_URL, _HOST, _PORT, _USER, _PASSWORD and _NAME injected at activation (PREFIX defaults to DATABASE; ' +
		'MONGODB for MongoDB, which also gets _URI; REDIS for Valkey/Redis; CLICKHOUSE for ClickHouse, whose URL is its HTTP interface), ' +
		"so read the URL from the environment; never hard-code credentials. An app must run on the database's node: " +
		"placement `auto` handles that, an explicit placement on another node is rejected.";

	tool(
		'list_databases',
		{
			title: 'List databases',
			description: 'List managed databases (every engine) in the org with status, node, size and attached projects.',
			inputSchema: z.object({
				includeDeleted: z.boolean().default(false).describe('Also list databases in the trash'),
			}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('database:read'),
		},
		async ({ includeDeleted }) => run(() => ({ databases: core.databases.list(principal, { includeDeleted }) })),
	);

	tool(
		'get_database',
		{
			title: 'Get database',
			description:
				'Get one managed database: status, node, limits, attachments, the largest tables, and a last-hour summary ' +
				'(latest size vs the storage budget, connections vs max_connections, commits/min, cache hit ratio). Never includes credentials.',
			inputSchema: z.object({ database: z.string().describe('Database name') }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('database:read'),
		},
		async ({ database }) =>
			run(async () => {
				const view = core.databases.get(principal, database, { includeDeleted: true });
				return { ...view, lastHour: await databaseLastHour(principal, view.name, view.storageMb) };
			}),
	);

	tool(
		'get_database_logs',
		{
			title: 'Get database logs',
			description:
				'Return recent container log lines for a managed database (the agent drains the unit journal). ' +
				'Use `after` as a cursor to poll for new lines; `level` and `q` filter server-side.',
			inputSchema: z.object({
				database: z.string().describe('Database name'),
				after: z.number().int().nonnegative().optional().describe('Return lines after this cursor'),
				limit: z.number().int().min(1).max(2000).default(200),
				level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
				q: z.string().max(200).optional(),
			}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('database:read', 'logs:read'),
		},
		async ({ database, after, limit, level, q }) =>
			run(() => {
				const view = core.databases.requireRow(principal, database, { includeDeleted: true });
				return core.logs.queryService(principal, 'database', view.id, {
					...(after !== undefined ? { after } : {}),
					limit,
					...(level ? { level } : {}),
					...(q ? { q } : {}),
				});
			}),
	);

	tool(
		'create_database',
		{
			title: 'Create database',
			description:
				'Create a managed database. `engine` is postgres (default; 17 or 16), mysql (8.4 or 9.7), mariadb (11.8 or 11.4), ' +
				'mongodb (8.0 or 9.0), valkey (9.1 or 8.1, Redis-compatible), redis (8.10 or 8.8) or clickhouse (26.8 or 26.3, ' +
				'analytics; at least 1 GB memory, default 2 GB). Pooling, extensions, metrics and PITR are Postgres-only; every engine ' +
				'has backups (its native dump format); ClickHouse has no studio yet. Pass `project` to attach it in the same call; ' +
				`the database is then placed on that project's node. ${connectionNote}`,
			inputSchema: databaseCreateSchema,
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
			scopeChallenge: requiresWith(['database:create'], (args) => (args.project ? ['project:update'] : [])),
		},
		async (input) =>
			run(() => {
				const view = core.databases.create(principal, input);
				const attached = view.attachments[0];
				return {
					database: view,
					nextSteps: attached
						? [
								`"${attached.projectSlug}" receives ${attached.envNames.join(', ')} at its next activation (a running app restarts on its own).`,
								`The database starts on node "${view.nodeName ?? view.nodeId}"; follow it with get_database.`,
							]
						: [
								`Attach it to an app with attach_database({ project, database: "${view.name}" }).`,
								`The database starts on node "${view.nodeName ?? view.nodeId}"; follow it with get_database.`,
							],
				};
			}),
	);

	tool(
		'list_database_backups',
		{
			title: 'List database backups',
			description:
				'List logical backups for one database with size, checksum, age, whether a restore has been verified and the target each was written to (`target.available` is false when that target was deleted). ' +
				'Restores and retention always use the recorded target; no credentials are returned.',
			inputSchema: z.object({ database: z.string().describe('Database name') }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('database:read'),
		},
		async ({ database }) =>
			run(() => ({
				database,
				backups: core.databases.listBackups(principal, database),
				policy: core.databases.backupPolicy(principal, database),
			})),
	);

	tool(
		'list_backup_targets',
		{
			title: 'List backup targets',
			description:
				'List local and S3-compatible backup targets for this org and the platform default. Credentials are never returned.',
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('database:read'),
		},
		async () => run(() => ({ targets: core.backupTargets.list(principal) })),
	);

	tool(
		'create_backup_target',
		{
			title: 'Create backup target',
			description:
				'Create a local directory or S3-compatible backup target (R2, RustFS, MinIO, Garage, Backblaze, Wasabi). ' +
				'Credentials are sealed and never returned here; use the dashboard or API for the one-time reveal. ' +
				'Test it with test_backup_target before relying on it.',
			inputSchema: backupTargetCreateSchema,
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
			scopeChallenge: requires('database:update'),
		},
		async (input) =>
			run(() => ({ target: core.backupTargets.create(principal, input).target })),
	);

	tool(
		'test_backup_target',
		{
			title: 'Test backup target',
			description:
				'Probe a backup target (bucket/head, put, list and delete when allowed) and record its status. ' +
				'Returns capabilities and a clear error; never credentials.',
			inputSchema: z.object({ target: z.string().describe('Backup target id from list_backup_targets') }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('database:update'),
		},
		async ({ target }) => run(() => ({ result: core.backupTargets.testConnection(principal, target) })),
	);

	tool(
		'backup_database',
		{
			title: 'Back up database',
			description:
				'Queue an on-demand backup in the engine\'s native format (`pg_dump -Fc`, mysqldump, mongodump, an RDB snapshot or a ClickHouse BACKUP archive). The node streams it to the backup target that applies now, which the backup records; follow it with ' +
				'list_database_backups. Agents should call this before a risky migration.',
			inputSchema: databaseBackupCreateSchema.extend({ database: z.string().describe('Database name') }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
			scopeChallenge: requires('database:update'),
		},
		async ({ database, ...input }) =>
			run(() => {
				const backup = core.databases.createBackup(principal, database, input);
				return {
					backup,
					nextSteps: ['The database node picks the task up on its next pull; poll list_database_backups.'],
				};
			}),
	);

	tool(
		'restore_database',
		{
			title: 'Restore database backup',
			description:
				'Restore a backup into a brand-new database (never in place). The new instance gets new credentials and its node ' +
				'restores the dump with the engine\'s own tool, then runs a verification query. Requires a completed backup from list_database_backups.',
			inputSchema: databaseRestoreSchema.extend({
				database: z.string().describe('Source database name'),
				backupId: z.string().describe('Backup id'),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
			scopeChallenge: requiresWith(['database:create'], (args) => (args.project ? ['project:update'] : [])),
		},
		async ({ database, backupId, ...input }) =>
			run(() => {
				const view = core.databases.restoreBackup(principal, database, backupId, input);
				return {
					database: view,
					nextSteps: [
						`The node restores into "${view.name}" and verifies it; follow get_database until backup.pendingRestoreId is null.`,
						`Connect an app with attach_database({ project, database: "${view.name}" }).`,
					],
				};
			}),
	);

	tool(
		'set_database_backup_policy',
		{
			title: 'Set database backup policy',
			description:
				'Change the schedule, retention or enabled flag for scheduled logical backups. The schedule is a five-field ' +
				'UTC cron expression; retention never removes the newest good backup.',
			inputSchema: databaseBackupPolicySchema.extend({ database: z.string().describe('Database name') }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('database:update'),
		},
		async ({ database, ...input }) =>
			run(() => ({ policy: core.databases.setBackupPolicy(principal, database, input) })),
	);

	// ---------------------------------------------------------------- point-in-time recovery (docs/PITR.md)

	tool(
		'get_database_pitr',
		{
			title: 'Get database PITR status',
			description:
				'Point-in-time recovery state for one PostgreSQL database: whether WAL archiving is on, archive health, the last ' +
				'base backup and the recoverable window (`recoverableFrom` → `recoverableTo`, from the node\'s check every 15 minutes). ' +
				'A restore target must fall inside that window. Offered while SKIFF_FEATURE_PITR is on; never returns repository credentials.',
			inputSchema: z.object({ database: z.string().describe('Database name') }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			feature: 'PITR',
			scopeChallenge: requires('database:read'),
		},
		async ({ database }) => run(() => ({ pitr: core.databases.pitrStatus(principal, database) })),
	);

	tool(
		'set_database_pitr',
		{
			title: 'Turn database PITR on or off',
			description:
				'Enable or disable point-in-time recovery for a PostgreSQL 18 database on the standard image (needs SKIFF_FEATURE_PITR ' +
				'and a pgBackRest repository on the control plane). Enabling restarts the database on the PITR image and queues the ' +
				'first full base backup; the recoverable window appears once the node reports it. Disabling stops WAL archiving.',
			inputSchema: databasePitrPolicySchema.extend({ database: z.string().describe('Database name') }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
			feature: 'PITR',
			scopeChallenge: requires('database:update'),
		},
		async ({ database, ...input }) =>
			run(() => ({
				pitr: core.databases.setPitrPolicy(principal, database, input),
				nextSteps: input.enabled
					? ['Poll get_database_pitr until lastBaseBackupAt and recoverableFrom are set before relying on a restore.']
					: [],
			})),
	);

	tool(
		'backup_database_pitr',
		{
			title: 'Take a PITR base backup',
			description:
				'Queue a pgBackRest base backup (full, diff or incr; default full) for a database with PITR on. Weekly full and daily ' +
				'differential backups already run on their own; take one before a risky change to shorten the WAL a restore must replay.',
			inputSchema: databasePitrBackupSchema.extend({ database: z.string().describe('Database name') }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
			feature: 'PITR',
			scopeChallenge: requires('database:update'),
		},
		async ({ database, ...input }) =>
			run(() => ({
				task: core.databases.pitrBackup(principal, database, input),
				nextSteps: ['The node runs it on its next pull; follow lastBaseBackupAt in get_database_pitr.'],
			})),
	);

	tool(
		'restore_database_to_time',
		{
			title: 'Restore database to a point in time',
			description:
				'Restore a PITR-enabled database to a moment (ISO 8601 with an offset or Z) into a brand-new database on the same node ' +
				'(never in place). The time must be inside the recoverable window from get_database_pitr. The new database gets its own ' +
				'credentials, stays pending until the node has replayed WAL and verified a login, and has scheduled dumps paused until then.',
			inputSchema: databasePitrRestoreSchema.extend({ database: z.string().describe('Source database name') }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
			feature: 'PITR',
			scopeChallenge: requires('database:create'),
		},
		async ({ database, ...input }) =>
			run(() => {
				const view = core.databases.restoreToTimestamp(principal, database, input);
				return {
					database: view,
					nextSteps: [
						`Follow get_database("${view.name}") until it is running; get_database_pitr("${database}") shows verifiedAt.`,
						`Compare rows, then attach_database({ project, database: "${view.name}" }).`,
					],
				};
			}),
	);

	tool(
		'restart_services',
		{
			title: 'Restart managed services',
			description:
				'Restart all managed databases, all storage instances, or both. Each item is an ordinary restart request ' +
				'(generation bump); the nodes apply them on their next pull. Returns per-item skips, never credentials.',
			inputSchema: serviceRestartSchema,
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
			scopeChallenge: requiresWith([], (args) => {
				const scope = typeof args.scope === 'string' ? args.scope : 'all';
				return scope === 'databases'
					? ['database:update']
					: scope === 'storage'
						? ['storage:update']
						: ['database:update', 'storage:update'];
			}),
		},
		async (input) =>
			run(() => {
				const result = core.serviceActions.restart(principal, input);
				return {
					...result,
					nextSteps: [
						'The nodes restart the selected containers on their next pull; follow each service status in the dashboard.',
					],
				};
			}),
	);

	tool(
		'backup_all_databases',
		{
			title: 'Back up all databases',
			description:
				'Queue a logical backup for every live database that is not already backing up. Returns the queued names and ' +
				'per-database skips (for example an attached database that is already running a backup).',
			inputSchema: z.object({}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
			scopeChallenge: requires('database:update'),
		},
		async () =>
			run(() => {
				const result = core.serviceActions.backupAllDatabases(principal);
				return {
					...result,
					nextSteps: ['The nodes upload the dumps on their next pull; follow each database Backups panel.'],
				};
			}),
	);

	tool(
		'update_database',
		{
			title: 'Update database',
			description:
				'Resize a database (memory, CPU, storage budget), turn the PgBouncer pooler on or off, set the enabled ' +
				'PostgreSQL extensions (the full list; removing one never drops it), or move MySQL, MariaDB, Valkey, Redis ' +
				'or ClickHouse forward to a newer listed version in place. Downgrades, MongoDB version changes and ' +
				'PostgreSQL major changes are refused; a Postgres major goes through the upgrade planner. A version, ' +
				'pooler or extension change restarts the database on its node; memory and CPU limits apply at its next ' +
				'restart (restart_database). The data is kept.',
			inputSchema: z.object({ database: z.string().describe('Database name'), ...databaseUpdateSchema.shape }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('database:update'),
		},
		async ({ database, ...patch }) =>
			run(() => ({
				database: core.databases.update(principal, database, patch),
				nextSteps: ['Follow get_database until it is running again; call restart_database to apply new limits now.'],
			})),
	);

	tool(
		'restart_database',
		{
			title: 'Restart database',
			description:
				'Restart the database container (and its PgBouncer sidecar), or only the pooler. The node picks the ' +
				'request up on its next pull; attached apps keep their connection settings and reconnect automatically.',
			inputSchema: databaseRestartSchema.extend({ database: z.string().describe('Database name') }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
			scopeChallenge: requires('database:update'),
		},
		async ({ database, target }) =>
			run(() => {
				const view = core.databases.restart(principal, database, { target });
				return {
					database: view,
					target,
					nextSteps: [
						target === 'pooler'
							? 'The pooler restarts without touching Postgres; follow the database status for readiness.'
							: 'The database restarts on its node; follow get_database until it is running again.',
					],
				};
			}),
	);

	// --- read replicas (docs/CLUSTERING.md §9.2, C7). Promotion is dashboard/CLI/REST only. ---
	tool(
		'list_database_replicas',
		{
			title: 'List database replicas',
			description:
				'List the streaming read replicas of a Postgres database: node, status (pending, streaming, lagging, stopped, lost, failed), ' +
				'replay LSN, lag in bytes and seconds, and the promotion history. Attached apps get <PREFIX>_READ_URL, _READ_URLS, ' +
				'_READ_HOST and _READ_PORT while a replica they can reach is streaming or lagging; reads may trail the primary by the lag.',
			inputSchema: z.object({ database: z.string().describe('Database name') }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('database:read'),
		},
		async ({ database }) =>
			run(() => ({
				database,
				primaryGeneration: core.databases.get(principal, database).primaryGeneration,
				replicas: core.databaseReplicas.list(principal, database),
				failovers: core.databaseReplicas.failovers(principal, database),
			})),
	);

	tool(
		'create_database_replica',
		{
			title: 'Add a database replica',
			description:
				'Add an asynchronous streaming read replica of a Postgres database on a node (another node for protection from node loss, ' +
				'or the same node for read scaling only). It reserves the database\'s memory on that node, copies the primary with ' +
				'pg_basebackup on first start, then streams. Attached apps restart once it streams, to pick up <PREFIX>_READ_URL. ' +
				'Synchronous replicas are not available.',
			inputSchema: databaseReplicaCreateSchema.extend({ database: z.string().describe('Database name') }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
			scopeChallenge: requires('database:update'),
		},
		async ({ database, ...input }) =>
			run(() => ({
				replica: core.databaseReplicas.add(principal, database, input),
				nextSteps: ['Follow list_database_replicas until the replica is streaming; the first copy takes as long as pg_basebackup needs.'],
			})),
	);

	tool(
		'delete_database_replica',
		{
			title: 'Remove a database replica',
			description:
				'Remove a read replica: it stops, its node deletes its copy of the data and the primary drops its replication slot. ' +
				'The primary and its data are untouched; apps lose <PREFIX>_READ_URL if it was their read target. Requires confirmation.',
			inputSchema: z.object({
				database: z.string().describe('Database name'),
				replica: z.string().describe('Replica id (dbr_…)'),
			}),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
			scopeChallenge: requires('database:read', 'database:update'),
		},
		async ({ database, replica }, ctx) => {
			const target = `${database}/${replica}`;
			if (era === 'assistant') return run(() => ({ replica: core.databaseReplicas.remove(principal, database, replica) }));
			if (era === 'legacy')
				return {
					isError: true,
					...text(
						`Removing replica ${replica} needs your confirmation, which this MCP client can't show. ` +
							`Ask the user to remove it from the Skiff dashboard: ${core.ctx.config.platformOrigin}/databases/${encodeURIComponent(database)}`,
					),
				};
			const key = `confirm_delete_database_replica:${target}`;
			const schema = z.object({ confirm: z.boolean() });
			const prompted = verifyConfirmation(ctx.mcpReq.requestState(), principal, 'delete_database_replica', target);
			const answer = prompted ? acceptedContent(ctx.mcpReq.inputResponses, key, schema) : undefined;
			const responded = prompted && ctx.mcpReq.inputResponses?.[key] !== undefined;
			if (responded && answer?.confirm !== true) {
				const cancelled = text(`Cancelled: replica ${replica} was not removed (the user did not confirm).`);
				declined.add(cancelled);
				return cancelled;
			}
			if (answer?.confirm !== true) {
				let found: DatabaseReplicaView | undefined;
				try {
					found = core.databaseReplicas.list(principal, database).find((item) => item.id === replica);
				} catch (error) {
					return run(() => {
						throw error;
					});
				}
				if (!found) return { isError: true, ...text(`Database "${database}" has no replica ${replica}.`) };
				return inputRequired({
					inputRequests: {
						[key]: inputRequired.elicit({
							message:
								`Remove the replica of "${database}" on node "${found.nodeName ?? found.nodeId}"? Its copy of the data is ` +
								'deleted from that node; the primary is untouched.',
							requestedSchema: schema,
						}),
					},
					requestState: mintConfirmation(principal, 'delete_database_replica', target),
				});
			}
			return run(() => ({ replica: core.databaseReplicas.remove(principal, database, replica) }));
		},
	);

	tool(
		'rotate_database_credentials',
		{
			title: 'Rotate database credentials',
			description:
				'Rotate the owner or monitor password. The node runs ALTER ROLE and verifies the new value before the ' +
				'control plane swaps the live secret; attached apps restart with it. No password is returned.',
			inputSchema: databaseRotateSchema.extend({ database: z.string().describe('Database name') }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
			scopeChallenge: requires('database:credentials', 'database:update'),
		},
		async ({ database, ...input }) =>
			run(() => {
				const rotation = core.databases.rotateCredentials(principal, database, input);
				return {
					rotation,
					nextSteps: ['The node applies ALTER ROLE on its next pull; poll get_database or the rotation list.'],
				};
			}),
	);

	// Named credentials (docs/DATABASES.md §16). Metadata only: a password is never returned over
	// MCP; apps get theirs injected and humans reveal it from the dashboard or `skif db credentials`.
	const credentialNote =
		'No password is returned over MCP: apps attached with the credential get it injected, and humans reveal it from the dashboard or `skif db credentials reveal`.';
	const credentialInput = z.object({
		database: z.string().describe('Database name'),
		credentialId: z.string().describe('Credential id (dbc_…) from list_database_credentials'),
	});

	tool(
		'list_database_credentials',
		{
			title: 'List database credentials',
			description:
				'List a database\'s credentials: the built-in owner and monitor roles plus named app, readonly and backup roles, with status, purpose and expiry. ' +
				credentialNote,
			inputSchema: z.object({ database: z.string().describe('Database name') }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('database:read'),
		},
		async ({ database }) => run(() => ({ credentials: core.databases.listCredentials(principal, database) })),
	);

	tool(
		'create_database_credential',
		{
			title: 'Create database credential',
			description:
				'Create a named Postgres credential: app (read/write on tables), readonly (SELECT only) or backup (read for dumps). ' +
				'The node provisions the role; it starts pending and is ready once the node confirms. ' +
				'Use it from an app with attach_database and `credential`. ' +
				credentialNote,
			inputSchema: databaseCredentialCreateSchema.extend({ database: z.string().describe('Database name') }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
			scopeChallenge: requires('database:credentials', 'database:update'),
		},
		async ({ database, ...input }) =>
			run(() => ({
				credential: core.databases.createCredential(principal, database, input),
				nextSteps: ['The node creates the role on its next pull; poll list_database_credentials until it is ready.'],
			})),
	);

	tool(
		'rotate_database_credential',
		{
			title: 'Rotate database credential',
			description:
				'Rotate a named (app, readonly or backup) credential\'s password. The node runs ALTER ROLE first; only then does the live ' +
				'secret swap and apps attached with this credential restart with it. For the owner or monitor use rotate_database_credentials. ' +
				credentialNote,
			inputSchema: credentialInput,
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
			scopeChallenge: requires('database:credentials', 'database:update'),
		},
		async ({ database, credentialId }) =>
			run(() => ({
				credential: core.databases.rotateNamedCredential(principal, database, credentialId),
				nextSteps: ['The node applies ALTER ROLE on its next pull; poll list_database_credentials until it is ready.'],
			})),
	);

	tool(
		'revoke_database_credential',
		{
			title: 'Revoke database credential',
			description:
				'Revoke a named (app, readonly or backup) credential: the node disables its login, so anything still using it is locked out. ' +
				'Refused while an app is attached with it (detach_database first). Requires confirmation.',
			inputSchema: credentialInput,
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
			scopeChallenge: requires('database:credentials', 'database:update'),
		},
		async ({ database, credentialId }, ctx) => {
			const revoke = () =>
				run(() => ({
					credential: core.databases.revokeCredential(principal, database, credentialId),
					nextSteps: ['The node disables the role on its next pull; it then shows as revoked.'],
				}));
			// The dashboard assistant gates destructive tools in the chat UI before they reach here.
			if (era === 'assistant') return revoke();
			if (era === 'legacy')
				return {
					isError: true,
					...text(
						`Revoking credential ${credentialId} needs your confirmation, which this MCP client can't show. ` +
							`Ask the user to revoke it from the Skiff dashboard: ${core.ctx.config.platformOrigin}/databases/${encodeURIComponent(database)}`,
					),
				};
			const target = `${database}/${credentialId}`;
			const key = `confirm_revoke_database_credential:${target}`;
			const schema = z.object({ confirm: z.boolean() });
			// Only an answer to a prompt we issued (signed requestState bound to this target) counts.
			const prompted = verifyConfirmation(ctx.mcpReq.requestState(), principal, 'revoke_database_credential', target);
			const answer = prompted ? acceptedContent(ctx.mcpReq.inputResponses, key, schema) : undefined;
			const responded = prompted && ctx.mcpReq.inputResponses?.[key] !== undefined;
			if (responded && answer?.confirm !== true) {
				const cancelled = text(`Cancelled: credential ${credentialId} was not revoked (the user did not confirm).`);
				declined.add(cancelled);
				return cancelled;
			}
			if (answer?.confirm === true) return revoke();
			// Fail before prompting when the revoke can't be found.
			let credential: DatabaseCredentialView | undefined;
			try {
				credential = core.databases.listCredentials(principal, database).find((item) => item.id === credentialId);
			} catch (error) {
				return run(() => {
					throw error;
				});
			}
			if (!credential) return { isError: true, ...text(`Credential ${credentialId} was not found on "${database}".`) };
			return inputRequired({
				inputRequests: {
					[key]: inputRequired.elicit({
						message:
							`Revoke the ${credential.role} credential "${credential.username}" on "${database}"? ` +
							'Anything still connecting with it is locked out.',
						requestedSchema: schema,
					}),
				},
				requestState: mintConfirmation(principal, 'revoke_database_credential', target),
			});
		},
	);

	tool(
		'attach_database',
		{
			title: 'Attach database',
			description:
				`Connect a database to a process or container project. ${connectionNote} ` +
				'Attaching re-activates (restarts) a running app; no redeploy is needed if it already runs on the database node. ' +
				'Pass `credential` (an id from list_database_credentials, or app/readonly/backup when there is exactly one ready) to connect ' +
				'as a named Postgres credential instead of the owner; such an attachment connects directly and gets no _POOL_* variables.',
			inputSchema: databaseAttachSchema.extend({ project: z.string().describe('Project slug') }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
			scopeChallenge: requires('database:update', 'project:update'),
		},
		async ({ project, ...input }) =>
			run(() => {
				const result = core.databases.attach(principal, core.projects.requireRow(principal, project), input);
				return {
					...result,
					nextSteps: [
						`Read ${result.attachment.envPrefix}_URL in the app; it is injected at activation.`,
						...(result.warning ? [result.warning] : []),
					],
				};
			}),
	);

	tool(
		'detach_database',
		{
			title: 'Detach database',
			description:
				'Disconnect a database from a project. The app restarts without its <PREFIX>_* variables; the database and its data are untouched.',
			inputSchema: z.object({
				project: z.string().describe('Project slug'),
				database: z.string().describe('Database name'),
			}),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
			scopeChallenge: requires('database:update', 'project:update'),
		},
		async ({ project, database }) =>
			run(() => {
				core.databases.detach(principal, core.projects.requireRow(principal, project), database);
				return { ok: true, project, database };
			}),
	);

	tool(
		'delete_database',
		{
			title: 'Delete database',
			description:
				'Soft-delete a database: its container stops, the data stays on the node and it can be restored for the trash period (7 days by default). ' +
				'Refused while projects are attached (detach_database first). Requires confirmation. Permanent deletion is dashboard/CLI only.',
			inputSchema: z.object({ database: z.string().describe('Database name') }),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
			scopeChallenge: requires('database:read', 'database:delete'),
		},
		async ({ database }, ctx) => {
			if (era === 'assistant')
				return run(() => {
					const view = core.databases.delete(principal, database);
					return {
						ok: true,
						database: view.name,
						restorable: true,
						restoreBefore: view.purgeAt
					};
				});
			if (era === 'legacy')
				return {
					isError: true,
					...text(
						`Deleting database "${database}" needs your confirmation, which this MCP client can't show. ` +
							`Ask the user to delete it from the Skiff dashboard: ${core.ctx.config.platformOrigin}/databases/${encodeURIComponent(database)}`,
					),
				};
			const key = `confirm_delete_database:${database}`;
			const schema = z.object({ confirm: z.boolean() });
			// Only an answer to a prompt we issued (signed requestState bound to this target) counts.
			const prompted = verifyConfirmation(ctx.mcpReq.requestState(), principal, 'delete_database', database);
			const answer = prompted ? acceptedContent(ctx.mcpReq.inputResponses, key, schema) : undefined;
			const responded = prompted && ctx.mcpReq.inputResponses?.[key] !== undefined;
			if (responded && answer?.confirm !== true) {
				const cancelled = text(`Cancelled: database "${database}" was not deleted (the user did not confirm).`);
				declined.add(cancelled);
				return cancelled;
			}
			if (answer?.confirm !== true) {
				// Fail before prompting when the delete can't succeed (unknown, or still attached).
				let view: DatabaseView;
				try {
					view = core.databases.get(principal, database);
				} catch (error) {
					return run(() => {
						throw error;
					});
				}
				if (view.attachments.length > 0)
					return {
						isError: true,
						...text(
							`Database "${database}" is attached to ${view.attachments.map((item) => item.projectSlug).join(', ')}. ` +
								'Detach it with detach_database first.',
						),
					};
				return inputRequired({
					inputRequests: {
						[key]: inputRequired.elicit({
							message:
								`Delete database "${database}"? Its container stops now; the data stays on node ` +
								`"${view.nodeName ?? view.nodeId}" and it can be restored for ${core.policies.get().trashDays} days.`,
							requestedSchema: schema,
						}),
					},
					requestState: mintConfirmation(principal, 'delete_database', database),
				});
			}
			return run(() => {
				const view = core.databases.delete(principal, database);
				return {
					ok: true,
					database: view.name,
					restorable: true,
					restoreBefore: view.purgeAt,
					nextSteps: ['A human can restore it from the dashboard or with `skif db restore`.'],
				};
			});
		},
	);

	// --- managed queue brokers (docs/BROKERS.md, D111; no credentials, delete or purge over MCP) ----
	const brokerNote =
		'Attached apps get <PREFIX>_URL, _HOST, _PORT, _USER and _PASSWORD injected at activation (PREFIX defaults to NATS, ' +
		'so NATS_URL is what most NATS clients read); never hard-code credentials. JetStream is on: use streams and durable ' +
		"consumers for work queues. An app must run on the broker's node: placement `auto` handles that.";

	tool(
		'list_brokers',
		{
			title: 'List queue brokers',
			description: 'List managed queue brokers (NATS with JetStream) in the org with status, node, limits and attached projects.',
			inputSchema: z.object({
				includeDeleted: z.boolean().default(false).describe('Also list brokers in the trash'),
			}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('broker:read'),
		},
		async ({ includeDeleted }) => run(() => ({ brokers: core.brokers.list(principal, { includeDeleted }) })),
	);

	tool(
		'get_broker',
		{
			title: 'Get queue broker',
			description: 'Get one managed queue broker: status, node, engine/version, limits, internal hosts and attachments. Never includes credentials.',
			inputSchema: z.object({ broker: z.string().describe('Broker name') }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('broker:read'),
		},
		async ({ broker }) => run(() => core.brokers.get(principal, broker, { includeDeleted: true })),
	);

	tool(
		'get_broker_logs',
		{
			title: 'Get queue broker logs',
			description:
				'Return recent container log lines for a managed broker. Use `after` as a cursor to poll for new lines; `level` and `q` filter server-side.',
			inputSchema: z.object({
				broker: z.string().describe('Broker name'),
				after: z.number().int().nonnegative().optional().describe('Return lines after this cursor'),
				limit: z.number().int().min(1).max(2000).default(200),
				level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
				q: z.string().max(200).optional(),
			}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('broker:read', 'logs:read'),
		},
		async ({ broker, after, limit, level, q }) =>
			run(() => {
				const row = core.brokers.requireRow(principal, broker, { includeDeleted: true });
				return core.logs.queryService(principal, 'broker', row.id, {
					...(after !== undefined ? { after } : {}),
					limit,
					...(level ? { level } : {}),
					...(q ? { q } : {}),
				});
			}),
	);

	tool(
		'get_broker_metrics',
		{
			title: 'Get queue broker metrics',
			description:
				'Last-hour summary of a managed broker from its node\'s 1-minute samples (D123): up, connections, JetStream store used vs ' +
				'budget, messages held, consumer backlog (pending, awaiting ack, redelivered), oldest unprocessed message age, and ' +
				'messages stored / in / out over the hour. Needs the optional telemetry store; without it, use get_broker_queues.',
			inputSchema: z.object({ broker: z.string().describe('Broker name') }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('broker:read'),
		},
		async ({ broker }) =>
			run(async () => {
				const row = core.brokers.get(principal, broker, { includeDeleted: true });
				return { broker: row.name, ...(await brokerLastHour(principal, row.name, row.storageMb)) };
			}),
	);

	tool(
		'get_broker_queues',
		{
			title: 'Get queue broker streams',
			description:
				'The newest JetStream stream listing for a managed broker (D123), refreshed about once a minute: per stream (function ' +
				'queues are SKIFF_Q_<queue>) messages, bytes, consumers, pending, awaiting ack, redelivered and the oldest message time, ' +
				'with each consumer\'s backlog. Works without the telemetry store. To read message bodies use peek_queue_messages; ' +
				'to create a queue, test it or move dead letters back use create_queue, send_queue_message and redrive_queue.',
			inputSchema: z.object({ broker: z.string().describe('Broker name') }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('broker:read'),
		},
		async ({ broker }) => run(() => core.brokers.queues(principal, broker)),
	);

	// Queue tools run on the broker's node and answer within ~20 s (D124). Purging or deleting a
	// stream and deleting a message stay off MCP, like broker delete/purge (D111): dashboard, CLI, REST.
	const queueToolNote =
		`The broker's node runs the task; the call waits up to ${nodeTaskLimits.waitMs / 1000} s and otherwise returns a task id for get_node_task. ` +
		'The broker must be running on a current agent.';

	tool(
		'create_queue',
		{
			title: 'Create queue',
			description:
				'Create the JetStream work-queue stream (SKIFF_Q_<queue>) for a function queue on a managed broker, so producers can send ' +
				'before a consumer is deployed. Idempotent: an existing queue is left as it is. ' +
				queueToolNote,
			inputSchema: z.object({
				broker: z.string().describe('Broker name'),
				queue: functionQueueNameSchema.describe('Queue name, as in the function\'s queue producer/consumer config'),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('broker:update'),
		},
		async ({ broker, queue }) =>
			run(async () => describeNodeTask(await core.nodeTasks.run(principal, core.nodeTasks.brokerTask(principal, broker, 'broker.queue.create', { queue })))),
	);

	tool(
		'send_queue_message',
		{
			title: 'Send queue message',
			description:
				'Publish a test message (or up to ' +
				`${nodeTaskLimits.sendCount} copies) to a function queue on a managed broker. It is a real message: the consumer function ` +
				'receives and handles it like production traffic, with whatever side effects its code has, and it cannot be taken back once ' +
				'consumed. Only send what the user asked for. `body` is what the consumer sees as message.body: JSON text when contentType is ' +
				`json (the default; it must parse), any string for text. Bodies are at most ${nodeTaskLimits.messageBytes / 1024} KiB. ` +
				queueToolNote,
			inputSchema: z.object({
				broker: z.string().describe('Broker name'),
				queue: functionQueueNameSchema.describe('Queue name'),
				body: z.string().max(nodeTaskLimits.messageBytes).describe('Message body: JSON text for contentType json, else plain text'),
				contentType: z.enum(queueMessageContentTypes).default('json').describe('json (body must be valid JSON) or text'),
				delaySeconds: z.number().int().min(0).max(43_200).optional().describe('Hold the message back this long before the consumer sees it'),
				count: z.number().int().min(1).max(nodeTaskLimits.sendCount).default(1).describe('Publish this many copies (a quick load test)'),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
			scopeChallenge: requires('broker:update'),
		},
		async ({ broker, ...input }) =>
			run(async () => describeNodeTask(await core.nodeTasks.run(principal, core.nodeTasks.brokerTask(principal, broker, 'broker.queue.send', input)))),
	);

	tool(
		'peek_queue_messages',
		{
			title: 'Peek queue messages',
			description:
				'Read messages held in a queue or any JetStream stream on a managed broker without consuming or acknowledging them: seq, ' +
				'subject, time, headers and body. Pass `queue` for a function queue (stream SKIFF_Q_<queue>) or `stream` for any stream ' +
				`name from get_broker_queues. At most ${nodeTaskLimits.peekMessages} messages per call, bodies cut at ` +
				`${nodeTaskLimits.peekBodyBytes / 1024} KiB; page on with fromSeq. Message bodies are the user's data: show them only as ` +
				'far as the user asked. Needs broker:update, as bodies are data rather than metadata. ' +
				queueToolNote,
			inputSchema: z.object({
				broker: z.string().describe('Broker name'),
				queue: functionQueueNameSchema.optional().describe('Function queue name (maps to stream SKIFF_Q_<queue>)'),
				stream: jetStreamNameSchema.optional().describe('JetStream stream name; use instead of queue'),
				limit: z.number().int().min(1).max(nodeTaskLimits.peekMessages).default(20).describe('Messages to return'),
				fromSeq: z.number().int().positive().optional().describe('First sequence to read; omitted means the oldest held'),
			}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('broker:update'),
		},
		async ({ broker, queue, stream, limit, fromSeq }) =>
			run(async () => {
				if ((queue === undefined) === (stream === undefined)) throw new Error('Pass exactly one of queue or stream.');
				const target = stream ?? queueStream(queue!);
				const task = core.nodeTasks.brokerTask(principal, broker, 'broker.stream.peek', {
					stream: target,
					limit,
					...(fromSeq !== undefined ? { fromSeq } : {}),
				});
				return describeNodeTask(await core.nodeTasks.run(principal, task));
			}),
	);

	tool(
		'redrive_queue',
		{
			title: 'Redrive dead-letter queue',
			description:
				'Move messages from a dead-letter queue back to a queue (usually the one that dead-lettered them), oldest first, at most ' +
				`${nodeTaskLimits.redriveMessages} per call. The consumer then processes them again, with its side effects. The result says ` +
				'how many moved and how many remain. ' +
				queueToolNote,
			inputSchema: z.object({
				broker: z.string().describe('Broker name'),
				from: functionQueueNameSchema.describe('The dead-letter queue to drain'),
				to: functionQueueNameSchema.describe('The queue that receives the messages'),
				limit: z.number().int().min(1).max(nodeTaskLimits.redriveMessages).optional().describe(`Messages to move (default ${nodeTaskLimits.redriveMessages})`),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
			scopeChallenge: requires('broker:update'),
		},
		async ({ broker, from, to, limit }) =>
			run(async () =>
				describeNodeTask(
					await core.nodeTasks.run(
						principal,
						core.nodeTasks.brokerTask(principal, broker, 'broker.queue.redrive', { from, to, ...(limit !== undefined ? { limit } : {}) }),
					),
				),
			),
	);

	tool(
		'get_node_task',
		{
			title: 'Get node task',
			description:
				'Follow a queue or function tool task (ntk_…) that had not finished when its tool returned: status pending, running, ' +
				`succeeded or failed, with the result. waitSeconds (up to ${NODE_TASK_MAX_WAIT_SECONDS}) holds the call until it finishes. ` +
				'Results are kept for an hour.',
			inputSchema: z.object({
				id: z.string().describe('Task id (ntk_…)'),
				waitSeconds: z.number().int().min(0).max(NODE_TASK_MAX_WAIT_SECONDS).default(0).describe('Wait this long for the task to finish'),
			}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			// The scope depends on the task: broker:read for queue tasks, deployment:read for function ones.
			scopeChallenge: requiresWith([], (args) => {
				try {
					core.nodeTasks.get(principal, String(args.id ?? ''));
					return [];
				} catch (error) {
					const permission = (error as { permission?: Permission }).permission;
					return permission ? [permission] : [];
				}
			}),
		},
		async ({ id, waitSeconds }) =>
			run(async () => {
				const task = core.nodeTasks.get(principal, id);
				return describeNodeTask(waitSeconds > 0 ? await core.nodeTasks.wait(principal, task, waitSeconds * 1000) : task);
			}),
	);

	tool(
		'create_broker',
		{
			title: 'Create queue broker',
			description:
				'Create a managed queue broker. `engine` is nats (2.12 or 2.11) with JetStream on; `storageMb` caps the persistent ' +
				'message store. Pass `project` to attach it in the same call; the broker is then placed on that project\'s node. ' +
				brokerNote,
			inputSchema: brokerCreateSchema,
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
			scopeChallenge: requiresWith(['broker:create'], (args) => (args.project ? ['project:update'] : [])),
		},
		async (input) =>
			run(() => {
				const view = core.brokers.create(principal, input);
				const attached = view.attachments[0];
				return {
					broker: view,
					nextSteps: [
						attached
							? `"${attached.projectSlug}" receives ${attached.envNames.join(', ')} at its next activation (a running app restarts on its own).`
							: `Attach it to an app with attach_broker({ project, broker: "${view.name}" }).`,
						`The broker starts on node "${view.nodeName ?? view.nodeId}"; follow it with get_broker.`,
					],
				};
			}),
	);

	tool(
		'update_broker',
		{
			title: 'Update queue broker',
			description:
				'Resize a broker (memory, CPU, message-store cap) or move it to a newer listed version in place. Downgrades are refused. ' +
				'The broker restarts on its node; JetStream data is kept.',
			inputSchema: brokerUpdateSchema.extend({ broker: z.string().describe('Broker name') }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('broker:update'),
		},
		async ({ broker, ...patch }) => run(() => ({ broker: core.brokers.update(principal, broker, patch) })),
	);

	tool(
		'restart_broker',
		{
			title: 'Restart queue broker',
			description: 'Restart the broker container. Connected clients reconnect; JetStream data is kept.',
			inputSchema: z.object({ broker: z.string().describe('Broker name') }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
			scopeChallenge: requires('broker:update'),
		},
		async ({ broker }) =>
			run(() => ({
				broker: core.brokers.restart(principal, broker),
				nextSteps: ['The broker restarts on its node; follow get_broker until it is running again.'],
			})),
	);

	tool(
		'attach_broker',
		{
			title: 'Attach queue broker',
			description:
				`Connect a queue broker to a process, container or function project (functions use it for queue bindings and consumers, D112). ${brokerNote} ` +
				'Attaching re-activates (restarts) a running app; no redeploy is needed if it already runs on the broker node.',
			inputSchema: brokerAttachSchema.extend({ project: z.string().describe('Project slug') }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
			scopeChallenge: requires('broker:update', 'project:update'),
		},
		async ({ project, ...input }) =>
			run(() => {
				const result = core.brokers.attach(principal, core.projects.requireRow(principal, project), input);
				return {
					...result,
					nextSteps: [
						`Read ${result.attachment.envPrefix}_URL in the app; it is injected at activation.`,
						...(result.warning ? [result.warning] : []),
					],
				};
			}),
	);

	tool(
		'detach_broker',
		{
			title: 'Detach queue broker',
			description:
				'Disconnect a broker from a project. The app restarts without its <PREFIX>_* variables; the broker and its streams are untouched.',
			inputSchema: z.object({
				project: z.string().describe('Project slug'),
				broker: z.string().describe('Broker name'),
			}),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
			scopeChallenge: requires('broker:update', 'project:update'),
		},
		async ({ project, broker }) =>
			run(() => {
				core.brokers.detach(principal, core.projects.requireRow(principal, project), broker);
				return { ok: true, project, broker };
			}),
	);

	// --- event notifications (docs/EVENTS.md, D122) ----
	const eventNote =
		'A rule publishes each matching event as a JSON message to a queue on a managed broker; a function consumes that queue ' +
		'like any other (wrangler `queues.consumers`, broker attached to the function project) and handles it in `queue()`. ' +
		'Storage messages use Cloudflare\'s R2 notification body ({ account, action, bucket, object: { key, size, eTag }, eventTime }); ' +
		'every other source sends { type, id, time, account, data }. Delivery is at least once.';

	tool(
		'list_event_rules',
		{
			title: 'List event rules',
			description:
				'List event notification rules: source, what each watches, target broker/queue, 24-hour delivery counts and the last error. ' +
				eventNote,
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('broker:read'),
		},
		async () => run(() => ({ rules: core.events.list(principal) })),
	);

	tool(
		'get_event_rule',
		{
			title: 'Get event rule',
			description: 'Get one event rule with its 20 most recent deliveries (status, attempts, error and message body).',
			inputSchema: z.object({ id: z.string().describe('Rule id (evr_…)') }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('broker:read'),
		},
		async ({ id }) =>
			run(() => ({ rule: core.events.get(principal, id), deliveries: core.events.deliveries(principal, { ruleId: id, limit: 20 }) })),
	);

	tool(
		'create_event_rule',
		{
			title: 'Create event rule',
			description:
				'Publish a platform source\'s events to a queue. Sources and events: storage (object-create, object-delete; needs `storage` ' +
				'and `bucket`, optional key `prefix`/`suffix`), alerts (firing, resolved; optional `alertRule` id), deployments (created, ' +
				'promoted, failed; optional `project` slug), database-backups (completed, failed; optional `database`). Omit `events` for ' +
				'all of them. A storage rule restarts the storage instance once to switch on bucket notifications. ' +
				eventNote,
			inputSchema: eventRuleCreateSchema,
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
			scopeChallenge: requiresWith(['broker:update'], (args) => {
				switch (args.source) {
					case 'storage':
						return ['storage:read'];
					case 'alerts':
						return ['metrics:read'];
					case 'deployments':
						return ['deployment:read'];
					case 'database-backups':
						return ['database:read'];
					default:
						return [];
				}
			}),
		},
		async (input) =>
			run(() => {
				const rule = core.events.create(principal, input);
				const attached = core.brokers.get(principal, rule.broker).attachments.map((item) => item.projectSlug);
				return {
					rule,
					nextSteps: [
						attached.length > 0
							? `Consume it from a function attached to "${rule.broker}" (${attached.join(', ')}): add { "queue": "${rule.queue}" } to wrangler queues.consumers and redeploy.`
							: `Attach "${rule.broker}" to the consuming function with attach_broker, add { "queue": "${rule.queue}" } to its wrangler queues.consumers, and redeploy.`,
						`Check the path end to end with test_event_rule({ id: "${rule.id}" }), then list_event_deliveries.`,
						...(rule.source === 'storage' ? [`Storage "${rule.filter.storage}" restarts once to switch bucket notifications on.`] : []),
					],
				};
			}),
	);

	tool(
		'update_event_rule',
		{
			title: 'Update event rule',
			description:
				'Change an event rule: `events`, storage key `prefix`/`suffix` (null clears), target `queue`, `description`, or `enabled`. ' +
				'The source, its resource and the broker are fixed; delete and recreate the rule to change them.',
			inputSchema: z.object({
				id: z.string().describe('Rule id (evr_…)'),
				events: z.array(z.string()).max(8).optional(),
				prefix: z.string().max(1024).nullable().optional(),
				suffix: z.string().max(1024).nullable().optional(),
				queue: z.string().max(63).optional(),
				description: z.string().max(200).nullable().optional(),
				enabled: z.boolean().optional(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('broker:update'),
		},
		async ({ id, ...patch }) => run(() => ({ rule: core.events.update(principal, id, patch) })),
	);

	tool(
		'test_event_rule',
		{
			title: 'Send test event',
			description:
				'Queue one synthetic event through a rule (data.test = true; storage tests use a key built from the prefix and suffix). ' +
				'Follow it with list_event_deliveries: pending until the broker node publishes it, then delivered.',
			inputSchema: z.object({ id: z.string().describe('Rule id (evr_…)') }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
			scopeChallenge: requires('broker:update'),
		},
		async ({ id }) => run(() => ({ delivery: core.events.test(principal, id) })),
	);

	tool(
		'list_event_deliveries',
		{
			title: 'List event deliveries',
			description:
				'Recent event deliveries, newest first, with status (pending, delivered, failed), attempts, last error and the message body. ' +
				'A pending delivery is waiting for the broker\'s node; failed ones were not published within 24 hours. History is kept 7 days.',
			inputSchema: z.object({
				rule: z.string().optional().describe('Only this rule id'),
				status: z.enum(eventDeliveryStatuses).optional(),
				limit: z.number().int().min(1).max(200).default(50),
			}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('broker:read'),
		},
		async ({ rule, status, limit }) =>
			run(() => ({
				deliveries: core.events.deliveries(principal, { ...(rule ? { ruleId: rule } : {}), ...(status ? { status } : {}), limit }),
			})),
	);

	tool(
		'delete_event_rule',
		{
			title: 'Delete event rule',
			description:
				'Delete an event rule. Its undelivered events are dropped; messages already in the queue stay. Requires confirmation.',
			inputSchema: z.object({ id: z.string().describe('Rule id (evr_…)') }),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
			scopeChallenge: requires('broker:read', 'broker:update'),
		},
		async ({ id }, ctx) => {
			if (era === 'assistant')
				return run(() => {
					core.events.delete(principal, id);
					return { ok: true, id };
				});
			if (era === 'legacy')
				return {
					isError: true,
					...text(
						`Deleting event rule ${id} needs your confirmation, which this MCP client can't show. ` +
							`Ask the user to remove it in the Skiff dashboard, in the Triggers card on the consuming function's Bindings & triggers tab (${core.ctx.config.platformOrigin}/functions).`,
					),
				};
			const key = `confirm_delete_event_rule:${id}`;
			const schema = z.object({ confirm: z.boolean() });
			const prompted = verifyConfirmation(ctx.mcpReq.requestState(), principal, 'delete_event_rule', id);
			const answer = prompted ? acceptedContent(ctx.mcpReq.inputResponses, key, schema) : undefined;
			const responded = prompted && ctx.mcpReq.inputResponses?.[key] !== undefined;
			if (responded && answer?.confirm !== true) {
				const cancelled = text(`Cancelled: event rule ${id} was not deleted (the user did not confirm).`);
				declined.add(cancelled);
				return cancelled;
			}
			if (answer?.confirm !== true) {
				let rule: EventRuleView;
				try {
					rule = core.events.get(principal, id);
				} catch (error) {
					return run(() => {
						throw error;
					});
				}
				return inputRequired({
					inputRequests: {
						[key]: inputRequired.elicit({
							message:
								`Delete the ${rule.source} event rule ${rule.id} (→ ${rule.broker}/${rule.queue})? ` +
								`${rule.deliveries.pending} undelivered events are dropped; messages already in the queue stay.`,
							requestedSchema: schema,
						}),
					},
					requestState: mintConfirmation(principal, 'delete_event_rule', id),
				});
			}
			return run(() => {
				core.events.delete(principal, id);
				return { ok: true, id };
			});
		},
	);

	// --- managed object storage (docs/OBJECT-STORAGE.md; no key reveal, bucket force-delete or purge over MCP) ----
	const storageNote =
		'Attached apps get a scoped key injected at activation as <PREFIX>_ENDPOINT_URL, _ACCESS_KEY_ID, _SECRET_ACCESS_KEY, _REGION ' +
		'and _FORCE_PATH_STYLE, plus _BUCKET when exactly one bucket is granted and _PUBLIC_ENDPOINT_URL when the instance is public. ' +
		'PREFIX defaults to S3; use AWS to get the names the AWS SDKs read on their own (AWS_ENDPOINT_URL, AWS_ACCESS_KEY_ID, …). ' +
		'Clients must use path-style addressing (forcePathStyle: true / addressing_style "path"); never hard-code keys. ' +
		"A private instance is reachable only from apps on its node (placement `auto` handles that); a public one from anywhere.";

	tool(
		'list_storage',
		{
			title: 'List object storage',
			description:
				'List managed S3-compatible object storage instances (RustFS) in the org with status, node, usage, buckets and attached projects.',
			inputSchema: z.object({
				includeDeleted: z.boolean().default(false).describe('Also list instances in the trash'),
			}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('storage:read'),
		},
		async ({ includeDeleted }) => run(() => ({ storage: core.storage.list(principal, { includeDeleted }) })),
	);

	tool(
		'get_storage',
		{
			title: 'Get object storage',
			description:
				'Get one object storage instance: status, node, endpoints, buckets (access, size, objects), attachments and a last-hour ' +
				'summary (bytes used vs the storage budget, objects, memory). Never includes keys.',
			inputSchema: z.object({ storage: z.string().describe('Storage instance name') }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('storage:read'),
		},
		async ({ storage }) =>
			run(async () => {
				const view = core.storage.get(principal, storage, { includeDeleted: true });
				return { ...view, lastHour: await storageLastHour(principal, view.name, view.storageMb) };
			}),
	);

	tool(
		'list_objects',
		{
			title: 'List bucket objects',
			description:
				'List objects and folder prefixes in a managed storage bucket. Use delimiter "/" (the default) for a folder view, ' +
				'`prefix` to descend, and `token` to continue a truncated listing. Object contents are not returned.',
			inputSchema: z.object({
				storage: z.string().describe('Storage instance name'),
				bucket: bucketNameSchema,
				prefix: z.string().max(1024).default(''),
				delimiter: z.string().max(1).default('/'),
				token: z.string().max(2048).optional(),
				limit: z.number().int().min(1).max(1000).default(100),
			}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('storage:read'),
		},
		async ({ storage, bucket, prefix, delimiter, token, limit }) =>
			run(() => core.storageObjects.list(principal, storage, { bucket, prefix, delimiter, token, limit })),
	);

	tool(
		'presign_object',
		{
			title: 'Presign an object URL',
			description:
				'Create a short-lived presigned GET or PUT URL for one object. Only public storage instances have a browser-reachable ' +
				'endpoint; private instances are reachable through the dashboard, the CLI or an attached app. The URL carries a signature, not the root key.',
			inputSchema: z.object({
				storage: z.string().describe('Storage instance name'),
				bucket: bucketNameSchema,
				key: storageObjectKeySchema,
				method: z.enum(['GET', 'PUT']).default('GET'),
				expiresIn: z.number().int().min(60).max(604_800).default(3600).describe('Seconds (max 7 days)'),
			}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('storage:read'),
		},
		async ({ storage, bucket, key, method, expiresIn }) =>
			run(() => core.storageObjects.presign(principal, storage, bucket, { key, method, expiresIn })),
	);

	tool(
		'create_object_folder',
		{
			title: 'Create an object folder',
			description:
				'Create a folder marker (a zero-byte object whose key ends in "/") in a bucket. Useful before uploading or granting a prefix.',
			inputSchema: z.object({
				storage: z.string().describe('Storage instance name'),
				bucket: bucketNameSchema,
				prefix: z.string().min(1).max(1024).describe('Folder prefix; a trailing slash is added'),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('storage:update'),
		},
		async ({ storage, bucket, prefix }) =>
			run(() => core.storageObjects.folder(principal, storage, bucket, prefix)),
	);

	tool(
		'create_storage',
		{
			title: 'Create object storage',
			description:
				'Create a managed S3-compatible object storage instance (RustFS). `buckets` creates private buckets right away; pass ' +
				'`project` (with at least one bucket) to attach it read-write in the same call, and `public: true` to serve it at ' +
				`https://<name>--s3.<domain> for browsers or apps on other nodes. ${storageNote}`,
			inputSchema: storageCreateSchema,
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
			scopeChallenge: requiresWith(['storage:create'], (args) => (args.project ? ['project:update'] : [])),
		},
		async (input) =>
			run(() => {
				const view = core.storage.create(principal, input);
				const attached = view.attachments[0];
				const where = `The instance starts on node "${view.nodeName ?? view.nodeId}"; follow it with get_storage.`;
				return {
					storage: view,
					nextSteps: attached
						? [
								`"${attached.projectSlug}" receives ${attached.envNames.join(', ')} at its next activation (a running app restarts on its own).`,
								where,
							]
						: [
								...(view.buckets.length === 0
									? [`Create a bucket with create_bucket({ storage: "${view.name}", name }).`]
									: []),
								`Attach it to an app with attach_storage({ project, storage: "${view.name}" }).`,
								where,
							],
				};
			}),
	);

	tool(
		'create_bucket',
		{
			title: 'Create bucket',
			description:
				'Create a bucket in an object storage instance. Names are 3–63 lowercase letters, digits and single hyphens (no dots). ' +
				'`access: "public-read"` allows unsigned GETs of objects (not listing); the default is private. ' +
				'Grant it to an app with attach_storage, or by changing an existing attachment from the dashboard or CLI.',
			inputSchema: bucketCreateSchema.extend({ storage: z.string().describe('Storage instance name') }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
			scopeChallenge: requires('storage:update'),
		},
		async ({ storage, ...input }) => run(() => ({ bucket: core.storage.createBucket(principal, storage, input) })),
	);

	tool(
		'get_bucket_config',
		{
			title: 'Get bucket configuration',
			description:
				'Read a bucket’s desired configuration and the node’s last convergence report: access, versioning, lifecycle rules, ' +
				'CORS, hard quota and object lock. `configStatus` is pending, converged, error or unsupported.',
			inputSchema: z.object({
				storage: z.string().describe('Storage instance name'),
				bucket: bucketNameSchema,
			}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('storage:read'),
		},
		async ({ storage, bucket }) =>
			run(() => ({ config: core.storage.getBucketConfig(principal, storage, bucket) })),
	);

	tool(
		'update_bucket_config',
		{
			title: 'Update bucket configuration',
			description:
				'Change a bucket’s desired versioning, lifecycle, CORS or hard byte quota. Send only the fields that change; the node ' +
				'applies them on its next reconcile and reports configStatus. Object lock is create-only and cannot be changed here. ' +
				'Disabling versioning is refused while object lock is configured.',
			inputSchema: bucketUpdateSchema.extend({
				storage: z.string().describe('Storage instance name'),
				bucket: bucketNameSchema,
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('storage:update'),
		},
		async ({ storage, bucket, ...input }) =>
			run(() => ({ config: core.storage.updateBucket(principal, storage, bucket, input) })),
	);

	tool(
		'attach_storage',
		{
			title: 'Attach object storage',
			description:
				`Give a process or container project a scoped key to some buckets of a storage instance. ${storageNote} ` +
				'Omit `grants` to grant read-write on the only bucket (refused when the instance has several). ' +
				'Attaching re-activates (restarts) a running app.',
			inputSchema: storageAttachSchema.extend({
				project: z.string().describe('Project slug'),
				grants: storageAttachSchema.shape.grants
					.optional()
					.describe('Buckets and modes ({ bucket, mode: "read" | "read-write" }); defaults to read-write on the only bucket'),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
			scopeChallenge: requires('storage:update', 'project:update'),
		},
		async ({ project, grants, ...input }) =>
			run(() => {
				const row = core.projects.requireRow(principal, project);
				const resolved = grants ?? defaultStorageGrants(principal, input.storage);
				const result = core.storage.attach(principal, row, { ...input, grants: resolved });
				return {
					...result,
					nextSteps: [
						`Read ${result.attachment.envNames.join(', ')} in the app; they are injected at activation. Use path-style addressing.`,
						...(result.warning ? [result.warning] : []),
					],
				};
			}),
	);

	tool(
		'detach_storage',
		{
			title: 'Detach object storage',
			description:
				"Revoke a project's key to a storage instance. The app restarts without its <PREFIX>_* variables; the buckets and objects are untouched.",
			inputSchema: z.object({
				project: z.string().describe('Project slug'),
				storage: z.string().describe('Storage instance name'),
			}),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
			scopeChallenge: requires('storage:update', 'project:update'),
		},
		async ({ project, storage }) =>
			run(() => {
				core.storage.detach(principal, core.projects.requireRow(principal, project), storage);
				return { ok: true, project, storage };
			}),
	);

	tool(
		'delete_storage',
		{
			title: 'Delete object storage',
			description:
				'Soft-delete an object storage instance: its container and public endpoint stop, the data stays on the node and it can be ' +
				'restored for the trash period (7 days by default). Refused while projects are attached (detach_storage first). Requires confirmation. ' +
				'Permanent deletion is dashboard/CLI only.',
			inputSchema: z.object({ storage: z.string().describe('Storage instance name') }),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
			scopeChallenge: requires('storage:read', 'storage:delete'),
		},
		async ({ storage }, ctx) => {
			if (era === 'assistant')
				return run(() => {
					const view = core.storage.delete(principal, storage);
					return {
						ok: true,
						storage: view.name,
						restorable: true,
						restoreBefore: view.purgeAt
					};
				});
			if (era === 'legacy')
				return {
					isError: true,
					...text(
						`Deleting storage "${storage}" needs your confirmation, which this MCP client can't show. ` +
							`Ask the user to delete it from the Skiff dashboard: ${core.ctx.config.platformOrigin}/storage/${encodeURIComponent(storage)}`,
					),
				};
			const key = `confirm_delete_storage:${storage}`;
			const schema = z.object({ confirm: z.boolean() });
			// Only an answer to a prompt we issued (signed requestState bound to this target) counts.
			const prompted = verifyConfirmation(ctx.mcpReq.requestState(), principal, 'delete_storage', storage);
			const answer = prompted ? acceptedContent(ctx.mcpReq.inputResponses, key, schema) : undefined;
			const responded = prompted && ctx.mcpReq.inputResponses?.[key] !== undefined;
			if (responded && answer?.confirm !== true) {
				const cancelled = text(`Cancelled: storage "${storage}" was not deleted (the user did not confirm).`);
				declined.add(cancelled);
				return cancelled;
			}
			if (answer?.confirm !== true) {
				// Fail before prompting when the delete can't succeed (unknown, or still attached).
				let view: StorageView;
				try {
					view = core.storage.get(principal, storage);
				} catch (error) {
					return run(() => {
						throw error;
					});
				}
				if (view.attachments.length > 0)
					return {
						isError: true,
						...text(
							`Storage "${storage}" is attached to ${view.attachments.map((item) => item.projectSlug).join(', ')}. ` +
								'Detach it with detach_storage first.',
						),
					};
				const buckets = view.buckets.length === 1 ? '1 bucket' : `${view.buckets.length} buckets`;
				return inputRequired({
					inputRequests: {
						[key]: inputRequired.elicit({
							message:
								`Delete storage "${storage}" (${buckets})? Its container${view.public ? ' and public endpoint' : ''} stop now; ` +
								`the data stays on node "${view.nodeName ?? view.nodeId}" and it can be restored for ${core.policies.get().trashDays} days.`,
							requestedSchema: schema,
						}),
					},
					requestState: mintConfirmation(principal, 'delete_storage', storage),
				});
			}
			return run(() => {
				const view = core.storage.delete(principal, storage);
				return {
					ok: true,
					storage: view.name,
					restorable: true,
					restoreBefore: view.purgeAt,
					nextSteps: ['A human can restore it from the dashboard or with `skif storage restore`.'],
				};
			});
		},
	);

	tool(
		'get_storage_logs',
		{
			title: 'Get object storage logs',
			description:
				'Return recent RustFS container log lines for a storage instance (the agent drains the unit journal). ' +
				'Use `after` as a cursor to poll for new lines; `level` and `q` filter server-side.',
			inputSchema: z.object({
				storage: z.string().describe('Storage instance name'),
				after: z.number().int().nonnegative().optional().describe('Return lines after this cursor'),
				limit: z.number().int().min(1).max(2000).default(200),
				level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
				q: z.string().max(200).optional(),
			}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('storage:read', 'logs:read'),
		},
		async ({ storage, after, limit, level, q }) =>
			run(() => {
				const view = core.storage.requireRow(principal, storage, { includeDeleted: true });
				return core.logs.queryService(principal, 'storage', view.id, {
					...(after !== undefined ? { after } : {}),
					limit,
					...(level ? { level } : {}),
					...(q ? { q } : {}),
				});
			}),
	);

	tool(
		'restart_storage',
		{
			title: 'Restart object storage',
			description:
				'Restart the RustFS container for a storage instance. Buckets, objects and access keys are kept; S3 requests ' +
				'fail briefly while it comes back. Use this after an engine change or when the API is wedged.',
			inputSchema: z.object({ storage: z.string().describe('Storage instance name') }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('storage:update'),
		},
		async ({ storage }) =>
			run(() => {
				const view = core.storage.restart(principal, storage);
				return { ok: true, storage: view.name, status: view.status, message: view.message };
			}),
	);

	// Named keys (plan 04b): metadata only. A key's secret is revealed in the dashboard or with
	// `skif storage keys reveal`, never over MCP (D67).
	tool(
		'list_storage_keys',
		{
			title: 'List storage keys',
			description:
				'List the named access keys of a storage instance: id, name, access key id, bucket grants, purpose, status ' +
				'(active, expired, revoked), expiry and last use. Never includes secrets. Keys named attachment-<project>-… belong to a ' +
				'project attachment and are revoked with detach_storage.',
			inputSchema: z.object({ storage: z.string().describe('Storage instance name') }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('storage:read'),
		},
		async ({ storage }) => run(() => ({ keys: core.storage.listKeys(principal, storage) })),
	);

	tool(
		'create_storage_key',
		{
			title: 'Create storage key',
			description:
				'Create a named access key on a storage instance, scoped to some buckets ({ bucket, mode: "read" | "read-write" }), for a ' +
				'person or an outside service. The node adds the RustFS user on its next round. The secret is not returned: a human ' +
				'reveals it in the dashboard or with `skif storage keys reveal`. For an app on Skiff use attach_storage instead.',
			inputSchema: storageKeyCreateSchema.extend({ storage: z.string().describe('Storage instance name') }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
			scopeChallenge: requires('storage:update'),
		},
		async ({ storage, ...input }) =>
			run(() => ({
				key: core.storage.createKey(principal, storage, input),
				nextSteps: [
					`Reveal the secret in the dashboard (${core.ctx.config.platformOrigin}/storage/${encodeURIComponent(storage)}) or with ` +
						`\`skif storage keys reveal ${storage} <id>\`.`,
				],
			})),
	);

	tool(
		'revoke_storage_key',
		{
			title: 'Revoke storage key',
			description:
				'Revoke a named storage key: the node removes its RustFS user, so anything still signing with it is refused. ' +
				'Attachment keys are revoked with detach_storage. Requires confirmation.',
			inputSchema: z.object({
				storage: z.string().describe('Storage instance name'),
				keyId: z.string().describe('Key id (stk_…) from list_storage_keys'),
			}),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
			scopeChallenge: requires('storage:update'),
		},
		async ({ storage, keyId }, ctx) => {
			const revoke = () =>
				run(() => ({
					key: core.storage.revokeKey(principal, storage, keyId),
					nextSteps: ['The node removes the RustFS user on its next round.'],
				}));
			// The dashboard assistant gates destructive tools in the chat UI before they reach here.
			if (era === 'assistant') return revoke();
			if (era === 'legacy')
				return {
					isError: true,
					...text(
						`Revoking storage key ${keyId} needs your confirmation, which this MCP client can't show. ` +
							`Ask the user to revoke it from the Skiff dashboard: ${core.ctx.config.platformOrigin}/storage/${encodeURIComponent(storage)}`,
					),
				};
			const target = `${storage}/${keyId}`;
			const key = `confirm_revoke_storage_key:${target}`;
			const schema = z.object({ confirm: z.boolean() });
			// Only an answer to a prompt we issued (signed requestState bound to this target) counts.
			const prompted = verifyConfirmation(ctx.mcpReq.requestState(), principal, 'revoke_storage_key', target);
			const answer = prompted ? acceptedContent(ctx.mcpReq.inputResponses, key, schema) : undefined;
			const responded = prompted && ctx.mcpReq.inputResponses?.[key] !== undefined;
			if (responded && answer?.confirm !== true) {
				const cancelled = text(`Cancelled: storage key ${keyId} was not revoked (the user did not confirm).`);
				declined.add(cancelled);
				return cancelled;
			}
			if (answer?.confirm === true) return revoke();
			// Fail before prompting when the key can't be found.
			let found: StorageKeyView | undefined;
			try {
				found = core.storage.listKeys(principal, storage).find((item) => item.id === keyId);
			} catch (error) {
				return run(() => {
					throw error;
				});
			}
			if (!found) return { isError: true, ...text(`Key ${keyId} was not found on "${storage}".`) };
			if (found.status === 'revoked') return revoke();
			return inputRequired({
				inputRequests: {
					[key]: inputRequired.elicit({
						message: `Revoke storage key "${found.name}" (${found.accessKeyId}) on "${storage}"? Anything still using it is refused.`,
						requestedSchema: schema,
					}),
				},
				requestState: mintConfirmation(principal, 'revoke_storage_key', target),
			});
		},
	);

	// --- access -------------------------------------------------------------
	tool(
		'set_access',
		{
			title: 'Set access mode',
			description:
				'Set public/password/platform access for production or previews. Each scope has its own password: ' +
				'password mode needs `password` unless the scope already has one, and leaving password mode clears only that scope\'s.',
			inputSchema: setAccessSchema.extend({ project: z.string() }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('project:update'),
		},
		async ({ project, ...input }) => run(() => core.projects.setAccess(principal, project, input)),
	);

	tool(
		'create_share_link',
		{
			title: 'Create share link',
			description: 'Create a time- and usage-limited link to a protected deployment.',
			inputSchema: shareLinkCreateSchema,
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
			scopeChallenge: requires('shareLink:create'),
		},
		async ({ project, ...input }) =>
			run(() => core.access.createShareLink(principal, core.projects.requireRow(principal, project), input)),
	);

	tool(
		'list_share_links',
		{
			title: 'List share links',
			description: 'List share links for a project, including redemption counts.',
			inputSchema: z.object({ project: z.string() }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('shareLink:read'),
		},
		async ({ project }) =>
			run(() => ({
				shareLinks: core.access.listShareLinks(principal, core.projects.requireRow(principal, project)),
			})),
	);

	tool(
		'revoke_share_link',
		{
			title: 'Revoke share link',
			description: 'Revoke a share link and every session it created. Takes effect within seconds.',
			inputSchema: z.object({ project: z.string(), shareLinkId: z.string() }),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
			scopeChallenge: requires('shareLink:revoke'),
		},
		async ({ project, shareLinkId }) =>
			run(async () => {
				await core.access.revokeShareLink(principal, core.projects.requireRow(principal, project), shareLinkId);
				return { ok: true, shareLinkId };
			}),
	);

	tool(
		'list_site_sessions',
		{
			title: 'List visitor sessions',
			description:
				'List live visitor sessions started from a project\'s share links (id, link, host, email, expiry). ' +
				'Password and platform sign-ins are stateless and not listed; sign_out_all_visitors ends those too.',
			inputSchema: z.object({ project: z.string() }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('shareLink:read'),
		},
		async ({ project }) =>
			run(() => ({ sessions: core.access.listSessions(principal, core.projects.requireRow(principal, project)) })),
	);

	tool(
		'revoke_site_session',
		{
			title: 'Revoke visitor session',
			description:
				'End one share-link visitor session (id red_… from list_site_sessions). The link keeps working. Takes effect within seconds.',
			inputSchema: z.object({ project: z.string(), sessionId: z.string() }),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
			scopeChallenge: requires('shareLink:revoke'),
		},
		async ({ project, sessionId }) =>
			run(async () => {
				await core.access.revokeSession(principal, core.projects.requireRow(principal, project), sessionId);
				return { ok: true, sessionId };
			}),
	);

	tool(
		'sign_out_all_visitors',
		{
			title: 'Sign out all visitors',
			description:
				'Sign out every visitor of a protected project: password, platform and share-link sessions on production, ' +
				'previews and environments. Visitors must sign in again; share links keep working. Requires confirmation.',
			inputSchema: z.object({ project: z.string() }),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
			scopeChallenge: requires('project:update'),
		},
		async ({ project }, ctx) => {
			const signOut = () =>
				run(async () => {
					const result = await core.access.signOutEveryone(principal, core.projects.requireRow(principal, project));
					return { ok: true, project, ...result };
				});
			if (era === 'assistant') return signOut();
			if (era === 'legacy')
				return {
					isError: true,
					...text(
						`Signing out every visitor of "${project}" needs your confirmation, which this MCP client can't show. ` +
							`Ask the user to do it from the project's Settings → Access card: ${core.ctx.config.platformOrigin}/projects/${encodeURIComponent(project)}?tab=settings`,
					),
				};
			const key = `confirm_sign_out_all_visitors:${project}`;
			const schema = z.object({ confirm: z.boolean() });
			const prompted = verifyConfirmation(ctx.mcpReq.requestState(), principal, 'sign_out_all_visitors', project);
			const answer = prompted ? acceptedContent(ctx.mcpReq.inputResponses, key, schema) : undefined;
			const responded = prompted && ctx.mcpReq.inputResponses?.[key] !== undefined;
			if (responded && answer?.confirm !== true) {
				const cancelled = text(`Cancelled: visitors of "${project}" stay signed in (the user did not confirm).`);
				declined.add(cancelled);
				return cancelled;
			}
			if (answer?.confirm !== true) {
				try {
					core.projects.requireRow(principal, project);
				} catch (error) {
					return run(() => {
						throw error;
					});
				}
				return inputRequired({
					inputRequests: {
						[key]: inputRequired.elicit({
							message:
								`Sign out every visitor of "${project}"? Password, platform and share-link sessions end on every host ` +
								'within seconds, and visitors have to sign in again. Share links keep working.',
							requestedSchema: schema,
						}),
					},
					requestState: mintConfirmation(principal, 'sign_out_all_visitors', project),
				});
			}
			return signOut();
		},
	);

	// --- observability ------------------------------------------------------
	tool(
		'get_status',
		{
			title: 'Get status',
			description: 'Fleet and platform summary: nodes, projects, deployments, storage.',
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('project:read'),
		},
		async () => run(() => core.metrics.status(principal)),
	);

	tool(
		'get_metrics',
		{
			title: 'Get traffic metrics',
			description:
				'Aggregated request metrics for your org\'s projects from the ClickHouse telemetry store (1m or 1h buckets), optionally filtered by project or host.',
			inputSchema: z.object({
				project: z.string().optional().describe('Project slug'),
				host: z.string().optional(),
				from: z.string().datetime().optional(),
				to: z.string().datetime().optional(),
				interval: z.enum(['1m', '1h']).default('1h'),
			}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('metrics:read', 'project:read'),
		},
		async ({ project, host, from, to, interval }) =>
			run(async () => {
				requirePermission(principal, 'metrics:read');
				if (!core.ctx.telemetry || !(await core.ctx.telemetry.ready()))
					return { points: [], note: 'Telemetry is not enabled on this install.' };
				// Telemetry is global; only this org's projects are visible to this principal.
				const projectId = project ? core.projects.requireRow(principal, project).id : undefined;
				const orgProjects = new Set(core.projects.list(principal, { includeDeleted: true }).map((row) => row.id));
				const now = Date.now();
				const points = await core.ctx.telemetry.query({
					host,
					projectId,
					from: from ? new Date(from) : new Date(now - 24 * 3600_000),
					to: to ? new Date(to) : new Date(now),
					interval,
				});
				return { points: points.filter((point) => point.projectId !== null && orgProjects.has(point.projectId)) };
			}),
	);

	// --- observability dashboards (D101) ------------------------------------
	const sizeName = (w: number) =>
		({ 6: 'quarter', 8: 'third', 12: 'half', 16: 'two-thirds', 24: 'full' })[w] ?? `${w}/24 columns`;
	const panelSummary = (panel: DashboardPanel) => ({
		id: panel.id,
		title: panel.title,
		viz: panel.viz,
		size: sizeName(panel.gridPos.w),
		height: panel.gridPos.h,
		unit: panel.options.unit,
		...(panel.query ? { query: panel.query } : {}),
		...(panel.viz === 'text' ? { text: panel.options.text } : {}),
	});
	const dashboardResult = (dashboard: DashboardView) => ({
		id: dashboard.id,
		title: dashboard.title,
		url: core.observability.url(dashboard.id),
		version: dashboard.version,
		description: dashboard.description,
		tags: dashboard.tags,
		time: dashboard.spec.time,
		refresh: dashboard.spec.refresh,
		variables: dashboard.spec.variables,
		panels: dashboard.spec.panels.map(panelSummary),
		canEdit: dashboard.canEdit,
	});
	/** Builder spec reminder shared by the write tools' descriptions. */
	const PANEL_HELP =
		'A panel is {title, viz, query, unit?, size?}. viz: timeseries | bar | stat | gauge | bargauge | table | pie | text. ' +
		'query (builder, works for everyone): {mode:"builder", builder:{dataset, metrics:[{field, agg}], groupBy?:[dimension], filters?:[{field, op, value}], timeSeries?: true, interval?: "auto", limit?}}. ' +
		'Datasets, measures (with their aggregations) and dimensions come from describe_telemetry; derived measures take agg "value", counters sum|rate|avg|max|min, gauges avg|max|min|last. ' +
		'Use timeSeries:false with groupBy for tables, bar gauges and pies; stats and gauges reduce a series. Filter values may be "$variable". ' +
		'size: quarter | third | half | two-thirds | full (defaults by viz); panels are laid out automatically. unit: short, bytes, ms, percent (0–100), percentunit (0–1), reqps, bytesps.';
	const lastRanges = { '15m': 0.25, '1h': 1, '6h': 6, '24h': 24, '7d': 168, '30d': 720, '90d': 2160 } as const;
	const dashboardRef = z.string().min(1).describe('Dashboard id (dsh_…) or exact title');

	tool(
		'describe_telemetry',
		{
			title: 'Describe telemetry',
			description:
				'What dashboards can chart: whether the optional ClickHouse store is installed and running, the builder datasets with their measures (kind, unit, aggregations) and dimensions, display names for project/database/storage ids, retention, starter templates, and (platform admins) the raw ClickHouse tables for SQL. Call this before building panels.',
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('metrics:read'),
		},
		async () =>
			run(async () => {
				const schema = await core.observability.schema(principal);
				return {
					installed: schema.installed,
					available: schema.available,
					...(schema.error ? { error: schema.error } : {}),
					...(schema.installed
						? {}
						: { note: 'The telemetry store is not installed. Dashboards can still be created and edited; panels show data once a platform owner installs it in Settings → Telemetry.' }),
					canUseSql: schema.canUseSql,
					retention: schema.retention,
					aggregations: { counter: ['sum', 'rate', 'avg', 'max', 'min', 'count'], gauge: ['avg', 'max', 'min', 'last'], derived: ['value'] },
					datasets: schema.datasets,
					names: schema.names,
					templates: Object.values(dashboardTemplates).map(({ id, title, description }) => ({ id, title, description })),
					...(schema.canUseSql
						? {
								tables: schema.tables.map(({ name, rows, columns }) => ({ name, rows, columns: columns.map((column) => `${column.name} ${column.type}`) })),
								sqlMacros: ['$__timeFilter(bucket)', '$__timeInterval(bucket)', '$__fromTime', '$__toTime', '$__interval_s', '$variable'],
							}
						: {}),
				};
			}),
	);

	tool(
		'query_telemetry',
		{
			title: 'Query telemetry',
			description:
				'Run one panel query and return its rows, to answer a question or to check a panel before adding it. Builder queries are scoped to what you can see; SQL is platform-admin only (read-only, 30 s limit). ' +
				'Time columns are epoch milliseconds. Example: {"query":{"mode":"builder","builder":{"dataset":"traffic","metrics":[{"field":"requests","agg":"rate"}],"groupBy":["host"]}},"last":"6h"}.',
			inputSchema: z.object({
				query: panelQuerySchema,
				last: z.enum(Object.keys(lastRanges) as [keyof typeof lastRanges, ...Array<keyof typeof lastRanges>]).default('24h').describe('Range ending now (ignored when from/to are given)'),
				from: z.string().datetime().optional(),
				to: z.string().datetime().optional(),
				variables: z.record(z.string(), z.union([z.string(), z.array(z.string())])).default({}),
				maxRows: z.number().int().min(1).max(500).default(50).describe('Rows returned to you (the query may produce more)'),
			}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('metrics:read'),
		},
		async ({ query, last, from, to, variables, maxRows }) =>
			run(async () => {
				const end = to ? Date.parse(to) : Date.now();
				const start = from ? Date.parse(from) : end - lastRanges[last] * 3_600_000;
				const result = await core.observability.query(principal, {
					query,
					range: { from: new Date(start).toISOString(), to: new Date(end).toISOString() },
					maxDataPoints: 120,
					variables,
				});
				return {
					columns: result.columns.map(({ name, type, kind }) => ({ name, type, kind })),
					rows: result.rows.slice(0, maxRows),
					totalRows: result.rows.length,
					...(result.rows.length > maxRows ? { note: `Showing ${maxRows} of ${result.rows.length} rows.` } : {}),
					intervalSeconds: result.intervalSeconds,
					...(result.notice ? { notice: result.notice } : {}),
					sql: result.sql,
				};
			}),
	);

	tool(
		'list_dashboards',
		{
			title: 'List dashboards',
			description: 'Saved observability dashboards in your org, newest first, with links.',
			inputSchema: z.object({ q: z.string().max(100).optional().describe('Filter by title or tag') }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('metrics:read'),
		},
		async ({ q }) =>
			run(() => {
				const needle = q?.trim().toLowerCase();
				return {
					dashboards: core.observability
						.list(principal)
						.filter((item) => !needle || item.title.toLowerCase().includes(needle) || item.tags.some((tag) => tag.toLowerCase().includes(needle)))
						.map((item) => ({
							id: item.id,
							title: item.title,
							url: core.observability.url(item.id),
							tags: item.tags,
							panels: item.panelCount,
							updatedAt: item.updatedAt,
							by: item.createdByName,
							canEdit: item.canEdit,
						})),
				};
			}),
	);

	tool(
		'get_dashboard',
		{
			title: 'Get dashboard',
			description: 'One dashboard with its panels (id, title, viz, size, query), variables and default time range.',
			inputSchema: z.object({ dashboard: dashboardRef }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('metrics:read'),
		},
		async ({ dashboard }) => run(() => dashboardResult(core.observability.resolve(principal, dashboard))),
	);

	tool(
		'create_dashboard',
		{
			title: 'Create dashboard',
			description:
				`Create a dashboard in one call: start from a template ("traffic", "databases", "storage"), pass panel drafts, or both (template panels first). ${PANEL_HELP} ` +
				'Every query is checked against the catalog before anything is saved. Returns the link and, when telemetry is running, how many rows each panel has right now.',
			inputSchema: z.object({
				title: z.string().max(120).optional().describe('Defaults to the template title'),
				description: z.string().max(1_000).optional(),
				tags: z.array(z.string().max(40)).max(10).optional(),
				template: z.enum(dashboardTemplateIds).optional(),
				panels: z.array(panelDraftSchema).max(40).optional(),
				variables: z.array(dashboardVariableSchema).max(20).optional().describe('e.g. {name:"host", kind:"query", query:{mode:"builder", builder:{dataset:"traffic", groupBy:["host"], timeSeries:false}}, multi:true, includeAll:true, current:["$__all"]}'),
				time: z.object({ from: z.string(), to: z.string() }).optional().describe('Default range, e.g. {from:"now-24h", to:"now"}'),
				refresh: z.enum(['10s', '30s', '1m', '5m', '15m', '1h']).nullable().optional(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
			scopeChallenge: requires('metrics:read'),
		},
		async (input) =>
			run(async () => {
				const dashboard = core.observability.createFromDrafts(principal, input as never);
				const preview = await core.observability.preview(principal, dashboard.spec.panels);
				return { ...dashboardResult(dashboard), ...(preview ? { preview } : { note: 'Telemetry is not running, so panels were not previewed.' }) };
			}),
	);

	tool(
		'add_dashboard_panels',
		{
			title: 'Add dashboard panels',
			description: `Append panels to a dashboard, placed below the existing ones automatically. ${PANEL_HELP}`,
			inputSchema: z.object({ dashboard: dashboardRef, panels: z.array(panelDraftSchema).min(1).max(40) }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
			scopeChallenge: requires('metrics:read'),
		},
		async ({ dashboard, panels }) =>
			run(async () => {
				const result = core.observability.addPanels(principal, dashboard, panels as never);
				const preview = await core.observability.preview(principal, result.added);
				return {
					dashboard: { id: result.dashboard.id, title: result.dashboard.title, url: core.observability.url(result.dashboard.id), version: result.dashboard.version },
					added: result.added.map(panelSummary),
					...(preview ? { preview } : {}),
				};
			}),
	);

	tool(
		'update_dashboard_panel',
		{
			title: 'Update dashboard panel',
			description: 'Change one panel (by id or exact title): title, viz, query, unit, size, height, text or options. Only the fields you pass change.',
			inputSchema: z.object({
				dashboard: dashboardRef,
				panel: z.string().min(1).describe('Panel id or exact title'),
				title: z.string().max(200).optional(),
				description: z.string().max(2_000).optional(),
				viz: z.enum(vizTypes).optional(),
				query: panelQuerySchema.optional(),
				unit: z.string().max(32).optional(),
				size: z.enum(panelSizes).optional(),
				height: z.number().int().min(2).max(40).optional(),
				text: z.string().max(20_000).optional(),
				options: panelOptionsSchema.optional(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('metrics:read'),
		},
		async ({ dashboard, panel, ...patch }) =>
			run(async () => {
				const updated = core.observability.updatePanel(principal, dashboard, panel, patch as never);
				const changed = updated.spec.panels.find((item) => item.id === panel || item.title === (patch.title ?? panel)) ?? null;
				const preview = changed ? await core.observability.preview(principal, [changed]) : null;
				return {
					dashboard: { id: updated.id, url: core.observability.url(updated.id), version: updated.version },
					panel: changed ? panelSummary(changed) : null,
					...(preview ? { preview } : {}),
				};
			}),
	);

	tool(
		'remove_dashboard_panels',
		{
			title: 'Remove dashboard panels',
			description: 'Remove panels (by id or exact title) from a dashboard. The rest keep their places.',
			inputSchema: z.object({ dashboard: dashboardRef, panels: z.array(z.string().min(1)).min(1).max(100) }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('metrics:read'),
		},
		async ({ dashboard, panels }) =>
			run(() => {
				const result = core.observability.removePanels(principal, dashboard, panels);
				return { dashboard: { id: result.dashboard.id, url: core.observability.url(result.dashboard.id), version: result.dashboard.version }, removed: result.removed };
			}),
	);

	tool(
		'update_dashboard',
		{
			title: 'Update dashboard',
			description: 'Change dashboard settings: title, description, tags, default time range, auto refresh or the variable list (replaces it). Panels are changed with the panel tools.',
			inputSchema: z.object({
				dashboard: dashboardRef,
				title: z.string().trim().min(1).max(120).optional(),
				description: z.string().max(1_000).optional(),
				tags: z.array(z.string().max(40)).max(10).optional(),
				time: z.object({ from: z.string(), to: z.string() }).optional(),
				refresh: z.enum(['10s', '30s', '1m', '5m', '15m', '1h']).nullable().optional(),
				variables: z.array(dashboardVariableSchema).max(20).optional(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('metrics:read'),
		},
		async ({ dashboard, ...patch }) => run(() => dashboardResult(core.observability.updateSettings(principal, dashboard, patch as never))),
	);

	tool(
		'delete_dashboard',
		{
			title: 'Delete dashboard',
			description: 'Delete a dashboard permanently (its panels and layout; the telemetry itself is untouched). Requires confirmation.',
			inputSchema: z.object({ dashboard: dashboardRef }),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
			scopeChallenge: requires('metrics:read'),
		},
		async ({ dashboard }, ctx) => {
			const remove = () =>
				run(() => {
					const target = core.observability.resolve(principal, dashboard);
					core.observability.delete(principal, target.id);
					return { ok: true, deleted: { id: target.id, title: target.title } };
				});
			if (era === 'assistant') return remove();
			if (era === 'legacy')
				return {
					isError: true,
					...text(`Deleting "${dashboard}" needs your confirmation, which this MCP client can't show. Delete it from the Skiff dashboard (Dashboards → ${dashboard}).`),
				};
			const key = `confirm_delete_dashboard:${dashboard}`;
			const schema = z.object({ confirm: z.boolean() });
			const prompted = verifyConfirmation(ctx.mcpReq.requestState(), principal, 'delete_dashboard', dashboard);
			const answer = prompted ? acceptedContent(ctx.mcpReq.inputResponses, key, schema) : undefined;
			const responded = prompted && ctx.mcpReq.inputResponses?.[key] !== undefined;
			if (responded && answer?.confirm !== true) {
				const cancelled = text(`Cancelled: dashboard "${dashboard}" was not deleted (the user did not confirm).`);
				declined.add(cancelled);
				return cancelled;
			}
			if (answer?.confirm !== true)
				return inputRequired({
					inputRequests: {
						[key]: inputRequired.elicit({
							message: `Delete dashboard "${dashboard}"? Its panels and layout are removed for everyone in the org; this cannot be undone.`,
							requestedSchema: schema,
						}),
					},
					requestState: mintConfirmation(principal, 'delete_dashboard', dashboard),
				});
			return remove();
		},
	);

	// --- metric alert rules (docs/ALERTS.md) ---------------------------------------------------

	const alertRuleRef = z.string().min(1).describe('Alert rule id (alr_…) or exact name');
	const alertRuleSummary = (rule: AlertRuleSummary) => ({
		id: rule.id,
		name: rule.name,
		url: core.alerts.url(rule.id),
		enabled: rule.enabled,
		severity: rule.severity,
		state: rule.state,
		counts: rule.counts,
		health: rule.health,
		...(rule.lastError ? { lastError: rule.lastError } : {}),
		query: rule.query,
		condition: rule.condition,
		windowSeconds: rule.windowSeconds,
		forSeconds: rule.forSeconds,
		noData: rule.noData,
		channels: rule.channels.length ? rule.channels : 'all',
		lastEvaluatedAt: rule.lastEvaluatedAt,
	});
	const alertInstance = (instance: AlertInstanceView) => ({
		rule: instance.ruleName,
		ruleId: instance.ruleId,
		state: instance.state,
		severity: instance.severity,
		labels: instance.labels,
		...(Object.keys(instance.labelNames).length ? { names: instance.labelNames } : {}),
		value: instance.value,
		since: instance.activeSince ?? instance.since,
		fingerprint: instance.fingerprint,
		...(instance.acknowledgedBy ? { acknowledgedBy: instance.acknowledgedByName ?? instance.acknowledgedBy } : {}),
		...(instance.silencedBy ? { silenced: true } : {}),
	});
	const ALERT_RULE_HELP =
		'A rule runs one builder query over a trailing window and compares one value per series (one series per groupBy combination) with a threshold. ' +
		'query: {mode:"builder", builder:{dataset, metrics:[exactly one {field, agg}], groupBy?:[dimension], filters?}} (see describe_telemetry); percentunit values are 0–1, so a 5% error rate is threshold 0.05. ' +
		'noData: ok (quiet is fine), nodata (alert as "no data"), alerting (missing data means down: use for up/traffic outage rules), keep. ' +
		'channels: platform notifier names from list_alerts (empty = all).';

	tool(
		'list_alerts',
		{
			title: 'List alerts',
			description:
				'What is alerting right now (firing, pending and no-data series with values and since when), every metric alert rule with its state and health, the notification channels rules can use, and the outage templates create_alert_rule accepts.',
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('metrics:read'),
		},
		async () =>
			run(async () => {
				const overview = await core.alerts.overview(principal);
				return {
					url: core.alerts.url(),
					telemetryAvailable: overview.telemetryAvailable,
					...(overview.telemetryError ? { telemetryError: overview.telemetryError } : {}),
					counts: overview.counts,
					active: overview.active.map(alertInstance),
					rules: core.alerts.listRules(principal).map(alertRuleSummary),
					channels: overview.channels.map((channel) => channel.name),
					templates: alertRuleTemplates.map(({ id, title, description }) => ({ id, title, description })),
					canEdit: overview.canEdit,
					canSilence: overview.canSilence,
				};
			}),
	);

	tool(
		'get_alert_rule',
		{
			title: 'Get alert rule',
			description: 'One alert rule: its full definition, every series with its state and value, and its recent history (state changes, notifications and who they reached).',
			inputSchema: z.object({ rule: alertRuleRef, history: z.number().int().min(0).max(100).default(20) }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('metrics:read'),
		},
		async ({ rule, history }) =>
			run(() => {
				const view = core.alerts.resolveRule(principal, rule);
				return {
					...alertRuleSummary(view),
					description: view.description,
					keepFiringSeconds: view.keepFiringSeconds,
					intervalSeconds: view.intervalSeconds,
					repeatMinutes: view.repeatMinutes,
					notifyOnResolve: view.notifyOnResolve,
					emails: view.emails,
					runbook: view.runbook,
					version: view.version,
					series: view.instances.map(alertInstance),
					history: history
						? core.alerts.history(principal, { ruleId: view.id, limit: history }).map(({ kind, at, title, detail, delivery }) => ({ kind, at, title, detail, ...(delivery ? { delivery } : {}) }))
						: [],
				};
			}),
	);

	tool(
		'create_alert_rule',
		{
			title: 'Create alert rule',
			description:
				`Create a metric alert rule (org owners/admins). Start from a template id (site_down, high_error_rate, slow_responses, traffic_stopped, database_down, pooler_down, database_connections, database_deadlocks, storage_down) and override fields, or give the full rule. ${ALERT_RULE_HELP} ` +
				'The result includes a preview: the series the rule sees right now and which would breach.',
			inputSchema: z.object({
				template: z.enum(alertRuleTemplates.map((template) => template.id) as [string, ...string[]]).optional(),
				rule: alertRuleInputSchema.partial().default({}).describe('Rule fields; with a template, only the ones to change'),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
			scopeChallenge: requires('metrics:read'),
		},
		async ({ template, rule }) =>
			run(async () => {
				const base = template ? alertRuleTemplate(template)?.rule : undefined;
				const overrides = Object.fromEntries(Object.entries(rule as Record<string, unknown>).filter(([, value]) => value !== undefined));
				const created = core.alerts.createRule(principal, { ...(base ?? {}), ...overrides });
				let preview: unknown = null;
				try {
					const result = await core.alerts.preview(principal, { ruleId: created.id });
					preview = result.series.slice(0, 20).map(({ labels, value, met }) => ({ labels, value, breaching: met }));
				} catch (error) {
					preview = { error: (error as Error).message };
				}
				return { created: alertRuleSummary(created), preview };
			}),
	);

	tool(
		'update_alert_rule',
		{
			title: 'Update alert rule',
			description: `Change an alert rule: only the fields given change. Pause or resume with {enabled:false|true}. ${ALERT_RULE_HELP}`,
			inputSchema: z.object({
				rule: alertRuleRef,
				changes: alertRuleInputSchema.partial().describe('Fields to change'),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('metrics:read'),
		},
		async ({ rule, changes }) =>
			run(() => {
				const current = core.alerts.resolveRule(principal, rule);
				// The tool schema is `.partial()` over fields with defaults; pass only what the caller named.
				const raw = (changes ?? {}) as Record<string, unknown>;
				const patch = Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== undefined));
				return { updated: alertRuleSummary(core.alerts.updateRule(principal, current.id, { ...patch, version: current.version })) };
			}),
	);

	tool(
		'silence_alerts',
		{
			title: 'Silence alerts',
			description:
				'Mute notifications for a while (a maintenance window, or an alert someone is already handling). Scope it to one rule and/or label matchers (e.g. {label:"host", value:"shop.example.com"}); with no rule it mutes every rule in the org. States still update; notifications resume when it ends.',
			inputSchema: z.object({
				rule: alertRuleRef.optional(),
				matchers: z.array(alertMatcherSchema).max(10).default([]),
				durationMinutes: z.number().int().min(1).max(60 * 24 * 90),
				comment: z.string().max(500).default(''),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
			scopeChallenge: requires('metrics:read'),
		},
		async ({ rule, matchers, durationMinutes, comment }) =>
			run(() => {
				const ruleId = rule ? core.alerts.resolveRule(principal, rule).id : null;
				return { silence: core.alerts.createSilence(principal, { ruleId, matchers, durationMinutes, comment }) };
			}),
	);

	tool(
		'acknowledge_alert',
		{
			title: 'Acknowledge alert',
			description: 'Acknowledge a firing series so repeat notifications stop until it resolves (fingerprint from list_alerts or get_alert_rule). acknowledged:false undoes it.',
			inputSchema: z.object({ rule: alertRuleRef, fingerprint: z.string().min(1), acknowledged: z.boolean().default(true) }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('metrics:read'),
		},
		async ({ rule, fingerprint, acknowledged }) =>
			run(() => {
				const view = core.alerts.acknowledge(principal, core.alerts.resolveRule(principal, rule).id, fingerprint, acknowledged);
				return { series: view.instances.filter((instance) => instance.fingerprint === fingerprint).map(alertInstance) };
			}),
	);

	tool(
		'get_alert_history',
		{
			title: 'Get alert history',
			description: 'Recent alert events, newest first: state changes, notifications (with per-channel delivery results), rule errors, silences, acknowledgements and (platform admins) built-in system alerts such as node offline or certificate expiry.',
			inputSchema: z.object({
				rule: alertRuleRef.optional(),
				kinds: z.array(z.enum(['state', 'notification', 'error', 'system', 'ack', 'silence'])).default([]),
				limit: z.number().int().min(1).max(200).default(50),
				before: z.string().datetime().optional(),
			}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('metrics:read'),
		},
		async ({ rule, kinds, limit, before }) =>
			run(() => ({
				events: core.alerts
					.history(principal, { ruleId: rule ? core.alerts.resolveRule(principal, rule).id : undefined, kinds, limit, before })
					.map(({ kind, at, ruleName, title, detail, labels, delivery, severity }) => ({ kind, at, rule: ruleName, severity, title, detail, labels, ...(delivery ? { delivery } : {}) })),
			})),
	);

	tool(
		'delete_alert_rule',
		{
			title: 'Delete alert rule',
			description: 'Delete an alert rule permanently, with its series and silences (history is kept). To stop it temporarily, update_alert_rule with enabled:false instead. Requires confirmation.',
			inputSchema: z.object({ rule: alertRuleRef }),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
			scopeChallenge: requires('metrics:read'),
		},
		async ({ rule }, ctx) => {
			const remove = () =>
				run(() => {
					const target = core.alerts.resolveRule(principal, rule);
					core.alerts.deleteRule(principal, target.id);
					return { ok: true, deleted: { id: target.id, name: target.name } };
				});
			if (era === 'assistant') return remove();
			if (era === 'legacy')
				return {
					isError: true,
					...text(`Deleting "${rule}" needs your confirmation, which this MCP client can't show. Delete it from the Skiff dashboard (Alerts → Rules).`),
				};
			const key = `confirm_delete_alert_rule:${rule}`;
			const schema = z.object({ confirm: z.boolean() });
			const prompted = verifyConfirmation(ctx.mcpReq.requestState(), principal, 'delete_alert_rule', rule);
			const answer = prompted ? acceptedContent(ctx.mcpReq.inputResponses, key, schema) : undefined;
			const responded = prompted && ctx.mcpReq.inputResponses?.[key] !== undefined;
			if (responded && answer?.confirm !== true) {
				const cancelled = text(`Cancelled: alert rule "${rule}" was not deleted (the user did not confirm).`);
				declined.add(cancelled);
				return cancelled;
			}
			if (answer?.confirm !== true)
				return inputRequired({
					inputRequests: {
						[key]: inputRequired.elicit({
							message: `Delete alert rule "${rule}"? It stops alerting for everyone in the org; this cannot be undone.`,
							requestedSchema: schema,
						}),
					},
					requestState: mintConfirmation(principal, 'delete_alert_rule', rule),
				});
			return remove();
		},
	);

	tool(
		'get_logs',
		{
			title: 'Get logs',
			description:
				'Recent runtime or build logs for a project. Pass `after` with the previous cursor to tail without duplicates; static sites have access logs in get_metrics instead.',
			inputSchema: z.object({
				project: z.string(),
				source: z.enum(['runtime', 'build']).optional(),
				buildId: z.string().optional(),
				deploymentId: z.string().optional(),
				after: z.number().int().nonnegative().optional(),
				limit: z.number().int().positive().max(2_000).optional(),
				level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
				q: z.string().max(200).optional(),
			}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('logs:read'),
		},
		async (input) =>
			run(() => {
				const row = core.projects.requireRow(principal, input.project);
				const result = core.logs.query(principal, row, input);
				return {
					events: result.events,
					lines: result.events.map((event) => ({
						timestamp: new Date(event.ts).toISOString(),
						level: event.level,
						message: event.message,
					})),
					cursor: result.cursor,
					hasMore: result.hasMore,
					...(result.events.length === 0 && row.runtime === 'static'
						? { note: 'Static deployments have no application logs. Use get_metrics for traffic and error rates.' }
						: {}),
				};
			}),
	);

	// --- container console (D127): read-only over MCP. No shell: an agent could run something
	// irreversible, so command execution stays with people (dashboard, `skif container shell`).
	const replicaInput = z
		.number()
		.int()
		.min(0)
		.optional()
		.describe('Replica index for a multi-copy workload; omit for the first.');

	tool(
		'inspect_container',
		{
			title: 'Inspect container',
			description:
				'Live state of a container project on its node: status, restarts, last exit code, OOM kills, image and digest, entrypoint and command, ' +
				'environment variable names (never values), ports, networks, mounts, sandbox flags, resource counters and the processes running inside. ' +
				'`stats` holds raw counters (CPU microseconds, bytes); call twice a few seconds apart and divide the difference by the time between `sampledAt` values for rates.',
			inputSchema: z.object({ project: z.string(), replica: replicaInput }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('container:inspect'),
			feature: 'CONTAINER_CONSOLE'
		},
		async (input) =>
			run(() =>
				consoleJson(containerConsoleDeps, principal, input.project, 'inspect', { replica: input.replica })
			)
	);

	tool(
		'list_container_files',
		{
			title: 'List container files',
			description:
				"One directory of a running container's filesystem (the image's root plus its volumes), symlinks resolved inside the container. " +
				'Secret files and tmpfs mounts such as /tmp are refused. At most 2,000 entries (`truncated` says when there were more).',
			inputSchema: z.object({
				project: z.string(),
				path: z.string().max(4096).optional().describe('Absolute path inside the container; default "/".'),
				replica: replicaInput
			}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('container:files'),
			feature: 'CONTAINER_CONSOLE'
		},
		async (input) =>
			run(() =>
				consoleJson(containerConsoleDeps, principal, input.project, 'files', {
					path: input.path ?? '/',
					replica: input.replica
				})
			)
	);

	tool(
		'read_container_file',
		{
			title: 'Read container file',
			description:
				'A text file from a running container, up to 1 MiB. Binary or larger files come back with `content: null` and a `reason`; ' +
				'download them from the dashboard or with `skif container cp`. Reads are audited.',
			inputSchema: z.object({ project: z.string(), path: z.string().min(1).max(4096), replica: replicaInput }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('container:files'),
			feature: 'CONTAINER_CONSOLE'
		},
		async (input) =>
			run(() =>
				consoleJson(containerConsoleDeps, principal, input.project, 'files/preview', {
					path: input.path,
					replica: input.replica
				})
			)
	);

	tool(
		'restart_container',
		{
			title: 'Restart container',
			description:
				'Restart every replica of a container project from the same image and configuration, through desired state. ' +
				'Requests fail for the few seconds it takes to come back. Follow with inspect_container and get_logs.',
			inputSchema: z.object({ project: z.string() }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
			scopeChallenge: requires('project:update'),
			feature: 'CONTAINER_CONSOLE'
		},
		async (input) => run(() => consoleJson(containerConsoleDeps, principal, input.project, 'restart'))
	);

	// --- platform registry (docs/REGISTRY.md G2): read-only; push, delete and deploy stay elsewhere --
	tool(
		'list_images',
		{
			title: 'List registry images',
			description:
				"List the org's repositories in the platform container registry (<host>/<org>/<name>), with the last pushed tag, " +
				'digest and push time, sampled size, linked project and deploy-on-push target. Deploy one with set_workload ' +
				'using image "<host>/<repository>:<tag>"; the deploy pins its digest.',
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('image:pull'),
		},
		async () =>
			run(() => {
				const registry = core.registry.view(principal);
				return {
					host: registry.enabled ? registry.host : null,
					enabled: registry.enabled,
					repositories: registry.enabled ? core.registry.listRepositories(principal) : [],
				};
			}),
	);

	tool(
		'image_tags',
		{
			title: 'List image tags',
			description:
				'List the tags of one repository in the platform registry, each with its digest. Deployment pins (skiff-d-…) are hidden.',
			inputSchema: z.object({
				repository: z.string().min(3).max(255).describe('Repository as listed by list_images, e.g. acme/api'),
			}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('image:pull'),
		},
		async ({ repository }) => run(async () => ({ repository, tags: await core.registry.tags(principal, repository) })),
	);

	tool(
		'get_audit_log',
		{
			title: 'Get audit log',
			description:
				'Audit entries for the org, newest first: user, MCP client, tool, args (secrets redacted), result. ' +
				'Narrow with `from`/`to` (a date like 2026-11-07, an ISO timestamp or epoch ms; a date as `to` covers that whole day, UTC). ' +
				'When `nextCursor` is set there are older entries: call again with `cursor` set to it.',
			inputSchema: z.object({
				limit: z.number().int().min(1).max(200).default(50),
				action: z.string().optional().describe('Exact action, e.g. project.delete or mcp.deploy_site'),
				resource: z.string().optional().describe('Exact resource type, e.g. project or log_drain'),
				from: z.string().max(40).optional().describe('Oldest entry to include (inclusive)'),
				to: z.string().max(40).optional().describe('Newest entry to include (inclusive)'),
				cursor: z.string().max(200).optional().describe('nextCursor from the previous call'),
			}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('project:read'),
		},
		async ({ limit, action, resource, from, to, cursor }) =>
			run(() =>
				core.audit.page({
					principal,
					limit,
					action,
					resource,
					from: parseAuditTime(from, 'from'),
					to: parseAuditTime(to, 'to'),
					cursor: cursor ?? null,
				}),
			),
	);

	// --- log drains (DESIGN §8; private-network drains and edits are dashboard/REST/CLI only) ----
	const drainSummary = (drain: LogDrainView) =>
		`${drain.kind === 'otlp' ? 'OTLP' : 'webhook'} drain "${drain.name}" → ${drain.url} (${drain.project ? `project ${drain.project}` : 'every project in the org'})`;

	tool(
		'list_log_drains',
		{
			title: 'List log drains',
			description:
				'Log drains forward the org\'s log lines (build, runtime, system, managed services) to a webhook or an OTLP receiver. ' +
				'Shows each drain\'s target (query-string values masked), filters, status (healthy, failing, pending, disabled) and delivery ' +
				'counters, including dropped (dead-letter) lines and the last error. Header values and signing secrets are never shown.',
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('logs:read'),
		},
		async () => run(() => ({ drains: core.logDrains.list(principal), canEdit: core.logDrains.canEdit(principal) })),
	);

	tool(
		'create_log_drain',
		{
			title: 'Create log drain',
			description:
				'Forward log lines to an external HTTPS endpoint from now on (earlier lines are not sent). `webhook` POSTs NDJSON ' +
				'(or a JSON array) signed with X-Skiff-Signature; `otlp` POSTs OTLP/HTTP JSON to <url>/v1/logs (Grafana, Datadog, ' +
				'Honeycomb, an OpenTelemetry Collector…). Put an API key in `headers`; values are stored sealed and never shown again. ' +
				'Org owners and admins only; at most 10 per org. The webhook signing secret is in the answer once: hand it to the user.',
			inputSchema: z.object({
				name: z.string().min(1).max(64),
				kind: z.enum(logDrainKinds),
				url: z.string().min(1).max(2048).describe('https:// receiver URL'),
				format: z.enum(logDrainFormats).optional().describe('Webhook only: ndjson (default) or json'),
				project: z.string().optional().describe('Only this project (slug); omit for every project and managed services'),
				sources: z.array(z.enum(logDrainSources)).max(4).default([]).describe('Empty forwards every source'),
				minLevel: z.enum(logDrainLevels).optional().describe('Forward this level and above'),
				headers: z.record(z.string(), z.string()).optional().describe('Sent with every request, e.g. { "Authorization": "Bearer …" }'),
				enabled: z.boolean().default(true),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
			scopeChallenge: requires('logs:read'),
		},
		// The dashboard assistant asks for a click before this runs (CONFIRM_TOOLS): a drain copies logs out of Skiff.
		async (input) =>
			run(() => {
				const result = core.logDrains.create(principal, input);
				return {
					...result,
					nextSteps: [
						`Check the receiver with test_log_drain({ id: "${result.drain.id}" }).`,
						...(result.signingSecret
							? [`Give the user the signing secret now; it is not shown again. Verify X-Skiff-Signature as HMAC-SHA256(secret, "<t>.<body>").`]
							: []),
					],
				};
			}),
	);

	tool(
		'test_log_drain',
		{
			title: 'Test log drain',
			description:
				'Send one test line to a drain now and report what the receiver answered. Delivery counters and cursors are left alone.',
			inputSchema: z.object({ id: z.string().describe('Drain id (ldr_…)') }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
			scopeChallenge: requires('logs:read'),
		},
		async ({ id }) => run(async () => ({ result: await core.logDrains.test(principal, id) })),
	);

	tool(
		'delete_log_drain',
		{
			title: 'Delete log drain',
			description:
				'Delete a log drain: forwarding stops at once. Lines already sent stay with the receiver. To pause it instead, ' +
				'disable it in the dashboard (Settings → Log drains) or with `skif log-drain update --disable`. Requires confirmation.',
			inputSchema: z.object({ id: z.string().describe('Drain id (ldr_…)') }),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
			scopeChallenge: requires('logs:read'),
		},
		async ({ id }, ctx) => {
			const remove = () =>
				run(() => {
					core.logDrains.delete(principal, id);
					return { ok: true, id };
				});
			if (era === 'assistant') return remove();
			if (era === 'legacy')
				return {
					isError: true,
					...text(
						`Deleting log drain ${id} needs your confirmation, which this MCP client can't show. ` +
							`Ask the user to delete it from the Skiff dashboard: ${core.ctx.config.platformOrigin}/settings/log-drains`,
					),
				};
			const key = `confirm_delete_log_drain:${id}`;
			const schema = z.object({ confirm: z.boolean() });
			const prompted = verifyConfirmation(ctx.mcpReq.requestState(), principal, 'delete_log_drain', id);
			const answer = prompted ? acceptedContent(ctx.mcpReq.inputResponses, key, schema) : undefined;
			const responded = prompted && ctx.mcpReq.inputResponses?.[key] !== undefined;
			if (responded && answer?.confirm !== true) {
				const cancelled = text(`Cancelled: log drain ${id} was not deleted (the user did not confirm).`);
				declined.add(cancelled);
				return cancelled;
			}
			if (answer?.confirm !== true) {
				let drain: LogDrainView;
				try {
					drain = core.logDrains.get(principal, id);
				} catch (error) {
					return run(() => {
						throw error;
					});
				}
				return inputRequired({
					inputRequests: {
						[key]: inputRequired.elicit({
							message: `Delete the ${drainSummary(drain)}? Forwarding stops at once; this cannot be undone.`,
							requestedSchema: schema,
						}),
					},
					requestState: mintConfirmation(principal, 'delete_log_drain', id),
				});
			}
			return remove();
		},
	);

	tool(
		'list_nodes',
		{
			title: 'List nodes',
			description: 'List fleet nodes (read-only). Requires a platform admin role.',
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('project:read'),
		},
		async () => run(() => ({ nodes: core.nodes.list(principal) })),
	);

	tool(
		'get_ha_status',
		{
			title: 'Get HA status',
			description:
				'Read the failover controller (read-only): whether automatic failover is on, the controller lease (epoch, holder), ' +
				'nodes and how long each has been silent, the ingress record set, databases whose primary is lost with the replica a ' +
				'promotion would pick, and recent failover events (replica moves, ingress withdrawals, database decisions). ' +
				'Requires a platform admin role. MCP never changes placement or promotes anything (CLUSTERING §12.4).',
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('project:read'),
		},
		async () => run(() => core.failover.status(principal)),
	);

	// --- email (docs/EMAIL.md §9; no credential, settings or org-state tools: D58, platform admin only) ----
	const emailNote =
		'Mail goes out from an address on one of the org\'s verified sending domains. A new org starts in the sandbox ' +
		'(low limits, its own verified domains and verified sandbox recipients only) until an org owner or admin requests ' +
		'production access and a platform admin approves it. Recipients on the suppression list ' +
		'(hard bounces, complaints, manual entries) are dropped from a message, not reported as an error.';

	/** What the user still has to add to DNS, phrased so an agent can relay it as-is. */
	const emailDomainNextSteps = (view: EmailDomainView): string[] => {
		const missing = view.records.filter((record) => !record.ok);
		if (view.status === 'verified' && missing.length === 0) return [`${view.name} is verified and every record checks out.`];
		const steps = missing.map(
			(record) =>
				`${record.required ? 'Required' : 'Recommended'} (${record.purpose}): ${record.type} record at ${record.name}` +
				`${record.priority !== undefined ? ` with priority ${record.priority}` : ''}, value: ${record.value}` +
				(record.note ? ` (${record.note})` : ''),
		);
		if (view.status !== 'verified')
			steps.push(`After adding the records, call check_email_domain with domain "${view.name}". Sending works once the DKIM record is found.`);
		else if (view.failingSince)
			steps.push(`The DKIM record went missing at ${view.failingSince}; sending from ${view.name} pauses if it is not back within 72 hours.`);
		return steps;
	};

	const recipientInputSchema = z.union([
		z.string().describe('Bare address, e.g. ada@example.com'),
		z.object({ name: z.string().max(200).optional(), address: z.string().describe('Bare address') }),
	]);
	const recipientsInputSchema = z.array(recipientInputSchema).max(EMAIL_MAX_RECIPIENTS).default([]);
	const recipientLabel = (recipient: z.infer<typeof recipientInputSchema>) =>
		typeof recipient === 'string' ? recipient : recipient.name ? `${recipient.name} <${recipient.address}>` : recipient.address;
	const recipientAddressOf = (recipient: z.infer<typeof recipientInputSchema>) =>
		(typeof recipient === 'string' ? recipient : recipient.address).trim();

	/** Why a send would be refused before the policy check even runs, so the user isn't asked to confirm a dead end. */
	const emailSendBlocker = (from: z.infer<typeof recipientInputSchema>): string | null => {
		const settings = core.email.settings();
		if (!settings.nodeId)
			return 'Email is not set up on this platform yet: a platform admin has to choose a mail node in the Skiff dashboard (Settings → Email) before anything can be delivered.';
		const address = recipientAddressOf(from);
		const domain = address.slice(address.lastIndexOf('@') + 1).toLowerCase();
		let domains: EmailDomainView[];
		try {
			domains = core.email.listDomains(principal);
		} catch {
			// A token with email:send but not email:read: leave the domain checks to core.email.send.
			return null;
		}
		const match = domains.find((entry) => entry.name === domain);
		const usable = domains.filter((entry) => entry.status === 'verified' && entry.sending).map((entry) => entry.name);
		const elsewhere = usable.length ? ` Verified sending domains: ${usable.join(', ')}.` : ' The org has no verified sending domain yet.';
		if (!match) return `${domain} is not a sending domain of this org. Add it with create_email_domain.${elsewhere}`;
		if (match.status !== 'verified')
			return `${domain} is not verified yet (status ${match.status}). Use get_email_domain to see the DNS records it still needs.${elsewhere}`;
		if (!match.sending) return `Sending from ${domain} is turned off for this org.${elsewhere}`;
		return null;
	};

	tool(
		'get_email_status',
		{
			title: 'Get email status',
			description:
				'Whether Email is set up on this platform (a mail node is chosen), the org\'s sending state (sandbox, active or paused, with the reason), ' +
				'limits, messages sent today, bounce and complaint rates, and its sending domains. Start here before sending. ' +
				emailNote,
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('email:read'),
			feature: 'EMAIL',
		},
		async () =>
			run(() => {
				const org = core.email.orgView(principal);
				const settings = core.email.settings();
				const domains = core.email.listDomains(principal).map((view) => ({ name: view.name, status: view.status, sending: view.sending }));
				const nextSteps: string[] = [];
				if (!settings.nodeId)
					nextSteps.push('Email is not set up yet: a platform admin chooses a mail node in the Skiff dashboard (Settings → Email). Until then nothing is delivered.');
				if (settings.paused) nextSteps.push('A platform admin has paused all outgoing mail on this platform.');
				if (org.state === 'paused') nextSteps.push(`This org's sending is paused: ${org.pausedReason ?? 'by a platform admin'}. Only a platform admin can resume it.`);
				if (org.state === 'sandbox') {
					nextSteps.push(
						`The org is in the sandbox (${org.perSecond}/s, ${org.perDay}/day): mail goes only to its verified domains and to verified sandbox recipients (list_email_addresses, add_email_address).`,
					);
					let request: ReturnType<typeof core.email.accessRequest> = null;
					try {
						request = core.email.accessRequest(principal);
					} catch {
						// Unknown request state: the generic step below still applies.
					}
					if (request?.status === 'pending')
						nextSteps.push(`Production access was requested at ${request.createdAt} and is waiting for a platform admin; the requester gets an email with the answer.`);
					else
						nextSteps.push(
							(request?.status === 'denied' ? `The last production access request was denied${request.note ? ` (${request.note})` : ''}. ` : '') +
								'For real traffic, an org owner or admin requests production access: Email → Sandbox in the Skiff dashboard, ' +
								`\`skif email request-access --use-case "…" --volume <per day>\`, or POST ${core.ctx.config.platformOrigin}/api/v1/email/access-request. A platform admin reviews it.`,
						);
				}
				if (!domains.some((entry) => entry.status === 'verified' && entry.sending))
					nextSteps.push('No verified sending domain yet: add one with create_email_domain.');
				return {
					setUp: settings.nodeId !== null,
					platformPaused: settings.paused,
					org,
					domains,
					smtp: { host: settings.hostnames.submission, port: 587, secure: 'starttls' },
					nextSteps,
				};
			}),
	);

	tool(
		'list_email_domains',
		{
			title: 'List email domains',
			description: 'List the org\'s sending domains with their verification status and DNS records (each with its last check result).',
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('email:read'),
			feature: 'EMAIL',
		},
		async () => run(() => ({ domains: core.email.listDomains(principal) })),
	);

	tool(
		'get_email_domain',
		{
			title: 'Get email domain',
			description:
				'Get one sending domain: status, every DNS record it needs (DKIM, SPF, DMARC) with what public DNS returned at the last check, ' +
				'and `nextSteps` listing exactly which records the user still has to add. Relay those to the user verbatim.',
			inputSchema: z.object({ domain: z.string().describe('Domain name, e.g. example.com') }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('email:read'),
			feature: 'EMAIL',
		},
		async ({ domain }) =>
			run(() => {
				const view = core.email.getDomain(principal, domain);
				return { domain: view, nextSteps: emailDomainNextSteps(view) };
			}),
	);

	tool(
		'create_email_domain',
		{
			title: 'Create email domain',
			description:
				'Add a sending domain to the org. Skiff generates its DKIM key and, when the domain is in the platform\'s Cloudflare zone and ' +
				'`autoDns` is on, creates the records itself; otherwise the result lists the records the user must add at their DNS host. ' +
				'Sending works once the DKIM record is found (check_email_domain).',
			inputSchema: z.object({
				domain: z.string().describe('Domain to send from, e.g. example.com or mail.example.com'),
				sending: z.boolean().default(true).describe('Allow sending from it right away once verified'),
				autoDns: z.boolean().default(true).describe('Create the records through Cloudflare when Skiff manages the zone'),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
			scopeChallenge: requires('email:update'),
			feature: 'EMAIL',
		},
		async ({ domain, sending, autoDns }) =>
			run(async () => {
				const view = await core.email.createDomain(principal, { name: domain, sending, autoDns });
				return { domain: view, nextSteps: emailDomainNextSteps(view) };
			}),
	);

	tool(
		'check_email_domain',
		{
			title: 'Check email domain',
			description:
				'Look the domain\'s records up in public DNS now and update its status (verified once DKIM is found). DNS changes can take a few ' +
				'minutes to show up; if a record is still missing, wait and check again rather than asking the user to re-add it.',
			inputSchema: z.object({ domain: z.string().describe('Domain name') }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
			scopeChallenge: requires('email:read'),
			feature: 'EMAIL',
		},
		async ({ domain }) =>
			run(async () => {
				const view = await core.email.checkDomain(principal, domain);
				return { domain: view, nextSteps: emailDomainNextSteps(view) };
			}),
	);

	const sendEmailInputSchema = z.object({
		from: recipientInputSchema.describe('Sender: an address on a verified sending domain of the org'),
		to: recipientsInputSchema,
		cc: recipientsInputSchema,
		bcc: recipientsInputSchema,
		replyTo: z.array(recipientInputSchema).max(10).default([]),
		subject: z.string().max(998).describe('One line'),
		text: z.string().optional().describe('Plain-text body; give text, html or both'),
		html: z.string().optional().describe('HTML body'),
		tags: z.record(z.string(), z.string()).default({}).describe('Up to 10 key/value tags, echoed in the message log'),
		idempotencyKey: z.string().min(1).max(255).optional().describe('Repeat sends with the same key within 24 h return the first message'),
	});

	tool(
		'send_email',
		{
			title: 'Send email',
			description:
				`Send a real email to real people from the org's verified domain (at most ${EMAIL_MAX_RECIPIENTS} recipients across to, cc and bcc). ` +
				'The user must confirm each message before it is sent, and a sent message cannot be recalled: only send what the user asked for. ' +
				'The result is the message id; delivery happens afterwards, so follow it with get_email_message. ' +
				'In the sandbox, only verified recipients are accepted. Attachments and raw MIME are API/SMTP only. ' +
				emailNote,
			inputSchema: sendEmailInputSchema,
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
			scopeChallenge: requires('email:send'),
			feature: 'EMAIL',
		},
		async (input, ctx) => {
			const send = (idempotencyKey?: string) =>
				run(async () => {
					const result = await core.email.send(principal, { ...input, ...(idempotencyKey && !input.idempotencyKey ? { idempotencyKey } : {}) });
					return {
						...result,
						nextSteps: [
							`Accepted for delivery, not yet delivered. Call get_email_message with id "${result.id}" to see each recipient's status.`,
							...(result.suppressed.length
								? [`Dropped because they are on the suppression list: ${result.suppressed.join(', ')}. See list_email_suppressions.`]
								: []),
						],
					};
				});
			// The dashboard assistant asks for a click in the chat before this runs (CONFIRM_TOOLS).
			if (era === 'assistant') return send();
			if (era === 'legacy')
				return {
					isError: true,
					...text(
						'Sending email needs your confirmation, which this MCP client can\'t show. ' +
							`Ask the user to send it themselves (POST ${core.ctx.config.platformOrigin}/api/v1/email/send with an API key, or their SMTP client).`,
					),
				};
			// The prompt is bound to this exact message: a confirmed state can't be reused for different content.
			const target = createHash('sha256').update(JSON.stringify(input)).digest('base64url');
			const key = 'confirm_send_email';
			const schema = z.object({ confirm: z.boolean() });
			const state = ctx.mcpReq.requestState();
			const prompted = verifyConfirmation(state, principal, 'send_email', target);
			const answer = prompted ? acceptedContent(ctx.mcpReq.inputResponses, key, schema) : undefined;
			const responded = prompted && ctx.mcpReq.inputResponses?.[key] !== undefined;
			if (responded && answer?.confirm !== true) {
				const cancelled = text(`Cancelled: the email "${input.subject}" was not sent (the user did not confirm).`);
				declined.add(cancelled);
				return cancelled;
			}
			if (answer?.confirm !== true) {
				// Fail before prompting when the message can't be sent anyway.
				const parsed = emailSendSchema.safeParse(input);
				if (!parsed.success)
					return { isError: true, ...text(parsed.error.issues.map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('\n')) };
				const blocker = emailSendBlocker(input.from);
				if (blocker) return { isError: true, ...text(blocker) };
				const body = (input.text ?? (input.html ?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
				const lines = [
					'Send this email? It goes to real recipients and cannot be recalled.',
					'',
					`From: ${recipientLabel(input.from)}`,
					...(input.to.length ? [`To: ${input.to.map(recipientLabel).join(', ')}`] : []),
					...(input.cc.length ? [`Cc: ${input.cc.map(recipientLabel).join(', ')}`] : []),
					...(input.bcc.length ? [`Bcc: ${input.bcc.map(recipientLabel).join(', ')}`] : []),
					`Subject: ${input.subject}`,
					'',
					body.length > 500 ? `${body.slice(0, 500)}…` : body,
				];
				return inputRequired({
					inputRequests: { [key]: inputRequired.elicit({ message: lines.join('\n'), requestedSchema: schema }) },
					requestState: mintConfirmation(principal, 'send_email', target),
				});
			}
			// One confirmation sends once: replaying the same confirmed state hits the same idempotency key.
			return send(`mcp-${createHash('sha256').update(String(state)).digest('base64url')}`);
		},
	);

	tool(
		'list_email_messages',
		{
			title: 'List email messages',
			description:
				'The org\'s message log, newest first: sender, subject, overall status and each recipient\'s latest status. ' +
				'Filter by `recipient` (exact address) or `status`; page with `before` (the oldest createdAt you have).',
			inputSchema: z.object({
				limit: z.number().int().min(1).max(200).default(20),
				before: z.string().optional().describe('ISO timestamp: only messages created before it'),
				recipient: z.string().optional().describe('Exact recipient address'),
				status: z.enum(emailEventKinds).optional(),
			}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('email:read'),
			feature: 'EMAIL',
		},
		async ({ limit, before, recipient, status }) =>
			run(() => ({
				messages: core.email.listMessages(principal, {
					limit,
					...(before ? { before } : {}),
					...(recipient ? { recipient } : {}),
					...(status ? { status } : {}),
				}),
			})),
	);

	tool(
		'get_email_message',
		{
			title: 'Get email message',
			description:
				'One message by id (em_…): each recipient\'s status (accepted, deferred, delivered, bounced, complained, rejected, suppressed) ' +
				'and the last SMTP response from the receiving server, which explains bounces and deferrals.',
			inputSchema: z.object({ id: z.string().describe('Message id, em_…') }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('email:read'),
			feature: 'EMAIL',
		},
		async ({ id }) => run(() => ({ message: core.email.getMessage(principal, id) })),
	);

	tool(
		'list_email_suppressions',
		{
			title: 'List email suppressions',
			description:
				'Addresses the org never sends to: hard bounces, complaints, unsubscribes and manual entries, newest first. ' +
				'Pass `address` to check one address.',
			inputSchema: z.object({
				limit: z.number().int().min(1).max(1000).default(100),
				address: z.string().optional().describe('Exact address to look up'),
			}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('email:read'),
			feature: 'EMAIL',
		},
		async ({ limit, address }) =>
			run(() => ({ suppressions: core.email.listSuppressions(principal, { limit, ...(address ? { address } : {}) }) })),
	);

	tool(
		'remove_email_suppression',
		{
			title: 'Remove email suppression',
			description:
				'Take an address off the suppression list so mail to it is attempted again. Only do this when the user says the address ' +
				'is fixed (e.g. the mailbox exists again): sending to addresses that bounce or complain can pause the whole org. Requires confirmation.',
			inputSchema: z.object({ address: z.string().describe('Suppressed address') }),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
			scopeChallenge: requires('email:read', 'email:update'),
			feature: 'EMAIL',
		},
		async ({ address }, ctx) => {
			const remove = () =>
				run(() => {
					core.email.removeSuppression(principal, address);
					return { ok: true, address };
				});
			if (era === 'assistant') return remove();
			if (era === 'legacy')
				return {
					isError: true,
					...text(
						`Removing ${address} from the suppression list needs your confirmation, which this MCP client can't show. ` +
							`Ask the user to remove it themselves (DELETE ${core.ctx.config.platformOrigin}/api/v1/email/suppressions/${encodeURIComponent(address)}).`,
					),
				};
			const target = address.trim().toLowerCase();
			const key = `confirm_remove_email_suppression:${target}`;
			const schema = z.object({ confirm: z.boolean() });
			const prompted = verifyConfirmation(ctx.mcpReq.requestState(), principal, 'remove_email_suppression', target);
			const answer = prompted ? acceptedContent(ctx.mcpReq.inputResponses, key, schema) : undefined;
			const responded = prompted && ctx.mcpReq.inputResponses?.[key] !== undefined;
			if (responded && answer?.confirm !== true) {
				const cancelled = text(`Cancelled: ${address} stays on the suppression list (the user did not confirm).`);
				declined.add(cancelled);
				return cancelled;
			}
			if (answer?.confirm !== true) {
				let entry;
				try {
					entry = core.email.listSuppressions(principal, { address, limit: 1 })[0];
				} catch (error) {
					return run(() => {
						throw error;
					});
				}
				if (!entry) return { isError: true, ...text(`${address} is not on the suppression list.`) };
				return inputRequired({
					inputRequests: {
						[key]: inputRequired.elicit({
							message:
								`Remove ${entry.address} from the suppression list? It was added on ${entry.createdAt} (${entry.reason}). ` +
								'Mail to it will be attempted again; repeated bounces or complaints can pause sending for the whole org.',
							requestedSchema: schema,
						}),
					},
					requestState: mintConfirmation(principal, 'remove_email_suppression', target),
				});
			}
			return remove();
		},
	);

	// Sandbox recipients (docs/EMAIL.md §4.3): single addresses an org in the sandbox may send to once
	// their owner clicked a link. Adding one mails a third party, so it is confirmed like a send.
	const sandboxAddressNextSteps = (view: EmailSandboxAddressView): string[] =>
		view.status === 'verified'
			? [`${view.address} is verified: the sandbox accepts mail to it.`]
			: [
					`A verification link went to ${view.address}${view.expiresAt ? ` (it expires at ${view.expiresAt})` : ''}. ` +
						'Mail to it is refused until its owner opens the link and confirms; ask the user to check that inbox, then call list_email_addresses.',
				];
	const sandboxAddressOf = (address: string): EmailSandboxAddressView | undefined => {
		const wanted = address.trim().toLowerCase();
		return core.email.listSandboxAddresses(principal).find((entry) => entry.address === wanted);
	};

	tool(
		'list_email_addresses',
		{
			title: 'List email sandbox recipients',
			description:
				'Single addresses the org may send to while it is in the email sandbox, besides its own verified domains: ' +
				'each is pending until its owner confirms the emailed link, then verified. Not needed once the org is active.',
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('email:read'),
			feature: 'EMAIL',
		},
		async () =>
			run(() => {
				const org = core.email.orgView(principal);
				return {
					state: org.state,
					addresses: core.email.listSandboxAddresses(principal),
					limits: EMAIL_SANDBOX_ADDRESS_LIMITS,
					...(org.state === 'sandbox' ? {} : { note: 'The org is out of the sandbox: it can send to any address; this list is not used.' }),
				};
			}),
	);

	tool(
		'add_email_address',
		{
			title: 'Add email sandbox recipient',
			description:
				'Add a sandbox recipient: Skiff emails the address a single-use link (valid 24 hours), and mail to it is accepted once its owner confirms. ' +
				'Calling it again for a pending address sends a fresh link (at most once a minute). Only add an address the user named, ' +
				'ideally a mailbox they can read: the link goes to a real person. Requires confirmation.',
			inputSchema: z.object({ address: z.string().describe('Bare address, e.g. ada@gmail.com') }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
			scopeChallenge: requires('email:read', 'email:update'),
			feature: 'EMAIL',
		},
		async ({ address }, ctx) => {
			const add = () =>
				run(async () => {
					const view = await core.email.addSandboxAddress(principal, { address });
					return { address: view, nextSteps: sandboxAddressNextSteps(view) };
				});
			// The dashboard assistant asks for a click in the chat before this runs (CONFIRM_TOOLS).
			if (era === 'assistant') return add();
			if (era === 'legacy')
				return {
					isError: true,
					...text(
						`Emailing a verification link to ${address} needs your confirmation, which this MCP client can't show. ` +
							'Ask the user to add it themselves in the Skiff dashboard (Email → Sandbox) or with `skif email addresses add`.',
					),
				};
			const target = address.trim().toLowerCase();
			const key = `confirm_add_email_address:${target}`;
			const schema = z.object({ confirm: z.boolean() });
			const prompted = verifyConfirmation(ctx.mcpReq.requestState(), principal, 'add_email_address', target);
			const answer = prompted ? acceptedContent(ctx.mcpReq.inputResponses, key, schema) : undefined;
			const responded = prompted && ctx.mcpReq.inputResponses?.[key] !== undefined;
			if (responded && answer?.confirm !== true) {
				const cancelled = text(`Cancelled: no verification link went to ${address} (the user did not confirm).`);
				declined.add(cancelled);
				return cancelled;
			}
			if (answer?.confirm !== true) {
				const parsed = emailSandboxAddressCreateSchema.safeParse({ address });
				if (!parsed.success) return { isError: true, ...text(`${address} is not a valid email address.`) };
				let existing: EmailSandboxAddressView | undefined;
				try {
					existing = sandboxAddressOf(address);
				} catch (error) {
					return run(() => {
						throw error;
					});
				}
				// Already verified: nothing is mailed, so there is nothing to confirm.
				if (existing?.status === 'verified') return add();
				return inputRequired({
					inputRequests: {
						[key]: inputRequired.elicit({
							message:
								`Email a verification link to ${target}? ` +
								(existing ? 'It replaces the link sent earlier. ' : '') +
								'Once its owner confirms, this organisation can send test mail to it while in the sandbox.',
							requestedSchema: schema,
						}),
					},
					requestState: mintConfirmation(principal, 'add_email_address', target),
				});
			}
			return add();
		},
	);

	tool(
		'remove_email_address',
		{
			title: 'Remove email sandbox recipient',
			description:
				'Remove a sandbox recipient. While the org is in the sandbox, sends to it are refused again, and adding it back needs a new ' +
				'confirmation from its owner. Requires confirmation.',
			inputSchema: z.object({ address: z.string().describe('The sandbox recipient to remove') }),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
			scopeChallenge: requires('email:read', 'email:update'),
			feature: 'EMAIL',
		},
		async ({ address }, ctx) => {
			const remove = () =>
				run(() => {
					core.email.removeSandboxAddress(principal, address);
					return { ok: true, address: address.trim().toLowerCase() };
				});
			if (era === 'assistant') return remove();
			if (era === 'legacy')
				return {
					isError: true,
					...text(
						`Removing ${address} from the sandbox recipients needs your confirmation, which this MCP client can't show. ` +
							`Ask the user to remove it themselves (DELETE ${core.ctx.config.platformOrigin}/api/v1/email/addresses/${encodeURIComponent(address)}).`,
					),
				};
			const target = address.trim().toLowerCase();
			const key = `confirm_remove_email_address:${target}`;
			const schema = z.object({ confirm: z.boolean() });
			const prompted = verifyConfirmation(ctx.mcpReq.requestState(), principal, 'remove_email_address', target);
			const answer = prompted ? acceptedContent(ctx.mcpReq.inputResponses, key, schema) : undefined;
			const responded = prompted && ctx.mcpReq.inputResponses?.[key] !== undefined;
			if (responded && answer?.confirm !== true) {
				const cancelled = text(`Cancelled: ${address} stays a sandbox recipient (the user did not confirm).`);
				declined.add(cancelled);
				return cancelled;
			}
			if (answer?.confirm !== true) {
				let entry: EmailSandboxAddressView | undefined;
				try {
					entry = sandboxAddressOf(address);
				} catch (error) {
					return run(() => {
						throw error;
					});
				}
				if (!entry) return { isError: true, ...text(`${address} is not a sandbox recipient of this org.`) };
				return inputRequired({
					inputRequests: {
						[key]: inputRequired.elicit({
							message:
								`Remove ${entry.address} from the sandbox recipients (${entry.status})? ` +
								'While the organisation is in the sandbox, mail to it is refused again until its owner confirms a new link.',
							requestedSchema: schema,
						}),
					},
					requestState: mintConfirmation(principal, 'remove_email_address', target),
				});
			}
			return remove();
		},
	);

	// --- resources ----------------------------------------------------------
	server.registerResource(
		'deploying',
		'skiff://guides/deploying',
		{ title: 'Deploying with Skiff', mimeType: 'text/markdown' },
		async (uri) => ({
			contents: [
				{
					uri: uri.href,
					text: [
						'# Deploying with Skiff',
						'',
						'Use `deploy_site` for a one-shot deploy: it creates the project if missing, deploys inline files (≤5 MB) and promotes to production by default.',
						'',
						'For larger sites use `create_upload`, PUT the zip to the presigned URL, then `finalize_upload`.',
						'',
						'Every deployment gets an immutable preview URL `<slug>--<id>.<contentDomain>`. `promote_deployment` and `rollback` are instant because they only move a pointer.',
						'',
						'Named environments (`create_environment`, `list_environments`) serve at `<slug>--<env>.<contentDomain>`. Use `deploy_to_environment` to deploy into one; only its own pointer moves. Process/container projects run a single workload: only the latest deployment is active, every environment host and preview URL proxies to it, and a production promote or rollback re-points the workload.',
					].join('\n'),
				},
			],
		}),
	);
	server.registerResource(
		'limits',
		'skiff://guides/limits',
		{ title: 'Skiff limits', mimeType: 'text/markdown' },
		async (uri) => ({
			contents: [
				{
					uri: uri.href,
					text: [
						'# Limits',
						'',
						`- Artifact: ${limits.artifactBytes} bytes`,
						`- Files: ${limits.files}`,
						`- One file: ${limits.fileBytes} bytes`,
						`- Inline MCP deploy: ${limits.inlineBytes} bytes`,
						`- Retained deployments per project: ${core.policies.get().retainedDeployments} by default (plus pinned; org and app quotas can override)`,
					].join('\n'),
				},
			],
		}),
	);
	server.registerResource(
		'site-config',
		'skiff://guides/site-config',
		{ title: 'Site configuration', mimeType: 'text/markdown' },
		async (uri) => ({
			contents: [
				{
					uri: uri.href,
					text: [
						'# Site configuration',
						'',
						'`_redirects` (Netlify syntax): `<from> <to> [status]`. Splats (`/old/*`) and `:placeholders` are supported.',
						'',
						'`_headers` (Netlify syntax): a path line followed by indented `Name: value` lines.',
						'',
						'`skiff.json`: `{ "spa": bool, "cleanUrls": bool, "trailingSlash": "always"|"never"|"ignore", "notFound": "/404.html" }`.',
					].join('\n'),
				},
			],
		}),
	);
	server.registerResource(
		'databases',
		'skiff://guides/databases',
		{ title: 'Managed databases', mimeType: 'text/markdown' },
		async (uri) => ({
			contents: [
				{
					uri: uri.href,
					text: [
						'# Managed databases',
						'',
						'Skiff runs managed databases as org resources on one node: PostgreSQL (16/17, the default), MySQL (8.4/9.7), MariaDB (11.4/11.8), MongoDB (8.0/9.0), Valkey (8.1/9.1), Redis (8.8/8.10) and ClickHouse (26.3/26.8). Create one with `create_database` (set `engine`); pass `project` to attach it to an app in the same call. Use Valkey for caches and queues (BullMQ, Sidekiq) unless the app needs Redis-only modules, and ClickHouse for analytics, events and logs (it needs at least 1 GB of memory).',
						'',
						'An attached process or container project receives `<PREFIX>_URL`, `_HOST`, `_PORT`, `_USER`, `_PASSWORD` and `_NAME` at activation (`PREFIX` defaults to `DATABASE`, `MONGODB` for MongoDB (which also gets `MONGODB_URI`), `REDIS` for Valkey/Redis and `CLICKHOUSE` for ClickHouse, so read `DATABASE_URL`, `MONGODB_URI`, `REDIS_URL` or `CLICKHOUSE_URL`). Use a different prefix per database when a project has several. Static projects cannot use databases.',
						'',
						"Apps and their databases share a node in v1. A project with attachments is placed on the database's node at deploy time, so `auto` placement just works; an explicit placement on another node is rejected. If `attach_database` warns that the app runs elsewhere, redeploy it.",
						'',
						'Credentials are never returned over MCP: apps get them injected, and humans can reveal them from the dashboard or `skif db credentials`.',
						'',
						'`get_database` shows status, the largest tables and a last-hour summary (size vs storage budget, connections vs max_connections, commits/min, cache hit ratio).',
						'',
						'`delete_database` is a confirmed soft delete (restorable for the trash period, 7 days by default) and is refused while projects are attached; `detach_database` first. Permanent deletion is dashboard/CLI only.',
					].join('\n'),
				},
			],
		}),
	);

	server.registerResource(
		'storage',
		'skiff://guides/storage',
		{ title: 'Managed object storage', mimeType: 'text/markdown' },
		async (uri) => ({
			contents: [
				{
					uri: uri.href,
					text: [
						'# Managed object storage',
						'',
						'Skiff runs S3-compatible object storage (RustFS) as an org resource on one node. Create an instance with `create_storage` (pass `buckets` to create private buckets, and `project` to attach it in the same call), and more buckets with `create_bucket`.',
						'',
						'An attached process or container project receives its own scoped key at activation: `<PREFIX>_ENDPOINT_URL`, `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY`, `_REGION` and `_FORCE_PATH_STYLE`, plus `_BUCKET` when exactly one bucket is granted and `_PUBLIC_ENDPOINT_URL` when the instance is public. `PREFIX` defaults to `S3`; `AWS` gives the names the AWS SDKs read on their own. Static projects cannot use storage.',
						'',
						'Always use path-style addressing (`forcePathStyle: true` in the AWS JS SDK, `addressing_style: "path"` in boto3); virtual-hosted bucket URLs do not resolve.',
						'',
						'Each attachment grants `read` or `read-write` per bucket. A private instance is reachable only from apps on its node, so a project attached to one is placed there at deploy time; a public instance (`https://<name>--s3.<domain>`) works from any node and from browsers (presigned URLs). A `public-read` bucket serves objects without a signature.',
						'',
						'Keys are never returned over MCP: apps get them injected, and humans can reveal the root key from the dashboard or `skif storage credentials`. For a client outside Skiff (a backup tool, a CDN), `create_storage_key` makes a named key scoped to some buckets; a human reveals its secret with `skif storage keys reveal`. `list_storage_keys` and `revoke_storage_key` manage them.',
						'',
						'`delete_storage` is a confirmed soft delete (restorable for the trash period, 7 days by default) and is refused while projects are attached; `detach_storage` first. Deleting non-empty buckets and permanent deletion are dashboard/CLI only.',
					].join('\n'),
				},
			],
		}),
	);

	if (featureEnabled(core.ctx.config, 'EMAIL'))
		server.registerResource(
			'email',
			'skiff://guides/email',
			{ title: 'Email', mimeType: 'text/markdown' },
			async (uri) => ({
				contents: [
					{
						uri: uri.href,
						text: [
							'# Email',
							'',
							"Skiff sends mail through its own MTA on one mail node, which a platform admin chooses in Settings → Email. `get_email_status` says whether that is done, the org's state (sandbox, active, paused) and its limits.",
							'',
							'1. `create_email_domain` adds a sending domain and its DKIM key. `get_email_domain` lists the DKIM, SPF and DMARC records with what DNS returned; relay its `nextSteps` to the user. When the platform manages the zone in Cloudflare, Skiff creates the records itself.',
							'2. `check_email_domain` re-checks DNS. The domain is verified once DKIM is found, and only verified domains can send.',
							'3. `send_email` sends one message (text and/or html, at most 50 recipients). The user confirms every message. The result is a message id; `get_email_message` shows each recipient\'s delivery status and the last SMTP response.',
							'',
							'Apps send through SMTP or the REST API with credentials injected at activation (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_URL`, via `POST /api/v1/projects/:slug/email`). Credentials are never created or shown over MCP.',
							'',
							'New orgs start in the sandbox: low limits, their own verified domains and verified sandbox recipients only. To test with an inbox the user can read, `add_email_address` (confirmed) emails it a link its owner must click. Leaving the sandbox is a production access request an org owner or admin sends from the dashboard (Email → Sandbox) or `skif email request-access`; a platform admin decides. Hard bounces and complaints add addresses to the suppression list (`list_email_suppressions`), and suppressed recipients are dropped. High bounce or complaint rates pause the org. Only use `remove_email_suppression` (confirmed) when the user says the address is fixed.',
						].join('\n'),
					},
				],
			}),
		);

	// --- pipelines (docs/PIPELINES.md §8): declared in ./mcp-pipelines --------------
	for (const spec of pipelineTools(principal))
		tool(spec.name, { ...spec.config, scopeChallenge: requires(...spec.permissions) } as never, (async (args: Record<string, unknown>) =>
			run(() => spec.handler(args))) as never);

	tool(
		'get_usage',
		{
			title: 'Get usage',
			description:
				'Show org usage (or one project with `project`): counts, actual database/storage bytes, ' +
				'30-day egress, builds and jobs today, and the percentage of each quota in use. Read-only.',
			inputSchema: z.object({
				project: z.string().optional().describe('Project slug; omit for the whole org'),
			}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('project:read'),
		},
		async ({ project }) =>
			run(() => core.usage.view(principal, project ? { projectSlug: project } : {})),
	);

	tool(
		'get_quotas',
		{
			title: 'Get quotas',
			description:
				'Show the effective org quotas, or one project’s org base, overrides and effective limits ' +
				'with `project`. Read-only; only a platform admin can change quotas.',
			inputSchema: z.object({
				project: z.string().optional().describe('Project slug; omit for the org quota'),
			}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('project:read'),
		},
		async ({ project }) =>
			run(() => core.usage.quotas(principal, project ? { projectSlug: project } : {})),
	);

	return server;
}

/**
 * The dashboard assistant's tool catalog: every MCP tool, captured from the same registration
 * code. Handlers audit as `assistant.<tool>` so the audit log distinguishes a chat action from a
 * remote MCP client. Destructive tools run directly here because the chat UI confirms them first.
 */
export function skiffToolDefinitions(principal: Principal): SkiffToolDefinition[] {
	const sink: SkiffToolDefinition[] = [];
	buildServer(principal, 'assistant', sink, 'assistant');
	return sink;
}

export const mcpHandler = createMcpHandler(
	({ authInfo, era }) => buildServer(principalFor(authInfo), era),
	{
		legacy: 'stateless',
		onerror: (error) => console.error('[mcp]', error),
	},
);

export { effectivePermissions, type Role };
