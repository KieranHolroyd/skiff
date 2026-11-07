import { afterEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	clickhouseBackupQuery,
	clickhouseClientArgv,
	clickhouseRestoreQuery,
	isStaleStagingFile,
	keyValueAofManifest,
	keyValueCheckRdbArgv,
	keyValueRdbDumpArgv,
	keyValueReplyFailed,
	stagingFileName,
} from './database-dumps.ts';
import { SystemdDriver, type CommandRunOptions, type CommandRunner, type RunResult } from './systemd.ts';

const DB_ID = 'db_0123456789abcdef0123456789abcdef';
const CONTAINER = `skiff-workload-${DB_ID}`;
const PASSWORD = 'pw-0123456789abcdef';
const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('native dump commands (docs/DATABASES.md §8)', () => {
	test('valkey-cli --rdb writes into /data/skiff-dumps and never puts the password in argv', () => {
		const file = stagingFileName('dump', '0123abcd-0000-4000-8000-000000000000', 'rdb');
		const argv = keyValueRdbDumpArgv({ podmanPath: '/usr/bin/podman', container: CONTAINER, engine: 'valkey', user: 'shop_cache', file });
		expect(argv).toEqual([
			'/usr/bin/podman',
			'exec',
			'-e',
			'REDISCLI_AUTH',
			CONTAINER,
			'valkey-cli',
			'--no-auth-warning',
			'--user',
			'shop_cache',
			'--rdb',
			`/data/skiff-dumps/${file}`,
		]);
		expect(keyValueCheckRdbArgv({ podmanPath: '/usr/bin/podman', container: CONTAINER, engine: 'redis', file })).toEqual([
			'/usr/bin/podman',
			'exec',
			CONTAINER,
			'redis-check-rdb',
			`/data/skiff-dumps/${file}`,
		]);
	});

	test('staging names and identifiers are validated, so nothing can escape the query or the dir', () => {
		expect(() => stagingFileName('dump', '../etc', 'rdb')).toThrow(/staging token/);
		expect(() => keyValueRdbDumpArgv({ podmanPath: '/p', container: CONTAINER, engine: 'valkey', user: 'a b', file: 'dump-0123abcd.rdb' })).toThrow();
		expect(() => keyValueCheckRdbArgv({ podmanPath: '/p', container: CONTAINER, engine: 'valkey', file: '../x.rdb' })).toThrow(/staging file/);
		expect(() => clickhouseBackupQuery("x`; DROP", 'dump-0123abcd.zip')).toThrow(/ClickHouse database/);
		expect(() => clickhouseRestoreQuery('events', "dump-0123abcd.zip') --")).toThrow(/staging file/);
	});

	test('ClickHouse backs up under a fixed name and restores it into the target database', () => {
		expect(clickhouseBackupQuery('shop_events', 'dump-0123abcd.zip')).toBe(
			"BACKUP DATABASE `shop_events` AS `skiff_backup` TO File('/data/skiff-dumps/dump-0123abcd.zip')",
		);
		expect(clickhouseRestoreQuery('restored_events', 'restore-0123abcd.zip')).toBe(
			"RESTORE DATABASE `skiff_backup` AS `restored_events` FROM File('/data/skiff-dumps/restore-0123abcd.zip') SETTINGS allow_different_database_def = 1",
		);
		const argv = clickhouseClientArgv({ podmanPath: '/usr/bin/podman', container: CONTAINER, user: 'shop_events', query: 'SELECT 1' });
		expect(argv.slice(0, 6)).toEqual(['/usr/bin/podman', 'exec', '-e', 'CLICKHOUSE_PASSWORD', CONTAINER, 'clickhouse-client']);
		expect(argv).toContain('--receive_timeout=21600');
		expect(argv.join(' ')).not.toContain('pw');
	});

	test('the AOF manifest names the restored snapshot as the only (base) file', () => {
		expect(keyValueAofManifest()).toBe('file appendonly.aof.1.base.rdb seq 1 type b\n');
	});

	test('reply errors and stale staging files are recognised', () => {
		expect(keyValueReplyFailed('NOAUTH Authentication required.')).toBe(true);
		expect(keyValueReplyFailed('LOADING Valkey is loading the dataset in memory')).toBe(true);
		expect(keyValueReplyFailed('Transfer finished with success.')).toBe(false);
		expect(isStaleStagingFile('dump-0123abcd.rdb', 0, 2 * 60 * 60_000)).toBe(true);
		expect(isStaleStagingFile('dump-0123abcd.rdb', 0, 60_000)).toBe(false);
		expect(isStaleStagingFile('dump.rdb', 0, 2 * 60 * 60_000)).toBe(false);
	});
});

interface Call {
	argv: string[];
	env: Record<string, string> | undefined;
}

/** Plays the container: `--rdb` and `BACKUP` write the staging file through the data dir. */
class EngineRunner implements CommandRunner {
	calls: Call[] = [];
	checkCode = 0;
	restoreCode = 0;
	pingReplies: string[] = [];
	units: string[] = [];

	constructor(private readonly dataDir: string) {}

	async run(argv: string[], options: CommandRunOptions = {}): Promise<RunResult> {
		this.calls.push({ argv, env: options.env });
		const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
		if (argv[0]?.endsWith('systemctl')) {
			this.units.push(`${argv[1]} ${argv[2]}`);
			return ok();
		}
		const staged = (path: string) => join(this.dataDir, path.replace(/^\/data\//, ''));
		const rdb = argv.indexOf('--rdb');
		if (rdb > 0) {
			await fs.writeFile(staged(argv[rdb + 1]!), 'REDIS0012-snapshot');
			return ok('Transfer finished with success.');
		}
		if (argv.some((arg) => arg.endsWith('-check-rdb')))
			return { code: this.checkCode, stdout: '', stderr: this.checkCode ? '--- RDB ERROR DETECTED ---' : '' };
		if (argv.at(-1) === 'PING') return ok(this.pingReplies.shift() ?? 'PONG');
		const query = argv.at(-1) ?? '';
		if (query.startsWith('BACKUP ')) {
			const file = /File\('([^']+)'\)/.exec(query)![1]!;
			await fs.writeFile(staged(file), 'PK-archive');
			return ok(`some-id\tBACKUP_CREATED`);
		}
		if (query.startsWith('RESTORE ')) return { code: this.restoreCode, stdout: '', stderr: this.restoreCode ? 'Code: 598' : '' };
		if (query.startsWith("SELECT 'skiff-ok'")) return ok('skiff-ok\n');
		return ok();
	}
}

async function engineFixture(engine: 'valkey' | 'clickhouse') {
	const root = await fs.mkdtemp(join(tmpdir(), 'skiff-helper-dumps-'));
	directories.push(root);
	const runtimeDir = join(root, 'run');
	const stateDir = join(root, 'state');
	const dataDir = join(stateDir, DB_ID);
	await fs.mkdir(join(runtimeDir, DB_ID), { recursive: true });
	await fs.mkdir(dataDir, { recursive: true });
	const env =
		engine === 'valkey'
			? `SKIFF_DB_ENGINE=valkey\nVALKEY_USER=shop_cache\nVALKEY_PASSWORD=${PASSWORD}\n`
			: `SKIFF_DB_ENGINE=clickhouse\nCLICKHOUSE_USER=shop_events\nCLICKHOUSE_PASSWORD=${PASSWORD}\nCLICKHOUSE_DB=shop_events\n`;
	await fs.writeFile(join(runtimeDir, DB_ID, 'env'), env);
	const runner = new EngineRunner(dataDir);
	const chowns: Array<[string, number, number]> = [];
	const driver = new SystemdDriver({
		runner,
		unitDir: join(root, 'units'),
		runtimeDir,
		stateDir,
		volumeRegistry: {},
		releaseDirs: [join(root, 'releases')],
		bunPath: '/usr/local/bin/bun',
		podmanPath: '/usr/bin/podman',
		restorePollMs: 0,
		chown: async (path, uid, gid) => {
			chowns.push([path, uid, gid]);
		},
	});
	return { root, dataDir, runner, driver, chowns };
}

function bodyOf(text: string): ReadableStream<Uint8Array> {
	return new Response(text).body!;
}

describe('Valkey/Redis backups through the driver', () => {
	test('dump takes an RDB snapshot, checks it and returns it from the data dir', async () => {
		const f = await engineFixture('valkey');
		const dump = await f.driver.dumpDatabase(DB_ID);
		expect(dump.filename).toBe(`${DB_ID}.rdb`);
		expect(dump.path.startsWith(join(f.dataDir, 'skiff-dumps', 'dump-'))).toBe(true);
		expect(await fs.readFile(dump.path, 'utf8')).toBe('REDIS0012-snapshot');
		expect(dump.sizeBytes).toBe(18);
		expect((await fs.stat(dump.path)).mode & 0o777).toBe(0o400);
		const [rdb, check] = f.runner.calls;
		expect(rdb!.argv).toContain('--rdb');
		expect(rdb!.env).toEqual({ REDISCLI_AUTH: PASSWORD });
		expect(rdb!.argv.join(' ')).not.toContain(PASSWORD);
		expect(check!.argv[3]).toBe('valkey-check-rdb');
		expect(f.chowns).toContainEqual([join(f.dataDir, 'skiff-dumps'), 999, 1000]);
	});

	test('a snapshot that fails check-rdb is deleted and the dump fails', async () => {
		const f = await engineFixture('valkey');
		f.runner.checkCode = 1;
		await expect(f.driver.dumpDatabase(DB_ID)).rejects.toThrow(/check-rdb rejected/);
		expect(await fs.readdir(join(f.dataDir, 'skiff-dumps'))).toEqual([]);
	});

	test('restore installs the snapshot as the AOF base, restarts the unit and waits for PONG', async () => {
		const f = await engineFixture('valkey');
		await fs.mkdir(join(f.dataDir, 'appendonlydir'));
		await fs.writeFile(join(f.dataDir, 'appendonlydir', 'appendonly.aof.1.incr.aof'), 'old');
		await fs.writeFile(join(f.dataDir, 'dump.rdb'), 'old');
		f.runner.pingReplies = ['LOADING Valkey is loading the dataset in memory'];
		await f.driver.restoreDatabase(DB_ID, bodyOf('REDIS0012-restored'));

		const aof = join(f.dataDir, 'appendonlydir');
		expect((await fs.readdir(aof)).sort()).toEqual(['appendonly.aof.1.base.rdb', 'appendonly.aof.manifest']);
		expect(await fs.readFile(join(aof, 'appendonly.aof.1.base.rdb'), 'utf8')).toBe('REDIS0012-restored');
		expect(await fs.readFile(join(aof, 'appendonly.aof.manifest'), 'utf8')).toBe('file appendonly.aof.1.base.rdb seq 1 type b\n');
		expect(await fs.stat(join(f.dataDir, 'dump.rdb')).catch(() => null)).toBeNull();
		expect(await fs.readdir(join(f.dataDir, 'skiff-dumps'))).toEqual([]);
		expect(f.runner.units).toEqual([`stop skiff-workload-${DB_ID}.service`, `start skiff-workload-${DB_ID}.service`]);
		// check-rdb runs before the stop; PING is retried while the dataset loads.
		const kinds = f.runner.calls.map((call) => (call.argv[0]!.endsWith('systemctl') ? call.argv[1] : call.argv.at(-1)!.split('/').pop()));
		expect(kinds[1]).toBe('stop');
		expect(kinds.filter((kind) => kind === 'PING')).toHaveLength(2);
		expect(f.chowns).toContainEqual([join(aof, 'appendonly.aof.1.base.rdb'), 999, 1000]);
	});

	test('a corrupt artifact is refused before the target is stopped', async () => {
		const f = await engineFixture('valkey');
		f.runner.checkCode = 1;
		await expect(f.driver.restoreDatabase(DB_ID, bodyOf('garbage'))).rejects.toThrow(/check-rdb rejected the backup/);
		expect(f.runner.units).toEqual([]);
		expect(await fs.readdir(join(f.dataDir, 'skiff-dumps'))).toEqual([]);
	});

	test('a restore that never answers PING fails after starting the unit again', async () => {
		const f = await engineFixture('valkey');
		f.runner.pingReplies = Array.from({ length: 600 }, () => 'LOADING');
		await expect(f.driver.restoreDatabase(DB_ID, bodyOf('REDIS0012'))).rejects.toThrow(/did not answer PING/);
		expect(f.runner.units.at(-1)).toBe(`start skiff-workload-${DB_ID}.service`);
	});
});

describe('ClickHouse backups through the driver', () => {
	test('dump runs BACKUP into the staging dir with the password in the environment only', async () => {
		const f = await engineFixture('clickhouse');
		const dump = await f.driver.dumpDatabase(DB_ID);
		expect(dump.filename).toBe(`${DB_ID}.zip`);
		expect(await fs.readFile(dump.path, 'utf8')).toBe('PK-archive');
		const [backup] = f.runner.calls;
		expect(backup!.argv.at(-1)).toMatch(/^BACKUP DATABASE `shop_events` AS `skiff_backup` TO File\('\/data\/skiff-dumps\/dump-[a-f0-9-]+\.zip'\)$/);
		expect(backup!.env).toEqual({ CLICKHOUSE_PASSWORD: PASSWORD });
		expect(f.chowns).toContainEqual([join(f.dataDir, 'skiff-dumps'), 101, 101]);
	});

	test('restore runs RESTORE into the target, verifies it and removes the staged archive', async () => {
		const f = await engineFixture('clickhouse');
		await f.driver.restoreDatabase(DB_ID, bodyOf('PK-archive'));
		const queries = f.runner.calls.map((call) => call.argv.at(-1)!);
		expect(queries[0]).toMatch(/^RESTORE DATABASE `skiff_backup` AS `shop_events` FROM File\('\/data\/skiff-dumps\/restore-[a-f0-9-]+\.zip'\)/);
		expect(queries[1]).toBe("SELECT 'skiff-ok' FROM system.databases WHERE name = 'shop_events'");
		expect(f.runner.units).toEqual([]);
		expect(await fs.readdir(join(f.dataDir, 'skiff-dumps'))).toEqual([]);
	});

	test('a failed RESTORE surfaces the server error and still removes the archive', async () => {
		const f = await engineFixture('clickhouse');
		f.runner.restoreCode = 1;
		await expect(f.driver.restoreDatabase(DB_ID, bodyOf('PK-archive'))).rejects.toThrow(/RESTORE failed \(1\): Code: 598/);
		expect(await fs.readdir(join(f.dataDir, 'skiff-dumps'))).toEqual([]);
	});

	test('stale staging leftovers are pruned before the next run', async () => {
		const f = await engineFixture('clickhouse');
		const staging = join(f.dataDir, 'skiff-dumps');
		await fs.mkdir(staging);
		const old = join(staging, 'dump-0123abcd.zip');
		await fs.writeFile(old, 'stale');
		const past = new Date(Date.now() - 2 * 60 * 60_000);
		await fs.utimes(old, past, past);
		await fs.writeFile(join(staging, 'keep.txt'), 'not ours');
		const dump = await f.driver.dumpDatabase(DB_ID);
		expect((await fs.readdir(staging)).sort()).toEqual([dump.path.split('/').pop()!, 'keep.txt'].sort());
	});
});
