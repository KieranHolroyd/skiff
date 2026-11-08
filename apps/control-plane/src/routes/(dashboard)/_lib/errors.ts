import { ConflictError, CoreError } from '@skiff/core';
import { reportRequestError } from '#lib/server/server-errors.js';

export interface FormFailure {
	message: string;
	code?: string;
	suggestions?: string[];
	fieldErrors?: Record<string, string>;
}

/** Turn a service-layer error into something safe (and useful) to render above a form. */
export function toFormFailure(error: unknown): FormFailure {
	if (error instanceof ConflictError) {
		return {
			message: error.message,
			code: error.code,
			suggestions: error.suggestions.length > 0 ? error.suggestions : undefined
		};
	}
	if (error instanceof CoreError) {
		return { message: error.message, code: error.code };
	}
	console.error('[dashboard] unexpected action error:', error);
	// The form shows a generic message; Settings → Server errors keeps the real one.
	reportRequestError(error, { source: 'request' });
	return {
		message: 'Something went wrong while saving. Please try again.',
		code: 'internal_error'
	};
}

export function failStatus(error: unknown): 400 | 401 | 403 | 404 | 409 | 422 | 429 {
	if (error instanceof CoreError) {
		if ([400, 401, 403, 404, 409, 422, 429].includes(error.status)) {
			return error.status as 400 | 401 | 403 | 404 | 409 | 422 | 429;
		}
	}
	return 400;
}

export function formString(data: FormData, key: string): string {
	const value = data.get(key);
	return typeof value === 'string' ? value.trim() : '';
}

/** Like `formString` but preserves whitespace, which matters for passwords. */
export function formRawString(data: FormData, key: string): string {
	const value = data.get(key);
	return typeof value === 'string' ? value : '';
}

export function formOptionalString(data: FormData, key: string): string | undefined {
	const value = formString(data, key);
	return value.length > 0 ? value : undefined;
}

export function formBoolean(data: FormData, key: string): boolean {
	const value = data.get(key);
	return value === 'true' || value === 'on' || value === '1';
}

export function formOptionalPositiveInt(data: FormData, key: string): number | undefined | null {
	const raw = formString(data, key);
	if (!raw) return undefined;
	const value = Number(raw);
	if (!Number.isInteger(value) || value <= 0) return null;
	return value;
}
