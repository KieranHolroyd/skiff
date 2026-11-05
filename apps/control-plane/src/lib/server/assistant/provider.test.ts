import { afterAll, describe, expect, test } from 'bun:test';
import { streamChat } from './provider';
import { testProvider, type AssistantRuntimeConfig } from './config';

const config: AssistantRuntimeConfig = {
	provider: 'openai-compatible',
	baseUrl: '',
	model: 'test-model',
	routerModel: 'test-router',
	maxAgents: 2
};

function sse(events: string[]): Response {
	const body = events.map((event) => `data: ${event}\n\n`).join('') + 'data: [DONE]\n\n';
	return new Response(body, {
		headers: { 'content-type': 'text/event-stream' }
	});
}

const server = Bun.serve({
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === '/v1/models') {
			return Response.json({ data: [{ id: 'test-model' }, { id: 'test-router' }] });
		}
		if (url.pathname === '/v1/chat/completions') {
			const body = (await request.json()) as { tools?: unknown[] };
			if (body.tools && body.tools.length > 0) {
				return sse([
					JSON.stringify({
						choices: [
							{
								delta: {
									tool_calls: [
										{
											index: 0,
											id: 'call_1',
											function: { name: 'list_projects', arguments: '{"limit":' }
										}
									]
								}
							}
						]
					}),
					JSON.stringify({
						choices: [
							{
								delta: {
									tool_calls: [{ index: 0, function: { arguments: '5}' } }]
								}
							}
						]
					}),
					JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })
				]);
			}
			return sse([
				JSON.stringify({ choices: [{ delta: { content: 'Hello ' } }] }),
				JSON.stringify({ choices: [{ delta: { content: 'there.' } }] }),
				JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })
			]);
		}
		return new Response('not found', { status: 404 });
	}
});

const baseUrl = `http://127.0.0.1:${server.port}/v1`;

afterAll(() => server.stop(true));

describe('OpenAI-compatible provider', () => {
	test('streams text deltas and returns the whole answer', async () => {
		const deltas: string[] = [];
		const result = await streamChat(
			{ ...config, baseUrl },
			{ messages: [{ role: 'user', content: 'hi' }], onText: (delta) => deltas.push(delta) }
		);
		expect(deltas).toEqual(['Hello ', 'there.']);
		expect(result.text).toBe('Hello there.');
		expect(result.toolCalls).toEqual([]);
	});

	test('accumulates streamed tool-call arguments', async () => {
		const result = await streamChat(
			{ ...config, baseUrl },
			{
				messages: [{ role: 'user', content: 'list' }],
				tools: [
					{
						type: 'function',
						function: { name: 'list_projects', description: 'List', parameters: { type: 'object' } }
					}
				]
			}
		);
		expect(result.toolCalls).toHaveLength(1);
		expect(result.toolCalls[0]).toMatchObject({
			id: 'call_1',
			name: 'list_projects',
			arguments: '{"limit":5}'
		});
	});

	test('lists models for the setup check', async () => {
		const result = await testProvider({ baseUrl });
		expect(result).toEqual({ ok: true, models: ['test-model', 'test-router'] });
	});

	test('falls back to a tiny completion when /models is absent', async () => {
		const noModels = Bun.serve({
			port: 0,
			fetch(request) {
				const url = new URL(request.url);
				if (url.pathname === '/v1/models') return new Response('not found', { status: 404 });
				if (url.pathname === '/v1/chat/completions') return Response.json({ choices: [] });
				return new Response('not found', { status: 404 });
			}
		});
		try {
			const result = await testProvider({
				baseUrl: `http://127.0.0.1:${noModels.port}/v1`,
				model: 'test-model'
			});
			expect(result).toEqual({ ok: true, models: [] });
		} finally {
			noModels.stop(true);
		}
	});

	test('reports a provider error with the status', async () => {
		const bad = Bun.serve({
			port: 0,
			fetch: () => new Response('nope', { status: 401 })
		});
		try {
			await expect(
				streamChat(
					{ ...config, baseUrl: `http://127.0.0.1:${bad.port}/v1` },
					{ messages: [{ role: 'user', content: 'hi' }] }
				)
			).rejects.toThrow('401');
		} finally {
			bad.stop(true);
		}
	});
});
