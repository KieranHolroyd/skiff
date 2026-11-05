import { parseArgs, rejectExtraPositionals, requirePositional, type FlagSpec } from '../args.ts';
import { CliError, UsageError } from '../errors.ts';
import {
	assertEnvPrefix,
	databaseDetails,
	databaseTable,
	engineLabel,
	nodeLabel,
	parseCpus,
	parseMegabytes,
	type DatabaseCreateInput,
} from '../databases.ts';
import { formatBytes, formatTime, indent, printJson, renderTable } from '../output.ts';
import { authenticatedClient } from './common.ts';
import { confirmOrRefuse } from './run-operation.ts';

/** Managed databases (docs/DATABASES.md). Every check lives on the server; this is a thin client. */

const usage = `Usage: skif db <command> [options]

Commands:
  list                         List databases (the default); --all includes the trash
  create <name>                Create a PostgreSQL database
  info <name>                  Status, node, size vs budget, attached projects, top tables
  attach <name> -p <project>   Connect a database to a project (injects <PREFIX>_URL, …)
  detach <name> -p <project>   Disconnect it; the app restarts without the variables
  delete <name>                Move it to the trash (restorable for 7 days)
  restore <name>               Bring it back from the trash
  purge <name>                 Permanently delete a trashed database and its data
  logs <name>                  Tail the Postgres container journal (--follow to stream)
  credentials <name>           Print the connection URL (--json for user, password, host, port)
  restart <name>|--all         Restart a database (and its pooler) or every database
  upgrade <name> --to <major>  Plan a PostgreSQL major upgrade; --apply queues a backup
  rotate <name>                Rotate the owner password (--monitor for the monitor role)
  backups <name>               List backups and the last verified restore
  backup <name>|--all          Take a backup now (--pin keeps it past retention); --all backs up every database
  backup-delete <name> <id>    Delete one backup artifact
  restore-backup <name> <id>   Restore a backup into a new database (--as <new-name>)
  backup-policy <name>         Show or change the schedule and retention

Create options:
  -p, --project <slug>         Attach to this project right away (placed on its node)
      --prefix <PREFIX>        Env prefix for the attachment (default DATABASE)
      --version <16|17>        PostgreSQL major version (default 17)
      --placement <where>      auto (default), edge, or a node id
      --memory <size>          Memory limit, e.g. 256M or 1G (default 256M)
      --cpus <n>               CPU limit (default 1)
      --storage <size>         Storage budget for alerts and the gauge (default 10G)
      --[no-]pooler            PgBouncer sidecar (default on; injects <PREFIX>_POOL_URL)
      --extension <name>       Enable an allowlisted extension (repeatable)

Options:
  -y, --yes                    Don't ask for confirmation (required when stdin isn't a terminal)
      --json                   JSON output
  -h, --help                   Show this help

Attached apps get <PREFIX>_URL, _HOST, _PORT, _USER, _PASSWORD and _NAME at activation and must
run on the database's node (\`auto\` placement handles that). Credentials need the
database:credentials permission and every read is audited.

Examples:
  skif db create main --project api
  skif db attach main --project api --prefix DATABASE
  psql "$(skif db credentials main)"     # on the node, or through ssh -L <port>:127.0.0.1:<port>`;

const baseFlags: FlagSpec = {
	json: { type: 'boolean' },
	help: { type: 'boolean', short: 'h' },
};

const listFlags: FlagSpec = { ...baseFlags, all: { type: 'boolean', short: 'a' } };

const createFlags: FlagSpec = {
	...baseFlags,
	project: { type: 'string', short: 'p' },
	prefix: { type: 'string' },
	version: { type: 'string' },
	placement: { type: 'string' },
	memory: { type: 'string' },
	cpus: { type: 'string' },
	storage: { type: 'string' },
	pooler: { type: 'boolean' },
	extension: { type: 'string', multiple: true },
};

const attachFlags: FlagSpec = {
	...baseFlags,
	project: { type: 'string', short: 'p' },
	prefix: { type: 'string' },
};

const detachFlags: FlagSpec = { ...baseFlags, project: { type: 'string', short: 'p' } };

const confirmFlags: FlagSpec = { ...baseFlags, yes: { type: 'boolean', short: 'y' } };
const backupsFlags: FlagSpec = { ...baseFlags, pin: { type: 'boolean' }, all: { type: 'boolean' } };
const restoreBackupFlags: FlagSpec = {
	...baseFlags,
	as: { type: 'string' },
	placement: { type: 'string' },
	project: { type: 'string', short: 'p' },
	prefix: { type: 'string' },
};
const backupPolicyFlags: FlagSpec = {
	...baseFlags,
	schedule: { type: 'string' },
	retention: { type: 'string' },
	enable: { type: 'boolean' },
	disable: { type: 'boolean' },
};
const rotateFlags: FlagSpec = { ...baseFlags, monitor: { type: 'boolean' } };
const restartFlags: FlagSpec = { ...baseFlags, pooler: { type: 'boolean' }, all: { type: 'boolean' } };
const upgradeFlags: FlagSpec = {
	...baseFlags,
	to: { type: 'string' },
	apply: { type: 'boolean' },
	plan: { type: 'boolean' },
	yes: { type: 'boolean', short: 'y' },
};
const logsFlags: FlagSpec = {
	...baseFlags,
	follow: { type: 'boolean', short: 'f' },
	limit: { type: 'string' },
	level: { type: 'string' },
	q: { type: 'string' },
	after: { type: 'string' },
};

const subcommands: Record<string, (argv: string[]) => Promise<void>> = {
	list: listDatabases,
	ls: listDatabases,
	create: createDatabase,
	info: showDatabase,
	show: showDatabase,
	attach: attachDatabase,
	detach: detachDatabase,
	delete: deleteDatabase,
	rm: deleteDatabase,
	restore: restoreDatabase,
	purge: purgeDatabase,
	credentials: showCredentials,
	creds: showCredentials,
	logs: databaseLogs,
	backups: listBackups,
	backup: createBackup,
	'backup-delete': deleteBackup,
	'restore-backup': restoreBackup,
	'backup-policy': backupPolicy,
	restart: restartDatabase,
	rotate: rotateCredentials,
	upgrade: upgradeDatabase,
};

export async function dbCommand(argv: string[]): Promise<void> {
	const first = argv[0];
	if (first && !first.startsWith('-')) {
		const handler = subcommands[first];
		if (!handler) throw new UsageError(`Unknown db command "${first}".\n\n${usage}`);
		await handler(argv.slice(1));
		return;
	}
	await listDatabases(argv);
}

/** Parse, handle --help, and return the single `<name>` positional. */
function parseNamed(argv: string[], spec: FlagSpec, command: string) {
	const args = parseArgs(argv, spec);
	if (args.boolean('help')) {
		console.log(usage);
		return null;
	}
	const line = `Usage: skif db ${command} <name>`;
	rejectExtraPositionals(args, 1, line);
	const name = requirePositional(args, 0, `database name.\n\n${line}`);
	return { args, name };
}

function requireProject(project: string | undefined, command: string, name: string): string {
	if (!project) throw new UsageError(`Name the project: skif db ${command} ${name} --project <slug>`);
	return project;
}

async function listDatabases(argv: string[]): Promise<void> {
	const args = parseArgs(argv, listFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 0, 'Usage: skif db list [--all] [--json]');
	const client = await authenticatedClient();
	const { databases, raw } = await client.listDatabases({ includeDeleted: args.boolean('all') });
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	if (databases.length === 0) {
		console.log('No databases yet. Create one with `skif db create <name> --project <slug>`.');
		return;
	}
	console.log(databaseTable(databases));
}

async function createDatabase(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, createFlags, 'create');
	if (!parsed) return;
	const { args, name } = parsed;
	const prefix = args.string('prefix');
	const project = args.string('project');
	if (prefix !== undefined) {
		if (!project) throw new UsageError('--prefix needs --project (it names the attachment).');
		assertEnvPrefix(prefix);
	}
	const input: DatabaseCreateInput = { name };
	if (project) input.project = project;
	if (prefix) input.envPrefix = prefix;
	const version = args.string('version');
	if (version) input.version = version;
	const placement = args.string('placement');
	if (placement) input.placement = placement;
	const memory = args.string('memory');
	if (memory) input.memoryMb = parseMegabytes(memory, '--memory');
	const cpus = args.string('cpus');
	if (cpus) input.cpus = parseCpus(cpus);
	const storage = args.string('storage');
	if (storage) input.storageMb = parseMegabytes(storage, '--storage');
	if (args.has('pooler')) input.pooler = args.boolean('pooler');
	const extensions = args.strings('extension');
	if (extensions.length > 0) input.extensions = extensions;

	const client = await authenticatedClient();
	const { database, raw } = await client.createDatabase(input);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(`Created ${engineLabel(database)} database "${database.name}" on node ${nodeLabel(database)} (${database.status}).`);
	const attached = database.attachments[0];
	if (attached)
		console.log(
			`Attached to ${attached.projectSlug} as ${attached.envPrefix}: it receives ${attached.envNames.join(', ')} at its next activation.`,
		);
	const steps = [
		`Follow it:    skif db info ${database.name}`,
		...(attached ? [] : [`Attach:       skif db attach ${database.name} --project <slug>`]),
		`Connect:      skif db credentials ${database.name}`,
	];
	console.log(`\nNext steps:\n${indent(steps)}`);
}

async function showDatabase(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, baseFlags, 'info');
	if (!parsed) return;
	const { args, name } = parsed;
	const client = await authenticatedClient();
	const { database, raw } = await client.getDatabase(name, { includeDeleted: true });
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(databaseDetails(database));
	if (database.deletedAt)
		console.log(`\nIn the trash. Restore with \`skif db restore ${database.name}\`; delete for good with \`skif db purge ${database.name}\`.`);
}

async function attachDatabase(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, attachFlags, 'attach');
	if (!parsed) return;
	const { args, name } = parsed;
	const project = requireProject(args.string('project'), 'attach', name);
	const prefix = args.string('prefix');
	if (prefix !== undefined) assertEnvPrefix(prefix);
	const client = await authenticatedClient();
	const { attachment, warning, raw } = await client.attachDatabase(project, {
		database: name,
		...(prefix ? { envPrefix: prefix } : {}),
	});
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(`Attached "${attachment.databaseName}" to ${attachment.projectSlug} as ${attachment.envPrefix}.`);
	console.log(
		`${attachment.projectSlug} receives ${attachment.envNames.join(', ')} at activation; a running app restarts on its own.`,
	);
	if (warning) console.log(`Note: ${warning}`);
}

async function detachDatabase(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, detachFlags, 'detach');
	if (!parsed) return;
	const { args, name } = parsed;
	const project = requireProject(args.string('project'), 'detach', name);
	const client = await authenticatedClient();
	const raw = await client.detachDatabase(project, name);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(`Detached "${name}" from ${project}. The app restarts without its database variables; the data is untouched.`);
}

async function deleteDatabase(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, confirmFlags, 'delete');
	if (!parsed) return;
	const { args, name } = parsed;
	const client = await authenticatedClient();
	// Fail before asking when the server would refuse anyway.
	const { database: current } = await client.getDatabase(name);
	if (current.attachments.length > 0)
		throw new CliError(
			`Database "${name}" is attached to ${current.attachments.map((item) => item.projectSlug).join(', ')}. Detach it first.`,
			{
				code: 'conflict',
				suggestions: current.attachments.map((item) => `skif db detach ${name} --project ${item.projectSlug}`),
			},
		);
	const confirmed = await confirmOrRefuse(
		`Delete database "${name}"? Its container stops now; the data stays on node ${nodeLabel(current)} and is restorable for 7 days. [y/N] `,
		{
			yes: args.boolean('yes'),
			refusal: `Not confirmed: stdin is not a terminal, so there's no one to ask before deleting "${name}".`,
		},
	);
	if (!confirmed) {
		console.error('Cancelled. Nothing was changed.');
		process.exitCode = 1;
		return;
	}
	const { database, raw } = await client.deleteDatabase(name);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(`Deleted "${database.name}".${database.purgeAt ? ` It is purged for good after ${formatTime(database.purgeAt)}.` : ''}`);
	console.log(`Undo: skif db restore ${database.name}`);
}

async function restoreDatabase(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, baseFlags, 'restore');
	if (!parsed) return;
	const { args, name } = parsed;
	const client = await authenticatedClient();
	const { database, raw } = await client.restoreDatabase(name);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(`Restored "${database.name}" on node ${nodeLabel(database)} (${database.status}). Re-attach projects with \`skif db attach\`.`);
}

async function purgeDatabase(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, confirmFlags, 'purge');
	if (!parsed) return;
	const { args, name } = parsed;
	const client = await authenticatedClient();
	const { database } = await client.getDatabase(name, { includeDeleted: true });
	if (!database.deletedAt)
		throw new CliError(`Database "${name}" is not in the trash. Delete it first.`, {
			code: 'conflict',
			suggestions: [`skif db delete ${name}`],
		});
	const confirmed = await confirmOrRefuse(
		`This permanently deletes database "${name}" and its data on node ${nodeLabel(database)}. It cannot be undone. Type ${name} to confirm: `,
		{
			yes: args.boolean('yes'),
			accept: (answer) => answer === name,
			refusal: `Not confirmed: stdin is not a terminal, so there's no one to ask before purging "${name}".`,
		},
	);
	if (!confirmed) {
		console.error('Cancelled. Nothing was changed.');
		process.exitCode = 1;
		return;
	}
	const raw = await client.purgeDatabase(name);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(`Purging "${name}": its node deletes the data, then it disappears from \`skif db list --all\`.`);
}

async function showCredentials(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, baseFlags, 'credentials');
	if (!parsed) return;
	const { args, name } = parsed;
	const client = await authenticatedClient();
	const { credentials, raw } = await client.databaseCredentials(name);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	// The URL alone on stdout, so `psql "$(skif db credentials main)"` works.
	console.log(credentials.url);
	if (process.stderr.isTTY && credentials.note) process.stderr.write(`${credentials.note}\n`);
}

async function databaseLogs(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, logsFlags, 'logs');
	if (!parsed) return;
	const { args, name } = parsed;
	const client = await authenticatedClient();
	const level = args.string('level');
	if (level && !['debug', 'info', 'warn', 'error'].includes(level))
		throw new UsageError('--level must be debug, info, warn or error.');
	const limit = args.string('limit') ? Number(args.string('limit')) : undefined;
	if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 2000))
		throw new UsageError('--limit must be a whole number between 1 and 2000.');
	const after = args.string('after') ? Number(args.string('after')) : undefined;
	const follow = args.boolean('follow');
	let cursor = after;
	let first = true;

	do {
		const page = await client.databaseLogs(name, {
			...(cursor !== undefined ? { after: cursor } : {}),
			limit: limit ?? (follow ? 200 : 500),
			...(level ? { level } : {}),
			...(args.string('q') ? { q: args.string('q') } : {}),
		});
		if (args.boolean('json') && !follow) {
			printJson(page.raw);
			return;
		}
		if (page.events.length > 0) {
			if (!first && follow) console.log('---');
			for (const event of page.events) {
				const time = new Date(event.ts).toISOString().slice(11, 19);
				console.log(`${time} ${event.level.toUpperCase().padEnd(5)} ${event.message}`);
			}
			first = false;
		} else if (!follow) {
			console.log(`No logs for "${name}" yet.`);
			return;
		}
		cursor = page.cursor;
		if (!follow) return;
		await Bun.sleep(2_000);
	} while (follow);
}

async function restartDatabase(argv: string[]): Promise<void> {
	if (argv.includes('--all')) {
		const args = parseArgs(argv, restartFlags);
		if (args.boolean('help')) {
			console.log(usage);
			return;
		}
		const client = await authenticatedClient();
		const { result, raw } = await client.restartServices({ scope: 'databases' });
		if (args.boolean('json')) {
			printJson(raw);
			return;
		}
		console.log(`Restarting ${result.restarted.databases.length} database${result.restarted.databases.length === 1 ? '' : 's'}.`);
		for (const item of result.skipped) console.log(`Skipped ${item.name}: ${item.reason}`);
		return;
	}
	const parsed = parseNamed(argv, restartFlags, 'restart');
	if (!parsed) return;
	const { args, name } = parsed;
	const target = args.boolean('pooler') ? 'pooler' : 'database';
	const client = await authenticatedClient();
	const { database, raw } = await client.restartDatabase(name, target);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(
		target === 'pooler'
			? `Restarting the pooler for "${name}". Postgres keeps its connections; the sidecar comes back in a few seconds.`
			: `Restarting "${name}" on node ${nodeLabel(database)}. Attached apps reconnect when it is back.`,
	);
}

async function upgradeDatabase(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, upgradeFlags, 'upgrade');
	if (!parsed) return;
	const { args, name } = parsed;
	const target = args.string('to');
	if (!target) throw new UsageError(`Usage: skif db upgrade ${name} --to <major> [--apply]`);
	const client = await authenticatedClient();
	if (!args.boolean('apply')) {
		const { plan, raw } = await client.databaseUpgradePlan(name, target);
		if (args.boolean('json')) {
			printJson(raw);
			return;
		}
		console.log(`PostgreSQL ${plan.fromVersion} → ${plan.toVersion} for "${name}" (${plan.status}).`);
		for (const blocker of plan.blockers) console.log(`Blocker: ${blocker}`);
		for (const warning of plan.warnings) console.log(`Warning: ${warning}`);
		for (const [index, step] of plan.steps.entries())
			console.log(`${index + 1}. ${step.title}${step.automatic ? ' (queued)' : ''}: ${step.detail}`);
		console.log(`\nDocs: ${plan.docs}. Re-run with --apply to queue the pinned pre-upgrade backup.`);
		return;
	}
	const confirmed = await confirmOrRefuse(
		`Queue a pinned backup and the manual PostgreSQL ${target} upgrade runbook for "${name}"? The major is not switched automatically.`,
		{ yes: args.boolean('yes'), refusal: 'Refusing to queue the upgrade backup without confirmation.' },
	);
	if (!confirmed) throw new UsageError('Cancelled.');
	const { plan, raw } = await client.applyDatabaseUpgrade(name, target);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	if (plan.status === 'blocked') {
		throw new CliError(`Upgrade blocked: ${plan.blockers.join(' ')}`, { code: 'upgrade_blocked' });
	}
	console.log(plan.message);
	if (plan.backupId) console.log(`Pre-upgrade backup: ${plan.backupId} (pinned).`);
	for (const [index, step] of plan.steps.entries()) console.log(`${index + 1}. ${step.title}: ${step.detail}`);
	console.log(`\nFollow ${plan.docs}. Nothing is switched automatically.`);
}

async function rotateCredentials(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, rotateFlags, 'rotate');
	if (!parsed) return;
	const { args, name } = parsed;
	const role = args.boolean('monitor') ? 'monitor' : 'owner';
	const client = await authenticatedClient();
	const { rotation, raw } = await client.rotateDatabase(name, role);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(
		`Queued ${role} credential rotation ${rotation.id} for "${name}". The node applies it on its next pull; attached apps restart with the new secret.`,
	);
}

async function listBackups(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, baseFlags, 'backups');
	if (!parsed) return;
	const { args, name } = parsed;
	const client = await authenticatedClient();
	const { backups, raw } = await client.listDatabaseBackups(name);
	const { database } = await client.getDatabase(name);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	const policy = database.backup;
	if (policy) {
		console.log(
			`Policy: ${policy.enabled ? 'enabled' : 'disabled'}, ${policy.schedule} UTC, ${policy.retentionDays}-day retention` +
				(policy.nextBackupAt ? `; next ${formatTime(policy.nextBackupAt)}` : '') +
				`; last verified restore ${policy.lastVerifiedAt ? formatTime(policy.lastVerifiedAt) : 'never'}.`,
		);
	}
	if (backups.length === 0) {
		console.log(`No backups yet. Take one with \`skif db backup ${name}\`.`);
		return;
	}
	console.log(
		renderTable(
			['ID', 'KIND', 'STATUS', 'SIZE', 'CREATED', 'VERIFIED', 'EXPIRES'],
			backups.map((backup) => [
				backup.id,
				backup.kind,
				backup.status,
				backup.sizeBytes === null ? '—' : formatBytes(backup.sizeBytes),
				formatTime(backup.finishedAt ?? backup.startedAt),
				backup.verifiedAt ? formatTime(backup.verifiedAt) : 'no',
				backup.expiresAt ? formatTime(backup.expiresAt) : 'never',
			]),
		),
	);
}

async function createBackup(argv: string[]): Promise<void> {
	if (argv.includes('--all')) {
		const args = parseArgs(argv, backupsFlags);
		if (args.boolean('help')) {
			console.log(usage);
			return;
		}
		const client = await authenticatedClient();
		const { result, raw } = await client.backupAllDatabases();
		if (args.boolean('json')) {
			printJson(raw);
			return;
		}
		console.log(`Queued ${result.queued.length} database backup${result.queued.length === 1 ? '' : 's'}.`);
		for (const item of result.skipped) console.log(`Skipped ${item.name}: ${item.reason}`);
		return;
	}
	const parsed = parseNamed(argv, backupsFlags, 'backup');
	if (!parsed) return;
	const { args, name } = parsed;
	const client = await authenticatedClient();
	const { backup, raw } = await client.createDatabaseBackup(name, { pinned: args.boolean('pin') });
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(`Queued backup ${backup.id} for "${name}". The node picks it up on its next pull; follow it with \`skif db backups ${name}\`.`);
}

async function deleteBackup(argv: string[]): Promise<void> {
	const args = parseArgs(argv, baseFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 2, 'Usage: skif db backup-delete <name> <backup-id>');
	const name = requirePositional(args, 0, 'database name');
	const backupId = requirePositional(args, 1, 'backup id');
	const client = await authenticatedClient();
	await client.deleteDatabaseBackup(name, backupId);
	if (args.boolean('json')) {
		printJson({ ok: true });
		return;
	}
	console.log(`Deleted backup ${backupId} of "${name}".`);
}

async function restoreBackup(argv: string[]): Promise<void> {
	const args = parseArgs(argv, restoreBackupFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 2, 'Usage: skif db restore-backup <name> <backup-id> --as <new-name>');
	const name = requirePositional(args, 0, 'source database name');
	const backupId = requirePositional(args, 1, 'backup id');
	const target = args.string('as');
	if (!target) throw new UsageError('Name the new database with --as <new-name>.');
	const prefix = args.string('prefix');
	if (prefix !== undefined) assertEnvPrefix(prefix);
	const client = await authenticatedClient();
	const { database, raw } = await client.restoreDatabaseBackup(name, backupId, {
		name: target,
		...(args.string('placement') ? { placement: args.string('placement')! } : {}),
		...(args.string('project') ? { project: args.string('project')! } : {}),
		...(prefix ? { envPrefix: prefix } : {}),
	});
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(`Restoring backup ${backupId} into "${database.name}" on node ${nodeLabel(database)}.`);
	console.log(`The node verifies the restore; follow it with \`skif db info ${database.name}\`.`);
}

async function backupPolicy(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, backupPolicyFlags, 'backup-policy');
	if (!parsed) return;
	const { args, name } = parsed;
	const retentionRaw = args.string('retention');
	const patch: { enabled?: boolean; schedule?: string; retentionDays?: number } = {};
	const schedule = args.string('schedule');
	if (schedule) patch.schedule = schedule;
	if (retentionRaw) {
		const days = Number(retentionRaw);
		if (!Number.isInteger(days) || days < 1 || days > 365)
			throw new UsageError('--retention must be a whole number of days between 1 and 365.');
		patch.retentionDays = days;
	}
	if (args.boolean('enable')) patch.enabled = true;
	if (args.boolean('disable')) patch.enabled = false;
	const client = await authenticatedClient();
	if (Object.keys(patch).length > 0) await client.setDatabaseBackupPolicy(name, patch);
	const { policy, raw } = await client.databaseBackupPolicy(name);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(JSON.stringify(policy, null, 2));
}
