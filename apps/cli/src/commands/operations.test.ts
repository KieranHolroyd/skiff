import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let dir = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'yoal-cli-operations-'));
});

afterEach(async () => {
	server?.stop(true);
	server = undefined;
	await rm(dir, { recursive: true, force: true });
});

function view(status: string, overrides: Record<string, unknown> = {}) {
	return {
		id: 'op_1',
		kind: 'bulk',
		action: 'project.delete',
		status,
		scope: null,
		phase: null,
		total: 2,
		done: 1,
		failed: 0,
		summary: { verdicts: { ok: 2 }, statuses: { succeeded: 1, pending: 1 }, flags: {}, freedBytes: 0 },
		createdAt: '2026-11-04T12:00:00.000Z',
		startedAt: null,
		finishedAt: null,
		planExpiresAt: null,
		...overrides,
	};
}

function spawnCli(url: string, ...args: string[]) {
	return Bun.spawn([process.execPath, 'src/main.ts', ...args], {
		cwd: join(import.meta.dir, '../..'),
		env: {
			...process.env,
			YOAL_CONFIG_DIR: dir,
			YOAL_URL: url,
			YOAL_TOKEN: 'yoal_test',
			YOAL_CONTENT_DOMAIN: '',
			YOAL_PROFILE: '',
		},
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
	});
}

describe('yoal operations watch', () => {
	test('Ctrl-C detaches without cancelling and prints how to resume', async () => {
		let cancelled = false;
		let streamOpened: () => void = () => {};
		const opened = new Promise<void>((resolve) => (streamOpened = resolve));
		server = Bun.serve({
			port: 0,
			idleTimeout: 0,
			fetch(request) {
				const url = new URL(request.url);
				if (url.pathname.endsWith('/cancel')) cancelled = true;
				if (url.pathname.endsWith('/stream')) {
					streamOpened();
					// Never finishes: one progress event, then silence.
					const body = new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new TextEncoder().encode(`event: progress\ndata: ${JSON.stringify(view('applying'))}\n\n`));
						},
					});
					return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
				}
				return Response.json({ operation: view('applying') });
			},
		});
		const child = spawnCli(`http://127.0.0.1:${server.port}`, 'operations', 'watch', 'op_1');
		await opened;
		await Bun.sleep(150);
		child.kill('SIGINT');
		const code = await child.exited;
		const stderr = await new Response(child.stderr).text();
		expect(code).toBe(130);
		expect(stderr).toContain('Still running: yoal operations watch op_1');
		expect(cancelled).toBe(false);
	});

	test('exit code follows the final status: 3 for partial', async () => {
		server = Bun.serve({
			port: 0,
			fetch(request) {
				const url = new URL(request.url);
				if (url.pathname.endsWith('/stream'))
					return new Response(
						`event: done\ndata: ${JSON.stringify(view('partial', { done: 2, failed: 1, summary: { verdicts: {}, statuses: { succeeded: 1, failed: 1 }, flags: {}, freedBytes: 0 } }))}\n\n`,
						{ headers: { 'content-type': 'text/event-stream' } },
					);
				return Response.json({ operation: view('applying') });
			},
		});
		const child = spawnCli(`http://127.0.0.1:${server.port}`, 'operations', 'watch', 'op_1');
		const code = await child.exited;
		const stdout = await new Response(child.stdout).text();
		expect(code).toBe(3);
		expect(stdout).toContain('Partial: 1 succeeded, 1 failed.');
	});

	test('--json emits NDJSON events ending with done', async () => {
		server = Bun.serve({
			port: 0,
			fetch(request) {
				const url = new URL(request.url);
				if (url.pathname.endsWith('/stream'))
					return new Response(
						[
							`event: progress\ndata: ${JSON.stringify(view('applying'))}\n\n`,
							`id: 1\nevent: items\ndata: ${JSON.stringify({ items: [{ seq: 1, status: 'succeeded', verdict: 'ok', label: 'a', flags: [] }], cursor: 1 })}\n\n`,
							`event: done\ndata: ${JSON.stringify(view('succeeded', { done: 2 }))}\n\n`,
						].join(''),
						{ headers: { 'content-type': 'text/event-stream' } },
					);
				return Response.json({ operation: view('applying') });
			},
		});
		const child = spawnCli(`http://127.0.0.1:${server.port}`, 'operations', 'watch', 'op_1', '--json');
		const code = await child.exited;
		const lines = (await new Response(child.stdout).text())
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line) as { type: string });
		expect(code).toBe(0);
		expect(lines.map((line) => line.type)).toEqual(['progress', 'items', 'done']);
	});
});
