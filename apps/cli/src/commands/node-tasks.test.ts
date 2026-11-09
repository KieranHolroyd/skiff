import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** `yoal broker` queue tools and `yoal function` against a fake control plane (D124). */

let dir = '';
let server: ReturnType<typeof Bun.serve> | undefined;

interface Seen {
	method: string;
	path: string;
	body: unknown;
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'yoal-cli-node-tasks-'));
});

afterEach(async () => {
	server?.stop(true);
	server = undefined;
	await rm(dir, { recursive: true, force: true });
});

function task(kind: string, result: unknown, overrides: Record<string, unknown> = {}) {
	return {
		task: {
			id: 'nt_1',
			kind,
			status: 'succeeded',
			target: { type: kind.startsWith('broker.') ? 'broker' : 'workload', name: 'x', nodeId: 'node_1' },
			input: {},
			result,
			error: null,
			createdAt: '2026-11-07T10:00:00.000Z',
			startedAt: null,
			finishedAt: null,
			...overrides,
		},
	};
}

/** `routes` maps `METHOD /path` (without `?wait=`) to a JSON body or a Response. */
function serve(routes: Record<string, unknown>): Seen[] {
	const seen: Seen[] = [];
	server = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			url.searchParams.delete('wait');
			const path = `${url.pathname}${url.search}`;
			const text = await request.text();
			seen.push({ method: request.method, path, body: text ? JSON.parse(text) : undefined });
			const route = routes[`${request.method} ${path}`] ?? routes[`${request.method} ${url.pathname}`];
			if (route === undefined) return Response.json({ error: 'not_found', message: 'no route' }, { status: 404 });
			return route instanceof Response ? route : Response.json(route);
		},
	});
	return seen;
}

async function cli(...args: string[]) {
	const child = Bun.spawn([process.execPath, 'src/main.ts', ...args], {
		cwd: join(import.meta.dir, '../..'),
		env: {
			...process.env,
			YOAL_CONFIG_DIR: dir,
			YOAL_URL: `http://127.0.0.1:${server!.port}`,
			YOAL_TOKEN: 'yoal_test',
			YOAL_CONTENT_DOMAIN: '',
			YOAL_PROFILE: '',
		},
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const code = await child.exited;
	return { code, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() };
}

const sent = (seqs: number[]) => task('broker.queue.send', { stream: 'YOAL_Q_jobs', sent: seqs.length, seqs, durationMs: 4, state: null });

describe('yoal broker queue tools', () => {
	test('send posts the body, content type, delay and count, and prints the sequences', async () => {
		const seen = serve({ 'POST /api/v1/brokers/mq/queues/jobs/messages': sent([1, 2, 3]) });
		const result = await cli('queue', 'send', 'mq', 'jobs', '{"a":1}', '--count', '3', '--delay', '5m');
		expect(result.code).toBe(0);
		expect(seen[0]?.body).toEqual({ body: '{"a":1}', contentType: 'json', delaySeconds: 300, count: 3 });
		expect(result.stdout).toContain('Sent 3 messages to queue jobs (seq 1–3) in 4 ms.');
		expect(result.stdout).toContain('Consumers see them after 300s.');
	});

	test('send checks JSON before asking, takes --text and --file, and needs a body', async () => {
		const seen = serve({ 'POST /api/v1/brokers/mq/queues/jobs/messages': sent([9]) });
		const bad = await cli('broker', 'send', 'mq', 'jobs', 'hello');
		expect(bad.code).toBe(1);
		expect(bad.stderr).toContain('--text');
		expect(seen).toHaveLength(0);

		const text = await cli('broker', 'send', 'mq', 'jobs', '--body', 'hello', '--text');
		expect(text.code).toBe(0);
		expect(seen[0]?.body).toEqual({ body: 'hello', contentType: 'text' });

		const file = join(dir, 'msg.json');
		await writeFile(file, '{"from":"file"}\n');
		await cli('broker', 'send', 'mq', 'jobs', '--file', file);
		expect(seen[1]?.body).toEqual({ body: '{"from":"file"}', contentType: 'json' });

		const none = await cli('broker', 'send', 'mq', 'jobs');
		expect(none.code).toBe(1);
		expect(none.stderr).toContain('Give a message body');
		const twice = await cli('broker', 'send', 'mq', 'jobs', '{}', '--body', '{}');
		expect(twice.code).toBe(1);
		expect(twice.stderr).toContain('Give the body once');
		expect(seen).toHaveLength(2);
	});

	test('peek maps the queue to its stream, passes --limit/--from and prints the messages', async () => {
		const seen = serve({
			'GET /api/v1/brokers/mq/streams/YOAL_Q_jobs/messages?limit=1&from=3': task('broker.stream.peek', {
				stream: 'YOAL_Q_jobs',
				messages: [
					{ seq: 3, subject: 'yoal.q.jobs', time: '2026-11-07T10:00:00.000Z', size: 9, headers: { 'Yoal-Content-Type': 'json' }, encoding: 'utf8', body: '{"a":[1]}', truncated: false },
				],
				total: 2,
				firstSeq: 3,
				lastSeq: 4,
				nextSeq: 4,
			}),
		});
		const result = await cli('broker', 'peek', 'mq', 'jobs', '--limit', '1', '--from', '3');
		expect(result.code).toBe(0);
		expect(seen[0]?.method).toBe('GET');
		expect(result.stdout).toContain('jobs (YOAL_Q_jobs): 2 messages held, seq 3–4. Showing 1.');
		expect(result.stdout).toContain('#3  2026-11-07 10:00:00Z  9 B');
		expect(result.stdout).toContain('      1');
		expect(result.stdout).toContain('More: yoal broker peek mq jobs --limit 1 --from 4');
	});

	test('peek --stream reads a raw stream and --json prints the task', async () => {
		const body = task('broker.stream.peek', { stream: 'EVENTS', messages: [], total: 0, firstSeq: 0, lastSeq: 0, nextSeq: null });
		serve({ 'GET /api/v1/brokers/mq/streams/EVENTS/messages': body });
		const result = await cli('broker', 'peek', 'mq', '--stream', 'EVENTS', '--json');
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual(body);
		const both = await cli('broker', 'peek', 'mq', 'jobs', '--stream', 'EVENTS');
		expect(both.code).toBe(1);
	});

	test('queue-purge, queue-rm and message-rm refuse without a terminal or --yes', async () => {
		const seen = serve({});
		for (const args of [['queue-purge', 'mq', 'jobs'], ['queue-rm', 'mq', 'jobs'], ['message-rm', 'mq', 'jobs', '5']]) {
			const result = await cli('broker', ...args);
			expect(result.code).toBe(1);
			expect(result.stderr).toContain('Not confirmed');
		}
		expect(seen).toHaveLength(0);
	});

	test('queue-purge, queue-rm and message-rm with --yes call their endpoints', async () => {
		const seen = serve({
			'POST /api/v1/brokers/mq/streams/YOAL_Q_jobs/purge': task('broker.stream.purge', { stream: 'YOAL_Q_jobs', purged: 12, state: null }),
			'DELETE /api/v1/brokers/mq/streams/EVENTS': task('broker.stream.delete', { stream: 'EVENTS', deleted: true }),
			'DELETE /api/v1/brokers/mq/streams/YOAL_Q_jobs/messages/5': task('broker.stream.deleteMessage', {
				stream: 'YOAL_Q_jobs',
				seq: 5,
				deleted: true,
				state: { stream: 'YOAL_Q_jobs', messages: 11, bytes: 100, firstAt: null, lastAt: null },
			}),
			'DELETE /api/v1/brokers/mq/streams/EVENTS/messages/7': task('broker.stream.deleteMessage', { stream: 'EVENTS', seq: 7, deleted: false, state: null }),
		});
		const purge = await cli('broker', 'queue-purge', 'mq', 'jobs', '-y');
		expect(purge.stdout).toContain('Purged 12 messages from YOAL_Q_jobs.');
		const rmStream = await cli('broker', 'queue-rm', 'mq', '--stream', 'EVENTS', '--yes');
		expect(rmStream.stdout).toContain('Deleted EVENTS from "mq".');
		const rmMessage = await cli('broker', 'message-rm', 'mq', 'jobs', '5', '--yes');
		expect(rmMessage.stdout).toContain('Deleted message #5 from YOAL_Q_jobs. YOAL_Q_jobs now holds 11 messages');
		const missing = await cli('broker', 'message-rm', 'mq', '7', '--stream', 'EVENTS', '--yes');
		expect(missing.code).toBe(0);
		expect(missing.stdout).toContain('Message #7 is not in EVENTS');
		expect(seen.map((item) => `${item.method} ${item.path}`)).toEqual([
			'POST /api/v1/brokers/mq/streams/YOAL_Q_jobs/purge',
			'DELETE /api/v1/brokers/mq/streams/EVENTS',
			'DELETE /api/v1/brokers/mq/streams/YOAL_Q_jobs/messages/5',
			'DELETE /api/v1/brokers/mq/streams/EVENTS/messages/7',
		]);
	});

	test('redrive needs --to and posts it with the limit', async () => {
		const seen = serve({
			'POST /api/v1/brokers/mq/queues/jobs-dlq/redrive': task('broker.queue.redrive', { moved: 10, remaining: 5, state: null, source: null }),
		});
		const missing = await cli('broker', 'redrive', 'mq', 'jobs-dlq');
		expect(missing.code).toBe(1);
		expect(missing.stderr).toContain('--to <queue>');
		const result = await cli('broker', 'redrive', 'mq', 'jobs-dlq', '--to', 'jobs', '--limit', '10');
		expect(result.code).toBe(0);
		expect(seen[0]?.body).toEqual({ to: 'jobs', limit: 10 });
		expect(result.stdout).toContain('Moved 10 messages from jobs-dlq to jobs.');
		expect(result.stdout).toContain('5 messages still in jobs-dlq.');
	});

	test('queue-create reports whether the stream was new', async () => {
		const seen = serve({ 'POST /api/v1/brokers/mq/queues': task('broker.queue.create', { stream: 'YOAL_Q_jobs', created: true, state: null }) });
		const result = await cli('broker', 'queue-create', 'mq', 'jobs');
		expect(result.code).toBe(0);
		expect(seen[0]?.body).toEqual({ queue: 'jobs' });
		expect(result.stdout).toContain('Created YOAL_Q_jobs on "mq".');
	});

	test('a node failure prints the node message and exits 1', async () => {
		serve({
			'POST /api/v1/brokers/mq/streams/YOAL_Q_jobs/purge': new Response(
				JSON.stringify({ error: 'node_task_failed', message: 'stream not found', task: task('broker.stream.purge', null, { status: 'failed' }).task }),
				{ status: 502, headers: { 'content-type': 'application/json' } },
			),
		});
		const result = await cli('broker', 'queue-purge', 'mq', 'jobs', '--yes');
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('yoal: stream not found');
	});
});

describe('yoal function', () => {
	const invoked = (overrides: Record<string, unknown> = {}) =>
		task('function.invoke', {
			status: 200,
			statusText: 'OK',
			headers: [['content-type', 'application/json']],
			encoding: 'utf8',
			body: '{"id":1}',
			size: 8,
			truncated: false,
			durationMs: 15,
			coldStart: true,
			...overrides,
		});

	test('invoke sends method, path, headers and body; prints the body and a summary on stderr', async () => {
		const seen = serve({ 'POST /api/v1/projects/api/function/invoke': invoked() });
		const result = await cli('fn', 'invoke', 'api', 'users', '-H', 'content-type: application/json', '-H', 'X-A: 1', '-d', '{"name":"Ada"}');
		expect(result.code).toBe(0);
		expect(seen[0]?.body).toEqual({
			method: 'POST',
			path: '/users',
			headers: { 'content-type': 'application/json', 'X-A': '1' },
			body: '{"name":"Ada"}',
		});
		expect(result.stdout).toBe('{"id":1}');
		expect(result.stderr).toBe('200 OK · 15 ms · cold start · 8 B\n');
	});

	test('invoke -i prints the head; a non-2xx exits 1', async () => {
		const seen = serve({ 'POST /api/v1/projects/api/function/invoke': invoked({ status: 404, statusText: 'Not Found', body: 'nope', coldStart: false }) });
		const result = await cli('function', 'invoke', 'api', '-i', '-X', 'delete');
		expect(result.code).toBe(1);
		expect(seen[0]?.body).toEqual({ method: 'DELETE', path: '/' });
		expect(result.stdout).toBe('HTTP 404 Not Found\ncontent-type: application/json\n\nnope');
		expect(result.stderr).toContain('404 Not Found · 15 ms');
	});

	test('invoke refuses a body on GET before asking', async () => {
		const seen = serve({});
		const result = await cli('function', 'invoke', 'api', '-X', 'GET', '-d', 'x');
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('GET requests have no body');
		expect(seen).toHaveLength(0);
	});

	test('cron runs the handler and exits 1 when it fails', async () => {
		const seen = serve({
			'POST /api/v1/projects/api/function/scheduled': task('function.scheduled', { status: 500, error: 'boom', durationMs: 3, coldStart: false }),
		});
		const result = await cli('fn', 'cron', 'api', '*/5 * * * *');
		expect(result.code).toBe(1);
		expect(seen[0]?.body).toEqual({ cron: '*/5 * * * *' });
		expect(result.stderr).toContain('scheduled() for "*/5 * * * *" failed (status 500, 3 ms): boom');
		const unquoted = await cli('fn', 'cron', 'api', '*/5', '*');
		expect(unquoted.code).toBe(1);
		expect(unquoted.stderr).toContain('Quote the cron expression');
	});

	test('cron success prints one line', async () => {
		serve({ 'POST /api/v1/projects/api/function/scheduled': task('function.scheduled', { status: 200, error: null, durationMs: 6, coldStart: true }) });
		const result = await cli('functions', 'cron', 'api', '0 * * * *');
		expect(result.code).toBe(0);
		expect(result.stdout).toBe('Ran scheduled() for "0 * * * *": status 200 in 6 ms, cold start.\n');
	});
});
