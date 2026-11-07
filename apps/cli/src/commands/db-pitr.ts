import { parseArgs, rejectExtraPositionals, requirePositional, type FlagSpec } from '../args.ts';
import { UsageError } from '../errors.ts';
import { nodeLabel, type DatabasePitrView } from '../databases.ts';
import { formatTime, printJson } from '../output.ts';
import { authenticatedClient } from './common.ts';
import { confirmOrRefuse } from './run-operation.ts';

/**
 * Point-in-time recovery (docs/PITR.md): `skif db pitr`, `skif db pitr-backup` and
 * `skif db restore-to`. Behind the control plane's SKIFF_FEATURE_PITR; every check is on the server.
 */

export const pitrUsage = `Usage:
  skif db pitr <name>                       Show WAL archiving, base backups and the recoverable window
  skif db pitr <name> --enable              Turn PITR on (PostgreSQL 18, standard image); restarts the
                                            database on the PITR image and takes the first full backup
  skif db pitr <name> --disable [--yes]     Stop archiving WAL; existing backups stay in the repository
  skif db pitr-backup <name> [--type full|diff|incr]
                                            Take a base backup now (default full)
  skif db restore-to <name> --time <ISO 8601> --as <new-name>
                                            Restore to a moment into a NEW database on the same node

Options:
  -y, --yes                    Don't ask for confirmation (required when stdin isn't a terminal)
      --json                   JSON output
  -h, --help                   Show this help

The control plane must run with SKIFF_FEATURE_PITR=on and a pgBackRest repository
(SKIFF_PITR_REPO_BUCKET, …). --time needs an offset or Z, e.g. 2026-11-05T09:30:00Z, and must be
inside the recoverable window \`skif db pitr <name>\` shows.`;

const base: FlagSpec = { json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } };
const pitrFlags: FlagSpec = {
	...base,
	enable: { type: 'boolean' },
	disable: { type: 'boolean' },
	yes: { type: 'boolean', short: 'y' },
};
const backupFlags: FlagSpec = { ...base, type: { type: 'string' } };
const restoreFlags: FlagSpec = { ...base, time: { type: 'string' }, as: { type: 'string' } };

function named(argv: string[], spec: FlagSpec, command: string) {
	const args = parseArgs(argv, spec);
	if (args.boolean('help')) {
		console.log(pitrUsage);
		return null;
	}
	rejectExtraPositionals(args, 1, `Usage: skif db ${command} <name>`);
	return { args, name: requirePositional(args, 0, `database name.\n\n${pitrUsage}`) };
}

/** Human summary of one database's PITR state. */
export function describePitr(pitr: DatabasePitrView): string[] {
	const when = (value: string | null) => (value ? formatTime(value) : '—');
	const lines = [
		`PITR:              ${pitr.enabled ? 'enabled' : 'off'} (${pitr.status})`,
		`Repository:        s3://${pitr.repo.bucket}/${[pitr.repo.pathPrefix, pitr.stanza].filter(Boolean).join('/')}${pitr.repo.endpoint ? ` at ${pitr.repo.endpoint}` : ''}`,
		`WAL archive:       ${pitr.archiveStatus ?? 'not checked yet'}${pitr.archiveAt ? ` (checked ${formatTime(pitr.archiveAt)})` : ''}`,
		`Last base backup:  ${pitr.lastBaseBackupAt ? `${formatTime(pitr.lastBaseBackupAt)} (${pitr.lastBaseBackupType})` : '—'}`,
		`Recoverable:       ${
			pitr.recoverableFrom && pitr.recoverableTo
				? `${formatTime(pitr.recoverableFrom)} → ${formatTime(pitr.recoverableTo)}${pitr.archiveStatus === 'ok' ? ' (and later while the archive is healthy)' : ''}`
				: 'nothing yet (needs a finished base backup)'
		}`,
	];
	if (pitr.enabled) lines.push(`Next full / diff:  ${when(pitr.nextFullAt)} / ${when(pitr.nextDiffAt)}`);
	if (pitr.verifiedAt) lines.push(`Last verified:     ${formatTime(pitr.verifiedAt)} (restore into ${pitr.lastRestoreDatabaseId})`);
	if (pitr.error) lines.push(`Problem:           ${pitr.error}`);
	return lines;
}

export async function pitrCommand(argv: string[]): Promise<void> {
	const parsed = named(argv, pitrFlags, 'pitr');
	if (!parsed) return;
	const { args, name } = parsed;
	const enable = args.boolean('enable');
	const disable = args.boolean('disable');
	if (enable && disable) throw new UsageError('Pass either --enable or --disable, not both.');
	const client = await authenticatedClient();
	let result: Awaited<ReturnType<typeof client.databasePitr>>;
	if (enable) {
		result = await client.setDatabasePitr(name, true);
	} else if (disable) {
		const confirmed = await confirmOrRefuse(
			`Stop archiving WAL for "${name}"? Point-in-time restores stop at this moment until you enable it again. [y/N] `,
			{ yes: args.boolean('yes'), refusal: 'Refusing to disable PITR without confirmation.' },
		);
		if (!confirmed) throw new UsageError('Cancelled.');
		result = await client.setDatabasePitr(name, false);
	} else {
		result = await client.databasePitr(name);
	}
	if (args.boolean('json')) {
		printJson(result.raw);
		return;
	}
	if (enable)
		console.log(
			`PITR is on for "${name}". It restarts on the PITR image, then the node takes the first full backup; the recoverable window appears once that backup is reported.\n`,
		);
	console.log(describePitr(result.pitr).join('\n'));
}

export async function pitrBackupCommand(argv: string[]): Promise<void> {
	const parsed = named(argv, backupFlags, 'pitr-backup');
	if (!parsed) return;
	const { args, name } = parsed;
	const type = args.string('type') ?? 'full';
	if (type !== 'full' && type !== 'diff' && type !== 'incr') throw new UsageError('--type must be full, diff or incr.');
	const client = await authenticatedClient();
	const { task, raw } = await client.createDatabasePitrBackup(name, type);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(`Queued a ${type} base backup (${task.id}) for "${name}". Follow it with \`skif db pitr ${name}\`.`);
}

export async function restoreToCommand(argv: string[]): Promise<void> {
	const args = parseArgs(argv, restoreFlags);
	if (args.boolean('help')) {
		console.log(pitrUsage);
		return;
	}
	const line = 'Usage: skif db restore-to <name> --time <ISO 8601> --as <new-name>';
	rejectExtraPositionals(args, 1, line);
	const name = requirePositional(args, 0, `source database name.\n\n${line}`);
	const time = args.string('time');
	const target = args.string('as');
	if (!time) throw new UsageError(`Pick the moment with --time, e.g. --time 2026-11-05T09:30:00Z.\n\n${line}`);
	if (!target) throw new UsageError(`Name the new database with --as <new-name>.\n\n${line}`);
	if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(time) || Number.isNaN(Date.parse(time)))
		throw new UsageError('--time must be an ISO 8601 timestamp with an offset or Z, e.g. 2026-11-05T09:30:00Z.');
	const client = await authenticatedClient();
	const { database, raw } = await client.restoreDatabaseToTime(name, {
		name: target,
		targetTime: new Date(time).toISOString(),
	});
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(`Restoring "${name}" to ${new Date(time).toISOString()} into "${database.name}" on node ${nodeLabel(database)}.`);
	console.log(`It stays pending until the node verifies it; follow it with \`skif db info ${database.name}\`.`);
}
