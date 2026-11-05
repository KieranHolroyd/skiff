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

	async purge(id: string): Promise<void> {
		this.calls.push(`purge:${id}`);
	}

	async dumpDatabase(id: string): Promise<{ path: string; sizeBytes: number; filename: string }> {
		this.calls.push(`dump:${id}`);
		return { path: '/tmp/unused.dump', sizeBytes: 0, filename: `${id}.dump` };
	}

	async restoreDatabase(id: string): Promise<void> {
		this.calls.push(`restore:${id}`);
	}

	async rotateDatabaseRole(id: string, role: string): Promise<void> {
		this.calls.push(`rotate:${id}:${role}`);
	}

	async restartPooler(id: string): Promise<void> {
		this.calls.push(`restart-pooler:${id}`);
	}

	async pitrConfigure(id: string, repo: unknown): Promise<{ stanza: string; configPath: string }> {
		this.calls.push(`pitr-configure:${id}`);
		return { stanza: id, configPath: `/run/skiff-workloads/${id}/pgbackrest.conf` };
	}

	async pitrBaseBackup(id: string, type: unknown): Promise<{ stanza: string; type: 'full' | 'diff' | 'incr' }> {
		this.calls.push(`pitr-basebackup:${id}:${String(type)}`);
		return { stanza: id, type: type === 'diff' || type === 'incr' ? type : 'full' };
	}

	async pitrRestore(
		id: string,
		input: { targetDatabaseId: unknown; targetTime: unknown },
	): Promise<{ targetDatabaseId: string; targetTime: number; verified: true }> {
		this.calls.push(`pitr-restore:${id}:${String(input.targetDatabaseId)}`);
		return { targetDatabaseId: String(input.targetDatabaseId), targetTime: Number(input.targetTime), verified: true };
	}

	async pitrStatus(id: string): Promise<{
		configured: boolean;
		stanza: string;
		repo: { bucket: string | null; region: string | null; endpoint: string | null; path: string | null };
		archiveStatus: 'ok' | 'failing' | 'unknown';
	}> {
		this.calls.push(`pitr-status:${id}`);
		return {
			configured: false,
			stanza: id,
			repo: { bucket: null, region: null, endpoint: null, path: null },
			archiveStatus: 'unknown',
		};
	}

	async status(id: string): Promise<HelperWorkloadStatus> {
		return { id, status: 'running', restarts: 2 };
	}

	async volumesInventory() {
		this.calls.push('volumes:inventory');
		return { generatedAt: '2026-11-05T00:00:00.000Z', mounts: [], devices: [] };
	}

	async syncVolumes(volumes: unknown) {
		this.calls.push(`volumes:sync:${Array.isArray(volumes) ? volumes.length : 'invalid'}`);
		return Array.isArray(volumes) ? volumes.length : 0;
	}

	async verifyVolume(input: { mountPath: string; sourceKey: string }) {
		this.calls.push(`volumes:verify:${input.mountPath}:${input.sourceKey}`);
		return { ok: true, mountPath: input.mountPath, sourceKey: input.sourceKey, message: null };
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

	test('purges a database by id with POST only', async () => {
		const runtime = new FakeRuntime();
		const id = 'db_0123456789abcdef0123456789abcdef';
		const response = await handler(runtime)(
			new Request(`http://localhost/v1/workloads/${id}/purge`, { method: 'POST' }),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true, purged: id });
		expect(runtime.calls).toEqual([`purge:${id}`]);

		const get = await handler(runtime)(new Request(`http://localhost/v1/workloads/${id}/purge`));
		expect(get.status).toBe(405);
		expect(get.headers.get('allow')).toBe('POST');
	});

	test('purges a storage instance by id', async () => {
		const runtime = new FakeRuntime();
		const id = 'st_fedcba9876543210fedcba9876543210';
		const response = await handler(runtime)(
			new Request(`http://localhost/v1/workloads/${id}/purge`, { method: 'POST' }),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true, purged: id });
		expect(runtime.calls).toEqual([`purge:${id}`]);
	});

	test('refuses to purge anything but a db_ or st_ id', async () => {
		const runtime = new FakeRuntime();
		for (const raw of ['wld_abc123', '..%2Fstate', 'db_', 'db_a%2Fb', 'st_', 'st_a%2Fb', '%E0%A4%A']) {
			const response = await handler(runtime)(
				new Request(`http://localhost/v1/workloads/${raw}/purge`, { method: 'POST' }),
			);
			expect(response.status).toBe(400);
		}
		expect(runtime.calls).toEqual([]);
	});

	test('accepts a database workload and passes its profile through', async () => {
		const runtime = new FakeRuntime();
		const id = 'db_0123456789abcdef0123456789abcdef';
		const response = await handler(runtime)(
			post('/v1/workloads', {
				workload: workloadInput({
					id,
					projectId: id,
					deploymentId: id,
					runtime: 'container',
					release: null,
					image: 'docker.io/library/postgres:16-alpine',
					port: 15433,
					socketActivation: false,
					database: { engine: 'postgres', version: '16' },
				}),
				activation: activationInput({
					workloadId: id,
					env: { POSTGRES_PASSWORD: 'pw' },
					monitor: { ownerPassword: 'pw', monitorPassword: 'mon' },
				}),
			}),
		);
		expect(response.status).toBe(200);
		expect(runtime.applyInput?.workload.database).toEqual({ engine: 'postgres', version: '16' });
		expect(JSON.stringify(runtime.applyInput?.activation)).not.toContain('mon');
	});

	test('accepts a storage workload with agent desired state and strips it to engine + version', async () => {
		const runtime = new FakeRuntime();
		const id = 'st_fedcba9876543210fedcba9876543210';
		const response = await handler(runtime)(
			post('/v1/workloads', {
				workload: workloadInput({
					id,
					projectId: id,
					deploymentId: id,
					runtime: 'container',
					release: null,
					image: 'docker.io/rustfs/rustfs:1.0.4',
					port: 19000,
					healthPath: '/health',
					socketActivation: false,
					objectStorage: {
						engine: 'rustfs',
						version: '1.0.4',
						buckets: [{ name: 'uploads', access: 'private' }],
						users: [{ accessKeyId: 'SKFAAAAAAAAAAAAAAAAA', grants: [{ bucket: 'uploads', mode: 'read-write' }] }],
						deleteBuckets: [],
						keysVersion: 'c'.repeat(64),
					},
				}),
				activation: activationInput({
					workloadId: id,
					env: { RUSTFS_ACCESS_KEY: 'SKRROOT', RUSTFS_SECRET_KEY: 'root-secret' },
					storageAdmin: { rootSecretAccessKey: 'root-secret', users: { SKFAAAAAAAAAAAAAAAAA: 'user-secret' } },
				}),
			}),
		);
		expect(response.status).toBe(200);
		expect(runtime.applyInput?.workload.objectStorage).toEqual({ engine: 'rustfs', version: '1.0.4' });
		expect(JSON.stringify(runtime.applyInput)).not.toContain('user-secret');
	});

	test('rejects a database workload with a foreign image', async () => {
		const id = 'db_0123456789abcdef0123456789abcdef';
		const response = await handler()(
			post('/v1/workloads', {
				workload: workloadInput({
					id,
					runtime: 'container',
					release: null,
					image: 'ghcr.io/evil/postgres:16-alpine',
					socketActivation: false,
					database: { engine: 'postgres', version: '16' },
				}),
				activation: activationInput({ workloadId: id }),
			}),
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

	test('serves the read-only volume inventory', async () => {
		const runtime = new FakeRuntime();
		const response = await handler(runtime)(new Request('http://localhost/v1/volumes'));
		expect(response.status).toBe(200);
		const body = (await response.json()) as { ok: boolean; inventory: { mounts: unknown[] } };
		expect(body.ok).toBe(true);
		expect(body.inventory.mounts).toEqual([]);
		expect(runtime.calls).toEqual(['volumes:inventory']);
	});

	test('verifies a volume and rejects a non-absolute path', async () => {
		const runtime = new FakeRuntime();
		const ok = await handler(runtime)(
			post('/v1/volumes/verify', { mountPath: '/mnt/data', sourceKey: 'fs:data-uuid' }),
		);
		expect(ok.status).toBe(200);
		expect(await ok.json()).toMatchObject({ ok: true, mountPath: '/mnt/data' });

		const bad = await handler(runtime)(post('/v1/volumes/verify', { mountPath: 'mnt/data', sourceKey: 'fs:x' }));
		expect(bad.status).toBe(400);
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
