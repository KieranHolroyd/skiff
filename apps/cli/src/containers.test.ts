import { describe, expect, test } from 'bun:test';
import type { ApiClient } from './api.ts';
import { ApiError } from './errors.ts';
import {
	ContainerConsoleClient,
	inspectReport,
	listingTable,
	parseRemote,
	runShell,
	type ContainerInspect,
	type ShellIo,
} from './containers.ts';

const EXEC = 'cx_abcdefghijklmnopqrstuvwx';
const b64 = (text: string) => Buffer.from(text).toString('base64');

/** A scripted platform: each stream call takes the next body from `streams`. */
function fakeClient(streams: Array<string | 'drop' | 'dead' | 404>) {
	const calls: Array<{ method: string; path: string; body?: unknown; headers?: Record<string, string> }> = [];
	const client = {
		async raw(method: string, path: string, options: { body?: string | Uint8Array; headers?: Record<string, string> } = {}) {
			calls.push({ method, path, body: options.body, headers: options.headers });
			if (path.split('?')[0]!.endsWith('/exec') && method === 'POST') return Response.json({ exec: { execId: EXEC } });
			if (path.includes('/stream')) {
				const next = streams.shift();
				if (next === 404 || next === undefined)
					throw new ApiError('gone', { status: 404, method, url: path });
				if (next === 'dead')
					return new Response(
						new ReadableStream({
							pull(controller) {
								controller.error(new Error('connection reset'));
							},
						}),
					);
				if (next === 'drop')
					return new Response(
						(() => {
							let sent = false;
							return new ReadableStream({
								pull(controller) {
									if (sent) return controller.error(new Error('socket hang up'));
									sent = true;
									controller.enqueue(new TextEncoder().encode(`id: 3\nevent: data\ndata: ${b64('abc')}\n\n`));
								},
							});
						})(),
					);
				return new Response(next, { headers: { 'content-type': 'text/event-stream' } });
			}
			return Response.json({ ok: true });
		},
	} as unknown as ApiClient;
	return { client, calls };
}

function fakeIo() {
	const output: string[] = [];
	const notices: string[] = [];
	let input: ((bytes: Uint8Array) => void) | null = null;
	const io: ShellIo = {
		cols: () => 132,
		rows: () => 40,
		write: (bytes) => output.push(Buffer.from(bytes).toString()),
		onInput: (listener) => {
			input = listener;
			return () => {
				input = null;
			};
		},
		onResize: () => () => undefined,
		notice: (message) => notices.push(message),
	};
	return { io, output, notices, type: (text: string) => input?.(new TextEncoder().encode(text)) };
}

describe('runShell', () => {
	test('opens with the terminal size, prints output and returns the exit code', async () => {
		const { client, calls } = fakeClient([
			`id: 5\nevent: data\ndata: ${b64('hello')}\n\nevent: exit\ndata: {"code":3}\n\n`,
		]);
		const { io, output } = fakeIo();
		const code = await runShell(new ContainerConsoleClient(client, 'api', 1), io, { shell: 'auto', user: 'root' });
		expect(code).toBe(3);
		expect(output.join('')).toBe('hello');
		expect(JSON.parse(String(calls[0]!.body))).toEqual({ shell: 'auto', user: 'root', cols: 132, rows: 40 });
		expect(calls[0]!.path).toBe('/api/v1/projects/api/container/exec?replica=1');
		// The shell ended on its own: no hang-up.
		expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
	});

	test('resumes from the last byte offset after a dropped stream', async () => {
		const { client, calls } = fakeClient(['drop', `id: 6\nevent: data\ndata: ${b64('def')}\n\nevent: exit\ndata: {"code":0}\n\n`]);
		const { io, output, notices } = fakeIo();
		const code = await runShell(new ContainerConsoleClient(client, 'api'), io, { shell: 'auto', user: 'default', sleep: async () => undefined });
		expect(code).toBe(0);
		expect(output.join('')).toBe('abcdef');
		expect(notices[0]).toContain('reconnecting');
		const streams = calls.filter((call) => call.path.includes('/stream'));
		expect(streams[1]!.headers?.['last-event-id']).toBe('3');
	});

	test('sends keystrokes in order, batched', async () => {
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { client, calls } = fakeClient([]);
		const original = (client as unknown as { raw: (...args: unknown[]) => Promise<Response> }).raw;
		(client as unknown as { raw: unknown }).raw = async (method: string, path: string, options?: unknown) => {
			if (path.includes('/stream')) {
				await gate;
				return new Response('event: exit\ndata: {"code":0}\n\n');
			}
			return original(method, path, options);
		};
		const { io, type } = fakeIo();
		const done = runShell(new ContainerConsoleClient(client, 'api'), io, { shell: 'auto', user: 'default' });
		await Bun.sleep(5);
		type('l');
		type('s');
		type('\r');
		await Bun.sleep(30);
		release();
		await done;
		const inputs = calls.filter((call) => call.path.includes('/input'));
		expect(inputs).toHaveLength(1);
		expect(Buffer.from(inputs[0]!.body as Uint8Array).toString()).toBe('ls\r');
	});

	test('hangs up when the session is lost for good', async () => {
		const { client, calls } = fakeClient(['dead', 'dead', 'dead']);
		const { io } = fakeIo();
		const code = await runShell(new ContainerConsoleClient(client, 'api'), io, {
			shell: 'auto',
			user: 'default',
			reconnects: 2,
			sleep: async () => undefined,
		});
		expect(code).toBe(-1);
		expect(calls.at(-1)).toMatchObject({ method: 'DELETE', path: `/api/v1/projects/api/container/exec/${EXEC}` });
	});

	test('a shell the node no longer holds is an error', async () => {
		const { client } = fakeClient([404]);
		const { io } = fakeIo();
		await expect(runShell(new ContainerConsoleClient(client, 'api'), io, { shell: 'auto', user: 'default' })).rejects.toThrow('gone');
	});
});

describe('output', () => {
	test('listingTable marks kinds, links and truncation', () => {
		const table = listingTable({
			path: '/app',
			mount: '/',
			readOnly: true,
			truncated: true,
			entries: [
				{ name: 'src', kind: 'directory', sizeBytes: 0, mode: '0755', uid: 0, gid: 0, modifiedAt: '2026-11-07T10:00:00Z', linkTarget: null },
				{ name: 'lib', kind: 'symlink', sizeBytes: 7, mode: '0777', uid: 0, gid: 0, modifiedAt: '2026-11-07T10:00:00Z', linkTarget: 'usr/lib' },
			],
		});
		expect(table).toContain('d0755');
		expect(table).toContain('src/');
		expect(table).toContain('lib -> usr/lib');
		expect(table).toContain('first 2 entries');
	});

	test('parseRemote', () => {
		expect(parseRemote('my-api:/data/app.db')).toEqual({ project: 'my-api', path: '/data/app.db' });
		expect(parseRemote('./local.txt')).toBeNull();
		expect(parseRemote('my-api:relative')).toBeNull();
	});

	test('inspectReport keeps env values out and lists processes', () => {
		const container = {
			id: 'wld_x',
			name: 'skiff-workload-wld_x',
			exists: true,
			state: { status: 'running', running: true, paused: false, restarting: false, oomKilled: false, exitCode: 0, error: null, startedAt: '2026-11-07T10:00:00Z', finishedAt: null, health: null },
			unit: { activeState: 'active', subState: 'running', restarts: 1 },
			image: { name: 'ghcr.io/acme/api:1', id: 'abc', digest: 'sha256:0123456789abcdef0123' },
			config: { entrypoint: ['node'], command: ['server.js'], workingDir: '/app', user: '1000', hostname: null, envNames: ['DATABASE_URL'], labels: {} },
			security: { readOnlyRootfs: true, capAdd: [], capDrop: ['ALL'], noNewPrivileges: true },
			network: { ports: [{ container: '3000/tcp', host: '127.0.0.1:41000' }], networks: [] },
			mounts: [{ destination: '/data', type: 'bind', readOnly: false, browsable: true, note: null }],
			stats: null,
			processes: [{ pid: 1, ppid: 0, uid: 1000, state: 'S', rssBytes: 4096, cpuMicros: 2_000_000, startedAt: null, command: 'node server.js' }],
		} satisfies ContainerInspect;
		const report = inspectReport(container, { replica: null, nodeId: 'n', nodeName: 'edge', desiredId: 'wld_x' }).join('\n');
		expect(report).toContain('skiff-workload-wld_x  running');
		expect(report).toContain('Command     node server.js');
		expect(report).toContain('DATABASE_URL');
		expect(report).toContain('node server.js');
		expect(report).toContain('3000/tcp → 127.0.0.1:41000');
	});
});
