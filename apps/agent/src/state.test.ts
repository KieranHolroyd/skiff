import { afterEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { desiredStateSchema, type DesiredState } from '@skiff/contracts';
import { atomicWriteFile, DesiredStateStore, desiredStateEtag, desiredStateRequest } from './state.ts';

const directories: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(join(tmpdir(), 'skiff-agent-state-'));
	directories.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function state(version: number): DesiredState {
	return desiredStateSchema.parse({
		version,
		nodeId: 'nod_1',
		agentVersion: '0.1.0',
		generatedAt: '2026-11-03T00:00:00.000Z',
		contentDomain: 'example.com',
		releases: [],
		routes: [],
		revocations: [],
		hostRedirects: [],
	});
}

describe('desired-state cache', () => {
	test('round-trips state and ETag', async () => {
		const dir = await tempDir();
		const store = new DesiredStateStore(dir);
		await store.write(state(3), '"3"');

		const cached = await store.readCached();
		expect(cached?.state.version).toBe(3);
		expect(cached?.etag).toBe('"3"');
		expect(await store.readEtag()).toBe('"3"');
	});

	test('falls back to a version ETag when the sidecar is absent', async () => {
		const dir = await tempDir();
		const store = new DesiredStateStore(dir);
		await store.write(state(9));
		await fs.rm(store.etagPath);
		expect((await store.readCached())?.etag).toBe(desiredStateEtag(state(9)));
	});

	test('leaves no temp files after an atomic write', async () => {
		const dir = await tempDir();
		const store = new DesiredStateStore(dir);
		for (let version = 0; version < 5; version++) await store.write(state(version));
		const files = await fs.readdir(dir);
		expect(files.sort()).toEqual(['desired-state.etag', 'desired-state.json']);
		expect((await store.read())?.version).toBe(4);
	});

	test('corrupt JSON is quarantined instead of throwing', async () => {
		const dir = await tempDir();
		const store = new DesiredStateStore(dir);
		await atomicWriteFile(store.statePath, '{"version": "not a number"}');
		expect(await store.read()).toBeNull();
		const files = await fs.readdir(dir);
		expect(files.some((name) => name.startsWith('desired-state.json.invalid-'))).toBe(true);
	});

	test('missing cache reads as null', async () => {
		const dir = await tempDir();
		expect(await new DesiredStateStore(dir).readCached()).toBeNull();
	});

	test('atomicWriteFile replaces content in place', async () => {
		const dir = await tempDir();
		const path = join(dir, 'nested', 'file.txt');
		await atomicWriteFile(path, 'first');
		await atomicWriteFile(path, 'second');
		expect(await fs.readFile(path, 'utf8')).toBe('second');
	});
});

describe('desiredStateRequest', () => {
	const base = { etag: '"v39"', force: false, longPollSeconds: 8 };

	test('the first pull of a run ignores the cache a previous agent build wrote', () => {
		// That cache may lack fields the old build stripped; a 304 would hide them for good.
		expect(desiredStateRequest({ ...base, pulledThisRun: false })).toEqual({ ifNoneMatch: null, waitSeconds: 0 });
	});

	test('later pulls revalidate and long-poll', () => {
		expect(desiredStateRequest({ ...base, pulledThisRun: true })).toEqual({ ifNoneMatch: '"v39"', waitSeconds: 8 });
	});

	test('a forced pull, or one with nothing cached, always fetches a fresh copy', () => {
		expect(desiredStateRequest({ ...base, force: true, pulledThisRun: true })).toEqual({ ifNoneMatch: null, waitSeconds: 0 });
		expect(desiredStateRequest({ ...base, etag: null, pulledThisRun: true })).toEqual({ ifNoneMatch: null, waitSeconds: 0 });
	});
});
