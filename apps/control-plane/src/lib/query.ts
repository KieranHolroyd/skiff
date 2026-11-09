import { browser } from '$app/env';
import { QueryClient } from '@tanstack/svelte-query';

/**
 * TanStack Query for the dashboard's client-side reads: live tails, polled status and lazily
 * fetched files. Page data still comes from SvelteKit loads; Query owns what changes (or is
 * fetched) after the page has rendered.
 *
 * One client per dashboard mount, so server renders never share a cache between requests.
 * Queries only run in the browser; SSR renders their pending state.
 */
export function createDashboardQueryClient(): QueryClient {
	return new QueryClient({
		defaultOptions: {
			queries: {
				enabled: browser,
				staleTime: 10_000,
				// One quick retry hides a blip; anything longer is surfaced to the reader.
				retry: 1,
				refetchOnWindowFocus: true
			}
		}
	});
}

/** A non-2xx response, with the server's `{ message }` when it sent one. */
export class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string
	) {
		super(message);
		this.name = 'HttpError';
	}
}

/**
 * A 403 `step_up_required` (STEP-UP.md §6). Carries the permission and level the server named so
 * the future VerifyDialog can verify and retry; today the message says verification is unavailable.
 */
export class StepUpRequiredHttpError extends HttpError {
	constructor(
		readonly permission: string,
		readonly level: 'window' | 'always',
		message = 'Verify it’s you to continue. Step-up verification is not available in this build yet.'
	) {
		super(403, message);
		this.name = 'StepUpRequiredHttpError';
	}
}

async function failure(response: Response, fallback: string): Promise<HttpError> {
	let message = `${fallback} (${response.status}).`;
	try {
		const body = (await response.json()) as {
			message?: unknown;
			error?: unknown;
			permission?: unknown;
			level?: unknown;
		};
		if (body?.error === 'step_up_required' && typeof body.permission === 'string')
			return new StepUpRequiredHttpError(
				body.permission,
				body.level === 'always' ? 'always' : 'window'
			);
		if (typeof body?.message === 'string' && body.message) message = body.message;
	} catch {
		// Not JSON; keep the status message.
	}
	return new HttpError(response.status, message);
}

/** GET JSON, throwing an `HttpError` that carries the server's message. */
export async function fetchJson<T>(
	url: string,
	init: RequestInit & { fallback?: string } = {}
): Promise<T> {
	const { fallback = 'The request failed', ...rest } = init;
	const response = await fetch(url, {
		...rest,
		headers: { accept: 'application/json', ...rest.headers }
	});
	if (!response.ok) throw await failure(response, fallback);
	return (await response.json()) as T;
}

/** GET text, with the same error handling as `fetchJson`. */
export async function fetchText(
	url: string,
	init: RequestInit & { fallback?: string } = {}
): Promise<string> {
	const { fallback = 'The request failed', ...rest } = init;
	const response = await fetch(url, {
		...rest,
		headers: { accept: 'text/plain', ...rest.headers }
	});
	if (!response.ok) throw await failure(response, fallback);
	return response.text();
}

/** A readable message from whatever a query threw. */
export function errorText(error: unknown, fallback = 'Something went wrong.'): string {
	return error instanceof Error && error.message ? error.message : fallback;
}
