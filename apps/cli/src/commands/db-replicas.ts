import { parseArgs, rejectExtraPositionals, requirePositional, type FlagSpec } from '../args.ts';
import { CliError, UsageError } from '../errors.ts';
import type { DatabaseFailoverView, DatabaseReplicaView } from '../databases.ts';
import { formatBytes, formatTime, printJson, renderTable } from '../output.ts';
import { authenticatedClient } from './common.ts';
import { confirmOrRefuse } from './run-operation.ts';

/**
 * Postgres read replicas (docs/CLUSTERING.md §9.2–9.3): `yoal db replica list|add|remove|promote`.
 * A thin client; every refusal (engine, capacity, lag, fencing) comes from the server.
 */

export const replicaUsage = `Usage:
  yoal db replica list <name>                 Replicas with status, lag and the promotion history
  yoal db replica add <name> --node <node>    Add an async streaming replica on a node (id or name);
                                              --disk <where> system, fast, bulk or a disk on that
                                              node (default: the primary's kind of disk)
  yoal db replica remove <name> <replica-id>  Stop it; its node deletes the copy, the primary drops
                                              its slot
  yoal db replica promote <name> <replica-id> Make the replica the primary: fence the old one,
                                              promote, re-point apps (asks; --yes to skip)
      --accept-data-loss                      Promote although the replica is behind (64 MB / 60 s),
                                              its lag report is stale, or the old primary's node
                                              cannot confirm it stopped

Options:
  -y, --yes                    Don't ask for confirmation (required when stdin isn't a terminal)
      --json                   JSON output
  -h, --help                   Show this help

Attached apps get <PREFIX>_READ_URL, _READ_URLS, _READ_HOST and _READ_PORT while a replica they can
reach is streaming or lagging. Reads may trail the primary by the lag; use <PREFIX>_URL for
read-your-writes. A replica on the primary's own node is for read scaling and cannot be promoted.`;

const base: FlagSpec = { json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } };
const addFlags: FlagSpec = { ...base, node: { type: 'string' }, disk: { type: 'string' }, volume: { type: 'string' } };
const removeFlags: FlagSpec = { ...base, yes: { type: 'boolean', short: 'y' } };
const promoteFlags: FlagSpec = { ...removeFlags, 'accept-data-loss': { type: 'boolean' } };

export async function replicaCommand(argv: string[]): Promise<void> {
	const [verb, ...rest] = argv;
	if (!verb || verb === '-h' || verb === '--help' || verb === 'help') {
		console.log(replicaUsage);
		return;
	}
	if (verb === 'list' || verb === 'ls') return listReplicas(rest);
	if (verb === 'add' || verb === 'create') return addReplica(rest);
	if (verb === 'remove' || verb === 'rm' || verb === 'delete') return removeReplica(rest);
	if (verb === 'promote') return promoteReplica(rest);
	throw new UsageError(`Unknown replica command "${verb}".\n\n${replicaUsage}`);
}

function parse(argv: string[], spec: FlagSpec, positionals: number, line: string) {
	const args = parseArgs(argv, spec);
	if (args.boolean('help')) {
		console.log(replicaUsage);
		return null;
	}
	rejectExtraPositionals(args, positionals, line);
	return args;
}

/** One row per replica: node, status, lag and what to do about a problem. */
export function replicaTable(replicas: readonly DatabaseReplicaView[]): string {
	return renderTable(
		['ID', 'NODE', 'STATUS', 'LAG', 'REPLAY LSN', 'PORT', 'NOTE'],
		replicas.map((replica) => [
			replica.id,
			`${replica.nodeName ?? replica.nodeId}${replica.sameNode ? ' (same node)' : ''}`,
			replica.removing ? 'removing' : replica.status,
			lagLabel(replica),
			replica.replayLsn ?? '—',
			replica.hostPort === null ? '—' : String(replica.hostPort),
			replica.message ?? '',
		]),
	);
}

export function lagLabel(replica: Pick<DatabaseReplicaView, 'lagBytes' | 'lagSeconds'>): string {
	if (replica.lagBytes === null && replica.lagSeconds === null) return '—';
	const parts: string[] = [];
	if (replica.lagSeconds !== null) parts.push(`${replica.lagSeconds < 10 ? replica.lagSeconds.toFixed(1) : Math.round(replica.lagSeconds)} s`);
	if (replica.lagBytes !== null) parts.push(formatBytes(replica.lagBytes));
	return parts.join(' / ');
}

function failoverLine(failover: DatabaseFailoverView): string {
	const from = failover.fromNodeName ?? failover.fromNodeId ?? '?';
	const to = failover.toNodeName ?? failover.toNodeId;
	const tail = failover.message ? ` — ${failover.message}` : '';
	return `${formatTime(failover.startedAt)}  ${from} → ${to}  generation ${failover.generation}  ${failover.stage}${tail}`;
}

async function listReplicas(argv: string[]): Promise<void> {
	const args = parse(argv, base, 1, 'Usage: yoal db replica list <name>');
	if (!args) return;
	const name = requirePositional(args, 0, `database name.\n\n${replicaUsage}`);
	const client = await authenticatedClient();
	const result = await client.databaseReplicas(name);
	if (args.boolean('json')) {
		printJson(result.raw);
		return;
	}
	if (result.replicas.length === 0) console.log(`"${name}" has no replicas. Add one with \`yoal db replica add ${name} --node <node>\`.`);
	else console.log(replicaTable(result.replicas));
	if (result.failovers.length > 0) {
		console.log(`\nPromotions (primary generation ${result.primaryGeneration}):`);
		for (const failover of result.failovers.slice(0, 5)) console.log(`  ${failoverLine(failover)}`);
	}
}

async function addReplica(argv: string[]): Promise<void> {
	const args = parse(argv, addFlags, 1, 'Usage: yoal db replica add <name> --node <node> [--disk <where>]');
	if (!args) return;
	const name = requirePositional(args, 0, `database name.\n\n${replicaUsage}`);
	const node = args.string('node');
	if (!node) throw new UsageError(`Name the node: yoal db replica add ${name} --node <node>`);
	const disk = args.string('disk') ?? args.string('volume');
	const client = await authenticatedClient();
	const { replica, raw } = await client.addDatabaseReplica(name, { node, ...(disk ? { storage: disk } : {}) });
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(
		`Added replica ${replica.id} of "${name}" on ${replica.nodeName ?? replica.nodeId}${replica.sameNode ? ' (same node: read scaling only)' : ''}. ` +
			'It copies the primary first, then streams; follow it with `yoal db replica list`.',
	);
}

async function removeReplica(argv: string[]): Promise<void> {
	const args = parse(argv, removeFlags, 2, 'Usage: yoal db replica remove <name> <replica-id>');
	if (!args) return;
	const name = requirePositional(args, 0, `database name.\n\n${replicaUsage}`);
	const id = requirePositional(args, 1, `replica id.\n\n${replicaUsage}`);
	const confirmed = await confirmOrRefuse(
		`Remove replica ${id} of "${name}"? Its copy of the data is deleted from its node; the primary is untouched. [y/N] `,
		{ yes: args.boolean('yes'), refusal: `Not confirmed: stdin is not a terminal, so there's no one to ask before removing ${id}.` },
	);
	if (!confirmed) {
		console.error('Cancelled. Nothing was changed.');
		process.exitCode = 1;
		return;
	}
	const client = await authenticatedClient();
	const { raw } = await client.removeDatabaseReplica(name, id);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(`Removing ${id}: it disappears once its node deleted the data and the primary dropped its slot.`);
}

async function promoteReplica(argv: string[]): Promise<void> {
	const args = parse(argv, promoteFlags, 2, 'Usage: yoal db replica promote <name> <replica-id> [--accept-data-loss]');
	if (!args) return;
	const name = requirePositional(args, 0, `database name.\n\n${replicaUsage}`);
	const id = requirePositional(args, 1, `replica id.\n\n${replicaUsage}`);
	const client = await authenticatedClient();
	const current = await client.databaseReplicas(name);
	const replica = current.replicas.find((item) => item.id === id);
	if (!replica)
		throw new CliError(`Database "${name}" has no replica ${id}.`, { code: 'not_found', suggestions: [`yoal db replica list ${name}`] });
	const acceptDataLoss = args.boolean('accept-data-loss');
	const confirmed = await confirmOrRefuse(
		`Promote ${id} on ${replica.nodeName ?? replica.nodeId} to primary of "${name}"? The current primary is stopped and ` +
			`replaced; this cannot be undone in place${acceptDataLoss ? ', and commits the replica has not replayed are lost' : ''}. ` +
			`Type ${name} to confirm: `,
		{
			yes: args.boolean('yes'),
			accept: (answer) => answer === name,
			refusal: `Not confirmed: stdin is not a terminal, so there's no one to ask before promoting ${id}.`,
		},
	);
	if (!confirmed) {
		console.error('Cancelled. Nothing was changed.');
		process.exitCode = 1;
		return;
	}
	const { failover, raw } = await client.promoteDatabaseReplica(name, id, {
		acceptDataLoss,
		ifMatch: current.primaryGeneration,
	});
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(
		`Promoting ${id} (generation ${failover.generation}): ${failover.stage === 'fencing' ? 'waiting for the old primary to stop' : 'the old primary is unreachable; promoting now'}. ` +
			'Follow it with `yoal db replica list`.',
	);
}
