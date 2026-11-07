/**
 * Managed queue brokers (docs/BROKERS.md, D111): the wire types the CLI reads, and pure formatting
 * for `skif broker`. Types mirror `packages/contracts/src/broker.ts`; the CLI bundle stays free of
 * runtime dependencies (D40), so keep them in sync.
 */
import { formatTime, renderTable, truncate } from './output.ts';

/** Mirrors `brokerEngines` in @skiff/contracts. Keep in sync; the server validates. */
export const BROKER_ENGINES = ['nats'] as const;

export type BrokerStatus = 'pending' | 'starting' | 'running' | 'failed' | 'stopped';

export interface BrokerAttachmentView {
	brokerId: string;
	brokerName: string;
	projectId: string;
	projectSlug: string;
	envPrefix: string;
	envNames: string[];
	createdAt: string;
}

export interface BrokerView {
	id: string;
	name: string;
	engine: string;
	engineLabel: string;
	protocol: string;
	version: string;
	upgradeVersions: string[];
	status: BrokerStatus;
	message: string | null;
	nodeId: string;
	nodeName: string | null;
	memoryMb: number;
	cpus: number;
	storageMb: number;
	username: string;
	internalHost: { process: string; container: string };
	volume: { id: string; name: string } | null;
	attachments: BrokerAttachmentView[];
	createdAt: string;
	updatedAt: string;
	deletedAt: string | null;
	purgeAt: string | null;
}

export interface BrokerCredentials {
	brokerId: string;
	name: string;
	username: string;
	password: string;
	url: string;
	host: string;
	port: number;
	connectionSnippets: Record<string, string>;
	note: string;
}

export interface BrokerCreateInput {
	name: string;
	engine?: string;
	version?: string;
	placement?: string;
	memoryMb?: number;
	cpus?: number;
	storageMb?: number;
	volume?: string;
	project?: string;
	envPrefix?: string;
}

export interface BrokerUpdateInput {
	memoryMb?: number;
	cpus?: number;
	storageMb?: number;
	version?: string;
}

function statusLabel(view: Pick<BrokerView, 'status' | 'deletedAt'>): string {
	return view.deletedAt ? 'deleted' : view.status;
}

function megabytes(mb: number): string {
	return mb >= 1024 && mb % 1024 === 0 ? `${mb / 1024}G` : `${mb}M`;
}

export function brokerTable(brokers: BrokerView[]): string {
	const rows = brokers.map((view) => [
		view.name,
		statusLabel(view),
		`${view.engineLabel} ${view.version}`,
		view.nodeName ?? view.nodeId,
		`${megabytes(view.memoryMb)} / ${megabytes(view.storageMb)}`,
		view.attachments.length ? truncate(view.attachments.map((item) => item.projectSlug).join(', '), 30) : '-',
		formatTime(view.createdAt),
	]);
	return renderTable(['NAME', 'STATUS', 'ENGINE', 'NODE', 'MEMORY / STORE', 'PROJECTS', 'CREATED'], rows);
}

/** The `skif broker info` report. */
export function brokerDetails(view: BrokerView): string {
	const lines: string[] = [];
	const field = (label: string, value: string) => lines.push(`${label.padEnd(10)}  ${value}`);
	field('Broker', view.name);
	field('Status', `${statusLabel(view)}${view.message ? ` (${view.message})` : ''}`);
	field('Engine', `${view.engineLabel} ${view.version} — ${view.protocol}`);
	if (view.upgradeVersions.length > 0) field('Upgrades', view.upgradeVersions.join(', '));
	field('Node', view.nodeName ? `${view.nodeName} (${view.nodeId})` : view.nodeId);
	field('Limits', `${megabytes(view.memoryMb)} memory, ${view.cpus} CPU, ${megabytes(view.storageMb)} message store`);
	if (view.volume) field('Volume', view.volume.name);
	field('User', view.username);
	field('Process', view.internalHost.process);
	field('Container', view.internalHost.container);
	field('Created', formatTime(view.createdAt));
	if (view.attachments.length === 0) lines.push('\nNot attached to any project.');
	else {
		lines.push('\nAttached to:');
		for (const item of view.attachments) lines.push(`  ${item.projectSlug.padEnd(24)} ${item.envNames.join(', ')}`);
	}
	return lines.join('\n');
}
