import type {
	AlertEventKind,
	AlertEventView,
	AlertPreview,
	AlertRuleInput,
	AlertRuleSummary,
	AlertRuleUpdateInput,
	AlertRuleView,
	AlertSilenceCreateInput,
	AlertSilenceView,
	AlertsOverview
} from '@yoal/contracts';
import { HttpError } from '#lib/query.js';

/**
 * The alerts REST API (`/api/v1/alerts/*`), called with the session cookie like the dashboards
 * API. Errors keep the server's `issues` (422) so the rule editor can show them inline.
 */
const BASE = '/api/v1/alerts';

export const keys = {
	all: ['alerts'] as const,
	overview: ['alerts', 'overview'] as const,
	rules: ['alerts', 'rules'] as const,
	rule: (id: string) => ['alerts', 'rule', id] as const,
	silences: (expired: boolean) => ['alerts', 'silences', expired] as const,
	history: (filter: { rule?: string; kinds: AlertEventKind[] }) =>
		['alerts', 'history', filter] as const
};

/** A failed alerts request; `issues` are zod-style `{ path, message }` from a 422. */
export class AlertApiError extends HttpError {
	constructor(
		status: number,
		message: string,
		readonly issues: unknown[] = []
	) {
		super(status, message);
		this.name = 'AlertApiError';
	}
}

async function request<T>(
	url: string,
	init: RequestInit & { fallback: string; body?: never },
	body?: unknown
): Promise<T> {
	const { fallback, ...rest } = init;
	const response = await fetch(url, {
		...rest,
		headers: {
			accept: 'application/json',
			...(body === undefined ? {} : { 'content-type': 'application/json' }),
			...rest.headers
		},
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	if (!response.ok) {
		let message = `${fallback} (${response.status}).`;
		let issues: unknown[] = [];
		try {
			const data = (await response.json()) as { message?: unknown; issues?: unknown };
			if (typeof data?.message === 'string' && data.message) message = data.message;
			if (Array.isArray(data?.issues)) {
				issues = data.issues;
				if (typeof data.message !== 'string')
					message = `${fallback}: check the highlighted fields.`;
			}
		} catch {
			// Not JSON; keep the status message.
		}
		throw new AlertApiError(response.status, message, issues);
	}
	return (await response.json()) as T;
}

const id = (value: string) => encodeURIComponent(value);

export function getOverview(signal?: AbortSignal): Promise<AlertsOverview> {
	return request(BASE, { signal, fallback: 'Could not load alerts' });
}

export async function listRules(signal?: AbortSignal): Promise<AlertRuleSummary[]> {
	const body = await request<{ rules: AlertRuleSummary[] }>(`${BASE}/rules`, {
		signal,
		fallback: 'Could not load alert rules'
	});
	return body.rules;
}

export async function getRule(ruleId: string, signal?: AbortSignal): Promise<AlertRuleView> {
	const body = await request<{ rule: AlertRuleView }>(`${BASE}/rules/${id(ruleId)}`, {
		signal,
		fallback: 'Could not load the alert rule'
	});
	return body.rule;
}

export async function createRule(input: AlertRuleInput): Promise<AlertRuleView> {
	const body = await request<{ rule: AlertRuleView }>(
		`${BASE}/rules`,
		{ method: 'POST', fallback: 'Could not create the rule' },
		input
	);
	return body.rule;
}

export async function updateRule(
	ruleId: string,
	input: AlertRuleUpdateInput
): Promise<AlertRuleView> {
	const body = await request<{ rule: AlertRuleView }>(
		`${BASE}/rules/${id(ruleId)}`,
		{ method: 'PUT', fallback: 'Could not save the rule' },
		input
	);
	return body.rule;
}

export async function deleteRule(ruleId: string): Promise<void> {
	await request(`${BASE}/rules/${id(ruleId)}`, {
		method: 'DELETE',
		fallback: 'Could not delete the rule'
	});
}

export async function evaluateRule(ruleId: string): Promise<AlertRuleView> {
	const body = await request<{ rule: AlertRuleView }>(`${BASE}/rules/${id(ruleId)}/evaluate`, {
		method: 'POST',
		fallback: 'Could not evaluate the rule'
	});
	return body.rule;
}

export async function testRule(ruleId: string): Promise<Record<string, string>> {
	const body = await request<{ delivery: Record<string, string> }>(
		`${BASE}/rules/${id(ruleId)}/test`,
		{ method: 'POST', fallback: 'Could not send a test notification' }
	);
	return body.delivery;
}

export async function acknowledge(
	ruleId: string,
	fingerprint: string,
	acknowledged: boolean
): Promise<AlertRuleView> {
	const body = await request<{ rule: AlertRuleView }>(
		`${BASE}/rules/${id(ruleId)}/ack`,
		{ method: 'POST', fallback: 'Could not update the acknowledgement' },
		{ fingerprint, acknowledged }
	);
	return body.rule;
}

export function previewRule(
	input: { rule?: AlertRuleInput; ruleId?: string },
	signal?: AbortSignal
): Promise<AlertPreview> {
	return request(
		`${BASE}/preview`,
		{ method: 'POST', signal, fallback: 'Could not preview the rule' },
		input
	);
}

export async function listSilences(
	expired: boolean,
	signal?: AbortSignal
): Promise<AlertSilenceView[]> {
	const body = await request<{ silences: AlertSilenceView[] }>(
		`${BASE}/silences${expired ? '?expired=1' : ''}`,
		{ signal, fallback: 'Could not load silences' }
	);
	return body.silences;
}

export async function createSilence(input: AlertSilenceCreateInput): Promise<AlertSilenceView> {
	const body = await request<{ silence: AlertSilenceView }>(
		`${BASE}/silences`,
		{ method: 'POST', fallback: 'Could not create the silence' },
		input
	);
	return body.silence;
}

export async function expireSilence(silenceId: string): Promise<void> {
	await request(`${BASE}/silences/${id(silenceId)}`, {
		method: 'DELETE',
		fallback: 'Could not end the silence'
	});
}

export async function getHistory(
	filter: { rule?: string; kinds: AlertEventKind[]; before?: string; limit?: number },
	signal?: AbortSignal
): Promise<AlertEventView[]> {
	const params = new URLSearchParams();
	if (filter.rule) params.set('rule', filter.rule);
	if (filter.kinds.length) params.set('kind', filter.kinds.join(','));
	if (filter.before) params.set('before', filter.before);
	if (filter.limit) params.set('limit', String(filter.limit));
	const query = params.toString();
	const body = await request<{ events: AlertEventView[] }>(
		`${BASE}/history${query ? `?${query}` : ''}`,
		{ signal, fallback: 'Could not load alert history' }
	);
	return body.events;
}
