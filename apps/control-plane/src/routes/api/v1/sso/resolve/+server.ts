import type { RequestHandler } from './$types';
import { route } from '#lib/server/api.js';
import { sso } from '#lib/server/sso.js';

/**
 * Email → IdP resolution for the sign-in page (IAM.md I19, §8.3). Public by design: `/login` has no
 * session yet, and the answer only says whether this server has an enabled provider for a domain
 * that an organisation proved with a TXT record. The browser then starts the plugin's sign-in flow
 * with `providerId`, so no provider or secret leaves the server except the id the IdP callback
 * already contains.
 */
export const GET: RequestHandler = (event) =>
	route(() => {
		const email = event.url.searchParams.get('email')?.trim() ?? '';
		if (!email) return { provider: null };
		const match = sso.resolveProviderForEmail(email);
		if (!match) return { provider: null };
		return {
			provider: {
				id: match.provider.id,
				name: match.provider.name,
				orgId: match.orgId,
				domain: match.domain.domain
			}
		};
	});
