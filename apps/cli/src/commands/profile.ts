import { parseArgs, requirePositional, rejectExtraPositionals, type FlagSpec } from '../args.ts';
import {
	PROFILE_ENV,
	addProfile,
	describeProfiles,
	removeProfile,
	useProfile,
	type ProfileSummary,
} from '../config.ts';
import { ConfigError, UsageError } from '../errors.ts';
import { maskSecret, printJson, renderTable } from '../output.ts';

const flags: FlagSpec = {
	url: { type: 'string', short: 'u' },
	token: { type: 'string', short: 't' },
	'content-domain': { type: 'string' },
	use: { type: 'boolean' },
	force: { type: 'boolean' },
	json: { type: 'boolean' },
	help: { type: 'boolean', short: 'h' },
};

const usage = `Usage: skif profile <list|add|use|remove|show|current> [options]

Profiles keep a separate control-plane URL, API key and content domain for each
Skiff deployment, so one machine can talk to production, staging and a local
dev server. With one profile, commands use it automatically. With several, set
an active profile with \`skif profile use <name>\`, or select one per command
with \`--profile <name>\` (or ${PROFILE_ENV}).

Commands:
  list                              Show profiles (* = the one commands use)
  add <name> [options]              Add a profile
  use <name>                        Make <name> the active profile
  remove <name>                     Delete a profile (aliases: rm, delete)
  show [name]                       Show one profile (default: the active one)
  current                           Print the profile commands use

Add options:
  -u, --url <platform>              Control-plane URL, e.g. https://control.example.com
  -t, --token <key>                 API key; prefer \`skif login --profile <name>\`
      --content-domain <domain>     Domain deployed sites use, e.g. sites.example.com
      --use                         Make the new profile active
      --force                       Replace an existing profile
      --json                        Print the result as JSON
  -h, --help                        Show this help

Profiles live in ~/.config/skiff/config.json (mode 0600).`;

export async function profileCommand(argv: string[]): Promise<void> {
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
			await listProfiles(args.boolean('json'));
			return;
		case 'add':
		case 'create':
			await add(args);
			return;
		case 'use':
		case 'select':
		case 'switch':
			await use(args);
			return;
		case 'remove':
		case 'rm':
		case 'delete':
			await remove(args);
			return;
		case 'show':
			await show(args);
			return;
		case 'current':
		case 'whoami':
			await current(args.boolean('json'));
			return;
		default:
			throw new UsageError(`"${subcommand}" is not a profile command.\n\n${usage}`);
	}
}

async function listProfiles(json: boolean): Promise<void> {
	const report = await describeProfiles();
	const profiles = report.profiles.map(maskProfile);

	if (json) {
		printJson({
			path: report.path,
			activeProfile: report.activeProfile ?? null,
			currentProfile: report.currentProfile ?? null,
			profiles,
		});
		return;
	}

	if (profiles.length === 0) {
		console.log('No profiles yet. Run `skif login` or `skif profile add <name> --url <url>`.');
		return;
	}

	const rows = profiles.map((profile) => [
		`${profile.current ? '*' : ' '} ${profile.name}`,
		profile.url ?? '-',
		profile.contentDomain ?? '-',
		profile.token ?? '-',
	]);
	console.log(renderTable(['', 'URL', 'SITES', 'TOKEN'], rows));
	console.log(`\nConfig  ${report.path}`);
	if (report.activeProfile) console.log(`Active  ${report.activeProfile}`);
	else if (report.profiles.length > 1)
		console.log('No active profile. Run `skif profile use <name>`.');
}

async function add(args: ReturnType<typeof parseArgs>): Promise<void> {
	const name = requirePositional(args, 0, 'profile name');
	rejectExtraPositionals(args, 1, usage);
	const url = args.string('url');
	const token = args.string('token');
	const contentDomain = args.string('content-domain');
	if (!url && !token)
		throw new UsageError(
			'Provide --url and/or --token, or run `skif login --profile <name>` to sign in.',
		);

	const change = await addProfile(
		name,
		{ url, token, contentDomain },
		{ use: args.boolean('use'), force: args.boolean('force') },
	);
	if (args.boolean('json')) {
		printJson(change);
		return;
	}
	console.log(`${change.created ? 'Added' : 'Updated'} profile ${change.name}.`);
	if (change.activeProfile) console.log(`Active  ${change.activeProfile}`);
	console.log(`Config  ${change.path}`);
	if (change.activeProfile === change.name)
		console.log(`Run \`skif --profile ${change.name} status\` to check the connection.`);
	else console.log(`Run \`skif profile use ${change.name}\` to make it the default.`);
}

async function use(args: ReturnType<typeof parseArgs>): Promise<void> {
	const name = requirePositional(args, 0, 'profile name');
	rejectExtraPositionals(args, 1, usage);
	const change = await useProfile(name);
	if (args.boolean('json')) {
		printJson(change);
		return;
	}
	console.log(`Active profile is now ${change.name}.`);
	console.log(`Config  ${change.path}`);
}

async function remove(args: ReturnType<typeof parseArgs>): Promise<void> {
	const name = requirePositional(args, 0, 'profile name');
	rejectExtraPositionals(args, 1, usage);
	const change = await removeProfile(name);
	if (args.boolean('json')) {
		printJson(change);
		return;
	}
	console.log(`Removed profile ${change.name}.`);
	if (change.activeProfile) console.log(`Active  ${change.activeProfile}`);
	else console.log('No active profile. Run `skif profile use <name>` to choose one.');
}

async function show(args: ReturnType<typeof parseArgs>): Promise<void> {
	rejectExtraPositionals(args, 1, usage);
	const report = await describeProfiles();
	const requested = args.positionals[0];
	const name = requested ?? report.currentProfile;
	if (!name) throw noCurrentProfile(report.profiles.map((profile) => profile.name));
	const profile = report.profiles.find((candidate) => candidate.name === name);
	if (!profile)
		throw new ConfigError(`Unknown profile "${name}".`, {
			suggestions: [
				report.profiles.length > 0
					? `Available profiles: ${report.profiles.map((candidate) => candidate.name).join(', ')}.`
					: 'No profiles are configured.',
			],
		});

	const masked = maskProfile(profile);
	if (args.boolean('json')) {
		printJson({ path: report.path, activeProfile: report.activeProfile ?? null, profile: masked });
		return;
	}

	console.log(`Profile  ${profile.name}${profile.current ? ' (current)' : ''}`);
	if (profile.url) console.log(`URL      ${profile.url}`);
	if (profile.contentDomain) console.log(`Sites    ${profile.contentDomain}`);
	console.log(`Token    ${masked.token ?? '-'}`);
	if (profile.updatedAt) console.log(`Updated  ${profile.updatedAt}`);
	console.log(`Config   ${report.path}`);
}

async function current(json: boolean): Promise<void> {
	const report = await describeProfiles();
	if (!report.currentProfile) throw noCurrentProfile(report.profiles.map((profile) => profile.name));
	if (json) {
		printJson({
			profile: report.currentProfile,
			activeProfile: report.activeProfile ?? null,
			path: report.path,
		});
		return;
	}
	console.log(report.currentProfile);
}

function maskProfile(profile: ProfileSummary): ProfileSummary & { token?: string } {
	return { ...profile, token: profile.token ? maskSecret(profile.token) : undefined };
}

function noCurrentProfile(names: string[]): ConfigError {
	if (names.length === 0)
		return new ConfigError(
			'No profiles configured. Run `skif login` or `skif profile add <name> --url <url>`.',
		);
	return new ConfigError(
		`No active profile. Choose one of: ${[...names].sort().join(', ')}. Run \`skif profile use <name>\`.`,
		{ suggestions: ['Run `skif profile list` to see the profiles.'] },
	);
}
