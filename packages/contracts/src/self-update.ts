/**
 * The contract between the dashboard and the root-owned self-updater (docs/OPS.md §4.1).
 *
 * The control plane runs unprivileged and sandboxed, so it cannot update (or restart) itself.
 * Instead it drops `requestFile`; a systemd path unit notices and starts
 * `skiff-update-self.service` as root, which deletes the request, runs the updater and keeps
 * `statusFile` current. The request carries no data the updater trusts: it is only a trigger,
 * and the updater re-checks the version on GitHub itself. The exceptions are the install method
 * and the release channel: allowlisted enums written to sidecar files (see
 * {@link SELF_UPDATE_METHODS}, {@link SELF_UPDATE_CHANNELS}), because a systemd unit cannot pass
 * form data through to the updater, plus approvals of destructive migrations, each bound to the
 * hash of the SQL the updater reported ({@link selfUpdateApprovalFile}).
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
	/** The host's release channel, persisted by the updater (root:skiff 0640, group-readable). */
	channelFile: '/var/lib/skiff-update/channel',
} as const;

/**
 * Release channels (docs/OPS.md §4.1, *Release channels*). Every `VERSION` bump on `main` is
 * published as a signed GitHub **prerelease**: the canary. The Promote workflow flips a canary
 * to a full release with the same signed bits: stable. `canary` hosts install the newest of
 * either; `stable` hosts only full releases. GitHub Releases is the whole channel feed, so no
 * update server is involved.
 */
export const SELF_UPDATE_CHANNELS = ['canary', 'stable'] as const;
export type SelfUpdateChannel = (typeof SELF_UPDATE_CHANNELS)[number];

/** Canary is the default path: a host follows every release unless it opts into stable. */
export const DEFAULT_SELF_UPDATE_CHANNEL: SelfUpdateChannel = 'canary';

export function isSelfUpdateChannel(value: unknown): value is SelfUpdateChannel {
	return typeof value === 'string' && (SELF_UPDATE_CHANNELS as readonly string[]).includes(value);
}

/** Whether a published GitHub release belongs to `channel` (canary sees stable releases too). */
export function releaseInChannel(
	release: { draft?: boolean; prerelease?: boolean },
	channel: SelfUpdateChannel
): boolean {
	if (release.draft) return false;
	return channel === 'canary' || !release.prerelease;
}

/** The channel sidecar the control plane writes beside the request; the updater consumes it. */
export function selfUpdateChannelFile(requestFile: string): string {
	return `${requestFile}.channel`;
}

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

/**
 * Destructive migrations approved from the dashboard (`request.approve`). The updater refuses a
 * destructive migration unattended and reports it in the status ({@link SelfUpdateApproval}); an
 * admin reviews the SQL and approves it. Each approval names the migration and the SHA-256 of
 * the exact SQL that was shown, so the updater accepts it only for that file: a release whose
 * migration changed, or that adds another destructive one, is refused again.
 */
export function selfUpdateApprovalFile(requestFile: string): string {
	return `${requestFile}.approve`;
}

export interface MigrationApproval {
	id: string;
	sha256: string;
}

const MIGRATION_ID = /^[0-9]{4}_[a-z0-9_]{1,80}\.sql$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_APPROVALS = 50;

export function isMigrationApproval(value: unknown): value is MigrationApproval {
	const entry = value as MigrationApproval | null;
	return (
		typeof entry === 'object' &&
		entry !== null &&
		typeof entry.id === 'string' &&
		MIGRATION_ID.test(entry.id) &&
		typeof entry.sha256 === 'string' &&
		SHA256.test(entry.sha256)
	);
}

/** The approval sidecar body: one `<id> <sha256>` per line. */
export function formatMigrationApprovals(approvals: MigrationApproval[]): string {
	return approvals.map((approval) => `${approval.id} ${approval.sha256}`).join('\n');
}

/** Parse the sidecar; null when any line is malformed, so a bad file approves nothing. */
export function parseMigrationApprovals(text: string): MigrationApproval[] | null {
	const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
	if (lines.length === 0 || lines.length > MAX_APPROVALS) return null;
	const approvals: MigrationApproval[] = [];
	for (const line of lines) {
		const [id, sha256, extra] = line.split(/\s+/);
		const entry = { id, sha256 };
		if (extra !== undefined || !isMigrationApproval(entry)) return null;
		approvals.push(entry);
	}
	return approvals;
}

/** A destructive migration the updater refused, as the dashboard's review dialog shows it. */
export interface SelfUpdateApprovalMigration extends MigrationApproval {
	/** What makes it destructive, with the line in `sql`. */
	statements: Array<{ line: number; statement: string }>;
	/** The migration's SQL, capped at {@link SELF_UPDATE_APPROVAL_SQL_BYTES}. */
	sql: string;
	truncated: boolean;
}

export const SELF_UPDATE_APPROVAL_SQL_BYTES = 64 * 1024;

/** Set on the status when a release waits for destructive migrations to be approved. */
export interface SelfUpdateApproval {
	version: string;
	migrations: SelfUpdateApprovalMigration[];
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
	/** The channel this run followed; absent on status files from older updaters. */
	channel?: SelfUpdateChannel;
	phase: SelfUpdatePhase;
	message: string;
	outcome?: SelfUpdateOutcome;
	fromVersion: string | null;
	toVersion: string | null;
	startedAt: string;
	updatedAt: string;
	finishedAt?: string;
	/** The release was refused until these destructive migrations are approved. */
	approval?: SelfUpdateApproval;
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
