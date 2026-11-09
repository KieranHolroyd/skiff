import type { RequestHandler } from './$types';
import { eq } from 'drizzle-orm';
import { projects } from '@yoal/db';
import { core } from '#lib/server/core.js';
import { json, route } from '#lib/server/api.js';

/**
 * A project's hand-made push webhook (D2, D174), also served as `/api/webhooks/git/<project>`.
 * GitHub, Gitea and Forgejo sign the raw body with the project's secret; GitLab sends the secret in
 * `X-Gitlab-Token`. Never a cookie, so it is a CSRF-exempt prefix.
 */
export const POST: RequestHandler = async (event) => {
	const projectSlug = event.params.project;
	return route(async () => {
		const row = core.ctx.db.select().from(projects).where(eq(projects.slug, projectSlug)).get();
		if (!row || row.deletedAt) return json({ error: 'not_found' }, 404);
		const rawBody = await event.request.text();
		const build = await core.builds.handleWebhook(row, rawBody, event.request.headers);
		if (!build) return json({ ok: true, ignored: true }, 202);
		return json({ ok: true, build }, 202);
	});
};
