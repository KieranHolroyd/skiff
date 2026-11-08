import * as z from 'zod';
import type { RequestHandler } from './$types';
import { auth } from '#lib/server/auth.js';
import { json, readJson, route } from '#lib/server/api.js';
import { membershipRoleIn, rememberOrganization } from '#lib/server/org-membership.js';

/**
 * Switch the active organisation (IAM.md I5, §8.1). Better Auth stores the choice on the session,
 * so every later request resolves its principal in that org; it is also remembered on the user so
 * the next sign-in starts there. Only a browser session may switch: a key is bound to its own org.
 */
const bodySchema = z.object({
	organizationId: z.string().trim().min(1).max(200)
});

export const POST: RequestHandler = (event) =>
	route(async () => {
		const user = event.locals.user;
		if (!user)
			return json({ error: 'unauthorized', message: 'Sign in to switch organisations.' }, 401);

		const { organizationId } = await readJson(event.request, bodySchema);
		const role = membershipRoleIn(organizationId, user.id);
		if (!role)
			return json(
				{ error: 'forbidden', message: 'You are not a member of that organisation.' },
				403
			);

		let organization: { id: string; name: string; slug: string } | null;
		try {
			organization = await auth.api.setActiveOrganization({
				body: { organizationId },
				headers: event.request.headers
			});
		} catch {
			return json(
				{ error: 'switch_failed', message: 'Could not switch organisation. Try again.' },
				500
			);
		}
		if (!organization)
			return json({ error: 'not_found', message: 'That organisation no longer exists.' }, 404);

		rememberOrganization(user.id, organizationId);
		return { org: { id: organization.id, name: organization.name, slug: organization.slug, role } };
	});
