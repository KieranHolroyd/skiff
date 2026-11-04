import type { RequestHandler } from './$types';
import * as z from 'zod';
import { ValidationError } from '@skiff/core';
import {
	projectCreateSchema,
	projectUpdateSchema,
	setAccessSchema,
	shareLinkCreateSchema,
	deployFilesSchema,
	promoteSchema,
	createUploadSchema,
	finalizeUploadSchema,
	domainCreateSchema,
	logLevels,
	logSources,
	type LogLevel,
	type LogSource,
} from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** The URL names the project/upload; a body may repeat it but must not contradict it. */
const projectDeploySchema = deployFilesSchema.partial({ project: true });
const finalizeByIdSchema = finalizeUploadSchema.partial({ uploadId: true });
const pinSchema = z.object({ pinned: z.boolean().default(true) });

/**
 * Skiff REST API v1. Every endpoint calls the same service layer as the dashboard, MCP and CLI
 * (DESIGN §3.2), so permission checks cannot drift between surfaces.
 */
const api: RequestHandler = async (event) => {
	const { request } = event;
	const method = request.method;
	const segments = event.params.path.split('/').filter(Boolean);
	return route(async () => {
		const principal = requirePrincipal(event);
		// --- session / status -------------------------------------------------
		if (segments.length === 0 || (segments.length === 1 && segments[0] === 'whoami')) {
			if (method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
			return {
				user: { id: principal.userId, role: principal.role, orgId: principal.orgId, kind: principal.kind },
				permissions: [...principal.permissions].sort(),
				platform: core.ctx.config.platformOrigin,
				contentDomain: core.ctx.config.contentDomain,
			};
		}

		if (segments[0] === 'status' && segments.length === 1) {
			if (method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
			return core.metrics.status(principal);
		}

		// --- metrics ----------------------------------------------------------
		if (segments[0] === 'metrics' && segments.length === 1) {
			if (method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
			return new Response(await core.metrics.prometheus(), {
				headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' },
			});
		}

		// --- projects ---------------------------------------------------------
		if (segments[0] === 'projects') {
			if (segments.length === 1) {
				if (method === 'GET') return { projects: core.projects.list(principal) };
				if (method === 'POST') {
					const input = await readJson(request, projectCreateSchema);
					return json(await core.projects.create(principal, input), 201);
				}
				return json({ error: 'method_not_allowed' }, 405);
			}

			const slug = segments[1]!;
			if (segments.length === 2) {
				if (method === 'GET') return core.projects.get(principal, slug);
				if (method === 'PATCH' || method === 'PUT') {
					const input = await readJson(request, projectUpdateSchema.extend({ slug: projectCreateSchema.shape.slug.optional() }));
					return core.projects.update(principal, slug, input);
				}
				if (method === 'DELETE') {
					await core.projects.softDelete(principal, slug);
					return json({ ok: true, restorable: true, purgeAfterDays: 7 });
				}
				return json({ error: 'method_not_allowed' }, 405);
			}

			const action = segments[2]!;
			if (action === 'restore' && method === 'POST') return core.projects.restore(principal, slug);
			if (action === 'access' && method === 'POST') {
				const input = await readJson(request, setAccessSchema);
				return core.projects.setAccess(principal, slug, input);
			}
			if (action === 'deploy' && method === 'POST') {
				const input = await readJson(request, projectDeploySchema);
				if (input.project && input.project !== slug)
					throw new ValidationError(`Body names project "${input.project}" but the URL names "${slug}".`);
				return core.deploy.deployFiles(principal, { ...input, project: slug });
			}
			if (action === 'promote' && method === 'POST') {
				const input = await readJson(request, promoteSchema);
				return core.deployments.promote(principal, core.projects.requireRow(principal, slug), input.deploymentId);
			}
			if (action === 'rollback' && method === 'POST') {
				return core.deployments.rollback(principal, core.projects.requireRow(principal, slug));
			}
			if (action === 'logs' && method === 'GET') {
				const project = core.projects.requireRow(principal, slug);
				const params = event.url.searchParams;
				const afterRaw = Number(params.get('after') ?? '');
				const limitRaw = Number(params.get('limit') ?? '');
				const source = params.get('source');
				const level = params.get('level');
				const result = core.logs.query(principal, project, {
					...(Number.isFinite(afterRaw) && afterRaw >= 0 ? { after: Math.floor(afterRaw) } : {}),
					...(Number.isFinite(limitRaw) && limitRaw > 0 ? { limit: Math.floor(limitRaw) } : {}),
					...(source && (logSources as readonly string[]).includes(source)
						? { source: source as LogSource }
						: {}),
					...(level && (logLevels as readonly string[]).includes(level)
						? { level: level as LogLevel }
						: {}),
					...(params.get('buildId') ? { buildId: params.get('buildId')! } : {}),
					...(params.get('deploymentId') ? { deploymentId: params.get('deploymentId')! } : {}),
					...(params.get('q') ? { q: params.get('q')! } : {}),
				});
				return {
					lines: result.events.map((item) => ({
						timestamp: new Date(item.ts).toISOString(),
						level: item.level,
						stream: item.stream,
						source: item.source,
						message: item.message,
					})),
					events: result.events,
					cursor: result.cursor,
					hasMore: result.hasMore,
					note:
						project.runtime === 'static' && result.events.length === 0
							? 'Static deployments have no application logs. Build logs appear here when a git build runs.'
							: undefined,
				};
			}
			if (action === 'deployments') {
				const project = core.projects.requireRow(principal, slug);
				if (segments.length === 3 && method === 'GET') {
					const limit = Number(event.url.searchParams.get('limit') ?? 50);
					return { deployments: core.deployments.list(principal, project, { limit }) };
				}
				const deploymentId = segments[3]!;
				if (segments.length === 4) {
					if (method === 'GET') return core.deployments.get(principal, project, deploymentId);
					if (method === 'DELETE') {
						await core.deployments.delete(principal, project, deploymentId);
						return { ok: true };
					}
				}
				if (segments[4] === 'pin' && method === 'POST') {
					const { pinned } = pinSchema.parse(await request.json().catch(() => ({})));
					return core.deployments.setPinned(principal, project, deploymentId, pinned);
				}
				return json({ error: 'not_found' }, 404);
			}
			if (action === 'shares') {
				const project = core.projects.requireRow(principal, slug);
				if (segments.length === 3 && method === 'GET') return { shareLinks: core.access.listShareLinks(principal, project) };
				if (segments.length === 3 && method === 'POST') {
					const input = await readJson(request, shareLinkCreateSchema.omit({ project: true }));
					return json(await core.access.createShareLink(principal, project, input), 201);
				}
				if (segments.length === 4 && method === 'DELETE') {
					await core.access.revokeShareLink(principal, project, segments[3]!);
					return { ok: true };
				}
			}
			return json({ error: 'not_found' }, 404);
		}

		// --- uploads ----------------------------------------------------------
		if (segments[0] === 'uploads') {
			if (segments.length === 1 && method === 'POST') {
				const input = await readJson(request, createUploadSchema);
				const project = core.projects.requireRow(principal, input.project);
				return json(await core.uploads.create(principal, project, input), 201);
			}
			if (segments.length === 3 && segments[2] === 'finalize' && method === 'POST') {
				const uploadId = segments[1]!;
				const input = await readJson(request, finalizeByIdSchema);
				if (input.uploadId && input.uploadId !== uploadId)
					throw new ValidationError(`Body names upload "${input.uploadId}" but the URL names "${uploadId}".`);
				const project = core.projects.requireRow(principal, input.project);
				return core.uploads.finalize(principal, project, uploadId, {
					promote: input.promote,
					message: input.message,
				});
			}
			return json({ error: 'not_found' }, 404);
		}

		// --- nodes (platform admin) -------------------------------------------
		if (segments[0] === 'nodes') {
			if (segments.length === 1 && method === 'GET') return { nodes: core.nodes.list(principal) };
			if (segments.length === 2 && segments[1] === 'join-token' && method === 'POST') {
				const body = (await request.json().catch(() => ({}))) as { name?: string };
				return json(core.nodes.createJoinToken(principal, body.name), 201);
			}
			const nodeId = segments[1]!;
			if (segments[2] === 'drain' && method === 'POST')
				return core.nodes.setDraining(principal, nodeId, true);
			if (segments[2] === 'resume' && method === 'POST')
				return core.nodes.setDraining(principal, nodeId, false);
			if (segments[2] === 'rotate-token' && method === 'POST')
				return core.nodes.rotateToken(principal, nodeId);
			return json({ error: 'not_found' }, 404);
		}

		// --- audit ------------------------------------------------------------
		if (segments[0] === 'audit' && segments.length === 1) {
			if (method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
			const rawLimit = Number(event.url.searchParams.get('limit') ?? 50);
			const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 50;
			return {
				entries: core.audit.list({
					principal,
					limit,
					action: event.url.searchParams.get('action') ?? undefined,
					resource: event.url.searchParams.get('resource') ?? undefined,
				}),
			};
		}

		// --- secrets (metadata only; values never leave the platform) ---------
		if (segments[0] === 'secrets') {
			if (segments.length === 1) {
				if (method === 'GET') return { secrets: core.secrets.list(principal) };
				if (method === 'POST') {
					const body = (await request.json().catch(() => ({}))) as {
						name?: string;
						value?: string;
						projectId?: string | null;
						type?: 'secret' | 'env';
					};
					if (!body.name || body.value === undefined) return json({ error: 'validation', message: 'name and value are required' }, 422);
					return json(
						await core.secrets.set(principal, {
							name: body.name,
							value: body.value,
							projectId: body.projectId ?? null,
							type: body.type,
						}),
						201,
					);
				}
			}
			if (segments.length === 2 && method === 'DELETE') {
				await core.secrets.delete(principal, segments[1]!);
				return { ok: true };
			}
			return json({ error: 'not_found' }, 404);
		}

		// --- domains (v2 table; verification is deferred, D31) ----------------
		if (segments[0] === 'domains' && method === 'POST') {
			await readJson(request, domainCreateSchema);
			return json({ error: 'not_implemented', message: 'Custom domains arrive in v2.' }, 501);
		}

		return json({ error: 'not_found', path: segments.join('/') }, 404);
	});
};

export const GET = api;
export const POST = api;
export const PATCH = api;
export const PUT = api;
export const DELETE = api;
