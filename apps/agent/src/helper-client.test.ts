import { afterEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workloadActivationSchema, workloadDesiredSchema } from '@skiff/contracts';
import { HelperClient, HelperError } from './helper-client.ts';

const SHA = 'a'.repeat(64);
const directories: string[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(async () => {
	for (const server of servers.splice(0)) server.stop(true);
	await Promise.all(directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function socketPath(): Promise<string> {
	const dir = await fs.mkdtemp(join(tmpdir(), 'skiff-helper-client-'));
	directories.push(dir);
	return join(dir, 'helper.sock');
}

function workload() {
	return workloadDesiredSchema.parse({
		id: 'wld_abc123',
		projectId: 'prj_abc123',
		projectSlug: 'app',
		deploymentId: 'dep_abc123',
		runtime: 'process',
		status: 'running',
		release: SHA,
		upstream: 'unix//run/skiff-workloads/prj_abc123.sock',
		memoryMb: 256,
		cpus: 1,
		port: 3000,
		healthPath: '/health',
		socketActivation: true,
		activationVersion: 'b'.repeat(64),
		env: {},
		secrets: [],
		dataSizeMb: null,
	});
}

function activation() {
	return workloadActivationSchema.parse({
		workloadId: 'wld_abc123',
		activationVersion: 'b'.repeat(64),
		env: { DATABASE_URL: 'postgres://example' },
		files: {},
	});
}

describe('HelperClient', () => {
	test('speaks the fixed verbs over a unix socket', async () => {
		const path = await socketPath();
		const requests: Array<{ method: string; path: string; body: unknown }> = [];
		const server = Bun.serve({
			unix: path,
			async fetch(request) {
				const url = new URL(request.url);
				const text = request.method === 'POST' ? await request.text() : '';
				const body = text ? JSON.parse(text) : null;
				requests.push({ method: request.method, path: url.pathname, body });
				if (url.pathname === '/healthz') return Response.json({ ok: true, version: 'test' });
				if (url.pathname === '/v1/slice') return Response.json({ ok: true });
				if (url.pathname === '/v1/workloads' && request.method === 'POST')
					return Response.json({
						ok: true,
						workload: { id: 'wld_abc123', status: 'running', restarts: 1, memoryBytes: 1024 },
					});
				if (url.pathname === '/v1/workloads/wld_abc123' && request.method === 'DELETE')
					return Response.json({ ok: true });
				if (url.pathname === '/v1/workloads/db_abc/purge' && request.method === 'POST')
					return Response.json({ ok: true, purged: 'db_abc' });
				if (url.pathname === '/v1/workloads/wld_abc123')
					return Response.json({
						ok: true,
						workload: { id: 'wld_abc123', status: 'failed', restarts: 4 },
					});
				return Response.json({ error: 'nope' }, { status: 500 });
			},
		});
		servers.push(server);

		const client = new HelperClient(path, { health: 1_000, apply: 1_000 });
		expect(await client.health()).toEqual({ ok: true, version: 'test' });

		await client.ensureSlice({ memoryMb: 1024 });
		expect(requests.at(-1)).toEqual({
			method: 'POST',
			path: '/v1/slice',
			body: { memoryMb: 1024 },
		});

		const applied = await client.apply({ workload: workload(), activation: activation() });
		expect(applied).toEqual({
			id: 'wld_abc123',
			status: 'running',
			restarts: 1,
			memoryBytes: 1024,
		});
		expect(requests.at(-1)?.body).toMatchObject({
			workload: { id: 'wld_abc123' },
			activation: { env: { DATABASE_URL: 'postgres://example' } },
		});

		expect((await client.status('wld_abc123')).status).toBe('failed');
		await client.remove('wld_abc123');
		expect(requests.at(-1)).toEqual({ method: 'DELETE', path: '/v1/workloads/wld_abc123', body: null });

		await client.purge('db_abc');
		expect(requests.at(-1)).toEqual({ method: 'POST', path: '/v1/workloads/db_abc/purge', body: null });
	});

	test('surfaces helper errors with the endpoint', async () => {
		const path = await socketPath();
		const server = Bun.serve({
			unix: path,
			fetch(request) {
				const url = new URL(request.url);
				if (url.pathname === '/v1/workloads/wld_abc123')
					return Response.json({ error: 'unit not found' }, { status: 500 });
				return Response.json({ ok: true });
			},
		});
		servers.push(server);

		const client = new HelperClient(path);
		await expect(client.status('wld_abc123')).rejects.toThrow(/unit not found/);
	});

	test('reports a missing helper socket clearly', async () => {
		const client = new HelperClient(join(tmpdir(), 'skiff-missing-helper-socket.sock'));
		await expect(client.health()).rejects.toThrow(HelperError);
		await expect(client.health()).rejects.toThrow(/helper unavailable/);
	});
});
