import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { parseArgs, rejectExtraPositionals, type FlagSpec } from '../args.ts';
import { authenticatedClient } from './common.ts';
import { CliError, UsageError } from '../errors.ts';
import { printJson } from '../output.ts';
import { confirmOrRefuse } from './run-operation.ts';

/**
 * Platform upgrade operations. These are host-level actions, so on a Skiff server the command
 * shells out to the root-owned `skiff-update-self` (the updater re-checks everything itself).
 * `plan` also works remotely through the read-only API.
 */

const usage = `Usage: skif upgrade <plan|apply|rollback> [options]

Commands:
  plan                  Preflight the next release (disk, backup target, migrations, Postgres majors)
  apply                 Install the newer VERSION, with a sealed snapshot and /readyz rollback
  rollback              Switch back to the previous release (repeat to undo)

Options:
  --version <v>         Plan a specific target version
  --repo <owner/name>   GitHub repository (plan/apply)
  --ref <ref>           Branch, tag or sha (plan/apply)
  --force               Rebuild or deliberately downgrade (apply)
  --with-agent          Restart skiff-agent on the new release
  --restore-db          Rollback: also restore the control DB snapshot (loses later writes)
  --keep-db             Rollback: run the old code against the newer schema
  --yes                 Don't ask for confirmation
  --json                JSON output
  -h, --help            Show this help

Run apply/rollback on the Skiff host as root (or through the dashboard). The CLI delegates to
\`skiff-update-self\`; an API key cannot perform a platform mutation.`;

const flags: FlagSpec = {
	version: { type: 'string' },
	repo: { type: 'string' },
	ref: { type: 'string' },
	force: { type: 'boolean' },
	'with-agent': { type: 'boolean' },
	'restore-db': { type: 'boolean' },
	'keep-db': { type: 'boolean' },
	yes: { type: 'boolean', short: 'y' },
	json: { type: 'boolean' },
	help: { type: 'boolean', short: 'h' }
};

const LOCAL_UPDATER = process.env.SKIFF_UPDATE_SELF ?? '/usr/local/sbin/skiff-update-self';

function onHost(): boolean {
	return (process.getuid?.() ?? -1) === 0 && existsSync(LOCAL_UPDATER);
}

function local(args: string[]): never {
	const result = spawnSync(LOCAL_UPDATER, args, { stdio: 'inherit' });
	process.exit(result.status ?? 1);
}

export async function upgradeCommand(argv: string[]): Promise<void> {
	const sub = argv[0] && !argv[0].startsWith('-') ? argv.shift()! : 'plan';
	if (!['plan', 'apply', 'rollback'].includes(sub))
		throw new UsageError(`Unknown upgrade command "${sub}".\n\n${usage}`);
	const args = parseArgs(argv, flags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 0, `Usage: skif upgrade ${sub}`);

	if (sub === 'plan') return plan(args);
	if (sub === 'apply') return apply(args);
	return rollback(args);
}

async function plan(args: ReturnType<typeof parseArgs>): Promise<void> {
	if (onHost() && !args.string('version')) {
		const localArgs = ['plan'];
		if (args.string('repo')) localArgs.push('--repo', args.string('repo')!);
		if (args.string('ref')) localArgs.push('--ref', args.string('ref')!);
		if (args.boolean('json')) localArgs.push('--json');
		local(localArgs);
	}
	const client = await authenticatedClient();
	const { plan, raw } = await client.platformUpgradePlan(args.string('version'));
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	const value = plan as {
		ok?: boolean;
		currentVersion?: string;
		targetVersion?: string;
		errors?: string[];
		warnings?: string[];
		checks?: Array<{ id: string; status: string; message: string }>;
		migrations?: { pending?: unknown[]; destructive?: boolean };
	} | undefined;
	if (!value) throw new CliError('The platform returned an unexpected upgrade plan.', { code: 'protocol' });
	console.log(`Upgrade ${value.currentVersion} → ${value.targetVersion}: ${value.ok ? 'ready' : 'refused'}`);
	console.log(
		`Migrations: ${value.migrations?.pending?.length ?? 0} pending${value.migrations?.destructive ? ' (destructive)' : ''}`
	);
	for (const check of value.checks ?? [])
		console.log(`${check.status === 'ok' ? 'ok  ' : check.status === 'warn' ? 'warn' : 'FAIL'} ${check.id}: ${check.message}`);
	if (!value.ok)
		console.error('Run `sudo skiff-update-self plan` on the server for the authoritative check.');
}

async function apply(args: ReturnType<typeof parseArgs>): Promise<void> {
	const confirmed = await confirmOrRefuse(
		'Install the newest Skiff release? It snapshots the control DB and .env/APP_KEY, switches releases, and rolls back automatically if /readyz fails.',
		{ yes: args.boolean('yes'), refusal: 'Refusing to apply an upgrade without confirmation.' }
	);
	if (!confirmed) throw new UsageError('Cancelled.');
	if (!onHost())
		throw new CliError(
			'Applying an upgrade requires root on the Skiff host. Run `sudo skiff-update-self update` there, or use Settings → Updates in the dashboard.',
			{ code: 'local_required', suggestions: ['sudo skiff-update-self update'] }
		);
	const localArgs = ['update'];
	if (args.string('repo')) localArgs.push('--repo', args.string('repo')!);
	if (args.string('ref')) localArgs.push('--ref', args.string('ref')!);
	if (args.boolean('force')) localArgs.push('--force');
	if (args.boolean('with-agent')) localArgs.push('--with-agent');
	local(localArgs);
}

async function rollback(args: ReturnType<typeof parseArgs>): Promise<void> {
	const confirmed = await confirmOrRefuse(
		args.boolean('restore-db')
			? 'Roll back and restore the control database snapshot from the last switch? Writes since then are lost.'
			: 'Switch back to the previous release?',
		{ yes: args.boolean('yes'), refusal: 'Refusing to roll back without confirmation.' }
	);
	if (!confirmed) throw new UsageError('Cancelled.');
	if (!onHost())
		throw new CliError(
			'Rolling back requires root on the Skiff host. Run `sudo skiff-update-self rollback` there.',
			{ code: 'local_required', suggestions: ['sudo skiff-update-self rollback'] }
		);
	const localArgs = ['rollback'];
	if (args.boolean('restore-db')) localArgs.push('--restore-db');
	if (args.boolean('keep-db')) localArgs.push('--keep-db');
	if (args.boolean('with-agent')) localArgs.push('--with-agent');
	local(localArgs);
}
