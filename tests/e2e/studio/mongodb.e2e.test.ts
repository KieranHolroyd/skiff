/**
 * MongoDB studio plugin end-to-end (plan 22, Phase 2 track C): the shared conformance suite plus
 * document-specific checks, against a disposable `mongo:8.0` (and `mongo:9.0` when the image is
 * present). Mirrors Skiff: a standalone `mongod`, users in the `admin` auth database.
 *
 *   SKIFF_E2E_STUDIO=1 SKIFF_E2E_ENGINE=docker bun test tests/e2e/studio/mongodb.e2e.test.ts
 *
 * Without `SKIFF_E2E_STUDIO=1` it registers one skipped test, so the root `bun test` stays fast.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collect, describeConformance, rowsOf } from '../../../packages/studio/src/conformance.ts';
import type { StudioSession, StudioTarget } from '../../../packages/studio/src/driver.ts';
import { mongodbPlugin } from '../../../packages/studio/src/plugins/mongodb/index.ts';
// `mongodb` and `@skiff/contracts` resolve only inside packages/studio.
import { BSON, DEFAULT_STUDIO_LIMITS, MongoClient } from '../../../packages/studio/src/plugins/mongodb/test-support.ts';
import { StudioError, type Cell, type StudioEvent } from '../../../packages/studio/src/protocol.ts';
import { ContainerRuntime, detectEngine, freePort, waitFor } from '../lib/containers.ts';

const ROW_COUNT = 250;
const ROOT = { user: 'root', password: 'root-pw' };
const OWNER = { user: 'app_owner', password: 'owner p@ss:/?' };
const READER = { user: 'skiff_studio_ro', password: 'reader-pw' };
const COLLECTION = 'studio_items';
const VIEW = 'studio_item_names';

/** Deterministic fixture: the same `_id`s on every reset, so restored state is identical. */
const ids = Array.from({ length: ROW_COUNT }, (_, i) => new BSON.ObjectId(`64b7f0${String(i + 1).padStart(18, '0')}`));
function fixtureDocs(): BSON.Document[] {
	return ids.map((_id, i) => {
		const n = i + 1;
		return {
			_id,
			name: `item ${String(n).padStart(3, '0')}`,
			amount: BSON.Decimal128.fromString(`${n}.25`),
			big: BSON.Long.fromBigInt(BigInt(n) * 100_000_000_000_000_000n),
			data: new BSON.Binary(Buffer.from([n % 256, 0, 255])),
			meta: { even: n % 2 === 0, tags: ['a', String(n)] },
			created: new Date(Date.UTC(2026, 0, 1, 0, 0, n)),
		};
	});
}

interface Instance {
	image: string;
	version: string;
	port: number;
	name: string;
}

if (process.env.SKIFF_E2E_STUDIO !== '1') {
	test.skip('mongodb studio e2e (set SKIFF_E2E_STUDIO=1 to run)', () => {});
} else {
	const engine = await detectEngine();
	if (!engine) throw new Error('SKIFF_E2E_STUDIO=1 needs Podman or Docker (or set SKIFF_E2E_ENGINE).');
	const probe = new ContainerRuntime(engine, tmpdir());
	const hasImage = async (image: string) =>
		(await probe.exec(['image', 'inspect', image], { check: false, timeoutMs: 30_000 })).code === 0;

	const instances: Instance[] = [];
	for (const version of ['8.0', '9.0']) {
		const image = `mongo:${version}`;
		// 8.0 is required (pulled if needed); 9.0 only when the image is already present.
		if (version !== '8.0' && !(await hasImage(image))) continue;
		instances.push({ image, version, port: await freePort(), name: `studio-mongo-${version.replace('.', '')}-${process.pid}` });
	}

	let runtime: ContainerRuntime | null = null;
	let tempDir = '';
	const admins = new Map<string, MongoClient>();

	const target = (instance: Instance, who: { user: string; password: string }): StudioTarget => ({
		engine: 'mongodb',
		version: instance.version,
		host: '127.0.0.1',
		port: instance.port,
		database: 'app',
		user: who.user,
		password: who.password,
		tls: null,
	});

	const reset = async (instance: Instance) => {
		const app = admins.get(instance.name)!.db('app');
		await app.collection(COLLECTION).deleteMany({});
		await app.collection(COLLECTION).insertMany(fixtureDocs());
	};

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'skiff-studio-mongo-'));
		runtime = new ContainerRuntime(engine, tempDir);
		const network = `studio-mongo-net-${runtime.runId}`;
		await runtime.createNetwork(network);
		await Promise.all(
			instances.map((instance) =>
				runtime!.runContainer({
					name: instance.name,
					image: instance.image,
					network,
					ports: [[instance.port, 27017]],
					env: { MONGO_INITDB_ROOT_USERNAME: ROOT.user, MONGO_INITDB_ROOT_PASSWORD: ROOT.password },
				}),
			),
		);
		await Promise.all(
			instances.map(async (instance) => {
				const url = `mongodb://${ROOT.user}:${ROOT.password}@127.0.0.1:${instance.port}/?authSource=admin&directConnection=true`;
				let client: MongoClient | null = null;
				await waitFor(
					instance.image,
					async () => {
						client = new MongoClient(url, { serverSelectionTimeoutMS: 2_000 });
						try {
							await client.db('admin').command({ ping: 1 });
							return true;
						} catch (error) {
							await client.close().catch(() => undefined);
							throw error;
						}
					},
					{ timeoutMs: 120_000, intervalMs: 1_000 },
				);
				const admin = client! as MongoClient;
				admins.set(instance.name, admin);
				// Skiff's shape: users live in `admin`, scoped to the app database.
				await admin.db('admin').command({ createUser: OWNER.user, pwd: OWNER.password, roles: [{ role: 'readWrite', db: 'app' }] });
				await admin.db('admin').command({ createUser: READER.user, pwd: READER.password, roles: [{ role: 'read', db: 'app' }] });
				const app = admin.db('app');
				await app.collection(COLLECTION).insertMany(fixtureDocs());
				await app.createCollection(VIEW, { viewOn: COLLECTION, pipeline: [{ $project: { name: 1 } }] });
				// Mixed `_id` types, for keyset paging across BSON type brackets.
				await app.collection('mixed_ids').insertMany([
					{ _id: 3 as never, v: 1 },
					{ _id: BSON.Long.fromString('9007199254740993') as never, v: 2 },
					{ _id: 'b' as never, v: 3 },
					{ _id: 'a' as never, v: 4 },
					{ _id: new BSON.ObjectId() as never, v: 5 },
					{ _id: new Date(0) as never, v: 6 },
					{ _id: 1.5 as never, v: 7 },
				]);
			}),
		);
	}, 300_000);

	afterAll(async () => {
		for (const client of admins.values()) await client.close().catch(() => undefined);
		await runtime?.cleanup();
		if (tempDir) await rm(tempDir, { recursive: true, force: true });
	}, 120_000);

	const fixture = (instance: Instance) => ({
		object: { path: [COLLECTION], kind: 'collection' as const },
		rowCount: ROW_COUNT,
		keyColumns: ['_id'],
		editableColumn: 'name',
		selectAllInput: `{"find":"${COLLECTION}","filter":{}}`,
		slowInput: `{"find":"${COLLECTION}","filter":{"$where":"sleep(100) || true"}}`,
		writeInput: `{"delete":"${COLLECTION}","deletes":[{"q":{},"limit":0}]}`,
		readOnlyEscapes: [
			`{"aggregate":"${COLLECTION}","pipeline":[{"$out":"x"}],"cursor":{}}`,
			`{"aggregate":"${COLLECTION}","pipeline":[{"$facet":{"a":[{"$merge":{"into":"x"}}]}}],"cursor":{}}`,
			`{"drop":"${COLLECTION}"}`,
			`{"insert":"${COLLECTION}","documents":[{"a":1}]}`,
			`{"update":"${COLLECTION}","updates":[{"q":{},"u":{"$set":{"name":"x"}},"multi":true}]}`,
			'{"dropDatabase":1}',
			'{"eval":"1"}',
		],
		reset: () => reset(instance),
		scratchCreate: { op: 'create-collection' as const, parent: [], name: 'conformance_scratch' },
	});

	for (const instance of instances) {
		// Interim: activations carry the owner credential, read-only rests on the session flag.
		describeConformance({
			name: `mongodb ${instance.version} (owner credential)`,
			plugin: mongodbPlugin,
			target: target(instance, OWNER),
			fixture: fixture(instance),
		});
		// Phase 3: read-only sessions connect as a `read`-role principal.
		describeConformance({
			name: `mongodb ${instance.version} (read-role credential)`,
			plugin: mongodbPlugin,
			target: target(instance, OWNER),
			readOnlyTarget: target(instance, READER),
			fixture: fixture(instance),
		});
	}

	describe('mongodb studio: document specifics', () => {
		const instance = instances[0]!;
		const signal = () => new AbortController().signal;
		const open = (readOnly: boolean, who = OWNER): Promise<StudioSession> =>
			mongodbPlugin.connect(target(instance, who), { readOnly, limits: DEFAULT_STUDIO_LIMITS });
		const run = (session: StudioSession, input: string, timeoutMs = 10_000) =>
			collect(session.run(input, { maxRows: 1_000, timeoutMs }, signal()));
		const columnsOf = (events: StudioEvent[]) => {
			const event = events.find((e) => e.t === 'columns');
			return event?.t === 'columns' ? event.columns.map((c) => c.name) : [];
		};
		const cell = (events: StudioEvent[], row: Cell[], name: string) => row[columnsOf(events).indexOf(name)] ?? null;

		test('describe infers fields, types, the key and indexes', async () => {
			const session = await open(false);
			try {
				const description = await session.describe({ path: [COLLECTION], kind: 'collection' }, signal());
				const byName = Object.fromEntries(description.columns.map((c) => [c.name, c]));
				expect(description.columns[0]?.name).toBe('_id');
				expect(byName._id).toMatchObject({ kind: 'objectid', key: 'primary', editable: false });
				expect(byName.name?.kind).toBe('text');
				expect(byName.amount?.kind).toBe('decimal');
				expect(byName.big?.kind).toBe('bigint');
				expect(byName.data?.kind).toBe('bytes');
				expect(byName.meta?.kind).toBe('document');
				expect(byName.created?.kind).toBe('datetime');
				expect(description.primaryKey).toEqual(['_id']);
				expect(description.indexes.map((i) => i.name)).toContain('_id_');
				expect(description.editable).toBe(true);
				expect(description.estimate?.rows).toBe(ROW_COUNT);
			} finally {
				await session.close();
			}
		});

		test('EJSON values round-trip through browse → apply → browse', async () => {
			const session = await open(false);
			const object = { path: [COLLECTION], kind: 'collection' as const };
			try {
				const first = await collect(session.browse(object, { limit: 1, sort: [], filter: [] }, signal()));
				const row = rowsOf(first)[0]!;
				const id = cell(first, row, '_id');
				expect(id).toEqual({ $t: 'ejson', v: { $oid: ids[0]!.toHexString() } });
				expect(cell(first, row, 'big')).toEqual({ $t: 'ejson', v: { $numberLong: '100000000000000000' } });
				expect(cell(first, row, 'amount')).toEqual({ $t: 'ejson', v: { $numberDecimal: '1.25' } });

				const values: Record<string, Cell> = {
					big: { $t: 'ejson', v: { $numberLong: '9007199254740993' } },
					amount: { $t: 'ejson', v: { $numberDecimal: '0.1000000000000000000000000000000001' } },
					meta: { $t: 'ejson', v: { nested: { when: { $date: { $numberLong: '1700000000123' } }, n: { $numberLong: '42' } } } },
					data: { $t: 'ejson', v: { $binary: { base64: 'AAEC/w==', subType: '00' } } },
				};
				const original = Object.fromEntries(Object.keys(values).map((k) => [k, cell(first, row, k)]));
				expect(await session.apply(object, [{ op: 'update', key: { _id: id }, values, original }], signal())).toEqual({
					applied: 1,
					conflicts: [],
				});

				const again = await collect(
					session.browse(object, { limit: 5, sort: [], filter: [{ column: '_id', op: 'eq', value: id }] }, signal()),
				);
				const after = rowsOf(again)[0]!;
				for (const [name, value] of Object.entries(values)) expect(cell(again, after, name)).toEqual(value);
				// The server holds real BSON types, not strings or doubles.
				const stored = await admins.get(instance.name)!.db('app').collection(COLLECTION).findOne({ _id: ids[0] });
				expect((stored?.big as BSON.Long | undefined)?.toString()).toBe('9007199254740993');
				expect(stored?.amount?._bsontype).toBe('Decimal128');
				expect(stored?.meta?.nested?.when instanceof Date).toBe(true);
			} finally {
				await session.close();
				await reset(instance);
			}
		});

		test('apply validates every change before writing any', async () => {
			const session = await open(false);
			const object = { path: [COLLECTION], kind: 'collection' as const };
			try {
				const key = (i: number) => ({ _id: { $t: 'ejson' as const, v: { $oid: ids[i]!.toHexString() } } });
				const result = await session.apply(
					object,
					[
						{ op: 'update', key: key(1), values: { name: 'changed' }, original: { name: 'item 002' } },
						{ op: 'delete', key: key(2), original: { name: 'stale value' } },
					],
					signal(),
				);
				expect(result.applied).toBe(0);
				expect(result.conflicts).toEqual([{ index: 1, reason: expect.stringContaining('changed since it was loaded') }]);
				const doc = await admins.get(instance.name)!.db('app').collection(COLLECTION).findOne({ _id: ids[1] });
				expect(doc?.name).toBe('item 002');
			} finally {
				await session.close();
			}
		});

		test('native EJSON filter ANDs with structured filters', async () => {
			const session = await open(true, READER);
			try {
				const events = await collect(
					session.browse(
						{ path: [COLLECTION], kind: 'collection' },
						{ limit: 100, sort: [{ column: 'name', dir: 'desc' }], native: '{"meta.even":true}', filter: [{ column: 'name', op: 'like', value: 'item 00%' }] },
						signal(),
					),
				);
				const names = rowsOf(events).map((row) => cell(events, row, 'name'));
				expect(names).toEqual(['item 008', 'item 006', 'item 004', 'item 002']);
				expect(events.find((e) => e.t === 'page')).toEqual({ t: 'page', next: null });
			} finally {
				await session.close();
			}
		});

		test('keyset paging crosses mixed _id types exactly once', async () => {
			const session = await open(true, READER);
			try {
				for (const dir of ['asc', 'desc'] as const) {
					const seen: number[] = [];
					let cursor: string | undefined;
					for (let i = 0; i < 20; i += 1) {
						const events = await collect(
							session.browse({ path: ['mixed_ids'], kind: 'collection' }, { limit: 2, cursor, sort: [{ column: '_id', dir }], filter: [] }, signal()),
						);
						for (const row of rowsOf(events)) seen.push(Number(cell(events, row, 'v')));
						const page = events.find((e) => e.t === 'page');
						if (page?.t !== 'page' || !page.next) break;
						cursor = page.next;
					}
					const expected = [7, 1, 2, 4, 3, 5, 6]; // numbers (1.5, 3, 2^53+1), strings, ObjectId, Date
					expect(seen).toEqual(dir === 'asc' ? expected : [...expected].reverse());
				}
			} finally {
				await session.close();
			}
		});

		test('a non-cursor command answers one document; writes report affected', async () => {
			const session = await open(false);
			try {
				const count = await run(session, `{"count":"${COLLECTION}"}`);
				expect(columnsOf(count)).toEqual(['result']);
				const doc = rowsOf(count)[0]?.[0];
				expect(doc).toMatchObject({ $t: 'ejson', v: { n: { $numberInt: String(ROW_COUNT) } } });

				const insert = await run(session, `{"insert":"${COLLECTION}","documents":[{"_id":"tmp-1","name":"tmp"}]}`);
				expect(insert.find((e) => e.t === 'result')).toEqual({ t: 'result', command: 'insert', affected: 1 });
				const remove = await run(session, `{"delete":"${COLLECTION}","deletes":[{"q":{"_id":"tmp-1"},"limit":1}]}`);
				expect(remove.find((e) => e.t === 'result')).toEqual({ t: 'result', command: 'delete', affected: 1 });

				const listed = await run(session, '{"listCollections":1,"nameOnly":true}');
				expect(JSON.stringify(rowsOf(listed)[0])).toContain(COLLECTION);
			} finally {
				await session.close();
			}
		});

		test('aggregate streams documents; countDocuments works', async () => {
			const session = await open(true, READER);
			try {
				const events = await run(
					session,
					`{"aggregate":"${COLLECTION}","pipeline":[{"$group":{"_id":"$meta.even","n":{"$sum":1}}},{"$sort":{"_id":1}}],"cursor":{}}`,
				);
				expect(columnsOf(events)).toEqual(['_id', 'n']);
				expect(rowsOf(events)).toEqual([
					[false, 125],
					[true, 125],
				]);
				const counted = await run(session, `{"countDocuments":"${COLLECTION}","filter":{"meta.even":true}}`);
				expect(rowsOf(counted)).toEqual([[125]]);
			} finally {
				await session.close();
			}
		});

		test('abort kills the operation on the server, also for a read-role user', async () => {
			for (const who of [OWNER, READER]) {
				const session = await open(who === READER, who);
				try {
					const admin = admins.get(instance.name)!.db('admin');
					const lingering = async () =>
						(
							await admin
								.aggregate([{ $currentOp: { allUsers: true } }, { $match: { 'command.comment': { $regex: '^skiff-studio:' } } }])
								.toArray()
						).length;
					const controller = new AbortController();
					let visibleBeforeAbort = 0;
					setTimeout(async () => {
						visibleBeforeAbort = await lingering();
						controller.abort();
					}, 300);
					let error: unknown;
					try {
						await collect(
							session.run(`{"find":"${COLLECTION}","filter":{"$where":"sleep(100) || true"}}`, { maxRows: 10, timeoutMs: 60_000 }, controller.signal),
						);
					} catch (caught) {
						error = caught;
					}
					expect(error instanceof StudioError && error.code).toBe('cancelled');
					// The matcher sees the running op, so "gone" below is meaningful.
					expect(visibleBeforeAbort).toBeGreaterThan(0);
					// Not just abandoned client-side: the server-side op is gone within the plan's 2 s.
					await waitFor('killOp', async () => (await lingering()) === 0, { timeoutMs: 2_000, intervalMs: 100 });
				} finally {
					await session.close();
				}
			}
		});

		test('a run past its timeout fails with timeout', async () => {
			const session = await open(true, READER);
			try {
				const started = performance.now();
				let error: unknown;
				try {
					await run(session, `{"find":"${COLLECTION}","filter":{"$where":"sleep(100) || true"}}`, 500);
				} catch (caught) {
					error = caught;
				}
				expect(error instanceof StudioError && error.code).toBe('timeout');
				expect(performance.now() - started).toBeLessThan(3_000);
			} finally {
				await session.close();
			}
		});

		test('the view is listed and browsable but not editable', async () => {
			const session = await open(false);
			try {
				const tree = await session.tree([], signal());
				expect(tree.find((n) => n.name === VIEW)).toMatchObject({ kind: 'view', browsable: true, detail: { type: 'view' } });
				expect(tree.find((n) => n.name === COLLECTION)).toMatchObject({ kind: 'collection', detail: { rows: ROW_COUNT } });
				const object = { path: [VIEW], kind: 'view' as const };
				const description = await session.describe(object, signal());
				expect(description.editable).toBe(false);
				expect(description.reason).toBe('Views are read-only.');
				expect(description.columns.every((c) => c.editable === false)).toBe(true);
				const events = await collect(session.browse(object, { limit: 100, sort: [], filter: [] }, signal()));
				expect(rowsOf(events).length).toBe(100);
				let refused: unknown;
				try {
					await session.apply(object, [{ op: 'delete', key: { _id: { $t: 'ejson', v: { $oid: ids[0]!.toHexString() } } } }], signal());
				} catch (error) {
					refused = error;
				}
				expect(refused instanceof StudioError && refused.code).toBe('unsupported');
			} finally {
				await session.close();
			}
		});

		test('alter edits fields, indexes and contents of a collection', async () => {
			const name = 'alter_scratch';
			const object = { path: [name], kind: 'collection' as const };
			const app = admins.get(instance.name)!.db('app');
			await app.collection(name).drop().catch(() => undefined);
			await app.collection(name).insertMany([
				{ _id: 1 as never, a: 1, nested: { x: 1 } },
				{ _id: 2 as never, a: 2 },
				{ _id: 3 as never, b: 3 },
			]);
			const session = await open(false);
			const alter = (change: Parameters<NonNullable<StudioSession['alter']>>[0], dryRun = false) =>
				session.alter!(change, { dryRun }, signal());
			const code = async (work: Promise<unknown>) => {
				try {
					await work;
					return null;
				} catch (error) {
					return error instanceof StudioError ? error.code : 'other';
				}
			};
			try {
				// Dry run: the statement, nothing changed.
				const dry = await alter({ op: 'rename-column', object, column: 'a', name: 'alpha' }, true);
				expect(dry).toEqual({
					statements: [`{"update":"${name}","updates":[{"q":{"a":{"$exists":true}},"u":{"$rename":{"a":"alpha"}},"multi":true}]}`],
					applied: false,
				});
				expect(await app.collection(name).countDocuments({ a: { $exists: true } })).toBe(2);

				expect(await alter({ op: 'rename-column', object, column: 'a', name: 'alpha' })).toMatchObject({ applied: true, affected: 2 });
				expect(await app.collection(name).countDocuments({ alpha: { $exists: true } })).toBe(2);
				expect(await alter({ op: 'drop-column', object, column: 'nested.x' })).toMatchObject({ applied: true, affected: 1 });
				expect(await app.collection(name).findOne({ _id: 1 as never })).toEqual({ _id: 1, alpha: 1, nested: {} } as never);
				expect(await code(alter({ op: 'drop-column', object, column: '_id' }))).toBe('bad_request');

				await alter({ op: 'create-index', object, columns: [{ name: 'alpha', dir: 'desc' }], unique: true });
				let indexes = (await session.describe(object, signal())).indexes.map((index) => index.name);
				expect(indexes).toContain('alpha_-1');
				expect(await code(alter({ op: 'create-index', object, columns: [{ name: 'b', dir: 'asc' }], unique: false, name: 'alpha_-1' }))).toBe(
					'conflict',
				);
				await alter({ op: 'drop-index', object, name: 'alpha_-1' });
				indexes = (await session.describe(object, signal())).indexes.map((index) => index.name);
				expect(indexes).toEqual(['_id_']);
				expect(await code(alter({ op: 'drop-index', object, name: '_id_' }))).toBe('bad_request');
				expect(await code(alter({ op: 'drop-index', object, name: 'nope' }))).toBe('not_found');

				// Views refuse content edits; a missing collection is not found.
				expect(await code(alter({ op: 'truncate', object: { path: [VIEW], kind: 'view' } }, true))).toBe('unsupported');
				expect(await code(alter({ op: 'truncate', object: { path: ['missing'], kind: 'collection' } }, true))).toBe('not_found');
				// Renaming onto an existing collection never drops it.
				expect(await code(alter({ op: 'rename', object, name: COLLECTION }))).toBe('conflict');
				expect(await code(alter({ op: 'create-collection', parent: [], name: COLLECTION }))).toBe('conflict');
				expect(await code(alter({ op: 'create-collection', parent: [], name: 'system.x' }))).toBe('bad_request');

				expect(await alter({ op: 'truncate', object })).toMatchObject({ applied: true, affected: 3 });
				expect(await app.collection(name).countDocuments()).toBe(0);
			} finally {
				await session.close();
				await app.collection(name).drop().catch(() => undefined);
			}
		});

		test('explain returns a JSON plan; value loads the full field', async () => {
			const session = await open(true, READER);
			try {
				const plan = await session.explain!(`{"find":"${COLLECTION}","filter":{"name":"item 001"}}`, signal());
				expect(plan.format).toBe('json');
				expect(JSON.stringify(plan.plan)).toContain('queryPlanner');
				const value = await session.value!(
					{ path: [COLLECTION], kind: 'collection' },
					{ _id: { $t: 'ejson', v: { $oid: ids[0]!.toHexString() } } },
					'meta',
					signal(),
				);
				expect(value).toEqual({ $t: 'ejson', v: { even: false, tags: ['a', '1'] } });
			} finally {
				await session.close();
			}
		});
	});
}
