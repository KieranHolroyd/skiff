import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadToFile, ReleaseError } from './releases.ts';

const BIG = 96 * 1024 * 1024;
const chunk = new Uint8Array(1024 * 1024).fill(7);

const server = Bun.serve({
	port: 0,
	fetch(request) {
		const size = Number(new URL(request.url).searchParams.get('size'));
		let sent = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (sent >= size) return controller.close();
				const next = Math.min(chunk.byteLength, size - sent);
				controller.enqueue(chunk.subarray(0, next));
				sent += next;
			},
		});
		return new Response(body, { headers: { 'content-length': String(size), 'content-type': 'application/zip' } });
	},
});
const dir = await mkdtemp(join(tmpdir(), 'skiff-download-'));

afterAll(async () => {
	server.stop(true);
	await rm(dir, { recursive: true, force: true });
});

describe('downloadToFile', () => {
	test('streams a large release archive to disk', async () => {
		const path = join(dir, 'big.zip');
		const response = await fetch(`${server.url}?size=${BIG}`);
		const written = await downloadToFile(response, path, BIG * 2, 'big');
		expect(written).toBe(BIG);
		expect((await stat(path)).size).toBe(BIG);
	}, 30_000);

	test('rejects an archive whose declared size is over the limit', async () => {
		const response = await fetch(`${server.url}?size=${4 * 1024 * 1024}`);
		await expect(downloadToFile(response, join(dir, 'declared.zip'), 1024 * 1024, 'declared')).rejects.toBeInstanceOf(
			ReleaseError,
		);
	});

	test('stops streaming once the body passes the limit', async () => {
		const original = await fetch(`${server.url}?size=${4 * 1024 * 1024}`);
		// Drop content-length so only the streaming check can catch it.
		const response = new Response(original.body);
		await expect(downloadToFile(response, join(dir, 'streamed.zip'), 1024 * 1024, 'streamed')).rejects.toBeInstanceOf(
			ReleaseError,
		);
	});
});
