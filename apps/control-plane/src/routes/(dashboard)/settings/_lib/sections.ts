import ActivityIcon from '@lucide/svelte/icons/activity';
import BellRingIcon from '@lucide/svelte/icons/bell-ring';
import Building2Icon from '@lucide/svelte/icons/building-2';
import ChartColumnIcon from '@lucide/svelte/icons/chart-column';
import ChartLineIcon from '@lucide/svelte/icons/chart-line';
import ClockIcon from '@lucide/svelte/icons/clock';
import CircleArrowUpIcon from '@lucide/svelte/icons/circle-arrow-up';
import DatabaseBackupIcon from '@lucide/svelte/icons/database-backup';
import GlobeIcon from '@lucide/svelte/icons/globe';
import HardDriveUploadIcon from '@lucide/svelte/icons/hard-drive-upload';
import KeyRoundIcon from '@lucide/svelte/icons/key-round';
import MailIcon from '@lucide/svelte/icons/mail';
import SparklesIcon from '@lucide/svelte/icons/sparkles';
import UserRoundIcon from '@lucide/svelte/icons/user-round';
import UsersIcon from '@lucide/svelte/icons/users';
import NetworkIcon from '@lucide/svelte/icons/network';
import WrenchIcon from '@lucide/svelte/icons/wrench';
import type { Permission } from '@skiff/contracts';

/**
 * Every Settings section, grouped by who it belongs to: you, the organisation you are signed in
 * to, or this Skiff install. Install-wide sections are split into the platform's own config,
 * observability, and operations (backups, upkeep, upgrades). The layout's navigation and each
 * page's header both read from here, so a section's name and one-line summary live in one place.
 */

export type SectionId =
	| 'account'
	| 'api-keys'
	| 'general'
	| 'members'
	| 'usage'
	| 'backup-targets'
	| 'domains'
	| 'policies'
	| 'backups'
	| 'notifications'
	| 'email'
	| 'assistant'
	| 'telemetry'
	| 'metrics'
	| 'high-availability'
	| 'clustering'
	| 'maintenance'
	| 'updates';

export type SectionGroup = 'you' | 'organisation' | 'platform' | 'observability' | 'operations';

export type SectionHref =
	| '/(dashboard)/settings'
	| '/(dashboard)/settings/account'
	| '/(dashboard)/settings/api-keys'
	| '/(dashboard)/settings/members'
	| '/(dashboard)/settings/usage'
	| '/(dashboard)/settings/backup-targets'
	| '/(dashboard)/settings/domains'
	| '/(dashboard)/settings/policies'
	| '/(dashboard)/settings/backups'
	| '/(dashboard)/settings/notifications'
	| '/(dashboard)/settings/email'
	| '/(dashboard)/settings/assistant'
	| '/(dashboard)/settings/telemetry'
	| '/(dashboard)/settings/metrics'
	| '/(dashboard)/settings/high-availability'
	| '/(dashboard)/settings/clustering'
	| '/(dashboard)/settings/maintenance'
	| '/(dashboard)/settings/updates';

export interface Section {
	id: SectionId;
	group: SectionGroup;
	label: string;
	/** One line under the page title. */
	summary: string;
	href: SectionHref;
	path: string;
	icon: typeof Building2Icon;
	/** Platform admins only (manages nodes, installs updates). */
	platformAdmin?: boolean;
	/** Platform admin who also owns the current org (canConfigurePlatform on the server). */
	ownerOnly?: boolean;
	/** Needs any one of these org permissions. */
	anyPermission?: Permission[];
}

export const SECTIONS: Section[] = [
	{
		id: 'account',
		group: 'you',
		label: 'Account',
		summary: 'Your profile, how you sign in, and every device signed in as you.',
		href: '/(dashboard)/settings/account',
		path: '/settings/account',
		icon: UserRoundIcon
	},
	{
		id: 'api-keys',
		group: 'you',
		label: 'API keys',
		summary:
			'Headless access for CI, scripts and the CLI. A key can never do more than your current role.',
		href: '/(dashboard)/settings/api-keys',
		path: '/settings/api-keys',
		icon: KeyRoundIcon,
		anyPermission: ['apiKey:read', 'apiKey:create']
	},
	{
		id: 'general',
		group: 'organisation',
		label: 'General',
		summary: 'The organisation you are signed in to, and exactly what your role lets you do in it.',
		href: '/(dashboard)/settings',
		path: '/settings',
		icon: Building2Icon
	},
	{
		id: 'members',
		group: 'organisation',
		label: 'Members',
		summary: 'Everyone with access to this organisation, and the invitations still waiting.',
		href: '/(dashboard)/settings/members',
		path: '/settings/members',
		icon: UsersIcon
	},
	{
		id: 'usage',
		group: 'organisation',
		label: 'Usage & limits',
		summary: 'What this organisation is using against its limits.',
		href: '/(dashboard)/settings/usage',
		path: '/settings/usage',
		icon: ChartColumnIcon,
		anyPermission: ['project:read']
	},
	{
		id: 'backup-targets',
		group: 'organisation',
		label: 'Backup targets',
		summary: 'Where this organisation’s database backups are written.',
		href: '/(dashboard)/settings/backup-targets',
		path: '/settings/backup-targets',
		icon: HardDriveUploadIcon,
		anyPermission: ['database:read']
	},
	{
		id: 'domains',
		group: 'platform',
		label: 'Domains',
		summary: 'The dashboard address, the domain sites are served under, and HTTPS.',
		href: '/(dashboard)/settings/domains',
		path: '/settings/domains',
		icon: GlobeIcon,
		ownerOnly: true
	},
	{
		id: 'policies',
		group: 'platform',
		label: 'Policies',
		summary:
			'How long deleted things and history are kept, defaults for new resources, and assistant limits.',
		href: '/(dashboard)/settings/policies',
		path: '/settings/policies',
		icon: ClockIcon,
		ownerOnly: true
	},
	{
		id: 'backups',
		group: 'operations',
		label: 'Backups',
		summary: 'Continuous off-site backup of the platform database, and what a full restore needs.',
		href: '/(dashboard)/settings/backups',
		path: '/settings/backups',
		icon: DatabaseBackupIcon,
		ownerOnly: true
	},
	{
		id: 'notifications',
		group: 'platform',
		label: 'Notifications',
		summary:
			'Set up the channels Skiff sends through: email, SMS, chat, push and the alert recipients.',
		href: '/(dashboard)/settings/notifications',
		path: '/settings/notifications',
		icon: BellRingIcon,
		ownerOnly: true
	},
	{
		id: 'email',
		group: 'platform',
		label: 'Email',
		summary:
			'The mail node that sends for every organisation, the DNS it needs, the global pause and sending limits.',
		href: '/(dashboard)/settings/email',
		path: '/settings/email',
		icon: MailIcon,
		platformAdmin: true
	},
	{
		id: 'assistant',
		group: 'platform',
		label: 'Assistant',
		summary: 'An optional chat panel over the same tools your agents use.',
		href: '/(dashboard)/settings/assistant',
		path: '/settings/assistant',
		icon: SparklesIcon,
		ownerOnly: true
	},
	{
		id: 'telemetry',
		group: 'observability',
		label: 'Telemetry',
		summary:
			'The optional ClickHouse store behind traffic charts and dashboards. Off by default to keep the install light.',
		href: '/(dashboard)/settings/telemetry',
		path: '/settings/telemetry',
		icon: ActivityIcon,
		ownerOnly: true
	},
	{
		id: 'metrics',
		group: 'observability',
		label: 'Metrics',
		summary: 'What /metrics exports for Prometheus and Grafana, and how much work a scrape may do.',
		href: '/(dashboard)/settings/metrics',
		path: '/settings/metrics',
		icon: ChartLineIcon,
		ownerOnly: true
	},
	{
		id: 'clustering',
		group: 'platform',
		label: 'Clustering',
		summary: 'Overlay addressing, endpoint ports, replica and failover limits, and share mounts.',
		href: '/(dashboard)/settings/clustering',
		path: '/settings/clustering',
		icon: NetworkIcon,
		platformAdmin: true
	},
	{
		id: 'high-availability',
		group: 'platform',
		label: 'High availability',
		summary: 'Ingress driver, failover hold-downs and ingress-node readiness.',
		href: '/(dashboard)/settings/high-availability',
		path: '/settings/high-availability',
		icon: NetworkIcon,
		platformAdmin: true
	},
	{
		id: 'maintenance',
		group: 'operations',
		label: 'Maintenance',
		summary: 'Reclaim space from old releases and trash, and review every bulk operation.',
		href: '/(dashboard)/settings/maintenance',
		path: '/settings/maintenance',
		icon: WrenchIcon,
		anyPermission: ['project:read']
	},
	{
		id: 'updates',
		group: 'operations',
		label: 'Updates',
		summary: 'The Skiff version running here, and safe one-click upgrades with automatic rollback.',
		href: '/(dashboard)/settings/updates',
		path: '/settings/updates',
		icon: CircleArrowUpIcon,
		platformAdmin: true
	}
];

export const GROUP_LABELS: Record<SectionGroup, string> = {
	you: 'You',
	organisation: 'Organisation',
	platform: 'Platform',
	observability: 'Observability',
	operations: 'Operations'
};

/** Navigation order; a group with no visible sections is hidden. */
export const GROUP_ORDER: SectionGroup[] = [
	'you',
	'organisation',
	'platform',
	'observability',
	'operations'
];

export function section(id: SectionId): Section {
	return SECTIONS.find((entry) => entry.id === id)!;
}

export function visibleSections(viewer: {
	platformAdmin: boolean;
	role: string;
	permissions: readonly string[];
}): Section[] {
	const owner = viewer.platformAdmin && viewer.role === 'owner';
	return SECTIONS.filter(
		(entry) =>
			(!entry.platformAdmin || viewer.platformAdmin) &&
			(!entry.ownerOnly || owner) &&
			(!entry.anyPermission ||
				entry.anyPermission.some((permission) => viewer.permissions.includes(permission)))
	);
}

/** The section a URL belongs to; nested pages (a Maintenance operation) keep their parent. */
export function sectionForPath(pathname: string, among: Section[] = SECTIONS): Section | undefined {
	return among.find(
		(entry) =>
			entry.path === pathname ||
			(entry.path !== '/settings' && pathname.startsWith(`${entry.path}/`))
	);
}
