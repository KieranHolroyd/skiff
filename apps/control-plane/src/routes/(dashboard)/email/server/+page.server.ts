import { core } from '#lib/server/core.js';
import { canConfigurePlatform, currentSection } from '#lib/server/platform-config.js';
import {
	loadMailServer,
	mailNodeIp,
	mailServerActions,
	requirePlatformAdmin
} from '../_lib/mail-server.server.js';
import { checkReverseDns } from '../_lib/reverse-dns.server.js';
import type { Actions, PageServerLoad } from './$types';

/**
 * Email → Mail server (docs/EMAIL.md §3.3, §10), platform admin only: the mail node, the mail
 * domain, the global pause, reverse DNS (checked live), the platform DNS records, the host names,
 * this organisation's sandbox state and limits, and how the platform's own mail goes out.
 */
export const load: PageServerLoad = ({ locals }) => {
	const principal = requirePlatformAdmin(locals);
	const server = loadMailServer(principal);
	const ip = mailNodeIp();
	const relay = currentSection('email');
	return {
		...server,
		reverseDns:
			server.settings.nodeId && ip ? checkReverseDns(ip, server.settings.hostnames.helo) : null,
		reverseIp: ip,
		/** D22: sign-in links, invites and alerts go through the platform SMTP relay, set in Notifications. */
		platformMail: {
			relay: relay.configured
				? {
						host: relay.values.SKIFF_SMTP_HOST ?? '',
						port: relay.values.SKIFF_SMTP_PORT ?? '587',
						from: relay.values.SKIFF_SMTP_FROM ?? null
					}
				: null,
			canEdit: canConfigurePlatform(principal),
			platformDkim: core.email
				.platformRecords()
				.some((record) => record.type === 'TXT' && record.name.includes('._domainkey.'))
		}
	};
};

export const actions: Actions = mailServerActions;
