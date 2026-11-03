import type { RequestHandler } from './$types';
import { eq } from 'drizzle-orm';
import { projects } from '@skiff/db';
import { core } from '#lib/server/core.js';
import { json, route } from '#lib/server/api.js';

/**
 * GitHub push webhook (D2). Authenticated by the repository's HMAC secret, never a cookie, so it
 * is listed as a CSRF-exempt prefix. The raw body is required verbatim for signature verification.
 */
export const POST: RequestHandler = async (event) => {
	const projectSlug = event.params.project;
	return route(async () => {
		const row = core.ctx.db.select().from(projects).where(eq(projects.slug, projectSlug)).get();
		if (!row || row.deletedAt) return json({ error: 'not_found' }, 404);
		const rawBody = await event.request.text();
		const build = await core.builds.handleGithubWebhook(
			row,
			rawBody,
			event.request.headers.get('x-hub-signature-256'),
			event.request.headers.get('x-github-event'),
		);
		if (!build) return json({ ok: true, ignored: true }, 202);
		return json({ ok: true, build }, 202);
	});
};
