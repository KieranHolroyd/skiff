import { describe, expect, test } from 'bun:test';
import { SseParser, readSse } from './sse.ts';

describe('SseParser', () => {
	test('parses event, data and id fields and dispatches on a blank line', () => {
		const parser = new SseParser();
		expect(parser.push('id: 3\nevent: items\ndata: {"a":1}\n\n')).toEqual([
			{ event: 'items', data: '{"a":1}', id: '3' },
		]);
	});

	test('defaults the event name to message and leaves id unset without an id line', () => {
		const parser = new SseParser();
		expect(parser.push('data: hi\n\n')).toEqual([{ event: 'message', data: 'hi' }]);
	});

	test('joins multi-line data with newlines and strips only one leading space', () => {
		const parser = new SseParser();
		expect(parser.push('data:  two spaces\ndata:none\n\n')).toEqual([{ event: 'message', data: ' two spaces\nnone' }]);
	});

	test('ignores comments (heartbeats) and blocks without data, and records retry', () => {
		const parser = new SseParser();
		expect(parser.push('retry: 2000\n\n: ping\n\nevent: progress\n\n')).toEqual([]);
		expect(parser.retryMs).toBe(2000);
	});

	test('handles events split across chunks at any byte, and CRLF / CR line endings', () => {
		const text = 'event: progress\r\ndata: {"x":1}\r\n\r\nevent: done\rdata: {}\r\r';
		const parser = new SseParser();
		const events = [];
		for (const char of text) events.push(...parser.push(char));
		events.push(...parser.end());
		expect(events).toEqual([
			{ event: 'progress', data: '{"x":1}' },
			{ event: 'done', data: '{}' },
		]);
	});

	test('a field resets between events', () => {
		const parser = new SseParser();
		const events = parser.push('id: 1\nevent: items\ndata: a\n\ndata: b\n\n');
		expect(events[1]).toEqual({ event: 'message', data: 'b' });
	});

	test('end() drops a trailing block that never got its blank line', () => {
		const parser = new SseParser();
		expect(parser.push('event: done\ndata: {}')).toEqual([]);
		expect(parser.end()).toEqual([]);
	});
});

describe('readSse', () => {
	test('decodes a byte stream, including multi-byte characters split across chunks', async () => {
		const bytes = new TextEncoder().encode('event: items\ndata: {"label":"café"}\nid: 7\n\n: ping\n\n');
		const chunks = [bytes.slice(0, 30), bytes.slice(30, 31), bytes.slice(31)];
		let seenChunks = 0;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(chunk);
				controller.close();
			},
		});
		const events = [];
		for await (const event of readSse(body, { onChunk: () => seenChunks++ })) events.push(event);
		expect(events).toEqual([{ event: 'items', data: '{"label":"café"}', id: '7' }]);
		expect(seenChunks).toBe(3);
	});
});
