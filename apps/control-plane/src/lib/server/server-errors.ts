import { AsyncLocalStorage } from 'node:async_hooks';
import type { RequestEvent } from '@sveltejs/kit';
import type { ServerErrorSource } from '@skiff/contracts';
import type { ServerErrorCapture } from '@skiff/core';

/**
 * The control plane's side of Settings → Server errors (docs/SERVER-ERRORS.md, D171).
 *
 * `hooks.server.ts` runs every request inside `withErrorContext`, so code that has no `event`
 * (the REST API's `errorResponse`) can still attribute an error to its request. A request that
 * reported an exception is marked, so the 5xx it then answers is not recorded a second time.
 */

interface RequestErrorContext {
	event: RequestEvent;
	reported: boolean;
}

const requests = new AsyncLocalStorage<RequestErrorContext>();

interface ServerErrorSink {
	capture(input: ServerErrorCapture): { issueId: string } | null;
}

/** Set once by `hooks.server.ts` (`core.serverErrors`); until then, and in unit tests, a no-op. */
let sink: ServerErrorSink | null = null;

export function setServerErrorSink(next: ServerErrorSink): void {
	sink = next;
}

export function withErrorContext<T>(event: RequestEvent, run: () => Promise<T>): Promise<T> {
	return requests.run({ event, reported: false }, run);
}

function requestFields(event: RequestEvent | undefined) {
	if (!event) return {};
	const principal = event.locals.principal;
	return {
		method: event.request.method,
		path: event.url.pathname,
		routeId: event.route.id,
		userId: principal?.userId ?? event.locals.user?.id ?? null,
		orgId: principal?.orgId ?? null,
		context: {
			principalKind: principal?.kind ?? null,
			dataRequest: event.isDataRequest || undefined
		}
	};
}

/**
 * Record an exception from a request (dashboard load/action, endpoint or REST handler). Returns
 * the issue id to show as a reference, or undefined when nothing was recorded.
 */
export function reportRequestError(
	error: unknown,
	options: { source?: ServerErrorSource; event?: RequestEvent; status?: number } = {}
): string | undefined {
	const store = requests.getStore();
	const event = options.event ?? store?.event;
	if (store) store.reported = true;
	const source = options.source ?? (event?.url.pathname.startsWith('/api/') ? 'api' : 'request');
	return sink?.capture({ source, error, status: options.status ?? 500, ...requestFields(event) })
		?.issueId;
}

/** A 5xx answered without an exception we saw (a proxy's 502, a handler's own 503). */
export function reportErrorResponse(event: RequestEvent, response: Response): void {
	if (response.status < 500) return;
	if (requests.getStore()?.reported) return;
	sink?.capture({
		source: 'response',
		name: `HTTP ${response.status}`,
		message: response.statusText || `The control plane answered ${response.status}.`,
		status: response.status,
		...requestFields(event)
	});
}

/** Log a background loop's failure and record it, with the loop's name as the culprit. */
export function reportBackgroundError(task: string, error: unknown): void {
	console.error(`[${task}]`, error);
	sink?.capture({ source: 'background', error, culprit: task, context: { task } });
}
