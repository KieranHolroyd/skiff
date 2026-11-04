import { describe, expect, test } from 'bun:test';
import { ApiClient } from './api.ts';
import { ApiError } from './errors.ts';

const token = 'sk_test_123';

async function withServer<T>(
	handler: (request: Request) => Response | Promise<Response>,
	run: (server: ReturnType<typeof Bun.serve>) => Promise<T>,
): Promise<T> {
	const server = Bun.serve({ port: 0, fetch: handler });
	try {
		return await run(server);
	} finally {
		server.stop(true);
	}
}

function baseUrl(server: ReturnType<typeof Bun.serve>): string {
	return `http://127.0.0.1:${server.port}`;
}

describe('ApiClient', () => {
	test('sends bearer + origin headers and normalizes whoami', async () => {
		let seen: { url: string; authorization: string | null; origin: string | null } | undefined;
		await withServer(
			(request) => {
				seen = {
					url: request.url,
					authorization: request.headers.get('authorization'),
					origin: request.headers.get('origin'),
				};
				return Response.json({
					user: { id: 'usr_1', role: 'owner', orgId: 'org_1', kind: 'apiKey' },
					permissions: ['project:read', 'deployment:create'],
					platform: 'https://control.example.com',
					contentDomain: 'example.com',
				});
			},
			async (server) => {
				const client = new ApiClient({ baseUrl: baseUrl(server), token });
				const who = await client.whoami();
				expect(who.user).toEqual({
					id: 'usr_1',
					email: undefined,
					name: undefined,
				});
				expect(who.org).toEqual({
					id: 'org_1',
					slug: undefined,
					name: undefined,
					role: 'owner',
				});
				expect(who.permissions).toEqual(['project:read', 'deployment:create']);
				expect(who.platform).toBe('https://control.example.com');
				expect(who.contentDomain).toBe('example.com');
				expect(seen?.url).toBe(`${baseUrl(server)}/api/v1/whoami`);
				expect(seen?.authorization).toBe(`Bearer ${token}`);
				expect(seen?.origin).toBe(baseUrl(server));
			},
		);
	});

	test('maps API errors, suggestions and request ids to ApiError', async () => {
		await withServer(
			() =>
				new Response(
					JSON.stringify({
						error: 'conflict',
						message: '"demo" is already taken.',
						suggestions: ['demo-app', 'demo-site'],
					}),
					{
						status: 409,
						headers: { 'content-type': 'application/json', 'x-request-id': 'req_123' },
					},
				),
			async (server) => {
				const client = new ApiClient({ baseUrl: baseUrl(server), token });
				let caught: unknown;
				try {
					await client.createProject({ slug: 'demo' });
				} catch (error) {
					caught = error;
				}
				expect(caught).toBeInstanceOf(ApiError);
				const error = caught as ApiError;
				expect(error.status).toBe(409);
				expect(error.code).toBe('conflict');
				expect(error.message).toContain('already taken');
				expect(error.suggestions).toEqual(['demo-app', 'demo-site']);
				expect(error.requestId).toBe('req_123');
			},
		);
	});

	test('creates an upload, PUTs bytes with exactly the returned headers, then finalizes', async () => {
		let createBody: unknown;
		let upload: { method: string; headers: Headers; bytes: Uint8Array } | undefined;
		let finalizeBody: unknown;

		await withServer(
			async (request) => {
				const url = new URL(request.url);
				if (url.pathname === '/api/v1/uploads' && request.method === 'POST') {
					createBody = await request.json();
					return Response.json({
						uploadId: 'upl_1',
						url: `${url.origin}/objects/upl_1?sig=abc`,
						method: 'PUT',
						headers: { 'content-type': 'application/zip', 'x-test-header': 'yes' },
					});
				}
				if (url.pathname === '/objects/upl_1' && request.method === 'PUT') {
					upload = {
						method: request.method,
						headers: request.headers,
						bytes: new Uint8Array(await request.arrayBuffer()),
					};
					return new Response('', { status: 200 });
				}
				if (url.pathname === '/api/v1/uploads/upl_1/finalize' && request.method === 'POST') {
					finalizeBody = await request.json();
					return Response.json({
						deployment: {
							id: 'dep_1',
							shortId: 'abc123',
							status: 'active',
							url: 'https://demo.kierancloud.dev',
							previewUrl: 'https://demo--abc123.kierancloud.dev',
							message: 'first deploy',
						},
						project: {
							slug: 'demo',
							name: 'Demo',
							productionUrl: 'https://demo.kierancloud.dev',
							productionDeploymentId: 'dep_1',
						},
						promoted: true,
						nextSteps: ['Roll back with skif rollback demo'],
					});
				}
				return new Response('not found', { status: 404 });
			},
			async (server) => {
				const client = new ApiClient({ baseUrl: baseUrl(server), token });
				const bytes = new TextEncoder().encode('PK fake zip');
				const ticket = await client.createUpload({ project: 'demo', fileCount: 2, totalBytes: bytes.byteLength });
				expect(ticket.uploadId).toBe('upl_1');
				expect(ticket.method).toBe('PUT');

				await client.putUpload(ticket, bytes);
				expect(upload?.method).toBe('PUT');
				expect(upload?.headers.get('content-type')).toBe('application/zip');
				expect(upload?.headers.get('x-test-header')).toBe('yes');
				expect(upload?.headers.get('authorization')).toBeNull();
				expect(upload?.headers.get('origin')).toBeNull();
				expect([...(upload?.bytes ?? [])]).toEqual([...bytes]);

				const outcome = await client.finalizeUpload('upl_1', { project: 'demo', promote: false });
				expect(outcome.deployment?.id).toBe('dep_1');
				expect(outcome.previewUrl).toBe('https://demo--abc123.kierancloud.dev');
				expect(outcome.productionUrl).toBe('https://demo.kierancloud.dev');
				expect(outcome.promoted).toBe(true);
				expect(outcome.nextSteps).toEqual(['Roll back with skif rollback demo']);

				expect(createBody).toEqual({ project: 'demo', fileCount: 2, totalBytes: bytes.byteLength });
				expect(finalizeBody).toEqual({
					uploadId: 'upl_1',
					project: 'demo',
					promote: false,
				});
			},
		);
	});

	test('unwraps list envelopes and creates projects with the documented defaults', async () => {
		let createBody: unknown;
		await withServer(
			async (request) => {
				const url = new URL(request.url);
				if (url.pathname === '/api/v1/projects' && request.method === 'GET') {
					return Response.json({
						data: {
							projects: [
								{ slug: 'demo', name: 'Demo', productionUrl: 'https://demo.example.com' },
							],
						},
					});
				}
				if (url.pathname === '/api/v1/projects' && request.method === 'POST') {
					createBody = await request.json();
					return Response.json({
						project: {
							slug: 'new-site',
							name: 'New Site',
							productionAccess: 'public',
							previewAccess: 'platform',
						},
					});
				}
				if (url.pathname === '/api/v1/projects/demo/deployments') {
					return Response.json({
						deployments: [{ id: 'dep_1', shortId: 'abc', status: 'active', previewHost: 'demo--abc.example.com' }],
					});
				}
				return new Response('not found', { status: 404 });
			},
			async (server) => {
				const client = new ApiClient({ baseUrl: baseUrl(server), token });
				const list = await client.listProjects();
				expect(list.projects).toEqual([
					{
						id: undefined,
						slug: 'demo',
						name: 'Demo',
						runtime: undefined,
						placement: undefined,
						productionDeploymentId: null,
						productionUrl: 'https://demo.example.com',
						previewPattern: undefined,
						productionAccess: undefined,
						previewAccess: undefined,
						createdAt: undefined,
						updatedAt: undefined,
						deletedAt: undefined,
					},
				]);

				const deployments = await client.listDeployments('demo');
				expect(deployments.deployments[0]?.previewUrl).toBe('https://demo--abc.example.com');

				const created = await client.createProject({ slug: 'new-site', name: 'New Site' });
				expect(created.project.slug).toBe('new-site');
				expect(createBody).toEqual({
					slug: 'new-site',
					name: 'New Site',
					productionAccess: 'public',
					previewAccess: 'platform',
				});
			},
		);
	});

	test('uses the expected promote and rollback endpoints', async () => {
		const calls: Array<{ path: string; body: unknown }> = [];
		await withServer(
			async (request) => {
				calls.push({ path: new URL(request.url).pathname, body: await request.json() });
				return Response.json({
					deployment: { id: 'dep_2', status: 'active', url: 'https://demo.example.com' },
					project: { slug: 'demo', productionUrl: 'https://demo.example.com' },
					promoted: true,
				});
			},
			async (server) => {
				const client = new ApiClient({ baseUrl: baseUrl(server), token });
				await client.promote('demo', 'dep_2');
				await client.rollback('demo');
				expect(calls).toEqual([
					{ path: '/api/v1/projects/demo/promote', body: { project: 'demo', deploymentId: 'dep_2' } },
					{ path: '/api/v1/projects/demo/rollback', body: {} },
				]);
			},
		);
	});

	test('normalizes the control-plane fleet status shape', async () => {
		await withServer(
			() =>
				Response.json({
					nodes: { total: 2, online: 1, offline: 1 },
					projects: 3,
					deployments: { active: 4, total: 7 },
					storageBytes: 1024,
					versions: { controlPlane: '1.2.3', agent: '1.2.0' },
				}),
			async (server) => {
				const client = new ApiClient({ baseUrl: baseUrl(server), token });
				const { status } = await client.getStatus();
				expect(status.counts).toEqual({
					projects: 3,
					deployments: 7,
					activeDeployments: 4,
					offlineNodes: 1,
					storageBytes: 1024,
					nodes: 2,
					onlineNodes: 1,
				});
				expect(status.health).toBe('degraded');
				expect(status.platform?.version).toBe('1.2.3');
				expect(status.versions).toEqual({ controlPlane: '1.2.3', agent: '1.2.0' });
			},
		);
	});

	test('returns plain-text logs as lines', async () => {
		await withServer(
			() => new Response('one\ntwo\n', { headers: { 'content-type': 'text/plain' } }),
			async (server) => {
				const client = new ApiClient({ baseUrl: baseUrl(server), token });
				const logs = await client.getLogs('demo', { limit: 10 });
				expect(logs.lines).toEqual([{ message: 'one' }, { message: 'two' }]);
			},
		);
	});

	test('times out with a clear error', async () => {
		await withServer(
			async () => {
				await Bun.sleep(100);
				return Response.json({});
			},
			async (server) => {
				const client = new ApiClient({ baseUrl: baseUrl(server), token, timeoutMs: 10 });
				await expect(client.whoami()).rejects.toThrow('timed out after 10ms');
			},
		);
	});
});

describe('ApiClient operations', () => {
	const operation = {
		id: 'op_1',
		kind: 'bulk',
		action: 'project.delete',
		status: 'planned',
		scope: null,
		phase: null,
		total: 1,
		done: 0,
		failed: 0,
		summary: { verdicts: { ok: 1 }, statuses: { pending: 1 }, flags: {}, freedBytes: 0 },
		createdAt: '2026-11-04T12:00:00.000Z',
		startedAt: null,
		finishedAt: null,
		planExpiresAt: '2026-11-04T13:00:00.000Z',
	};

	test('createOperation sends the body, wait and Idempotency-Key, and reads the bare view', async () => {
		let seen: { url: string; key: string | null; body: unknown } | undefined;
		await withServer(
			async (request) => {
				seen = { url: request.url, key: request.headers.get('idempotency-key'), body: await request.json() };
				return Response.json(operation, { status: 202 });
			},
			async (server) => {
				const client = new ApiClient({ baseUrl: baseUrl(server), token });
				const view = await client.createOperation(
					{ action: 'project.delete', targets: ['a'], stage: 'plan' },
					{ idempotencyKey: 'k-1', waitSeconds: 40 },
				);
				expect(view.id).toBe('op_1');
				expect(view.summary.verdicts.ok).toBe(1);
				expect(seen?.url).toBe(`${baseUrl(server)}/api/v1/operations?wait=25`);
				expect(seen?.key).toBe('k-1');
				expect(seen?.body).toEqual({ action: 'project.delete', targets: ['a'], stage: 'plan' });
			},
		);
	});

	test('getOperation unwraps { operation } and listOperationItems follows the cursor', async () => {
		const urls: string[] = [];
		await withServer(
			(request) => {
				const url = new URL(request.url);
				urls.push(`${url.pathname}${url.search}`);
				if (!url.searchParams.get('items')) return Response.json({ operation });
				const after = Number(url.searchParams.get('after'));
				return Response.json({
					operation,
					items: after === 0 ? [{ seq: 1 }, { seq: 2 }] : [{ seq: 3 }],
					cursor: after === 0 ? 2 : 3,
					hasMore: after === 0,
				});
			},
			async (server) => {
				const client = new ApiClient({ baseUrl: baseUrl(server), token });
				expect((await client.getOperation('op_1')).status).toBe('planned');
				const { items } = await client.listOperationItems('op_1', { status: 'failed' });
				expect(items.map((entry) => entry.seq)).toEqual([1, 2, 3]);
				expect(urls.slice(1)).toEqual([
					'/api/v1/operations/op_1?items=1&status=failed&after=0&limit=1000',
					'/api/v1/operations/op_1?items=1&status=failed&after=2&limit=1000',
				]);
			},
		);
	});

	test('a 409 on apply becomes an ApiError with the server message', async () => {
		await withServer(
			() => Response.json({ error: 'conflict', message: 'Only a planned operation can be applied (it is cancelled).' }, { status: 409 }),
			async (server) => {
				const client = new ApiClient({ baseUrl: baseUrl(server), token });
				const error = await client.applyOperation('op_1').catch((caught) => caught);
				expect(error).toBeInstanceOf(ApiError);
				expect(error.status).toBe(409);
				expect(error.message).toContain('Only a planned operation can be applied');
			},
		);
	});

	test('listProjects({ trash }) asks for the trash and keeps purgeAt', async () => {
		await withServer(
			(request) => {
				expect(new URL(request.url).search).toBe('?trash=1');
				return Response.json({
					projects: [{ slug: 'old', deletedAt: '2026-11-01T00:00:00Z', purgeAt: '2026-11-08T00:00:00Z' }],
				});
			},
			async (server) => {
				const client = new ApiClient({ baseUrl: baseUrl(server), token });
				const { projects } = await client.listProjects({ trash: true });
				expect(projects[0]?.purgeAt).toBe('2026-11-08T00:00:00Z');
			},
		);
	});
});
