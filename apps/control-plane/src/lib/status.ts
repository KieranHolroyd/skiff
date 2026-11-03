/**
 * One vocabulary for status colour across the dashboard. Every status string the UI shows
 * (deployments, nodes, share links, API keys, audit results) maps to a tone here.
 */
export type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'brand';

const tones: Record<string, Tone> = {
	active: 'success',
	online: 'success',
	ok: 'success',
	verified: 'success',
	pending: 'info',
	draining: 'warning',
	'used up': 'warning',
	unverified: 'warning',
	failed: 'danger',
	error: 'danger',
	denied: 'danger',
	offline: 'danger',
	revoked: 'danger',
	expired: 'neutral',
	inactive: 'neutral',
	disabled: 'neutral',
	deleted: 'neutral',
	production: 'brand'
};

export function statusTone(status: string | null | undefined): Tone {
	return tones[(status ?? '').toLowerCase()] ?? 'neutral';
}

/** Statuses that represent something currently running get an animated dot. */
export function isLive(status: string | null | undefined): boolean {
	return status === 'online';
}
