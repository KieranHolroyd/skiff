import type { RequestHandler } from './$types';
import * as z from 'zod';
import { bucketNameSchema, storagePresignSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

const inputSchema = storagePresignSchema.extend({ bucket: bucketNameSchema });

/** A browser-facing presigned URL; only public instances have a reachable host (D64). */
export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, inputSchema);
		const { bucket, ...presign } = input;
		return core.storageObjects.presign(principal, event.params.name, bucket, presign);
	});
