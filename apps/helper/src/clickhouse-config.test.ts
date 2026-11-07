import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
	CLICKHOUSE_DATA_PATH,
	clickhouseMemory,
	renderClickHouseServerConfig,
	renderClickHouseUsers,
} from './clickhouse-config.ts';

const PASSWORD = 'p'.repeat(32);

describe('ClickHouse server config (docs/DATABASES.md §17)', () => {
	test('keeps every path under the /data mount and logs to stderr only', () => {
		const config = renderClickHouseServerConfig({ memoryMb: 2048 });
		expect(config).toContain(`<path>${CLICKHOUSE_DATA_PATH}</path>`);
		for (const tag of ['tmp_path', 'user_files_path', 'format_schema_path', 'user_scripts_path', 'user_defined_path'])
			expect(config).toMatch(new RegExp(`<${tag}>/data/clickhouse/[a-z_]+/</${tag}>`));
		expect(config).toContain('<path>/data/clickhouse/access/</path>');
		expect(config).not.toContain('/var/lib/clickhouse');
		expect(config).not.toContain('/var/log');
		expect(config).not.toMatch(/<log>|<errorlog>/);
		expect(config).toContain('<console>1</console>');
	});

	test('allows BACKUP/RESTORE only in the helper staging dir inside the data mount', () => {
		const config = renderClickHouseServerConfig({ memoryMb: 2048 });
		expect(config).toContain('<backups>\n\t\t<allowed_path>/data/skiff-dumps/</allowed_path>\n\t</backups>');
		expect(config).not.toContain('<allowed_disk>');
	});

	test('listens on the container network with HTTP and native ports, and users come from users.xml', () => {
		const config = renderClickHouseServerConfig({ memoryMb: 2048 });
		expect(config).toContain('<http_port>8123</http_port>');
		// The entrypoint's first-start CREATE DATABASE uses the native port.
		expect(config).toContain('<tcp_port>9000</tcp_port>');
		expect(config).toContain('<listen_host>0.0.0.0</listen_host>');
		expect(config).toContain('<users_xml>\n\t\t\t<path>users.xml</path>');
		expect(config).not.toMatch(/mysql_port|postgresql_port|interserver_http_port|grpc_port/);
	});

	test('sizes memory from the unit limit and keeps only a TTL-bound query_log', () => {
		const config = renderClickHouseServerConfig({ memoryMb: 2048 });
		expect(config).toContain(`<max_server_memory_usage>${1536 * 1024 * 1024}</max_server_memory_usage>`);
		expect(config).toContain(`<merges_mutations_memory_usage_soft_limit>${512 * 1024 * 1024}</merges_mutations_memory_usage_soft_limit>`);
		expect(config).toContain('<ttl>event_date + INTERVAL 7 DAY DELETE</ttl>');
		expect(config).toContain('<trace_log remove="1"/>');
		expect(config).toContain('<metric_log remove="1"/>');
		expect(config).not.toContain('<query_log remove="1"/>');
		expect(clickhouseMemory(256).markCache).toBe(32 * 1024 * 1024);
		expect(clickhouseMemory(4096).markCache).toBe(Math.floor(4096 * 1024 * 1024 * 0.05));
		expect(clickhouseMemory(16_384).markCache).toBe(512 * 1024 * 1024);
		expect(() => renderClickHouseServerConfig({ memoryMb: 100 })).toThrow();
	});

	test('the merge pool fits the free-entry thresholds, or tables refuse to load', () => {
		const config = renderClickHouseServerConfig({ memoryMb: 2048 });
		const pool = Number(/<background_pool_size>(\d+)</.exec(config)![1]);
		const ratio = Number(/<background_merges_mutations_concurrency_ratio>(\d+)</.exec(config)![1]);
		for (const match of config.matchAll(/<number_of_free_entries_in_pool_to_[a-z_]+>(\d+)</g))
			expect(Number(match[1])).toBeLessThan(pool * ratio);
	});
});

describe('ClickHouse users file', () => {
	test('the owner authenticates by SHA-256 and manages access; default is locked', () => {
		const users = renderClickHouseUsers({ user: 'events', password: PASSWORD });
		const hash = createHash('sha256').update(PASSWORD).digest('hex');
		expect(users).toContain(`<events>\n\t\t\t<password_sha256_hex>${hash}</password_sha256_hex>`);
		expect(users).not.toContain(PASSWORD);
		expect(users).toMatch(/<events>[\s\S]*<access_management>1<\/access_management>[\s\S]*<\/events>/);
		// The image entrypoint reads users.default; it exists but nobody can log in as it.
		expect(users).toMatch(/<default>\s*<password_sha256_hex>0{64}<\/password_sha256_hex>/);
		expect(users).toMatch(/<default>[\s\S]*<access_management>0<\/access_management>[\s\S]*<\/default>/);
	});

	test('does not depend on anything but the owner, so a rotation can re-render it', () => {
		const a = renderClickHouseUsers({ user: 'events', password: PASSWORD });
		expect(renderClickHouseUsers({ user: 'events', password: PASSWORD })).toBe(a);
		expect(renderClickHouseUsers({ user: 'events', password: 'q'.repeat(32) })).not.toBe(a);
	});

	test('refuses anything that could inject XML', () => {
		expect(() => renderClickHouseUsers({ user: 'a<b>', password: PASSWORD })).toThrow();
		expect(() => renderClickHouseUsers({ user: 'Events', password: PASSWORD })).toThrow();
		expect(() => renderClickHouseUsers({ user: 'events', password: 'short' })).toThrow();
		expect(() => renderClickHouseUsers({ user: 'events', password: `${'p'.repeat(20)}]]><x/>` })).toThrow();
	});
});
