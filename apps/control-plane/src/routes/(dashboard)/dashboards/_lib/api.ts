import type {
	DashboardCreateInput,
	DashboardSummary,
	DashboardUpdateInput,
	DashboardView,
	ObservabilityQueryRequest,
	ObservabilitySchema,
	QueryResult
} from '@skiff/contracts';
import { fetchJson } from '#lib/query.js';

/**
 * The observability REST API (`/api/v1/observability/*`), called with the session cookie.
 * Mutations are same-origin fetches, so the browser's `Origin` header satisfies the CSRF check.
 */
const BASE = '/api/v1/observability';

const json = (method: string, body: unknown): RequestInit => ({
	method,
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify(body)
});

export const keys = {
	schema: ['observability', 'schema'] as const,
	dashboards: ['observability', 'dashboards'] as const,
	dashboard: (id: string) => ['observability', 'dashboard', id] as const,
	query: (request: ObservabilityQueryRequest) => ['observability', 'query', request] as const
};

export function getSchema(signal?: AbortSignal): Promise<ObservabilitySchema> {
	return fetchJson(`${BASE}/schema`, { signal, fallback: 'Could not load the telemetry schema' });
}

export function runQuery(
	request: ObservabilityQueryRequest,
	signal?: AbortSignal
): Promise<QueryResult> {
	return fetchJson(`${BASE}/query`, {
		...json('POST', request),
		signal,
		fallback: 'The query failed'
	});
}

export async function listDashboards(signal?: AbortSignal): Promise<DashboardSummary[]> {
	const body = await fetchJson<{ dashboards: DashboardSummary[] }>(`${BASE}/dashboards`, {
		signal,
		fallback: 'Could not load dashboards'
	});
	return body.dashboards;
}

export async function getDashboard(id: string, signal?: AbortSignal): Promise<DashboardView> {
	const body = await fetchJson<{ dashboard: DashboardView }>(
		`${BASE}/dashboards/${encodeURIComponent(id)}`,
		{
			signal,
			fallback: 'Could not load the dashboard'
		}
	);
	return body.dashboard;
}

export async function createDashboard(input: DashboardCreateInput): Promise<DashboardView> {
	const body = await fetchJson<{ dashboard: DashboardView }>(`${BASE}/dashboards`, {
		...json('POST', input),
		fallback: 'Could not create the dashboard'
	});
	return body.dashboard;
}

export async function updateDashboard(
	id: string,
	input: DashboardUpdateInput
): Promise<DashboardView> {
	const body = await fetchJson<{ dashboard: DashboardView }>(
		`${BASE}/dashboards/${encodeURIComponent(id)}`,
		{
			...json('PUT', input),
			fallback: 'Could not save the dashboard'
		}
	);
	return body.dashboard;
}

export async function deleteDashboard(id: string): Promise<void> {
	await fetchJson(`${BASE}/dashboards/${encodeURIComponent(id)}`, {
		method: 'DELETE',
		fallback: 'Could not delete the dashboard'
	});
}
