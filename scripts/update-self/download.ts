/**
 * Stream a fetched response body to a file with bounded memory.
 *
 * Deliberately not `Bun.write(path, response)`: on Bun 1.4.x a response whose body is a
 * `ReadableStream` (every real `fetch` response above a few kilobytes) never resolves and never
 * creates the file. A release or source download would then hang silently after the
 * "Downloading …" line until systemd killed the unit. The agent hit the same bug and keeps the
 * same workaround in `apps/agent/src/releases.ts`.
 */
export async function writeResponseBody(response: Response, path: string): Promise<number> {
	if (!response.body) throw new Error(`${path} was requested but the response has no body`);
	const sink = Bun.file(path).writer();
	let written = 0;
	try {
		for await (const chunk of response.body) {
			written += chunk.byteLength;
			sink.write(chunk);
			// Drain each chunk so a fast connection never buffers the whole archive in memory.
			await sink.flush();
		}
	} finally {
		await sink.end();
	}
	return written;
}
