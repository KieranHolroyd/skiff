import { afterEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	HBA_BEGIN,
	HBA_RULE,
	REPLICATION_STATUS_SQL,
	assertPrimaryDatabaseId,
	assertReplicaWorkloadId,
	parseReplicationPassword,
	parseReplicationStatus,
	parseSlots,
	renderPromoteArgs,
	renderReplicaStartScript,
	renderReplicationConfigureSql,
	renderReplicationTeardownSql,
	replicaPostgresArgs,
	withReplicationHba,
} from './replication.ts';
import { createHandler } from './server.ts';
import { SystemdDriver, type CommandRunOptions, type CommandRunner, type RunResult } from './systemd.ts';
import { renderDatabaseUnit } from './units.ts';
import { databaseImage, parseWorkload, type WorkloadDesired } from './validate.ts';

const PRIMARY = 'db_0123456789abcdef0123456789abcdef';
const REPLICA = 'db_dbr_0123456789abcdef0123456789abcdef';
const SLOT = 'yoal_dbr_0123456789abcdef0123456789abcdef';
const PASSWORD = 'Abcdefghijklmnop_qrstu-vwxyz';
const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function replicaWorkload(overrides: Record<string, unknown> = {}): WorkloadDesired {
	const database = { engine: 'postgres', version: '17', replica: { slot: SLOT } };
	return parseWorkload({
		id: REPLICA,
		projectId: PRIMARY,
		projectSlug: 'orders',
		deploymentId: 'dbr_0123456789abcdef0123456789abcdef',
		runtime: 'container',
		status: 'running',
		release: null,
		image: databaseImage({ engine: 'postgres', version: '17' }),
		upstream: '127.0.0.1:15433',
		memoryMb: 512,
		cpus: 1,
		port: 15433,
		healthPath: '/',
		socketActivation: false,
		activationVersion: 'b'.repeat(64),
		env: { POSTGRES_USER: 'orders', POSTGRES_DB: 'orders', PGDATA: '/data/pgdata' },
		secrets: [],
		dataSizeMb: null,
		database,
		...overrides,
	});
}

describe('validation', () => {
	test('a replica profile needs a replica id and the reverse', () => {
		expect(replicaWorkload().database?.replica).toEqual({ slot: SLOT });
		expect(() => replicaWorkload({ id: PRIMARY })).toThrow(/db_dbr_/);
		expect(() =>
			replicaWorkload({ database: { engine: 'postgres', version: '17' } }),
		).toThrow(/reserved for database replicas/);
		expect(() =>
			replicaWorkload({ database: { engine: 'postgres', version: '17', replica: { slot: 'pg_evil' } } }),
		).toThrow(/slot must match/);
		expect(() =>
			replicaWorkload({ database: { engine: 'postgres', version: '17', replica: { slot: SLOT, extra: 1 } } }),
		).toThrow(/not supported/);
		expect(() => replicaWorkload({ pooler: { port: 16432 } })).toThrow(/no pooler/);
	});

	test('ids, slots and passwords are checked before anything renders', () => {
		expect(assertReplicaWorkloadId(REPLICA)).toBe(REPLICA);
		expect(() => assertReplicaWorkloadId(PRIMARY)).toThrow(/db_dbr_/);
		expect(() => assertPrimaryDatabaseId(REPLICA)).toThrow(/not be a replica/);
		expect(parseSlots(['yoal_b', 'yoal_a'])).toEqual(['yoal_a', 'yoal_b']);
		expect(() => parseSlots(['yoal_a', 'yoal_a'])).toThrow(/repeat/);
		expect(() => parseSlots(["yoal_a'; DROP ROLE x; --"])).toThrow(/must match/);
		expect(() => parseSlots(Array.from({ length: 9 }, (_, index) => `yoal_${index}`))).toThrow(/at most 8/);
		expect(parseReplicationPassword(null, [])).toBeNull();
		expect(() => parseReplicationPassword(PASSWORD, [])).toThrow(/null/);
		expect(() => parseReplicationPassword("x'; --", ['yoal_a'])).toThrow(/base64url/);
	});
});

describe('replica unit', () => {
	test('runs the start script with the slot, mounts the link read-only and adds standby flags', () => {
		const unit = renderDatabaseUnit({
			workload: replicaWorkload(),
			envFile: `/run/yoal-workloads/${REPLICA}/env`,
			dataDir: `/var/lib/yoal-workloads/${REPLICA}`,
			replica: { linkDir: `/var/lib/yoal/agent/replication/${REPLICA}`, scriptPath: `/run/yoal-workloads/${REPLICA}/replica-start.sh` },
		});
		expect(unit).toContain('Entrypoint=/usr/local/bin/yoal-replica-start');
		expect(unit).toMatch(new RegExp(`^Exec="${SLOT}" "postgres" `, 'm'));
		expect(unit).toContain('"hot_standby=on"');
		expect(unit).toContain(`"primary_slot_name=${SLOT}"`);
		expect(unit).toContain(`"primary_conninfo=host=/run/yoal-upstream port=5432 user=yoal_repl application_name=${SLOT} connect_timeout=10"`);
		expect(unit).toContain(`Volume=/var/lib/yoal/agent/replication/${REPLICA}:/run/yoal-upstream:ro,z`);
		expect(unit).toContain(`Volume=/run/yoal-workloads/${REPLICA}/replica-start.sh:/usr/local/bin/yoal-replica-start:ro,Z`);
		expect(unit).toContain('PublishPort=127.0.0.1:15433:5432');
		expect(unit).toContain('ReadOnly=true');
		expect(unit).not.toContain('archive_mode');
	});

	test('refuses a replica profile without link paths, and link paths without the profile', () => {
		expect(() =>
			renderDatabaseUnit({ workload: replicaWorkload(), envFile: '/run/env', dataDir: '/var/lib/x' }),
		).toThrow(/link paths/);
	});

	test('the start script copies once, retries, marks a standby and execs the entrypoint', () => {
		const script = renderReplicaStartScript();
		expect(script.startsWith('#!/bin/sh\n')).toBe(true);
		expect(script).toContain('if [ ! -s "$data/PG_VERSION" ]; then');
		expect(script).toContain('--host=/run/yoal-upstream --port=5432 --username=yoal_repl --no-password');
		expect(script).toContain('--wal-method=stream --checkpoint=fast --max-rate=50M --slot="$slot"');
		expect(script).toContain('mv "$partial" "$data"');
		expect(script).toContain('touch "$data/standby.signal"');
		expect(script).toContain('exec /usr/local/bin/docker-entrypoint.sh "$@"');
		// The password comes from PGPASSWORD (the env file), never the script or argv.
		expect(script).not.toMatch(/password=/i);
		expect(replicaPostgresArgs(SLOT)).toContain(`primary_slot_name=${SLOT}`);
	});
});

describe('primary configuration', () => {
	test('the managed pg_hba block is appended once and removed cleanly', () => {
		const base = 'local all all trust\nhost all all all scram-sha-256\n';
		const on = withReplicationHba(base, true);
		expect(on).toContain(`${HBA_BEGIN}\n${HBA_RULE}\n`);
		expect(on.startsWith(base.trimEnd())).toBe(true);
		expect(withReplicationHba(on, true)).toBe(on);
		expect(withReplicationHba(on, false)).toBe(base);
		expect(HBA_RULE).toBe('host replication yoal_repl all scram-sha-256');
	});

	test('configure SQL creates the role, keeps exactly the slots and reloads', () => {
		const sql = renderReplicationConfigureSql(PASSWORD, ['yoal_a', 'yoal_b']);
		expect(sql).toContain(`CREATE ROLE yoal_repl WITH LOGIN REPLICATION PASSWORD '${PASSWORD}'`);
		expect(sql).toContain("ALTER SYSTEM SET max_slot_wal_keep_size = '2GB';");
		expect(sql).toContain("ALTER SYSTEM SET wal_keep_size = '512MB';");
		expect(sql).toContain("pg_create_physical_replication_slot(s, true) FROM unnest(ARRAY['yoal_a', 'yoal_b']::text[])");
		expect(sql).toContain("slot_name LIKE 'yoal\\_%' AND NOT (slot_name = ANY(ARRAY['yoal_a', 'yoal_b']::text[]))");
		expect(sql).toContain('SELECT pg_reload_conf();');
		expect(() => renderReplicationConfigureSql(PASSWORD, [])).toThrow(/teardown/);
		const teardown = renderReplicationTeardownSql();
		expect(teardown).toContain('NOT (slot_name = ANY(ARRAY[]::text[]))');
		expect(teardown).toContain('DROP ROLE yoal_repl');
		expect(teardown).toContain('ALTER SYSTEM RESET max_slot_wal_keep_size;');
	});

	test('the status query is read-only and its output is parsed strictly', () => {
		expect(REPLICATION_STATUS_SQL).toMatch(/^SELECT /);
		expect(REPLICATION_STATUS_SQL).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER)\b/);
		const parsed = parseReplicationStatus(
			JSON.stringify([
				{ slot: 'yoal_a', active: true, walStatus: 'reserved', state: 'streaming', sentLsn: '0/3000148', replayLsn: '0/3000060', lagBytes: 232, lagSeconds: 0.004, syncState: 'async' },
				{ slot: 'not_ours', active: true },
				{ slot: 'yoal_b', active: false, walStatus: 'lost', state: null, sentLsn: 'junk', replayLsn: null, lagBytes: -5, lagSeconds: null, syncState: null },
			]),
		);
		expect(parsed).toEqual([
			{ slot: 'yoal_a', active: true, walStatus: 'reserved', state: 'streaming', sentLsn: '0/3000148', replayLsn: '0/3000060', lagBytes: 232, lagSeconds: 0.004, syncState: 'async' },
			{ slot: 'yoal_b', active: false, walStatus: 'lost', state: null, sentLsn: null, replayLsn: null, lagBytes: null, lagSeconds: null, syncState: null },
		]);
		expect(parseReplicationStatus('')).toEqual([]);
		expect(() => parseReplicationStatus('not json')).toThrow(/JSON/);
		expect(renderPromoteArgs('/usr/bin/podman', REPLICA)).toEqual([
			'/usr/bin/podman', 'exec', `yoal-workload-${REPLICA}`, 'pg_ctl', 'promote', '-D', '/data/pgdata', '-w', '-t', '60',
		]);
	});
});

/** Answers psql and podman like a live primary/replica would. */
class ReplicationRunner implements CommandRunner {
	calls: Array<{ argv: string[]; options?: CommandRunOptions }> = [];
	recovery = 't';
	status = '[]';
	async run(argv: string[], options?: CommandRunOptions): Promise<RunResult> {
		this.calls.push({ argv, ...(options ? { options } : {}) });
		const sql = argv[argv.indexOf('-c') + 1] ?? '';
		if (argv.includes('psql') && sql === 'SELECT pg_is_in_recovery()') return { code: 0, stdout: `${this.recovery}\n`, stderr: '' };
		if (argv.includes('psql') && sql.startsWith('SELECT pg_current_wal_lsn')) return { code: 0, stdout: '0/5000060\n', stderr: '' };
		if (argv.includes('psql') && sql === REPLICATION_STATUS_SQL) return { code: 0, stdout: this.status, stderr: '' };
		if (argv.includes('pg_ctl')) {
			this.recovery = 'f';
			return { code: 0, stdout: 'server promoted\n', stderr: '' };
		}
		return { code: 0, stdout: '', stderr: '' };
	}
}

async function driverFixture() {
	const root = await fs.mkdtemp(join(tmpdir(), 'yoal-helper-replication-'));
	directories.push(root);
	const runtimeDir = join(root, 'run');
	const stateDir = join(root, 'state');
	const replicationDir = join(root, 'agent', 'replication');
	await fs.mkdir(replicationDir, { recursive: true });
	await fs.mkdir(join(root, 'releases'), { recursive: true });
	const runner = new ReplicationRunner();
	const driver = new SystemdDriver({
		runner,
		chown: async () => undefined,
		unitDir: join(root, 'units'),
		quadletDir: join(root, 'quadlet'),
		runtimeDir,
		stateDir,
		replicationDir,
		releaseDirs: [join(root, 'releases')],
		volumeRegistryFile: join(root, 'volumes.json'),
		bunPath: '/usr/local/bin/bun',
		restorePollMs: 0,
	});
	const envFor = async (id: string) => {
		await fs.mkdir(join(runtimeDir, id), { recursive: true });
		await fs.writeFile(join(runtimeDir, id, 'env'), 'POSTGRES_USER=orders\nPOSTGRES_DB=orders\nPOSTGRES_PASSWORD=owner-secret\n');
	};
	return { root, runtimeDir, stateDir, replicationDir, runner, driver, envFor };
}

describe('SystemdDriver replication verbs', () => {
	test('apply writes the start script and creates the link dir before the unit', async () => {
		const f = await driverFixture();
		await f.driver.apply(replicaWorkload(), {
			workloadId: REPLICA,
			activationVersion: 'b'.repeat(64),
			env: { POSTGRES_PASSWORD: 'owner-secret', PGPASSWORD: PASSWORD },
			files: {},
		});
		const script = await fs.readFile(join(f.runtimeDir, REPLICA, 'replica-start.sh'), 'utf8');
		expect(script).toBe(renderReplicaStartScript());
		expect((await fs.stat(join(f.runtimeDir, REPLICA, 'replica-start.sh'))).mode & 0o777).toBe(0o755);
		expect((await fs.stat(join(f.replicationDir, REPLICA))).isDirectory()).toBe(true);
		const unit = await fs.readFile(join(f.root, 'quadlet', `yoal-workload-${REPLICA}.container`), 'utf8');
		expect(unit).toContain(`Volume=${join(f.replicationDir, REPLICA)}:/run/yoal-upstream:ro,z`);
		// The replication password is in the 0400 env file only.
		expect(await fs.readFile(join(f.runtimeDir, REPLICA, 'env'), 'utf8')).toContain(`PGPASSWORD=${PASSWORD}`);
		expect(f.runner.calls.some((call) => call.argv.join(' ').includes(PASSWORD))).toBe(false);
	});

	test('configure edits pg_hba, sends SQL over stdin with the owner password in the environment', async () => {
		const f = await driverFixture();
		await f.envFor(PRIMARY);
		await fs.mkdir(join(f.stateDir, PRIMARY, 'pgdata'), { recursive: true });
		await fs.writeFile(join(f.stateDir, PRIMARY, 'pgdata', 'pg_hba.conf'), 'host all all all scram-sha-256\n');
		expect(await f.driver.replicationConfigure(PRIMARY, { slots: [SLOT], password: PASSWORD })).toEqual({ slots: [SLOT] });
		expect(await fs.readFile(join(f.stateDir, PRIMARY, 'pgdata', 'pg_hba.conf'), 'utf8')).toContain(HBA_RULE);
		const call = f.runner.calls.find((item) => item.argv.includes('psql'))!;
		expect(call.argv.join(' ')).not.toContain(PASSWORD);
		expect(call.options?.stdin).toContain(`PASSWORD '${PASSWORD}'`);
		expect(call.options?.env).toEqual({ PGPASSWORD: 'owner-secret' });
		await f.driver.replicationConfigure(PRIMARY, { slots: [], password: null });
		expect(await fs.readFile(join(f.stateDir, PRIMARY, 'pgdata', 'pg_hba.conf'), 'utf8')).not.toContain(HBA_RULE);
		await expect(f.driver.replicationConfigure(REPLICA, { slots: [] })).rejects.toThrow(/not be a replica/);
	});

	test('status returns the parsed sample', async () => {
		const f = await driverFixture();
		await f.envFor(PRIMARY);
		f.runner.status = JSON.stringify([{ slot: SLOT, active: true, walStatus: 'reserved', state: 'streaming', sentLsn: '0/1', replayLsn: '0/1', lagBytes: 0, lagSeconds: 0, syncState: 'async' }]);
		expect((await f.driver.replicationStatus(PRIMARY)).slots).toEqual([
			{ slot: SLOT, active: true, walStatus: 'reserved', state: 'streaming', sentLsn: '0/1', replayLsn: '0/1', lagBytes: 0, lagSeconds: 0, syncState: 'async' },
		]);
	});

	test('promote runs pg_ctl, stops the unit and hands the data dir to the database id', async () => {
		const f = await driverFixture();
		await f.envFor(REPLICA);
		await fs.mkdir(join(f.stateDir, REPLICA, 'pgdata'), { recursive: true });
		await fs.writeFile(join(f.stateDir, REPLICA, 'pgdata', 'standby.signal'), '');
		await fs.writeFile(join(f.stateDir, REPLICA, 'pgdata', 'PG_VERSION'), '17\n');
		expect(await f.driver.replicaPromote(REPLICA, { databaseId: PRIMARY })).toEqual({ databaseId: PRIMARY, lsn: '0/5000060' });
		expect(f.runner.calls.some((call) => call.argv.includes('pg_ctl'))).toBe(true);
		expect(f.runner.calls.some((call) => call.argv.includes('stop') && call.argv.includes(`yoal-workload-${REPLICA}.service`))).toBe(true);
		expect(await fs.readFile(join(f.stateDir, PRIMARY, 'pgdata', 'PG_VERSION'), 'utf8')).toBe('17\n');
		await expect(fs.stat(join(f.stateDir, PRIMARY, 'pgdata', 'standby.signal'))).rejects.toThrow();
		await expect(fs.stat(join(f.stateDir, REPLICA))).rejects.toThrow();
		// Idempotent: a retry after the hand-over reports success without touching anything.
		expect(await f.driver.replicaPromote(REPLICA, { databaseId: PRIMARY })).toEqual({ databaseId: PRIMARY, lsn: null });
	});

	test('promote refuses to overwrite another copy of the database', async () => {
		const f = await driverFixture();
		await f.envFor(REPLICA);
		await fs.mkdir(join(f.stateDir, REPLICA, 'pgdata'), { recursive: true });
		await fs.mkdir(join(f.stateDir, PRIMARY), { recursive: true });
		await expect(f.driver.replicaPromote(REPLICA, { databaseId: PRIMARY })).rejects.toThrow(/already exists/);
		expect(f.runner.calls.some((call) => call.argv.includes('pg_ctl'))).toBe(false);
	});

	test('the HTTP verbs validate their bodies', async () => {
		const f = await driverFixture();
		const handler = createHandler(f.driver, { version: 'test' });
		const response = await handler(
			new Request(`http://helper/v1/workloads/${PRIMARY}/replication/configure`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ slots: [SLOT], password: PASSWORD, command: 'rm -rf /' }),
			}),
		);
		expect(response.status).toBe(400);
		const promote = await handler(
			new Request(`http://helper/v1/workloads/${PRIMARY}/replica/promote`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ databaseId: PRIMARY }),
			}),
		);
		expect(promote.status).toBe(400);
	});
});
