import { parseArgs, rejectExtraPositionals, type FlagSpec } from '../args.ts';
import type { UsageMetricView, UsageView } from '../api.ts';
import { formatBytes, formatNumber, printJson, renderTable } from '../output.ts';
import { authenticatedClient } from './common.ts';

const flags: FlagSpec = {
	json: { type: 'boolean' },
	help: { type: 'boolean', short: 'h' },
};

const usage = `Usage: skif usage [project] [--json]

Show org usage and quota percentages. With a project, show only that project's resources.
Counts are current; database/storage bytes are the latest samples; egress is a 30-day estimate.`;

const METRICS = [
	'projects',
	'databases',
	'databaseStorageBytes',
	'storageInstances',
	'storageBytes',
	'storageObjects',
	'appVolumes',
	'appVolumeBytes',
	'jobs',
	'jobRunsPerDay',
	'buildsPerDay',
	'previews',
	'workloadMemoryMb',
	'egressBytes',
] as const;

export async function usageCommand(argv: string[]): Promise<void> {
	const args = parseArgs(argv, flags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 1, usage);
	const project = args.positionals[0];
	const client = await authenticatedClient();
	const { usage: view, raw } = await client.getUsage(project);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	printUsage(view);
}

export function printUsage(view: UsageView): void {
	const scope = view.projectSlug ? `project ${view.projectSlug}` : `org ${view.orgId}`;
	console.log(`${scope} · current usage · egress over ${view.periodDays} days`);
	const rows = METRICS.map((key) => {
		const metric = view.metrics[key];
		if (!metric) return null;
		return [
			label(key),
			formatMetric(metric.used, metric.unit),
			metric.limit < 0 ? 'unlimited' : formatMetric(metric.limit, metric.unit),
			metric.percent === null ? '-' : `${metric.percent.toFixed(1)}%`,
		];
	}).filter((row): row is string[] => row !== null);
	console.log(renderTable(['METRIC', 'USED', 'LIMIT', 'USED %'], rows));
	if (view.warnings.length > 0) {
		console.log('');
		console.log('Warnings:');
		for (const warning of view.warnings)
			console.log(`  ${label(warning.metric)} at ${warning.percent.toFixed(1)}%`);
	}
}

function label(key: string): string {
	return key
		.replace(/([A-Z])/g, ' $1')
		.replace(/^./, (char) => char.toUpperCase())
		.replace('Per Day', '/day');
}

function formatMetric(value: number, unit: UsageMetricView['unit']): string {
	if (unit === 'bytes') return formatBytes(value);
	if (unit === 'megabytes') return `${formatNumber(value)} MB`;
	return formatNumber(value);
}
