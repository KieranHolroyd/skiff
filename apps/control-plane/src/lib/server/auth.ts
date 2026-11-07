import { betterAuth, type BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { admin, jwt, magicLink, organization, twoFactor } from 'better-auth/plugins';
import { passkey } from '@better-auth/passkey';
import { apiKey } from '@better-auth/api-key';
import { createAccessControl } from 'better-auth/plugins/access';
import { defaultStatements } from 'better-auth/plugins/organization/access';
import { sveltekitCookies } from 'better-auth/svelte-kit';
import { mcp } from '@better-auth/mcp';
import { cimd } from '@better-auth/cimd';
import { fetchClientMetadataResource } from '@better-auth/cimd/node';
import { allPermissions, roles, statements, type Permission, type Role } from '@skiff/contracts';
import { readMembership } from '@skiff/core';
import { getRequestEvent } from '$app/server';
import * as z from 'zod';
import { allowDcr, authSecret, contentDomain, github, mcpResource, openSignup, platformOrigin, smtp } from './config';
import { core } from './core';
import { MAGIC_LINK_TTL_SECONDS, sendInviteEmail, sendMagicLinkEmail, sendPasswordResetEmail } from './email';
import {
	PASSWORD_RESET_TTL_SECONDS,
	ResetThrottle,
	deleteResetTokens,
	discardResetToken,
	hashRequestIp,
	recordPasswordReset,
} from './password-reset';
import {
	enforceOwnerSecondFactor,
	markSessionSecondFactor,
	recordSecondFactorFailure,
	revokeSession,
	secondFactorAttemptsExhausted,
	userHasSecondFactor,
	userIsOwner,
} from './second-factor';
import { OAUTH_AUTHORIZE_PATH, authPathAllowedBeforeSecondFactor, factorProvedBy } from './second-factor-policy';
import { sqlite } from './db';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, SetupAlreadyCompleteError, claimInstance, parseClaimInput } from './setup';
import { isValidSetupToken } from './setup-token';

/**
 * Better Auth: passwords, passkeys, GitHub and magic links (D103), invite-only, 2FA for owners
 * (D10); organizations with the
 * same RBAC statements the API/MCP/CLI use (D9); API keys and MCP OAuth 2.1 (D11).
 */
const ac = createAccessControl({
	...defaultStatements,
	...statements,
	// Both define `member`: keep Better Auth's actions (used by its endpoints) next to Skiff's.
	member: [...defaultStatements.member, ...statements.member],
});

/**
 * Skiff permissions → the Better Auth organization actions its endpoints check, so the same RBAC
 * table (DESIGN §6.2) governs invitations and membership changes. Better Auth itself stops
 * non-owners from inviting or promoting anyone to `owner`.
 */
const betterAuthEquivalents: Partial<Record<Permission, Record<string, string[]>>> = {
	'member:invite': { invitation: ['create', 'cancel'], member: ['create'] },
	'member:update-role': { member: ['update'] },
	'member:remove': { member: ['delete'] },
};

function statementsFor(role: Role): Record<string, string[]> {
	const grouped: Record<string, string[]> = { ac: ['read'] };
	const add = (resource: string, action: string) => {
		const list = (grouped[resource] ??= []);
		if (!list.includes(action)) list.push(action);
	};
	for (const permission of roles[role] as readonly Permission[]) {
		const [resource, action] = permission.split(':') as [string, string];
		add(resource, action);
		for (const [extra, actions] of Object.entries(betterAuthEquivalents[permission] ?? {}))
			for (const extraAction of actions) add(extra, extraAction);
	}
	if (role === 'owner') for (const action of ['update', 'delete']) add('organization', action);
	if (role === 'admin') add('organization', 'update');
	return grouped;
}

const organizationRoles = {
	owner: ac.newRole(statementsFor('owner')),
	admin: ac.newRole(statementsFor('admin')),
	deployer: ac.newRole(statementsFor('deployer')),
	viewer: ac.newRole(statementsFor('viewer')),
};

/** Better Auth's API-key endpoints, gated by the same RBAC permissions as the dashboard (§6.2). */
const apiKeyEndpointPermissions: Record<string, Permission> = {
	'/api-key/create': 'apiKey:create',
	'/api-key/update': 'apiKey:create',
	'/api-key/delete': 'apiKey:revoke',
};

/** True when the user's org role grants `permission` (no membership → false). */
export function userHasOrgPermission(userId: string, permission: Permission): boolean {
	const membership = readMembership(sqlite, userId);
	return membership ? (roles[membership.role] as readonly Permission[]).includes(permission) : false;
}

/**
 * First-run setup (D102, setup.ts). Server-only: never on the HTTP router, so only the `/setup`
 * wizard's form action can call it, and it checks the setup token again itself. Creates the owner,
 * their organisation and membership atomically, then signs them in with an ordinary Better Auth
 * session. That session has proved no second factor, so the owner policy sends it straight to
 * enrolment, which the wizard walks through next.
 */
const claimSetupBody = z.object({
	token: z.string().optional(),
	name: z.string(),
	email: z.string(),
	organizationName: z.string(),
	password: z.string(),
});

const skiffSetup = {
	id: 'skiff-setup',
	endpoints: {
		claimSetup: createAuthEndpoint.serverOnly({ method: 'POST', body: claimSetupBody }, async (ctx) => {
			const body = ctx.body;
			if (!isValidSetupToken(body.token))
				throw new APIError('FORBIDDEN', { message: 'The setup link is not valid. Open the link the installer printed.' });
			const parsed = parseClaimInput(body);
			if (!parsed.ok) throw new APIError('BAD_REQUEST', { message: parsed.message });
			// Hash before the transaction: scrypt is async, the claim itself must not be.
			const { password, ...owner } = parsed.value;
			const passwordHash = await ctx.context.password.hash(password);
			let userId: string;
			try {
				({ userId } = claimInstance(sqlite, { ...owner, passwordHash }));
			} catch (error) {
				if (error instanceof SetupAlreadyCompleteError) throw new APIError('CONFLICT', { message: error.message });
				throw error;
			}
			const user = await ctx.context.internalAdapter.findUserById(userId);
			if (!user) throw new APIError('INTERNAL_SERVER_ERROR', { message: 'The owner account was not saved.' });
			const session = await ctx.context.internalAdapter.createSession(userId);
			if (!session) throw new APIError('INTERNAL_SERVER_ERROR', { message: 'Could not start a session.' });
			await setSessionCookie(ctx, { session, user });
			return ctx.json({ userId });
		}),
	},
} satisfies BetterAuthPlugin;

const API_KEY_RATE_WINDOW_MS = 24 * 60 * 60 * 1000;
const API_KEY_RATE_MAX = 100_000;

const secure = platformOrigin.startsWith('https://');
const platformHost = new URL(platformOrigin).hostname;

/** At most one reset email a minute and five an hour per address (on top of Better Auth's per-IP limit). */
const resetThrottle = new ResetThrottle({ perMinute: 1, perHour: 5 });

/**
 * Better Auth calls this only for an address that has an account, and waits for it before
 * answering. So it returns at once and sends in the background: the response takes as long
 * either way and never says whether the address exists. A link that is not sent (no SMTP, or the
 * address is throttled) is deleted rather than left valid.
 */
async function sendResetPassword({ user, url, token }: { user: { id: string; email: string }; url: string; token: string }) {
	void (async () => {
		if (!smtp) {
			discardResetToken(sqlite, token);
			console.info(`[auth] password reset requested for user ${user.id}, but email is not set up: an operator can run scripts/reset-password.ts`);
			return;
		}
		if (!resetThrottle.take(user.email)) {
			discardResetToken(sqlite, token);
			console.info(`[auth] password reset for user ${user.id} throttled (1 a minute, 5 an hour per address)`);
			return;
		}
		await sendPasswordResetEmail(user.email, url, PASSWORD_RESET_TTL_SECONDS);
	})().catch((error) => console.error('[auth] could not send a password reset email:', error));
}

export const auth = betterAuth({
	baseURL: platformOrigin,
	secret: authSecret,
	database: sqlite,
	// Passwords work everywhere, including plain-HTTP or IP-only installs where passkeys can't (D103).
	// Public password sign-up stays off outside open-signup dev servers: an invitee could otherwise
	// be beaten to their invitation by anyone who knows their address. Passwords are set by the setup
	// wizard or from Settings → Account by a signed-in user.
	emailAndPassword: {
		enabled: true,
		disableSignUp: !openSignup,
		minPasswordLength: MIN_PASSWORD_LENGTH,
		maxPasswordLength: MAX_PASSWORD_LENGTH,
		// Forgot password (password-reset.ts): a 30-minute, single-use link by email. Using it signs
		// out every session and never signs in, so owners still prove a second factor afterwards.
		sendResetPassword,
		resetPasswordTokenExpiresIn: PASSWORD_RESET_TTL_SECONDS,
		revokeSessionsOnPasswordReset: true,
		onPasswordReset: async ({ user }, request) => {
			// One link resets once; any other links sent before it stop working too.
			deleteResetTokens(sqlite, user.id);
			try {
				recordPasswordReset(core.audit, sqlite, { userId: user.id, method: 'email', ipHash: hashRequestIp(request) });
			} catch (error) {
				console.error('[auth] could not audit a password reset:', error);
			}
		},
	},
	// Per IP, in production (Better Auth's default limiter). Request links: 3 a minute (its default,
	// spelled out). Using a token: a handful a minute; tokens are 24 random characters anyway.
	rateLimit: {
		customRules: {
			'/request-password-reset': { window: 60, max: 3 },
			'/reset-password': { window: 60, max: 5 },
			'/reset-password/*': { window: 60, max: 10 },
		},
	},
	socialProviders: github
		? { github: { clientId: github.clientId, clientSecret: github.clientSecret } }
		: {},
	trustedOrigins: [platformOrigin],
	session: {
		additionalFields: {
			// The second factor this session proved ('passkey' | 'totp' | 'backup-code'), set by the
			// after-hook below. Owners need it before using the platform (second-factor-policy.ts).
			secondFactor: { type: 'string', required: false, input: false },
		},
	},
	databaseHooks: {
		user: {
			create: {
				// Invite-only (D10). The owner is created by the setup wizard (D102, `claimSetup`
				// above), never by whoever signs up first: until setup is done, sign-up is refused.
				// Invitations are Better Auth organization invitations by email.
				before: async (user) => {
					const count = sqlite.query<{ count: number }, []>('SELECT count(*) AS count FROM user').get();
					if ((count?.count ?? 0) === 0) {
						if (!openSignup)
							throw new APIError('FORBIDDEN', {
								message: 'Skiff is not set up yet. Open the setup link the installer printed.',
							});
						// Dev/open-signup installs: the first user is the platform admin (DESIGN §6.2).
						return { data: { ...user, role: 'admin' } };
					}
					if (openSignup) return;
					const invited = sqlite
						.query<{ id: string }, [string, string]>(
							"SELECT id FROM invitation WHERE lower(email) = ? AND status = 'pending' AND expiresAt > ?",
						)
						// Better Auth stores dates as ISO-8601 text; comparing against a number would always
						// pass in SQLite (text sorts after numbers), letting expired invitations sign up.
						.get(user.email.toLowerCase(), new Date().toISOString());
					if (!invited)
						throw new APIError('FORBIDDEN', {
							message: 'Skiff is invite-only. Ask an owner to invite your email address.',
						});
				},
			},
		},
	},
	hooks: {
		before: createAuthMiddleware(async (ctx) => {
			// Trusted in-process calls without request headers (e.g. the CLI token exchange) do their
			// own checks; anything carrying a user session is held to that user's role and factor.
			if (!ctx.request && !ctx.headers) return;
			const session = await getSessionFromCtx(ctx);
			if (!session) return; // the endpoint itself rejects unauthenticated calls

			// Owner second factor (D10): an unproven owner session may only sign in, verify a factor,
			// or (with no factor yet) enrol one. See second-factor-policy.ts.
			const sessionFactor = (session.session as { secondFactor?: string | null }).secondFactor;
			if (enforceOwnerSecondFactor && !sessionFactor && userIsOwner(session.user.id)) {
				if (secondFactorAttemptsExhausted(session.session.id)) {
					revokeSession(session.session.id);
					throw new APIError('TOO_MANY_REQUESTS', {
						message: 'Too many incorrect codes. Sign in again to retry.',
					});
				}
				// An MCP client's authorization request resumes after the challenge rather than failing.
				if (ctx.path === OAUTH_AUTHORIZE_PATH && ctx.request?.method === 'GET') {
					const url = new URL(ctx.request.url);
					throw ctx.redirect(`/two-factor?redirect=${encodeURIComponent(`${url.pathname}${url.search}`)}`);
				}
				if (!authPathAllowedBeforeSecondFactor(ctx.path, userHasSecondFactor(session.user.id)))
					throw new APIError('FORBIDDEN', {
						message: 'Verify your second factor (passkey or authenticator app) first.',
						code: 'SECOND_FACTOR_REQUIRED',
					});
			}

			const permission = apiKeyEndpointPermissions[ctx.path];
			if (permission && !userHasOrgPermission(session.user.id, permission))
				throw new APIError('FORBIDDEN', { message: `Your role does not include ${permission}.` });
		}),
		after: createAuthMiddleware(async (ctx) => {
			const factor = factorProvedBy(ctx.path);
			if (!factor) return;
			if (ctx.context.returned instanceof APIError) {
				// Better Auth limits attempts during password sign-in, but not when a signed-in session
				// verifies a code. Cap guesses from an unproven owner session; passkey failures prove
				// nothing either way.
				if (factor === 'passkey') return;
				const session = await getSessionFromCtx(ctx).catch(() => null);
				const proven = (session?.session as { secondFactor?: string | null } | undefined)?.secondFactor;
				if (!session || proven || !userIsOwner(session.user.id)) return;
				if (recordSecondFactorFailure(session.session.id)) revokeSession(session.session.id);
				return;
			}
			// Sign-in and first-time TOTP verification create a new session; otherwise it's this one.
			const sessionId =
				ctx.context.newSession?.session.id ?? (await getSessionFromCtx(ctx).catch(() => null))?.session.id;
			if (sessionId) markSessionSecondFactor(sessionId, factor);
		}),
	},
	advanced: {
		// `__Host-` cookies only (DESIGN §5, D19): no Domain attribute, Secure, Path=/.
		cookiePrefix: secure ? '__Host-skiff' : 'skiff',
		useSecureCookies: secure,
	},
	plugins: [
		// Stable signing key for access/ID tokens + /jwks (required by mcp()).
		jwt(),
		// mcp() *is* the OAuth 2.1 provider — never also register oauthProvider().
		mcp({
			resource: mcpResource,
			loginPage: '/login',
			consentPage: '/consent',
			scopes: ['openid', 'profile', 'email', 'offline_access', ...allPermissions],
			allowDynamicClientRegistration: allowDcr,
			allowUnauthenticatedClientRegistration: allowDcr,
			clientRegistrationDefaultApplicationType: 'infer',
		}),
		cimd({ fetchClientMetadataResource, metadataProfile: 'mcp-2026-07-28' }),
		organization({
			ac,
			roles: organizationRoles,
			creatorRole: 'owner',
			// Orgs come from bootstrap (or open signup) and invitations, never self-service (D10).
			allowUserToCreateOrganization: false,
			organizationLimit: 10,
			membershipLimit: 100,
			sendInvitationEmail: async ({ id, email, organization }) => {
				await sendInviteEmail(
					email,
					organization.name,
					`${platformOrigin}/accept-invitation/${id}`,
				);
			},
		}),
		admin(),
		passkey({ rpID: platformHost, rpName: 'Skiff', origin: platformOrigin }),
		// Accounts without a password (passkey/GitHub/magic link) enrol TOTP without one; accounts with
		// a password must re-enter it to add or remove the app (Better Auth's rule, D103).
		twoFactor({ issuer: 'Skiff', allowPasswordless: true }),
		apiKey({
			defaultPrefix: 'skif_',
			enableMetadata: true,
			// The plugin default (10 per 24h) locks out the CLI after a handful of deploys.
			rateLimit: { enabled: true, timeWindow: API_KEY_RATE_WINDOW_MS, maxRequests: API_KEY_RATE_MAX },
		}),
		magicLink({
			expiresIn: MAGIC_LINK_TTL_SECONDS,
			sendMagicLink: async ({ email, url }) => {
				await sendMagicLinkEmail(email, url);
			},
		}),
		skiffSetup,
		// Must stay last: it copies Set-Cookie from server-side calls onto the SvelteKit response.
		sveltekitCookies(getRequestEvent),
	],
});

/**
 * Keys snapshot their rate limit into their own row at creation, so raising the plugin default
 * doesn't reach existing keys. Lift any key still on the old plugin default (10 per 24h).
 */
export function backfillApiKeyRateLimits(): number {
	const result = sqlite
		.query('UPDATE apikey SET rateLimitMax = ?, rateLimitTimeWindow = ? WHERE rateLimitMax = 10 AND rateLimitTimeWindow = ?')
		.run(API_KEY_RATE_MAX, API_KEY_RATE_WINDOW_MS, API_KEY_RATE_WINDOW_MS);
	return result.changes;
}

/**
 * Installs that predate the platform-admin role have no `admin` user. Promote the earliest user
 * (the bootstrap owner) so fleet management keeps working after the upgrade.
 */
export function ensurePlatformAdmin(): string | undefined {
	const hasAdmin = sqlite
		.query<{ id: string }, []>("SELECT id FROM user WHERE ',' || replace(coalesce(role, ''), ' ', '') || ',' LIKE '%,admin,%' LIMIT 1")
		.get();
	if (hasAdmin) return undefined;
	const first = sqlite.query<{ id: string }, []>('SELECT id FROM user ORDER BY createdAt ASC LIMIT 1').get();
	if (!first) return undefined;
	sqlite.run("UPDATE user SET role = 'admin' WHERE id = ?", [first.id]);
	return first.id;
}

export type Session = typeof auth.$Infer.Session;
export { contentDomain };
