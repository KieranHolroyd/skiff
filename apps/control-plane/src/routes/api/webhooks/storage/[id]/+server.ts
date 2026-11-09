import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { json, route } from '#lib/server/api.js';

/** RustFS posts one webhook body per event; a few records at most, never a large upload. */
const MAX_BODY_BYTES = 256 * 1024;

/**
 * RustFS bucket events for one storage instance (docs/EVENTS.md, D122). The instance's `yoal`
 * webhook target posts here with a bearer token derived from the instance id, never a cookie, so
 * this sits under the CSRF-exempt `/api/webhooks/` prefix. A non-2xx answer makes RustFS keep the
 * event in its queue dir and retry, so only a bad token or body is refused.
 */
export const POST: RequestHandler = (event) =>
	route(async () => {
		const length = Number(event.request.headers.get('content-length') ?? 0);
		if (length > MAX_BODY_BYTES) return json({ error: 'payload_too_large' }, 413);
		const body = await event.request.text();
		if (body.length > MAX_BODY_BYTES) return json({ error: 'payload_too_large' }, 413);
		const queued = core.events.ingestStorage(
			event.params.id,
			event.request.headers.get('authorization'),
			body
		);
		return json({ ok: true, queued }, 202);
	});
