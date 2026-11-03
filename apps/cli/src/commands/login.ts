import { ApiClient } from '../api.ts';
import {
	CONTENT_DOMAIN_ENV,
	TOKEN_ENV,
	URL_ENV,
	normalizePlatformUrl,
	platformOrigin,
	readStoredConfig,
	saveConfig,
} from '../config.ts';
import { parseArgs, type FlagSpec } from '../args.ts';
import { UsageError } from '../errors.ts';
import { printJson } from '../output.ts';
import { promptText } from '../prompt.ts';
import { webLogin } from '../web-login.ts';

const flags: FlagSpec = {
	url: { type: 'string', short: 'u' },
	token: { type: 'string', short: 't' },
	web: { type: 'boolean' },
	browser: { type: 'boolean', default: true },
	json: { type: 'boolean' },
	help: { type: 'boolean', short: 'h' },
};

type Identity = Awaited<ReturnType<ApiClient['whoami']>>;

export async function loginCommand(argv: string[]): Promise<void> {
	const args = parseArgs(argv, flags);
	if (args.boolean('help')) {
		console.log(`Usage: skif login [--url <platform>] [--no-browser] [--token <api-key>]

Sign in through the browser (default):
  skif login
  skif login --no-browser

Or store an API key created in the Skiff dashboard:
  skif login --url https://control.example.com --token <key>

Options:
  -u, --url <platform>   Control-plane URL (default: the stored URL)
      --web              Explicitly use browser sign-in (the default)
      --no-browser       Print the browser URL instead of opening it
  -t, --token <key>      Store an API key directly, skipping the browser
      --json             Print the result as JSON
  -h, --help             Show this help

Browser sign-in approves the CLI in the dashboard and stores a new API key.
Login keeps the URL and content domain already saved by \`skif config\`, and
records the platform and content domain the server reports. Credentials are
saved to ~/.config/skiff/config.json with mode 0600.

Environment: ${URL_ENV} and ${TOKEN_ENV} override the stored config. When ${TOKEN_ENV}
is set, \`skif login\` stores that key instead of opening the browser (use --web or
--no-browser to force browser sign-in).`);
		return;
	}
	if (args.positionals.length > 0)
		throw new UsageError('Usage: skif login [--url <platform>] [--no-browser] [--token <api-key>]');

	const tokenFlag = args.string('token');
	const explicitWeb = args.boolean('web');
	const noBrowser = !args.boolean('browser');
	const wantsWeb = explicitWeb || noBrowser;
	if (wantsWeb && tokenFlag)
		throw new UsageError('Use either browser sign-in or --token, not both.');

	// Browser approval is the default. An explicit --token, or SKIFF_TOKEN for CI, opts into
	// key login; --web / --no-browser force the browser flow even when SKIFF_TOKEN is set.
	const envToken = wantsWeb ? undefined : process.env[TOKEN_ENV]?.trim() || undefined;
	const tokenInput = tokenFlag ?? envToken;

	const stored = await readStoredConfig();
	const urlInput =
		args.string('url') ??
		process.env[URL_ENV] ??
		stored?.url ??
		(await promptText('Platform URL: '));
	if (!urlInput?.trim()) throw new UsageError('A platform URL is required.');
	const url = normalizePlatformUrl(urlInput);

	if (!tokenInput) {
		await loginWithBrowser(url, noBrowser, args.boolean('json'));
		return;
	}

	const token = tokenInput;
	if (!token.trim()) throw new UsageError('An API key is required.');

	const client = new ApiClient({
		baseUrl: url,
		token: token.trim(),
		origin: platformOrigin(url),
		userAgent: 'skif-cli',
	});
	const identity = await client.whoami();
	// Trust the server's canonical origin (e.g. after logging in through an IP).
	const savedUrl = normalizePlatformUrl(identity.platform ?? url);
	const path = await saveConfig({
		url: savedUrl,
		token: token.trim(),
		contentDomain: identity.contentDomain,
	});

	printLogin({
		url: savedUrl,
		path,
		identity,
		contentDomain: identity.contentDomain,
		json: args.boolean('json'),
		method: 'token',
	});
}

async function loginWithBrowser(url: string, noBrowser: boolean, json: boolean): Promise<void> {
	const result = await webLogin(url, {
		openBrowser: !noBrowser,
		onReady: ({ url: loginUrl, opened }) => {
			if (opened) {
				process.stderr.write('Authorize the CLI in your browser.\n');
			} else {
				process.stderr.write(`Open this URL to authorize the CLI:\n\n  ${loginUrl}\n\n`);
			}
		},
		onWaiting: () => process.stderr.write('Waiting for approval...\n'),
	});

	const savedUrl = normalizePlatformUrl(result.platform || url);
	const path = await saveConfig({
		url: savedUrl,
		token: result.token,
		contentDomain: result.contentDomain,
	});
	const identity = await new ApiClient({
		baseUrl: savedUrl,
		token: result.token,
		origin: platformOrigin(savedUrl),
		userAgent: 'skif-cli',
	}).whoami();

	printLogin({
		url: savedUrl,
		path,
		identity,
		contentDomain: result.contentDomain ?? identity.contentDomain,
		json,
		method: 'web',
	});
}

function printLogin(input: {
	url: string;
	path: string;
	identity: Identity;
	contentDomain?: string;
	json: boolean;
	method: 'token' | 'web';
}): void {
	const { url, path, identity, contentDomain, json, method } = input;
	if (json) {
		printJson({
			url,
			platform: identity.platform,
			contentDomain: contentDomain ?? null,
			user: identity.user,
			org: identity.org,
			permissions: identity.permissions,
			configPath: path,
			method,
		});
		return;
	}

	const userLabel =
		[identity.user.name, identity.user.email ? `<${identity.user.email}>` : undefined]
			.filter(Boolean)
			.join(' ') || identity.user.id || 'unknown';
	const orgLabel = identity.org
		? [
				identity.org.name ?? identity.org.slug ?? identity.org.id,
				identity.org.name && identity.org.slug ? `(${identity.org.slug})` : undefined,
				identity.org.role ? `· ${identity.org.role}` : undefined,
			]
				.filter(Boolean)
				.join(' ')
		: '-';

	console.log(`Logged in to ${url}`);
	console.log(`User   ${userLabel}`);
	console.log(`Org    ${orgLabel}`);
	if (contentDomain) console.log(`Sites  ${contentDomain}`);
	console.log(`Key    saved to ${path} (mode 0600)`);
	console.log('Note   `skif logout` removes the key but keeps the URL and domains.');
	if (process.env[URL_ENV] || process.env[TOKEN_ENV] || process.env[CONTENT_DOMAIN_ENV])
		console.log(
			`Note   ${URL_ENV}/${TOKEN_ENV}/${CONTENT_DOMAIN_ENV} are set and will override the stored config.`,
		);
}
