import { error } from '@sveltejs/kit';
import { rmSync, statSync } from 'node:fs';
import { core } from '#lib/server/core.js';
import { canConfigurePlatform, snapshotForDownload } from '#lib/server/platform-config.js';
import type { RequestHandler } from './$types';

/**
 * A consistent copy of the platform database, for an offline backup (POST so a cross-site link
 * cannot trigger it; the CSRF hook enforces same-origin). Secrets inside stay encrypted with the
 * master key, which this does not include.
 */
export const POST: RequestHandler = async ({ locals }) => {
	const principal = locals.principal;
	if (!principal || !canConfigurePlatform(principal))
		error(403, 'Only the owner can download the database.');

	let path: string;
	try {
		path = snapshotForDownload(core.ctx.sqlite);
	} catch (cause) {
		core.ctx.audit.record({
			principal,
			action: 'platform.backup.download',
			resource: 'platform',
			result: 'error',
			error: (cause as Error).message
		});
		error(500, `Could not snapshot the database: ${(cause as Error).message}`);
	}
	core.ctx.audit.record({
		principal,
		action: 'platform.backup.download',
		resource: 'platform',
		result: 'ok'
	});

	const size = statSync(path).size;
	const file = Bun.file(path);
	const reader = file.stream().getReader();
	const cleanup = () => rmSync(path, { force: true });
	// Delete the copy once streamed (or abandoned); the next download also sweeps leftovers.
	const timer = setTimeout(cleanup, 30 * 60_000);
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			const { done, value } = await reader.read();
			if (done) {
				controller.close();
				clearTimeout(timer);
				cleanup();
			} else controller.enqueue(value);
		},
		cancel() {
			clearTimeout(timer);
			void reader.cancel();
			cleanup();
		}
	});
	const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
	return new Response(body, {
		headers: {
			'content-type': 'application/vnd.sqlite3',
			'content-length': String(size),
			'content-disposition': `attachment; filename="yoal-${stamp}.db"`,
			'cache-control': 'no-store'
		}
	});
};
