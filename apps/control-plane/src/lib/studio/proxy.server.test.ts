import { describe, expect, test } from 'bun:test';
import { STUDIO_SESSION_HEADER, STUDIO_TOKEN_HEADER, type Principal } from '@skiff/contracts';
import { NDJSON_CONTENT_TYPE, decodeEvents, encodeEvent } from '@skiff/studio/protocol';
import {
	STUDIO_MAX_BODY_BYTES,
	handleStudioCall,
	studioErrorFromCore,
	type StudioActivity,
	type StudioEndpoint,
	type StudioProxyDeps
} from './proxy.server.ts';

const TOKEN = 'tok_super_secret_value_1234567890';

const endpoint: StudioEndpoint = {
	sessionId: 'dss_abcdefghijklmnop',
	token: TOKEN,
	host: 'n-abc.studio.internal',
	nodeId: 'node_abc',
	engine: 'postgres',
	readOnly: true,
	expiresAt: '2026-11-06T12:00:00.000Z'
};

const user = { kind: 'user', userId: 'u1', orgId: 'o1', role: 'owner' } as unknown as Principal;
const apiKey = { ...user, kind: 'apiKey' } as unknown as Principal;

interface Dial {
	url: string;
	init: RequestInit;
}

function setup(
	options: {
		endpoint?: Partial<StudioEndpoint>;
		upstream?: (dial: Dial) => Response | Promise<Response>;
		endpointError?: Error;
		enabled?: boolean;
	} = {}
) {
	const dials: Dial[] = [];
	const activity: StudioActivity[] = [];
	const deps: StudioProxyDeps = {
		enabled: () => options.enabled ?? true,
		studio: {
			endpoint: () => {
				if (options.endpointError) throw options.endpointError;
				return { ...endpoint, ...options.endpoint };
			},
			recordActivity: (_principal, _name, entry) => {
				activity.push(entry);
			}
		},
		gatewayPort: () => 8082,
		fingerprint: (input) => `fp:${input.length}`,
		fetch: (async (url: string | URL | Request, init?: RequestInit) => {
			const dial = { url: String(url), init: init ?? {} };
			dials.push(dial);
			return options.upstream
				? options.upstream(dial)
				: Response.json({ nodes: [] }, { headers: { 'content-type': 'application/json' } });
		}) as typeof fetch
	};
	return { deps, dials, activity };
}

function request(body: unknown, init: RequestInit = {}): Request {
	return new Request('http://skiff.test/databases/app-db/studio/api/x', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: typeof body === 'string' ? body : JSON.stringify(body),
		...init
	});
}

async function call(
	deps: StudioProxyDeps,
	op: string,
	body: unknown,
	extra: { principal?: Principal; request?: Request } = {}
) {
	return handleStudioCall(deps, {
		principal: 'principal' in extra ? extra.principal : user,
		name: 'app-db',
		op,
		request: extra.request ?? request(body)
	});
}

async function errorCode(response: Response): Promise<string> {
	const body = (await response.json()) as { error: { code: string } };
	return body.error.code;
}

describe('studio proxy: refusals', () => {
	test('an op that is not in the protocol is a 404 without dialling', async () => {
		const { deps, dials } = setup();
		const response = await call(deps, 'drop', {});
		expect(response.status).toBe(404);
		expect(await errorCode(response)).toBe('not_found');
		expect(dials).toHaveLength(0);
	});

	test('everything is a 404 when DB_STUDIO is off', async () => {
		const { deps, dials } = setup({ enabled: false });
		const response = await call(deps, 'info', {});
		expect(response.status).toBe(404);
		expect(dials).toHaveLength(0);
	});

	test('a body over the cap is a 413', async () => {
		const { deps, dials } = setup();
		const big = JSON.stringify({ input: 'x'.repeat(STUDIO_MAX_BODY_BYTES) });
		const response = await call(deps, 'run', big);
		expect(response.status).toBe(413);
		expect(await errorCode(response)).toBe('bad_request');
		expect(dials).toHaveLength(0);
	});

	test('a streamed body over the cap is a 413 even without content-length', async () => {
		const { deps } = setup();
		const chunk = new TextEncoder().encode('x'.repeat(256 * 1024));
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (let i = 0; i < 6; i += 1) controller.enqueue(chunk);
				controller.close();
			}
		});
		const req = new Request('http://skiff.test/x', {
			method: 'POST',
			body: stream,
			// @ts-expect-error Bun/undici need duplex for a stream body.
			duplex: 'half'
		});
		const response = await call(deps, 'run', null, { request: req });
		expect(response.status).toBe(413);
	});

	test('a body that fails the op schema is a 400', async () => {
		const { deps, dials } = setup();
		const response = await call(deps, 'run', { input: '' });
		expect(response.status).toBe(400);
		expect(await errorCode(response)).toBe('bad_request');
		const notJson = await call(deps, 'tree', '{nope');
		expect(notJson.status).toBe(400);
		expect(dials).toHaveLength(0);
	});

	test('an API key is refused', async () => {
		const { deps, dials } = setup();
		const response = await call(deps, 'info', {}, { principal: apiKey });
		expect(response.status).toBe(403);
		expect(await errorCode(response)).toBe('forbidden');
		expect(dials).toHaveLength(0);
	});

	test('no principal is a 401', async () => {
		const { deps } = setup();
		const response = await call(deps, 'info', {}, { principal: undefined });
		expect(response.status).toBe(401);
	});

	test('apply in a read-only session is refused without dialling', async () => {
		const { deps, dials, activity } = setup();
		const response = await call(deps, 'apply', {
			object: { path: ['public', 'users'], kind: 'table' },
			changes: [{ op: 'delete', key: { id: 1 } }]
		});
		expect(response.status).toBe(403);
		expect(await errorCode(response)).toBe('read_only');
		expect(dials).toHaveLength(0);
		expect(activity).toHaveLength(0);
	});

	test('alter in a read-only session is refused without dialling, dry runs included', async () => {
		const { deps, dials, activity } = setup();
		for (const dryRun of [true, false]) {
			const response = await call(deps, 'alter', {
				change: { op: 'drop', object: { path: ['public', 'users'], kind: 'table' } },
				dryRun
			});
			expect(response.status).toBe(403);
			expect(await errorCode(response)).toBe('read_only');
		}
		expect(dials).toHaveLength(0);
		expect(activity).toHaveLength(0);
	});

	test('alter refuses a column type that could smuggle SQL', async () => {
		const { deps, dials } = setup({ endpoint: { readOnly: false } });
		for (const type of ['int; drop table users', 'text --', "enum('a';')"]) {
			const response = await call(deps, 'alter', {
				change: {
					op: 'add-column',
					object: { path: ['public', 'users'], kind: 'table' },
					column: { name: 'x', type }
				}
			});
			expect(response.status).toBe(400);
			expect(await errorCode(response)).toBe('bad_request');
		}
		const response = await call(deps, 'alter', {
			change: {
				op: 'add-column',
				object: { path: ['public', 'users'], kind: 'table' },
				column: { name: 'x', type: 'text', default: { expression: 'now()); drop table users; --' } }
			}
		});
		expect(response.status).toBe(400);
		expect(dials).toHaveLength(0);
	});

	test('core errors map onto protocol codes', async () => {
		const coreError = (status: number, message: string) =>
			Object.assign(new Error(message), { name: 'CoreError', status });
		const cases: Array<[Error, number, string]> = [
			[
				Object.assign(new Error('Missing database:console'), { name: 'ForbiddenError' }),
				403,
				'forbidden'
			],
			[coreError(404, 'Database not found'), 404, 'not_found'],
			[coreError(409, 'The studio session has expired. Open it again.'), 410, 'session_expired'],
			[coreError(410, 'Session expired'), 410, 'session_expired'],
			[coreError(409, 'The studio is not open. Open it first.'), 409, 'conflict']
		];
		for (const [caught, status, code] of cases) {
			const { deps } = setup({ endpointError: caught });
			const response = await call(deps, 'info', {});
			expect(response.status).toBe(status);
			expect(await errorCode(response)).toBe(code);
		}
		expect(studioErrorFromCore(new Error('boom'))).toBeNull();
	});
});

describe('studio proxy: dialling', () => {
	test('sends Host, session and token upstream with a re-serialised body', async () => {
		const { deps, dials } = setup();
		const response = await call(deps, 'tree', { path: ['public'], extra: 'dropped' });
		expect(response.status).toBe(200);
		expect(dials).toHaveLength(1);
		const [dial] = dials;
		expect(dial!.url).toBe('http://127.0.0.1:8082/v1/tree');
		expect(dial!.init.method).toBe('POST');
		const headers = new Headers(dial!.init.headers);
		expect(headers.get('host')).toBe(endpoint.host);
		expect(headers.get('content-type')).toBe('application/json');
		expect(headers.get(STUDIO_SESSION_HEADER)).toBe(endpoint.sessionId);
		expect(headers.get(STUDIO_TOKEN_HEADER)).toBe(TOKEN);
		// Unknown keys are stripped: only schema-checked protocol reaches the node.
		expect(dial!.init.body).toBe(JSON.stringify({ path: ['public'] }));
	});

	test('never echoes the token or upstream cookies back to the browser', async () => {
		const { deps } = setup({
			upstream: () =>
				new Response(JSON.stringify({ nodes: [] }), {
					headers: {
						'content-type': 'application/json',
						'set-cookie': 'studio=1',
						connection: 'keep-alive',
						[STUDIO_TOKEN_HEADER]: TOKEN,
						'x-upstream': TOKEN
					}
				})
		});
		const response = await call(deps, 'tree', { path: [] });
		const text = await response.text();
		expect(text).not.toContain(TOKEN);
		for (const [name, value] of response.headers) {
			expect(value).not.toContain(TOKEN);
			expect(name).not.toBe('set-cookie');
			expect(name).not.toBe('connection');
		}
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(response.headers.get('x-content-type-options')).toBe('nosniff');
		expect(response.headers.get('content-type')).toBe('application/json');
	});

	test('streams NDJSON through without buffering', async () => {
		let push: ((line: string) => void) | null = null;
		let end: (() => void) | null = null;
		const upstreamBody = new ReadableStream<Uint8Array>({
			start(controller) {
				const encoder = new TextEncoder();
				push = (line) => controller.enqueue(encoder.encode(line));
				end = () => controller.close();
			}
		});
		const { deps } = setup({
			upstream: () =>
				new Response(upstreamBody, { headers: { 'content-type': NDJSON_CONTENT_TYPE } })
		});
		const response = await call(deps, 'browse', {
			object: { path: ['public', 'users'], kind: 'table' },
			query: { limit: 100 }
		});
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe(NDJSON_CONTENT_TYPE);
		const events = decodeEvents(response.body!);

		// The first event arrives before upstream has finished.
		push!(
			encodeEvent({ t: 'columns', columns: [{ name: 'id', nativeType: 'int4', kind: 'number' }] })
		);
		const first = await events.next();
		expect(first.value).toEqual({
			t: 'columns',
			columns: [{ name: 'id', nativeType: 'int4', kind: 'number' }]
		});

		push!(encodeEvent({ t: 'rows', rows: [[1], [2]] }));
		push!(encodeEvent({ t: 'done', ms: 3, truncated: false }));
		end!();
		const rest = [];
		for await (const event of events) rest.push(event);
		expect(rest).toEqual([
			{ t: 'rows', rows: [[1], [2]] },
			{ t: 'done', ms: 3, truncated: false }
		]);
	});

	test('a browser abort reaches the upstream fetch', async () => {
		const controller = new AbortController();
		let upstreamSignal: AbortSignal | undefined;
		const { deps } = setup({
			upstream: (dial) => {
				upstreamSignal = dial.init.signal ?? undefined;
				return new Response(new ReadableStream(), {
					headers: { 'content-type': NDJSON_CONTENT_TYPE }
				});
			}
		});
		const req = request({ input: 'select pg_sleep(60)' }, { signal: controller.signal });
		await call(deps, 'run', null, { request: req });
		expect(upstreamSignal).toBeDefined();
		expect(upstreamSignal!.aborted).toBe(false);
		controller.abort();
		expect(upstreamSignal!.aborted).toBe(true);
	});

	test('a network failure is a 503 studio_unavailable', async () => {
		const { deps } = setup({
			upstream: () => {
				throw new TypeError(`fetch failed: ${TOKEN}`);
			}
		});
		const response = await call(deps, 'info', {});
		expect(response.status).toBe(503);
		const text = await response.text();
		expect(JSON.parse(text).error.code).toBe('studio_unavailable');
		expect(text).not.toContain(TOKEN);
	});

	test('upstream errors pass through with their status', async () => {
		const { deps } = setup({
			upstream: () =>
				Response.json(
					{ error: { code: 'busy', message: 'A run is in progress.' } },
					{ status: 409 }
				)
		});
		const response = await call(deps, 'tree', { path: [] });
		expect(response.status).toBe(409);
		expect(await errorCode(response)).toBe('busy');
	});
});

describe('studio proxy: audit', () => {
	test('run records a fingerprint and the mode, never the SQL', async () => {
		const sql = "select * from users where email = 'secret@example.com'";
		const { deps, activity, dials } = setup({
			upstream: () => new Response('', { headers: { 'content-type': NDJSON_CONTENT_TYPE } })
		});
		await call(deps, 'run', { input: sql });
		expect(activity).toEqual([{ op: 'run', fingerprint: `fp:${sql.length}`, readOnly: true }]);
		expect(JSON.stringify(activity)).not.toContain('secret@example.com');
		expect(dials).toHaveLength(1);
	});

	test('apply records the change counts and the applied total after a 200', async () => {
		const object = { path: ['public', 'users'], kind: 'table' as const };
		const { deps, activity } = setup({
			endpoint: { readOnly: false },
			upstream: () => Response.json({ applied: 3, conflicts: [] })
		});
		const response = await call(deps, 'apply', {
			object,
			changes: [
				{ op: 'insert', values: { id: 3 } },
				{ op: 'update', key: { id: 1 }, values: { name: 'b' }, original: { name: 'a' } },
				{ op: 'delete', key: { id: 2 } }
			]
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ applied: 3, conflicts: [] });
		expect(activity).toEqual([
			{ op: 'apply', object, inserted: 1, updated: 1, deleted: 1, applied: 3 }
		]);
	});

	test('an applied alter records the object and the change kind only', async () => {
		const { deps, dials, activity } = setup({
			endpoint: { readOnly: false },
			upstream: () =>
				Response.json({ statements: ['ALTER TABLE "public"."users" ADD COLUMN "secret_col" text'], applied: true })
		});
		const response = await call(deps, 'alter', {
			change: {
				op: 'add-column',
				object: { path: ['public', 'users'], kind: 'table' },
				column: { name: 'secret_col', type: 'text', default: { literal: 'secret@example.com' } }
			}
		});
		expect(response.status).toBe(200);
		expect(JSON.parse(String(dials[0]?.init.body))).toMatchObject({ dryRun: false });
		expect(activity).toEqual([{ op: 'alter', object: ['public', 'users'], change: 'add-column' }]);
		expect(JSON.stringify(activity)).not.toContain('secret@example.com');
	});

	test('a dry-run or failed alter is not audited', async () => {
		const dry = setup({
			endpoint: { readOnly: false },
			upstream: () => Response.json({ statements: ['TRUNCATE "public"."users"'], applied: false })
		});
		const response = await call(dry.deps, 'alter', {
			change: { op: 'truncate', object: { path: ['public', 'users'], kind: 'table' } },
			dryRun: true
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ statements: ['TRUNCATE "public"."users"'], applied: false });
		expect(dry.activity).toHaveLength(0);

		const failed = setup({
			endpoint: { readOnly: false },
			upstream: () =>
				Response.json({ error: { code: 'engine_error', message: 'no such table' } }, { status: 500 })
		});
		const refused = await call(failed.deps, 'alter', {
			change: { op: 'truncate', object: { path: ['public', 'users'], kind: 'table' } }
		});
		expect(refused.status).toBe(500);
		expect(failed.activity).toHaveLength(0);
	});

	test('a refused apply is not recorded as a write', async () => {
		const { deps, activity } = setup({
			endpoint: { readOnly: false },
			upstream: () =>
				Response.json({ error: { code: 'read_only', message: 'Read-only.' } }, { status: 403 })
		});
		const response = await call(deps, 'apply', {
			object: { path: ['t'], kind: 'table' },
			changes: [{ op: 'delete', key: { id: 1 } }]
		});
		expect(response.status).toBe(403);
		expect(activity).toHaveLength(0);
	});
});
