import { resolve } from '$app/paths';
import ActivityIcon from '@lucide/svelte/icons/activity';
import InboxIcon from '@lucide/svelte/icons/inbox';
import ListOrderedIcon from '@lucide/svelte/icons/list-ordered';
import LayoutDashboardIcon from '@lucide/svelte/icons/layout-dashboard';
import ScrollTextIcon from '@lucide/svelte/icons/scroll-text';
import Settings2Icon from '@lucide/svelte/icons/settings-2';
import type { BrokerView } from '@skiff/contracts';
import type { Subnav, RouteUrl } from '#lib/nav/subnav.js';
import { readTab, tabHref } from '../../_lib/service/sections.js';
import { BROKER_DEFAULT_TAB, BROKER_TABS } from './broker-tabs.js';

export const brokerSubnavKey = (name: string) => `broker:${name}`;

/** A queue's sections; Logs is its own route. */
export function brokerSubnav(
	data: { broker: BrokerView },
	url: RouteUrl,
	route: 'logs' | null
): Subnav {
	const broker = data.broker;
	const base = resolve('/(dashboard)/brokers/[name]', { name: broker.name });
	return {
		key: brokerSubnavKey(broker.name),
		depth: 1,
		title: broker.name,
		mono: true,
		icon: InboxIcon,
		back: { href: resolve('/(dashboard)/brokers'), label: 'Queues' },
		active: route ?? readTab(url.searchParams.get('tab'), BROKER_TABS, BROKER_DEFAULT_TAB),
		target: 'service.tab',
		groups: [
			{
				id: 'sections',
				items: [
					{
						id: 'overview',
						label: 'Overview',
						icon: LayoutDashboardIcon,
						href: tabHref(base, 'overview', BROKER_DEFAULT_TAB)
					},
					{
						id: 'queues',
						label: 'Queues',
						icon: ListOrderedIcon,
						href: tabHref(base, 'queues', BROKER_DEFAULT_TAB)
					},
					{
						id: 'metrics',
						label: 'Metrics',
						icon: ActivityIcon,
						href: tabHref(base, 'metrics', BROKER_DEFAULT_TAB)
					},
					{
						id: 'logs',
						label: 'Logs',
						icon: ScrollTextIcon,
						href: resolve('/(dashboard)/brokers/[name]/logs', { name: broker.name })
					},
					{
						id: 'settings',
						label: 'Settings',
						icon: Settings2Icon,
						href: tabHref(base, 'settings', BROKER_DEFAULT_TAB)
					}
				]
			}
		]
	};
}
