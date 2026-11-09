import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentUnit, detectCaddyAdminSocket } from '../systemd/agent.ts';
import { cliCommandScript, hostCommands, RELEASE_COMMANDS } from '../install/commands.ts';
import { hostPathsFromEnv, prepareHost, type CommandRunner } from './converge.ts';

let dir: string;
const runner = (calls: string[][]): CommandRunner => ({ run: (cmd) => void calls.push(cmd), capture: () => null });

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'yoal-converge-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('prepareHost', () => {
	test('adds the Web Push pair once and keeps it on later runs', async () => {
		const envFile = join(dir, 'yoal.env');
		writeFileSync(envFile, 'NODE_ENV=production\n');
		const paths = { ...hostPathsFromEnv({}), etcDir: dir };
		const calls: string[][] = [];
		const first = await prepareHost({ release: dir, paths, runner: runner(calls) });
		expect(first).toEqual({ changed: ['vapid-keys'], warnings: [] });
		expect(calls).toEqual([
			['chown', 'root:yoal', envFile],
			['chmod', '0640', envFile],
		]);
		const written = readFileSync(envFile, 'utf8');
		expect(written).toContain('NODE_ENV=production');
		expect(written).toMatch(/VAPID/);
		expect(await prepareHost({ release: dir, paths, runner: runner([]) })).toEqual({ changed: [], warnings: [] });
		expect(readFileSync(envFile, 'utf8')).toBe(written);
	});

	test('a host without yoal.env (a worker) is left alone', async () => {
		const paths = { ...hostPathsFromEnv({}), etcDir: dir };
		expect(await prepareHost({ release: dir, paths, runner: runner([]) })).toEqual({ changed: [], warnings: [] });
	});
});

describe('agent unit', () => {
	test('renders the paths it is given', () => {
		const unit = agentUnit({ optDir: '/o', etcDir: '/e', varDir: '/v', runDir: '/r', caddyAdminSocket: '/c.sock' });
		expect(unit).toContain('ConditionPathExists=/e/agent.env');
		expect(unit).toContain('EnvironmentFile=/e/yoal.env\nEnvironmentFile=-/e/agent.env');
		expect(unit).toContain('Environment=YOAL_CADDY_ADMIN_SOCKET=/c.sock');
		expect(unit).toContain('ExecStart=/o/current/agent/yoal-agent');
		expect(unit).toContain('ReadWritePaths=/v /r');
	});

	test('reads the admin socket from the Caddyfile without its mode suffix', () => {
		const caddyfile = join(dir, 'Caddyfile');
		writeFileSync(caddyfile, '{\n\tadmin unix//srv/caddy/admin.sock|0660\n}\n');
		// The default candidates do not exist on a test machine, so the Caddyfile decides.
		expect(detectCaddyAdminSocket(caddyfile)).toBe('/srv/caddy/admin.sock');
		expect(detectCaddyAdminSocket(join(dir, 'missing'))).toBe('/var/lib/caddy/admin.sock');
	});
});

describe('host commands', () => {
	test('every command runs from current, then previous, on the shared Bun', () => {
		const paths = { optDir: '/opt/yoal', bunBin: '/opt/yoal/runtime/bin/bun' };
		expect(cliCommandScript(paths)).toContain('exec /opt/yoal/runtime/bin/bun "$release/cli/yoal.js" "$@"');
		const commands = hostCommands(paths);
		expect(commands.map((c) => c.path)).toEqual([
			'/usr/local/bin/yoal',
			'/usr/local/bin/yoal',
			...RELEASE_COMMANDS.map((c) => c.path),
		]);
		for (const { body } of commands) expect(body).toContain('for release in /opt/yoal/current /opt/yoal/previous; do');
	});
});
