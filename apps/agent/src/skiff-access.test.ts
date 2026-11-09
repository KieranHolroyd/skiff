import { describe, expect, test } from 'bun:test';
import { sha256Hex, type RouteSpec } from '@skiff/contracts';
import {
	AccessDecisionCache,
	accessDecisionCacheKey,
	handleSkiffAccessRequest,
	ServiceTokenTouchThrottle,
	type SkiffAccessOptions,
} from './skiff-access.ts';

/**
 * Last-used reporting for machine tokens is best effort: the edge decision stays local, the report
 * is fire-and-forget, and the throttle keeps it to one per token a minute.
 */

const secret = 'skiff_svc_agent_token';
const policyId = 'apol_1';

function route(): RouteSpec {
	return {
		projectId: 'proj_1',
		slug: 'site',
		host: 'site.test',
		deploymentId: 'dep_1',
		release: 'a'.repeat(64),
		accessMode: 'access',
		spa: false,
		cleanUrls: true,
		trailingSlash: 'ignore',
		notFound: null,
		redirects: [],
		headers: [],
		upstream: null,
		access: {
			mode: 'access',
			siteKey: 'site-key-for-tests-0123456789',
			loginUrl: 'https://control.test/api/v1/access/authorize',
			policyId,
			policyEnabled: true,
			serviceTokens: [
				{ header: 'x-skiff-token', tokenHash: sha256Hex(secret), action: 'allow' },
			],
			hasPersonRules: true,
		},
	};
}

function request(): Request {
	return new Request('http://agent.local/_skiff/verify', {
		headers: { 'x-forwarded-host': 'site.test', 'x-skiff-token': secret },
	});
}

/** A browser request: no machine token, so the handler reaches the cookie/login path. */
function browserRequest(): Request {
	return new Request('http://agent.local/_skiff/verify', {
		headers: { 'x-forwarded-host': 'site.test' },
	});
}

function options(
	touches: Array<{ policyId: string; header: string; tokenHash: string }>,
): SkiffAccessOptions {
	return {
		accessCookieName: '__skiff_a',
		insecureHttp: true,
		touchThrottle: new ServiceTokenTouchThrottle(),
		touchServiceToken: (input) => touches.push(input),
	};
}

describe('service token last-used reporting', () => {
	test('the throttle allows one report per token a minute', () => {
		const throttle = new ServiceTokenTouchThrottle();
		expect(throttle.shouldTouch('apol_1|hash', 1_000)).toBe(true);
		expect(throttle.shouldTouch('apol_1|hash', 30_000)).toBe(false);
		expect(throttle.shouldTouch('apol_1|hash', 61_000)).toBe(true);
		expect(throttle.shouldTouch('apol_2|hash', 61_000)).toBe(true);
	});

	test('a matching machine token reports its hash without blocking the allow', () => {
		const touches: Array<{ policyId: string; header: string; tokenHash: string }> = [];
		const opts = options(touches);
		const first = handleSkiffAccessRequest(
			request(),
			opts,
			route(),
			'site.test',
			null,
			1_000,
		);
		expect(first.status).toBe(200);
		expect(first.headers.get('Skiff-Access-Identity')).toBe('service');
		expect(touches).toEqual([
			{ policyId, header: 'x-skiff-token', tokenHash: sha256Hex(secret) },
		]);

		// The same token inside a minute is still allowed, but not reported again.
		expect(
			handleSkiffAccessRequest(request(), opts, route(), 'site.test', null, 1_030).status,
		).toBe(200);
		expect(touches).toHaveLength(1);

		// After the throttle window the next request reports again.
		expect(
			handleSkiffAccessRequest(request(), opts, route(), 'site.test', null, 1_061).status,
		).toBe(200);
		expect(touches).toHaveLength(2);
	});
});

describe('Skiff Access decision cache', () => {
	test('a negative login/deny decision expires after its short TTL', () => {
		const cache = new AccessDecisionCache(15_000, 100, 2_000);
		cache.setNegative('host|cookie', 1_000, 'login');
		expect(cache.getNegative('host|cookie', 1_000)).toBe('login');
		expect(cache.getNegative('host|cookie', 2_999)).toBe('login');
		expect(cache.getNegative('host|cookie', 3_001)).toBeNull();
		expect(cache.negativeSize).toBe(0);

		cache.setNegative('host|machine', 1_000, 'deny');
		expect(cache.getNegative('host|machine', 1_500)).toBe('deny');
	});

	test('the cache key changes when the policy version (site key) changes', () => {
		const first = route();
		const rotated = route();
		rotated.access.siteKey = 'site-key-after-a-policy-edit-9876543210';
		expect(accessDecisionCacheKey(first, 'site.test', null)).not.toBe(
			accessDecisionCacheKey(rotated, 'site.test', null),
		);
		// A different cookie (the visitor just signed in) is also a different key.
		expect(accessDecisionCacheKey(first, 'site.test', 'v1.cookie')).not.toBe(
			accessDecisionCacheKey(first, 'site.test', null),
		);
	});

	test('a cached login redirect does not hide a freshly minted cookie', () => {
		const cache = new AccessDecisionCache(15_000, 100, 2_000);
		const browserRoute = route();
		browserRoute.access.serviceTokens = [];
		const opts = { ...options([]), cache };
		// Anonymous: no cookie or machine token, so the handler redirects and caches login.
		expect(
			handleSkiffAccessRequest(browserRequest(), opts, browserRoute, 'site.test', null, 1_000).status,
		).toBe(302);
		const anonymousKey = accessDecisionCacheKey(browserRoute, 'site.test', null);
		expect(cache.getNegative(anonymousKey, 1_000)).toBe('login');
		// The signed-in cookie lands on a different key, so the redirect cache never masks it.
		expect(accessDecisionCacheKey(browserRoute, 'site.test', 'v1.cookie')).not.toBe(anonymousKey);
	});
});
