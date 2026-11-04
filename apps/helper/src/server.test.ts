import { describe, expect, test, afterEach } from 'bun:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadHelperConfig } from './config.ts';
import { createHandler, startHelperServer, type HelperRuntime } from './server.ts';
import type { HelperWorkloadStatus } from './systemd.ts';
import type { WorkloadActivation, WorkloadDesired } from './validate.ts';

const SHA = 'a'.repeat(64);
const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function workloadInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: 'wld_abc123',
		projectId: 'prj_abc123',
		projectSlug: 'my-app',
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
		...overrides,
	};
}

function activationInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		workloadId: 'wld_abc123',
		activationVersion: 'b'.repeat(64),
		env: {},
		files: {},
		...overrides,
	};
}

class FakeRuntime implements HelperRuntime {
	calls: string[] = [];
	failApply = false;
	applyInput: { workload: WorkloadDesired; activation: WorkloadActivation } | null = null;

	async ensureSlice(options: { memoryMb: number; cpuWeight?: number }): Promise<void> {
		this.calls.push(`slice:${options.memoryMb}:${options.cpuWeight}`);
	}

	async apply(workload: WorkloadDesired, activation: WorkloadActivation): Promise<HelperWorkloadStatus> {
		if (this.failApply) throw new Error('systemctl restart failed (1): unit not found');
		this.applyInput = { workload, activation };
		this.calls.push(`apply:${workload.id}`);
		return { id: workload.id, status: 'running', restarts: 0 };
	}

	async remove(id: string): Promise<void> {
		this.calls.push(`remove:${id}`);
	}

	async status(id: string): Promise<HelperWorkloadStatus> {
		return { id, status: 'running', restarts: 2 };
	}

	logReads: Array<{ id: string; cursor?: string; lines?: number }> = [];

	async logs(id: string, options: { cursor?: string; lines?: number } = {}) {
		this.logReads.push({ id, ...options });
		return {
			entries: [
				{ cursor: 's=1', ts: 1_700_000_000_000, priority: 6, message: 'listening on :3000' },
			],
			nextCursor: 's=1',
		};
	}
}

function handler(runtime: HelperRuntime = new FakeRuntime()): (request: Request) => Promise<Response> {
	return createHandler(runtime, { version: '0.1.0' });
}

function post(path: string, body: unknown): Request {
	return new Request(`http://localhost${path}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
}

describe('helper HTTP surface', () => {
	test('reports health', async () => {
		const response = await handler()(new Request('http://localhost/healthz'));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true, version: '0.1.0' });
	});

	test('applies a slice budget', async () => {
		const runtime = new FakeRuntime();
		const response = await handler(runtime)(post('/v1/slice', { memoryMb: 1024 }));
		expect(response.status).toBe(200);
		expect(runtime.calls).toEqual(['slice:1024:200']);
	});

	test('rejects an out-of-range slice budget', async () => {
		const response = await handler()(post('/v1/slice', { memoryMb: 4 }));
		expect(response.status).toBe(400);
	});

	test('applies a validated workload and activation', async () => {
		const runtime = new FakeRuntime();
		const response = await handler(runtime)(
			post('/v1/workloads', { workload: workloadInput(), activation: activationInput() }),
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { ok: boolean; workload: HelperWorkloadStatus };
		expect(body.workload.status).toBe('running');
		expect(runtime.calls).toEqual(['apply:wld_abc123']);
		expect(runtime.applyInput?.workload.id).toBe('wld_abc123');
	});

	test('rejects a workload whose activation belongs to another version', async () => {
		const response = await handler()(
			post('/v1/workloads', {
				workload: workloadInput(),
				activation: activationInput({ activationVersion: SHA }),
			}),
		);
		expect(response.status).toBe(400);
	});

	test('returns status and removes by id', async () => {
		const runtime = new FakeRuntime();
		const get = await handler(runtime)(new Request('http://localhost/v1/workloads/wld_abc123'));
		expect(await get.json()).toEqual({
			ok: true,
			workload: { id: 'wld_abc123', status: 'running', restarts: 2 },
		});
		const del = await handler(runtime)(
			new Request('http://localhost/v1/workloads/wld_abc123', { method: 'DELETE' }),
		);
		expect(del.status).toBe(200);
		expect(runtime.calls).toEqual(['remove:wld_abc123']);
	});

	test('reads workload logs with a cursor and a bounded line count', async () => {
		const runtime = new FakeRuntime();
		const response = await handler(runtime)(
			new Request('http://localhost/v1/workloads/wld_abc123/logs?cursor=s%3D0&lines=50'),
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			ok: boolean;
			entries: Array<{ message: string }>;
			nextCursor: string | null;
		};
		expect(body.entries[0]?.message).toContain('listening');
		expect(body.nextCursor).toBe('s=1');
		expect(runtime.logReads).toEqual([{ id: 'wld_abc123', cursor: 's=0', lines: 50 }]);
	});

	test('rejects an out-of-range log line count', async () => {
		const response = await handler()(
			new Request('http://localhost/v1/workloads/wld_abc123/logs?lines=5000'),
		);
		expect(response.status).toBe(400);
	});

	test('rejects unsafe ids in the path', async () => {
		const response = await handler()(new Request('http://localhost/v1/workloads/..%2Fetc'));
		expect(response.status).toBe(400);
	});

	test('maps malformed bodies, wrong methods and unknown paths', async () => {
		const runtime = new FakeRuntime();
		const malformed = await handler(runtime)(
			new Request('http://localhost/v1/slice', { method: 'POST', body: 'not json' }),
		);
		expect(malformed.status).toBe(400);

		const wrongMethod = await handler(runtime)(new Request('http://localhost/v1/slice'));
		expect(wrongMethod.status).toBe(405);
		expect(wrongMethod.headers.get('allow')).toBe('POST');

		const unknown = await handler(runtime)(new Request('http://localhost/v1/nope'));
		expect(unknown.status).toBe(404);
	});

	test('surfaces runtime failures as 500 without a request echo', async () => {
		const runtime = new FakeRuntime();
		runtime.failApply = true;
		const response = await handler(runtime)(
			post('/v1/workloads', { workload: workloadInput(), activation: activationInput() }),
		);
		expect(response.status).toBe(500);
		const body = (await response.json()) as { error: string };
		expect(body.error).toContain('systemctl');
		expect(body.error).not.toContain('activation');
	});

	test('rejects oversized bodies', async () => {
		const small = createHandler(new FakeRuntime(), { version: '0.1.0', maxBodyBytes: 16 });
		const response = await small(post('/v1/slice', { memoryMb: 1024 }));
		expect(response.status).toBe(413);
	});

	test('binds a group-restricted unix socket and removes it on stop', async () => {
		const dir = await fs.mkdtemp(join(tmpdir(), 'skiff-helper-server-'));
		directories.push(dir);
		const config = loadHelperConfig({ SKIFF_HELPER_SOCKET: join(dir, 'helper.sock') });
		const helper = await startHelperServer(config, new FakeRuntime());
		try {
			expect((await fs.stat(config.socketPath)).mode & 0o777).toBe(0o660);
			const response = await fetch('http://localhost/healthz', { unix: config.socketPath });
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ ok: true, version: '0.1.0' });
		} finally {
			await helper.stop();
		}
		await expect(fs.stat(config.socketPath)).rejects.toThrow();
	});
});
