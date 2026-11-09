import { resolve } from '$app/paths';
import ActivityIcon from '@lucide/svelte/icons/activity';
import ArchiveIcon from '@lucide/svelte/icons/archive';
import BellIcon from '@lucide/svelte/icons/bell';
import BookOpenIcon from '@lucide/svelte/icons/book-open';
import BotIcon from '@lucide/svelte/icons/bot';
import BracesIcon from '@lucide/svelte/icons/braces';
import ChartAreaIcon from '@lucide/svelte/icons/chart-area';
import CircleArrowUpIcon from '@lucide/svelte/icons/circle-arrow-up';
import ClockIcon from '@lucide/svelte/icons/clock';
import ContainerIcon from '@lucide/svelte/icons/container';
import CylinderIcon from '@lucide/svelte/icons/cylinder';
import DatabaseIcon from '@lucide/svelte/icons/database';
import DownloadIcon from '@lucide/svelte/icons/download';
import FileCogIcon from '@lucide/svelte/icons/file-cog';
import FileTextIcon from '@lucide/svelte/icons/file-text';
import GaugeIcon from '@lucide/svelte/icons/gauge';
import GitBranchIcon from '@lucide/svelte/icons/git-branch';
import GlobeIcon from '@lucide/svelte/icons/globe';
import HardDriveIcon from '@lucide/svelte/icons/hard-drive';
import HistoryIcon from '@lucide/svelte/icons/history';
import KeyIcon from '@lucide/svelte/icons/key';
import KeyRoundIcon from '@lucide/svelte/icons/key-round';
import LifeBuoyIcon from '@lucide/svelte/icons/life-buoy';
import LightbulbIcon from '@lucide/svelte/icons/lightbulb';
import LinkIcon from '@lucide/svelte/icons/link';
import LockIcon from '@lucide/svelte/icons/lock';
import MailIcon from '@lucide/svelte/icons/mail';
import MessageSquareIcon from '@lucide/svelte/icons/message-square';
import NetworkIcon from '@lucide/svelte/icons/network';
import ServerIcon from '@lucide/svelte/icons/server';
import ShieldIcon from '@lucide/svelte/icons/shield';
import SlidersHorizontalIcon from '@lucide/svelte/icons/sliders-horizontal';
import SparklesIcon from '@lucide/svelte/icons/sparkles';
import SquareFunctionIcon from '@lucide/svelte/icons/square-function';
import TableIcon from '@lucide/svelte/icons/table';
import TerminalIcon from '@lucide/svelte/icons/terminal';
import UsersIcon from '@lucide/svelte/icons/users';
import WebhookIcon from '@lucide/svelte/icons/webhook';
import ZapIcon from '@lucide/svelte/icons/zap';
import type { NavSection } from '@yoal/docs';
import type { RouteUrl, Subnav, SubnavIcon } from '#lib/nav/subnav.js';

export const DOCS_SUBNAV_KEY = 'docs';

/** Per-page icons, so the collapsed (icon-only) sidebar stays readable. */
const PAGE_ICONS: Record<string, SubnavIcon> = {
	'getting-started/introduction': SparklesIcon,
	'getting-started/quickstart': ZapIcon,
	'getting-started/concepts': LightbulbIcon,
	'deploying/static-sites': GlobeIcon,
	'deploying/site-config': FileCogIcon,
	'deploying/access-and-sharing': LockIcon,
	'deploying/domains-and-environments': LinkIcon,
	'deploying/git-builds': GitBranchIcon,
	'compute/functions': SquareFunctionIcon,
	'compute/apps-and-containers': ContainerIcon,
	'compute/volumes': HardDriveIcon,
	'compute/scheduled-jobs': ClockIcon,
	'data/databases': DatabaseIcon,
	'data/database-studio': TableIcon,
	'data/backups-and-pitr': HistoryIcon,
	'data/object-storage': CylinderIcon,
	'data/brokers-and-events': WebhookIcon,
	'data/email': MailIcon,
	'observe/dashboards-and-logs': ChartAreaIcon,
	'observe/metrics': ActivityIcon,
	'observe/alerts': BellIcon,
	'clients/cli': TerminalIcon,
	'clients/rest-api': BracesIcon,
	'clients/mcp': BotIcon,
	'clients/assistant': MessageSquareIcon,
	'accounts/sign-in-and-2fa': KeyRoundIcon,
	'accounts/organizations-and-roles': UsersIcon,
	'accounts/api-keys-and-tokens': KeyIcon,
	'accounts/security-model': ShieldIcon,
	'self-hosting/installation': DownloadIcon,
	'self-hosting/configuration': SlidersHorizontalIcon,
	'self-hosting/nodes-and-fleet': ServerIcon,
	'self-hosting/clustering': NetworkIcon,
	'self-hosting/platform-backups': ArchiveIcon,
	'self-hosting/upgrades': CircleArrowUpIcon,
	'self-hosting/quotas-and-limits': GaugeIcon,
	'self-hosting/troubleshooting': LifeBuoyIcon
};

/** The docs' sections and pages take over the sidebar while reading. */
export function docsSubnav(data: { docsNav: NavSection[] }, url: RouteUrl): Subnav {
	const docsRoot = resolve('/(dashboard)/docs');
	const current = decodeURIComponent(url.pathname.slice(docsRoot.length)).replace(/^\/+|\/+$/g, '');
	return {
		key: DOCS_SUBNAV_KEY,
		depth: 1,
		title: 'Docs',
		icon: BookOpenIcon,
		back: { href: resolve('/(dashboard)/overview'), label: 'Overview' },
		active: current || null,
		target: 'docs.page',
		groups: data.docsNav.map((section) => ({
			id: section.id,
			label: section.title,
			items: section.pages.map((page) => ({
				id: page.slug,
				label: page.title,
				icon: PAGE_ICONS[page.slug] ?? FileTextIcon,
				href: resolve('/(dashboard)/docs/[...slug]', { slug: page.slug })
			}))
		}))
	};
}
