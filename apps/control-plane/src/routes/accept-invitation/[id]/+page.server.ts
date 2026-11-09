import { redirect } from '@sveltejs/kit';
import { core } from '#lib/server/core.js';
import type { PageServerLoad } from './$types';

/** Invite acceptance (DESIGN §6.1). Requires a session; the page calls Better Auth to join. */
export const load: PageServerLoad = ({ locals, params, url }) => {
	if (!locals.user) redirect(303, `/login?redirect=${encodeURIComponent(url.pathname)}`);
	// A project invitation lands the new guest on the project they were invited to, instead of an
	// org overview that is mostly empty for them (IAM.md §8.2). The column appears at boot.
	let projectSlug: string | null = null;
	try {
		const invitation = core.ctx.sqlite
			.query<{ projectId: string | null }, [string]>(
				'SELECT projectId FROM invitation WHERE id = ?'
			)
			.get(params.id);
		if (invitation?.projectId) {
			const project = core.ctx.sqlite
				.query<{ slug: string }, [string]>('SELECT slug FROM projects WHERE id = ?')
				.get(invitation.projectId);
			projectSlug = project?.slug ?? null;
		}
	} catch {
		// No invitation row yet, or an install that has not added the guest columns: fall back.
	}
	return { invitationId: params.id, email: locals.user.email, projectSlug };
};
