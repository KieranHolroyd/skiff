import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	CLICKHOUSE_ENV,
	CLICKHOUSE_SHA512,
	CLICKHOUSE_SYSTEM_LOGS,
	CLICKHOUSE_UNIT,
	CLICKHOUSE_VERSION,
	clickhouseArch,
	clickhouseAssetUrl,
	clickhouseConfigXml,
	clickhouseMemory,
	clickhouseUnit,
	clickhouseUsersXml,
	ensureClickHouse,
	ensureClickHouseEnv,
	parseClickHouseMemoryMb,
	restartClickHouse,
	sha256Hex,
	type EnsureClickHouseOptions,
} from './clickhouse.ts';

const root = mkdtempSync(join(tmpdir(), 'yoal-clickhouse-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** `Key=value` lines of one section, comments and blanks dropped. */
function directives(unit: string, section: string): Map<string, string[]> {
	const out = new Map<string, string[]>();
	let current = '';
	for (const raw of unit.split('\n')) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) continue;
		const header = /^\[(.+)\]$/.exec(line);
		if (header) {
			current = header[1]!;
			continue;
		}
		if (current !== section) continue;
		const eq = line.indexOf('=');
		const key = line.slice(0, eq);
		out.set(key, [...(out.get(key) ?? []), line.slice(eq + 1)]);
	}
	return out;
}

/** The text of the first `<tag>…</tag>`. */
function tag(xml: string, name: string): string | undefined {
	return new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1];
}

describe('release pin', () => {
	test('asset URLs and hashes for both architectures', () => {
		expect(clickhouseAssetUrl('amd64')).toBe(
			'https://github.com/ClickHouse/ClickHouse/releases/download/v26.8.34.13-lts/clickhouse-common-static-26.8.34.13-amd64.tgz',
		);
		expect(clickhouseAssetUrl('arm64')).toContain('-arm64.tgz');
		for (const hash of Object.values(CLICKHOUSE_SHA512)) expect(hash).toMatch(/^[0-9a-f]{128}$/);
		expect(CLICKHOUSE_VERSION).toBe('26.8.34.13');
	});

	test('maps Node architectures', () => {
		expect(clickhouseArch('x64')).toBe('amd64');
		expect(clickhouseArch('arm64')).toBe('arm64');
		expect(clickhouseArch('ia32')).toBeNull();
	});
});

describe('config.xml', () => {
	const config = clickhouseConfigXml();

	test('HTTP on loopback only; no other protocol ports', () => {
		expect(tag(config, 'listen_host')).toBe('127.0.0.1');
		expect(tag(config, 'http_port')).toBe('18123');
		for (const port of ['tcp_port', 'tcp_port_secure', 'https_port', 'mysql_port', 'postgresql_port', 'interserver_http_port', 'grpc_port', 'prometheus'])
			expect(config).not.toContain(`<${port}>`);
		expect(config.match(/<listen_host>/g)).toHaveLength(1);
	});

	test('every path lives under the data dir', () => {
		const custom = clickhouseConfigXml({ dataDir: '/srv/ch' });
		for (const name of ['path', 'tmp_path', 'user_files_path', 'format_schema_path', 'user_scripts_path', 'user_defined_path'])
			expect(tag(custom, name)!.startsWith('/srv/ch/')).toBe(true);
		expect(tag(config, 'path')).toBe('/var/lib/yoal/clickhouse/');
	});

	test('small footprint: memory ceiling, small caches and pools', () => {
		expect(Number(tag(config, 'max_server_memory_usage'))).toBe(768 * 1024 * 1024);
		expect(Number(tag(config, 'mark_cache_size'))).toBeLessThanOrEqual(64 * 1024 * 1024);
		expect(tag(config, 'uncompressed_cache_size')).toBe('0');
		expect(tag(config, 'max_concurrent_queries')).toBe('20');
		expect(tag(config, 'background_pool_size')).toBe('2');
		// Tables refuse to load when these exceed background_pool_size x concurrency ratio.
		const slots = Number(tag(config, 'background_pool_size')) * Number(tag(config, 'background_merges_mutations_concurrency_ratio'));
		for (const name of [
			'number_of_free_entries_in_pool_to_lower_max_size_of_merge',
			'number_of_free_entries_in_pool_to_execute_mutation',
			'number_of_free_entries_in_pool_to_execute_optimize_entire_partition',
		])
			expect(Number(tag(config, name))).toBeLessThanOrEqual(slots);
	});

	test('system log tables are removed, logs go to the console at warning', () => {
		for (const name of ['query_log', 'part_log', 'trace_log', 'metric_log', 'text_log', 'asynchronous_metric_log', 'error_log', 'latency_log'])
			expect(CLICKHOUSE_SYSTEM_LOGS).toContain(name);
		for (const name of CLICKHOUSE_SYSTEM_LOGS) expect(config).toContain(`<${name} remove="1"/>`);
		expect(tag(config, 'console')).toBe('1');
		expect(tag(config, 'level')).toBe('warning');
		expect(config).not.toMatch(/<log>|<errorlog>/);
		expect(config).toMatch(/<send_crash_reports>\s*<enabled>false<\/enabled>/);
	});

	test('users.xml is the only user directory (no SQL-managed users)', () => {
		expect(config).toMatch(/<user_directories>\s*<users_xml>\s*<path>users\.xml<\/path>/);
		expect(config).not.toContain('<local_directory>');
	});
});

describe('users.xml', () => {
	const users = clickhouseUsersXml({ writerPassword: 'w-secret', readerPassword: 'r-secret' });

	test('stores SHA-256 hashes, never the passwords', () => {
		expect(users).toContain(`<password_sha256_hex>${sha256Hex('w-secret')}</password_sha256_hex>`);
		expect(users).toContain(`<password_sha256_hex>${sha256Hex('r-secret')}</password_sha256_hex>`);
		expect(users).not.toContain('w-secret');
		expect(users).not.toContain('r-secret');
		expect(sha256Hex('abc')).toBe(createHash('sha256').update('abc').digest('hex'));
	});

	test('no default user; both users loopback only without access management', () => {
		expect(users).not.toMatch(/<users>[\s\S]*<default>/);
		expect(users.match(/<ip>127\.0\.0\.1<\/ip>/g)).toHaveLength(2);
		expect(users.match(/<ip>::1<\/ip>/g)).toHaveLength(2);
		expect(users.match(/<access_management>0<\/access_management>/g)).toHaveLength(2);
	});

	test('writer owns the yoal database; reader may only SELECT it', () => {
		const writer = /<yoal>([\s\S]*?)<\/yoal>/.exec(users)![1]!;
		const reader = /<yoal_reader>([\s\S]*?)<\/yoal_reader>/.exec(users)![1]!;
		expect(writer).toContain('GRANT ALL ON yoal.*');
		expect(writer).not.toContain('ON *.*</query>\n\t\t\t\t<query>GRANT ALL');
		expect(writer).toContain('<profile>default</profile>');
		expect(reader).toContain('GRANT SELECT ON yoal.*');
		expect(reader.match(/GRANT/g)).toHaveLength(1);
		expect(reader).toContain('<profile>readonly</profile>');
	});

	test('reader profile: readonly=2, limits capped by constraints, FINAL by default', () => {
		const profile = /<readonly>\s*<profile>default<\/profile>([\s\S]*?)<\/readonly>\s*<\/profiles>/.exec(users)![1]!;
		expect(tag(profile, 'readonly')).toBe('2');
		expect(tag(profile, 'max_execution_time')).toBe('30');
		expect(tag(profile, 'max_memory_usage')).toBe('268435456');
		expect(tag(profile, 'max_result_rows')).toBe('100000');
		expect(tag(profile, 'result_overflow_mode')).toBe('break');
		expect(tag(profile, 'max_rows_to_read')).toBe('500000000');
		expect(tag(profile, 'max_threads')).toBe('2');
		expect(tag(profile, 'final')).toBe('1');
		expect(tag(profile, 'do_not_merge_across_partitions_select_final')).toBe('1');
		const constraints = /<constraints>([\s\S]*?)<\/constraints>/.exec(profile)![1]!;
		expect(constraints).toContain('<readonly><const/></readonly>');
		for (const name of ['max_execution_time', 'max_memory_usage', 'max_result_rows', 'max_rows_to_read', 'max_bytes_to_read', 'max_threads'])
			expect(constraints).toContain(`<${name}><max>${tag(profile, name)}</max></${name}>`);
		expect(constraints).not.toContain('result_overflow_mode');
		expect(constraints).not.toContain('read_overflow_mode');
	});

	test('rejects empty passwords and odd identifiers', () => {
		expect(() => clickhouseUsersXml({ writerPassword: '', readerPassword: 'x' })).toThrow();
		expect(() => clickhouseUsersXml({ writerPassword: 'x', readerPassword: 'y', database: 'a-b' })).toThrow();
		expect(() => clickhouseUsersXml({ writerPassword: 'x', readerPassword: 'y', readerUser: 'yoal' })).toThrow();
	});
});

describe('yoal-clickhouse unit', () => {
	const unit = clickhouseUnit();
	const service = directives(unit, 'Service');

	test('runs the versioned binary as its own user with config as credentials', () => {
		expect(service.get('ExecStart')).toEqual([`/opt/yoal/clickhouse/${CLICKHOUSE_VERSION}/clickhouse server --config-file=%d/config.xml`]);
		expect(service.get('User')).toEqual(['yoal-clickhouse']);
		expect(service.get('Group')).toEqual(['yoal-clickhouse']);
		expect(service.get('LoadCredential')).toEqual([
			'config.xml:/etc/yoal/clickhouse/config.xml',
			'users.xml:/etc/yoal/clickhouse/users.xml',
		]);
		expect(service.has('EnvironmentFile')).toBe(false);
		expect(service.get('Type')).toEqual(['simple']);
		expect(service.get('Restart')).toEqual(['always']);
	});

	test('limits and sandbox match the sibling units', () => {
		expect(service.get('MemoryMax')).toEqual(['1G']);
		expect(service.get('LimitNOFILE')).toEqual(['262144']);
		const litestream = directives(readFileSync(join(import.meta.dir, 'yoal-litestream.service'), 'utf8'), 'Service');
		for (const key of [
			'NoNewPrivileges',
			'PrivateTmp',
			'PrivateDevices',
			'ProtectSystem',
			'ProtectHome',
			'ProtectKernelTunables',
			'ProtectKernelModules',
			'ProtectControlGroups',
			'RestrictAddressFamilies',
			'RestrictNamespaces',
			'SystemCallFilter',
			'CapabilityBoundingSet',
			'AmbientCapabilities',
		])
			expect([key, service.get(key)]).toEqual([key, litestream.get(key)]);
		expect(service.get('ReadWritePaths')).toEqual(['/var/lib/yoal/clickhouse']);
	});

	test('alerts on failure only when asked', () => {
		expect(directives(unit, 'Unit').has('OnFailure')).toBe(false);
		expect(directives(clickhouseUnit({ alert: true }), 'Unit').get('OnFailure')).toEqual(['yoal-alert@%n.service']);
	});
});

describe('ensureClickHouseEnv', () => {
	test('appends only the missing keys and never overwrites', () => {
		const file = join(root, 'env-a');
		writeFileSync(file, '# keep me\nNODE_ENV=production\nYOAL_CLICKHOUSE_PASSWORD=existing');
		let n = 0;
		const { env, added } = ensureClickHouseEnv(file, { generate: () => `gen${++n}` });
		expect(env.password).toBe('existing');
		expect(env.readerPassword).toBe('gen1');
		expect(env.url).toBe('http://127.0.0.1:18123');
		expect(added).toEqual([
			CLICKHOUSE_ENV.url,
			CLICKHOUSE_ENV.database,
			CLICKHOUSE_ENV.user,
			CLICKHOUSE_ENV.readerUser,
			CLICKHOUSE_ENV.readerPassword,
		]);
		const text = readFileSync(file, 'utf8');
		expect(text.startsWith('# keep me\nNODE_ENV=production\nYOAL_CLICKHOUSE_PASSWORD=existing\n')).toBe(true);
		expect(text).toContain('YOAL_CLICKHOUSE_READER_PASSWORD=gen1\n');
		expect(ensureClickHouseEnv(file).added).toEqual([]);
		expect(readFileSync(file, 'utf8')).toBe(text);
	});

	test('generated passwords are 32 random bytes, url-safe', () => {
		const file = join(root, 'env-b');
		const { env } = ensureClickHouseEnv(file);
		expect(env.password).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(env.password).not.toBe(env.readerPassword);
		expect(statSync(file).mode & 0o777).toBe(0o640);
	});

	test('dry run writes nothing', () => {
		const file = join(root, 'env-c');
		expect(ensureClickHouseEnv(file, { dryRun: true }).added).toHaveLength(6);
		expect(existsSync(file)).toBe(false);
	});
});

/** A fake release archive: `<dir>/usr/bin/clickhouse` is a shell script. */
function fakeRelease(dir: string): { archive: Uint8Array; sha512: string } {
	const src = join(dir, 'src', 'clickhouse-common-static-x', 'usr', 'bin');
	mkdirSync(src, { recursive: true });
	writeFileSync(join(src, 'clickhouse'), '#!/bin/sh\necho "ClickHouse server version 26.8.34.13"\n', { mode: 0o755 });
	const out = join(dir, 'release.tgz');
	Bun.spawnSync({ cmd: ['tar', '-czf', out, '-C', join(dir, 'src'), '.'] });
	const archive = readFileSync(out);
	return { archive, sha512: createHash('sha512').update(archive).digest('hex') };
}

function harness(name: string, overrides: Partial<EnsureClickHouseOptions> = {}) {
	const dir = join(root, name);
	mkdirSync(join(dir, 'systemd'), { recursive: true });
	mkdirSync(join(dir, 'etc'), { recursive: true });
	const release = fakeRelease(dir);
	const calls: string[] = [];
	const downloads: string[] = [];
	const logs: string[] = [];
	let pingOk = true;
	let authOk = true;
	const options: EnsureClickHouseOptions = {
		installRoot: join(dir, 'opt'),
		configDir: join(dir, 'etc', 'clickhouse'),
		dataDir: join(dir, 'var', 'clickhouse'),
		envFile: join(dir, 'etc', 'yoal.env'),
		systemdDir: join(dir, 'systemd'),
		platform: 'linux',
		arch: 'arm64',
		asset: () => ({ url: 'https://example.test/ch.tgz', sha512: release.sha512 }),
		run: (cmd) => {
			calls.push(cmd.join(' '));
			// Only tar really runs; everything privileged is recorded.
			if (cmd[0] === 'tar' && Bun.spawnSync({ cmd }).exitCode !== 0) throw new Error('tar failed');
		},
		capture: (cmd) => {
			if (cmd[0] === 'id') return null;
			if (cmd[0] === 'df') return 'Filesystem 1024-blocks Used Available Capacity Mounted\n/dev/x 100 1 99999999 1% /';
			if (cmd[1] === 'server' && cmd[2] === '--version') return 'ClickHouse server version 26.8.34.13';
			return '';
		},
		log: (message) => logs.push(message),
		fetch: async (url) => {
			if (url.endsWith('/ping')) {
				if (!pingOk) throw new Error('connection refused');
				return new Response('Ok.\n');
			}
			// The readiness probe authenticates as the writer; downloads are the other callers.
			if (url.includes('query=SELECT')) {
				if (!pingOk) throw new Error('connection refused');
				return authOk ? new Response('1\n') : new Response('unauthorized', { status: 401 });
			}
			downloads.push(url);
			return new Response(release.archive);
		},
		sleep: async () => {},
		readyTimeoutMs: 20,
		...overrides,
	};
	return {
		dir,
		options,
		calls,
		downloads,
		logs,
		setPing: (ok: boolean) => (pingOk = ok),
		setAuth: (ok: boolean) => (authOk = ok),
	};
}

describe('ensureClickHouse', () => {
	test('first run installs, configures, starts and waits for /ping', async () => {
		const h = harness('first');
		const result = await ensureClickHouse(h.options);
		expect(result.warning).toBeUndefined();
		expect(result).toMatchObject({ ok: true, changed: true });
		const binary = join(h.dir, 'opt', CLICKHOUSE_VERSION, 'clickhouse');
		expect(result.binary).toBe(binary);
		expect(statSync(binary).mode & 0o777).toBe(0o755);
		expect(h.downloads).toEqual(['https://example.test/ch.tgz']);
		// The archive and staging directory are cleaned up.
		expect(Bun.spawnSync({ cmd: ['ls', '-A', join(h.dir, 'opt')] }).stdout.toString().trim()).toBe(CLICKHOUSE_VERSION);

		expect(result.envAdded).toHaveLength(6);
		const env = readFileSync(join(h.dir, 'etc', 'yoal.env'), 'utf8');
		const password = /YOAL_CLICKHOUSE_PASSWORD=(.+)/.exec(env)![1]!;
		const users = readFileSync(join(h.dir, 'etc', 'clickhouse', 'users.xml'), 'utf8');
		expect(users).toContain(sha256Hex(password));
		expect(statSync(join(h.dir, 'etc', 'clickhouse', 'users.xml')).mode & 0o777).toBe(0o640);
		expect(readFileSync(join(h.dir, 'etc', 'clickhouse', 'config.xml'), 'utf8')).toContain(`<path>${join(h.dir, 'var', 'clickhouse')}/</path>`);
		const unit = readFileSync(join(h.dir, 'systemd', CLICKHOUSE_UNIT), 'utf8');
		expect(unit).toContain(`ExecStart=${binary} server --config-file=%d/config.xml`);

		const privileged = h.calls.filter((call) => !call.startsWith('tar '));
		expect(privileged).toContain(
			'useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin yoal-clickhouse',
		);
		expect(privileged).toContain(`chown yoal-clickhouse:yoal-clickhouse ${join(h.dir, 'var', 'clickhouse')}`);
		expect(privileged).toContain(`chown root:yoal-clickhouse ${join(h.dir, 'etc', 'clickhouse', 'users.xml')}`);
		expect(privileged.slice(-3)).toEqual(['systemctl daemon-reload', `systemctl enable ${CLICKHOUSE_UNIT}`, `systemctl restart ${CLICKHOUSE_UNIT}`]);
	});

	test('retires the pre-rename unit before taking port 18123', async () => {
		const h = harness('legacy-unit');
		const legacy = join(h.dir, 'systemd', 'skiff-clickhouse.service');
		writeFileSync(legacy, '[Unit]\nDescription=old\n');
		const result = await ensureClickHouse(h.options);
		expect(result).toMatchObject({ ok: true, changed: true });
		expect(existsSync(legacy)).toBe(false);
		expect(h.calls).toContain('systemctl disable --now skiff-clickhouse.service');
		expect(h.logs.join('\n')).toContain('pre-rename skiff-clickhouse.service');
	});

	test('a server that answers /ping but rejects the credentials is not reported as installed', async () => {
		const h = harness('wrong-creds');
		h.setAuth(false);
		const result = await ensureClickHouse(h.options);
		expect(result.ok).toBe(false);
		expect(result.warning).toContain('rejected the yoal credentials');
		expect(result.warning).toContain('users.xml');
	});

	test('a re-run changes nothing: no download, no reload, start instead of restart', async () => {
		const h = harness('rerun');
		await ensureClickHouse(h.options);
		const before = readFileSync(join(h.dir, 'etc', 'clickhouse', 'users.xml'), 'utf8');
		h.calls.length = 0;
		const result = await ensureClickHouse(h.options);
		expect(result).toMatchObject({ ok: true, changed: false, envAdded: [] });
		expect(h.downloads).toHaveLength(1);
		expect(h.calls).not.toContain('systemctl daemon-reload');
		expect(h.calls.at(-1)).toBe(`systemctl start ${CLICKHOUSE_UNIT}`);
		expect(readFileSync(join(h.dir, 'etc', 'clickhouse', 'users.xml'), 'utf8')).toBe(before);
	});

	test('a changed password in yoal.env regenerates users.xml and restarts', async () => {
		const h = harness('rotate');
		await ensureClickHouse(h.options);
		const envFile = join(h.dir, 'etc', 'yoal.env');
		writeFileSync(envFile, readFileSync(envFile, 'utf8').replace(/YOAL_CLICKHOUSE_READER_PASSWORD=.*/, 'YOAL_CLICKHOUSE_READER_PASSWORD=rotated'));
		h.calls.length = 0;
		const result = await ensureClickHouse(h.options);
		expect(result.changed).toBe(true);
		expect(readFileSync(join(h.dir, 'etc', 'clickhouse', 'users.xml'), 'utf8')).toContain(sha256Hex('rotated'));
		expect(h.calls.at(-1)).toBe(`systemctl restart ${CLICKHOUSE_UNIT}`);
	});

	test('a download failure is a warning, not a throw, and the env vars are still written', async () => {
		const h = harness('offline', { fetch: async () => new Response('nope', { status: 503 }) });
		const result = await ensureClickHouse(h.options);
		expect(result.ok).toBe(false);
		expect(result.warning).toContain('HTTP 503');
		expect(result.envAdded).toHaveLength(6);
		expect(existsSync(join(h.dir, 'systemd', CLICKHOUSE_UNIT))).toBe(false);
		expect(h.calls.some((call) => call.startsWith('systemctl'))).toBe(false);
	});

	test('a hash mismatch refuses the archive', async () => {
		const h = harness('tampered', { asset: () => ({ url: 'https://example.test/ch.tgz', sha512: '0'.repeat(128) }) });
		const result = await ensureClickHouse(h.options);
		expect(result.warning).toContain('sha512 mismatch');
		expect(existsSync(join(h.dir, 'opt', CLICKHOUSE_VERSION))).toBe(false);
	});

	test('a failed upgrade download keeps the installed version running', async () => {
		const h = harness('keep-old');
		await ensureClickHouse(h.options);
		const result = await ensureClickHouse({
			...h.options,
			version: '26.8.99.1',
			fetch: async (url) => (url.includes('/ping') || url.includes('query=SELECT') ? new Response(url.includes('/ping') ? 'Ok.\n' : '1\n') : new Response('', { status: 404 })),
		});
		expect(result.ok).toBe(true);
		expect(result.binary).toBe(join(h.dir, 'opt', CLICKHOUSE_VERSION, 'clickhouse'));
	});

	test('an upgrade that does not come up reverts the unit; the old version is kept', async () => {
		const h = harness('bad-upgrade');
		await ensureClickHouse(h.options);
		const unitPath = join(h.dir, 'systemd', CLICKHOUSE_UNIT);
		const oldUnit = readFileSync(unitPath, 'utf8');
		h.setPing(false);
		const result = await ensureClickHouse({ ...h.options, version: '26.8.99.1' });
		expect(result.ok).toBe(false);
		expect(result.warning).toContain('previous unit');
		expect(readFileSync(unitPath, 'utf8')).toBe(oldUnit);
		expect(existsSync(join(h.dir, 'opt', CLICKHOUSE_VERSION, 'clickhouse'))).toBe(true);
	});

	test('a successful upgrade prunes older versions', async () => {
		const h = harness('upgrade');
		await ensureClickHouse(h.options);
		const result = await ensureClickHouse({ ...h.options, version: '26.8.99.1' });
		expect(result.ok).toBe(true);
		expect(existsSync(join(h.dir, 'opt', '26.8.99.1', 'clickhouse'))).toBe(true);
		expect(existsSync(join(h.dir, 'opt', CLICKHOUSE_VERSION))).toBe(false);
	});

	test('skips with a warning off Linux, on unknown CPUs and when a command throws', async () => {
		expect((await ensureClickHouse(harness('mac', { platform: 'darwin' }).options)).warning).toContain('Linux');
		expect((await ensureClickHouse(harness('riscv', { arch: 'riscv64' }).options)).warning).toContain('riscv64');
		const failing = harness('useradd', {
			run: (cmd) => {
				if (cmd[0] === 'useradd') throw new Error('useradd exited 9');
				if (cmd[0] === 'tar') Bun.spawnSync({ cmd });
			},
		});
		const result = await ensureClickHouse(failing.options);
		expect(result.ok).toBe(false);
		expect(result.warning).toContain('useradd exited 9');
	});

	test('dry run touches nothing', async () => {
		const h = harness('dry', { dryRun: true });
		const result = await ensureClickHouse(h.options);
		expect(result.ok).toBe(true);
		expect(existsSync(join(h.dir, 'etc', 'yoal.env'))).toBe(false);
		expect(h.calls).toEqual([]);
		expect(h.downloads).toEqual([]);
	});
});

describe('memory ceiling (YOAL_CLICKHOUSE_MEMORY_MB)', () => {
	const MIB = 1024 * 1024;

	test('the default budget renders exactly the historical limits', () => {
		expect(clickhouseMemory()).toEqual({ server: 768 * MIB, writerQuery: 512 * MIB, readerQuery: 256 * MIB, merges: 256 * MIB, unitMaxMiB: 1024 });
		expect(clickhouseConfigXml()).toBe(clickhouseConfigXml({ memory: clickhouseMemory(768) }));
		expect(directives(clickhouseUnit(), 'Service').get('MemoryMax')).toEqual(['1G']);
	});

	test('every limit scales with the ceiling', () => {
		const memory = clickhouseMemory(1536);
		const config = clickhouseConfigXml({ memory });
		expect(tag(config, 'max_server_memory_usage')).toBe(String(1536 * MIB));
		expect(tag(config, 'merges_mutations_memory_usage_soft_limit')).toBe(String(512 * MIB));
		const users = clickhouseUsersXml({ writerPassword: 'w', readerPassword: 'r', memory });
		expect(users).toContain(`<max_memory_usage>${1024 * MIB}</max_memory_usage>`);
		expect(users).toContain(`<max_memory_usage><max>${512 * MIB}</max></max_memory_usage>`);
		expect(directives(clickhouseUnit({ memory }), 'Service').get('MemoryMax')).toEqual(['2G']);
		expect(directives(clickhouseUnit({ memory: clickhouseMemory(1000) }), 'Service').get('MemoryMax')).toEqual(['1334M']);
	});

	test('parses the env value, falling back to the default with a warning', () => {
		expect(parseClickHouseMemoryMb(undefined)).toEqual({ mb: 768 });
		expect(parseClickHouseMemoryMb(' 1024 ')).toEqual({ mb: 1024 });
		for (const bad of ['128', '1e3', '1024MB', '-1', '999999'])
			expect(parseClickHouseMemoryMb(bad)).toMatchObject({ mb: 768, warning: expect.stringContaining('YOAL_CLICKHOUSE_MEMORY_MB') });
	});

	test('ensureClickHouse applies the env value and restarts only when it changes', async () => {
		const h = harness('memory');
		const envFile = h.options.envFile!;
		expect((await ensureClickHouse(h.options)).changed).toBe(true);
		writeFileSync(envFile, `${readFileSync(envFile, 'utf8')}YOAL_CLICKHOUSE_MEMORY_MB=1536\n`);
		h.calls.length = 0;
		expect(await ensureClickHouse(h.options)).toMatchObject({ ok: true, changed: true });
		expect(h.calls).toContain(`systemctl restart ${CLICKHOUSE_UNIT}`);
		expect(readFileSync(join(h.dir, 'etc', 'clickhouse', 'config.xml'), 'utf8')).toContain(`<max_server_memory_usage>${1536 * MIB}</max_server_memory_usage>`);
		expect(directives(readFileSync(join(h.dir, 'systemd', CLICKHOUSE_UNIT), 'utf8'), 'Service').get('MemoryMax')).toEqual(['2G']);
		h.calls.length = 0;
		expect((await ensureClickHouse(h.options)).changed).toBe(false);
		expect(h.calls).toContain(`systemctl start ${CLICKHOUSE_UNIT}`);
	});

	test('restartClickHouse clears a failed unit, restarts it and waits for an authenticated answer', async () => {
		const h = harness('restart');
		expect(await restartClickHouse(h.options)).toMatchObject({ ok: false, warning: expect.stringContaining('not installed') });
		await ensureClickHouse(h.options);
		h.calls.length = 0;
		expect(await restartClickHouse(h.options)).toEqual({ ok: true });
		expect(h.calls).toEqual([`systemctl reset-failed ${CLICKHOUSE_UNIT}`, `systemctl restart ${CLICKHOUSE_UNIT}`]);
		h.setPing(false);
		expect((await restartClickHouse(h.options)).warning).toContain('did not answer');
	});
});
