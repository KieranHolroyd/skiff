import { describe, expect, test } from 'bun:test';
import { ApiClient } from './api.ts';
import { UsageError } from './errors.ts';
import { auditTable, logDrainDetails, logDrainTable, parseHeaderFlags, parseSources, type LogDrainView } from './log-drains.ts';

const drain: LogDrainView = {
	id: 'ldr_1',
	name: 'archive',
	kind: 'webhook',
	url: 'https://logs.example.com/in?api_key=***',
	format: 'ndjson',
	projectId: null,
	project: null,
	sources: ['runtime', 'build'],
	minLevel: 'warn',
	headerNames: ['Authorization'],
	signed: true,
	allowPrivateNetwork: false,
	enabled: true,
	status: 'failing',
	delivery: {
		deliveredLines: 12,
		deliveredBatches: 2,
		droppedLines: 3,
		droppedBatches: 1,
		attempts: 2,
		nextAttemptAt: '2026-11-07T10:00:10.000Z',
		lastDeliveredAt: '2026-11-07T09:59:00.000Z',
		lastError: 'logs.example.com answered HTTP 503',
		lastErrorAt: '2026-11-07T10:00:00.000Z',
		failingSince: '2026-11-07T10:00:00.000Z',
	},
	createdAt: '2026-11-07T09:00:00.000Z',
	updatedAt: '2026-11-07T09:00:00.000Z',
};

describe('log drain flags', () => {
	test('headers accept curl and key=value forms', () => {
		expect(parseHeaderFlags(['Authorization: Bearer abc', 'X-Api-Key=k=v'])).toEqual({ Authorization: 'Bearer abc', 'X-Api-Key': 'k=v' });
		expect(() => parseHeaderFlags(['Authorization'])).toThrow(UsageError);
		expect(() => parseHeaderFlags(['Authorization:'])).toThrow(UsageError);
	});

	test('sources may repeat or be comma-separated and are checked', () => {
		expect(parseSources(['runtime,build', 'runtime'])).toEqual(['runtime', 'build']);
		expect(() => parseSources(['stdout'])).toThrow(/--source/);
	});
});

describe('log drain output', () => {
	test('table and details show status, counters and the error but no secrets', () => {
		const table = logDrainTable([drain]);
		expect(table).toContain('ldr_1');
		expect(table).toContain('webhook/ndjson');
		expect(table).toContain('12 sent, 3 dropped');
		const details = logDrainDetails(drain);
		expect(details).toContain('signed (X-Yoal-Signature)');
		expect(details).toContain('org: runtime,build ≥ warn');
		expect(details).toContain('Authorization (values hidden)');
		expect(details).toContain('attempt 3');
		expect(details).toContain('HTTP 503');
	});

	test('audit table', () => {
		const table = auditTable([
			{
				id: 'aud_1',
				actorType: 'mcp',
				actorId: 'user_1',
				clientId: 'client_9',
				action: 'mcp.create_log_drain',
				resource: 'mcp',
				resourceId: null,
				argsJson: null,
				result: 'error',
				error: 'forbidden',
				createdAt: Date.parse('2026-11-07T10:00:00Z'),
			},
		]);
		expect(table).toContain('2026-11-07 10:00:00Z');
		expect(table).toContain('mcp:client_9');
		expect(table).toContain('error: forbidden');
	});
});

describe('ApiClient log drains and audit', () => {
	test('audit passes the range and cursor and returns nextCursor', async () => {
		let url = '';
		const server = Bun.serve({
			port: 0,
			fetch: (request) => {
				url = request.url;
				return Response.json({ entries: [], nextCursor: 'abc' });
			},
		});
		try {
			const client = new ApiClient({ baseUrl: `http://127.0.0.1:${server.port}`, token: 'sk_test' });
			const page = await client.auditLog({ from: '2026-11-01', to: '2026-11-07', resource: 'log_drain', limit: 20, cursor: 'xyz' });
			expect(page.nextCursor).toBe('abc');
			const query = new URL(url).searchParams;
			expect(new URL(url).pathname).toBe('/api/v1/audit');
			expect(Object.fromEntries(query)).toEqual({ from: '2026-11-01', to: '2026-11-07', resource: 'log_drain', cursor: 'xyz', limit: '20' });
		} finally {
			server.stop(true);
		}
	});

	test('create returns the signing secret once', async () => {
		let body: unknown;
		const server = Bun.serve({
			port: 0,
			fetch: async (request) => {
				body = await request.json();
				return Response.json({ drain, signingSecret: 'whsec_x' }, { status: 201 });
			},
		});
		try {
			const client = new ApiClient({ baseUrl: `http://127.0.0.1:${server.port}`, token: 'sk_test' });
			const created = await client.createLogDrain({ name: 'archive', kind: 'webhook', url: 'https://logs.example.com/in' });
			expect(created.signingSecret).toBe('whsec_x');
			expect(created.drain.id).toBe('ldr_1');
			expect(body).toEqual({ name: 'archive', kind: 'webhook', url: 'https://logs.example.com/in' });
		} finally {
			server.stop(true);
		}
	});
});
