/**
 * Key-value studio plugin end-to-end (plan 22, Phase 2 track D): the shared conformance suite
 * plus key-value checks, against disposable `valkey/valkey:9.1` and the newest Redis 8.x image
 * available (8.10 preferred). Mirrors Skiff's server config: the `default` user is off and the
 * owner is an ACL user with `~* &* +@all`; the Phase 3 read-only principal is
 * `+@read -@write -@admin -@dangerous ~*`.
 *
 *   SKIFF_E2E_STUDIO=1 SKIFF_E2E_ENGINE=docker bun test tests/e2e/studio/keyvalue.e2e.test.ts
 *
 * Without `SKIFF_E2E_STUDIO=1` it registers one skipped test, so the root `bun test` stays fast.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { RedisClient } from 'bun';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_STUDIO_LIMITS } from '../../../packages/contracts/src/index.ts';
import { collect, describeConformance, rowsOf } from '../../../packages/studio/src/conformance.ts';
import type { StudioSession, StudioTarget } from '../../../packages/studio/src/driver.ts';
import { keyvaluePlugin } from '../../../packages/studio/src/plugins/keyvalue/index.ts';
import { StudioError, type Cell, type ObjectRef, type StudioEvent } from '../../../packages/studio/src/protocol.ts';
import { ContainerRuntime, detectEngine, freePort, waitFor } from '../lib/containers.ts';

const ROW_COUNT = 250;
// Skiff's owner is named after the database; the password exercises URL encoding.
const OWNER = { user: 'app_cache', password: 'ownerP@ss:w/rd?%' };
const READER = { user: 'skiff_studio_ro', password: 'reader-pw-0123456789' };
const BIG_LIST = 300_000;
const BINARY = new Uint8Array([0xff, 0x00, 0xfe, 0x41]);
const LARGE = 'x'.repeat(10_000);

interface Server {
	engine: 'valkey' | 'redis';
	image: string;
	version: string;
	port: number;
	name: string;
}

const enabled = process.env.SKIFF_E2E_STUDIO === '1';
const engine = enabled ? await detectEngine() : null;

if (!enabled || !engine) {
	test.skip('keyvalue studio e2e (set SKIFF_E2E_STUDIO=1 and have Docker or Podman)', () => {});
} else {
	const tempDir = await mkdtemp(join(tmpdir(), 'studio-kv-'));
	const runtime = new ContainerRuntime(engine, tempDir);
	const network = `studio-kv-${runtime.runId}`;
	const servers: Server[] = [
		{ engine: 'valkey', image: 'valkey/valkey:9.1', version: '9.1', port: await freePort(), name: `studio-kv-valkey-${runtime.runId}` },
		await (async (): Promise<Server> => {
			const image = await pickImage(runtime, ['redis:8.10', 'redis:8.10-alpine', 'redis:8.8', 'redis:8.8-alpine', 'redis:8.0', 'redis:8']);
			const version = /:(\d+(?:\.\d+)?)/.exec(image)?.[1] ?? '8';
			return { engine: 'redis', image, version, port: await freePort(), name: `studio-kv-redis-${runtime.runId}` };
		})(),
	];

	beforeAll(async () => {
		await runtime.createNetwork(network);
		for (const server of servers) {
			const binary = server.engine === 'valkey' ? 'valkey-server' : 'redis-server';
			await runtime.runContainer({
				name: server.name,
				image: server.image,
				network,
				ports: [[server.port, 6379]],
				command: [
					binary,
					'--save',
					'',
					'--appendonly',
					'no',
					'--maxmemory',
					'256mb',
					'--maxmemory-policy',
					'noeviction',
					'--user',
					'default',
					'off',
					'--user',
					OWNER.user,
					'on',
					`>${OWNER.password}`,
					'~*',
					'&*',
					'+@all',
					'--user',
					READER.user,
					'on',
					`>${READER.password}`,
					'~*',
					'+@read',
					'-@write',
					'-@admin',
					'-@dangerous',
				],
			});
		}
		for (const server of servers) {
			await waitFor(`${server.image} ready`, async () => {
				const client = await bootstrap(server);
				try {
					return (await client.send('PING', [])) === 'PONG';
				} finally {
					client.close();
				}
			}, { timeoutMs: 60_000 });
			await seed(server);
		}
	}, 240_000);

	afterAll(async () => {
		await runtime.cleanup();
		await rm(tempDir, { recursive: true, force: true });
	}, 120_000);

	for (const server of servers) {
		const owner = target(server, OWNER);
		const reader = target(server, READER);
		const fixture = {
			object: { path: ['0', 'studio:item:'], kind: 'key-group' } as ObjectRef,
			rowCount: ROW_COUNT,
			keyColumns: ['key'],
			editableColumn: 'value',
			// One SCAN pass covers the whole small keyspace; the plugin lists SCAN's keys as rows.
			selectAllInput: 'SCAN 0 MATCH studio:item:* COUNT 1000',
			// DEBUG is denylisted (and disabled by default); the run is refused at once.
			slowInput: 'DEBUG SLEEP 10',
			writeInput: 'SET studio:item:1 hacked',
			readOnlyEscapes: [
				'FLUSHALL',
				`EVAL "redis.call('del','studio:item:1')" 0`,
				'MULTI',
				'CONFIG SET appendonly no',
				'ACL SETUSER x on',
				'DEL studio:item:2',
			],
			reset: () => resetItems(server),
		};
		describeConformance({ name: `${server.image} (owner credential)`, plugin: keyvaluePlugin, target: owner, fixture });
		describeConformance({
			name: `${server.image} (read-only principal)`,
			plugin: keyvaluePlugin,
			target: owner,
			readOnlyTarget: reader,
			fixture,
		});

		describe(`keyvalue studio: ${server.image}`, () => {
			const signal = () => new AbortController().signal;
			const open = (readOnly: boolean, as = owner) =>
				keyvaluePlugin.connect(as, { readOnly, limits: DEFAULT_STUDIO_LIMITS });

			test('tree groups keys on the delimiter and nests', async () => {
				const session = await open(true, reader);
				try {
					const [root] = await session.tree([], signal());
					expect(root).toMatchObject({ path: ['0'], kind: 'keyspace', browsable: true });
					expect(root?.detail?.rows).toBeGreaterThanOrEqual(ROW_COUNT + 10);

					const top = await session.tree(['0'], signal());
					const group = (name: string) => top.find((n) => n.path.at(-1) === name);
					// `studio:` holds only `studio:item:*`, so the tree skips the level with no choice.
					expect(group('studio:item:')).toMatchObject({ kind: 'key-group', name: 'studio:item:', detail: { rows: ROW_COUNT } });
					expect(group('studio:')).toBeUndefined();
					// `user:` has two subgroups, so it stays a level of its own.
					expect(group('user:')).toMatchObject({ kind: 'key-group', detail: { rows: 3 } });
					// The sample covered the whole keyspace, so nothing is approximate.
					expect(JSON.stringify(top)).not.toContain('approximate');

					// The uncollapsed path is still valid.
					const studio = await session.tree(['0', 'studio:'], signal());
					expect(studio.map((n) => n.path)).toEqual([['0', 'studio:', 'studio:item:']]);
					const items = await session.tree(['0', 'studio:item:'], signal());
					expect(items.length).toBe(ROW_COUNT);
					expect(items[0]).toMatchObject({ kind: 'key', hasChildren: false, browsable: true, detail: { type: 'string' } });

					const users = await session.tree(['0', 'user:'], signal());
					expect(users.map((n) => [n.name, n.kind, n.detail?.rows])).toEqual([
						['1:', 'key-group', 2],
						['2:', 'key-group', 1],
					]);
					const ada = await session.tree(['0', 'user:', 'user:1:'], signal());
					expect(ada.map((n) => [n.path.at(-1), n.kind, n.detail?.type])).toEqual([
						['user:1:email', 'key', 'string'],
						['user:1:name', 'key', 'string'],
					]);

					const fixtureKeys = await session.tree(['0', 'fixture:'], signal());
					const byKey = new Map(fixtureKeys.map((n) => [n.path.at(-1), n]));
					expect(byKey.get('fixture:hash')?.detail?.type).toBe('hash');
					expect(byKey.get('fixture:stream')?.detail?.type).toBe('stream');
					expect(byKey.get('fixture:ttl')?.detail?.ttlMs).toBeGreaterThan(0);
					expect(byKey.get('fixture:hash')?.detail?.ttlMs).toBeUndefined();
				} finally {
					await session.close();
				}
			});

			test('a keyspace browse filters by SCAN TYPE, pattern and client-side key filters', async () => {
				const session = await open(true, reader);
				try {
					const keyspace: ObjectRef = { path: ['0'], kind: 'keyspace' };
					const hashes = await browseAll(session, keyspace, { type: 'hash' });
					expect(hashes.rows.map((r) => r[0])).toEqual(['fixture:hash']);
					const users = await browseAll(session, keyspace, { native: 'user:*:name' });
					expect(users.rows.map((r) => r[0]).sort()).toEqual(['user:1:name', 'user:2:name']);
					const like = await browseAll(session, fixture.object, {
						filter: [{ column: 'key', op: 'like', value: 'studio:item:1_' }],
						sort: [{ column: 'key', dir: 'asc' }],
					});
					expect(like.rows.length).toBe(10);
					expect(like.events.some((e) => e.t === 'notice' && e.message.includes('sorting'))).toBe(true);
					const row = like.rows.find((r) => r[0] === 'studio:item:12');
					expect(row?.slice(1, 3)).toEqual(['string', null]);
					expect(row?.[4]).toBe('item 12');
					expect(typeof row?.[3]).toBe('number');
				} finally {
					await session.close();
				}
			});

			test('a key browses as its contents, per type, page by page', async () => {
				const session = await open(true, reader);
				try {
					const key = (name: string): ObjectRef => ({ path: ['0', 'fixture:', name], kind: 'key' });
					const columns = async (name: string) => (await session.describe(key(name), signal())).columns.map((c) => c.name);

					expect(await columns('fixture:hash')).toEqual(['field', 'value']);
					const hash = await browseAll(session, key('fixture:hash'), { limit: 2 });
					expect(hash.pages).toBeGreaterThan(1);
					expect(Object.fromEntries(hash.rows)).toEqual({ f1: 'v1', f2: 'v2', f3: 'v3', 'f:4': 'v 4' });

					expect(await columns('fixture:list')).toEqual(['index', 'value']);
					const list = await browseAll(session, key('fixture:list'), { limit: 2 });
					expect(list.rows).toEqual([
						[0, 'a'],
						[1, 'b'],
						[2, 'c'],
						[3, 'd'],
						[4, 'e'],
					]);

					expect(await columns('fixture:set')).toEqual(['member']);
					const set = await browseAll(session, key('fixture:set'), { limit: 2 });
					expect(set.rows.map((r) => r[0]).sort()).toEqual(['m1', 'm2', 'm3']);

					expect(await columns('fixture:zset')).toEqual(['member', 'score']);
					const zset = await browseAll(session, key('fixture:zset'), { limit: 2 });
					expect(Object.fromEntries(zset.rows)).toEqual({ a: 1, b: 2.5, c: 3 });

					expect(await columns('fixture:stream')).toEqual(['id', 'fields']);
					const stream = await browseAll(session, key('fixture:stream'), { limit: 2 });
					expect(stream.pages).toBe(2);
					expect(stream.rows).toEqual([
						['1-1', { $t: 'json', v: { event: 'signup', user: '1' } }],
						['2-1', { $t: 'json', v: { event: 'login', user: '1' } }],
						['3-1', { $t: 'json', v: { event: 'logout', user: '1' } }],
					]);

					const string = await browseAll(session, { path: ['0', 'user:', 'user:1:', 'user:1:name'], kind: 'key' }, {});
					expect(string.rows).toEqual([['Ada']]);

					const description = await session.describe(key('fixture:zset'), signal());
					expect(description).toMatchObject({ primaryKey: ['member'], estimate: { rows: 3 }, editable: false });
				} finally {
					await session.close();
				}
			});

			test('TTL edits: set, persist, and a stale TTL conflicts', async () => {
				const session = await open(false);
				const raw = await bootstrap(server);
				try {
					const group: ObjectRef = { path: ['0', 'fixture:'], kind: 'key-group' };
					const ttlOf = async () => {
						const { rows } = await browseAll(session, group, { filter: [{ column: 'key', op: 'eq', value: 'fixture:ttl' }] });
						return rows[0]?.[2] ?? null;
					};
					const before = await ttlOf();
					expect(typeof before).toBe('number');
					const key = { key: 'fixture:ttl' };
					expect(await session.apply(group, [{ op: 'update', key, values: { ttl: 120_000 }, original: { ttl: before } }], signal())).toEqual({
						applied: 1,
						conflicts: [],
					});
					const pttl = Number(await raw.send('PTTL', ['fixture:ttl']));
					expect(pttl).toBeGreaterThan(110_000);
					expect(pttl).toBeLessThanOrEqual(120_000);
					// The TTL we loaded earlier is now stale: someone (we) set a longer one.
					const stale = await session.apply(group, [{ op: 'update', key, values: { ttl: 5_000 }, original: { ttl: 1 } }], signal());
					expect(stale.applied).toBe(0);
					expect(stale.conflicts[0]?.reason).toContain('TTL');
					// Persist, and a value edit keeps (no) TTL as it was.
					expect((await session.apply(group, [{ op: 'update', key, values: { ttl: null }, original: { ttl: await ttlOf() } }], signal())).applied).toBe(1);
					expect(Number(await raw.send('PTTL', ['fixture:ttl']))).toBe(-1);
					expect(await ttlOf()).toBeNull();
					// Bad TTLs are refused before anything runs.
					await expect(session.apply(group, [{ op: 'update', key, values: { ttl: -5 }, original: {} }], signal())).rejects.toThrow(/TTL/);
				} finally {
					await raw.send('SET', ['fixture:ttl', 'soon', 'PX', '3600000']);
					raw.close();
					await session.close();
				}
			});

			test('alter renames a key (never overwriting) and deletes it', async () => {
				const session = await open(false);
				const raw = await bootstrap(server);
				const keyRef = (name: string): ObjectRef => ({ path: ['0', name], kind: 'key' });
				const code = async (work: Promise<unknown>) => {
					try {
						await work;
						return null;
					} catch (error) {
						return error instanceof StudioError ? error.code : 'other';
					}
				};
				try {
					await raw.send('DEL', ['alter:a', 'alter:b', 'alter:taken']);
					await raw.send('HSET', ['alter:a', 'f', 'v']);
					await raw.send('PEXPIRE', ['alter:a', '600000']);
					await raw.send('SET', ['alter:taken', 'keep']);

					const dry = await session.alter!({ op: 'rename', object: keyRef('alter:a'), name: 'alter:b' }, { dryRun: true }, signal());
					expect(dry).toEqual({ statements: ['RENAMENX "alter:a" "alter:b"'], applied: false });
					expect(Number(await raw.send('EXISTS', ['alter:a']))).toBe(1);

					expect(await code(session.alter!({ op: 'rename', object: keyRef('alter:a'), name: 'alter:taken' }, { dryRun: false }, signal()))).toBe(
						'conflict',
					);
					expect(await raw.send('GET', ['alter:taken'])).toBe('keep');

					expect(
						await session.alter!({ op: 'rename', object: keyRef('alter:a'), name: 'alter:b' }, { dryRun: false }, signal()),
					).toEqual({ statements: ['RENAMENX "alter:a" "alter:b"'], applied: true });
					expect(Number(await raw.send('EXISTS', ['alter:a']))).toBe(0);
					expect(await raw.send('HGET', ['alter:b', 'f'])).toBe('v');
					// RENAMENX keeps the TTL.
					expect(Number(await raw.send('PTTL', ['alter:b']))).toBeGreaterThan(0);

					expect(await code(session.alter!({ op: 'rename', object: keyRef('alter:a'), name: 'alter:c' }, { dryRun: true }, signal()))).toBe(
						'not_found',
					);
					expect(
						await code(
							session.alter!({ op: 'drop', object: { path: ['0', 'alter:'], kind: 'key-group' }, cascade: false }, { dryRun: true }, signal()),
						),
					).toBe('unsupported');
					expect(await code(session.alter!({ op: 'truncate', object: keyRef('alter:b') }, { dryRun: true }, signal()))).toBe('unsupported');

					expect(
						await session.alter!({ op: 'drop', object: keyRef('alter:b'), cascade: false }, { dryRun: false }, signal()),
					).toEqual({ statements: ['UNLINK "alter:b"'], applied: true });
					expect(Number(await raw.send('EXISTS', ['alter:b']))).toBe(0);

					// The read-only principal is refused before anything is sent.
					const readOnly = await open(true, reader);
					try {
						expect(
							await code(readOnly.alter!({ op: 'drop', object: keyRef('alter:taken'), cascade: false }, { dryRun: true }, signal())),
						).toBe('read_only');
					} finally {
						await readOnly.close();
					}
					expect(await raw.send('GET', ['alter:taken'])).toBe('keep');
				} finally {
					await raw.send('DEL', ['alter:a', 'alter:b', 'alter:taken']);
					raw.close();
					await session.close();
				}
			});

			test('a string value edit keeps the TTL; a stale original conflicts and the batch is all-or-nothing', async () => {
				const session = await open(false);
				const raw = await bootstrap(server);
				try {
					const ttlBefore = Number(await raw.send('PTTL', ['studio:item:1']));
					expect(ttlBefore).toBeGreaterThan(0);
					const ok = await session.apply(
						fixture.object,
						[{ op: 'update', key: { key: 'studio:item:1' }, values: { value: 'edited' }, original: { value: 'item 1' } }],
						signal(),
					);
					expect(ok).toEqual({ applied: 1, conflicts: [] });
					expect(Number(await raw.send('PTTL', ['studio:item:1']))).toBeGreaterThan(0);

					const batch = await session.apply(
						fixture.object,
						[
							{ op: 'update', key: { key: 'studio:item:2' }, values: { value: 'should not land' }, original: { value: 'item 2' } },
							{ op: 'update', key: { key: 'studio:item:3' }, values: { value: 'x' }, original: { value: 'not what is there' } },
							{ op: 'insert', values: { key: 'studio:item:4', value: 'dup' } },
						],
						signal(),
					);
					expect(batch.applied).toBe(0);
					expect(batch.conflicts.map((c) => c.index)).toEqual([1, 2]);
					expect(await raw.send('GET', ['studio:item:2'])).toBe('item 2');

					// Insert with a TTL, then delete with its original.
					expect(
						(await session.apply(fixture.object, [{ op: 'insert', values: { key: 'studio:item:new', value: 'fresh', ttl: 60_000 } }], signal())).applied,
					).toBe(1);
					expect(Number(await raw.send('PTTL', ['studio:item:new']))).toBeGreaterThan(0);
					expect(
						(await session.apply(fixture.object, [{ op: 'delete', key: { key: 'studio:item:new' }, original: { value: 'fresh' } }], signal()))
							.applied,
					).toBe(1);
					expect(await raw.send('EXISTS', ['studio:item:new'])).toBe(0);
					// Keys outside the group are refused.
					await expect(
						session.apply(fixture.object, [{ op: 'insert', values: { key: 'elsewhere', value: 'x' } }], signal()),
					).rejects.toThrow(/outside the group/);
				} finally {
					raw.close();
					await session.close();
					await resetItems(server);
				}
			});

			test('edits inside keys: hash fields (with a stale original), set, zset, list', async () => {
				const session = await open(false);
				const raw = await bootstrap(server);
				const key = (name: string): ObjectRef => ({ path: ['0', 'fixture:', name], kind: 'key' });
				try {
					const hash = key('fixture:hash');
					const update = { op: 'update' as const, key: { field: 'f1' }, values: { value: 'new' }, original: { value: 'v1' } };
					expect(await session.apply(hash, [update], signal())).toEqual({ applied: 1, conflicts: [] });
					const stale = await session.apply(hash, [update], signal());
					expect(stale.applied).toBe(0);
					expect(stale.conflicts[0]?.reason).toContain('f1');
					expect(
						await session.apply(
							hash,
							[
								{ op: 'insert', values: { field: 'f9', value: 'nine' } },
								{ op: 'delete', key: { field: 'f2' }, original: { value: 'v2' } },
							],
							signal(),
						),
					).toEqual({ applied: 2, conflicts: [] });
					expect(await raw.send('HGETALL', ['fixture:hash'])).toEqual({ f1: 'new', f3: 'v3', 'f:4': 'v 4', f9: 'nine' });
					// A stale delete plus a valid insert: nothing lands.
					const mixed = await session.apply(
						hash,
						[
							{ op: 'insert', values: { field: 'f10', value: 'ten' } },
							{ op: 'delete', key: { field: 'f3' }, original: { value: 'old' } },
						],
						signal(),
					);
					expect(mixed.applied).toBe(0);
					expect(await raw.send('HEXISTS', ['fixture:hash', 'f10'])).toBe(0);

					expect(
						await session.apply(
							key('fixture:set'),
							[
								{ op: 'insert', values: { member: 'm4' } },
								{ op: 'delete', key: { member: 'm1' } },
								{ op: 'update', key: { member: 'm2' }, values: { member: 'm2b' }, original: {} },
							],
							signal(),
						),
					).toEqual({ applied: 3, conflicts: [] });
					expect(((await raw.send('SMEMBERS', ['fixture:set'])) as string[]).sort()).toEqual(['m2b', 'm3', 'm4']);

					const zset = key('fixture:zset');
					expect(
						await session.apply(zset, [{ op: 'update', key: { member: 'b' }, values: { score: 7 }, original: { score: 2.5 } }], signal()),
					).toEqual({ applied: 1, conflicts: [] });
					expect(Number(await raw.send('ZSCORE', ['fixture:zset', 'b']))).toBe(7);
					const zstale = await session.apply(zset, [{ op: 'update', key: { member: 'b' }, values: { score: 8 }, original: { score: 2.5 } }], signal());
					expect(zstale.applied).toBe(0);

					// List: deletes and updates refer to indexes as loaded.
					expect(
						await session.apply(
							key('fixture:list'),
							[
								{ op: 'delete', key: { index: 0 }, original: { value: 'a' } },
								{ op: 'update', key: { index: 2 }, values: { value: 'C' }, original: { value: 'c' } },
								{ op: 'delete', key: { index: 3 }, original: { value: 'd' } },
								{ op: 'insert', values: { value: 'f' } },
							],
							signal(),
						),
					).toEqual({ applied: 4, conflicts: [] });
					expect(await raw.send('LRANGE', ['fixture:list', '0', '-1'])).toEqual(['b', 'C', 'e', 'f']);

					// Rows of the wrong shape for the key's type are conflicts, never writes.
					const wrong = await session.apply(hash, [{ op: 'delete', key: { member: 'm3' } }], signal());
					expect(wrong.applied).toBe(0);
				} finally {
					raw.close();
					await session.close();
					await seedCollections(server);
				}
			});

			test('a timed-out run closes and replaces the run client', async () => {
				const session = await open(false);
				const raw = await bootstrap(server);
				try {
					expect(rowsOf(await collect(session.run('DBSIZE', { maxRows: 10, timeoutMs: 5_000 }, signal())))).toHaveLength(1);
					// Earlier sessions' connections may still be closing on the server.
					let before: string[] = [];
					await waitFor('two studio connections', async () => (before = await studioClients(raw)).length === 2, {
						timeoutMs: 5_000,
						intervalMs: 100,
					});

					const error = await collect(session.run(`LRANGE fixture:big 0 -1`, { maxRows: 10, timeoutMs: 1 }, signal())).then(
						() => null,
						(e: unknown) => e,
					);
					expect(error).toBeInstanceOf(StudioError);
					expect((error as StudioError).code).toBe('timeout');

					// The next run gets its own answer, not the abandoned LRANGE reply.
					const next = await collect(session.run('GET studio:item:3', { maxRows: 10, timeoutMs: 5_000 }, signal()));
					expect(rowsOf(next)).toEqual([['item 3']]);
					await waitFor('old run connection closed', async () => {
						const after = await studioClients(raw);
						return after.length === 2 && after.filter((id) => before.includes(id)).length === 1;
					}, { timeoutMs: 5_000, intervalMs: 100 });

					// An abort takes the same path and reports `cancelled`.
					const controller = new AbortController();
					const run = collect(session.run('LRANGE fixture:big 0 -1', { maxRows: 10, timeoutMs: 30_000 }, controller.signal));
					controller.abort();
					const aborted = await run.then(
						() => null,
						(e: unknown) => e,
					);
					expect((aborted as StudioError | null)?.code).toBe('cancelled');
					expect(rowsOf(await collect(session.run('GET studio:item:4', { maxRows: 10, timeoutMs: 5_000 }, signal())))).toEqual([['item 4']]);
				} finally {
					raw.close();
					await session.close();
				}
			});

			test('run: gate, reply shapes and the read-only principal without COMMAND INFO', async () => {
				const ro = await open(true, reader);
				const rw = await open(false);
				try {
					const table = async (session: StudioSession, input: string) => {
						const events = await collect(session.run(input, { maxRows: 1_000, timeoutMs: 10_000 }, signal()));
						const columns = events.find((e) => e.t === 'columns');
						return { events, columns: columns?.t === 'columns' ? columns.columns.map((c) => c.name) : [], rows: rowsOf(events) };
					};
					// The read-only principal may not run COMMAND INFO; the static list lets reads through.
					expect((await table(ro, 'GET "studio:item:9"')).rows).toEqual([['item 9']]);
					expect((await table(ro, 'MEMORY USAGE studio:item:9 SAMPLES 0')).rows[0]?.[0]).toBeGreaterThan(0);
					expect((await table(ro, 'HGETALL fixture:hash')).columns).toEqual(['field', 'value']);
					expect((await table(ro, 'LRANGE fixture:list 0 -1')).columns).toEqual(['index', 'value']);
					expect((await table(ro, 'ZRANGE fixture:zset 0 -1 WITHSCORES')).rows[0]).toEqual([0, { $t: 'json', v: ['a', 1] }]);
					await expect(collect(ro.run('SET a b', { maxRows: 1, timeoutMs: 1_000 }, signal()))).rejects.toMatchObject({ code: 'read_only' });
					await expect(collect(ro.run('KEYS *', { maxRows: 1, timeoutMs: 1_000 }, signal()))).rejects.toMatchObject({ code: 'forbidden' });
					await expect(collect(ro.run('GET "unterminated', { maxRows: 1, timeoutMs: 1_000 }, signal()))).rejects.toMatchObject({
						code: 'bad_request',
					});

					// Write session: engine errors are error events; FLUSHDB warns (run on a scratch db is not
					// possible here, so only check the warning path on a command the gate lets through).
					const wrongType = await table(rw, 'LPUSH studio:item:9 x');
					expect(wrongType.events.find((e) => e.t === 'error')).toMatchObject({ code: 'engine_error' });
					expect((await table(rw, 'SET "fixture:quoted key" "a b\\x41"')).rows).toEqual([['OK']]);
					expect(await raw(server, (c) => c.send('GET', ['fixture:quoted key']))).toBe('a bA');
					await expect(collect(rw.run('BLPOP q 0', { maxRows: 1, timeoutMs: 1_000 }, signal()))).rejects.toMatchObject({ code: 'forbidden' });
					await expect(collect(rw.run('SELECT 1', { maxRows: 1, timeoutMs: 1_000 }, signal()))).rejects.toMatchObject({ code: 'forbidden' });
				} finally {
					await raw(server, (c) => c.send('DEL', ['fixture:quoted key']));
					await ro.close();
					await rw.close();
				}
			});

			test('binary and large values: bytes cells, previews, full values and byte-exact edits', async () => {
				const session = await open(false);
				try {
					const group: ObjectRef = { path: ['0', 'fixture:'], kind: 'key-group' };
					const { rows } = await browseAll(session, group, { filter: [{ column: 'type', op: 'eq', value: 'string' }] });
					const value = (key: string) => rows.find((r) => r[0] === key)?.[4];
					const bytes: Cell = { $t: 'bytes', v: Buffer.from(BINARY).toString('base64') };
					expect(value('fixture:bin')).toEqual(bytes);
					expect(value('fixture:utf8')).toBe('héllo ✓ 🔑');
					expect(value('fixture:large')).toEqual({ $t: 'truncated', v: 'x'.repeat(4_096), bytes: LARGE.length });
					expect(await session.value?.(group, { key: 'fixture:large' }, 'value', signal())).toBe(LARGE);
					expect(await session.value?.(group, { key: 'fixture:bin' }, 'value', signal())).toEqual(bytes);
					expect(await session.value?.(group, { key: 'fixture:hash' }, 'value', signal())).toEqual({
						$t: 'json',
						v: { f1: 'v1', f2: 'v2', f3: 'v3', 'f:4': 'v 4' },
					});

					const replacement = new Uint8Array([0x00, 0x01, 0x80]);
					const next: Cell = { $t: 'bytes', v: Buffer.from(replacement).toString('base64') };
					expect(
						await session.apply(group, [{ op: 'update', key: { key: 'fixture:bin' }, values: { value: next }, original: { value: bytes } }], signal()),
					).toEqual({ applied: 1, conflicts: [] });
					const stored = await raw(server, (c) => c.getBuffer('fixture:bin'));
					expect([...(stored ?? [])]).toEqual([...replacement]);
					// The old bytes are now a stale original.
					const stale = await session.apply(
						group,
						[{ op: 'update', key: { key: 'fixture:bin' }, values: { value: bytes }, original: { value: bytes } }],
						signal(),
					);
					expect(stale.applied).toBe(0);
					// A truncated preview cannot stand in for the original.
					await expect(
						session.apply(
							group,
							[{ op: 'update', key: { key: 'fixture:large' }, values: { value: 'y' }, original: { value: value('fixture:large') ?? null } }],
							signal(),
						),
					).rejects.toThrow(/truncated/);
				} finally {
					await session.close();
					await seedCollections(server);
				}
			});
		});
	}
}

// ---------------------------------------------------------------- helpers

function target(server: Server, credential: { user: string; password: string }): StudioTarget {
	return {
		engine: server.engine,
		version: server.version,
		host: '127.0.0.1',
		port: server.port,
		database: '0',
		user: credential.user,
		password: credential.password,
		tls: null,
	};
}

/** Prefer an image already present; otherwise pull the first candidate that exists. */
async function pickImage(runtime: ContainerRuntime, candidates: string[]): Promise<string> {
	for (const image of candidates)
		if ((await runtime.exec(['image', 'inspect', image], { check: false, timeoutMs: 30_000 })).code === 0) return image;
	for (const image of candidates)
		if ((await runtime.exec(['pull', image], { check: false, timeoutMs: 300_000 })).code === 0) return image;
	throw new Error(`None of ${candidates.join(', ')} could be found or pulled.`);
}

async function bootstrap(server: Server): Promise<RedisClient> {
	const url = `redis://${encodeURIComponent(OWNER.user)}:${encodeURIComponent(OWNER.password)}@127.0.0.1:${server.port}/0`;
	const client = new RedisClient(url, { autoReconnect: false });
	await client.connect();
	return client;
}

async function raw<T>(server: Server, fn: (client: RedisClient) => Promise<T>): Promise<T> {
	const client = await bootstrap(server);
	try {
		return await fn(client);
	} finally {
		client.close();
	}
}

async function seed(server: Server): Promise<void> {
	await raw(server, async (client) => {
		await client.send('FLUSHALL', []);
		// A big list for the timeout test: its LRANGE takes far longer than 1 ms.
		for (let start = 0; start < BIG_LIST; start += 10_000)
			await client.send('RPUSH', ['fixture:big', ...Array.from({ length: 10_000 }, (_, i) => `element ${start + i}`)]);
		await client.send('MSET', ['user:1:name', 'Ada', 'user:1:email', 'ada@example.com', 'user:2:name', 'Grace']);
	});
	await resetItems(server);
	await seedCollections(server);
}

/** The 250 standard rows, with a TTL on the first five. */
async function resetItems(server: Server): Promise<void> {
	await raw(server, async (client) => {
		const args = Array.from({ length: ROW_COUNT }, (_, i) => [`studio:item:${i + 1}`, `item ${i + 1}`]).flat();
		await client.send('MSET', args);
		for (let id = 1; id <= 5; id += 1) await client.send('PEXPIRE', [`studio:item:${id}`, '3600000']);
		await client.send('DEL', ['studio:item:new']);
	});
}

async function seedCollections(server: Server): Promise<void> {
	await raw(server, async (client) => {
		await client.send('DEL', ['fixture:hash', 'fixture:list', 'fixture:set', 'fixture:zset', 'fixture:stream']);
		await client.send('HSET', ['fixture:hash', 'f1', 'v1', 'f2', 'v2', 'f3', 'v3', 'f:4', 'v 4']);
		await client.send('RPUSH', ['fixture:list', 'a', 'b', 'c', 'd', 'e']);
		await client.send('SADD', ['fixture:set', 'm1', 'm2', 'm3']);
		await client.send('ZADD', ['fixture:zset', '1', 'a', '2.5', 'b', '3', 'c']);
		await client.send('XADD', ['fixture:stream', '1-1', 'event', 'signup', 'user', '1']);
		await client.send('XADD', ['fixture:stream', '2-1', 'event', 'login', 'user', '1']);
		await client.send('XADD', ['fixture:stream', '3-1', 'event', 'logout', 'user', '1']);
		await client.send('SET', ['fixture:ttl', 'soon', 'PX', '3600000']);
		await client.set('fixture:bin', BINARY);
		await client.send('SET', ['fixture:utf8', 'héllo ✓ 🔑']);
		await client.send('SET', ['fixture:large', LARGE]);
	});
}

/** Connection ids named `skiff-studio`, from CLIENT LIST. */
async function studioClients(client: RedisClient): Promise<string[]> {
	const list = String(await client.send('CLIENT', ['LIST']));
	return list
		.split('\n')
		.filter((line) => /\bname=skiff-studio\b/.test(line))
		.map((line) => /\bid=(\d+)/.exec(line)?.[1] ?? '')
		.filter(Boolean);
}

async function browseAll(
	session: StudioSession,
	object: ObjectRef,
	query: { limit?: number; type?: string; native?: string; filter?: any[]; sort?: any[] },
): Promise<{ rows: Cell[][]; pages: number; events: StudioEvent[] }> {
	const rows: Cell[][] = [];
	const all: StudioEvent[] = [];
	let cursor: string | undefined;
	let pages = 0;
	for (; pages < 1_000; ) {
		const events = await collect(
			session.browse(
				object,
				{ limit: query.limit ?? 100, cursor, sort: query.sort ?? [], filter: query.filter ?? [], type: query.type, native: query.native },
				new AbortController().signal,
			),
		);
		pages += 1;
		all.push(...events);
		rows.push(...rowsOf(events));
		const page = events.find((e) => e.t === 'page');
		if (page?.t !== 'page' || page.next === null) break;
		cursor = page.next;
	}
	return { rows, pages, events: all };
}
