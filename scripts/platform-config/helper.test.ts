import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PlatformConfigStatus } from '../../packages/contracts/src/platform-config.ts';
import { readEnvFile } from '../install/env-file.ts';
import { BACKUP_UNITS, LITESTREAM_SHA256, PlatformConfigHelper, claimRequest, litestreamAsset, type Host, type Layout } from './helper.ts';

const R2 = {
	R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
	R2_BUCKET: 'skiff-prod',
	R2_ACCESS_KEY_ID: 'abcdef0123456789abcdef0123456789',
	R2_SECRET_ACCESS_KEY: 'f'.repeat(64),
};

let root: string;
let layout: Layout;

interface FakeHost extends Host {
	commands: string[][];
	statuses: PlatformConfigStatus[];
	healthy: boolean[];
	units: Record<string, string>;
	downloadBytes: Uint8Array;
	/** Scripted answers for platformAnswers (default true), and the origins it was asked about. */
	answers: boolean[];
	probed: string[];
}

function fakeHost(): FakeHost {
	const host: FakeHost = {
		commands: [],
		statuses: [],
		healthy: [],
		units: {},
		downloadBytes: new Uint8Array(),
		answers: [],
		probed: [],
		run(cmd) {
			host.commands.push(cmd);
			const joined = cmd.join(' ');
			if (joined === 'uname -m') return { code: 0, stdout: 'x86_64\n', stderr: '' };
			if (joined.startsWith('sh -c command -v sqlite3')) return { code: 0, stdout: '/usr/bin/sqlite3\n', stderr: '' };
			if (joined.startsWith('sh -c command -v')) return { code: 1, stdout: '', stderr: '' };
			if (cmd[0] === 'systemctl' && cmd[1] === 'is-active') return { code: 0, stdout: `${host.units[cmd[2]!] ?? 'inactive'}\n`, stderr: '' };
			if (cmd[0] === 'install') writeFileSync(cmd.at(-1)!, '#!/bin/sh\n');
			return { code: 0, stdout: '', stderr: '' };
		},
		log() {},
		sleep: async () => {},
		download: async () => host.downloadBytes,
		controlPlaneHealthy: async () => host.healthy.shift() ?? true,
		platformAnswers: async (origin) => {
			host.probed.push(origin);
			return host.answers.shift() ?? true;
		},
		writeStatus: (status) => void host.statuses.push(status),
		chownRootSkiff() {},
	};
	return host;
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'skiff-platform-config-'));
	const source = join(root, 'repo');
	mkdirSync(join(source, 'scripts', 'systemd'), { recursive: true });
	writeFileSync(join(source, 'scripts', 'litestream.yml'), 'bucket: ${R2_BUCKET}\n');
	for (const unit of BACKUP_UNITS) writeFileSync(join(source, 'scripts', 'systemd', unit), `ExecStart=/usr/local/bin/litestream ${unit}\n`);
	for (const dir of ['etc', 'systemd', 'sbin', 'bin', 'drill', 'request']) mkdirSync(join(root, dir));
	layout = {
		envFile: join(root, 'etc', 'skiff.env'),
		systemdDir: join(root, 'systemd'),
		sbinDir: join(root, 'sbin'),
		optDir: '/opt/skiff',
		sourceDir: source,
		bunBin: '/opt/skiff/runtime/bin/bun',
		litestreamBin: join(root, 'bin', 'litestream'),
		litestreamConfig: join(root, 'etc', 'litestream.yml'),
		drillDir: join(root, 'drill'),
		requestFile: join(root, 'request', 'request.json'),
	};
	writeFileSync(layout.envFile, 'NODE_ENV=production\nBETTER_AUTH_SECRET=keep-me\n');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function request(body: Record<string, unknown>) {
	writeFileSync(layout.requestFile, JSON.stringify({ id: 'req_0123456789', requestedAt: new Date().toISOString(), by: 'user_1', ...body }));
}

describe('claimRequest', () => {
	test('reads and deletes a regular file', () => {
		request({ action: 'restore-drill' });
		expect(claimRequest(layout.requestFile)).toMatchObject({ action: 'restore-drill' });
		expect(existsSync(layout.requestFile)).toBe(false);
	});

	test('returns null when there is no request', () => {
		expect(claimRequest(layout.requestFile)).toBeNull();
	});

	test('refuses to follow a symlink and removes it', () => {
		writeFileSync(join(root, 'secret'), '{"action":"restore-drill"}');
		symlinkSync(join(root, 'secret'), layout.requestFile);
		expect(() => claimRequest(layout.requestFile)).toThrow(/symlink/);
		expect(existsSync(layout.requestFile)).toBe(false);
		expect(existsSync(join(root, 'secret'))).toBe(true);
	});

	test('never echoes invalid content', () => {
		writeFileSync(layout.requestFile, 'root:x:0:0:hunter2');
		expect(() => claimRequest(layout.requestFile)).toThrow('the request is not valid JSON');
	});
});

describe('configure', () => {
	test('writes only the allowlisted keys and restarts the control plane', async () => {
		const host = fakeHost();
		request({ action: 'configure', section: 'alerts', set: { SKIFF_ALERT_WEBHOOK: 'https://ntfy.sh/skiff' } });
		const status = await new PlatformConfigHelper(layout, host).applyRequestFile();
		expect(status?.outcome).toBe('applied');
		expect(status?.changed).toEqual(['SKIFF_ALERT_WEBHOOK']);
		const env = readEnvFile(layout.envFile);
		expect(env.get('SKIFF_ALERT_WEBHOOK')).toBe('https://ntfy.sh/skiff');
		expect(env.get('BETTER_AUTH_SECRET')).toBe('keep-me');
		expect(host.commands).toContainEqual(['systemctl', 'restart', 'skiff-control-plane.service']);
	});

	test('rejects a forged key without touching the env file', async () => {
		const host = fakeHost();
		const before = readFileSync(layout.envFile, 'utf8');
		request({ action: 'configure', section: 'alerts', set: { BETTER_AUTH_SECRET: 'pwned' } });
		const status = await new PlatformConfigHelper(layout, host).applyRequestFile();
		expect(status?.outcome).toBe('rejected');
		expect(readFileSync(layout.envFile, 'utf8')).toBe(before);
		expect(host.commands.some((cmd) => cmd[0] === 'systemctl')).toBe(false);
	});

	test('reverts to the previous env when the control plane does not come back', async () => {
		const host = fakeHost();
		// 60 failed health checks with the new settings, then healthy twice after the revert.
		host.healthy = [...Array(60).fill(false), true, true];
		const before = readFileSync(layout.envFile, 'utf8');
		request({ action: 'configure', section: 'email', set: { SKIFF_SMTP_HOST: 'smtp.example.com', SKIFF_SMTP_PORT: '587', SKIFF_SMTP_FROM: 'Skiff <a@example.com>' } });
		const status = await new PlatformConfigHelper(layout, host).applyRequestFile();
		expect(status?.outcome).toBe('reverted');
		expect(readFileSync(layout.envFile, 'utf8')).toBe(before);
	});

	test('reports unchanged settings without restarting', async () => {
		const host = fakeHost();
		request({ action: 'configure', section: 'alerts', unset: ['SKIFF_ALERT_EMAIL'] });
		const status = await new PlatformConfigHelper(layout, host).applyRequestFile();
		expect(status?.outcome).toBe('unchanged');
		expect(host.commands.some((cmd) => cmd[1] === 'restart')).toBe(false);
	});

	test('refuses to remove R2 credentials while artifacts live in R2', async () => {
		writeFileSync(layout.envFile, `SKIFF_OBJECT_STORE=r2\n${Object.entries(R2).map(([k, v]) => `${k}=${v}`).join('\n')}\n`);
		request({ action: 'configure', section: 'backups', unset: Object.keys(R2) });
		const status = await new PlatformConfigHelper(layout, fakeHost()).applyRequestFile();
		expect(status?.outcome).toBe('rejected');
		expect(readEnvFile(layout.envFile).get('R2_BUCKET')).toBe('skiff-prod');
	});
});

describe('backups', () => {
	test('saving R2 credentials installs the pinned Litestream and enables replication', async () => {
		const host = fakeHost();
		host.units['skiff-litestream.service'] = 'active';
		// Pretend the download matches by pinning its hash for this test.
		host.downloadBytes = new TextEncoder().encode('litestream tarball');
		const original = LITESTREAM_SHA256.amd64!;
		LITESTREAM_SHA256.amd64 = createHash('sha256').update(host.downloadBytes).digest('hex');
		try {
			request({ action: 'configure', section: 'backups', set: R2 });
			const status = await new PlatformConfigHelper(layout, host).applyRequestFile();
			expect(status?.outcome).toBe('applied');
			expect(status?.message).toContain('Backups are on');
		} finally {
			LITESTREAM_SHA256.amd64 = original;
		}
		expect(readEnvFile(layout.envFile).get('R2_ENDPOINT')).toBe(`https://${R2.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`);
		expect(existsSync(layout.litestreamBin)).toBe(true);
		expect(readFileSync(layout.litestreamConfig, 'utf8')).toContain('${R2_BUCKET}');
		for (const unit of BACKUP_UNITS) expect(existsSync(join(layout.systemdDir, unit))).toBe(true);
		expect(readFileSync(join(layout.sbinDir, 'skiff-alert'), 'utf8')).toContain('repo/scripts/skiff-alert.ts');
		expect(host.commands).toContainEqual(['systemctl', 'enable', 'skiff-litestream.service', 'skiff-restore-drill.timer']);
	});

	test('a tampered Litestream download is refused', async () => {
		writeFileSync(layout.envFile, `${Object.entries(R2).map(([k, v]) => `${k}=${v}`).join('\n')}\n`);
		const host = fakeHost();
		host.downloadBytes = new TextEncoder().encode('evil');
		request({ action: 'backups', enabled: true });
		const status = await new PlatformConfigHelper(layout, host).applyRequestFile();
		expect(status?.outcome).toBe('error');
		expect(status?.message).toContain('checksum');
		expect(existsSync(layout.litestreamBin)).toBe(false);
	});

	test('enabling without credentials is rejected', async () => {
		request({ action: 'backups', enabled: true });
		const status = await new PlatformConfigHelper(layout, fakeHost()).applyRequestFile();
		expect(status?.outcome).toBe('rejected');
	});

	test('the drill needs the units, and starts without blocking', async () => {
		const host = fakeHost();
		request({ action: 'restore-drill' });
		expect((await new PlatformConfigHelper(layout, host).applyRequestFile())?.outcome).toBe('rejected');
		writeFileSync(join(layout.systemdDir, 'skiff-restore-drill.service'), '');
		request({ action: 'restore-drill' });
		expect((await new PlatformConfigHelper(layout, host).applyRequestFile())?.outcome).toBe('applied');
		expect(host.commands).toContainEqual(['systemctl', 'start', '--no-block', 'skiff-restore-drill.service']);
	});
});

test('litestreamAsset maps machine names', () => {
	expect(litestreamAsset('x86_64')?.arch).toBe('amd64');
	expect(litestreamAsset('aarch64')?.url).toContain('linux-arm64.tar.gz');
	expect(litestreamAsset('riscv64')).toBeNull();
});

describe('telemetry store (D101)', () => {
	beforeEach(() => {
		// Never let a test touch the real /opt/skiff or /var/lib/skiff.
		layout.optDir = join(root, 'opt');
		layout.clickhouseDataDir = join(root, 'clickhouse-data');
		mkdirSync(join(layout.optDir, 'clickhouse', '26.8.34.13'), { recursive: true });
		mkdirSync(layout.clickhouseDataDir, { recursive: true });
	});

	test('removing it strips only the ClickHouse settings, keeps data and restarts the control plane', async () => {
		writeFileSync(
			layout.envFile,
			'# keep this comment\nNODE_ENV=production\nSKIFF_CLICKHOUSE_URL=http://127.0.0.1:18123\nSKIFF_CLICKHOUSE_PASSWORD=x\nBETTER_AUTH_SECRET=keep-me\n',
		);
		writeFileSync(join(layout.systemdDir, 'skiff-clickhouse.service'), '[Unit]\n');
		const host = fakeHost();
		const status = await new PlatformConfigHelper(layout, host).apply({
			id: 'req_0123456789',
			requestedAt: new Date().toISOString(),
			by: 'user_1',
			action: 'telemetry',
			enabled: false,
			purgeData: false,
		});
		expect(status.outcome).toBe('applied');
		expect(status.changed).toEqual(['SKIFF_CLICKHOUSE_URL', 'SKIFF_CLICKHOUSE_PASSWORD']);
		expect(readFileSync(layout.envFile, 'utf8')).toBe('# keep this comment\nNODE_ENV=production\nBETTER_AUTH_SECRET=keep-me\n');
		expect(existsSync(join(layout.systemdDir, 'skiff-clickhouse.service'))).toBe(false);
		expect(existsSync(join(layout.optDir, 'clickhouse'))).toBe(false);
		expect(existsSync(layout.clickhouseDataDir!)).toBe(true);
		expect(host.commands).toContainEqual(['systemctl', 'disable', '--now', 'skiff-clickhouse.service']);
		expect(host.commands).toContainEqual(['systemctl', 'restart', 'skiff-control-plane.service']);
	});

	test('purge deletes the stored telemetry; removing nothing is a no-op', async () => {
		const host = fakeHost();
		const helper = new PlatformConfigHelper(layout, host);
		const base = { id: 'req_0123456789', requestedAt: new Date().toISOString(), by: 'user_1', action: 'telemetry' as const, enabled: false };
		expect((await helper.apply({ ...base, purgeData: false })).outcome).toBe('unchanged');
		expect(host.commands).toEqual([]);
		expect((await helper.apply({ ...base, purgeData: true })).outcome).toBe('applied');
		expect(existsSync(layout.clickhouseDataDir!)).toBe(false);
	});

	// Off Linux ensureClickHouse refuses before any download; on Linux it would fetch for real.
	test.skipIf(process.platform === 'linux')('a failed install reports why and leaves the control plane alone', async () => {
		const host = fakeHost();
		const status = await new PlatformConfigHelper(layout, host).apply({
			id: 'req_0123456789',
			requestedAt: new Date().toISOString(),
			by: 'user_1',
			action: 'telemetry',
			enabled: true,
			purgeData: false,
		});
		expect(status.outcome).toBe('error');
		expect(status.message).toContain('could not be installed');
		expect(host.commands.some((cmd) => cmd.includes('skiff-control-plane.service'))).toBe(false);
	});
});

describe('telemetry memory and restart', () => {
	const base = { id: 'req_0123456789', requestedAt: new Date().toISOString(), by: 'user_1' };

	test('both refuse when ClickHouse is not installed', async () => {
		writeFileSync(layout.envFile, 'NODE_ENV=production\n');
		const host = fakeHost();
		const helper = new PlatformConfigHelper(layout, host);
		expect((await helper.apply({ ...base, action: 'telemetry-memory', memoryMb: 1024 })).outcome).toBe('rejected');
		expect((await helper.apply({ ...base, action: 'telemetry-restart' })).outcome).toBe('rejected');
		expect(readFileSync(layout.envFile, 'utf8')).toBe('NODE_ENV=production\n');
		expect(host.commands).toEqual([]);
	});

	// Off Linux ensureClickHouse refuses at once, which exercises the revert path.
	test.skipIf(process.platform === 'linux')('a ceiling ClickHouse cannot apply is reverted in skiff.env', async () => {
		layout.optDir = join(root, 'opt');
		writeFileSync(layout.envFile, 'NODE_ENV=production\nSKIFF_CLICKHOUSE_MEMORY_MB=1024\n');
		writeFileSync(join(layout.systemdDir, 'skiff-clickhouse.service'), '[Unit]\n');
		const host = fakeHost();
		const status = await new PlatformConfigHelper(layout, host).apply({ ...base, action: 'telemetry-memory', memoryMb: 2048 });
		expect(status.outcome).toBe('error');
		expect(status.changed).toEqual(['SKIFF_CLICKHOUSE_MEMORY_MB']);
		expect(readEnvFile(layout.envFile).get('SKIFF_CLICKHOUSE_MEMORY_MB')).toBe('1024');
		expect(host.commands.some((cmd) => cmd.includes('skiff-control-plane.service'))).toBe(false);
	});
});

describe('domains', () => {
	const httpsTarget = { platformHost: 'control.example.com', contentDomain: 'example.dev', tls: true, acmeEmail: 'ops@example.com' };
	const agentEnv = [
		'SKIFF_CONTROL_URL=http://203.0.113.7',
		'SKIFF_NODE_TOKEN=node-secret',
		'SKIFF_CONTENT_DOMAIN=203-0-113-7.sslip.io',
		'SKIFF_PLATFORM_HOST=203.0.113.7',
		'SKIFF_TLS=0',
		'',
	].join('\n');

	beforeEach(() => {
		layout = { ...layout, agentEnvFile: join(root, 'etc', 'agent.env'), cloudflareTokenFile: join(root, 'etc', 'cloudflare.token') };
		writeFileSync(
			layout.envFile,
			'NODE_ENV=production\nBETTER_AUTH_SECRET=keep-me\nSKIFF_PLATFORM_ORIGIN=http://203.0.113.7\nSKIFF_CONTENT_DOMAIN=203-0-113-7.sslip.io\n',
		);
		writeFileSync(layout.agentEnvFile!, agentEnv);
	});

	test('moves an IP install to HTTPS domains: both env files, the token, both restarts, verified', async () => {
		const host = fakeHost();
		request({ action: 'domains', ...httpsTarget, cloudflareToken: 'cf'.repeat(20) });
		const status = await new PlatformConfigHelper(layout, host).applyRequestFile();
		expect(status?.outcome).toBe('applied');
		const control = readEnvFile(layout.envFile);
		expect(control.get('SKIFF_PLATFORM_ORIGIN')).toBe('https://control.example.com');
		expect(control.get('SKIFF_CONTENT_DOMAIN')).toBe('example.dev');
		expect(control.get('SKIFF_ACME_EMAIL')).toBe('ops@example.com');
		expect(control.get('BETTER_AUTH_SECRET')).toBe('keep-me');
		const agent = readEnvFile(layout.agentEnvFile!);
		expect(agent.get('SKIFF_CONTROL_URL')).toBe('https://control.example.com');
		expect(agent.get('SKIFF_CONTROL_SOCKET')).toBe('/run/skiff/control.sock');
		expect(agent.get('SKIFF_PLATFORM_HOST')).toBe('control.example.com');
		expect(agent.get('SKIFF_TLS')).toBe('1');
		expect(agent.get('SKIFF_CLOUDFLARE_API_TOKEN_FILE')).toBe(layout.cloudflareTokenFile);
		expect(agent.get('SKIFF_NODE_TOKEN')).toBe('node-secret');
		expect(readFileSync(layout.cloudflareTokenFile!, 'utf8').trim()).toBe('cf'.repeat(20));
		expect(host.commands).toContainEqual(['systemctl', 'restart', 'skiff-control-plane.service']);
		expect(host.commands).toContainEqual(['systemctl', 'restart', 'skiff-agent.service']);
		expect(host.probed.at(-1)).toBe('https://control.example.com');
		expect(status?.message).toContain('https://control.example.com');
	});

	test('HTTPS without any Cloudflare token is rejected before anything changes', async () => {
		const host = fakeHost();
		const before = readFileSync(layout.envFile, 'utf8');
		request({ action: 'domains', ...httpsTarget });
		const status = await new PlatformConfigHelper(layout, host).applyRequestFile();
		expect(status?.outcome).toBe('rejected');
		expect(status?.message).toContain('Cloudflare');
		expect(readFileSync(layout.envFile, 'utf8')).toBe(before);
		expect(host.commands.some((cmd) => cmd[0] === 'systemctl')).toBe(false);
	});

	test('reverts both files and removes a new token when the new address never answers', async () => {
		const host = fakeHost();
		// The new address fails for the whole HTTPS window, then the old one answers.
		host.answers = [...Array(80).fill(false), true];
		const controlBefore = readFileSync(layout.envFile, 'utf8');
		request({ action: 'domains', ...httpsTarget, cloudflareToken: 'cf'.repeat(20) });
		const status = await new PlatformConfigHelper(layout, host).applyRequestFile();
		expect(status?.outcome).toBe('reverted');
		expect(status?.message).toContain('previous domains were restored');
		expect(readFileSync(layout.envFile, 'utf8')).toBe(controlBefore);
		expect(readFileSync(layout.agentEnvFile!, 'utf8')).toBe(agentEnv);
		expect(existsSync(layout.cloudflareTokenFile!)).toBe(false);
		expect(host.probed.at(-1)).toBe('http://203.0.113.7');
	});

	test('the same domains again change nothing and restart nothing', async () => {
		const host = fakeHost();
		request({ action: 'domains', platformHost: '203.0.113.7', contentDomain: '203-0-113-7.sslip.io', tls: false, acmeEmail: '' });
		// The agent env lacks SKIFF_CONTROL_SOCKET at first, so the first run writes it.
		expect((await new PlatformConfigHelper(layout, host).applyRequestFile())?.outcome).toBe('applied');
		const second = fakeHost();
		request({ action: 'domains', platformHost: '203.0.113.7', contentDomain: '203-0-113-7.sslip.io', tls: false, acmeEmail: '' });
		expect((await new PlatformConfigHelper(layout, second).applyRequestFile())?.outcome).toBe('unchanged');
		expect(second.commands.some((cmd) => cmd[0] === 'systemctl')).toBe(false);
	});

	test('a control-plane-only install updates skiff.env and skips the Caddy check', async () => {
		rmSync(layout.agentEnvFile!);
		const host = fakeHost();
		request({ action: 'domains', platformHost: 'control.example.com', contentDomain: 'example.dev', tls: false, acmeEmail: '' });
		const status = await new PlatformConfigHelper(layout, host).applyRequestFile();
		expect(status?.outcome).toBe('applied');
		expect(readEnvFile(layout.envFile).get('SKIFF_PLATFORM_ORIGIN')).toBe('http://control.example.com');
		expect(host.probed).toEqual([]);
	});
});

describe('push-keys', () => {
	test('adds a VAPID pair once, keeps it on a second request, and restarts each time', async () => {
		const host = fakeHost();
		request({ action: 'push-keys' });
		const first = await new PlatformConfigHelper(layout, host).applyRequestFile();
		expect(first?.outcome).toBe('applied');
		expect(first?.changed).toEqual(['SKIFF_VAPID_PUBLIC_KEY', 'SKIFF_VAPID_PRIVATE_KEY']);
		const env = readEnvFile(layout.envFile);
		const publicKey = env.get('SKIFF_VAPID_PUBLIC_KEY');
		expect(publicKey).toMatch(/^[A-Za-z0-9_-]{87}$/);
		expect(env.get('BETTER_AUTH_SECRET')).toBe('keep-me');

		request({ action: 'push-keys' });
		const second = await new PlatformConfigHelper(layout, host).applyRequestFile();
		expect(second?.outcome).toBe('applied');
		expect(second?.changed).toEqual([]);
		expect(readEnvFile(layout.envFile).get('SKIFF_VAPID_PUBLIC_KEY')).toBe(publicKey);
		expect(host.commands.filter((cmd) => cmd.join(' ') === 'systemctl restart skiff-control-plane.service')).toHaveLength(2);
	});

	test('removes the new keys again when the control plane does not come back', async () => {
		const host = fakeHost();
		host.healthy = Array(60).fill(false);
		request({ action: 'push-keys' });
		const status = await new PlatformConfigHelper(layout, host).applyRequestFile();
		expect(status?.outcome).toBe('reverted');
		expect(readEnvFile(layout.envFile).has('SKIFF_VAPID_PUBLIC_KEY')).toBe(false);
	});
});
