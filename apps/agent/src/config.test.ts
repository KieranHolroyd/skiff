import { afterEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, loadConfig } from './config.ts';

const directories: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(join(tmpdir(), 'skiff-agent-config-'));
	directories.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const base = {
	SKIFF_CONTROL_URL: 'https://cloud.example.com/',
	SKIFF_NODE_TOKEN: 'token',
	SKIFF_NODE_ID: 'nod_1',
};

describe('loadConfig', () => {
	test('applies production defaults and strips the control URL slash', () => {
		const config = loadConfig({ ...base });
		expect(config.controlUrl).toBe('https://cloud.example.com');
		expect(config.dataDir).toBe('/var/lib/skiff-agent');
		expect(config.agentVersion).toBe('0.1.0');
		expect(config.caddyAdminSocket).toBe('/var/lib/caddy/admin.sock');
		expect(config.caddyListen).toEqual([':443', ':80']);
		expect(config.agentSocket).toBe('/run/skiff-agent/agent.sock');
		expect(config.cookieName).toBe('__skiff_s');
		expect(config.caddyAccessLog).toBeNull();
		expect(config.insecureHttp).toBe(false);
		expect(config.tls).toBe(false);
		expect(config.acmeEmail).toBeNull();
		expect(config.acmeCa).toBeNull();
		expect(config.cloudflareApiToken).toBeNull();
		expect(config.contentDomain).toBeNull();
		expect(config.helperSocket).toBe('/run/skiff-helper/helper.sock');
		expect(config.workloadSliceMb).toBe(1024);
		expect(config.workloadSocketDir).toBe('/run/skiff-workloads');
		expect(config.workloadHealthTimeoutMs).toBe(30_000);
		expect(config.logDrain).toBe(true);
		expect(config.logDrainIntervalMs).toBe(2_000);
	});

	test('lets an operator disable or slow the log drain', () => {
		const config = loadConfig({
			...base,
			SKIFF_LOG_DRAIN: '0',
			SKIFF_LOG_DRAIN_INTERVAL_MS: '5000',
		});
		expect(config.logDrain).toBe(false);
		expect(config.logDrainIntervalMs).toBe(5_000);
	});

	test('parses comma-separated listeners and optional access logs', () => {
		const config = loadConfig({
			...base,
			SKIFF_CADDY_LISTEN: ':8080, 127.0.0.1:8081',
			SKIFF_CADDY_ACCESS_LOG: '/var/log/caddy/access.log',
			SKIFF_SITE_COOKIE_COOKIE_NAME: '__host-skiff',
			SKIFF_DATA_DIR: '/srv/skiff/',
		});
		expect(config.caddyListen).toEqual([':8080', '127.0.0.1:8081']);
		expect(config.caddyAccessLog).toBe('/var/log/caddy/access.log');
		expect(config.cookieName).toBe('__host-skiff');
		expect(config.dataDir).toBe('/srv/skiff');
	});

	test('requires the control URL, token and node id', () => {
		expect(() => loadConfig({ SKIFF_DATA_DIR: '/nonexistent-skiff-agent-test' })).toThrow(ConfigError);
		expect(() =>
			loadConfig({ ...base, SKIFF_DATA_DIR: '/nonexistent-skiff-agent-test', SKIFF_NODE_TOKEN: '' }),
		).toThrow(/SKIFF_NODE_TOKEN/);
	});

	test('rejects an invalid URL or listen address', () => {
		expect(() => loadConfig({ ...base, SKIFF_CONTROL_URL: 'not a url' })).toThrow(/valid URL/);
		expect(() => loadConfig({ ...base, SKIFF_CADDY_LISTEN: 'nonsense' })).toThrow(/Invalid Caddy listen/);
	});

	test('refuses insecure HTTP in production', () => {
		expect(() =>
			loadConfig({ ...base, NODE_ENV: 'production', SKIFF_AGENT_INSECURE_HTTP: '1' }),
		).toThrow(/must not be enabled/);
		expect(loadConfig({ ...base, SKIFF_AGENT_INSECURE_HTTP: '1' }).insecureHttp).toBe(true);
	});

	test('enables TLS from the ACME email by default', () => {
		const config = loadConfig({ ...base, SKIFF_ACME_EMAIL: 'ops@example.com' });
		expect(config.tls).toBe(true);
		expect(config.acmeEmail).toBe('ops@example.com');
		expect(loadConfig({ ...base, SKIFF_ACME_EMAIL: 'ops@example.com', SKIFF_TLS: '0' }).tls).toBe(false);
		expect(() =>
			loadConfig({ ...base, NODE_ENV: 'production', SKIFF_TLS: '1' }),
		).toThrow(/SKIFF_ACME_EMAIL/);
	});

	test('passes through ACME CA, Cloudflare token and content domain', () => {
		const config = loadConfig({
			...base,
			SKIFF_ACME_EMAIL: 'ops@example.com',
			SKIFF_ACME_CA: 'https://acme-staging-v02.api.letsencrypt.org/directory',
			SKIFF_CLOUDFLARE_API_TOKEN: 'cf-token',
			SKIFF_CONTENT_DOMAIN: '.Example.COM.',
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
		const config = loadConfig({ SKIFF_DATA_DIR: dir });
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
			SKIFF_DATA_DIR: dir,
			SKIFF_CONTROL_URL: 'https://env.example.com',
			SKIFF_NODE_ID: 'nod_env',
			SKIFF_NODE_TOKEN: 'env-token',
		});
		expect(config.controlUrl).toBe('https://env.example.com');
		expect(config.nodeId).toBe('nod_env');
		expect(config.nodeToken).toBe('env-token');
	});

	test('a malformed node.json is a clear config error', async () => {
		const dir = await tempDir();
		await fs.writeFile(join(dir, 'node.json'), '{not json');
		expect(() => loadConfig({ SKIFF_DATA_DIR: dir })).toThrow(/not valid JSON/);
	});

	test('reads the workload helper settings and rejects invalid paths', () => {
		const config = loadConfig({
			...base,
			SKIFF_HELPER_SOCKET: '/run/custom/helper.sock',
			SKIFF_WORKLOAD_SLICE_MB: '512',
			SKIFF_WORKLOAD_SOCKET_DIR: '/run/custom-workloads',
			SKIFF_WORKLOAD_HEALTH_TIMEOUT_MS: '45000',
		});
		expect(config.helperSocket).toBe('/run/custom/helper.sock');
		expect(config.workloadSliceMb).toBe(512);
		expect(config.workloadSocketDir).toBe('/run/custom-workloads');
		expect(config.workloadHealthTimeoutMs).toBe(45_000);

		expect(() => loadConfig({ ...base, SKIFF_HELPER_SOCKET: 'run/helper.sock' })).toThrow(/absolute/);
		expect(() => loadConfig({ ...base, SKIFF_WORKLOAD_SLICE_MB: 'lots' })).toThrow(/integer/);
		expect(() => loadConfig({ ...base, SKIFF_WORKLOAD_HEALTH_TIMEOUT_MS: '10' })).toThrow(/integer/);
	});
});
