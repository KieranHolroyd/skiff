/**
 * Bundle a Python Worker for Skiff Functions (D121, docs/FUNCTIONS.md §4.3).
 *
 * Python Workers are not compiled: the bundle is the Python source next to the entry module plus
 * the packages vendored into `python_modules/` by `pywrangler sync`. This follows Wrangler's
 * layout, which the pinned workerd loads (checked against workerd 1.20261106.1):
 *
 * - every `.py` file under the entry module's directory, named relative to that directory, so
 *   `src/entry.py` becomes the module `entry.py`;
 * - every file under `<project>/python_modules/`, named `python_modules/<path>`: `.py` files are
 *   Python modules and everything else (`.pth`, `.js`, `.so`, data files) is a data module.
 *
 * Package metadata, bytecode caches and virtualenv markers are left out. Packages are never
 * resolved here: the config's `build.command` (for example `uv run pywrangler sync`) runs first,
 * as for a JavaScript Worker.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { CliError } from './errors.ts';
import { runShellCommand, type BuildCommandRunner, type WorkerBundle, type WorkerModule } from './worker-bundler.ts';

/** Same cap the control plane enforces (`FUNCTION_MAX_MODULES`). */
export const PYTHON_MAX_MODULES = 512;
export const PYTHON_VENDOR_DIR = 'python_modules';

/** Directory and file names never shipped: caches, metadata and environments. */
const SKIPPED_DIRECTORIES = new Set(['__pycache__', '.venv', '.venv-workers', 'node_modules', '.git', 'bin', '.wrangler']);
const SKIPPED_FILES = new Set(['pyvenv.cfg', '.DS_Store']);

export interface PythonBuildSettings {
	/** Absolute entry module path. */
	entry: string;
	/** Directory of the wrangler config. */
	projectRoot: string;
	buildCommand?: { command: string; cwd: string };
}

/** True when the wrangler `main` names a Python module. */
export function isPythonMain(config: Record<string, unknown>): boolean {
	return typeof config.main === 'string' && config.main.endsWith('.py');
}

/** Read what the Python bundler needs from a parsed wrangler config. */
export function readPythonBuildSettings(config: Record<string, unknown>, configPath: string): PythonBuildSettings {
	const label = basename(configPath);
	const projectRoot = dirname(configPath);
	const fail = (message: string): never => {
		throw new CliError(`${label}: ${message}`, { code: 'wrangler_config' });
	};
	const main = config.main;
	if (typeof main !== 'string' || !main.endsWith('.py')) fail('"main" must point at the Python entry module.');
	const build = config.build;
	let buildCommand: PythonBuildSettings['buildCommand'];
	if (build !== undefined && build !== null) {
		if (typeof build !== 'object' || Array.isArray(build)) fail('"build" must be an object.');
		const { command, cwd } = build as Record<string, unknown>;
		if (command !== undefined) {
			if (typeof command !== 'string' || command.trim() === '') fail('"build.command" must be a non-empty string.');
			if (cwd !== undefined && (typeof cwd !== 'string' || cwd === '')) fail('"build.cwd" must be a non-empty string.');
			buildCommand = { command: command as string, cwd: resolve(projectRoot, (cwd as string | undefined) ?? '.') };
		}
	}
	return { entry: resolve(projectRoot, main as string), projectRoot, ...(buildCommand ? { buildCommand } : {}) };
}

export interface BundlePythonOptions {
	log?: (message: string) => void;
	runCommand?: BuildCommandRunner;
}

export async function bundlePythonWorker(
	settings: PythonBuildSettings,
	options: BundlePythonOptions = {},
): Promise<WorkerBundle> {
	const log = options.log ?? (() => {});
	if (settings.buildCommand) {
		const { command, cwd } = settings.buildCommand;
		log(`Running custom build: ${command}`);
		const code = await (options.runCommand ?? runShellCommand)(command, cwd);
		if (code !== 0)
			throw new CliError(`The custom build command failed (exit ${code}): ${command}`, { code: 'build_command' });
	}

	const entryInfo = await stat(settings.entry).catch(() => null);
	if (!entryInfo?.isFile())
		throw new CliError(`The Python entry module ${relative(settings.projectRoot, settings.entry)} does not exist.`, {
			code: 'wrangler_config',
		});

	const sourceRoot = dirname(settings.entry);
	const vendorRoot = join(settings.projectRoot, PYTHON_VENDOR_DIR);
	const modules: WorkerModule[] = [];
	const warnings: string[] = [];

	// Source: the entry's directory, minus a vendor directory that happens to live inside it.
	for (const path of await walk(sourceRoot, (dir) => dir !== vendorRoot)) {
		if (!path.endsWith('.py')) continue;
		modules.push({ name: posix(relative(sourceRoot, path)), type: 'python', data: await readFile(path) });
	}

	const vendorInfo = await stat(vendorRoot).catch(() => null);
	if (vendorInfo?.isDirectory()) {
		for (const path of await walk(vendorRoot, (dir) => !basename(dir).endsWith('.dist-info'))) {
			const name = `${PYTHON_VENDOR_DIR}/${posix(relative(vendorRoot, path))}`;
			modules.push({ name, type: path.endsWith('.py') ? 'python' : 'data', data: await readFile(path) });
		}
	} else {
		const hasProject = await stat(join(settings.projectRoot, 'pyproject.toml')).catch(() => null);
		warnings.push(
			hasProject
				? `No ${PYTHON_VENDOR_DIR}/ directory: packages from pyproject.toml are not bundled. Run \`uv run pywrangler sync\` first, or set "build": { "command": "uv run pywrangler sync" }.`
				: `No ${PYTHON_VENDOR_DIR}/ directory: the Worker gets only the standard library and must import the \`workers\` SDK from a vendored workers-runtime-sdk.`,
		);
	}

	const main = posix(relative(sourceRoot, settings.entry));
	modules.sort((a, b) => a.name.localeCompare(b.name));
	if (modules.length > PYTHON_MAX_MODULES)
		throw new CliError(
			`This Python Worker has ${modules.length} files; Skiff Functions load at most ${PYTHON_MAX_MODULES}. Trim python_modules/ (drop unused packages) or deploy the app as a process app instead.`,
			{ code: 'bundle_too_large' },
		);
	log(`Python Worker: ${modules.length} modules (${modules.filter((module) => module.name.startsWith(`${PYTHON_VENDOR_DIR}/`)).length} vendored).`);
	return { main, modules, warnings };
}

/** Files under `root`, depth first, skipping caches and any directory `keep` refuses. */
async function walk(root: string, keep: (dir: string) => boolean): Promise<string[]> {
	const files: string[] = [];
	const visit = async (dir: string): Promise<void> => {
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (SKIPPED_DIRECTORIES.has(entry.name) || !keep(path)) continue;
				await visit(path);
			} else if (entry.isFile()) {
				if (SKIPPED_FILES.has(entry.name) || entry.name.endsWith('.pyc')) continue;
				files.push(path);
			}
		}
	};
	await visit(root);
	return files;
}

function posix(path: string): string {
	return path.split(sep).join('/');
}
