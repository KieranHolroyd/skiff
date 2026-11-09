import { parseArgs, type FlagSpec } from '../args.ts';
import { TOKEN_ENV, clearCredentials, configFile, deleteConfig } from '../config.ts';
import { UsageError } from '../errors.ts';
import { printJson } from '../output.ts';

const flags: FlagSpec = {
	all: { type: 'boolean' },
	json: { type: 'boolean' },
	help: { type: 'boolean', short: 'h' },
};

export async function logoutCommand(argv: string[]): Promise<void> {
	const args = parseArgs(argv, flags);
	if (args.boolean('help')) {
		console.log(`Usage: yoal logout [--profile <name>] [--all]

Remove the selected profile's API key. Its control-plane URL and content domain
are kept, so \`yoal login\` remembers them. Use --all to delete the whole config
file, including every profile.`);
		return;
	}
	if (args.positionals.length > 0)
		throw new UsageError('Usage: yoal logout [--profile <name>] [--all]');

	const path = configFile();
	const all = args.boolean('all');
	const result = all
		? { removed: await deleteConfig(), settingsKept: false, profile: undefined }
		: await clearCredentials();

	if (args.boolean('json')) {
		printJson({
			loggedOut: true,
			removed: result.removed,
			configPath: path,
			profile: result.profile ?? null,
			settingsKept: result.settingsKept,
			envTokenStillSet: Boolean(process.env[TOKEN_ENV]),
		});
		return;
	}

	if (all) {
		console.log(result.removed ? `Removed ${path}.` : 'Already logged out (no stored config).');
	} else if (result.removed && result.settingsKept) {
		console.log('Logged out. The URL and content domain were kept for the next login.');
		if (result.profile) console.log(`Profile ${result.profile}`);
	} else if (result.removed) {
		console.log('Logged out.');
		if (result.profile) console.log(`Profile ${result.profile}`);
	} else {
		console.log('Already logged out (no stored API key).');
		if (result.settingsKept) console.log(`Settings remain in ${path}.`);
	}
	if (process.env[TOKEN_ENV]) console.log(`Note: ${TOKEN_ENV} is still set in the environment.`);
}
