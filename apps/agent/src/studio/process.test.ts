import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { STUDIO_SESSION_HEADER, type DatabaseStudioActivation } from '@yoal/contracts';
import { decodeEvents, type StudioEvent } from '@yoal/studio/protocol';
import { runStudioProcess, type StudioProcess, type StudioProcessOptions } from './process.ts';
import { tempSocket, testActivation, trackedFake } from './test-support.ts';

const SESSION = 'dss_AAAAAAAAAAAAAAAA';
const OTHER = 'dss_BBBBBBBBBBBBBBBB';

const quiet = () => undefined;
const running: StudioProcess[] = [];

async function start(options: Partial<StudioProcessOptions> = {}) {
	const fake = trackedFake();
	const proc = await runStudioProcess({
		socketPath: tempSocket(),
		loaders: fake.loaders,
		exit: quiet,
		log: quiet,
		...options,
	});
	running.push(proc);
	const call = (path: string, init: RequestInit = {}) =>
		fetch(`http://studio${path}`, { ...init, unix: proc.socketPath });
	const put = (activation: DatabaseStudioActivation, id = activation.sessionId) =>
		call(`/sessions/${id}`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(activation),
		});
	const op = (name: string, body: unknown, session = SESSION, signal?: AbortSignal) =>
		call(`/v1/${name}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', [STUDIO_SESSION_HEADER]: session },
			body: JSON.stringify(body),
			...(signal ? { signal } : {}),
		});
	return { proc, fake, call, put, op };
}

async function collect(response: Response): Promise<StudioEvent[]> {
	const events: StudioEvent[] = [];
	if (!response.body) return events;
	for await (const event of decodeEvents(response.body)) events.push(event);
	return events;
}

afterEach(async () => {
	await Promise.all(running.splice(0).map((proc) => proc.stop()));
});

describe('studio process', () => {
	test('healthz reports the boot id and session count', async () => {
		const { proc, call } = await start();
		const response = await call('/healthz');
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true, bootId: proc.bootId, sessions: 0 });
	});

	test('PUT and DELETE sessions', async () => {
		const { call, put } = await start();
		expect((await put(testActivation(SESSION))).status).toBe(200);
		expect(((await (await call('/healthz')).json()) as { sessions: number }).sessions).toBe(1);

		const mismatched = await put(testActivation(SESSION), OTHER);
		expect(mismatched.status).toBe(400);
		expect(await mismatched.json()).toMatchObject({ error: { code: 'bad_request' } });

		expect((await call(`/sessions/${SESSION}`, { method: 'DELETE' })).status).toBe(200);
		expect(((await (await call('/healthz')).json()) as { sessions: number }).sessions).toBe(0);
	});

	test('an unknown session is refused', async () => {
		const { op } = await start();
		const response = await op('tree', { path: [] });
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({
			error: { code: 'unknown_session', message: expect.any(String) },
		});
	});

	test('an invalid body is a bad request', async () => {
		const { put, op } = await start();
		await put(testActivation(SESSION));
		const response = await op('tree', { path: 'public' });
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: { code: 'bad_request' } });
	});

	test('an expired session is forgotten', async () => {
		let clock = Date.now();
		const { call, put, op } = await start({ now: () => clock });
		await put(testActivation(SESSION, { expiresAt: new Date(clock + 1_000).toISOString() }));
		clock += 2_000;
		const response = await op('tree', { path: [] });
		expect(response.status).toBe(410);
		expect(await response.json()).toMatchObject({ error: { code: 'session_expired' } });
		expect(((await (await call('/healthz')).json()) as { sessions: number }).sessions).toBe(0);
	});

	test('info, tree and describe answer JSON', async () => {
		const { put, op } = await start();
		await put(testActivation(SESSION, { readOnly: true }));
		const info = await op('info', {});
		expect(await info.json()).toMatchObject({
			v: 1,
			engine: 'postgres',
			readOnly: true,
			capabilities: { family: 'relational', language: 'sql' },
			limits: { maxRows: 1_000 },
		});
		const tree = (await (await op('tree', { path: ['public'] })).json()) as { nodes: { name: string }[] };
		expect(tree.nodes.map((node) => node.name)).toEqual(['item_names', 'items']);
		const described = await op('describe', { object: { path: ['public', 'items'], kind: 'table' } });
		expect(await described.json()).toMatchObject({ primaryKey: ['id'], editable: false });
	});

	test('browse streams NDJSON', async () => {
		const { put, op } = await start();
		await put(testActivation(SESSION));
		const response = await op('browse', { object: { path: ['public', 'items'], kind: 'table' }, query: { limit: 100 } });
		expect(response.headers.get('content-type')).toBe('application/x-ndjson');
		const events = await collect(response);
		expect(events.map((event) => event.t)).toEqual(['columns', 'rows', 'page', 'done']);
		expect(events[1]).toMatchObject({ t: 'rows' });
		expect((events[1] as { rows: unknown[] }).rows).toHaveLength(100);
		expect(events[2]).toEqual({ t: 'page', next: '100', estimate: 250 });
	});

	test('run is truncated at the session maxRows, and maxRows only lowers it', async () => {
		const { put, op } = await start();
		await put(testActivation(SESSION, { limits: { maxRows: 120, maxBytes: 16 * 1_048_576, statementTimeoutMs: 30_000 } }));
		const rowsOf = (events: StudioEvent[]) => events.flatMap((event) => (event.t === 'rows' ? event.rows : []));

		const capped = await collect(await op('run', { input: 'select * from items' }));
		expect(rowsOf(capped)).toHaveLength(120);
		expect(capped.at(-1)).toMatchObject({ t: 'done', truncated: true });

		const lower = await collect(await op('run', { input: 'select * from items', maxRows: 30 }));
		expect(rowsOf(lower)).toHaveLength(30);

		const higher = await collect(await op('run', { input: 'select * from items', maxRows: 5_000 }));
		expect(rowsOf(higher)).toHaveLength(120);
	});

	test('a client abort cancels the running statement quickly', async () => {
		const { put, op, fake } = await start();
		await put(testActivation(SESSION));
		const controller = new AbortController();
		const pending = op('run', { input: 'sleep 10000' }, SESSION, controller.signal);
		await Bun.sleep(100);
		const abortedAt = Date.now();
		controller.abort();
		await expect(pending).rejects.toThrow();
		for (let i = 0; i < 50 && fake.aborts.length === 0; i += 1) await Bun.sleep(20);
		expect(fake.aborts).toHaveLength(1);
		expect((fake.aborts[0] ?? Infinity) - abortedAt).toBeLessThan(1_000);
	});

	test('a newer run cancels the previous one', async () => {
		const { put, op } = await start();
		await put(testActivation(SESSION));
		const started = Date.now();
		const first = op('run', { input: 'sleep 10000' });
		await Bun.sleep(100);
		const second = await collect(await op('run', { input: 'select count' }));
		expect(second.map((event) => event.t)).toEqual(['columns', 'rows', 'result', 'done']);
		const cancelled = await first;
		expect(cancelled.status).toBe(499);
		expect(await cancelled.json()).toMatchObject({ error: { code: 'cancelled' } });
		expect(Date.now() - started).toBeLessThan(2_000);
	});

	test('a read-only session refuses writes', async () => {
		const { put, op } = await start();
		await put(testActivation(SESSION, { readOnly: true }));
		const refused = await op('run', { input: 'delete from items' });
		expect(refused.status).toBe(403);
		expect(await refused.json()).toMatchObject({ error: { code: 'read_only' } });

		// Once rows have streamed, the refusal is an error event followed by done.
		const events = await collect(await op('run', { input: 'select count; delete from items' }));
		expect(events.map((event) => event.t)).toEqual(['columns', 'rows', 'result', 'error', 'done']);
		expect(events[3]).toMatchObject({ t: 'error', code: 'read_only' });
	});

	test('alter runs on a write session and is refused on a read-only one', async () => {
		const { put, op } = await start();
		await put(testActivation(SESSION, { readOnly: false }));
		const dry = await op('alter', { change: { op: 'truncate', object: { path: ['public', 'items'], kind: 'table' } }, dryRun: true });
		expect(dry.status).toBe(200);
		expect(await dry.json()).toEqual({ statements: ['TRUNCATE public.items'], applied: false });
		const created = await op('alter', {
			change: { op: 'create-table', parent: ['public'], name: 'scratch', columns: [{ name: 'id', type: 'integer' }] },
		});
		expect(await created.json()).toMatchObject({ applied: true });
		const tree = (await (await op('tree', { path: ['public'] })).json()) as { nodes: Array<{ name: string }> };
		expect(tree.nodes.map((node) => node.name)).toContain('scratch');
		const unsupported = await op('alter', {
			change: { op: 'drop-index', object: { path: ['public', 'items'], kind: 'table' }, name: 'items_pkey' },
		});
		expect(unsupported.status).toBe(422);

		await put(testActivation(OTHER, { readOnly: true }));
		const refused = await op('alter', { change: { op: 'truncate', object: { path: ['public', 'items'], kind: 'table' } }, dryRun: true }, OTHER);
		expect(refused.status).toBe(403);
		expect(await refused.json()).toMatchObject({ error: { code: 'read_only' } });
	});

	test('errors that are not StudioErrors become engine_error without a stack', async () => {
		const fake = trackedFake({
			onConnect() {
				throw new Error('connection refused');
			},
		});
		const { put, op } = await start({ loaders: fake.loaders });
		await put(testActivation(SESSION));
		const response = await op('tree', { path: [] });
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ error: { code: 'engine_error', message: 'connection refused' } });
	});

	test('refuses a new session past maxSessions', async () => {
		const { put } = await start({ maxSessions: 1 });
		expect((await put(testActivation(SESSION))).status).toBe(200);
		const busy = await put(testActivation(OTHER));
		expect(busy.status).toBe(409);
		expect(await busy.json()).toMatchObject({ error: { code: 'busy' } });
		// Replacing an existing session is still fine.
		expect((await put(testActivation(SESSION, { readOnly: true }))).status).toBe(200);
	});

	test('idle connections close and reconnect lazily', async () => {
		const fake = trackedFake();
		const { put, op } = await start({ loaders: fake.loaders, sessionIdleMs: 40 });
		await put(testActivation(SESSION));
		expect((await op('tree', { path: [] })).status).toBe(200);
		expect((await op('tree', { path: [] })).status).toBe(200);
		expect(fake.connects()).toBe(1);
		await Bun.sleep(150);
		expect((await op('tree', { path: [] })).status).toBe(200);
		expect(fake.connects()).toBe(2);
	});

	test('exits after idleExitMs with no sessions and removes the socket', async () => {
		let exited!: () => void;
		const exit = new Promise<void>((resolve) => {
			exited = resolve;
		});
		const { proc } = await start({ idleExitMs: 80, exit: () => exited() });
		expect(existsSync(proc.socketPath)).toBe(true);
		await Promise.race([exit, Bun.sleep(2_000).then(() => Promise.reject(new Error('did not exit')))]);
		expect(existsSync(proc.socketPath)).toBe(false);
	});
});
