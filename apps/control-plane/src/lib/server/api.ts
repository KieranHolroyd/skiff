import * as z from 'zod';
import { CoreError, ForbiddenError } from '@skiff/core';
import { ZodError } from 'zod';

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
	if (error instanceof ForbiddenError) return json({ error: 'forbidden', permission: error.permission, message: error.message }, 403);
	// `@skiff/contracts`' requirePermission throws its own ForbiddenError, which is not a CoreError.
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
			{ error: error.code, message: error.message, ...(('suggestions' in error && Array.isArray(error.suggestions)) ? { suggestions: error.suggestions } : {}) },
			error.status,
		);
	if (error instanceof Response) return error;
	console.error('[api]', error);
	return json({ error: 'internal', message: 'Internal server error' }, 500);
}

/**
 * `@skiff/contracts`' ForbiddenError is a separate class from `@skiff/core`'s. Identify it by its
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
