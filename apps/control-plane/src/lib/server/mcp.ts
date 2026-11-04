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
	workloadSpecSchema,
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
function auditTool(principal: Principal, tool: string, input: unknown, error?: string): void {
	try {
		const project = (input as { project?: unknown; name?: unknown } | undefined)?.project;
		core.audit.record({
			principal,
			action: `mcp.${tool}`,
			resource: 'mcp',
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

function buildServer(principal: Principal, era: 'legacy' | 'modern') {
	const server = new McpServer({ name: 'skiff', version: '0.1.0' });

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
				);
				return result;
			} catch (error) {
				auditTool(principal, name, input, (error as Error).message ?? String(error));
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

	return server;
}

export const mcpHandler = createMcpHandler(
	({ authInfo, era }) => buildServer(principalFor(authInfo), era),
	{
		legacy: 'stateless',
		onerror: (error) => console.error('[mcp]', error),
	},
);

export { effectivePermissions, type Role };
