import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { json, route } from '#lib/server/api.js';

/**
 * GitHub webhook for a pipeline repository (docs/PIPELINES.md §4.1): `push`, `pull_request`,
 * `ping`. Authenticated by the repository's HMAC secret over the raw body, never a cookie.
 */
export const POST: RequestHandler = async (event) =>
	route(async () => {
		const rawBody = await event.request.text();
		const result = core.pipelines.handleGithubWebhook(
			event.params.repository,
			rawBody,
			event.request.headers.get('x-hub-signature-256'),
			event.request.headers.get('x-github-event'),
		);
		return json({ ok: true, ...result }, 202);
	});
