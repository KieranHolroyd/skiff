import { fail, redirect, type Cookies } from '@sveltejs/kit';
import { auth } from '#lib/server/auth.js';
import { contentDomain, features, github, objectStoreKind, platformOrigin, sharedDomain, smtp } from '#lib/server/config.js';
import { sqlite } from '#lib/server/db.js';
import {
	enforceOwnerSecondFactor,
	userHasPasskey,
	userHasPassword,
	userHasSecondFactor,
	userHasTotp
} from '#lib/server/second-factor.js';
import { secondFactorState } from '#lib/server/second-factor-policy.js';
import { SETUP_COOKIE, needsSetup, parseClaimInput } from '#lib/server/setup.js';
import { currentSetupToken, isValidSetupToken } from '#lib/server/setup-token.js';
import { formPassword, startTotpEnrolment, totpCode, verifyTotpCode } from '#lib/server/totp-enrolment.js';
import { authErrorMessage } from '#lib/server/user-settings.js';
import { platformVersion } from '#lib/server/version.js';
import type { Actions, PageServerLoad, RequestEvent } from './$types';

/**
 * First-run setup wizard (DESIGN §12, D102). Phases:
 *  - `wrong-host`: opened on another hostname (an IP, or before DNS moved). Cookies, CSRF and
 *    passkeys are all bound to the platform origin, so setup has to happen there.
 *  - `locked`: no valid setup token yet; asks for the link or token.
 *  - `account`: token verified (held in an httpOnly cookie), shows instance checks and the
 *    owner form (name, email, organisation, password: D103).
 *  - `secure`: the owner exists and is signed in, but has no second factor yet.
 *  - `done`: the owner's session is fully set up; offers a backup factor and next steps.
 */

const COOKIE_MAX_AGE = 6 * 60 * 60;
const platformHost = new URL(platformOrigin).host;

function setupCookie(cookies: Cookies, url: URL, token: string) {
	cookies.set(SETUP_COOKIE, token, {
		path: '/setup',
		httpOnly: true,
		sameSite: 'strict',
		secure: url.protocol === 'https:',
		maxAge: COOKIE_MAX_AGE
	});
}

function instanceFacts() {
	const nodes = sqlite.query<{ count: number }, []>('SELECT count(*) AS count FROM nodes').get();
	return {
		platformOrigin,
		https: platformOrigin.startsWith('https://'),
		contentDomain,
		sharedDomain,
		email: smtp ? ('smtp' as const) : ('console' as const),
		github: Boolean(github),
		objectStore: objectStoreKind,
		nodes: nodes?.count ?? 0,
		version: platformVersion,
		features
	};
}

function sessionFactor(locals: App.Locals): string | null {
	return (locals.session as { secondFactor?: string | null } | undefined)?.secondFactor ?? null;
}

export const load: PageServerLoad = ({ url, locals, cookies }) => {
	if (!needsSetup(sqlite)) {
		cookies.delete(SETUP_COOKIE, { path: '/setup' });
		if (!locals.user || !locals.session) redirect(303, '/login');
		const userId = locals.user.id;
		const state = secondFactorState({
			enforce: enforceOwnerSecondFactor,
			role: locals.principal?.role,
			kind: locals.principal?.kind,
			sessionFactor: sessionFactor(locals),
			hasFactor: userHasSecondFactor(userId)
		});
		// An existing owner signing in again answers the normal challenge, not the wizard.
		if (state === 'challenge') redirect(303, '/two-factor?redirect=%2Fsetup');
		if (state === 'satisfied' && !locals.principal?.platformAdmin) redirect(303, '/overview');
		return {
			phase: state === 'enrol' ? ('secure' as const) : ('done' as const),
			account: { name: locals.user.name, email: locals.user.email },
			hasPasskey: userHasPasskey(userId),
			hasTotp: userHasTotp(userId),
			/** Better Auth asks for it again before adding an authenticator app. */
			hasPassword: userHasPassword(userId),
			instance: instanceFacts()
		};
	}

	if (url.host.toLowerCase() !== platformHost.toLowerCase())
		return { phase: 'wrong-host' as const, platformUrl: `${platformOrigin}/setup${url.search}`, platformOrigin };

	const email = url.searchParams.get('email') ?? '';
	const fromQuery = url.searchParams.get('token');
	if (fromQuery !== null) {
		if (!isValidSetupToken(fromQuery))
			return { phase: 'locked' as const, tokenFile: currentSetupToken().file, error: 'That setup link is not valid.' };
		setupCookie(cookies, url, fromQuery.trim());
		// Drop the token from the address bar (history, screenshots, Referer).
		redirect(303, email ? `/setup?email=${encodeURIComponent(email)}` : '/setup');
	}
	if (!isValidSetupToken(cookies.get(SETUP_COOKIE)))
		return { phase: 'locked' as const, tokenFile: currentSetupToken().file, error: null };
	return { phase: 'account' as const, email, instance: instanceFacts() };
};

/** Owner session for the post-claim actions; refuses anyone else. */
function owner(event: RequestEvent) {
	return event.locals.user && event.locals.principal?.role === 'owner' ? event.locals.user : undefined;
}

export const actions: Actions = {
	/** Paste the token (or the whole link) when the link itself wasn't opened. */
	unlock: async ({ request, cookies, url }) => {
		const raw = String((await request.formData()).get('token') ?? '').trim();
		let token = raw;
		try {
			token = new URL(raw).searchParams.get('token') ?? raw;
		} catch {
			// Not a URL: the token itself.
		}
		if (!needsSetup(sqlite)) redirect(303, '/login');
		if (!isValidSetupToken(token)) return fail(400, { unlockError: 'That token does not match this install.' });
		setupCookie(cookies, url, token.trim());
		redirect(303, '/setup');
	},

	/** Create the owner account and organisation, and sign in. */
	claim: async ({ request, cookies }) => {
		const data = await request.formData();
		const values = {
			name: String(data.get('name') ?? ''),
			email: String(data.get('email') ?? ''),
			organizationName: String(data.get('organizationName') ?? '')
		};
		// Passwords are never echoed back to the form.
		const password = String(data.get('password') ?? '');
		const passwordConfirm = String(data.get('passwordConfirm') ?? '');
		const token = cookies.get(SETUP_COOKIE);
		if (!needsSetup(sqlite)) return fail(409, { values, claimError: 'Setup is already complete. Sign in instead.' });
		if (!isValidSetupToken(token))
			return fail(403, { values, claimError: 'Your setup link expired. Reopen the link the installer printed.' });
		const parsed = parseClaimInput({ ...values, password, passwordConfirm });
		if (!parsed.ok) return fail(400, { values, field: parsed.field, claimError: parsed.message });
		try {
			await auth.api.claimSetup({ body: { ...parsed.value, token }, headers: request.headers });
		} catch (error) {
			return fail(400, { values, claimError: authErrorMessage(error, 'Could not create the owner account.') });
		}
		cookies.delete(SETUP_COOKIE, { path: '/setup' });
		redirect(303, '/setup');
	},

	/** Authenticator app: the fallback when passkeys are unavailable, or a backup to one. */
	startTotp: async (event) => {
		const user = owner(event);
		if (!user) return fail(401, { totpError: 'Sign in first.' });
		if (userHasTotp(user.id)) return fail(400, { totpError: 'An authenticator app is already set up.' });
		const started = await startTotpEnrolment(event.request.headers, formPassword(await event.request.formData()));
		if (!started.ok) return fail(400, { totpError: started.message });
		return { enrolment: started.value };
	},

	verifyTotp: async (event) => {
		if (!owner(event)) return fail(401, { totpError: 'Sign in first.' });
		const code = totpCode(await event.request.formData());
		if (!code) return fail(400, { totpError: 'Enter the 6-digit code from your app.' });
		const verified = await verifyTotpCode(event.request.headers, code);
		if (!verified.ok) return fail(400, { totpError: verified.message });
		return { totpVerified: true };
	}
};
