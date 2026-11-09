import { existsSync, promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import {
	NODE_STORAGE_DEFAULTS,
	nodeStorageSchema,
	storagePathProblem,
	type NodeStorage,
	type NodeStorageStatus,
} from '@yoal/contracts';
import { readStorageStatus, STORAGE_STATE_FILE } from './storage.ts';

/**
 * `yoal-agent storage apply`: the root half of a node storage move (D48), run by
 * `yoal-storage.service` when the agent drops a request. It trusts nothing in that request.
 * It reads the node token from agent.env, asks the control plane for the paths, re-checks them,
 * and only then moves anything.
 *
 * - Data directory (release cache, site links, desired-state cache): stop the agent, copy with
 *   `cp -a`, point site links at the new tree, set `YOAL_DATA_DIR` in agent.env (it outranks the
 *   unit's Environment=), add the path to the agent's `ReadWritePaths=` with a drop-in, and start
 *   the agent again. Caddy keeps serving the old copy until the agent re-applies its config, and
 *   only then is the old copy deleted. Any failure puts everything back.
 * - Build directory: scratch only, so nothing is copied. A drop-in points the Builder at the new
 *   path, and the service restarts it if it was running.
 *
 * Nothing moves while a build unit is running; the request stays pending and the agent asks again.
 */

export interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface StorageApplyOptions {
	agentEnvFile: string;
	sharedEnvFile: string;
	stateFile: string;
	systemdDir: string;
	/** Account that owns the data directory (the agent's user). */
	agentUser: string;
	agentGroup: string;
	run: (cmd: string[]) => Promise<CommandResult>;
	fetchStorage: (controlUrl: string, token: string) => Promise<NodeStorage>;
	sleep: (ms: number) => Promise<void>;
	now: () => Date;
	log: (message: string) => void;
	/** How long the agent must stay up before the old data is deleted. */
	settleMs: number;
	/** Path rules; always `storagePathProblem` outside tests. */
	pathProblem: (path: string) => string | null;
}

export const AGENT_UNIT = 'yoal-agent.service';
export const BUILDER_UNIT = 'yoal-builder.service';
const DROP_IN = 'yoal-storage.conf';

export class StorageApplyError extends Error {}

export function defaultStorageApplyOptions(): StorageApplyOptions {
	return {
		agentEnvFile: process.env.YOAL_AGENT_ENV_FILE ?? '/etc/yoal/agent.env',
		sharedEnvFile: process.env.YOAL_ENV_FILE ?? '/etc/yoal/yoal.env',
		stateFile: process.env.YOAL_STORAGE_STATE_FILE ?? STORAGE_STATE_FILE,
		systemdDir: process.env.YOAL_SYSTEMD_DIR ?? '/etc/systemd/system',
		agentUser: 'yoal',
		agentGroup: 'yoal',
		run: async (cmd) => {
			const proc = Bun.spawn(cmd, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
			const [stdout, stderr, code] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			return { code, stdout, stderr };
		},
		fetchStorage: async (controlUrl, token) => {
			const response = await fetch(`${controlUrl.replace(/\/+$/, '')}/api/agent/storage`, {
				headers: { authorization: `Bearer ${token}` },
				signal: AbortSignal.timeout(30_000),
			});
			if (!response.ok) throw new StorageApplyError(`control plane answered ${response.status} for storage settings`);
			return nodeStorageSchema.parse(await response.json());
		},
		sleep: (ms) => Bun.sleep(ms),
		now: () => new Date(),
		log: (message) => console.log(`[yoal-storage] ${message}`),
		settleMs: 20_000,
		pathProblem: storagePathProblem,
	};
}

// --- env files ---------------------------------------------------------------

export function parseEnv(text: string): Map<string, string> {
	const values = new Map<string, string>();
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) continue;
		const equals = line.indexOf('=');
		if (equals <= 0) continue;
		let value = line.slice(equals + 1).trim();
		if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0]!)) value = value.slice(1, -1);
		values.set(line.slice(0, equals).trim(), value);
	}
	return values;
}

/** Replace (or append) one `KEY=value` line, keeping every other line as written. */
export function setEnvLine(text: string, key: string, value: string): string {
	const lines = text.split('\n');
	let found = false;
	const out = lines.map((line) => {
		if (new RegExp(`^\\s*${key}\\s*=`).test(line)) {
			found = true;
			return `${key}=${value}`;
		}
		return line;
	});
	if (!found) {
		if (out.length > 0 && out[out.length - 1] === '') out.splice(out.length - 1, 0, `${key}=${value}`);
		else out.push(`${key}=${value}`);
	}
	const joined = out.join('\n');
	return joined.endsWith('\n') ? joined : `${joined}\n`;
}

async function readText(path: string): Promise<string | null> {
	try {
		return await fs.readFile(path, 'utf8');
	} catch {
		return null;
	}
}

async function writeAtomic(path: string, body: string, mode: number): Promise<void> {
	await fs.mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}`;
	await fs.writeFile(tmp, body, { mode });
	await fs.chmod(tmp, mode);
	await fs.rename(tmp, path);
}

function within(path: string, parent: string): boolean {
	return path === parent || path.startsWith(`${parent}/`);
}

// --- the apply -----------------------------------------------------------------

export async function applyStorage(options: StorageApplyOptions): Promise<NodeStorageStatus> {
	const agentEnvText = await readText(options.agentEnvFile);
	if (agentEnvText === null) throw new StorageApplyError(`${options.agentEnvFile} is missing; join the node first`);
	const agentEnv = parseEnv(agentEnvText);
	const sharedEnv = parseEnv((await readText(options.sharedEnvFile)) ?? '');
	const controlUrl = agentEnv.get('YOAL_CONTROL_URL');
	const token = agentEnv.get('YOAL_NODE_TOKEN');
	if (!controlUrl || !token) throw new StorageApplyError(`${options.agentEnvFile} has no control URL or node token`);

	const previous = await readStorageStatus(options.stateFile);
	const current = {
		dataDir: agentEnv.get('YOAL_DATA_DIR') || sharedEnv.get('YOAL_DATA_DIR') || NODE_STORAGE_DEFAULTS.dataDir,
		buildDir: previous?.buildDir ?? NODE_STORAGE_DEFAULTS.buildDir,
	};

	const record = async (
		requested: NodeStorage,
		paths: { dataDir: string; buildDir: string },
		status: NodeStorageStatus['status'],
		message: string | null,
	): Promise<NodeStorageStatus> => {
		const value: NodeStorageStatus = {
			requested: { dataDir: requested.dataDir, buildDir: requested.buildDir },
			dataDir: paths.dataDir,
			buildDir: paths.buildDir,
			status,
			message,
			updatedAt: options.now().toISOString(),
		};
		// Group-readable so the agent can relay it in heartbeats.
		await writeAtomic(options.stateFile, `${JSON.stringify(value, null, 2)}\n`, 0o640);
		await options.run(['chown', `root:${options.agentGroup}`, options.stateFile]);
		return value;
	};

	let requested: NodeStorage;
	try {
		requested = await options.fetchStorage(controlUrl, token);
	} catch (error) {
		// Nothing was requested that we can trust; leave the status as it was.
		throw new StorageApplyError(`could not read storage settings: ${errorText(error)}`);
	}

	for (const path of [requested.dataDir, requested.buildDir]) {
		const problem = path === null ? null : options.pathProblem(path);
		if (problem) return record(requested, current, 'failed', problem);
	}
	const target = {
		dataDir: requested.dataDir ?? NODE_STORAGE_DEFAULTS.dataDir,
		buildDir: requested.buildDir ?? NODE_STORAGE_DEFAULTS.buildDir,
	};
	if (within(target.dataDir, target.buildDir) || within(target.buildDir, target.dataDir))
		return record(requested, current, 'failed', 'The data and build directories must be separate.');
	if (target.dataDir === current.dataDir && target.buildDir === current.buildDir)
		return record(requested, current, 'applied', null);

	// Never move (and later delete) something that is not plainly node data, such as the edge's
	// control-plane directory if agent.env ever lost its YOAL_DATA_DIR.
	if (target.dataDir !== current.dataDir && options.pathProblem(current.dataDir) !== null)
		return record(
			requested,
			current,
			'failed',
			`The agent's current data directory (${current.dataDir}) is not one this service will move; set YOAL_DATA_DIR in ${options.agentEnvFile}.`,
		);

	if (await buildRunning(options)) {
		options.log('a build is running; the move waits for it to finish');
		return record(requested, current, 'pending', 'Waiting for the running build to finish.');
	}

	const notes: string[] = [];
	let applied = { ...current };
	try {
		if (target.dataDir !== current.dataDir) {
			notes.push(...(await moveDataDir(options, agentEnvText, current.dataDir, target.dataDir)));
			applied = { ...applied, dataDir: target.dataDir };
		}
		if (target.buildDir !== current.buildDir) {
			notes.push(...(await moveBuildDir(options, current.buildDir, target.buildDir)));
			applied = { ...applied, buildDir: target.buildDir };
		}
	} catch (error) {
		const message = errorText(error);
		options.log(`failed: ${message}`);
		return record(requested, applied, 'failed', message.slice(0, 2000));
	}
	return record(requested, applied, 'applied', notes.length ? notes.join(' ') : null);
}

async function buildRunning(options: StorageApplyOptions): Promise<boolean> {
	const result = await options.run([
		'systemctl',
		'list-units',
		'--type=service',
		'--state=active,activating',
		'--no-legend',
		'--plain',
		'yoal-build-*',
	]);
	return result.code === 0 && result.stdout.trim().length > 0;
}

async function isActive(options: StorageApplyOptions, unit: string): Promise<boolean> {
	return (await options.run(['systemctl', 'is-active', '--quiet', unit])).code === 0;
}

async function must(options: StorageApplyOptions, cmd: string[]): Promise<CommandResult> {
	const result = await options.run(cmd);
	if (result.code !== 0)
		throw new StorageApplyError(`${cmd.join(' ')} failed: ${(result.stderr || result.stdout).trim().slice(0, 500) || `exit ${result.code}`}`);
	return result;
}

/** Empty or missing, or already a Yoal data directory (a retried move): safe to copy into. */
async function usableTarget(path: string): Promise<{ created: boolean }> {
	const stat = await fs.stat(path).catch(() => null);
	if (!stat) return { created: true };
	if (!stat.isDirectory()) throw new StorageApplyError(`${path} exists and is not a directory`);
	const entries = await fs.readdir(path);
	if (entries.length === 0) return { created: false };
	if (entries.includes('releases') || entries.includes('node.json') || entries.includes('desired-state.json'))
		return { created: false };
	throw new StorageApplyError(`${path} is not empty; pick an empty or new directory`);
}

async function moveDataDir(
	options: StorageApplyOptions,
	agentEnvText: string,
	from: string,
	to: string,
): Promise<string[]> {
	if (within(to, from) || within(from, to))
		throw new StorageApplyError('The new data directory cannot be inside the current one, or contain it.');
	const { created } = await usableTarget(to);
	// New parents must stay traversable for the agent and Caddy; only the leaf is private.
	await fs.mkdir(dirname(to), { recursive: true, mode: 0o755 });
	if (created) await fs.mkdir(to, { mode: 0o750 });
	try {
		await must(options, ['chown', `${options.agentUser}:${options.agentGroup}`, to]);
		await fs.chmod(to, 0o750);
		// Every existing parent must let the agent (and Caddy, via the yoal group) reach it too.
		const reach = await options.run(['runuser', '-u', options.agentUser, '--', 'test', '-w', to]);
		if (reach.code !== 0)
			throw new StorageApplyError(
				`${options.agentUser} cannot write ${to}; make each parent directory traversable (for example chmod o+x)`,
			);
	} catch (error) {
		if (created) await fs.rm(to, { recursive: true, force: true }).catch(() => undefined);
		throw error;
	}

	const dropInPath = join(options.systemdDir, `${AGENT_UNIT}.d`, DROP_IN);
	const previousDropIn = await readText(dropInPath);
	const builderWasActive = await isActive(options, BUILDER_UNIT);
	options.log(`moving the agent data directory ${from} -> ${to}`);
	await must(options, ['systemctl', 'stop', AGENT_UNIT]);
	try {
		if (existsSync(from)) {
			await must(options, ['cp', '-a', `${from}/.`, `${to}/`]);
			await relinkSites(from, to);
			await options.run(['chown', '-R', '--no-dereference', `${options.agentUser}:${options.agentGroup}`, to]);
		}
		// The default directory is already writable by the unit itself; anything else needs a drop-in.
		if (to === NODE_STORAGE_DEFAULTS.dataDir) await fs.rm(dropInPath, { force: true });
		else
			await writeAtomic(
				dropInPath,
				`# Written by yoal-storage (D48). Remove with the dashboard, not by hand.\n[Service]\nReadWritePaths=${to}\n`,
				0o644,
			);
		await writeAtomic(options.agentEnvFile, setEnvLine(agentEnvText, 'YOAL_DATA_DIR', to), 0o640);
		await options.run(['chown', `root:${options.agentGroup}`, options.agentEnvFile]);
		await must(options, ['systemctl', 'daemon-reload']);
		await must(options, ['systemctl', 'start', AGENT_UNIT]);
		// It must stay up, not crash-loop on the new path.
		await options.sleep(5_000);
		if (!(await isActive(options, AGENT_UNIT)))
			throw new StorageApplyError(`${AGENT_UNIT} did not stay running with ${to}; see journalctl -u yoal-agent`);
	} catch (error) {
		options.log(`rolling back to ${from}: ${errorText(error)}`);
		await options.run(['systemctl', 'stop', AGENT_UNIT]);
		await writeAtomic(options.agentEnvFile, agentEnvText, 0o640).catch(() => undefined);
		await options.run(['chown', `root:${options.agentGroup}`, options.agentEnvFile]);
		if (previousDropIn === null) await fs.rm(dropInPath, { force: true }).catch(() => undefined);
		else await writeAtomic(dropInPath, previousDropIn, 0o644).catch(() => undefined);
		await options.run(['systemctl', 'daemon-reload']);
		await options.run(['systemctl', 'start', AGENT_UNIT]);
		if (builderWasActive) await options.run(['systemctl', 'start', BUILDER_UNIT]);
		if (created) await fs.rm(to, { recursive: true, force: true }).catch(() => undefined);
		throw error;
	}
	// Stopping the agent also stopped the Builder (PartOf=); bring it back.
	if (builderWasActive) await options.run(['systemctl', 'start', BUILDER_UNIT]);

	// Caddy serves the old copy until the agent has pushed a config rooted at the new one.
	await options.sleep(options.settleMs);
	if (options.pathProblem(from) !== null) return [`Left the old copy at ${from}; remove it by hand.`];
	await fs.rm(from, { recursive: true, force: true });
	options.log(`removed the old copy at ${from}`);
	return [];
}

/** `sites/<project>` links are absolute; point the copied ones at the copied releases. */
export async function relinkSites(from: string, to: string): Promise<void> {
	const sites = join(to, 'sites');
	const entries = await fs.readdir(sites, { withFileTypes: true }).catch(() => []);
	for (const entry of entries) {
		if (!entry.isSymbolicLink()) continue;
		const link = join(sites, entry.name);
		const target = await fs.readlink(link);
		if (!within(target, from)) continue;
		const tmp = `${link}.relink-${process.pid}`;
		await fs.symlink(`${to}${target.slice(from.length)}`, tmp);
		await fs.rename(tmp, link);
	}
}

async function moveBuildDir(options: StorageApplyOptions, from: string, to: string): Promise<string[]> {
	if (within(to, from) || within(from, to))
		throw new StorageApplyError('The new build directory cannot be inside the current one, or contain it.');
	await fs.mkdir(dirname(to), { recursive: true, mode: 0o755 });
	await fs.mkdir(to, { recursive: true, mode: 0o711 });
	await must(options, ['chown', 'root:root', to]);
	await fs.chmod(to, 0o711);
	const dropInPath = join(options.systemdDir, `${BUILDER_UNIT}.d`, DROP_IN);
	if (to === NODE_STORAGE_DEFAULTS.buildDir) await fs.rm(dropInPath, { force: true });
	else
		await writeAtomic(
			dropInPath,
			`# Written by yoal-storage (D48). Remove with the dashboard, not by hand.\n[Service]\nEnvironment=YOAL_BUILD_DIR=${to}\nEnvironment=HOME=${to}\nWorkingDirectory=${to}\n`,
			0o644,
		);
	await must(options, ['systemctl', 'daemon-reload']);
	await options.run(['systemctl', 'try-restart', BUILDER_UNIT]);
	options.log(`build directory is now ${to}`);
	// Scratch only: checkouts are removed after each build. The default is the unit's
	// StateDirectory, which systemd recreates anyway, so leave it.
	if (from !== NODE_STORAGE_DEFAULTS.buildDir && options.pathProblem(from) === null)
		await fs.rm(from, { recursive: true, force: true }).catch(() => undefined);
	return [];
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function runStorageCli(args: string[]): Promise<number> {
	if (args[0] !== 'apply') {
		console.error('usage: yoal-agent storage apply   (run as root by yoal-storage.service)');
		return 2;
	}
	if (typeof process.getuid === 'function' && process.getuid() !== 0) {
		console.error('yoal-agent storage apply must run as root');
		return 1;
	}
	const options = defaultStorageApplyOptions();
	try {
		const status = await applyStorage(options);
		options.log(`${status.status}: data ${status.dataDir}, builds ${status.buildDir}${status.message ? ` (${status.message})` : ''}`);
		return status.status === 'failed' ? 1 : 0;
	} catch (error) {
		console.error(`[yoal-storage] ${errorText(error)}`);
		return 1;
	}
}
