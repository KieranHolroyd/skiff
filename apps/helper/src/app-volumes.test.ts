import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	AppVolumeData,
	BackingUnavailableError,
	duArgv,
	parseAppVolumeRef,
	parseAppVolumeRefQuery,
	parseAppVolumeRefs,
	parseDuOutput,
	parseSnapshotRequest,
	reflinkArgv,
	tarCreateArgv,
	tarExtractArgv,
	type ArchiveSpawner,
	type SpawnedArchive,
} from './app-volumes.ts';
import { createHandler, type HelperRuntime } from './server.ts';
import { ValidationError } from './validate.ts';

const ref = { id: 'av_one', projectId: 'prj_1', backing: 'state_dir' as const };

describe('app volume wire validation', () => {
	test('a reference carries ids and the backing, never a path', () => {
		expect(parseAppVolumeRef(ref)).toEqual(ref);
		expect(parseAppVolumeRef({ id: 'av_1', projectId: 'p', backing: 'node_volume', nodeVolumeId: 'vol_1' })).toEqual({
			id: 'av_1',
			projectId: 'p',
			backing: 'node_volume',
			nodeVolumeId: 'vol_1',
		});
		for (const bad of [
			{ ...ref, id: 'av_../../etc' },
			{ ...ref, id: '../av_1' },
			{ ...ref, id: 'db_1' },
			{ ...ref, projectId: 'prj/1' },
			{ ...ref, projectId: '..' },
			{ ...ref, backing: 'host' },
			{ ...ref, path: '/etc' },
			{ ...ref, nodeVolumeId: 'vol_1' },
			{ id: 'av_1', projectId: 'p', backing: 'node_volume' },
		])
			expect(() => parseAppVolumeRef(bad)).toThrow(ValidationError);
	});

	test('lists are bounded and unique', () => {
		expect(parseAppVolumeRefs([ref])).toHaveLength(1);
		expect(() => parseAppVolumeRefs([ref, ref])).toThrow('Duplicate');
		expect(() => parseAppVolumeRefs('x')).toThrow(ValidationError);
		expect(() => parseAppVolumeRefs([ref, { ...ref, id: 'av_two' }], 1)).toThrow('at most 1');
	});

	test('restore references come from the query string', () => {
		expect(parseAppVolumeRefQuery(new URLSearchParams('id=av_one&projectId=prj_1&backing=state_dir'))).toEqual(ref);
		expect(() => parseAppVolumeRefQuery(new URLSearchParams('id=av_one&id=av_two&projectId=p&backing=state_dir'))).toThrow(
			'repeated',
		);
		expect(() => parseAppVolumeRefQuery(new URLSearchParams('id=av_one&projectId=p&backing=state_dir&dir=/'))).toThrow(
			'not accepted',
		);
	});

	test('snapshot requests name writers by workload id only', () => {
		expect(parseSnapshotRequest({ volume: ref, snapshotId: 'avs_1', quiesce: true, writers: ['wl_a', 'wl_a'] })).toEqual({
			volume: ref,
			snapshotId: 'avs_1',
			quiesce: true,
			writers: ['wl_a'],
		});
		expect(() => parseSnapshotRequest({ volume: ref, snapshotId: 'avs_1', quiesce: 'yes' })).toThrow('quiesce');
		expect(() => parseSnapshotRequest({ volume: ref, snapshotId: '../x', quiesce: true })).toThrow('snapshotId');
		expect(() => parseSnapshotRequest({ volume: ref, snapshotId: 'avs_1', quiesce: true, writers: ['wl;rm'] })).toThrow();
		expect(() =>
			parseSnapshotRequest({ volume: ref, snapshotId: 'avs_1', quiesce: true, writers: Array(21).fill('wl_a') }),
		).toThrow('at most 20');
		expect(() => parseSnapshotRequest({ volume: ref, snapshotId: 'avs_1', quiesce: true, unit: 'sshd' })).toThrow(
			'not accepted',
		);
	});

	test('commands are fixed argv, never a shell string', () => {
		expect(duArgv('/usr/bin/du', '/d')).toEqual(['/usr/bin/du', '--summarize', '--block-size=1', '--one-file-system', '--', '/d']);
		expect(reflinkArgv('/usr/bin/cp', '/a', '/b')).toEqual([
			'/usr/bin/cp',
			'--archive',
			'--reflink=always',
			'--no-target-directory',
			'--',
			'/a',
			'/b',
		]);
		expect(tarCreateArgv('/usr/bin/tar', '/a').slice(-3)).toEqual(['/a', '--', '.']);
		expect(tarExtractArgv('/usr/bin/tar', '/b')).toContain('--numeric-owner');
		expect(tarExtractArgv('/usr/bin/tar', '/b')).not.toContain('--absolute-names');
		expect(parseDuOutput('4096\t/var/lib/x\n')).toBe(4096);
		expect(parseDuOutput('du: cannot access')).toBeNull();
	});
});

interface FakeRun {
	argv: string[];
}

class FakeRunner {
	calls: FakeRun[] = [];
	active = new Set<string>();
	freezeFails = new Set<string>();
	reflink = true;
	du = '1234\t/x\n';
	async run(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
		this.calls.push({ argv });
		const [bin, verb, ...rest] = argv;
		if (bin!.endsWith('systemctl')) {
			const unit = argv.at(-1)!;
			if (verb === 'is-active') return { code: this.active.has(unit) ? 0 : 3, stdout: '', stderr: '' };
			if (verb === 'freeze') return this.freezeFails.has(unit) ? { code: 1, stdout: '', stderr: 'not supported' } : ok();
			return ok();
		}
		if (bin!.endsWith('cp')) {
			if (!this.reflink) return { code: 1, stdout: '', stderr: 'Operation not supported' };
			await mkdir(rest.at(-1)!, { recursive: true });
			return ok();
		}
		if (bin!.endsWith('du')) return { code: 0, stdout: this.du, stderr: '' };
		return ok();
	}
	verbs(): string[] {
		return this.calls.map((call) => `${call.argv[0]!.split('/').pop()} ${call.argv[1]}${call.argv[1] === 'freeze' || call.argv[1] === 'thaw' ? ` ${call.argv.at(-1)}` : ''}`);
	}
}

function ok() {
	return { code: 0, stdout: '', stderr: '' };
}

class FakeSpawn {
	calls: string[][] = [];
	stdinChunks: Uint8Array[] = [];
	code = 0;
	output = new TextEncoder().encode('archive-bytes');
	onSpawn: (() => void) | null = null;
	spawner: ArchiveSpawner = (argv, options) => {
		this.calls.push(argv);
		this.onSpawn?.();
		const output = this.output;
		const chunks = this.stdinChunks;
		const code = this.code;
		const child: SpawnedArchive = {
			stdout:
				options.stdin === 'ignore'
					? new ReadableStream<Uint8Array>({
							start(controller) {
								controller.enqueue(output);
								controller.close();
							},
						})
					: null,
			stdin: options.stdin === 'pipe' ? { write: (chunk) => chunks.push(chunk), flush: () => undefined, end: () => undefined } : null,
			stderr: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.close();
				},
			}),
			exited: Promise.resolve(code),
			kill: () => undefined,
		};
		return child;
	};
}

describe('AppVolumeData', () => {
	let root: string;
	let stateDir: string;
	let runner: FakeRunner;
	let spawn: FakeSpawn;
	let mounted: boolean;
	let registry: Record<string, { mountPath: string; sourceKey: string; fsType: string }>;

	const data = () =>
		new AppVolumeData({
			stateDir,
			registry: async () => registry,
			runner,
			spawn: spawn.spawner,
			verifyMount: async (_runner, mountPath) => ({
				ok: mounted,
				mountPath,
				sourceKey: 'fs:x',
				message: mounted ? null : `Nothing is mounted at ${mountPath}.`,
			}),
		});

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'skiff-app-volumes-'));
		stateDir = join(root, 'state');
		runner = new FakeRunner();
		spawn = new FakeSpawn();
		mounted = true;
		registry = { vol_1: { mountPath: join(root, 'disk'), sourceKey: 'fs:x', fsType: 'ext4' } };
	});
	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	const volumeDir = () => join(stateDir, 'apps', 'prj_1', 'av_one');
	const consume = async (body: ReadableStream<Uint8Array>) => new TextDecoder().decode(await new Response(body).arrayBuffer());

	test('usage: a never-mounted volume is 0, a present one is measured with du', async () => {
		expect(await data().usage([ref])).toEqual([{ id: 'av_one', usedBytes: 0 }]);
		expect(runner.calls).toHaveLength(0);
		await mkdir(volumeDir(), { recursive: true });
		expect(await data().usage([ref])).toEqual([{ id: 'av_one', usedBytes: 1234 }]);
		expect(runner.calls[0]!.argv).toEqual(duArgv('/usr/bin/du', volumeDir()));
	});

	test('usage on an unmounted node volume reports null instead of measuring the root disk', async () => {
		mounted = false;
		const nodeRef = { id: 'av_two', projectId: 'prj_1', backing: 'node_volume' as const, nodeVolumeId: 'vol_1' };
		const [sample] = await data().usage([nodeRef]);
		expect(sample!.usedBytes).toBeNull();
		expect(sample!.error).toContain('not mounted');
		expect(runner.calls.some((call) => call.argv[0]!.endsWith('du'))).toBe(false);
	});

	test('purge removes only the volume directory', async () => {
		await mkdir(volumeDir(), { recursive: true });
		await writeFile(join(volumeDir(), 'file'), 'x');
		const sibling = join(stateDir, 'apps', 'prj_1', 'av_other');
		await mkdir(sibling, { recursive: true });
		await data().purge(ref);
		await expect(stat(volumeDir())).rejects.toThrow();
		expect((await stat(sibling)).isDirectory()).toBe(true);
		// Idempotent.
		await data().purge(ref);
	});

	test('purge fails closed on an unmounted backing and is a no-op for an unregistered one', async () => {
		const nodeRef = { id: 'av_two', projectId: 'prj_1', backing: 'node_volume' as const, nodeVolumeId: 'vol_1' };
		mounted = false;
		await expect(data().purge(nodeRef)).rejects.toBeInstanceOf(BackingUnavailableError);
		registry = {};
		await data().purge(nodeRef);
	});

	test('snapshot with no running writer is idle: nothing is frozen', async () => {
		const snapshot = await data().snapshot({ volume: ref, snapshotId: 'avs_1', quiesce: true, writers: ['wl_a'] });
		expect(snapshot.method).toBe('idle');
		expect(await consume(snapshot.body)).toBe('archive-bytes');
		expect(spawn.calls[0]).toEqual(tarCreateArgv('/usr/bin/tar', volumeDir()));
		expect(runner.verbs()).toEqual(['systemctl is-active']);
	});

	test('reflink snapshot thaws before the archive streams and removes the clone after', async () => {
		runner.active.add('skiff-workload-wl_a.service');
		let verbsAtSpawn: string[] = [];
		spawn.onSpawn = () => (verbsAtSpawn = runner.verbs());
		const snapshot = await data().snapshot({ volume: ref, snapshotId: 'avs_1', quiesce: true, writers: ['wl_a'] });
		expect(snapshot.method).toBe('reflink');
		expect(verbsAtSpawn).toEqual([
			'systemctl is-active',
			'systemctl freeze skiff-workload-wl_a.service',
			'cp --archive',
			'systemctl thaw skiff-workload-wl_a.service',
		]);
		const stage = join(stateDir, 'apps', 'prj_1', '.snapshots', 'av_one', 'avs_1');
		expect(spawn.calls[0]).toEqual(tarCreateArgv('/usr/bin/tar', stage));
		await consume(snapshot.body);
		await expect(stat(stage)).rejects.toThrow();
	});

	test('without reflink the writer stays frozen until the archive finished', async () => {
		runner.active.add('skiff-workload-wl_a.service');
		runner.reflink = false;
		const snapshot = await data().snapshot({ volume: ref, snapshotId: 'avs_1', quiesce: true, writers: ['wl_a'] });
		expect(snapshot.method).toBe('paused');
		expect(runner.verbs()).not.toContain('systemctl thaw skiff-workload-wl_a.service');
		expect(spawn.calls[0]).toEqual(tarCreateArgv('/usr/bin/tar', volumeDir()));
		await consume(snapshot.body);
		expect(runner.verbs().at(-1)).toBe('systemctl thaw skiff-workload-wl_a.service');
	});

	test('quiesce off copies a running writer live', async () => {
		runner.active.add('skiff-workload-wl_a.service');
		const snapshot = await data().snapshot({ volume: ref, snapshotId: 'avs_1', quiesce: false, writers: ['wl_a'] });
		expect(snapshot.method).toBe('live');
		expect(runner.verbs().some((verb) => verb.includes('freeze'))).toBe(false);
		await consume(snapshot.body);
	});

	test('a failed freeze thaws what was frozen and fails the snapshot', async () => {
		runner.active.add('skiff-workload-wl_a.service');
		runner.active.add('skiff-workload-wl_b.service');
		runner.freezeFails.add('skiff-workload-wl_b.service');
		await expect(
			data().snapshot({ volume: ref, snapshotId: 'avs_1', quiesce: true, writers: ['wl_a', 'wl_b'] }),
		).rejects.toThrow('Could not pause wl_b');
		expect(runner.verbs()).toContain('systemctl thaw skiff-workload-wl_a.service');
		expect(spawn.calls).toHaveLength(0);
	});

	test('a failing tar errors the stream and still thaws', async () => {
		runner.active.add('skiff-workload-wl_a.service');
		runner.reflink = false;
		spawn.code = 2;
		const snapshot = await data().snapshot({ volume: ref, snapshotId: 'avs_1', quiesce: true, writers: ['wl_a'] });
		await expect(consume(snapshot.body)).rejects.toThrow('tar exited 2');
		expect(runner.verbs().at(-1)).toBe('systemctl thaw skiff-workload-wl_a.service');
	});

	test('one snapshot or restore per volume at a time', async () => {
		const volumes = data();
		const first = await volumes.snapshot({ volume: ref, snapshotId: 'avs_1', quiesce: true, writers: [] });
		await expect(volumes.snapshot({ volume: ref, snapshotId: 'avs_2', quiesce: true, writers: [] })).rejects.toThrow(
			'already has',
		);
		await consume(first.body);
		const again = await volumes.snapshot({ volume: ref, snapshotId: 'avs_2', quiesce: true, writers: [] });
		await consume(again.body);
	});

	test('restore fills an empty volume and refuses a non-empty one', async () => {
		const body = new Response('tar-bytes').body!;
		await data().restore(ref, body);
		expect(spawn.calls[0]).toEqual(tarExtractArgv('/usr/bin/tar', volumeDir()));
		expect(new TextDecoder().decode(spawn.stdinChunks[0])).toBe('tar-bytes');
		await writeFile(join(volumeDir(), 'existing'), 'x');
		await expect(data().restore(ref, new Response('x').body!)).rejects.toThrow('not empty');
	});

	test('a failed restore leaves the volume empty', async () => {
		spawn.onSpawn = () => void writeFile(join(volumeDir(), 'partial'), 'x');
		spawn.code = 2;
		await expect(data().restore(ref, new Response('bad').body!)).rejects.toThrow('tar exited 2');
		expect(await readdir(volumeDir())).toEqual([]);
	});
});

describe('helper routes', () => {
	const runtime = {} as HelperRuntime;
	const post = (path: string, body: unknown) =>
		new Request(`http://localhost${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

	test('absent verbs are a 404', async () => {
		const handler = createHandler(runtime, { version: 't' });
		expect((await handler(post('/v1/app-volumes/usage', { volumes: [] }))).status).toBe(404);
	});

	test('validation happens before the verb runs', async () => {
		const seen: unknown[] = [];
		const handler = createHandler(runtime, {
			version: 't',
			appVolumes: {
				usage: async (refs) => {
					seen.push(refs);
					return refs.map((item) => ({ id: item.id, usedBytes: 7 }));
				},
				purge: async (item) => void seen.push(item),
				snapshot: async () => ({ method: 'idle', body: new Response('gz').body! }),
				restore: async () => undefined,
			},
		});
		const usage = await handler(post('/v1/app-volumes/usage', { volumes: [ref] }));
		expect(await usage.json()).toEqual({ ok: true, usage: [{ id: 'av_one', usedBytes: 7 }] });
		expect((await handler(post('/v1/app-volumes/purge', { volume: { ...ref, id: '../x' } }))).status).toBe(400);
		const snapshot = await handler(post('/v1/app-volumes/snapshot', { volume: ref, snapshotId: 'avs_1', quiesce: true }));
		expect(snapshot.headers.get('x-skiff-snapshot-method')).toBe('idle');
		expect(await snapshot.text()).toBe('gz');
		const restore = await handler(
			new Request('http://localhost/v1/app-volumes/restore?id=av_one&projectId=prj_1&backing=state_dir', { method: 'POST', body: 'x' }),
		);
		expect(restore.status).toBe(200);
		expect((await handler(new Request('http://localhost/v1/app-volumes/usage'))).status).toBe(405);
		expect(seen).toHaveLength(1);
	});
});
