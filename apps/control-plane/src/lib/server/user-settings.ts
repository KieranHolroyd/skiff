import { describeUserAgent } from '../user-agent.js';

/**
 * Presentation helpers for the account settings module. They deliberately accept plain shapes
 * instead of Better Auth's generic endpoint types so the dashboard and tests can share them.
 */

export interface AuthSessionLike {
	id: string;
	token: string;
	createdAt: Date | string | number;
	updatedAt: Date | string | number;
	expiresAt: Date | string | number;
	ipAddress?: string | null;
	userAgent?: string | null;
}

/** A session as rendered in the dashboard. The session token never leaves the server. */
export interface SessionSummary {
	id: string;
	current: boolean;
	createdAt: string | null;
	lastActiveAt: string | null;
	expiresAt: string | null;
	ipAddress: string | null;
	userAgent: string | null;
	device: string;
}

export function toIso(value: Date | string | number | null | undefined): string | null {
	if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
	if (typeof value === 'string' && value.length > 0) {
		const date = new Date(value);
		return Number.isNaN(date.getTime()) ? null : date.toISOString();
	}
	if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
	return null;
}

/**
 * Sort most recently used first, but always keep the current session at the top. Expired
 * sessions are omitted: Better Auth can leave them behind until cleanup runs.
 */
export function toSessionSummaries(
	sessions: readonly AuthSessionLike[],
	currentSessionId: string | null,
	now = Date.now()
): SessionSummary[] {
	return sessions
		.filter((session) => {
			const expiresAt = toIso(session.expiresAt);
			return expiresAt === null || Date.parse(expiresAt) > now;
		})
		.map((session) => ({
			id: session.id,
			current: session.id === currentSessionId,
			createdAt: toIso(session.createdAt),
			lastActiveAt: toIso(session.updatedAt),
			expiresAt: toIso(session.expiresAt),
			ipAddress: session.ipAddress ?? null,
			userAgent: session.userAgent ?? null,
			device: describeUserAgent(session.userAgent)
		}))
		.sort((a, b) => {
			if (a.current !== b.current) return a.current ? -1 : 1;
			return (
				(b.lastActiveAt ? Date.parse(b.lastActiveAt) : 0) -
				(a.lastActiveAt ? Date.parse(a.lastActiveAt) : 0)
			);
		});
}

export function providerLabel(providerId: string): string {
	switch (providerId) {
		case 'credential':
			return 'Email & password';
		case 'github':
			return 'GitHub';
		case 'gitlab':
			return 'GitLab';
		case 'passkey':
			return 'Passkey';
		case 'magic-link':
			return 'Email link';
		default:
			return providerId;
	}
}

/** Better Auth throws `APIError` (and sometimes a plain Error); keep the useful message only. */
export function authErrorMessage(
	error: unknown,
	fallback = 'The auth service rejected the request. Please try again.'
): string {
	if (error && typeof error === 'object') {
		const body = 'body' in error ? error.body : undefined;
		if (body && typeof body === 'object' && 'message' in body && typeof body.message === 'string') {
			return body.message;
		}
		if ('message' in error && typeof error.message === 'string' && error.message.length > 0) {
			return error.message;
		}
	}
	return fallback;
}
