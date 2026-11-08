import * as z from 'zod';
import { auth, userHasOrgPermission } from '#lib/server/auth.js';
import { json, readJson, route } from '#lib/server/api.js';
import { redeemCliLoginCode } from '#lib/server/cli-login.js';
import { contentDomain, platformOrigin } from '#lib/server/config.js';
import { core } from '#lib/server/core.js';
import { preferredOrganizationId } from '#lib/server/org-membership.js';
import { principalFromSession } from '#lib/server/principal.js';
import type { RequestHandler } from './$types';

/**
 * Exchange a one-time browser-login code for a regular API key. The CLI holds the PKCE
 * verifier; only the CLI that started the flow can redeem the code. The key is returned once
 * and then behaves exactly like a key created in the dashboard.
 */
const bodySchema = z.object({
	code: z.string().min(32).max(200),
	codeVerifier: z.string().min(43).max(128).regex(/^[A-Za-z0-9_-]+$/),
});

export const POST: RequestHandler = ({ request }) =>
	route(async () => {
		const input = await readJson(request, bodySchema);
		const redeemed = redeemCliLoginCode(input.code, input.codeVerifier);
		if (!redeemed.ok) {
			return json(
				{
					error: 'invalid_grant',
					message:
						redeemed.reason === 'expired'
							? 'This login link has expired. Run `skif login --web` again.'
							: 'This login link is invalid or has already been used. Run `skif login --web` again.',
				},
				400,
				{ 'cache-control': 'no-store' },
			);
		}

		// The CLI receives an API key, so the user's role must allow creating one (DESIGN §6.2).
		// The key belongs to the org the user last worked in (IAM.md I5); without one, fall back to
		// their first membership, which is what earlier builds did.
		const orgId = preferredOrganizationId(redeemed.userId);
		if (!userHasOrgPermission(redeemed.userId, 'apiKey:create', orgId))
			return json(
				{
					error: 'forbidden',
					message: 'Your role cannot create API keys, so the CLI cannot sign in. Ask an org owner or admin.',
				},
				403,
				{ 'cache-control': 'no-store' },
			);

		const created = await auth.api.createApiKey({
			body: {
				userId: redeemed.userId,
				name: 'Skiff CLI (browser login)',
				// IAM.md I14: still a Better Auth `apikey`; it moves to `access_keys` (org-bound,
				// expiring) with the service-account work, once spike S1 settles the hash format.
				metadata: orgId ? { orgId } : undefined,
			},
		});
		if (!created?.key)
			return json(
				{ error: 'server_error', message: 'Could not create an API key.' },
				500,
				{ 'cache-control': 'no-store' },
			);

		try {
			const principal = principalFromSession(redeemed.userId, request, { kind: 'user', orgId });
			if (principal) core.audit.record({
				principal,
				action: 'cli.login',
				resource: 'apiKey',
				resourceId: created.id,
				result: 'ok',
				args: { method: 'browser' },
			});
		} catch (error) {
			// The key is already minted; auditing must not fail the login.
			console.error('[cli-login] audit failed:', error);
		}

		return json(
			{ token: created.key, keyId: created.id, platform: platformOrigin, contentDomain },
			200,
			{ 'cache-control': 'no-store' },
		);
	});
