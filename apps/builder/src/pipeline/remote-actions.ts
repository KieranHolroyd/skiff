import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { PipelineActionManifest, PipelineActionRef } from '@yoal/contracts';
import { parseActionManifest } from '@yoal/contracts';

/**
 * Composite and JavaScript actions (WP4): where `uses:` is not a built-in, the step runner fetches
 * the action (`owner/repo[/path]@ref` from github.com, or `./path` in the workspace) and reads its
 * `action.yml`. Running it lives in the step runner, which owns processes, file commands and logs.
 *
 * Remote actions come from codeload.github.com as a tarball, so no GitHub API, token or git is
 * needed for public repositories. Each download is extracted once per job under
 * `$RUNNER_TOOL_CACHE/_actions/<owner>/<repo>/<ref>`; a full 40-hex SHA is immutable, so it is also
 * reused across jobs that share the tool cache.
 */

export const GITHUB_CODELOAD_URL = 'https://codeload.github.com';
/** Compressed size cap for one action download. */
export const MAX_ACTION_ARCHIVE_BYTES = 200 * 1024 * 1024;
/** Nested `uses:` inside composite actions, as on GitHub. */
export const MAX_ACTION_DEPTH = 10;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const COMPLETE_MARKER = '.yoal-action-complete';
const FULL_SHA = /^[0-9a-f]{40}$/i;

type RemoteRef = Extract<PipelineActionRef, { kind: 'remote' }>;
type LocalRef = Extract<PipelineActionRef, { kind: 'local' }>;

export class ActionResolveError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ActionResolveError';
	}
}

export interface ResolvedAction {
	/** The `uses:` text, for messages. */
	uses: string;
	/** Real path of the directory holding `action.yml`. */
	dir: string;
	/** Real path of the repository root (remote) or workspace (local); files must stay inside. */
	root: string;
	manifest: PipelineActionManifest;
	/** `owner/repo` for remote actions, null for local ones. */
	repository: string | null;
	ref: string | null;
}

export function isFullSha(ref: string): boolean {
	return FULL_SHA.test(ref);
}

export function insideDir(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** `https://codeload.github.com/<owner>/<repo>/tar.gz/<ref>` (each part URL-encoded). */
export function actionTarballUrl(ref: Pick<RemoteRef, 'owner' | 'repo' | 'ref'>, baseUrl: string = GITHUB_CODELOAD_URL): string {
	const encodedRef = ref.ref.split('/').map(encodeURIComponent).join('/');
	return `${baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/tar.gz/${encodedRef}`;
}

/** Where a remote action is extracted. The ref is one path segment (`releases/v1` → `releases%2Fv1`). */
export function actionCacheDir(toolCache: string, ref: Pick<RemoteRef, 'owner' | 'repo' | 'ref'>): string {
	return join(toolCache, '_actions', ref.owner, ref.repo, encodeURIComponent(ref.ref));
}

/** GitHub's environment name for an input: `INPUT_` + upper case, spaces as `_`. */
export function inputEnvName(name: string): string {
	return `INPUT_${name.replace(/ /g, '_').toUpperCase()}`;
}

/**
 * The inputs an action runs with: each declared input takes the `with:` value (names match
 * case-insensitively, as GitHub's `INPUT_` names do), else its default evaluated with the calling
 * step's context, else ''. Undeclared `with:` keys are passed too and reported as unexpected.
 */
export function actionInputs(
	manifest: PipelineActionManifest,
	given: Record<string, string>,
	evaluateDefault: (template: string) => string,
): { values: Record<string, string>; unexpected: string[] } {
	const values: Record<string, string> = {};
	const byLower = new Map(Object.entries(given).map(([key, value]) => [key.toLowerCase(), value]));
	const declared = new Set<string>();
	for (const [name, input] of Object.entries(manifest.inputs)) {
		declared.add(name.toLowerCase());
		const value = byLower.get(name.toLowerCase());
		values[name] = value !== undefined ? value : input.default !== null ? evaluateDefault(input.default) : '';
	}
	const unexpected: string[] = [];
	for (const [key, value] of Object.entries(given)) {
		if (declared.has(key.toLowerCase())) continue;
		unexpected.push(key);
		values[key] = value;
	}
	return { values, unexpected };
}

/** `$GITHUB_STATE` values, as the `STATE_<name>` variables a later phase sees. */
export function stateEnv(state: Record<string, string>): Record<string, string> {
	return Object.fromEntries(Object.entries(state).map(([name, value]) => [`STATE_${name}`, value]));
}

/** Resolve a file of the action (`runs.main`, `pre`, `post`) and require it to stay inside the action's repository. */
export async function actionFile(action: ResolvedAction, file: string): Promise<string> {
	const target = resolve(action.dir, file);
	let real: string;
	try {
		real = await realpath(target);
	} catch {
		throw new ActionResolveError(`${action.uses}: ${file} does not exist`);
	}
	if (!insideDir(action.root, real)) throw new ActionResolveError(`${action.uses}: ${file} is outside the action`);
	return real;
}

async function readManifest(dir: string, root: string, uses: string): Promise<PipelineActionManifest> {
	for (const name of ['action.yml', 'action.yaml']) {
		let real: string;
		try {
			real = await realpath(join(dir, name));
		} catch {
			continue;
		}
		if (!insideDir(root, real)) throw new ActionResolveError(`${uses}: ${name} points outside the action`);
		const info = await stat(real);
		if (!info.isFile()) continue;
		if (info.size > MAX_MANIFEST_BYTES) throw new ActionResolveError(`${uses}: ${name} is larger than 1 MB`);
		let doc: unknown;
		try {
			doc = Bun.YAML.parse(await readFile(real, 'utf8'));
		} catch (error) {
			throw new ActionResolveError(`${uses}: ${name} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`);
		}
		return parseActionManifest(doc, `${uses} (${name})`);
	}
	const dockerfile = existsSync(join(dir, 'Dockerfile'));
	throw new ActionResolveError(
		dockerfile
			? `${uses} is a Docker action (Dockerfile, no action.yml), which Yoal Pipelines cannot run; use the GitHub runner pool (docs/RUNNERS.md)`
			: `Can't find action.yml or action.yaml for ${uses}`,
	);
}

export interface ActionResolverOptions {
	workspace: string;
	toolCache: string;
	/** Defaults to codeload.github.com; tests point it at a local server. */
	baseUrl?: string;
	maxBytes?: number;
	fetch?: typeof fetch;
}

/** Fetches and caches the actions of one job. */
export class ActionResolver {
	private readonly downloads = new Map<string, Promise<string>>();

	constructor(private readonly options: ActionResolverOptions) {}

	/**
	 * Locate the action and parse its `action.yml`. `token` (optional) authenticates the download,
	 * for actions in private repositories. `log` receives progress lines for the step log.
	 */
	async resolve(ref: RemoteRef | LocalRef, uses: string, options: { token?: string | null; log?: (text: string) => void } = {}): Promise<ResolvedAction> {
		let root: string;
		let repository: string | null = null;
		let version: string | null = null;
		if (ref.kind === 'local') {
			root = this.options.workspace;
		} else {
			repository = `${ref.owner}/${ref.repo}`;
			version = ref.ref;
			const key = `${repository.toLowerCase()}@${ref.ref}`;
			let download = this.downloads.get(key);
			if (!download) {
				download = this.download(ref, options);
				this.downloads.set(key, download);
				download.catch(() => this.downloads.delete(key));
			}
			root = await download;
		}
		const realRoot = await realpath(root);
		const target = resolve(root, ref.path);
		let dir: string;
		try {
			dir = await realpath(target);
		} catch {
			throw new ActionResolveError(
				ref.kind === 'local'
					? `Can't find the local action ${uses}: ${ref.path || '.'} does not exist in the workspace (did a checkout step run first?)`
					: `Can't find ${ref.path} in ${repository}@${version}`,
			);
		}
		if (!insideDir(realRoot, dir)) throw new ActionResolveError(`${uses} resolves outside ${ref.kind === 'local' ? 'the workspace' : 'its repository'}`);
		const manifest = await readManifest(dir, realRoot, uses);
		return { uses, dir, root: realRoot, manifest, repository, ref: version };
	}

	private async download(ref: RemoteRef, options: { token?: string | null; log?: (text: string) => void }): Promise<string> {
		const target = actionCacheDir(this.options.toolCache, ref);
		const name = `${ref.owner}/${ref.repo}@${ref.ref}`;
		if (isFullSha(ref.ref) && existsSync(join(target, COMPLETE_MARKER))) {
			options.log?.(`Using cached action ${name}`);
			return target;
		}
		if (!isFullSha(ref.ref)) options.log?.(`Notice: ${name} is not pinned to a full commit SHA; a SHA is safer against a moved tag.`);
		const url = actionTarballUrl(ref, this.options.baseUrl);
		options.log?.(`Download action repository '${name}'`);
		const headers: Record<string, string> = { 'user-agent': 'yoal-pipelines' };
		if (options.token) headers.authorization = `token ${options.token}`;
		const fetcher = this.options.fetch ?? fetch;
		let response: Response;
		try {
			response = await fetcher(url, { headers, redirect: 'follow' });
		} catch (error) {
			throw new ActionResolveError(`Downloading ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (!response.ok || !response.body) {
			await response.body?.cancel().catch(() => undefined);
			const hint = response.status === 404 ? ' (does the repository and ref exist, and is the repository public?)' : '';
			throw new ActionResolveError(`Downloading ${name} failed: HTTP ${response.status}${hint}`);
		}
		const maxBytes = this.options.maxBytes ?? MAX_ACTION_ARCHIVE_BYTES;
		const declared = Number(response.headers.get('content-length') ?? '0');
		if (declared > maxBytes) {
			await response.body.cancel().catch(() => undefined);
			throw new ActionResolveError(`${name} is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`);
		}
		await mkdir(dirname(target), { recursive: true });
		const staging = `${target}.tmp-${randomUUID()}`;
		const archive = `${staging}.tar.gz`;
		try {
			await writeCapped(response.body, archive, maxBytes, name);
			await mkdir(staging, { recursive: true });
			await extractTarball(archive, staging, name);
			await writeFile(join(staging, COMPLETE_MARKER), `${name}\n`);
			await rm(target, { recursive: true, force: true });
			await rename(staging, target);
		} finally {
			await rm(archive, { force: true });
			await rm(staging, { recursive: true, force: true });
		}
		return target;
	}
}

async function writeCapped(body: ReadableStream<Uint8Array>, path: string, maxBytes: number, name: string): Promise<void> {
	const out = createWriteStream(path, { mode: 0o600 });
	let total = 0;
	try {
		for await (const chunk of body) {
			total += chunk.byteLength;
			if (total > maxBytes) throw new ActionResolveError(`${name} is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`);
			if (!out.write(chunk)) await new Promise<void>((done) => out.once('drain', () => done()));
		}
	} finally {
		await new Promise<void>((done, fail) => out.end((error?: Error | null) => (error ? fail(error) : done())));
	}
}

/**
 * Extract codeload's tarball (one top-level `<repo>-<ref>/` directory) without it. GNU tar and
 * bsdtar both refuse `..` members and strip leading `/`; symlinks that leave the tree are caught
 * when the action's files are resolved (`actionFile`).
 */
async function extractTarball(archive: string, into: string, name: string): Promise<void> {
	const proc = Bun.spawn(['tar', '-xzf', archive, '-C', into, '--strip-components=1', '--no-same-owner'], {
		stdout: 'ignore',
		stderr: 'pipe',
	});
	const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr as ReadableStream<Uint8Array>).text()]);
	if (code !== 0) throw new ActionResolveError(`Extracting ${name} failed: ${stderr.trim().split('\n').slice(-3).join('; ') || `tar exited with ${code}`}`);
}
