/**
 * Warm the Pyodide bundle cache for the pinned workerd, so Python functions can run (D121).
 *
 * A Python Worker loads Pyodide (the CPython runtime compiled to WebAssembly) when its host starts.
 * workerd downloads that bundle from Cloudflare unless it is already in the directory given by
 * `--pyodide-bundle-disk-cache-dir`. The helper points Python hosts at a **read-only** cache next to
 * the pinned binary (`<workerd dir>/<version>/pyodide`), and the agent only advertises
 * `functions-python` once it is filled, so a host never fetches its runtime while serving.
 *
 * The bundle depends on the compatibility date (workerd switches generations on 2025-01-16 and
 * 2026-06-10), and its file name is workerd's business, so this does not hard-code URLs: it starts
 * the pinned workerd once per date era with a throwaway Python Worker and a writable scratch cache,
 * waits for the bundle to land, stops it, and moves the files into place.
 *
 *   sudo bun scripts/install/pyodide.ts        # on an installed node
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface WarmPyodideOptions {
	/** The pinned workerd binary. */
	workerdPath: string;
	/** Final cache directory, normally `<dir of workerdPath>/pyodide`. */
	cacheDir: string;
	/** One compatibility date per Pyodide generation to fetch. */
	eras: readonly string[];
	dryRun?: boolean;
	/** How long to wait for one era's bundle. */
	timeoutMs?: number;
	log?: (message: string) => void;
	/** Process seam for tests: starts workerd and returns a stop function. */
	spawn?: (argv: string[], cwd: string) => { stop(): void; exited(): boolean };
	sleep?: (ms: number) => Promise<void>;
}

export type WarmPyodideResult = 'present' | 'warmed' | 'would-warm';

const BUNDLE_SUFFIX = '.capnp.bin';
/** Records which compatibility eras this cache was warmed for; eras can share one bundle. */
const ERAS_MARKER = 'skiff-eras.json';

/** Eras a previous warm recorded, sorted; empty when there is no marker. */
export function warmedEras(dir: string): string[] {
	try {
		const parsed = JSON.parse(readFileSync(join(dir, ERAS_MARKER), 'utf8')) as { eras?: unknown };
		return Array.isArray(parsed.eras) ? parsed.eras.filter((era): era is string => typeof era === 'string').sort() : [];
	} catch {
		return [];
	}
}

/** Bundle files already in a cache directory. */
export function pyodideBundles(dir: string): string[] {
	try {
		return readdirSync(dir).filter((name) => name.endsWith(BUNDLE_SUFFIX)).sort();
	} catch {
		return [];
	}
}

/** The throwaway config: one Python Worker on an ephemeral loopback port. */
export function warmConfig(compatibilityDate: string): string {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(compatibilityDate)) throw new Error(`Invalid compatibility date: ${compatibilityDate}`);
	return [
		'using Workerd = import "/workerd/workerd.capnp";',
		'const config :Workerd.Config = (',
		'  services = [ ( name = "main", worker = .w ) ],',
		'  sockets = [ ( name = "http", address = "127.0.0.1:0", http = (), service = "main" ) ],',
		');',
		// The built-in SDK flag keeps the probe free of vendored packages; only the bundle matters.
		`const w :Workerd.Worker = ( modules = [ ( name = "warm.py", pythonModule = embed "warm.py" ) ], compatibilityDate = "${compatibilityDate}", compatibilityFlags = [ "python_workers", "disable_python_external_sdk" ] );`,
		'',
	].join('\n');
}

/**
 * Fill `cacheDir` with every era's bundle. Idempotent: a cache that already holds one bundle per
 * era is left alone. The new files are staged in a scratch directory and renamed into place.
 */
export async function warmPyodideCache(options: WarmPyodideOptions): Promise<WarmPyodideResult> {
	const log = options.log ?? (() => undefined);
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const timeoutMs = options.timeoutMs ?? 180_000;
	const spawn =
		options.spawn ??
		((argv: string[], cwd: string) => {
			const child = Bun.spawn(argv, { cwd, stdout: 'ignore', stderr: 'ignore' });
			return { stop: () => child.kill(), exited: () => child.exitCode !== null };
		});

	const eras = [...new Set(options.eras)].sort();
	if (warmedEras(options.cacheDir).join(',') === eras.join(',') && pyodideBundles(options.cacheDir).length > 0)
		return 'present';
	if (!existsSync(options.workerdPath)) throw new Error(`workerd is not installed at ${options.workerdPath}`);
	if (options.dryRun) {
		log(`would warm the Pyodide cache in ${options.cacheDir} (${options.eras.length} compatibility eras)`);
		return 'would-warm';
	}

	const work = mkdtempSync(join(tmpdir(), 'skiff-pyodide-'));
	writeFileSync(join(work, 'warm.py'), 'def on_fetch(request):\n    pass\n');
	const scratches: string[] = [];
	try {
		for (const [index, era] of eras.entries()) {
			// Each era gets an empty cache, so "a bundle appeared and stopped growing" can only mean
			// this era's bundle. Eras that share a bundle download it twice; the merge dedupes.
			const scratch = join(work, `cache-${index}`);
			mkdirSync(scratch, { recursive: true });
			scratches.push(scratch);
			writeFileSync(join(work, 'warm.capnp'), warmConfig(era));
			log(`fetching the Pyodide bundle for compatibility date ${era}`);
			const child = spawn(
				[options.workerdPath, 'serve', 'warm.capnp', '--pyodide-bundle-disk-cache-dir', scratch],
				work,
			);
			try {
				const deadline = Date.now() + timeoutMs;
				let settled = false;
				let lastSize = -1;
				while (Date.now() < deadline) {
					const current = pyodideBundles(scratch);
					const size = current.reduce((sum, name) => sum + statSync(join(scratch, name)).size, 0);
					if (current.length > 0 && size > 0 && size === lastSize) {
						settled = true;
						break;
					}
					lastSize = size;
					if (child.exited() && current.length === 0) break;
					await sleep(1_000);
				}
				if (!settled) throw new Error(`no Pyodide bundle arrived for compatibility date ${era}`);
			} finally {
				child.stop();
			}
		}

		mkdirSync(options.cacheDir, { recursive: true, mode: 0o755 });
		for (const scratch of scratches) {
			for (const name of pyodideBundles(scratch)) {
				const target = join(options.cacheDir, name);
				if (existsSync(target)) continue;
				// Same filesystem is not guaranteed (tmp vs /usr): stage next to the target, then rename.
				const staged = `${target}.new`;
				writeFileSync(staged, await Bun.file(join(scratch, name)).bytes(), { mode: 0o644 });
				renameSync(staged, target);
			}
		}
		// The marker is written last: an interrupted warm is retried in full next time.
		writeFileSync(join(options.cacheDir, ERAS_MARKER), `${JSON.stringify({ eras })}\n`, { mode: 0o644 });
		log(`Pyodide cache ready: ${pyodideBundles(options.cacheDir).join(', ')}`);
		return 'warmed';
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	const { pinnedWorkerdVersion, WORKERD_DEST } = await import('./workerd.ts');
	const source = new URL('../..', import.meta.url).pathname;
	const version = pinnedWorkerdVersion(source);
	const eras = await pythonBundleEras(source);
	const result = await warmPyodideCache({
		workerdPath: join(WORKERD_DEST, version, 'workerd'),
		cacheDir: join(WORKERD_DEST, version, 'pyodide'),
		eras,
		dryRun: process.argv.includes('--dry-run'),
		log: (message) => console.log(message),
	});
	console.log(`Pyodide cache for workerd ${version}: ${result}`);
}

/**
 * The eras live in contracts (`FUNCTION_PYTHON_BUNDLE_ERAS`); the installer runs before
 * `bun install`, so read the source rather than importing the package. The last era is the pinned
 * maximum compatibility date.
 */
export async function pythonBundleEras(repoRoot: string): Promise<string[]> {
	const text = await Bun.file(join(repoRoot, 'packages', 'contracts', 'src', 'function.ts')).text();
	const max = /export const WORKERD_MAX_COMPATIBILITY_DATE = '([^']+)'/.exec(text)?.[1];
	const list = /export const FUNCTION_PYTHON_BUNDLE_ERAS = \[([^\]]*)\]/.exec(text)?.[1];
	if (!max || !list) throw new Error('Could not read FUNCTION_PYTHON_BUNDLE_ERAS from packages/contracts/src/function.ts');
	const eras = [...list.matchAll(/'(\d{4}-\d{2}-\d{2})'/g)].map((match) => match[1]!);
	if (list.includes('WORKERD_MAX_COMPATIBILITY_DATE')) eras.push(max);
	return eras;
}
