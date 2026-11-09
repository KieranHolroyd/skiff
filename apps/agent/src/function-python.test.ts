import { describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workloadDesiredSchema, type WorkloadDesired } from '@yoal/contracts';
import { renderWorkerdConfigParts } from './function-config.ts';
import { renderPythonFunctionShim } from './function-shim-python.ts';

/**
 * Python Workers (D121). The rendered layout was run end to end on workerd 1.20261106.1: health,
 * public fetch, cron and a queue batch with per-message verdicts all pass through the shim.
 */
const SHA = 'a'.repeat(64);

function pythonWorkload(): WorkloadDesired {
	return workloadDesiredSchema.parse({
		id: 'wld_py',
		projectId: 'prj_py',
		projectSlug: 'py',
		deploymentId: 'dep_py',
		runtime: 'function',
		status: 'running',
		release: SHA,
		upstream: 'unix//run/yoal-workloads/wld_py.sock',
		memoryMb: 384,
		cpus: 1,
		port: 3000,
		healthPath: '/__yoal/health',
		socketActivation: true,
		activationVersion: 'b'.repeat(64),
		dataSizeMb: null,
		function: {
			main: 'entry.py',
			// Manifest order is by name; the entry is not first, and the renderer must put it first.
			modules: [
				{ name: 'a_helpers.py', type: 'python', sha256: SHA },
				{ name: 'entry.py', type: 'python', sha256: SHA },
				{ name: 'python_modules/workers/workflows.js', type: 'data', sha256: SHA },
			],
			compatibilityDate: '2026-10-01',
			compatibilityFlags: ['python_workers'],
			bindings: [{ name: 'GREETING', type: 'text', value: 'hi' }],
			triggers: { crons: [], queues: [] },
			assets: null,
			idleStopSeconds: 300,
			workerdVersion: '1.20261106.1',
		},
	});
}

describe('Python function config', () => {
	const config = renderWorkerdConfigParts({ workload: pythonWorkload(), releaseDir: '/r', env: {} }).config;

	test('the user Worker is `main`, entry module first, embeds keep manifest indexes, no shim inside', () => {
		const main = config.slice(config.indexOf('( name = "main",'), config.indexOf('( name = "yoal-shim",'));
		const modules = [...main.matchAll(/\( name = "([^"]+)", (\w+) = embed "([^"]+)" \)/g)].map((match) => match.slice(1));
		expect(modules).toEqual([
			['entry.py', 'pythonModule', 'module-1'],
			['a_helpers.py', 'pythonModule', 'module-0'],
			['python_modules/workers/workflows.js', 'data', 'module-2'],
		]);
		expect(main).toContain('compatibilityFlags = [ "python_workers" ]');
		expect(main).not.toContain('function-shim');
	});

	test('the socket serves the shim Worker, bound to the user Worker with the extra-handlers flag', () => {
		expect(config).toContain('sockets = [ ( name = "http", http = (), service = "yoal-shim" ) ]');
		const shim = config.slice(config.indexOf('( name = "yoal-shim",'));
		expect(shim).toContain('esModule = embed "function-shim"');
		expect(shim).toContain('compatibilityFlags = [ "service_binding_extra_handlers" ]');
		expect(shim).toContain('bindings = [ ( name = "USER", service = "main" ) ]');
	});
});

describe('Python function shim', () => {
	let shimModule: Promise<{ default: { fetch(request: Request, env: unknown): Promise<Response> } }> | null = null;
	async function load(user: Record<string, unknown>) {
		// Write the generated module to disk once and import it, as the JavaScript shim tests do.
		shimModule ??= (async () => {
			const dir = await mkdtemp(join(tmpdir(), 'yoal-py-shim-'));
			const path = join(dir, 'shim.mjs');
			await writeFile(path, renderPythonFunctionShim());
			return import(path);
		})();
		const module = await shimModule;
		return (request: Request) => module.default.fetch(request, { USER: user });
	}
	const internal = { 'x-yoal-internal': '1' };

	test('health answers without waking the user Worker; public requests are forwarded', async () => {
		const seen: string[] = [];
		const fetch = await load({
			fetch: async (request: Request) => {
				seen.push(new URL(request.url).pathname);
				return new Response('from python');
			},
		});
		expect(await (await fetch(new Request('http://x/__yoal/health'))).json()).toEqual({ ok: true });
		expect(await (await fetch(new Request('http://x/hello'))).text()).toBe('from python');
		expect((await fetch(new Request('http://x/__yoal/scheduled', { method: 'POST' }))).status).toBe(404);
		expect(seen).toEqual(['/hello']);
	});

	test('cron becomes a scheduled event; a failed outcome is a 500', async () => {
		const calls: unknown[] = [];
		let outcome = 'ok';
		const fetch = await load({
			scheduled: async (options: unknown) => {
				calls.push(options);
				return { outcome, noRetry: false };
			},
		});
		const request = () =>
			new Request('http://x/__yoal/scheduled', {
				method: 'POST',
				headers: { ...internal, 'x-yoal-cron': '0 * * * *', 'x-yoal-scheduled-time': '1794027000000' },
			});
		expect((await fetch(request())).status).toBe(204);
		expect(calls).toEqual([{ cron: '0 * * * *', scheduledTime: new Date(1794027000000) }]);
		outcome = 'exception';
		expect((await fetch(request())).status).toBe(500);
	});

	test('queue results become per-message verdicts with the JS shim precedence', async () => {
		let result: Record<string, unknown> = {};
		const delivered: unknown[] = [];
		const fetch = await load({
			queue: async (name: string, messages: unknown[]) => {
				delivered.push({ name, ids: (messages as Array<{ id: string }>).map((message) => message.id) });
				return result;
			},
		});
		const send = async () =>
			(await (
				await fetch(
					new Request('http://x/__yoal/queue', {
						method: 'POST',
						headers: { ...internal, 'x-yoal-queue': 'jobs' },
						body: JSON.stringify([
							{ id: 'm1', timestamp: 1, body: { n: 1 }, attempts: 1 },
							{ id: 'm2', timestamp: 1, body: { n: 2 }, attempts: 2 },
							{ id: 'm3', timestamp: 1, body: { n: 3 }, attempts: 1 },
						]),
					}),
				)
			).json()) as { results: unknown[]; error?: string };

		// Explicit ack and retry win; the rest follow the handler (returned → ack).
		result = { outcome: 'ok', ackAll: false, retryBatch: { retry: false }, explicitAcks: ['m1'], retryMessages: [{ msgId: 'm2', delaySeconds: 30 }] };
		expect((await send()).results).toEqual([
			{ id: 'm1', outcome: 'ack' },
			{ id: 'm2', outcome: 'retry', delaySeconds: 30 },
			{ id: 'm3', outcome: 'ack' },
		]);

		// retryAll() retries everything not decided explicitly.
		result = { outcome: 'ok', ackAll: false, retryBatch: { retry: true }, explicitAcks: ['m3'], retryMessages: [] };
		expect((await send()).results).toEqual([
			{ id: 'm1', outcome: 'retry' },
			{ id: 'm2', outcome: 'retry' },
			{ id: 'm3', outcome: 'ack' },
		]);

		// A handler that threw retries the batch and reports the failure.
		result = { outcome: 'exception', ackAll: false, retryBatch: { retry: false }, explicitAcks: [], retryMessages: [] };
		const failed = await send();
		expect(failed.results).toEqual([
			{ id: 'm1', outcome: 'retry' },
			{ id: 'm2', outcome: 'retry' },
			{ id: 'm3', outcome: 'retry' },
		]);
		expect(failed.error).toContain('exception');
		expect(delivered[0]).toEqual({ name: 'jobs', ids: ['m1', 'm2', 'm3'] });
	});
});
