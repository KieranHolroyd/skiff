/**
 * Wrangler config discovery, JSONC parsing, and the `yoal wrangler` passthrough.
 *
 * A Functions project is one with a `wrangler.jsonc` (or `wrangler.json`) (docs/FUNCTIONS.md
 * §4.3, §4.11). This module finds that file and parses it without a dependency. Deploys never run
 * Wrangler: Yoal's own bundler compiles the Worker (`worker-bundler.ts`, D113). The install and
 * invoker helpers below serve only `yoal wrangler …`, the local dev loop.
 *
 * The CLI runs on Node 20 (package.json `engines`) and is also exercised under Bun, so
 * everything here uses `node:child_process` and `node:fs` and takes injectable runners for
 * tests. Tests never spawn a real wrangler or install anything.
 */
import { execFile, spawn } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { CliError } from './errors.ts';
import { askTerminal } from './prompt.ts';

export type WranglerConfigFormat = 'jsonc' | 'json';

export interface WranglerConfig {
	/** Absolute path to the config file. */
	path: string;
	format: WranglerConfigFormat;
}

export type PackageManager = 'bun' | 'npm' | 'pnpm' | 'yarn';

export interface WranglerFileSystem {
	exists?: (path: string) => Promise<boolean>;
	which?: (command: string) => Promise<string | null>;
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
}

export interface WranglerSpawnOptions {
	cwd: string;
	stdio: 'inherit';
	env?: NodeJS.ProcessEnv;
}

/** Runs a command with inherited stdio and resolves to its exit code. */
export type WranglerSpawn = (command: string, args: string[], options: WranglerSpawnOptions) => Promise<number>;

/** `(args) => exit code`, with the command it will run for diagnostics. */
export interface WranglerInvoker {
	(args: string[]): Promise<number>;
	readonly command: string;
	readonly display: string;
	readonly ephemeral: boolean;
	readonly installed: boolean;
}

export interface EnsureWranglerOptions extends WranglerFileSystem {
	/** Injected runner for both installation and wrangler itself (tests). */
	run?: WranglerSpawn;
	log?: (message: string) => void;
	/** Skip the installation confirmation prompt. */
	yes?: boolean;
	/** Explicit binary (`--wrangler-bin`); skips discovery and installation. */
	binary?: string;
	/** Injected confirmation prompt (tests). */
	confirm?: (question: string) => Promise<boolean>;
	/** Force a package manager instead of detecting one (tests). */
	packageManager?: PackageManager;
}

const CONFIG_FILES: ReadonlyArray<{ name: string; format: WranglerConfigFormat }> = [
	{ name: 'wrangler.jsonc', format: 'jsonc' },
	{ name: 'wrangler.json', format: 'json' },
];

const INSTALL_COMMANDS: Record<PackageManager, { command: string; args: string[] }> = {
	bun: { command: 'bun', args: ['add', '-d', 'wrangler'] },
	npm: { command: 'npm', args: ['install', '--save-dev', 'wrangler'] },
	pnpm: { command: 'pnpm', args: ['add', '-D', 'wrangler'] },
	yarn: { command: 'yarn', args: ['add', '-D', 'wrangler'] },
};

const EXEC_COMMANDS: Record<PackageManager, { command: string; prefix: string[] }> = {
	bun: { command: 'bunx', prefix: ['wrangler'] },
	npm: { command: 'npx', prefix: ['--yes', 'wrangler'] },
	pnpm: { command: 'pnpm', prefix: ['exec', 'wrangler'] },
	yarn: { command: 'yarn', prefix: ['wrangler'] },
};

/**
 * Find the wrangler config in `dir`. Filenames are case-sensitive, so this lists the directory
 * rather than `stat`ing, which would match `Wrangler.JSONC` on a case-insensitive filesystem.
 * Returns null when there is no config; a `wrangler.toml` is an error pointing at JSONC.
 */
export async function findWranglerConfig(dir: string): Promise<WranglerConfig | null> {
	// Search the deploy root first, then its parents: `yoal deploy ./dist` is a common way to
	// ship a prebuilt Worker whose wrangler config lives at the project root. Stop at the
	// filesystem root; a directory without a config simply has none.
	let current = resolve(dir);
	for (;;) {
		let names: string[];
		try {
			names = await readdir(current);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === 'ENOENT' || code === 'ENOTDIR') return null;
			throw new CliError(`Could not read ${current}: ${messageOf(error)}`, { cause: error });
		}
		for (const config of CONFIG_FILES) {
			if (names.includes(config.name))
				return { path: resolve(current, config.name), format: config.format };
		}
		if (names.includes('wrangler.toml'))
			throw new CliError(
				`Found wrangler.toml in ${current}. Yoal Functions use wrangler.jsonc (or wrangler.json): convert the TOML to JSONC and rename the file.`,
				{ code: 'wrangler_config' },
			);
		const parent = dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

/**
 * Build a `WranglerConfig` from a `--wrangler <path>` override, validating the extension.
 * Relative paths resolve against the process working directory, like wrangler's own `--config`.
 */
export async function resolveWranglerConfig(input: string): Promise<WranglerConfig> {
	const path = resolve(input);
	const lower = path.toLowerCase();
	if (lower.endsWith('.toml'))
		throw new CliError(
			`${input} is a wrangler.toml. Yoal Functions use wrangler.jsonc (or wrangler.json): convert the TOML to JSONC and rename the file.`,
			{ code: 'wrangler_config' },
		);
	const format: WranglerConfigFormat | null = lower.endsWith('.jsonc')
		? 'jsonc'
		: lower.endsWith('.json')
			? 'json'
			: null;
	if (!format)
		throw new CliError(`--wrangler must point at a wrangler.jsonc or wrangler.json file (got ${input}).`, {
			code: 'wrangler_config',
		});
	try {
		const info = await stat(path);
		if (!info.isFile()) throw new CliError(`Wrangler config not found: ${input}`, { code: 'wrangler_config' });
	} catch (error) {
		if (error instanceof CliError) throw error;
		throw new CliError(`Wrangler config not found: ${input}`, { code: 'wrangler_config', cause: error });
	}
	return { path, format };
}

/** Read and parse a config; errors are prefixed with the config's filename. */
export async function readWranglerConfig(config: WranglerConfig): Promise<Record<string, unknown>> {
	const label = basename(config.path);
	let text: string;
	try {
		text = await readFile(config.path, 'utf8');
	} catch (error) {
		throw new CliError(`Could not read ${label}: ${messageOf(error)}`, {
			code: 'wrangler_config',
			cause: error,
		});
	}
	const parsed = parseJsonc(text, label);
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
		throw new CliError(`${label}: expected a JSON object at the top level.`, { code: 'wrangler_config' });
	return parsed as Record<string, unknown>;
}

/**
 * Parse JSONC without a dependency: strip `//` and block comments outside strings, remove
 * trailing commas before `}`/`]`, then `JSON.parse`. Comments are recognised in the look-ahead
 * for trailing commas too, so a comma followed by a comment and then the closing bracket parses.
 */
export function parseJsonc(text: string, label = 'wrangler.jsonc'): unknown {
	const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
	let out = '';
	let inString = false;
	let index = 0;

	while (index < source.length) {
		const char = source[index]!;

		if (inString) {
			out += char;
			if (char === '\\') {
				const escaped = source[index + 1];
				if (escaped !== undefined) {
					out += escaped;
					index += 2;
					continue;
				}
				throw new CliError(`${label}: invalid escape at the end of the file.`, { code: 'wrangler_config' });
			}
			if (char === '"') inString = false;
			index++;
			continue;
		}

		if (char === '"') {
			inString = true;
			out += char;
			index++;
			continue;
		}

		if (char === '/' && source[index + 1] === '/') {
			index += 2;
			while (index < source.length && source[index] !== '\n') index++;
			continue;
		}

		if (char === '/' && source[index + 1] === '*') {
			const end = source.indexOf('*/', index + 2);
			if (end === -1)
				throw new CliError(`${label}: unterminated block comment.`, { code: 'wrangler_config' });
			index = end + 2;
			continue;
		}

		if (char === ',') {
			// Drop the comma when the next significant token closes an object or array.
			let lookahead = index + 1;
			for (;;) {
				while (lookahead < source.length && /\s/.test(source[lookahead]!)) lookahead++;
				if (source[lookahead] === '/' && source[lookahead + 1] === '/') {
					lookahead += 2;
					while (lookahead < source.length && source[lookahead] !== '\n') lookahead++;
					continue;
				}
				if (source[lookahead] === '/' && source[lookahead + 1] === '*') {
					const end = source.indexOf('*/', lookahead + 2);
					if (end === -1)
						throw new CliError(`${label}: unterminated block comment.`, { code: 'wrangler_config' });
					lookahead = end + 2;
					continue;
				}
				break;
			}
			if (source[lookahead] === '}' || source[lookahead] === ']') {
				index++;
				continue;
			}
			out += char;
			index++;
			continue;
		}

		out += char;
		index++;
	}

	try {
		return JSON.parse(out) as unknown;
	} catch (error) {
		throw new CliError(`${label}: ${messageOf(error)}`, { code: 'wrangler_config', cause: error });
	}
}

/**
 * Find wrangler: `node_modules/.bin/wrangler` walking up from `dir` first, then PATH.
 * Injectable so tests never consult the host's PATH.
 */
export async function findWranglerBinary(
	dir: string,
	options: WranglerFileSystem = {},
): Promise<string | null> {
	const exists = options.exists ?? fileExists;
	const platform = options.platform ?? process.platform;
	const names =
		platform === 'win32' ? ['wrangler.cmd', 'wrangler.exe', 'wrangler'] : ['wrangler'];
	let current = resolve(dir);
	for (;;) {
		for (const name of names) {
			const candidate = join(current, 'node_modules', '.bin', name);
			if (await exists(candidate)) return candidate;
		}
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	const which = options.which ?? defaultWhich(platform);
	return (await which('wrangler')) ?? null;
}

/** Detect the package manager from the lockfiles in `dir`; null when there is no package.json. */
export async function detectPackageManager(
	dir: string,
	options: WranglerFileSystem = {},
): Promise<PackageManager | null> {
	const exists = options.exists ?? fileExists;
	const root = resolve(dir);
	if (await exists(join(root, 'bun.lock'))) return 'bun';
	if (await exists(join(root, 'bun.lockb'))) return 'bun';
	if (await exists(join(root, 'pnpm-lock.yaml'))) return 'pnpm';
	if (await exists(join(root, 'yarn.lock'))) return 'yarn';
	if (await exists(join(root, 'package-lock.json'))) return 'npm';
	if (await exists(join(root, 'package.json'))) return 'npm';
	return null;
}

/**
 * Ensure wrangler is available for `dir` and return an invoker for it.
 *
 * A local binary is used when present. Otherwise wrangler is installed as a dev dependency with
 * the project's package manager (never globally); with no package.json an ephemeral
 * `bunx`/`npx` is used and no package.json is created. `CI=1` is forced so wrangler never waits
 * for a prompt.
 */
export async function ensureWrangler(
	dir: string,
	options: EnsureWranglerOptions = {},
): Promise<WranglerInvoker> {
	const cwd = resolve(dir);
	const run = options.run ?? defaultSpawn;
	const exists = options.exists ?? fileExists;
	const which = options.which ?? defaultWhich(options.platform ?? process.platform);
	const log = options.log ?? (() => {});
	const env: NodeJS.ProcessEnv = { ...process.env, ...options.env, CI: '1' };

	const invoker = (
		command: string,
		prefix: string[],
		ephemeral: boolean,
		installed: boolean,
		target: string,
	): WranglerInvoker => {
		const invoke = ((args: string[]) =>
			run(command, [...prefix, ...args], { cwd, stdio: 'inherit', env })) as WranglerInvoker;
		const absolute = target.startsWith('/') || /^[A-Za-z]:[\\/]/.test(target) ? target : resolve(cwd, target);
		const display = prefix.length > 0 ? [command, ...prefix].join(' ') : displayPath(cwd, absolute);
		return Object.assign(invoke, { command, display, ephemeral, installed });
	};

	if (options.binary) {
		const binary = resolve(options.binary);
		if (!(await exists(binary)))
			throw new CliError(`--wrangler-bin: "${options.binary}" was not found.`, { code: 'wrangler_missing' });
		return invoker(binary, [], false, true, binary);
	}

	const found = await findWranglerBinary(cwd, { exists, which, platform: options.platform });
	if (found) {
		log(`Using wrangler at ${displayPath(cwd, found)}.`);
		return invoker(found, [], false, true, found);
	}

	const manager = options.packageManager ?? (await detectPackageManager(cwd, { exists }));
	const hasPackageJson = await exists(join(cwd, 'package.json'));

	if (!hasPackageJson) {
		// No project to install into: run through a package runner and leave the directory alone.
		const bunx = (await exists(join(cwd, 'bun.lock'))) || (await exists(join(cwd, 'bun.lockb')))
			? true
			: (await which('bun')) !== null;
		const command = bunx ? 'bunx' : 'npx';
		const prefix = bunx ? ['wrangler'] : ['--yes', 'wrangler'];
		log(
			`No package.json in ${cwd}; using an ephemeral wrangler via ${[command, ...prefix].join(' ')} (nothing is installed).`,
		);
		return invoker(command, prefix, true, false, command);
	}

	const packageManager = manager ?? 'npm';
	const install = INSTALL_COMMANDS[packageManager];
	const confirmed = await confirmInstall(packageManager, options);
	if (!confirmed)
		throw new CliError(
			`wrangler is required to build a function bundle. Install it with: ${install.command} ${install.args.join(' ')}`,
			{ code: 'wrangler_missing' },
		);

	log(`Installing wrangler as a dev dependency: ${install.command} ${install.args.join(' ')}`);
	const code = await run(install.command, install.args, { cwd, stdio: 'inherit', env });
	if (code !== 0)
		throw new CliError(
			`Installing wrangler failed: ${install.command} ${install.args.join(' ')} exited with code ${code}.`,
			{ code: 'wrangler_install' },
		);

	const installed = await findWranglerBinary(cwd, { exists, which, platform: options.platform });
	if (installed) {
		log(`Installed wrangler at ${displayPath(cwd, installed)}.`);
		return invoker(installed, [], false, true, installed);
	}

	const exec = EXEC_COMMANDS[packageManager];
	log(`Using ${[exec.command, ...exec.prefix].join(' ')} after installing wrangler.`);
	return invoker(exec.command, exec.prefix, false, true, exec.command);
}

/** The command line an invoker will run, for error messages. */
export function wranglerCommandLine(invoker: WranglerInvoker, args: string[]): string {
	return [invoker.display, ...args].join(' ');
}

async function confirmInstall(
	packageManager: PackageManager,
	options: EnsureWranglerOptions,
): Promise<boolean> {
	if (options.yes) return true;
	if (options.confirm) return options.confirm(installQuestion(packageManager));
	// CI and piped invocations cannot answer, so installing is the useful default there.
	if (!process.stdin.isTTY || process.env.CI) return true;
	const answer = await askTerminal(installQuestion(packageManager));
	return answer === '' || /^y(es)?$/i.test(answer);
}

function installQuestion(packageManager: PackageManager): string {
	return `wrangler is not installed. Install it as a dev dependency with ${packageManager}? [Y/n] `;
}

function displayPath(cwd: string, path: string): string {
	if (!path.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(path)) return path;
	const rel = relative(cwd, path);
	return rel && !rel.startsWith('..') ? rel : path;
}

async function fileExists(path: string): Promise<boolean> {
	try {
		const info = await stat(path);
		return info.isFile() || info.isDirectory();
	} catch {
		return false;
	}
}

function defaultWhich(platform: NodeJS.Platform): (command: string) => Promise<string | null> {
	return (command) =>
		new Promise((resolveWhich) => {
			const finder = platform === 'win32' ? 'where' : 'which';
			execFile(finder, [command], { env: process.env }, (error, stdout) => {
				if (error) {
					resolveWhich(null);
					return;
				}
				const first = stdout
					.split(/\r?\n/)
					.map((line) => line.trim())
					.find((line) => line.length > 0);
				resolveWhich(first ?? null);
			});
		});
}

function defaultSpawn(command: string, args: string[], options: WranglerSpawnOptions): Promise<number> {
	return new Promise((resolveSpawn, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			stdio: options.stdio,
			env: options.env,
			shell: process.platform === 'win32',
		});
		child.once('error', (error) => {
			reject(new CliError(`Could not run ${command}: ${messageOf(error)}`, { code: 'wrangler_spawn', cause: error }));
		});
		child.once('close', (code, signal) => {
			resolveSpawn(code ?? (signal ? 1 : 0));
		});
	});
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
