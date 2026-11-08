import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { json, route } from '#lib/server/api.js';

/**
 * A pipeline repository's hand-made webhook (docs/PIPELINES.md §4.1, D174): GitHub, Gitea and
 * Forgejo `push` / `pull_request` (signed with the repository's secret) and GitLab push and merge
 * request hooks (`X-Gitlab-Token`). Never a cookie.
 */
export const POST: RequestHandler = (event) =>
	route(async () => {
		const rawBody = await event.request.text();
		const result = await core.pipelines.handleWebhook(event.params.repository, rawBody, event.request.headers);
		return json({ ok: true, ...result }, 202);
	});
