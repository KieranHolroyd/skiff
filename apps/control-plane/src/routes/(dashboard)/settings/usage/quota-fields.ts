import type { QuotaField, QuotaUsageMetricKey } from '@skiff/contracts';

/** How a quota reads in the dashboard; shared by the usage meters and the "Edit limits" form. */
export interface QuotaFieldMeta {
	label: string;
	/** Window for rolling counters; omitted for point-in-time totals. */
	period?: string;
	/** Extra context shown under the label. */
	hint?: string;
	/** Unit the edit form uses. Byte fields are entered in GB or MB and stored in bytes. */
	inputUnit?: 'GB' | 'MB';
}

export interface QuotaGroup {
	id: string;
	title: string;
	fields: QuotaField[];
}

const GB = 1024 ** 3;
const MB = 1024 ** 2;

export const QUOTA_FIELDS: Record<QuotaField, QuotaFieldMeta> = {
	projects: { label: 'Projects' },
	previews: { label: 'Previews', hint: 'Deployments that serve no environment and were never live' },
	buildsPerDay: { label: 'Builds', period: 'last 24 hours' },
	retainedDeployments: { label: 'Kept deployments', hint: 'Per project; older ones are pruned' },
	maxUploadBytes: { label: 'Largest upload', inputUnit: 'MB' },
	workloadMemoryMb: { label: 'Reserved memory', hint: 'Workloads, databases and storage' },
	egressBytes: {
		label: 'Egress',
		period: 'last 30 days',
		hint: 'Approximate; over the limit, new deploys are refused',
		inputUnit: 'GB'
	},
	jobs: { label: 'Jobs' },
	jobRunsPerDay: { label: 'Job runs', period: 'last 24 hours' },
	databases: { label: 'Databases' },
	databaseStorageBytes: { label: 'Database storage', inputUnit: 'GB' },
	storageInstances: { label: 'Storage services' },
	storageBytes: {
		label: 'Storage space',
		hint: 'Object storage and release artifacts',
		inputUnit: 'GB'
	},
	storageObjects: { label: 'Objects' },
	appVolumes: { label: 'Volumes' },
	appVolumeBytes: { label: 'Volume space', hint: 'Configured volume sizes', inputUnit: 'GB' }
};

/** Multiplier from the form's unit to the stored value. */
export const QUOTA_FIELD_SCALE: Partial<Record<QuotaField, number>> = Object.fromEntries(
	Object.entries(QUOTA_FIELDS)
		.filter(([, meta]) => meta.inputUnit)
		.map(([field, meta]) => [field, meta.inputUnit === 'GB' ? GB : MB])
);

/** Sections on the page, in reading order. Every quota field appears exactly once. */
export const QUOTA_GROUPS: QuotaGroup[] = [
	{
		id: 'apps',
		title: 'Apps and deploys',
		fields: ['projects', 'previews', 'buildsPerDay', 'retainedDeployments', 'maxUploadBytes']
	},
	{
		id: 'compute',
		title: 'Compute and network',
		fields: ['workloadMemoryMb', 'egressBytes', 'jobs', 'jobRunsPerDay']
	},
	{ id: 'databases', title: 'Databases', fields: ['databases', 'databaseStorageBytes'] },
	{
		id: 'storage',
		title: 'Object storage',
		fields: ['storageInstances', 'storageBytes', 'storageObjects']
	},
	{ id: 'volumes', title: 'Volumes', fields: ['appVolumes', 'appVolumeBytes'] }
];

/** Fields with a live usage reading; the rest (upload size, kept deployments) are limits only. */
export function isUsageMetric(field: QuotaField, metrics: object): field is QuotaUsageMetricKey {
	return field in metrics;
}

/** The value the edit form shows for a stored limit: blank when unlimited, else in its input unit. */
export function inputValue(field: QuotaField, stored: number): string {
	if (stored < 0) return '';
	const scale = QUOTA_FIELD_SCALE[field] ?? 1;
	const value = stored / scale;
	return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, '');
}
