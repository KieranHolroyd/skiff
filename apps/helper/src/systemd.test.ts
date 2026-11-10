import { afterEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHandler } from './server.ts';
import { STUDIO_UNIT, SystemdDriver, takeRegistryFiles, type CommandRunner, type RunResult } from './systemd.ts';
import { databaseTlsPaths } from './tls.ts';
import { parseWorkload, type WorkloadActivation, type WorkloadDesired } from './validate.ts';

const SHA = 'a'.repeat(64);
const directories: string[] = [];

class FakeRunner implements CommandRunner {
	calls: string[][] = [];
	show = '';
	journal = '';
	/** `podman network inspect` output; empty means the container is not attached yet. */
	network = '';
	/** `podman ps --all --format {{.Names}}` output, one name per line. */
	containers = '';

	/** Result for `systemctl <verb> …`, keyed by verb, instead of success. */
	fail: Record<string, RunResult> = {};

	async run(argv: string[]): Promise<RunResult> {
		this.calls.push(argv);
		const failure = argv[0]?.endsWith('systemctl') ? this.fail[argv[1] ?? ''] : undefined;
		if (failure) return failure;
		if (argv[1] === 'show') return { code: 0, stdout: this.show, stderr: '' };
		if (argv[0]?.includes('journalctl')) return { code: 0, stdout: this.journal, stderr: '' };
		if (argv[1] === 'network' && argv[2] === 'inspect') return { code: 0, stdout: this.network, stderr: '' };
		if (argv[0]?.endsWith('podman') && argv[1] === 'ps') return { code: 0, stdout: this.containers, stderr: '' };
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
	volumeRegistryFile: string;
	chowns: Array<[string, number, number]>;
}

async function fixture(
	options: {
		packageJson?: boolean;
		databaseTlsGenerator?: import('./tls.ts').DatabaseTlsGenerator;
		containerSubids?: import('./userns.ts').SubidFiles;
	} = {},
): Promise<Fixture> {
	const root = await fs.mkdtemp(join(tmpdir(), 'yoal-helper-systemd-'));
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
		volumeRegistryFile: join(root, 'volumes.json'),
		bunPath: '/usr/local/bin/bun',
		socketMode: '0660',
		socketGroup: 'caddy',
		...(options.databaseTlsGenerator ? { databaseTlsGenerator: options.databaseTlsGenerator } : {}),
		...(options.containerSubids ? { containerSubids: options.containerSubids } : {}),
	});
	return {
		root,
		releaseDir,
		driver,
		runner,
		unitDir,
		quadletDir,
		runtimeDir,
		stateDir,
		volumeRegistryFile: join(root, 'volumes.json'),
		chowns,
	};
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
		upstream: 'unix//run/yoal-workloads/prj_abc123.sock',
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
		const slice = await fs.readFile(join(f.unitDir, 'yoal-workloads.slice'), 'utf8');
		expect(slice).toContain('MemoryMax=1024M');
		expect(slice).toContain('CPUWeight=200');
		expect(f.runner.calls).toContainEqual(['/usr/bin/systemctl', 'daemon-reload']);
		expect(f.runner.calls).toContainEqual(['/usr/bin/systemctl', 'start', 'yoal-workloads.slice']);
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

		const service = await fs.readFile(join(f.unitDir, 'yoal-workload-wld_abc123.service'), 'utf8');
		expect(service).toContain(`WorkingDirectory=${f.releaseDir}`);
		expect(service).toContain('ExecStart="/usr/local/bin/bun" "run" "start"');
		expect(service).toContain('LoadCredential=TLS_KEY:' + join(f.runtimeDir, 'wld_abc123/secrets/TLS_KEY'));

		const socket = await fs.readFile(join(f.unitDir, 'yoal-workload-wld_abc123.socket'), 'utf8');
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
			'yoal-workload-wld_abc123.socket',
		]);
		expect(f.runner.calls).toContainEqual([
			'/usr/bin/systemctl',
			'restart',
			'yoal-workload-wld_abc123.service',
		]);
	});

	test('uses bun run start only when the release has a package.json', async () => {
		const withManifest = await fixture();
		await withManifest.driver.apply(workload(), activation());
		const unit = await fs.readFile(
			join(withManifest.unitDir, 'yoal-workload-wld_abc123.service'),
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
		const unit = await fs.readFile(join(f.unitDir, 'yoal-workload-wld_abc123.service'), 'utf8');
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
			join(f.quadletDir, 'yoal-workload-wld_abc123.container'),
			'utf8',
		);
		expect(quadlet).toContain('Image=ghcr.io/acme/app:1.2.3');
		expect(quadlet).toContain('PublishPort=127.0.0.1:3000:3000');
		await expect(fs.stat(join(f.unitDir, 'yoal-workload-wld_abc123.service'))).rejects.toThrow();
		await expect(fs.stat(join(f.unitDir, 'yoal-workload-wld_abc123.socket'))).rejects.toThrow();
		expect(f.runner.calls).toContainEqual([
			'/usr/bin/systemctl',
			'restart',
			'yoal-workload-wld_abc123.service',
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
		// Each option keeps its own value: `-u --after-cursor <c>` would make journalctl treat
		// the cursor as a match ("Failed to add match ... Invalid argument").
		const after = call!.indexOf('--after-cursor');
		expect(call![after + 1]).toBe('s=9');
		expect(call![call!.indexOf('-u') + 1]).toBe('yoal-workload-wld_abc123.service');
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
			'yoal-workload-wld_abc123.service',
		]);
		await expect(fs.stat(join(f.unitDir, 'yoal-workload-wld_abc123.service'))).rejects.toThrow();
		await expect(fs.stat(join(f.unitDir, 'yoal-workload-wld_abc123.socket'))).rejects.toThrow();
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

describe('stop and restart', () => {
	test('stops only the service, leaving the socket unit listening', async () => {
		const f = await fixture();
		await f.driver.stop('wld_abc123');
		expect(f.runner.calls).toEqual([
			['/usr/bin/systemctl', 'stop', 'yoal-workload-wld_abc123.service'],
		]);
		// The listener survives: nothing touches the .socket unit (RemoveOnStop=yes is on it).
		expect(f.runner.calls.some((argv) => argv.includes('yoal-workload-wld_abc123.socket'))).toBe(false);
	});

	test('stop is idempotent, even when systemd no longer knows the unit', async () => {
		const f = await fixture();
		await f.driver.stop('wld_abc123');
		f.runner.fail.stop = { code: 1, stdout: '', stderr: 'Unit yoal-workload-wld_abc123.service not loaded.\n' };
		await expect(f.driver.stop('wld_abc123')).resolves.toBeUndefined();
		expect(f.runner.count('stop')).toBe(2);
	});

	test('restarts the service and then the socket, exactly like apply', async () => {
		const f = await fixture();
		await f.driver.restart('wld_abc123');
		expect(f.runner.calls).toEqual([
			['/usr/bin/systemctl', 'restart', 'yoal-workload-wld_abc123.service'],
			['/usr/bin/systemctl', 'restart', 'yoal-workload-wld_abc123.socket'],
		]);
		// Idempotent: repeating the fixed pair is the same request.
		await f.driver.restart('wld_abc123');
		expect(f.runner.count('restart')).toBe(4);
	});

	test('a failed restart surfaces the systemctl error', async () => {
		const f = await fixture();
		f.runner.fail.restart = { code: 1, stdout: '', stderr: 'Unit yoal-workload-wld_abc123.service not found.\n' };
		await expect(f.driver.restart('wld_abc123')).rejects.toThrow(/systemctl restart failed/);
	});

	test('rejects invalid ids before touching systemd', async () => {
		const f = await fixture();
		await expect(f.driver.stop('../etc')).rejects.toThrow(/id must match/);
		await expect(f.driver.restart('a b')).rejects.toThrow(/id must match/);
		expect(f.runner.calls).toEqual([]);
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
		const network = await fs.readFile(join(f.quadletDir, 'yoal-workloads.network'), 'utf8');
		expect(network).toContain('NetworkName=yoal-workloads');
		const quadlet = await fs.readFile(join(f.quadletDir, 'yoal-workload-wld_abc123.container'), 'utf8');
		expect(quadlet).toContain('Network=yoal-workloads.network');
		expect(f.runner.count('daemon-reload')).toBe(1);

		// Unchanged network + unit: no reload.
		await f.driver.apply(container, activation());
		expect(f.runner.count('daemon-reload')).toBe(1);

		// A missing network unit alone triggers a reload.
		await fs.rm(join(f.quadletDir, 'yoal-workloads.network'));
		await f.driver.apply(container, activation());
		expect(f.runner.count('daemon-reload')).toBe(2);
	});

	test('process workloads do not need the network unit', async () => {
		const f = await fixture();
		await f.driver.apply(workload(), activation());
		await expect(fs.stat(join(f.quadletDir, 'yoal-workloads.network'))).rejects.toThrow();
	});

	test('each org gets its own network and only sees its own containers', async () => {
		const f = await fixture();
		const container = (id: string, orgId: string) =>
			workload({
				id,
				projectId: id,
				projectSlug: id.replace(/_/g, '-'),
				deploymentId: id,
				runtime: 'container',
				release: null,
				image: 'ghcr.io/acme/app:1',
				socketActivation: false,
				orgId,
				networkName: `yoal-org-${orgId}`,
			});
		await f.driver.apply(container('wld_a', 'org_1'), activation({ workloadId: 'wld_a' }));
		await f.driver.apply(container('wld_b', 'org_2'), activation({ workloadId: 'wld_b' }));
		await f.driver.apply(container('wld_c', 'org_1'), activation({ workloadId: 'wld_c' }));

		expect(await fs.readFile(join(f.quadletDir, 'yoal-org-org_1.network'), 'utf8')).toContain(
			'NetworkName=yoal-org-org_1',
		);
		expect(await fs.readFile(join(f.quadletDir, 'yoal-org-org_2.network'), 'utf8')).toContain(
			'NetworkName=yoal-org-org_2',
		);
		expect(await fs.readFile(join(f.quadletDir, 'yoal-workload-wld_a.container'), 'utf8')).toContain(
			'Network=yoal-org-org_1.network',
		);
		expect(await fs.readFile(join(f.quadletDir, 'yoal-workload-wld_b.container'), 'utf8')).toContain(
			'Network=yoal-org-org_2.network',
		);
		// Same-org workloads share one network; the file count proves no per-workload networks.
		expect(await fs.readFile(join(f.quadletDir, 'yoal-workload-wld_c.container'), 'utf8')).toContain(
			'Network=yoal-org-org_1.network',
		);
		const networks = (await fs.readdir(f.quadletDir)).filter((name) => name.endsWith('.network')).sort();
		expect(networks).toEqual(['yoal-org-org_1.network', 'yoal-org-org_2.network']);
		await expect(fs.stat(join(f.quadletDir, 'yoal-workloads.network'))).rejects.toThrow();
	});

	test('repairs a missing network attachment without a shell', async () => {
		const f = await fixture();
		const isolated = workload({
			runtime: 'container',
			release: null,
			image: 'ghcr.io/acme/app:1',
			socketActivation: false,
			orgId: 'org_1',
			networkName: 'yoal-org-org_1',
		});
		f.runner.network = '{}';
		await f.driver.apply(isolated, activation());
		expect(f.runner.calls).toContainEqual([
			'/usr/bin/podman',
			'network',
			'connect',
			'yoal-org-org_1',
			'yoal-workload-wld_abc123',
		]);

		f.runner.network = '{"yoal-workload-wld_abc123":{}}';
		f.runner.calls = [];
		await f.driver.apply(isolated, activation());
		expect(f.runner.calls.some((argv) => argv[2] === 'connect')).toBe(false);
	});
});

describe('database profile', () => {
	test('renders the database unit, pins PGDATA and hands the data dir to 70:70', async () => {
		const f = await fixture();
		f.runner.show = 'ActiveState=activating\nSubState=start\nNRestarts=0\n';
		const status = await f.driver.apply(database(), databaseActivation());
		expect(status.status).toBe('starting');

		const quadlet = await fs.readFile(join(f.quadletDir, `yoal-workload-${DB_ID}.container`), 'utf8');
		expect(quadlet).toContain('User=70:70');
		expect(quadlet).toContain('PublishPort=127.0.0.1:15432:5432');
		expect(quadlet).toContain('NetworkAlias=db-0123456789abcdef0123456789abcdef');
		expect(await fs.readFile(join(f.quadletDir, 'yoal-workloads.network'), 'utf8')).toContain('[Network]');

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
			`yoal-workload-${DB_ID}.service`,
		]);
	});

	test('a certificate failure never blocks startup and is surfaced in status', async () => {
		const f = await fixture({
			databaseTlsGenerator: async ({ runtimeDir, id }) => {
				const paths = databaseTlsPaths(runtimeDir, id);
				await fs.mkdir(paths.dir, { recursive: true, mode: 0o700 });
				await fs.writeFile(paths.error, 'openssl is missing\n', { mode: 0o600 });
				throw new Error('openssl is missing');
			},
		});
		f.runner.show = 'ActiveState=active\nSubState=running\nNRestarts=0\n';
		const status = await f.driver.apply(
			database({ database: { engine: 'postgres', version: '17', tls: true } }),
			databaseActivation(),
		);
		expect(status.status).toBe('running');
		expect(status.tls).toEqual({ enabled: false, caPem: null, error: 'openssl is missing' });
		const quadlet = await fs.readFile(join(f.quadletDir, `yoal-workload-${DB_ID}.container`), 'utf8');
		expect(quadlet).not.toContain('/run/yoal-tls');
		expect(quadlet).not.toContain('ssl=on');
	});

	test('a successful generator mounts TLS and reports the CA', async () => {
		const f = await fixture({
			databaseTlsGenerator: async ({ runtimeDir, id }) => {
				const paths = databaseTlsPaths(runtimeDir, id);
				await fs.mkdir(paths.dir, { recursive: true, mode: 0o700 });
				await fs.writeFile(paths.caCert, '-----BEGIN CERTIFICATE-----\nCA\n', { mode: 0o400 });
				await fs.writeFile(paths.serverCert, 'cert', { mode: 0o400 });
				await fs.writeFile(paths.serverKey, 'key', { mode: 0o400 });
				await fs.writeFile(paths.marker, '1\n', { mode: 0o400 });
				return {
					enabled: true,
					caPem: '-----BEGIN CERTIFICATE-----\nCA\n',
					error: null,
				};
			},
		});
		f.runner.show = 'ActiveState=active\nSubState=running\nNRestarts=0\n';
		const status = await f.driver.apply(
			database({ database: { engine: 'postgres', version: '17', tls: true } }),
			databaseActivation(),
		);
		expect(status.tls?.enabled).toBe(true);
		expect(status.tls?.caPem).toContain('BEGIN CERTIFICATE');
		const quadlet = await fs.readFile(join(f.quadletDir, `yoal-workload-${DB_ID}.container`), 'utf8');
		expect(quadlet).toContain(`Volume=${join(f.runtimeDir, DB_ID, 'tls')}:/run/yoal-tls:ro,z`);
		expect(quadlet).toContain('ssl=on');
	});

	test('app containers are not chowned and restart synchronously', async () => {
		const f = await fixture();
		await f.driver.apply(
			workload({ runtime: 'container', release: null, image: 'ghcr.io/acme/app:1', socketActivation: false }),
			activation(),
		);
		expect(f.chowns).toEqual([]);
		expect(f.runner.calls).toContainEqual(['/usr/bin/systemctl', 'restart', 'yoal-workload-wld_abc123.service']);
	});

	test('app containers get the containers subid range first; databases do not need it', async () => {
		const root = await fs.mkdtemp(join(tmpdir(), 'yoal-helper-subids-'));
		directories.push(root);
		const subids = { subuid: join(root, 'subuid'), subgid: join(root, 'subgid') };
		const f = await fixture({ containerSubids: subids });

		f.runner.show = 'ActiveState=active\nSubState=running\nNRestarts=0\n';
		await f.driver.apply(database(), databaseActivation());
		await expect(fs.readFile(subids.subuid, 'utf8')).rejects.toThrow();

		await f.driver.apply(
			workload({ runtime: 'container', release: null, image: 'ghcr.io/acme/app:1', socketActivation: false }),
			activation(),
		);
		expect(await fs.readFile(subids.subuid, 'utf8')).toMatch(/^containers:\d+:\d+\n$/);
		expect(await fs.readFile(subids.subgid, 'utf8')).toMatch(/^containers:\d+:\d+\n$/);
		const quadlet = await fs.readFile(join(f.quadletDir, 'yoal-workload-wld_abc123.container'), 'utf8');
		expect(quadlet).toContain('UserNS=auto');
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

describe('leftover D60 studio console cleanup (D96)', () => {
	const DB_ID = 'db_0123456789abcdef0123456789abcdef';
	const OTHER_ID = 'db_fedcba9876543210fedcba9876543210';

	async function leaveConsole(f: Fixture, id: string): Promise<void> {
		await fs.mkdir(f.quadletDir, { recursive: true });
		await fs.writeFile(join(f.quadletDir, `yoal-workload-${id}-console.container`), '[Container]\n');
		await fs.mkdir(join(f.runtimeDir, id), { recursive: true });
		await fs.writeFile(join(f.runtimeDir, id, 'env'), 'POSTGRES_USER=orders\n');
		await fs.writeFile(join(f.runtimeDir, id, 'console.env'), 'PASSWORD=x\n', { mode: 0o600 });
	}

	test('stops, disables and removes leftover units, containers and env files', async () => {
		const f = await fixture();
		await leaveConsole(f, DB_ID);
		// A pooler sidecar and a non-database unit with a similar name must survive.
		await fs.writeFile(join(f.quadletDir, `yoal-workload-${DB_ID}-pool.container`), '[Container]\n');
		await fs.writeFile(join(f.quadletDir, 'yoal-workload-wld_abc123-console.container'), '[Container]\n');
		f.runner.containers = `yoal-workload-${DB_ID}-console\nyoal-workload-${OTHER_ID}-console\nunrelated-console\n`;

		expect(await f.driver.removeLegacyConsoles()).toEqual([DB_ID, OTHER_ID]);

		expect(f.runner.calls).toContainEqual([
			'/usr/bin/systemctl',
			'disable',
			'--now',
			`yoal-workload-${DB_ID}-console.service`,
		]);
		expect(f.runner.count('daemon-reload')).toBe(1);
		expect(f.runner.calls).toContainEqual(['/usr/bin/podman', 'rm', '--force', `yoal-workload-${DB_ID}-console`]);
		expect(f.runner.calls).toContainEqual(['/usr/bin/podman', 'rm', '--force', `yoal-workload-${OTHER_ID}-console`]);
		expect(f.runner.calls.some((argv) => argv.includes('unrelated-console'))).toBe(false);

		await expect(fs.stat(join(f.quadletDir, `yoal-workload-${DB_ID}-console.container`))).rejects.toThrow();
		await expect(fs.stat(join(f.runtimeDir, DB_ID, 'console.env'))).rejects.toThrow();
		// The database itself is untouched: its own env file stays and it is never restarted.
		expect(await fs.readFile(join(f.runtimeDir, DB_ID, 'env'), 'utf8')).toContain('POSTGRES_USER');
		await fs.stat(join(f.quadletDir, `yoal-workload-${DB_ID}-pool.container`));
		await fs.stat(join(f.quadletDir, 'yoal-workload-wld_abc123-console.container'));
		expect(f.runner.calls.some((argv) => argv[1] === 'restart')).toBe(false);
	});

	test('is a no-op without leftovers, and never reloads systemd', async () => {
		const f = await fixture();
		expect(await f.driver.removeLegacyConsoles()).toEqual([]);
		expect(f.runner.count('daemon-reload')).toBe(0);
		expect(f.runner.count('disable')).toBe(0);
	});

	test('is idempotent: a second run finds nothing', async () => {
		const f = await fixture();
		await leaveConsole(f, DB_ID);
		expect(await f.driver.removeLegacyConsoles()).toEqual([DB_ID]);
		f.runner.calls = [];
		expect(await f.driver.removeLegacyConsoles()).toEqual([]);
		expect(f.runner.count('daemon-reload')).toBe(0);
	});

	test('a failing systemctl or podman does not stop the cleanup', async () => {
		const f = await fixture();
		await leaveConsole(f, DB_ID);
		f.runner.fail.disable = { code: 1, stdout: '', stderr: 'Unit not loaded' };
		expect(await f.driver.removeLegacyConsoles()).toEqual([DB_ID]);
		await expect(fs.stat(join(f.quadletDir, `yoal-workload-${DB_ID}-console.container`))).rejects.toThrow();
	});
});

describe('storage profile', () => {
	test('renders the storage unit, forces the RustFS env and hands the data dir to 10001:10001', async () => {
		const f = await fixture();
		f.runner.show = 'ActiveState=activating\nSubState=start\nNRestarts=0\n';
		const status = await f.driver.apply(storage(), storageActivation());
		expect(status.status).toBe('starting');

		const quadlet = await fs.readFile(join(f.quadletDir, `yoal-workload-${ST_ID}.container`), 'utf8');
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
			`yoal-workload-${ST_ID}.service`,
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
			(argv) => argv[1] === 'disable' && argv[3] === `yoal-workload-${DB_ID}.service`,
		);
		expect(disableAt).toBeGreaterThanOrEqual(0);
		await expect(fs.stat(join(f.quadletDir, `yoal-workload-${DB_ID}.container`))).rejects.toThrow();
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
		await expect(fs.stat(join(f.quadletDir, `yoal-workload-${ST_ID}.container`))).rejects.toThrow();
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

describe('app volumes (plan 07)', () => {
	const volume = (id: string, mountPath: string, readOnly = false) => ({
		id,
		mountPath,
		readOnly,
		backing: 'state_dir' as const,
	});

	test('creates a state-dir volume and binds it into the unit', async () => {
		const f = await fixture();
		const desired = workload({ volumes: [volume('av_1', '/var/lib/app')] });
		await f.driver.apply(desired, activation());
		const hostPath = join(f.stateDir, 'apps', 'prj_abc123', 'av_1');
		const info = await fs.stat(hostPath);
		expect(info.isDirectory()).toBe(true);
		expect(info.mode & 0o777).toBe(0o777);
		const unit = await fs.readFile(join(f.unitDir, 'yoal-workload-wld_abc123.service'), 'utf8');
		expect(unit).toContain(`BindPaths=${hostPath}:/var/lib/app`);
		expect(unit).toContain('ReadWritePaths=/var/lib/app');
	});

	test('a node-volume backing that is not registered fails the start, with no unit written', async () => {
		const f = await fixture();
		const desired = workload({
			volumes: [
				{
					id: 'av_1',
					mountPath: '/var/lib/app',
					readOnly: false,
					backing: 'node_volume',
					nodeVolumeId: 'vol_missing',
				},
			],
		});
		await expect(f.driver.apply(desired, activation())).rejects.toThrow(/not registered/);
		await expect(fs.stat(join(f.unitDir, 'yoal-workload-wld_abc123.service'))).rejects.toThrow();
	});

	test('a registered node volume that is not mounted fails closed instead of using the root disk', async () => {
		const f = await fixture();
		await fs.writeFile(
			f.volumeRegistryFile,
			JSON.stringify({
				vol_missing: { mountPath: '/mnt/data', sourceKey: 'fs:uuid-1', fsType: 'ext4' },
			}),
		);
		const desired = workload({
			volumes: [
				{
					id: 'av_1',
					mountPath: '/var/lib/app',
					readOnly: false,
					backing: 'node_volume',
					nodeVolumeId: 'vol_missing',
				},
			],
		});
		await expect(f.driver.apply(desired, activation())).rejects.toThrow(/not mounted|Could not read mounts/);
		// The helper never creates the path under the (empty) mountpoint or the root disk.
		await expect(fs.stat('/mnt/data/yoal/apps/prj_abc123/av_1')).rejects.toThrow();
		await expect(fs.stat(join(f.unitDir, 'yoal-workload-wld_abc123.service'))).rejects.toThrow();
	});
});

describe('studio process', () => {
	test('start and stop run systemctl on the fixed unit name and nothing else', async () => {
		const f = await fixture();
		const handle = createHandler(f.driver, { version: '0.1.0' });
		const started = await handle(new Request('http://localhost/v1/studio/start', { method: 'POST' }));
		expect(started.status).toBe(200);
		const stopped = await handle(new Request('http://localhost/v1/studio/stop', { method: 'POST' }));
		expect(stopped.status).toBe(200);
		expect(STUDIO_UNIT).toBe('yoal-studio.service');
		expect(f.runner.calls).toEqual([
			['/usr/bin/systemctl', 'start', 'yoal-studio.service'],
			['/usr/bin/systemctl', 'stop', 'yoal-studio.service'],
		]);
	});

	test('a failed start surfaces the systemctl message', async () => {
		const f = await fixture();
		f.runner.fail.start = {
			code: 1,
			stdout: '',
			stderr: 'Job for yoal-studio.service failed because the control process exited with error code.\n',
		};
		const handle = createHandler(f.driver, { version: '0.1.0' });
		const response = await handle(new Request('http://localhost/v1/studio/start', { method: 'POST' }));
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({
			error: 'systemctl start failed (1): Job for yoal-studio.service failed because the control process exited with error code.',
		});
	});

	test('a refused request never reaches systemctl', async () => {
		const f = await fixture();
		const handle = createHandler(f.driver, { version: '0.1.0' });
		const response = await handle(
			new Request('http://localhost/v1/studio/start', { method: 'POST', body: '{"unit":"sshd.service"}' }),
		);
		expect(response.status).toBe(400);
		expect(f.runner.calls).toEqual([]);
	});
});

describe('platform registry (docs/REGISTRY.md G1)', () => {
	const REG_ID = 'reg_0123456789abcdef0123456789abcdef';
	const CERT = '-----BEGIN CERTIFICATE-----\nMIIBAAAA\n-----END CERTIFICATE-----';
	const registryWorkload = (overrides: Record<string, unknown> = {}) =>
		workload({
			id: REG_ID,
			projectId: REG_ID,
			projectSlug: 'registry',
			deploymentId: REG_ID,
			runtime: 'container',
			release: null,
			image: 'ghcr.io/project-zot/zot:v2.1.23',
			upstream: '127.0.0.1:15000',
			port: 15000,
			healthPath: '/readyz',
			socketActivation: false,
			env: {},
			secrets: [],
			registry: {
				engine: 'zot',
				version: '2.1.23',
				service: 'registry.example.com',
				realm: 'https://control.example.com/api/registry/token',
				keepTags: 15,
			},
			...overrides,
		});
	const registryActivation = (env: Record<string, string> = {}): WorkloadActivation => ({
		workloadId: REG_ID,
		activationVersion: 'b'.repeat(64),
		env: {
			YOAL_REGISTRY_TOKEN_CERT: CERT,
			YOAL_REGISTRY_EVENTS_URL: 'https://control.example.com/api/webhooks/registry/s3cret',
			...env,
		},
		files: {},
	});

	test('renders zot from the profile: pinned image, config dir, unprivileged uid, no secrets in env', async () => {
		const f = await fixture();
		await f.driver.apply(parseWorkload(registryWorkload()), registryActivation());
		const unit = await fs.readFile(join(f.quadletDir, `yoal-workload-${REG_ID}.container`), 'utf8');
		expect(unit).toContain('Image=ghcr.io/project-zot/zot:v2.1.23@sha256:9d3de83ac2099e6f4843045b4c9b65b7e8baf40f92d28f54906dee9d4d390fd7');
		expect(unit).toContain('User=65532:65532');
		expect(unit).toContain('PublishPort=127.0.0.1:15000:5000');
		expect(unit).toContain(`Volume=${join(f.runtimeDir, REG_ID, 'zot')}:/etc/zot:ro,Z`);
		expect(unit).toContain('ReadOnly=true');
		expect(unit).not.toContain('UserNS=');
		const config = JSON.parse(await fs.readFile(join(f.runtimeDir, REG_ID, 'zot', 'config.json'), 'utf8'));
		expect(config.http.auth.bearer).toEqual({
			realm: 'https://control.example.com/api/registry/token',
			service: 'registry.example.com',
			cert: '/etc/zot/cert.pem',
		});
		expect(config.http.compat).toEqual(['docker2s2']);
		expect(config.storage.retention.policies[0].keepTags).toEqual([
			{ patterns: ['^yoal-d-.*'] },
			{ mostRecentlyPushedCount: 15 },
		]);
		expect(config.extensions.events.sinks[0].address).toBe('https://control.example.com/api/webhooks/registry/s3cret');
		expect(await fs.readFile(join(f.runtimeDir, REG_ID, 'zot', 'cert.pem'), 'utf8')).toBe(`${CERT}\n`);
		const env = await fs.readFile(join(f.runtimeDir, REG_ID, 'env'), 'utf8');
		expect(env).not.toContain('YOAL_REGISTRY');
		expect(f.chowns).toContainEqual([join(f.runtimeDir, REG_ID, 'zot', 'config.json'), 65532, 65532]);
		// The first start pulls the image, so the restart is queued.
		expect(f.runner.calls).toContainEqual(['/usr/bin/systemctl', 'restart', '--no-block', `yoal-workload-${REG_ID}.service`]);
		// The config dir ends read-only; reopen it so the fixture cleanup (not root) can delete it.
		expect((await fs.stat(join(f.runtimeDir, REG_ID, 'zot'))).mode & 0o777).toBe(0o500);
		await fs.chmod(join(f.runtimeDir, REG_ID, 'zot'), 0o700);
	});

	test('managed S3 needs no cache URL; half a key pair and a bad cache URL are refused', () => {
		const base = { YOAL_REGISTRY_TOKEN_CERT: CERT, YOAL_REGISTRY_EVENTS_URL: 'https://control.example.com/api/webhooks/registry/s3cret' };
		expect(
			takeRegistryFiles({
				...base,
				YOAL_REGISTRY_S3_ACCESS_KEY: 'AK',
				YOAL_REGISTRY_S3_SECRET_KEY: 'SK',
			}).s3,
		).toEqual({ accessKey: 'AK', secretKey: 'SK', cacheUrl: null });
		expect(() => takeRegistryFiles({ ...base, YOAL_REGISTRY_S3_ACCESS_KEY: 'AK' })).toThrow(/access key and a secret key/);
		expect(() =>
			takeRegistryFiles({
				...base,
				YOAL_REGISTRY_S3_ACCESS_KEY: 'AK',
				YOAL_REGISTRY_S3_SECRET_KEY: 'SK',
				YOAL_REGISTRY_CACHE_URL: 'http://cache',
			}),
		).toThrow(/redis/);
	});

	test('refuses another image, a missing certificate, and app ids with the registry prefix', async () => {

		expect(() => parseWorkload(registryWorkload({ image: 'docker.io/library/registry:2' }))).toThrow(/workload.image must be/);
		expect(() => parseWorkload(registryWorkload({ registry: { engine: 'zot', version: '9.9.9', service: 'r.example.com', realm: 'https://x/t' } }))).toThrow(
			/version/,
		);
		expect(() => parseWorkload(workload({ id: 'reg_1234' }))).toThrow(/reserved for the registry/);
		const f = await fixture();
		await expect(
			f.driver.apply(parseWorkload(registryWorkload()), registryActivation({ YOAL_REGISTRY_TOKEN_CERT: 'not a cert' })),
		).rejects.toThrow(/PEM certificate/);
	});
});

describe('compose stacks (level 4)', () => {
	const composeWorkload = (overrides: Record<string, unknown> = {}) =>
		parseWorkload({
			id: 'wld_compose1',
			projectId: 'prj_compose1',
			projectSlug: 'shop',
			deploymentId: 'dep_compose1',
			runtime: 'compose',
			status: 'running',
			release: SHA,
			upstream: '127.0.0.1:30001',
			memoryMb: 512,
			cpus: 1.5,
			port: 30001,
			healthPath: '/health',
			socketActivation: false,
			activationVersion: 'b'.repeat(64),
			env: { SHARED: 'yes' },
			secrets: [],
			dataSizeMb: null,
			compose: {
				volumes: [{ name: 'uploads' }],
				services: [
					{
						name: 'web',
						image: 'nginx:1.27',
						command: ['nginx', '-g', 'daemon off;'],
						env: { PORT: '3000' },
						secrets: [],
						ports: [3000],
						dependsOn: ['db'],
						volumes: [{ name: 'uploads', mountPath: '/app/uploads', readOnly: false }],
						memoryMb: 256,
						cpus: 1,
					},
					{
						name: 'db',
						image: 'postgres:17-alpine',
						env: {},
						secrets: [],
						ports: [],
						dependsOn: [],
						volumes: [{ name: 'uploads', mountPath: '/var/lib/postgresql/data', readOnly: false }],
						memoryMb: 256,
						cpus: 0.5,
					},
				],
				routes: [{ service: 'web', port: 3000, healthPath: '/health', primary: true, hostPort: 30001 }],
			},
			...overrides,
		});

	test('renders one unit per service on the workload network with routing and ordering', async () => {
		const f = await fixture();
		await f.driver.apply(composeWorkload(), activation({ workloadId: 'wld_compose1', env: { DATABASE_URL: 'postgres://db/app' } }));

		const web = await fs.readFile(join(f.quadletDir, 'yoal-workload-wld_compose1--web.container'), 'utf8');
		const db = await fs.readFile(join(f.quadletDir, 'yoal-workload-wld_compose1--db.container'), 'utf8');
		expect(web).toContain('ContainerName=yoal-workload-wld_compose1--web');
		expect(web).toContain('NetworkAlias=web');
		expect(web).toContain('PublishPort=127.0.0.1:30001:3000');
		expect(web).toContain('Exec="nginx" "-g" "daemon off;"');
		expect(web).toContain('After=yoal-workload-wld_compose1--db.service');
		expect(web).toContain('Requires=yoal-workload-wld_compose1--db.service');
		expect(web).toContain('Volume=');
		expect(web).toContain(':/app/uploads:Z,U');
		expect(db).not.toContain('PublishPort=');
		expect(db).toContain('NetworkAlias=db');
		// Every service sees the stack's shared activation env plus its own plain env.
		const webEnv = await fs.readFile(join(f.runtimeDir, 'wld_compose1', 'web', 'env'), 'utf8');
		expect(webEnv).toContain('SHARED=yes');
		expect(webEnv).toContain('PORT=3000');
		expect(webEnv).toContain('DATABASE_URL=postgres://db/app');
		expect(await fs.readFile(join(f.runtimeDir, 'wld_compose1', 'compose.json'), 'utf8')).toContain('web');
		expect(f.runner.calls).toContainEqual(['/usr/bin/systemctl', 'restart', '--no-block', 'yoal-workload-wld_compose1--web.service']);
		expect(f.runner.calls).toContainEqual(['/usr/bin/systemctl', 'restart', '--no-block', 'yoal-workload-wld_compose1--db.service']);
	});

	test('removes every service unit and its container', async () => {
		const f = await fixture();
		await f.driver.apply(composeWorkload(), activation({ workloadId: 'wld_compose1' }));
		await f.driver.remove('wld_compose1');
		expect((await fs.readdir(f.quadletDir)).filter((name) => name.startsWith('yoal-workload-wld_compose1--'))).toEqual([]);
		expect(f.runner.calls).toContainEqual([
			'/usr/bin/systemctl',
			'disable',
			'--now',
			'yoal-workload-wld_compose1--web.service',
		]);
		expect(await fs.stat(join(f.runtimeDir, 'wld_compose1')).catch(() => null)).toBeNull();
	});

	test('refuses undeclared volumes and a route port the service does not publish', () => {
		expect(() =>
			parseWorkload({
				...composeWorkload(),
				compose: {
					volumes: [],
					services: [
						{
							name: 'web',
							image: 'nginx:1.27',
							env: {},
							secrets: [],
							ports: [3000],
							dependsOn: [],
							volumes: [{ name: 'missing', mountPath: '/x', readOnly: false }],
							memoryMb: 256,
							cpus: 1,
						},
					],
					routes: [],
				},
			}),
		).toThrow(/undeclared volume missing/);
	});
});
