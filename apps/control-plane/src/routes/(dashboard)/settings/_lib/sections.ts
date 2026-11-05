import BellRingIcon from '@lucide/svelte/icons/bell-ring';
import Building2Icon from '@lucide/svelte/icons/building-2';
import ChartColumnIcon from '@lucide/svelte/icons/chart-column';
import CircleArrowUpIcon from '@lucide/svelte/icons/circle-arrow-up';
import DatabaseBackupIcon from '@lucide/svelte/icons/database-backup';
import HardDriveUploadIcon from '@lucide/svelte/icons/hard-drive-upload';
import KeyRoundIcon from '@lucide/svelte/icons/key-round';
import SparklesIcon from '@lucide/svelte/icons/sparkles';
import UserRoundIcon from '@lucide/svelte/icons/user-round';
import UsersIcon from '@lucide/svelte/icons/users';
import WrenchIcon from '@lucide/svelte/icons/wrench';
import type { Permission } from '@skiff/contracts';

/**
 * Every Settings section, grouped by who it belongs to: you, the organisation you are signed in
 * to, or the platform (this Skiff install). The layout's navigation and each page's header both
 * read from here, so a section's name and one-line summary live in one place.
 */

export type SectionId =
	| 'account'
	| 'api-keys'
	| 'general'
	| 'members'
	| 'usage'
	| 'backup-targets'
	| 'backups'
	| 'notifications'
	| 'assistant'
	| 'maintenance'
	| 'updates';

export type SectionGroup = 'you' | 'organisation' | 'platform';

export type SectionHref =
	| '/(dashboard)/settings'
	| '/(dashboard)/settings/account'
	| '/(dashboard)/settings/api-keys'
	| '/(dashboard)/settings/members'
	| '/(dashboard)/settings/usage'
	| '/(dashboard)/settings/backup-targets'
	| '/(dashboard)/settings/backups'
	| '/(dashboard)/settings/notifications'
	| '/(dashboard)/settings/assistant'
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
		id: 'backups',
		group: 'platform',
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
		summary: 'Outbound email for sign-in links and invitations, and where alerts are sent.',
		href: '/(dashboard)/settings/notifications',
		path: '/settings/notifications',
		icon: BellRingIcon,
		ownerOnly: true
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
		id: 'maintenance',
		group: 'platform',
		label: 'Maintenance',
		summary: 'Reclaim space from old releases and trash, and review every bulk operation.',
		href: '/(dashboard)/settings/maintenance',
		path: '/settings/maintenance',
		icon: WrenchIcon,
		anyPermission: ['project:read']
	},
	{
		id: 'updates',
		group: 'platform',
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
	platform: 'Platform'
};

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
