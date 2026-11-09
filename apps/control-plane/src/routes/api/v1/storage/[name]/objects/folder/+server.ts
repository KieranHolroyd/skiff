import type { RequestHandler } from './$types';
import * as z from 'zod';
import { bucketNameSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

const inputSchema = z.object({ prefix: z.string().min(1).max(1024) });

/** Create a folder marker: a zero-byte object whose key ends in `/`. */
export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const bucket = bucketNameSchema.parse(event.url.searchParams.get('bucket') ?? '');
		const input = await readJson(event.request, inputSchema);
		return core.storageObjects.folder(principal, event.params.name, bucket, input.prefix);
	});
