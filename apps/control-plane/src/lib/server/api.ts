import * as z from 'zod';
import { CoreError, ForbiddenError } from '@yoal/core';
import { ZodError } from 'zod';
import { reportRequestError } from './server-errors';

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
	});
}

export async function readJson<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw new CoreError('invalid_json', 'Request body must be valid JSON', 400);
	}
	const parsed = schema.safeParse(body);
	if (!parsed.success) throw parsed.error;
	return parsed.data;
}

export function errorResponse(error: unknown): Response {
	if (error instanceof ZodError)
		return json({ error: 'validation', issues: error.issues.map((issue) => ({ path: issue.path, message: issue.message })) }, 422);
	// STEP-UP.md §6: a fresh verification is needed before this permission can be used. The client
	// recognises the shape, verifies (later slice) and retries the same request once.
	const stepUp = stepUpRequiredFrom(error);
	if (stepUp)
		return json(
			{ error: 'step_up_required', permission: stepUp.permission, level: stepUp.level },
			403
		);
	if (error instanceof ForbiddenError) return json({ error: 'forbidden', permission: error.permission, message: error.message }, 403);
	// `@yoal/contracts`' requirePermission throws its own ForbiddenError, which is not a CoreError.
	// Match it by name + permission so a missing permission is a 403 rather than a 500.
	const contractForbidden = forbiddenFromContracts(error);
	if (contractForbidden)
		return json(
			{
				error: 'forbidden',
				permission: contractForbidden.permission,
				message: contractForbidden.message,
			},
			403,
		);
	if (error instanceof CoreError)
		return json(
			{
				error: error.code,
				message: error.message,
				...(('suggestions' in error && Array.isArray(error.suggestions)) ? { suggestions: error.suggestions } : {}),
				// A core ValidationError carries zod issues; surface them like a request-body 422.
				...(('issues' in error && Array.isArray(error.issues) && error.issues.length)
					? { issues: (error.issues as Array<{ path?: unknown; message?: unknown }>).map((issue) => ({ path: issue.path ?? [], message: String(issue.message ?? '') })) }
					: {}),
			},
			error.status,
		);
	if (error instanceof Response) return error;
	console.error('[api]', error);
	// Settings → Server errors; the id lets a caller quote the failure to an admin.
	const errorId = reportRequestError(error, { source: 'api' });
	return json({ error: 'internal', message: 'Internal server error', ...(errorId ? { errorId } : {}) }, 500);
}

/**
 * `@yoal/contracts`' `StepUpRequiredError` is not a `CoreError`, so identify it by its class name
 * and required `permission`/`level` fields (the same treatment as `forbiddenFromContracts`).
 */
function stepUpRequiredFrom(
	error: unknown,
): { permission: string; level: 'window' | 'always' } | null {
	if (typeof error !== 'object' || error === null) return null;
	const candidate = error as { name?: unknown; permission?: unknown; level?: unknown };
	if (candidate.name !== 'StepUpRequiredError' || typeof candidate.permission !== 'string') return null;
	return {
		permission: candidate.permission,
		level: candidate.level === 'always' ? 'always' : 'window',
	};
}

/**
 * `@yoal/contracts`' ForbiddenError is a separate class from `@yoal/core`'s. Identify it by its
 * class name and required `permission` property instead of relying on `instanceof`.
 */
function forbiddenFromContracts(
	error: unknown,
): { permission: string; message: string } | null {
	if (typeof error !== 'object' || error === null) return null;
	const candidate = error as { name?: unknown; permission?: unknown; message?: unknown };
	if (candidate.name !== 'ForbiddenError' || typeof candidate.permission !== 'string') return null;
	return {
		permission: candidate.permission,
		message:
			typeof candidate.message === 'string'
				? candidate.message
				: `Missing permission ${candidate.permission}`,
	};
}

/** Wrap a handler so every error becomes a consistent JSON response. */
export function route<T>(handler: () => Promise<T> | T): Promise<Response> {
	return Promise.resolve()
		.then(handler)
		.then((value) => (value instanceof Response ? value : json(value)))
		.catch(errorResponse);
}
