/**
 * Workload specs and runtime views (DESIGN §3.4).
 *
 * The control plane owns validation and admission; this file only describes the JSON it returns
 * and formats it for a terminal. Secrets in a spec are references (`{ name }`), never values.
 */
import { formatNumber, renderTable } from './output.ts';

export interface WorkloadSecretRef {
	name: string;
	version?: number;
	delivery?: 'env' | 'file';
}

export interface WorkloadSpec {
	runtime: 'process' | 'container' | 'function' | string;
	command?: string[];
	engine?: 'bun' | 'node';
	image?: string;
	imageDigest?: string;
	port?: number;
	memoryMb?: number;
	cpus?: number;
	healthPath?: string;
	socketActivation?: boolean;
	idleStopSeconds?: number;
	env?: Record<string, string>;
	secrets?: WorkloadSecretRef[];
	data?: { sizeMb: number };
	ingress?: 'http' | 'none';
	replicas?: number;
	/** Fields this CLI does not know yet (runner, identity, function) are preserved verbatim. */
	[key: string]: unknown;
}

export interface WorkloadView {
	id?: string;
	projectId?: string;
	nodeId?: string | null;
	status?: string;
	upstream?: string | null;
	memoryMb?: number;
	cpus?: number;
	image?: string | null;
	imageDigest?: string | null;
	deploymentId?: string | null;
	message?: string | null;
	updatedAt?: string | null;
	[key: string]: unknown;
}

export interface NodeCapacityView {
	nodeId: string;
	name: string;
	mode: string;
	status: string;
	sliceMemoryMb: number;
	reservedMemoryMb: number;
	freeMemoryMb: number;
	workloadCount: number;
	diskFreeBytes: number | null;
	diskTotalBytes: number | null;
	reservedDiskBytes?: number;
}

/** Split a command the way the dashboard does: on whitespace, with no shell quoting. */
export function splitCommand(value: string): string[] {
	return value.trim().split(/\s+/).filter(Boolean);
}

/** `KEY=value` (the first `=` separates them, so a value may contain one). */
export function parseEnvPair(value: string): [string, string] {
	const index = value.indexOf('=');
	if (index <= 0) throw new Error(`Expected KEY=value, got "${value}".`);
	return [value.slice(0, index), value.slice(index + 1)];
}

/** `NAME`, `NAME=3` or `NAME=3:file` / `NAME:file`. */
export function parseSecretRef(value: string): WorkloadSecretRef {
	let text = value.trim();
	let delivery: WorkloadSecretRef['delivery'];
	const deliveryMatch = /:(env|file)$/.exec(text);
	if (deliveryMatch) {
		delivery = deliveryMatch[1] as 'env' | 'file';
		text = text.slice(0, deliveryMatch.index);
	}
	const [name, rawVersion] = text.split('=', 2);
	if (!name) throw new Error('Secret references need a name.');
	const ref: WorkloadSecretRef = { name };
	if (rawVersion !== undefined && rawVersion !== '') {
		const version = Number(rawVersion);
		if (!Number.isInteger(version) || version < 1)
			throw new Error(`Secret ${name} has an invalid version "${rawVersion}".`);
		ref.version = version;
	}
	if (delivery) ref.delivery = delivery;
	return ref;
}

export function adapterLabel(spec: WorkloadSpec): string {
	if (spec.runtime === 'process') {
		const engine = spec.engine === 'node' ? 'Node.js' : 'Bun';
		return spec.socketActivation === false ? `${engine}, port` : `${engine}, socket activation`;
	}
	if (spec.runtime === 'container') return 'Container';
	return 'Function';
}

/** The human-readable spec block shared by `workload show` and `workload set`. */
export function workloadDetails(spec: WorkloadSpec | null, workload?: WorkloadView | null): string[] {
	const lines: string[] = [];
	if (!spec) {
		lines.push('No runtime spec saved.');
	} else {
		lines.push(`Runtime     ${spec.runtime}`);
		if (spec.runtime === 'process') {
			lines.push(`Engine      ${spec.engine === 'node' ? 'Node.js' : 'Bun'}`);
			lines.push(`Command     ${spec.command?.join(' ') || '(default)'}`);
			lines.push(`Socket      ${spec.socketActivation === false ? 'disabled' : 'enabled'}`);
			lines.push(
				`Scale zero  ${
					spec.idleStopSeconds && spec.idleStopSeconds > 0
						? `after ${formatNumber(spec.idleStopSeconds)}s idle`
						: 'off (always on)'
				}`,
			);
		}
		if (spec.runtime === 'container') lines.push(`Image       ${spec.image ?? '(not set)'}`);
		lines.push(`Port        ${spec.port ?? 3000}`);
		lines.push(`Health path ${spec.healthPath ?? '/'}`);
		lines.push(`Memory      ${formatNumber(spec.memoryMb ?? 256)} MB`);
		lines.push(`CPU         ${formatNumber(spec.cpus ?? 1)}`);
		lines.push(`Ingress     ${spec.ingress ?? 'http'}`);
		lines.push(`Replicas    ${formatNumber(spec.replicas ?? 1)}`);
		const envCount = Object.keys(spec.env ?? {}).length;
		const secretCount = spec.secrets?.length ?? 0;
		lines.push(`Variables   ${formatNumber(envCount)} plain · ${formatNumber(secretCount)} secret`);
		lines.push(`Data        ${spec.data ? `${formatNumber(spec.data.sizeMb)} MB` : 'none'}`);
	}
	if (workload) {
		lines.push('');
		lines.push(`Status      ${workload.status ?? 'unknown'}`);
		if (workload.nodeId) lines.push(`Node        ${workload.nodeId}`);
		if (workload.deploymentId) lines.push(`Deployment  ${workload.deploymentId}`);
		if (workload.image) lines.push(`Live image  ${workload.image}${workload.imageDigest ? ' (pinned)' : ''}`);
		if (workload.message) lines.push(`Message     ${workload.message}`);
	}
	return lines;
}

export function capacityTable(capacity: NodeCapacityView[]): string {
	if (capacity.length === 0) return 'No nodes report a workload slice yet.';
	const rows = capacity.map((node) => [
		node.name || node.nodeId,
		node.status,
		node.mode,
		`${formatNumber(node.reservedMemoryMb)}/${formatNumber(node.sliceMemoryMb)} MB`,
		`${formatNumber(node.freeMemoryMb)} MB`,
		formatNumber(node.workloadCount),
	]);
	return renderTable(['NODE', 'STATUS', 'MODE', 'RESERVED/SLICE', 'FREE', 'WORKLOADS'], rows);
}
