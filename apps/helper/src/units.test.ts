import { describe, expect, test } from 'bun:test';
import {
	escapeEnvValue,
	quoteSystemdArg,
	renderContainerEnvFile,
	renderContainerUnit,
	renderConsoleEnv,
	renderConsoleUnit,
	renderDatabaseUnit,
	renderEnvFile,
	renderStorageUnit,
	renderExecStart,
	renderNetworkUnit,
	renderPoolerConfig,
	renderPoolerUnit,
	renderPoolerUserlist,
	renderKeyValueConfig,
	databaseServerArgs,
	renderProcessUnit,
	renderSliceUnit,
	renderSocketUnit,
	consoleServiceName,
	consoleUnitName,
	serviceUnitName,
	socketUnitName,
} from './units.ts';
import { parseWorkload, type WorkloadDesired } from './validate.ts';

const SHA = 'a'.repeat(64);

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
		cpus: 1.5,
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

describe('slice unit', () => {
	test('carries the node memory budget and a lower CPU weight', () => {
		const unit = renderSliceUnit(1024);
		expect(unit).toContain('MemoryMax=1024M');
		expect(unit).toContain('CPUWeight=200');
		expect(unit).toContain('[Slice]');
	});
});

describe('process unit', () => {
	test('is hardened and runs from the release directory', () => {
		const unit = renderProcessUnit({
			workload: workload(),
			releaseDir: '/srv/skiff/releases/' + SHA,
			envFile: '/run/skiff-workloads/wld_abc123/env',
			secrets: [],
			command: ['bun', 'run', 'start'],
			envNames: ['NODE_ENV'],
		});

		for (const expected of [
			'DynamicUser=yes',
			'StateDirectory=skiff-workloads/wld_abc123',
			`WorkingDirectory=/srv/skiff/releases/${SHA}`,
			'EnvironmentFile=-/run/skiff-workloads/wld_abc123/env',
			'MemoryMax=256M',
			'CPUQuota=150%',
			'Slice=skiff-workloads.slice',
			'Restart=on-failure',
			'NoNewPrivileges=yes',
			'ProtectSystem=strict',
			'PrivateTmp=yes',
			'ProtectHome=yes',
			'CapabilityBoundingSet=',
		]) {
			expect(unit).toContain(expected);
		}
		// Socket-activated services have no [Install] of their own.
		expect(unit).not.toContain('[Install]');
		// No shell is involved.
		expect(unit).toContain('ExecStart=/usr/bin/env "bun" "run" "start"');
		expect(unit).not.toContain('sh -c');
	});

	test('sets loopback PORT/HOST when not socket-activated', () => {
		const unit = renderProcessUnit({
			workload: workload({ socketActivation: false }),
			releaseDir: '/srv/skiff/releases/' + SHA,
			envFile: '/run/skiff-workloads/wld_abc123/env',
			secrets: [],
			command: ['/opt/app/server'],
			envNames: ['NODE_ENV'],
		});
		expect(unit).toContain('Environment=PORT=3000');
		expect(unit).toContain('Environment=HOST=127.0.0.1');
		expect(unit).toContain('ExecStart="/opt/app/server"');
		expect(unit).toContain('[Install]');
		expect(unit).toContain('WantedBy=multi-user.target');
	});

	test('file secrets go through LoadCredential and NAME_FILE', () => {
		const unit = renderProcessUnit({
			workload: workload({ secrets: [{ name: 'TLS_KEY', delivery: 'file' }] }),
			releaseDir: '/srv/skiff/releases/' + SHA,
			envFile: '/run/skiff-workloads/wld_abc123/env',
			secrets: [{ name: 'TLS_KEY', path: '/run/skiff-workloads/wld_abc123/secrets/TLS_KEY' }],
			command: ['bun', 'run', 'start'],
			envNames: ['NODE_ENV', 'TLS_KEY'],
		});
		expect(unit).toContain(
			'LoadCredential=TLS_KEY:/run/skiff-workloads/wld_abc123/secrets/TLS_KEY',
		);
		expect(unit).toContain('Environment=TLS_KEY_FILE=%d/TLS_KEY');
	});

	test('does not override an explicit PORT in the activation env', () => {
		const unit = renderProcessUnit({
			workload: workload({ socketActivation: false }),
			releaseDir: '/srv/skiff/releases/' + SHA,
			envFile: '/run/skiff-workloads/wld_abc123/env',
			secrets: [],
			command: ['bun', 'run', 'start'],
			envNames: ['PORT'],
		});
		expect(unit).not.toContain('Environment=PORT=');
	});

	test('escapes systemd variable/specifier expansion in argv', () => {
		const unit = renderProcessUnit({
			workload: workload(),
			releaseDir: '/srv/skiff/releases/' + SHA,
			envFile: '/run/skiff-workloads/wld_abc123/env',
			secrets: [],
			command: ['bun', 'run', '--flag=$HOME%n', 'quote"and\\slash'],
			envNames: [],
		});
		expect(unit).toContain('--flag=$$HOME%%n');
		expect(unit).toContain('quote\\"and\\\\slash');
	});
});

describe('socket unit', () => {
	test('listens on the project socket with the configured ownership', () => {
		const unit = renderSocketUnit({
			workload: workload(),
			socketPath: '/run/skiff-workloads/prj_abc123.sock',
			socketMode: '0660',
			socketGroup: 'caddy',
		});
		expect(unit).toContain('ListenStream=/run/skiff-workloads/prj_abc123.sock');
		expect(unit).toContain('SocketMode=0660');
		expect(unit).toContain('SocketGroup=caddy');
		expect(unit).toContain('WantedBy=sockets.target');
	});

	test('omits SocketGroup when none is configured', () => {
		const unit = renderSocketUnit({
			workload: workload(),
			socketPath: '/run/skiff-workloads/prj_abc123.sock',
			socketMode: '0666',
			socketGroup: null,
		});
		expect(unit).not.toContain('SocketGroup=');
	});

	test('unit names are stable and id-scoped', () => {
		expect(serviceUnitName('wld_1')).toBe('skiff-workload-wld_1.service');
		expect(socketUnitName('wld_1')).toBe('skiff-workload-wld_1.socket');
	});
});

describe('container unit', () => {
	test('renders a Quadlet with the same caps as a process unit', () => {
		const unit = renderContainerUnit({
			workload: workload({
				runtime: 'container',
				release: null,
				image: 'ghcr.io/acme/app:1.2.3',
				secrets: [{ name: 'TLS_KEY', delivery: 'file' }],
				socketActivation: false,
			}),
			image: 'ghcr.io/acme/app:1.2.3',
			envFile: '/run/skiff-workloads/wld_abc123/env',
			dataDir: '/var/lib/skiff-workloads/wld_abc123',
			secretsDir: '/run/skiff-workloads/wld_abc123/secrets',
		});
		expect(unit).toContain('Image=ghcr.io/acme/app:1.2.3');
		expect(unit).toContain('PublishPort=127.0.0.1:3000:3000');
		expect(unit).toContain('EnvironmentFile=/run/skiff-workloads/wld_abc123/env');
		expect(unit).toContain('Volume=/var/lib/skiff-workloads/wld_abc123:/data:Z');
		expect(unit).toContain('Volume=/run/skiff-workloads/wld_abc123/secrets:/run/skiff-secrets:ro,Z');
		expect(unit).toContain('Environment=TLS_KEY_FILE=/run/skiff-secrets/TLS_KEY');
		expect(unit).toContain('DropCapability=all');
		expect(unit).toContain('NoNewPrivileges=true');
		expect(unit).toContain('MemoryMax=256M');
		expect(unit).toContain('CPUQuota=150%');
		expect(unit).toContain('Slice=skiff-workloads.slice');
		expect(unit).toContain('WantedBy=default.target');
		// Every container joins the shared network, so it can reach databases by alias.
		expect(unit).toContain('Network=skiff-workloads.network');
		expect(unit).not.toContain('NetworkAlias=');
		expect(unit).not.toContain('User=');
	});

	test('passes an AppArmor override only when the host needs it', () => {
		const base = {
			workload: workload({
				runtime: 'container',
				release: null,
				image: 'ghcr.io/acme/app:1.2.3',
				socketActivation: false,
			}),
			image: 'ghcr.io/acme/app:1.2.3',
			envFile: '/run/skiff-workloads/wld_abc123/env',
			dataDir: '/var/lib/skiff-workloads/wld_abc123',
			secretsDir: null,
		};
		expect(renderContainerUnit(base)).not.toContain('PodmanArgs=');
		expect(renderContainerUnit({ ...base, apparmorProfile: 'unconfined' })).toContain(
			'PodmanArgs=--security-opt apparmor=unconfined',
		);
	});
});

describe('network unit', () => {
	test('is a Quadlet network with a fixed name', () => {
		const unit = renderNetworkUnit();
		expect(unit).toContain('[Network]');
		expect(unit).toContain('NetworkName=skiff-workloads');
		expect(unit.startsWith('# Generated by skiff-helper')).toBe(true);
	});

	test('renders an org network on demand', () => {
		const unit = renderNetworkUnit('skiff-org-org_1');
		expect(unit).toContain('NetworkName=skiff-org-org_1');
		expect(unit).not.toContain('NetworkName=skiff-workloads');
	});

	test('container units join the workload org network, falling back for old state', () => {
		const isolated = renderContainerUnit({
			workload: workload({
				runtime: 'container',
				release: null,
				image: 'ghcr.io/acme/app:1',
				socketActivation: false,
				orgId: 'org_1',
				networkName: 'skiff-org-org_1',
			}),
			image: 'ghcr.io/acme/app:1',
			envFile: '/run/skiff-workloads/wld_abc123/env',
			dataDir: '/var/lib/skiff-workloads/wld_abc123',
			secretsDir: null,
		});
		expect(isolated).toContain('Network=skiff-org-org_1.network');

		const legacy = renderContainerUnit({
			workload: workload({
				runtime: 'container',
				release: null,
				image: 'ghcr.io/acme/app:1',
				socketActivation: false,
			}),
			image: 'ghcr.io/acme/app:1',
			envFile: '/run/skiff-workloads/wld_abc123/env',
			dataDir: '/var/lib/skiff-workloads/wld_abc123',
			secretsDir: null,
		});
		expect(legacy).toContain('Network=skiff-workloads.network');
	});
});

describe('database unit', () => {
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
			port: 15432,
			memoryMb: 512,
			cpus: 0.5,
			healthPath: '/',
			socketActivation: false,
			env: { POSTGRES_USER: 'orders' },
			database: { engine: 'postgres', version: '17' },
			...overrides,
		});
	}

	test('renders the fixed profile with loopback-only publishing', () => {
		const options = {
			workload: database(),
			envFile: `/run/skiff-workloads/${DB_ID}/env`,
			dataDir: `/var/lib/skiff-workloads/${DB_ID}`,
		};
		const unit = renderDatabaseUnit(options);
		for (const expected of [
			`ContainerName=skiff-workload-${DB_ID}`,
			'Image=docker.io/library/postgres:17-alpine',
			'User=70:70',
			'PublishPort=127.0.0.1:15432:5432',
			'Network=skiff-workloads.network',
			'NetworkAlias=db-0123456789abcdef0123456789abcdef',
			`EnvironmentFile=/run/skiff-workloads/${DB_ID}/env`,
			`Volume=/var/lib/skiff-workloads/${DB_ID}:/data:Z`,
			'Tmpfs=/var/run/postgresql:rw,size=8m,mode=1777',
			'Tmpfs=/tmp:rw,size=64m',
			'DropCapability=all',
			'NoNewPrivileges=true',
			'ReadOnly=true',
			'Restart=on-failure',
			'TimeoutStartSec=600',
			'TimeoutStopSec=120',
			'MemoryMax=512M',
			'CPUQuota=50%',
			'Slice=skiff-workloads.slice',
		]) {
			expect(unit).toContain(expected);
		}
		expect(unit.match(/^PublishPort=/gm)).toHaveLength(1);
		expect(unit).not.toContain('skiff-secrets');
		// The generic renderer switches to the same profile.
		expect(renderContainerUnit({ ...options, image: 'ignored', secretsDir: '/run/x/secrets' })).toBe(unit);
	});

	test('derives the image from engine + version, not workload.image', () => {
		const unit = renderDatabaseUnit({
			workload: { ...database(), image: 'ghcr.io/evil/image:1' },
			envFile: '/run/env',
			dataDir: '/var/lib/x',
		});
		expect(unit).toContain('Image=docker.io/library/postgres:17-alpine');
		expect(unit).not.toContain('evil');
	});

	test('refuses a workload without a database profile', () => {
		expect(() =>
			renderDatabaseUnit({ workload: workload(), envFile: '/run/env', dataDir: '/var/lib/x' }),
		).toThrow(/database/);
	});

	test('mounts the TLS directory and enables ssl with TLSv1.2', () => {
		const unit = renderDatabaseUnit({
			workload: database(),
			envFile: '/run/env',
			dataDir: '/var/lib/x',
			tlsDir: `/run/skiff-workloads/${DB_ID}/tls`,
		});
		expect(unit).toContain(`Volume=/run/skiff-workloads/${DB_ID}/tls:/run/skiff-tls:ro,Z`);
		expect(unit).toContain('ssl=on');
		expect(unit).toContain('ssl_cert_file=/run/skiff-tls/server.crt');
		expect(unit).toContain('ssl_key_file=/run/skiff-tls/server.key');
		expect(unit).toContain('ssl_min_protocol_version=TLSv1.2');
	});

	test('does not mount TLS when the directory is absent', () => {
		const unit = renderDatabaseUnit({ workload: database(), envFile: '/run/env', dataDir: '/var/lib/x' });
		expect(unit).not.toContain('/run/skiff-tls');
		expect(unit).not.toContain('ssl=on');
	});
});

describe('database pooler unit', () => {
	const database = (): WorkloadDesired =>
		parseWorkload({
			...workload(),
			id: 'db_abc123',
			projectId: 'db_abc123',
			projectSlug: 'main-db',
			deploymentId: 'db_abc123',
			runtime: 'container',
			release: null,
			image: 'docker.io/library/postgres:17-alpine',
			upstream: '127.0.0.1:15432',
			port: 15432,
			healthPath: '/',
			socketActivation: false,
			env: { POSTGRES_USER: 'main_db', POSTGRES_DB: 'main_db' },
			database: { engine: 'postgres', version: '17' },
			pooler: { port: 16432 },
		});

	test('renders a loopback-only sidecar with read-only config mounts', () => {
		const unit = renderPoolerUnit({
			workload: database(),
			configPath: '/run/skiff-workloads/db_abc123/pgbouncer.ini',
			userlistPath: '/run/skiff-workloads/db_abc123/pgbouncer-users.txt',
		});
		expect(unit).toContain('PublishPort=127.0.0.1:16432:6432');
		expect(unit).toContain('NetworkAlias=db-abc123-pool');
		expect(unit).toContain('pgbouncer.ini:ro,Z');
		expect(unit).toContain('DropCapability=all');
		expect(unit).toContain('MemoryMax=64M');
		// The pin is the multi-arch index, so both amd64 and arm64 nodes can resolve a manifest.
		expect(unit).toContain('Image=docker.io/edoburu/pgbouncer:latest@sha256:8638aa56');
	});

	test('passes the AppArmor override to the sidecar too', () => {
		const unit = renderPoolerUnit({
			workload: database(),
			configPath: '/run/pgbouncer.ini',
			userlistPath: '/run/users.txt',
			apparmorProfile: 'unconfined',
		});
		expect(unit).toContain('PodmanArgs=--security-opt apparmor=unconfined');
	});

	test('renders a transaction-mode config and a quoted userlist', () => {
		expect(renderPoolerConfig({ databaseAlias: 'db-abc123', authFile: '/etc/pgbouncer/userlist.txt' })).toContain(
			'pool_mode = transaction',
		);
		expect(renderPoolerUserlist('main_db', 'p"a\\ss')).toBe('"main_db" "p\\"a\\\\ss"\n');
		const config = renderPoolerConfig({
			databaseAlias: 'db-abc123',
			authFile: '/etc/pgbouncer/userlist.txt',
			adminUser: 'main_db',
			tls: { certFile: '/run/skiff-tls/server.crt', keyFile: '/run/skiff-tls/server.key' },
		});
		expect(config).toContain('admin_users = main_db');
		expect(config).toContain('client_tls_sslmode = require');
		expect(config).toContain('client_tls_cert_file = /run/skiff-tls/server.crt');
		expect(config).toContain('client_tls_key_file = /run/skiff-tls/server.key');
		expect(
			renderPoolerUnit({
				workload: database(),
				configPath: '/run/pgbouncer.ini',
				userlistPath: '/run/users.txt',
				tlsDir: '/run/skiff-workloads/db_abc123/tls',
			}),
		).toContain('Volume=/run/skiff-workloads/db_abc123/tls:/run/skiff-tls:ro,Z');
	});
});

describe('database console unit', () => {
	const DB_ID = 'db_0123456789abcdef0123456789abcdef';

	function database(): WorkloadDesired {
		return parseWorkload({
			...workload(),
			id: DB_ID,
			projectId: DB_ID,
			projectSlug: 'orders',
			deploymentId: DB_ID,
			runtime: 'container',
			release: null,
			image: 'docker.io/library/postgres:17-alpine',
			port: 15432,
			memoryMb: 512,
			cpus: 0.5,
			healthPath: '/',
			socketActivation: false,
			env: { POSTGRES_USER: 'orders' },
			database: { engine: 'postgres', version: '17' },
		});
	}

	test('names the sidecar unit after the database', () => {
		expect(consoleUnitName('db_1')).toBe('skiff-workload-db_1-console.container');
		expect(consoleServiceName('db_1')).toBe('skiff-workload-db_1-console.service');
	});

	test('renders the single-connection env with encoded credentials', () => {
		const env = renderConsoleEnv({
			id: DB_ID,
			database: { user: 'orders', password: 'p@ss:w/rd?', database: 'orders' },
			webRoot: '/databases/orders/studio/proxy/',
			authUser: 'skiff',
			authPassword: 'session-password-1234',
			readOnly: true,
			tls: true,
		});
		const values = new Map(
			env
				.trimEnd()
				.split('\n')
				.map((line) => {
					const eq = line.indexOf('=');
					return [line.slice(0, eq), line.slice(eq + 1)] as const;
				}),
		);
		expect(values.get('CONNECTIONS')).toBe('skiff');
		expect(values.get('LABEL_skiff')).toBe('orders');
		expect(values.get('URL_skiff')).toBe(
			'postgres://orders:p%40ss%3Aw%2Frd%3F@db-0123456789abcdef0123456789abcdef:5432/orders?sslmode=require',
		);
		expect(values.get('ENGINE_skiff')).toBe('postgres@dbgate-plugin-postgres');
		expect(values.get('SINGLE_CONNECTION')).toBe('skiff');
		expect(values.get('SINGLE_DATABASE')).toBe('orders');
		expect(values.get('WEB_ROOT')).toBe('/databases/orders/studio/proxy');
		expect(values.get('LOGIN')).toBe('skiff');
		expect(values.get('PASSWORD')).toBe('session-password-1234');
		expect(values.get('BASIC_AUTH')).toBe('1');
		expect(values.get('PORT')).toBe('3000');
		expect(values.get('SHELL_CONNECTION')).toBe('0');
		expect(values.get('SHELL_SCRIPTING')).toBe('0');
		expect(values.get('READONLY_skiff')).toBe('1');
	});

	test('omits TLS and read-only flags when they are off', () => {
		const env = renderConsoleEnv({
			id: DB_ID,
			database: { user: 'orders', password: 'secret', database: 'orders' },
			webRoot: '/studio',
			authUser: 'skiff',
			authPassword: 'session-password-1234',
			readOnly: false,
		});
		expect(env).not.toContain('sslmode=require');
		expect(env).not.toContain('READONLY_skiff');
	});

	test('refuses values a container env file cannot carry', () => {
		expect(() =>
			renderConsoleEnv({
				id: DB_ID,
				database: { user: 'orders', password: 'secret', database: 'orders' },
				webRoot: '/studio\nproxy',
				authUser: 'skiff',
				authPassword: 'session-password-1234',
				readOnly: false,
			}),
		).toThrow(/line break/);
	});

	test('renders a loopback-only hardened sidecar on the database network', () => {
		const unit = renderConsoleUnit({
			workload: database(),
			envFile: `/run/skiff-workloads/${DB_ID}/console.env`,
			port: 17432,
			apparmorProfile: 'unconfined',
		});
		for (const expected of [
			`ContainerName=skiff-workload-${DB_ID}-console`,
			'Image=docker.io/dbgate/dbgate:7.3.4@sha256:ac3df611',
			'PublishPort=127.0.0.1:17432:3000',
			'Network=skiff-workloads.network',
			'NetworkAlias=db-0123456789abcdef0123456789abcdef-console',
			`EnvironmentFile=/run/skiff-workloads/${DB_ID}/console.env`,
			'Tmpfs=/root/.dbgate:rw,size=64m',
			'Tmpfs=/tmp:rw,size=64m',
			'DropCapability=all',
			'NoNewPrivileges=true',
			'ReadOnly=true',
			'PodmanArgs=--security-opt apparmor=unconfined',
			'Restart=no',
			'TimeoutStartSec=300',
			'TimeoutStopSec=30',
			'MemoryMax=256M',
			'CPUQuota=100%',
			'Slice=skiff-workloads.slice',
			'WantedBy=default.target',
		]) {
			expect(unit).toContain(expected);
		}
		expect(unit.match(/^PublishPort=/gm)).toHaveLength(1);
	});

	test('refuses a workload without a database profile', () => {
		expect(() =>
			renderConsoleUnit({ workload: workload(), envFile: '/run/console.env', port: 17432 }),
		).toThrow(/database/);
	});
});

describe('storage unit', () => {
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
			port: 19003,
			memoryMb: 512,
			cpus: 1,
			healthPath: '/health',
			socketActivation: false,
			env: {},
			objectStorage: { engine: 'rustfs', version: '1.0.4', keysVersion: 'c'.repeat(64) },
			...overrides,
		});
	}

	test('renders the fixed profile with a digest-pinned image and loopback-only publishing', () => {
		const options = {
			workload: storage(),
			envFile: `/run/skiff-workloads/${ST_ID}/env`,
			dataDir: `/var/lib/skiff-workloads/${ST_ID}`,
		};
		const unit = renderStorageUnit(options);
		for (const expected of [
			`ContainerName=skiff-workload-${ST_ID}`,
			'Image=docker.io/rustfs/rustfs:1.0.4@sha256:ed9210d6411d77ffceb70d94b964a3cb7d225983368bc25bebe01e995293dcc2',
			'User=10001:10001',
			'PublishPort=127.0.0.1:19003:9000',
			'Network=skiff-workloads.network',
			'NetworkAlias=s3-fedcba9876543210fedcba9876543210',
			`EnvironmentFile=/run/skiff-workloads/${ST_ID}/env`,
			`Volume=/var/lib/skiff-workloads/${ST_ID}:/data:Z`,
			'Tmpfs=/tmp:rw,size=64m',
			'DropCapability=all',
			'NoNewPrivileges=true',
			'ReadOnly=true',
			'Restart=on-failure',
			'TimeoutStartSec=600',
			'MemoryMax=512M',
			'CPUQuota=100%',
			'Slice=skiff-workloads.slice',
			'WantedBy=default.target',
		]) {
			expect(unit).toContain(expected);
		}
		expect(unit.match(/^PublishPort=/gm)).toHaveLength(1);
		expect(unit.match(/^Volume=/gm)).toHaveLength(1);
		expect(unit).not.toContain('skiff-secrets');
		expect(unit).not.toContain('postgresql');
		expect(renderContainerUnit({ ...options, image: 'ignored', secretsDir: '/run/x/secrets' })).toBe(unit);
	});

	test('derives the image from engine + version, not workload.image', () => {
		const unit = renderStorageUnit({
			workload: { ...storage(), image: 'ghcr.io/evil/image:1' },
			envFile: '/run/env',
			dataDir: '/var/lib/x',
		});
		expect(unit).toContain('Image=docker.io/rustfs/rustfs:1.0.4@sha256:');
		expect(unit).not.toContain('evil');
	});

	test('refuses a workload without a storage profile', () => {
		expect(() => renderStorageUnit({ workload: workload(), envFile: '/run/env', dataDir: '/var/lib/x' })).toThrow(
			/objectStorage/,
		);
	});
});

describe('env files and argv quoting', () => {
	test('quotes values and escapes newlines/backslashes', () => {
		expect(escapeEnvValue('plain')).toBe('"plain"');
		expect(escapeEnvValue('a"b\\c')).toBe('"a\\"b\\\\c"');
		expect(escapeEnvValue('line1\nline2')).toBe('"line1\\nline2"');
		expect(renderEnvFile({ B: '2', A: '1' })).toBe('A="1"\nB="2"\n');
		expect(renderEnvFile({})).toBe('');
		// Empty values are explicit and bare.
		expect(renderEnvFile({ EMPTY: '', A: 'x' })).toBe('A="x"\nEMPTY=\n');
	});

	test('container env files are literal, as Podman reads them', () => {
		expect(renderContainerEnvFile({ B: 'two words', A: 'a"b\\c=d', EMPTY: '' })).toBe(
			'A=a"b\\c=d\nB=two words\nEMPTY=\n',
		);
		expect(renderContainerEnvFile({})).toBe('');
		expect(() => renderContainerEnvFile({ PEM: 'line1\nline2' })).toThrow(/line break/);
		expect(() => renderContainerEnvFile({ CR: 'a\rb' })).toThrow(/line break/);
	});

	test('always quotes argv elements', () => {
		expect(quoteSystemdArg('simple')).toBe('"simple"');
		expect(renderExecStart(['/bin/echo', 'hi there'])).toBe('"/bin/echo" "hi there"');
		expect(renderExecStart(['bun', 'run'])).toBe('/usr/bin/env "bun" "run"');
	});
});

describe('app volume mounts (plan 07)', () => {
	test('process units bind each volume at its sandbox path, read-only when attached so', () => {
		const unit = renderProcessUnit({
			workload: workload({
				volumes: [
					{ id: 'av_1', mountPath: '/var/lib/app', readOnly: false, backing: 'state_dir' },
					{ id: 'av_2', mountPath: '/var/lib/media', readOnly: true, backing: 'state_dir' },
				],
			}),
			releaseDir: '/srv/skiff/releases/' + SHA,
			envFile: '/run/skiff-workloads/wld_abc123/env',
			secrets: [],
			command: ['bun', 'run', 'start'],
			envNames: [],
			volumeMounts: [
				{ hostPath: '/var/lib/skiff-workloads/apps/prj_abc123/av_1', mountPath: '/var/lib/app', readOnly: false },
				{ hostPath: '/var/lib/skiff-workloads/apps/prj_abc123/av_2', mountPath: '/var/lib/media', readOnly: true },
			],
		});
		expect(unit).toContain(
			'BindPaths=/var/lib/skiff-workloads/apps/prj_abc123/av_1:/var/lib/app',
		);
		expect(unit).toContain('ReadWritePaths=/var/lib/app');
		expect(unit).toContain(
			'BindReadOnlyPaths=/var/lib/skiff-workloads/apps/prj_abc123/av_2:/var/lib/media',
		);
		expect(unit).not.toContain('ReadWritePaths=/var/lib/media');
		// The legacy /data mount is not reused for app volumes.
		expect(unit).not.toContain(':/data');
	});

	test('container units mount each volume, read-only when asked', () => {
		const unit = renderContainerUnit({
			workload: workload({
				runtime: 'container',
				image: 'docker.io/library/nginx:1',
				socketActivation: false,
				volumes: [
					{ id: 'av_1', mountPath: '/var/lib/app', readOnly: false, backing: 'state_dir' },
					{ id: 'av_2', mountPath: '/var/lib/media', readOnly: true, backing: 'state_dir' },
				],
			}),
			image: 'docker.io/library/nginx:1',
			envFile: '/run/skiff-workloads/wld_abc123/env',
			dataDir: '/var/lib/skiff-workloads/wld_abc123',
			secretsDir: null,
			volumeMounts: [
				{ hostPath: '/var/lib/skiff-workloads/apps/prj_abc123/av_1', mountPath: '/var/lib/app', readOnly: false },
				{ hostPath: '/var/lib/skiff-workloads/apps/prj_abc123/av_2', mountPath: '/var/lib/media', readOnly: true },
			],
		});
		expect(unit).toContain(
			'Volume=/var/lib/skiff-workloads/apps/prj_abc123/av_1:/var/lib/app:Z',
		);
		expect(unit).toContain(
			'Volume=/var/lib/skiff-workloads/apps/prj_abc123/av_2:/var/lib/media:ro:Z',
		);
	});
});

describe('worker and runner units (plan 21)', () => {
	const options = {
		image: 'ghcr.io/actions/actions-runner:latest',
		envFile: '/run/skiff-workloads/wld_abc123-r1/env',
		dataDir: '/var/lib/skiff-workloads/wld_abc123-r1',
		secretsDir: null,
	};

	test('a worker publishes no port but keeps the hardened container shape', () => {
		const unit = renderContainerUnit({
			workload: workload({
				runtime: 'container',
				release: null,
				image: 'ghcr.io/acme/bot:1',
				socketActivation: false,
				upstream: 'none',
				ingress: 'none',
			}),
			...options,
			image: 'ghcr.io/acme/bot:1',
		});
		expect(unit).not.toContain('PublishPort=');
		expect(unit).toContain('ReadOnly=true');
		expect(unit).toContain('Restart=on-failure');
		expect(unit).toContain('Volume=/var/lib/skiff-workloads/wld_abc123-r1:/data:Z');
	});

	test('a runner is ephemeral: fixed entrypoint, newest image, no restart, no data dir', () => {
		const unit = renderContainerUnit({
			workload: workload({
				id: 'wld_abc123-r1',
				runtime: 'container',
				release: null,
				image: 'ghcr.io/actions/actions-runner:latest',
				socketActivation: false,
				upstream: 'none',
				ingress: 'none',
				runner: { provider: 'github' },
			}),
			...options,
		});
		expect(unit).toContain('ContainerName=skiff-workload-wld_abc123-r1');
		expect(unit).toContain('Exec=/home/runner/run.sh');
		expect(unit).toContain('Pull=newer');
		expect(unit).toContain('Restart=no');
		expect(unit).toContain('TimeoutStartSec=900');
		expect(unit).not.toContain('Restart=on-failure');
		expect(unit).not.toContain('PublishPort=');
		expect(unit).not.toContain(':/data:');
		expect(unit).not.toContain('ReadOnly=true');
		// Still unprivileged: sudo inside the runner image cannot escalate.
		expect(unit).toContain('DropCapability=all');
		expect(unit).toContain('NoNewPrivileges=true');
		expect(unit).toContain('Slice=skiff-workloads.slice');
	});
});

describe('engine database units (D95)', () => {
	const DB_ID = 'db_0123456789abcdef0123456789abcdef';
	function engineDb(engine: string, version: string, image: string, memoryMb = 512): WorkloadDesired {
		return workload({
			id: DB_ID,
			projectId: DB_ID,
			projectSlug: 'orders',
			deploymentId: DB_ID,
			runtime: 'container',
			release: null,
			image,
			port: 15432,
			memoryMb,
			cpus: 0.5,
			healthPath: '/',
			socketActivation: false,
			env: {},
			database: { engine, version },
		});
	}

	test('MySQL runs the image entrypoint with fixed, memory-sized flags and a socket tmpfs', () => {
		const unit = renderDatabaseUnit({
			workload: engineDb('mysql', '8.4', 'docker.io/library/mysql:8.4', 1000),
			envFile: '/run/env',
			dataDir: '/var/lib/x',
		});
		expect(unit).toContain('Image=docker.io/library/mysql:8.4');
		expect(unit).not.toContain('Entrypoint=');
		expect(unit).toContain(
			'Exec="mysqld" "--datadir=/data/mysql" "--innodb-buffer-pool-size=400M" "--performance-schema=OFF" "--mysqlx=OFF" "--skip-name-resolve" "--host-cache-size=0"',
		);
		expect(unit).toContain('User=999:999');
		expect(unit).toContain('PublishPort=127.0.0.1:15432:3306');
		expect(unit).toContain('Tmpfs=/var/run/mysqld:rw,size=8m,mode=1777');
		expect(unit).toContain('ReadOnly=true');
		expect(unit).toContain('DropCapability=all');
		expect(unit).toContain('MemoryMax=1000M');
		expect(unit).not.toContain('postgres');
	});

	test('MariaDB, MongoDB and Valkey/Redis get their own ports, users and arguments', () => {
		const maria = renderDatabaseUnit({
			workload: engineDb('mariadb', '11.8', 'docker.io/library/mariadb:11.8'),
			envFile: '/run/env',
			dataDir: '/var/lib/x',
		});
		expect(maria).toContain('Exec="mariadbd" "--datadir=/data/mysql" "--innodb-buffer-pool-size=204M"');
		expect(maria).toContain('Tmpfs=/run/mysqld:rw,size=8m,mode=1777');
		const mongo = renderDatabaseUnit({
			workload: engineDb('mongodb', '8.0', 'docker.io/library/mongo:8.0'),
			envFile: '/run/env',
			dataDir: '/var/lib/x',
		});
		expect(mongo).toContain('Exec="mongod" "--dbpath" "/data/db" "--bind_ip_all" "--wiredTigerCacheSizeGB" "0.25"');
		expect(mongo).toContain('PublishPort=127.0.0.1:15432:27017');
		const valkey = renderDatabaseUnit({
			workload: engineDb('valkey', '9.1', 'docker.io/valkey/valkey:9.1-alpine'),
			envFile: '/run/env',
			dataDir: '/var/lib/x',
			serverConfigPath: '/run/skiff-workloads/db_x/server.conf',
		});
		expect(valkey).toContain('Exec="valkey-server" "/etc/skiff/server.conf"');
		expect(valkey).toContain('Volume=/run/skiff-workloads/db_x/server.conf:/etc/skiff/server.conf:ro,Z');
		expect(valkey).toContain('User=999:1000');
		expect(valkey).toContain('PublishPort=127.0.0.1:15432:6379');
		expect(() =>
			renderDatabaseUnit({
				workload: engineDb('redis', '8.10', 'docker.io/library/redis:8.10-alpine'),
				envFile: '/run/env',
				dataDir: '/var/lib/x',
			}),
		).toThrow(/server config/);
	});

	test('MongoDB cache grows with memory', () => {
		expect(databaseServerArgs('mongodb', 4096)).toContain('1.6');
		expect(databaseServerArgs('mongodb', 256)).toContain('0.25');
	});

	test('the Valkey/Redis config disables the default user and caps memory below MemoryMax', () => {
		const config = renderKeyValueConfig({ user: 'orders', password: 'p'.repeat(32), memoryMb: 256 });
		expect(config).toContain('user default off');
		expect(config).toContain(`user orders on >${'p'.repeat(32)} ~* &* +@all`);
		expect(config).toContain('maxmemory 192mb');
		expect(config).toContain('maxmemory-policy noeviction');
		expect(config).toContain('appendonly yes');
		expect(() => renderKeyValueConfig({ user: 'orders', password: 'bad pass\nuser x on', memoryMb: 256 })).toThrow();
		expect(() => renderKeyValueConfig({ user: 'a b', password: 'p'.repeat(32), memoryMb: 256 })).toThrow();
	});

	test('the studio env uses each engine\'s DBGate driver', () => {
		const base = { id: DB_ID, webRoot: '/databases/orders/studio/proxy/', authUser: 'skiff', authPassword: 'x'.repeat(24), readOnly: true };
		const creds = { user: 'orders', password: 'secret', database: 'orders' };
		const mysql = renderConsoleEnv({ ...base, engine: 'mysql', database: creds });
		expect(mysql).toContain('ENGINE_skiff=mysql@dbgate-plugin-mysql');
		expect(mysql).toContain('SERVER_skiff=db-0123456789abcdef0123456789abcdef');
		expect(mysql).toContain('PORT_skiff=3306');
		expect(mysql).toContain('SINGLE_DATABASE=orders');
		const mongo = renderConsoleEnv({ ...base, engine: 'mongodb', database: creds });
		expect(mongo).toContain('URL_skiff=mongodb://orders:secret@db-0123456789abcdef0123456789abcdef:27017/orders?authSource=admin');
		const valkey = renderConsoleEnv({ ...base, engine: 'valkey', database: { ...creds, database: '' } });
		expect(valkey).toContain('ENGINE_skiff=redis@dbgate-plugin-redis');
		expect(valkey).not.toContain('SINGLE_DATABASE');
		expect(valkey).toContain('LABEL_skiff=orders');
	});
});
