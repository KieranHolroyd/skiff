import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	renameSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { dirname } from 'node:path';
import {
	SELF_UPDATE_DEFAULTS,
	SELF_UPDATE_LOG_LINES,
	SELF_UPDATE_STALE_MS,
	canAdministerPlatform,
	compareSemver,
	isSelfUpdateMethod,
	parseSemver,
	selfUpdateModeFile,
	semverBump,
	type Principal,
	type SelfUpdateLog,
	type SelfUpdateLogLevel,
	type SelfUpdateLogLine,
	type SelfUpdateMethod,
	type SelfUpdateStatus
} from '@skiff/contracts';
import { platformVersion } from './version';

/**
 * Dashboard side of self-update (docs/OPS.md §4.1). This process is unprivileged and sandboxed:
 * it only reads the latest VERSION from GitHub, reads the updater's status file and drops a
 * request file. The root-owned updater re-checks everything itself before acting.
 */

const env = process.env;
const requestFile = env.SKIFF_UPDATE_REQUEST_FILE ?? SELF_UPDATE_DEFAULTS.requestFile;
const paths = {
	requestFile,
	modeFile: selfUpdateModeFile(requestFile),
	statusFile: env.SKIFF_UPDATE_STATUS_FILE ?? SELF_UPDATE_DEFAULTS.statusFile,
	logFile: env.SKIFF_UPDATE_LOG_FILE ?? SELF_UPDATE_DEFAULTS.logFile,
	pathUnit: env.SKIFF_UPDATE_PATH_UNIT ?? SELF_UPDATE_DEFAULTS.pathUnit,
	releaseMeta: env.SKIFF_RELEASE_META ?? SELF_UPDATE_DEFAULTS.releaseMeta
};

const DEFAULT_REPO = 'KieranHolroyd/skiff';
const DEFAULT_REF = 'main';
const CACHE_MS = 5 * 60 * 1000;

/** Updating restarts the whole platform: platform admins, signed in interactively (no API keys/MCP). */
export function canManagePlatform(principal: Principal | undefined): boolean {
	// Platform admin (admin-plugin user role), never merely an org owner/admin (DESIGN §6.2).
	return principal !== undefined && principal.kind === 'user' && canAdministerPlatform(principal);
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
			tag?: unknown;
			source?: unknown;
		};
		// Older artifact installs recorded the release tag as `ref`; a source build of that tag
		// only finds the running version. Same rule as the updater's `trackedRef`.
		const legacyArtifact = meta.source === 'artifact' && meta.tag === undefined;
		const repo =
			typeof meta.repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(meta.repo)
				? meta.repo
				: DEFAULT_REPO;
		const ref =
			!legacyArtifact &&
			typeof meta.ref === 'string' &&
			/^[\w./-]+$/.test(meta.ref) &&
			!meta.ref.includes('..')
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

/**
 * Newest signed release (`v<semver>` with a manifest), the same choice the updater makes.
 * null when nothing is published or GitHub cannot be asked; the caller falls back to VERSION.
 */
async function latestPublishedVersion(repo: string): Promise<string | null> {
	try {
		const response = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=30`, {
			headers: { 'User-Agent': 'skiff-control-plane', Accept: 'application/vnd.github+json' },
			signal: AbortSignal.timeout(8_000)
		});
		if (!response.ok) return null;
		const releases = (await response.json()) as {
			tag_name?: string;
			draft?: boolean;
			prerelease?: boolean;
			assets?: { name?: string }[];
		}[];
		const versions = releases
			.filter(
				(release) =>
					!release.draft &&
					!release.prerelease &&
					/^v\d+\.\d+\.\d+$/.test(release.tag_name ?? '') &&
					(release.assets ?? []).some((asset) => asset.name === 'manifest.json')
			)
			.map((release) => release.tag_name!.slice(1))
			.sort((a, b) => compareSemver(b, a));
		return versions[0] ?? null;
	} catch {
		return null;
	}
}

/**
 * The version the updater would install for the chosen method: the newest signed release, the
 * VERSION file on the update ref for a source build, or either for `auto` (signed first, then
 * source). Cached for five minutes unless `force`.
 */
export async function latestVersion(
	source: UpdateSource,
	{ force = false, method = 'auto' }: { force?: boolean; method?: SelfUpdateMethod } = {}
): Promise<LatestVersion> {
	const key = `${source.repo}@${source.ref}#${method}`;
	if (!force && cached && cached.key === key && Date.now() - cached.at < CACHE_MS)
		return cached.value;
	const checkedAt = new Date().toISOString();
	const ref = source.ref.split('/').map(encodeURIComponent).join('/');
	let value: LatestVersion;
	// A source build always reads VERSION at the update ref. Downloading only ever installs a
	// signed published release; `auto` prefers one and falls back to the source path.
	if (method !== 'build') {
		const published = await latestPublishedVersion(source.repo);
		if (published) {
			value = { ok: true, version: published, checkedAt };
			cached = { key, at: Date.now(), value };
			return value;
		}
		if (method === 'download') {
			value = {
				ok: false,
				error: `No signed release is published for ${source.repo} (or GitHub could not be reached). Choose “Build from source”, or publish a signed release first.`,
				checkedAt
			};
			cached = { key, at: Date.now(), value };
			return value;
		}
	}
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
				error: `No VERSION file on ${source.repo}@${source.ref} (or the repository is private).`,
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
						error: `VERSION on ${source.repo}@${source.ref} is not a semantic version ("${body.trim().slice(0, 40)}").`,
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

/**
 * The newer version the dashboard shell flags to platform admins, or null (none, the check failed,
 * an update is already under way, or this is not an installed release). Uses the cached check.
 */
export async function availableUpdate(): Promise<{ current: string; latest: string } | null> {
	if (selfUpdateAvailability() === 'unmanaged' || updateInFlight()) return null;
	const comparison = compareToRunning(await latestVersion(updateSource()));
	return comparison.available && comparison.latest
		? { current: comparison.current, latest: comparison.latest }
		: null;
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

const LOG_LEVELS: SelfUpdateLogLevel[] = ['info', 'warn', 'error', 'command', 'output', 'phase'];
const LOG_TAIL_BYTES = 256 * 1024;

/**
 * Parse the updater's JSON Lines log. Tolerates a truncated first record (a byte-window tail can
 * start mid-line) and never throws: a corrupt log must not break the updates page.
 */
export function parseUpdateLog(
	text: string,
	limit = SELF_UPDATE_LOG_LINES
): { lines: SelfUpdateLogLine[]; truncated: boolean } {
	const lines: SelfUpdateLogLine[] = [];
	for (const raw of text.split('\n')) {
		if (!raw.trim()) continue;
		try {
			const value = JSON.parse(raw) as Partial<SelfUpdateLogLine>;
			if (typeof value?.at !== 'string' || typeof value?.text !== 'string') continue;
			const level = LOG_LEVELS.includes(value.level as SelfUpdateLogLevel)
				? (value.level as SelfUpdateLogLevel)
				: 'info';
			lines.push({ at: value.at, level, text: value.text.slice(0, 4_000) });
		} catch {
			// A partial record from the read window; skip it.
		}
	}
	return lines.length > limit
		? { lines: lines.slice(-limit), truncated: true }
		: { lines, truncated: false };
}

/** The live update log: the last few hundred lines, read from a bounded tail of the file. */
export function readUpdateLog(limit = SELF_UPDATE_LOG_LINES): SelfUpdateLog {
	let stat: ReturnType<typeof statSync>;
	try {
		stat = statSync(paths.logFile);
	} catch {
		return { lines: [], exists: false, truncated: false, updatedAt: null };
	}
	const size = Math.min(stat.size, LOG_TAIL_BYTES);
	const start = stat.size - size;
	let text: string;
	try {
		const fd = openSync(paths.logFile, 'r');
		try {
			const buffer = Buffer.alloc(size);
			readSync(fd, buffer, 0, size, start);
			text = buffer.toString('utf8');
		} finally {
			closeSync(fd);
		}
	} catch {
		return { lines: [], exists: false, truncated: false, updatedAt: null };
	}
	// Drop the byte-window's partial first record.
	if (start > 0) {
		const newline = text.indexOf('\n');
		text = newline === -1 ? '' : text.slice(newline + 1);
	}
	const parsed = parseUpdateLog(text, limit);
	return {
		lines: parsed.lines,
		exists: true,
		truncated: parsed.truncated || start > 0,
		updatedAt: new Date(stat.mtimeMs).toISOString()
	};
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
 * Ask the root updater to run. The request body stays informational (the updater never reads it);
 * the audit log is the record of who asked. The install method travels in an allowlisted sidecar
 * because the trigger unit cannot pass form data to the updater.
 */
export function requestUpdate(
	principal: Principal,
	target: string | null,
	method: SelfUpdateMethod = 'auto'
): void {
	if (!isSelfUpdateMethod(method)) throw new Error(`Unknown update method "${String(method)}".`);
	mkdirSync(dirname(paths.requestFile), { recursive: true });
	// Write the method first so the path unit cannot fire before it exists. The updater deletes
	// the sidecar as soon as it has read it, even when the value is not recognised.
	const modeTmp = `${paths.modeFile}.${process.pid}.tmp`;
	writeFileSync(modeTmp, `${method}\n`, { mode: 0o640 });
	renameSync(modeTmp, paths.modeFile);
	const tmp = `${paths.requestFile}.${process.pid}.tmp`;
	writeFileSync(
		tmp,
		`${JSON.stringify({ requestedAt: new Date().toISOString(), by: principal.userId, target, method })}\n`,
		{ mode: 0o640 }
	);
	renameSync(tmp, paths.requestFile);
}

/** The dashboard's default choice; `SKIFF_UPDATE_METHOD` lets operators pin it per host. */
export function defaultUpdateMethod(): SelfUpdateMethod {
	const value = env.SKIFF_UPDATE_METHOD;
	return isSelfUpdateMethod(value) ? value : 'auto';
}

/** Parse a submitted radio value; null means it was not one of the allowlisted choices. */
export function updateMethodFromForm(value: unknown): SelfUpdateMethod | null {
	return isSelfUpdateMethod(value) ? value : null;
}
