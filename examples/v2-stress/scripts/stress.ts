#!/usr/bin/env bun
/**
 * Black-box stress and conformance run against a deployed v2-stress workload.
 *
 * The app is ordinary HTTP: this script knows nothing about Skiff internals except the public
 * REST and agent APIs it uses for optional cross-checks. Run it against the deployed URL (with
 * `--node-token` for desired-state/activation checks) or against `bun run dev` locally.
 */

import {
	ApiClient,
	ApiError,
	Flags,
	asArray,
	bold,
	dim,
	green,
	percentile,
	readState,
	red,
	round,
	sha256Hex,
	sleep,
	unwrap,
	yellow,
	type FlagSpec,
	type StressState
} from './lib.ts';
import { resolve } from 'node:path';

const flags = new Flags(process.argv.slice(2), {
	base: 'string',
	state: 'string',
	api: 'string',
	token: 'string',
	node: 'string',
	'node-token': 'string',
	project: 'string',
	workload: 'string',
	'expect-env': 'string',
	'secret-env-sha': 'string',
	'secret-file-sha': 'string',
	secrets: 'boolean',
	'no-secrets': 'boolean',
	requests: 'string',
	concurrency: 'string',
	p95: 'string',
	timeout: 'string',
	memory: 'string',
	writes: 'string',
	crash: 'boolean',
	'require-running': 'boolean',
	'domain-verified': 'boolean',
	'skip-load': 'boolean',
	json: 'boolean',
	help: 'boolean'
} satisfies FlagSpec);

if (flags.bool('help')) {
	console.log(`Usage: bun examples/v2-stress/scripts/stress.ts [options]

Target:
  --base <url>             app URL (default: .state.json appUrl or STRESS_BASE)
  --state <path>           provision state file (default examples/v2-stress/.state.json)
  --expect-env <name>      expected STRESS_ENV (default production when state exists)

Secrets:
  --secret-env-sha <hex>   expected sha256 of STRESS_ENV_SECRET
  --secret-file-sha <hex>  expected sha256 of STRESS_FILE_SECRET
  --secrets                require injected secrets even without a state file
  --no-secrets             skip secret checks

Load and limits:
  --requests <n>           total sample requests (default 200)
  --concurrency <n>        concurrent requests (default 16)
  --p95 <ms>               fail when p95 exceeds this (default 2000)
  --timeout <ms>           per-request timeout (default 10000)
  --writes <n>             concurrent /api/data increments (default 40, 0 disables)
  --memory <mb>            allocate this much to test MemoryMax (default 0; destructive)
  --crash                  restart the app and verify recovery (default off)
  --skip-load              skip the load sample

Control plane (optional):
  --api <origin>           platform origin (default state.platform or SKIFF_URL)
  --token <key>            user API key (default SKIFF_TOKEN)
  --node <origin>          node-API origin (default --api)
  --node-token <token>     node token for desired-state and activation checks
  --project <slug>         project slug (default state.project)
  --workload <id>          workload id (default state.workloadId)
  --require-running        fail unless the workload reports running
  --no-require-running     do not require the running status
  --domain-verified        fail unless the custom domain is verified/active

Output:
  --json                   machine-readable report
  -h, --help
`);
	process.exit(0);
}

const statePath = flags.string('state') ?? resolve(import.meta.dir, '../.state.json');
const state: StressState | null = readState(statePath);
const base = (flags.string('base') ?? state?.appUrl ?? process.env.STRESS_BASE ?? '').replace(
	/\/+$/,
	''
);
if (!base) {
	fail('Set --base (or run the provision script first so .state.json has appUrl).');
}
const baseUrl = new URL(base);
const stateMatchesBase = (state?.appUrl ?? '').replace(/\/+$/, '') === base;
const project = flags.string('project') ?? state?.project ?? '';
const apiOrigin = (flags.string('api') ?? state?.platform ?? process.env.SKIFF_URL ?? '').replace(
	/\/+$/,
	''
);
const apiToken = flags.string('token') ?? process.env.SKIFF_TOKEN ?? '';
const nodeOrigin = (flags.string('node') ?? apiOrigin).replace(/\/+$/, '');
const nodeToken = flags.string('node-token') ?? process.env.SKIFF_NODE_TOKEN ?? '';
const requests = flags.int('requests', 200, 1, 100_000);
const concurrency = flags.int('concurrency', 16, 1, 512);
const fit = Math.min(concurrency, requests);
const p95Budget = flags.int('p95', 2000, 1, 600_000);
const timeoutMs = flags.int('timeout', 10_000, 100, 120_000);
const memoryMb = flags.int('memory', 0, 0, 512);
const writes = flags.int('writes', 40, 0, 10_000);
const expectEnv = flags.string('expect-env') ?? (stateMatchesBase ? 'production' : undefined);
const secretEnvSha =
  flags.string('secret-env-sha') ?? (stateMatchesBase ? state?.secretDigests.STRESS_ENV_SECRET : undefined);
const secretFileSha =
  flags.string('secret-file-sha') ?? (stateMatchesBase ? state?.secretDigests.STRESS_FILE_SECRET : undefined);
const explicitSecrets = Boolean(
	flags.string('secret-env-sha') || flags.string('secret-file-sha') || flags.bool('secrets')
);
const expectSecrets =
	!flags.bool('no-secrets') && (explicitSecrets || Boolean(secretEnvSha || secretFileSha));
const apiAvailable = Boolean(apiOrigin && apiToken);
const requireRunning = flags.has('require-running') ? flags.bool('require-running') : true;
const api = apiAvailable ? new ApiClient({ baseUrl: apiOrigin, token: apiToken }) : null;

interface CheckResult {
	name: string;
	status: 'pass' | 'fail' | 'skip';
	ms: number;
	detail?: string;
}

const checks: CheckResult[] = [];

async function check(name: string, fn: () => Promise<string | void>): Promise<void> {
	const started = performance.now();
	try {
		const detail = await fn();
		checks.push({
			name,
			status: 'pass',
			ms: round(performance.now() - started, 1),
			...(detail ? { detail } : {})
		});
	} catch (error) {
		checks.push({
			name,
			status: 'fail',
			ms: round(performance.now() - started, 1),
			detail: error instanceof Error ? error.message : String(error)
		});
	}
}

function skip(name: string, reason: string): void {
	checks.push({ name, status: 'skip', ms: 0, detail: reason });
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
	if (actual !== expected)
		throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
}

function record(value: unknown, label: string): Record<string, unknown> {
	assert(
		value !== null && typeof value === 'object' && !Array.isArray(value),
		`${label} is not an object`
	);
	return value as Record<string, unknown>;
}

function arrayOf(value: unknown, label: string): unknown[] {
	assert(Array.isArray(value), `${label} is not an array`);
	return value;
}

function numberValue(value: unknown, label: string): number {
	assert(typeof value === 'number' && Number.isFinite(value), `${label} is not a number`);
	return value;
}

function stringValue(value: unknown, label: string): string {
	assert(typeof value === 'string', `${label} is not a string`);
	return value;
}

interface SecretMetadata {
	name?: string;
	present?: boolean;
	source?: string;
	length?: number;
	sha256?: string;
	error?: string;
}

interface AppInfo {
	app: string;
	version: string;
	requestCount: number;
	runtime: {
		bun: string;
		pid: number;
		instanceId: string;
		bootId: string;
		uptimeSeconds: number;
		memory: { rssBytes: number; heapUsedBytes: number };
		cgroup: Record<string, string>;
	};
	config: {
		host: string;
		port: number;
		env: Record<string, string>;
		secrets: { env: SecretMetadata; file: SecretMetadata };
		data: { kind: string; path: string | null; counters: number; error: string | null };
		socketActivation: { listenFds: string | null };
	};
}

async function fetchApp(
	path: string,
	init: RequestInit = {},
	timeout = timeoutMs
): Promise<Response> {
	return fetch(new URL(path, baseUrl), {
		redirect: 'manual',
		...init,
		headers: { accept: '*/*', ...(init.headers ?? {}) },
		signal: init.signal ?? AbortSignal.timeout(timeout)
	});
}

async function appJson<T = unknown>(
	path: string,
	init: RequestInit = {}
): Promise<{ response: Response; body: T }> {
	const response = await fetchApp(path, init);
	const text = await response.text();
	let body: unknown = null;
	try {
		body = text ? JSON.parse(text) : null;
	} catch {
		throw new Error(`${path} returned non-JSON (HTTP ${response.status}): ${text.slice(0, 200)}`);
	}
	return { response, body: body as T };
}

async function getInfo(): Promise<AppInfo> {
	const { response, body } = await appJson<AppInfo>('/api/info');
	assertEqual(response.status, 200, '/api/info status');
	assert(body && typeof body === 'object', '/api/info body');
	return body;
}

function secretDetail(label: string, meta: SecretMetadata | undefined, expected?: string): string {
	assert(meta, `${label} metadata missing from /api/info`);
	assert(meta.present === true, `${label} is not injected${meta.error ? `: ${meta.error}` : ''}`);
	if (expected) {
		assert(meta.sha256, `${label} has no digest`);
		assertEqual(meta.sha256, expected, `${label} digest`);
		return `${label} sha256:${meta.sha256.slice(0, 12)}… matches`;
	}
	return `${label} present sha256:${meta.sha256?.slice(0, 12) ?? '?'}… (no expected digest)`;
}

// --- control-plane views --------------------------------------------------

interface ProjectView {
	id: string;
	slug: string;
	runtime: string;
	placement: string;
	productionDeploymentId: string | null;
	productionUrl: string;
}
interface WorkloadView {
	id: string;
	projectSlug: string;
	deploymentId: string;
	nodeId: string | null;
	runtime: string;
	status: string;
	memoryMb: number;
	cpus: number;
	upstream: string | null;
	message: string | null;
}
interface DeploymentView {
	id: string;
	status: string;
	production?: boolean;
	environmentSlug?: string;
}
interface EnvironmentView {
	slug: string;
	name: string;
	isProduction: boolean;
	host: string;
	deploymentId: string | null;
}
interface CapacityView {
	nodeId: string;
	sliceMemoryMb: number;
	reservedMemoryMb: number;
	freeMemoryMb: number;
	workloadCount: number;
}
interface GitView {
	repoUrl: string;
	branch: string;
	rootDir: string;
	buildCommand: string;
	outputDir: string;
	hasWebhookSecret: boolean;
}
interface DomainView {
	id: string;
	hostname: string;
	status: string;
}

interface DesiredWorkload {
	id: string;
	runtime: string;
	status: string;
	upstream: string;
	command?: string[];
	image?: string;
	activationVersion: string;
	env: Record<string, string>;
	secrets: Array<{ name: string; delivery: string; version?: number }>;
	port: number;
	healthPath: string;
	socketActivation: boolean;
	memoryMb: number;
}
interface DesiredState {
	workloads: DesiredWorkload[];
}
interface Activation {
	workloadId: string;
	activationVersion: string;
	env: Record<string, string>;
	files: Record<string, string>;
}

// --- run ------------------------------------------------------------------

const startedAt = new Date();
let info: AppInfo;
try {
	info = await getInfo();
} catch (error) {
	fail(`cannot reach ${base}: ${error instanceof Error ? error.message : String(error)}`);
}

await check('health endpoint', async () => {
	const { response, body } = await appJson<{ ok?: boolean; app?: string; data?: string }>(
		'/healthz'
	);
	assertEqual(response.status, 200, '/healthz status');
	assert(body.ok === true, 'healthz ok must be true');
	assertEqual(body.app, 'v2-stress', 'healthz app');
	return `pid ${info.runtime.pid}, data ${String(body.data)}`;
});

await check('health strict mode', async () => {
	const response = await fetchApp('/healthz?strict=1');
	const expected = info.config.data.kind === 'sqlite' ? 200 : 503;
	assertEqual(response.status, expected, `strict health (data is ${info.config.data.kind})`);
	return `HTTP ${response.status} for ${info.config.data.kind} data`;
});

await check('runtime identity', async () => {
	assertEqual(info.app, 'v2-stress', 'app');
	assert(info.runtime && info.runtime.pid > 0, 'pid');
	assert(info.runtime.bun.length > 0, 'bun version');
	assert(info.runtime.instanceId.length === 8, 'instance id');
	assert(info.runtime.uptimeSeconds >= 0, 'uptime');
	return `bun ${info.runtime.bun}, pid ${info.runtime.pid}, instance ${info.runtime.instanceId}`;
});

await check('public env', async () => {
	assertEqual(info.config.env.STRESS_APP, 'v2-stress', 'STRESS_APP');
	assert(info.config.env.STRESS_BUILD, 'STRESS_BUILD is missing');
	if (expectEnv) {
		assertEqual(info.config.env.STRESS_ENV, expectEnv, 'STRESS_ENV');
		return `STRESS_ENV=${expectEnv}, build=${info.config.env.STRESS_BUILD}`;
	}
	return `STRESS_ENV=${info.config.env.STRESS_ENV ?? '(unset)'}, build=${info.config.env.STRESS_BUILD}`;
});

if (expectSecrets) {
	await check('secret delivery', async () => {
		const details = [secretDetail('STRESS_ENV_SECRET', info.config.secrets.env, secretEnvSha)];
		if (secretFileSha || info.config.secrets.file.present) {
			details.push(secretDetail('STRESS_FILE_SECRET', info.config.secrets.file, secretFileSha));
		}
		return details.join('; ');
	});
} else {
	skip('secret delivery', 'no expected digests (pass --secrets or provision first)');
}

let dataValue = 0;
await check('data read/write', async () => {
	const before = await appJson<{ value: number; data: { kind: string } }>('/api/data?key=visits');
	assertEqual(before.response.status, 200, 'GET /api/data status');
	const written = await appJson<{ value: number }>('/api/data?key=visits&by=3', { method: 'POST' });
	assertEqual(written.response.status, 200, 'POST /api/data status');
	const after = await appJson<{ value: number }>('/api/data?key=visits');
	const start = numberValue(before.body.value, 'visits before');
	const end = numberValue(after.body.value, 'visits after');
	assert(end >= start + 3, `counter did not grow: ${start} → ${end}`);
	dataValue = end;
	return `${info.config.data.kind} counter ${start} → ${end}${info.config.data.kind === 'memory' ? ' (memory: /data not writable)' : ''}`;
});

await check('request echo', async () => {
	const payload = JSON.stringify({ hello: 'v2-stress', at: new Date().toISOString() });
	const { response, body } = await appJson<{ body?: string; bodyBytes?: number }>('/api/echo', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: payload
	});
	assertEqual(response.status, 200, 'POST /api/echo status');
	assertEqual(body.body, payload, 'echoed body');
	assertEqual(body.bodyBytes, Buffer.byteLength(payload), 'echoed bytes');
	return `${body.bodyBytes} bytes round-tripped`;
});

await check('proxy headers', async () => {
	const { response, body } = await appJson<{ host?: string; headers?: Record<string, string> }>(
		'/api/headers'
	);
	assertEqual(response.status, 200, 'GET /api/headers status');
	assertEqual(
		response.headers.get('x-stress-instance'),
		info.runtime.instanceId,
		'instance header'
	);
	assert(
		body.host === baseUrl.host,
		`Host header ${String(body.host)} does not match ${baseUrl.host}`
	);
	return `host ${body.host}`;
});

await check('large response', async () => {
	const response = await fetchApp('/api/large?kb=512');
	assertEqual(response.status, 200, '/api/large status');
	const bytes = new Uint8Array(await response.arrayBuffer());
	assertEqual(bytes.byteLength, 512 * 1024, 'large byte length');
	const expected = response.headers.get('x-stress-sha256');
	assert(expected, 'missing x-stress-sha256');
	assertEqual(sha256Hex(bytes), expected, 'large payload digest');
	return '512 KiB digest verified';
});

await check('status passthrough', async () => {
	for (const status of [404, 418, 500]) {
		const response = await fetchApp(`/api/status/${status}`);
		assertEqual(response.status, status, `/api/status/${status}`);
		const text = await response.text();
		assert(text.includes(String(status)), `status body for ${status}`);
	}
	return '404 / 418 / 500 preserved';
});

await check('cpu endpoint', async () => {
	const { response, body } = await appJson<{
		requestedMs: number;
		elapsedMs: number;
		iterations: number;
	}>('/api/cpu?ms=200');
	assertEqual(response.status, 200, '/api/cpu status');
	assert(numberValue(body.elapsedMs, 'elapsedMs') >= 150, 'cpu loop returned too early');
	assert(numberValue(body.iterations, 'iterations') > 0, 'cpu loop did not iterate');
	return `${body.elapsedMs} ms busy loop`;
});

if (memoryMb > 0) {
	await check('memory endpoint', async () => {
		const { response, body } = await appJson<{ mb: number; bytes: number; rssDeltaBytes: number }>(
			`/api/memory?mb=${memoryMb}&hold=250`
		);
		assertEqual(response.status, 200, '/api/memory status');
		assertEqual(body.mb, memoryMb, 'allocated mb');
		assertEqual(body.bytes, memoryMb * 1024 * 1024, 'allocated bytes');
		return `${memoryMb} MiB held, rss delta ${round(body.rssDeltaBytes / 1024 / 1024, 1)} MiB`;
	});
} else {
	skip('memory endpoint', 'pass --memory <mb> to exercise MemoryMax');
}

await check('server-sent events', async () => {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 10_000);
	try {
		const response = await fetchApp('/api/stream?seconds=3&interval=100', {
			signal: controller.signal
		});
		assertEqual(response.status, 200, '/api/stream status');
		const type = response.headers.get('content-type') ?? '';
		assert(type.includes('text/event-stream'), `content-type is ${type}`);
		const body = response.body;
		assert(body, 'response has no body');
		const reader = body.getReader();
		const decoder = new TextDecoder();
		let text = '';
		let ticks = 0;
		while (ticks < 3) {
			const { value, done } = await reader.read();
			if (done) break;
			text += decoder.decode(value, { stream: true });
			ticks = text.match(/event: tick/g)?.length ?? 0;
		}
		await reader.cancel().catch(() => undefined);
		assert(ticks >= 3, `only received ${ticks} ticks`);
		return `${ticks} SSE ticks`;
	} finally {
		clearTimeout(timer);
		controller.abort();
	}
});

interface LoadResult {
	requests: number;
	failures: number;
	p50: number;
	p95: number;
	p99: number;
	max: number;
	mean: number;
	rps: number;
	wallMs: number;
}

async function loadSample(total: number, parallel: number): Promise<LoadResult> {
	const latencies: number[] = [];
	let failures = 0;
	let next = 0;
	const wallStart = performance.now();
	const workers = Array.from({ length: parallel }, async () => {
		while (true) {
			const index = next;
			next += 1;
			if (index >= total) return;
			const started = performance.now();
			try {
				const response = await fetchApp('/api/info');
				await response.arrayBuffer();
				if (response.status !== 200) failures += 1;
			} catch {
				failures += 1;
			}
			latencies.push(performance.now() - started);
		}
	});
	await Promise.all(workers);
	const wallMs = performance.now() - wallStart;
	const sorted = latencies.sort((a, b) => a - b);
	const sum = sorted.reduce((acc, value) => acc + value, 0);
	return {
		requests: total,
		failures,
		p50: percentile(sorted, 0.5),
		p95: percentile(sorted, 0.95),
		p99: percentile(sorted, 0.99),
		max: sorted[sorted.length - 1] ?? 0,
		mean: sorted.length > 0 ? sum / sorted.length : 0,
		rps: total / (wallMs / 1000),
		wallMs
	};
}

let load: LoadResult | null = null;
if (!flags.bool('skip-load')) {
	await check('load sample', async () => {
		load = await loadSample(requests, fit);
		assertEqual(load.failures, 0, `failed requests (${load.failures}/${load.requests})`);
		assert(load.p95 <= p95Budget, `p95 ${round(load.p95, 1)} ms exceeds ${p95Budget} ms`);
		return `${load.requests} requests, ${round(load.rps, 1)} req/s, p50 ${round(load.p50, 1)} ms, p95 ${round(load.p95, 1)} ms, p99 ${round(load.p99, 1)} ms`;
	});
} else {
	skip('load sample', '--skip-load');
}

if (writes > 0) {
	await check('concurrent writes', async () => {
		const key = `concurrent-${Date.now()}`;
		const before = await appJson<{ value: number }>(`/api/data?key=${encodeURIComponent(key)}`);
		const start = numberValue(before.body.value, 'write baseline');
		let failures = 0;
		let next = 0;
		const workers = Array.from({ length: Math.min(writes, fit) }, async () => {
			while (true) {
				const index = next;
				next += 1;
				if (index >= writes) return;
				try {
					const response = await fetchApp(`/api/data?key=${encodeURIComponent(key)}&by=1`, {
						method: 'POST'
					});
					await response.arrayBuffer();
					if (response.status !== 200) failures += 1;
				} catch {
					failures += 1;
				}
			}
		});
		await Promise.all(workers);
		assertEqual(failures, 0, `failed writes (${failures}/${writes})`);
		const after = await appJson<{ value: number }>(`/api/data?key=${encodeURIComponent(key)}`);
		const end = numberValue(after.body.value, 'write end');
		assertEqual(end - start, writes, 'increments lost');
		return `${writes} concurrent increments, no losses (${info.config.data.kind})`;
	});
} else {
	skip('concurrent writes', '--writes 0');
}

// --- control plane --------------------------------------------------------

let workloadId = flags.string('workload') ?? state?.workloadId ?? '';
let workload: WorkloadView | null = null;
let projectView: ProjectView | null = null;

if (api) {
	await check('project and workload state', async () => {
		assert(project, 'No project slug (use --project or run provision)');
		projectView = unwrap<ProjectView>(
			await api.get(`/api/v1/projects/${encodeURIComponent(project)}`),
			'project'
		);
		assert(projectView.productionDeploymentId, 'project has no production deployment');
		workload = unwrap<WorkloadView>(
			await api.get(`/api/v1/projects/${encodeURIComponent(project)}/workload`),
			'workload'
		);
		workloadId = workload.id;
		if (requireRunning) assertEqual(workload.status, 'running', 'workload status');
		assert(workload.nodeId, 'workload has no node');
		assert(workload.upstream, 'workload has no upstream');
		if (state?.memoryMb) assertEqual(workload.memoryMb, state.memoryMb, 'workload memoryMb');
		return `${projectView.runtime} on ${workload.nodeId}, upstream ${workload.upstream}, ${workload.status}`;
	});

	await check('production deployment', async () => {
		const current = projectView;
		assert(current, 'project check did not run');
		const listed = await api.get(
			`/api/v1/projects/${encodeURIComponent(project)}/deployments?limit=20`
		);
		const deployments = asArray<DeploymentView>(listed, 'deployments');
		assert(deployments.length > 0, 'no deployments');
		const production = deployments.find(
			(deployment) => deployment.id === current.productionDeploymentId
		);
		assert(production, 'production pointer is not in the deployment list');
		assertEqual(production.status, 'active', 'production deployment status');
		if (state?.deploymentId) {
			const deployed = deployments.find((deployment) => deployment.id === state.deploymentId);
			assert(deployed, 'provision state deployment is missing from the list');
		}
		return `${deployments.length} deployments, production ${production.id.slice(0, 14)}…`;
	});

	await check('environments', async () => {
		const listed = await api.get(`/api/v1/projects/${encodeURIComponent(project)}/environments`);
		const environments = asArray<EnvironmentView>(listed, 'environments');
		const production = environments.find((environment) => environment.isProduction);
		assert(production, 'production environment missing');
		if (state?.environment) {
			const named = environments.find((environment) => environment.slug === state.environment);
			assert(named, `environment ${state.environment} missing`);
			assert(named.host !== production.host, 'environment host equals production host');
			return `production ${production.host}, ${named.slug} ${named.host}`;
		}
		return `production ${production.host}, ${environments.length} environments`;
	});

	if (state?.gitRepo) {
		await check('git source', async () => {
			const git = unwrap<GitView>(
				await api.get(`/api/v1/projects/${encodeURIComponent(project)}/git`),
				'gitSource'
			);
			assertEqual(git.repoUrl, state?.gitRepo, 'repoUrl');
			assert(git.hasWebhookSecret, 'webhook secret is not set');
			return `${git.repoUrl} @ ${git.branch}, ${git.rootDir} → ${git.outputDir}`;
		});
	} else {
		skip('git source', 'no git source in state (provision --git-repo)');
	}

	if (state?.domain) {
		await check('custom domain', async () => {
			const listed = await api.get(`/api/v1/domains?project=${encodeURIComponent(project)}`);
			const domains = asArray<DomainView>(listed, 'domains');
			const domain = domains.find((candidate) => candidate.hostname === state?.domain);
			assert(domain, `domain ${state?.domain} missing`);
			if (flags.bool('domain-verified')) {
				assert(
					domain.status === 'verified' || domain.status === 'active',
					`domain ${domain.hostname} is ${domain.status}`
				);
			}
			return `${domain.hostname} ${domain.status}`;
		});
	} else {
		skip('custom domain', 'no domain in state (provision --domain)');
	}

	await check('node capacity', async () => {
		assert(workload, 'workload check did not run');
		let capacity: CapacityView[];
		try {
			const listed = await api.get(`/api/v1/nodes/capacity`);
			capacity = asArray<CapacityView>(listed, 'capacity');
			if (capacity.length === 0) capacity = asArray<CapacityView>(listed, 'nodes');
		} catch (error) {
			if (error instanceof ApiError && error.status === 403) {
				throw new Error('capacity is platform-admin only; rerun with an admin token');
			}
			throw error;
		}
		const node = capacity.find((candidate) => candidate.nodeId === workload?.nodeId);
		assert(node, 'workload node is not in capacity');
		assert(
			node.reservedMemoryMb >= workload.memoryMb,
			`reserved ${node.reservedMemoryMb} MB is below the workload's ${workload.memoryMb} MB`
		);
		return `${node.reservedMemoryMb}/${node.sliceMemoryMb} MB reserved, ${node.workloadCount} workloads`;
	});
} else {
	skip('control-plane state', 'set --api and --token (or SKIFF_URL/SKIFF_TOKEN)');
}

if (nodeToken && nodeOrigin && workloadId) {
	await check('desired state and activation', async () => {
		const desiredResponse = await fetch(`${nodeOrigin}/api/agent/desired-state`, {
			headers: { authorization: `Bearer ${nodeToken}`, accept: 'application/json' },
			signal: AbortSignal.timeout(timeoutMs)
		});
		assertEqual(desiredResponse.status, 200, 'GET /api/agent/desired-state');
		const desired = (await desiredResponse.json()) as DesiredState;
		const desiredWorkload = arrayOf(desired.workloads, 'desired.workloads')
			.map((entry) => entry as DesiredWorkload)
			.find((entry) => entry.id === workloadId);
		assert(desiredWorkload, `workload ${workloadId} is not in desired state`);
		assertEqual(desiredWorkload.activationVersion.length, 64, 'activationVersion length');
		assert(desiredWorkload.upstream.length > 0, 'desired upstream');
		assert(
			desiredWorkload.secrets.every((secret) => typeof secret.name === 'string'),
			'secret refs are malformed'
		);
		assert(
			desiredWorkload.secrets.every((secret) => !('value' in (secret as Record<string, unknown>))),
			'desired state contains a secret value'
		);

		const activationResponse = await fetch(
			`${nodeOrigin}/api/agent/workloads/${encodeURIComponent(workloadId)}/activation`,
			{
				headers: { authorization: `Bearer ${nodeToken}`, accept: 'application/json' },
				signal: AbortSignal.timeout(timeoutMs)
			}
		);
		assertEqual(activationResponse.status, 200, 'GET workload activation');
		const activation = (await activationResponse.json()) as Activation;
		assertEqual(activation.workloadId, workloadId, 'activation workload id');

		const raw = JSON.stringify(desired);
		const secretValues = [
			...desiredWorkload.secrets
				.filter((secret) => secret.delivery === 'env')
				.map((secret) => activation.env[secret.name])
				.filter((value): value is string => typeof value === 'string'),
			...Object.values(activation.files)
		];
		for (const value of secretValues) {
			assert(
				value.length < 8 || !raw.includes(value),
				'activation value leaked into desired state'
			);
		}

		if (expectSecrets) {
			const envSecret = activation.env.STRESS_ENV_SECRET;
			const fileSecret = activation.files.STRESS_FILE_SECRET;
			if (secretEnvSha) {
				assert(envSecret, 'activation has no STRESS_ENV_SECRET');
				assertEqual(sha256Hex(envSecret), secretEnvSha, 'activation env secret digest');
			}
			if (secretFileSha) {
				assert(fileSecret, 'activation has no STRESS_FILE_SECRET');
				assertEqual(sha256Hex(fileSecret), secretFileSha, 'activation file secret digest');
			}
			if (envSecret) {
				assertEqual(
					sha256Hex(envSecret),
					info.config.secrets.env.sha256 ?? '',
					'activation matches the running app (env secret)'
				);
			}
			if (fileSecret) {
				assertEqual(
					sha256Hex(fileSecret),
					info.config.secrets.file.sha256 ?? '',
					'activation matches the running app (file secret)'
				);
			}
		}

		return `${desiredWorkload.secrets.length} refs, activation v${desiredWorkload.activationVersion.slice(0, 12)}…, no values in desired state`;
	});
} else {
	skip(
		'desired state and activation',
		'set --node-token (and provision first) to verify JIT secret delivery'
	);
}

if (flags.bool('crash')) {
	await check('crash recovery', async () => {
		const before = info;
		const crash = await fetchApp('/api/crash?code=1&delay=100', { method: 'POST' });
		assertEqual(crash.status, 202, '/api/crash status');
		await crash.arrayBuffer();
		const deadline = Date.now() + Math.max(30_000, timeoutMs * 3);
		let recovered: AppInfo | null = null;
		while (Date.now() < deadline) {
			await sleep(500);
			try {
				const candidate = await getInfo();
				if (candidate.runtime.instanceId !== before.runtime.instanceId) {
					recovered = candidate;
					break;
				}
			} catch {
				// Still down; keep polling.
			}
		}
		assert(recovered, 'app did not come back after the crash');
		assert(recovered.runtime.pid > 0, 'new pid');
		const dataAfter = await appJson<{ value: number }>('/api/data?key=visits');
		assert(
			numberValue(dataAfter.body.value, 'visits after restart') >= dataValue,
			'counter went backwards across the restart'
		);
		if (api && workloadId) {
			const restarted = unwrap<WorkloadView>(
				await api.get(`/api/v1/projects/${encodeURIComponent(project)}/workload`),
				'workload'
			);
			if (requireRunning) assertEqual(restarted.status, 'running', 'workload after restart');
		}
		return `instance ${before.runtime.instanceId} → ${recovered.runtime.instanceId}, data preserved`;
	});
} else {
	skip('crash recovery', 'pass --crash to restart the workload');
}

// --- report ---------------------------------------------------------------

const failed = checks.filter((entry) => entry.status === 'fail');
const passed = checks.filter((entry) => entry.status === 'pass');
const skipped = checks.filter((entry) => entry.status === 'skip');
const report = {
	base,
	project: project || null,
	startedAt: startedAt.toISOString(),
	finishedAt: new Date().toISOString(),
	app: {
		instance: info.runtime.instanceId,
		bun: info.runtime.bun,
		uptimeSeconds: info.runtime.uptimeSeconds
	},
	checks,
	load,
	summary: {
		passed: passed.length,
		failed: failed.length,
		skipped: skipped.length
	}
};

if (flags.bool('json')) {
	console.log(JSON.stringify(report, null, 2));
} else {
	console.log('');
	console.log(`${bold('v2-stress')} ${dim(base)}`);
	console.log('');
	for (const entry of checks) {
		const icon =
			entry.status === 'pass' ? green('✓') : entry.status === 'fail' ? red('✗') : yellow('-');
		const ms = entry.status === 'skip' ? '' : dim(` ${round(entry.ms, 1)} ms`);
		console.log(`${icon} ${entry.name}${ms}`);
		if (entry.detail) console.log(`  ${dim(entry.detail)}`);
	}
	console.log('');
	if (load) {
		const sample = load as LoadResult;
		console.log(
			`${dim('load')} ${sample.requests} requests, ${round(sample.rps, 1)} req/s, ` +
				`p50 ${round(sample.p50, 1)} ms, p95 ${round(sample.p95, 1)} ms, p99 ${round(sample.p99, 1)} ms, max ${round(sample.max, 1)} ms`
		);
	}
	const verdict = failed.length === 0 ? green('PASS') : red('FAIL');
	console.log(
		`${verdict} ${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped`
	);
	if (failed.length > 0) {
		for (const entry of failed)
			console.log(`  ${red('✗')} ${entry.name}: ${entry.detail ?? 'failed'}`);
	}
}

if (failed.length > 0) process.exit(1);

function fail(message: string): never {
	console.error(`stress: ${message}`);
	process.exit(2);
}
