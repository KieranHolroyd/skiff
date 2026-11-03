/**
 * The contract between the dashboard and the root-owned self-updater (docs/OPS.md §4.1).
 *
 * The control plane runs unprivileged and sandboxed, so it cannot update (or restart) itself.
 * Instead it drops `requestFile`; a systemd path unit notices and starts
 * `skiff-update-self.service` as root, which deletes the request, runs the updater and keeps
 * `statusFile` current. The request carries no data the updater trusts: it is only a trigger,
 * and the updater re-checks the version on GitHub itself.
 */

export const SELF_UPDATE_DEFAULTS = {
	/** Written by the control plane (skiff-owned directory). */
	requestFile: '/var/lib/skiff/update/request',
	/** Written by the updater (root-owned directory, group skiff can read). */
	statusFile: '/var/lib/skiff-update/status.json',
	/** Its presence means dashboard-triggered updates are wired up on this host. */
	pathUnit: '/etc/systemd/system/skiff-update-self.path',
	/** Release metadata of the active release (repo/ref the updater pulls from). */
	releaseMeta: '/opt/skiff/current/meta.json',
} as const;

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
