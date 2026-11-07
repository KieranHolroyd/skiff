import { fail } from '@sveltejs/kit';
import type { EmailDomainView, EmailMessageView, EmailOrgView } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { platformOrigin } from '#lib/server/config.js';
import { failStatus, formString, toFormFailure } from '../../_lib/errors.js';
import { checkReverseDns } from '../_lib/reverse-dns.server.js';
import { sentFromApp } from '../_lib/setup-guide.js';
import type { Actions, PageServerLoad } from './$types';

/**
 * The Email setup guide (docs/EMAIL.md §9): everything between "Email isn't set up" and an app
 * sending real mail, as a checklist judged from live state. It reads only; each step links to the
 * page that does the work, apart from re-checking a domain's DNS in place.
 */
export const load: PageServerLoad = ({ locals }) => {
	const principal = locals.principal!;
	const settings = core.email.settings();

	let org: EmailOrgView | null = null;
	let domains: EmailDomainView[] = [];
	let recent: EmailMessageView[] = [];
	let delivered = false;
	let credentials = 0;
	let denied = false;
	try {
		org = core.email.orgView(principal);
		domains = core.email.listDomains(principal);
		recent = core.email.listMessages(principal, { limit: 50 });
		delivered = core.email.listMessages(principal, { status: 'delivered', limit: 1 }).length > 0;
		credentials = core.email.listCredentials(principal).length;
	} catch {
		denied = true;
	}

	// The mail node's IPv4 comes from its platform A record, which every member may see; the node
	// list itself is platform-admin only.
	const ip =
		core.email
			.platformRecords()
			.find((record) => record.type === 'A' && record.name === settings.hostnames.helo)?.value ??
		null;

	// The first domain still waiting on DNS is the one the guide walks through.
	const pending = domains.find((domain) => domain.status !== 'verified') ?? null;

	return {
		denied,
		org,
		domains: domains.map((domain) => ({
			name: domain.name,
			status: domain.status,
			sending: domain.sending
		})),
		pending,
		delivered,
		appSent: sentFromApp(recent),
		credentials,
		ip,
		apiBase: `${platformOrigin}/api/v1/email`,
		// Streamed: the page renders straight away and the check fills in when DNS answers.
		reverseDns: settings.nodeId && ip ? checkReverseDns(ip, settings.hostnames.helo) : null
	};
};

export const actions: Actions = {
	check: async ({ request, locals }) => {
		const name = formString(await request.formData(), 'name');
		if (!name) return fail(400, { message: 'A domain name is required.' });
		try {
			const domain = await core.email.checkDomain(locals.principal!, name);
			const missing = domain.records.filter((record) => record.required && !record.ok).length;
			return {
				success:
					domain.status === 'verified'
						? `${domain.name} is verified. On to the test message.`
						: `${missing} required ${missing === 1 ? 'record is' : 'records are'} still missing. DNS can take a few minutes to update.`
			};
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	}
};
