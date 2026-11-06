import type * as z from 'zod';
import {
	decodeEvents,
	studioErrorBodySchema,
	type StudioErrorCode,
	type StudioEvent,
	type StudioOp,
	type StudioResponses,
	studioRequestSchemas
} from '@skiff/studio/protocol';

/**
 * Browser client for the native studio (plan 22). Every call goes to the dashboard's same-origin
 * proxy, which adds the session token; nothing here ever sees it.
 */

/** Ops answered with one JSON document. */
export type StudioJsonOp = Exclude<StudioOp, 'browse' | 'run'>;
/** Ops answered with an NDJSON stream of `StudioEvent`s. */
export type StudioStreamOp = Extract<StudioOp, 'browse' | 'run'>;
/** A request body as the caller writes it (schema defaults may be left out). */
export type StudioCallBody<Op extends StudioOp> = z.input<(typeof studioRequestSchemas)[Op]>;

/** A refused or failed studio call, with the protocol's stable code. */
export class StudioCallError extends Error {
	constructor(
		readonly code: StudioErrorCode | 'network',
		message: string,
		readonly status: number
	) {
		super(message);
		this.name = 'StudioCallError';
	}
}

export function studioApiPath(databaseName: string, op: StudioOp): string {
	return `/databases/${encodeURIComponent(databaseName)}/studio/api/${op}`;
}

async function failure(response: Response): Promise<StudioCallError> {
	try {
		const parsed = studioErrorBodySchema.safeParse(await response.json());
		if (parsed.success)
			return new StudioCallError(
				parsed.data.error.code,
				parsed.data.error.message,
				response.status
			);
	} catch {
		// Not a protocol error body (a proxy or framework error page).
	}
	const code: StudioErrorCode =
		response.status === 401
			? 'unauthorized'
			: response.status === 403
				? 'forbidden'
				: response.status === 404
					? 'not_found'
					: response.status === 503
						? 'studio_unavailable'
						: 'internal';
	return new StudioCallError(
		code,
		`The studio request failed (${response.status}).`,
		response.status
	);
}

async function post(
	databaseName: string,
	op: StudioOp,
	body: unknown,
	accept: string,
	signal?: AbortSignal
): Promise<Response> {
	let response: Response;
	try {
		response = await fetch(studioApiPath(databaseName, op), {
			method: 'POST',
			headers: { 'content-type': 'application/json', accept },
			body: JSON.stringify(body),
			cache: 'no-store',
			signal
		});
	} catch (caught) {
		if (signal?.aborted) throw new StudioCallError('cancelled', 'Cancelled.', 499);
		throw new StudioCallError(
			'network',
			caught instanceof Error ? caught.message : 'Could not reach the control plane.',
			0
		);
	}
	if (!response.ok) throw await failure(response);
	return response;
}

/** Call a JSON op (`info`, `tree`, `describe`, `explain`, `apply`, `value`). */
export async function studioCall<Op extends StudioJsonOp>(
	databaseName: string,
	op: Op,
	body: StudioCallBody<Op>,
	signal?: AbortSignal
): Promise<StudioResponses[Op]> {
	const response = await post(databaseName, op, body, 'application/json', signal);
	return (await response.json()) as StudioResponses[Op];
}

/**
 * Stream a `browse` or `run` call's events. Abort `signal` to stop: the abort travels through the
 * proxy and the node to the engine.
 */
export async function* studioStream<Op extends StudioStreamOp>(
	databaseName: string,
	op: Op,
	body: StudioCallBody<Op>,
	signal?: AbortSignal
): AsyncGenerator<StudioEvent> {
	const response = await post(databaseName, op, body, 'application/x-ndjson', signal);
	if (!response.body)
		throw new StudioCallError('internal', 'The studio sent an empty stream.', 500);
	try {
		yield* decodeEvents(response.body);
	} catch (caught) {
		if (signal?.aborted) throw new StudioCallError('cancelled', 'Cancelled.', 499);
		if (caught instanceof StudioCallError) throw caught;
		throw new StudioCallError(
			'network',
			caught instanceof Error ? caught.message : 'The result stream broke off.',
			0
		);
	}
}
