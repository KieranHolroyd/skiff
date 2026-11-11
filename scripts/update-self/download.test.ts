import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeResponseBody } from './download.ts';

const root = mkdtempSync(join(tmpdir(), 'yoal-download-'));

/** A response whose body is a stream, like every `fetch` body a real download returns. */
function streamedResponse(chunks: Uint8Array[], headers: Record<string, string> = {}): Response {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		},
	});
	return new Response(body, { headers });
}

describe('writeResponseBody', () => {
	test('writes a streamed body to disk and reports its size and sha256', async () => {
		const path = join(root, 'artifact.tar.gz');
		const chunk = new Uint8Array(1024).fill(7);
		const stats = await writeResponseBody(streamedResponse([chunk, chunk, chunk]), path);
		const bytes = readFileSync(path);
		expect(stats.bytes).toBe(3072);
		expect(stats.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
		expect(bytes.byteLength).toBe(3072);
		expect([...bytes.subarray(0, 3)]).toEqual([7, 7, 7]);
		rmSync(path, { force: true });
	});

	test('refuses a response with no body', async () => {
		await expect(writeResponseBody(new Response(null), join(root, 'empty'))).rejects.toThrow(/no body/);
	});
});
