#!/usr/bin/env node
/**
 * Skiff CLI. Published as the `skif` npm package and installed under two command names,
 * `skif` and `skiff` (D33), both pointing at this entrypoint.
 */
import pkg from '../package.json' with { type: 'json' };
import { ApiError, CliError, UsageError } from './errors.ts';
import { configCommand } from './commands/config.ts';
import { dbCommand } from './commands/db.ts';
import { storageCommand } from './commands/storage.ts';
import { brokerCommand } from './commands/broker.ts';
import { eventsCommand } from './commands/events.ts';
import { emailCommand } from './commands/email.ts';
import { functionCommand } from './commands/function.ts';
import { jobsCommand } from './commands/jobs.ts';
import { repoCommand, runOrPipelineCommand, secretCommand, varCommand, workflowCommand } from './commands/pipelines.ts';
import { haCommand } from './commands/ha.ts';
import { backupTargetCommand } from './commands/backup-target.ts';
import { blueprintCommand } from './commands/blueprint.ts';
import { logDrainCommand } from './commands/log-drain.ts';
import { iamCommand } from './commands/iam.ts';
import { registryCommand } from './commands/registry.ts';
import { auditCommand } from './commands/audit.ts';
import { volumeCommand } from './commands/volume.ts';
import { deployCommand } from './commands/deploy.ts';
import { deploymentsCommand } from './commands/deployments.ts';
import { loginCommand } from './commands/login.ts';
import { logoutCommand } from './commands/logout.ts';
import { logsCommand } from './commands/logs.ts';
import { containerCommand, shellCommand } from './commands/container.ts';
import { openCommand } from './commands/open.ts';
import { operationsCommand } from './commands/operations.ts';
import { profileCommand } from './commands/profile.ts';
import { projectsCommand } from './commands/projects.ts';
import { promoteCommand } from './commands/promote.ts';
import { pruneCommand } from './commands/prune.ts';
import { rollbackCommand } from './commands/rollback.ts';
import { statusCommand } from './commands/status.ts';
import { usageCommand } from './commands/usage.ts';
import { upgradeCommand } from './commands/upgrade.ts';
import { wranglerCommand } from './commands/wrangler.ts';
import { PROFILE_ENV, setProfileOverride } from './config.ts';

const invokedAs = 'skif';

const commands: Record<string, (argv: string[]) => Promise<void>> = {
	login: loginCommand,
	logout: logoutCommand,
	config: configCommand,
	profile: profileCommand,
	deploy: deployCommand,
	status: statusCommand,
	usage: usageCommand,
	projects: projectsCommand,
	deployments: deploymentsCommand,
	promote: promoteCommand,
	rollback: rollbackCommand,
	logs: logsCommand,
	container: containerCommand,
	ctr: containerCommand,
	shell: shellCommand,
	open: openCommand,
	prune: pruneCommand,
	blueprint: blueprintCommand,
	blueprints: blueprintCommand,
	operations: operationsCommand,
	ops: operationsCommand,
	db: dbCommand,
	databases: dbCommand,
	storage: storageCommand,
	s3: storageCommand,
	broker: brokerCommand,
	brokers: brokerCommand,
	queue: brokerCommand,
	function: functionCommand,
	functions: functionCommand,
	fn: functionCommand,
	jobs: jobsCommand,
	job: jobsCommand,
	run: runOrPipelineCommand,
	repo: repoCommand,
	repos: repoCommand,
	repository: repoCommand,
	workflow: workflowCommand,
	workflows: workflowCommand,
	wf: workflowCommand,
	secret: secretCommand,
	secrets: secretCommand,
	var: varCommand,
	vars: varCommand,
	events: eventsCommand,
	event: eventsCommand,
	email: emailCommand,
	mail: emailCommand,
	'backup-target': backupTargetCommand,
	backupTargets: backupTargetCommand,
	'log-drain': logDrainCommand,
	'log-drains': logDrainCommand,
	iam: iamCommand,
	registry: registryCommand,
	images: registryCommand,
	audit: auditCommand,
	volume: volumeCommand,
	volumes: volumeCommand,
	ha: haCommand,
	upgrade: upgradeCommand,
	wrangler: wranglerCommand,
};

const help = `${invokedAs} ${pkg.version} — deploy to your own Skiff cloud

Usage: ${invokedAs} <command> [options]   (\`skiff\` works too)

Commands:
  login [--url <platform>] [--token <key>]  Sign in (browser by default)
  logout [--all]                             Forget the API key (settings are kept)
  config [list|get|set|unset|path]           Inspect or change persistent settings
  profile [list|add|use|remove|show|current] Manage profiles for multiple deployments
  deploy [dir] [options]                     Zip and deploy a directory (wrangler-aware)
  wrangler <args…>                           Run wrangler locally (installs it if needed)
  status [project]                           Fleet health, or one project's status
  usage [project]                            Usage and quota percentages (showback)
  projects                                   List projects
  projects delete|restore|purge <slug…>      Bulk actions: shows the plan, then asks
  projects trash                             List the trash with purge dates
  deployments <project>                      List deployments
  promote <project> <deploymentId>           Move production to a deployment
  rollback <project>                         Move production back one deployment
  logs <project>                             Show recent project logs
  container [inspect|ls|cat|cp|restart] <p>  Inspect a container project, read its files, restart it (\`skif container --help\`)
  shell <project>                            Interactive shell inside a container project
  open <project>                             Open the site in a browser
  prune [--apply] [--plan <id>]              Find and remove orphaned data (dry run by default)
  operations [list|show|watch|cancel]        Inspect and follow bulk and prune operations
  blueprint <validate|plan|apply> [file]     Declare a stack in one file; plan shows the diff, apply runs it
  db [list|create|info|attach|detach|…]      Managed PostgreSQL databases (\`skif db --help\`)
  upgrade <plan|apply|rollback>              Preflight, install or roll back the platform
  storage [list|create|info|buckets|…]       Managed S3-compatible object storage (\`skif storage --help\`)
  broker [list|create|info|attach|…]         Managed queue brokers, NATS with JetStream (\`skif broker --help\`)
                                             Queue tools: send, peek, redrive, queue-purge, …
  function [invoke|cron]                     Test a function on its node: a request, or a cron run now (\`skif function --help\`)
  jobs [list|create|run|runs|logs|…]       Cron jobs and manual commands on an app (\`skif jobs --help\`)
  run <project> -- <command…>               Run a one-off command against the app's current release
  repo [list|show|add|remove]                Git repositories for pipelines (\`skif repo --help\`)
  run [list|view|watch|logs|cancel|rerun]    Pipeline runs: jobs, steps, logs (\`skif run --help\`)
  workflow [dispatch|run|lint]               Start a workflow, run a local file, or lint one (\`skif workflow --help\`)
  secret|var [list|set|rm] <repo>            Pipeline secrets and variables (\`skif secret --help\`)
  events [list|create|test|deliveries|…]    Publish platform events (uploads, alerts, deploys, backups) to a function queue (\`skif events --help\`)
  email [status|domains|send|log|…]          Send email from your own domains, a self-hosted SES (\`skif email --help\`)
  backup-target [list|add|test|remove]       Where backups are written (\`skif backup-target --help\`)
  log-drain [list|create|test|update|…]      Forward logs to a webhook or OTLP receiver (\`skif log-drain --help\`)
  iam [roles|bindings|groups|bind|…]         Roles, bindings and groups, and why access is allowed (\`skif iam --help\`)
  registry [status|login|repos|credentials|deploy]  The platform registry, private registry logins, image deploys (\`skif registry --help\`)
  audit [--from] [--to] [--all]              Org audit log, newest first, with a date range and paging
  volume [list|show|snapshot|restore|…]      Persistent app volumes and their snapshots (\`skif volume --help\`)
  ha status                                  Failover controller: lease, lost nodes, recent failovers (platform admin)

Global:
  --profile <name>  Use a saved profile (also ${PROFILE_ENV})
  -h, --help        Show help (also works per command)
  -v, --version     Print the version

Environment:
  SKIFF_URL              Platform URL, e.g. https://control.example.com (overrides the config)
  SKIFF_TOKEN            API key (overrides the config)
  SKIFF_CONTENT_DOMAIN   Domain deployed sites use, e.g. sites.example.com (overrides the config)
  SKIFF_PROFILE          Profile to use (overrides the active profile)

Settings and credentials are stored per profile at ~/.config/skiff/config.json with
mode 0600. With one profile commands use it automatically; with several, run
\`skif profile use <name>\` or pass --profile. \`logout\` removes only the selected
profile's API key; \`logout --all\` removes the file.

Bulk and prune commands exit 0 when everything succeeded, 3 when some items failed,
and 1 when the run failed or was cancelled. Ctrl-C detaches: the run keeps going on
the server and \`skif operations watch <id>\` picks it up again.`;

async function run(): Promise<void> {
	let argv: string[];
	try {
		const extracted = extractProfileFlag(process.argv.slice(2));
		argv = extracted.argv;
		if (extracted.profile !== undefined) setProfileOverride(extracted.profile);
	} catch (error) {
		const cliError = toCliError(error);
		console.error(`${invokedAs}: ${cliError.message}`);
		process.exitCode = cliError.exitCode;
		return;
	}
	const [command, ...rest] = argv;
	const wantsJson = argv.some((arg) => arg === '--json' || arg.startsWith('--json='));

	if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
		if (command === 'help' && rest[0] && commands[rest[0]]) {
			await commands[rest[0]]!(['--help']);
			return;
		}
		console.log(help);
		return;
	}
	if (command === '--version' || command === '-v' || command === 'version') {
		console.log(pkg.version);
		return;
	}

	const handler = commands[command];
	if (!handler) {
		if (command === 'agent') {
			console.error(
				`${invokedAs}: 'agent join' is handled by the Skiff agent installer, not the CLI.`,
			);
		} else {
			console.error(`${invokedAs}: '${command}' is not a command. Run \`${invokedAs} --help\`.`);
		}
		process.exitCode = 1;
		return;
	}

	try {
		await handler(rest);
	} catch (error) {
		const cliError = toCliError(error);
		if (wantsJson) {
			const payload: Record<string, unknown> = {
				error: {
					code: cliError.code,
					message: cliError.message,
					suggestions: cliError.suggestions,
				},
			};
			if (cliError instanceof ApiError) {
				payload.error = {
					...(payload.error as Record<string, unknown>),
					status: cliError.status,
					requestId: cliError.requestId,
				};
			}
			console.error(JSON.stringify(payload, null, 2));
		} else {
			console.error(`${invokedAs}: ${cliError.message}`);
			for (const suggestion of cliError.suggestions) console.error(`  ${suggestion}`);
		}
		if (process.env.SKIFF_DEBUG === '1') console.error(cliError);
		process.exitCode = cliError.exitCode;
	}
}

/**
 * Pull the global `--profile` option out of argv before a command parses its own
 * flags. `--profile` may appear before or after the command, but never after `--`.
 */
function extractProfileFlag(argv: string[]): { argv: string[]; profile?: string } {
	const rest: string[] = [];
	let profile: string | undefined;
	let flagsDone = false;

	for (let i = 0; i < argv.length; i++) {
		const token = argv[i]!;
		if (flagsDone) {
			rest.push(token);
			continue;
		}
		if (token === '--') {
			flagsDone = true;
			rest.push(token);
			continue;
		}
		if (token === '--profile') {
			const value = argv[i + 1];
			if (value === undefined) throw new UsageError('Option --profile needs a value.');
			profile = value;
			i++;
			continue;
		}
		if (token.startsWith('--profile=')) {
			profile = token.slice('--profile='.length);
			if (!profile) throw new UsageError('Option --profile needs a value.');
			continue;
		}
		rest.push(token);
	}

	return { argv: rest, profile };
}

function toCliError(error: unknown): CliError {
	if (error instanceof CliError) return error;
	if (error instanceof Error) {
		const wrapped = new CliError(error.message);
		wrapped.stack = error.stack;
		return wrapped;
	}
	return new CliError(String(error));
}

await run();
