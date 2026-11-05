/**
 * The contract between the dashboard and the root-owned self-updater (docs/OPS.md §4.1).
 *
 * The control plane runs unprivileged and sandboxed, so it cannot update (or restart) itself.
 * Instead it drops `requestFile`; a systemd path unit notices and starts
 * `skiff-update-self.service` as root, which deletes the request, runs the updater and keeps
 * `statusFile` current. The request carries no data the updater trusts: it is only a trigger,
 * and the updater re-checks the version on GitHub itself. The one exception is the install
 * method: it is an allowlisted enum written to a sidecar file (see {@link SELF_UPDATE_METHODS}),
 * because a systemd unit cannot pass form data through to the updater.
 */

export const SELF_UPDATE_DEFAULTS = {
	/** Written by the control plane (skiff-owned directory). */
	requestFile: '/var/lib/skiff/update/request',
	/** Written by the updater (root-owned directory, group skiff can read). */
	statusFile: '/var/lib/skiff-update/status.json',
	/** JSON Lines progress log written by the updater; tailed by the dashboard. */
	logFile: '/var/lib/skiff-update/update.log',
	/** Its presence means dashboard-triggered updates are wired up on this host. */
	pathUnit: '/etc/systemd/system/skiff-update-self.path',
	/** Release metadata of the active release (repo/ref the updater pulls from). */
	releaseMeta: '/opt/skiff/current/meta.json',
} as const;

/**
 * How the updater obtains the release. `download` installs the CI-built, signed artifact;
 * `build` fetches the configured ref and compiles it on the host. `auto` preserves the historic
 * behaviour (download when a signed release exists, otherwise build from source).
 */
export const SELF_UPDATE_METHODS = ['auto', 'download', 'build'] as const;
export type SelfUpdateMethod = (typeof SELF_UPDATE_METHODS)[number];

export function isSelfUpdateMethod(value: unknown): value is SelfUpdateMethod {
	return typeof value === 'string' && (SELF_UPDATE_METHODS as readonly string[]).includes(value);
}

/** Map the user-facing method onto the updater's source mode. */
export function updateSourceForMethod(
	method: SelfUpdateMethod
): 'auto' | 'artifact' | 'source' {
	return method === 'download' ? 'artifact' : method === 'build' ? 'source' : 'auto';
}

/** The sidecar the control plane writes beside the request; the updater consumes it. */
export function selfUpdateModeFile(requestFile: string): string {
	return `${requestFile}.mode`;
}

export type SelfUpdatePhase =
	| 'queued'
	| 'checking'
	| 'building'
	| 'canary'
	| 'swapping'
	| 'verifying'
	| 'rolling-back'
	| 'done';

export type SelfUpdateOutcome =
	| 'updated'
	| 'up-to-date'
	| 'skipped'
	| 'build-failed'
	| 'canary-failed'
	| 'rolled-back'
	| 'error';

export interface SelfUpdateStatus {
	running: boolean;
	trigger: 'dashboard' | 'cli';
	/** How this run obtains the release; absent on status files from older updaters. */
	method?: SelfUpdateMethod;
	phase: SelfUpdatePhase;
	message: string;
	outcome?: SelfUpdateOutcome;
	fromVersion: string | null;
	toVersion: string | null;
	startedAt: string;
	updatedAt: string;
	finishedAt?: string;
}

/** A run that has not written progress for this long is treated as dead (updater crashed). */
export const SELF_UPDATE_STALE_MS = 60 * 60 * 1000;

/** Lines the dashboard asks for by default; also the server-side cap on one response. */
export const SELF_UPDATE_LOG_LINES = 400;

export type SelfUpdateLogLevel = 'info' | 'warn' | 'error' | 'command' | 'output' | 'phase';

/** One line of `/var/lib/skiff-update/update.log` (JSON Lines on disk). */
export interface SelfUpdateLogLine {
	/** ISO timestamp written by the updater. */
	at: string;
	level: SelfUpdateLogLevel;
	text: string;
}

export interface SelfUpdateLog {
	lines: SelfUpdateLogLine[];
	/** False before the first update (or after a host rebuilt the directory). */
	exists: boolean;
	/** Older lines were dropped: the file is larger than the read window or the line cap. */
	truncated: boolean;
	/** File mtime, so the page can tell a live log from yesterday's. */
	updatedAt: string | null;
}
