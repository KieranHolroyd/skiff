import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseActionManifest } from '@yoal/contracts';
import {
	ActionResolver,
	actionCacheDir,
	actionInputs,
	actionTarballUrl,
	inputEnvName,
	isFullSha,
	stateEnv,
} from './remote-actions.ts';

const root = mkdtempSync(join(tmpdir(), 'yoal-remote-actions-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let counter = 0;

function dirs(): { workspace: string; toolCache: string } {
	const base = join(root, `case-${++counter}`);
	const workspace = join(base, 'workspace');
	const toolCache = join(base, 'tool-cache');
	mkdirSync(workspace, { recursive: true });
	return { workspace, toolCache };
}

/** A codeload-style tarball: one top-level `<repo>-<ref>/` directory. */
function tarball(files: Record<string, string>): string {
	const source = join(root, `src-${++counter}`);
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(join(source, 'repo-ref', path, '..'), { recursive: true });
		writeFileSync(join(source, 'repo-ref', path), content);
	}
	const out = join(root, `archive-${counter}.tar.gz`);
	expect(Bun.spawnSync(['tar', '-czf', out, '-C', source, 'repo-ref']).exitCode).toBe(0);
	return out;
}

function serve(handler: (request: Request) => Response | Promise<Response>): {
	url: string;
	requests: Array<{ path: string; authorization: string | null }>;
	stop(): void;
} {
	const requests: Array<{ path: string; authorization: string | null }> = [];
	const server = Bun.serve({
		port: 0,
		fetch(request) {
			requests.push({ path: new URL(request.url).pathname, authorization: request.headers.get('authorization') });
			return handler(request);
		},
	});
	return { url: `http://127.0.0.1:${server.port}`, requests, stop: () => server.stop(true) };
}

const ACTION = 'runs: { using: node20, main: index.js }\n';

describe('pure helpers', () => {
	test('codeload URL and cache directory', () => {
		const ref = { owner: 'actions', repo: 'setup-node', ref: 'v4' };
		expect(actionTarballUrl(ref)).toBe('https://codeload.github.com/actions/setup-node/tar.gz/v4');
		expect(actionTarballUrl({ ...ref, ref: 'releases/v1' }, 'http://local:1/')).toBe('http://local:1/actions/setup-node/tar.gz/releases/v1');
		expect(actionCacheDir('/tc', ref)).toBe('/tc/_actions/actions/setup-node/v4');
		expect(actionCacheDir('/tc', { ...ref, ref: 'releases/v1' })).toBe('/tc/_actions/actions/setup-node/releases%2Fv1');
		expect(isFullSha('a'.repeat(40))).toBe(true);
		expect(isFullSha('v4')).toBe(false);
	});

	test('input names, values and state', () => {
		expect(inputEnvName('node-version')).toBe('INPUT_NODE-VERSION');
		expect(inputEnvName('My Input')).toBe('INPUT_MY_INPUT');
		const manifest = parseActionManifest(
			{ inputs: { Who: { default: '${{ github.repository }}' }, plain: { default: 'x' }, none: {} }, runs: { using: 'node20', main: 'i.js' } },
			'action.yml',
		);
		expect(actionInputs(manifest, { who: 'given', extra: 'e' }, (template) => template.replace('${{ github.repository }}', 'acme/app'))).toEqual({
			values: { Who: 'given', plain: 'x', none: '', extra: 'e' },
			unexpected: ['extra'],
		});
		expect(actionInputs(manifest, {}, () => 'evaluated').values.Who).toBe('evaluated');
		expect(stateEnv({ a: '1' })).toEqual({ STATE_a: '1' });
	});
});

describe('ActionResolver', () => {
	test('downloads, strips the top directory, honours a sub-path, sends the token, caches per job', async () => {
		const archive = tarball({ 'tools/hello/action.yml': ACTION, 'tools/hello/index.js': '' });
		const server = serve(() => new Response(Bun.file(archive)));
		try {
			const { workspace, toolCache } = dirs();
			const resolver = new ActionResolver({ workspace, toolCache, baseUrl: server.url });
			const ref = { kind: 'remote' as const, owner: 'acme', repo: 'kit', path: 'tools/hello', ref: 'v2' };
			const lines: string[] = [];
			const action = await resolver.resolve(ref, 'acme/kit/tools/hello@v2', { token: 'tok', log: (line) => lines.push(line) });
			expect(action.dir.endsWith('/_actions/acme/kit/v2/tools/hello')).toBe(true);
			expect(action.repository).toBe('acme/kit');
			expect(action.ref).toBe('v2');
			expect(action.manifest.runs.using).toBe('node20');
			expect(server.requests[0]!.path).toBe('/acme/kit/tar.gz/v2');
			expect(server.requests[0]!.authorization).toBe('token tok');
			expect(lines.some((line) => line.includes('not pinned to a full commit SHA'))).toBe(true);
			await resolver.resolve({ ...ref, path: 'tools/hello' }, 'again');
			expect(server.requests.length).toBe(1);
			// A fresh job re-downloads a moving ref…
			await new ActionResolver({ workspace, toolCache, baseUrl: server.url }).resolve(ref, 'x');
			expect(server.requests.length).toBe(2);
			expect(server.requests[1]!.authorization).toBeNull();
		} finally {
			server.stop();
		}
	});

	test('a full SHA is reused from the tool cache across jobs', async () => {
		const archive = tarball({ 'action.yml': ACTION, 'index.js': '' });
		const server = serve(() => new Response(Bun.file(archive)));
		try {
			const { workspace, toolCache } = dirs();
			const ref = { kind: 'remote' as const, owner: 'acme', repo: 'pinned', path: '', ref: 'b'.repeat(40) };
			await new ActionResolver({ workspace, toolCache, baseUrl: server.url }).resolve(ref, 'acme/pinned');
			await new ActionResolver({ workspace, toolCache, baseUrl: server.url }).resolve(ref, 'acme/pinned');
			expect(server.requests.length).toBe(1);
		} finally {
			server.stop();
		}
	});

	test('size cap, HTTP errors, missing manifest and sub-path traversal', async () => {
		// Random bytes, so the gzipped archive stays far over the cap with any tar (GNU tar compresses
		// a repeated character to under 1 KB).
		const big = tarball({ 'action.yml': ACTION, 'blob.bin': randomBytes(20_000).toString('base64') });
		const server = serve((request) => {
			const path = new URL(request.url).pathname;
			if (path.startsWith('/acme/big/')) return new Response(Bun.file(big));
			if (path.startsWith('/acme/stream/')) return new Response(new Blob([new Uint8Array(50_000)]).stream());
			if (path.startsWith('/acme/empty/')) return new Response(Bun.file(tarball({ 'README.md': 'hi' })));
			return new Response('missing', { status: 404 });
		});
		try {
			const { workspace, toolCache } = dirs();
			const resolver = new ActionResolver({ workspace, toolCache, baseUrl: server.url, maxBytes: 1000 });
			const remote = (repo: string, path = '') => ({ kind: 'remote' as const, owner: 'acme', repo, path, ref: 'v1' });
			await expect(resolver.resolve(remote('big'), 'acme/big@v1')).rejects.toThrow(/larger than/);
			await expect(resolver.resolve(remote('stream'), 'acme/stream@v1')).rejects.toThrow(/larger than/);
			await expect(resolver.resolve(remote('gone'), 'acme/gone@v1')).rejects.toThrow(/HTTP 404 \(does the repository and ref exist/);
			const roomy = new ActionResolver({ workspace, toolCache, baseUrl: server.url });
			await expect(roomy.resolve(remote('empty'), 'acme/empty@v1')).rejects.toThrow(/Can't find action.yml/);
			await expect(roomy.resolve(remote('empty', 'nope'), 'acme/empty/nope@v1')).rejects.toThrow(/Can't find nope in acme\/empty@v1/);
			// Nothing half-extracted is left behind.
			expect(existsSync(join(toolCache, '_actions', 'acme', 'big', 'v1'))).toBe(false);
		} finally {
			server.stop();
		}
	});

	test('local actions resolve inside the workspace only', async () => {
		const { workspace, toolCache } = dirs();
		mkdirSync(join(workspace, 'act'));
		writeFileSync(join(workspace, 'act', 'action.yaml'), ACTION);
		const resolver = new ActionResolver({ workspace, toolCache });
		const action = await resolver.resolve({ kind: 'local', path: 'act' }, './act');
		expect(action.repository).toBeNull();
		expect(action.manifest.runs.using).toBe('node20');
		await expect(resolver.resolve({ kind: 'local', path: '../..' }, './../..')).rejects.toThrow(/outside the workspace/);
	});
});
