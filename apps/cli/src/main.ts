#!/usr/bin/env node
/**
 * Skiff CLI. Published as the `skif` npm package and installed under two command names,
 * `skif` and `skiff` (D33), both pointing at this entrypoint.
 */
import pkg from '../package.json' with { type: 'json' };
import { ApiError, CliError, UsageError } from './errors.ts';
import { configCommand } from './commands/config.ts';
import { deployCommand } from './commands/deploy.ts';
import { deploymentsCommand } from './commands/deployments.ts';
import { loginCommand } from './commands/login.ts';
import { logoutCommand } from './commands/logout.ts';
import { logsCommand } from './commands/logs.ts';
import { openCommand } from './commands/open.ts';
import { profileCommand } from './commands/profile.ts';
import { projectsCommand } from './commands/projects.ts';
import { promoteCommand } from './commands/promote.ts';
import { rollbackCommand } from './commands/rollback.ts';
import { statusCommand } from './commands/status.ts';
import { PROFILE_ENV, setProfileOverride } from './config.ts';

const invokedAs = 'skif';

const commands: Record<string, (argv: string[]) => Promise<void>> = {
	login: loginCommand,
	logout: logoutCommand,
	config: configCommand,
	profile: profileCommand,
	deploy: deployCommand,
	status: statusCommand,
	projects: projectsCommand,
	deployments: deploymentsCommand,
	promote: promoteCommand,
	rollback: rollbackCommand,
	logs: logsCommand,
	open: openCommand,
};

const help = `${invokedAs} ${pkg.version} — deploy to your own Skiff cloud

Usage: ${invokedAs} <command> [options]   (\`skiff\` works too)

Commands:
  login [--url <platform>] [--token <key>]  Sign in (browser by default)
  logout [--all]                             Forget the API key (settings are kept)
  config [list|get|set|unset|path]           Inspect or change persistent settings
  profile [list|add|use|remove|show|current] Manage profiles for multiple deployments
  deploy [dir] [options]                     Zip and deploy a directory
  status [project]                           Fleet health, or one project's status
  projects                                   List projects
  deployments <project>                      List deployments
  promote <project> <deploymentId>           Move production to a deployment
  rollback <project>                         Move production back one deployment
  logs <project>                             Show recent project logs
  open <project>                             Open the site in a browser

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
profile's API key; \`logout --all\` removes the file.`;

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
