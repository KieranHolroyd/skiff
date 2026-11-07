import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'skiff-update-log-'));
const logFile = join(dir, 'update.log');
process.env.SKIFF_UPDATE_LOG_FILE = logFile;
const channelFile = join(dir, 'channel');
process.env.SKIFF_UPDATE_CHANNEL_FILE = channelFile;
const requestFile = join(dir, 'request');
process.env.SKIFF_UPDATE_REQUEST_FILE = requestFile;
// `version.ts` reads the build-time constant at module load.
(globalThis as { __SKIFF_VERSION__?: string }).__SKIFF_VERSION__ = '0.0.0';
const { currentChannel, latestVersion, parseUpdateLog, readUpdateLog, requestUpdate } =
	await import('./self-update.js');

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const record = (text: string, level = 'info', at = '2026-01-01T00:00:00.000Z') =>
	JSON.stringify({ at, level, text });

describe('parseUpdateLog', () => {
	test('keeps valid records in order and normalises unknown levels', () => {
		const parsed = parseUpdateLog(
			[
				record('[building] Build', 'phase'),
				'not json at all',
				record('hello', 'chatty'),
				record('careful', 'warn')
			].join('\n')
		);
		expect(parsed.truncated).toBe(false);
		expect(parsed.lines.map((line) => [line.level, line.text])).toEqual([
			['phase', '[building] Build'],
			['info', 'hello'],
			['warn', 'careful']
		]);
	});

	test('drops malformed records and caps the line count', () => {
		const text = Array.from({ length: 10 }, (_, index) => record(`line ${index}`)).join('\n');
		const parsed = parseUpdateLog(text, 3);
		expect(parsed.truncated).toBe(true);
		expect(parsed.lines.map((line) => line.text)).toEqual(['line 7', 'line 8', 'line 9']);
	});
});

describe('readUpdateLog', () => {
	test('reports a missing log without throwing', () => {
		expect(readUpdateLog()).toEqual({
			lines: [],
			exists: false,
			truncated: false,
			updatedAt: null
		});
	});

	test('returns the newest lines from disk', () => {
		writeFileSync(
			logFile,
			`${Array.from({ length: 5 }, (_, index) => record(`line ${index}`)).join('\n')}\n`
		);
		const log = readUpdateLog(3);
		expect(log.exists).toBe(true);
		expect(log.truncated).toBe(true);
		expect(log.lines.map((line) => line.text)).toEqual(['line 2', 'line 3', 'line 4']);
		expect(log.updatedAt).not.toBeNull();
	});
});

describe('release channels', () => {
	const signed = (version: string, prerelease: boolean) => ({
		tag_name: `v${version}`,
		draft: false,
		prerelease,
		assets: [{ name: 'manifest.json' }, { name: 'manifest.json.sig' }]
	});
	const source = { repo: 'owner/skiff', ref: 'main' };
	const realFetch = globalThis.fetch;

	function serve(releases: unknown[], version = '0.9.0') {
		globalThis.fetch = (async (input: string | URL | Request) => {
			const url = String(input instanceof Request ? input.url : input);
			if (url.includes('/releases')) return Response.json(releases);
			return new Response(`${version}\n`);
		}) as typeof fetch;
	}
	afterAll(() => (globalThis.fetch = realFetch));

	test('defaults to canary and follows the file the updater writes', () => {
		rmSync(channelFile, { force: true });
		expect(currentChannel()).toBe('canary');
		writeFileSync(channelFile, 'stable\n');
		expect(currentChannel()).toBe('stable');
		writeFileSync(channelFile, 'beta\n');
		expect(currentChannel()).toBe('canary');
	});

	test('canary sees prereleases; stable only promoted releases', async () => {
		serve([signed('0.3.0', true), signed('0.2.0', false), signed('0.1.0', false)]);
		const canary = await latestVersion(source, { force: true, channel: 'canary' });
		const stable = await latestVersion(source, { force: true, channel: 'stable' });
		expect(canary).toMatchObject({ ok: true, version: '0.3.0' });
		expect(stable).toMatchObject({ ok: true, version: '0.2.0' });
	});

	test('a stable source build reports the newest stable tag, never the branch VERSION', async () => {
		serve([signed('0.3.0', true), signed('0.2.0', false)], '0.9.0');
		expect(
			await latestVersion(source, { force: true, channel: 'stable', method: 'build' })
		).toMatchObject({ ok: true, version: '0.2.0' });
		expect(
			await latestVersion(source, { force: true, channel: 'canary', method: 'build' })
		).toMatchObject({ ok: true, version: '0.9.0' });
	});

	test('stable with nothing promoted says how to promote', async () => {
		serve([signed('0.3.0', true)]);
		const latest = await latestVersion(source, { force: true, channel: 'stable' });
		expect(latest.ok).toBe(false);
		expect(latest.ok ? '' : latest.error).toMatch(/Promote workflow/);
	});

	test('an update request carries the channel in its own sidecar', async () => {
		const { readFileSync } = await import('node:fs');
		const principal = { kind: 'user', userId: 'u1' } as Parameters<typeof requestUpdate>[0];
		requestUpdate(principal, '0.2.0', 'download', 'stable');
		expect(readFileSync(`${requestFile}.channel`, 'utf8')).toBe('stable\n');
		expect(readFileSync(`${requestFile}.mode`, 'utf8')).toBe('download\n');
		expect(JSON.parse(readFileSync(requestFile, 'utf8'))).toMatchObject({ channel: 'stable' });
	});
});
