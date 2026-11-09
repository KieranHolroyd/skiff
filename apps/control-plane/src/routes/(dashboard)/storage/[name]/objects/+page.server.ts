import { error, fail, redirect } from '@sveltejs/kit';
import { CoreError } from '@yoal/core';
import {
	hasPermission,
	storageObjectDeleteSchema,
	type StorageObjectList,
	type StorageView
} from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { failStatus, formString, toFormFailure } from '../../../_lib/errors.js';
import { storageCan } from '../../_lib/forms.server.js';
import type { Actions, PageServerLoad } from './$types';

/**
 * The object browser (D82). The list is fetched through the node gateway. Deletes and folders are
 * form actions; uploads go straight from the browser to the object REST endpoint (one `PUT` per
 * file, so drops of many files or whole folders show per-file progress). Both paths share the same
 * permission checks and audit.
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
		requested && buckets.some((item) => item.name === requested)
			? requested
			: (buckets[0]?.name ?? null);
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
		storageCan: storageCan(principal),
		maxUploadBytes: core.storageObjects.maxUploadBytes,
		maxUploadMb: Math.floor(core.storageObjects.maxUploadBytes / 1024 / 1024)
	};
};

export const actions: Actions = {
	delete: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const bucket = formString(data, 'bucket');
		const key = formString(data, 'key');
		if (!bucket || !key) return fail(400, { message: 'Missing bucket or key.' });
		try {
			const result = await core.storageObjects.remove(principal, params.name, bucket, {
				keys: [key]
			});
			if (result.errors.length > 0) return fail(502, { message: result.errors[0]!.message });
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		return { success: `Deleted ${key}.` };
	},

	deleteMany: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const bucket = formString(data, 'bucket');
		let keys: string[];
		try {
			keys = storageObjectDeleteSchema.parse({
				keys: JSON.parse(formString(data, 'keys') || '[]')
			}).keys;
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
