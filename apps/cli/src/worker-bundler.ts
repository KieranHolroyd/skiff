/**
 * Yoal's own Worker bundler (D113, docs/FUNCTIONS.md §4.3).
 *
 * `yoal deploy` used to shell out to `wrangler deploy --dry-run`, which meant whatever Wrangler
 * the user had installed (or whatever npm resolved that day) decided what a function bundle
 * looked like. This module owns that step instead. It runs esbuild as a library, pinned to an
 * exact version in the CLI's package.json, so bundling only changes when Yoal ships a release.
 *
 * It follows the parts of Wrangler's bundling that decide whether a Worker runs:
 * - ESM output, `workerd`/`worker`/`browser` export conditions, `keep_names` on by default,
 *   `process.env.NODE_ENV` defined as "production", and `.js`/`.mjs`/`.cjs` parsed as JSX.
 * - `cloudflare:*` and `workerd:*` imports stay external for the runtime to supply.
 * - With `nodejs_compat` (explicit, or implied by a compatibility date from 2026-08-04), Node built-ins (bare or `node:`) stay external as `node:` imports. The
 *   pinned workerd implements them natively, so there is no unenv polyfill layer.
 * - Module rules: `.txt`/`.html`/`.sql` become Text modules, `.bin` Data, `.wasm` CompiledWasm,
 *   plus the config's own `rules`. Each becomes a separate module named `<sha1>-<basename>`.
 * - `define`, `alias`, `minify`, `keep_names`, `tsconfig`, `jsx_factory`, `jsx_fragment` and a
 *   custom `build.command`, which runs first.
 *
 * Deliberately refused, with a message: service-worker syntax, `no_bundle`,
 * `find_additional_modules` and the legacy `node_compat` option. Python Workers (a `.py` main) go
 * to `python-bundler.ts` instead (D121).
 *
 * esbuild is imported lazily so commands that never bundle do not load its native binary.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import type { BuildFailure, Message, Plugin, PluginBuild } from 'esbuild';
import { CliError } from './errors.ts';

/** Must equal the exact `esbuild` version in apps/cli/package.json; a test enforces it. */
export const ESBUILD_VERSION = '0.28.2';

/** The bundler identity printed by `yoal deploy`. */
export const BUNDLER_DISPLAY = `yoal bundler (esbuild ${ESBUILD_VERSION})`;

/** `python` comes only from the Python bundler (`python-bundler.ts`, D121), never from esbuild. */
export type WorkerModuleType = 'esm' | 'cjs' | 'text' | 'data' | 'wasm' | 'python';

export interface WorkerModule {
	name: string;
	type: WorkerModuleType;
	data: Uint8Array;
}

export interface WorkerBundle {
	/** Name of the entry module in `modules`. */
	main: string;
	/** Sorted by name. */
	modules: WorkerModule[];
	warnings: string[];
}

type RuleType = 'Text' | 'Data' | 'CompiledWasm';

interface ModuleRule {
	type: RuleType;
	globs: string[];
}

/** Everything the bundler reads from the wrangler config, resolved and validated. */
export interface WorkerBuildSettings {
	/** Absolute path of the entry module (`main`). */
	entry: string;
	/** Directory of the wrangler config; relative paths in the config resolve against it. */
	projectRoot: string;
	nodeCompat: boolean;
	minify: boolean;
	keepNames: boolean;
	define: Record<string, string>;
	alias: Record<string, string>;
	tsconfig?: string;
	jsxFactory?: string;
	jsxFragment?: string;
	rules: ModuleRule[];
	buildCommand?: { command: string; cwd: string };
}

/** Runs a shell command with inherited stdio and resolves to its exit code. */
export type BuildCommandRunner = (command: string, cwd: string) => Promise<number>;

export interface BundleWorkerOptions {
	log?: (message: string) => void;
	/** Injected runner for `build.command` (tests). */
	runCommand?: BuildCommandRunner;
}

/** Wrangler's default module rules, applied after the config's own. */
const DEFAULT_RULES: ModuleRule[] = [
	{ type: 'Text', globs: ['**/*.txt', '**/*.html', '**/*.sql'] },
	{ type: 'Data', globs: ['**/*.bin'] },
	{ type: 'CompiledWasm', globs: ['**/*.wasm', '**/*.wasm?module'] },
];

const RULE_MODULE_TYPES: Record<RuleType, WorkerModuleType> = {
	Text: 'text',
	Data: 'data',
	CompiledWasm: 'wasm',
};

/** Modules the runtime supplies; never bundled. */
const RUNTIME_EXTERNAL = /^(?:cloudflare|workerd):/;

/** Bare Node built-in names (`fs`, `stream/web`, …) for rewriting to `node:` imports. */
const BARE_BUILTINS = new Set(builtinModules.filter((name) => !name.startsWith('node:') && !name.startsWith('_')));

const NODE_COMPAT_FLAGS = new Set(['nodejs_compat', 'nodejs_compat_v2']);
/** workerd turns `nodejs_compat` on by default from this compatibility date (pinned workerd). */
export const NODE_COMPAT_DEFAULT_DATE = '2026-08-04';

/** Whether workerd will provide Node built-ins for this date and flag set. */
export function nodeCompatEnabled(compatibilityDate: string, flags: string[]): boolean {
	if (flags.some((flag) => NODE_COMPAT_FLAGS.has(flag))) return true;
	if (flags.includes('no_nodejs_compat')) return false;
	return compatibilityDate >= NODE_COMPAT_DEFAULT_DATE;
}

/**
 * Read the bundling settings from a parsed wrangler config. `configPath` anchors relative paths,
 * as Wrangler does. Throws a `CliError` naming the offending key.
 */
export function readBuildSettings(
	config: Record<string, unknown>,
	configPath: string,
	compatibility: { date: string; flags: string[] },
): WorkerBuildSettings {
	const label = basename(configPath);
	const projectRoot = dirname(configPath);
	const fail = (message: string): never => {
		throw new CliError(`${label}: ${message}`, { code: 'wrangler_config' });
	};

	if (config.no_bundle === true)
		fail(
			'"no_bundle" is not supported by yoal deploy. Remove it to let Yoal bundle the Worker, or deploy the already-built directory with yoal deploy <dir> --no-wrangler.',
		);
	if (config.find_additional_modules === true)
		fail('"find_additional_modules" is not supported. Import the modules from your entrypoint so they are bundled.');
	if (config.node_compat !== undefined)
		fail('"node_compat" is the retired Wrangler v1 option. Use "compatibility_flags": ["nodejs_compat"] instead.');

	const main = config.main;
	if (typeof main !== 'string' || main.length === 0)
		fail('"main" is required. Point it at your Worker entrypoint, e.g. "main": "src/index.ts".');
	const entry = resolve(projectRoot, main as string);

	const booleanField = (key: string, fallback: boolean): boolean => {
		const value = config[key];
		if (value === undefined) return fallback;
		if (typeof value !== 'boolean') fail(`"${key}" must be true or false.`);
		return value as boolean;
	};
	const stringField = (key: string): string | undefined => {
		const value = config[key];
		if (value === undefined) return undefined;
		if (typeof value !== 'string' || value.length === 0) fail(`"${key}" must be a non-empty string.`);
		return value as string;
	};
	const stringRecord = (key: string): Record<string, string> => {
		const value = config[key];
		if (value === undefined) return {};
		if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`"${key}" must be an object.`);
		const record: Record<string, string> = {};
		for (const [name, item] of Object.entries(value as Record<string, unknown>)) {
			if (typeof item !== 'string') fail(`"${key}.${name}" must be a string.`);
			record[name] = item as string;
		}
		return record;
	};

	const tsconfig = stringField('tsconfig');

	return {
		entry,
		projectRoot,
		nodeCompat: nodeCompatEnabled(compatibility.date, compatibility.flags),
		minify: booleanField('minify', false),
		keepNames: booleanField('keep_names', true),
		define: stringRecord('define'),
		alias: stringRecord('alias'),
		...(tsconfig ? { tsconfig: resolve(projectRoot, tsconfig) } : {}),
		...optional('jsxFactory', stringField('jsx_factory')),
		...optional('jsxFragment', stringField('jsx_fragment')),
		rules: readRules(config.rules, fail),
		...readBuildCommand(config.build, projectRoot, fail),
	};
}

function optional<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
	return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}

/**
 * The config's rules, then the defaults. A config rule without `fallthrough: true` replaces the
 * default rule of the same type, as in Wrangler. ESModule/CommonJS rules only matter when
 * Wrangler is not bundling, so they are ignored here.
 */
function readRules(value: unknown, fail: (message: string) => never): ModuleRule[] {
	if (value === undefined) return DEFAULT_RULES;
	if (!Array.isArray(value)) fail('"rules" must be an array.');
	const rules: ModuleRule[] = [];
	const replaced = new Set<RuleType>();
	(value as unknown[]).forEach((item, index) => {
		if (typeof item !== 'object' || item === null || Array.isArray(item)) fail(`rules[${index}] must be an object.`);
		const rule = item as Record<string, unknown>;
		const type = rule.type;
		if (type === 'ESModule' || type === 'CommonJS') return;
		if (type === 'PythonModule' || type === 'PythonRequirement')
			fail(`rules[${index}]: Python module rules are not needed; a "main" ending in .py bundles every .py file next to it.`);
		if (type !== 'Text' && type !== 'Data' && type !== 'CompiledWasm')
			fail(`rules[${index}].type must be Text, Data, CompiledWasm, ESModule or CommonJS.`);
		const globs = rule.globs;
		if (!Array.isArray(globs) || globs.length === 0 || globs.some((glob) => typeof glob !== 'string' || glob === ''))
			fail(`rules[${index}].globs must be a non-empty array of globs.`);
		rules.push({ type: type as RuleType, globs: globs as string[] });
		if (rule.fallthrough !== true) replaced.add(type as RuleType);
	});
	return [...rules, ...DEFAULT_RULES.filter((rule) => !replaced.has(rule.type))];
}

function readBuildCommand(
	value: unknown,
	projectRoot: string,
	fail: (message: string) => never,
): Pick<WorkerBuildSettings, 'buildCommand'> {
	if (value === undefined || value === null) return {};
	if (typeof value !== 'object' || Array.isArray(value)) fail('"build" must be an object.');
	const build = value as Record<string, unknown>;
	if (build.command === undefined) return {};
	if (typeof build.command !== 'string' || build.command.trim() === '')
		fail('"build.command" must be a non-empty string.');
	if (build.cwd !== undefined && (typeof build.cwd !== 'string' || build.cwd === ''))
		fail('"build.cwd" must be a non-empty string.');
	return {
		buildCommand: {
			command: build.command as string,
			cwd: resolve(projectRoot, (build.cwd as string | undefined) ?? '.'),
		},
	};
}

/**
 * Turn a Wrangler module-rule glob into a RegExp, matching the import specifier as Wrangler
 * does (glob-to-regexp with globstar): `**` crosses directories, `*` does not, and every other
 * character, `?` included, is literal.
 */
export function globToRegExp(glob: string): RegExp {
	let source = '';
	for (let index = 0; index < glob.length; index++) {
		const char = glob[index]!;
		if (char === '*') {
			if (glob[index + 1] === '*') {
				index++;
				if (glob[index + 1] === '/') {
					index++;
					source += '(?:.*/)?';
				} else {
					source += '.*';
				}
			} else {
				source += '[^/]*';
			}
			continue;
		}
		source += /[\\^$.+?()[\]{}|/]/.test(char) ? `\\${char}` : char;
	}
	return new RegExp(`^${source}$`);
}

/**
 * Bundle the Worker described by `settings`. Runs `build.command` first when there is one.
 * Output stays in memory; the caller writes it into the deploy bundle.
 */
export async function bundleWorker(
	settings: WorkerBuildSettings,
	options: BundleWorkerOptions = {},
): Promise<WorkerBundle> {
	const log = options.log ?? (() => {});

	if (settings.buildCommand) {
		const { command, cwd } = settings.buildCommand;
		log(`Running custom build: ${command}`);
		const code = await (options.runCommand ?? runShellCommand)(command, cwd);
		if (code !== 0)
			throw new CliError(`The custom build command failed (exit ${code}): ${command}`, { code: 'build_command' });
	}

	const esbuild = await loadEsbuild();
	const collected = new Map<string, WorkerModule>();
	const plugins = [
		runtimeExternalsPlugin(settings.nodeCompat),
		moduleRulesPlugin(settings.rules, collected),
	];

	let result;
	try {
		result = await esbuild.build({
			entryPoints: [settings.entry],
			absWorkingDir: settings.projectRoot,
			outdir: resolve(settings.projectRoot, '.yoal-bundle'),
			write: false,
			bundle: true,
			format: 'esm',
			platform: 'browser',
			target: 'es2024',
			conditions: ['workerd', 'worker', 'browser'],
			keepNames: settings.keepNames,
			minify: settings.minify,
			metafile: true,
			sourcemap: false,
			legalComments: 'none',
			logLevel: 'silent',
			loader: { '.js': 'jsx', '.mjs': 'jsx', '.cjs': 'jsx' },
			define: {
				'process.env.NODE_ENV': '"production"',
				'global.process.env.NODE_ENV': '"production"',
				'globalThis.process.env.NODE_ENV': '"production"',
				...settings.define,
			},
			alias: settings.alias,
			external: ['__STATIC_CONTENT_MANIFEST'],
			...(settings.tsconfig ? { tsconfig: settings.tsconfig } : {}),
			...(settings.jsxFactory ? { jsxFactory: settings.jsxFactory } : {}),
			...(settings.jsxFragment ? { jsxFragment: settings.jsxFragment } : {}),
			plugins,
		});
	} catch (error) {
		throw bundleError(error, settings);
	}

	const scripts = result.outputFiles.filter((file) => !file.path.endsWith('.map'));
	const unexpected = scripts.filter((file) => !file.path.endsWith('.js'));
	if (unexpected.length > 0)
		throw new CliError(
			`The Worker imports files that cannot run in a Worker (${unexpected.map((file) => basename(file.path)).join(', ')}). Remove CSS or other asset imports from the Worker code; serve them from assets instead.`,
			{ code: 'bundle_failed' },
		);
	if (scripts.length !== 1)
		throw new CliError(`Expected one bundled entry module, got ${scripts.length}.`, { code: 'bundle_failed' });
	const output = scripts[0]!;
	const main = basename(output.path);

	const meta = Object.entries(result.metafile.outputs).find(([path]) => basename(path) === main)?.[1];
	if (meta && meta.exports.length === 0)
		throw new CliError(
			`${relativeEntry(settings)} has no exports. Yoal Functions use the ES modules format: export default { async fetch(request, env, ctx) { … } }. Service-worker syntax (addEventListener("fetch")) is not supported.`,
			{ code: 'bundle_failed' },
		);

	if (collected.has(main))
		throw new CliError(`A module rule produced "${main}", which clashes with the entry module.`, {
			code: 'bundle_failed',
		});
	const modules = [{ name: main, type: 'esm' as const, data: output.contents }, ...collected.values()].sort((a, b) =>
		a.name.localeCompare(b.name),
	);

	return { main, modules, warnings: result.warnings.map((warning) => formatMessage(warning, settings)) };
}

/** `cloudflare:*`, `workerd:*` and (with nodejs_compat) Node built-ins stay imports. */
function runtimeExternalsPlugin(nodeCompat: boolean): Plugin {
	return {
		name: 'yoal-runtime-externals',
		setup(build) {
			build.onResolve({ filter: /^(?:cloudflare|workerd):/ }, (args) =>
				RUNTIME_EXTERNAL.test(args.path) ? { path: args.path, external: true } : undefined,
			);
			if (!nodeCompat) return;
			build.onResolve({ filter: /^node:/ }, (args) => ({ path: args.path, external: true }));
			build.onResolve({ filter: /^[a-z_]+(?:\/[a-z_/]+)?$/ }, (args) => {
				if (!BARE_BUILTINS.has(args.path)) return undefined;
				return { path: `node:${args.path}`, external: true };
			});
		},
	};
}

/**
 * Imports matching a module rule become separate modules rather than bundled code. The import
 * is rewritten to `./<sha1>-<basename>`, which workerd resolves against the module list.
 */
function moduleRulesPlugin(rules: ModuleRule[], collected: Map<string, WorkerModule>): Plugin {
	const matchers = rules.map((rule) => ({
		type: RULE_MODULE_TYPES[rule.type],
		patterns: rule.globs.map(globToRegExp),
	}));
	const RESOLVING = Symbol.for('yoal-module-rule');
	return {
		name: 'yoal-module-rules',
		setup(build: PluginBuild) {
			build.onResolve({ filter: /.*/ }, async (args) => {
				if (args.pluginData === RESOLVING || args.namespace !== 'file') return undefined;
				const rule = matchers.find((matcher) => matcher.patterns.some((pattern) => pattern.test(args.path)));
				if (!rule) return undefined;

				const specifier = args.path.replace(/\?module$/, '');
				let file: string;
				if (specifier.startsWith('.') || isAbsolute(specifier)) {
					file = resolve(args.resolveDir, specifier);
				} else {
					const resolved = await build.resolve(specifier, {
						kind: args.kind,
						importer: args.importer,
						resolveDir: args.resolveDir,
						pluginData: RESOLVING,
					});
					if (resolved.errors.length > 0) return { errors: resolved.errors };
					file = resolved.path;
				}

				let data: Uint8Array;
				try {
					data = await readFile(file);
				} catch (error) {
					return { errors: [{ text: `Could not read ${args.path}: ${messageOf(error)}` }] };
				}
				const name = `${createHash('sha1').update(data).digest('hex')}-${basename(file)}`;
				collected.set(name, { name, type: rule.type, data });
				return { path: `./${name}`, external: true, watchFiles: [file] };
			});
		},
	};
}

async function loadEsbuild(): Promise<typeof import('esbuild')> {
	let esbuild: typeof import('esbuild');
	try {
		esbuild = await import('esbuild');
	} catch (error) {
		throw new CliError(
			`The function bundler could not load esbuild (${messageOf(error)}). Reinstall the Yoal CLI; esbuild ships with it.`,
			{ code: 'bundler_missing', cause: error },
		);
	}
	if (esbuild.version !== ESBUILD_VERSION)
		throw new CliError(
			`The function bundler expected esbuild ${ESBUILD_VERSION} but loaded ${esbuild.version}. Reinstall the Yoal CLI so its pinned esbuild is used.`,
			{ code: 'bundler_version' },
		);
	return esbuild;
}

function bundleError(error: unknown, settings: WorkerBuildSettings): CliError {
	const failure = error as Partial<BuildFailure>;
	if (!Array.isArray(failure.errors) || failure.errors.length === 0)
		return new CliError(`Bundling failed: ${messageOf(error)}`, { code: 'bundle_failed', cause: error });
	const lines = failure.errors.slice(0, 10).map((message) => formatMessage(message, settings));
	if (failure.errors.length > 10) lines.push(`… and ${failure.errors.length - 10} more errors`);
	const needsNodeCompat =
		!settings.nodeCompat &&
		failure.errors.some(
			(message) => message.text.includes('Could not resolve "node:') || /built into node/i.test(notesOf(message)),
		);
	if (needsNodeCompat)
		lines.push(
			`Node.js built-ins need "compatibility_flags": ["nodejs_compat"] (or a compatibility_date of ${NODE_COMPAT_DEFAULT_DATE} or later) in your wrangler config.`,
		);
	return new CliError(`Bundling failed:\n${lines.map((line) => `  ${line}`).join('\n')}`, {
		code: 'bundle_failed',
		cause: error,
	});
}

function formatMessage(message: Message, settings: WorkerBuildSettings): string {
	const location = message.location
		? `${relativeTo(settings.projectRoot, message.location.file)}:${message.location.line}:${message.location.column + 1}: `
		: '';
	return `${location}${message.text}`;
}

function notesOf(message: Message): string {
	return message.notes.map((note) => note.text).join(' ');
}

function relativeEntry(settings: WorkerBuildSettings): string {
	return relativeTo(settings.projectRoot, settings.entry);
}

function relativeTo(root: string, file: string): string {
	const prefix = root.endsWith('/') ? root : `${root}/`;
	return file.startsWith(prefix) ? file.slice(prefix.length) : file;
}

export function runShellCommand(command: string, cwd: string): Promise<number> {
	return new Promise((resolveRun, reject) => {
		const child = spawn(command, { cwd, stdio: 'inherit', shell: true, env: process.env });
		child.once('error', (error) =>
			reject(new CliError(`Could not run the custom build command: ${messageOf(error)}`, { code: 'build_command', cause: error })),
		);
		child.once('close', (code, signal) => resolveRun(code ?? (signal ? 1 : 0)));
	});
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
