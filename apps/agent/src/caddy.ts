/**
 * Minimal Caddy admin API client. The admin endpoint is a unix socket only (D7); Bun's fetch
 * supports `unix`, which keeps this dependency-free.
 */

export class CaddyError extends Error {
	readonly status: number | undefined;

	constructor(message: string, status?: number) {
		super(message);
		this.name = 'CaddyError';
		this.status = status;
	}
}

/** Conservative timeouts: a wedged Caddy must not stall the reconcile loop forever. */
const HEALTH_TIMEOUT_MS = 5_000;
const LOAD_TIMEOUT_MS = 30_000;

export class CaddyAdmin {
	readonly socketPath: string;

	constructor(socketPath: string) {
		this.socketPath = socketPath;
	}

	private async request(
		method: string,
		path: string,
		body?: unknown,
		signal?: AbortSignal,
		timeoutMs = LOAD_TIMEOUT_MS,
	): Promise<Response> {
		const timeout = AbortSignal.timeout(timeoutMs);
		const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
		let response: Response;
		try {
			response = await fetch(`http://caddy${path}`, {
				method,
				unix: this.socketPath,
				signal: combined,
				headers: body === undefined ? undefined : { 'content-type': 'application/json' },
				body: body === undefined ? undefined : JSON.stringify(body),
			});
		} catch (error) {
			throw new CaddyError(
				`Caddy admin ${method} ${path} failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (!response.ok) {
			const text = await response.text().catch(() => '');
			throw new CaddyError(
				`Caddy admin ${method} ${path} -> ${response.status}${text ? `: ${text}` : ''}`,
				response.status,
			);
		}
		return response;
	}

	/** GET /config/ — used as the liveness probe before every heartbeat. */
	async health(signal?: AbortSignal): Promise<void> {
		const response = await this.request('GET', '/config/', undefined, signal, HEALTH_TIMEOUT_MS);
		// The config can be large and we do not need it for a liveness check.
		await response.body?.cancel().catch(() => undefined);
	}

	/**
	 * Replace the entire config. Caddy reloads the whole config on every admin call, so the agent
	 * deliberately makes exactly one of these per reconcile (SPIKES §4).
	 */
	async applyFullConfig(config: unknown, signal?: AbortSignal): Promise<void> {
		const response = await this.request('POST', '/load', config, signal, LOAD_TIMEOUT_MS);
		await response.body?.cancel().catch(() => undefined);
	}

	/** Whether the running config contains an object with this `@id` (Caddy answers 404 if not). */
	async hasId(id: string, signal?: AbortSignal): Promise<boolean> {
		try {
			const response = await this.request(
				'GET',
				`/id/${encodeURIComponent(id)}`,
				undefined,
				signal,
				HEALTH_TIMEOUT_MS,
			);
			await response.body?.cancel().catch(() => undefined);
			return true;
		} catch (error) {
			if (error instanceof CaddyError && error.status === 404) return false;
			throw error;
		}
	}

	/** Current config as JSON, useful for diagnostics. */
	async load(signal?: AbortSignal): Promise<unknown> {
		const response = await this.request('GET', '/config/', undefined, signal, HEALTH_TIMEOUT_MS);
		return response.json();
	}
}
