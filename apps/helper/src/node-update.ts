import { spawn } from 'node:child_process';
import type { KeyObject } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import {
	hostPlatform,
	loadTrustedKeys,
	SignatureError,
	verifyManifest,
	type ManifestArtifact,
} from '../../../scripts/update-self/signing.ts';
import { ValidationError } from './validate.ts';

/**
 * The fixed `node/update` verb (D99): install a signed Skiff release's agent and helper on a worker.
 *
 * The only inputs are a release version and a repository name. Everything that decides what runs as
 * root is checked here, on the node: the release manifest must verify against a release-signing key
 * compiled into this binary (or one an operator dropped into /etc/skiff/updater/keys), the bundle
 * must match the manifest's size and sha256, and the version may not go backwards. A compromised
 * control plane or agent can therefore at most install a genuine, newer Skiff release.
 *
 * A control-plane host is refused: its binaries belong to the release `skiff-update-self` manages
 * (`/opt/skiff/current` is a symlink into /opt/skiff/releases there), and replacing them in place
 * would break that release's rollback.
 */

export const NODE_BUNDLE_FILES = ['skiff-agent', 'skiff-helper'] as const;

export interface NodeUpdateRequest {
	version: string;
	repo: string;
}

export interface NodeUpdateResult {
	version: string;
	previous: string;
	installed: string[];
}

export interface NodeUpdatePaths {
	/** The agent binary the units run (`skiff-builder`/`skiff-storage` are symlinks to it). */
	agentBinary: string;
	/** This helper's own binary. */
	helperBinary: string;
	/** A symlink here marks a control-plane release layout, which is refused. */
	releaseLink: string;
	/** Root-only scratch space for the download. */
	workDir: string;
}

export interface NodeUpdateDeps {
	paths: NodeUpdatePaths;
	/** The running helper's version (embedded at build time). */
	currentVersion: string;
	fetch?: typeof fetch;
	trustedKeys?: () => Map<string, KeyObject>;
	platform?: () => string;
	/** List an archive's entries (`tar -tzf`). */
	list?: (archive: string) => Promise<string[]>;
	/** Unpack an archive (`tar -xzf … -C dest`). */
	extract?: (archive: string, dest: string) => Promise<void>;
	/** Restart the agent and this helper once the response is out. */
	scheduleRestart?: () => void;
	log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export class NodeUpdateError extends Error {}

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;
const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;
const METADATA_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
/** Generous for two compiled Bun binaries; a bigger bundle is refused before it fills the disk. */
const MAX_BUNDLE_BYTES = 512 * 1024 * 1024;

export function parseNodeUpdateRequest(body: unknown): NodeUpdateRequest {
	if (typeof body !== 'object' || body === null || Array.isArray(body))
		throw new ValidationError('request must be an object');
	const record = body as Record<string, unknown>;
	const extra = Object.keys(record).filter((key) => key !== 'version' && key !== 'repo');
	if (extra.length) throw new ValidationError(`unexpected field ${extra[0]}`);
	if (typeof record.version !== 'string' || !VERSION_PATTERN.test(record.version))
		throw new ValidationError('version must be a release version like 1.2.3');
	if (typeof record.repo !== 'string' || record.repo.length > 140 || !REPO_PATTERN.test(record.repo))
		throw new ValidationError('repo must be owner/name');
	return { version: record.version, repo: record.repo };
}

export class NodeUpdater {
	private busy = false;
	private readonly fetch: typeof fetch;
	private readonly trustedKeys: () => Map<string, KeyObject>;
	private readonly platform: () => string;
	private readonly list: (archive: string) => Promise<string[]>;
	private readonly extract: (archive: string, dest: string) => Promise<void>;
	private readonly scheduleRestart: () => void;
	private readonly log: NonNullable<NodeUpdateDeps['log']>;

	constructor(private readonly deps: NodeUpdateDeps) {
		this.fetch = deps.fetch ?? fetch;
		this.trustedKeys = deps.trustedKeys ?? (() => loadTrustedKeys());
		this.platform = deps.platform ?? hostPlatform;
		this.list = deps.list ?? tarList;
		this.extract = deps.extract ?? tarExtract;
		this.scheduleRestart = deps.scheduleRestart ?? restartNodeServices;
		this.log = deps.log ?? (() => undefined);
	}

	async update(request: NodeUpdateRequest): Promise<NodeUpdateResult> {
		if (this.busy) throw new NodeUpdateError('a node update is already running');
		this.busy = true;
		try {
			const result = await this.install(request);
			// After the caller has its answer: restarting the helper ends this process.
			this.scheduleRestart();
			return result;
		} finally {
			this.busy = false;
		}
	}

	private async install({ version, repo }: NodeUpdateRequest): Promise<NodeUpdateResult> {
		const { paths, currentVersion } = this.deps;
		await this.refuseReleaseLayout();
		if (!(await isFile(paths.agentBinary)))
			throw new NodeUpdateError(`no agent binary at ${paths.agentBinary}; this node was not installed the way the updater expects`);
		if (compareVersions(version, currentVersion) < 0)
			throw new NodeUpdateError(`refusing to downgrade from ${currentVersion} to ${version}`);

		const base = `https://github.com/${repo}/releases/download/v${version}`;
		const manifestBytes = await this.download(`${base}/manifest.json`, `v${version} has no signed manifest in ${repo}`);
		const signature = new TextDecoder().decode(
			await this.download(`${base}/manifest.json.sig`, `v${version} has no manifest signature in ${repo}`),
		);
		let manifest;
		try {
			manifest = verifyManifest(manifestBytes, signature, this.trustedKeys());
		} catch (error) {
			if (error instanceof SignatureError) throw new NodeUpdateError(`v${version} is not trusted: ${error.message}`);
			throw error;
		}
		if (manifest.version !== version)
			throw new NodeUpdateError(`v${version}'s signed manifest describes ${manifest.version}; refusing a mislabelled release`);
		if (manifest.repo.toLowerCase() !== repo.toLowerCase())
			throw new NodeUpdateError(`v${version}'s signed manifest is for ${manifest.repo}, not ${repo}`);
		const platform = this.platform();
		const entry = manifest.nodeArtifacts?.[platform];
		if (!entry)
			throw new NodeUpdateError(
				`v${version} ships no node bundle for ${platform}${manifest.nodeArtifacts ? '' : ' (it predates node updates)'}`,
			);
		assertBundleEntry(entry);

		await fs.rm(paths.workDir, { recursive: true, force: true });
		await fs.mkdir(paths.workDir, { recursive: true, mode: 0o700 });
		try {
			const archive = join(paths.workDir, entry.file);
			this.log('info', `downloading ${entry.file} (${(entry.size / 1024 ** 2).toFixed(0)} MiB) from v${version}`);
			await this.downloadTo(`${base}/${entry.file}`, archive, entry.size);
			const sha256 = await sha256Of(archive);
			if (sha256 !== entry.sha256)
				throw new NodeUpdateError(`${entry.file} does not match its signed checksum (got ${sha256.slice(0, 16)}…)`);

			const entries = (await this.list(archive)).filter(Boolean);
			const expected = [...NODE_BUNDLE_FILES].sort();
			if (JSON.stringify([...entries].sort()) !== JSON.stringify(expected))
				throw new NodeUpdateError(`${entry.file} must contain exactly ${expected.join(' and ')}; found ${entries.join(', ') || 'nothing'}`);
			const stage = join(paths.workDir, 'stage');
			await fs.mkdir(stage, { mode: 0o700 });
			await this.extract(archive, stage);

			// Stage both before swapping either, so a failure leaves the old pair in place.
			const targets = [
				{ source: join(stage, 'skiff-agent'), dest: paths.agentBinary },
				{ source: join(stage, 'skiff-helper'), dest: paths.helperBinary },
			];
			for (const { source, dest } of targets) {
				if (!(await isFile(source))) throw new NodeUpdateError(`${entry.file} did not unpack ${source}`);
				await fs.mkdir(dirname(dest), { recursive: true });
				await fs.copyFile(source, `${dest}.new`);
				await fs.chmod(`${dest}.new`, 0o755);
				await fs.chown(`${dest}.new`, 0, 0).catch(() => undefined);
			}
			for (const { dest } of targets) {
				// Keep one previous copy for a manual rollback; rename is atomic over a running binary.
				if (await isFile(dest)) await fs.copyFile(dest, `${dest}.previous`);
				await fs.rename(`${dest}.new`, dest);
			}
			this.log('info', `installed skiff-agent and skiff-helper ${version} (was ${currentVersion}); restarting`);
			return { version, previous: currentVersion, installed: targets.map((target) => target.dest) };
		} finally {
			for (const dest of [paths.agentBinary, paths.helperBinary])
				await fs.rm(`${dest}.new`, { force: true }).catch(() => undefined);
			await fs.rm(paths.workDir, { recursive: true, force: true }).catch(() => undefined);
		}
	}

	private async refuseReleaseLayout(): Promise<void> {
		const stat = await fs.lstat(this.deps.paths.releaseLink).catch(() => null);
		if (stat?.isSymbolicLink())
			throw new NodeUpdateError(
				`${this.deps.paths.releaseLink} is a control-plane release; this node updates with skiff-update-self, not from the node list`,
			);
	}

	private async download(url: string, missing: string): Promise<Uint8Array> {
		const response = await this.fetch(url, { signal: AbortSignal.timeout(METADATA_TIMEOUT_MS), redirect: 'follow' });
		if (response.status === 404) throw new NodeUpdateError(missing);
		if (!response.ok) throw new NodeUpdateError(`GitHub ${response.status} fetching ${url}`);
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.length > 1024 * 1024) throw new NodeUpdateError(`${url} is unexpectedly large`);
		return bytes;
	}

	private async downloadTo(url: string, path: string, size: number): Promise<void> {
		const response = await this.fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), redirect: 'follow' });
		if (!response.ok || !response.body) throw new NodeUpdateError(`GitHub ${response.status} downloading ${url}`);
		await Bun.write(path, response);
		const written = (await fs.stat(path)).size;
		if (written !== size) throw new NodeUpdateError(`${url} is ${written} bytes; the signed manifest says ${size}`);
	}
}

function assertBundleEntry(entry: ManifestArtifact): void {
	if (!/^skiff-node-[\w.-]+\.tar\.gz$/.test(entry.file)) throw new NodeUpdateError(`unexpected node bundle name ${entry.file}`);
	if (!/^[0-9a-f]{64}$/.test(entry.sha256)) throw new NodeUpdateError('the node bundle has no sha256');
	if (!Number.isInteger(entry.size) || entry.size <= 0 || entry.size > MAX_BUNDLE_BYTES)
		throw new NodeUpdateError(`the node bundle size (${entry.size}) is out of range`);
}

/** -1, 0 or 1 for plain `x.y.z` versions; an unparseable current version never blocks an update. */
export function compareVersions(a: string, b: string): number {
	const left = VERSION_PATTERN.exec(a);
	const right = VERSION_PATTERN.exec(b);
	if (!left || !right) return 1;
	for (let index = 1; index <= 3; index += 1) {
		const diff = Number(left[index]) - Number(right[index]);
		if (diff !== 0) return diff > 0 ? 1 : -1;
	}
	return 0;
}

async function isFile(path: string): Promise<boolean> {
	return (await fs.stat(path).catch(() => null))?.isFile() ?? false;
}

async function sha256Of(path: string): Promise<string> {
	const hasher = new Bun.CryptoHasher('sha256');
	for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
	return hasher.digest('hex');
}

function run(command: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
		child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
		child.on('error', reject);
		child.on('close', (code) =>
			code === 0 ? resolve(stdout) : reject(new NodeUpdateError(`${command} ${args[0]} failed: ${stderr.trim().slice(0, 300)}`)),
		);
	});
}

async function tarList(archive: string): Promise<string[]> {
	return (await run('tar', ['-tzf', archive])).split('\n').map((line) => line.trim()).filter(Boolean);
}

async function tarExtract(archive: string, dest: string): Promise<void> {
	await run('tar', ['-xzf', archive, '-C', dest, '--no-same-owner', ...NODE_BUNDLE_FILES]);
}

/**
 * Queue the restarts with systemd and return at once (`--no-block`): the helper's own restart ends
 * this process, so it must not wait. The builder and studio run the agent binary too.
 */
export function restartNodeServices(systemctl = '/usr/bin/systemctl'): void {
	setTimeout(() => {
		const queue = (args: string[]) => spawn(systemctl, ['--no-block', ...args], { stdio: 'ignore', detached: true }).unref();
		queue(['try-restart', 'skiff-builder.service', 'skiff-studio.service']);
		queue(['restart', 'skiff-agent.service', 'skiff-helper.service']);
	}, 500);
}
