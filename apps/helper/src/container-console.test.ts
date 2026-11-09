import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContainerConsole, mountViews, shellArgv, type PtyProcess, type SpawnPty } from './container-console.ts';
import { createHandler, type HelperRuntime } from './server.ts';
import type { CommandRunner } from './systemd.ts';

let dir: string;
let quadletDir: string;
let procRoot: string;
let cgroupRoot: string;

const ID = 'wld_abc123';
const NAME = `yoal-workload-${ID}`;

function inspectJson(running = true): string {
	return JSON.stringify([
		{
			ImageName: 'ghcr.io/acme/app:1.2',
			Image: 'sha256deadbeef',
			ImageDigest: 'sha256:abcd',
			State: {
				Status: running ? 'running' : 'exited',
				Running: running,
				Paused: false,
				Restarting: false,
				OOMKilled: false,
				Pid: 4242,
				ExitCode: 0,
				Error: '',
				StartedAt: '2026-11-07T10:00:00.000000000Z',
				FinishedAt: '0001-01-01T00:00:00Z',
				CgroupPath: '/yoal-workloads.slice/yoal-workload-wld_abc123.service/libpod-payload-x',
			},
			Config: {
				Env: ['PATH=/usr/bin', 'DATABASE_PASSWORD=hunter2', 'PORT=3000'],
				Cmd: ['node', 'server.js'],
				Entrypoint: '/docker-entrypoint.sh',
				WorkingDir: '/app',
				User: '1000',
				Labels: { 'org.opencontainers.image.version': '1.2' },
			},
			HostConfig: { ReadonlyRootfs: true, CapDrop: ['CAP_ALL'], CapAdd: [], SecurityOpt: ['no-new-privileges'], Tmpfs: { '/tmp': 'rw,size=64m' } },
			GraphDriver: { Data: { MergedDir: join(dir, 'merged') } },
			Mounts: [
				{ Type: 'bind', Source: join(dir, 'data'), Destination: '/data', RW: true },
				{ Type: 'bind', Source: '/run/yoal/secrets/x', Destination: '/run/yoal-secrets', RW: false },
			],
			NetworkSettings: {
				Ports: { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '41000' }] },
				Networks: { 'yoal-org-x': { IPAddress: '10.89.0.4', Aliases: ['app'] } },
			},
		},
	]);
}

function runner(running = true): CommandRunner & { calls: string[][] } {
	const calls: string[][] = [];
	return {
		calls,
		async run(argv) {
			calls.push(argv);
			if (argv.includes('inspect')) return { code: 0, stdout: inspectJson(running), stderr: '' };
			if (argv[1] === 'show')
				return {
					code: 0,
					stdout: `ActiveState=active\nSubState=running\nNRestarts=2\nControlGroup=/yoal-workloads.slice/${NAME}.service\n`,
					stderr: '',
				};
			return { code: 1, stdout: '', stderr: 'unexpected' };
		},
	};
}

interface FakePty extends PtyProcess {
	write(data: Uint8Array): void;
	argv: string[];
	written: string[];
	sizes: Array<[number, number]>;
	emit(text: string): void;
	exit(code: number): void;
	killed: string[];
}

function ptyFactory(): { spawn: SpawnPty; ptys: FakePty[] } {
	const ptys: FakePty[] = [];
	const spawn: SpawnPty = (argv, options) => {
		let resolveExit: (code: number) => void = () => undefined;
		const exited = new Promise<number>((resolve) => {
			resolveExit = resolve;
		});
		const pty: FakePty = {
			argv,
			written: [],
			sizes: [],
			killed: [],
			write: (data) => pty.written.push(new TextDecoder().decode(data)),
			resize: (cols, rows) => pty.sizes.push([cols, rows]),
			kill: (signal) => {
				pty.killed.push(signal ?? 'SIGTERM');
				resolveExit(129);
			},
			exited,
			emit: (text) => options.onData(new TextEncoder().encode(text)),
			exit: (code) => resolveExit(code),
		};
		ptys.push(pty);
		return pty;
	};
	return { spawn, ptys };
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'yoal-ctr-console-'));
	quadletDir = join(dir, 'quadlet');
	procRoot = join(dir, 'proc');
	cgroupRoot = join(dir, 'cgroup');
	mkdirSync(quadletDir);
	writeFileSync(join(quadletDir, `${NAME}.container`), '[Container]\n');
	mkdirSync(join(dir, 'merged/etc'), { recursive: true });
	mkdirSync(join(dir, 'data'), { recursive: true });
	writeFileSync(join(dir, 'merged/etc/os-release'), 'ID=alpine\n');
	const cg = join(cgroupRoot, `yoal-workloads.slice/${NAME}.service/libpod-payload-x`);
	mkdirSync(cg, { recursive: true });
	writeFileSync(join(cg, 'cgroup.procs'), '100\n101\n');
	writeFileSync(join(cg, 'cpu.stat'), 'usage_usec 1500000\nuser_usec 1000000\n');
	writeFileSync(join(cg, 'memory.current'), '52428800\n');
	writeFileSync(join(cg, 'memory.peak'), '62914560\n');
	writeFileSync(join(cg, 'memory.max'), 'max\n');
	writeFileSync(join(cg, 'memory.events'), 'low 0\noom 1\noom_kill 1\n');
	writeFileSync(join(cg, 'pids.current'), '2\n');
	writeFileSync(join(cg, 'pids.max'), '512\n');
	writeFileSync(join(cg, 'io.stat'), '8:0 rbytes=1000 wbytes=2000 rios=1 wios=2\n');
	mkdirSync(join(procRoot, '4242/net'), { recursive: true });
	writeFileSync(
		join(procRoot, '4242/net/dev'),
		'Inter-|   Receive\n face |bytes\n    lo: 50 0 0 0 0 0 0 0 50 0 0 0 0 0 0 0\n  eth0: 1234 5 0 0 0 0 0 0 5678 6 0 0 0 0 0 0\n',
	);
	writeFileSync(join(procRoot, 'stat'), 'cpu 1 2 3\nbtime 1762500000\n');
	for (const [pid, comm, ppid, nspid, cmd] of [
		[100, 'conmon', 1, '100', 'conmon\0'],
		[101, 'node', 100, '101 1', 'node\0server.js\0'],
	] as const) {
		mkdirSync(join(procRoot, String(pid)), { recursive: true });
		writeFileSync(
			join(procRoot, `${pid}/stat`),
			`${pid} (${comm}) S ${ppid} 1 1 0 -1 4194560 0 0 0 0 150 50 0 0 20 0 1 0 1000 0 0`,
		);
		writeFileSync(join(procRoot, `${pid}/status`), `Name:\t${comm}\nUid:\t1000\t1000\t1000\t1000\nVmRSS:\t  2048 kB\nNSpid:\t${nspid}\n`);
		writeFileSync(join(procRoot, `${pid}/cmdline`), cmd);
	}
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function consoleFor(options: { running?: boolean; spawn?: SpawnPty; now?: () => number } = {}) {
	const commands = runner(options.running ?? true);
	const console = new ContainerConsole({
		podmanPath: '/usr/bin/podman',
		systemctlPath: '/usr/bin/systemctl',
		quadletDir,
		runner: commands,
		spawnPty: options.spawn ?? ptyFactory().spawn,
		procRoot,
		cgroupRoot,
		fdView: { realPath: (_fd, opened) => opened, dirPath: (_fd, opened) => opened },
		now: options.now,
		limits: { execPerContainer: 2 },
	});
	return { console, commands };
}

async function readEvents(stream: ReadableStream<Uint8Array>, until: (text: string) => boolean): Promise<string> {
	const reader = stream.getReader();
	let text = '';
	while (!until(text)) {
		const { value, done } = await reader.read();
		if (done) break;
		text += new TextDecoder().decode(value);
	}
	await reader.cancel().catch(() => undefined);
	return text;
}

describe('ContainerConsole.assertWorkload', () => {
	test('accepts only rendered project containers', () => {
		const { console } = consoleFor();
		expect(console.assertWorkload(ID)).toBe(ID);
		expect(() => console.assertWorkload('db_abc')).toThrow('project containers');
		expect(() => console.assertWorkload('wld_abc;rm')).toThrow('project containers');
		expect(() => console.assertWorkload('wld_other')).toThrow('not a container');
	});
});

describe('ContainerConsole.inspect', () => {
	test('curates podman inspect, keeps env values on the node and reads stats from the cgroup', async () => {
		const { console } = consoleFor();
		const view = (await console.inspect(ID)) as Record<string, any>;
		expect(view.exists).toBe(true);
		expect(view.state).toMatchObject({ status: 'running', running: true, finishedAt: null });
		expect(view.unit).toEqual({ activeState: 'active', subState: 'running', restarts: 2 });
		expect(view.config.envNames).toEqual(['DATABASE_PASSWORD', 'PATH', 'PORT']);
		expect(JSON.stringify(view)).not.toContain('hunter2');
		expect(view.config.entrypoint).toEqual(['/docker-entrypoint.sh']);
		expect(view.security).toMatchObject({ readOnlyRootfs: true, noNewPrivileges: true });
		expect(view.network.ports).toEqual([{ container: '3000/tcp', host: '127.0.0.1:41000' }]);
		expect(view.mounts.find((mount: any) => mount.destination === '/run/yoal-secrets')).toMatchObject({ browsable: false, note: 'secrets' });
		expect(view.mounts.find((mount: any) => mount.destination === '/tmp')).toMatchObject({ browsable: false, note: 'tmpfs' });
		expect(view.stats).toMatchObject({
			cpuMicros: 1_500_000,
			memoryBytes: 52_428_800,
			memoryLimitBytes: null,
			oomKills: 1,
			pids: 2,
			pidsLimit: 512,
			netRxBytes: 1234,
			netTxBytes: 5678,
			blockReadBytes: 1000,
			blockWriteBytes: 2000,
		});
		// conmon is left out and pids are shown as the container sees them.
		expect(view.processes).toEqual([
			expect.objectContaining({ pid: 1, ppid: 0, uid: 1000, command: 'node server.js', rssBytes: 2048 * 1024, cpuMicros: 2_000_000 }),
		]);
	});

	test('a missing container still reports the unit', async () => {
		const { console } = consoleFor();
		(console as any).options.runner = {
			run: async (argv: string[]) =>
				argv.includes('inspect')
					? { code: 125, stdout: '', stderr: 'no such container' }
					: { code: 0, stdout: 'ActiveState=activating\nSubState=auto-restart\nNRestarts=7\n', stderr: '' },
		};
		const view = (await console.inspect(ID)) as Record<string, any>;
		expect(view.exists).toBe(false);
		expect(view.state.status).toBe('starting');
		expect(view.unit.restarts).toBe(7);
	});
});

describe('mountViews', () => {
	test('maps the merged dir to / and hides secrets', () => {
		const views = mountViews(JSON.parse(inspectJson())[0]);
		expect(views[0]).toMatchObject({ destination: '/', source: join(dir, 'merged'), readOnly: true });
		expect(views.find((view) => view.destination === '/run/yoal-secrets')?.source).toBeNull();
	});
});

describe('ContainerConsole.filesystem', () => {
	test('lists the container root', async () => {
		const { console } = consoleFor();
		const fs = await console.filesystem(ID);
		expect(fs.list('/', 50).entries.map((entry) => entry.name)).toEqual(['data', 'etc', 'tmp']);
		expect(fs.preview('/etc/os-release', 100).content).toBe('ID=alpine\n');
	});

	test('refuses a stopped container', async () => {
		const { console } = consoleFor({ running: false });
		await expect(console.filesystem(ID)).rejects.toThrow('not running');
	});
});

describe('ContainerConsole exec', () => {
	test('runs a fixed podman exec argv with a tag, streams output and replays after reconnect', async () => {
		const { spawn, ptys } = ptyFactory();
		const { console } = consoleFor({ spawn });
		const opened = await console.execOpen(ID, { shell: 'auto', user: 'root', cols: 100, rows: 30 });
		expect(opened.execId).toMatch(/^cx_[A-Za-z0-9]{24}$/);
		const pty = ptys[0]!;
		expect(pty.argv.slice(0, 5)).toEqual(['/usr/bin/podman', 'exec', '--interactive', '--tty', '--detach-keys=']);
		expect(pty.argv).toContain(`YOAL_EXEC_ID=${opened.execId}`);
		expect(pty.argv).toContain('0:0');
		expect(pty.argv.slice(-4)).toEqual([NAME, ...shellArgv('auto')]);

		pty.emit('hello ');
		pty.emit('world');
		const first = await readEvents(console.execStream(ID, opened.execId, 0), (text) => text.includes('id: 11'));
		expect(first).toContain(`data: ${Buffer.from('hello ').toString('base64')}`);
		expect(first).toContain('id: 6');

		// A reconnect after byte 6 replays only "world".
		const replay = await readEvents(console.execStream(ID, opened.execId, 6), (text) => text.includes('id: 11'));
		expect(replay).not.toContain(Buffer.from('hello ').toString('base64'));
		expect(replay).toContain(`data: ${Buffer.from('world').toString('base64')}`);

		console.execInput(ID, opened.execId, new TextEncoder().encode('ls\r'));
		console.execResize(ID, opened.execId, 80, 24);
		expect(pty.written).toEqual(['ls\r']);
		expect(pty.sizes).toEqual([[80, 24]]);

		const ended = readEvents(console.execStream(ID, opened.execId, 11), (text) => text.includes('event: exit'));
		pty.exit(0);
		expect(await ended).toContain('data: {"code":0}');
	});

	test('a session is bound to its container', async () => {
		const { console } = consoleFor();
		const opened = await console.execOpen(ID, { shell: '/bin/sh', user: 'default', cols: 80, rows: 24 });
		expect(() => console.execInput('wld_other', opened.execId, new Uint8Array([1]))).toThrow('No such shell');
		expect(() => console.execInput(ID, 'cx_nope', new Uint8Array([1]))).toThrow('malformed');
	});

	test('limits shells per container and refuses a stopped one', async () => {
		const { console } = consoleFor();
		await console.execOpen(ID, { shell: 'auto', user: 'default', cols: 80, rows: 24 });
		await console.execOpen(ID, { shell: 'auto', user: 'default', cols: 80, rows: 24 });
		await expect(console.execOpen(ID, { shell: 'auto', user: 'default', cols: 80, rows: 24 })).rejects.toThrow('at most 2');
		const stopped = consoleFor({ running: false }).console;
		await expect(stopped.execOpen(ID, { shell: 'auto', user: 'default', cols: 80, rows: 24 })).rejects.toThrow('not running');
	});

	test('idle shells without a viewer are closed by the sweep', async () => {
		let now = 1_000_000;
		const { spawn, ptys } = ptyFactory();
		const { console } = consoleFor({ spawn, now: () => now });
		await console.execOpen(ID, { shell: 'auto', user: 'default', cols: 80, rows: 24 });
		expect(console.openShells).toBe(1);
		now += 16 * 60_000;
		console.sweep();
		await Bun.sleep(5);
		expect(ptys[0]!.killed).toContain('SIGHUP');
		expect(console.openShells).toBe(0);
	});

	test('close hangs up the shell', async () => {
		const { spawn, ptys } = ptyFactory();
		const { console } = consoleFor({ spawn });
		const opened = await console.execOpen(ID, { shell: 'auto', user: 'default', cols: 80, rows: 24 });
		await console.execClose(ID, opened.execId);
		expect(ptys[0]!.killed[0]).toBe('SIGHUP');
		expect(() => console.execInput(ID, opened.execId, new Uint8Array([1]))).toThrow('No such shell');
	});
});

describe('helper routes', () => {
	const runtime = {} as HelperRuntime;

	test('expose the verbs and map errors', async () => {
		const { console } = consoleFor();
		const handler = createHandler(runtime, { version: 'test', containers: console });
		const inspect = await handler(new Request(`http://helper/v1/containers/${ID}`));
		expect(inspect.status).toBe(200);
		expect(((await inspect.json()) as any).container.exists).toBe(true);

		const listing = await handler(new Request(`http://helper/v1/containers/${ID}/files?path=/etc`));
		expect(((await listing.json()) as any).listing.entries.map((entry: any) => entry.name)).toEqual(['os-release']);

		const download = await handler(new Request(`http://helper/v1/containers/${ID}/files/download?path=/etc/os-release`));
		expect(download.headers.get('content-length')).toBe('10');
		expect(await download.text()).toBe('ID=alpine\n');

		const refused = await handler(new Request(`http://helper/v1/containers/${ID}/files?path=/tmp`));
		expect(refused.status).toBe(403);

		const managed = await handler(new Request('http://helper/v1/containers/db_abc'));
		expect(managed.status).toBe(400);

		const badShell = await handler(
			new Request(`http://helper/v1/containers/${ID}/exec`, { method: 'POST', body: JSON.stringify({ shell: '/usr/bin/python3' }) }),
		);
		expect(badShell.status).toBe(400);

		const exec = await handler(
			new Request(`http://helper/v1/containers/${ID}/exec`, { method: 'POST', body: JSON.stringify({ cols: 90, rows: 20 }) }),
		);
		const execId = ((await exec.json()) as any).exec.execId as string;
		const input = await handler(new Request(`http://helper/v1/containers/${ID}/exec/${execId}/input`, { method: 'POST', body: 'x' }));
		expect(input.status).toBe(200);
		const close = await handler(new Request(`http://helper/v1/containers/${ID}/exec/${execId}`, { method: 'DELETE' }));
		expect(close.status).toBe(200);
	});

	test('are absent on a helper without the console', async () => {
		const handler = createHandler(runtime, { version: 'test' });
		expect((await handler(new Request(`http://helper/v1/containers/${ID}`))).status).toBe(404);
	});
});
