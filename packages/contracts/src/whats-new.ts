import { compareSemver, parseSemver } from './semver.ts';

/**
 * Post-update onboarding (docs/WHATS-NEW.md, D212).
 *
 * Every release may carry a small set of changes a platform admin should see after updating. The
 * catalog below ships with the release, so it cannot drift from the code: an item is only visible
 * while the running version is at or past its `since` release.
 *
 * Two kinds of item exist:
 *
 * - `info`: something new the admin should know about. Acknowledging it is enough.
 * - `consent`: a change that needs an explicit decision before it applies (for example the opt-in
 *   anonymous usage ping). The server resolves the setting's current state; the dashboard never
 *   pretends a consent item is done until the admin chooses.
 *
 * The version the admin last reviewed is stored server-side under one install-wide key, because
 * only platform admins see this flow and consent belongs to the install, not to one person.
 */

/**
 * The release before the first tracked release. An install that predates this feature has no
 * stored version, so it starts here and sees every item from the release that introduced the
 * ledger onwards. A fresh install records the running version at setup completion and starts
 * empty (see `WhatsNewService.markInstalled`).
 */
export const WHATS_NEW_BASELINE_VERSION = '0.13.5';

export type WhatsNewAttention = 'info' | 'consent';

/** A decision is final for the item; only `enabled` turns a consent setting on. */
export type WhatsNewDecision = 'acknowledged' | 'enabled' | 'declined';

/** Settings the server knows how to read and change for a consent item. */
export type WhatsNewConsent = 'usage-analytics';

export interface WhatsNewItem {
	/** Stable id; never reuse one for a different change. */
	id: string;
	/**
	 * The release that first included this change. The item is shown to an install whose last
	 * reviewed version is older than this and whose running version is at least this. Authors set
	 * it to the release that carries the entry (see docs/WHATS-NEW.md).
	 */
	since: string;
	title: string;
	summary: string;
	/** A short explanation; plain text, one or two paragraphs. */
	body?: string;
	attention: WhatsNewAttention;
	/** Which setting the consent item reads and writes. Required when attention is `consent`. */
	consent?: WhatsNewConsent;
	/** Button labels for a consent item; the page falls back to generic wording. */
	consentLabels?: { enable: string; decline: string; keep: string };
	/** Where to read the setting or feature in the dashboard. */
	href?: string;
	/** Public documentation for the change. */
	learnMore?: string;
}

export const WHATS_NEW_ITEMS: readonly WhatsNewItem[] = [
	{
		id: 'usage-analytics',
		since: '0.13.6',
		title: 'Anonymous usage analytics is now available',
		summary:
			'Yoal can send one small anonymous ping a day so the project can see which parts of the platform are used. It is off until you decide.',
		body: 'The ping contains counts (projects, deployments, nodes, databases, users), the release, the OS and architecture, the feature flags that are on and the optional services that are configured. It never contains a hostname, address, organisation, user or project name, and there is no free-form field. You can see the exact payload in Settings before enabling it, pin a different collector, or turn it off at any time.',
		attention: 'consent',
		consent: 'usage-analytics',
		consentLabels: {
			enable: 'Enable anonymous analytics',
			decline: 'Keep it off',
			keep: 'Keep it on'
		},
		href: '/settings/usage-analytics',
		learnMore: 'https://github.com/yoal-dev/yoal/blob/main/docs/USAGE-ANALYTICS.md'
	}
];

export function whatsNewItem(id: string): WhatsNewItem | undefined {
	return WHATS_NEW_ITEMS.find((item) => item.id === id);
}

/** The live state of a consent setting, so the page shows the truth rather than the item's copy. */
export interface WhatsNewConsentState {
	/** What the setting is called, for a generic “<label> is on/off” line. */
	label: string;
	enabled: boolean;
	/** The collector or destination currently in use; shown so the admin knows where data goes. */
	endpoint: string;
}

export interface WhatsNewItemView extends WhatsNewItem {
	decision: WhatsNewDecision | null;
	decidedAt: string | null;
	/** Present only for `consent` items. */
	consentState: WhatsNewConsentState | null;
}

export interface WhatsNewView {
	currentVersion: string;
	lastSeenVersion: string;
	/** Items in `(lastSeenVersion, currentVersion]`, newest release first. */
	items: WhatsNewItemView[];
	/** Items with no decision yet. */
	pending: number;
	/** Pending consent items, which cannot be dismissed as read. */
	attention: number;
	/** Whether this principal may record decisions (a platform viewer sees them read-only). */
	canDecide: boolean;
}

/**
 * Catalog items in `(lastSeen, current]`, newest release first. A bad version string is treated
 * as unknown: nothing is shown rather than guessing at the install's history.
 */
export function whatsNewItemsBetween(
	items: readonly WhatsNewItem[],
	lastSeen: string,
	current: string
): WhatsNewItem[] {
	const to = parseSemver(current);
	if (!to) return [];
	const from = parseSemver(lastSeen);
	if (from && compareSemver(from, to) >= 0) return [];
	return items
		.filter((item) => {
			const since = parseSemver(item.since);
			if (!since || compareSemver(since, to) > 0) return false;
			return from ? compareSemver(since, from) > 0 : true;
		})
		.sort((a, b) => compareSemver(b.since, a.since));
}
