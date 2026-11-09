import { z } from 'zod';
import { cronSchema } from './database-backup.ts';
import { ingressDrivers } from './ingress.ts';

/**
 * Platform policies: retention windows, alert thresholds, defaults for new resources and assistant
 * cost caps. Platform-wide, stored as one JSON row in the `settings` table under
 * `PLATFORM_POLICIES_KEY`, and changed by the owner on the Settings page each group belongs to
 * (apps/control-plane/src/routes/(dashboard)/settings/_lib/policy-groups.ts). Every field has a
 * default (the value that used to be hardcoded), so a missing or stale row still parses, and every
 * reader picks a change up on its next run without a restart.
 */

export const PLATFORM_POLICIES_KEY = 'platform_policies';

const int = (min: number, max: number) => z.number().int().min(min).max(max);

/** Field rules without defaults; the stored shape adds them, the update shape makes them optional. */
const policyFields = {
	// ---------------------------------------------------------------- retention
	/** Deleted apps, databases, storage instances and app volumes stay restorable this long. */
	trashDays: int(1, 90),
	/** Unpinned deployments kept per app when neither the org nor the app quota sets a number. */
	retainedDeployments: int(1, 500),
	/** Build and runtime log lines older than this are pruned. */
	logRetentionDays: int(1, 90),
	/** Soft-deleted deployments, revoked share links and expired redemptions are purged after this. */
	deletedHistoryDays: int(1, 365),
	/** Finished maintenance operations (Settings → Maintenance) are kept this long. */
	operationHistoryDays: int(1, 365),
	/** Registry tags older than this are prunable (the newest `keepTags` per repository always stay). */
	registryRetentionDays: int(1, 3650),
	/** GitHub Actions runner registrations with no live replica are prunable after this. */
	runnerRegistrationRetentionDays: int(1, 365),
	/** Unpinned app-volume snapshots are prunable after this. */
	volumeSnapshotRetentionDays: int(1, 3650),

	// ---------------------------------------------------------------- alerts
	/** Warn when a certificate is this close to expiry… */
	certWarnDays: int(2, 60),
	/** …and raise it to critical at this many days. */
	certCriticalDays: int(1, 30),
	/** Alert after a node has missed heartbeats for this many minutes. */
	nodeAlertMinutes: int(1, 60),
	/** A node's disk above this percentage alerts. */
	diskAlertPercent: int(50, 99),
	/** A managed database above this share of its storage budget alerts (critical at 95%). */
	databaseStorageAlertPercent: int(50, 99),
	/** Open connections above this share of max_connections alert. */
	databaseConnectionsAlertPercent: int(50, 100),
	/** A PgBouncer pool above this saturation alerts (critical at 95%). */
	poolSaturationAlertPercent: int(50, 100),
	/** A storage instance above this share of its budget alerts (critical at 95%). */
	storageAlertPercent: int(50, 99),
	/** A queue broker's JetStream store above this share of its budget alerts (critical at 95%). */
	brokerStoreAlertPercent: int(50, 99),
	/** A built-in alert that is still true re-notifies after this many minutes. */
	systemAlertRepeatMinutes: int(5, 1440),

	// ---------------------------------------------------------------- new databases
	/** Backup schedule (cron, UTC) given to new managed databases. */
	databaseBackupSchedule: cronSchema,
	/** Backup retention given to new managed databases. */
	databaseBackupRetentionDays: int(1, 365),

	// ---------------------------------------------------------------- assistant
	/** Model calls one assistant turn may make before it stops. */
	assistantMaxRounds: int(1, 50),
	/** Tool calls one assistant turn may make. */
	assistantMaxToolCalls: int(1, 200),
	/** Turns one user may start per minute. */
	assistantTurnsPerMinute: int(1, 120),

	// ---------------------------------------------------------------- ingress HA
	/** `direct` keeps today's single edge; `dns-failover` maintains the platform record set. */
	ingressDriver: z.enum(ingressDrivers),
	/** Consecutive failed probes before an ingress is withdrawn (C5). */
	ingressHoldDownSeconds: int(10, 600),
	/** Healthy time before a recovered ingress is added back (C5). */
	ingressReaddSeconds: int(30, 3600),
};

export type PlatformPolicies = { [K in keyof typeof policyFields]: z.infer<(typeof policyFields)[K]> };
export type PlatformPolicyKey = keyof PlatformPolicies;

/** The values that were hardcoded before policies existed. */
export const PLATFORM_POLICY_DEFAULTS: PlatformPolicies = {
	trashDays: 7,
	retainedDeployments: 10,
	logRetentionDays: 7,
	deletedHistoryDays: 30,
	operationHistoryDays: 90,
	registryRetentionDays: 90,
	runnerRegistrationRetentionDays: 7,
	volumeSnapshotRetentionDays: 30,
	certWarnDays: 14,
	certCriticalDays: 3,
	nodeAlertMinutes: 2,
	diskAlertPercent: 85,
	databaseStorageAlertPercent: 85,
	databaseConnectionsAlertPercent: 90,
	poolSaturationAlertPercent: 90,
	storageAlertPercent: 85,
	brokerStoreAlertPercent: 85,
	systemAlertRepeatMinutes: 30,
	databaseBackupSchedule: '0 3 * * *',
	databaseBackupRetentionDays: 7,
	assistantMaxRounds: 12,
	assistantMaxToolCalls: 24,
	assistantTurnsPerMinute: 12,
	ingressDriver: 'direct',
	ingressHoldDownSeconds: 45,
	ingressReaddSeconds: 120,
};

const criticalBelowWarn = (input: { certWarnDays?: number; certCriticalDays?: number }) =>
	input.certWarnDays === undefined || input.certCriticalDays === undefined || input.certCriticalDays < input.certWarnDays;
const criticalMessage = {
	message: 'The critical certificate threshold must be fewer days than the warning threshold.',
	path: ['certCriticalDays'],
};

/**
 * The stored row. Each field is parsed on its own (`.catch`), so one hand-edited or out-of-range
 * value falls back to its default instead of discarding every other saved policy.
 */
export const platformPoliciesSchema = z.object(
	Object.fromEntries(
		Object.entries(policyFields).map(([key, field]) => {
			const fallback = PLATFORM_POLICY_DEFAULTS[key as PlatformPolicyKey];
			return [key, (field as z.ZodType).default(fallback).catch(fallback)];
		}),
	) as unknown as { [K in PlatformPolicyKey]: z.ZodType<PlatformPolicies[K]> },
);

/** An update names any subset of fields; omitted fields keep their saved value. */
export const platformPoliciesUpdateSchema = z.object(policyFields).partial().strict();
export type PlatformPoliciesUpdate = z.input<typeof platformPoliciesUpdateSchema>;

/** The merged result must still be coherent (checked after the update is applied). */
export const platformPoliciesMergedSchema = z.object(policyFields).refine(criticalBelowWarn, criticalMessage);
