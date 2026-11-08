import type { RequestHandler } from './$types';
import * as z from 'zod';
import { MetricsExporter, PROMETHEUS_CONTENT_TYPE, ValidationError, parseAuditTime } from '@skiff/core';
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
	nodeUpdateSchema,
	serviceMoveSchema,
	logLevels,
	logSources,
	itemStatuses,
	itemVerdicts,
	operationApplySchema,
	operationCreateSchema,
	operationKinds,
	operationStatuses,
	flowStatuses,
	isFlowId,
	type FlowStatus,
	shareCreateSchema,
	shareUpdateSchema,
	shareGrantsSchema,
	shareMountCreateSchema,
	shareMountLinkSchema,
	storageOnboardingSchema,
	storageDefaultsSchema,
	diskAddSchema,
	diskUpdateSchema,
	type ItemStatus,
	type ItemVerdict,
	type OperationKind,
	type OperationStatus,
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
		if (segments[0] === 'metrics') {
			if (method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
			// Same renderer as `/metrics`, scoped to the caller's org (docs/METRICS.md).
			return new Response(await core.metricsExport.render(principal, MetricsExporter.scopeFromPath(segments.slice(1))), {
				headers: { 'content-type': PROMETHEUS_CONTENT_TYPE, 'cache-control': 'no-store' },
			});
		}

		// --- projects ---------------------------------------------------------
		if (segments[0] === 'projects') {
			if (segments.length === 1) {
				if (method === 'GET') {
					const trash = event.url.searchParams.get('trash');
					return { projects: core.projects.list(principal, { onlyDeleted: trash === '1' || trash === 'true' }) };
				}
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
			if (action === 'move' && method === 'POST') {
				const input = await readJson(request, serviceMoveSchema);
				return core.moves.moveApp(principal, slug, input);
			}
			if (action === 'function' && segments.length === 3) {
				if (method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
				const view = core.functions.view(principal, core.projects.requireRow(principal, slug));
				return view ?? json({ error: 'not_found' }, 404);
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

		// --- operations: mass actions and prune (docs/OPERATIONS.md) -------------
		if (segments[0] === 'operations') {
			const params = event.url.searchParams;
			const waitMs = Math.min(Math.max(Number(params.get('wait') ?? 0) || 0, 0), 25) * 1000;
			const settle = async (view: { id: string }) => (waitMs ? core.operations.wait(principal, view.id, waitMs) : view);
			if (segments.length === 1) {
				if (method === 'GET') {
					const kind = params.get('kind');
					const status = params.get('status');
					return {
						operations: core.operations.list(principal, {
							...(kind && (operationKinds as readonly string[]).includes(kind) ? { kind: kind as OperationKind } : {}),
							...(status && (operationStatuses as readonly string[]).includes(status) ? { status: status as OperationStatus } : {}),
							...(params.get('scope') === 'platform' ? { scope: 'platform' as const } : {}),
							...(Number(params.get('limit')) > 0 ? { limit: Number(params.get('limit')) } : {}),
						}),
					};
				}
				if (method === 'POST') {
					const input = await readJson(request, operationCreateSchema);
					const idempotencyKey = request.headers.get('idempotency-key')?.trim().slice(0, 128) || undefined;
					const operation = core.operations.create(principal, input, { idempotencyKey });
					return json(await settle(operation), 202);
				}
				return json({ error: 'method_not_allowed' }, 405);
			}
			if (segments.length === 2 && segments[1] === 'actions' && method === 'GET')
				return { actions: core.operations.actions(principal) };
			// Flows (docs/FLOWS.md §5): durable multi-step changes share this async-operation
			// contract. `flw_` ids answer `{ flow }`; `?wait=` holds until terminal; `?steps=1` adds
			// the step log; `POST …/cancel` cancels where the flow allows it.
			if (segments.length === 2 && segments[1] === 'flows' && method === 'GET') {
				const kind = params.get('kind');
				const status = params.get('status');
				const subjectKind = params.get('subjectKind');
				const subjectId = params.get('subjectId');
				return {
					flows: core.flows.list(principal, {
						...(kind ? { kind } : {}),
						...(status && (flowStatuses as readonly string[]).includes(status) ? { status: status as FlowStatus } : {}),
						...(subjectKind && subjectId ? { subject: { kind: subjectKind, id: subjectId } } : {}),
						...(Number(params.get('limit')) > 0 ? { limit: Number(params.get('limit')) } : {}),
					}),
				};
			}
			const id = segments[1]!;
			if (isFlowId(id)) {
				const steps = params.get('steps') === '1';
				if (segments.length === 2 && method === 'GET') {
					if (waitMs) await core.flows.wait(principal, id, waitMs);
					return { flow: core.flows.get(principal, id, { steps }) };
				}
				if (segments.length === 3 && segments[2] === 'cancel' && method === 'POST')
					return { flow: core.flows.cancel(principal, id) };
				return json({ error: 'not_found' }, 404);
			}
			if (segments.length === 2 && method === 'GET') {
				const operation = await settle(core.operations.get(principal, id));
				if (!params.get('items')) return { operation };
				const status = params.get('status');
				const verdict = params.get('verdict');
				return {
					operation,
					...core.operations.items(principal, id, {
						...(Number(params.get('after')) > 0 ? { after: Number(params.get('after')) } : {}),
						...(Number(params.get('limit')) > 0 ? { limit: Number(params.get('limit')) } : {}),
						...(status && (itemStatuses as readonly string[]).includes(status) ? { status: status as ItemStatus } : {}),
						...(verdict && (itemVerdicts as readonly string[]).includes(verdict) ? { verdict: verdict as ItemVerdict } : {}),
						...(params.get('category') ? { category: params.get('category')! } : {}),
					}),
				};
			}
			if (segments.length === 3 && segments[2] === 'apply' && method === 'POST') {
				const input = operationApplySchema.parse(await request.json().catch(() => ({})));
				return settle(core.operations.apply(principal, id, input));
			}
			if (segments.length === 3 && segments[2] === 'cancel' && method === 'POST')
				return core.operations.cancel(principal, id);
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

		// --- disks and default storage (platform admin; docs/STORAGE.md, D169) ---------------
		// Under /platform/storage: /storage is object storage.
		if (segments[0] === 'platform' && segments[1] === 'storage') {
			const sub = segments.slice(1);
			if (sub.length === 1) {
				if (method === 'GET') return core.disks.overview(principal);
				return json({ error: 'method_not_allowed' }, 405);
			}
			if (sub[1] === 'disks') {
				if (sub.length === 2) {
					if (method === 'POST') return json(core.disks.add(principal, await readJson(request, diskAddSchema)), 201);
					return json({ error: 'method_not_allowed' }, 405);
				}
				if (sub.length === 4 && sub[3] === 'profile') {
					if (method === 'POST') return json(core.disks.profile(principal, sub[2]!), 202);
					return json({ error: 'method_not_allowed' }, 405);
				}
				if (sub.length === 3) {
					if (method === 'PATCH') return core.disks.update(principal, sub[2]!, await readJson(request, diskUpdateSchema));
					if (method === 'DELETE') return core.disks.remove(principal, sub[2]!);
					return json({ error: 'method_not_allowed' }, 405);
				}
			}
			if (sub[1] === 'defaults' && sub.length === 2) {
				if (method === 'PUT') return { defaults: core.disks.setDefaults(principal, await readJson(request, storageDefaultsSchema)) };
				return json({ error: 'method_not_allowed' }, 405);
			}
			if (sub[1] === 'onboarding' && sub.length === 2) {
				if (method === 'POST') return core.disks.setOnboarding(principal, await readJson(request, storageOnboardingSchema));
				return json({ error: 'method_not_allowed' }, 405);
			}
			return json({ error: 'not_found' }, 404);
		}

		// --- cluster shares (platform admin; CLUSTERING §5.2, C3) ----------------
		if (segments[0] === 'shares') {
			if (segments.length === 1) {
				if (method === 'GET') return { shares: core.shares.list(principal) };
				if (method === 'POST') return json(core.shares.create(principal, await readJson(request, shareCreateSchema)), 201);
				return json({ error: 'method_not_allowed' }, 405);
			}
			const name = segments[1]!;
			if (segments.length === 2) {
				if (method === 'GET') return core.shares.get(principal, name);
				if (method === 'PATCH' || method === 'PUT')
					return core.shares.update(principal, name, await readJson(request, shareUpdateSchema));
				if (method === 'DELETE') return core.shares.remove(principal, name);
				return json({ error: 'method_not_allowed' }, 405);
			}
			if (segments.length === 3 && segments[2] === 'grants' && method === 'PUT')
				return core.shares.setGrants(principal, name, await readJson(request, shareGrantsSchema));
			// Mounts (docs/STORAGE.md §3, D143): POST /shares/:name/mounts, DELETE /shares/:name/mounts/:node,
			// PUT|DELETE /shares/:name/mounts/:node/disk to use the mount as a disk or stop using it as one.
			if (segments[2] === 'mounts') {
				if (segments.length === 3) {
					if (method === 'POST')
						return json(core.shares.mount(principal, name, await readJson(request, shareMountCreateSchema)), 201);
					return json({ error: 'method_not_allowed' }, 405);
				}
				const node = segments[3]!;
				if (segments.length === 4) {
					if (method === 'DELETE') return core.shares.unmount(principal, name, node);
					return json({ error: 'method_not_allowed' }, 405);
				}
				if (segments.length === 5 && segments[4] === 'disk') {
					if (method === 'PUT') return core.shares.link(principal, name, node, await readJson(request, shareMountLinkSchema));
					if (method === 'DELETE') return core.shares.unlink(principal, name, node);
					return json({ error: 'method_not_allowed' }, 405);
				}
			}
			return json({ error: 'not_found' }, 404);
		}

		// --- topology (platform admin; CLUSTERING §3.6, C0) --------------------
		if (segments[0] === 'topology') {
			if (method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
			if (segments.length === 1) return core.topology.view(principal);
			if (segments.length === 2 && segments[1] === 'blast-radius') {
				const node = event.url.searchParams.get('node');
				const zone = event.url.searchParams.get('zone');
				if (!node && !zone)
					return json({ error: 'validation', message: 'Pass ?node=<id> or ?zone=<name>.' }, 422);
				return core.topology.blastRadius(principal, node ? { kind: 'node', id: node } : { kind: 'zone', id: zone! });
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
			if (segments.length === 2 && method === 'PATCH')
				return core.nodes.update(principal, nodeId, await readJson(request, nodeUpdateSchema));
			if (segments.length === 2 && method === 'DELETE') return core.nodes.remove(principal, nodeId);
			if (segments[2] === 'drain' && method === 'POST')
				return core.nodes.setDraining(principal, nodeId, true);
			if (segments[2] === 'resume' && method === 'POST')
				return core.nodes.setDraining(principal, nodeId, false);
			if (segments[2] === 'rotate-token' && method === 'POST')
				return core.nodes.rotateToken(principal, nodeId);
			if (segments[2] === 'edge' && method === 'POST') return core.nodes.setEdge(principal, nodeId);
			return json({ error: 'not_found' }, 404);
		}

		// --- audit ------------------------------------------------------------
		if (segments[0] === 'audit' && segments.length === 1) {
			if (method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
			// `from`/`to`: epoch ms, ISO 8601 or a date (a date as `to` covers that whole day, UTC).
			// `cursor`: the previous answer's `nextCursor`, for the next (older) page.
			const query = event.url.searchParams;
			const rawLimit = Number(query.get('limit') ?? 50);
			const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 50;
			return core.audit.page({
				principal,
				limit,
				action: query.get('action') || undefined,
				resource: query.get('resource') || undefined,
				from: parseAuditTime(query.get('from'), 'from'),
				to: parseAuditTime(query.get('to'), 'to'),
				cursor: query.get('cursor') || null,
			});
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
