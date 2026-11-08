import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { json, route } from '#lib/server/api.js';

/** zot sends one CloudEvent per request (binary mode: `ce-*` headers, JSON body with the manifest). */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Push events from the platform registry (docs/REGISTRY.md §5.3). zot's events extension posts
 * here; the path carries a secret only the registry's config holds, never a cookie, so it sits
 * under the CSRF-exempt `/api/webhooks/` prefix. Unknown event types are accepted and ignored.
 */
export const POST: RequestHandler = (event) =>
	route(async () => {
		const length = Number(event.request.headers.get('content-length') ?? 0);
		if (length > MAX_BODY_BYTES) return json({ error: 'payload_too_large' }, 413);
		const text = await event.request.text();
		if (text.length > MAX_BODY_BYTES) return json({ error: 'payload_too_large' }, 413);
		let body: unknown = null;
		try {
			body = text ? JSON.parse(text) : null;
		} catch {
			return json({ error: 'invalid_json' }, 400);
		}
		const recorded = core.registry.recordEvent(event.params.secret, event.request.headers.get('ce-type'), body);
		return json({ ok: true, recorded }, 202);
	});
