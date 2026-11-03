import { describe, expect, test } from 'bun:test';
import {
	escapeEnvValue,
	quoteSystemdArg,
	renderContainerUnit,
	renderEnvFile,
	renderExecStart,
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
	});
});

describe('env files and argv quoting', () => {
	test('quotes values and escapes newlines/backslashes', () => {
		expect(escapeEnvValue('plain')).toBe('"plain"');
		expect(escapeEnvValue('a"b\\c')).toBe('"a\\"b\\\\c"');
		expect(escapeEnvValue('line1\nline2')).toBe('"line1\\nline2"');
		expect(renderEnvFile({ B: '2', A: '1' })).toBe('A="1"\nB="2"\n');
		expect(renderEnvFile({})).toBe('');
	});

	test('always quotes argv elements', () => {
		expect(quoteSystemdArg('simple')).toBe('"simple"');
		expect(renderExecStart(['/bin/echo', 'hi there'])).toBe('"/bin/echo" "hi there"');
		expect(renderExecStart(['bun', 'run'])).toBe('/usr/bin/env "bun" "run"');
	});
});
