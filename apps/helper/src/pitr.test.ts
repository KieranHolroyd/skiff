import { describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SystemdDriver, type CommandRunner, type RunResult } from './systemd.ts';
import {
	parsePitrBackupType,
	parsePitrRepo,
	pitrPaths,
	renderPgBackRestConfig,
	renderPgPass,
	renderPitrPodmanArgs,
	validatePitrStanza,
	validatePitrTargetTime,
	PITR_PGBACKREST_IMAGE,
} from './pitr.ts';
import { renderDatabaseUnit } from './units.ts';
import { parseWorkload } from './validate.ts';

const SHA = 'a'.repeat(64);
const repo = {
	kind: 's3' as const,
	endpoint: 'https://s3.example.test',
	bucket: 'skiff-pitr',
	region: 'us-east-1',
	pathPrefix: 'skiff/pitr',
	forcePathStyle: true,
	accessKeyId: 'access-key',
	secretAccessKey: 'secret-key-value',
};

class FakeRunner implements CommandRunner {
	calls: string[][] = [];
	async run(argv: string[]): Promise<RunResult> {
		this.calls.push(argv);
		return { code: 0, stdout: '', stderr: '' };
	}
}

describe('pgBackRest repository config', () => {
	test('renders a scoped repository and refuses credentials in the endpoint', () => {
		const config = renderPgBackRestConfig({
			stanza: 'db_abc123',
			repo,
			pg1Path: '/data/pgdata',
			pg1Host: 'db-abc123',
			pg1User: 'main_db',
		});
		expect(config).toContain('repo1-s3-bucket=skiff-pitr');
		expect(config).toContain('repo1-path=/skiff/pitr/db_abc123');
		expect(config).toContain('repo1-s3-uri-style=path');
		expect(config).toContain('pg1-host=db-abc123');
		expect(config).toContain('[db_abc123]');
		expect(config).not.toContain('; rm -rf');
		expect(() =>
			parsePitrRepo({ ...repo, endpoint: 'https://user:pass@s3.example.test' }),
		).toThrow(/must not embed credentials/);
	});

	test('rejects unsafe repository fields and bad stanza names', () => {
		expect(() => parsePitrRepo({ ...repo, bucket: 'Bad Bucket' })).toThrow(/bucket/);
		expect(() => parsePitrRepo({ ...repo, pathPrefix: '../escape' })).toThrow(/pathPrefix/);
		expect(() => parsePitrRepo({ ...repo, region: 'us east' })).toThrow(/region/);
		expect(() => validatePitrStanza('bad stanza')).toThrow();
		expect(() => parsePitrBackupType('snapshot')).toThrow();
	});

	test('escapes pgpass fields', () => {
		expect(renderPgPass('user', 'pa:ss:word', 'db-abc', '5432')).toBe(
			'db-abc:5432:*:user:pa\\:ss\\:word\n',
		);
	});

	test('builds a fixed one-shot sidecar argv', () => {
		const args = renderPitrPodmanArgs({
			podmanPath: '/usr/bin/podman',
			workloadId: 'db_abc123',
			dataDir: '/var/lib/skiff-workloads/db_abc123',
			configPath: '/run/skiff-workloads/db_abc123/pgbackrest.conf',
			pgpassPath: '/run/skiff-workloads/db_abc123/pgpass',
			network: true,
			args: ['--stanza=db_abc123', 'backup', '--type=full'],
		});
		expect(args.slice(0, 3)).toEqual(['/usr/bin/podman', 'run', '--rm']);
		expect(args).toContain(PITR_PGBACKREST_IMAGE);
		expect(args).toContain('--network');
		expect(args).toContain('skiff-workloads');
		expect(args.slice(-5)).toEqual([
			'pgbackrest',
			'--config=/etc/pgbackrest/pgbackrest.conf',
			'--stanza=db_abc123',
			'backup',
			'--type=full',
		]);
	});

	test('pitr paths stay inside the workload runtime dir', () => {
		expect(pitrPaths('/run/skiff-workloads', 'db_abc123')).toEqual({
			dir: '/run/skiff-workloads/db_abc123',
			config: '/run/skiff-workloads/db_abc123/pgbackrest.conf',
			pgpass: '/run/skiff-workloads/db_abc123/pgpass',
		});
	});
});

describe('restore target validation', () => {
	const now = Date.parse('2026-11-05T12:00:00Z');

	test('accepts a past timestamp inside the retention window', () => {
		expect(validatePitrTargetTime(now - 60_000, now, 35)).toBe(now - 60_000);
	});

	test('rejects a future or expired timestamp', () => {
		expect(() => validatePitrTargetTime(now + 1, now, 35)).toThrow(/future/);
		expect(() => validatePitrTargetTime(now - 36 * 86_400_000, now, 35)).toThrow(/retention/);
	});
});

describe('archive settings in the Postgres unit', () => {
	function databaseWorkload(pitr?: { stanza: string; archiveTimeoutSeconds: number }) {
		return parseWorkload({
			id: 'db_abc123',
			projectId: 'db_abc123',
			projectSlug: 'main-db',
			deploymentId: 'db_abc123',
			runtime: 'container',
			status: 'running',
			release: null,
			image: 'docker.io/library/postgres:17-alpine',
			upstream: '127.0.0.1:15432',
			memoryMb: 256,
			cpus: 1,
			port: 15432,
			healthPath: '/',
			socketActivation: false,
			activationVersion: SHA,
			env: {},
			secrets: [],
			dataSizeMb: null,
			database: { engine: 'postgres', version: '17', ...(pitr ? { pitr } : {}) },
		});
	}

	test('renders WAL archiving, config mounts and the escaped WAL placeholder', () => {
		const unit = renderDatabaseUnit({
			workload: databaseWorkload({ stanza: 'db_abc123', archiveTimeoutSeconds: 60 }),
			envFile: '/run/skiff-workloads/db_abc123/env',
			dataDir: '/var/lib/skiff-workloads/db_abc123',
			pitr: {
				stanza: 'db_abc123',
				configPath: '/run/skiff-workloads/db_abc123/pgbackrest.conf',
				pgpassPath: '/run/skiff-workloads/db_abc123/pgpass',
				archiveTimeoutSeconds: 60,
			},
		});
		expect(unit).toContain('archive_mode=on');
		expect(unit).toContain('wal_level=replica');
		expect(unit).toContain('archive_timeout=60');
		// systemd would expand %p, so the unit must escape it for Postgres/the archive command.
		expect(unit).toContain('archive-push %%p');
		expect(unit).toContain(
			'Volume=/run/skiff-workloads/db_abc123/pgbackrest.conf:/etc/pgbackrest/pgbackrest.conf:ro,Z',
		);
		expect(unit).toContain(
			'Volume=/run/skiff-workloads/db_abc123/pgpass:/etc/pgbackrest/pgpass:ro,Z',
		);
	});

	test('leaves a non-PITR database unchanged', () => {
		const unit = renderDatabaseUnit({
			workload: databaseWorkload(),
			envFile: '/run/skiff-workloads/db_abc123/env',
			dataDir: '/var/lib/skiff-workloads/db_abc123',
		});
		expect(unit).not.toContain('archive_mode');
		expect(unit).not.toContain('pgbackrest');
	});
});

describe('helper PITR verbs', () => {
	async function fixture() {
		const root = await fs.mkdtemp(join(tmpdir(), 'skiff-pitr-helper-'));
		const runtimeDir = join(root, 'run');
		const stateDir = join(root, 'state');
		const workloadDir = join(runtimeDir, 'db_abc123');
		await fs.mkdir(workloadDir, { recursive: true });
		await fs.mkdir(join(stateDir, 'db_abc123'), { recursive: true });
		await fs.writeFile(
			join(workloadDir, 'env'),
			'POSTGRES_USER=main_db\nPOSTGRES_PASSWORD=pw\nPOSTGRES_DB=main_db\n',
			{ mode: 0o400 },
		);
		const runner = new FakeRunner();
		const driver = new SystemdDriver({
			runner,
			unitDir: join(root, 'units'),
			quadletDir: join(root, 'quadlet'),
			runtimeDir,
			stateDir,
			releaseDirs: [join(root, 'releases')],
			bunPath: '/usr/local/bin/bun',
			podmanPath: '/usr/bin/podman',
		});
		return { root, runtimeDir, stateDir, runner, driver };
	}

	test('writes 0400 config files and runs fixed pgBackRest argv', async () => {
		const { root, driver, runner } = await fixture();
		try {
			const configured = await driver.pitrConfigure('db_abc123', repo);
			expect(configured.stanza).toBe('db_abc123');
			const paths = pitrPaths(join(root, 'run'), 'db_abc123');
			const config = await fs.stat(paths.config);
			const pgpass = await fs.stat(paths.pgpass);
			expect(config.mode & 0o777).toBe(0o400);
			expect(pgpass.mode & 0o777).toBe(0o400);
			expect(await fs.readFile(paths.config, 'utf8')).toContain('repo1-s3-bucket=skiff-pitr');
			expect(await fs.readFile(paths.pgpass, 'utf8')).toContain('main_db:pw');

			const backup = await driver.pitrBaseBackup('db_abc123', 'diff');
			expect(backup).toMatchObject({ stanza: 'db_abc123', type: 'diff' });
			const podman = runner.calls.filter((argv) => argv[0] === '/usr/bin/podman');
			expect(podman.some((argv) => argv.includes('stanza-create'))).toBe(true);
			expect(podman.some((argv) => argv.includes('backup') && argv.includes('--type=diff'))).toBe(true);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('rejects an in-place or future restore target before touching the data dir', async () => {
		const { root, driver } = await fixture();
		try {
			await driver.pitrConfigure('db_abc123', repo);
			await expect(
				driver.pitrRestore('db_abc123', {
					targetDatabaseId: 'db_abc123',
					targetTime: Date.now() - 60_000,
				}),
			).rejects.toThrow(/different database/);
			await expect(
				driver.pitrRestore('db_abc123', {
					targetDatabaseId: 'db_target',
					targetTime: Date.now() + 60_000,
				}),
			).rejects.toThrow(/future/);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
