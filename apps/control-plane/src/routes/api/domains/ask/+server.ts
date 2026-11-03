import { domainAskSchema } from '@skiff/contracts';
import { json } from '#lib/server/api.js';
import { core } from '#lib/server/core.js';
import type { RequestHandler } from './$types';

/**
 * Caddy on-demand TLS authorization (DESIGN §5, D31). This endpoint is cookieless and CSRF-exempt
 * by design: Caddy calls it for every unknown SNI before issuing a certificate. It answers only
 * 200 (approved) or 403, and never reveals whether a hostname exists on another org.
 */
function answer(domain: string | null): Response {
	const parsed = domainAskSchema.safeParse({ domain: domain ?? '' });
	const ok = parsed.success && core.domains.approve(parsed.data.domain);
	return json({ ok }, ok ? 200 : 403, { 'cache-control': 'no-store' });
}

export const GET: RequestHandler = ({ url }) => answer(url.searchParams.get('domain'));

export const POST: RequestHandler = async ({ request }) => {
	let body: unknown = null;
	try {
		body = await request.json();
	} catch {
		// Missing/invalid JSON is an unapproved domain, not a server error.
	}
	const domain =
		body && typeof body === 'object' && typeof (body as { domain?: unknown }).domain === 'string'
			? ((body as { domain: string }).domain)
			: null;
	return answer(domain);
};
