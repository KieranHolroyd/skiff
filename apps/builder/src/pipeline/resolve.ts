import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { PipelineResolveClaim, PipelineResolveReport } from '@skiff/contracts';
import { PIPELINE_WORKFLOW_DIR } from '@skiff/contracts';
import { redactSecret } from '../command.ts';
import { cloneAtSha, cloneRef, commitInfo, withCloneToken, type GitCredentials } from './git.ts';

/**
 * Resolve claims (W1): read `.skiff/workflows/*.yml` at a ref for the control plane, which cannot
 * clone arbitrary git hosts itself. The node's git credentials are used; nothing in the
 * repository is executed. Any failure is reported as `{ error }` so the trigger never hangs.
 */

export const MAX_WORKFLOW_FILES = 100;
export const MAX_WORKFLOW_BYTES = 512_000;

export interface ResolveApi {
	resolve(report: PipelineResolveReport): Promise<unknown>;
}

function isInside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Workflow files directly in `.skiff/workflows` (not recursive), sorted. Symlinks are followed
 * only while they stay inside the checkout; a link out (to `/etc/…`) is skipped, never read.
 */
export async function readWorkflowFiles(checkout: string): Promise<Array<{ path: string; content: string }>> {
	const realRoot = await realpath(checkout);
	const directory = join(checkout, PIPELINE_WORKFLOW_DIR);
	let realDirectory: string;
	try {
		realDirectory = await realpath(directory);
	} catch {
		return [];
	}
	if (!isInside(realRoot, realDirectory)) return [];
	const entries = (await readdir(realDirectory, { withFileTypes: true }))
		.filter((entry) => /\.ya?ml$/i.test(entry.name))
		.sort((a, b) => a.name.localeCompare(b.name));
	const files: Array<{ path: string; content: string }> = [];
	for (const entry of entries) {
		const full = join(realDirectory, entry.name);
		let target = full;
		if (entry.isSymbolicLink()) {
			const resolved = await realpath(full).catch(() => null);
			if (!resolved || !isInside(realRoot, resolved)) continue;
			target = resolved;
		}
		const info = await lstat(target);
		if (!info.isFile()) continue;
		const path = `${PIPELINE_WORKFLOW_DIR}/${entry.name}`;
		if (files.length >= MAX_WORKFLOW_FILES) throw new Error(`More than ${MAX_WORKFLOW_FILES} workflow files in ${PIPELINE_WORKFLOW_DIR}`);
		if (info.size > MAX_WORKFLOW_BYTES) throw new Error(`${path} is larger than ${MAX_WORKFLOW_BYTES} bytes`);
		files.push({ path, content: await readFile(target, 'utf8') });
	}
	return files;
}

export async function runResolve(input: {
	claim: PipelineResolveClaim;
	api: ResolveApi;
	credentials: GitCredentials;
	log?: (message: string) => void;
}): Promise<void> {
	const { claim, api } = input;
	const credentials = withCloneToken(input.credentials, claim.gitToken, { host: claim.gitTokenHost, username: claim.gitTokenUsername });
	const log = input.log ?? ((message: string) => console.log(`[pipeline] ${message}`));
	const root = join(credentials.buildDir, 'pipelines');
	await mkdir(root, { recursive: true, mode: 0o711 });
	const dir = await mkdtemp(join(root, 'resolve-'));
	try {
		const url = claim.repository.cloneUrl;
		if (claim.sha) await cloneAtSha({ url, ref: claim.ref, sha: claim.sha, dir, credentials });
		else await cloneRef({ url, ref: claim.ref.replace(/^refs\/(heads|tags)\//, ''), dir, credentials });
		const info = await commitInfo(dir);
		const files = await readWorkflowFiles(dir);
		await api.resolve({
			...(info.sha ? { sha: info.sha } : {}),
			...(info.message ? { commitMessage: info.message.slice(0, 4000) } : {}),
			files,
		});
		log(`resolved ${claim.repository.name}@${claim.ref}: ${files.length} workflow files`);
	} catch (error) {
		const raw = error instanceof Error ? error.message : String(error);
		const message = redactSecret(redactSecret(raw, credentials.gitToken), input.credentials.gitToken).slice(0, 4000);
		log(`resolve ${claim.triggerId} failed: ${message}`);
		await api.resolve({ error: message, files: [] }).catch((reportError: unknown) =>
			log(`resolve ${claim.triggerId} report failed: ${reportError instanceof Error ? reportError.message : String(reportError)}`),
		);
	} finally {
		await rm(dir, { recursive: true, force: true }).catch(() => undefined);
	}
}
