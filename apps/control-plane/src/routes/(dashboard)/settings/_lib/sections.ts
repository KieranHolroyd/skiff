import ActivityIcon from '@lucide/svelte/icons/activity';
import BellRingIcon from '@lucide/svelte/icons/bell-ring';
import BugIcon from '@lucide/svelte/icons/bug';
import Building2Icon from '@lucide/svelte/icons/building-2';
import ChartColumnIcon from '@lucide/svelte/icons/chart-column';
import ChartLineIcon from '@lucide/svelte/icons/chart-line';
import ClockIcon from '@lucide/svelte/icons/clock';
import CircleArrowUpIcon from '@lucide/svelte/icons/circle-arrow-up';
import DatabaseBackupIcon from '@lucide/svelte/icons/database-backup';
import FingerprintIcon from '@lucide/svelte/icons/fingerprint';
import FolderTreeIcon from '@lucide/svelte/icons/folder-tree';
import GitBranchIcon from '@lucide/svelte/icons/git-branch';
import GlobeIcon from '@lucide/svelte/icons/globe';
import GlobeLockIcon from '@lucide/svelte/icons/globe-lock';
import HardDriveIcon from '@lucide/svelte/icons/hard-drive';
import HardDriveUploadIcon from '@lucide/svelte/icons/hard-drive-upload';
import IdCardIcon from '@lucide/svelte/icons/id-card';
import KeyRoundIcon from '@lucide/svelte/icons/key-round';
import LogsIcon from '@lucide/svelte/icons/logs';
import MailIcon from '@lucide/svelte/icons/mail';
import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
import SparklesIcon from '@lucide/svelte/icons/sparkles';
import UserRoundIcon from '@lucide/svelte/icons/user-round';
import UsersIcon from '@lucide/svelte/icons/users';
import NetworkIcon from '@lucide/svelte/icons/network';
import PlugIcon from '@lucide/svelte/icons/plug';
import PackageIcon from '@lucide/svelte/icons/package';
import WaypointsIcon from '@lucide/svelte/icons/waypoints';
import WrenchIcon from '@lucide/svelte/icons/wrench';
import type { Permission } from '@skiff/contracts';

/**
 * Every Settings section, grouped by what it is about rather than only by scope, so no group grows
 * past five or six entries. The order still runs from you, through the organisation you are signed
 * in to, to this Skiff install:
 *
 * - you: your own account and credentials;
 * - organisation: the org itself, its people and what it uses;
 * - security: who can sign in and do what (IAM, SSO, edge access, user pools);
 * - integrations: outside services this org connects to (GitHub, registries, backup targets);
 * - observability: where logs and metrics go (an org's drains, then the platform's stores);
 * - platform: install-wide services and policy (addresses, notifications, mail, assistant);
 * - infrastructure: how nodes cluster, fail over and store data;
 * - operations: keeping the install healthy (backups, upgrades, clean-up).
 *
 * Visibility is per section, so a member who is not a platform admin simply sees fewer groups. The
 * layout's navigation and each page's header both read from here, so a section's name and one-line
 * summary live in one place.
 */

export type SectionId =
	| 'account'
	| 'api-keys'
	| 'connected-apps'
	| 'general'
	| 'members'
	| 'access'
	| 'access-policies'
	| 'sso'
	| 'identity'
	| 'usage'
	| 'backup-targets'
	| 'log-drains'
	| 'registry'
	| 'github'
	| 'domains'
	| 'policies'
	| 'backups'
	| 'notifications'
	| 'email'
	| 'assistant'
	| 'telemetry'
	| 'metrics'
	| 'errors'
	| 'high-availability'
	| 'storage'
	| 'shares'
	| 'clustering'
	| 'maintenance'
	| 'updates';

export type SectionGroup =
	| 'you'
	| 'organisation'
	| 'security'
	| 'integrations'
	| 'observability'
	| 'platform'
	| 'infrastructure'
	| 'operations';

/**
 * The settings navigation passes each href to SvelteKit's `resolve()`, whose generic is distributed
 * over the route-id union; TypeScript stops inferring past 25 members. SSO, Skiff Access, User
 * pools and Server errors are the newest sections, so they are left out of this type and asserted
 * at their entries below. All are real routes (`svelte-kit sync` lists them in `$app/types`); every other entry is literal-checked.
 */
export type SectionHref =
	| '/(dashboard)/settings'
	| '/(dashboard)/settings/account'
	| '/(dashboard)/settings/api-keys'
	| '/(dashboard)/settings/connected-apps'
	| '/(dashboard)/settings/members'
	| '/(dashboard)/settings/access'
	| '/(dashboard)/settings/usage'
	| '/(dashboard)/settings/backup-targets'
	| '/(dashboard)/settings/log-drains'
	| '/(dashboard)/settings/registry'
	| '/(dashboard)/settings/github'
	| '/(dashboard)/settings/domains'
	| '/(dashboard)/settings/policies'
	| '/(dashboard)/settings/backups'
	| '/(dashboard)/settings/notifications'
	| '/(dashboard)/settings/email'
	| '/(dashboard)/settings/assistant'
	| '/(dashboard)/settings/telemetry'
	| '/(dashboard)/settings/metrics'
	| '/(dashboard)/settings/high-availability'
	| '/(dashboard)/settings/storage'
	| '/(dashboard)/settings/shares'
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
		id: 'connected-apps',
		group: 'you',
		label: 'Connected apps',
		summary:
			'The MCP clients and agents you have approved, what each may do, and when it last called.',
		href: '/(dashboard)/settings/connected-apps',
		path: '/settings/connected-apps',
		icon: PlugIcon
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
		id: 'access',
		group: 'security',
		label: 'Access',
		summary:
			'Roles, bindings and groups: who can do what in this organisation, at which scope, and why.',
		href: '/(dashboard)/settings/access',
		path: '/settings/access',
		icon: ShieldCheckIcon,
		anyPermission: ['iam:read']
	},
	{
		id: 'sso',
		group: 'security',
		label: 'SSO',
		summary:
			'OpenID Connect sign-in, and the email domains that route to it. SAML, JIT and enforcement follow.',
		// See `SectionHref`: the route is real, but `resolve()` cannot infer past 25 members.
		href: '/(dashboard)/settings/sso' as unknown as SectionHref,
		path: '/settings/sso',
		icon: FingerprintIcon,
		anyPermission: ['sso:read']
	},
	{
		id: 'access-policies',
		group: 'security',
		label: 'Skiff Access',
		summary:
			'Skiff Access: ordered allow and deny rules for sites and app environments, enforced at the edge.',
		// See `SectionHref`: `resolve()` cannot infer past its 25-member union.
		href: '/(dashboard)/settings/access-policies' as unknown as SectionHref,
		path: '/settings/access-policies',
		icon: GlobeLockIcon,
		anyPermission: ['accessPolicy:read', 'accessPolicy:create']
	},
	{
		id: 'identity',
		group: 'security',
		label: 'User pools',
		summary:
			'Managed user pools: the OIDC issuer, clients and signing keys for your apps’ own end users.',
		// See `SectionHref`: the route is real, but `resolve()` cannot infer past 25 members.
		href: '/(dashboard)/settings/identity' as unknown as SectionHref,
		path: '/settings/identity',
		icon: IdCardIcon,
		anyPermission: ['userPool:read']
	},
	{
		id: 'github',
		group: 'integrations',
		label: 'GitHub',
		summary:
			'Skiff’s GitHub App: private clones, push and pull request events, commit statuses and runners without tokens or webhooks.',
		href: '/(dashboard)/settings/github',
		path: '/settings/github',
		icon: GitBranchIcon,
		anyPermission: ['build:read']
	},
	{
		id: 'registry',
		group: 'integrations',
		label: 'Container registries',
		summary: 'Logins for private registries, so nodes can pull this organisation’s images.',
		href: '/(dashboard)/settings/registry',
		path: '/settings/registry',
		icon: PackageIcon,
		anyPermission: ['image:pull']
	},
	{
		id: 'backup-targets',
		group: 'integrations',
		label: 'Backup targets',
		summary: 'Where this organisation’s database backups are written.',
		href: '/(dashboard)/settings/backup-targets',
		path: '/settings/backup-targets',
		icon: HardDriveUploadIcon,
		anyPermission: ['database:read']
	},
	{
		id: 'log-drains',
		group: 'observability',
		label: 'Log drains',
		summary: 'Forward this organisation’s logs to a webhook or an OpenTelemetry (OTLP) receiver.',
		href: '/(dashboard)/settings/log-drains',
		path: '/settings/log-drains',
		icon: LogsIcon,
		anyPermission: ['logs:read']
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
		id: 'errors',
		group: 'observability',
		label: 'Server errors',
		summary:
			'Exceptions and 5xx answers from the control plane itself, grouped into issues you can resolve or ignore.',
		// See `SectionHref`: the route is real, but `resolve()` cannot infer past 25 members.
		href: '/(dashboard)/settings/errors' as unknown as SectionHref,
		path: '/settings/errors',
		icon: BugIcon,
		platformAdmin: true
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
		summary: 'An optional chat panel over the same tools your agents use, and its turn limits.',
		href: '/(dashboard)/settings/assistant',
		path: '/settings/assistant',
		icon: SparklesIcon,
		ownerOnly: true
	},
	{
		id: 'clustering',
		group: 'infrastructure',
		label: 'Clustering',
		summary: 'Overlay addressing, endpoint ports, replica and failover limits, and share mounts.',
		href: '/(dashboard)/settings/clustering',
		path: '/settings/clustering',
		icon: NetworkIcon,
		platformAdmin: true
	},
	{
		id: 'high-availability',
		group: 'infrastructure',
		label: 'High availability',
		summary: 'Ingress driver, failover hold-downs and ingress-node readiness.',
		href: '/(dashboard)/settings/high-availability',
		path: '/settings/high-availability',
		icon: WaypointsIcon,
		platformAdmin: true
	},
	{
		id: 'storage',
		group: 'infrastructure',
		label: 'Storage',
		summary:
			'The system disk, fast disks and bulk disks, and where each kind of service keeps its data.',
		href: '/(dashboard)/settings/storage',
		path: '/settings/storage',
		icon: HardDriveIcon,
		platformAdmin: true
	},
	{
		// NFS/SMB mounts, not a project's share links (those live on each project).
		id: 'shares',
		group: 'infrastructure',
		label: 'Network shares',
		summary: 'NFS and SMB shares: mount them on nodes and use them as bulk disks.',
		href: '/(dashboard)/settings/shares',
		path: '/settings/shares',
		icon: FolderTreeIcon,
		platformAdmin: true
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
		id: 'updates',
		group: 'operations',
		label: 'Updates',
		summary: 'The Skiff version running here, and safe one-click upgrades with automatic rollback.',
		href: '/(dashboard)/settings/updates',
		path: '/settings/updates',
		icon: CircleArrowUpIcon,
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
		id: 'policies',
		group: 'operations',
		label: 'Retention & defaults',
		summary: 'How long deleted things and history are kept, and defaults for new databases.',
		href: '/(dashboard)/settings/policies',
		path: '/settings/policies',
		icon: ClockIcon,
		ownerOnly: true
	}
];

export const GROUP_LABELS: Record<SectionGroup, string> = {
	you: 'You',
	organisation: 'Organisation',
	security: 'Access & security',
	integrations: 'Integrations',
	observability: 'Observability',
	platform: 'Platform',
	infrastructure: 'Infrastructure',
	operations: 'Operations'
};

/** Navigation order; a group with no visible sections is hidden. */
export const GROUP_ORDER: SectionGroup[] = [
	'you',
	'organisation',
	'security',
	'integrations',
	'observability',
	'platform',
	'infrastructure',
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
