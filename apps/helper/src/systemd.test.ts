import { afterEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SystemdDriver, type CommandRunner, type RunResult } from './systemd.ts';
import { parseWorkload, type WorkloadActivation, type WorkloadDesired } from './validate.ts';

const SHA = 'a'.repeat(64);
const directories: string[] = [];

class FakeRunner implements CommandRunner {
	calls: string[][] = [];
	show = '';
	journal = '';

	async run(argv: string[]): Promise<RunResult> {
		this.calls.push(argv);
		if (argv[1] === 'show') return { code: 0, stdout: this.show, stderr: '' };
		if (argv[0]?.includes('journalctl')) return { code: 0, stdout: this.journal, stderr: '' };
		return { code: 0, stdout: '', stderr: '' };
	}

	count(command: string): number {
		return this.calls.filter((argv) => argv[1] === command).length;
	}
}

interface Fixture {
	root: string;
	releaseDir: string;
	driver: SystemdDriver;
	runner: FakeRunner;
	unitDir: string;
	quadletDir: string;
	runtimeDir: string;
	stateDir: string;
	chowns: Array<[string, number, number]>;
}

async function fixture(options: { packageJson?: boolean } = {}): Promise<Fixture> {
	const root = await fs.mkdtemp(join(tmpdir(), 'skiff-helper-systemd-'));
	directories.push(root);
	const unitDir = join(root, 'units');
	const quadletDir = join(root, 'quadlet');
	const runtimeDir = join(root, 'run');
	const stateDir = join(root, 'state');
	const releases = join(root, 'releases');
	const releaseDir = join(releases, SHA);
	await fs.mkdir(releaseDir, { recursive: true });
	if (options.packageJson !== false) await fs.writeFile(join(releaseDir, 'package.json'), '{"name":"app"}');

	const runner = new FakeRunner();
	const chowns: Array<[string, number, number]> = [];
	const driver = new SystemdDriver({
		chown: async (path, uid, gid) => {
			chowns.push([path, uid, gid]);
		},
		runner,
		unitDir,
		quadletDir,
		runtimeDir,
		stateDir,
		releaseDirs: [releases],
		bunPath: '/usr/local/bin/bun',
		socketMode: '0660',
		socketGroup: 'caddy',
	});
	return { root, releaseDir, driver, runner, unitDir, quadletDir, runtimeDir, stateDir, chowns };
}

function workload(overrides: Record<string, unknown> = {}): WorkloadDesired {
	return parseWorkload({
		id: 'wld_abc123',
		projectId: 'prj_abc123',
		projectSlug: 'my-app',
		deploymentId: 'dep_abc123',
		runtime: 'process',
		status: 'running',
		release: SHA,
		upstream: 'unix//run/skiff-workloads/prj_abc123.sock',
		memoryMb: 256,
		cpus: 1,
		port: 3000,
		healthPath: '/health',
		socketActivation: true,
		activationVersion: 'b'.repeat(64),
		env: { NODE_ENV: 'production' },
		secrets: [],
		dataSizeMb: null,
		...overrides,
	});
}

function activation(overrides: Record<string, unknown> = {}): WorkloadActivation {
	return {
		workloadId: 'wld_abc123',
		activationVersion: 'b'.repeat(64),
		env: { NODE_ENV: 'production', DATABASE_URL: 'postgres://secret' },
		files: {},
		...overrides,
	};
}

afterEach(async () => {
	await Promise.all(directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('ensureSlice', () => {
	test('writes the slice, reloads systemd and starts it with argv arrays', async () => {
		const f = await fixture();
		await f.driver.ensureSlice({ memoryMb: 1024 });
		const slice = await fs.readFile(join(f.unitDir, 'skiff-workloads.slice'), 'utf8');
		expect(slice).toContain('MemoryMax=1024M');
		expect(slice).toContain('CPUWeight=200');
		expect(f.runner.calls).toContainEqual(['/usr/bin/systemctl', 'daemon-reload']);
		expect(f.runner.calls).toContainEqual(['/usr/bin/systemctl', 'start', 'skiff-workloads.slice']);
		// Every call is an argv array; the helper never builds a shell string.
		expect(f.runner.calls.every((argv) => argv.every((part) => !part.includes(' ; ')))).toBe(true);
	});
});

describe('apply', () => {
	test('installs a hardened process unit, env file and secret files', async () => {
		const f = await fixture();
		f.runner.show = 'ActiveState=active\nSubState=running\nNRestarts=0\nMemoryCurrent=1048576\nResult=success\n';
		const desired = workload({ secrets: [{ name: 'TLS_KEY', delivery: 'file' }] });
		const status = await f.driver.apply(
			desired,
			activation({ files: { TLS_KEY: '-----BEGIN KEY-----\nabc\n-----END KEY-----\n' } }),
		);

		const service = await fs.readFile(join(f.unitDir, 'skiff-workload-wld_abc123.service'), 'utf8');
		expect(service).toContain(`WorkingDirectory=${f.releaseDir}`);
		expect(service).toContain('ExecStart="/usr/local/bin/bun" "run" "start"');
		expect(service).toContain('LoadCredential=TLS_KEY:' + join(f.runtimeDir, 'wld_abc123/secrets/TLS_KEY'));

		const socket = await fs.readFile(join(f.unitDir, 'skiff-workload-wld_abc123.socket'), 'utf8');
		expect(socket).toContain(`ListenStream=${join(f.runtimeDir, 'prj_abc123.sock')}`);

		const envFile = join(f.runtimeDir, 'wld_abc123/env');
		const env = await fs.readFile(envFile, 'utf8');
		expect(env).toContain('DATABASE_URL="postgres://secret"');
		expect((await fs.stat(envFile)).mode & 0o777).toBe(0o400);

		const secretPath = join(f.runtimeDir, 'wld_abc123/secrets/TLS_KEY');
		expect(await fs.readFile(secretPath, 'utf8')).toContain('BEGIN KEY');
		expect((await fs.stat(secretPath)).mode & 0o777).toBe(0o400);

		expect(status.status).toBe('running');
		expect(status.memoryBytes).toBe(1_048_576);
		expect(f.runner.calls).toContainEqual([
			'/usr/bin/systemctl',
			'enable',
			'skiff-workload-wld_abc123.socket',
		]);
		expect(f.runner.calls).toContainEqual([
			'/usr/bin/systemctl',
			'restart',
			'skiff-workload-wld_abc123.service',
		]);
	});

	test('uses bun run start only when the release has a package.json', async () => {
		const withManifest = await fixture();
		await withManifest.driver.apply(workload(), activation());
		const unit = await fs.readFile(
			join(withManifest.unitDir, 'skiff-workload-wld_abc123.service'),
			'utf8',
		);
		expect(unit).toContain('ExecStart="/usr/local/bin/bun" "run" "start"');

		const withoutManifest = await fixture({ packageJson: false });
		await expect(withoutManifest.driver.apply(workload(), activation())).rejects.toThrow(
			/workload.command is required/,
		);
	});

	test('honours an explicit command and rejects undeclared secret files', async () => {
		const f = await fixture();
		await f.driver.apply(workload({ command: ['/opt/bin/app', '--serve'] }), activation());
		const unit = await fs.readFile(join(f.unitDir, 'skiff-workload-wld_abc123.service'), 'utf8');
		expect(unit).toContain('ExecStart="/opt/bin/app" "--serve"');

		await expect(
			f.driver.apply(workload(), activation({ files: { EXTRA: 'x' } })),
		).rejects.toThrow(/not a file secret/);
	});

	test('is idempotent: unchanged units are not rewritten or reloaded again', async () => {
		const f = await fixture();
		await f.driver.apply(workload(), activation());
		const reloads = f.runner.count('daemon-reload');
		await f.driver.apply(workload(), activation());
		expect(f.runner.count('daemon-reload')).toBe(reloads);
	});

	test('renders a Quadlet container and removes stale process units', async () => {
		const f = await fixture();
		await f.driver.apply(workload(), activation());
		f.runner.show = 'ActiveState=active\nSubState=running\nNRestarts=0\nResult=success\n';
		const container = workload({
			runtime: 'container',
			release: null,
			image: 'ghcr.io/acme/app:1.2.3',
			socketActivation: false,
			activationVersion: 'c'.repeat(64),
		});
		const status = await f.driver.apply(
			container,
			activation({ activationVersion: 'c'.repeat(64) }),
		);
		expect(status.status).toBe('running');

		const quadlet = await fs.readFile(
			join(f.quadletDir, 'skiff-workload-wld_abc123.container'),
			'utf8',
		);
		expect(quadlet).toContain('Image=ghcr.io/acme/app:1.2.3');
		expect(quadlet).toContain('PublishPort=127.0.0.1:3000:3000');
		await expect(fs.stat(join(f.unitDir, 'skiff-workload-wld_abc123.service'))).rejects.toThrow();
		await expect(fs.stat(join(f.unitDir, 'skiff-workload-wld_abc123.socket'))).rejects.toThrow();
		expect(f.runner.calls).toContainEqual([
			'/usr/bin/systemctl',
			'restart',
			'skiff-workload-wld_abc123.service',
		]);
	});
});

describe('logs', () => {
	test('reads journald JSON after a cursor with a fixed argv', async () => {
		const f = await fixture();
		f.runner.journal = [
			JSON.stringify({
				__CURSOR: 's=10',
				__REALTIME_TIMESTAMP: '1700000000000000',
				PRIORITY: '3',
				MESSAGE: 'upstream refused',
			}),
			JSON.stringify({
				__CURSOR: 's=11',
				__REALTIME_TIMESTAMP: '1700000000100000',
				PRIORITY: '6',
				MESSAGE: [104, 105],
			}),
			'not json',
		].join('\n');

		const result = await f.driver.logs('wld_abc123', { cursor: 's=9', lines: 50 });
		expect(result.entries).toEqual([
			{ cursor: 's=10', ts: 1_700_000_000_000, priority: 3, message: 'upstream refused' },
			{ cursor: 's=11', ts: 1_700_000_000_100, priority: 6, message: 'hi' },
		]);
		expect(result.nextCursor).toBe('s=11');
		const call = f.runner.calls.find((argv) => argv[0]?.includes('journalctl'));
		expect(call).toContain('--after-cursor');
		expect(call).toContain('skiff-workload-wld_abc123.service');
		expect(call).toContain('50');
	});
});

describe('remove', () => {
	test('disables units, deletes unit files and scrubs the runtime directory', async () => {
		const f = await fixture();
		await f.driver.apply(
			workload({ secrets: [{ name: 'TLS_KEY', delivery: 'file' }] }),
			activation({ files: { TLS_KEY: 'secret' } }),
		);
		await f.driver.remove('wld_abc123');

		expect(f.runner.calls).toContainEqual([
			'/usr/bin/systemctl',
			'disable',
			'--now',
			'skiff-workload-wld_abc123.service',
		]);
		await expect(fs.stat(join(f.unitDir, 'skiff-workload-wld_abc123.service'))).rejects.toThrow();
		await expect(fs.stat(join(f.unitDir, 'skiff-workload-wld_abc123.socket'))).rejects.toThrow();
		await expect(fs.stat(join(f.runtimeDir, 'wld_abc123'))).rejects.toThrow();
	});

	test('rejects invalid ids before touching the filesystem', async () => {
		const f = await fixture();
		await expect(f.driver.remove('../etc')).rejects.toThrow(/id/);
		await expect(f.driver.status('a/b')).rejects.toThrow(/id/);
	});
});

describe('status', () => {
	test('maps systemd state onto workload statuses', async () => {
		const f = await fixture();
		f.runner.show = 'ActiveState=activating\nSubState=start\nNRestarts=0\nResult=success\n';
		expect((await f.driver.status('wld_abc123')).status).toBe('starting');

		f.runner.show = 'ActiveState=failed\nSubState=failed\nNRestarts=3\nResult=exit-code\n';
		expect((await f.driver.status('wld_abc123')).status).toBe('failed');

		f.runner.show = 'ActiveState=active\nSubState=running\nNRestarts=6\nMemoryCurrent=[not set]\n';
		const looping = await f.driver.status('wld_abc123');
		expect(looping.status).toBe('failed');
		expect(looping.restarts).toBe(6);
		expect(looping.memoryBytes).toBeUndefined();

		f.runner.show = 'ActiveState=inactive\nSubState=dead\nNRestarts=0\n';
		expect((await f.driver.status('wld_abc123')).status).toBe('stopped');
	});
});

const DB_ID = 'db_0123456789abcdef0123456789abcdef';

function database(overrides: Record<string, unknown> = {}): WorkloadDesired {
	return workload({
		id: DB_ID,
		projectId: DB_ID,
		projectSlug: 'orders',
		deploymentId: DB_ID,
		runtime: 'container',
		release: null,
		image: 'docker.io/library/postgres:17-alpine',
		upstream: '127.0.0.1:15432',
		port: 15432,
		healthPath: '/',
		socketActivation: false,
		env: { POSTGRES_USER: 'orders', POSTGRES_DB: 'orders', PGDATA: '/elsewhere' },
		database: { engine: 'postgres', version: '17' },
		...overrides,
	});
}

function databaseActivation(): WorkloadActivation {
	return { workloadId: DB_ID, activationVersion: 'b'.repeat(64), env: { POSTGRES_PASSWORD: 'pw' }, files: {} };
}

describe('container network', () => {
	test('writes the shared network before the first container and reloads once', async () => {
		const f = await fixture();
		const container = workload({
			runtime: 'container',
			release: null,
			image: 'ghcr.io/acme/app:1.2.3',
			socketActivation: false,
		});
		await f.driver.apply(container, activation());
		const network = await fs.readFile(join(f.quadletDir, 'skiff-workloads.network'), 'utf8');
		expect(network).toContain('NetworkName=skiff-workloads');
		const quadlet = await fs.readFile(join(f.quadletDir, 'skiff-workload-wld_abc123.container'), 'utf8');
		expect(quadlet).toContain('Network=skiff-workloads.network');
		expect(f.runner.count('daemon-reload')).toBe(1);

		// Unchanged network + unit: no reload.
		await f.driver.apply(container, activation());
		expect(f.runner.count('daemon-reload')).toBe(1);

		// A missing network unit alone triggers a reload.
		await fs.rm(join(f.quadletDir, 'skiff-workloads.network'));
		await f.driver.apply(container, activation());
		expect(f.runner.count('daemon-reload')).toBe(2);
	});

	test('process workloads do not need the network unit', async () => {
		const f = await fixture();
		await f.driver.apply(workload(), activation());
		await expect(fs.stat(join(f.quadletDir, 'skiff-workloads.network'))).rejects.toThrow();
	});
});

describe('database profile', () => {
	test('renders the database unit, pins PGDATA and hands the data dir to 70:70', async () => {
		const f = await fixture();
		f.runner.show = 'ActiveState=activating\nSubState=start\nNRestarts=0\n';
		const status = await f.driver.apply(database(), databaseActivation());
		expect(status.status).toBe('starting');

		const quadlet = await fs.readFile(join(f.quadletDir, `skiff-workload-${DB_ID}.container`), 'utf8');
		expect(quadlet).toContain('User=70:70');
		expect(quadlet).toContain('PublishPort=127.0.0.1:15432:5432');
		expect(quadlet).toContain('NetworkAlias=db-0123456789abcdef0123456789abcdef');
		expect(await fs.readFile(join(f.quadletDir, 'skiff-workloads.network'), 'utf8')).toContain('[Network]');

		const env = await fs.readFile(join(f.runtimeDir, DB_ID, 'env'), 'utf8');
		// Podman reads env files literally, so container values are written unquoted.
		expect(env).toContain('PGDATA=/data/pgdata\n');
		expect(env).not.toContain('/elsewhere');
		expect(env).toContain('POSTGRES_PASSWORD=pw\n');
		expect(env).not.toContain('"');

		const dataDir = join(f.stateDir, DB_ID);
		expect((await fs.stat(dataDir)).mode & 0o777).toBe(0o700);
		expect(f.chowns).toEqual([[dataDir, 70, 70]]);

		// The first start can pull an image for minutes; the helper must not block on it.
		expect(f.runner.calls).toContainEqual([
			'/usr/bin/systemctl',
			'restart',
			'--no-block',
			`skiff-workload-${DB_ID}.service`,
		]);
	});

	test('app containers are not chowned and restart synchronously', async () => {
		const f = await fixture();
		await f.driver.apply(
			workload({ runtime: 'container', release: null, image: 'ghcr.io/acme/app:1', socketActivation: false }),
			activation(),
		);
		expect(f.chowns).toEqual([]);
		expect(f.runner.calls).toContainEqual(['/usr/bin/systemctl', 'restart', 'skiff-workload-wld_abc123.service']);
	});

	test('refuses to chown a data dir that is a symlink', async () => {
		const f = await fixture();
		const outside = join(f.root, 'outside');
		await fs.mkdir(outside);
		await fs.mkdir(f.stateDir, { recursive: true });
		await fs.symlink(outside, join(f.stateDir, DB_ID));
		await expect(f.driver.apply(database(), databaseActivation())).rejects.toThrow(/not a directory/);
		expect(f.chowns).toEqual([]);
	});
});

const ST_ID = 'st_fedcba9876543210fedcba9876543210';

function storage(overrides: Record<string, unknown> = {}): WorkloadDesired {
	return workload({
		id: ST_ID,
		projectId: ST_ID,
		projectSlug: 'media',
		deploymentId: ST_ID,
		runtime: 'container',
		release: null,
		image: 'docker.io/rustfs/rustfs:1.0.4',
		upstream: '127.0.0.1:19000',
		port: 19000,
		healthPath: '/health',
		socketActivation: false,
		env: { RUSTFS_VOLUMES: '/elsewhere', RUSTFS_CONSOLE_ENABLE: 'true', RUSTFS_OBS_LOG_DIRECTORY: '/logs' },
		objectStorage: {
			engine: 'rustfs',
			version: '1.0.4',
			buckets: [{ name: 'uploads', access: 'private' }],
			users: [{ accessKeyId: 'SKFAAAAAAAAAAAAAAAAA', grants: [{ bucket: 'uploads', mode: 'read-write' }] }],
			deleteBuckets: [],
			keysVersion: 'c'.repeat(64),
		},
		...overrides,
	});
}

function storageActivation(): WorkloadActivation {
	return {
		workloadId: ST_ID,
		activationVersion: 'b'.repeat(64),
		env: { RUSTFS_ACCESS_KEY: 'SKRROOT', RUSTFS_SECRET_KEY: 'root-secret' },
		files: {},
	};
}

describe('storage profile', () => {
	test('renders the storage unit, forces the RustFS env and hands the data dir to 10001:10001', async () => {
		const f = await fixture();
		f.runner.show = 'ActiveState=activating\nSubState=start\nNRestarts=0\n';
		const status = await f.driver.apply(storage(), storageActivation());
		expect(status.status).toBe('starting');

		const quadlet = await fs.readFile(join(f.quadletDir, `skiff-workload-${ST_ID}.container`), 'utf8');
		expect(quadlet).toContain(
			'Image=docker.io/rustfs/rustfs:1.0.4@sha256:ed9210d6411d77ffceb70d94b964a3cb7d225983368bc25bebe01e995293dcc2',
		);
		expect(quadlet).toContain('User=10001:10001');
		expect(quadlet).toContain('PublishPort=127.0.0.1:19000:9000');
		expect(quadlet).toContain('NetworkAlias=s3-fedcba9876543210fedcba9876543210');

		const env = await fs.readFile(join(f.runtimeDir, ST_ID, 'env'), 'utf8');
		expect(env).toBe(
			[
				'RUSTFS_ACCESS_KEY=SKRROOT',
				'RUSTFS_ADDRESS=:9000',
				'RUSTFS_CONSOLE_ENABLE=false',
				// An explicit empty value overrides the image's /logs default: logs go to the journal.
				'RUSTFS_OBS_LOG_DIRECTORY=',
				'RUSTFS_SECRET_KEY=root-secret',
				'RUSTFS_VOLUMES=/data',
				'',
			].join('\n'),
		);
		expect((await fs.stat(join(f.runtimeDir, ST_ID, 'env'))).mode & 0o777).toBe(0o400);

		const dataDir = join(f.stateDir, ST_ID);
		expect((await fs.stat(dataDir)).mode & 0o777).toBe(0o700);
		expect(f.chowns).toEqual([[dataDir, 10001, 10001]]);
		expect(f.runner.calls).toContainEqual([
			'/usr/bin/systemctl',
			'restart',
			'--no-block',
			`skiff-workload-${ST_ID}.service`,
		]);
	});

	test('refuses to chown a storage data dir that is a symlink', async () => {
		const f = await fixture();
		const outside = join(f.root, 'outside');
		await fs.mkdir(outside);
		await fs.mkdir(f.stateDir, { recursive: true });
		await fs.symlink(outside, join(f.stateDir, ST_ID));
		await expect(f.driver.apply(storage(), storageActivation())).rejects.toThrow(/not a directory/);
		expect(f.chowns).toEqual([]);
	});

	test('refuses a container env value with a line break before writing anything', async () => {
		const f = await fixture();
		await expect(
			f.driver.apply(storage(), { ...storageActivation(), env: { RUSTFS_SECRET_KEY: 'a\nb' } }),
		).rejects.toThrow(/line break/);
		await expect(fs.stat(join(f.runtimeDir, ST_ID, 'env'))).rejects.toThrow();
	});
});

describe('purge', () => {
	test('removes the unit first, then deletes only <stateDir>/<id>', async () => {
		const f = await fixture();
		await f.driver.apply(database(), databaseActivation());
		const dataDir = join(f.stateDir, DB_ID);
		await fs.mkdir(join(dataDir, 'pgdata', 'base'), { recursive: true });
		await fs.writeFile(join(dataDir, 'pgdata', 'PG_VERSION'), '17');
		const sibling = join(f.stateDir, 'db_other');
		await fs.mkdir(sibling);

		await f.driver.purge(DB_ID);

		const disableAt = f.runner.calls.findIndex(
			(argv) => argv[1] === 'disable' && argv[3] === `skiff-workload-${DB_ID}.service`,
		);
		expect(disableAt).toBeGreaterThanOrEqual(0);
		await expect(fs.stat(join(f.quadletDir, `skiff-workload-${DB_ID}.container`))).rejects.toThrow();
		await expect(fs.stat(join(f.runtimeDir, DB_ID))).rejects.toThrow();
		await expect(fs.stat(dataDir)).rejects.toThrow();
		expect((await fs.stat(sibling)).isDirectory()).toBe(true);
		expect((await fs.stat(f.stateDir)).isDirectory()).toBe(true);
	});

	test('purges a storage instance the same way', async () => {
		const f = await fixture();
		await f.driver.apply(storage(), storageActivation());
		const dataDir = join(f.stateDir, ST_ID);
		await fs.mkdir(join(dataDir, '.rustfs.sys'), { recursive: true });
		const sibling = join(f.stateDir, 'st_other');
		await fs.mkdir(sibling);
		await f.driver.purge(ST_ID);
		await expect(fs.stat(join(f.quadletDir, `skiff-workload-${ST_ID}.container`))).rejects.toThrow();
		await expect(fs.stat(dataDir)).rejects.toThrow();
		expect((await fs.stat(sibling)).isDirectory()).toBe(true);
	});

	test('is idempotent: a missing data dir is success', async () => {
		const f = await fixture();
		await f.driver.purge(DB_ID);
		await f.driver.purge(DB_ID);
	});

	test('only accepts db_/st_ ids that are safe path segments', async () => {
		const f = await fixture();
		await fs.mkdir(join(f.stateDir, 'wld_abc123'), { recursive: true });
		for (const id of ['wld_abc123', '../state', 'db_../x', 'db_', 'db_a/b', 'st_', 'st_../x', 'st_a/b', '']) {
			await expect(f.driver.purge(id)).rejects.toThrow();
		}
		expect((await fs.stat(join(f.stateDir, 'wld_abc123'))).isDirectory()).toBe(true);
		// Nothing was stopped for a rejected id.
		expect(f.runner.calls).toEqual([]);
	});
});
