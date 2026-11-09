import { afterEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NODE_LISTEN_SOURCE } from './node-listen.ts';
import { SystemdDriver, nodeStartCommand, type CommandRunner, type RunResult } from './systemd.ts';
import { escapeUnitEnvironmentValue, renderProcessUnit } from './units.ts';
import { parseWorkload, type WorkloadDesired } from './validate.ts';

/** Node.js process apps (D125): the helper half. */
const SHA = 'a'.repeat(64);
const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function temp(): Promise<string> {
	const dir = await fs.mkdtemp(join(tmpdir(), 'yoal-node-listen-'));
	directories.push(dir);
	return dir;
}

function workload(overrides: Record<string, unknown> = {}): WorkloadDesired {
	return parseWorkload({
		id: 'wld_node01',
		projectId: 'prj_node01',
		projectSlug: 'node-app',
		deploymentId: 'dep_node01',
		runtime: 'process',
		status: 'running',
		release: SHA,
		upstream: 'unix//run/yoal-workloads/prj_node01.sock',
		memoryMb: 256,
		cpus: 1,
		port: 3000,
		healthPath: '/',
		socketActivation: true,
		activationVersion: 'b'.repeat(64),
		env: {},
		secrets: [],
		dataSizeMb: null,
		engine: 'node',
		...overrides,
	});
}

class QuietRunner implements CommandRunner {
	async run(): Promise<RunResult> {
		return { code: 0, stdout: '', stderr: '' };
	}
}

describe('workload.engine', () => {
	test('is accepted only as "node" and only for process workloads', () => {
		expect(workload().engine).toBe('node');
		expect(workload({ engine: undefined }).engine).toBeUndefined();
		expect(() => workload({ engine: 'bun' })).toThrow(/must be "node"/);
		expect(() =>
			workload({ runtime: 'container', release: null, image: 'nginx', socketActivation: false }),
		).toThrow(/Only process workloads may set workload.engine/);
	});
});

describe('renderProcessUnit with the Node preload', () => {
	test('loads the preload as a credential and prepends it to the app NODE_OPTIONS', () => {
		const unit = renderProcessUnit({
			workload: workload(),
			releaseDir: '/srv/release',
			envFile: '/run/yoal/env',
			secrets: [],
			command: ['node', 'server.js'],
			envNames: [],
			nodeListen: { path: '/run/yoal/wld_node01/yoal-node-listen.cjs', userNodeOptions: '--max-old-space-size=200 --title=50%' },
		});
		expect(unit).toContain('LoadCredential=yoal-node-listen.cjs:/run/yoal/wld_node01/yoal-node-listen.cjs');
		expect(unit).toContain(
			'Environment="NODE_OPTIONS=--require=%d/yoal-node-listen.cjs --max-old-space-size=200 --title=50%%"',
		);
		expect(unit).toContain('ExecStart=/usr/bin/env "node" "server.js"');
	});

	test('escapes quotes and backslashes, and refuses control characters', () => {
		expect(escapeUnitEnvironmentValue('a"b\\c%d')).toBe('a\\"b\\\\c%%d');
		expect(() => escapeUnitEnvironmentValue('a\nb')).toThrow(/control characters/);
	});
});

describe('nodeStartCommand', () => {
	test('wraps the start script in sh with node_modules/.bin and the pinned Node first on PATH', () => {
		expect(nodeStartCommand('{"scripts":{"start":"next start -p 3000"}}', '/srv/r', '/usr/local/bin')).toEqual([
			'/bin/sh',
			'-c',
			`PATH='/srv/r/node_modules/.bin':'/usr/local/bin':"$PATH"; export PATH; next start -p 3000`,
		]);
	});

	test('names what is missing', () => {
		expect(() => nodeStartCommand('{"name":"x"}', '/srv/r', '/usr/local/bin')).toThrow(/no "start" script/);
		expect(() => nodeStartCommand('{', '/srv/r', '/usr/local/bin')).toThrow(/not valid JSON/);
		expect(() => nodeStartCommand(JSON.stringify({ scripts: { start: 'a\nb' } }), '/srv/r', '/usr/local/bin')).toThrow(
			/must not contain newlines/,
		);
	});
});

describe('SystemdDriver for a Node app', () => {
	async function driver() {
		const root = await temp();
		const releases = join(root, 'releases');
		await fs.mkdir(join(releases, SHA), { recursive: true });
		await fs.writeFile(join(releases, SHA, 'package.json'), '{"name":"app","scripts":{"start":"node server.js"}}');
		const instance = new SystemdDriver({
			runner: new QuietRunner(),
			unitDir: join(root, 'units'),
			runtimeDir: join(root, 'run'),
			stateDir: join(root, 'state'),
			releaseDirs: [releases],
			volumeRegistryFile: join(root, 'volumes.json'),
			bunPath: '/usr/local/bin/bun',
			nodePath: '/usr/local/bin/node',
			chown: async () => undefined,
		});
		return { root, instance };
	}

	test('runs the start script under sh, writes the preload and moves NODE_OPTIONS into the unit', async () => {
		const { root, instance } = await driver();
		await instance.apply(workload({ env: { NODE_OPTIONS: '--enable-source-maps', NODE_ENV: 'production' } }), {
			workloadId: 'wld_node01',
			activationVersion: 'b'.repeat(64),
			env: {},
			files: {},
		});
		const unit = await fs.readFile(join(root, 'units', 'yoal-workload-wld_node01.service'), 'utf8');
		const bin = join(root, 'releases', SHA, 'node_modules', '.bin');
		expect(unit).toContain(
			`ExecStart="/bin/sh" "-c" "PATH='${bin}':'/usr/local/bin':\\"$$PATH\\"; export PATH; node server.js"`,
		);
		expect(unit).toContain('Environment="NODE_OPTIONS=--require=%d/yoal-node-listen.cjs --enable-source-maps"');
		const env = await fs.readFile(join(root, 'run', 'wld_node01', 'env'), 'utf8');
		expect(env).not.toContain('NODE_OPTIONS');
		expect(env).toContain('NODE_ENV');
		const preload = join(root, 'run', 'wld_node01', 'yoal-node-listen.cjs');
		expect(await fs.readFile(preload, 'utf8')).toBe(NODE_LISTEN_SOURCE);
		expect((await fs.stat(preload)).mode & 0o777).toBe(0o600);
	});

	test('without socket activation there is no preload and NODE_OPTIONS stays in the env file', async () => {
		const { root, instance } = await driver();
		await instance.apply(workload({ socketActivation: false, env: { NODE_OPTIONS: '--enable-source-maps' } }), {
			workloadId: 'wld_node01',
			activationVersion: 'b'.repeat(64),
			env: {},
			files: {},
		});
		const unit = await fs.readFile(join(root, 'units', 'yoal-workload-wld_node01.service'), 'utf8');
		expect(unit).not.toContain('yoal-node-listen.cjs');
		expect(unit).toContain('Environment=PORT=3000');
		expect(await fs.readFile(join(root, 'run', 'wld_node01', 'env'), 'utf8')).toContain('NODE_OPTIONS');
	});

	test('a Bun app is untouched', async () => {
		const { root, instance } = await driver();
		await instance.apply(workload({ engine: undefined, env: { NODE_OPTIONS: '--x' } }), {
			workloadId: 'wld_node01',
			activationVersion: 'b'.repeat(64),
			env: {},
			files: {},
		});
		const unit = await fs.readFile(join(root, 'units', 'yoal-workload-wld_node01.service'), 'utf8');
		expect(unit).toContain('ExecStart="/usr/local/bin/bun" "run" "start"');
		expect(unit).not.toContain('NODE_OPTIONS');
	});
});

/**
 * The preload against a real Node: a parent opens a listener, hands it to the child as fd 3 with
 * `LISTEN_FDS=1` (what systemd does), and closes its own copy. The child is an ordinary app that
 * calls `listen(4321)`; the request must reach it on the parent's port. Skipped without `node`.
 */
const nodeBinary = Bun.which('node');
describe.skipIf(!nodeBinary)('the preload under a real Node.js', () => {
	async function serve(app: string, script = 'server.js'): Promise<string> {
		const dir = await temp();
		await fs.writeFile(join(dir, 'yoal-node-listen.cjs'), NODE_LISTEN_SOURCE);
		await fs.writeFile(join(dir, script), app);
		await fs.writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { start: `node ${script}` } }));
		const parent = `
			const net = require('node:net');
			const { spawn } = require('node:child_process');
			const server = net.createServer();
			server.listen(0, '127.0.0.1', async () => {
				const { port } = server.address();
				const rest = process.argv.slice(2);
				const shell = rest[0] === '--shell';
				const child = spawn(shell ? rest[1] : process.execPath, shell ? rest.slice(2) : rest, {
					cwd: ${JSON.stringify(dir)},
					stdio: ['ignore', 'pipe', 'inherit', server._handle.fd],
					// Its own process group, so the server under sh dies with it (systemd kills the cgroup).
					detached: true,
					env: { ...process.env, LISTEN_FDS: '1', LISTEN_PID: '1', NODE_OPTIONS: '--require=${join(dir, 'yoal-node-listen.cjs')}' },
				});
				server.close();
				let out = '';
				child.stdout.on('data', (chunk) => (out += chunk));
				for (let attempt = 0; attempt < 50; attempt += 1) {
					try {
						const response = await fetch('http://127.0.0.1:' + port + '/');
						console.log(await response.text() + '|' + out.trim());
						process.kill(-child.pid, 'SIGKILL');
						return;
					} catch {
						await new Promise((resolve) => setTimeout(resolve, 100));
					}
				}
				process.kill(-child.pid, 'SIGKILL');
				console.log('unreachable|' + out.trim());
			});
		`;
		await fs.writeFile(join(dir, 'parent.cjs'), parent);
		return dir;
	}

	async function run(dir: string, args: string[]): Promise<string> {
		const proc = Bun.spawn([nodeBinary!, join(dir, 'parent.cjs'), ...args], { stdout: 'pipe', stderr: 'pipe' });
		const text = await new Response(proc.stdout).text();
		await proc.exited;
		return text.trim();
	}

	const APP = `
		const http = require('node:http');
		const server = http.createServer((_, res) => res.end('hello from ' + process.pid));
		server.listen(4321, () => console.log('fd3=' + (server.address().port !== 4321) + ' env=' + (process.env.LISTEN_FDS ?? 'cleared')));
	`;

	test('an unchanged app serves on the passed socket', async () => {
		const dir = await serve(APP);
		const output = await run(dir, ['server.js']);
		expect(output).toMatch(/^hello from \d+\|fd3=true env=cleared$/);
	}, 15_000);

	test('through the default start-script command, where sh starts the server', async () => {
		const dir = await serve(APP);
		const [shell, ...args] = nodeStartCommand(
			JSON.stringify({ scripts: { start: 'node server.js' } }),
			dir,
			join(nodeBinary!, '..'),
		);
		const output = await run(dir, ['--shell', shell!, ...args]);
		expect(output).toMatch(/^hello from \d+\|fd3=true env=cleared$/);
	}, 15_000);

	test('an ESM app is covered too', async () => {
		const dir = await serve(
			`import http from 'node:http';
			const server = http.createServer((_, res) => res.end('esm'));
			server.listen({ port: 4321, host: '0.0.0.0' }, () => console.log('ready'));`,
			'server.mjs',
		);
		expect(await run(dir, ['server.mjs'])).toBe('esm|ready');
	}, 15_000);
});
