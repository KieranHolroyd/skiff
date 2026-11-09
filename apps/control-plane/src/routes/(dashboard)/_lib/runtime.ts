import BoxesIcon from '@lucide/svelte/icons/boxes';
import CpuIcon from '@lucide/svelte/icons/cpu';
import LayersIcon from '@lucide/svelte/icons/layers';
import ZapIcon from '@lucide/svelte/icons/zap';
import type { Component } from 'svelte';

/**
 * Display vocabulary for the four runtime tiers (D1 as amended by D110). Every list, badge and
 * header that names a runtime reads it from here so a fifth tier is one edit, not a hunt.
 *
 * Yoal already uses "worker" for a no-ingress app (D89) and a non-edge node, so the tier is
 * always "Function" in the UI; "Workers" appears only when it means Cloudflare's programming model.
 */
export type RuntimeTier = 'static' | 'process' | 'container' | 'function';

interface RuntimeInfo {
	label: string;
	/** Short noun for inline badges ("process", "function"). */
	short: string;
	description: string;
	icon: Component<{ class?: string }>;
}

const RUNTIMES: Record<RuntimeTier, RuntimeInfo> = {
	static: {
		label: 'Static site',
		short: 'static',
		description: 'Files served by Caddy from an immutable release.',
		icon: LayersIcon
	},
	process: {
		label: 'Process app',
		short: 'process',
		description: 'A Bun or Node command in a sandboxed systemd unit.',
		icon: CpuIcon
	},
	container: {
		label: 'Container',
		short: 'container',
		description: 'An OCI image in a rootless container.',
		icon: BoxesIcon
	},
	function: {
		label: 'Function',
		short: 'function',
		description: 'Workers-compatible code on workerd that scales to zero when idle.',
		icon: ZapIcon
	}
};

function tier(value: string | null | undefined): RuntimeTier {
	return value && value in RUNTIMES ? (value as RuntimeTier) : 'static';
}

export function runtimeInfo(value: string | null | undefined): RuntimeInfo {
	return RUNTIMES[tier(value)];
}

export function runtimeIcon(value: string | null | undefined): Component<{ class?: string }> {
	return runtimeInfo(value).icon;
}

export function runtimeLabel(value: string | null | undefined): string {
	return runtimeInfo(value).label;
}
