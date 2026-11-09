import { json } from '@sveltejs/kit';
import { CoreError } from '@yoal/core';

/** JSON endpoints never cache a challenge or a session decision. */
export const NO_STORE = { 'cache-control': 'no-store' } as const;

/** Parse a JSON request body, returning an empty object for anything malformed. */
export async function readBody(request: Request): Promise<Record<string, unknown>> {
	try {
		const value: unknown = await request.json();
		return value && typeof value === 'object' && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

/** A string member of a JSON body, or null for anything else. */
export function bodyString(body: Record<string, unknown>, key: string): string | null {
	const value = body[key];
	return typeof value === 'string' ? value : null;
}

/** A JSON error response. Engine messages are already enumeration-safe for the sign-in paths. */
export function apiError(error: unknown): Response {
	if (error instanceof CoreError)
		return json({ error: error.message }, { status: error.status, headers: NO_STORE });
	// Name only: a library error message can quote the credential or the response body.
	console.error(`[user-pool] passkey endpoint failed (${error instanceof Error ? error.name : 'unknown'}).`);
	return json({ error: 'Passkeys are unavailable right now. Try again.' }, { status: 500, headers: NO_STORE });
}
