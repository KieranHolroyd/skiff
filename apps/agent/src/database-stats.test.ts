import { describe, expect, test } from 'bun:test';
import { telemetryBatchSchema } from '@skiff/contracts';
import {
	BOOTSTRAP_SQL,
	bunSqlConnector,
	counterDeltas,
	DatabaseStatsSampler,
	STATEMENT_TIMEOUT_SQL,
	STATS_SQL,
	TABLES_SQL,
	type DatabaseTarget,
	type DatabaseTargetSource,
	type SqlClient,
	type SqlConnectOptions,
} from './database-stats.ts';

const DB_ID = 'db_0123456789abcdef0123456789abcdef';
const ACTIVATION = 'b'.repeat(64);
const OWNER_PASSWORD = "own'er-pw";
const MONITOR_PASSWORD = "mon'itor-pw";
const NOW = Date.parse('2026-11-04T12:34:56.789Z');

class FakeSource implements DatabaseTargetSource {
	targets: DatabaseTarget[] = [];
	forgotten: Array<[string, string]> = [];

	databaseTargets(): DatabaseTarget[] {
		return this.targets.map((target) => ({ ...target, monitor: { ...target.monitor } }));
	}

	forgetOwnerPassword(id: string, activationVersion: string): void {
		this.forgotten.push([id, activationVersion]);
		for (const target of this.targets) {
			if (target.id === id && target.activationVersion === activationVersion) target.monitor.ownerPassword = null;
		}
	}
}

function target(overrides: Partial<DatabaseTarget> = {}): DatabaseTarget {
	return {
		id: DB_ID,
		activationVersion: ACTIVATION,
		port: 15432,
		status: 'running',
		memoryBytes: 64 * 1024 * 1024,
		monitor: {
			databaseName: 'orders',
			ownerUser: 'orders',
			ownerPassword: OWNER_PASSWORD,
			monitorUser: 'skiff_monitor',
			monitorPassword: MONITOR_PASSWORD,
			port: 15432,
		},
		...overrides,
	};
}

interface Query {
	user: string;
	text: string;
	params: unknown[];
}

class FakePostgres {
	connects: SqlConnectOptions[] = [];
	queries: Query[] = [];
	closed = 0;
	/** Usernames whose connection fails (auth error, server down). */
	refuse = new Set<string>();
	failTables = false;
	stats: Record<string, unknown> = baseStats();
	tables: Array<Record<string, unknown>> = [
		{
			schema: 'public',
			name: 'orders',
			rows: '1200',
			total_bytes: 81_920,
			seq_scans: 3,
			idx_scans: null,
			last_autovacuum: new Date('2026-11-04T11:00:00.000Z'),
			last_autoanalyze: null,
		},
	];

	connector = (options: SqlConnectOptions): SqlClient => {
		this.connects.push(options);
		return {
			query: async (text: string, params: unknown[] = []) => {
				if (this.refuse.has(options.username))
					throw new Error(`password authentication failed for user "${options.username}"`);
				this.queries.push({ user: options.username, text, params });
				if (text === BOOTSTRAP_SQL)
					return [
						{
							role_sql: 'CREATE ROLE skiff_monitor WITH LOGIN PASSWORD <quoted>',
							monitor_sql: 'GRANT pg_monitor TO skiff_monitor',
							connect_sql: 'GRANT CONNECT ON DATABASE orders TO skiff_monitor',
						},
					];
				if (text === STATS_SQL) return [{ ...this.stats }];
				if (text === TABLES_SQL) {
					if (this.failTables) throw new Error('permission denied');
					return this.tables;
				}
				return [];
			},
			close: async () => {
				this.closed += 1;
			},
		};
	};

	ofUser(user: string): Query[] {
		return this.queries.filter((query) => query.user === user);
	}

	count(text: string): number {
		return this.queries.filter((query) => query.text === text).length;
	}
}

function baseStats(): Record<string, unknown> {
	return {
		size_bytes: '8388608',
		connections_active: 2,
		connections_idle: 3,
		connections_total: 5,
		max_connections: 100,
		xact_commit: 1_000,
		xact_rollback: 10,
		tup_returned: 50_000,
		tup_fetched: 20_000,
		tup_inserted: 300,
		tup_updated: 40,
		tup_deleted: 5,
		blks_hit: 90_000,
		blks_read: 1_000,
		deadlocks: 0,
		temp_bytes: 4096n,
	};
}

function fixture(options: { snapshotEvery?: number; maxBuckets?: number } = {}) {
	const source = new FakeSource();
	const pg = new FakePostgres();
	let now = NOW;
	const logs: string[] = [];
	const sampler = new DatabaseStatsSampler({
		source,
		connect: pg.connector,
		now: () => now,
		log: (_level, message) => logs.push(message),
		...options,
	});
	return {
		source,
		pg,
		sampler,
		logs,
		advance(ms = 60_000) {
			now += ms;
		},
	};
}

describe('DatabaseStatsSampler bootstrap', () => {
	test('creates the monitor role once as the owner, then drops the owner password', async () => {
		const f = fixture();
		f.source.targets = [target()];

		await f.sampler.sample();

		const owner = f.pg.ofUser('orders');
		expect(owner.map((query) => query.text)).toEqual([
			BOOTSTRAP_SQL,
			'CREATE ROLE skiff_monitor WITH LOGIN PASSWORD <quoted>',
			'GRANT pg_monitor TO skiff_monitor',
			'GRANT CONNECT ON DATABASE orders TO skiff_monitor',
		]);
		// The password travels as a bound parameter; Postgres quotes it with %L.
		expect(owner[0]?.params).toEqual(['skiff_monitor', MONITOR_PASSWORD]);
		expect(BOOTSTRAP_SQL).not.toContain(MONITOR_PASSWORD);
		expect(BOOTSTRAP_SQL).toContain('PASSWORD %L');
		expect(f.source.forgotten).toEqual([[DB_ID, ACTIVATION]]);
		expect(f.source.targets[0]?.monitor.ownerPassword).toBeNull();
		expect(f.pg.connects[0]).toEqual({
			hostname: '127.0.0.1',
			port: 15432,
			username: 'orders',
			password: OWNER_PASSWORD,
			database: 'orders',
		});

		// Sampling happens as the monitor, never as the owner.
		expect(f.pg.ofUser('skiff_monitor').map((query) => query.text)).toEqual([
			STATEMENT_TIMEOUT_SQL,
			STATS_SQL,
			TABLES_SQL,
		]);

		f.advance();
		await f.sampler.sample();
		expect(f.pg.count(BOOTSTRAP_SQL)).toBe(1);
		expect(f.pg.ofUser('orders')).toHaveLength(4);
		// Every connection is closed.
		expect(f.pg.closed).toBe(f.pg.connects.length);
	});

	test('bootstraps again for a new activation version', async () => {
		const f = fixture();
		f.source.targets = [target()];
		await f.sampler.sample();
		f.source.targets = [target({ activationVersion: 'c'.repeat(64) })];
		f.advance();
		await f.sampler.sample();
		expect(f.pg.count(BOOTSTRAP_SQL)).toBe(2);
		expect(f.source.forgotten).toEqual([
			[DB_ID, ACTIVATION],
			[DB_ID, 'c'.repeat(64)],
		]);
	});

	test('a failed bootstrap reports down and is retried next minute', async () => {
		const f = fixture();
		f.source.targets = [target()];
		f.pg.refuse.add('orders');

		await f.sampler.sample();
		expect(f.sampler.pending().databases.map((bucket) => bucket.up)).toEqual([false]);
		expect(f.source.forgotten).toEqual([]);
		expect(f.pg.ofUser('skiff_monitor')).toEqual([]);
		expect(f.logs.join('\n')).toContain('monitor bootstrap failed');
		expect(f.logs.join('\n')).not.toContain(OWNER_PASSWORD);

		f.pg.refuse.clear();
		f.advance();
		await f.sampler.sample();
		expect(f.pg.count(BOOTSTRAP_SQL)).toBe(1);
		expect(f.sampler.pending().databases.map((bucket) => bucket.up)).toEqual([false, true]);
	});

	test('a re-delivered owner password after bootstrap is dropped without re-running it', async () => {
		const f = fixture();
		f.source.targets = [target()];
		await f.sampler.sample();
		f.source.targets[0]!.monitor.ownerPassword = OWNER_PASSWORD;
		f.advance();
		await f.sampler.sample();
		expect(f.pg.count(BOOTSTRAP_SQL)).toBe(1);
		expect(f.source.forgotten).toHaveLength(2);
		expect(f.source.targets[0]?.monitor.ownerPassword).toBeNull();
	});
});

describe('DatabaseStatsSampler buckets', () => {
	test('gauges are absolute and counters are deltas from the previous sample', async () => {
		const f = fixture();
		f.source.targets = [target()];
		await f.sampler.sample();

		f.pg.stats = { ...baseStats(), xact_commit: 1_060, tup_inserted: 330, temp_bytes: 8192n, connections_total: 7 };
		f.advance();
		await f.sampler.sample();

		const [first, second] = f.sampler.pending().databases;
		expect(first).toMatchObject({
			databaseId: DB_ID,
			bucket: '2026-11-04T12:34:00.000Z',
			up: true,
			sizeBytes: 8_388_608,
			connectionsActive: 2,
			connectionsIdle: 3,
			connectionsTotal: 5,
			maxConnections: 100,
			memoryBytes: 64 * 1024 * 1024,
			// First sample: no baseline.
			xactCommit: 0,
			tupInserted: 0,
			tempBytes: 0,
		});
		expect(second).toMatchObject({
			bucket: '2026-11-04T12:35:00.000Z',
			connectionsTotal: 7,
			xactCommit: 60,
			tupInserted: 30,
			tempBytes: 4096,
			xactRollback: 0,
		});
	});

	test('a counter reset sends the raw value instead of a negative delta', async () => {
		const f = fixture();
		f.source.targets = [target()];
		await f.sampler.sample();
		f.pg.stats = { ...baseStats(), xact_commit: 25, blks_hit: 95_000 };
		f.advance();
		await f.sampler.sample();
		const second = f.sampler.pending().databases[1]!;
		expect(second.xactCommit).toBe(25);
		expect(second.blksHit).toBe(5_000);

		expect(counterDeltas(null, { ...zero(), deadlocks: 4 }).deadlocks).toBe(0);
		expect(counterDeltas({ ...zero(), deadlocks: 4 }, { ...zero(), deadlocks: 1 }).deadlocks).toBe(1);
	});

	test('a stopped database or a failed connect produces an up:false bucket', async () => {
		const f = fixture();
		f.source.targets = [target({ status: 'starting', memoryBytes: 1024 })];
		await f.sampler.sample();
		expect(f.pg.connects).toEqual([]);

		f.source.targets = [target()];
		f.pg.refuse.add('skiff_monitor');
		f.advance();
		await f.sampler.sample();

		const buckets = f.sampler.pending().databases;
		expect(buckets).toHaveLength(2);
		expect(buckets[0]).toMatchObject({ up: false, memoryBytes: 1024, sizeBytes: 0, xactCommit: 0 });
		expect(buckets[1]).toMatchObject({ up: false, connectionsTotal: 0 });
		expect(f.logs.join('\n')).toContain('sample failed');
		expect(f.logs.join('\n')).not.toContain(MONITOR_PASSWORD);
	});

	test('the whole payload fits the telemetry batch schema', async () => {
		const f = fixture();
		f.source.targets = [target(), target({ id: 'db_ffff', status: 'failed' })];
		await f.sampler.sample();
		const batch = telemetryBatchSchema.parse({ nodeId: 'nod_1', ...f.sampler.pending() });
		expect(batch.databases).toHaveLength(2);
		expect(batch.databaseSnapshots).toHaveLength(1);
		expect(batch.buckets).toEqual([]);
	});
});

describe('DatabaseStatsSampler snapshots', () => {
	test('takes the top tables on the first and then every fifth successful sample', async () => {
		const f = fixture();
		f.source.targets = [target()];
		for (let i = 0; i < 11; i += 1) {
			await f.sampler.sample();
			f.advance();
		}
		expect(f.pg.count(TABLES_SQL)).toBe(3);
		// Only the newest snapshot per database is buffered.
		const snapshots = f.sampler.pending().databaseSnapshots;
		expect(snapshots).toHaveLength(1);
		expect(snapshots[0]).toEqual({
			databaseId: DB_ID,
			at: new Date(NOW + 10 * 60_000).toISOString(),
			tables: [
				{
					schema: 'public',
					name: 'orders',
					rows: 1200,
					totalBytes: 81_920,
					seqScans: 3,
					idxScans: 0,
					lastAutovacuum: '2026-11-04T11:00:00.000Z',
					lastAutoanalyze: null,
				},
			],
		});
		expect(TABLES_SQL).toContain('LIMIT 50');
		expect(TABLES_SQL).toContain('pg_total_relation_size(relid)');
	});

	test('a failed snapshot keeps the bucket and retries on the next sample', async () => {
		const f = fixture();
		f.source.targets = [target()];
		f.pg.failTables = true;
		await f.sampler.sample();
		expect(f.sampler.pending().databases[0]?.up).toBe(true);
		expect(f.sampler.pending().databaseSnapshots).toEqual([]);

		f.pg.failTables = false;
		f.advance();
		await f.sampler.sample();
		expect(f.sampler.pending().databaseSnapshots).toHaveLength(1);
	});
});

describe('DatabaseStatsSampler buffer', () => {
	test('clears only what a successful POST carried', async () => {
		const f = fixture();
		f.source.targets = [target()];
		await f.sampler.sample();

		await expect(
			f.sampler.flush(async () => {
				throw new Error('Telemetry POST -> 503');
			}),
		).rejects.toThrow(/503/);
		expect(f.sampler.pending().databases).toHaveLength(1);

		let release: () => void = () => undefined;
		const posted: number[] = [];
		const flushing = f.sampler.flush(async (payload) => {
			posted.push(payload.databases.length);
			await new Promise<void>((resolve) => {
				release = resolve;
			});
		});
		// A sample that lands while the POST is in flight stays for the next flush.
		f.advance();
		await f.sampler.sample();
		release();
		expect(await flushing).toBe(true);
		expect(posted).toEqual([1]);
		expect(f.sampler.pending().databases.map((bucket) => bucket.bucket)).toEqual(['2026-11-04T12:35:00.000Z']);
		expect(f.sampler.pending().databaseSnapshots).toEqual([]);

		expect(await f.sampler.flush(async () => undefined)).toBe(true);
		expect(await f.sampler.flush(async () => {
			throw new Error('must not be called for an empty buffer');
		})).toBe(false);
	});

	test('drops the oldest buckets on overflow', async () => {
		const f = fixture({ maxBuckets: 3 });
		f.source.targets = [target()];
		for (let i = 0; i < 5; i += 1) {
			await f.sampler.sample();
			f.advance();
		}
		const buckets = f.sampler.pending().databases.map((bucket) => bucket.bucket);
		expect(buckets).toEqual([
			'2026-11-04T12:36:00.000Z',
			'2026-11-04T12:37:00.000Z',
			'2026-11-04T12:38:00.000Z',
		]);
		expect(f.sampler.dropped).toBe(2);
	});

	test('forgets state for databases that left the node', async () => {
		const f = fixture();
		f.source.targets = [target()];
		await f.sampler.sample();
		f.source.targets = [];
		await f.sampler.sample();
		f.source.targets = [target()];
		f.advance();
		await f.sampler.sample();
		// Back with a fresh state: bootstrap again, counters restart from a zero delta.
		expect(f.pg.count(BOOTSTRAP_SQL)).toBe(2);
		expect(f.sampler.pending().databases.at(-1)?.xactCommit).toBe(0);
	});
});

describe('bunSqlConnector', () => {
	test('fails fast against a closed loopback port', async () => {
		const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
		const port = listener.port;
		listener.stop(true);
		const client = bunSqlConnector()({
			hostname: '127.0.0.1',
			port,
			username: 'skiff_monitor',
			password: 'x',
			database: 'orders',
		});
		await expect(client.query('SELECT 1')).rejects.toThrow();
		await client.close();
	});
});

function zero() {
	return counterDeltas(null, {
		xactCommit: 0,
		xactRollback: 0,
		tupReturned: 0,
		tupFetched: 0,
		tupInserted: 0,
		tupUpdated: 0,
		tupDeleted: 0,
		blksHit: 0,
		blksRead: 0,
		deadlocks: 0,
		tempBytes: 0,
	});
}
