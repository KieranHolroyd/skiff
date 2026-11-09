import { fail, type Action } from '@sveltejs/kit';
import {
	emailDomainCreateSchema,
	type EmailAccessRequestView,
	type EmailDomainView,
	type EmailMessageView,
	type EmailOrgView,
	type Principal
} from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { platformOrigin } from '#lib/server/config.js';
import { failStatus, formString, toFormFailure } from '../../_lib/errors.js';
import { fieldErrorsFrom } from '../../databases/_lib/forms.server.js';
import { isPlatformAdmin, mailNodeIp, mailNodes } from './mail-server.server.js';
import { checkReverseDns } from './reverse-dns.server.js';
import { canRequestAccess } from './sandbox.server.js';
import { sentFromApp } from './setup-guide.js';

/**
 * Everything the Email overview needs, including its setup checklist (docs/EMAIL.md §9). The
 * checklist is the one place Email is set up: each step does its work in place, so the loader also
 * carries what the embedded forms need (the node list for platform admins, the pending domain's
 * records, the production access request).
 */
export function loadEmailHome(principal: Principal) {
	const settings = core.email.settings();
	const platformAdmin = isPlatformAdmin(principal);

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

	let request: EmailAccessRequestView | null = null;
	try {
		request = core.email.accessRequest(principal);
	} catch {
		// No email:read: the checklist's last step says who can ask.
	}

	const ip = mailNodeIp();
	// The first domain still waiting on DNS is the one the checklist walks through.
	const pending = domains.find((domain) => domain.status !== 'verified') ?? null;

	return {
		denied,
		emailOrg: org,
		domains: domains.map((domain) => ({
			name: domain.name,
			status: domain.status,
			sending: domain.sending
		})),
		recent: recent.slice(0, 5),
		pending,
		/** A Cloudflare token covers the pending domain's zone, so "Set up for me" can write its records. */
		pendingAutoDns: pending ? core.email.managesDns(pending.name) : false,
		delivered,
		appSent: sentFromApp(recent),
		credentials,
		ip,
		apiBase: `${platformOrigin}/api/v1/email`,
		accessRequest: request,
		canRequest: canRequestAccess(principal),
		/** Platform admins pick the mail node and publish platform DNS inside the checklist. */
		mailNodes: platformAdmin ? mailNodes(principal) : [],
		platformRecords: platformAdmin ? core.email.platformRecords() : [],
		mailNodeId: platformAdmin ? settings.nodeId : null,
		mailIp: platformAdmin ? settings.ip : null,
		// Streamed: the page renders straight away and the check fills in when DNS answers.
		reverseDns: settings.nodeId && ip ? checkReverseDns(ip, settings.hostnames.helo) : null
	};
}

const PURPOSE: Record<string, string> = { dkim: 'DKIM', spf: 'SPF', dmarc: 'DMARC' };

/** Add a sending domain and stay on the page (the Domains page redirects to the new domain). */
const addDomain: Action = async ({ request, locals }) => {
	const data = await request.formData();
	const values = {
		name: formString(data, 'name').toLowerCase(),
		sending: true,
		// Yoal writes the records itself when Cloudflare holds the zone; otherwise this is a no-op.
		autoDns: true
	};
	const parsed = emailDomainCreateSchema.safeParse(values);
	if (!parsed.success)
		return fail(400, {
			message: 'Check the highlighted fields.',
			fieldErrors: fieldErrorsFrom(parsed.error.issues),
			values
		});
	try {
		const created = await core.email.createDomain(locals.principal!, values);
		const managed = created.records.some((record) => record.managed);
		return {
			success: managed
				? `Added ${created.name} and created its records in Cloudflare. DNS can take a few minutes to update.`
				: `Added ${created.name}. Publish its records next.`
		};
	} catch (caught) {
		return fail(failStatus(caught), { ...toFormFailure(caught), values });
	}
};

/** Write a domain's records through Cloudflare ("Set up for me"). */
const publishDomain: Action = async ({ request, locals }) => {
	const name = formString(await request.formData(), 'name');
	if (!name) return fail(400, { message: 'A domain name is required.' });
	try {
		const { domain, written } = await core.email.publishDomain(locals.principal!, name);
		const what = written.length
			? `Created the ${written.map((purpose) => PURPOSE[purpose] ?? purpose).join(', ')} records in Cloudflare.`
			: 'The records were already in Cloudflare.';
		return {
			success:
				domain.status === 'verified'
					? `${what} ${domain.name} is verified.`
					: `${what} DNS can take a few minutes to update; Yoal keeps checking.`
		};
	} catch (caught) {
		return fail(failStatus(caught), toFormFailure(caught));
	}
};

const checkDomain: Action = async ({ request, locals }) => {
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
};

export const domainSetupActions = { addDomain, publishDomain, checkDomain };
