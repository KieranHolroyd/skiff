/**
 * Local preview: builds the site, serves it, and rebuilds whenever content, the renderer or the
 * site's own sources change. `bun src/dev.ts` (DOCS_PORT, default 4321).
 */
import { existsSync, statSync, watch } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildSite } from './build.ts';

const APP_DIR = resolve(import.meta.dir, '..');
const OUT = join(APP_DIR, '.dev-dist');
const port = Number(process.env.DOCS_PORT ?? 4321);

let building: Promise<void> | null = null;
let queued = false;

async function rebuild(reason: string) {
	if (building) {
		queued = true;
		return;
	}
	building = buildSite({ outDir: OUT, base: '/', siteUrl: null, dev: true })
		.then((result) => console.log(`[docs] ${reason}: ${result.pages} pages in ${result.ms} ms`))
		.catch((error) => console.error(`[docs] build failed (${reason}):\n${error.message ?? error}`))
		.finally(() => {
			building = null;
			if (queued) {
				queued = false;
				void rebuild('queued change');
			}
		});
	await building;
}

await rebuild('start');

for (const dir of [
	join(APP_DIR, 'src'),
	join(APP_DIR, '..', '..', 'packages/docs/content'),
	join(APP_DIR, '..', '..', 'packages/docs/src')
]) {
	watch(dir, { recursive: true }, (_event, file) => void rebuild(`changed ${file ?? dir}`));
}

Bun.serve({
	port,
	async fetch(request) {
		await building;
		const path = decodeURIComponent(new URL(request.url).pathname);
		const target = join(OUT, path);
		if (!target.startsWith(OUT)) return new Response('Bad path', { status: 400 });
		if (!path.endsWith('/') && existsSync(target) && statSync(target).isDirectory()) {
			return Response.redirect(`${path}/`, 308);
		}
		const file = path.endsWith('/') ? join(target, 'index.html') : target;
		if (existsSync(file) && statSync(file).isFile()) return new Response(Bun.file(file));
		return new Response(Bun.file(join(OUT, '404.html')), {
			status: 404,
			headers: { 'content-type': 'text/html; charset=utf-8' }
		});
	}
});

console.log(`[docs] serving on http://localhost:${port}`);
