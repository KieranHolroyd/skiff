import type { Component } from 'svelte';
import CloudDownloadIcon from '@lucide/svelte/icons/cloud-download';
import HammerIcon from '@lucide/svelte/icons/hammer';
import SparklesIcon from '@lucide/svelte/icons/sparkles';
import type { SelfUpdateMethod, SelfUpdateOutcome, SelfUpdatePhase } from '@skiff/contracts';
import type { Tone } from '#lib/status.js';

/** Presentation for the updates page, shared by the install form, progress and history. */

export interface MethodOption {
	value: SelfUpdateMethod;
	label: string;
	short: string;
	description: string;
	icon: Component<{ class?: string }>;
}

export const methods: MethodOption[] = [
	{
		value: 'auto',
		label: 'Automatic',
		short: 'automatic',
		description: 'Signed release when one is published, otherwise a source build.',
		icon: SparklesIcon
	},
	{
		value: 'download',
		label: 'Signed release',
		short: 'signed release download',
		description: 'Install the CI-built release after checking its signed manifest and SHA-256.',
		icon: CloudDownloadIcon
	},
	{
		value: 'build',
		label: 'Build from source',
		short: 'source build',
		description: 'Compile the configured ref on this server. Slower; no prebuilt binary runs.',
		icon: HammerIcon
	}
];

export function methodOption(value: SelfUpdateMethod | undefined): MethodOption {
	return methods.find((item) => item.value === value) ?? methods[0];
}

export interface Step {
	phase: SelfUpdatePhase;
	label: string;
	hint: string;
}

/** The updater's phases in order. The fetch step is named after the install method. */
export function updateSteps(method: SelfUpdateMethod | undefined): Step[] {
	return [
		{ phase: 'queued', label: 'Queued', hint: 'systemd starts the updater' },
		{ phase: 'checking', label: 'Preflight', hint: 'Checks run on the exact release' },
		{
			phase: 'building',
			label: method === 'download' ? 'Download' : method === 'build' ? 'Build' : 'Fetch',
			hint:
				method === 'download'
					? 'Verify signature and checksum'
					: method === 'build'
						? 'Compile from source'
						: 'Download or build'
		},
		{ phase: 'canary', label: 'Test boot', hint: 'Boots against a copy of your data' },
		{ phase: 'swapping', label: 'Switch over', hint: 'Dashboard restarts; sites keep serving' },
		{ phase: 'verifying', label: 'Verify', hint: 'Health checks, rollback on failure' }
	];
}

export const outcomes: Record<SelfUpdateOutcome, { label: string; tone: Tone }> = {
	updated: { label: 'Updated', tone: 'success' },
	'up-to-date': { label: 'Already up to date', tone: 'neutral' },
	skipped: { label: 'Skipped', tone: 'warning' },
	'build-failed': { label: 'Build failed', tone: 'danger' },
	'canary-failed': { label: 'Test boot failed', tone: 'danger' },
	'rolled-back': { label: 'Rolled back', tone: 'warning' },
	error: { label: 'Failed', tone: 'danger' }
};

/** Preflight check ids from `evaluateUpgradePreflight`, in words. */
const checkLabels: Record<string, string> = {
	version: 'Version',
	channel: 'Release channel',
	migrations: 'Database migrations',
	disk: 'Disk space',
	'data-dirs': 'Data directories',
	'backup-target': 'Backup target',
	'last-verified-backup': 'Last verified backup',
	'postgres-major': 'Managed Postgres versions'
};

export function checkLabel(id: string): string {
	if (checkLabels[id]) return checkLabels[id];
	// One check per broken directory: `data:objects`, `data:backups`, …
	if (id.startsWith('data:')) return `Data directory: ${id.slice(5)}`;
	return id;
}

/** Tailwind classes per tone, for the icon tiles and dots this page draws itself. */
export const toneTile: Record<Tone, string> = {
	success: 'bg-success/10 text-success ring-success/20',
	warning: 'bg-warning/10 text-warning ring-warning/20',
	danger: 'bg-destructive/10 text-destructive ring-destructive/20',
	info: 'bg-info/10 text-info ring-info/20',
	brand: 'bg-brand/10 text-brand ring-brand/20',
	neutral: 'bg-muted text-muted-foreground ring-border'
};

/** "2m 05s" style elapsed time for a running update. */
export function formatElapsed(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return '—';
	const total = Math.floor(ms / 1000);
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = total % 60;
	if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
	if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
	return `${seconds}s`;
}
