import { describe, expect, test } from 'bun:test';
import type { DesiredState } from '@yoal/contracts';
import { ShareMountRunner, type HelperShareApi } from './share-mounts.ts';

type MountCall = Parameters<HelperShareApi['mountShare']>[0];

function fakeHelper(options: { failMounts?: number } = {}) {
	const mounted = new Set<string>();
	const mounts: MountCall[] = [];
	const unmounts: string[] = [];
	let failures = options.failMounts ?? 0;
	const helper: HelperShareApi = {
		async shareStatus(ids) {
			return ids.map((id) => ({ id, mounted: mounted.has(id) }));
		},
		async mountShare(share) {
			mounts.push(share);
			if (failures > 0) {
				failures -= 1;
				return { id: share.id, mounted: false, error: 'mount error(13): Permission denied' };
			}
			mounted.add(share.id);
			return { id: share.id, mounted: true, error: null };
		},
		async unmountShare(id) {
			unmounts.push(id);
			mounted.delete(id);
			return { id, mounted: false, error: null };
		},
	};
	return { helper, mounted, mounts, unmounts };
}

function state(partial: Partial<Pick<DesiredState, 'shareMounts' | 'shareUnmounts'>>): DesiredState {
	return { shareMounts: [], shareUnmounts: [], ...partial } as DesiredState;
}

const smb = {
	id: 'shm_1',
	name: 'vault',
	protocol: 'smb' as const,
	server: 'nas.home',
	exportPath: '/vault',
	readOnly: false,
	credentials: true,
	generation: '1',
};

describe('ShareMountRunner', () => {
	test('fetches SMB credentials for the mount call and reports the result', async () => {
		const { helper, mounts } = fakeHelper();
		const requested: string[] = [];
		const runner = new ShareMountRunner({
			controlUrl: 'https://control.test',
			nodeToken: 'node-token',
			helper,
			fetch: (async (url: string, init?: RequestInit) => {
				requested.push(`${url} ${(init?.headers as Record<string, string>).authorization}`);
				return Response.json({ id: 'shm_1', username: 'yoal', password: 'secret', domain: null });
			}) as typeof fetch,
		});
		expect(await runner.runOnce(state({ shareMounts: [smb] }))).toBe(true);
		expect(requested).toEqual(['https://control.test/api/agent/share-mounts/shm_1/credentials Bearer node-token']);
		expect(mounts).toEqual([
			{ id: 'vault', protocol: 'smb', server: 'nas.home', exportPath: '/vault', readOnly: false, username: 'yoal', password: 'secret' },
		]);
		expect(runner.report()).toEqual({ shareMounts: [{ id: 'shm_1', mounted: true, error: null }], unmountedShares: [] });

		// Already mounted: a status check only, no credentials fetched again.
		expect(await runner.runOnce(state({ shareMounts: [smb] }))).toBe(false);
		expect(requested).toHaveLength(1);
		expect(mounts).toHaveLength(1);
	});

	test('backs off after a failure and retries at once when the generation changes', async () => {
		const { helper, mounts } = fakeHelper({ failMounts: 2 });
		let now = 0;
		const nfs = { ...smb, protocol: 'nfs' as const, credentials: false };
		const runner = new ShareMountRunner({ controlUrl: 'x', nodeToken: 'y', helper, now: () => now });
		await runner.runOnce(state({ shareMounts: [nfs] }));
		expect(runner.report().shareMounts).toEqual([{ id: 'shm_1', mounted: false, error: 'mount error(13): Permission denied' }]);

		now = 1_000;
		await runner.runOnce(state({ shareMounts: [nfs] }));
		expect(mounts).toHaveLength(1);

		now = 6_000;
		await runner.runOnce(state({ shareMounts: [nfs] }));
		expect(mounts).toHaveLength(2);

		// Second backoff is 15 s, but rotated credentials (new generation) skip it.
		now = 7_000;
		expect(await runner.runOnce(state({ shareMounts: [{ ...nfs, generation: '2' }] }))).toBe(true);
		expect(mounts).toHaveLength(3);
		expect(runner.report().shareMounts[0]!.mounted).toBe(true);
	});

	test('unmounts removed shares and reports them until acknowledged', async () => {
		const { helper, mounted, unmounts } = fakeHelper();
		mounted.add('vault');
		const runner = new ShareMountRunner({ controlUrl: 'x', nodeToken: 'y', helper });
		expect(await runner.runOnce(state({ shareUnmounts: [{ id: 'shm_1', name: 'vault' }] }))).toBe(true);
		expect(unmounts).toEqual(['vault']);
		expect(runner.report().unmountedShares).toEqual(['shm_1']);
		// Not repeated while waiting for the control plane to accept the report.
		await runner.runOnce(state({ shareUnmounts: [{ id: 'shm_1', name: 'vault' }] }));
		expect(unmounts).toHaveLength(1);
		runner.acknowledgeUnmounted(['shm_1']);
		expect(runner.report().unmountedShares).toEqual([]);
	});
});
