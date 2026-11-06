/**
 * `skiff-clickhouse.service`: the control plane's hot telemetry store (traffic, database and
 * storage usage). A small ClickHouse server, HTTP on loopback only, sized for a ~4 GB VPS that
 * also runs Caddy, the agent and workloads.
 *
 *   binary  /opt/skiff/clickhouse/<version>/clickhouse  (official static build, sha512-pinned)
 *   config  /etc/skiff/clickhouse/{config,users}.xml   (generated; overwritten on every run)
 *   data    /var/lib/skiff/clickhouse                   (skiff-clickhouse:skiff-clickhouse 0750)
 *   HTTP    127.0.0.1:18123                             (no native TCP: 9000 is object storage's)
 *
 * Telemetry is optional: the control plane reports it unavailable when ClickHouse is down. So
 * `ensureClickHouse` never throws. A failed download, a missing tool or a server that does not
 * come up is returned as a warning, and an install or update carries on without it.
 *
 * /etc/skiff is 0750 root:skiff and the server runs as its own user, so systemd (root) hands it
 * the two config files as credentials (`LoadCredential=`); the process never reads /etc/skiff.
 *
 * Shared by the installer, `skiff-update-self` and the local dev runner (scripts/dev/clickhouse.ts).
 */
import { createHash, randomBytes } from 'node:crypto';
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { formatEnvLine, readEnvFile } from '../install/env-file.ts';

export const CLICKHOUSE_VERSION = '26.8.34.13';
export const CLICKHOUSE_TAG = `v${CLICKHOUSE_VERSION}-lts`;
export const CLICKHOUSE_SHA512: Record<ClickHouseArch, string> = {
	amd64: 'e5c753b258679daa882747aaec10b351a85bcad1412af7957d4a4616dcf5b45663da219bd37fe0697fde2ae76dbed2ba5b414ce9a5c8044c6d1fa0142e03e4cc',
	arm64: '0c44b5da1aa6f4ab2fc634ce34c91198db7d975696cbb072b543a7a5b81253140404f2adaeaaff3746c05ffa23e45d67d6ed3b8790a4a4bf4ff567cbf56c8447',
};

export const CLICKHOUSE_UNIT = 'skiff-clickhouse.service';
export const CLICKHOUSE_SYSTEM_USER = 'skiff-clickhouse';
export const CLICKHOUSE_HTTP_PORT = 18123;
export const CLICKHOUSE_DATABASE = 'skiff';
export const CLICKHOUSE_WRITER = 'skiff';
export const CLICKHOUSE_READER = 'skiff_reader';

export const CLICKHOUSE_PATHS = {
	installRoot: '/opt/skiff/clickhouse',
	configDir: '/etc/skiff/clickhouse',
	dataDir: '/var/lib/skiff/clickhouse',
	envFile: '/etc/skiff/skiff.env',
	systemdDir: '/etc/systemd/system',
};

/** What the control plane reads from skiff.env. Passwords are generated when missing. */
export const CLICKHOUSE_ENV = {
	url: 'SKIFF_CLICKHOUSE_URL',
	database: 'SKIFF_CLICKHOUSE_DATABASE',
	user: 'SKIFF_CLICKHOUSE_USER',
	password: 'SKIFF_CLICKHOUSE_PASSWORD',
	readerUser: 'SKIFF_CLICKHOUSE_READER_USER',
	readerPassword: 'SKIFF_CLICKHOUSE_READER_PASSWORD',
} as const;

/** Memory budget (bytes). The unit's MemoryMax is 1G; the server stops itself well short of it. */
export const CLICKHOUSE_MEMORY = {
	server: 768 * 1024 * 1024,
	writerQuery: 512 * 1024 * 1024,
	readerQuery: 256 * 1024 * 1024,
	merges: 256 * 1024 * 1024,
};

/** The reader's limits. Profile constraints make every one of them un-raisable per query. */
export const CLICKHOUSE_READER_LIMITS = {
	max_execution_time: 30,
	max_memory_usage: CLICKHOUSE_MEMORY.readerQuery,
	max_result_rows: 100_000,
	max_rows_to_read: 500_000_000,
	max_bytes_to_read: 20 * 1024 * 1024 * 1024,
	max_threads: 2,
};

export type ClickHouseArch = 'amd64' | 'arm64';

export function clickhouseArch(nodeArch: string = process.arch): ClickHouseArch | null {
	if (nodeArch === 'x64' || nodeArch === 'amd64') return 'amd64';
	if (nodeArch === 'arm64' || nodeArch === 'aarch64') return 'arm64';
	return null;
}

export function clickhouseAssetUrl(arch: ClickHouseArch, version = CLICKHOUSE_VERSION, tag = `v${version}-lts`): string {
	return `https://github.com/ClickHouse/ClickHouse/releases/download/${tag}/clickhouse-common-static-${version}-${arch}.tgz`;
}

export function sha256Hex(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

function xml(value: string | number): string {
	return String(value).replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

function withSlash(path: string): string {
	return path.endsWith('/') ? path : `${path}/`;
}

/** Disabled outright: on a small install they dominate disk and RAM, and nothing reads them. */
export const CLICKHOUSE_SYSTEM_LOGS = [
	'query_log',
	'query_thread_log',
	'query_views_log',
	'query_metric_log',
	'part_log',
	'trace_log',
	'metric_log',
	'transposed_metric_log',
	'asynchronous_metric_log',
	'text_log',
	'session_log',
	'opentelemetry_span_log',
	'processors_profile_log',
	'asynchronous_insert_log',
	'backup_log',
	'blob_storage_log',
	'background_schedule_pool_log',
	'latency_log',
	'error_log',
	's3queue_log',
	'azure_queue_log',
	'crash_log',
	'zookeeper_log',
	'zookeeper_connection_log',
	'aggregated_zookeeper_log',
	'filesystem_cache_log',
	'filesystem_read_prefetches_log',
	'iceberg_metadata_log',
	'delta_lake_metadata_log',
	'dead_letter_queue',
	'object_storage_queue_log',
];

export interface ClickHouseConfigOptions {
	/** The server's `<path>`; everything it writes lives under it. */
	dataDir?: string;
	listenHost?: string;
	httpPort?: number;
	/** users.xml, relative to the config file's directory. */
	usersFile?: string;
	maxServerMemoryBytes?: number;
	logLevel?: 'fatal' | 'critical' | 'error' | 'warning' | 'notice' | 'information' | 'debug' | 'trace';
}

/**
 * A complete standalone config.xml (no packaged default underneath). HTTP on loopback only: no
 * native TCP, MySQL, PostgreSQL, interserver or gRPC ports. Setting names checked against 26.8.
 */
export function clickhouseConfigXml(options: ClickHouseConfigOptions = {}): string {
	const data = withSlash(options.dataDir ?? CLICKHOUSE_PATHS.dataDir);
	const level = options.logLevel ?? 'warning';
	const memory = options.maxServerMemoryBytes ?? CLICKHOUSE_MEMORY.server;
	const logs = CLICKHOUSE_SYSTEM_LOGS.map((name) => `\t<${name} remove="1"/>`).join('\n');
	return `<?xml version="1.0"?>
<!-- Generated by Skiff (scripts/systemd/clickhouse.ts). Overwritten on every install and update. -->
<clickhouse>
	<logger>
		<!-- stderr only: journald keeps it. No log files under the data dir. -->
		<level>${level}</level>
		<console>1</console>
		<console_log_level>${level}</console_log_level>
	</logger>

	<listen_host>${xml(options.listenHost ?? '127.0.0.1')}</listen_host>
	<http_port>${options.httpPort ?? CLICKHOUSE_HTTP_PORT}</http_port>
	<listen_try>0</listen_try>
	<listen_reuse_port>0</listen_reuse_port>
	<max_connections>256</max_connections>
	<keep_alive_timeout>30</keep_alive_timeout>

	<path>${xml(data)}</path>
	<tmp_path>${xml(`${data}tmp/`)}</tmp_path>
	<user_files_path>${xml(`${data}user_files/`)}</user_files_path>
	<format_schema_path>${xml(`${data}format_schemas/`)}</format_schema_path>
	<user_scripts_path>${xml(`${data}user_scripts/`)}</user_scripts_path>
	<user_defined_path>${xml(`${data}user_defined/`)}</user_defined_path>
	<custom_cached_disks_base_directory>${xml(`${data}caches/`)}</custom_cached_disks_base_directory>

	<user_directories>
		<users_xml>
			<path>${xml(options.usersFile ?? 'users.xml')}</path>
		</users_xml>
	</user_directories>
	<default_profile>default</default_profile>
	<default_database>default</default_database>
	<timezone>UTC</timezone>
	<display_name>skiff</display_name>

	<!-- Memory: a hard server-wide ceiling under the unit's MemoryMax=1G, and small caches. -->
	<max_server_memory_usage>${memory}</max_server_memory_usage>
	<merges_mutations_memory_usage_soft_limit>${CLICKHOUSE_MEMORY.merges}</merges_mutations_memory_usage_soft_limit>
	<mark_cache_size>67108864</mark_cache_size>
	<uncompressed_cache_size>0</uncompressed_cache_size>
	<index_mark_cache_size>16777216</index_mark_cache_size>
	<index_uncompressed_cache_size>0</index_uncompressed_cache_size>
	<primary_index_cache_size>33554432</primary_index_cache_size>
	<query_condition_cache_size>16777216</query_condition_cache_size>
	<mmap_cache_size>256</mmap_cache_size>
	<compiled_expression_cache_size>16777216</compiled_expression_cache_size>
	<compiled_expression_cache_elements_size>1000</compiled_expression_cache_elements_size>
	<mlock_executable>false</mlock_executable>
	<remap_executable>false</remap_executable>

	<!-- Threads: telemetry is a handful of tables written once a minute. -->
	<max_concurrent_queries>20</max_concurrent_queries>
	<max_thread_pool_size>500</max_thread_pool_size>
	<max_thread_pool_free_size>32</max_thread_pool_free_size>
	<background_pool_size>2</background_pool_size>
	<background_merges_mutations_concurrency_ratio>2</background_merges_mutations_concurrency_ratio>
	<!-- Schedule pools stay at 2 or more: each task type may use 80% of a pool, and 80% of 1 is 0. -->
	<background_schedule_pool_size>8</background_schedule_pool_size>
	<background_schedule_pool_initial_size>2</background_schedule_pool_initial_size>
	<background_common_pool_size>2</background_common_pool_size>
	<background_move_pool_size>1</background_move_pool_size>
	<background_fetches_pool_size>1</background_fetches_pool_size>
	<background_buffer_flush_schedule_pool_size>2</background_buffer_flush_schedule_pool_size>
	<background_message_broker_schedule_pool_size>2</background_message_broker_schedule_pool_size>
	<background_distributed_schedule_pool_size>2</background_distributed_schedule_pool_size>
	<!-- background_streaming_schedule_pool_size stays at its default: each MergeTree table parks a
	     task there, and a small pool pauses them in a warning loop. Idle threads cost almost nothing. -->
	<max_io_thread_pool_size>8</max_io_thread_pool_size>
	<max_active_parts_loading_thread_pool_size>2</max_active_parts_loading_thread_pool_size>
	<max_outdated_parts_loading_thread_pool_size>2</max_outdated_parts_loading_thread_pool_size>
	<max_parts_cleaning_thread_pool_size>2</max_parts_cleaning_thread_pool_size>
	<max_backups_io_thread_pool_size>4</max_backups_io_thread_pool_size>
	<async_insert_threads>2</async_insert_threads>
	<asynchronous_metrics_update_period_s>30</asynchronous_metrics_update_period_s>

	<merge_tree>
		<!-- Must fit background_pool_size x concurrency_ratio (4 slots) or tables refuse to load. -->
		<number_of_free_entries_in_pool_to_lower_max_size_of_merge>2</number_of_free_entries_in_pool_to_lower_max_size_of_merge>
		<number_of_free_entries_in_pool_to_execute_mutation>2</number_of_free_entries_in_pool_to_execute_mutation>
		<number_of_free_entries_in_pool_to_execute_optimize_entire_partition>2</number_of_free_entries_in_pool_to_execute_optimize_entire_partition>
		<merge_max_block_size>1024</merge_max_block_size>
		<max_bytes_to_merge_at_max_space_in_pool>1073741824</max_bytes_to_merge_at_max_space_in_pool>
	</merge_tree>

	<!-- The control plane prunes by TTL and drops partitions itself; no size guard needed. -->
	<max_table_size_to_drop>0</max_table_size_to_drop>
	<max_partition_size_to_drop>0</max_partition_size_to_drop>

	<send_crash_reports>
		<enabled>false</enabled>
	</send_crash_reports>

	<!-- System log tables: off. -->
${logs}
</clickhouse>
`;
}

export interface ClickHouseUsersOptions {
	database?: string;
	writerUser?: string;
	writerPassword: string;
	readerUser?: string;
	readerPassword: string;
	/**
	 * Extra database patterns the writer owns, e.g. `skiff_test*` (wildcard grant). Dev only: the
	 * telemetry tests give every store its own throwaway database. Never set on a host.
	 */
	extraWriterDatabases?: string[];
}

/** System tables the writer may read (storage size, merge backlog, server health). */
export const CLICKHOUSE_WRITER_SYSTEM_TABLES = ['parts', 'disks', 'merges', 'mutations', 'metrics', 'asynchronous_metrics'];

/** A settings-profile constraint that caps a setting at `max`. */
function capped(name: string, max: number): string {
	return `\t\t\t\t<${name}><max>${max}</max></${name}>`;
}

/**
 * users.xml: the writer (everything on the telemetry database, nothing else) and the reader
 * (SELECT on it, `readonly=2` so per-query output settings work, every resource limit capped by
 * a constraint). No `default` user. Loopback only; passwords as SHA-256.
 */
export function clickhouseUsersXml(options: ClickHouseUsersOptions): string {
	const database = options.database ?? CLICKHOUSE_DATABASE;
	const writer = options.writerUser ?? CLICKHOUSE_WRITER;
	const reader = options.readerUser ?? CLICKHOUSE_READER;
	if (!options.writerPassword || !options.readerPassword) throw new Error('ClickHouse passwords must not be empty');
	if (writer === reader) throw new Error('the ClickHouse writer and reader must be different users');
	for (const name of [database, writer, reader])
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`invalid ClickHouse identifier: ${name}`);
	const extra = options.extraWriterDatabases ?? [];
	for (const pattern of extra)
		if (!/^[A-Za-z_][A-Za-z0-9_]*\*?$/.test(pattern)) throw new Error(`invalid ClickHouse database pattern: ${pattern}`);
	const limits = CLICKHOUSE_READER_LIMITS;
	const networks = `\t\t\t<networks>
\t\t\t\t<ip>127.0.0.1</ip>
\t\t\t\t<ip>::1</ip>
\t\t\t</networks>`;
	return `<?xml version="1.0"?>
<!-- Generated by Skiff (scripts/systemd/clickhouse.ts) from /etc/skiff/skiff.env. Overwritten on every run. -->
<clickhouse>
	<profiles>
		<!-- Server-internal work and the writer. -->
		<default>
			<max_threads>2</max_threads>
			<max_insert_threads>1</max_insert_threads>
			<max_download_threads>1</max_download_threads>
			<max_parsing_threads>1</max_parsing_threads>
			<max_final_threads>2</max_final_threads>
			<max_memory_usage>${CLICKHOUSE_MEMORY.writerQuery}</max_memory_usage>
			<input_format_parallel_parsing>0</input_format_parallel_parsing>
			<output_format_parallel_formatting>0</output_format_parallel_formatting>
			<log_queries>0</log_queries>
			<log_profile_events>0</log_profile_events>
			<log_query_views>0</log_query_views>
			<query_profiler_real_time_period_ns>0</query_profiler_real_time_period_ns>
			<query_profiler_cpu_time_period_ns>0</query_profiler_cpu_time_period_ns>
		</default>
		<!-- Ad-hoc SQL from the dashboard. readonly=2: no writes or DDL, but output settings work. -->
		<readonly>
			<profile>default</profile>
			<readonly>2</readonly>
			<max_execution_time>${limits.max_execution_time}</max_execution_time>
			<max_memory_usage>${limits.max_memory_usage}</max_memory_usage>
			<max_result_rows>${limits.max_result_rows}</max_result_rows>
			<result_overflow_mode>break</result_overflow_mode>
			<max_rows_to_read>${limits.max_rows_to_read}</max_rows_to_read>
			<max_bytes_to_read>${limits.max_bytes_to_read}</max_bytes_to_read>
			<max_threads>${limits.max_threads}</max_threads>
			<!-- The tables are ReplacingMergeTree: dedupe every read without users writing FINAL. -->
			<final>1</final>
			<do_not_merge_across_partitions_select_final>1</do_not_merge_across_partitions_select_final>
			<constraints>
				<readonly><const/></readonly>
${Object.entries(limits)
	.map(([name, max]) => capped(name, max))
	.join('\n')}
			</constraints>
		</readonly>
	</profiles>

	<quotas>
		<default>
			<interval>
				<duration>3600</duration>
				<queries>0</queries>
				<errors>0</errors>
				<result_rows>0</result_rows>
				<read_rows>0</read_rows>
				<execution_time>0</execution_time>
			</interval>
		</default>
	</quotas>

	<users>
		<${writer}>
			<password_sha256_hex>${sha256Hex(options.writerPassword)}</password_sha256_hex>
${networks}
			<profile>default</profile>
			<quota>default</quota>
			<access_management>0</access_management>
			<grants>
				<query>GRANT ALL ON ${database}.*</query>
${extra.map((pattern) => `\t\t\t\t<query>GRANT ALL ON ${pattern}.*</query>\n`).join('')}				<query>GRANT CREATE TEMPORARY TABLE ON *.*</query>
${CLICKHOUSE_WRITER_SYSTEM_TABLES.map((table) => `\t\t\t\t<query>GRANT SELECT ON system.${table}</query>\n`).join('')}			</grants>
		</${writer}>
		<${reader}>
			<password_sha256_hex>${sha256Hex(options.readerPassword)}</password_sha256_hex>
${networks}
			<profile>readonly</profile>
			<quota>default</quota>
			<access_management>0</access_management>
			<grants>
				<query>GRANT SELECT ON ${database}.*</query>
			</grants>
		</${reader}>
	</users>
</clickhouse>
`;
}

export interface ClickHouseUnitOptions {
	binary?: string;
	configDir?: string;
	dataDir?: string;
	user?: string;
	/** Add `OnFailure=skiff-alert@%n.service` (only when that template is installed). */
	alert?: boolean;
}

export function clickhouseBinaryPath(installRoot = CLICKHOUSE_PATHS.installRoot, version = CLICKHOUSE_VERSION): string {
	return join(installRoot, version, 'clickhouse');
}

export function clickhouseUnit(options: ClickHouseUnitOptions = {}): string {
	const binary = options.binary ?? clickhouseBinaryPath();
	const configDir = options.configDir ?? CLICKHOUSE_PATHS.configDir;
	const dataDir = options.dataDir ?? CLICKHOUSE_PATHS.dataDir;
	const user = options.user ?? CLICKHOUSE_SYSTEM_USER;
	return `[Unit]
Description=Skiff telemetry store (ClickHouse, HTTP on 127.0.0.1:${CLICKHOUSE_HTTP_PORT})
Documentation=https://github.com/KieranHolroyd/skiff/blob/main/docs/OPS.md
After=network.target
StartLimitIntervalSec=120
StartLimitBurst=5
${options.alert ? '# Once restarts are exhausted the unit fails; alert (telemetry is optional, the platform keeps serving).\nOnFailure=skiff-alert@%n.service\n' : ''}
[Service]
Type=simple
User=${user}
Group=${user}
UMask=0027
# /etc/skiff is root:skiff 0750, so systemd hands the server its config as credentials.
LoadCredential=config.xml:${configDir}/config.xml
LoadCredential=users.xml:${configDir}/users.xml
# systemd supervises the server directly; no forked watchdog process.
Environment=CLICKHOUSE_WATCHDOG_ENABLE=0
ExecStart=${binary} server --config-file=%d/config.xml

Restart=always
RestartSec=5
TimeoutStopSec=60
KillSignal=SIGTERM
LimitNOFILE=262144
TasksMax=1024
# max_server_memory_usage is 768 MiB; this is the hard backstop.
MemoryMax=1G
# Telemetry yields to workloads, Caddy and the control plane under contention.
CPUWeight=50
IOWeight=50

NoNewPrivileges=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
ProtectHome=yes
ProtectClock=yes
ProtectHostname=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectProc=invisible
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallErrorNumber=EPERM
CapabilityBoundingSet=
AmbientCapabilities=

ReadWritePaths=${dataDir}

[Install]
WantedBy=multi-user.target
`;
}

export interface ClickHouseEnv {
	url: string;
	database: string;
	user: string;
	password: string;
	readerUser: string;
	readerPassword: string;
}

export function clickhousePassword(): string {
	return randomBytes(32).toString('base64url');
}

/**
 * Append whichever SKIFF_CLICKHOUSE_* keys are missing (never overwriting a value, never
 * rewriting the rest of the file) and return the effective values plus the keys it added.
 */
export function ensureClickHouseEnv(
	envFile: string,
	options: { dryRun?: boolean; generate?: () => string; port?: number } = {},
): { env: ClickHouseEnv; added: string[] } {
	const existing = readEnvFile(envFile);
	const generate = options.generate ?? clickhousePassword;
	const defaults: Record<keyof ClickHouseEnv, () => string> = {
		url: () => `http://127.0.0.1:${options.port ?? CLICKHOUSE_HTTP_PORT}`,
		database: () => CLICKHOUSE_DATABASE,
		user: () => CLICKHOUSE_WRITER,
		password: generate,
		readerUser: () => CLICKHOUSE_READER,
		readerPassword: generate,
	};
	const env = {} as ClickHouseEnv;
	const added: string[] = [];
	const lines: string[] = [];
	for (const [field, key] of Object.entries(CLICKHOUSE_ENV) as [keyof ClickHouseEnv, string][]) {
		const current = existing.get(key);
		if (current) {
			env[field] = current;
			continue;
		}
		env[field] = defaults[field]();
		added.push(key);
		lines.push(formatEnvLine(key, env[field]));
	}
	if (lines.length && !options.dryRun) {
		const text = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
		const prefix = text && !text.endsWith('\n') ? '\n' : '';
		appendFileSync(envFile, `${prefix}${lines.join('\n')}\n`, { mode: 0o640 });
	}
	return { env, added };
}

export interface EnsureClickHouseOptions {
	installRoot?: string;
	configDir?: string;
	dataDir?: string;
	envFile?: string;
	systemdDir?: string;
	systemUser?: string;
	version?: string;
	/** Asset URL and sha512 for the host arch; defaults to the pinned GitHub release. */
	asset?: (arch: ClickHouseArch) => { url: string; sha512: string };
	arch?: string;
	platform?: string;
	/** Runs a command; must throw on a non-zero exit. */
	run: (cmd: string[]) => void;
	/** Runs a command and returns stdout, or null on a non-zero exit. */
	capture: (cmd: string[]) => string | null;
	log?: (message: string) => void;
	fetch?: (url: string, init?: RequestInit) => Promise<Response>;
	sleep?: (ms: number) => Promise<void>;
	readyTimeoutMs?: number;
	/** Minimum free bytes under installRoot before a download (archive + extracted binary). */
	minFreeBytes?: number;
	dryRun?: boolean;
}

export interface EnsureClickHouseResult {
	/** The server answered /ping (or would, on a dry run). */
	ok: boolean;
	/** Anything was installed, rewritten or restarted. */
	changed: boolean;
	binary: string | null;
	envAdded: string[];
	warning?: string;
}

/** Free bytes on the filesystem holding `path` (`df -Pk`), or null when unknown. */
function freeBytes(path: string, capture: EnsureClickHouseOptions['capture']): number | null {
	const out = capture(['df', '-Pk', path]);
	const kb = Number(out?.split('\n')[1]?.trim().split(/\s+/)[3]);
	return Number.isFinite(kb) && kb > 0 ? kb * 1024 : null;
}

async function sha512File(path: string): Promise<string> {
	const hash = createHash('sha512');
	const stream = Bun.file(path).stream();
	for await (const chunk of stream) hash.update(chunk);
	return hash.digest('hex');
}

/** Stream a download to disk, hashing as it goes. Returns the sha512. */
async function download(body: ReadableStream<Uint8Array>, path: string): Promise<string> {
	const hash = createHash('sha512');
	const writer = Bun.file(path).writer();
	try {
		for await (const chunk of body) {
			hash.update(chunk);
			writer.write(chunk);
		}
	} finally {
		await writer.end();
	}
	return hash.digest('hex');
}

function findFile(root: string, suffix: string): string | null {
	for (const entry of readdirSync(root, { withFileTypes: true, recursive: true })) {
		const full = join(entry.parentPath, entry.name);
		if (entry.isFile() && full.endsWith(suffix)) return full;
	}
	return null;
}

function writeIfChanged(path: string, body: string, mode: number): boolean {
	if (existsSync(path) && readFileSync(path, 'utf8') === body) return false;
	writeFileSync(`${path}.tmp`, body, { mode });
	chmodSync(`${path}.tmp`, mode);
	renameSync(`${path}.tmp`, path);
	return true;
}

/** Installed version directories, newest first (by numeric version). */
function installedVersions(installRoot: string): string[] {
	if (!existsSync(installRoot)) return [];
	const parse = (v: string) => v.split('.').map(Number);
	return readdirSync(installRoot)
		.filter((name) => /^\d+(\.\d+)+$/.test(name) && existsSync(join(installRoot, name, '.verified')))
		.sort((a, b) => {
			const [x, y] = [parse(a), parse(b)];
			for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
			return 0;
		});
}

/**
 * Download, verify and install the pinned binary unless it is already there. Returns the binary
 * path, or throws with a readable reason (the caller turns that into a warning).
 */
async function installBinary(options: EnsureClickHouseOptions, arch: ClickHouseArch, log: (m: string) => void): Promise<{ binary: string; changed: boolean }> {
	const installRoot = options.installRoot ?? CLICKHOUSE_PATHS.installRoot;
	const version = options.version ?? CLICKHOUSE_VERSION;
	const { url, sha512 } = options.asset?.(arch) ?? { url: clickhouseAssetUrl(arch, version), sha512: CLICKHOUSE_SHA512[arch] };
	const dir = join(installRoot, version);
	const binary = join(dir, 'clickhouse');
	const marker = join(dir, '.verified');
	if (existsSync(binary) && existsSync(marker) && readFileSync(marker, 'utf8').trim() === sha512) return { binary, changed: false };

	mkdirSync(installRoot, { recursive: true, mode: 0o755 });
	const archive = join(installRoot, `.clickhouse-${version}-${arch}.tgz`);
	// A verified archive left by an interrupted run is reused instead of fetched again.
	let cached = existsSync(archive) && (await sha512File(archive)) === sha512;
	if (!cached) {
		const need = options.minFreeBytes ?? 1_300_000_000;
		const free = freeBytes(installRoot, options.capture);
		if (free !== null && free < need)
			throw new Error(`only ${Math.floor(free / 1e6)} MB free under ${installRoot}; ClickHouse needs about ${Math.ceil(need / 1e6)} MB to install`);
		log(`downloading ClickHouse ${version} (${arch})`);
		const fetcher = options.fetch ?? fetch;
		const response = await fetcher(url, { redirect: 'follow', signal: AbortSignal.timeout(15 * 60_000) });
		if (!response.ok || !response.body) throw new Error(`download failed: ${url} answered HTTP ${response.status}`);
		const actual = await download(response.body, `${archive}.part`);
		if (actual !== sha512) {
			rmSync(`${archive}.part`, { force: true });
			throw new Error(`sha512 mismatch for ${url} (got ${actual.slice(0, 16)}…, want ${sha512.slice(0, 16)}…)`);
		}
		renameSync(`${archive}.part`, archive);
		cached = true;
	}

	const staging = join(installRoot, `.staging-${version}-${process.pid}`);
	rmSync(staging, { recursive: true, force: true });
	mkdirSync(staging, { recursive: true, mode: 0o700 });
	try {
		options.run(['tar', '-xzf', archive, '-C', staging, '--no-same-owner']);
		const extracted = findFile(staging, '/usr/bin/clickhouse');
		if (!extracted) throw new Error(`${archive} has no usr/bin/clickhouse`);
		chmodSync(extracted, 0o755);
		// Prove the binary runs on this host before anything points at it.
		if (options.capture([extracted, 'server', '--version']) === null)
			throw new Error(`the downloaded ClickHouse binary does not run on this host (${arch})`);
		rmSync(dir, { recursive: true, force: true });
		mkdirSync(dir, { recursive: true, mode: 0o755 });
		renameSync(extracted, binary);
		writeFileSync(marker, `${sha512}\n`, { mode: 0o644 });
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
	rmSync(archive, { force: true });
	log(`installed ClickHouse ${version} at ${binary}`);
	return { binary, changed: true };
}

async function waitForPing(url: string, options: EnsureClickHouseOptions): Promise<boolean> {
	const fetcher = options.fetch ?? fetch;
	const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
	const deadline = Date.now() + (options.readyTimeoutMs ?? 60_000);
	do {
		try {
			const response = await fetcher(`${url.replace(/\/$/, '')}/ping`, { signal: AbortSignal.timeout(2_000) });
			if (response.ok && (await response.text()).trim() === 'Ok.') return true;
		} catch {
			// not listening yet
		}
		await sleep(500);
	} while (Date.now() < deadline);
	return false;
}

/**
 * Install, configure, start and keep ClickHouse current on a control-plane host. Idempotent:
 * files are rewritten and the server restarted only when something changed. Never throws.
 */
export async function ensureClickHouse(options: EnsureClickHouseOptions): Promise<EnsureClickHouseResult> {
	const log = options.log ?? (() => {});
	const installRoot = options.installRoot ?? CLICKHOUSE_PATHS.installRoot;
	const configDir = options.configDir ?? CLICKHOUSE_PATHS.configDir;
	const dataDir = options.dataDir ?? CLICKHOUSE_PATHS.dataDir;
	const envFile = options.envFile ?? CLICKHOUSE_PATHS.envFile;
	const systemdDir = options.systemdDir ?? CLICKHOUSE_PATHS.systemdDir;
	const user = options.systemUser ?? CLICKHOUSE_SYSTEM_USER;
	const result: EnsureClickHouseResult = { ok: false, changed: false, binary: null, envAdded: [] };
	const warn = (warning: string): EnsureClickHouseResult => {
		log(`warning: ${warning}; telemetry stays unavailable until ClickHouse runs (see docs/OPS.md)`);
		return { ...result, warning };
	};

	try {
		if ((options.platform ?? process.platform) !== 'linux') return warn('ClickHouse is only installed on Linux hosts');
		const arch = clickhouseArch(options.arch);
		if (!arch) return warn(`no ClickHouse build for CPU architecture ${options.arch ?? process.arch}`);

		// The env vars first: the control plane reads them even when the server is not up yet.
		const { env, added } = ensureClickHouseEnv(envFile, { dryRun: options.dryRun });
		result.envAdded = added;
		if (added.length) log(`added ${added.join(', ')} to ${envFile}`);
		if (options.dryRun) {
			log(`would install ClickHouse ${options.version ?? CLICKHOUSE_VERSION} and ${CLICKHOUSE_UNIT}`);
			return { ...result, ok: true };
		}

		let binary: string;
		let binaryChanged = false;
		try {
			({ binary, changed: binaryChanged } = await installBinary(options, arch, log));
		} catch (error) {
			// Keep running whatever version is already installed.
			const fallback = installedVersions(installRoot)[0];
			if (!fallback) return warn(`could not install ClickHouse: ${(error as Error).message}`);
			binary = join(installRoot, fallback, 'clickhouse');
			log(`warning: could not install ClickHouse ${options.version ?? CLICKHOUSE_VERSION} (${(error as Error).message}); keeping ${fallback}`);
		}
		result.binary = binary;

		if (options.capture(['id', '-u', user]) === null) {
			options.run(['useradd', '--system', '--user-group', '--no-create-home', '--home-dir', '/nonexistent', '--shell', '/usr/sbin/nologin', user]);
			log(`created system user ${user}`);
		}
		mkdirSync(dataDir, { recursive: true, mode: 0o750 });
		options.run(['chown', `${user}:${user}`, dataDir]);
		options.run(['chmod', '0750', dataDir]);
		mkdirSync(configDir, { recursive: true, mode: 0o750 });
		options.run(['chown', `root:${user}`, configDir]);
		options.run(['chmod', '0750', configDir]);

		const files: [string, string][] = [
			[join(configDir, 'config.xml'), clickhouseConfigXml({ dataDir })],
			[
				join(configDir, 'users.xml'),
				clickhouseUsersXml({
					database: env.database,
					writerUser: env.user,
					writerPassword: env.password,
					readerUser: env.readerUser,
					readerPassword: env.readerPassword,
				}),
			],
		];
		let configChanged = false;
		for (const [path, body] of files) {
			if (writeIfChanged(path, body, 0o640)) configChanged = true;
			options.run(['chown', `root:${user}`, path]);
		}

		const unitPath = join(systemdDir, CLICKHOUSE_UNIT);
		const previousUnit = existsSync(unitPath) ? readFileSync(unitPath, 'utf8') : null;
		const unit = clickhouseUnit({ binary, configDir, dataDir, user, alert: existsSync(join(systemdDir, 'skiff-alert@.service')) });
		const unitChanged = writeIfChanged(unitPath, unit, 0o644);
		if (unitChanged) options.run(['systemctl', 'daemon-reload']);
		options.run(['systemctl', 'enable', CLICKHOUSE_UNIT]);
		const changed = binaryChanged || configChanged || unitChanged;
		result.changed = changed;
		options.run(['systemctl', changed ? 'restart' : 'start', CLICKHOUSE_UNIT]);

		if (await waitForPing(env.url, options)) {
			// The new version is serving: drop older ones.
			for (const version of installedVersions(installRoot))
				if (join(installRoot, version, 'clickhouse') !== binary) rmSync(join(installRoot, version), { recursive: true, force: true });
			if (changed) log(`ClickHouse is serving on ${env.url}`);
			return { ...result, ok: true };
		}

		// A new binary or unit that does not come up: put the previous unit back.
		if (previousUnit && unitChanged) {
			writeIfChanged(unitPath, previousUnit, 0o644);
			options.run(['systemctl', 'daemon-reload']);
			options.run(['systemctl', 'restart', CLICKHOUSE_UNIT]);
			const recovered = await waitForPing(env.url, options);
			return warn(`ClickHouse did not answer ${env.url}/ping after the change; ${recovered ? 'reverted to the previous unit' : 'the previous unit did not come up either'} (journalctl -u ${CLICKHOUSE_UNIT})`);
		}
		return warn(`ClickHouse did not answer ${env.url}/ping (journalctl -u ${CLICKHOUSE_UNIT})`);
	} catch (error) {
		return warn(`ClickHouse setup failed: ${(error as Error).message}`);
	}
}

/** Stop and remove the unit (installer --uninstall). Data and binaries stay unless purged. */
export function removeClickHouseUnit(options: { systemdDir?: string; run: (cmd: string[]) => void }): void {
	const systemdDir = options.systemdDir ?? CLICKHOUSE_PATHS.systemdDir;
	try {
		options.run(['systemctl', 'disable', '--now', CLICKHOUSE_UNIT]);
	} catch {
		// not installed
	}
	rmSync(join(systemdDir, CLICKHOUSE_UNIT), { force: true });
}

/**
 * ClickHouse is optional (D101): it is installed only when asked for (installer prompt or
 * Settings → Telemetry). Its unit file is the marker the updater and the dashboard check.
 */
export function clickhouseInstalled(systemdDir: string = CLICKHOUSE_PATHS.systemdDir): boolean {
	return existsSync(join(systemdDir, CLICKHOUSE_UNIT));
}

export interface UninstallClickHouseOptions {
	installRoot?: string;
	configDir?: string;
	dataDir?: string;
	envFile?: string;
	systemdDir?: string;
	/** Also delete the stored telemetry. Off by default: reinstalling keeps the history. */
	purgeData?: boolean;
	run: (cmd: string[]) => void;
	log?: (message: string) => void;
}

/**
 * Stop and remove ClickHouse: the unit, the binaries, its config and the SKIFF_CLICKHOUSE_*
 * lines in skiff.env (other lines and comments are kept byte for byte). The data directory is
 * deleted only with `purgeData`. Returns the env keys it removed.
 */
export function uninstallClickHouse(options: UninstallClickHouseOptions): string[] {
	const log = options.log ?? (() => {});
	const envFile = options.envFile ?? CLICKHOUSE_PATHS.envFile;
	removeClickHouseUnit({ systemdDir: options.systemdDir, run: options.run });
	try {
		options.run(['systemctl', 'daemon-reload']);
	} catch {
		// Not fatal: the unit file is already gone.
	}
	rmSync(options.installRoot ?? CLICKHOUSE_PATHS.installRoot, { recursive: true, force: true });
	rmSync(options.configDir ?? CLICKHOUSE_PATHS.configDir, { recursive: true, force: true });
	if (options.purgeData) {
		rmSync(options.dataDir ?? CLICKHOUSE_PATHS.dataDir, { recursive: true, force: true });
		log('deleted the stored telemetry');
	}
	const keys = new Set<string>(Object.values(CLICKHOUSE_ENV));
	const removed: string[] = [];
	if (existsSync(envFile)) {
		const lines = readFileSync(envFile, 'utf8').split('\n');
		const kept = lines.filter((line) => {
			const key = /^\s*(?:export\s+)?([A-Z0-9_]+)=/.exec(line)?.[1];
			if (key && keys.has(key)) {
				removed.push(key);
				return false;
			}
			return true;
		});
		if (removed.length > 0) writeFileSync(envFile, kept.join('\n'), { mode: 0o640 });
	}
	log(`removed ${CLICKHOUSE_UNIT}${removed.length ? ` and ${removed.length} SKIFF_CLICKHOUSE_* settings` : ''}`);
	return removed;
}
