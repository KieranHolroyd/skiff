import { resolve } from '$app/paths';
import ActivityIcon from '@lucide/svelte/icons/activity';
import BanIcon from '@lucide/svelte/icons/ban';
import FlaskConicalIcon from '@lucide/svelte/icons/flask-conical';
import GlobeIcon from '@lucide/svelte/icons/globe';
import InboxIcon from '@lucide/svelte/icons/inbox';
import KeyRoundIcon from '@lucide/svelte/icons/key-round';
import LayoutDashboardIcon from '@lucide/svelte/icons/layout-dashboard';
import MailIcon from '@lucide/svelte/icons/mail';
import SendIcon from '@lucide/svelte/icons/send';
import ServerIcon from '@lucide/svelte/icons/server';
import type { Subnav, RouteUrl } from '#lib/nav/subnav.js';

export const EMAIL_SUBNAV_KEY = 'email';

const SECTIONS = [
	'overview',
	'domains',
	'activity',
	'send',
	'sandbox',
	'suppressions',
	'credentials',
	'requests',
	'server'
] as const;
export type EmailSection = (typeof SECTIONS)[number];

/** `/email/domains/example.com` → `domains`; detail pages keep their list lit. */
export function emailSection(pathname: string): EmailSection {
	const segment = pathname.split('/').filter(Boolean)[1] ?? 'overview';
	return SECTIONS.includes(segment as EmailSection) ? (segment as EmailSection) : 'overview';
}

/**
 * Email's sections (docs/EMAIL.md §9). Setup lives on the overview, as a checklist; platform admins
 * also get the production access queue and the mail server, so all of Email is in one place.
 */
export function emailSubnav(
	data: { emailArea: { can: { platform: boolean } } },
	url: RouteUrl
): Subnav {
	return {
		key: EMAIL_SUBNAV_KEY,
		depth: 1,
		title: 'Email',
		icon: MailIcon,
		back: { href: resolve('/(dashboard)/overview'), label: 'Overview' },
		active: emailSection(url.pathname),
		target: 'email.tab',
		groups: [
			{
				id: 'email',
				items: [
					{
						id: 'overview',
						label: 'Overview',
						icon: LayoutDashboardIcon,
						href: resolve('/(dashboard)/email')
					},
					{
						id: 'domains',
						label: 'Domains',
						icon: GlobeIcon,
						href: resolve('/(dashboard)/email/domains')
					},
					{
						id: 'activity',
						label: 'Activity',
						icon: ActivityIcon,
						href: resolve('/(dashboard)/email/activity')
					},
					{
						id: 'send',
						label: 'Send a test',
						icon: SendIcon,
						href: resolve('/(dashboard)/email/send')
					},
					{
						id: 'sandbox',
						label: 'Sandbox',
						icon: FlaskConicalIcon,
						href: resolve('/(dashboard)/email/sandbox')
					},
					{
						id: 'suppressions',
						label: 'Suppressions',
						icon: BanIcon,
						href: resolve('/(dashboard)/email/suppressions')
					},
					{
						id: 'credentials',
						label: 'SMTP credentials',
						icon: KeyRoundIcon,
						href: resolve('/(dashboard)/email/credentials')
					}
				]
			},
			...(data.emailArea.can.platform
				? [
						{
							id: 'platform',
							label: 'Platform',
							items: [
								{
									id: 'requests',
									label: 'Access requests',
									icon: InboxIcon,
									href: resolve('/(dashboard)/email/requests')
								},
								{
									id: 'server',
									label: 'Mail server',
									icon: ServerIcon,
									href: resolve('/(dashboard)/email/server')
								}
							]
						}
					]
				: [])
		]
	};
}
