import { afterEach, describe, expect, test } from 'bun:test';
import { BUILD_VERSION } from './build-version.ts';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, loadConfig } from './config.ts';

const directories: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(join(tmpdir(), 'yoal-agent-config-'));
	directories.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const base = {
	YOAL_CONTROL_URL: 'https://cloud.example.com/',
	YOAL_NODE_TOKEN: 'token',
	YOAL_NODE_ID: 'nod_1',
};

describe('loadConfig', () => {
	test('applies production defaults and strips the control URL slash', () => {
		const config = loadConfig({ ...base });
		expect(config.controlUrl).toBe('https://cloud.example.com');
		expect(config.dataDir).toBe('/var/lib/yoal-agent');
		expect(config.agentVersion).toBe(BUILD_VERSION);
		expect(config.caddyAdminSocket).toBe('/var/lib/caddy/admin.sock');
		expect(config.caddyListen).toEqual([':443', ':80']);
		expect(config.agentSocket).toBe('/run/yoal-agent/agent.sock');
		expect(config.cookieName).toBe('__yoal_s');
		expect(config.accessCacheMs).toBe(15_000);
		expect(config.caddyAccessLog).toBeNull();
		expect(config.insecureHttp).toBe(false);
		expect(config.tls).toBe(false);
		expect(config.acmeEmail).toBeNull();
		expect(config.acmeCa).toBeNull();
		expect(config.cloudflareApiToken).toBeNull();
		expect(config.contentDomain).toBeNull();
		expect(config.helperSocket).toBe('/run/yoal-helper/helper.sock');
		expect(config.workloadSliceMb).toBe(1024);
		expect(config.workloadSocketDir).toBe('/run/yoal-workloads');
		expect(config.workloadHealthTimeoutMs).toBe(30_000);
		expect(config.logDrain).toBe(true);
		expect(config.logDrainIntervalMs).toBe(2_000);
	});

	test('lets an operator change the Yoal Access decision cache lifetime', () => {
		const config = loadConfig({ ...base, YOAL_ACCESS_CACHE_MS: '3000' });
		expect(config.accessCacheMs).toBe(3_000);
		expect(() => loadConfig({ ...base, YOAL_ACCESS_CACHE_MS: 'soon' })).toThrow(
			/YOAL_ACCESS_CACHE_MS/,
		);
	});

	test('lets an operator disable or slow the log drain', () => {
		const config = loadConfig({
			...base,
			YOAL_LOG_DRAIN: '0',
			YOAL_LOG_DRAIN_INTERVAL_MS: '5000',
		});
		expect(config.logDrain).toBe(false);
		expect(config.logDrainIntervalMs).toBe(5_000);
	});

	test('parses comma-separated listeners and optional access logs', () => {
		const config = loadConfig({
			...base,
			YOAL_CADDY_LISTEN: ':8080, 127.0.0.1:8081',
			YOAL_CADDY_ACCESS_LOG: '/var/log/caddy/access.log',
			YOAL_SITE_COOKIE_COOKIE_NAME: '__host-yoal',
			YOAL_DATA_DIR: '/srv/yoal/',
		});
		expect(config.caddyListen).toEqual([':8080', '127.0.0.1:8081']);
		expect(config.caddyAccessLog).toBe('/var/log/caddy/access.log');
		expect(config.cookieName).toBe('__host-yoal');
		expect(config.dataDir).toBe('/srv/yoal');
	});

	test('requires the control URL, token and node id', () => {
		expect(() => loadConfig({ YOAL_DATA_DIR: '/nonexistent-yoal-agent-test' })).toThrow(ConfigError);
		expect(() =>
			loadConfig({ ...base, YOAL_DATA_DIR: '/nonexistent-yoal-agent-test', YOAL_NODE_TOKEN: '' }),
		).toThrow(/YOAL_NODE_TOKEN/);
	});

	test('rejects an invalid URL or listen address', () => {
		expect(() => loadConfig({ ...base, YOAL_CONTROL_URL: 'not a url' })).toThrow(/valid URL/);
		expect(() => loadConfig({ ...base, YOAL_CADDY_LISTEN: 'nonsense' })).toThrow(/Invalid Caddy listen/);
	});

	test('refuses insecure HTTP in production', () => {
		expect(() =>
			loadConfig({ ...base, NODE_ENV: 'production', YOAL_AGENT_INSECURE_HTTP: '1' }),
		).toThrow(/must not be enabled/);
		expect(loadConfig({ ...base, YOAL_AGENT_INSECURE_HTTP: '1' }).insecureHttp).toBe(true);
	});

	test('enables TLS from the ACME email by default', () => {
		const config = loadConfig({ ...base, YOAL_ACME_EMAIL: 'ops@example.com' });
		expect(config.tls).toBe(true);
		expect(config.acmeEmail).toBe('ops@example.com');
		expect(loadConfig({ ...base, YOAL_ACME_EMAIL: 'ops@example.com', YOAL_TLS: '0' }).tls).toBe(false);
		expect(() =>
			loadConfig({ ...base, NODE_ENV: 'production', YOAL_TLS: '1' }),
		).toThrow(/YOAL_ACME_EMAIL/);
	});

	test('passes through ACME CA, Cloudflare token and content domain', () => {
		const config = loadConfig({
			...base,
			YOAL_ACME_EMAIL: 'ops@example.com',
			YOAL_ACME_CA: 'https://acme-staging-v02.api.letsencrypt.org/directory',
			YOAL_CLOUDFLARE_API_TOKEN: 'cf-token',
			YOAL_CONTENT_DOMAIN: '.Example.COM.',
		});
		expect(config.acmeCa).toContain('acme-staging');
		expect(config.cloudflareApiToken).toBe('cf-token');
		expect(config.contentDomain).toBe('example.com');
	});

	test('falls back to node.json when credentials are absent', async () => {
		const dir = await tempDir();
		await fs.writeFile(
			join(dir, 'node.json'),
			JSON.stringify({
				controlUrl: 'https://cloud.example.com',
				nodeId: 'nod_file',
				token: 'node-token-from-file',
				mode: 'edge',
				joinedAt: '2026-11-03T00:00:00.000Z',
			}),
			{ mode: 0o600 },
		);
		const config = loadConfig({ YOAL_DATA_DIR: dir });
		expect(config.controlUrl).toBe('https://cloud.example.com');
		expect(config.nodeId).toBe('nod_file');
		expect(config.nodeToken).toBe('node-token-from-file');
	});

	test('environment values take precedence over node.json', async () => {
		const dir = await tempDir();
		await fs.writeFile(
			join(dir, 'node.json'),
			JSON.stringify({ controlUrl: 'https://file.example.com', nodeId: 'nod_file', token: 'file-token' }),
		);
		const config = loadConfig({
			YOAL_DATA_DIR: dir,
			YOAL_CONTROL_URL: 'https://env.example.com',
			YOAL_NODE_ID: 'nod_env',
			YOAL_NODE_TOKEN: 'env-token',
		});
		expect(config.controlUrl).toBe('https://env.example.com');
		expect(config.nodeId).toBe('nod_env');
		expect(config.nodeToken).toBe('env-token');
	});

	test('a malformed node.json is a clear config error', async () => {
		const dir = await tempDir();
		await fs.writeFile(join(dir, 'node.json'), '{not json');
		expect(() => loadConfig({ YOAL_DATA_DIR: dir })).toThrow(/not valid JSON/);
	});

	test('reads the workload helper settings and rejects invalid paths', () => {
		const config = loadConfig({
			...base,
			YOAL_HELPER_SOCKET: '/run/custom/helper.sock',
			YOAL_WORKLOAD_SLICE_MB: '512',
			YOAL_WORKLOAD_SOCKET_DIR: '/run/custom-workloads',
			YOAL_WORKLOAD_HEALTH_TIMEOUT_MS: '45000',
		});
		expect(config.helperSocket).toBe('/run/custom/helper.sock');
		expect(config.workloadSliceMb).toBe(512);
		expect(config.workloadSocketDir).toBe('/run/custom-workloads');
		expect(config.workloadHealthTimeoutMs).toBe(45_000);

		expect(() => loadConfig({ ...base, YOAL_HELPER_SOCKET: 'run/helper.sock' })).toThrow(/absolute/);
		expect(() => loadConfig({ ...base, YOAL_WORKLOAD_SLICE_MB: 'lots' })).toThrow(/integer/);
		expect(() => loadConfig({ ...base, YOAL_WORKLOAD_HEALTH_TIMEOUT_MS: '10' })).toThrow(/integer/);
	});
});
