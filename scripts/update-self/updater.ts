/**
 * Skiff self-updater (stage-0): orchestration.
 *
 * Invariant: a release that has been proven to serve is always either running or one atomic
 * rename away. Concretely:
 *
 *   /opt/skiff/current  -> the release serving now (what boots after a reboot)
 *   /opt/skiff/previous -> the release that served before it (kept until the next good update)
 *   /opt/skiff/standby  -> the incoming release, only while an update is in flight
 *
 * An update stages a release (a signed, CI-built artifact when one is published; otherwise a
 * source build), asks the *new release's own* hook to boot it against a copy of the live
 * database (canary), then cuts over with zero downtime:
 *
 *   1. start the standby unit on the new release (the primary keeps serving)
 *   2. prove it healthy on its own socket
 *   3. rename /run/skiff/control.sock to point at the standby (atomic; open requests finish)
 *   4. bake: watch it serve real traffic; any failure points control.sock back (code-only revert)
 *   5. commit: move `current`, restart the primary on it, point control.sock back, stop the standby
 *
 * A release that brings schema migrations is fenced instead: the old release stops before the
 * new one migrates the live database, so old code never runs against a schema it does not know.
 * A failed fenced update restores the pre-update snapshot.
 *
 * Failures are attributed. Only a well-formed verdict from the release's own hook, or a failed
 * bake, marks a release bad, and only for this updater build. Anything else (network, signature,
 * a hook that crashed or timed out, an updater exception) is retried next time.
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
	statSync,
	symlinkSync,
	writeFileSync,
	writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { compareSemver, parseSemver } from '../../packages/contracts/src/semver.ts';
import { linkAgentCommands } from '../systemd/builder.ts';
import {
	createUpgradeSnapshotBundle,
	directoryStatus,
	diskFacts,
	evaluateUpgradePreflight,
	fileBytes,
	pruneUpgradeSnapshotBundles,
	readAppliedMigrations,
	readDesiredStateVersion,
	readManagedDatabaseFacts,
	readMigrationsFromDir,
	retireUpgradeSnapshotBundles,
	type UpgradePreflight,
	type UpgradeSnapshotBundle
} from '../../packages/core/src/upgrade-plan.ts';
import type { HookVerdict } from '../release/canary.ts';
import type { Probe } from '../release/health.ts';
import { PRIMARY_UNIT, STANDBY_UNIT } from '../systemd/control-plane.ts';
import { STUDIO_UNIT } from '../systemd/studio.ts';
import { SignatureError, verifyManifest, type ManifestArtifact, type ReleaseManifest } from './signing.ts';
import { HOOK_PROTOCOL_MIN, UPDATER_IDENTITY } from './version.ts';
import type { KeyObject } from 'node:crypto';

export const CONTROL_PLANE = PRIMARY_UNIT;
export const STANDBY = STANDBY_UNIT;
export const AGENT = 'skiff-agent.service';
/** The on-demand database studio (plan 22). Never enabled; it follows the agent's binary. */
export const STUDIO = STUDIO_UNIT;
export const HELPER = 'skiff-helper.service';
export const LITESTREAM = 'skiff-litestream.service';
export const DEFAULT_REPO = 'KieranHolroyd/skiff';
export const DEFAULT_REF = 'main';

export interface Layout {
	optDir: string;
	releasesDir: string;
	currentLink: string;
	previousLink: string;
	/** The incoming release while an update is in flight (the standby unit runs it). */
	standbyLink: string;
	/** Stage-0 installs: <updaterDir>/<identity>/skiff-updated, <updaterDir>/current. */
	updaterDir: string;
	dbPath: string;
	backupsDir: string;
	canaryDir: string;
	stateFile: string;
	lockFile: string;
	bunBin: string;
	controlPlaneUnitFile: string;
	/** Release-managed Caddy unit, when the host uses it (stock `caddy.service` has no file here). */
	caddyUnitFile: string;
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
		standbyLink: join(optDir, 'standby'),
		updaterDir: env.SKIFF_UPDATER_DIR ?? '/usr/local/lib/skiff-updater',
		dbPath: join(varDir, 'data', 'skiff.db'),
		backupsDir: join(varDir, 'backups'),
		canaryDir: join(varDir, 'update-canary'),
		stateFile: join(optDir, 'update-state.json'),
		lockFile: join(optDir, 'update.lock'),
		bunBin: env.SKIFF_BUN_BIN ?? join(optDir, 'runtime', 'bin', 'bun'),
		controlPlaneUnitFile: join(systemdDir, CONTROL_PLANE),
		caddyUnitFile: join(systemdDir, 'skiff-caddy.service'),
	};
}

export type UpdatePhase = 'checking' | 'building' | 'canary' | 'swapping' | 'verifying' | 'rolling-back';

/** Which control-plane socket a probe targets. `public` is control.sock (what Caddy uses). */
export type SocketTarget = 'public' | 'primary' | 'standby';

/** A GitHub release as listed by the API (only the fields the updater uses). */
export interface PublishedRelease {
	tag: string;
	draft: boolean;
	prerelease: boolean;
	assets: { name: string; url: string; size: number }[];
}

/** Outcome of running a release hook. Only `verdict` can blame the release. */
export type HookOutcome =
	| { kind: 'verdict'; verdict: HookVerdict }
	| { kind: 'absent' }
	| { kind: 'error'; reason: string };

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
	 * Fallback canary for releases that predate release hooks: boot `release` in isolation (own
	 * socket, own data dir at `scratchDir/data`) and resolve once healthy; reject otherwise.
	 */
	canary(release: string, scratchDir: string): Promise<void>;
	/**
	 * Run `<release>/repo/scripts/release/hooks.ts <hook> ...args` with the release's own Bun and
	 * a hard timeout. `absent` when the release ships no hooks.
	 */
	releaseHook?(release: string, hook: string, args: string[], timeoutMs: number): Promise<HookOutcome>;
	/** Published GitHub releases, newest first. Absent: always build from source. */
	listReleases?(repo: string): Promise<PublishedRelease[]>;
	/** GET a (small) URL into memory. */
	fetchBytes?(url: string): Promise<Uint8Array>;
	/** Download `url` to `path`. */
	download?(url: string, path: string): Promise<void>;
	/** Extract a .tar.gz into an existing directory. */
	extract?(archive: string, dest: string): Promise<void>;
	/** sha256 hex of a file. */
	sha256?(path: string): string;
	/** Release-signing keys trusted on this host. */
	trustedKeys?(): Map<string, KeyObject>;
	/** e.g. linux-amd64 */
	platform?(): string;
	/** Probe one control-plane socket until fully healthy (setup, login, /readyz) or timeout. */
	probe?(target: SocketTarget, timeoutMs: number): Promise<Probe>;
	/** Rename control.sock to point at the primary or standby socket. */
	pointControlSocket?(target: 'primary' | 'standby'): void;
	/** Which socket control.sock names now (null: missing; `legacy`: a real socket file). */
	controlSocketTarget?(): 'primary' | 'standby' | 'legacy' | null;
	/** Write the primary/standby/guard units if they changed (daemon-reload). */
	ensureControlPlaneUnits?(): void;
	/** Run `<binary> self-test --json`; ok when the candidate stage-0 qualifies. */
	qualifyUpdater?(binary: string): Promise<Probe>;
	/** `<binary> --version` (identity), or null when it does not run. */
	updaterIdentity?(binary: string): Promise<string | null>;
	start(unit: string): Promise<void>;
	stop(unit: string): Promise<void>;
	restart(unit: string): Promise<void>;
	/** `systemctl try-restart`: restart only if active; never throws (the unit may not exist yet). */
	tryRestart?(unit: string): Promise<void>;
	/** Install/refresh skiff-helper from `release` (older hosts may lack the unit). */
	ensureHelper(release: string): void;
	/**
	 * Install this release's Caddy binary at the path the running unit executes and restart it.
	 * False when the release ships no Caddy or the host has no Caddy unit. Throws when the new
	 * binary cannot be validated or Caddy does not come back (after restoring the old binary).
	 */
	ensureCaddy?(release: string): boolean;
	/**
	 * Host setup stage-0 does itself when the serving release predates the `converge` hook (today:
	 * keep an installed telemetry store current). Releases with the hook own all of it.
	 */
	legacyHostSetup?(): Promise<void>;
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
	/** Probe the configured backup target before an upgrade. Optional for old hosts/tests. */
	backupTarget?(): Promise<{ ok: boolean; kind: string; error?: string }>;
	/** GET /readyz on the production socket; falls back to controlPlaneHealthy when absent. */
	readyz?(timeoutMs: number): Promise<boolean>;
	/** Ignore SIGINT/SIGTERM/SIGHUP while the swap is in flight. */
	enterCritical(): void;
	leaveCritical(): void;
}

export interface ReleaseMeta {
	version?: string;
	builtAt?: string;
	source?: string;
	repo?: string;
	/** The branch/ref source builds track. Never a release tag (see `tag`). */
	ref?: string;
	/** The signed release tag an artifact install came from. */
	tag?: string;
	commit?: string;
	status?: 'staged' | 'active' | 'failed';
	activatedAt?: string;
}

export interface Switch {
	kind: 'update' | 'rollback';
	/**
	 * Zero-downtime updates only. `overlap`: both releases share the live DB (no new migrations).
	 * `fenced`: the old release was stopped before the new one migrated the DB.
	 */
	mode?: 'overlap' | 'fenced';
	/** How far a zero-downtime update got: standby running, traffic on it, or committing. */
	stage?: 'standby' | 'cutover' | 'commit';
	/** Release that was serving before the switch. */
	from: string;
	/** Release activated by the switch. */
	to: string;
	/** What `previous` pointed at before the switch (restored if the switch is reverted). */
	previousBefore: string | null;
	/** The database exactly as `from` left it. */
	snapshot: string | null;
	/** Sealed upgrade bundle containing the control DB, env/APP_KEY and versions. */
	bundle?: string;
	commit?: string;
	withAgent: boolean;
	at: string;
}

export interface FailureVerdict {
	at: string;
	release: string;
	reason: string;
	/** Where it failed: canary, standby, bake, commit, live. */
	phase?: string;
	/**
	 * `release`: the release's own hook said no, or it failed while serving. Skipped (unless
	 * --force) by the same updater build only.
	 * `inconclusive`: could not tell (hook crashed/timed out, interrupted). Retried.
	 * `suspect`: two different releases failed the same way in a row; likely the updater. Retried.
	 */
	cause?: 'release' | 'inconclusive' | 'suspect';
	/** UPDATER_IDENTITY of the updater that recorded it. */
	updater?: string;
	version?: string;
}

export interface UpdateState {
	inProgress?: Switch;
	lastSwitch?: Switch;
	/** Failure verdicts by commit. Only {@link isBlocking} ones make the updater skip a commit. */
	failedCommits: Record<string, FailureVerdict>;
}

/** A recorded failure blocks a commit only if this updater build blamed the release itself. */
export function isBlocking(verdict: FailureVerdict | undefined): boolean {
	return Boolean(verdict && verdict.cause === 'release' && verdict.updater === UPDATER_IDENTITY);
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
	/** Explicit approval for a destructive migration; default false. */
	allowDestructiveMigrations?: boolean;
	/** How many successful pre-update bundles to retain (pinned bundles are always kept). */
	snapshotKeep?: number;
	/**
	 * `auto` (default): install the newest signed published release; build from source only when
	 * none is published or `ref` is given. `artifact`: never build on the host. `source`: always build.
	 */
	source?: 'auto' | 'artifact' | 'source';
	/** Default true. false: stop the old release before starting the new one (old behaviour). */
	zeroDowntime?: boolean;
	/** How long the new release must serve real traffic before it is committed. Default 60s. */
	bakeMs?: number;
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
	| { status: 'canary-failed'; commit: string; reason: string; cause?: FailureVerdict['cause'] }
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
/** The release's own check said no (well-formed verdict): the release is at fault. */
export class ReleaseFailure extends UpdateError {
	constructor(
		reason: string,
		readonly step?: string,
		readonly detail?: string,
	) {
		super(reason);
	}
}

const DEFAULTS = {
	minFreeBytes: 2 * 1024 ** 3,
	healthTimeoutMs: 90_000,
	stabilizeMs: 10_000,
	bakeMs: 60_000,
	bakeEveryMs: 1_000,
	hookTimeoutMs: 240_000,
	/** `converge` may download a ClickHouse or workerd pin (hundreds of MB). */
	convergeTimeoutMs: 900_000,
};

/** The release could not be judged (hook crashed, timed out, gave no verdict). Never blocklists. */
export class InconclusiveError extends UpdateError {}

/** A verified, published release ready to download. */
interface VerifiedRelease {
	tag: string;
	manifest: ReleaseManifest;
	artifact: ManifestArtifact & { url: string };
}

export class Updater {
	private snapshotKeep = 3;
	private readonly hookCache = new Map<string, Set<string>>();

	constructor(
		private readonly layout: Layout,
		private readonly host: Host,
	) {}

	// ------------------------------------------------------- host convergence

	/** Hooks `release` implements, from its `protocol` hook (cached; none when it has no hooks). */
	async releaseHooks(release: string): Promise<Set<string>> {
		const cached = this.hookCache.get(release);
		if (cached) return cached;
		let hooks = new Set<string>();
		if (this.host.releaseHook) {
			const outcome = await this.host.releaseHook(release, 'protocol', [], 60_000);
			if (outcome.kind === 'verdict') hooks = new Set(Array.isArray(outcome.verdict.hooks) ? outcome.verdict.hooks : ['canary']);
		}
		this.hookCache.set(release, hooks);
		return hooks;
	}

	/**
	 * Whether `release` installs its own units, helper and host commands (`converge` hook). When
	 * it does, the stage-0 updater must not render them from its own, possibly older, templates.
	 */
	async releaseOwnsHost(release: string): Promise<boolean> {
		return (await this.releaseHooks(release)).has('converge');
	}

	/**
	 * Additive skiff.env defaults `release` needs before it first boots (canary, standby). The
	 * running release keeps serving with them, so the hook only ever adds settings.
	 */
	private async prepareHost(release: string): Promise<void> {
		if (!(await this.releaseHooks(release)).has('prepare')) return;
		await this.runHostHook(release, 'prepare', ['--release', release]);
	}

	/**
	 * Make everything outside the release (units, the helper binary, host commands, workerd, the
	 * telemetry store) match `release`, with that release's own code, before its services restart.
	 * A release without the hook (or one whose hook fails) gets the built-in helper install.
	 * `rollback` never moves version-pinned data stores backwards.
	 */
	private async convergeHost(release: string, mode: 'update' | 'rollback'): Promise<void> {
		if ((await this.releaseOwnsHost(release)) && (await this.runHostHook(release, 'converge', ['--release', release, '--mode', mode]))) return;
		this.host.ensureHelper(release);
	}

	/** Run a host hook; true when it reported. Its failed steps are warnings, never fatal. */
	private async runHostHook(release: string, hook: 'prepare' | 'converge', args: string[]): Promise<boolean> {
		const { host } = this;
		try {
			const outcome = await host.releaseHook!(release, hook, args, DEFAULTS.convergeTimeoutMs);
			if (outcome.kind !== 'verdict') {
				host.warn(`${basename(release)}'s ${hook} hook ${outcome.kind === 'error' ? `failed: ${outcome.reason}` : 'is missing'}`);
				return false;
			}
			const { changed = [], warnings = [] } = outcome.verdict;
			for (const warning of warnings) host.warn(`${hook}: ${warning}`);
			host.log(changed.length ? `${hook}: updated ${changed.join(', ')}` : `${hook}: host already matches ${basename(release)}`);
			return true;
		} catch (error) {
			host.warn(`${basename(release)}'s ${hook} hook failed: ${message(error)}`);
			return false;
		}
	}

	/**
	 * Bring the host in line with the release that is serving now. Run at the start of an update,
	 * so a release committed by an older stage-0 (which knew nothing of `converge`) still gets its
	 * units. False when the release predates host hooks: the caller keeps its legacy setup.
	 */
	async syncHost(): Promise<boolean> {
		const current = readLink(this.layout.currentLink);
		if (!current || !(await this.releaseOwnsHost(current))) return false;
		await this.prepareHost(current);
		return this.runHostHook(current, 'converge', ['--release', current, '--mode', 'update']);
	}

	// ---------------------------------------------------------------- update

	async update(options: UpdateOptions = {}): Promise<UpdateResult> {
		this.snapshotKeep = Math.max(1, options.snapshotKeep ?? 3);
		return this.locked(async () => {
			await this.recoverInterrupted();
			const { host, layout } = this;
			const current = readLink(layout.currentLink);
			if (!current) throw new UpdateError(`No active release at ${layout.currentLink}. Run the installer first.`);
			// Heal drift, and finish the host side of a release an older stage-0 committed without
			// knowing about `converge`. Every update run does it, even one that finds nothing newer.
			if (!options.dryRun && !(await this.syncHost())) await host.legacyHostSetup?.();
			const currentMeta = readMeta(current);
			const repo = options.repo ?? currentMeta.repo ?? DEFAULT_REPO;
			const ref = options.ref ?? trackedRef(currentMeta) ?? DEFAULT_REF;

			host.log(`updater ${UPDATER_IDENTITY}`);
			host.log(`current release ${basename(current)} (${currentMeta.version ?? 'unknown version'}, ${short(currentMeta.commit) || 'unknown commit'})`);
			host.phase('checking', `Checking ${repo} for a newer release`);
			const target = await this.resolveTarget(repo, ref, currentMeta, options);
			const { commit, version, fromVersion, published } = target;
			const v: Versions = { version, fromVersion };
			host.phase('checking', `Latest is ${version}; running ${fromVersion ?? 'an unversioned release'}`, v);

			if (!options.force && fromVersion) {
				const order = compareSemver(version, fromVersion);
				if (order <= 0) {
					host.log(
						order === 0
							? `already on ${version}`
							: `the newest available is ${version}, older than the running ${fromVersion}; not downgrading (use rollback, or --force)`,
					);
					return { status: 'up-to-date', commit, ...v };
				}
			}
			if (!fromVersion) host.warn(`the current release has no semantic version; installing ${version}`);
			else if (options.force && compareSemver(version, fromVersion) < 0)
				host.warn(`downgrading ${fromVersion} -> ${version} (--force); forward-only migrations may not undo cleanly`);
			host.log(`${fromVersion ?? 'unknown'} -> ${version} (${short(commit)}, ${published ? `signed release ${published.tag}` : 'built from source'})`);

			const failed = this.readState().failedCommits[commit];
			if (!options.force && isBlocking(failed)) {
				const reason = `${version} (${short(commit)}) failed on ${failed!.at} (${failed!.reason}); pass --force to retry`;
				host.warn(reason);
				return { status: 'skipped', commit, reason, ...v };
			}
			if (failed && !isBlocking(failed))
				host.log(`retrying ${version}: its earlier failure (${failed.reason}) was ${failed.cause === 'release' ? 'recorded by a different updater build' : failed.cause ?? 'recorded by an older updater'}`);

			const name = releaseName(host.now(), commit);
			const release = join(layout.releasesDir, name);
			if (options.dryRun) {
				const plan = [
					published
						? `download and verify ${published.artifact.file} (${published.tag}) into ${release}`
						: `build ${repo}@${short(commit)} (${version}) into ${release}`,
					options.canary === false ? 'skip the canary' : "boot a canary against a copy of the database (the release's own hook)",
					options.zeroDowntime === false
						? `stop ${CONTROL_PLANE}, swap ${layout.currentLink}, start it, verify, roll back on failure`
						: `start ${STANDBY} on the new release, cut ${layout.currentLink.replace(/current$/, '')}control.sock over, bake, then move ${layout.currentLink} and restart ${CONTROL_PLANE} (fenced if the release brings migrations)`,
					'prune releases other than current and previous',
				];
				for (const line of plan) host.log(`would ${line}`);
				return { status: 'dry-run', commit, plan, ...v };
			}

			// Refuse early when the host cannot take a snapshot or the backup target is down. The
			// exact target migrations are checked again after staging.
			const initialPreflight = await this.preflight({
				release: null,
				targetVersion: version,
				allowDestructiveMigrations: options.allowDestructiveMigrations,
				allowDowngrade: options.force
			});
			if (!initialPreflight.ok)
				throw new UpdateError(`Upgrade preflight failed:\n- ${initialPreflight.errors.join('\n- ')}`);

			const free = host.freeBytes(layout.optDir);
			const minFree = options.minFreeBytes ?? DEFAULTS.minFreeBytes;
			if (free < minFree)
				throw new UpdateError(`Only ${gib(free)} free under ${layout.optDir}; at least ${gib(minFree)} is needed to stage a release.`);

			// 1. Stage next to the running release. Nothing serving is touched until this succeeds.
			try {
				if (published) await this.stageArtifact(release, { repo, ref, version, published });
				else await this.stage(release, { repo, ref, commit, version });
			} catch (error) {
				const reason = message(error);
				host.warn(`staging failed; ${basename(current)} is still serving untouched: ${reason}`);
				return { status: 'build-failed', commit, reason, ...v };
			}

			// The staged release ships the exact migration list. Refuse a destructive or unknown
			// migration before the canary or any link moves.
			const stagedPreflight = await this.preflight({
				release,
				targetVersion: version,
				allowDestructiveMigrations: options.allowDestructiveMigrations,
				allowDowngrade: options.force
			});
			if (!stagedPreflight.ok) {
				rmSync(release, { recursive: true, force: true });
				throw new UpdateError(
					`Upgrade preflight refused ${version}:\n- ${stagedPreflight.errors.join('\n- ')}`
				);
			}
			for (const warning of stagedPreflight.warnings) host.warn(`preflight: ${warning}`);

			// Settings the new release needs before it first boots (the canary reads skiff.env too).
			await this.prepareHost(release);

			// 2. Boot it in isolation against a copy of the live database, judged by its own hook.
			if (options.canary !== false) {
				try {
					await this.runCanary(release);
				} catch (error) {
					const reason = message(error);
					rmSync(release, { recursive: true, force: true });
					const verdict = this.recordFailure(commit, name, `canary: ${firstLine(reason)}`, {
						phase: 'canary',
						cause: error instanceof InconclusiveError ? 'inconclusive' : 'release',
						version,
					});
					host.warn(
						`canary failed (${verdict.cause === 'release' ? 'the release is at fault' : verdict.cause === 'suspect' ? 'the updater is suspected' : 'inconclusive; it will be retried'}); ${basename(current)} is still serving untouched`,
					);
					if (error instanceof ReleaseFailure && error.detail) host.log(`canary diagnostics:\n${error.detail}`);
					return { status: 'canary-failed', commit, reason, cause: verdict.cause, ...v };
				}
			}

			// 3. Cut over, bake, commit or revert.
			const publicCheck = options.publicCheck ?? 'auto';
			const requirePublic =
				publicCheck === 'require' || (publicCheck === 'auto' && (await host.publicHealthy(10_000)));
			if (publicCheck === 'auto')
				host.log(requirePublic ? 'public URL is healthy; it must stay healthy after the swap' : 'public URL is not reachable now; it will not gate the swap');
			const zeroDowntime = options.zeroDowntime !== false && Boolean(host.probe && host.pointControlSocket);
			const result = zeroDowntime
				? await this.activateZeroDowntime({ current, release, commit, version, requirePublic, options })
				: await this.activate({ current, release, commit, version, requirePublic, options });
			if (result.status === 'updated') await this.maybeInstallUpdater(release);
			return { ...result, ...v };
		});
	}

	/** Read-only: what would `update` install? Does not take the lock or touch the machine. */
	async check(options: Pick<UpdateOptions, 'repo' | 'ref' | 'source'> = {}): Promise<CheckResult> {
		const current = readLink(this.layout.currentLink);
		const currentMeta = current ? readMeta(current) : {};
		const repo = options.repo ?? currentMeta.repo ?? DEFAULT_REPO;
		const ref = options.ref ?? trackedRef(currentMeta) ?? DEFAULT_REF;
		const { published, ...resolved } = await this.resolveTarget(repo, ref, currentMeta, options);
		const failed = this.readState().failedCommits[resolved.commit];
		return {
			repo,
			ref: published ? published.tag : ref,
			...resolved,
			available: !resolved.fromVersion || compareSemver(resolved.version, resolved.fromVersion) > 0,
			...(isBlocking(failed) ? { failed: `${failed!.at}: ${failed!.reason}` } : {}),
		};
	}

	/**
	 * What to install: the newest signed published release, unless the caller pinned a ref or
	 * asked for a source build. Network and signature problems throw (retried, never blamed).
	 */
	private async resolveTarget(
		repo: string,
		ref: string,
		currentMeta: ReleaseMeta,
		options: Pick<UpdateOptions, 'ref' | 'source'>,
	): Promise<{ commit: string; published: VerifiedRelease | null } & Versions> {
		const source = options.source ?? 'auto';
		const fromVersion = parseSemver(currentMeta.version)?.version ?? null;
		if (source !== 'source' && !options.ref && this.host.listReleases) {
			const published = await this.resolvePublished(repo);
			if (published) return { commit: published.manifest.commit, version: published.manifest.version, fromVersion, published };
			if (source === 'artifact')
				throw new UpdateError(`No signed release of ${repo} is published; refusing to build on the host (source: download).`);
			this.host.log(`no signed release of ${repo} is published; building ${ref} from source`);
		} else if (source === 'artifact') {
			throw new UpdateError('source: download cannot be combined with --ref (a ref is always built from source).');
		}
		return { ...(await this.resolve(repo, ref, currentMeta)), published: null };
	}

	private async resolvePublished(repo: string): Promise<VerifiedRelease | null> {
		const { host } = this;
		if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new UpdateError(`Invalid repository "${repo}" (expected owner/name).`);
		const releases = await host.listReleases!(repo);
		const candidates = releases
			.filter(
				(release) =>
					!release.draft &&
					!release.prerelease &&
					/^v\d+\.\d+\.\d+$/.test(release.tag) &&
					release.assets.some((asset) => asset.name === 'manifest.json') &&
					release.assets.some((asset) => asset.name === 'manifest.json.sig'),
			)
			.sort((a, b) => compareSemver(b.tag.slice(1), a.tag.slice(1)));
		const top = candidates[0];
		if (!top) return null;
		if (!host.fetchBytes || !host.trustedKeys) throw new UpdateError('this host cannot verify signed releases');
		const asset = (name: string) => top.assets.find((entry) => entry.name === name)!;
		const bytes = await host.fetchBytes(asset('manifest.json').url);
		const signature = new TextDecoder().decode(await host.fetchBytes(asset('manifest.json.sig').url));
		let manifest: ReleaseManifest;
		try {
			manifest = verifyManifest(bytes, signature, host.trustedKeys());
		} catch (error) {
			if (error instanceof SignatureError) throw new UpdateError(`${top.tag} is not trusted: ${error.message}`);
			throw error;
		}
		if (manifest.version !== top.tag.slice(1))
			throw new UpdateError(`${top.tag}'s signed manifest describes ${manifest.version}; refusing a mislabelled release`);
		if (manifest.repo.toLowerCase() !== repo.toLowerCase())
			throw new UpdateError(`${top.tag}'s signed manifest is for ${manifest.repo}, not ${repo}`);
		if (manifest.hookProtocol < HOOK_PROTOCOL_MIN)
			host.warn(`${top.tag} ships release-hook protocol ${manifest.hookProtocol}; the fallback canary will be used`);
		const platform = host.platform?.() ?? `${process.platform}-${process.arch === 'x64' ? 'amd64' : process.arch}`;
		const entry = manifest.artifacts[platform];
		if (!entry) throw new UpdateError(`${top.tag} has no ${platform} artifact`);
		const download = top.assets.find((item) => item.name === entry.file);
		if (!download) throw new UpdateError(`${top.tag} lists ${entry.file} but the release has no such asset`);
		return { tag: top.tag, manifest, artifact: { ...entry, url: download.url } };
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

	private clearStaging(): void {
		const { layout } = this;
		mkdirSync(layout.releasesDir, { recursive: true });
		// Leftovers from an interrupted stage are safe to remove: we hold the lock.
		for (const entry of readdirSync(layout.releasesDir))
			if (entry.startsWith('.staging-') || entry.startsWith('.download-'))
				rmSync(join(layout.releasesDir, entry), { recursive: true, force: true });
	}

	/** Download the signed artifact, check size and sha256 against the manifest, unpack. */
	private async stageArtifact(
		release: string,
		input: { repo: string; ref: string; version: string; published: VerifiedRelease },
	): Promise<void> {
		const { host, layout } = this;
		const { published } = input;
		if (!host.download || !host.extract || !host.sha256) throw new UpdateError('this host cannot install release artifacts');
		this.clearStaging();
		const staging = join(layout.releasesDir, `.staging-${basename(release)}`);
		const archive = join(layout.releasesDir, `.download-${basename(release)}.tar.gz`);
		mkdirSync(staging, { recursive: true });
		try {
			host.phase('building', `Downloading the signed ${input.version} release`);
			host.log(`downloading ${published.artifact.file} (${(published.artifact.size / 1024 ** 2).toFixed(0)} MiB) from ${published.tag}`);
			await host.download(published.artifact.url, archive);
			const size = statSync(archive).size;
			if (size !== published.artifact.size)
				throw new UpdateError(`${published.artifact.file} is ${size} bytes; the signed manifest says ${published.artifact.size}`);
			const sha = host.sha256(archive);
			if (sha !== published.artifact.sha256)
				throw new UpdateError(`${published.artifact.file} does not match its signed checksum (got ${sha.slice(0, 16)}…)`);
			host.log('checksum and signature verified');
			await host.extract(archive, staging);
			rmSync(archive, { force: true });
			assembleRelease(staging, layout.bunBin);
			this.inheritCaddy(staging);
			const missing = verifyRelease(staging, layout);
			if (missing.length) throw new UpdateError(`the release artifact is missing ${missing.join(', ')}`);
			writeMeta(staging, {
				version: input.version,
				builtAt: published.manifest.createdAt,
				source: 'artifact',
				repo: input.repo,
				ref: input.ref,
				tag: published.tag,
				commit: published.manifest.commit,
				status: 'staged',
			});
			renameSync(staging, release);
			host.log(`staged ${release}`);
		} catch (error) {
			rmSync(staging, { recursive: true, force: true });
			rmSync(archive, { force: true });
			throw error;
		}
	}

	private async stage(
		release: string,
		source: { repo: string; ref: string; commit: string; version: string },
	): Promise<void> {
		const { host, layout } = this;
		this.clearStaging();
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
			this.inheritCaddy(staging);
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

	/**
	 * Source builds (and artifacts built before Caddy was bundled) carry no Caddy binary. Keep the
	 * running one in the staged release so `/opt/skiff/current/caddy/caddy` still resolves after
	 * the swap; the canary does not exercise Caddy.
	 */
	/**
	 * The first release that bundles Caddy would otherwise make `previous` unbootable: a rollback
	 * to a release with no `caddy/caddy` fails verifyRelease on a host whose unit executes it. Add
	 * the new binary to the release we just superseded; it is inert until a rollback runs it.
	 */
	private backfillCaddy(previous: string, release: string): void {
		const { host } = this;
		const source = join(release, 'caddy', 'caddy');
		const target = join(previous, 'caddy', 'caddy');
		if (!existsSync(source) || existsSync(target)) return;
		try {
			mkdirSync(dirname(target), { recursive: true });
			copyFileSync(source, target);
			chmodSync(target, 0o755);
			host.log(`added Caddy to ${basename(previous)} so rollback keeps working`);
		} catch (error) {
			host.warn(`could not add Caddy to ${basename(previous)}: ${message(error)}`);
		}
	}

	private inheritCaddy(staging: string): void {
		const { host, layout } = this;
		const target = join(staging, 'caddy', 'caddy');
		if (existsSync(target)) return;
		const current = readLink(layout.currentLink);
		if (!current) return;
		const source = join(current, 'caddy', 'caddy');
		if (!existsSync(source)) return;
		mkdirSync(dirname(target), { recursive: true });
		copyFileSync(source, target);
		chmodSync(target, 0o755);
		host.log(`carried Caddy over from ${basename(current)}`);
	}

	/**
	 * The release judges itself: its own `canary` hook prepares the scratch dir (data layout,
	 * ownership, DB copy) and boots it. Stage-0 only supplies an empty directory and reads the
	 * verdict. Releases from before hooks existed use the built-in fallback.
	 */
	private async runCanary(release: string): Promise<void> {
		const { host, layout } = this;
		const scratch = join(layout.canaryDir, basename(release));
		rmSync(scratch, { recursive: true, force: true });
		mkdirSync(scratch, { recursive: true });
		host.phase('canary', 'Test-booting the new release against a copy of the database');
		try {
			const outcome: HookOutcome = host.releaseHook
				? await host.releaseHook(release, 'canary', ['--release', release, '--scratch', scratch, '--db', layout.dbPath], DEFAULTS.hookTimeoutMs)
				: { kind: 'absent' };
			if (outcome.kind === 'error')
				throw new InconclusiveError(`the release's canary hook gave no verdict: ${outcome.reason}`);
			if (outcome.kind === 'verdict') {
				if (!outcome.verdict.ok)
					throw new ReleaseFailure(outcome.verdict.reason ?? 'unhealthy', outcome.verdict.step, outcome.verdict.detail);
				host.log(`canary is healthy (release hook, protocol ${outcome.verdict.protocol})`);
				return;
			}
			// Fallback for releases without hooks: stage-0's bundled copy of the same canary, which
			// prepares the scratch dir itself.
			host.log('this release ships no canary hook; using the built-in canary');
			try {
				await host.canary(release, scratch);
			} catch (error) {
				throw new ReleaseFailure(message(error), 'fallback');
			}
			host.log('canary is healthy');
		} finally {
			fixSidecarOwnership(layout.dbPath, host);
			rmSync(scratch, { recursive: true, force: true });
		}
	}

	private async activate(input: {
		current: string;
		release: string;
		commit: string;
		version: string;
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
			const bundle = this.takeSnapshotBundle(`pre-update-${basename(release)}`, {
				fromVersion: readMeta(current).version ?? null,
				targetVersion: input.version,
				migrations: readMigrationsFromDir(join(release, 'repo/packages/db/migrations')).map(
					(migration) => migration.id
				)
			});
			sw.snapshot = bundle?.controlDb ?? null;
			sw.bundle = bundle?.dir;
			this.writeState({ ...this.readState(), inProgress: sw });

			// `previous` first: if we die between the two renames, both links still name good releases.
			setLink(layout.previousLink, current);
			setLink(layout.currentLink, release);
			host.log(`${layout.currentLink} -> ${release}`);
			this.backfillCaddy(current, release);

			// Units, the helper binary and host commands live outside releases; the release installs
			// its own before its services restart.
			await this.convergeHost(release, 'update');
			await host.start(CONTROL_PLANE);
			await host.restart(HELPER);
			host.ensureCaddy?.(release);
			await this.restartAgent(withAgent, 'follow');

			host.phase('verifying', 'Waiting for the new release to prove it is healthy');
			const problem = await this.verifyLive({
				requirePublic: input.requirePublic,
				withAgent,
				healthTimeoutMs: options.healthTimeoutMs,
				stabilizeMs: options.stabilizeMs,
			});
			if (!problem) {
				this.finish(sw);
				retireUpgradeSnapshotBundles(layout.backupsDir, sw.bundle ?? null);
				writeMeta(release, { ...readMeta(release), status: 'active', activatedAt: host.now().toISOString() });
				this.prune();
				host.log(`updated to ${basename(release)}; ${basename(current)} kept as previous`);
				return { status: 'updated', commit, release, previous: current };
			}

			host.warn(`${basename(release)} is unhealthy (${problem}); rolling back`);
			host.phase('rolling-back', `Rolling back: ${problem}`);
			const recovered = await this.revert(sw);
			this.recordFailure(commit, basename(release), problem, { phase: 'live', cause: 'release', version: input.version });
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

	// ------------------------------------------------------- zero-downtime cutover

	/**
	 * Blue/green on one host. The primary keeps serving while the standby boots the new release;
	 * control.sock moves to the standby only once it is healthy, and the new release is committed
	 * (`current` moved, primary restarted on it) only after it has served real traffic for the
	 * bake window. Until commit, reverting is pointing control.sock back: no restart, no restore.
	 */
	private async activateZeroDowntime(input: {
		current: string;
		release: string;
		commit: string;
		version: string;
		requirePublic: boolean;
		options: UpdateOptions;
	}): Promise<
		| { status: 'updated'; commit: string; release: string; previous: string }
		| { status: 'rolled-back'; commit: string; reason: string; recovered: boolean }
	> {
		const { host, layout } = this;
		const { current, release, commit, options } = input;
		const withAgent = Boolean(options.withAgent);
		const healthTimeout = options.healthTimeoutMs ?? DEFAULTS.healthTimeoutMs;
		const pending = pendingMigrations(layout.dbPath, release);
		const sw: Switch = {
			kind: 'update',
			mode: pending.length ? 'fenced' : 'overlap',
			stage: 'standby',
			from: current,
			to: release,
			previousBefore: readLink(layout.previousLink),
			snapshot: null,
			commit,
			withAgent,
			at: host.now().toISOString(),
		};
		const fail = async (phase: 'standby' | 'bake' | 'commit', problem: string) => {
			host.warn(`${basename(release)} failed at ${phase} (${problem}); reverting`);
			host.phase('rolling-back', `Rolling back: ${problem}`);
			const recovered = await this.revertZeroDowntime(sw);
			// A release that served fine on the standby but not as the primary points at the host.
			this.recordFailure(commit, basename(release), `${phase}: ${problem}`, {
				phase,
				cause: phase === 'commit' ? 'inconclusive' : 'release',
				version: input.version,
			});
			if (recovered) rmSync(release, { recursive: true, force: true });
			return { status: 'rolled-back' as const, commit, reason: problem, recovered };
		};

		host.ensureControlPlaneUnits?.();
		host.enterCritical();
		try {
			if (sw.mode === 'fenced') {
				host.phase('swapping', `Stopping the old release to apply ${pending.length} migration(s)`);
				host.log(
					`${basename(release)} brings migrations ${pending.join(', ')}; the old release must not run on a schema it does not know, so this cutover is fenced (the old release stops first)`,
				);
				await host.stop(CONTROL_PLANE);
			} else {
				host.phase('swapping', 'Starting the new release beside the running one');
			}
			const bundle = this.takeSnapshotBundle(`pre-update-${basename(release)}`, {
				fromVersion: readMeta(current).version ?? null,
				targetVersion: input.version,
				migrations: readMigrationsFromDir(join(release, 'repo/packages/db/migrations')).map((migration) => migration.id),
			});
			sw.snapshot = bundle?.controlDb ?? null;
			sw.bundle = bundle?.dir;
			setLink(layout.standbyLink, release);
			this.writeState({ ...this.readState(), inProgress: sw });

			// 1. Standby: the new release on its own socket. The primary still serves (overlap).
			await host.stop(STANDBY);
			await host.start(STANDBY);
			const ready = await host.probe!('standby', healthTimeout);
			if (!ready.ok) return await fail('standby', `the new release did not become healthy: ${ready.reason}`);
			host.log('standby is healthy on its own socket');

			// 2. Cutover: one rename; new connections go to the standby, open ones finish where they are.
			sw.stage = 'cutover';
			this.writeState({ ...this.readState(), inProgress: sw });
			host.pointControlSocket!('standby');
			host.log('control.sock -> standby: the new release is taking traffic');

			// 3. Bake: it must keep serving real traffic before anything irreversible happens.
			const bakeMs = options.bakeMs ?? DEFAULTS.bakeMs;
			host.phase('verifying', `Watching the new release serve traffic for ${Math.round(bakeMs / 1000)}s before committing`);
			const problem = await this.bake({ bakeMs, requirePublic: input.requirePublic });
			if (problem) return await fail('bake', problem);

			// 4. Commit: `current` moves, the primary restarts on it while the standby keeps serving.
			sw.stage = 'commit';
			this.writeState({ ...this.readState(), inProgress: sw });
			setLink(layout.previousLink, current);
			setLink(layout.currentLink, release);
			host.log(`${layout.currentLink} -> ${release}`);
			this.backfillCaddy(current, release);
			await this.convergeHost(release, 'update');
			await this.restartPrimaryBehindStandby();
			const primary = await host.probe!('primary', healthTimeout);
			if (!primary.ok) return await fail('commit', `the primary did not come up on the new release: ${primary.reason}`);
			host.pointControlSocket!('primary');
			host.log('control.sock -> primary (now on the new release)');
			// Requests already on the standby finish within its stop timeout (graceful SIGTERM).
			await host.sleep(2_000);
			await host.stop(STANDBY);
			rmSync(layout.standbyLink, { force: true });
			await host.restart(HELPER);
			host.ensureCaddy?.(release);
			await this.restartAgent(withAgent, 'follow');
			const settled = await this.verifyLive({
				requirePublic: input.requirePublic,
				withAgent,
				healthTimeoutMs: options.healthTimeoutMs,
				stabilizeMs: options.stabilizeMs,
			});
			if (settled) return await fail('commit', settled);

			this.finish(sw);
			retireUpgradeSnapshotBundles(layout.backupsDir, sw.bundle ?? null);
			writeMeta(release, { ...readMeta(release), status: 'active', activatedAt: host.now().toISOString() });
			this.prune();
			host.log(`updated to ${basename(release)} with ${sw.mode === 'fenced' ? 'a fenced' : 'a zero-downtime'} cutover; ${basename(current)} kept as previous`);
			return { status: 'updated', commit, release, previous: current };
		} catch (error) {
			if (this.readState().inProgress) {
				host.warn(`update failed during the cutover (${message(error)}); reverting`);
				if (!(await this.revertZeroDowntime(sw))) throw new RecoveryError(`${message(error)}; reverting also failed`);
			} else if (sw.mode === 'fenced') {
				host.warn(`update failed before the cutover (${message(error)}); restarting ${basename(current)}`);
				await host.start(CONTROL_PLANE).catch(() => undefined);
			}
			throw error;
		} finally {
			host.leaveCritical();
		}
	}

	/**
	 * (Re)start the primary while the standby keeps serving. The old process may unlink
	 * control.sock on its way down (a pre-standby primary listened on that very path), so the link
	 * is re-pointed at the standby between stop and start; the primary's pre-start then leaves it
	 * there until the updater moves it once the primary answers.
	 */
	private async restartPrimaryBehindStandby(): Promise<void> {
		const { host } = this;
		await host.stop(CONTROL_PLANE);
		if (await host.isActive(STANDBY)) host.pointControlSocket!('standby');
		await host.start(CONTROL_PLANE);
	}

	/** The new release serves real traffic through control.sock; any wobble fails the bake. */
	private async bake(input: { bakeMs: number; requirePublic: boolean }): Promise<string | null> {
		const { host } = this;
		const restarts = await host.restartCount(STANDBY);
		const rounds = Math.max(1, Math.ceil(input.bakeMs / DEFAULTS.bakeEveryMs));
		for (let round = 0; round < rounds; round++) {
			await host.sleep(Math.min(DEFAULTS.bakeEveryMs, input.bakeMs));
			if (!(await host.isActive(STANDBY))) return 'the new release stopped while serving';
			if ((await host.restartCount(STANDBY)) !== restarts) return 'the new release crashed while serving';
			const probe = await host.probe!('public', 10_000);
			if (!probe.ok) return `the new release stopped answering: ${probe.reason}`;
		}
		if (input.requirePublic && !(await host.publicHealthy(60_000))) return 'public platform URL stopped answering';
		return null;
	}

	/**
	 * Undo a zero-downtime switch, whatever stage it reached, without dropping traffic where that
	 * is possible: the standby keeps serving until the old release answers again on the primary.
	 */
	private async revertZeroDowntime(sw: Switch): Promise<boolean> {
		const { host, layout } = this;
		const stage = sw.stage ?? 'standby';
		try {
			if (stage === 'commit') {
				setLink(layout.currentLink, sw.from);
				if (sw.previousBefore && existsSync(sw.previousBefore) && sw.previousBefore !== sw.from)
					setLink(layout.previousLink, sw.previousBefore);
				else rmSync(layout.previousLink, { force: true });
				host.log(`${layout.currentLink} -> ${sw.from}`);
				await this.convergeHost(sw.from, 'rollback');
			} else {
				host.ensureHelper(sw.from);
			}
			if (sw.mode === 'overlap') {
				if (stage === 'standby') {
					// Traffic never moved; the primary never stopped.
					await host.stop(STANDBY);
				} else {
					let primary: Probe = stage === 'commit' ? { ok: false } : await host.probe!('primary', 5_000);
					if (!primary.ok) {
						// The primary runs the new release (commit), or listens on a pre-standby socket path
						// (first update after the upgrade to zero-downtime units). Restart it on `current`;
						// while the standby is active its pre-start leaves control.sock on the standby.
						await this.restartPrimaryBehindStandby();
						primary = await host.probe!('primary', DEFAULTS.healthTimeoutMs);
					}
					if (primary.ok) host.pointControlSocket!('primary');
					await host.stop(STANDBY);
					if (!primary.ok) await host.restart(CONTROL_PLANE);
				}
			} else {
				await host.stop(STANDBY);
				await host.stop(CONTROL_PLANE);
				if (sw.snapshot && existsSync(sw.snapshot)) await this.restoreDatabase(sw.snapshot);
				await host.start(CONTROL_PLANE);
				host.pointControlSocket!('primary');
			}
			rmSync(layout.standbyLink, { force: true });
			await host.restart(HELPER).catch(() => undefined);
			host.ensureCaddy?.(sw.from);
			await this.restartAgent(sw.withAgent, 'stop');
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
	 * Boot-time arbiter (skiff-update-guard.service, ordered before the control plane). Like a
	 * bootloader's try-counter: a zero-downtime update that never committed falls back to the
	 * committed release. Filesystem only, so it cannot wait on the units it runs before.
	 */
	async bootRecover(): Promise<'nothing' | 'reverted' | 'deferred'> {
		return this.locked(async () => {
			const { host, layout } = this;
			const state = this.readState();
			const sw = state.inProgress;
			if (!sw) return 'nothing';
			if (!sw.mode) return 'deferred';
			if (readLink(layout.currentLink) !== sw.from) setLink(layout.currentLink, sw.from);
			if (sw.previousBefore && existsSync(sw.previousBefore) && sw.previousBefore !== sw.from)
				setLink(layout.previousLink, sw.previousBefore);
			else if (readLink(layout.previousLink) === sw.from) rmSync(layout.previousLink, { force: true });
			if (sw.mode === 'fenced' && sw.snapshot && existsSync(sw.snapshot)) {
				restoreDbFile(sw.snapshot, layout.dbPath);
				host.chownToSkiff(layout.dbPath);
			}
			rmSync(layout.standbyLink, { force: true });
			delete state.inProgress;
			this.writeState(state);
			if (sw.commit)
				this.recordFailure(sw.commit, basename(sw.to), 'interrupted by a reboot before it was committed', {
					phase: sw.stage ?? 'standby',
					cause: 'inconclusive',
				});
			host.log(`an uncommitted update to ${basename(sw.to)} was interrupted; booting ${basename(sw.from)}`);
			return 'reverted';
		});
	}

	/**
	 * Stage-0 updates itself the Chromium way, never in the same transaction as the app: after a
	 * release commits, its bundled updater is installed side by side, must pass `self-test`, and
	 * only then becomes `current`. A candidate that fails qualification is discarded.
	 */
	private async maybeInstallUpdater(release: string): Promise<void> {
		const { host, layout } = this;
		const binary = join(release, 'updater', 'skiff-updated');
		if (!existsSync(binary) || !host.updaterIdentity || !host.qualifyUpdater) return;
		try {
			const identity = await host.updaterIdentity(binary);
			if (!identity) {
				host.warn(`the stage-0 updater shipped in ${basename(release)} does not run; keeping ${UPDATER_IDENTITY}`);
				return;
			}
			const name = identity.replace(/[^\w.+-]/g, '_');
			const currentLink = join(layout.updaterDir, 'current');
			const installed = readLink(currentLink);
			if (installed && basename(installed) === name) return;
			const dir = join(layout.updaterDir, name);
			mkdirSync(dir, { recursive: true });
			const target = join(dir, 'skiff-updated');
			copyFileSync(binary, `${target}.tmp`);
			chmodSync(`${target}.tmp`, 0o755);
			renameSync(`${target}.tmp`, target);
			const qualified = await host.qualifyUpdater(target);
			if (!qualified.ok) {
				host.warn(`stage-0 updater ${identity} failed its self-test (${qualified.reason}); keeping ${installed ? basename(installed) : 'the current updater'}`);
				if (dir !== installed) rmSync(dir, { recursive: true, force: true });
				return;
			}
			if (installed) setLink(join(layout.updaterDir, 'previous'), installed);
			setLink(currentLink, dir);
			host.log(`stage-0 updater ${identity} passed its self-test and is now active`);
			const keep = new Set([dir, installed].filter(Boolean));
			for (const entry of readdirSync(layout.updaterDir)) {
				const path = join(layout.updaterDir, entry);
				if (entry === 'current' || entry === 'previous' || keep.has(path)) continue;
				rmSync(path, { recursive: true, force: true });
			}
		} catch (error) {
			host.warn(`could not install the stage-0 updater from ${basename(release)}: ${message(error)}`);
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
				await this.convergeHost(previous, 'rollback');
				await host.start(CONTROL_PLANE);
				await host.restart(HELPER);
				host.ensureCaddy?.(previous);
				await this.restartAgent(withAgent, 'stop');
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

	/** Resolve an interrupted switch now (also happens at the start of every update/rollback). */
	async recover(): Promise<void> {
		return this.locked(() => this.recoverInterrupted());
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
		const ready = host.readyz ? await host.readyz(15_000) : true;
		if (!ready) return '/readyz did not become ready';
		const restarts = await host.restartCount(CONTROL_PLANE);
		await host.sleep(input.stabilizeMs ?? DEFAULTS.stabilizeMs);
		if (!(await host.isActive(CONTROL_PLANE)) || (await host.restartCount(CONTROL_PLANE)) !== restarts)
			return 'control plane crashed after becoming healthy';
		if (!(await host.controlPlaneHealthy(5_000))) return 'control plane stopped answering health checks';
		if (host.readyz && !(await host.readyz(5_000))) return '/readyz stopped being ready';
		if (input.requirePublic && !(await host.publicHealthy(60_000))) return 'public platform URL stopped answering';
		if (input.withAgent && host.agentEnrolled() && !(await host.isActive(AGENT))) return 'agent is not running';
		return null;
	}

	/**
	 * Restart the agent on `current`. The studio runs the same binary from its own unit: after an
	 * update a running studio follows (`try-restart`, so a stopped one stays stopped); after a
	 * rollback it is stopped, because the restored agent may predate `skiff-agent studio` and starts
	 * it on demand anyway.
	 */
	private async restartAgent(withAgent: boolean, studio: 'follow' | 'stop'): Promise<void> {
		const { host } = this;
		if (!withAgent || !host.agentEnrolled()) return;
		await host.restart(AGENT);
		if (studio === 'follow') await host.tryRestart?.(STUDIO);
		else await host.stop(STUDIO).catch(() => undefined);
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
			await this.convergeHost(sw.from, 'rollback');
			await host.start(CONTROL_PLANE);
			await host.restart(HELPER);
			host.ensureCaddy?.(sw.from);
			await this.restartAgent(sw.withAgent, 'stop');
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
			if (sw.mode) {
				// Zero-downtime switch. Only a commit that already restarted the primary on the new
				// release and answers there is kept; anything earlier is reverted.
				if (sw.stage === 'commit' && readLink(layout.currentLink) === sw.to && host.probe && host.pointControlSocket) {
					const primary = await host.probe('primary', 15_000);
					if (primary.ok) {
						host.pointControlSocket('primary');
						await host.stop(STANDBY);
						rmSync(layout.standbyLink, { force: true });
						host.ensureCaddy?.(sw.to);
						host.log(`${basename(sw.to)} is healthy on the primary; keeping it`);
						this.finish(sw);
						retireUpgradeSnapshotBundles(layout.backupsDir, sw.bundle ?? null);
						this.prune();
						writeMeta(sw.to, { ...readMeta(sw.to), status: 'active', activatedAt: host.now().toISOString() });
						return;
					}
				}
				const recovered = await this.revertZeroDowntime(sw);
				if (sw.commit)
					this.recordFailure(sw.commit, basename(sw.to), 'interrupted before it was committed', {
						phase: sw.stage ?? 'standby',
						cause: 'inconclusive',
					});
				if (!recovered) throw new RecoveryError('Recovery failed; fix the control plane manually before updating again.');
				return;
			}
			if (readLink(layout.currentLink) === sw.to) {
				await this.convergeHost(sw.to, sw.kind === 'rollback' ? 'rollback' : 'update');
				if (!(await host.isActive(CONTROL_PLANE))) await host.start(CONTROL_PLANE);
				await host.restart(HELPER).catch(() => undefined);
				host.ensureCaddy?.(sw.to);
				const problem = await this.verifyLive({ requirePublic: false, withAgent: false });
				if (!problem) {
					host.log(`${basename(sw.to)} is healthy; keeping it`);
					this.finish(sw);
					retireUpgradeSnapshotBundles(layout.backupsDir, sw.bundle ?? null);
					this.prune();
					if (sw.kind === 'update') writeMeta(sw.to, { ...readMeta(sw.to), status: 'active', activatedAt: host.now().toISOString() });
					return;
				}
				host.warn(`${basename(sw.to)} is unhealthy (${problem}); reverting to ${basename(sw.from)}`);
				const recovered = await this.revert(sw);
				if (sw.kind === 'update' && sw.commit)
					this.recordFailure(sw.commit, basename(sw.to), problem, { phase: 'live', cause: 'release' });
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

	/**
	 * Read-only plan for `skiff-update-self plan` and the CLI. Uses the running release's migration
	 * list; the update itself re-runs this against the exact staged release before the canary.
	 */
	async plan(options: Pick<UpdateOptions, 'repo' | 'ref' | 'source'> = {}): Promise<{ check: CheckResult; preflight: UpgradePreflight }> {
		const check = await this.check(options);
		const current = readLink(this.layout.currentLink);
		const preflight = await this.preflight({
			release: current,
			targetVersion: check.version
		});
		return { check, preflight };
	}

	/** Apply the same refusal rules as the dashboard/service to the self-updater. */
	private async preflight(input: {
		release: string | null;
		targetVersion: string;
		allowDestructiveMigrations?: boolean;
		allowDowngrade?: boolean;
	}): Promise<UpgradePreflight> {
		const { host, layout } = this;
		const dataDir = dirname(layout.dbPath);
		const migrations = input.release
			? readMigrationsFromDir(join(input.release, 'repo', 'packages', 'db', 'migrations'))
			: [];
		const backup = host.backupTarget ? await host.backupTarget() : null;
		const disk = diskFacts(layout.backupsDir);
		return evaluateUpgradePreflight({
			currentVersion: (readLink(layout.currentLink) && readMeta(readLink(layout.currentLink)!).version) || '0.0.0',
			targetVersion: input.targetVersion,
			channel: process.env.SKIFF_RELEASE_CHANNEL === 'edge' ? 'edge' : 'stable',
			migrations,
			appliedMigrations: readAppliedMigrations(layout.dbPath),
			controlDbBytes: fileBytes(layout.dbPath),
			freeBytes: host.freeBytes(layout.backupsDir) || disk.freeBytes,
			totalBytes: disk.totalBytes,
			dataDirs: [
				directoryStatus('data', dataDir),
				directoryStatus('objects', join(dataDir, 'objects')),
				directoryStatus('backups', layout.backupsDir)
			],
			backupTarget: backup
				? { kind: backup.kind, reachable: backup.ok, ...(backup.error ? { error: backup.error } : {}) }
				: null,
			managedDatabases: readManagedDatabaseFacts(layout.dbPath),
			allowDestructiveMigrations: input.allowDestructiveMigrations,
			allowDowngrade: input.allowDowngrade,
			now: host.now().getTime()
		});
	}

	private takeSnapshotBundle(
		name: string,
		input: { fromVersion: string | null; targetVersion: string; migrations: string[] }
	): UpgradeSnapshotBundle | null {
		const { host, layout } = this;
		if (!existsSync(layout.dbPath)) return null;
		const bundle = createUpgradeSnapshotBundle({
			backupsDir: layout.backupsDir,
			dbPath: layout.dbPath,
			envDir: process.env.SKIFF_ETC_DIR ?? '/etc/skiff',
			dataDir: dirname(layout.dbPath),
			label: name.replace(/^pre-update-/, ''),
			kind: 'pre-update',
			fromVersion: input.fromVersion,
			targetVersion: input.targetVersion,
			migrations: input.migrations,
			agentVersion: process.env.SKIFF_AGENT_VERSION ?? null,
			desiredStateVersion: readDesiredStateVersion(layout.dbPath),
			pinned: true,
			retain: this.snapshotKeep,
			now: host.now().getTime()
		});
		fixSidecarOwnership(layout.dbPath, host);
		host.log(`upgrade snapshot bundle ${bundle.dir}${bundle.controlDb ? '' : ' (control DB missing)'}`);
		return bundle;
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

	/**
	 * Record why `commit` failed. If the previous *different* release failed at the same phase
	 * for the same reason, neither is blamed: two releases failing identically points at the
	 * updater or the host (the 2026-11-05 trap), so both stay retryable and the operator is told.
	 */
	private recordFailure(
		commit: string,
		release: string,
		reason: string,
		input: { phase?: string; cause?: FailureVerdict['cause']; version?: string } = {},
	): FailureVerdict {
		const state = this.readState();
		let cause = input.cause ?? 'release';
		if (cause === 'release') {
			const key = normalizeReason(reason, release);
			const last = Object.entries(state.failedCommits)
				.filter(([other, verdict]) => other !== commit && verdict.updater === UPDATER_IDENTITY && (verdict.cause === 'release' || verdict.cause === 'suspect'))
				.sort(([, a], [, b]) => b.at.localeCompare(a.at))[0];
			if (last && last[1].phase === input.phase && normalizeReason(last[1].reason, last[1].release) === key) {
				cause = 'suspect';
				state.failedCommits[last[0]] = { ...last[1], cause: 'suspect' };
				this.host.warn(
					`${input.version ?? short(commit)} failed exactly like ${last[1].version ?? short(last[0])} did (${firstLine(reason)}). ` +
						'Two different releases failing the same way points at the updater or this host, not the releases; neither will be skipped.',
				);
			}
		}
		const verdict: FailureVerdict = {
			at: this.host.now().toISOString(),
			release,
			reason,
			...(input.phase ? { phase: input.phase } : {}),
			cause,
			updater: UPDATER_IDENTITY,
			...(input.version ? { version: input.version } : {}),
		};
		state.failedCommits[commit] = verdict;
		this.writeState(state);
		return verdict;
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
		const last = this.readState().lastSwitch;
		pruneUpgradeSnapshotBundles(layout.backupsDir, {
			keep: this.snapshotKeep,
			protect: last?.bundle ? [last.bundle] : []
		});
		// Legacy single-file snapshots from older updaters and the installer. A bundle's control DB
		// lives inside its own directory and is handled above.
		const keep = last?.snapshot && !last.snapshot.includes('/upgrade-') ? last.snapshot : null;
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

/**
 * The ref a source build should track for this release. Artifact installs before `tag` existed
 * recorded the release tag (`v0.7.11`) as `ref`; building that tag only ever finds the running
 * version, so those fall back to the default branch.
 */
export function trackedRef(meta: ReleaseMeta): string | undefined {
	if (meta.source === 'artifact' && !meta.tag) return undefined;
	return meta.ref;
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
	// Stage-0 updater compiled from this release (a CI artifact ships it at updater/ already).
	const updater = join(release, 'repo', 'scripts', 'update-self', 'dist', 'skiff-updated');
	if (existsSync(updater) && !existsSync(join(release, 'updater', 'skiff-updated'))) {
		mkdirSync(join(release, 'updater'), { recursive: true });
		copyFileSync(updater, join(release, 'updater', 'skiff-updated'));
		chmodSync(join(release, 'updater', 'skiff-updated'), 0o755);
	}
	// The privileged helper is part of the release so a `current` swap upgrades it atomically.
	const helper = join(release, 'repo', 'apps', 'helper', 'dist', 'skiff-helper');
	if (existsSync(helper)) {
		mkdirSync(join(release, 'helper'), { recursive: true });
		copyFileSync(helper, join(release, 'helper', 'skiff-helper'));
		chmodSync(join(release, 'helper', 'skiff-helper'), 0o755);
	}
	// CI-built Caddy ships at the release root (`caddy/caddy`); the updater installs it.
	const caddy = join(release, 'caddy', 'caddy');
	if (existsSync(caddy)) chmodSync(caddy, 0o755);
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
export function verifyRelease(
	release: string,
	layout: Pick<Layout, 'optDir' | 'controlPlaneUnitFile' | 'caddyUnitFile'>,
): string[] {
	const required = new Set([
		'repo/apps/control-plane/build/index.js',
		'runtime/bun',
		'agent/skiff-agent',
	]);
	for (const unitFile of [layout.controlPlaneUnitFile, layout.caddyUnitFile]) {
		if (!existsSync(unitFile)) continue;
		for (const path of unitReleasePaths(readFileSync(unitFile, 'utf8'), layout.optDir))
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

/** Migration ids `release` ships that the database has not applied yet (the schema would change). */
export function pendingMigrations(dbPath: string, release: string): string[] {
	const dir = join(release, 'repo', 'packages', 'db', 'migrations');
	if (!existsSync(dir)) return [];
	const shipped = readdirSync(dir).filter((file) => /^\d+_.*\.sql$/.test(file)).sort();
	if (!existsSync(dbPath)) return shipped;
	const applied = new Set(readAppliedMigrations(dbPath));
	return shipped.filter((id) => !applied.has(id));
}

/** A failure reason with release-specific noise (names, shas, numbers) removed, for comparison. */
export function normalizeReason(reason: string, release: string): string {
	return firstLine(reason)
		.split(release)
		.join('<release>')
		.replace(/[0-9a-f]{12,40}/g, '<sha>')
		.replace(/\d+/g, '<n>')
		.trim();
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
