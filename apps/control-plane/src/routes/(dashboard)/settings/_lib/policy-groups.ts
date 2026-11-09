import ArchiveRestoreIcon from '@lucide/svelte/icons/archive-restore';
import DatabaseIcon from '@lucide/svelte/icons/database';
import GlobeIcon from '@lucide/svelte/icons/globe';
import SparklesIcon from '@lucide/svelte/icons/sparkles';
import type { PlatformPolicyKey } from '@skiff/contracts';

/**
 * Platform policies are one stored row (packages/contracts/src/platform-policies.ts), but each group
 * is edited on the Settings page it belongs to: retention and new-database defaults on Policies,
 * ingress on High availability, turn caps on Assistant. Alert thresholds are on Alerts → System
 * alerts. `PolicyPanel` renders a group; `savePolicies` (policies.server.ts) saves whichever keys a
 * form posts.
 */

export interface PolicyItem {
	key: PlatformPolicyKey;
	label: string;
	unit?: string;
	min?: number;
	max?: number;
	/** Free text (cron) instead of a number. */
	text?: boolean;
	/** Dropdown values instead of a text/number input. */
	options?: Array<{ value: string; label: string }>;
	description: string;
}

export interface PolicyGroup {
	title: string;
	description: string;
	icon: typeof ArchiveRestoreIcon;
	items: PolicyItem[];
}

export type PolicyGroupId = 'retention' | 'new-databases' | 'ingress' | 'assistant';

export const POLICY_GROUPS: Record<PolicyGroupId, PolicyGroup> = {
	retention: {
		title: 'Retention',
		description: 'How long deleted resources and history are kept before maintenance purges them.',
		icon: ArchiveRestoreIcon,
		items: [
			{
				key: 'trashDays',
				label: 'Trash period',
				unit: 'days',
				min: 1,
				max: 90,
				description:
					'Deleted apps, databases, storage and app volumes can be restored for this long. Applies to items deleted from now on.'
			},
			{
				key: 'retainedDeployments',
				label: 'Deployments kept per app',
				min: 1,
				max: 500,
				description:
					'Unpinned deployments kept when neither the org nor the app quota (Usage & limits) sets its own number.'
			},
			{
				key: 'logRetentionDays',
				label: 'Log retention',
				unit: 'days',
				min: 1,
				max: 90,
				description:
					'Build and runtime log lines older than this are pruned. A 500,000-line ceiling still applies.'
			},
			{
				key: 'deletedHistoryDays',
				label: 'Deleted-history retention',
				unit: 'days',
				min: 1,
				max: 365,
				description: 'Soft-deleted deployment records, revoked share links and expired redemptions.'
			},
			{
				key: 'operationHistoryDays',
				label: 'Operation history',
				unit: 'days',
				min: 1,
				max: 365,
				description: 'Finished bulk operations and prunes shown under Settings → Maintenance.'
			},
			{
				key: 'registryRetentionDays',
				label: 'Registry image retention',
				unit: 'days',
				min: 1,
				max: 3650,
				description:
					'Registry tags older than this can be pruned. The newest tags per repository (Settings → Container registries), deployment pins and images still used by a workload are always kept.'
			},
			{
				key: 'runnerRegistrationRetentionDays',
				label: 'Stale runner retention',
				unit: 'days',
				min: 1,
				max: 365,
				description:
					'GitHub Actions runner registrations for a deleted project, a removed runner or a shrunk pool are prunable after this.'
			},
			{
				key: 'volumeSnapshotRetentionDays',
				label: 'Volume snapshot retention',
				unit: 'days',
				min: 1,
				max: 3650,
				description: 'Unpinned app-volume snapshots older than this can be pruned; pinned snapshots are always kept.'
			}
		]
	},
	'new-databases': {
		title: 'New databases',
		description:
			'Backup policy given to managed databases created from now on. Each database can still change its own.',
		icon: DatabaseIcon,
		items: [
			{
				key: 'databaseBackupSchedule',
				label: 'Backup schedule',
				text: true,
				description: 'Five-field cron expression in UTC, e.g. 0 3 * * * for 03:00 daily.'
			},
			{
				key: 'databaseBackupRetentionDays',
				label: 'Backup retention',
				unit: 'days',
				min: 1,
				max: 365,
				description: 'Older backups are deleted; the newest is always kept.'
			}
		]
	},
	ingress: {
		title: 'Ingress',
		description:
			'How the platform hostname follows a healthy ingress node. No driver changes DNS yet: a withdrawal or re-add is a step you take by hand.',
		icon: GlobeIcon,
		items: [
			{
				key: 'ingressDriver',
				label: 'Ingress driver',
				options: [
					{ value: 'direct', label: 'Direct — one edge' },
					{ value: 'dns-failover', label: 'DNS failover' },
					{ value: 'cloudflare-lb', label: 'Cloudflare Load Balancing' },
					{ value: 'cloudflare-tunnel', label: 'Cloudflare Tunnel' }
				],
				description:
					'DNS failover maintains a record set of healthy ingress nodes; the others are documented drivers.'
			},
			{
				key: 'ingressHoldDownSeconds',
				label: 'Ingress hold-down',
				unit: 'seconds',
				min: 10,
				max: 600,
				description: 'Failed probes before an ingress is withdrawn from DNS.'
			},
			{
				key: 'ingressReaddSeconds',
				label: 'Ingress re-add hold-down',
				unit: 'seconds',
				min: 30,
				max: 3600,
				description: 'Healthy time before a recovered ingress is added back.'
			}
		]
	},
	assistant: {
		title: 'Turn limits',
		description:
			'Cost caps for the dashboard assistant. Each turn can call the model and tools several times.',
		icon: SparklesIcon,
		items: [
			{
				key: 'assistantMaxRounds',
				label: 'Model calls per turn',
				min: 1,
				max: 50,
				description: 'The turn stops after this many model calls.'
			},
			{
				key: 'assistantMaxToolCalls',
				label: 'Tool calls per turn',
				min: 1,
				max: 200,
				description: 'Further tool calls are refused and the model answers with what it has.'
			},
			{
				key: 'assistantTurnsPerMinute',
				label: 'Turns per user per minute',
				min: 1,
				max: 120,
				description: 'Rate limit on starting turns, per signed-in user.'
			}
		]
	}
};
