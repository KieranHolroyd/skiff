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
	runtimeDir: string;
}

async function fixture(options: { packageJson?: boolean } = {}): Promise<Fixture> {
	const root = await fs.mkdtemp(join(tmpdir(), 'skiff-helper-systemd-'));
	directories.push(root);
	const unitDir = join(root, 'units');
	const runtimeDir = join(root, 'run');
	const stateDir = join(root, 'state');
	const releases = join(root, 'releases');
	const releaseDir = join(releases, SHA);
	await fs.mkdir(releaseDir, { recursive: true });
	if (options.packageJson !== false) await fs.writeFile(join(releaseDir, 'package.json'), '{"name":"app"}');

	const runner = new FakeRunner();
	const driver = new SystemdDriver({
		runner,
		unitDir,
		runtimeDir,
		stateDir,
		releaseDirs: [releases],
		bunPath: '/usr/local/bin/bun',
		socketMode: '0660',
		socketGroup: 'caddy',
	});
	return { root, releaseDir, driver, runner, unitDir, runtimeDir };
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
			join(f.unitDir, 'skiff-workload-wld_abc123.container'),
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
