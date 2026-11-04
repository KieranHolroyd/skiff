/**
 * Server-Sent Events parsing for `fetch` streams. The CLI can't use `EventSource` because it
 * has to send a bearer key, so it reads the body itself (docs/OPERATIONS.md §2.5).
 *
 * Follows the WHATWG event-stream rules that matter here: `\n`, `\r\n` or `\r` line endings,
 * `:` comment lines (heartbeats), multi-line `data:` joined with `\n`, one optional space after
 * the colon, and an event is only dispatched when it has data.
 */

export interface SseEvent {
	/** `message` when the block had no `event:` line. */
	event: string;
	data: string;
	/** Set only when this block carried an `id:` line. */
	id?: string;
}

export class SseParser {
	private buffer = '';
	private event = '';
	private data: string[] = [];
	private id: string | undefined;
	/** The last reconnection delay the server asked for (`retry:`), in ms. */
	retryMs: number | undefined;

	/** Feed a decoded chunk; returns every event it completed. */
	push(chunk: string): SseEvent[] {
		this.buffer += chunk;
		const events: SseEvent[] = [];
		for (;;) {
			const match = /\r\n|\r|\n/.exec(this.buffer);
			if (!match) break;
			// A lone `\r` at the end might be the first half of `\r\n`; wait for more input.
			if (match[0] === '\r' && match.index === this.buffer.length - 1) break;
			const line = this.buffer.slice(0, match.index);
			this.buffer = this.buffer.slice(match.index + match[0].length);
			const event = this.line(line);
			if (event) events.push(event);
		}
		return events;
	}

	/**
	 * End of stream. A trailing `\r` held back as a possible `\r\n` is a line ending after all;
	 * a block still missing its blank line is discarded, per the spec.
	 */
	end(): SseEvent[] {
		const events = this.buffer.endsWith('\r') ? this.push('\n') : [];
		this.reset();
		this.buffer = '';
		return events;
	}

	private line(line: string): SseEvent | undefined {
		if (line === '') return this.dispatch();
		if (line.startsWith(':')) return undefined;
		const colon = line.indexOf(':');
		const field = colon === -1 ? line : line.slice(0, colon);
		let value = colon === -1 ? '' : line.slice(colon + 1);
		if (value.startsWith(' ')) value = value.slice(1);
		switch (field) {
			case 'event':
				this.event = value;
				break;
			case 'data':
				this.data.push(value);
				break;
			case 'id':
				if (!value.includes('\0')) this.id = value;
				break;
			case 'retry':
				if (/^\d+$/.test(value)) this.retryMs = Number(value);
				break;
		}
		return undefined;
	}

	private dispatch(): SseEvent | undefined {
		const hasData = this.data.length > 0;
		const event: SseEvent = { event: this.event || 'message', data: this.data.join('\n') };
		if (this.id !== undefined) event.id = this.id;
		this.reset();
		return hasData ? event : undefined;
	}

	private reset(): void {
		this.event = '';
		this.data = [];
		this.id = undefined;
	}
}

/** Read a streaming response body as SSE events. `onChunk` fires for every chunk, heartbeats included. */
export async function* readSse(
	body: ReadableStream<Uint8Array>,
	options: { onChunk?: () => void } = {},
): AsyncGenerator<SseEvent> {
	const parser = new SseParser();
	const decoder = new TextDecoder();
	const reader = body.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			options.onChunk?.();
			yield* parser.push(decoder.decode(value, { stream: true }));
		}
		yield* parser.push(decoder.decode());
		yield* parser.end();
	} finally {
		reader.releaseLock();
	}
}
