import type {
	PipelineArtifactCreate,
	PipelineArtifactUpload,
	PipelineArtifactView,
	PipelineCacheHit,
	PipelineCacheLookup,
	PipelineCacheReservation,
	PipelineCacheReserve,
	PipelineClaim,
	PipelineClaimRequest,
	PipelineDeployRequest,
	PipelineDeployResult,
	PipelineDeployStart,
	PipelineHeartbeatResponse,
	PipelineJobComplete,
	PipelineLogBatch,
	PipelineOidcTokenResponse,
	PipelineResolveReport,
	PipelineSecretsResponse,
	PipelineStepReport,
} from '@yoal/contracts';

/**
 * Clients for the Pipelines protocol (docs/PIPELINES.md §4.1). `PipelineNodeClient` claims work
 * with the node token; `JobApi` does everything else with the per-job token from the claim, so
 * the node token never reaches the job (W9) and a leaked job token dies with the job.
 */

export class PipelineApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = 'PipelineApiError';
	}
}

/** Statuses meaning "this job is no longer yours": stop work instead of retrying. */
export function isLeaseLost(error: unknown): boolean {
	return error instanceof PipelineApiError && [401, 403, 404, 409, 410].includes(error.status);
}

interface RequestOptions {
	method?: string;
	body?: unknown;
	timeoutMs?: number;
	/** Extra attempts on network errors, 429 and 5xx (only for idempotent-enough calls). */
	retries?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function retryable(error: unknown): boolean {
	if (error instanceof PipelineApiError) return error.status === 429 || error.status >= 500;
	return true;
}

class HttpBase {
	protected readonly base: string;

	constructor(
		controlUrl: string,
		protected readonly bearer: string,
	) {
		this.base = controlUrl.replace(/\/+$/, '');
	}

	/** Presigned URLs may be absolute or relative to the control plane. */
	absoluteUrl(url: string): string {
		return url.startsWith('/') ? `${this.base}${url}` : url;
	}

	protected async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
		const attempts = 1 + (options.retries ?? 0);
		let lastError: unknown;
		for (let attempt = 0; attempt < attempts; attempt += 1) {
			if (attempt > 0) await sleep(Math.min(500 * 2 ** (attempt - 1), 5_000));
			try {
				return await this.once<T>(path, options);
			} catch (error) {
				lastError = error;
				if (!retryable(error)) throw error;
			}
		}
		throw lastError;
	}

	private async once<T>(path: string, options: RequestOptions): Promise<T> {
		const method = options.method ?? (options.body === undefined ? 'GET' : 'POST');
		let response: Response;
		try {
			response = await fetch(`${this.base}${path}`, {
				method,
				headers: {
					authorization: `Bearer ${this.bearer}`,
					...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
				},
				body: options.body === undefined ? undefined : JSON.stringify(options.body),
				signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
			});
		} catch (error) {
			throw new Error(`${method} ${path} failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (!response.ok) {
			const body = (await response.text().catch(() => '')).slice(0, 500);
			throw new PipelineApiError(`${method} ${path} failed: ${response.status} ${body}`.trim(), response.status);
		}
		if (response.status === 204) return null as T;
		const text = await response.text();
		return (text ? JSON.parse(text) : null) as T;
	}
}

/** Node-token client: claim a resolve or job. 403 means this node is not a builder. */
export class PipelineNodeClient extends HttpBase {
	async claim(request: PipelineClaimRequest): Promise<PipelineClaim | null> {
		return (await this.request<PipelineClaim | null>('/api/agent/pipelines/claim', { body: request })) ?? null;
	}
}

/** Job-token client for `/api/pipeline/*`. */
export class JobApi extends HttpBase {
	resolve(report: PipelineResolveReport): Promise<unknown> {
		return this.request('/api/pipeline/resolve', { body: report, retries: 2 });
	}

	heartbeat(step?: number): Promise<PipelineHeartbeatResponse> {
		return this.request('/api/pipeline/heartbeat', { body: step === undefined ? {} : { step }, timeoutMs: 10_000 });
	}

	async secrets(): Promise<Record<string, string>> {
		const response = await this.request<PipelineSecretsResponse>('/api/pipeline/secrets', { retries: 2 });
		return response?.secrets ?? {};
	}

	step(index: number, report: PipelineStepReport): Promise<unknown> {
		return this.request(`/api/pipeline/steps/${index}`, { body: report, retries: 3 });
	}

	logs(batch: PipelineLogBatch): Promise<unknown> {
		return this.request('/api/pipeline/logs', { body: batch, retries: 3 });
	}

	complete(body: PipelineJobComplete): Promise<unknown> {
		return this.request('/api/pipeline/complete', { body, retries: 4 });
	}

	createArtifact(body: PipelineArtifactCreate): Promise<PipelineArtifactUpload> {
		return this.request('/api/pipeline/artifacts', { body });
	}

	finalizeArtifact(id: string): Promise<PipelineArtifactView> {
		return this.request(`/api/pipeline/artifacts/${encodeURIComponent(id)}/finalize`, { method: 'POST', retries: 2 });
	}

	async listArtifacts(name?: string): Promise<PipelineArtifactView[]> {
		const query = name ? `?name=${encodeURIComponent(name)}` : '';
		const response = await this.request<{ artifacts: PipelineArtifactView[] }>(`/api/pipeline/artifacts${query}`, { retries: 2 });
		return response?.artifacts ?? [];
	}

	async cacheLookup(body: PipelineCacheLookup): Promise<PipelineCacheHit | null> {
		const response = await this.request<{ hit: PipelineCacheHit | null }>('/api/pipeline/cache/lookup', { body, retries: 2 });
		return response?.hit ?? null;
	}

	cacheReserve(body: PipelineCacheReserve): Promise<PipelineCacheReservation> {
		return this.request('/api/pipeline/cache/reserve', { body });
	}

	cacheCommit(id: string): Promise<unknown> {
		return this.request(`/api/pipeline/cache/${encodeURIComponent(id)}/commit`, { method: 'POST', retries: 2 });
	}

	deploy(body: PipelineDeployRequest): Promise<PipelineDeployStart> {
		return this.request('/api/pipeline/deploy', { body, timeoutMs: 120_000 });
	}

	finalizeDeploy(id: string): Promise<PipelineDeployResult> {
		return this.request(`/api/pipeline/deploy/${encodeURIComponent(id)}/finalize`, { method: 'POST', timeoutMs: 300_000 });
	}

	/** W9: an OIDC ID token for cloud federation (403 for untrusted runs). Never put in step env. */
	oidcToken(audience?: string): Promise<PipelineOidcTokenResponse> {
		return this.request('/api/pipeline/oidc-token', { body: audience ? { audience } : {}, retries: 2 });
	}

	/**
	 * The job token goes only to the control plane's own (relative) URLs; an absolute presigned
	 * object-store URL carries its own authorization and must never receive it.
	 */
	private transferHeaders(url: string): Record<string, string> {
		return url.startsWith('/') ? { authorization: `Bearer ${this.bearer}` } : {};
	}

	/** PUT a body to a presigned URL. */
	async upload(url: string, body: Blob | Uint8Array, contentType: string): Promise<void> {
		const response = await fetch(this.absoluteUrl(url), {
			method: 'PUT',
			headers: { 'content-type': contentType, ...this.transferHeaders(url) },
			body,
			signal: AbortSignal.timeout(30 * 60_000),
		});
		if (!response.ok)
			throw new PipelineApiError(`Upload failed: ${response.status} ${(await response.text().catch(() => '')).slice(0, 300)}`, response.status);
	}

	/** GET a presigned URL into a file. */
	async download(url: string, path: string): Promise<number> {
		const response = await fetch(this.absoluteUrl(url), {
			headers: this.transferHeaders(url),
			signal: AbortSignal.timeout(30 * 60_000),
		});
		if (!response.ok)
			throw new PipelineApiError(`Download failed: ${response.status} ${(await response.text().catch(() => '')).slice(0, 300)}`, response.status);
		return Bun.write(path, response);
	}
}
