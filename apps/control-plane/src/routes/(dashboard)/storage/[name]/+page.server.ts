import { error, fail, redirect } from '@sveltejs/kit';
import { CoreError } from '@skiff/core';
import {
	bucketAccesses,
	bucketCreateSchema,
	bucketUpdateSchema,
	hasPermission,
	storageAttachSchema,
	storageAttachmentUpdateSchema,
	storageEngineRegistry,
	storageUpdateSchema,
	type BucketAccess,
	type NodeCapacityView,
	type Principal,
	type StorageMetricPoint,
	type StorageView
} from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { parseTrafficRange, trafficRangeHref, trafficRanges } from '#lib/server/traffic-range.js';
import { failStatus, formBoolean, formString, toFormFailure } from '../../_lib/errors.js';
import { fieldErrorsFrom, optionalNumber } from '../../databases/_lib/forms.server.js';
import { grantsFromForm, storageCan } from '../_lib/forms.server.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params, url }) => {
	const principal = locals.principal!;
	let storage: StorageView;
	try {
		storage = core.storage.get(principal, params.name, { includeDeleted: true });
	} catch (caught) {
		if (caught instanceof CoreError) error(caught.status, caught.message);
		throw caught;
	}

	// Same presets as the traffic page: minute buckets up to a day, hourly rollups beyond 48 h.
	const range = parseTrafficRange(url.searchParams.get('range'));
	let metrics: StorageMetricPoint[] = [];
	try {
		metrics = await core.storage.metrics(principal, params.name, {
			from: range.from,
			to: range.to,
			interval: range.interval
		});
	} catch {
		// Charts are a nicety; the page still works without them.
	}
	const rangeLinks = Object.fromEntries(
		trafficRanges.map((item) => [item.key, trafficRangeHref(url, item.key)])
	);

	const attached = new Set(storage.attachments.map((item) => item.projectSlug));
	let projects: Array<{ slug: string; name: string; runtime: string }> = [];
	if (hasPermission(principal, 'project:update')) {
		try {
			projects = core.projects
				.list(principal)
				.filter((project) => project.runtime !== 'static' && !attached.has(project.slug))
				.map((project) => ({ slug: project.slug, name: project.name, runtime: project.runtime }));
		} catch {
			// Attaching is optional.
		}
	}

	// Moving between nodes (D97): node choices come from capacity, which only platform admins read.
	let moveTargets: NodeCapacityView[] = [];
	if (hasPermission(principal, 'storage:update') && !storage.deletedAt) {
		try {
			moveTargets = core.workloads
				.capacity(principal)
				.filter((node) => node.nodeId !== storage.nodeId && node.status === 'online');
		} catch {
			moveTargets = [];
		}
	}

	let replicas: Awaited<ReturnType<typeof core.storageReplication.list>> = [];
	try {
		replicas = core.storageReplication.list(principal, params.name);
	} catch {
		replicas = [];
	}
	let replicaTargets: Array<{ name: string; nodeId: string }> = [];
	if (storageCan(principal).update) {
		try {
			replicaTargets = core.storage
				.list(principal)
				.filter((item) => item.name !== storage.name && !item.public && item.nodeId !== storage.nodeId)
				.map((item) => ({ name: item.name, nodeId: item.nodeId }));
		} catch {
			replicaTargets = [];
		}
	}

	return {
		storage,
		replicas,
		replicaTargets,
		moveTargets,
		metrics,
		telemetryAvailable: (await core.ctx.telemetry?.ready()) ?? false,
		telemetryInstalled: core.ctx.telemetry?.installed ?? false,
		telemetryReason: core.ctx.telemetry?.error?.message ?? null,
		range,
		ranges: trafficRanges,
		rangeLinks,
		projects,
		engine: storageEngineRegistry[storage.engine],
		storageCan: storageCan(principal),
		logsCanRead: hasPermission(principal, 'logs:read')
	};
};

function projectRow(principal: Principal, slug: string) {
	return core.projects.requireRow(principal, slug);
}

function accessFrom(raw: string): BucketAccess | null {
	return (bucketAccesses as readonly string[]).includes(raw) ? (raw as BucketAccess) : null;
}

export const actions: Actions = {
	addReplica: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		try {
			core.storageReplication.add(principal, params.name, { target: formString(data, 'target') });
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		return { success: 'Replication rule registered. RustFS applies it on the next converge.' };
	},

	removeReplica: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		try {
			core.storageReplication.remove(principal, params.name, formString(data, 'id'));
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		return { success: 'Replication rule removed.' };
	},

	credentials: async ({ locals, params }) => {
		const principal = locals.principal!;
		try {
			const credentials = core.storage.credentials(principal, params.name);
			return { credentials };
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	move: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const node = formString(data, 'node');
		if (!node) return fail(400, { message: 'Choose a node to move to.' });
		if (!formBoolean(data, 'acknowledge'))
			return fail(400, { message: 'Confirm that the objects are not copied to the new node.' });
		try {
			const moved = core.moves.moveStorage(principal, params.name, { node, from: 'empty' });
			const followed = moved.projects.length ? ` ${moved.projects.join(', ')} moved with it.` : '';
			const warnings = moved.warnings.length ? ` ${moved.warnings.join(' ')}` : '';
			return {
				success: `Moved to ${moved.to.name ?? node}; it starts empty with its buckets and keys.${followed}${warnings}`
			};
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	restart: async ({ locals, params }) => {
		const principal = locals.principal!;
		try {
			core.storage.restart(principal, params.name);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		return {
			success:
				'Restart requested. The node restarts the container on its next reconcile; S3 requests fail briefly.'
		};
	},

	update: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		let current: StorageView;
		try {
			current = core.storage.get(principal, params.name);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		const next = {
			memoryMb: optionalNumber(formString(data, 'memoryMb')),
			cpus: optionalNumber(formString(data, 'cpus')),
			storageMb: optionalNumber(formString(data, 'storageMb'))
		};
		// Only send what changed, so an unchanged field never re-runs admission.
		const patch: Record<string, number> = {};
		if (next.memoryMb !== undefined && next.memoryMb !== current.memoryMb)
			patch.memoryMb = next.memoryMb;
		if (next.cpus !== undefined && next.cpus !== current.cpus) patch.cpus = next.cpus;
		if (next.storageMb !== undefined && next.storageMb !== current.storageMb)
			patch.storageMb = next.storageMb;
		if (Object.keys(patch).length === 0) return { success: 'Nothing changed.' };

		const parsed = storageUpdateSchema.safeParse(patch);
		if (!parsed.success) {
			return fail(400, {
				message: parsed.error.issues[0]?.message ?? 'Check the resources.',
				fieldErrors: fieldErrorsFrom(parsed.error.issues)
			});
		}
		try {
			core.storage.update(principal, params.name, parsed.data);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		return {
			success:
				'Resources saved. The node restarts the instance with the new limits on its next reconcile.'
		};
	},

	/** Public toggle (S3). Routes only; the container keeps running. */
	setPublic: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const makePublic = formBoolean(await request.formData(), 'public');
		try {
			const updated = core.storage.update(principal, params.name, { public: makePublic });
			return {
				success: makePublic
					? `Public at ${updated.publicUrl}. The edge serves it once routes converge.`
					: 'Private again. The public route is removed; the instance keeps running.'
			};
		} catch (caught) {
			return fail(failStatus(caught), { ...toFormFailure(caught), publicError: true });
		}
	},

	createBucket: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const parsed = bucketCreateSchema.safeParse({
			name: formString(data, 'bucket').toLowerCase(),
			access: accessFrom(formString(data, 'access')) ?? 'private'
		});
		if (!parsed.success) {
			return fail(400, {
				message: parsed.error.issues[0]?.message ?? 'Check the bucket name.',
				fieldErrors: { bucket: parsed.error.issues[0]?.message ?? 'Invalid bucket name.' }
			});
		}
		let wasBlocked = false;
		try {
			wasBlocked =
				core.storage
					.get(principal, params.name)
					.buckets.find((bucket) => bucket.name === parsed.data.name)?.state ===
				'delete-blocked';
			core.storage.createBucket(principal, params.name, parsed.data);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		return {
			success: wasBlocked
				? `Delete of “${parsed.data.name}” cancelled. The bucket and its objects stay.`
				: `Bucket “${parsed.data.name}” created. The node creates it on its next reconcile.`
		};
	},

	bucketAccess: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const bucket = formString(data, 'bucket');
		const access = accessFrom(formString(data, 'access'));
		if (!bucket || !access) return fail(400, { message: 'Missing bucket or access.' });
		try {
			core.storage.updateBucket(principal, params.name, bucket, { access });
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		return {
			success:
				access === 'public-read'
					? `“${bucket}” is public-read: anyone who can reach the endpoint can GET its objects.`
					: `“${bucket}” is private again.`
		};
	},

	bucketConfig: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const bucket = formString(data, 'bucket');
		if (!bucket) return fail(400, { message: 'Missing bucket.' });
		const patch: Record<string, unknown> = {};
		if (data.has('versioning'))
			patch.versioning = ['on', 'true', '1'].includes(formString(data, 'versioning'));
		const quota = formString(data, 'quotaMb').trim();
		if (quota !== '') {
			if (quota === 'none' || quota === '0') patch.quotaBytes = null;
			else {
				const mb = Number(quota);
				if (!Number.isFinite(mb) || mb <= 0)
					return fail(400, { message: 'Quota must be a positive number of MB, or none.' });
				patch.quotaBytes = Math.round(mb * 1024 * 1024);
			}
		}
		for (const field of ['lifecycle', 'cors'] as const) {
			const raw = formString(data, field).trim();
			if (raw === '') continue;
			try {
				patch[field] = JSON.parse(raw) as unknown;
			} catch {
				return fail(400, {
					message: `${field === 'lifecycle' ? 'Lifecycle' : 'CORS'} must be valid JSON.`,
				});
			}
		}
		if (Object.keys(patch).length === 0) return { success: 'Nothing changed.' };
		const parsed = bucketUpdateSchema.safeParse(patch);
		if (!parsed.success) {
			return fail(400, {
				message: parsed.error.issues[0]?.message ?? 'Check the bucket configuration.',
			});
		}
		try {
			core.storage.updateBucket(principal, params.name, bucket, parsed.data);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		return {
			success: `Configuration saved for “${bucket}”. The node applies it on its next reconcile.`,
		};
	},

	deleteBucket: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const bucket = formString(data, 'bucket');
		const force = formBoolean(data, 'force');
		if (!bucket) return fail(400, { message: 'Missing bucket.' });
		try {
			core.storage.deleteBucket(principal, params.name, bucket, { force });
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		return {
			success: force
				? `“${bucket}” is being emptied and deleted by its node.`
				: `“${bucket}” is being deleted. If it turns out not to be empty, it stays and is marked blocked.`
		};
	},

	attach: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const slug = formString(data, 'project');
		if (!slug)
			return fail(400, { message: 'Choose a project.', fieldErrors: { project: 'Choose a project.' } });
		const parsed = storageAttachSchema.safeParse({
			storage: params.name,
			envPrefix: formString(data, 'envPrefix').toUpperCase() || 'S3',
			grants: grantsFromForm(data)
		});
		if (!parsed.success) {
			return fail(400, {
				message: parsed.error.issues[0]?.message ?? 'Check the attachment.',
				fieldErrors: fieldErrorsFrom(parsed.error.issues)
			});
		}
		try {
			const { attachment, warning } = core.storage.attach(
				principal,
				projectRow(principal, slug),
				parsed.data
			);
			return {
				success: `Attached to ${attachment.projectSlug} as ${attachment.envPrefix}_*. The app restarts with the new env.`,
				warning
			};
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	updateGrants: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const slug = formString(data, 'project');
		if (!slug) return fail(400, { message: 'Missing project.' });
		const parsed = storageAttachmentUpdateSchema.safeParse({ grants: grantsFromForm(data) });
		if (!parsed.success) {
			return fail(400, {
				message: parsed.error.issues[0]?.message ?? 'Check the grants.',
				fieldErrors: fieldErrorsFrom(parsed.error.issues)
			});
		}
		try {
			core.storage.updateAttachment(principal, projectRow(principal, slug), params.name, parsed.data);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		return { success: `Grants for ${slug} saved. The app restarts with its updated key policy.` };
	},

	detach: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const slug = formString(await request.formData(), 'project');
		if (!slug) return fail(400, { message: 'Missing project.' });
		try {
			core.storage.detach(principal, projectRow(principal, slug), params.name);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		return { success: `Detached from ${slug}. Its key is deleted and the app restarts without it.` };
	},

	delete: async ({ locals, params }) => {
		const principal = locals.principal!;
		try {
			core.storage.delete(principal, params.name);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		return {
			success: `“${params.name}” moved to the trash. Its data stays on the node for ${core.policies.get().trashDays} days.`
		};
	},

	restore: async ({ locals, params }) => {
		const principal = locals.principal!;
		try {
			core.storage.restore(principal, params.name);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		return { success: `“${params.name}” restored. Its node starts it on the next reconcile.` };
	},

	purge: async ({ locals, params }) => {
		const principal = locals.principal!;
		try {
			core.storage.purgeNow(principal, params.name);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		redirect(303, '/storage?view=trash');
	}
};
