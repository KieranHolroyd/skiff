import { describe, expect, test } from 'bun:test';
import { ApiClient } from './api.ts';
import { ApiError, CliError } from './errors.ts';

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
							url: 'https://demo.examplecloud.com',
							previewUrl: 'https://demo--abc123.examplecloud.com',
							message: 'first deploy',
						},
						project: {
							slug: 'demo',
							name: 'Demo',
							productionUrl: 'https://demo.examplecloud.com',
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
				expect(outcome.previewUrl).toBe('https://demo--abc123.examplecloud.com');
				expect(outcome.productionUrl).toBe('https://demo.examplecloud.com');
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

	test('createProject sends runtime and listSecrets reads secret metadata', async () => {
		let body: unknown;
		await withServer(
			async (request) => {
				const url = new URL(request.url);
				if (url.pathname === '/api/v1/projects' && request.method === 'POST') {
					body = await request.json();
					return Response.json({ project: { id: 'prj_1', slug: 'fn-app', runtime: 'function' } });
				}
				if (url.pathname === '/api/v1/secrets') {
					return Response.json({
						secrets: [
							{ id: 'sec_1', name: 'API_KEY', type: 'secret', version: 2, projectId: 'prj_1' },
							{ id: 'sec_2', name: 'ORG_KEY', type: 'secret', version: 1, projectId: null },
						],
					});
				}
				return new Response('not found', { status: 404 });
			},
			async (server) => {
				const client = new ApiClient({ baseUrl: baseUrl(server), token });
				const created = await client.createProject({ slug: 'fn-app', runtime: 'function' });
				expect(created.project.runtime).toBe('function');
				expect(body).toEqual({
					slug: 'fn-app',
					runtime: 'function',
					productionAccess: 'public',
					previewAccess: 'platform',
				});

				const { secrets } = await client.listSecrets();
				expect(secrets).toEqual([
					{ id: 'sec_1', name: 'API_KEY', type: 'secret', version: 2, projectId: 'prj_1' },
					{ id: 'sec_2', name: 'ORG_KEY', type: 'secret', version: 1, projectId: null },
				]);
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

describe('ApiClient node tasks (D124)', () => {
	const task = (overrides: Record<string, unknown> = {}) => ({
		id: 'nt_1',
		kind: 'broker.queue.send',
		status: 'succeeded',
		target: { type: 'broker', name: 'mq', nodeId: 'node_1' },
		input: {},
		result: { stream: 'SKIFF_Q_jobs', sent: 1, seqs: [4], durationMs: 2, state: null },
		error: null,
		createdAt: '2026-11-07T10:00:00.000Z',
		startedAt: null,
		finishedAt: null,
		...overrides,
	});

	test('a 200 answers with the result; the request waits 20s and sends the body', async () => {
		let seen: { url: string; method: string; body: unknown } | undefined;
		await withServer(
			async (request) => {
				seen = { url: request.url, method: request.method, body: await request.json() };
				return Response.json({ task: task() });
			},
			async (server) => {
				const client = new ApiClient({ baseUrl: baseUrl(server), token });
				const { result, task: view } = await client.brokerQueueSend('mq', 'jobs', { body: '{}', count: 2 });
				expect(result.seqs).toEqual([4]);
				expect(view.status).toBe('succeeded');
				expect(seen?.method).toBe('POST');
				expect(seen?.url).toBe(`${baseUrl(server)}/api/v1/brokers/mq/queues/jobs/messages?wait=20`);
				expect(seen?.body).toEqual({ body: '{}', count: 2 });
			},
		);
	});

	test('peek keeps its own query and adds wait', async () => {
		let url = '';
		await withServer(
			(request) => {
				url = request.url;
				return Response.json({ task: task({ result: { stream: 'S', messages: [], total: 0, firstSeq: 0, lastSeq: 0, nextSeq: null } }) });
			},
			async (server) => {
				await new ApiClient({ baseUrl: baseUrl(server), token }).brokerStreamPeek('mq', 'SKIFF_Q_jobs', { limit: 5, from: 10 });
				expect(url).toBe(`${baseUrl(server)}/api/v1/brokers/mq/streams/SKIFF_Q_jobs/messages?limit=5&from=10&wait=20`);
			},
		);
	});

	test('a 202 is polled at /node-tasks/:id until it finishes', async () => {
		const paths: string[] = [];
		let polls = 0;
		await withServer(
			(request) => {
				const url = new URL(request.url);
				paths.push(`${request.method} ${url.pathname}${url.search}`);
				if (request.method === 'POST')
					return Response.json({ task: task({ status: 'pending', result: null }) }, { status: 202, headers: { location: '/api/v1/node-tasks/nt_1' } });
				polls++;
				return Response.json({
					task: polls < 2 ? task({ status: 'running', result: null }) : task({ kind: 'function.scheduled', result: { status: 200, error: null, durationMs: 5, coldStart: true } }),
				});
			},
			async (server) => {
				const client = new ApiClient({ baseUrl: baseUrl(server), token });
				const { result } = await client.functionScheduled('api', '* * * * *');
				expect(result).toEqual({ status: 200, error: null, durationMs: 5, coldStart: true });
				expect(paths).toEqual([
					'POST /api/v1/projects/api/function/scheduled?wait=20',
					'GET /api/v1/node-tasks/nt_1?wait=20',
					'GET /api/v1/node-tasks/nt_1?wait=20',
				]);
			},
		);
	});

	test('a 502 node_task_failed becomes a CliError with the node message', async () => {
		await withServer(
			() =>
				Response.json(
					{ error: 'node_task_failed', message: 'stream not found', task: task({ status: 'failed', error: 'stream not found', result: null }) },
					{ status: 502 },
				),
			async (server) => {
				const client = new ApiClient({ baseUrl: baseUrl(server), token });
				const error = await client.brokerStreamPurge('mq', 'NOPE').catch((caught: unknown) => caught);
				expect(error).toBeInstanceOf(CliError);
				expect(error).not.toBeInstanceOf(ApiError);
				expect((error as CliError).message).toBe('stream not found');
				expect((error as CliError).code).toBe('node_task_failed');
			},
		);
	});

	test('a task that fails while polled throws its error; other errors stay ApiErrors', async () => {
		await withServer(
			(request) =>
				request.method === 'POST'
					? Response.json({ task: task({ status: 'pending', result: null }) }, { status: 202 })
					: Response.json({ task: task({ status: 'failed', error: 'Node node_1 did not pick up the task.', result: null }) }),
			async (server) => {
				const client = new ApiClient({ baseUrl: baseUrl(server), token });
				await expect(client.brokerQueueCreate('mq', 'jobs')).rejects.toThrow('Node node_1 did not pick up the task.');
			},
		);
		await withServer(
			() => Response.json({ error: 'not_found', message: 'No broker "mq".' }, { status: 404 }),
			async (server) => {
				const client = new ApiClient({ baseUrl: baseUrl(server), token });
				const error = await client.brokerStreamDelete('mq', 'S').catch((caught: unknown) => caught);
				expect(error).toBeInstanceOf(ApiError);
				expect((error as ApiError).status).toBe(404);
			},
		);
	});

	test('gives up after nodeTaskWaitMs with the task id', async () => {
		await withServer(
			() => Response.json({ task: task({ status: 'running', result: null }) }, { status: 202 }),
			async (server) => {
				const client = new ApiClient({ baseUrl: baseUrl(server), token, nodeTaskWaitMs: 0 });
				const error = await client.functionInvoke('api', { path: '/' }).catch((caught: unknown) => caught);
				expect((error as CliError).code).toBe('node_task_timeout');
				expect((error as CliError).message).toContain('task nt_1 (running)');
			},
		);
	});
});
