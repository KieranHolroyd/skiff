import { eq } from 'drizzle-orm';
import { settings } from '@yoal/db';
import {
	WHATS_NEW_BASELINE_VERSION,
	WHATS_NEW_ITEMS,
	whatsNewItem,
	whatsNewItemsBetween,
	type Principal,
	type WhatsNewDecision,
	type WhatsNewItem,
	type WhatsNewItemView,
	type WhatsNewView
} from '@yoal/contracts';
import type { CoreContext } from './context.ts';
import { ForbiddenError, ValidationError } from './errors.ts';
import { buildSystemPrincipal } from './iam/system.ts';
import { parseJson } from './util.ts';

/**
 * Post-update onboarding (docs/WHATS-NEW.md, D212).
 *
 * The catalog ships with the release (`WHATS_NEW_ITEMS` in `@yoal/contracts`). This service keeps
 * one install-wide ledger in `settings`: the last version a platform admin reviewed, plus the
 * decision recorded for each item still in view. Only platform admins can see or change it, so a
 * single row is enough and consent is never attributed to an ordinary member.
 *
 * First run: an install that predates this feature has no ledger, so it starts at
 * `WHATS_NEW_BASELINE_VERSION` and sees every item from the release that introduced it. A fresh
 * install calls `markInstalled()` when setup completes, which starts it at the running version so
 * a new install does not get a backlog of changes it never experienced.
 */

const SETTINGS_KEY = 'whats-new';
const DECISIONS: ReadonlySet<WhatsNewDecision> = new Set(['acknowledged', 'enabled', 'declined']);

interface StoredDecision {
	decision: WhatsNewDecision;
	at: number;
	by: string;
}

interface StoredLedger {
	lastSeenVersion: string;
	decisions: Record<string, StoredDecision>;
}

/** Cheap payload for the dashboard shell; it never builds the full page or reads a setting. */
export interface WhatsNewSummary {
	currentVersion: string;
	pending: number;
	attention: number;
}

export class WhatsNewService {
	constructor(
		private readonly ctx: CoreContext,
		private readonly options: { version: string }
	) {}

	/** The release this process is running, as the catalog's `since` values are compared to it. */
	private current(): string {
		return this.options.version;
	}

	// ------------------------------------------------------------------ state

	private read(): StoredLedger | null {
		const row = this.ctx.db.select().from(settings).where(eq(settings.key, SETTINGS_KEY)).get();
		if (!row) return null;
		const parsed = parseJson<Partial<StoredLedger>>(row.value, {});
		if (typeof parsed.lastSeenVersion !== 'string' || !parsed.lastSeenVersion) return null;
		const decisions: Record<string, StoredDecision> = {};
		for (const [id, raw] of Object.entries(parsed.decisions ?? {})) {
			if (!raw || typeof raw !== 'object') continue;
			const value = raw as Partial<StoredDecision>;
			if (!DECISIONS.has(value.decision as WhatsNewDecision)) continue;
			decisions[id] = {
				decision: value.decision as WhatsNewDecision,
				at: typeof value.at === 'number' ? value.at : this.ctx.now(),
				by: typeof value.by === 'string' ? value.by : 'unknown'
			};
		}
		return { lastSeenVersion: parsed.lastSeenVersion, decisions };
	}

	/** The stored ledger, or the install's starting point when nothing has been reviewed yet. */
	private ledger(): StoredLedger {
		return (
			this.read() ?? {
				lastSeenVersion: WHATS_NEW_BASELINE_VERSION,
				decisions: {}
			}
		);
	}

	private write(next: StoredLedger): void {
		const now = this.ctx.now();
		const value = JSON.stringify(next);
		this.ctx.db
			.insert(settings)
			.values({ key: SETTINGS_KEY, value, updatedAt: now })
			.onConflictDoUpdate({
				target: settings.key,
				set: { value, updatedAt: now }
			})
			.run();
	}

	private window(stored: StoredLedger): WhatsNewItem[] {
		return whatsNewItemsBetween(WHATS_NEW_ITEMS, stored.lastSeenVersion, this.current());
	}

	// ------------------------------------------------------------------ access

	/** Platform viewers may read the flow; only administrators may record a decision. */
	private assertView(principal: Principal): void {
		if (!this.ctx.platformIam.canView(principal))
			throw new ForbiddenError('Only a platform admin can review what’s new.');
	}

	private assertDecide(principal: Principal): void {
		if (!this.ctx.platformIam.canAdminister(principal))
			throw new ForbiddenError('Only a platform administrator can record a decision.');
	}

	// ------------------------------------------------------------------ surfaces

	/** The dashboard shell reads this on every navigation, so it stays a count and two queries. */
	summary(principal: Principal): WhatsNewSummary {
		this.assertDecide(principal);
		const stored = this.ledger();
		const pending = this.window(stored).filter((item) => !stored.decisions[item.id]);
		return {
			currentVersion: this.current(),
			pending: pending.length,
			attention: pending.filter((item) => item.attention === 'consent').length
		};
	}

	view(principal: Principal): WhatsNewView {
		this.assertView(principal);
		const stored = this.ledger();
		const items = this.window(stored).map((item) => this.itemView(principal, item, stored));
		const pending = items.filter((item) => item.decision === null);
		return {
			currentVersion: this.current(),
			lastSeenVersion: stored.lastSeenVersion,
			items,
			pending: pending.length,
			attention: pending.filter((item) => item.attention === 'consent').length,
			canDecide: this.ctx.platformIam.canAdminister(principal)
		};
	}

	private itemView(
		principal: Principal,
		item: WhatsNewItem,
		stored: StoredLedger
	): WhatsNewItemView {
		const decision = stored.decisions[item.id];
		return {
			...item,
			decision: decision?.decision ?? null,
			decidedAt: decision ? new Date(decision.at).toISOString() : null,
			consentState: this.consentState(principal, item)
		};
	}

	/** The exact current state of a consent setting, not what the catalog copy assumed. */
	private consentState(principal: Principal, item: WhatsNewItem): WhatsNewItemView['consentState'] {
		if (item.consent === 'usage-analytics') {
			const view = this.ctx.usageAnalytics.view(principal);
			return { label: 'Anonymous usage data', enabled: view.enabled, endpoint: view.endpoint };
		}
		return null;
	}

	// ------------------------------------------------------------------ writes

	/**
	 * Record one decision. `enabled` is the only value that changes a setting; `declined` leaves
	 * the setting as it is, so choosing "not now" can never turn off something enabled elsewhere.
	 */
	decide(principal: Principal, itemId: string, decision: WhatsNewDecision): WhatsNewView {
		this.assertDecide(principal);
		const item = whatsNewItem(itemId);
		if (!item) throw new ValidationError(`Unknown change "${itemId}".`);
		const stored = this.ledger();
		if (!this.window(stored).some((entry) => entry.id === item.id))
			throw new ValidationError('That change is not waiting for a decision on this version.');

		const allowed =
			item.attention === 'consent'
				? decision === 'enabled' || decision === 'declined'
				: decision === 'acknowledged';
		if (!allowed)
			throw new ValidationError(
				item.attention === 'consent'
					? 'Choose whether to enable this change or keep it off.'
					: 'That change only needs to be acknowledged.'
			);

		if (item.consent === 'usage-analytics' && decision === 'enabled')
			this.ctx.usageAnalytics.setEnabled(principal, { enabled: true });

		stored.decisions[item.id] = {
			decision,
			at: this.ctx.now(),
			by: principal.userId
		};
		this.write(stored);
		this.ctx.audit.record({
			principal,
			action: 'whats-new.decide',
			resource: 'whats-new',
			resourceId: item.id,
			args: { decision },
			result: 'ok'
		});
		return this.view(principal);
	}

	/**
	 * Finish the review: acknowledge every remaining informational item and move the ledger to the
	 * running version. A pending consent item blocks this, because silence is not permission.
	 */
	acknowledge(principal: Principal): WhatsNewView {
		this.assertDecide(principal);
		const stored = this.ledger();
		const items = this.window(stored);
		const pendingConsent = items.filter(
			(item) => item.attention === 'consent' && !stored.decisions[item.id]
		);
		if (pendingConsent.length > 0)
			throw new ValidationError(
				`Decide ${pendingConsent.map((item) => `“${item.title}”`).join(', ')} before marking the rest as read.`
			);
		const now = this.ctx.now();
		const acknowledged = items.filter((item) => !stored.decisions[item.id]).length;
		// The ledger only needs the new starting point: decisions for versions below it can never
		// be in a future window.
		this.write({ lastSeenVersion: this.current(), decisions: {} });
		this.ctx.audit.record({
			principal,
			action: 'whats-new.acknowledge',
			resource: 'whats-new',
			args: { version: this.current(), acknowledged, at: now },
			result: 'ok'
		});
		return this.view(principal);
	}

	/**
	 * Start a fresh install at its current release, so setup does not leave a backlog of changes
	 * the install never ran. Existing installs have no ledger and fall back to the baseline.
	 */
	markInstalled(): void {
		const version = this.current();
		this.write({ lastSeenVersion: version, decisions: {} });
		this.ctx.audit.record({
			principal: buildSystemPrincipal('system:whats-new', ''),
			action: 'whats-new.installed',
			resource: 'whats-new',
			args: { version },
			result: 'ok'
		});
	}
}
