import { error, fail, redirect } from '@sveltejs/kit';
import { CoreError } from '@skiff/core';
import {
	bucketNameSchema,
	hasPermission,
	storageObjectDeleteSchema,
	type StorageObjectList,
	type StorageView
} from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { failStatus, formString, toFormFailure } from '../../../_lib/errors.js';
import type { Actions, PageServerLoad } from './$types';

/**
 * The object browser (D82). The list is fetched through the node gateway; mutations are form
 * actions so uploads and deletes share the same permission checks and audit as the REST API.
 */

function bucketHref(name: string, bucket: string, prefix = '', token?: string): string {
	const params = new URLSearchParams({ bucket });
	if (prefix) params.set('prefix', prefix);
	if (token) params.set('token', token);
	return `/storage/${encodeURIComponent(name)}/objects?${params.toString()}`;
}

export const load: PageServerLoad = async ({ locals, params, url }) => {
	const principal = locals.principal!;
	let storage: StorageView;
	try {
		storage = core.storage.get(principal, params.name);
	} catch (caught) {
		if (caught instanceof CoreError) error(caught.status, caught.message);
		throw caught;
	}

	const buckets = storage.buckets.filter((bucket) => bucket.state === 'ready');
	const requested = url.searchParams.get('bucket');
	const bucket =
		requested && buckets.some((item) => item.name === requested) ? requested : (buckets[0]?.name ?? null);
	const prefix = url.searchParams.get('prefix') ?? '';
	const token = url.searchParams.get('token') ?? undefined;

	let list: StorageObjectList | null = null;
	let listError: string | null = null;
	if (bucket) {
		try {
			list = await core.storageObjects.list(principal, storage.name, {
				bucket,
				prefix,
				delimiter: '/',
				token,
				limit: 100
			});
		} catch (caught) {
			listError = caught instanceof Error ? caught.message : 'Could not list this bucket.';
		}
	}

	return {
		storage,
		buckets,
		bucket,
		prefix,
		list,
		listError,
		canWrite: hasPermission(principal, 'storage:update'),
		maxUploadMb: Math.floor(core.storageObjects.maxUploadBytes / 1024 / 1024)
	};
};

export const actions: Actions = {
	upload: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const bucket = formString(data, 'bucket');
		const prefix = formString(data, 'prefix');
		const key = formString(data, 'key');
		const file = data.get('file');
		if (!bucket) return fail(400, { message: 'Choose a bucket.' });
		if (!(file instanceof File) || file.size === 0)
			return fail(400, { message: 'Choose a file to upload.' });
		const objectKey = (key || file.name).replace(/^\/+/, '');
		if (!objectKey) return fail(400, { message: 'The object needs a key.' });
		try {
			await core.storageObjects.upload(
				principal,
				params.name,
				bucket,
				prefix && !objectKey.startsWith(prefix) ? `${prefix}${objectKey}` : objectKey,
				new Uint8Array(await file.arrayBuffer()),
				file.type || null
			);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		redirect(303, bucketHref(params.name, bucket, prefix));
	},

	delete: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const bucket = formString(data, 'bucket');
		const key = formString(data, 'key');
		if (!bucket || !key) return fail(400, { message: 'Missing bucket or key.' });
		try {
			const result = await core.storageObjects.remove(principal, params.name, bucket, { keys: [key] });
			if (result.errors.length > 0)
				return fail(502, { message: result.errors[0]!.message });
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		return { success: `Deleted ${key}.` };
	},

	deleteMany: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const bucket = formString(data, 'bucket');
		let keys: string[] = [];
		try {
			keys = storageObjectDeleteSchema.parse({ keys: JSON.parse(formString(data, 'keys') || '[]') }).keys;
		} catch {
			return fail(400, { message: 'Select at least one object.' });
		}
		if (!bucket) return fail(400, { message: 'Missing bucket.' });
		try {
			let deleted = 0;
			for (let index = 0; index < keys.length; index += 1000) {
				const result = await core.storageObjects.remove(principal, params.name, bucket, {
					keys: keys.slice(index, index + 1000)
				});
				deleted += result.deleted.length;
			}
			return { success: `Deleted ${deleted} object${deleted === 1 ? '' : 's'}.` };
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	folder: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const bucket = formString(data, 'bucket');
		const prefix = formString(data, 'prefix');
		if (!bucket || !prefix) return fail(400, { message: 'Give the folder a name.' });
		const normalized = prefix.endsWith('/') ? prefix : `${prefix}/`;
		try {
			await core.storageObjects.folder(principal, params.name, bucket, normalized);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		redirect(303, bucketHref(params.name, bucket, normalized));
	}
};
