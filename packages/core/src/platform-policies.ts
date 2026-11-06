import {
	PLATFORM_POLICIES_KEY,
	platformPoliciesMergedSchema,
	platformPoliciesSchema,
	platformPoliciesUpdateSchema,
	type PlatformPolicies,
} from '@skiff/contracts';
import type { CoreContext } from './context.ts';
import { ValidationError } from './errors.ts';

const DAY_MS = 86_400_000;

/**
 * Platform policies (Settings → Policies): retention, alert thresholds, new-database defaults and
 * assistant caps. One JSON row in `settings`, cached in memory and re-read after every save, so the
 * maintenance loop, the scheduler and each request see a change on their next run.
 */
export class PlatformPolicyService {
	#cache: PlatformPolicies | null = null;

	constructor(private readonly ctx: CoreContext) {}

	get(): PlatformPolicies {
		if (this.#cache) return this.#cache;
		let raw: unknown = {};
		try {
			const row = this.ctx.sqlite
				.query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?')
				.get(PLATFORM_POLICIES_KEY);
			if (row) raw = JSON.parse(row.value);
		} catch {
			// No settings table yet (first boot) or a hand-edited row that is not JSON: use the defaults.
		}
		this.#cache = platformPoliciesSchema.parse(raw && typeof raw === 'object' ? raw : {});
		return this.#cache;
	}

	/** Owner-only (the caller checks); validates, merges and persists. Returns the saved policies. */
	update(input: unknown): PlatformPolicies {
		const update = platformPoliciesUpdateSchema.safeParse(input);
		if (!update.success) throw new ValidationError('Invalid platform policies.', update.error.issues);
		const merged = platformPoliciesMergedSchema.safeParse({ ...this.get(), ...update.data });
		if (!merged.success) throw new ValidationError('Invalid platform policies.', merged.error.issues);
		this.ctx.sqlite.run(
			'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
			[PLATFORM_POLICIES_KEY, JSON.stringify(merged.data), this.ctx.now()],
		);
		this.#cache = merged.data;
		return merged.data;
	}

	// ------------------------------------------------------------ derived helpers (milliseconds)

	trashMs(): number {
		return this.get().trashDays * DAY_MS;
	}

	logRetentionMs(): number {
		return this.get().logRetentionDays * DAY_MS;
	}

	deletedHistoryMs(): number {
		return this.get().deletedHistoryDays * DAY_MS;
	}

	operationHistoryMs(): number {
		return this.get().operationHistoryDays * DAY_MS;
	}

	certWarnMs(): number {
		return this.get().certWarnDays * DAY_MS;
	}

	certCriticalMs(): number {
		return this.get().certCriticalDays * DAY_MS;
	}

	nodeAlertMs(): number {
		return this.get().nodeAlertMinutes * 60_000;
	}
}
