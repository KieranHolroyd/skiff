import type { NodeView } from '@skiff/core';

/** One node's last heartbeat stats, typed. Missing figures stay null (older agents, non-Linux hosts). */
export interface NodeResources {
	id: string;
	name: string;
	status: string;
	/** Logical CPUs from the hardware report; null until the agent has sent one. */
	cpus: number | null;
	cpuPercent: number | null;
	load1: number | null;
	memoryUsedBytes: number | null;
	memoryTotalBytes: number | null;
	diskUsedBytes: number | null;
	diskTotalBytes: number | null;
	uptimeSeconds: number | null;
	/** The raw heartbeat blob, for the per-node meters. */
	stats: unknown;
}

/** Fleet totals across online nodes that reported stats. */
export interface FleetResources {
	/** Online nodes with a stats blob. */
	reporting: number;
	online: number;
	/** CPU use weighted by each node's logical CPUs (unweighted when a node has no hardware report). */
	cpuPercent: number | null;
	cpus: number | null;
	load1: number | null;
	memoryUsedBytes: number | null;
	memoryTotalBytes: number | null;
	diskUsedBytes: number | null;
	diskTotalBytes: number | null;
	/** Shortest uptime among reporting nodes: the most recent restart. */
	uptimeSeconds: number | null;
	/** The node under most pressure on each axis, when more than one node reports. */
	busiest: { cpu: Hotspot | null; memory: Hotspot | null; disk: Hotspot | null };
}

export interface Hotspot {
	name: string;
	pct: number;
}

export interface ResourceSummary {
	fleet: FleetResources;
	nodes: NodeResources[];
	/** ISO time the summary was built; the page shows how fresh the figures are. */
	at: string;
}

function num(stats: Record<string, unknown>, key: string): number | null {
	const value = stats[key];
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function nodeResources(node: NodeView): NodeResources {
	const stats =
		node.stats && typeof node.stats === 'object' ? (node.stats as Record<string, unknown>) : {};
	const cpus = node.hardware?.threads ?? node.hardware?.cores ?? null;
	return {
		id: node.id,
		name: node.name,
		status: node.status,
		cpus,
		cpuPercent: num(stats, 'cpuPercent'),
		load1: num(stats, 'load1'),
		memoryUsedBytes: num(stats, 'memoryBytes'),
		memoryTotalBytes: num(stats, 'memoryTotalBytes') || null,
		diskUsedBytes: num(stats, 'diskUsedBytes'),
		diskTotalBytes: num(stats, 'diskTotalBytes') || null,
		uptimeSeconds: num(stats, 'uptimeSeconds'),
		stats: node.stats
	};
}

/** Sum a figure across nodes; null when no node reported it. */
function total(rows: NodeResources[], pick: (row: NodeResources) => number | null): number | null {
	let sum: number | null = null;
	for (const row of rows) {
		const value = pick(row);
		if (value !== null) sum = (sum ?? 0) + value;
	}
	return sum;
}

function hottest(
	rows: NodeResources[],
	pct: (row: NodeResources) => number | null
): Hotspot | null {
	if (rows.length < 2) return null;
	let best: Hotspot | null = null;
	for (const row of rows) {
		const value = pct(row);
		if (value !== null && (best === null || value > best.pct))
			best = { name: row.name, pct: value };
	}
	return best;
}

const ratio = (used: number | null, size: number | null) =>
	used !== null && size ? (used / size) * 100 : null;

/**
 * CPU, memory and disk across the fleet, from each node's last heartbeat. Offline nodes are left
 * out: their figures are stale, and a dead node's last 3% CPU would flatter the average.
 */
export function summariseResources(nodes: NodeView[], now = Date.now()): ResourceSummary {
	const rows = nodes.map(nodeResources);
	const online = rows.filter((row) => row.status === 'online');
	const live = online.filter(
		(row) => row.cpuPercent !== null || row.memoryTotalBytes !== null || row.diskTotalBytes !== null
	);

	// Weight CPU by logical CPUs so a busy 2-core box does not read the same as a busy 32-core one.
	let cpuPercent: number | null = null;
	const withCpu = live.filter((row) => row.cpuPercent !== null);
	if (withCpu.length > 0) {
		const weighted = withCpu.every((row) => row.cpus !== null);
		const weight = (row: NodeResources) => (weighted ? row.cpus! : 1);
		const weights = withCpu.reduce((sum, row) => sum + weight(row), 0);
		cpuPercent = withCpu.reduce((sum, row) => sum + row.cpuPercent! * weight(row), 0) / weights;
	}

	const memoryRows = live.filter((row) => row.memoryUsedBytes !== null && row.memoryTotalBytes);
	const diskRows = live.filter((row) => row.diskUsedBytes !== null && row.diskTotalBytes);
	const uptimes = live.map((row) => row.uptimeSeconds).filter((value) => value !== null);

	return {
		at: new Date(now).toISOString(),
		nodes: rows,
		fleet: {
			reporting: live.length,
			online: online.length,
			cpuPercent,
			cpus: live.every((row) => row.cpus !== null) ? total(live, (row) => row.cpus) : null,
			load1: total(live, (row) => row.load1),
			memoryUsedBytes: total(memoryRows, (row) => row.memoryUsedBytes),
			memoryTotalBytes: total(memoryRows, (row) => row.memoryTotalBytes),
			diskUsedBytes: total(diskRows, (row) => row.diskUsedBytes),
			diskTotalBytes: total(diskRows, (row) => row.diskTotalBytes),
			uptimeSeconds: uptimes.length > 0 ? Math.min(...uptimes) : null,
			busiest: {
				cpu: hottest(live, (row) => row.cpuPercent),
				memory: hottest(live, (row) => ratio(row.memoryUsedBytes, row.memoryTotalBytes)),
				disk: hottest(live, (row) => ratio(row.diskUsedBytes, row.diskTotalBytes))
			}
		}
	};
}
