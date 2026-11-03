import { parseArgs, type FlagSpec, type ParsedArgs } from '../args.ts';
import {
	CONFIG_KEYS,
	canonicalConfigKey,
	describeConfig,
	setStoredConfigValue,
	unsetStoredConfigValue,
} from '../config.ts';
import { UsageError } from '../errors.ts';
import { maskSecret, printJson, renderTable } from '../output.ts';

const flags: FlagSpec = {
	json: { type: 'boolean' },
	help: { type: 'boolean', short: 'h' },
};

const usage = `Usage: skif config <list|get|set|unset|path> [options]

Persistent settings live in ~/.config/skiff/config.json (mode 0600) and survive
\`skif logout\`, which removes only the API key. Settings belong to the selected
profile; use \`skif profile list\` to see them and \`--profile <name>\` to choose
one. SKIFF_CONFIG_DIR and XDG_CONFIG_HOME change the file location.

Settings:
  url            Control-plane URL, e.g. https://control.kieran.dev  (SKIFF_URL)
  contentDomain  Domain deployed sites use, e.g. kierancloud.dev     (SKIFF_CONTENT_DOMAIN)
  token          API key; prefer \`skif login\`, which verifies it     (SKIFF_TOKEN)

Commands:
  list                    Show effective settings and where each value came from
  get <key>               Print one value (list masks the token)
  set <key> <value>       Save a value
  unset <key>             Remove a value; \`unset token\` is equivalent to logout
  path                    Print the config file path

Aliases: platform/control for url, content-domain/sites-domain for contentDomain,
api-key for token.`;

export async function configCommand(argv: string[]): Promise<void> {
	const first = argv[0];
	const subcommand = first && !first.startsWith('-') ? first : 'list';
	const rest = first && !first.startsWith('-') ? argv.slice(1) : argv;
	const args = parseArgs(rest, flags);

	if (args.boolean('help') || subcommand === 'help') {
		console.log(usage);
		return;
	}

	switch (subcommand) {
		case 'list':
		case 'ls':
			await listSettings(args.boolean('json'));
			return;
		case 'get':
			await getSetting(args);
			return;
		case 'set':
			await setSetting(args);
			return;
		case 'unset':
		case 'remove':
		case 'rm':
			await unsetSetting(args);
			return;
		case 'path':
			await printPath(args);
			return;
		default:
			throw new UsageError(`"${subcommand}" is not a config command.\n\n${usage}`);
	}
}

async function listSettings(json: boolean): Promise<void> {
	const report = await describeConfig();
	const entries = report.entries.map((entry) => ({
		...entry,
		value: entry.secret && entry.value ? maskSecret(entry.value) : entry.value,
	}));

	if (json) {
		printJson({
			path: report.path,
			stored: report.stored,
			profile: report.profile ?? null,
			activeProfile: report.activeProfile ?? null,
			profiles: report.profiles,
			settings: entries,
		});
		return;
	}

	const rows = entries.map((entry) => [
		entry.key,
		entry.value ?? '-',
		entry.source === 'env' ? `env (${entry.env})` : entry.source,
	]);
	console.log(renderTable(['SETTING', 'VALUE', 'SOURCE'], rows));
	console.log(`\nProfile ${report.profile ?? 'none'}`);
	console.log(`Config  ${report.path}`);
	if (!report.stored) console.log('No settings saved yet. Run `skif config set url <control-url>`.');
}

async function getSetting(args: ParsedArgs): Promise<void> {
	if (args.positionals.length !== 1)
		throw new UsageError('Usage: skif config get <key>');
	const key = canonicalConfigKey(args.positionals[0]!);
	const report = await describeConfig();
	const entry = report.entries.find((candidate) => candidate.key === key)!;

	if (args.boolean('json')) {
		printJson({
			key,
			value: entry.value ?? null,
			source: entry.source,
			env: entry.env ?? null,
			path: report.path,
		});
		return;
	}
	// Script-friendly: print the value only, and nothing at all when unset.
	if (entry.value !== undefined) console.log(entry.value);
}

async function setSetting(args: ParsedArgs): Promise<void> {
	if (args.positionals.length !== 2)
		throw new UsageError('Usage: skif config set <key> <value>');
	const key = canonicalConfigKey(args.positionals[0]!);
	const change = await setStoredConfigValue(key, args.positionals[1]!);

	if (args.boolean('json')) {
		printJson({
			...change,
			value: CONFIG_KEYS[key].secret ? null : change.value,
		});
		return;
	}
	if (CONFIG_KEYS[key].secret) {
		console.log(`Stored the API key in ${change.path} (mode 0600).`);
		console.log('Run `skif login` to verify it, or use `skif config list` to check the URL.');
		return;
	}
	console.log(`Saved ${key} = ${change.value}`);
	if (change.profile) console.log(`Profile ${change.profile}`);
	console.log(`Config  ${change.path}`);
}

async function unsetSetting(args: ParsedArgs): Promise<void> {
	if (args.positionals.length !== 1)
		throw new UsageError('Usage: skif config unset <key>');
	const key = canonicalConfigKey(args.positionals[0]!);
	const change = await unsetStoredConfigValue(key);

	if (args.boolean('json')) {
		printJson(change);
		return;
	}
	if (!change.changed) {
		console.log(`${key} was not set.`);
		return;
	}
	console.log(`Removed ${key}.`);
	if (change.profile) console.log(`Profile ${change.profile}`);
	if (key === 'token') console.log('Settings such as url and contentDomain were kept.');
}

async function printPath(args: ParsedArgs): Promise<void> {
	if (args.positionals.length > 0) throw new UsageError('Usage: skif config path');
	const report = await describeConfig();
	if (args.boolean('json')) {
		printJson({ path: report.path, exists: report.stored, profile: report.profile ?? null });
		return;
	}
	console.log(report.path);
}
