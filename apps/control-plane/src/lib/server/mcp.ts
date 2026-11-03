import {
	McpServer,
	acceptedContent,
	createMcpHandler,
	inputRequired,
	type AuthInfo,
	type ScopeChallengeHandler,
} from '@modelcontextprotocol/server';
import * as z from 'zod';
import {
	deployFilesSchema,
	deploySiteSchema,
	effectivePermissions,
	limits,
	projectCreateSchema,
	projectUpdateSchema,
	setAccessSchema,
	shareLinkCreateSchema,
	type Permission,
	type Principal,
	type Role,
} from '@skiff/contracts';
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

function buildServer(principal: Principal, era: 'legacy' | 'modern') {
	const server = new McpServer({ name: 'skiff', version: '0.1.0' });

	server.registerTool(
		'whoami',
		{
			title: 'Who am I',
			description: 'Show the authenticated user, MCP client and effective Skiff permissions.',
			annotations: { readOnlyHint: true, idempotentHint: true },
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
	server.registerTool(
		'list_projects',
		{
			title: 'List projects',
			description: 'List projects you can access, with their production and preview URLs.',
			annotations: { readOnlyHint: true, idempotentHint: true },
			scopeChallenge: requires('project:read'),
		},
		async () => run(() => ({ projects: core.projects.list(principal) })),
	);

	server.registerTool(
		'get_project',
		{
			title: 'Get project',
			description: 'Get one project by slug, including access modes and deployment counts.',
			inputSchema: z.object({ project: z.string().describe('Project slug') }),
			annotations: { readOnlyHint: true, idempotentHint: true },
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

	server.registerTool(
		'create_project',
		{
			title: 'Create project',
			description: 'Create a project. Slugs are globally unique; collisions return suggestions.',
			inputSchema: projectCreateSchema,
			annotations: { idempotentHint: false },
			scopeChallenge: requires('project:create'),
		},
		async (input) => run(() => core.projects.create(principal, input)),
	);

	server.registerTool(
		'update_project',
		{
			title: 'Update project',
			description: 'Rename, re-place or change access modes for a project.',
			inputSchema: projectUpdateSchema.extend({ project: z.string(), slug: z.string().optional() }),
			annotations: { idempotentHint: true },
			scopeChallenge: requires('project:update'),
		},
		async ({ project, ...input }) => run(() => core.projects.update(principal, project, input)),
	);

	server.registerTool(
		'delete_project',
		{
			title: 'Delete project',
			description:
				'Soft-delete a project (stops serving immediately; restorable for 7 days). Requires confirmation.',
			inputSchema: z.object({ project: z.string().describe('Project slug') }),
			annotations: { destructiveHint: true, idempotentHint: true },
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
			const answer = acceptedContent(ctx.mcpReq.inputResponses, key, schema);
			const responded = ctx.mcpReq.inputResponses?.[key] !== undefined;
			if (responded && answer?.confirm !== true)
				return text(`Cancelled: "${project}" was not deleted (the user did not confirm).`);
			if (answer?.confirm !== true) {
				return inputRequired({
					inputRequests: {
						[key]: inputRequired.elicit({
							message: `Delete project "${project}"? It stops serving immediately and can be restored for 7 days.`,
							requestedSchema: schema,
						}),
					},
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

	// --- deploying ----------------------------------------------------------
	server.registerTool(
		'deploy_site',
		{
			title: 'Deploy a site',
			description:
				'One-shot deploy: creates the project if missing, then deploys inline files (≤5 MB) or a finalized upload. Promotes to production by default.',
			inputSchema: deploySiteSchema,
			annotations: { destructiveHint: false, idempotentHint: false },
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

	server.registerTool(
		'deploy_files',
		{
			title: 'Deploy files',
			description: 'Deploy inline files (≤5 MB total) to an existing project.',
			inputSchema: deployFilesSchema,
			annotations: { idempotentHint: false },
			scopeChallenge: requires('deployment:create'),
		},
		async (input) => run(() => core.deploy.deployFiles(principal, input)),
	);

	server.registerTool(
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
			annotations: { idempotentHint: false },
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

	server.registerTool(
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
			annotations: { idempotentHint: false },
			scopeChallenge: requires('deployment:create'),
		},
		async ({ project, uploadId, promote, message }) =>
			run(async () => {
				const row = core.projects.requireRow(principal, project);
				return core.uploads.finalize(principal, row, uploadId, { promote, message });
			}),
	);

	server.registerTool(
		'list_deployments',
		{
			title: 'List deployments',
			description: 'List deployments for a project, newest first, with preview URLs.',
			inputSchema: z.object({ project: z.string(), limit: z.number().int().min(1).max(200).default(20) }),
			annotations: { readOnlyHint: true, idempotentHint: true },
			scopeChallenge: requires('deployment:read'),
		},
		async ({ project, limit }) =>
			run(() => {
				const row = core.projects.requireRow(principal, project);
				return { deployments: core.deployments.list(principal, row, { limit }) };
			}),
	);

	server.registerTool(
		'get_deployment',
		{
			title: 'Get deployment',
			description: 'Get one deployment by id or short id.',
			inputSchema: z.object({ project: z.string(), deployment: z.string() }),
			annotations: { readOnlyHint: true, idempotentHint: true },
			scopeChallenge: requires('deployment:read'),
		},
		async ({ project, deployment }) =>
			run(() => core.deployments.get(principal, core.projects.requireRow(principal, project), deployment)),
	);

	server.registerTool(
		'promote_deployment',
		{
			title: 'Promote deployment',
			description: 'Point production at an existing deployment. Instant; no rebuild.',
			inputSchema: z.object({ project: z.string(), deployment: z.string() }),
			annotations: { idempotentHint: true },
			scopeChallenge: requires('deployment:promote'),
		},
		async ({ project, deployment }) =>
			run(() => core.deployments.promote(principal, core.projects.requireRow(principal, project), deployment)),
	);

	server.registerTool(
		'rollback',
		{
			title: 'Roll back production',
			description: 'Point production at the previous deployment (code and config together).',
			inputSchema: z.object({ project: z.string() }),
			annotations: { idempotentHint: true },
			scopeChallenge: requires('deployment:rollback'),
		},
		async ({ project }) => run(() => core.deployments.rollback(principal, core.projects.requireRow(principal, project))),
	);

	// --- access -------------------------------------------------------------
	server.registerTool(
		'set_access',
		{
			title: 'Set access mode',
			description: 'Set public/password/platform access for production or previews.',
			inputSchema: setAccessSchema.extend({ project: z.string() }),
			annotations: { idempotentHint: true },
			scopeChallenge: requires('project:update'),
		},
		async ({ project, ...input }) => run(() => core.projects.setAccess(principal, project, input)),
	);

	server.registerTool(
		'create_share_link',
		{
			title: 'Create share link',
			description: 'Create a time- and usage-limited link to a protected deployment.',
			inputSchema: shareLinkCreateSchema,
			annotations: { idempotentHint: false },
			scopeChallenge: requires('shareLink:create'),
		},
		async ({ project, ...input }) =>
			run(() => core.access.createShareLink(principal, core.projects.requireRow(principal, project), input)),
	);

	server.registerTool(
		'list_share_links',
		{
			title: 'List share links',
			description: 'List share links for a project, including redemption counts.',
			inputSchema: z.object({ project: z.string() }),
			annotations: { readOnlyHint: true, idempotentHint: true },
			scopeChallenge: requires('shareLink:read'),
		},
		async ({ project }) =>
			run(() => ({
				shareLinks: core.access.listShareLinks(principal, core.projects.requireRow(principal, project)),
			})),
	);

	server.registerTool(
		'revoke_share_link',
		{
			title: 'Revoke share link',
			description: 'Revoke a share link and every session it created. Takes effect within seconds.',
			inputSchema: z.object({ project: z.string(), shareLinkId: z.string() }),
			annotations: { destructiveHint: true, idempotentHint: true },
			scopeChallenge: requires('shareLink:revoke'),
		},
		async ({ project, shareLinkId }) =>
			run(async () => {
				await core.access.revokeShareLink(principal, core.projects.requireRow(principal, project), shareLinkId);
				return { ok: true, shareLinkId };
			}),
	);

	// --- observability ------------------------------------------------------
	server.registerTool(
		'get_status',
		{
			title: 'Get status',
			description: 'Fleet and platform summary: nodes, projects, deployments, storage.',
			annotations: { readOnlyHint: true, idempotentHint: true },
			scopeChallenge: requires('project:read'),
		},
		async () => run(() => core.metrics.status(principal)),
	);

	server.registerTool(
		'get_metrics',
		{
			title: 'Get traffic metrics',
			description: 'Aggregated request metrics from DuckDB (1m or 1h buckets), optionally filtered by host.',
			inputSchema: z.object({
				host: z.string().optional(),
				from: z.string().datetime().optional(),
				to: z.string().datetime().optional(),
				interval: z.enum(['1m', '1h']).default('1h'),
			}),
			annotations: { readOnlyHint: true, idempotentHint: true },
			scopeChallenge: requires('metrics:read'),
		},
		async ({ host, from, to, interval }) =>
			run(async () => {
				if (!core.ctx.telemetry?.available)
					return { points: [], note: 'Telemetry is not enabled on this install.' };
				const now = Date.now();
				return {
					points: await core.ctx.telemetry.query({
						host,
						from: from ? new Date(from) : new Date(now - 24 * 3600_000),
						to: to ? new Date(to) : new Date(now),
						interval,
					}),
				};
			}),
	);

	server.registerTool(
		'get_logs',
		{
			title: 'Get logs',
			description: 'Application logs for a project (tier 2+). Static sites have access logs in get_metrics instead.',
			inputSchema: z.object({ project: z.string(), since: z.string().datetime().optional() }),
			annotations: { readOnlyHint: true, idempotentHint: true },
			scopeChallenge: requires('logs:read'),
		},
		async ({ project, since }) =>
			run(() => {
				const row = core.projects.requireRow(principal, project);
				if (row.runtime === 'static')
					return {
						lines: [],
						note: 'Static deployments have no application logs. Use get_metrics for traffic and error rates.',
					};
				return { lines: [], note: `Log streaming for ${row.runtime} apps arrives with runtime tiers in v2.` };
			}),
	);

	server.registerTool(
		'get_audit_log',
		{
			title: 'Get audit log',
			description: 'Recent audit entries for the org: user, MCP client, tool, args (secrets redacted), result.',
			inputSchema: z.object({
				limit: z.number().int().min(1).max(200).default(50),
				action: z.string().optional(),
				resource: z.string().optional(),
			}),
			annotations: { readOnlyHint: true, idempotentHint: true },
			scopeChallenge: requires('project:read'),
		},
		async ({ limit, action, resource }) =>
			run(() => ({
				entries: core.audit.list({ orgId: principal.orgId, limit, action, resource }),
			})),
	);

	server.registerTool(
		'list_nodes',
		{
			title: 'List nodes',
			description: 'List fleet nodes (read-only). Requires a platform admin role.',
			annotations: { readOnlyHint: true, idempotentHint: true },
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
						'Every deployment gets an immutable preview URL `<slug>--<id>.<contentDomain>`. `promote_deployment` and `rollback` are instant because they only move the production pointer.',
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
