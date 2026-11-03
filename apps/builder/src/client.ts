import type { BuildJob, BuildLogChunk, BuildReport } from '@skiff/contracts';

export class ControlError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = 'ControlError';
	}
}

/** Thin client for the node-authenticated Builder protocol. */
export class ControlClient {
	private readonly base: string;

	constructor(
		controlUrl: string,
		private readonly nodeToken: string,
	) {
		this.base = controlUrl.replace(/\/+$/, '');
	}

	private headers(): Record<string, string> {
		return {
			authorization: `Bearer ${this.nodeToken}`,
			'content-type': 'application/json',
		};
	}

	private async request(path: string, init: RequestInit = {}): Promise<Response> {
		const response = await fetch(`${this.base}${path}`, {
			...init,
			headers: { ...this.headers(), ...(init.headers as Record<string, string> | undefined) },
			signal: AbortSignal.timeout(30_000),
		});
		if (!response.ok) {
			const body = (await response.text().catch(() => '')).slice(0, 500);
			throw new ControlError(`${init.method ?? 'GET'} ${path} failed: ${response.status} ${body}`.trim(), response.status);
		}
		return response;
	}

	/** The control plane returns `null` when the queue is empty or this node already has a build. */
	async next(): Promise<BuildJob | null> {
		const response = await this.request('/api/agent/builds/next');
		if (response.status === 204) return null;
		const body = (await response.json()) as BuildJob | null;
		return body ?? null;
	}

	async log(buildId: string, chunk: BuildLogChunk): Promise<void> {
		await this.request(`/api/agent/builds/${encodeURIComponent(buildId)}/log`, {
			method: 'POST',
			body: JSON.stringify(chunk),
		});
	}

	async report(buildId: string, report: BuildReport): Promise<void> {
		await this.request(`/api/agent/builds/${encodeURIComponent(buildId)}/report`, {
			method: 'POST',
			body: JSON.stringify(report),
		});
	}
}
