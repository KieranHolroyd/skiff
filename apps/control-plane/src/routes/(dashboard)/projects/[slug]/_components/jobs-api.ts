import type { JobConcurrency, JobRunStatus, JobRunView, JobView, LogQueryResult } from '@yoal/contracts';
import { HttpError } from '#lib/query.js';

/**
 * The jobs REST API (`/api/v1/projects/:slug/jobs/*`, plan 09), called with the session cookie.
 * Errors carry the server's message, or the first zod issue for a 422.
 */

export const jobKeys = {
	all: (slug: string) => ['jobs', slug] as const,
	list: (slug: string) => ['jobs', slug, 'list'] as const,
	runs: (slug: string) => ['jobs', slug, 'runs'] as const,
	logs: (slug: string, runId: string) => ['jobs', slug, 'logs', runId] as const
};

const base = (slug: string) => `/api/v1/projects/${encodeURIComponent(slug)}/jobs`;

async function request<T>(url: string, init: RequestInit & { fallback: string }, body?: unknown): Promise<T> {
	const { fallback, ...rest } = init;
	const response = await fetch(url, {
		...rest,
		headers: {
			accept: 'application/json',
			...(body === undefined ? {} : { 'content-type': 'application/json' })
		},
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	if (!response.ok) {
		let message = `${fallback} (${response.status}).`;
		try {
			const data = (await response.json()) as { message?: unknown; issues?: Array<{ path?: unknown[]; message?: unknown }> };
			if (typeof data?.message === 'string' && data.message) message = data.message;
			else if (Array.isArray(data?.issues) && data.issues[0]) {
				const issue = data.issues[0];
				const path = Array.isArray(issue.path) && issue.path.length ? `${issue.path.join('.')}: ` : '';
				message = `${path}${String(issue.message ?? fallback)}`;
			}
		} catch {
			// Not JSON; keep the status message.
		}
		throw new HttpError(response.status, message);
	}
	return (await response.json()) as T;
}

export interface JobInput {
	name?: string;
	command?: string[];
	schedule?: string | null;
	timeoutSeconds?: number;
	concurrency?: JobConcurrency;
	maxRetries?: number;
	enabled?: boolean;
}

export const listJobs = (slug: string, signal?: AbortSignal) =>
	request<{ jobs: JobView[] }>(base(slug), { signal, fallback: 'Could not load jobs' }).then((data) => data.jobs);

export const listRuns = (slug: string, signal?: AbortSignal) =>
	request<{ runs: JobRunView[] }>(`${base(slug)}/runs?limit=50`, { signal, fallback: 'Could not load runs' }).then((data) => data.runs);

export const runLogs = (slug: string, runId: string, signal?: AbortSignal) =>
	request<LogQueryResult>(`${base(slug)}/runs/${encodeURIComponent(runId)}/logs?limit=500`, { signal, fallback: 'Could not load the output' });

export const createJob = (slug: string, input: JobInput) =>
	request<{ job: JobView }>(base(slug), { method: 'POST', fallback: 'Could not create the job' }, input).then((data) => data.job);

export const updateJob = (slug: string, name: string, input: JobInput) =>
	request<{ job: JobView }>(`${base(slug)}/${encodeURIComponent(name)}`, { method: 'PATCH', fallback: 'Could not save the job' }, input).then(
		(data) => data.job
	);

export const setPaused = (slug: string, name: string, paused: boolean) =>
	request<{ job: JobView }>(`${base(slug)}/${encodeURIComponent(name)}/${paused ? 'pause' : 'resume'}`, {
		method: 'POST',
		fallback: paused ? 'Could not pause the job' : 'Could not resume the job'
	});

export const deleteJob = (slug: string, name: string) =>
	request<{ deleted: true }>(`${base(slug)}/${encodeURIComponent(name)}`, { method: 'DELETE', fallback: 'Could not delete the job' });

export const runJob = (slug: string, name: string) =>
	request<{ run: JobRunView }>(`${base(slug)}/${encodeURIComponent(name)}/run`, { method: 'POST', fallback: 'Could not start the run' }).then(
		(data) => data.run
	);

export const runCommand = (slug: string, command: string[], timeoutSeconds: number) =>
	request<{ run: JobRunView }>(`${base(slug)}/runs`, { method: 'POST', fallback: 'Could not start the command' }, { command, timeoutSeconds }).then(
		(data) => data.run
	);

export const cancelRun = (slug: string, runId: string) =>
	request<{ run: JobRunView }>(`${base(slug)}/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST', fallback: 'Could not cancel the run' });

export function runActive(status: JobRunStatus): boolean {
	return status === 'queued' || status === 'running';
}
