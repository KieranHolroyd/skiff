/**
 * Skiff self-updater: orchestration.
 *
 * Invariant: a release that has been proven to serve is always either running or one atomic
 * symlink swap away. Concretely:
 *
 *   /opt/skiff/current  -> the release serving now
 *   /opt/skiff/previous -> the release that served before it (kept until the next good update)
 *
 * An update builds the new release next to the running one, boots it in isolation against a
 * copy of the live database (canary), and only then stops the control plane, snapshots SQLite,
 * swaps `current`, starts and health-checks. Any failure after the swap restores the snapshot,
 * the old `current`/`previous` links and restarts the old release.
 *
 * Every switch (update or rollback) records `{ from, to, snapshot }`, where `snapshot` is the
 * database exactly as `from` left it. That makes every switch reversible, including a rollback.
 *
 * All side effects on the machine go through `Host` so this file can be tested without systemd.
 */
import { Database } from 'bun:sqlite';
import {
	chmodSync,
	closeSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
	writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { compareSemver, parseSemver } from '../../packages/contracts/src/semver.ts';
import { linkAgentCommands } from '../systemd/builder.ts';

export const CONTROL_PLANE = 'skiff-control-plane.service';
export const AGENT = 'skiff-agent.service';
export const LITESTREAM = 'skiff-litestream.service';
export const DEFAULT_REPO = 'KieranHolroyd/skiff';
export const DEFAULT_REF = 'main';

export interface Layout {
	optDir: string;
	releasesDir: string;
	currentLink: string;
	previousLink: string;
	dbPath: string;
	backupsDir: string;
	canaryDir: string;
	stateFile: string;
	lockFile: string;
	bunBin: string;
	controlPlaneUnitFile: string;
}

export function layoutFromEnv(env: Record<string, string | undefined> = process.env): Layout {
	const optDir = env.SKIFF_OPT_DIR ?? '/opt/skiff';
	const varDir = env.SKIFF_VAR_DIR ?? '/var/lib/skiff';
	const systemdDir = env.SKIFF_SYSTEMD_DIR ?? '/etc/systemd/system';
	return {
		optDir,
		releasesDir: join(optDir, 'releases'),
		currentLink: join(optDir, 'current'),
		previousLink: join(optDir, 'previous'),
		dbPath: join(varDir, 'data', 'skiff.db'),
		backupsDir: join(varDir, 'backups'),
		canaryDir: join(varDir, 'update-canary'),
		stateFile: join(optDir, 'update-state.json'),
		lockFile: join(optDir, 'update.lock'),
		bunBin: env.SKIFF_BUN_BIN ?? join(optDir, 'runtime', 'bin', 'bun'),
		controlPlaneUnitFile: join(systemdDir, CONTROL_PLANE),
	};
}

export type UpdatePhase = 'checking' | 'building' | 'canary' | 'swapping' | 'verifying' | 'rolling-back';

/** Machine side effects. The real implementation lives in main.ts. */
export interface Host {
	log(message: string): void;
	warn(message: string): void;
	now(): Date;
	sleep(ms: number): Promise<void>;
	/** Resolve a branch/tag/sha to a full commit sha. */
	resolveCommit(repo: string, ref: string): Promise<string>;
	/** Contents of the repository-root `VERSION` file at `commit`. */
	readVersionFile(repo: string, commit: string): Promise<string>;
	/** Progress for the dashboard (main.ts writes it to the status file). */
	phase(phase: UpdatePhase, detail: string, versions?: Partial<Versions>): void;
	/** Download and extract the source tree of `commit` into `dest` (created empty). */
	fetchSource(repo: string, commit: string, dest: string): Promise<void>;
	/** Install dependencies and build the control plane and agent inside `repoDir`. */
	build(repoDir: string): Promise<void>;
	/**
	 * Boot `release` in isolation (own socket, own data dir at `scratchDir/data`, no outbound
	 * notifications) and resolve once it answers health checks; reject with logs otherwise.
	 */
	canary(release: string, scratchDir: string): Promise<void>;
	start(unit: string): Promise<void>;
	stop(unit: string): Promise<void>;
	restart(unit: string): Promise<void>;
	isActive(unit: string): Promise<boolean>;
	/** systemd NRestarts (automatic restarts since the last manual start). */
	restartCount(unit: string): Promise<number>;
	/** Poll the production control-plane socket until healthy or `timeoutMs` elapses. */
	controlPlaneHealthy(timeoutMs: number): Promise<boolean>;
	/** Poll the public platform URL (through Caddy) until healthy or `timeoutMs` elapses. */
	publicHealthy(timeoutMs: number): Promise<boolean>;
	agentEnrolled(): boolean;
	/** chown -R skiff:skiff */
	chownToSkiff(path: string): void;
	freeBytes(path: string): number;
	/** Ignore SIGINT/SIGTERM/SIGHUP while the swap is in flight. */
	enterCritical(): void;
	leaveCritical(): void;
}

export interface ReleaseMeta {
	version?: string;
	builtAt?: string;
	source?: string;
	repo?: string;
	ref?: string;
	commit?: string;
	status?: 'staged' | 'active' | 'failed';
	activatedAt?: string;
}

export interface Switch {
	kind: 'update' | 'rollback';
	/** Release that was serving before the switch. */
	from: string;
	/** Release activated by the switch. */
	to: string;
	/** What `previous` pointed at before the switch (restored if the switch is reverted). */
	previousBefore: string | null;
	/** The database exactly as `from` left it. */
	snapshot: string | null;
	commit?: string;
	withAgent: boolean;
	at: string;
}

export interface UpdateState {
	inProgress?: Switch;
	lastSwitch?: Switch;
	/** Commits whose release failed the canary or the live health check. Skipped unless --force. */
	failedCommits: Record<string, { at: string; release: string; reason: string }>;
}

export interface UpdateOptions {
	repo?: string;
	ref?: string;
	force?: boolean;
	withAgent?: boolean;
	canary?: boolean;
	dryRun?: boolean;
	/** `auto`: require the public URL after the swap only if it was healthy before. */
	publicCheck?: 'auto' | 'require' | 'skip';
	minFreeBytes?: number;
	healthTimeoutMs?: number;
	stabilizeMs?: number;
}

export interface RollbackOptions {
	/** Restore the snapshot recorded when the current release was activated (loses later writes). */
	restoreDb?: boolean;
	/** Run the previous code against the current database even if its schema is newer. */
	keepDb?: boolean;
	withAgent?: boolean;
	dryRun?: boolean;
	healthTimeoutMs?: number;
	stabilizeMs?: number;
}

/** `version`: the semver at the resolved commit; `fromVersion`: the running release's, if known. */
export interface Versions {
	version: string;
	fromVersion: string | null;
}

export type UpdateResult = Versions &
	(
	| { status: 'up-to-date'; commit: string }
	| { status: 'skipped'; commit: string; reason: string }
	| { status: 'dry-run'; commit: string; plan: string[] }
	| { status: 'build-failed'; commit: string; reason: string }
	| { status: 'canary-failed'; commit: string; reason: string }
	| { status: 'updated'; commit: string; release: string; previous: string }
	| { status: 'rolled-back'; commit: string; reason: string; recovered: boolean }
	);

export interface CheckResult extends Versions {
	repo: string;
	ref: string;
	commit: string;
	/** `version` is newer than the running release (or the running version is unknown). */
	available: boolean;
	/** Set when this commit already failed to install; the updater skips it until --force. */
	failed?: string;
}

export type RollbackResult =
	| { status: 'dry-run'; plan: string[] }
	| { status: 'rolled-back'; release: string; previous: string; restoredDb: boolean }
	| { status: 'reverted'; reason: string; recovered: boolean };

export class UpdateError extends Error {}
/** The switch was reverted but the old release did not come back healthy. Needs a human. */
export class RecoveryError extends UpdateError {}

const DEFAULTS = {
	minFreeBytes: 2 * 1024 ** 3,
	healthTimeoutMs: 90_000,
	stabilizeMs: 10_000,
};

export class Updater {
	constructor(
		private readonly layout: Layout,
		private readonly host: Host,
	) {}

	// ---------------------------------------------------------------- update

	async update(options: UpdateOptions = {}): Promise<UpdateResult> {
		return this.locked(async () => {
			await this.recoverInterrupted();
			const { host, layout } = this;
			const current = readLink(layout.currentLink);
			if (!current) throw new UpdateError(`No active release at ${layout.currentLink}. Run the installer first.`);
			const currentMeta = readMeta(current);
			const repo = options.repo ?? currentMeta.repo ?? DEFAULT_REPO;
			const ref = options.ref ?? currentMeta.ref ?? DEFAULT_REF;

			host.log(`current release ${basename(current)} (${currentMeta.version ?? 'unknown version'}, ${short(currentMeta.commit) || 'unknown commit'})`);
			host.phase('checking', `Checking ${repo}@${ref}`);
			const { commit, version, fromVersion } = await this.resolve(repo, ref, currentMeta);
			const v: Versions = { version, fromVersion };
			host.phase('checking', `Latest is ${version}; running ${fromVersion ?? 'an unversioned release'}`, v);

			if (!options.force && fromVersion) {
				const order = compareSemver(version, fromVersion);
				if (order <= 0) {
					host.log(
						order === 0
							? `already on ${version}`
							: `${repo}@${ref} is at ${version}, older than the running ${fromVersion}; not downgrading (use rollback, or --force)`,
					);
					return { status: 'up-to-date', commit, ...v };
				}
			}
			if (!fromVersion) host.warn(`the current release has no semantic version; installing ${version}`);
			else if (options.force && compareSemver(version, fromVersion) < 0)
				host.warn(`downgrading ${fromVersion} -> ${version} (--force); forward-only migrations may not undo cleanly`);
			host.log(`${fromVersion ?? 'unknown'} -> ${version} (${short(commit)})`);

			const state = this.readState();
			const failed = state.failedCommits[commit];
			if (!options.force && failed) {
				const reason = `${version} (${short(commit)}) failed on ${failed.at} (${failed.reason}); pass --force to retry`;
				host.warn(reason);
				return { status: 'skipped', commit, reason, ...v };
			}

			const name = releaseName(host.now(), commit);
			const release = join(layout.releasesDir, name);
			if (options.dryRun) {
				const plan = [
					`build ${repo}@${short(commit)} (${version}) into ${release}`,
					options.canary === false ? 'skip the canary' : 'boot a canary against a copy of the database',
					`stop ${CONTROL_PLANE}, snapshot ${layout.dbPath}`,
					`${layout.previousLink} -> ${current}`,
					`${layout.currentLink} -> ${release}`,
					`start ${CONTROL_PLANE}${options.withAgent ? ` and restart ${AGENT}` : ''}, health-check, roll back on failure`,
					'prune releases other than current and previous',
				];
				for (const line of plan) host.log(`would ${line}`);
				return { status: 'dry-run', commit, plan, ...v };
			}

			const free = host.freeBytes(layout.optDir);
			const minFree = options.minFreeBytes ?? DEFAULTS.minFreeBytes;
			if (free < minFree)
				throw new UpdateError(`Only ${gib(free)} free under ${layout.optDir}; at least ${gib(minFree)} is needed to build.`);

			// 1. Build next to the running release. Nothing serving is touched until this succeeds.
			try {
				await this.stage(release, { repo, ref, commit, version });
			} catch (error) {
				const reason = message(error);
				host.warn(`build failed; ${basename(current)} is still serving untouched: ${reason}`);
				return { status: 'build-failed', commit, reason, ...v };
			}

			// 2. Boot it in isolation against a copy of the live database.
			if (options.canary !== false) {
				try {
					await this.runCanary(release);
				} catch (error) {
					const reason = message(error);
					host.warn(`canary failed; ${basename(current)} is still serving untouched`);
					rmSync(release, { recursive: true, force: true });
					this.recordFailure(commit, name, `canary: ${firstLine(reason)}`);
					return { status: 'canary-failed', commit, reason, ...v };
				}
			}

			// 3. Swap, verify, keep or revert.
			const publicCheck = options.publicCheck ?? 'auto';
			const requirePublic =
				publicCheck === 'require' || (publicCheck === 'auto' && (await host.publicHealthy(10_000)));
			if (publicCheck === 'auto')
				host.log(requirePublic ? 'public URL is healthy; it must stay healthy after the swap' : 'public URL is not reachable now; it will not gate the swap');
			const result = await this.activate({ current, release, commit, requirePublic, options });
			return { ...result, ...v };
		});
	}

	/** Read-only: what would `update` install? Does not take the lock or touch the machine. */
	async check(options: Pick<UpdateOptions, 'repo' | 'ref'> = {}): Promise<CheckResult> {
		const current = readLink(this.layout.currentLink);
		const currentMeta = current ? readMeta(current) : {};
		const repo = options.repo ?? currentMeta.repo ?? DEFAULT_REPO;
		const ref = options.ref ?? currentMeta.ref ?? DEFAULT_REF;
		const resolved = await this.resolve(repo, ref, currentMeta);
		const failed = this.readState().failedCommits[resolved.commit];
		return {
			repo,
			ref,
			...resolved,
			available: !resolved.fromVersion || compareSemver(resolved.version, resolved.fromVersion) > 0,
			...(failed ? { failed: `${failed.at}: ${failed.reason}` } : {}),
		};
	}

	private async resolve(repo: string, ref: string, currentMeta: ReleaseMeta): Promise<{ commit: string } & Versions> {
		if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new UpdateError(`Invalid repository "${repo}" (expected owner/name).`);
		if (!/^[\w./-]+$/.test(ref) || ref.includes('..')) throw new UpdateError(`Invalid ref "${ref}".`);
		const commit = await this.host.resolveCommit(repo, ref);
		if (!/^[0-9a-f]{40}$/.test(commit)) throw new UpdateError(`GitHub returned an invalid commit "${commit}".`);
		// Read VERSION at the exact commit we would build, so the version and the code always agree.
		const raw = await this.host.readVersionFile(repo, commit);
		const parsed = parseSemver(raw);
		if (!parsed)
			throw new UpdateError(
				`VERSION at ${repo}@${short(commit)} is not a semantic version: "${raw.trim().slice(0, 40)}"`,
			);
		return { commit, version: parsed.version, fromVersion: parseSemver(currentMeta.version)?.version ?? null };
	}

	private async stage(
		release: string,
		source: { repo: string; ref: string; commit: string; version: string },
	): Promise<void> {
		const { host, layout } = this;
		mkdirSync(layout.releasesDir, { recursive: true });
		// Leftovers from an interrupted build are safe to remove: we hold the lock.
		for (const entry of readdirSync(layout.releasesDir))
			if (entry.startsWith('.staging-')) rmSync(join(layout.releasesDir, entry), { recursive: true, force: true });
		const staging = join(layout.releasesDir, `.staging-${basename(release)}`);
		mkdirSync(staging, { recursive: true });
		try {
			const repoDir = join(staging, 'repo');
			mkdirSync(repoDir);
			host.phase('building', `Downloading and building ${source.version}`);
			host.log(`downloading ${source.repo}@${short(source.commit)}`);
			await host.fetchSource(source.repo, source.commit, repoDir);
			host.log('building');
			await host.build(repoDir);
			assembleRelease(staging, layout.bunBin);
			const missing = verifyRelease(staging, layout);
			if (missing.length) throw new UpdateError(`the new release is missing ${missing.join(', ')}`);
			writeMeta(staging, {
				version: source.version,
				builtAt: host.now().toISOString(),
				source: source.ref,
				repo: source.repo,
				ref: source.ref,
				commit: source.commit,
				status: 'staged',
			});
			renameSync(staging, release);
			host.log(`staged ${release}`);
		} catch (error) {
			rmSync(staging, { recursive: true, force: true });
			throw error;
		}
	}

	private async runCanary(release: string): Promise<void> {
		const { host, layout } = this;
		const scratch = join(layout.canaryDir, basename(release));
		rmSync(scratch, { recursive: true, force: true });
		mkdirSync(join(scratch, 'data'), { recursive: true });
		try {
			if (existsSync(layout.dbPath)) {
				snapshotDb(layout.dbPath, join(scratch, 'data', 'skiff.db'));
				fixSidecarOwnership(layout.dbPath, host);
			}
			host.chownToSkiff(scratch);
			host.phase('canary', 'Test-booting the new release against a copy of the database');
			host.log('booting canary against a copy of the database');
			await host.canary(release, scratch);
			host.log('canary is healthy');
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	}

	private async activate(input: {
		current: string;
		release: string;
		commit: string;
		requirePublic: boolean;
		options: UpdateOptions;
	}): Promise<
		| { status: 'updated'; commit: string; release: string; previous: string }
		| { status: 'rolled-back'; commit: string; reason: string; recovered: boolean }
	> {
		const { host, layout } = this;
		const { current, release, commit, options } = input;
		const withAgent = Boolean(options.withAgent);
		const sw: Switch = {
			kind: 'update',
			from: current,
			to: release,
			previousBefore: readLink(layout.previousLink),
			snapshot: null,
			commit,
			withAgent,
			at: host.now().toISOString(),
		};

		host.enterCritical();
		try {
			host.phase('swapping', 'Restarting the control plane on the new release');
			host.log(`stopping ${CONTROL_PLANE}`);
			await host.stop(CONTROL_PLANE);
			sw.snapshot = this.takeSnapshot(`pre-update-${basename(release)}`);
			this.writeState({ ...this.readState(), inProgress: sw });

			// `previous` first: if we die between the two renames, both links still name good releases.
			setLink(layout.previousLink, current);
			setLink(layout.currentLink, release);
			host.log(`${layout.currentLink} -> ${release}`);

			await host.start(CONTROL_PLANE);
			if (withAgent && host.agentEnrolled()) await host.restart(AGENT);

			host.phase('verifying', 'Waiting for the new release to prove it is healthy');
			const problem = await this.verifyLive({
				requirePublic: input.requirePublic,
				withAgent,
				healthTimeoutMs: options.healthTimeoutMs,
				stabilizeMs: options.stabilizeMs,
			});
			if (!problem) {
				this.finish(sw);
				writeMeta(release, { ...readMeta(release), status: 'active', activatedAt: host.now().toISOString() });
				this.prune();
				host.log(`updated to ${basename(release)}; ${basename(current)} kept as previous`);
				return { status: 'updated', commit, release, previous: current };
			}

			host.warn(`${basename(release)} is unhealthy (${problem}); rolling back`);
			host.phase('rolling-back', `Rolling back: ${problem}`);
			const recovered = await this.revert(sw);
			this.recordFailure(commit, basename(release), problem);
			if (recovered) rmSync(release, { recursive: true, force: true });
			return { status: 'rolled-back', commit, reason: problem, recovered };
		} catch (error) {
			if (this.readState().inProgress) {
				host.warn(`update failed mid-swap (${message(error)}); rolling back`);
				if (!(await this.revert(sw))) throw new RecoveryError(`${message(error)}; reverting also failed`);
			} else {
				// Failed before the links moved: the old release is still `current`, just bring it back.
				host.warn(`update failed before the swap (${message(error)}); restarting ${basename(current)}`);
				await host.start(CONTROL_PLANE).catch(() => undefined);
			}
			throw error;
		} finally {
			host.leaveCritical();
		}
	}

	// -------------------------------------------------------------- rollback

	async rollback(options: RollbackOptions = {}): Promise<RollbackResult> {
		return this.locked(async () => {
			await this.recoverInterrupted();
			const { host, layout } = this;
			const current = readLink(layout.currentLink);
			const previous = readLink(layout.previousLink);
			if (!current) throw new UpdateError(`No active release at ${layout.currentLink}.`);
			if (!previous) throw new UpdateError(`No previous release at ${layout.previousLink}; nothing to roll back to.`);
			if (previous === current) throw new UpdateError('previous and current point at the same release.');
			const missing = verifyRelease(previous, layout);
			if (missing.length) throw new UpdateError(`${basename(previous)} is incomplete (missing ${missing.join(', ')}).`);
			if (options.restoreDb && options.keepDb) throw new UpdateError('--restore-db and --keep-db are mutually exclusive.');

			const state = this.readState();
			let restore: string | null = null;
			if (options.restoreDb) {
				const last = state.lastSwitch;
				if (!last || last.to !== current || last.from !== previous || !last.snapshot || !existsSync(last.snapshot))
					throw new UpdateError(
						`No database snapshot is recorded for the switch ${basename(previous)} -> ${basename(current)}.`,
					);
				restore = last.snapshot;
			} else if (!options.keepDb) {
				const unknown = unknownMigrations(layout.dbPath, previous);
				if (unknown === null)
					throw new UpdateError(
						`Cannot tell which migrations ${basename(previous)} ships. Pass --restore-db or --keep-db.`,
					);
				if (unknown.length) {
					const at = state.lastSwitch?.to === current ? ` taken ${state.lastSwitch.at}` : '';
					throw new UpdateError(
						`The database has migrations ${basename(previous)} does not know (${unknown.join(', ')}).\n` +
							`  --restore-db  restore the snapshot${at} (writes since then are lost; a copy of the current database is kept)\n` +
							'  --keep-db     run the old code against the newer schema',
					);
				}
			}

			if (options.dryRun) {
				const plan = [
					`stop ${CONTROL_PLANE}, snapshot ${layout.dbPath}`,
					...(restore ? [`restore ${restore}`] : []),
					`${layout.currentLink} -> ${previous}`,
					`${layout.previousLink} -> ${current}`,
					`start ${CONTROL_PLANE}, health-check, undo on failure`,
				];
				for (const line of plan) host.log(`would ${line}`);
				return { status: 'dry-run', plan };
			}

			const withAgent = Boolean(options.withAgent);
			const sw: Switch = {
				kind: 'rollback',
				from: current,
				to: previous,
				previousBefore: previous,
				snapshot: null,
				withAgent,
				at: host.now().toISOString(),
			};
			host.enterCritical();
			try {
				await host.stop(CONTROL_PLANE);
				sw.snapshot = this.takeSnapshot(`pre-rollback-${stamp(host.now())}`);
				this.writeState({ ...this.readState(), inProgress: sw });
				if (restore) await this.restoreDatabase(restore);
				setLink(layout.currentLink, previous);
				setLink(layout.previousLink, current);
				host.log(`${layout.currentLink} -> ${previous}`);
				await host.start(CONTROL_PLANE);
				if (withAgent && host.agentEnrolled()) await host.restart(AGENT);
				const problem = await this.verifyLive({
					requirePublic: false,
					withAgent,
					healthTimeoutMs: options.healthTimeoutMs,
					stabilizeMs: options.stabilizeMs,
				});
				if (!problem) {
					this.finish(sw);
					this.pruneSnapshots();
					host.log(`rolled back to ${basename(previous)}; run rollback again to return to ${basename(current)}`);
					return { status: 'rolled-back', release: previous, previous: current, restoredDb: Boolean(restore) };
				}
				host.warn(`${basename(previous)} is unhealthy (${problem}); returning to ${basename(current)}`);
				const recovered = await this.revert(sw);
				return { status: 'reverted', reason: problem, recovered };
			} catch (error) {
				if (this.readState().inProgress) {
					host.warn(`rollback failed mid-swap (${message(error)}); returning to ${basename(current)}`);
					if (!(await this.revert(sw))) throw new RecoveryError(`${message(error)}; reverting also failed`);
				} else {
					host.warn(`rollback failed before the swap (${message(error)}); restarting ${basename(current)}`);
					await host.start(CONTROL_PLANE).catch(() => undefined);
				}
				throw error;
			} finally {
				host.leaveCritical();
			}
		});
	}

	// ---------------------------------------------------------------- status

	status(): {
		current: { path: string; meta: ReleaseMeta } | null;
		previous: { path: string; meta: ReleaseMeta } | null;
		state: UpdateState;
		releases: string[];
	} {
		const { layout } = this;
		const current = readLink(layout.currentLink);
		const previous = readLink(layout.previousLink);
		return {
			current: current ? { path: current, meta: readMeta(current) } : null,
			previous: previous ? { path: previous, meta: readMeta(previous) } : null,
			state: this.readState(),
			releases: existsSync(layout.releasesDir) ? readdirSync(layout.releasesDir).sort() : [],
		};
	}

	// --------------------------------------------------------------- helpers

	/** Health after a swap: answers, stays up without crash-restarts, optionally public + agent. */
	private async verifyLive(input: {
		requirePublic: boolean;
		withAgent: boolean;
		healthTimeoutMs?: number;
		stabilizeMs?: number;
	}): Promise<string | null> {
		const { host } = this;
		const timeout = input.healthTimeoutMs ?? DEFAULTS.healthTimeoutMs;
		if (!(await host.controlPlaneHealthy(timeout))) return 'control plane did not answer health checks';
		const restarts = await host.restartCount(CONTROL_PLANE);
		await host.sleep(input.stabilizeMs ?? DEFAULTS.stabilizeMs);
		if (!(await host.isActive(CONTROL_PLANE)) || (await host.restartCount(CONTROL_PLANE)) !== restarts)
			return 'control plane crashed after becoming healthy';
		if (!(await host.controlPlaneHealthy(5_000))) return 'control plane stopped answering health checks';
		if (input.requirePublic && !(await host.publicHealthy(60_000))) return 'public platform URL stopped answering';
		if (input.withAgent && host.agentEnrolled() && !(await host.isActive(AGENT))) return 'agent is not running';
		return null;
	}

	/** Undo a switch: database as `from` left it, links as they were, `from` running. */
	private async revert(sw: Switch): Promise<boolean> {
		const { host, layout } = this;
		try {
			await host.stop(CONTROL_PLANE);
			if (sw.snapshot && existsSync(sw.snapshot)) await this.restoreDatabase(sw.snapshot);
			setLink(layout.currentLink, sw.from);
			if (sw.previousBefore && existsSync(sw.previousBefore) && sw.previousBefore !== sw.from)
				setLink(layout.previousLink, sw.previousBefore);
			else rmSync(layout.previousLink, { force: true });
			await host.start(CONTROL_PLANE);
			if (sw.withAgent && host.agentEnrolled()) await host.restart(AGENT);
			const problem = await this.verifyLive({ requirePublic: false, withAgent: sw.withAgent });
			const state = this.readState();
			delete state.inProgress;
			this.writeState(state);
			if (problem) {
				host.warn(`${basename(sw.from)} is also unhealthy after reverting (${problem}). Check journalctl -u ${CONTROL_PLANE}.`);
				return false;
			}
			host.log(`${basename(sw.from)} is serving again`);
			return true;
		} catch (error) {
			host.warn(`revert failed: ${message(error)}. Inspect ${layout.stateFile} and journalctl -u ${CONTROL_PLANE}.`);
			return false;
		}
	}

	/**
	 * A previous run died between stopping the control plane and recording the outcome (SSH drop,
	 * OOM, reboot). Keep the new release if it is healthy, otherwise revert.
	 */
	private async recoverInterrupted(): Promise<void> {
		const { host, layout } = this;
		const sw = this.readState().inProgress;
		if (!sw) return;
		host.warn(`an earlier ${sw.kind} (${basename(sw.from)} -> ${basename(sw.to)}) did not finish; recovering`);
		host.enterCritical();
		try {
			if (readLink(layout.currentLink) === sw.to) {
				if (!(await host.isActive(CONTROL_PLANE))) await host.start(CONTROL_PLANE);
				const problem = await this.verifyLive({ requirePublic: false, withAgent: false });
				if (!problem) {
					host.log(`${basename(sw.to)} is healthy; keeping it`);
					this.finish(sw);
					if (sw.kind === 'update') writeMeta(sw.to, { ...readMeta(sw.to), status: 'active', activatedAt: host.now().toISOString() });
					return;
				}
				host.warn(`${basename(sw.to)} is unhealthy (${problem}); reverting to ${basename(sw.from)}`);
				const recovered = await this.revert(sw);
				if (sw.kind === 'update' && sw.commit) this.recordFailure(sw.commit, basename(sw.to), problem);
				if (!recovered) throw new RecoveryError('Recovery failed; fix the control plane manually before updating again.');
				return;
			}
			// The swap never happened. Put `previous` back and make sure the control plane runs.
			if (sw.previousBefore && existsSync(sw.previousBefore)) setLink(layout.previousLink, sw.previousBefore);
			else if (readLink(layout.previousLink) === sw.from) rmSync(layout.previousLink, { force: true });
			if (!(await host.isActive(CONTROL_PLANE))) await host.start(CONTROL_PLANE);
			const state = this.readState();
			delete state.inProgress;
			this.writeState(state);
		} finally {
			host.leaveCritical();
		}
	}

	private finish(sw: Switch): void {
		const state = this.readState();
		delete state.inProgress;
		state.lastSwitch = sw;
		this.writeState(state);
	}

	private takeSnapshot(name: string): string | null {
		const { host, layout } = this;
		if (!existsSync(layout.dbPath)) return null;
		const path = join(layout.backupsDir, `${name}.db`);
		snapshotDb(layout.dbPath, path);
		chmodSync(path, 0o640);
		host.chownToSkiff(path);
		fixSidecarOwnership(layout.dbPath, host);
		host.log(`database snapshot ${path}`);
		return path;
	}

	/** Replace the live database with `snapshot`. Litestream is paused so it starts a clean generation. */
	private async restoreDatabase(snapshot: string): Promise<void> {
		const { host, layout } = this;
		const litestream = await host.isActive(LITESTREAM);
		if (litestream) await host.stop(LITESTREAM);
		try {
			restoreDbFile(snapshot, layout.dbPath);
			host.chownToSkiff(layout.dbPath);
			host.log(`database restored from ${snapshot}`);
		} finally {
			if (litestream) await host.start(LITESTREAM);
		}
	}

	private recordFailure(commit: string, release: string, reason: string): void {
		const state = this.readState();
		state.failedCommits[commit] = { at: this.host.now().toISOString(), release, reason };
		this.writeState(state);
	}

	/** Keep exactly `current` and `previous`; remove other releases and superseded snapshots. */
	private prune(): void {
		const { host, layout } = this;
		const keep = new Set([readLink(layout.currentLink), readLink(layout.previousLink)].filter(Boolean));
		for (const entry of readdirSync(layout.releasesDir)) {
			const path = join(layout.releasesDir, entry);
			let real: string;
			try {
				real = realpathSync(path);
			} catch {
				real = path;
			}
			if (keep.has(real)) continue;
			rmSync(path, { recursive: true, force: true });
			host.log(`pruned release ${entry}`);
		}
		this.pruneSnapshots();
	}

	private pruneSnapshots(): void {
		const { layout } = this;
		if (!existsSync(layout.backupsDir)) return;
		const keep = this.readState().lastSwitch?.snapshot;
		for (const entry of readdirSync(layout.backupsDir)) {
			if (!/^pre-(update|rollback)-.+\.db$/.test(entry)) continue;
			const path = join(layout.backupsDir, entry);
			if (path !== keep) rmSync(path, { force: true });
		}
	}

	private readState(): UpdateState {
		if (!existsSync(this.layout.stateFile)) return { failedCommits: {} };
		const parsed = JSON.parse(readFileSync(this.layout.stateFile, 'utf8')) as Partial<UpdateState>;
		return { ...parsed, failedCommits: parsed.failedCommits ?? {} };
	}

	private writeState(state: UpdateState): void {
		writeAtomic(this.layout.stateFile, `${JSON.stringify(state, null, 2)}\n`);
	}

	private async locked<T>(fn: () => Promise<T>): Promise<T> {
		const release = acquireLock(this.layout.lockFile);
		try {
			return await fn();
		} finally {
			release();
		}
	}
}

// ------------------------------------------------------------------- pure helpers

export function releaseName(date: Date, commit: string): string {
	return `${stamp(date)}-${commit.slice(0, 12)}`;
}

function stamp(date: Date): string {
	return date.toISOString().replace(/[^0-9]/g, '').slice(0, 14);
}

function short(commit: string | undefined): string {
	return commit ? commit.slice(0, 12) : '';
}

function gib(bytes: number): string {
	return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function firstLine(text: string): string {
	return text.split('\n')[0] ?? text;
}

/** Resolve a symlink to its absolute target; null when missing or dangling. */
export function readLink(link: string): string | null {
	try {
		return realpathSync(link);
	} catch {
		return null;
	}
}

/** Atomically point `link` at `target` (rename over the old link). */
export function setLink(link: string, target: string): void {
	const tmp = `${link}.tmp-${process.pid}`;
	rmSync(tmp, { force: true });
	symlinkSync(target, tmp);
	renameSync(tmp, link);
}

function writeAtomic(path: string, body: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, body, { mode: 0o600 });
	renameSync(tmp, path);
}

export function readMeta(release: string): ReleaseMeta {
	const path = join(release, 'meta.json');
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, 'utf8')) as ReleaseMeta;
	} catch {
		return {};
	}
}

function writeMeta(release: string, meta: ReleaseMeta): void {
	writeAtomic(join(release, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
	chmodSync(join(release, 'meta.json'), 0o644);
}

/** Same layout the installer produces: repo/, runtime/{bun,bunx,bin/…} -> shared Bun, agent/, cli/. */
export function assembleRelease(release: string, bunBin: string): void {
	mkdirSync(join(release, 'runtime', 'bin'), { recursive: true });
	for (const dir of [join(release, 'runtime', 'bin'), join(release, 'runtime')]) {
		for (const name of ['bun', 'bunx']) {
			rmSync(join(dir, name), { force: true });
			symlinkSync(bunBin, join(dir, name));
		}
	}
	mkdirSync(join(release, 'agent'), { recursive: true });
	const agent = join(release, 'repo', 'apps', 'agent', 'dist', 'skiff-agent');
	if (existsSync(agent)) {
		copyFileSync(agent, join(release, 'agent', 'skiff-agent'));
		chmodSync(join(release, 'agent', 'skiff-agent'), 0o755);
		linkAgentCommands(release);
	}
	// Optional: `/usr/local/bin/skif` falls back to the previous release if this one lacks it.
	const cli = join(release, 'repo', 'apps', 'cli', 'dist', 'skif.js');
	if (existsSync(cli)) {
		mkdirSync(join(release, 'cli'), { recursive: true });
		copyFileSync(cli, join(release, 'cli', 'skif.js'));
		chmodSync(join(release, 'cli', 'skif.js'), 0o644);
	}
}

/** Paths below `<optDir>/current/` that a unit file references (ExecStart, WorkingDirectory). */
export function unitReleasePaths(unit: string, optDir: string): string[] {
	const prefix = `${optDir.replace(/\/$/, '')}/current/`;
	const paths = new Set<string>();
	for (const raw of unit.split(/\r?\n/)) {
		const line = raw.trim();
		const match = /^(ExecStart|ExecStartPre|ExecStartPost|WorkingDirectory)\s*=\s*(.*)$/.exec(line);
		if (!match) continue;
		for (let token of match[2]!.split(/\s+/)) {
			token = token.replace(/^[-@+!:]+/, '');
			if (token.startsWith(prefix)) paths.add(token.slice(prefix.length));
		}
	}
	return [...paths];
}

/** Everything the installed units need from a release. Returns the missing relative paths. */
export function verifyRelease(release: string, layout: Pick<Layout, 'optDir' | 'controlPlaneUnitFile'>): string[] {
	const required = new Set([
		'repo/apps/control-plane/build/index.js',
		'runtime/bun',
		'agent/skiff-agent',
	]);
	if (existsSync(layout.controlPlaneUnitFile)) {
		for (const path of unitReleasePaths(readFileSync(layout.controlPlaneUnitFile, 'utf8'), layout.optDir))
			required.add(path);
	}
	return [...required].filter((path) => !existsSync(join(release, path)));
}

/** Consistent copy of a live (WAL) SQLite database. Safe while the control plane is running. */
export function snapshotDb(source: string, dest: string): void {
	mkdirSync(dirname(dest), { recursive: true });
	rmSync(dest, { force: true });
	const db = new Database(source, { readwrite: true, create: false });
	try {
		db.run('PRAGMA busy_timeout = 10000');
		db.run('VACUUM INTO ?', [dest]);
	} finally {
		db.close();
	}
}

/** Swap `snapshot` in as the database. The control plane must be stopped. */
export function restoreDbFile(snapshot: string, dbPath: string): void {
	const tmp = `${dbPath}.restore-${process.pid}`;
	copyFileSync(snapshot, tmp);
	rmSync(`${dbPath}-wal`, { force: true });
	rmSync(`${dbPath}-shm`, { force: true });
	renameSync(tmp, dbPath);
	chmodSync(dbPath, 0o640);
}

/** Opening the DB as root can create -wal/-shm owned by root, which would lock out the service user. */
function fixSidecarOwnership(dbPath: string, host: Host): void {
	for (const suffix of ['-wal', '-shm']) if (existsSync(`${dbPath}${suffix}`)) host.chownToSkiff(`${dbPath}${suffix}`);
}

/** Migration ids applied to the database that `release` does not ship. null = cannot tell. */
export function unknownMigrations(dbPath: string, release: string): string[] | null {
	const dir = join(release, 'repo', 'packages', 'db', 'migrations');
	if (!existsSync(dir)) return null;
	const shipped = new Set(readdirSync(dir).filter((file) => /^\d+_.*\.sql$/.test(file)));
	if (!existsSync(dbPath)) return [];
	const db = new Database(dbPath, { readonly: true });
	try {
		const table = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='skiff_migrations'").get();
		if (!table) return [];
		const applied = db.query<{ id: string }, []>('SELECT id FROM skiff_migrations ORDER BY id').all();
		return applied.map((row) => row.id).filter((id) => !shipped.has(id));
	} finally {
		db.close();
	}
}

/** Exclusive lock file holding our pid; a lock left by a dead process is taken over. */
export function acquireLock(path: string): () => void {
	mkdirSync(dirname(path), { recursive: true });
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = openSync(path, 'wx', 0o600);
			writeSync(fd, String(process.pid));
			closeSync(fd);
			return () => rmSync(path, { force: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
			const pid = Number(readFileSync(path, 'utf8').trim());
			if (pid && pid !== process.pid && processAlive(pid))
				throw new UpdateError(`Another update is running (pid ${pid}, lock ${path}).`);
			if (lstatSync(path).isFile()) rmSync(path, { force: true });
		}
	}
	throw new UpdateError(`Could not acquire ${path}.`);
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}
