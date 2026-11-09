import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { json, route } from '#lib/server/api.js';

/**
 * The webhook of Yoal's GitHub App (docs/GITHUB.md, D165): installation changes, and `push` /
 * `pull_request` for every repository an installation covers, routed to the linked org's git
 * builds and pipelines. Authenticated by the App's webhook secret over the raw body, never a
 * cookie (`/api/webhooks/` is CSRF-exempt).
 */
export const POST: RequestHandler = async (event) =>
	route(async () => {
		const rawBody = await event.request.text();
		const result = await core.githubApp.handleWebhook(
			rawBody,
			event.request.headers.get('x-hub-signature-256'),
			event.request.headers.get('x-github-event')
		);
		return json({ ok: true, ...result }, 202);
	});
