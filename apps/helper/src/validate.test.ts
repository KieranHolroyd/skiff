import { describe, expect, test } from 'bun:test';
import {
	assertDatabaseId,
	assertManagedId,
	assertStorageId,
	assertAbsolutePath,
	assertCommand,
	assertEnvName,
	assertId,
	assertImage,
	assertPort,
	assertRelativePath,
	databaseAlias,
	databaseImage,
	orgNetworkName,
	parseActivation,
	parseApplyRequest,
	parseWorkload,
	renderRegistryAuthFile,
	storageAlias,
	storageImage,
	ValidationError,
} from './validate.ts';

const SHA = 'a'.repeat(64);

export function workloadInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
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
		secrets: [{ name: 'DATABASE_URL', delivery: 'env' }],
		dataSizeMb: null,
		...overrides,
	};
}

export function activationInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		workloadId: 'wld_abc123',
		activationVersion: 'b'.repeat(64),
		env: { DATABASE_URL: 'postgres://example' },
		files: {},
		...overrides,
	};
}

describe('identifiers', () => {
	test('accepts safe ids and rejects separators or traversal', () => {
		expect(assertId('wld_abc-123')).toBe('wld_abc-123');
		for (const value of ['../etc', 'a/b', 'a b', 'a.b', '', 'x\n']) {
			expect(() => assertId(value)).toThrow(ValidationError);
		}
	});

	test('relative paths cannot escape or use absolute paths', () => {
		expect(assertRelativePath('secrets/token')).toBe('secrets/token');
		for (const value of ['/etc/passwd', '../escape', 'a//b', 'a\\b', 'a b']) {
			expect(() => assertRelativePath(value)).toThrow(ValidationError);
		}
	});

	test('absolute paths reject whitespace and relative forms', () => {
		expect(assertAbsolutePath('/var/lib/yoal')).toBe('/var/lib/yoal');
		expect(() => assertAbsolutePath('var/lib')).toThrow(/absolute/);
		expect(() => assertAbsolutePath('/tmp/a b')).toThrow(/unsupported/);
	});
});

describe('field validation', () => {
	test('env names follow the shell-safe pattern', () => {
		expect(assertEnvName('DATABASE_URL')).toBe('DATABASE_URL');
		expect(() => assertEnvName('1BAD')).toThrow(ValidationError);
		expect(() => assertEnvName('BAD-NAME')).toThrow(ValidationError);
	});

	test('ports are in range', () => {
		expect(assertPort(1)).toBe(1);
		expect(assertPort(65535)).toBe(65535);
		for (const value of [0, 65536, 1.5, '80']) expect(() => assertPort(value)).toThrow(ValidationError);
	});

	test('commands are argv arrays with no control characters', () => {
		expect(assertCommand(['bun', 'run', 'start'])).toEqual(['bun', 'run', 'start']);
		expect(() => assertCommand('bun run start')).toThrow(ValidationError);
		expect(() => assertCommand([])).toThrow(ValidationError);
		expect(() => assertCommand(['sh', '-c', 'echo\nrm -rf /'])).toThrow(ValidationError);
		expect(() => assertCommand(['sh', '-c', 'a\tb'])).toThrow(/control/);
	});

	test('images are OCI refs, not shell fragments', () => {
		expect(assertImage('ghcr.io/acme/app:1.2.3')).toBe('ghcr.io/acme/app:1.2.3');
		expect(assertImage('localhost:5000/team/app:1.0')).toBe('localhost:5000/team/app:1.0');
		expect(assertImage('nginx@sha256:' + SHA)).toBe(`nginx@sha256:${SHA}`);
		for (const value of ['Nginx', 'app;rm -rf /', '../app', 'app:..', ''] ) {
			expect(() => assertImage(value)).toThrow(ValidationError);
		}
	});
});

describe('parseWorkload', () => {
	test('accepts a valid process workload', () => {
		const workload = parseWorkload(workloadInput());
		expect(workload.runtime).toBe('process');
		expect(workload.secrets).toEqual([{ name: 'DATABASE_URL', delivery: 'env' }]);
		expect(workload.socketActivation).toBe(true);
	});

	test('process requires a release and rejects an image', () => {
		expect(() => parseWorkload(workloadInput({ release: null }))).toThrow(/need a release/);
		expect(() => parseWorkload(workloadInput({ image: 'nginx' }))).toThrow(/cannot set an image/);
	});

	test('container requires an image and rejects a command', () => {
		const container = workloadInput({
			runtime: 'container',
			release: null,
			image: 'ghcr.io/acme/app:1.2.3',
		});
		expect(parseWorkload(container).image).toBe('ghcr.io/acme/app:1.2.3');
		expect(() => parseWorkload(workloadInput({ runtime: 'container', release: null }))).toThrow(/need an image/);
		expect(() => parseWorkload({ ...container, command: ['bun'] })).toThrow(/cannot set a command/);
	});

	test('rejects duplicate secret names and malformed secrets', () => {
		expect(() =>
			parseWorkload(
				workloadInput({
					secrets: [
						{ name: 'TOKEN', delivery: 'env' },
						{ name: 'TOKEN', delivery: 'file' },
					],
				}),
			),
		).toThrow(/Duplicate/);
		expect(() => parseWorkload(workloadInput({ secrets: [{ name: 'token', delivery: 'env' }] }))).toThrow(
			ValidationError,
		);
	});

	test('rejects an invalid health path and upstream type', () => {
		expect(() => parseWorkload(workloadInput({ healthPath: 'health' }))).toThrow(/start with/);
		expect(() => parseWorkload(workloadInput({ healthPath: '/a b' }))).toThrow(ValidationError);
		expect(() => parseWorkload(workloadInput({ upstream: 42 }))).toThrow(ValidationError);
	});
});

const DB_ID = 'db_0123456789ABCDEF0123456789abcdef';

export function databaseInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return workloadInput({
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
		env: { POSTGRES_USER: 'orders', POSTGRES_DB: 'orders', PGDATA: '/data/pgdata' },
		secrets: [],
		database: { engine: 'postgres', version: '17' },
		...overrides,
	});
}

describe('database engines (D95)', () => {
	const cases = [
		['mysql', '8.4', 'docker.io/library/mysql:8.4'],
		['mysql', '9.7', 'docker.io/library/mysql:9.7'],
		['mariadb', '11.8', 'docker.io/library/mariadb:11.8'],
		['mongodb', '8.0', 'docker.io/library/mongo:8.0'],
		['valkey', '9.1', 'docker.io/valkey/valkey:9.1-alpine'],
		['redis', '8.10', 'docker.io/library/redis:8.10-alpine'],
		['clickhouse', '26.8', 'docker.io/clickhouse/clickhouse-server:26.8'],
		['clickhouse', '26.3', 'docker.io/clickhouse/clickhouse-server:26.3'],
	] as const;
	for (const [engine, version, image] of cases) {
		test(`accepts ${engine} ${version} only with its own image`, () => {
			const workload = parseWorkload(databaseInput({ image, database: { engine, version } }));
			expect(workload.database).toEqual({ engine, version });
			expect(() =>
				parseWorkload(databaseInput({ image: 'docker.io/library/postgres:17-alpine', database: { engine, version } })),
			).toThrow(/workload.image must be/);
		});
	}

	test('keeps PITR, TLS and the pooler Postgres-only', () => {
		const mysql = { image: 'docker.io/library/mysql:8.4', database: { engine: 'mysql', version: '8.4' } };
		expect(() =>
			parseWorkload(databaseInput({ ...mysql, database: { ...mysql.database, tls: true } })),
		).toThrow(/only supported for postgres/);
		expect(() =>
			parseWorkload(
				databaseInput({ ...mysql, database: { ...mysql.database, pitr: { stanza: 'x', archiveTimeoutSeconds: 60 } } }),
			),
		).toThrow(/only supported for postgres/);
		expect(() => parseWorkload(databaseInput({ ...mysql, pooler: { port: 16432 } }))).toThrow(/postgres database/);
	});
});

describe('database profile', () => {
	test('accepts a database workload whose image matches the helper registry', () => {
		const workload = parseWorkload(databaseInput());
		expect(workload.database).toEqual({ engine: 'postgres', version: '17' });
		expect(workload.image).toBe('docker.io/library/postgres:17-alpine');
		expect(parseWorkload(databaseInput({
			image: 'docker.io/library/postgres:16-alpine',
			database: { engine: 'postgres', version: '16' },
		})).database?.version).toBe('16');
		// Plain workloads carry no database field at all.
		expect('database' in parseWorkload(workloadInput())).toBe(false);
	});

	test('the image is derived, never taken from the wire', () => {
		for (const image of [
			'docker.io/library/postgres:16-alpine',
			'postgres:17-alpine',
			'ghcr.io/evil/postgres:17-alpine',
			'docker.io/library/postgres:17',
		]) {
			expect(() => parseWorkload(databaseInput({ image }))).toThrow(/workload.image must be/);
		}
		expect(() => parseWorkload(databaseInput({ image: undefined }))).toThrow(ValidationError);
	});

	test('rejects unknown engines, versions, extra keys and non-container runtimes', () => {
		expect(() => parseWorkload(databaseInput({ database: { engine: 'oracle', version: '23' } }))).toThrow(/engine/);
		expect(() =>
			parseWorkload(databaseInput({ image: 'docker.io/library/mysql:8', database: { engine: 'mysql', version: '8' } })),
		).toThrow(/version/);
		expect(() => parseWorkload(databaseInput({ database: { engine: 'postgres', version: '15' } }))).toThrow(/version/);
		expect(() => parseWorkload(databaseInput({ database: { engine: 'toString', version: '17' } }))).toThrow(/engine/);
		expect(() =>
			parseWorkload(databaseInput({ database: { engine: 'postgres', version: '17', image: 'x' } })),
		).toThrow(/not supported/);
		expect(() => parseWorkload(databaseInput({ database: 'postgres' }))).toThrow(/object/);
		expect(() =>
			parseWorkload(databaseInput({ runtime: 'process', release: SHA, image: undefined })),
		).toThrow(ValidationError);
	});

	test('db_ ids are reserved for databases, and databases need them', () => {
		expect(() => parseWorkload(databaseInput({ id: 'wld_abc123' }))).toThrow(/db_/);
		expect(() => parseWorkload(workloadInput({ id: 'db_abc' }))).toThrow(/reserved/);
		expect(assertDatabaseId('db_abc')).toBe('db_abc');
		for (const value of ['db_', 'wld_abc', 'db_../x', 'DB_abc', '']) {
			expect(() => assertDatabaseId(value)).toThrow(ValidationError);
		}
	});

	test('databases cannot mount file secrets', () => {
		expect(() =>
			parseWorkload(databaseInput({ secrets: [{ name: 'TLS_KEY', delivery: 'file' }] })),
		).toThrow(/file secrets/);
	});

	test('alias and image follow the contract derivation', () => {
		expect(databaseAlias(DB_ID)).toBe('db-0123456789abcdef0123456789abcdef');
		expect(databaseAlias('db_a_B-c')).toBe('db-ab-c');
		expect(databaseImage({ engine: 'postgres', version: '16' })).toBe('docker.io/library/postgres:16-alpine');
		expect(databaseImage({ engine: 'postgres', version: '18' })).toBe('docker.io/pgvector/pgvector:0.8.7-pg18-trixie');
		expect(databaseImage({ engine: 'postgres', version: '18', variant: 'postgis' })).toBe(
			'ghcr.io/kieranholroyd/yoal-postgres:18-postgis-1',
		);
	});

	test('Yoal-built variants (D126) are Postgres 18 only and pin their own image', () => {
		const cron = parseWorkload(
			databaseInput({
				image: 'ghcr.io/kieranholroyd/yoal-postgres:18-pg_cron-1',
				database: { engine: 'postgres', version: '18', variant: 'pg_cron' },
			}),
		);
		expect(cron.database).toEqual({ engine: 'postgres', version: '18', variant: 'pg_cron' });
		// The variant changes the image, so the stock image is refused for it and vice versa.
		expect(() =>
			parseWorkload(
				databaseInput({
					image: 'docker.io/pgvector/pgvector:0.8.7-pg18-trixie',
					database: { engine: 'postgres', version: '18', variant: 'postgis' },
				}),
			),
		).toThrow(/workload.image must be/);
		expect(() =>
			parseWorkload(databaseInput({ database: { engine: 'postgres', version: '17', variant: 'postgis' } })),
		).toThrow(/variant postgis is only supported for postgres 18/);
		expect(() =>
			parseWorkload(
				databaseInput({
					image: 'docker.io/pgvector/pgvector:0.8.7-pg18-trixie',
					database: { engine: 'postgres', version: '18', variant: 'timescale' },
				}),
			),
		).toThrow(/variant must be one of/);
	});
});

const ST_ID = 'st_fedcba9876543210fedcba9876543210';
const RUSTFS_PINNED =
	'docker.io/rustfs/rustfs:1.0.4@sha256:ed9210d6411d77ffceb70d94b964a3cb7d225983368bc25bebe01e995293dcc2';

export function storageInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return workloadInput({
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
		env: { RUSTFS_VOLUMES: '/data', RUSTFS_OBS_LOG_DIRECTORY: '' },
		secrets: [],
		objectStorage: {
			engine: 'rustfs',
			version: '1.0.4',
			buckets: [{ name: 'uploads', access: 'public-read' }],
			users: [{ accessKeyId: 'SKFAAAAAAAAAAAAAAAAA', grants: [{ bucket: 'uploads', mode: 'read' }] }],
			deleteBuckets: [{ name: 'old', force: true }],
			keysVersion: 'c'.repeat(64),
		},
		...overrides,
	});
}

describe('object storage profile', () => {
	test('accepts the agent desired state but keeps only engine + version', () => {
		const workload = parseWorkload(storageInput());
		expect(workload.objectStorage).toEqual({ engine: 'rustfs', version: '1.0.4' });
		expect(JSON.stringify(workload)).not.toContain('SKFAAAAAAAAAAAAAAAAA');
		// The digest-pinned reference is accepted too.
		expect(parseWorkload(storageInput({ image: RUSTFS_PINNED })).objectStorage?.version).toBe('1.0.4');
		// An empty env value is still a value.
		expect(workload.env.RUSTFS_OBS_LOG_DIRECTORY).toBe('');
		expect('objectStorage' in parseWorkload(workloadInput())).toBe(false);
	});

	test('the image must match the helper registry', () => {
		for (const image of [
			'docker.io/rustfs/rustfs:1.0.3',
			'docker.io/rustfs/rustfs:latest',
			'rustfs/rustfs:1.0.4',
			'docker.io/rustfs/rustfs:1.0.4@sha256:' + '0'.repeat(64),
			'ghcr.io/evil/rustfs:1.0.4',
		]) {
			expect(() => parseWorkload(storageInput({ image }))).toThrow(/workload.image must be/);
		}
	});

	test('rejects unknown engines, versions, extra keys and non-container runtimes', () => {
		const profile = (extra: Record<string, unknown>) => ({ engine: 'rustfs', version: '1.0.4', keysVersion: 'c'.repeat(64), ...extra });
		expect(() => parseWorkload(storageInput({ objectStorage: profile({ engine: 'minio' }) }))).toThrow(/engine/);
		expect(() => parseWorkload(storageInput({ objectStorage: profile({ engine: 'constructor' }) }))).toThrow(/engine/);
		expect(() => parseWorkload(storageInput({ objectStorage: profile({ version: '1.0.3' }) }))).toThrow(/version/);
		expect(() => parseWorkload(storageInput({ objectStorage: profile({ image: 'x' }) }))).toThrow(/not supported/);
		expect(() => parseWorkload(storageInput({ objectStorage: 'rustfs' }))).toThrow(/object/);
		expect(() => parseWorkload(storageInput({ runtime: 'process', release: SHA, image: undefined }))).toThrow(
			ValidationError,
		);
	});

	test('a workload cannot be both a database and a storage instance', () => {
		expect(() =>
			parseWorkload(storageInput({ database: { engine: 'postgres', version: '17' } })),
		).toThrow(/both/);
		expect(() =>
			parseWorkload(databaseInput({ objectStorage: { engine: 'rustfs', version: '1.0.4' } })),
		).toThrow(/both/);
	});

	test('st_ ids are reserved for storage, and storage needs them', () => {
		expect(() => parseWorkload(storageInput({ id: 'wld_abc123' }))).toThrow(/st_/);
		expect(() => parseWorkload(storageInput({ id: DB_ID }))).toThrow(/st_/);
		expect(() => parseWorkload(workloadInput({ id: 'st_abc' }))).toThrow(/reserved/);
		expect(() => parseWorkload(databaseInput({ id: 'st_abc' }))).toThrow(/st_/);
		expect(assertStorageId('st_abc')).toBe('st_abc');
		for (const value of ['st_', 'wld_abc', 'st_../x', 'ST_abc', '']) {
			expect(() => assertStorageId(value)).toThrow(ValidationError);
		}
		expect(assertManagedId('st_abc')).toBe('st_abc');
		expect(assertManagedId('db_abc')).toBe('db_abc');
		for (const value of ['st_', 'db_', 'wld_abc', 'st_a/b', '../db_x', '']) {
			expect(() => assertManagedId(value)).toThrow(ValidationError);
		}
	});

	test('storage cannot mount file secrets', () => {
		expect(() =>
			parseWorkload(storageInput({ secrets: [{ name: 'TLS_KEY', delivery: 'file' }] })),
		).toThrow(/file secrets/);
	});

	test('alias and image follow the contract derivation', () => {
		expect(storageAlias(ST_ID)).toBe('s3-fedcba9876543210fedcba9876543210');
		expect(storageImage({ engine: 'rustfs', version: '1.0.4' })).toBe(RUSTFS_PINNED);
	});
});

describe('parseActivation', () => {
	test('drops fields the helper does not know, such as monitor credentials', () => {
		const activation = parseActivation(
			activationInput({ monitor: { ownerPassword: 'hunter2' } }),
			parseWorkload(workloadInput()),
		);
		expect('monitor' in activation).toBe(false);
		expect(JSON.stringify(activation)).not.toContain('hunter2');
	});

	test('accepts matching activation and file secrets', () => {
		const workload = parseWorkload(
			workloadInput({ secrets: [{ name: 'TLS_KEY', delivery: 'file' }] }),
		);
		const activation = parseActivation(
			activationInput({ files: { TLS_KEY: '-----BEGIN KEY-----\nabc\n' } }),
			workload,
		);
		expect(activation.files.TLS_KEY).toContain('BEGIN KEY');
	});

	test('rejects a version mismatch and an undeclared file secret', () => {
		const workload = parseWorkload(workloadInput());
		expect(() => parseActivation(activationInput({ workloadId: 'wld_other' }), workload)).toThrow(
			/workloadId/,
		);
		expect(() => parseActivation(activationInput({ activationVersion: SHA }), workload)).toThrow(
			/activationVersion/,
		);
		expect(() => parseActivation(activationInput({ files: { TLS_KEY: 'x' } }), workload)).toThrow(
			/not a file secret/,
		);
	});

	test('parseApplyRequest validates both halves together', () => {
		const parsed = parseApplyRequest({ workload: workloadInput(), activation: activationInput() });
		expect(parsed.workload.id).toBe('wld_abc123');
		expect(parsed.activation.env.DATABASE_URL).toBe('postgres://example');
	});
});

describe('registry credentials (docs/REGISTRY.md R2)', () => {
	const container = () =>
		parseWorkload(
			workloadInput({
				runtime: 'container',
				release: null,
				image: 'ghcr.io/acme/app@sha256:' + 'c'.repeat(64),
				socketActivation: false,
				upstream: '127.0.0.1:3000',
			}),
		);
	const auth = [{ registry: 'ghcr.io', username: 'robot', password: 'pat:with:colons' }];

	test('accepts credentials for a container and renders containers-auth.json', () => {
		const activation = parseActivation(activationInput({ registryAuth: auth }), container());
		expect(activation.registryAuth).toEqual(auth);
		const file = JSON.parse(renderRegistryAuthFile(activation.registryAuth!));
		expect(Buffer.from(file.auths['ghcr.io'].auth, 'base64').toString()).toBe('robot:pat:with:colons');
	});

	test('omits the field when empty or absent', () => {
		expect('registryAuth' in parseActivation(activationInput(), container())).toBe(false);
		expect('registryAuth' in parseActivation(activationInput({ registryAuth: [] }), container())).toBe(false);
	});

	test('refuses credentials for other runtimes and malformed entries', () => {
		expect(() => parseActivation(activationInput({ registryAuth: auth }), parseWorkload(workloadInput()))).toThrow(
			/only for container/,
		);
		const bad = (entry: Record<string, unknown>) =>
			parseActivation(activationInput({ registryAuth: [{ ...auth[0], ...entry }] }), container());
		expect(() => bad({ registry: 'https://ghcr.io' })).toThrow(/registry host/);
		expect(() => bad({ username: 'a:b' })).toThrow(/contains ":"/);
		expect(() => bad({ password: '' })).toThrow(ValidationError);
		expect(() =>
			parseActivation(activationInput({ registryAuth: [auth[0], auth[0]] }), container()),
		).toThrow(/repeats/);
		expect(() =>
			parseActivation(
				activationInput({ registryAuth: Array.from({ length: 9 }, (_, i) => ({ ...auth[0], registry: `r${i}.io` })) }),
				container(),
			),
		).toThrow(/at most 8/);
	});
});

describe('per-org network fields', () => {
	test('accepts an org id and derives the network, or keeps the legacy fallback', () => {
		expect(parseWorkload(workloadInput()).networkName).toBeUndefined();
		expect(parseWorkload(workloadInput({ orgId: 'org_1' }))).toMatchObject({
			orgId: 'org_1',
		});
		expect(parseWorkload(workloadInput({ orgId: 'org_1', networkName: 'yoal-org-org_1' })).networkName).toBe(
			'yoal-org-org_1',
		);
		expect(orgNetworkName('org_1')).toBe('yoal-org-org_1');
	});

	test('rejects a network name that does not belong to the org', () => {
		expect(() =>
			parseWorkload(workloadInput({ orgId: 'org_1', networkName: 'yoal-org-org_2' })),
		).toThrow(/derived/);
		expect(() =>
			parseWorkload(workloadInput({ networkName: 'host' })),
		).toThrow(/yoal-workloads/);
	});
});
describe('app volume desired state', () => {
	test('accepts ids and mount points and defaults the backing to the state dir', () => {
		const workload = parseWorkload(
			workloadInput({
				volumes: [
					{ id: 'av_abc', mountPath: '/var/lib/app', readOnly: false },
					{ id: 'av_def', mountPath: '/var/lib/media', readOnly: true, backing: 'node_volume', nodeVolumeId: 'vol_1' },
				],
			}),
		);
		expect(workload.volumes).toEqual([
			{ id: 'av_abc', mountPath: '/var/lib/app', readOnly: false, backing: 'state_dir' },
			{ id: 'av_def', mountPath: '/var/lib/media', readOnly: true, backing: 'node_volume', nodeVolumeId: 'vol_1' },
		]);
	});

	test('rejects reserved mount points, traversal and duplicate mounts', () => {
		const withVolumes = (volumes: unknown) =>
			parseWorkload(workloadInput({ volumes }));
		expect(() => withVolumes([{ id: 'av_1', mountPath: '/etc' }])).toThrow(/reserved|inside/);
		expect(() => withVolumes([{ id: 'av_1', mountPath: '/var/lib/../etc' }])).toThrow(/normalized/);
		expect(() => withVolumes([{ id: 'av_1', mountPath: '/data' }])).toThrow(/reserved|broad/);
		expect(() =>
			withVolumes([
				{ id: 'av_1', mountPath: '/var/lib/app' },
				{ id: 'av_2', mountPath: '/var/lib/app' },
			]),
		).toThrow(/same path/);
		expect(() =>
			withVolumes([{ id: 'av_1', mountPath: '/var/lib/app', backing: 'node_volume' }]),
		).toThrow(/nodeVolumeId/);
	});
});

describe('worker and runner desired state (plan 21)', () => {
	const runner = {
		runtime: 'container',
		release: null,
		image: 'ghcr.io/actions/actions-runner:latest',
		socketActivation: false,
		upstream: 'none',
		ingress: 'none',
		runner: { provider: 'github' },
	};

	test('accepts a runner replica', () => {
		const parsed = parseWorkload(workloadInput({ ...runner, id: 'wld_abc-r2', replica: { index: 2 } }));
		expect(parsed.ingress).toBe('none');
		expect(parsed.runner).toEqual({ provider: 'github' });
		expect(parsed.id).toBe('wld_abc-r2');
	});

	test('a runner must be a container worker without a data dir', () => {
		expect(() => parseWorkload(workloadInput({ ...runner, ingress: undefined }))).toThrow(/workers/);
		expect(() => parseWorkload(workloadInput({ ...runner, dataSizeMb: 256 }))).toThrow(/data directory/);
		expect(() => parseWorkload(workloadInput({ ...runner, runner: { provider: 'gitlab' } }))).toThrow(/provider/);
		expect(() =>
			parseWorkload(workloadInput({ runtime: 'process', ingress: 'none', runner: { provider: 'github' } })),
		).toThrow(/container runtime/);
	});

	test('ingress only accepts "none"', () => {
		expect(() => parseWorkload(workloadInput({ ingress: 'http' }))).toThrow(/ingress/);
	});
});
