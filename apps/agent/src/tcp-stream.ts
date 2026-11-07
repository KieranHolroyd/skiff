/**
 * A Bun TCP connection as the `{ readable, writable }` pair the shared NATS client expects
 * (packages/function-bindings/src/nats.js), the same shape workerd's `connect()` returns.
 */
export interface StreamSocket {
	readable: ReadableStream<Uint8Array>;
	writable: WritableStream<Uint8Array>;
	close(): void;
}

export function connectTcp(hostname: string, port: number, timeoutMs = 5_000): Promise<StreamSocket> {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	let ended = false;
	/** Resolves the writer waiting for the kernel to take more bytes (Bun does not buffer writes). */
	let drained: (() => void) | null = null;
	const readable = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
		},
	});
	const end = (error?: Error): void => {
		if (ended) return;
		ended = true;
		drained?.();
		try {
			if (error) controller.error(error);
			else controller.close();
		} catch {
			// Already closed or errored.
		}
	};

	let timer: ReturnType<typeof setTimeout> | undefined;
	const connecting = Bun.connect({
		hostname,
		port,
		socket: {
			data(_socket, data) {
				if (!ended) controller.enqueue(new Uint8Array(data));
			},
			drain() {
				const resume = drained;
				drained = null;
				resume?.();
			},
			end() {
				end();
			},
			close() {
				end();
			},
			error(_socket, error) {
				end(error);
			},
		},
	});
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`Timed out connecting to ${hostname}:${port}`)), timeoutMs);
	});

	return Promise.race([connecting, timeout])
		.finally(() => clearTimeout(timer))
		.then((socket) => {
			const writable = new WritableStream<Uint8Array>({
				async write(chunk) {
					let rest = chunk;
					while (rest.length > 0) {
						if (ended) throw new Error('The connection is closed.');
						const written = socket.write(rest);
						if (written >= rest.length) return;
						rest = rest.subarray(Math.max(0, written));
						await new Promise<void>((resolve) => {
							drained = resolve;
						});
					}
				},
				close() {
					socket.end();
				},
				abort() {
					socket.end();
				},
			});
			return {
				readable,
				writable,
				close: () => {
					socket.end();
					end();
				},
			};
		});
}
