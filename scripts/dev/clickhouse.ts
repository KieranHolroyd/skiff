#!/usr/bin/env bun
/**
 * Local ClickHouse for the dev control plane, configured by the same generators as production
 * (scripts/systemd/clickhouse.ts) with dev paths and fixed dev passwords.
 *
 *   bun run dev:clickhouse                 foreground (Ctrl-C stops it)
 *   bun run dev:clickhouse --background    detach; log + pid in apps/control-plane/.data/clickhouse
 *   bun run dev:clickhouse --stop          stop a background server
 *   bun run dev:clickhouse --status        is it answering?
 *   bun run dev:clickhouse --reset         delete the dev telemetry data first
 *   --port <n>                             HTTP port (default 18123)
 *
 * Data lives in apps/control-plane/.data/clickhouse (gitignored by `.data*\/`).
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
	CLICKHOUSE_DATABASE,
	CLICKHOUSE_ENV,
	CLICKHOUSE_HTTP_PORT,
	CLICKHOUSE_READER,
	CLICKHOUSE_WRITER,
	clickhouseConfigXml,
	clickhouseUsersXml,
} from '../systemd/clickhouse.ts';

export const DEV_WRITER_PASSWORD = 'skiff-dev';
export const DEV_READER_PASSWORD = 'skiff-dev-reader';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
};

const root = resolve(import.meta.dir, '..', '..');
const home = join(root, 'apps', 'control-plane', '.data', 'clickhouse');
const dataDir = join(home, 'data');
const configFile = join(home, 'config.xml');
const usersFile = join(home, 'users.xml');
const logFile = join(home, 'server.log');
const pidFile = join(home, 'server.pid');
const port = Number(option('--port') ?? CLICKHOUSE_HTTP_PORT);
const url = `http://127.0.0.1:${port}`;

function envLines(): string {
	return [
		`${CLICKHOUSE_ENV.url}=${url}`,
		`${CLICKHOUSE_ENV.database}=${CLICKHOUSE_DATABASE}`,
		`${CLICKHOUSE_ENV.user}=${CLICKHOUSE_WRITER}`,
		`${CLICKHOUSE_ENV.password}=${DEV_WRITER_PASSWORD}`,
		`${CLICKHOUSE_ENV.readerUser}=${CLICKHOUSE_READER}`,
		`${CLICKHOUSE_ENV.readerPassword}=${DEV_READER_PASSWORD}`,
	].join('\n');
}

async function ping(): Promise<boolean> {
	try {
		const response = await fetch(`${url}/ping`, { signal: AbortSignal.timeout(1_000) });
		return response.ok && (await response.text()).trim() === 'Ok.';
	} catch {
		return false;
	}
}

async function waitForPing(timeoutMs: number, alive: () => boolean): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await ping()) return true;
		if (!alive()) return false;
		await Bun.sleep(250);
	}
	return false;
}

function runningPid(): number | null {
	if (!existsSync(pidFile)) return null;
	const pid = Number(readFileSync(pidFile, 'utf8').trim());
	if (!Number.isInteger(pid) || pid <= 0) return null;
	try {
		process.kill(pid, 0);
		return pid;
	} catch {
		return null;
	}
}

async function stop(): Promise<number> {
	const pid = runningPid();
	if (!pid) {
		console.log('dev ClickHouse is not running (no live pid in server.pid)');
		rmSync(pidFile, { force: true });
		return 0;
	}
	process.kill(pid, 'SIGTERM');
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline && runningPid()) await Bun.sleep(250);
	if (runningPid()) {
		process.kill(pid, 'SIGKILL');
		console.log(`killed dev ClickHouse (pid ${pid}) after 30 s`);
	} else console.log(`stopped dev ClickHouse (pid ${pid})`);
	rmSync(pidFile, { force: true });
	return 0;
}

function printEnv(): void {
	console.log(`\nAdd to apps/control-plane/.env (Bun loads it for \`bun run dev\`):\n\n${envLines()}\n`);
	console.log(`Try: curl '${url.replace('://', `://${CLICKHOUSE_WRITER}:${DEV_WRITER_PASSWORD}@`)}/?query=SELECT+version()'`);
}

async function main(): Promise<number> {
	if (flag('--help') || flag('-h')) {
		console.log(readFileSync(import.meta.path, 'utf8').split('*/')[0]!.replace(/^#!.*\n\/\*\*\n/, '').replace(/^ \* ?/gm, ''));
		return 0;
	}
	if (flag('--stop')) return stop();
	if (flag('--status')) {
		const up = await ping();
		console.log(up ? `dev ClickHouse is answering on ${url} (pid ${runningPid() ?? 'unknown'})` : `nothing answering on ${url}`);
		return up ? 0 : 1;
	}

	const binary = Bun.which('clickhouse');
	if (!binary) {
		console.error(
			'clickhouse is not on PATH. Install it, then re-run:\n' +
				'  macOS:  brew install --cask clickhouse\n' +
				'  Linux:  curl https://clickhouse.com/ | sh && sudo ./clickhouse install   (or put ./clickhouse on PATH)',
		);
		return 1;
	}
	if (await ping()) {
		console.log(`something already answers on ${url}${runningPid() ? ` (dev ClickHouse, pid ${runningPid()})` : ''}`);
		printEnv();
		return 0;
	}

	if (flag('--reset')) {
		rmSync(dataDir, { recursive: true, force: true });
		console.log(`deleted ${dataDir}`);
	}
	mkdirSync(dataDir, { recursive: true });
	writeFileSync(configFile, clickhouseConfigXml({ dataDir, httpPort: port }));
	writeFileSync(
		usersFile,
		clickhouseUsersXml({
			writerPassword: DEV_WRITER_PASSWORD,
			readerPassword: DEV_READER_PASSWORD,
			// packages/core/src/test-clickhouse.ts: one throwaway database per test store.
			extraWriterDatabases: ['skiff_test*'],
		}),
	);

	const env: Record<string, string> = { ...(process.env as Record<string, string>), CLICKHOUSE_WATCHDOG_ENABLE: '0' };
	// macOS: ClickHouse forks in its DNS resolver, and the Objective-C runtime aborts a forked child
	// unless fork safety is disabled.
	if (process.platform === 'darwin') env.OBJC_DISABLE_INITIALIZE_FORK_SAFETY = 'YES';
	const cmd = [binary, 'server', `--config-file=${configFile}`];

	if (flag('--background')) {
		const out = openSync(logFile, 'a');
		const child = Bun.spawn({ cmd, cwd: home, env, stdin: 'ignore', stdout: out, stderr: out, detached: true });
		closeSync(out);
		writeFileSync(pidFile, `${child.pid}\n`);
		child.unref();
		let exited = false;
		child.exited.then(() => (exited = true));
		if (!(await waitForPing(60_000, () => !exited))) {
			console.error(`dev ClickHouse did not come up; see ${logFile}`);
			return 1;
		}
		console.log(`dev ClickHouse ${url} (pid ${child.pid}); log ${logFile}`);
		console.log('stop it with: bun run dev:clickhouse --stop');
		printEnv();
		return 0;
	}

	console.log(`starting dev ClickHouse on ${url} (data ${dataDir})`);
	const child = Bun.spawn({ cmd, cwd: home, env, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
	writeFileSync(pidFile, `${child.pid}\n`);
	// Bun's typings narrow process.on to its own events; the signals work at runtime.
	const signals = process as unknown as { on(event: string, listener: () => void): void };
	signals.on('SIGINT', () => child.kill('SIGINT'));
	signals.on('SIGTERM', () => child.kill('SIGTERM'));
	let exited = false;
	child.exited.then(() => (exited = true));
	if (await waitForPing(60_000, () => !exited)) {
		console.log(`dev ClickHouse is ready (pid ${child.pid}); Ctrl-C stops it`);
		printEnv();
	}
	const code = await child.exited;
	rmSync(pidFile, { force: true });
	return code;
}

process.exit(await main());
