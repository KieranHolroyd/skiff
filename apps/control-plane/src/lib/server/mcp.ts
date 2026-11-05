import { createHmac, timingSafeEqual } from 'node:crypto';
import {
	McpServer,
	acceptedContent,
	createMcpHandler,
	inputRequired,
	isInputRequiredResult,
	type AuthInfo,
	type ScopeChallengeHandler,
} from '@modelcontextprotocol/server';
import * as z from 'zod';
import {
	backupTargetCreateSchema,
	appVolumeAttachSchema,
	appVolumeDetachSchema,
	bucketCreateSchema,
	bucketUpdateSchema,
	bucketNameSchema,
	databaseAttachSchema,
	databaseBackupCreateSchema,
	databaseBackupPolicySchema,
	databaseCreateSchema,
	databaseRestartSchema,
	databaseRestoreSchema,
	databaseRotateSchema,
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
	storageCreateSchema,
	storageObjectKeySchema,
	workloadSpecSchema,
	type DatabaseMetricPoint,
	type DatabaseView,
	type StorageGrant,
	type StorageMetricPoint,
	type StorageView,
	type OperationView,
	type Permission,
	type Principal,
	type Role,
} from '@skiff/contracts';
import { authSecret } from './config';
import { core } from './core';
import { principalFromMcp } from './principal';

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

/** Inline file contents can be megabytes: keep paths and sizes, never bodies, in the audit log. */
function summarizeArgs(input: unknown): unknown {
	if (!input || typeof input !== 'object') return input;
	const out: Record<string, unknown> = { ...(input as Record<string, unknown>) };
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

	/** `server.registerTool` with auditing of every call, including scope denials. */
	const tool = ((name: string, config: Record<string, unknown>, callback: (...args: unknown[]) => unknown) => {
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
	}) as unknown as McpServer['registerTool'];

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
				'Soft-delete a project (stops serving immediately; restorable for 7 days). Requires confirmation.',
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
						restoreBefore: new Date(Date.now() + limits.trashDays * 86_400_000).toISOString(),
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
							message: `Delete project "${project}"? It stops serving immediately and can be restored for 7 days.`,
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
					restoreBefore: new Date(Date.now() + limits.trashDays * 86_400_000).toISOString(),
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
				`Soft-delete up to ${operationLimits.mcpTargets} projects at once (each stops serving immediately; restorable for 7 days with restore_projects). ` +
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
						restoreBefore: new Date(Date.now() + limits.trashDays * 86_400_000).toISOString()
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
							restoreBefore: new Date(Date.now() + limits.trashDays * 86_400_000).toISOString(),
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
				'They stop serving immediately and can be restored for 7 days.',
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
		'set_workload',
		{
			title: 'Set workload',
			description:
				'Set the runtime spec for a process/container project. Secrets are references only; values never leave the platform.',
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

	// --- managed databases (docs/DATABASES.md; no credentials or purge over MCP, D58/D53) ----
	const connectionNote =
		'Attached apps get <PREFIX>_URL, _HOST, _PORT, _USER, _PASSWORD and _NAME injected at activation (PREFIX defaults to DATABASE), ' +
		"so read DATABASE_URL from the environment; never hard-code credentials. An app must run on the database's node: " +
		"placement `auto` handles that, an explicit placement on another node is rejected.";

	tool(
		'list_databases',
		{
			title: 'List databases',
			description: 'List managed Postgres databases in the org with status, node, size and attached projects.',
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
				'Return recent Postgres container log lines for a managed database (the agent drains the unit journal). ' +
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
				'Create a managed Postgres database (v16 or v17, default 17). Pass `project` to attach it in the same call; ' +
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
				'List logical backups for one database with size, checksum, age and whether a restore has been verified. ' +
				'Artifacts live in the platform object store; no credentials are returned.',
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
				'Queue an on-demand `pg_dump -Fc` backup. The node streams it to the platform object store; follow it with ' +
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
				'runs `pg_restore` then a verification query. Requires a completed backup from list_database_backups.',
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

	tool(
		'attach_database',
		{
			title: 'Attach database',
			description:
				`Connect a database to a process or container project. ${connectionNote} ` +
				'Attaching re-activates (restarts) a running app; no redeploy is needed if it already runs on the database node.',
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
				'Soft-delete a database: its container stops, the data stays on the node and it can be restored for 7 days. ' +
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
								`"${view.nodeName ?? view.nodeId}" and it can be restored for 7 days.`,
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
				'restored for 7 days. Refused while projects are attached (detach_storage first). Requires confirmation. ' +
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
								`the data stays on node "${view.nodeName ?? view.nodeId}" and it can be restored for 7 days.`,
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

	// --- access -------------------------------------------------------------
	tool(
		'set_access',
		{
			title: 'Set access mode',
			description: 'Set public/password/platform access for production or previews.',
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
				'Aggregated request metrics for your org\'s projects from DuckDB (1m or 1h buckets), optionally filtered by project or host.',
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
				if (!core.ctx.telemetry?.available)
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

	tool(
		'get_audit_log',
		{
			title: 'Get audit log',
			description: 'Recent audit entries for the org: user, MCP client, tool, args (secrets redacted), result.',
			inputSchema: z.object({
				limit: z.number().int().min(1).max(200).default(50),
				action: z.string().optional(),
				resource: z.string().optional(),
			}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			scopeChallenge: requires('project:read'),
		},
		async ({ limit, action, resource }) =>
			run(() => ({
				entries: core.audit.list({ principal, limit, action, resource }),
			})),
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
						`- Retained deployments per project: ${limits.retainedDeployments} (plus pinned)`,
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
						'Skiff runs managed PostgreSQL (16 or 17) as an org resource on one node. Create one with `create_database`; pass `project` to attach it to an app in the same call.',
						'',
						'An attached process or container project receives `<PREFIX>_URL`, `_HOST`, `_PORT`, `_USER`, `_PASSWORD` and `_NAME` at activation (`PREFIX` defaults to `DATABASE`, so read `DATABASE_URL`). Use a different prefix per database when a project has several. Static projects cannot use databases.',
						'',
						"Apps and their databases share a node in v1. A project with attachments is placed on the database's node at deploy time, so `auto` placement just works; an explicit placement on another node is rejected. If `attach_database` warns that the app runs elsewhere, redeploy it.",
						'',
						'Credentials are never returned over MCP: apps get them injected, and humans can reveal them from the dashboard or `skif db credentials`.',
						'',
						'`get_database` shows status, the largest tables and a last-hour summary (size vs storage budget, connections vs max_connections, commits/min, cache hit ratio).',
						'',
						'`delete_database` is a confirmed soft delete (restorable for 7 days) and is refused while projects are attached; `detach_database` first. Permanent deletion is dashboard/CLI only.',
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
						'Keys are never returned over MCP: apps get them injected, and humans can reveal the root key from the dashboard or `skif storage credentials`.',
						'',
						'`delete_storage` is a confirmed soft delete (restorable for 7 days) and is refused while projects are attached; `detach_storage` first. Deleting non-empty buckets and permanent deletion are dashboard/CLI only.',
					].join('\n'),
				},
			],
		}),
	);

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
