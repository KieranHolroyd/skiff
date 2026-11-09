import { describe, expect, test } from 'bun:test';
import { routeSpecSchema } from './agent.ts';
import {
	FUNCTION_STATEFUL_BINDING_TYPES,
	FUNCTION_STATEFUL_REPLICA_MESSAGE,
	WORKERD_PINNED_VERSION,
	functionBindingIsStateful,
	functionRuntimeSpecSchema,
	type FunctionBindingType,
} from './function.ts';
import {
	DEFAULT_WORKLOAD_NETWORK,
	orgNetworkName,
	secretRefEnvName,
	workloadDesiredSchema,
	workloadEnvIssues,
	workloadNetworkName,
	workloadSpecSchema,
	workloadsShareNetwork,
} from './workload.ts';

const base = {
	id: 'wl_1',
	projectId: 'prj_1',
	projectSlug: 'my-app',
	deploymentId: 'dep_1',
	runtime: 'process',
	status: 'running',
	release: 'a'.repeat(64),
	upstream: '127.0.0.1:3000',
	memoryMb: 256,
	cpus: 1,
	port: 3000,
	healthPath: '/',
	socketActivation: true,
	activationVersion: 'b'.repeat(64),
} as const;

describe('WorkloadDesired additive fields', () => {
	test('older desired state still parses with the defaults', () => {
		const parsed = workloadDesiredSchema.parse(base);
		expect(parsed).toMatchObject({ env: {}, secrets: [], dataSizeMb: null });
		expect(parsed.volumes).toBeUndefined();
		expect(parsed.processes).toBeUndefined();
		expect(parsed.job).toBeUndefined();
	});

	test('volumes, processes and job are optional and additive', () => {
		const parsed = workloadDesiredSchema.parse({
			...base,
			volumes: [
				{ id: 'av_1', mountPath: '/var/lib/app', readOnly: false },
				{ id: 'av_2', mountPath: '/var/lib/assets', readOnly: true },
			],
			processes: [
				{ name: 'web', command: ['bun', 'run', 'start'], port: 3000, healthPath: '/health' },
				{ name: 'worker', command: ['bun', 'run', 'worker'] },
			],
			job: { id: 'job_1', timeoutSeconds: 300 },
		});
		expect(parsed.volumes).toHaveLength(2);
		expect(parsed.volumes?.[1]).toEqual({ id: 'av_2', mountPath: '/var/lib/assets', readOnly: true });
		expect(parsed.processes?.[0]?.name).toBe('web');
		expect(parsed.job).toEqual({ id: 'job_1', timeoutSeconds: 300 });
	});

	test('unknown fields from a newer control plane are dropped, not rejected', () => {
		const parsed = workloadDesiredSchema.parse({ ...base, futureField: { enabled: true } });
		expect(parsed).not.toHaveProperty('futureField');
	});

	test('a bad mount path or job timeout is rejected', () => {
		expect(workloadDesiredSchema.safeParse({ ...base, volumes: [{ id: 'av_1', mountPath: '', readOnly: false }] }).success).toBe(
			false,
		);
		expect(workloadDesiredSchema.safeParse({ ...base, job: { id: 'job_1', timeoutSeconds: 1 } }).success).toBe(false);
	});
});

describe('per-org network derivation', () => {
	test('derives a stable org network and keeps the shared fallback', () => {
		expect(orgNetworkName('org_123')).toBe('yoal-org-org_123');
		expect(orgNetworkName('Org ABC')).toBe('yoal-org-org-abc');
		expect(workloadNetworkName({})).toBe(DEFAULT_WORKLOAD_NETWORK);
	});

	test('two orgs are isolated and same-org workloads share a network', () => {
		const a = { orgId: 'org_1' };
		const b = { orgId: 'org_2' };
		expect(workloadNetworkName(a)).not.toBe(workloadNetworkName(b));
		expect(workloadsShareNetwork(a, { orgId: 'org_1' })).toBe(true);
		expect(workloadsShareNetwork(a, b)).toBe(false);
		// Explicit names win, which is what the node protocol sends.
		expect(workloadNetworkName({ orgId: 'org_1', networkName: 'yoal-org-org_1' })).toBe('yoal-org-org_1');
	});

	test('desired state accepts the new fields and old state stays valid', () => {
		expect(workloadDesiredSchema.parse({ ...base, orgId: 'org_1' }).orgId).toBe('org_1');
		expect(workloadDesiredSchema.parse(base).orgId).toBeUndefined();
	});
});

describe('workloadEnvIssues', () => {
	test('accepts distinct plain variables and secret references', () => {
		expect(
			workloadEnvIssues({
				env: { PORT: '3000', TLS_KEY: 'not-a-clash' },
				secrets: [
					{ name: 'API_KEY', delivery: 'env' },
					{ name: 'TLS_KEY', delivery: 'file' }
				]
			})
		).toEqual([]);
		expect(secretRefEnvName({ name: 'TLS_KEY', delivery: 'file' })).toBe('TLS_KEY_FILE');
	});

	test('flags names that would be set twice', () => {
		expect(
			workloadEnvIssues({
				env: { API_KEY: 'plain', TLS_KEY_FILE: '/tmp/key' },
				secrets: [
					{ name: 'API_KEY', delivery: 'env' },
					{ name: 'API_KEY', delivery: 'env' },
					{ name: 'TLS_KEY', delivery: 'file' }
				]
			})
		).toEqual([
			'API_KEY is set both as a plain variable and by secret API_KEY. Keep one.',
			'Secret API_KEY is referenced more than once.',
			'TLS_KEY_FILE is set both as a plain variable and by secret TLS_KEY. Keep one.'
		]);
	});
});


/** A minimal resolved function spec, valid for the workload contract. */
const resolvedFunction = functionRuntimeSpecSchema.parse({
	main: 'index.js',
	modules: [{ name: 'index.js', type: 'esm', sha256: 'a'.repeat(64) }],
	compatibilityDate: '2026-10-01',
	compatibilityFlags: [],
	bindings: [],
	triggers: { crons: [] },
	assets: null,
	idleStopSeconds: 300,
	workerdVersion: WORKERD_PINNED_VERSION,
});

const functionSpec = (bindings: unknown[] = []) =>
	functionRuntimeSpecSchema.parse({ ...resolvedFunction, bindings });

describe('function replicas (phase 4)', () => {
	const parse = (overrides: Record<string, unknown> = {}) =>
		workloadSpecSchema.safeParse({ runtime: 'function', function: functionSpec(), ...overrides });

	test('a stateless function may run more than one host', () => {
		const parsed = parse({ replicas: 3 });
		expect(parsed.success).toBe(true);
		expect(parsed.success && parsed.data.replicas).toBe(3);
		// No worker-only rejection: functions are the phase-4 exception to one copy per HTTP site.
		expect(parsed.success && parsed.data.ingress).toBe('http');
	});

	test('any stateful binding keeps the function at one host, with the phase-4 message', () => {
		const bindings: Record<string, unknown> = {
			durable_object: { name: 'ROOM', type: 'durable_object', className: 'Room', uniqueKey: 'prj_room' },
			kv: { name: 'KV', type: 'kv', namespaceId: 'prj_ns' },
			cache: { name: 'CACHE', type: 'cache' },
		};
		for (const [type, binding] of Object.entries(bindings)) {
			const parsed = parse({ function: functionSpec([binding]), replicas: 2 });
			expect(parsed.success, type).toBe(false);
			const messages = parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
			expect(messages).toContain(FUNCTION_STATEFUL_REPLICA_MESSAGE);
			// The generic worker message would mislead: stateless functions are allowed to scale.
			expect(messages).not.toContain('Only workers (ingress "none") can run more than one replica.');
		}
		// One host is still fine for a stateful function.
		expect(parse({ function: functionSpec([bindings.kv]) }).success).toBe(true);
	});

	test('the shared helper classifies every binding type', () => {
		const stateless: FunctionBindingType[] = [
			'text',
			'json',
			'secret',
			'service',
			'app',
			'hyperdrive',
			'r2',
			'analytics_engine',
			'assets',
			// D112: queue messages live in the managed broker, not on the host.
			'queue',
		];
		for (const type of stateless) expect(functionBindingIsStateful(type), type).toBe(false);
		expect([...FUNCTION_STATEFUL_BINDING_TYPES]).toEqual(['durable_object', 'kv', 'cache', 'd1']);
		for (const type of FUNCTION_STATEFUL_BINDING_TYPES) expect(functionBindingIsStateful(type), type).toBe(true);
	});

	test('non-function replicas are allowed for stateless HTTP workloads', () => {
		const process = workloadSpecSchema.safeParse({ runtime: 'process', command: ['bun', 'run', 'start'], replicas: 2 });
		expect(process.success).toBe(true);
		expect(
			workloadSpecSchema.safeParse({
				runtime: 'process',
				command: ['bun', 'run', 'start'],
				replicas: 2,
				ingress: 'none',
			}).success,
		).toBe(true);
		expect(workloadSpecSchema.safeParse({ runtime: 'container', image: 'x', replicas: 2 }).success).toBe(true);
		expect(
			workloadSpecSchema.safeParse({ runtime: 'container', image: 'x', replicas: 2, ingress: 'none' }).success,
		).toBe(true);
	});
});

describe('function route replica sockets', () => {
	const base = {
		projectId: 'prj_1',
		slug: 'app',
		host: 'app.example.com',
		deploymentId: 'dep_1',
		release: 'a'.repeat(64),
		access: {
			mode: 'public' as const,
			siteKey: 'site-key-0123456789',
			loginUrl: 'https://control.test/_yoal/site-login',
		},
		accessMode: 'public' as const,
		spa: false,
		cleanUrls: false,
		trailingSlash: 'ignore' as const,
		notFound: null,
	};

	test('a scaled function route carries its replica sockets in order', () => {
		const parsed = routeSpecSchema.parse({
			...base,
			upstream: 'unix//run/yoal-workloads/wld_1.sock',
			function: {
				assetsDirectory: 'public',
				runWorkerFirst: [],
				upstreams: [
					'unix//run/yoal-workloads/wld_1.sock',
					'unix//run/yoal-workloads/wld_1-r1.sock',
					'unix//run/yoal-workloads/wld_1-r2.sock',
				],
			},
		});
		expect(parsed.function?.upstreams).toEqual([
			'unix//run/yoal-workloads/wld_1.sock',
			'unix//run/yoal-workloads/wld_1-r1.sock',
			'unix//run/yoal-workloads/wld_1-r2.sock',
		]);
		// The primary target stays for older agents and for the edge, which has no function block.
		expect(parsed.upstream).toBe('unix//run/yoal-workloads/wld_1.sock');
	});

	test('older desired state without upstreams still parses', () => {
		const parsed = routeSpecSchema.parse({ ...base, function: { assetsDirectory: null, runWorkerFirst: [] } });
		expect(parsed.function?.upstreams).toBeUndefined();
		const edge = routeSpecSchema.parse({ ...base, upstream: 'http://10.0.0.5:8080' });
		expect(edge.function).toBeUndefined();
	});
});
