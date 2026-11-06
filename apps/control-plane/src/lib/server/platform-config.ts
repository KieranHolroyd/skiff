import { randomUUID } from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
	PLATFORM_CONFIG_DEFAULTS,
	PLATFORM_CONFIG_SECRET_KEYS,
	PLATFORM_CONFIG_SECTIONS,
	PLATFORM_CONFIG_STALE_MS,
	SELF_UPDATE_DEFAULTS,
	parsePlatformConfigRequest,
	type PlatformConfigRequest,
	type PlatformConfigSection,
	type PlatformConfigStatus,
	type Principal,
	type RestoreDrillStatus
} from '@skiff/contracts';
import type { DomainSettings } from '@skiff/contracts';
import { EmailNotifier, R2ObjectStore, SmtpEmailTransport, WebhookNotifier } from '@skiff/core';
import { localRestartPending, localSettingsEnabled, saveLocalSettings } from './local-settings';
import { canManagePlatform } from './self-update';

/**
 * Dashboard side of platform settings (docs/OPS.md §4.3). This process is unprivileged and cannot
 * write `/etc/skiff/skiff.env`; it validates, then drops a request for the root helper
 * (`skiff-platform-config`), which validates again, applies it and restarts the control plane.
 * Settings are read back from this process's own environment, which is the env file as of the
 * last (re)start.
 */

/**
 * Email, R2/backups and alert settings (and the database download) are for the owner only: a
 * platform admin (DESIGN §6.2, admin-plugin role) who is also the owner of the org they are signed
 * in to, in an interactive dashboard session. Org admins, API keys and MCP tokens never qualify.
 * On a single-user install that is the bootstrap user.
 */
export function canConfigurePlatform(principal: Principal | undefined): boolean {
	return canManagePlatform(principal) && principal?.role === 'owner';
}

export const OWNER_ONLY_MESSAGE = 'Only the owner can change email, backup and alert settings.';

const env = process.env;
const paths = {
	requestFile: env.SKIFF_CONFIG_REQUEST_FILE ?? PLATFORM_CONFIG_DEFAULTS.requestFile,
	statusFile: env.SKIFF_CONFIG_STATUS_FILE ?? PLATFORM_CONFIG_DEFAULTS.statusFile,
	pathUnit: env.SKIFF_CONFIG_PATH_UNIT ?? PLATFORM_CONFIG_DEFAULTS.pathUnit,
	releaseMeta: env.SKIFF_RELEASE_META ?? SELF_UPDATE_DEFAULTS.releaseMeta,
	drillStatus: join(env.SKIFF_RESTORE_DRILL_DIR ?? '/var/lib/skiff/drill', 'status.json'),
	litestreamBin: PLATFORM_CONFIG_DEFAULTS.litestreamBin,
	litestreamConfig: env.SKIFF_LITESTREAM_CONFIG ?? PLATFORM_CONFIG_DEFAULTS.litestreamConfig,
	backupsDir: join(dirname(env.SKIFF_DATA_DIR ?? '/var/lib/skiff/data'), 'backups'),
	dbPath: join(env.SKIFF_DATA_DIR ?? '.data', 'skiff.db')
};

/**
 * - `local`: a dev server (`vite dev`); settings are saved to `.data/platform-settings.json` and
 *   apply after a restart (lib/server/local-settings.ts)
 * - `unmanaged`: a production build that is not an installed release; settings come from its env
 * - `not-enabled`: installed, but the root helper's units are missing
 * - `ready`: the dashboard can change settings
 */
export type ConfigAvailability = 'local' | 'unmanaged' | 'not-enabled' | 'ready';

export function configAvailability(): ConfigAvailability {
	if (!existsSync(paths.releaseMeta)) return localSettingsEnabled ? 'local' : 'unmanaged';
	if (!existsSync(paths.pathUnit)) return 'not-enabled';
	return 'ready';
}

export type ConfigStatusView = PlatformConfigStatus & { stale: boolean };

export function readConfigStatus(): ConfigStatusView | null {
	try {
		const status = JSON.parse(readFileSync(paths.statusFile, 'utf8')) as PlatformConfigStatus;
		if (typeof status?.running !== 'boolean' || typeof status.updatedAt !== 'string') return null;
		const age = Date.now() - Date.parse(status.updatedAt);
		return { ...status, stale: status.running && !(age < PLATFORM_CONFIG_STALE_MS) };
	} catch {
		return null;
	}
}

/** Dev server: validate like the helper would, then save to the local settings file. Returns changed keys. */
export function saveConfigLocally(principal: Principal, body: RequestBody): string[] {
	const parsed = parsePlatformConfigRequest({
		id: `local_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
		requestedAt: new Date().toISOString(),
		by: principal.userId,
		...body
	});
	if (!parsed.ok) throw new Error(parsed.error);
	if (parsed.request.action !== 'configure')
		throw new Error('Litestream backups and restore drills only run on an installed server.');
	return saveLocalSettings(parsed.request);
}

export { localRestartPending };

export function configPending(): boolean {
	return existsSync(paths.requestFile);
}

export function configInFlight(status = readConfigStatus()): boolean {
	return configPending() || Boolean(status?.running && !status.stale);
}

type RequestBody =
	| {
			action: 'configure';
			section: PlatformConfigSection;
			set: Record<string, string>;
			unset: string[];
	  }
	| { action: 'backups'; enabled: boolean }
	| { action: 'restore-drill' }
	| { action: 'telemetry'; enabled: boolean; purgeData: boolean }
	| ({ action: 'domains'; cloudflareToken?: string } & DomainSettings);

/** Validate (same rules as the helper) and queue a request. Returns its id. Throws on bad input. */
export function submitConfigRequest(principal: Principal, body: RequestBody): string {
	const id = `cfg_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
	const parsed = parsePlatformConfigRequest({
		id,
		requestedAt: new Date().toISOString(),
		by: principal.userId,
		...body
	});
	if (!parsed.ok) throw new Error(parsed.error);
	writeRequest(parsed.request);
	return id;
}

function writeRequest(request: PlatformConfigRequest): void {
	mkdirSync(dirname(paths.requestFile), { recursive: true });
	const tmp = `${paths.requestFile}.${process.pid}.tmp`;
	// May contain credentials: owner-only. Root reads it, then deletes it.
	writeFileSync(tmp, `${JSON.stringify(request)}\n`, { mode: 0o600 });
	renameSync(tmp, paths.requestFile);
}

// -------------------------------------------------------------- current values

export interface SectionView {
	/** Non-secret values as currently running. */
	values: Record<string, string>;
	/** Secret keys that have a value (the value itself is never sent to the browser). */
	secretsSet: string[];
	configured: boolean;
}

export function currentSection(section: PlatformConfigSection): SectionView {
	const values: Record<string, string> = {};
	const secretsSet: string[] = [];
	for (const key of PLATFORM_CONFIG_SECTIONS[section]) {
		const value = env[key];
		if (!value) continue;
		if (PLATFORM_CONFIG_SECRET_KEYS.has(key)) secretsSet.push(key);
		else values[key] = value;
	}
	const configured =
		section === 'backups'
			? Boolean(
					env.R2_ACCOUNT_ID && env.R2_BUCKET && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY
				)
			: section === 'email'
				? Boolean(env.SKIFF_SMTP_HOST)
				: section === 'assistant'
					? Boolean(
							env.SKIFF_ASSISTANT_BASE_URL &&
								env.SKIFF_ASSISTANT_MODEL &&
								env.SKIFF_ASSISTANT_DISABLED !== '1'
						)
					: Boolean(env.SKIFF_ALERT_WEBHOOK || env.SKIFF_ALERT_EMAIL);
	return { values, secretsSet, configured };
}

/** Artifacts live in R2 too, so its credentials cannot be removed (and a new bucket hides old releases). */
export const artifactsInR2 = (env.SKIFF_OBJECT_STORE ?? 'local') === 'r2';

// ---------------------------------------------------------------- host health

export interface UnitState {
	active: string;
	enabled: string;
	/** Timers only: next scheduled run. */
	next: string | null;
	/** Timers only: last run. */
	last: string | null;
}

async function exec(
	cmd: string[],
	timeoutMs: number
): Promise<{ code: number; stdout: string } | null> {
	try {
		const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'ignore', env: process.env });
		const timer = setTimeout(() => proc.kill(), timeoutMs);
		const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		clearTimeout(timer);
		return { code, stdout };
	} catch {
		return null;
	}
}

function usecToIso(value: string | undefined): string | null {
	if (!value || value === 'n/a' || value === '0') return null;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** `systemctl show` works unprivileged over the system bus; null when it is unavailable. */
async function unitStates(units: string[]): Promise<Record<string, UnitState> | null> {
	const result = await exec(
		[
			'systemctl',
			'show',
			'--timestamp=utc',
			'-p',
			'Id,ActiveState,UnitFileState,NextElapseUSecRealtime,LastTriggerUSec',
			...units
		],
		3_000
	);
	if (!result || result.code !== 0) return null;
	const states: Record<string, UnitState> = {};
	for (const block of result.stdout.trim().split(/\n\s*\n/)) {
		const fields = new Map(
			block
				.split('\n')
				.map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
		);
		const id = fields.get('Id');
		if (!id) continue;
		states[id] = {
			active: fields.get('ActiveState') || 'unknown',
			enabled: fields.get('UnitFileState') || 'unknown',
			next: usecToIso(fields.get('NextElapseUSecRealtime')),
			last: usecToIso(fields.get('LastTriggerUSec'))
		};
	}
	return states;
}

export interface Replication {
	ok: boolean;
	/** Newest replicated position (end of the latest generation). */
	latestAt: string | null;
	lagSeconds: number | null;
	generations: number;
	error?: string;
}

let replicationCache: { at: number; value: Replication } | null = null;

/** The next status read asks R2 again instead of using the one-minute cache. */
export function clearBackupHealthCache(): void {
	replicationCache = null;
}

/**
 * Ask Litestream what R2 actually holds (`litestream generations`, v0.3). This is the real
 * signal: a running process with no recent objects is a silent failure (OPS §7.1).
 */
async function replication({ force = false } = {}): Promise<Replication | null> {
	if (!existsSync(paths.litestreamBin) || !existsSync(paths.litestreamConfig)) return null;
	if (!force && replicationCache && Date.now() - replicationCache.at < 60_000)
		return replicationCache.value;
	const result = await exec(
		[paths.litestreamBin, 'generations', '-config', paths.litestreamConfig, paths.dbPath],
		15_000
	);
	let value: Replication;
	if (!result || result.code !== 0) {
		value = {
			ok: false,
			latestAt: null,
			lagSeconds: null,
			generations: 0,
			error: result
				? 'Litestream could not list the replica in R2.'
				: 'Litestream could not be run.'
		};
	} else {
		let latest = 0;
		let generations = 0;
		for (const line of result.stdout.trim().split('\n').slice(1)) {
			const columns = line.trim().split(/\s+/);
			const end = Date.parse(columns.at(-1) ?? '');
			if (!Number.isFinite(end)) continue;
			generations++;
			latest = Math.max(latest, end);
		}
		value = latest
			? {
					ok: true,
					latestAt: new Date(latest).toISOString(),
					lagSeconds: Math.max(0, Math.round((Date.now() - latest) / 1000)),
					generations
				}
			: {
					ok: false,
					latestAt: null,
					lagSeconds: null,
					generations: 0,
					error: 'No backups in R2 yet.'
				};
	}
	replicationCache = { at: Date.now(), value };
	return value;
}

export function readDrillStatus(): RestoreDrillStatus | null {
	try {
		const status = JSON.parse(readFileSync(paths.drillStatus, 'utf8')) as RestoreDrillStatus;
		return typeof status?.ok === 'boolean' && typeof status.at === 'string' ? status : null;
	} catch {
		return null;
	}
}

export interface LocalSnapshot {
	name: string;
	kind: 'pre-upgrade' | 'pre-update' | 'pre-restore' | 'pre-install' | 'other';
	bytes: number;
	createdAt: string;
}

/** Snapshots the installer, updater and restore keep under /var/lib/skiff/backups. */
export function localSnapshots(): LocalSnapshot[] {
	try {
		return readdirSync(paths.backupsDir)
			.filter((name) => name.endsWith('.db') && !name.startsWith('download-'))
			.map((name): LocalSnapshot => {
				const info = statSync(join(paths.backupsDir, name));
				const kind = (['pre-upgrade', 'pre-update', 'pre-restore', 'pre-install'] as const).find(
					(prefix) => name.startsWith(prefix)
				);
				return {
					name,
					kind: kind ?? 'other',
					bytes: info.size,
					createdAt: info.mtime.toISOString()
				};
			})
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
			.slice(0, 20);
	} catch {
		return [];
	}
}

export interface BackupHealth {
	litestreamInstalled: boolean;
	litestream: UnitState | null;
	drillTimer: UnitState | null;
	drillRunning: boolean;
	replication: Replication | null;
	drill: RestoreDrillStatus | null;
	/** True when Litestream is enabled (whether or not it is healthy). */
	enabled: boolean;
}

export async function backupHealth({ force = false } = {}): Promise<BackupHealth> {
	const states = await unitStates([
		'skiff-litestream.service',
		'skiff-restore-drill.timer',
		'skiff-restore-drill.service'
	]);
	const litestream = states?.['skiff-litestream.service'] ?? null;
	const enabled = litestream ? litestream.enabled === 'enabled' : false;
	return {
		litestreamInstalled: existsSync(paths.litestreamBin),
		litestream,
		drillTimer: states?.['skiff-restore-drill.timer'] ?? null,
		drillRunning: ['active', 'activating'].includes(
			states?.['skiff-restore-drill.service']?.active ?? ''
		),
		replication: enabled ? await replication({ force }) : null,
		drill: readDrillStatus(),
		enabled
	};
}

// ---------------------------------------------------------- database download

/** A consistent copy of the live database (`VACUUM INTO`), for an offline backup. */
export function snapshotForDownload(sqlite: {
	run(sql: string, params?: unknown[]): unknown;
}): string {
	mkdirSync(paths.backupsDir, { recursive: true });
	// Leftovers from earlier downloads (the response stream may have been abandoned).
	for (const name of readdirSync(paths.backupsDir))
		if (name.startsWith('download-')) rmSync(join(paths.backupsDir, name), { force: true });
	const path = join(paths.backupsDir, `download-${Date.now()}.db`);
	sqlite.run('VACUUM INTO ?', [path]);
	return path;
}

// ---------------------------------------------------------------------- tests

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Write, read back and delete a small object with the given credentials. */
export async function testR2(options: {
	accountId: string;
	bucket: string;
	accessKeyId: string;
	secretAccessKey: string;
	endpoint?: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
	const store = new R2ObjectStore(options);
	const key = `skiff/healthcheck/${randomUUID()}.txt`;
	const body = new TextEncoder().encode(`skiff connection test ${new Date().toISOString()}\n`);
	try {
		await withTimeout(store.put(key, body, 'text/plain'), 10_000);
		const read = await withTimeout(store.get(key), 10_000);
		if (read.byteLength !== body.byteLength) throw new Error('read back a different object');
		await withTimeout(store.delete(key), 10_000);
		return { ok: true };
	} catch (error) {
		const message = errorMessage(error);
		const hint = / 403/.test(message)
			? 'Access denied: the token needs Object Read & Write on this bucket.'
			: / 404/.test(message) || /NoSuchBucket/.test(message)
				? 'The bucket does not exist in this account.'
				: / 401/.test(message) || /InvalidAccessKeyId|SignatureDoesNotMatch/.test(message)
					? 'The access key or secret is wrong.'
					: /S3 (PUT|GET|DELETE) .* failed: \d{3}/.test(message)
						? message.replace(/<[^>]+>/g, ' ').slice(0, 200)
						: `Could not reach ${options.endpoint ?? `${options.accountId}.r2.cloudflarestorage.com`} (${message.slice(0, 120)}). Check the account ID or endpoint.`;
		return { ok: false, error: hint };
	}
}

export async function testSmtp(
	options: {
		host: string;
		port: number;
		user: string;
		password: string;
		from: string;
		secure: boolean;
	},
	to: string
): Promise<{ ok: true } | { ok: false; error: string }> {
	try {
		const transport = new SmtpEmailTransport(options);
		await withTimeout(
			new EmailNotifier(transport, to).notify({
				title: 'Test email',
				detail:
					'Skiff can send email with these settings. Sign-in links, invitations and alerts will use them.',
				severity: 'info'
			}),
			20_000
		);
		return { ok: true };
	} catch (error) {
		return { ok: false, error: errorMessage(error).slice(0, 300) };
	}
}

export async function testWebhook(
	url: string
): Promise<{ ok: true } | { ok: false; error: string }> {
	try {
		await withTimeout(
			new WebhookNotifier(url).notify({
				key: 'test',
				title: 'Test alert',
				detail: 'This is a test alert from Skiff. Real alerts look like this.',
				severity: 'info'
			}),
			10_000
		);
		return { ok: true };
	} catch (error) {
		return { ok: false, error: errorMessage(error).slice(0, 300) };
	}
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return Promise.race([
		promise,
		new Promise<never>((_, reject) =>
			setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s`)), ms)
		)
	]);
}
