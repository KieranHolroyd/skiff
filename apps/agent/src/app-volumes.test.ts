import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { appVolumeTaskSchema, type AppVolumeNodeRef, type DesiredState } from '@skiff/contracts';
import { AppVolumeRunner, verifyStream, writersOf } from './app-volumes.ts';
import type { HelperAppVolumeApi } from './helper-client.ts';

const ref: AppVolumeNodeRef = { id: 'av_data', projectId: 'prj_1', backing: 'state_dir' };
const archive = new TextEncoder().encode('gzip-bytes-of-a-volume');
const sha = createHash('sha256').update(archive).digest('hex');

function stream(bytes: Uint8Array, chunk = 5): ReadableStream<Uint8Array> {
	let offset = 0;
	return new ReadableStream({
		pull(controller) {
			if (offset >= bytes.byteLength) return controller.close();
			controller.enqueue(bytes.slice(offset, offset + chunk));
			offset += chunk;
		},
	});
}

/** Only the fields the runner reads; the schema's own defaults fill the task fields. */
function state(partial: Record<string, unknown>): DesiredState {
	const tasks = (partial.appVolumeTasks as unknown[] | undefined) ?? [];
	return {
		workloads: [],
		appVolumes: [],
		appVolumePurges: [],
		...partial,
		appVolumeTasks: tasks.map((task) => appVolumeTaskSchema.parse(task)),
	} as unknown as DesiredState;
}

function workload(id: string, volumes: Array<{ id: string; mountPath: string; readOnly: boolean }>) {
	return { id, volumes };
}

class FakeHelper implements HelperAppVolumeApi {
	calls: string[] = [];
	snapshotInput: unknown = null;
	restored: Uint8Array[] = [];
	restoreError: Error | null = null;
	async appVolumeUsage(volumes: AppVolumeNodeRef[]) {
		this.calls.push(`usage:${volumes.map((item) => item.id).join(',')}`);
		return volumes.map((item, index) =>
			index === 0 ? { id: item.id, usedBytes: 4096 } : { id: item.id, usedBytes: null, error: 'not mounted' },
		);
	}
	async purgeAppVolume(volume: AppVolumeNodeRef) {
		this.calls.push(`purge:${volume.id}`);
	}
	async snapshotAppVolume(input: { volume: AppVolumeNodeRef; snapshotId: string; quiesce: boolean; writers: string[] }) {
		this.snapshotInput = input;
		return { method: 'reflink' as const, body: stream(archive) };
	}
	async restoreAppVolume(_volume: AppVolumeNodeRef, body: ReadableStream<Uint8Array>) {
		const reader = body.getReader();
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			this.restored.push(value);
		}
		if (this.restoreError) throw this.restoreError;
	}
}

const signal = new AbortController().signal;

describe('AppVolumeRunner', () => {
	test('measures on its interval, reports usage once, and keeps a failed sample out', async () => {
		let clock = 0;
		const helper = new FakeHelper();
		const runner = new AppVolumeRunner({ helper, usageIntervalMs: 60_000, now: () => clock });
		const desired = state({ appVolumes: [ref, { ...ref, id: 'av_other' }] });
		await runner.runOnce(desired, signal);
		await runner.runOnce(desired, signal);
		expect(helper.calls).toEqual(['usage:av_data,av_other']);
		const report = runner.pending();
		expect(report.usage).toEqual([{ id: 'av_data', usedBytes: 4096 }]);
		runner.acknowledge(report);
		expect(runner.pending().usage).toEqual([]);
		clock += 60_000;
		await runner.runOnce(desired, signal);
		expect(helper.calls).toHaveLength(2);
	});

	test('purges each entry once and reports it until acknowledged', async () => {
		const helper = new FakeHelper();
		const runner = new AppVolumeRunner({ helper });
		const desired = state({ appVolumePurges: [ref] });
		await runner.runOnce(desired, signal);
		await runner.runOnce(desired, signal);
		expect(helper.calls.filter((call) => call.startsWith('purge'))).toEqual(['purge:av_data']);
		const report = runner.pending();
		expect(report.purged).toEqual(['av_data']);
		runner.acknowledge(report);
		expect(runner.pending().purged).toEqual([]);
	});

	test('a snapshot pauses only read-write writers and uploads a hashed archive', async () => {
		const helper = new FakeHelper();
		const uploads: Array<{ url: string; body: string; type: string | null }> = [];
		const fakeFetch = (async (url: string, init: RequestInit) => {
			uploads.push({
				url,
				body: await new Response(init.body as ReadableStream).text(),
				type: new Headers(init.headers).get('content-type'),
			});
			return new Response(null, { status: 200 });
		}) as unknown as typeof fetch;
		const runner = new AppVolumeRunner({ helper, fetch: fakeFetch });
		const desired = state({
			workloads: [
				workload('wl_writer', [{ id: 'av_data', mountPath: '/var/lib/app', readOnly: false }]),
				workload('wl_reader', [{ id: 'av_data', mountPath: '/srv/ro', readOnly: true }]),
			],
			appVolumeTasks: [
				{ id: 'avs_1', action: 'snapshot', volume: ref, snapshotId: 'avs_1', url: 'https://s3/put', quiesce: true },
			],
		});
		await runner.runOnce(desired, signal);
		await runner.runOnce(desired, signal);
		await runner.idle();
		expect(helper.snapshotInput).toEqual({ volume: ref, snapshotId: 'avs_1', quiesce: true, writers: ['wl_writer'] });
		expect(uploads).toEqual([{ url: 'https://s3/put', body: 'gzip-bytes-of-a-volume', type: 'application/gzip' }]);
		const report = runner.pending();
		expect(report.results).toEqual([
			{
				taskId: 'avs_1',
				action: 'snapshot',
				snapshotId: 'avs_1',
				volumeId: 'av_data',
				status: 'ok',
				sizeBytes: archive.byteLength,
				sha256: sha,
				method: 'reflink',
			},
		]);
		runner.acknowledge(report);
		// Still in desired state until the control plane drops it: not run again.
		await runner.runOnce(desired, signal);
		await runner.idle();
		expect(uploads).toHaveLength(1);
	});

	test('a failed upload is reported with the status', async () => {
		const helper = new FakeHelper();
		const fakeFetch = (async (_url: string, init: RequestInit) => {
			await new Response(init.body as ReadableStream).arrayBuffer();
			return new Response('denied', { status: 403 });
		}) as unknown as typeof fetch;
		const runner = new AppVolumeRunner({ helper, fetch: fakeFetch });
		await runner.runOnce(
			state({
				appVolumeTasks: [
					{ id: 'avs_2', action: 'snapshot', volume: ref, snapshotId: 'avs_2', url: 'https://s3/put', quiesce: false },
				],
			}),
			signal,
		);
		await runner.idle();
		const [result] = runner.pending().results;
		expect(result).toMatchObject({ status: 'failed', action: 'snapshot' });
		expect(result!.error).toContain('403');
	});

	test('a restore streams the download into the helper and checks the checksum', async () => {
		const helper = new FakeHelper();
		const fakeFetch = (async () => new Response(stream(archive))) as unknown as typeof fetch;
		const runner = new AppVolumeRunner({ helper, fetch: fakeFetch });
		await runner.runOnce(
			state({
				appVolumeTasks: [
					{
						id: 'restore:av_new',
						action: 'restore',
						volume: { ...ref, id: 'av_new' },
						snapshotId: 'avs_1',
						url: 'https://s3/get',
						quiesce: false,
						checksum: sha,
					},
				],
			}),
			signal,
		);
		await runner.idle();
		expect(Buffer.concat(helper.restored).toString()).toBe('gzip-bytes-of-a-volume');
		expect(runner.pending().results).toEqual([
			{
				taskId: 'restore:av_new',
				action: 'restore',
				snapshotId: 'avs_1',
				volumeId: 'av_new',
				status: 'ok',
				sizeBytes: archive.byteLength,
			},
		]);
	});

	test('a checksum mismatch aborts the restore before the archive ends', async () => {
		const helper = new FakeHelper();
		const fakeFetch = (async () => new Response(stream(archive))) as unknown as typeof fetch;
		const runner = new AppVolumeRunner({ helper, fetch: fakeFetch });
		await runner.runOnce(
			state({
				appVolumeTasks: [
					{
						id: 'restore:av_bad',
						action: 'restore',
						volume: { ...ref, id: 'av_bad' },
						snapshotId: 'avs_1',
						url: 'https://s3/get',
						quiesce: false,
						checksum: 'b'.repeat(64),
					},
				],
			}),
			signal,
		);
		await runner.idle();
		const [result] = runner.pending().results;
		expect(result).toMatchObject({ status: 'failed', action: 'restore', volumeId: 'av_bad' });
		expect(result!.error).toContain('checksum mismatch');
	});
});

describe('helpers', () => {
	test('writersOf names read-write mounts only', () => {
		const desired = state({
			workloads: [
				workload('wl_b', [{ id: 'av_data', mountPath: '/a', readOnly: false }]),
				workload('wl_a', [{ id: 'av_data', mountPath: '/b', readOnly: false }]),
				workload('wl_ro', [{ id: 'av_data', mountPath: '/c', readOnly: true }]),
				workload('wl_other', [{ id: 'av_other', mountPath: '/d', readOnly: false }]),
			],
		});
		expect(writersOf(desired, 'av_data')).toEqual(['wl_a', 'wl_b']);
	});

	test('verifyStream passes a matching archive and errors a corrupt one before it closes', async () => {
		const good = verifyStream(stream(archive), sha);
		expect(await new Response(good.body).text()).toBe('gzip-bytes-of-a-volume');
		expect(good.mismatch()).toBeNull();
		const bad = verifyStream(stream(archive), 'c'.repeat(64));
		await expect(new Response(bad.body).text()).rejects.toThrow(/checksum mismatch/);
		expect(bad.mismatch()?.message).toContain('checksum mismatch');
	});
});
