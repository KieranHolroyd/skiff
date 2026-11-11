/**
 * Stream a fetched response body to a file with bounded memory.
 *
 * Deliberately not `Bun.write(path, response)`: on Bun 1.4.x a response whose body is a
 * `ReadableStream` (every real `fetch` response above a few kilobytes) never resolves and never
 * creates the file. A release or source download would then hang silently after the
 * "Downloading …" line until systemd killed the unit. The agent hit the same bug and keeps the
 * same workaround in `apps/agent/src/releases.ts`.
 *
 * The sha256 is computed while the bytes stream past, so verifying a release never re-reads the
 * archive from disk. Artifacts are hundreds of MiB; the old `readFileSync` hash doubled the IO
 * and allocated the whole file in memory.
 */
import { createHash } from 'node:crypto';

export interface DownloadStats {
	bytes: number;
	sha256: string;
}

export async function writeResponseBody(response: Response, path: string): Promise<DownloadStats> {
	if (!response.body) throw new Error(`${path} was requested but the response has no body`);
	const sink = Bun.file(path).writer();
	const hash = createHash('sha256');
	let written = 0;
	let unflushed = 0;
	try {
		for await (const chunk of response.body) {
			written += chunk.byteLength;
			hash.update(chunk);
			sink.write(chunk);
			unflushed += chunk.byteLength;
			// Drain in 1 MiB batches: bounded memory without an await per network chunk.
			if (unflushed >= 1024 * 1024) {
				await sink.flush();
				unflushed = 0;
			}
		}
	} finally {
		await sink.end();
	}
	return { bytes: written, sha256: hash.digest('hex') };
}
