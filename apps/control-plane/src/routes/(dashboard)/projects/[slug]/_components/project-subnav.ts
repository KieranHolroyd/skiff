import { resolve } from '$app/paths';
import ActivityIcon from '@lucide/svelte/icons/activity';
import BoxIcon from '@lucide/svelte/icons/box';
import FolderOpenIcon from '@lucide/svelte/icons/folder-open';
import SquareTerminalIcon from '@lucide/svelte/icons/square-terminal';
import ChartNoAxesCombinedIcon from '@lucide/svelte/icons/chart-no-axes-combined';
import ClockIcon from '@lucide/svelte/icons/clock';
import CpuIcon from '@lucide/svelte/icons/cpu';
import DatabaseIcon from '@lucide/svelte/icons/database';
import FolderKanbanIcon from '@lucide/svelte/icons/folder-kanban';
import FolderTreeIcon from '@lucide/svelte/icons/folder-tree';
import GitBranchIcon from '@lucide/svelte/icons/git-branch';
import GlobeIcon from '@lucide/svelte/icons/globe';
import KeyRoundIcon from '@lucide/svelte/icons/key-round';
import LayersIcon from '@lucide/svelte/icons/layers';
import LayoutDashboardIcon from '@lucide/svelte/icons/layout-dashboard';
import LinkIcon from '@lucide/svelte/icons/link-2';
import RocketIcon from '@lucide/svelte/icons/rocket';
import ScrollTextIcon from '@lucide/svelte/icons/scroll-text';
import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
import VariableIcon from '@lucide/svelte/icons/variable';
import type { Subnav, SubnavIcon, RouteUrl } from '#lib/nav/subnav.js';
import { readTab, tabHref } from '../../../_lib/service/sections.js';
import { readProjectTab, shareState, type ProjectTab } from './project-nav.js';

/** The slice of a project page's data the sidebar reads. */
export interface ProjectSubnavData {
	project: { slug: string; name: string; runtime?: string };
	deployments: unknown[];
	environments: unknown[];
	builds: Array<{ status: string }>;
	domains: unknown[];
	appVolumes: unknown[];
	databaseAttachments: unknown[];
	storageAttachments: unknown[];
	workloadSpec: { env: Record<string, unknown>; secrets: unknown[] } | null;
	shareLinks: Parameters<typeof shareState>[0][];
	/** YOAL_FEATURE_JOBS (plan 09). */
	jobsEnabled?: boolean;
	/** Container console permissions (D127); absent means none. */
	can?: { inspectContainer?: boolean; containerFiles?: boolean; containerExec?: boolean };
}

export const projectSubnavKey = (slug: string) => `project:${slug}`;

export function projectSubnav(data: ProjectSubnavData, url: RouteUrl): Subnav {
	const base = resolve('/(dashboard)/projects/[slug]', { slug: data.project.slug });
	const runningBuilds = data.builds.filter(
		(build) => build.status === 'building' || build.status === 'queued'
	).length;
	const live = runningBuilds > 0 ? 'Build in progress' : undefined;
	// Container projects get the console sections (D127); Logs moves in beside them.
	const container = data.project.runtime === 'container';
	const item = (id: ProjectTab, label: string, icon: SubnavIcon, count?: number) => ({
		id,
		label,
		icon,
		count,
		href: `${base}?tab=${id}`,
		target: `project.tab.${id}`
	});
	return {
		key: projectSubnavKey(data.project.slug),
		depth: 1,
		title: data.project.name,
		icon: FolderKanbanIcon,
		back: { href: resolve('/(dashboard)/projects'), label: 'Projects' },
		active: readProjectTab(url.searchParams.get('tab')),
		groups: [
			...(container
				? [
						{
							id: 'monitor',
							label: 'Monitor',
							items: [item('traffic', 'Traffic', ChartNoAxesCombinedIcon)]
						},
						{
							id: 'container',
							label: 'Container',
							items: [
								...(data.can?.inspectContainer ? [item('container', 'Overview', BoxIcon)] : []),
								{ ...item('logs', 'Logs', ScrollTextIcon), live },
								...(data.can?.containerExec ? [item('shell', 'Shell', SquareTerminalIcon)] : []),
								...(data.can?.containerFiles ? [item('files', 'Files', FolderOpenIcon)] : [])
							]
						}
					]
				: [
						{
							id: 'monitor',
							label: 'Monitor',
							items: [
								item('traffic', 'Traffic', ChartNoAxesCombinedIcon),
								{ ...item('logs', 'Logs', ScrollTextIcon), live }
							]
						}
					]),
			{
				id: 'ship',
				label: 'Ship',
				items: [
					item('deployments', 'Deployments', RocketIcon, data.deployments.length),
					item('environments', 'Environments', LayersIcon, data.environments.length),
					{ ...item('builds', 'Builds', GitBranchIcon, data.builds.length), live },
					// Jobs (plan 09) run in an app's sandbox; a static site has none.
					...(data.jobsEnabled === true && (data.project.runtime === 'process' || data.project.runtime === 'container')
						? [item('jobs', 'Jobs', ClockIcon)]
						: []),
					item('source', 'Source', FolderTreeIcon)
				]
			},
			{
				id: 'configure',
				label: 'Configure',
				items: [
					item('domains', 'Domains', GlobeIcon, data.domains.length),
					item(
						'data',
						'Data',
						DatabaseIcon,
						data.appVolumes.length +
							data.databaseAttachments.length +
							data.storageAttachments.length
					),
					item(
						'variables',
						'Variables',
						VariableIcon,
						data.workloadSpec
							? Object.keys(data.workloadSpec.env).length + data.workloadSpec.secrets.length
							: undefined
					),
					item('runtime', 'Runtime', CpuIcon),
					item(
						'shares',
						'Share links',
						LinkIcon,
						data.shareLinks.filter((link) => shareState(link) === 'active').length
					),
					item('access', 'Access', ShieldCheckIcon),
					item('settings', 'Settings', KeyRoundIcon)
				]
			}
		]
	};
}

export const DEPLOYMENT_TABS = ['overview', 'metrics', 'logs', 'files'] as const;
export type DeploymentTab = (typeof DEPLOYMENT_TABS)[number];
export const DEPLOYMENT_DEFAULT_TAB: DeploymentTab = 'overview';

export const deploymentSubnavKey = (id: string) => `deployment:${id}`;

/** One deployment of a project: a level below the project's own sections. */
export function deploymentSubnav(
	data: {
		project: { slug: string; name: string };
		deployment: { id: string; shortId: string; release: { fileCount: number } };
	},
	url: RouteUrl
): Subnav {
	const { project, deployment } = data;
	const base = resolve('/(dashboard)/projects/[slug]/deployments/[id]', {
		slug: project.slug,
		id: deployment.id
	});
	return {
		key: deploymentSubnavKey(deployment.id),
		depth: 2,
		title: deployment.shortId,
		mono: true,
		icon: RocketIcon,
		back: {
			href: `${resolve('/(dashboard)/projects/[slug]', { slug: project.slug })}?tab=deployments`,
			label: project.name
		},
		active: readTab(url.searchParams.get('tab'), DEPLOYMENT_TABS, DEPLOYMENT_DEFAULT_TAB),
		target: 'service.tab',
		groups: [
			{
				id: 'sections',
				label: 'Deployment',
				items: [
					{ id: 'overview', label: 'Overview', icon: LayoutDashboardIcon },
					{ id: 'metrics', label: 'Metrics', icon: ActivityIcon },
					{ id: 'logs', label: 'Logs', icon: ScrollTextIcon },
					{ id: 'files', label: 'Files', icon: FolderTreeIcon, count: deployment.release.fileCount }
				].map((section) => ({
					...section,
					href: tabHref(base, section.id, DEPLOYMENT_DEFAULT_TAB)
				}))
			}
		]
	};
}
