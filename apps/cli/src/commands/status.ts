import { parseArgs, rejectExtraPositionals, type FlagSpec } from '../args.ts';
import type { StatusView } from '../api.ts';
import { formatBytes, formatNumber, formatTime, printJson, renderTable } from '../output.ts';
import { authenticatedClient, deploymentTable } from './common.ts';

const flags: FlagSpec = {
	json: { type: 'boolean' },
	help: { type: 'boolean', short: 'h' },
};

const usage = `Usage: yoal status [project] [--json]

Show fleet health and node status. With a project, also show access modes and deployments.`;

export async function statusCommand(argv: string[]): Promise<void> {
	const args = parseArgs(argv, flags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 1, usage);
	const projectSlug = args.positionals[0];
	const json = args.boolean('json');
	const client = await authenticatedClient();

	if (!projectSlug) {
		const { status, raw } = await client.getStatus();
		if (json) {
			printJson(raw);
			return;
		}
		printStatus(status);
		return;
	}

	const [{ status, raw: statusRaw }, { project, raw: projectRaw }, { deployments, raw: deploymentsRaw }] =
		await Promise.all([
			client.getStatus(),
			client.getProject(projectSlug),
			client.listDeployments(projectSlug),
		]);

	if (json) {
		printJson({ status: statusRaw, project: projectRaw, deployments: deploymentsRaw });
		return;
	}

	printStatus(status);
	console.log('');
	console.log(`Project     ${project.slug}`);
	if (project.name) console.log(`Name        ${project.name}`);
	if (project.productionUrl) console.log(`URL         ${project.productionUrl}`);
	if (project.productionAccess)
		console.log(
			`Access      production ${project.productionAccess} · previews ${project.previewAccess ?? '-'}`,
		);
	console.log(`Production  ${project.productionDeploymentId ?? 'none'}`);
	console.log('');
	console.log(deploymentTable(deployments, project.productionDeploymentId));
}

function printStatus(status: StatusView): void {
	const deployments = status.counts.deployments;
	const active = status.counts.activeDeployments;
	const summaryRows: string[][] = [['Health', status.health]];
	if (status.platform?.origin) summaryRows.push(['Platform', status.platform.origin]);
	if (status.platform?.version) summaryRows.push(['Version', status.platform.version]);
	summaryRows.push(['Projects', formatNumber(status.counts.projects)]);
	summaryRows.push([
		'Deployments',
		`${formatNumber(deployments)}${
			active !== undefined && active !== deployments ? ` (${formatNumber(active)} active)` : ''
		}`,
	]);
	summaryRows.push([
		'Nodes',
		`${formatNumber(status.counts.onlineNodes)}/${formatNumber(status.counts.nodes)} online${
			status.counts.offlineNodes ? ` · ${formatNumber(status.counts.offlineNodes)} offline` : ''
		}`,
	]);
	if (status.counts.storageBytes !== undefined)
		summaryRows.push(['Storage', formatBytes(status.counts.storageBytes)]);
	if (status.versions?.agent) summaryRows.push(['Agent', `${status.versions.agent} (desired)`]);
	console.log(renderTable(['METRIC', 'VALUE'], summaryRows));

	if (status.nodes.length === 0) return;
	const rows = status.nodes.map((node) => [
		node.name ?? node.id ?? '-',
		node.status ?? '-',
		node.cpuPercent === undefined ? '-' : `${node.cpuPercent.toFixed(1)}%`,
		formatMemory(node.memoryUsedBytes, node.memoryTotalBytes),
		node.diskUsedPercent === undefined ? '-' : `${node.diskUsedPercent.toFixed(0)}%`,
		formatTime(node.lastHeartbeat),
	]);
	console.log('');
	console.log(renderTable(['NODE', 'STATUS', 'CPU', 'MEMORY', 'DISK', 'LAST SEEN'], rows));
}

function formatMemory(used: number | undefined, total: number | undefined): string {
	if (used === undefined) return '-';
	if (total === undefined) return formatBytes(used);
	return `${formatBytes(used)} / ${formatBytes(total)}`;
}
