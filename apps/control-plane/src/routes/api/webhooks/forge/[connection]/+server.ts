import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { json, route } from '#lib/server/api.js';

/**
 * A GitLab, Gitea or Forgejo connection's webhook (docs/FORGES.md §3, D174): every hook Yoal
 * creates on that forge points here. Authenticated by the connection's secret (GitLab's
 * `X-Gitlab-Token`, Gitea/Forgejo's HMAC signature) over the raw body, never a cookie
 * (`/api/webhooks/` is CSRF-exempt).
 */
export const POST: RequestHandler = async (event) =>
	route(async () => {
		const rawBody = await event.request.text();
		const result = await core.forges.handleWebhook(event.params.connection, rawBody, event.request.headers);
		return json({ ok: true, ...result }, 202);
	});
