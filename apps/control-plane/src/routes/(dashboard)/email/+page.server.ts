import type { EmailDomainView, EmailMessageView, EmailOrgView } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import type { PageServerLoad } from './$types';

/** Email overview: the org's sending state, limits and reputation (docs/EMAIL.md §7, §9). */
export const load: PageServerLoad = ({ locals }) => {
	const principal = locals.principal!;
	let emailOrg: EmailOrgView | null = null;
	let domains: EmailDomainView[] = [];
	let recent: EmailMessageView[] = [];
	let denied = false;
	try {
		emailOrg = core.email.orgView(principal);
		domains = core.email.listDomains(principal);
		recent = core.email.listMessages(principal, { limit: 5 });
	} catch {
		denied = true;
	}
	return {
		denied,
		emailOrg,
		domains: domains.map((domain) => ({
			name: domain.name,
			status: domain.status,
			sending: domain.sending
		})),
		recent
	};
};
