import type {
	PipelineLogLine,
	PipelineRunSummary,
	PipelineRunView,
	PipelineTriggerView
} from '@skiff/contracts';
import { fetchJson } from '#lib/query.js';

/** Client reads over `/api/v1/repositories` (docs/PIPELINES.md §8); writes go through form actions. */
const base = (repo: string) => `/api/v1/repositories/${encodeURIComponent(repo)}`;

export type RunDetail = PipelineRunView & { error?: string | null };

export const pipelineKeys = {
	repo: (repo: string) => ['pipelines', repo] as const,
	runs: (repo: string, status: string, workflow: string) =>
		['pipelines', repo, 'runs', status, workflow] as const,
	triggers: (repo: string) => ['pipelines', repo, 'triggers'] as const,
	run: (repo: string, run: string) => ['pipelines', repo, 'run', run] as const
};

export async function listRuns(
	repo: string,
	filter: { status: string; workflow: string },
	signal?: AbortSignal
): Promise<PipelineRunSummary[]> {
	const params = new URLSearchParams({ limit: '50' });
	if (filter.status) params.set('status', filter.status);
	if (filter.workflow) params.set('workflow', filter.workflow);
	const body = await fetchJson<{ runs: PipelineRunSummary[] }>(`${base(repo)}/runs?${params}`, {
		signal,
		fallback: 'Could not load runs'
	});
	return body.runs;
}

export async function listTriggers(repo: string, signal?: AbortSignal): Promise<PipelineTriggerView[]> {
	const body = await fetchJson<{ triggers: PipelineTriggerView[] }>(`${base(repo)}/triggers?limit=20`, {
		signal,
		fallback: 'Could not load triggers'
	});
	return body.triggers;
}

export async function getRun(repo: string, run: string, signal?: AbortSignal): Promise<RunDetail> {
	const body = await fetchJson<{ run: RunDetail }>(`${base(repo)}/runs/${encodeURIComponent(run)}`, {
		signal,
		fallback: 'Could not load the run'
	});
	return body.run;
}

export interface LogPage {
	lines: PipelineLogLine[];
	next: number;
	complete: boolean;
}

export const LOG_PAGE = 5000;

export function jobLogs(
	repo: string,
	run: string,
	job: string,
	after: number,
	signal?: AbortSignal
): Promise<LogPage> {
	return fetchJson<LogPage>(
		`${base(repo)}/runs/${encodeURIComponent(run)}/jobs/${encodeURIComponent(job)}/logs?after=${after}&limit=${LOG_PAGE}`,
		{ signal, fallback: 'Could not load logs' }
	);
}

export function artifactHref(repo: string, run: string, artifact: string): string {
	return `${base(repo)}/runs/${encodeURIComponent(run)}/artifacts/${encodeURIComponent(artifact)}?redirect=1`;
}
