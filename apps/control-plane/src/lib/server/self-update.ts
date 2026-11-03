import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
	SELF_UPDATE_DEFAULTS,
	SELF_UPDATE_STALE_MS,
	compareSemver,
	parseSemver,
	semverBump,
	type Principal,
	type SelfUpdateStatus
} from '@skiff/contracts';
import { platformVersion } from './version';

/**
 * Dashboard side of self-update (docs/OPS.md §4.1). This process is unprivileged and sandboxed:
 * it only reads the latest VERSION from GitHub, reads the updater's status file and drops a
 * request file. The root-owned updater re-checks everything itself before acting.
 */

const env = process.env;
const paths = {
	requestFile: env.SKIFF_UPDATE_REQUEST_FILE ?? SELF_UPDATE_DEFAULTS.requestFile,
	statusFile: env.SKIFF_UPDATE_STATUS_FILE ?? SELF_UPDATE_DEFAULTS.statusFile,
	pathUnit: env.SKIFF_UPDATE_PATH_UNIT ?? SELF_UPDATE_DEFAULTS.pathUnit,
	releaseMeta: env.SKIFF_RELEASE_META ?? SELF_UPDATE_DEFAULTS.releaseMeta
};

const DEFAULT_REPO = 'KieranHolroyd/skiff';
const DEFAULT_REF = 'main';
const CACHE_MS = 5 * 60 * 1000;

/** Updating restarts the whole platform: platform admins, signed in interactively (no API keys/MCP). */
export function canManagePlatform(principal: Principal | undefined): boolean {
	return principal?.kind === 'user' && (principal.role === 'owner' || principal.role === 'admin');
}

/**
 * - `unmanaged`: not running from an installed release (e.g. `vite dev`)
 * - `not-enabled`: installed, but the root trigger units are missing (run the CLI once)
 * - `ready`: the dashboard can request updates
 */
export type SelfUpdateAvailability = 'unmanaged' | 'not-enabled' | 'ready';

export function selfUpdateAvailability(): SelfUpdateAvailability {
	if (!existsSync(paths.releaseMeta)) return 'unmanaged';
	if (!existsSync(paths.pathUnit)) return 'not-enabled';
	return 'ready';
}

export interface UpdateSource {
	repo: string;
	ref: string;
}

/** The repo/ref the updater pulls from: recorded in the active release's meta.json. */
export function updateSource(): UpdateSource {
	try {
		const meta = JSON.parse(readFileSync(paths.releaseMeta, 'utf8')) as {
			repo?: unknown;
			ref?: unknown;
		};
		const repo =
			typeof meta.repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(meta.repo)
				? meta.repo
				: DEFAULT_REPO;
		const ref =
			typeof meta.ref === 'string' && /^[\w./-]+$/.test(meta.ref) && !meta.ref.includes('..')
				? meta.ref
				: DEFAULT_REF;
		return { repo, ref };
	} catch {
		return { repo: DEFAULT_REPO, ref: DEFAULT_REF };
	}
}

export type LatestVersion =
	| { ok: true; version: string; checkedAt: string }
	| { ok: false; error: string; checkedAt: string };

let cached: { key: string; at: number; value: LatestVersion } | null = null;

/** The VERSION file on the update ref. Cached for five minutes unless `force`. */
export async function latestVersion(
	source: UpdateSource,
	{ force = false }: { force?: boolean } = {}
): Promise<LatestVersion> {
	const key = `${source.repo}@${source.ref}`;
	if (!force && cached && cached.key === key && Date.now() - cached.at < CACHE_MS)
		return cached.value;
	const checkedAt = new Date().toISOString();
	const ref = source.ref.split('/').map(encodeURIComponent).join('/');
	let value: LatestVersion;
	try {
		const response = await fetch(
			`https://raw.githubusercontent.com/${source.repo}/${ref}/VERSION`,
			{
				headers: { 'User-Agent': 'skiff-control-plane' },
				signal: AbortSignal.timeout(8_000)
			}
		);
		if (response.status === 404) {
			value = {
				ok: false,
				error: `No VERSION file on ${key} (or the repository is private).`,
				checkedAt
			};
		} else if (!response.ok) {
			value = { ok: false, error: `GitHub answered ${response.status}.`, checkedAt };
		} else {
			const body = (await response.text()).slice(0, 1024);
			const parsed = parseSemver(body);
			value = parsed
				? { ok: true, version: parsed.version, checkedAt }
				: {
						ok: false,
						error: `VERSION on ${key} is not a semantic version ("${body.trim().slice(0, 40)}").`,
						checkedAt
					};
		}
	} catch (error) {
		value = {
			ok: false,
			error: `Could not reach GitHub: ${error instanceof Error ? error.message : String(error)}`,
			checkedAt
		};
	}
	cached = { key, at: Date.now(), value };
	return value;
}

export interface VersionComparison {
	current: string;
	latest: string | null;
	/** `latest` is newer than the running version by semver precedence. */
	available: boolean;
	bump: ReturnType<typeof semverBump>;
}

export function compareToRunning(latest: LatestVersion): VersionComparison {
	const current = platformVersion;
	if (!latest.ok) return { current, latest: null, available: false, bump: null };
	const valid = parseSemver(current) !== null;
	return {
		current,
		latest: latest.version,
		available: !valid || compareSemver(latest.version, current) > 0,
		bump: valid ? semverBump(current, latest.version) : null
	};
}

export type UpdateStatusView = SelfUpdateStatus & { stale: boolean };

/** The updater's last (or in-flight) run; null when it has never run on this host. */
export function readUpdateStatus(): UpdateStatusView | null {
	try {
		const status = JSON.parse(readFileSync(paths.statusFile, 'utf8')) as SelfUpdateStatus;
		if (typeof status?.running !== 'boolean' || typeof status.updatedAt !== 'string') return null;
		const age = Date.now() - Date.parse(status.updatedAt);
		return { ...status, stale: status.running && !(age < SELF_UPDATE_STALE_MS) };
	} catch {
		return null;
	}
}

/** A request is waiting for systemd to start the updater. */
export function updatePending(): boolean {
	return existsSync(paths.requestFile);
}

/** True while an update is queued or running (a crashed, stale run does not count). */
export function updateInFlight(status = readUpdateStatus()): boolean {
	return updatePending() || Boolean(status?.running && !status.stale);
}

/**
 * Ask the root updater to run. The content is informational only (the updater never reads it);
 * the audit log is the record of who asked.
 */
export function requestUpdate(principal: Principal, target: string | null): void {
	mkdirSync(dirname(paths.requestFile), { recursive: true });
	const tmp = `${paths.requestFile}.${process.pid}.tmp`;
	writeFileSync(
		tmp,
		`${JSON.stringify({ requestedAt: new Date().toISOString(), by: principal.userId, target })}\n`,
		{ mode: 0o640 }
	);
	renameSync(tmp, paths.requestFile);
}
