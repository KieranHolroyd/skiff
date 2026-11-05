import { describe, expect, test } from 'bun:test';
import {
	escapeEnvValue,
	quoteSystemdArg,
	renderContainerEnvFile,
	renderContainerUnit,
	renderDatabaseUnit,
	renderEnvFile,
	renderStorageUnit,
	renderExecStart,
	renderNetworkUnit,
	renderProcessUnit,
	renderSliceUnit,
	renderSocketUnit,
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
});

describe('network unit', () => {
	test('is a Quadlet network with a fixed name', () => {
		const unit = renderNetworkUnit();
		expect(unit).toContain('[Network]');
		expect(unit).toContain('NetworkName=skiff-workloads');
		expect(unit.startsWith('# Generated by skiff-helper')).toBe(true);
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
