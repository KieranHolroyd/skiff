import { afterEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILD_VERSION } from './build-version.ts';
import { formatEnv, JoinError, joinNode, nodeFilePath, parseJoinArgs, type FetchLike } from './join.ts';

const TOKEN = 'j'.repeat(32);
const directories: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(join(tmpdir(), 'skiff-agent-join-'));
	directories.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('parseJoinArgs', () => {
	test('parses the required arguments and defaults', () => {
		const options = parseJoinArgs(
			['https://cloud.example.com/', '--token', TOKEN, '--name', 'edge-1'],
			{},
		);
		expect(options.controlUrl).toBe('https://cloud.example.com');
		expect(options.token).toBe(TOKEN);
		expect(options.name).toBe('edge-1');
		expect(options.dataDir).toBe('/var/lib/skiff-agent');
		expect(options.version).toBe(BUILD_VERSION);
		expect(options.publicAddress).toBeUndefined();
	});

	test('supports --flag=value, optional flags and env defaults', () => {
		const options = parseJoinArgs(
			[
				'https://cloud.example.com',
				`--token=${TOKEN}`,
				'--name=worker-1',
				'--data-dir=/srv/skiff',
				'--public-address=203.0.113.4',
			],
			{ SKIFF_AGENT_VERSION: '1.2.3', SKIFF_DATA_DIR: '/ignored' },
		);
		expect(options.dataDir).toBe('/srv/skiff');
		expect(options.version).toBe('1.2.3');
		expect(options.publicAddress).toBe('203.0.113.4');
	});

	test('rejects missing, unknown and invalid arguments', () => {
		expect(() => parseJoinArgs(['https://cloud.example.com', '--name', 'edge'], {})).toThrow(
			/--token is required/,
		);
		expect(() => parseJoinArgs(['https://cloud.example.com', '--token', TOKEN], {})).toThrow(
			/--name is required/,
		);
		expect(() => parseJoinArgs(['--token', TOKEN, '--name', 'edge'], {})).toThrow(/control URL/);
		expect(() =>
			parseJoinArgs(['https://cloud.example.com', '--token', TOKEN, '--name', 'edge', '--nope'], {}),
		).toThrow(/Unknown option/);
		expect(() =>
			parseJoinArgs(['https://cloud.example.com', '--token', 'short', '--name', 'edge'], {}),
		).toThrow(/at least 20/);
		expect(() =>
			parseJoinArgs(['ftp://cloud.example.com', '--token', TOKEN, '--name', 'edge'], {}),
		).toThrow(/http or https/);
	});
});

describe('joinNode', () => {
	test('posts the join request, writes node.json atomically with mode 0600', async () => {
		const dir = await tempDir();
		let requestUrl = '';
		let requestBody: Record<string, unknown> = {};
		const fakeFetch: FetchLike = async (input, init) => {
			requestUrl = String(input);
			requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return new Response(
				JSON.stringify({
					nodeId: 'nod_1',
					token: 'node-token-returned',
					controlUrl: 'https://cloud.example.com',
					mode: 'edge',
				}),
				{ status: 201, headers: { 'content-type': 'application/json' } },
			);
		};

		const options = parseJoinArgs(
			['https://cloud.example.com', '--token', TOKEN, '--name', 'edge-1', '--data-dir', dir],
			{ SKIFF_AGENT_VERSION: '2.0.0' },
		);
		const joined = await joinNode(options, fakeFetch);

		expect(requestUrl).toBe('https://cloud.example.com/api/agent/join');
		expect(requestBody).toEqual({
			token: TOKEN,
			name: 'edge-1',
			version: '2.0.0',
			networkMode: 'external',
		});
		expect(joined.nodeId).toBe('nod_1');
		expect(joined.mode).toBe('edge');

		const file = nodeFilePath(dir);
		const stored = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
		expect(stored.nodeId).toBe('nod_1');
		expect(stored.token).toBe('node-token-returned');
		expect(stored.controlUrl).toBe('https://cloud.example.com');
		expect(stored.mode).toBe('edge');
		expect(typeof stored.joinedAt).toBe('string');
		expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
		expect((await fs.readdir(dir)).filter((name) => name.includes('.tmp-'))).toEqual([]);
	});

	test('surfaces control-plane errors', async () => {
		const dir = await tempDir();
		const options = parseJoinArgs(
			['https://cloud.example.com', '--token', TOKEN, '--name', 'edge-1', '--data-dir', dir],
			{},
		);
		const fakeFetch: FetchLike = async () =>
			new Response('{"error":"invalid_or_expired_join_token"}', { status: 401 });
		await expect(joinNode(options, fakeFetch)).rejects.toThrow(/Join failed \(401\)/);
		await expect(fs.stat(nodeFilePath(dir))).rejects.toThrow();
	});

	test('rejects a malformed success response', async () => {
		const dir = await tempDir();
		const options = parseJoinArgs(
			['https://cloud.example.com', '--token', TOKEN, '--name', 'edge-1', '--data-dir', dir],
			{},
		);
		const fakeFetch: FetchLike = async () => new Response('{}', { status: 201 });
		await expect(joinNode(options, fakeFetch)).rejects.toThrow(JoinError);
	});

	test('formats EnvironmentFile lines including the mode', () => {
		const env = formatEnv({
			controlUrl: 'https://cloud.example.com',
			nodeId: 'nod_1',
			token: 'node-token',
			mode: 'worker',
			joinedAt: '2026-11-03T00:00:00.000Z',
		});
		expect(env).toContain('SKIFF_CONTROL_URL=https://cloud.example.com');
		expect(env).toContain('SKIFF_NODE_ID=nod_1');
		expect(env).toContain('SKIFF_NODE_TOKEN=node-token');
		expect(env).toContain('SKIFF_NODE_MODE=worker');
	});
});
