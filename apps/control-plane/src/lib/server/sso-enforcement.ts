/**
 * Sign-in policy enforcement (IAM.md I19/I21, §8.3–§8.5).
 *
 * Better Auth owns the sign-in endpoints; this module answers "may this person sign in this way?"
 * from the stored org auth policy. Two callers use it:
 *
 * - `auth.ts` before a password or magic-link endpoint runs (so the user sees a useful refusal);
 * - `auth.ts` in `session.create.before` and `hooks.server.ts` as the backstop for every method,
 *   including GitHub, passkey and SSO, where the identity is only known after the round trip.
 *
 * `require_sso` is per organisation, not per email domain, once a session exists: a member of an
 * organisation that enforces SSO may only sign in through its IdP. Break-glass owners (IAM.md §8.3)
 * keep the other methods. A second-factor challenge is separate and remains in
 * `second-factor-policy.ts`.
 */
import { sqlite } from './db';
import { core } from './core';

export type SignInMethod = 'password' | 'passkey' | 'github' | 'gitlab' | 'magic-link' | 'sso';

/** Which Better Auth endpoint a session was created by, or `undefined` for unknown flows. */
export function signInMethodFromPath(path: string | undefined): SignInMethod | undefined {
	if (!path) return undefined;
	if (path.startsWith('/sso/callback') || path.startsWith('/sso/saml2/sp/acs')) return 'sso';
	if (path.startsWith('/callback/gitlab')) return 'gitlab';
	if (path.startsWith('/callback/')) return 'github';
	if (path === '/passkey/verify-authentication' || path === '/passkey/verify-registration')
		return 'passkey';
	if (path === '/magic-link/verify') return 'magic-link';
	if (path === '/sign-in/email') return 'password';
	return undefined;
}

/** The address a password or magic-link request is for, when the endpoint carries one. */
export function signInEmailFromPath(
	path: string,
	body: unknown
): { email: string; method: SignInMethod } | undefined {
	if (path !== '/sign-in/email' && path !== '/sign-in/magic-link') return undefined;
	const email = (body as { email?: unknown } | undefined)?.email;
	if (typeof email !== 'string' || !email.trim()) return undefined;
	return { email: email.trim().toLowerCase(), method: path === '/sign-in/email' ? 'password' : 'magic-link' };
}

function emailDomain(email: string): string | null {
	const at = email.lastIndexOf('@');
	if (at <= 0 || at === email.length - 1) return null;
	return email.slice(at + 1).trim().toLowerCase() || null;
}

/** Whether this owner is explicitly exempt from `require_sso`. */
export function isBreakGlassOwner(userId: string, orgId: string): boolean {
	const policy = core.authPolicy.forOrg(orgId);
	if (!policy.breakGlassUserIds.includes(userId)) return false;
	const row = sqlite
		.query<{ role: string }, [string, string]>(
			'SELECT role FROM member WHERE organizationId = ? AND userId = ?'
		)
		.get(orgId, userId);
	return row?.role === 'owner';
}

interface Membership {
	organizationId: string;
	role: string;
}

function memberships(userId: string): Membership[] {
	try {
		return sqlite
			.query<Membership, [string]>('SELECT organizationId, role FROM member WHERE userId = ?')
			.all(userId);
	} catch {
		return [];
	}
}

/**
 * Why this user may not sign in with this method, across every org they belong to. `undefined`
 * means allowed. A user with no memberships is judged only by `signInRefusalForEmail`'s domain check.
 */
export function signInRefusalForUser(userId: string, method: SignInMethod): string | undefined {
	for (const membership of memberships(userId)) {
		const policy = core.authPolicy.forOrg(membership.organizationId);
		if (!policy.allowedMethods.includes(method))
			return `Your organisation does not allow ${methodLabel(method)} sign-in. Use one of: ${policy.allowedMethods.join(', ')}.`;
		if (policy.requireSso && method !== 'sso') {
			// Break-glass keeps a strong local path only: a passkey, or a password followed by the
			// owner second factor. GitHub and magic links stay refused (IAM.md §8.3).
			const breakGlass = isBreakGlassOwner(userId, membership.organizationId);
			const strong = method === 'passkey' || method === 'password';
			if (!breakGlass || !strong)
				return 'Your organisation requires single sign-on. Sign in through your identity provider.';
		}
	}
	return undefined;
}

/**
 * `require_sso` for a session created before `signInMethod` was recorded. It has no method to
 * judge, so any enforcing org the user belongs to makes the session unfit until they sign in
 * through the IdP (or a break-glass owner signs in again).
 */
export function requireSsoRefusalForUser(userId: string): string | undefined {
	for (const membership of memberships(userId)) {
		const policy = core.authPolicy.forOrg(membership.organizationId);
		if (policy.requireSso && !isBreakGlassOwner(userId, membership.organizationId))
			return 'Your organisation requires single sign-on. Sign in through your identity provider.';
	}
	return undefined;
}

/** Pre-session check for password and magic-link sign-in, where the address is known. */
export function signInRefusalForEmail(
	email: string,
	method: SignInMethod
): string | undefined {
	let user: { id: string } | null | undefined;
	try {
		user = sqlite
			.query<{ id: string }, [string]>('SELECT id FROM user WHERE lower(email) = ? LIMIT 1')
			.get(email.toLowerCase());
	} catch {
		return undefined;
	}
	if (user) return signInRefusalForUser(user.id, method);

	// No account yet: invite-only already refuses creation, but an address on an enforced domain
	// should be pointed at the IdP instead of at a password form that cannot work.
	if (method === 'sso') return undefined;
	const domain = emailDomain(email);
	if (!domain) return undefined;
	try {
		const enforcing = sqlite
			.query<{ org_id: string }, [string]>(
				`SELECT d.org_id FROM sso_domains d
				 JOIN org_auth_policies p ON p.org_id = d.org_id
				 WHERE d.domain = ? AND d.verified_at IS NOT NULL AND p.require_sso = 1`
			)
			.all(domain);
		if (enforcing.length > 0)
			return 'Your organisation requires single sign-on. Sign in through your identity provider.';
	} catch {
		// No policy table (migration 0089 not applied): no enforcement to report.
	}
	return undefined;
}

function methodLabel(method: SignInMethod): string {
	switch (method) {
		case 'magic-link':
			return 'email-link';
		case 'github':
			return 'GitHub';
		case 'gitlab':
			return 'GitLab';
		case 'sso':
			return 'single sign-on';
		case 'passkey':
			return 'passkey';
		case 'password':
			return 'password';
	}
}
