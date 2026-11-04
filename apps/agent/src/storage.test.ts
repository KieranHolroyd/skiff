import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storagePathProblem, type NodeStorage, type NodeStorageStatus } from '@skiff/contracts';
import { StorageRequester } from './storage.ts';
import { applyStorage, parseEnv, setEnvLine, type CommandResult, type StorageApplyOptions } from './storage-apply.ts';

const root = mkdtempSync(join(tmpdir(), 'skiff-storage-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const sha = 'a'.repeat(64);

describe('env file edits', () => {
	test('replaces the key in place and keeps everything else', () => {
		const text = 'SKIFF_CONTROL_URL=https://c\nSKIFF_DATA_DIR=/var/lib/skiff/agent\n# note\n';
		expect(setEnvLine(text, 'SKIFF_DATA_DIR', '/mnt/a')).toBe('SKIFF_CONTROL_URL=https://c\nSKIFF_DATA_DIR=/mnt/a\n# note\n');
		expect(setEnvLine('A=1\n', 'SKIFF_DATA_DIR', '/mnt/a')).toBe('A=1\nSKIFF_DATA_DIR=/mnt/a\n');
		expect(parseEnv('A="x y"\n# c\nB=2').get('A')).toBe('x y');
	});
});

describe('StorageRequester', () => {
	test('requests a move once per setting, and again only while it is pending', async () => {
		let clock = 0;
		const request = join(root, 'req', 'storage.request');
		const requester = new StorageRequester(join(root, 'none.json'), request, () => clock);
		const desired: NodeStorage = { dataDir: '/mnt/a', buildDir: null };
		expect(await requester.reconcile({ dataDir: null, buildDir: null }, null)).toBe(false);
		expect(await requester.reconcile(desired, null)).toBe(true);
		expect(JSON.parse(readFileSync(request, 'utf8'))).toEqual(desired);
		expect(await requester.reconcile(desired, null)).toBe(false);
		clock += 61_000;
		expect(await requester.reconcile(desired, null)).toBe(true);
		const failed: NodeStorageStatus = {
			requested: desired,
			dataDir: '/var/lib/skiff/agent',
			buildDir: '/var/lib/skiff-builder',
			status: 'failed',
			message: 'x',
			updatedAt: '',
		};
		clock += 61_000;
		expect(await requester.reconcile(desired, failed)).toBe(false);
	});
});

describe('applyStorage', () => {
	let dir: string;
	let calls: string[];
	let active: Set<string>;
	let building: boolean;
	let requested: NodeStorage;
	let options: StorageApplyOptions;
	const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' });

	beforeEach(() => {
		dir = mkdtempSync(join(root, 'case-'));
		calls = [];
		active = new Set(['skiff-agent.service', 'skiff-builder.service']);
		building = false;
		const oldData = join(dir, 'old');
		mkdirSync(join(oldData, 'releases', sha), { recursive: true });
		mkdirSync(join(oldData, 'sites'));
		writeFileSync(join(oldData, 'releases', sha, 'index.html'), 'hi');
		symlinkSync(join(oldData, 'releases', sha), join(oldData, 'sites', 'prj_1'));
		writeFileSync(join(oldData, 'node.json'), '{}');
		mkdirSync(join(dir, 'etc'));
		writeFileSync(join(dir, 'etc', 'agent.env'), `SKIFF_CONTROL_URL=https://c\nSKIFF_NODE_TOKEN=t\nSKIFF_DATA_DIR=${oldData}\n`);
		requested = { dataDir: null, buildDir: null };
		options = {
			agentEnvFile: join(dir, 'etc', 'agent.env'),
			sharedEnvFile: join(dir, 'etc', 'skiff.env'),
			stateFile: join(dir, 'etc', 'storage.json'),
			systemdDir: join(dir, 'systemd'),
			agentUser: 'skiff',
			agentGroup: 'skiff',
			run: async (cmd) => {
				calls.push(cmd.join(' '));
				if (cmd[0] === 'cp') {
					const proc = Bun.spawnSync({ cmd, stdout: 'pipe', stderr: 'pipe' });
					return { code: proc.exitCode ?? 1, stdout: '', stderr: proc.stderr.toString() };
				}
				if (cmd[0] === 'systemctl' && cmd[1] === 'list-units') return ok(building ? 'skiff-build-bld_1.service loaded active running' : '');
				if (cmd[0] === 'systemctl' && cmd[1] === 'is-active') return { code: active.has(cmd[3]!) ? 0 : 3, stdout: '', stderr: '' };
				if (cmd[0] === 'systemctl' && cmd[1] === 'stop') active.delete(cmd[2]!);
				if (cmd[0] === 'systemctl' && cmd[1] === 'start') active.add(cmd[2]!);
				return ok();
			},
			fetchStorage: async () => requested,
			sleep: async () => undefined,
			now: () => new Date(0),
			log: () => undefined,
			settleMs: 0,
			// Temp dirs live under /tmp on Linux, which the real rules reject; allow only this case.
			pathProblem: (path) => (path.startsWith(`${dir}/`) ? null : storagePathProblem(path)),
		};
	});

	test('moves the data directory, re-points site links, rewrites agent.env and removes the old copy', async () => {
		// Inside the temp root, so the path rules accept it.
		const target = join(dir, 'disk', 'skiff');
		requested = { dataDir: target, buildDir: null };
		const status = await applyStorage(options);
		expect(status).toMatchObject({ status: 'applied', dataDir: target, requested });
		expect(readFileSync(join(target, 'releases', sha, 'index.html'), 'utf8')).toBe('hi');
		expect(readlinkSync(join(target, 'sites', 'prj_1'))).toBe(join(target, 'releases', sha));
		expect(readFileSync(options.agentEnvFile, 'utf8')).toContain(`SKIFF_DATA_DIR=${target}\n`);
		expect(readFileSync(join(options.systemdDir, 'skiff-agent.service.d', 'skiff-storage.conf'), 'utf8')).toContain(
			`ReadWritePaths=${target}`,
		);
		expect(existsSync(join(dir, 'old'))).toBe(false);
		expect(calls).toContain('systemctl stop skiff-agent.service');
		// The Builder was stopped with the agent (PartOf=) and comes back.
		expect(calls.filter((call) => call === 'systemctl start skiff-builder.service')).toHaveLength(1);
		expect(JSON.parse(readFileSync(options.stateFile, 'utf8')).status).toBe('applied');
	});

	test('rolls back when the agent does not stay up on the new path', async () => {
		const target = join(dir, 'disk', 'skiff');
		requested = { dataDir: target, buildDir: null };
		const before = readFileSync(options.agentEnvFile, 'utf8');
		const run = options.run;
		options.run = async (cmd) => {
			const result = await run(cmd);
			// The agent "crashes" right after starting on the new directory.
			if (cmd[1] === 'start' && cmd[2] === 'skiff-agent.service' && readFileSync(options.agentEnvFile, 'utf8') !== before)
				active.delete('skiff-agent.service');
			return result;
		};
		const status = await applyStorage(options);
		expect(status.status).toBe('failed');
		expect(status.dataDir).toBe(join(dir, 'old'));
		expect(readFileSync(options.agentEnvFile, 'utf8')).toBe(before);
		expect(existsSync(join(options.systemdDir, 'skiff-agent.service.d', 'skiff-storage.conf'))).toBe(false);
		expect(existsSync(target)).toBe(false);
		expect(existsSync(join(dir, 'old', 'releases', sha))).toBe(true);
	});

	test('refuses a non-empty unrelated directory and leaves everything in place', async () => {
		const target = join(dir, 'busy');
		mkdirSync(target);
		writeFileSync(join(target, 'photos.zip'), 'x');
		requested = { dataDir: target, buildDir: null };
		const status = await applyStorage(options);
		expect(status).toMatchObject({ status: 'failed' });
		expect(status.message).toMatch(/not empty/);
		expect(calls).not.toContain('systemctl stop skiff-agent.service');
	});

	test('waits while a build is running', async () => {
		building = true;
		requested = { dataDir: join(dir, 'disk', 'skiff'), buildDir: null };
		expect(await applyStorage(options)).toMatchObject({ status: 'pending' });
		expect(calls).not.toContain('systemctl stop skiff-agent.service');
	});

	test('moves the build directory with a Builder drop-in and no copy', async () => {
		const target = join(dir, 'disk', 'builds');
		requested = { dataDir: null, buildDir: target };
		// Data directory stays where agent.env says, which is not the default here: keep it.
		writeFileSync(options.agentEnvFile, 'SKIFF_CONTROL_URL=https://c\nSKIFF_NODE_TOKEN=t\nSKIFF_DATA_DIR=/var/lib/skiff/agent\n');
		const status = await applyStorage(options);
		expect(status).toMatchObject({ status: 'applied', buildDir: target, dataDir: '/var/lib/skiff/agent' });
		const dropIn = readFileSync(join(options.systemdDir, 'skiff-builder.service.d', 'skiff-storage.conf'), 'utf8');
		expect(dropIn).toContain(`Environment=SKIFF_BUILD_DIR=${target}`);
		expect(calls).toContain('systemctl try-restart skiff-builder.service');
		expect(calls).not.toContain('systemctl stop skiff-agent.service');
	});

	test('never moves a current directory that is not plainly node data', async () => {
		writeFileSync(options.agentEnvFile, 'SKIFF_CONTROL_URL=https://c\nSKIFF_NODE_TOKEN=t\n');
		writeFileSync(options.sharedEnvFile, 'SKIFF_DATA_DIR=/var/lib/skiff/data\n');
		requested = { dataDir: join(dir, 'disk', 'skiff'), buildDir: null };
		const status = await applyStorage(options);
		expect(status.status).toBe('failed');
		expect(status.message).toMatch(/not one this service will move/);
		expect(calls.some((call) => call.startsWith('systemctl stop'))).toBe(false);
	});

	test('re-checks the paths from the control plane before touching anything', async () => {
		requested = { dataDir: '/etc/skiff/evil', buildDir: null };
		const status = await applyStorage(options);
		expect(status.status).toBe('failed');
		expect(calls.some((call) => call.startsWith('systemctl stop'))).toBe(false);
	});
});
