import type { PipelineLogBatch } from '@yoal/contracts';
import type { Masker } from './masker.ts';

/** The contract's per-line cap (`pipelineLogBatchSchema`). */
export const MAX_LOG_LINE = 16_384;
const MAX_BATCH = 1_000;
/** Lines kept while the control plane is unreachable; older ones are dropped, never the step. */
const MAX_QUEUED = 50_000;

type LogLine = PipelineLogBatch['lines'][number];
type Stream = LogLine['stream'];

export interface LogSink {
	logs(batch: PipelineLogBatch): Promise<unknown>;
}

/**
 * Batches job log lines to `POST /api/pipeline/logs`: every second, or as soon as 500 lines are
 * waiting. `push` never awaits the network, so a slow or failing control plane can delay logs but
 * never a step. Every line is masked here, the last point before it leaves the process.
 */
export class LogBatcher {
	private queue: LogLine[] = [];
	private sending: Promise<void> = Promise.resolve();
	private timer: ReturnType<typeof setInterval> | null;
	private dropped = 0;

	constructor(
		private readonly sink: LogSink,
		private readonly masker: Masker | null,
		private readonly options: { flushMs?: number; flushLines?: number; onError?: (error: unknown) => void } = {},
	) {
		this.timer = setInterval(() => void this.flush(), options.flushMs ?? 1_000);
	}

	push(step: number, stream: Stream, text: string): void {
		const masked = this.masker ? this.masker.mask(text) : text;
		this.queue.push({ step, stream, text: masked.slice(0, MAX_LOG_LINE), ts: Date.now() });
		if (this.queue.length > MAX_QUEUED) {
			const excess = this.queue.length - MAX_QUEUED;
			this.queue.splice(0, excess);
			this.dropped += excess;
		}
		if (this.queue.length >= (this.options.flushLines ?? 500)) void this.flush();
	}

	system(step: number, text: string): void {
		for (const line of text.split(/\r?\n/)) this.push(step, 'system', line);
	}

	/** Send everything queued so far; resolves once it has been sent (or given up on). */
	flush(): Promise<void> {
		if (!this.queue.length && !this.dropped) return this.sending;
		const lines = this.queue;
		this.queue = [];
		if (this.dropped) {
			lines.unshift({ step: -1, stream: 'system', text: `[${this.dropped} log lines dropped while the control plane was unreachable]`, ts: Date.now() });
			this.dropped = 0;
		}
		this.sending = this.sending.then(async () => {
			for (let start = 0; start < lines.length; start += MAX_BATCH) {
				try {
					await this.sink.logs({ lines: lines.slice(start, start + MAX_BATCH) });
				} catch (error) {
					this.options.onError?.(error);
				}
			}
		});
		return this.sending;
	}

	async close(): Promise<void> {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		await this.flush();
	}
}

/**
 * Split a byte stream into lines (`\n`, trailing `\r` removed), emitting over-long lines in
 * `MAX_LOG_LINE` pieces so one pathological line cannot grow without bound.
 */
export async function pumpLines(
	stream: ReadableStream<Uint8Array> | number | null | undefined,
	onLine: (line: string) => void,
): Promise<void> {
	if (!stream || typeof stream === 'number') return;
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let index = buffer.indexOf('\n');
			while (index >= 0) {
				onLine(buffer.slice(0, index).replace(/\r$/, ''));
				buffer = buffer.slice(index + 1);
				index = buffer.indexOf('\n');
			}
			while (buffer.length > MAX_LOG_LINE) {
				onLine(buffer.slice(0, MAX_LOG_LINE));
				buffer = buffer.slice(MAX_LOG_LINE);
			}
		}
		buffer += decoder.decode();
		if (buffer) onLine(buffer.replace(/\r$/, ''));
	} finally {
		reader.releaseLock();
	}
}
