import type {
	PipelineJobClaim,
	PipelineJobComplete,
	PipelineJobSpec,
	PipelineLogBatch,
	PipelineStepReport,
	PipelineStepSpec,
} from '@yoal/contracts';

/**
 * An in-process fake of the job API (`/api/pipeline/*`) for step runner and executor tests:
 * records every call, serves secrets, and keeps artifacts and caches in memory behind relative
 * "presigned" URLs.
 */
export interface FakeControlPlane {
	url: string;
	token: string;
	steps: Array<{ index: number; report: PipelineStepReport }>;
	logs: PipelineLogBatch['lines'];
	completes: PipelineJobComplete[];
	heartbeats: number;
	resolves: unknown[];
	cancelled: boolean;
	caches: Map<string, { key: string; version: string; data: Uint8Array }>;
	artifacts: Map<string, { id: string; name: string; sha256: string; size: number; data: Uint8Array | null }>;
	logText(): string;
	stepLog(index: number): string[];
	finalSteps(): Map<number, PipelineStepReport>;
	stop(): void;
}

export function startFakeControlPlane(options: { secrets?: Record<string, string>; token?: string } = {}): FakeControlPlane {
	const token = options.token ?? 'job-token-123';
	const blobs = new Map<string, Uint8Array>();
	const pendingCaches = new Map<string, { key: string; version: string }>();
	let counter = 0;
	const state: Omit<FakeControlPlane, 'url' | 'stop' | 'logText' | 'stepLog' | 'finalSteps' | 'token'> = {
		steps: [],
		logs: [],
		completes: [],
		heartbeats: 0,
		resolves: [],
		cancelled: false,
		caches: new Map(),
		artifacts: new Map(),
	};
	const json = (value: unknown) => Response.json(value);
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const path = url.pathname;
			if (path.startsWith('/blob/')) {
				const id = path.slice('/blob/'.length);
				if (request.method === 'PUT') {
					blobs.set(id, new Uint8Array(await request.arrayBuffer()));
					return new Response(null, { status: 200 });
				}
				const blob = blobs.get(id);
				return blob ? new Response(blob) : new Response('missing', { status: 404 });
			}
			if (request.headers.get('authorization') !== `Bearer ${token}`) return new Response('unauthorized', { status: 401 });
			const body = request.method === 'POST' ? await request.json().catch(() => ({})) : null;
			if (path === '/api/pipeline/secrets') return json({ secrets: options.secrets ?? {} });
			if (path === '/api/pipeline/heartbeat') {
				state.heartbeats += 1;
				return json({ cancelled: state.cancelled, leaseExpiresAt: Date.now() + 60_000 });
			}
			if (path === '/api/pipeline/logs') {
				state.logs.push(...(body as PipelineLogBatch).lines);
				return json({ ok: true });
			}
			if (path === '/api/pipeline/resolve') {
				state.resolves.push(body);
				return json({ ok: true });
			}
			const stepMatch = /^\/api\/pipeline\/steps\/(\d+)$/.exec(path);
			if (stepMatch) {
				state.steps.push({ index: Number(stepMatch[1]), report: body as PipelineStepReport });
				return json({ ok: true });
			}
			if (path === '/api/pipeline/complete') {
				state.completes.push(body as PipelineJobComplete);
				return json({ ok: true });
			}
			if (path === '/api/pipeline/artifacts' && request.method === 'POST') {
				const id = `art${++counter}`;
				const input = body as { name: string; sha256: string; size: number };
				state.artifacts.set(id, { id, name: input.name, sha256: input.sha256, size: input.size, data: null });
				return json({ artifactId: id, uploadUrl: `/blob/${id}` });
			}
			const finalize = /^\/api\/pipeline\/artifacts\/([^/]+)\/finalize$/.exec(path);
			if (finalize) {
				const artifact = state.artifacts.get(finalize[1]!)!;
				artifact.data = blobs.get(artifact.id) ?? null;
				return json({ id: artifact.id, name: artifact.name, sha256: artifact.sha256, size: artifact.size });
			}
			if (path === '/api/pipeline/artifacts') {
				const name = url.searchParams.get('name');
				const artifacts = [...state.artifacts.values()]
					.filter((artifact) => artifact.data && (!name || artifact.name === name))
					.map((artifact) => ({ ...artifact, data: undefined, downloadUrl: `/blob/${artifact.id}` }));
				return json({ artifacts });
			}
			if (path === '/api/pipeline/cache/lookup') {
				const input = body as { key: string; restoreKeys: string[]; version: string };
				const entries = [...state.caches.values()].filter((entry) => entry.version === input.version);
				const exact = entries.find((entry) => entry.key === input.key);
				const prefix = input.restoreKeys.map((key) => entries.find((entry) => entry.key.startsWith(key))).find(Boolean);
				const hit = exact ?? prefix;
				if (!hit) return json({ hit: null });
				const id = `cache${++counter}`;
				blobs.set(id, hit.data);
				return json({ hit: { key: hit.key, downloadUrl: `/blob/${id}`, size: hit.data.byteLength } });
			}
			if (path === '/api/pipeline/cache/reserve') {
				const input = body as { key: string; version: string };
				if (state.caches.has(`${input.key}|${input.version}`)) return json({ cacheId: null, uploadUrl: null, reason: 'exists' });
				const id = `c${++counter}`;
				pendingCaches.set(id, input);
				return json({ cacheId: id, uploadUrl: `/blob/${id}` });
			}
			const commit = /^\/api\/pipeline\/cache\/([^/]+)\/commit$/.exec(path);
			if (commit) {
				const pending = pendingCaches.get(commit[1]!)!;
				state.caches.set(`${pending.key}|${pending.version}`, { ...pending, data: blobs.get(commit[1]!)! });
				return json({ ok: true });
			}
			return new Response(`not found: ${path}`, { status: 404 });
		},
	});
	const fake = state as FakeControlPlane;
	fake.url = `http://127.0.0.1:${server.port}`;
	fake.token = token;
	fake.stop = () => server.stop(true);
	fake.logText = () => state.logs.map((line) => line.text).join('\n');
	fake.stepLog = (index) => state.logs.filter((line) => line.step === index).map((line) => line.text);
	fake.finalSteps = () => {
		const result = new Map<number, PipelineStepReport>();
		for (const { index, report } of state.steps) if (report.status === 'completed') result.set(index, report);
		return result;
	};
	return fake;
}

export function stepSpec(partial: Partial<PipelineStepSpec>): PipelineStepSpec {
	return {
		id: null,
		name: partial.run ? `Run ${partial.run.split('\n')[0]}` : `Run ${partial.uses ?? 'step'}`,
		if: null,
		run: null,
		shell: null,
		workingDirectory: null,
		uses: null,
		with: {},
		env: {},
		continueOnError: false,
		timeoutMinutes: null,
		...partial,
	};
}

export function jobClaim(input: {
	steps: PipelineStepSpec[];
	job?: Partial<PipelineJobSpec>;
	workflowEnv?: Record<string, string>;
	cloneUrl?: string;
	sha?: string;
	token?: string;
}): PipelineJobClaim {
	return {
		kind: 'job',
		jobId: 'job_test1',
		runId: 'run_1',
		runNumber: 7,
		attempt: 1,
		token: input.token ?? 'job-token-123',
		repository: { id: 'repo_1', name: 'acme/app', cloneUrl: input.cloneUrl ?? 'https://github.com/acme/app.git' },
		checkout: { ref: 'refs/heads/main', sha: input.sha ?? 'a'.repeat(40) },
		workflow: { name: 'ci', path: '.yoal/workflows/ci.yml' },
		job: {
			key: 'test',
			name: 'test',
			needs: [],
			if: null,
			runsOn: ['linux'],
			strategy: { matrix: null, failFast: true, maxParallel: null },
			outputs: {},
			env: {},
			defaults: { shell: null, workingDirectory: null },
			timeoutMinutes: 60,
			continueOnError: false,
			concurrency: null,
			environment: null,
			container: null,
			services: {},
			steps: input.steps,
			...input.job,
		},
		workflowEnv: input.workflowEnv ?? {},
		workflowDefaults: { shell: null, workingDirectory: null },
		context: {
			yoal: { event_name: 'push', actor: 'kieran', server_url: 'https://control.test', repository: 'acme/app' },
			matrix: { node: '24' },
		},
		secretNames: [],
		trust: 'trusted',
		image: 'docker.io/library/node:24-bookworm',
		limits: { memoryMb: 2048, cpus: 2, timeoutMinutes: 60 },
	};
}
