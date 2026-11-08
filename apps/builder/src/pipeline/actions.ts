import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { PipelineBuiltinAction, PipelineJobClaim } from '@skiff/contracts';
import { zipDirectory } from '../zip.ts';
import { PipelineApiError, type JobApi } from './client.ts';
import { inputLines, resolveUserPath, truthyInput } from './context.ts';
import {
	BUILDKIT_BIN_DIR,
	BUILDKIT_DEFAULT_HOST,
	attestationInputs,
	buildctlArgs,
	buildkitCacheScope,
	checkBuildArgs,
	checkLabels,
	parseSecretFiles,
	parseSecretInputs,
	platformInput,
	type Attestations,
} from './image-build.ts';
import { RegistryClient, createImageIndex, parseImageReference } from './image-registry.ts';
import type { Masker } from './masker.ts';

/**
 * Built-in actions (W13): `skiff/*` and their `actions/*` aliases, implemented in the step runner
 * against the job API instead of GitHub's Twirp services. Each returns an outcome and outputs and
 * logs through the host, so masking and cancellation apply as for `run:` steps.
 */

export interface ActionHost {
	api: JobApi;
	claim: PipelineJobClaim;
	workspace: string;
	temp: string;
	home: string;
	/** The step's working directory. */
	cwd: string;
	/** The step's process environment. */
	env: Record<string, string>;
	masker: Masker;
	secretNames: string[];
	log(text: string, stream?: 'stdout' | 'stderr' | 'system'): void;
	/** Run a tool with its output in the step log; returns the exit code. */
	exec(argv: string[], options?: { cwd?: string; env?: Record<string, string>; stdin?: string }): Promise<number>;
	/** Register work for after the last step (only on job success). */
	addPost(run: () => Promise<void>): void;
	isCancelled(): boolean;
}

export interface ActionResult {
	outcome: 'success' | 'failure';
	outputs: Record<string, string>;
}

export class ActionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ActionError';
	}
}

export async function runAction(action: PipelineBuiltinAction, inputs: Record<string, string>, host: ActionHost): Promise<ActionResult> {
	try {
		switch (action) {
			case 'skiff/checkout':
				return checkout(inputs, host);
			case 'skiff/cache':
				return await cache(inputs, host);
			case 'skiff/upload-artifact':
				return await uploadArtifact(inputs, host);
			case 'skiff/download-artifact':
				return await downloadArtifact(inputs, host);
			case 'skiff/deploy':
				return await deploy(inputs, host);
			case 'skiff/build-image':
				return await buildImage(inputs, host);
			case 'skiff/image-index':
				return await imageIndex(inputs, host);
			case 'skiff/oidc-token':
				return await oidcToken(inputs, host);
		}
		throw new ActionError(`Unknown built-in action ${String(action)}`);
	} catch (error) {
		host.log(`Error: ${error instanceof Error ? error.message : String(error)}`, 'stderr');
		return { outcome: 'failure', outputs: {} };
	}
}

// --- helpers ------------------------------------------------------------------------------

function sha256Hex(data: Uint8Array): string {
	return createHash('sha256').update(data).digest('hex');
}

async function sha256File(path: string): Promise<{ sha256: string; size: number }> {
	const data = new Uint8Array(await readFile(path));
	return { sha256: sha256Hex(data), size: data.byteLength };
}

function isInside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Run tar quietly through the host (logged on failure). */
async function tar(host: ActionHost, args: string[], cwd: string): Promise<void> {
	const code = await host.exec(['tar', ...args], { cwd });
	if (code !== 0) throw new ActionError(`tar exited with code ${code}`);
}

const GLOB_CHARS = /[*?[\]{}!]/;

/** The directory part of a pattern before its first glob segment (GitHub's search root). */
function literalRoot(pattern: string): string {
	const parts = pattern.split('/');
	const literal: string[] = [];
	for (const part of parts) {
		if (GLOB_CHARS.test(part)) break;
		literal.push(part);
	}
	return literal.join('/') || (pattern.startsWith('/') ? '/' : '.');
}

function commonAncestor(paths: string[]): string {
	if (!paths.length) return '/';
	let parts = paths[0]!.split(sep);
	for (const path of paths.slice(1)) {
		const other = path.split(sep);
		let index = 0;
		while (index < parts.length && index < other.length && parts[index] === other[index]) index += 1;
		parts = parts.slice(0, index);
	}
	return parts.join(sep) || sep;
}

async function walkFiles(root: string, into: Set<string>): Promise<void> {
	const info = await lstat(root).catch(() => null);
	if (!info) return;
	if (info.isFile()) {
		into.add(root);
		return;
	}
	if (!info.isDirectory()) return;
	for (const name of await Array.fromAsync(new Bun.Glob('**/*').scan({ cwd: root, dot: true, onlyFiles: true }))) into.add(join(root, name));
}

/**
 * Expand `path:` lines (globs relative to the workspace, `~` for HOME, `!` to exclude) into files
 * and the common root they are archived relative to.
 */
export async function collectFiles(
	lines: string[],
	workspace: string,
	home: string,
): Promise<{ root: string; files: string[] }> {
	const files = new Set<string>();
	const roots: string[] = [];
	const excludes: Bun.Glob[] = [];
	for (const line of lines) {
		if (line.startsWith('!')) {
			excludes.push(new Bun.Glob(resolveUserPath(workspace, home, line.slice(1))));
			continue;
		}
		const absolute = resolveUserPath(workspace, home, line);
		if (!GLOB_CHARS.test(line.replace(/^~/, ''))) {
			const info = await stat(absolute).catch(() => null);
			if (!info) continue;
			roots.push(info.isDirectory() ? absolute : dirname(absolute));
			await walkFiles(absolute, files);
			continue;
		}
		const root = resolve(literalRoot(absolute));
		if (!(await stat(root).catch(() => null))?.isDirectory()) continue;
		roots.push(root);
		const pattern = relative(root, absolute);
		for await (const match of new Bun.Glob(pattern).scan({ cwd: root, dot: true, onlyFiles: false })) await walkFiles(join(root, match), files);
	}
	const kept = [...files].filter((file) => !excludes.some((glob) => glob.match(file))).sort();
	return { root: commonAncestor(roots), files: kept };
}

// --- checkout -----------------------------------------------------------------------------

function checkout(inputs: Record<string, string>, host: ActionHost): ActionResult {
	const { claim } = host;
	const problems: string[] = [];
	const repository = inputs.repository?.trim();
	if (repository && repository !== claim.repository.name && !claim.repository.name.endsWith(`/${repository}`) && !repository.endsWith(`/${claim.repository.name}`))
		problems.push(`repository "${repository}"`);
	const ref = inputs.ref?.trim();
	if (ref && ![claim.checkout.ref, claim.checkout.sha, claim.checkout.ref.replace(/^refs\/(heads|tags)\//, '')].includes(ref) && !claim.checkout.sha.startsWith(ref))
		problems.push(`ref "${ref}"`);
	const path = inputs.path?.trim();
	if (path && path !== '.' && resolve(host.workspace, path) !== host.workspace) problems.push(`path "${path}"`);
	if (problems.length) {
		host.log(
			`Error: checking out ${problems.join(', ')} is not supported yet. The workspace already holds ` +
				`${claim.repository.name} at ${claim.checkout.sha}; clone other repositories with git in a run: step.`,
			'stderr',
		);
		return { outcome: 'failure', outputs: {} };
	}
	for (const ignored of ['submodules', 'lfs'])
		if (truthyInput(inputs[ignored])) host.log(`Warning: ${ignored} is not supported by skiff/checkout and was ignored.`, 'stderr');
	host.log(`The workspace is already checked out at ${claim.checkout.sha} (${claim.checkout.ref}).`);
	return { outcome: 'success', outputs: { ref: claim.checkout.ref, commit: claim.checkout.sha } };
}

// --- cache --------------------------------------------------------------------------------

/** Different path sets (or compression) never share a cache entry, as in actions/cache. */
export function cacheVersion(paths: string[]): string {
	return createHash('sha256')
		.update([...paths].sort().join('|'))
		.update('|gzip')
		.digest('hex');
}

/** Archive member names: relative to the workspace when inside it, absolute (with -P) otherwise. */
function cacheMembers(paths: string[], workspace: string, home: string): string[] {
	return paths.map((path) => {
		const absolute = resolveUserPath(workspace, home, path);
		// `./` keeps a member such as `-foo` from being read as a tar option.
		return isInside(workspace, absolute) ? `./${relative(workspace, absolute)}` : absolute;
	});
}

async function cache(inputs: Record<string, string>, host: ActionHost): Promise<ActionResult> {
	const paths = inputLines(inputs.path);
	const key = inputs.key?.trim();
	if (!paths.length) throw new ActionError('Input required and not supplied: path');
	if (!key) throw new ActionError('Input required and not supplied: key');
	if (paths.some((path) => GLOB_CHARS.test(path))) throw new ActionError('Cache paths cannot be globs yet; list directories or files');
	const restoreKeys = inputLines(inputs['restore-keys']).slice(0, 10);
	const version = cacheVersion(paths);
	const members = cacheMembers(paths, host.workspace, host.home);

	let exactHit = false;
	const hit = await host.api.cacheLookup({ key, restoreKeys, version });
	if (hit) {
		const archive = join(host.temp, `cache-${randomUUID()}.tgz`);
		try {
			await host.api.download(hit.downloadUrl, archive);
			await tar(host, ['-xzPf', archive], host.workspace);
			exactHit = hit.key === key;
			host.log(`Cache restored from key: ${hit.key}`);
		} finally {
			await rm(archive, { force: true });
		}
	} else {
		host.log(`Cache not found for input keys: ${[key, ...restoreKeys].join(', ')}`);
	}

	if (!exactHit && !inputs['lookup-only']) {
		host.addPost(async () => {
			const existing: string[] = [];
			for (const member of members) {
				const absolute = isAbsolute(member) ? member : join(host.workspace, member);
				if (await lstat(absolute).catch(() => null)) existing.push(member);
			}
			if (!existing.length) {
				host.log('Warning: none of the cache paths exist; nothing saved.', 'stderr');
				return;
			}
			const archive = join(host.temp, `cache-save-${randomUUID()}.tgz`);
			try {
				await tar(host, ['-czPf', archive, ...existing], host.workspace);
				const { size } = await sha256File(archive);
				const reservation = await host.api.cacheReserve({ key, version, size });
				if (!reservation.uploadUrl || !reservation.cacheId) {
					host.log(`Cache not saved: ${reservation.reason ?? 'the key already exists'}`);
					return;
				}
				await host.api.upload(reservation.uploadUrl, Bun.file(archive), 'application/gzip');
				await host.api.cacheCommit(reservation.cacheId);
				host.log(`Cache saved with key: ${key} (${size} bytes)`);
			} finally {
				await rm(archive, { force: true });
			}
		});
	}
	return { outcome: 'success', outputs: { 'cache-hit': exactHit ? 'true' : 'false' } };
}

// --- artifacts ----------------------------------------------------------------------------

async function uploadArtifact(inputs: Record<string, string>, host: ActionHost): Promise<ActionResult> {
	const name = inputs.name?.trim() || 'artifact';
	const lines = inputLines(inputs.path);
	if (!lines.length) throw new ActionError('Input required and not supplied: path');
	const ifNoFiles = (inputs['if-no-files-found']?.trim() || 'warn').toLowerCase();
	const { root, files } = await collectFiles(lines, host.workspace, host.home);
	if (!files.length) {
		const message = `No files were found with the provided path: ${lines.join(', ')}. No artifacts will be uploaded.`;
		if (ifNoFiles === 'error') throw new ActionError(message);
		if (ifNoFiles !== 'ignore') host.log(`Warning: ${message}`, 'stderr');
		return { outcome: 'success', outputs: {} };
	}
	const retention = inputs['retention-days']?.trim();
	const retentionDays = retention ? Number.parseInt(retention, 10) : undefined;
	if (retentionDays !== undefined && (!Number.isFinite(retentionDays) || retentionDays < 1 || retentionDays > 90))
		throw new ActionError('retention-days must be between 1 and 90');

	const list = join(host.temp, `artifact-${randomUUID()}.list`);
	const archive = join(host.temp, `artifact-${randomUUID()}.tgz`);
	try {
		await writeFile(list, files.map((file) => relative(root, file)).join('\0') + '\0');
		await tar(host, ['-czf', archive, '--null', '-T', list], root);
		const { sha256, size } = await sha256File(archive);
		const upload = await host.api.createArtifact({ name, size, sha256, ...(retentionDays ? { retentionDays } : {}) });
		await host.api.upload(upload.uploadUrl, Bun.file(archive), 'application/gzip');
		const view = await host.api.finalizeArtifact(upload.artifactId);
		host.log(`Uploaded artifact ${name}: ${files.length} files, ${size} bytes (id ${view?.id ?? upload.artifactId}).`);
		return { outcome: 'success', outputs: { 'artifact-id': view?.id ?? upload.artifactId } };
	} finally {
		await rm(list, { force: true });
		await rm(archive, { force: true });
	}
}

async function downloadArtifact(inputs: Record<string, string>, host: ActionHost): Promise<ActionResult> {
	const name = inputs.name?.trim() || undefined;
	const target = inputs.path?.trim() ? resolveUserPath(host.workspace, host.home, inputs.path) : host.workspace;
	const artifacts = await host.api.listArtifacts(name);
	const selected = name ? artifacts.filter((artifact) => artifact.name === name) : artifacts;
	if (name && !selected.length) throw new ActionError(`Unable to find an artifact named "${name}" in this run`);
	for (const artifact of selected) {
		if (!artifact.downloadUrl) throw new ActionError(`Artifact ${artifact.name} has no download URL`);
		// Names are validated server-side (no separators), so this stays under `target`.
		const destination = name ? target : join(target, artifact.name);
		await mkdir(destination, { recursive: true });
		const archive = join(host.temp, `download-${randomUUID()}.tgz`);
		try {
			await host.api.download(artifact.downloadUrl, archive);
			const { sha256 } = await sha256File(archive);
			if (sha256 !== artifact.sha256) throw new ActionError(`Artifact ${artifact.name} failed its checksum`);
			await tar(host, ['-xzf', archive], destination);
			host.log(`Downloaded artifact ${artifact.name} to ${destination}`);
		} finally {
			await rm(archive, { force: true });
		}
	}
	return { outcome: 'success', outputs: { 'download-path': target } };
}

// --- deploy -------------------------------------------------------------------------------

async function deploy(inputs: Record<string, string>, host: ActionHost): Promise<ActionResult> {
	const project = inputs.project?.trim();
	if (!project) throw new ActionError('Input required and not supplied: project');
	const image = inputs.image?.trim();
	const path = inputs.path?.trim();
	if (Boolean(image) === Boolean(path)) throw new ActionError('Set exactly one of image or path');
	const promote = truthyInput(inputs.promote);
	const message = inputs.message?.trim() || undefined;

	if (image) {
		const start = await host.api.deploy({ project, image, archive: false, promote, message });
		host.log(`Deployed ${image} to ${project}${start.url ? ` (${start.url})` : ''}.`);
		return { outcome: 'success', outputs: { 'deployment-id': start.deploymentId ?? '', url: start.url ?? '' } };
	}
	const directory = resolveUserPath(host.workspace, host.home, path!);
	const zipped = await zipDirectory(directory);
	host.log(`Packed ${zipped.fileCount} files (${zipped.sizeBytes} bytes) from ${path}.`);
	const start = await host.api.deploy({ project, archive: true, promote, message });
	if (!start.uploadUrl) throw new ActionError('The control plane returned no upload URL for the archive deploy');
	await host.api.upload(start.uploadUrl, zipped.zip, 'application/zip');
	const result = await host.api.finalizeDeploy(start.deployId);
	host.log(`Deployed to ${project}${result.url ? ` (${result.url})` : ''}.`);
	return { outcome: 'success', outputs: { 'deployment-id': result.deploymentId, url: result.url ?? '' } };
}

// --- oidc-token (W9) -----------------------------------------------------------------------

/**
 * `skiff/oidc-token`: mint an OIDC ID token for cloud federation with the job token. The token is
 * masked before it becomes the step output `token`; it never enters any step's environment.
 */
async function oidcToken(inputs: Record<string, string>, host: ActionHost): Promise<ActionResult> {
	const audience = inputs.audience?.trim() || undefined;
	if (audience && audience.length > 512) throw new ActionError('audience must be at most 512 characters');
	let response: Awaited<ReturnType<JobApi['oidcToken']>>;
	try {
		response = await host.api.oidcToken(audience);
	} catch (error) {
		if (error instanceof PipelineApiError && error.status === 403)
			throw new ActionError('OIDC tokens are not available to untrusted runs (fork pull requests, inline workflows)');
		throw error;
	}
	if (!response?.token) throw new ActionError('The control plane returned no OIDC token');
	host.masker.add(response.token);
	host.log(`Minted an OIDC token${audience ? ` for audience ${audience}` : ''}, valid until ${new Date(response.expiresAt < 1e12 ? response.expiresAt * 1000 : response.expiresAt).toISOString()}.`);
	return { outcome: 'success', outputs: { token: response.token, 'expires-at': String(response.expiresAt) } };
}

// --- build-image (EXPERIMENTAL: pending spikes WS1/WS2) -------------------------------------

/** `registry/acme/api:tag` → `registry/acme/api` (a `:port` in the host is kept). */
export function imageWithoutTag(reference: string): string {
	const withoutDigest = reference.split('@')[0]!;
	const slash = withoutDigest.lastIndexOf('/');
	const colon = withoutDigest.lastIndexOf(':');
	return colon > slash ? withoutDigest.slice(0, colon) : withoutDigest;
}

function registryHost(reference: string): string {
	const first = reference.split('/')[0]!;
	return reference.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost') ? first : 'docker.io';
}

/**
 * `registry/<name>:<tag>` → `<host>/<org>/<name>:<tag>`, and `registry/<org>/<name>` → `<host>/<org>/<name>`:
 * the platform registry the claim names (docs/REGISTRY.md). Other references are unchanged.
 */
export function expandRegistryTag(tag: string, registry: PipelineJobClaim['registry']): string {
	if (!tag.startsWith('registry/')) return tag;
	if (!registry) throw new ActionError(`"${tag}" names Skiff's registry, but the platform registry is off on this install`);
	const rest = tag.slice('registry/'.length);
	const path = rest.split(/[:@]/, 1)[0]!;
	return path.includes('/') ? `${registry.host}/${rest}` : `${registry.namespace}/${rest}`;
}

type ImageBuilder = 'buildkit' | 'buildah' | 'podman' | 'docker';

/**
 * The environment builders are looked up in: the step's, plus the W6 sidecar's `buildctl`
 * (`/skiff/bin`) and `BUILDKIT_HOST`, which the runner sets on the job container but the step
 * runner does not pass through to steps.
 */
export function builderEnv(host: Pick<ActionHost, 'env' | 'claim'>, processEnv: Record<string, string | undefined> = process.env): Record<string, string> {
	const env = { ...host.env };
	const path = env.PATH ?? '';
	if (!path.split(':').includes(BUILDKIT_BIN_DIR)) env.PATH = path ? `${path}:${BUILDKIT_BIN_DIR}` : BUILDKIT_BIN_DIR;
	const buildkitHost = env.BUILDKIT_HOST || processEnv.BUILDKIT_HOST || (host.claim.buildkit ? BUILDKIT_DEFAULT_HOST : '');
	if (buildkitHost) env.BUILDKIT_HOST = buildkitHost;
	return env;
}

/** `builder:` input, else the first tool this job can use: BuildKit, buildah, podman, docker. */
function chooseBuilder(input: string | undefined, env: Record<string, string>): ImageBuilder {
	const has = (bin: string) => Boolean(Bun.which(bin, { PATH: env.PATH ?? '' }));
	const wanted = input?.trim().toLowerCase() || 'auto';
	if (wanted !== 'auto') {
		if (!['buildkit', 'buildah', 'podman', 'docker'].includes(wanted)) throw new ActionError(`builder must be auto, buildkit, buildah, podman or docker (got "${wanted}")`);
		const bin = wanted === 'buildkit' ? 'buildctl' : wanted;
		if (!has(bin)) throw new ActionError(`builder ${wanted} needs ${bin} on PATH`);
		if (wanted === 'buildkit' && !env.BUILDKIT_HOST) throw new ActionError('builder buildkit needs BUILDKIT_HOST');
		return wanted as ImageBuilder;
	}
	if (env.BUILDKIT_HOST && has('buildctl')) return 'buildkit';
	for (const tool of ['buildah', 'podman', 'docker'] as const) if (has(tool)) return tool;
	throw new ActionError('No image builder in this job: install buildah, podman or docker, or set BUILDKIT_HOST for buildctl');
}

function isLocalRegistry(registry: string): boolean {
	const name = registry.replace(/:\d+$/, '');
	return name === 'localhost' || /^127\.\d+\.\d+\.\d+$/.test(name);
}

/** Options every backend understands (buildkit, docker, podman, buildah). */
interface BuildOptions {
	tags: string[];
	context: string;
	file: string;
	buildArgs: string[];
	labels: string[];
	target: string | null;
	platform: string | null;
	secrets: Array<{ id: string; src: string }>;
	/** Requested attestations; `explicit` when the workflow set provenance/sbom itself. */
	attestations: Attestations & { explicit: boolean };
	push: boolean;
}

async function buildImage(inputs: Record<string, string>, host: ActionHost): Promise<ActionResult> {
	const tags = inputLines(inputs.tags, /[\n,]/).map((tag) => expandRegistryTag(tag, host.claim.registry));
	if (!tags.length) throw new ActionError('Input required and not supplied: tags');
	for (const tag of tags) if (!/^[A-Za-z0-9][A-Za-z0-9._\/:@-]{0,511}$/.test(tag)) throw new ActionError(`Invalid tag "${tag}"`);
	const context = resolve(host.workspace, inputs.context?.trim() || '.');
	if (!isInside(host.workspace, context)) throw new ActionError('context must be inside the workspace');
	const file = inputs.file?.trim() ? resolve(host.workspace, inputs.file.trim()) : join(context, 'Dockerfile');
	if (!isInside(host.workspace, file)) throw new ActionError('file must be inside the workspace');
	// W11: secrets reach a build only as secret mounts, never as build args (they land in history).
	const secrets = parseSecretInputs(inputs.secrets);
	for (const secret of secrets) host.masker.add(secret.value);
	const buildArgs = checkBuildArgs(inputLines(inputs['build-args']), (text) => host.masker.contains(text), secrets);
	const labels = checkLabels(inputLines(inputs.labels));
	const secretFiles = parseSecretFiles(inputLines(inputs['secret-files'])).map(({ id, path }) => {
		const absolute = resolveUserPath(host.workspace, host.home, path);
		if (!isInside(host.workspace, absolute) && !isInside(host.temp, absolute)) throw new ActionError(`secret-files ${id}: the file must be in the workspace or RUNNER_TEMP`);
		return { id, src: absolute };
	});
	const target = inputs.target?.trim() || null;
	if (target && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(target)) throw new ActionError(`Invalid target "${target}"`);
	const platform = platformInput(inputs.platforms ?? inputs.platform);
	const push = truthyInput(inputs.push, true);
	const attestations = { ...attestationInputs(inputs, push), explicit: Boolean(inputs.provenance?.trim() || inputs.sbom?.trim()) };
	const registry = registryHost(tags[0]!);
	let username = inputs.username?.trim();
	let password = inputs.password ?? '';
	// Skiff's own registry: log in as this job with its token (docs/PIPELINES.md W9), no secret needed.
	const own = host.claim.registry && registry === host.claim.registry.host;
	if (own && push && !host.claim.registry!.push) throw new ActionError('Untrusted runs (pull requests from forks) cannot push images');
	if (own && !username) {
		username = `job.${host.claim.jobId}`;
		password = host.claim.token;
	}
	if (tags.some((tag) => registryHost(tag) !== registry)) throw new ActionError('All tags must be on one registry');
	const env = builderEnv(host);
	const builder = chooseBuilder(inputs.builder, env);
	host.log(`Building ${tags.join(', ')} with ${builder}.`, 'system');

	// One private directory for everything this step writes: registry auth, secret files, metadata.
	const work = join(host.temp, `build-image-${randomUUID()}`);
	await mkdir(work, { recursive: true, mode: 0o700 });
	const digestFile = join(work, 'digest');
	const authDir = join(work, 'auth');
	await mkdir(authDir, { recursive: true, mode: 0o700 });
	const authFile = join(authDir, 'config.json');
	if (username) {
		const auth = Buffer.from(`${username}:${password}`).toString('base64');
		host.masker.add(auth);
		if (password) host.masker.add(password);
		await writeFile(authFile, JSON.stringify({ auths: { [registry]: { auth } } }), { mode: 0o600 });
	}
	const secretDir = join(work, 'secrets');
	await mkdir(secretDir, { recursive: true, mode: 0o700 });
	const secretMounts = [...secretFiles];
	for (const [index, secret] of secrets.entries()) {
		const src = join(secretDir, `${index}`);
		await writeFile(src, secret.value, { mode: 0o600 });
		secretMounts.push({ id: secret.id, src });
	}
	const options: BuildOptions = { tags, context, file, buildArgs, labels, target, platform, secrets: secretMounts, attestations, push };

	try {
		if (builder === 'docker' || builder === 'podman') {
			await buildWithEngine(builder, { ...options, authFile: username ? authFile : null, authDir, digestFile }, host);
		} else if (builder === 'buildkit') {
			await buildWithBuildkit(options, { env, authDir, digestFile, metadata: join(work, 'metadata.json'), own: Boolean(own), registry }, inputs, host);
		} else {
			await buildWithBuildah(options, { username, password, registry, digestFile }, host);
		}
		return await finishBuild(tags, digestFile, host);
	} finally {
		await rm(work, { recursive: true, force: true });
	}
}

/**
 * `buildctl` against the per-job sidecar (W6). Registry auth through a throwaway DOCKER_CONFIG;
 * on the platform registry a scoped registry cache (`<image>:buildcache-<scope>`), exported only by
 * trusted runs that may push (W10).
 */
async function buildWithBuildkit(
	options: BuildOptions,
	io: { env: Record<string, string>; authDir: string; digestFile: string; metadata: string; own: boolean; registry: string },
	inputs: Record<string, string>,
	host: ActionHost,
): Promise<void> {
	const buildctl = Bun.which('buildctl', { PATH: io.env.PATH ?? '' });
	if (!buildctl) throw new ActionError('BUILDKIT_HOST is set but buildctl is not on PATH');
	const cache: { importRefs: string[]; exportRef: string | null } = { importRefs: [], exportRef: null };
	if (io.own && truthyInput(inputs.cache, true)) {
		const scope = buildkitCacheScope(host.claim, { ...process.env, ...host.env });
		const base = imageWithoutTag(options.tags[0]!);
		const ref = `${base}:buildcache-${scope}`;
		cache.importRefs.push(ref);
		const trusted = host.claim.trust === 'trusted';
		// A pull request reads the trusted cache but never writes any shared scope.
		if (!trusted && scope !== 'trusted') cache.importRefs.push(`${base}:buildcache-trusted`);
		if (trusted && options.push && host.claim.registry?.push) cache.exportRef = ref;
		host.log(`Registry cache: ${ref}${cache.exportRef ? '' : ' (read-only)'}`);
	}
	const argv = buildctlArgs({
		context: options.context,
		dockerfileDir: dirname(options.file),
		filename: relative(dirname(options.file), options.file),
		tags: options.tags,
		push: options.push,
		target: options.target,
		platform: options.platform,
		buildArgs: options.buildArgs,
		labels: options.labels,
		secrets: options.secrets,
		attestations: options.attestations,
		cache,
		metadataFile: io.metadata,
		insecure: isLocalRegistry(io.registry),
	});
	const code = await host.exec([buildctl, ...argv], { env: { DOCKER_CONFIG: io.authDir, BUILDKIT_HOST: io.env.BUILDKIT_HOST! } });
	if (code !== 0) throw new ActionError(`buildctl exited with code ${code}`);
	const parsed = JSON.parse(await readFile(io.metadata, 'utf8').catch(() => '{}')) as Record<string, unknown>;
	if (options.push) await writeFile(io.digestFile, String(parsed['containerimage.digest'] ?? ''));
}

/** The W6 fallback: `buildah --isolation chroot` on `vfs` (no attestations, no registry cache). */
async function buildWithBuildah(
	options: BuildOptions,
	io: { username: string | undefined; password: string; registry: string; digestFile: string },
	host: ActionHost,
): Promise<void> {
	if (options.attestations.explicit && (options.attestations.provenance || options.attestations.sbom))
		host.log('Warning: buildah does not attach provenance or SBOM attestations; they were skipped.', 'stderr');
	const storage = ['--storage-driver', 'vfs'];
	if (io.username) {
		const code = await host.exec(['buildah', 'login', ...storage, '--username', io.username, '--password-stdin', io.registry], { stdin: io.password });
		if (code !== 0) throw new ActionError(`buildah login to ${io.registry} failed`);
	}
	const build = await host.exec(['buildah', 'build', ...storage, '--isolation', 'chroot', ...engineFlags(options), options.context], { cwd: options.context });
	if (build !== 0) throw new ActionError(`buildah build exited with code ${build}`);
	if (options.push) {
		for (const [index, tag] of options.tags.entries()) {
			const code = await host.exec(['buildah', 'push', ...storage, ...(index === 0 ? ['--digestfile', io.digestFile] : []), tag]);
			if (code !== 0) throw new ActionError(`buildah push ${tag} failed`);
		}
	}
}

/** `-f`, tags, build args, labels, target, platform and secret mounts in docker/podman/buildah syntax. */
function engineFlags(options: BuildOptions): string[] {
	return [
		'-f',
		options.file,
		...options.tags.flatMap((tag) => ['-t', tag]),
		...options.buildArgs.flatMap((arg) => ['--build-arg', arg]),
		...options.labels.flatMap((label) => ['--label', label]),
		...(options.target ? ['--target', options.target] : []),
		...(options.platform ? ['--platform', options.platform] : []),
		...options.secrets.flatMap((secret) => ['--secret', `id=${secret.id},src=${secret.src}`]),
	];
}

async function finishBuild(tags: string[], digestFile: string, host: ActionHost): Promise<ActionResult> {
	const digest = (await readFile(digestFile, 'utf8').catch(() => '')).trim();
	await rm(digestFile, { force: true });
	const image = digest ? `${imageWithoutTag(tags[0]!)}@${digest}` : tags[0]!;
	host.log(digest ? `Built and pushed ${image}` : `Built ${tags.join(', ')}`);
	return { outcome: 'success', outputs: { digest, image, tags: tags.join(',') } };
}

/**
 * A throwaway DOCKER_CONFIG must still find the user's CLI plugins (buildx: without it `docker build`
 * falls back to the legacy builder, which cannot `--push`) and their current context (OrbStack,
 * Docker Desktop, a remote engine). Credentials stay only in the throwaway `config.json`.
 */
/** The build user's home from the account database (not $HOME, which the job overrides). */
async function accountHome(): Promise<string> {
	const uid = process.getuid?.() ?? -1;
	if (process.platform === 'linux') {
		const passwd = await readFile('/etc/passwd', 'utf8').catch(() => '');
		const line = passwd.split('\n').find((entry) => entry.split(':')[2] === String(uid));
		if (line) return line.split(':')[5]!;
	}
	if (process.platform === 'darwin') {
		const user = Bun.spawnSync(['id', '-un']).stdout.toString().trim();
		const out = Bun.spawnSync(['dscl', '.', '-read', `/Users/${user}`, 'NFSHomeDirectory']).stdout.toString();
		const match = /NFSHomeDirectory:\s*(\S+)/.exec(out);
		if (match) return match[1]!;
	}
	return userInfo().homedir;
}

async function shareDockerSetup(configDir: string, home: string): Promise<void> {
	const own = join(home, '.docker');
	for (const name of ['cli-plugins', 'contexts']) {
		const source = join(own, name);
		if (await stat(source).catch(() => null)) await symlink(source, join(configDir, name)).catch(() => undefined);
	}
	// Only what finds the engine and its plugins: `currentContext` and `cliPluginsExtraDirs` (how
	// OrbStack ships buildx). Credentials, CLI hooks and plugin settings stay in the user's config.
	const user = JSON.parse(await readFile(join(own, 'config.json'), 'utf8').catch(() => '{}')) as Record<string, unknown>;
	const shared = Object.fromEntries(Object.entries(user).filter(([key]) => key === 'currentContext' || key === 'cliPluginsExtraDirs'));
	const path = join(configDir, 'config.json');
	const ours = JSON.parse(await readFile(path, 'utf8').catch(() => '{}')) as Record<string, unknown>;
	await writeFile(path, JSON.stringify({ ...shared, ...ours }), { mode: 0o600 });
}

/**
 * docker (BuildKit through `docker build`) or podman. Credentials go in a throwaway config for this
 * step only (`DOCKER_CONFIG` / `--authfile`), never the user's own login.
 */
async function buildWithEngine(
	engine: 'docker' | 'podman',
	options: BuildOptions & { authFile: string | null; authDir: string; digestFile: string },
	host: ActionHost,
): Promise<void> {
	const { tags, context, push, authFile, authDir, digestFile, attestations } = options;
	if (engine === 'docker') {
		// The job's HOME is its own temp dir, and Bun's os.homedir()/userInfo() follow $HOME.
		await shareDockerSetup(authDir, await accountHome());
		const env = { DOCKER_CONFIG: authDir };
		// Build into the engine's store, then a plain `docker push` per tag. `build --push` with the
		// default docker driver hands the push to the daemon without the throwaway config's login.
		const code = await host.exec(
			[
				'docker',
				'build',
				...engineFlags(options),
				// Only when asked: the default `docker` driver refuses attestations.
				...(attestations.explicit ? [`--provenance=${attestations.provenance ? `mode=${attestations.provenance}` : 'false'}`, `--sbom=${attestations.sbom}`] : []),
				context,
			],
			{ cwd: context, env },
		);
		if (code !== 0) throw new ActionError(`docker build exited with code ${code}`);
		if (push) {
			for (const tag of tags) {
				const pushed = await host.exec(['docker', 'push', tag], { env });
				if (pushed !== 0) throw new ActionError(`docker push ${tag} exited with code ${pushed}`);
			}
			// The registry digest of the first tag, from the engine's RepoDigests after the push.
			const digests = join(authDir, 'repo-digests.json');
			const inspected = await host.exec(
				['sh', '-c', 'docker image inspect --format "{{json .RepoDigests}}" "$1" > "$2"', 'sh', tags[0]!, digests],
				{ env },
			);
			if (inspected !== 0) throw new ActionError('docker image inspect failed after the push');
			const repo = imageWithoutTag(tags[0]!);
			const list = JSON.parse((await readFile(digests, 'utf8').catch(() => '[]')).trim() || '[]') as string[];
			const match = list.find((entry) => entry.startsWith(`${repo}@`));
			await writeFile(digestFile, match ? match.slice(repo.length + 1) : '');
		}
		return;
	}
	const build = await host.exec(
		['podman', 'build', ...engineFlags(options), context],
		{ cwd: context },
	);
	if (build !== 0) throw new ActionError(`podman build exited with code ${build}`);
	if (!push) return;
	for (const [index, tag] of tags.entries()) {
		const code = await host.exec([
			'podman',
			'push',
			...(authFile ? ['--authfile', authFile] : []),
			...(index === 0 ? ['--digestfile', digestFile] : []),
			tag,
		]);
		if (code !== 0) throw new ActionError(`podman push ${tag} failed`);
	}
}

// --- image-index (WP5) --------------------------------------------------------------------

/**
 * `skiff/image-index`: one OCI image index at `tag` from per-architecture `sources` (refs or
 * digests in the target repository), e.g. the `digest` outputs of a `skiff/build-image` matrix.
 * Sources elsewhere (another repository or registry) are copied into the target first, so the
 * same action mirrors a multi-arch image to GHCR. The platform registry logs in as this job.
 */
async function imageIndex(inputs: Record<string, string>, host: ActionHost): Promise<ActionResult> {
	const registry = host.claim.registry ?? null;
	const tagInput = (inputs.tag ?? inputs.tags ?? '').trim();
	if (!tagInput) throw new ActionError('Input required and not supplied: tag');
	if (/[\s,]/.test(tagInput)) throw new ActionError('tag takes one reference; run the action once per target');
	const target = expandRegistryTag(tagInput, registry);
	const sources = inputLines(inputs.sources, /[\s,]+/).map((source) => expandRegistryTag(source, registry));
	if (!sources.length) throw new ActionError('Input required and not supplied: sources');
	const targetHost = parseImageReference(target).registry;
	const own = Boolean(registry && targetHost === registry.host);
	if (own && !registry!.push) throw new ActionError('Untrusted runs (pull requests from forks) cannot push images');
	const username = inputs.username?.trim();
	const password = inputs.password ?? '';
	if (password) host.masker.add(password);
	// The job token is this step's registry password whenever the platform registry is involved.
	if (registry) host.masker.add(host.claim.token);
	const annotations: Record<string, string> = {};
	for (const line of inputLines(inputs.annotations)) {
		const index = line.indexOf('=');
		if (index < 1) throw new ActionError(`annotations lines must be KEY=VALUE (got "${line.slice(0, 40)}")`);
		annotations[line.slice(0, index).trim()] = line.slice(index + 1).trim();
	}
	const client = new RegistryClient({
		tempDir: host.temp,
		credentials: (hostname) => {
			if (registry && hostname === registry.host) return { username: `job.${host.claim.jobId}`, password: host.claim.token };
			if (username && hostname === targetHost) return { username, password };
			return null;
		},
	});
	host.log(`Writing an image index at ${target} from ${sources.length} source${sources.length === 1 ? '' : 's'}.`, 'system');
	const result = await createImageIndex(client, { target, sources, annotations, log: (line) => host.log(line) });
	const platforms = result.manifests
		.filter((entry) => entry.platform && entry.platform.os !== 'unknown')
		.map((entry) => [entry.platform!.os, entry.platform!.architecture, entry.platform!.variant].filter(Boolean).join('/'));
	host.log(`Pushed ${target} (${platforms.join(', ')}) as ${result.image}`);
	return { outcome: 'success', outputs: { digest: result.digest, image: result.image, tag: target, platforms: platforms.join(',') } };
}
