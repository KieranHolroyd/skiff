import type { Cookies, RequestEvent } from '@sveltejs/kit';
import {
	USER_POOL_SESSION_TTL_SECONDS,
	safeEqual,
	userPoolCsrfCookieName,
	userPoolSessionCookieName
} from '@yoal/core';
import { platformOrigin } from '#lib/server/config.js';

/**
 * Small helpers shared by the hosted pool pages. These deliberately do not import the platform's
 * session, auth or principal modules: a pool visitor only ever has a pool session cookie.
 */

const attempts = new Map<string, number[]>();
const MAX_TRACKED_KEYS = 10_000;

/** A rolling-window limit for sign-in and sign-up forms, keyed by address and client. */
export function allowAttempt(key: string, limit = 10, windowMs = 60_000): boolean {
	const now = Date.now();
	const recent = (attempts.get(key) ?? []).filter((at) => now - at < windowMs);
	if (recent.length >= limit) {
		attempts.set(key, recent);
		return false;
	}
	recent.push(now);
	attempts.delete(key);
	attempts.set(key, recent);
	if (attempts.size > MAX_TRACKED_KEYS) {
		for (const [entry, times] of attempts)
			if (times.every((at) => now - at >= windowMs)) attempts.delete(entry);
	}
	return true;
}

/** The request's client address, or a stable fallback when the adapter cannot provide one. */
export function clientKey(event: RequestEvent): string {
	try {
		return event.getClientAddress();
	} catch {
		return 'unknown';
	}
}

/** Double-submit CSRF check: the hidden form field must equal the cookie the layout set. */
export function validCsrf(cookies: Cookies, poolId: string, submitted: FormDataEntryValue | null): boolean {
	const expected = cookies.get(userPoolCsrfCookieName(poolId));
	const value = typeof submitted === 'string' ? submitted : '';
	return Boolean(expected && value && safeEqual(expected, value));
}

export function poolSessionToken(cookies: Cookies, poolId: string): string | undefined {
	return cookies.get(userPoolSessionCookieName(poolId));
}

export function setPoolSession(cookies: Cookies, poolId: string, token: string): void {
	cookies.set(userPoolSessionCookieName(poolId), token, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: platformOrigin.startsWith('https://'),
		maxAge: USER_POOL_SESSION_TTL_SECONDS
	});
}

export function clearPoolSession(cookies: Cookies, poolId: string): void {
	cookies.delete(userPoolSessionCookieName(poolId), { path: '/' });
}
