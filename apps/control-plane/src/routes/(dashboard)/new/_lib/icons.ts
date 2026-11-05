import BoxesIcon from '@lucide/svelte/icons/boxes';
import ContainerIcon from '@lucide/svelte/icons/container';
import CpuIcon from '@lucide/svelte/icons/cpu';
import LayersIcon from '@lucide/svelte/icons/layers';
import LayoutTemplateIcon from '@lucide/svelte/icons/layout-template';
import WorkflowIcon from '@lucide/svelte/icons/workflow';
import type { Component } from 'svelte';

type Icon = Component<{ class?: string; strokeWidth?: number }>;

/** Templates name a lucide icon; unknown names fall back to the generic template icon. */
const icons: Record<string, Icon> = {
	workflow: WorkflowIcon,
	container: ContainerIcon,
	boxes: BoxesIcon,
	cpu: CpuIcon,
	layers: LayersIcon
};

export function templateIcon(name: string): Icon {
	return icons[name] ?? LayoutTemplateIcon;
}

export const categoryLabels: Record<string, string> = {
	ci: 'CI / CD',
	worker: 'Worker'
};
