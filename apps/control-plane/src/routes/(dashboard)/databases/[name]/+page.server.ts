import { error, fail, redirect } from '@sveltejs/kit';
import { CoreError } from '@skiff/core';
import {
	databaseAttachSchema,
	databaseEngineRegistry,
	databasePublicUrlUpdateSchema,
	databaseUpdateSchema,
	hasPermission,
	type DatabaseMetricPoint,
	type DatabaseMoveView,
	type NodeCapacityView,
	type DatabaseView,
	type Principal
} from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { parseTrafficRange, trafficRangeHref, trafficRanges } from '#lib/server/traffic-range.js';
import { failStatus, formString, toFormFailure } from '../../_lib/errors.js';
import { databaseCan, fieldErrorsFrom, optionalNumber } from '../_lib/forms.server.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params, url }) => {
	const principal = locals.principal!;
	// The studio used to be an in-page section (D60); old links land on its own route (D96).
	if (url.searchParams.get('tab') === 'studio')
		redirect(307, `/databases/${encodeURIComponent(params.name)}/studio`);
	let database;
	try {
		database = core.databases.get(principal, params.name, { includeDeleted: true });
	} catch (caught) {
		if (caught instanceof CoreError) error(caught.status, caught.message);
		throw caught;
	}

	// Same presets as the traffic page: minute buckets up to a day, hourly rollups beyond 48 h.
	const range = parseTrafficRange(url.searchParams.get('range'));
	let metrics: DatabaseMetricPoint[] = [];
	try {
		metrics = await core.databases.metrics(principal, params.name, {
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

	const dbCan = databaseCan(principal);

	const attached = new Set(database.attachments.map((item) => item.projectSlug));
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

	// Moving between nodes (D97). Node choices come from capacity, which only platform admins can
	// read, so the move dialog is theirs; the latest move's progress is shown to everyone.
	let move: DatabaseMoveView | null = null;
	try {
		move = core.moves.latestForDatabase(principal, params.name);
	} catch {
		move = null;
	}
	let moveTargets: NodeCapacityView[] = [];
	if (dbCan.update && !database.deletedAt) {
		try {
			moveTargets = core.workloads
				.capacity(principal)
				.filter((node) => node.nodeId !== database.nodeId && node.status === 'online');
		} catch {
			moveTargets = [];
		}
	}

	return {
		database,
		move,
		moveTargets,
		backups: core.databases.listBackups(principal, params.name, { includeDeleted: true }),
		metrics,
		telemetryAvailable: core.ctx.telemetry?.available ?? false,
		range,
		ranges: trafficRanges,
		rangeLinks,
		projects,
		engine: databaseEngineRegistry[database.engine],
		dbCan
	};
};

function projectRow(principal: Principal, slug: string) {
	return core.projects.requireRow(principal, slug);
}

export const actions: Actions = {
	credentials: async ({ locals, params }) => {
		const principal = locals.principal!;
		try {
			const credentials = core.databases.credentials(principal, params.name);
			return { credentials };
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	'public-url': async ({ locals, params }) => {
		const principal = locals.principal!;
		try {
			return { publicUrl: core.databases.revealPublicUrl(principal, params.name) };
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	'set-public-url': async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const parsed = databasePublicUrlUpdateSchema.safeParse({
			url: formString(data, 'url'),
		});
		if (!parsed.success) {
			return fail(400, {
				message: parsed.error.issues[0]?.message ?? 'Check the public URL.',
				fieldErrors: fieldErrorsFrom(parsed.error.issues),
			});
		}
		try {
			core.databases.setPublicUrl(principal, params.name, parsed.data);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		return {
			success: 'Public URL saved. It is encrypted with the org key and only revealed on demand.',
		};
	},

	'clear-public-url': async ({ locals, params }) => {
		const principal = locals.principal!;
		try {
			core.databases.clearPublicUrl(principal, params.name);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		return { success: 'Public URL cleared.' };
	},

	update: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		let current: DatabaseView;
		try {
			current = core.databases.get(principal, params.name);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		const next = {
			memoryMb: optionalNumber(formString(data, 'memoryMb')),
			cpus: optionalNumber(formString(data, 'cpus')),
			storageMb: optionalNumber(formString(data, 'storageMb'))
		};
		// Only send what changed, so an unchanged field never re-runs admission.
		const patch: Record<string, number | boolean> = {};
		if (next.memoryMb !== undefined && next.memoryMb !== current.memoryMb)
			patch.memoryMb = next.memoryMb;
		if (next.cpus !== undefined && next.cpus !== current.cpus) patch.cpus = next.cpus;
		if (next.storageMb !== undefined && next.storageMb !== current.storageMb)
			patch.storageMb = next.storageMb;
		const pooler = data.get('pooler') === 'on';
		if (pooler !== current.pooler.enabled) patch.pooler = pooler;
		if (Object.keys(patch).length === 0) return { success: 'Nothing changed.' };

		const parsed = databaseUpdateSchema.safeParse(patch);
		if (!parsed.success) {
			return fail(400, {
				message: parsed.error.issues[0]?.message ?? 'Check the resources.',
				fieldErrors: fieldErrorsFrom(parsed.error.issues)
			});
		}
		try {
			core.databases.update(principal, params.name, parsed.data);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		return {
			success:
				'Resources saved. The node restarts the database with the new limits on its next reconcile.'
		};
	},

	restart: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const target = formString(data, 'target') === 'pooler' ? 'pooler' : 'database';
		try {
			core.databases.restart(principal, params.name, { target });
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		return {
			success:
				target === 'pooler'
					? 'Pooler restart requested. Postgres keeps its connections.'
					: 'Restart requested. The node restarts the container and its pooler on the next reconcile.'
		};
	},

	rotate: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const role = formString(data, 'role') === 'monitor' ? 'monitor' : 'owner';
		try {
			core.databases.rotateCredentials(principal, params.name, { role });
			return {
				success: `Queued ${role} credential rotation. The node applies ALTER ROLE and verifies it before the secret swaps; attached apps restart with the new value.`
			};
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	extensions: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const parsed = databaseUpdateSchema.safeParse({ extensions: data.getAll('extensions').map(String) });
		if (!parsed.success)
			return fail(400, {
				message: parsed.error.issues[0]?.message ?? 'Check the extensions.',
				fieldErrors: fieldErrorsFrom(parsed.error.issues)
			});
		try {
			core.databases.update(principal, params.name, parsed.data);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		return {
			success:
				(parsed.data.extensions?.length ?? 0) === 0
					? 'Extensions saved. Removing one never drops it; use SQL if the data is no longer needed.'
					: 'Extensions saved. The node installs them on the next activation.'
		};
	},

	backup: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		try {
			const backup = core.databases.createBackup(principal, params.name, {
				pinned: formString(data, 'pinned') === 'on'
			});
			return { success: `Backup ${backup.id} queued. The node uploads it on its next pull.` };
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	'backup-policy': async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const retentionRaw = formString(data, 'retentionDays');
		const retentionDays = retentionRaw ? Number(retentionRaw) : undefined;
		if (retentionDays !== undefined && (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 365))
			return fail(400, {
				message: 'Retention must be a whole number of days between 1 and 365.',
				fieldErrors: { retentionDays: '1–365 days.' }
			});
		try {
			core.databases.setBackupPolicy(principal, params.name, {
				enabled: formString(data, 'enabled') === 'on',
				schedule: formString(data, 'schedule') || undefined,
				...(retentionDays === undefined ? {} : { retentionDays })
			});
			return { success: 'Backup policy saved.' };
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	'delete-backup': async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const backupId = formString(await request.formData(), 'backupId');
		if (!backupId) return fail(400, { message: 'Missing backup id.' });
		try {
			await core.databases.deleteBackup(principal, params.name, backupId);
			return { success: `Deleted backup ${backupId}.` };
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	move: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const node = formString(data, 'node');
		if (!node) return fail(400, { message: 'Choose a node to move to.' });
		const from = formString(data, 'from');
		const source = from === 'latest-backup' || from === 'empty' ? from : 'dump';
		if (source !== 'dump' && formString(data, 'acknowledge') !== 'on')
			return fail(400, {
				message:
					source === 'empty'
						? 'Confirm that the database starts empty and its current data is discarded.'
						: 'Confirm that writes after the latest backup are lost.'
			});
		try {
			const move = core.moves.moveDatabase(principal, params.name, { node, from: source });
			const warnings = move.warnings?.length ? ` ${move.warnings.join(' ')}` : '';
			return {
				success: `Moving to ${move.target.name ?? node}. ${
					move.projects.length
						? `${move.projects.join(', ')} stop${move.projects.length === 1 ? 's' : ''} until the restore finishes.`
						: 'The database is unavailable until the restore finishes.'
				}${warnings}`
			};
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	'restore-backup': async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const backupId = formString(data, 'backupId');
		const name = formString(data, 'name');
		if (!backupId || !name) return fail(400, { message: 'Choose a backup and a new database name.' });
		try {
			const restored = core.databases.restoreBackup(principal, params.name, backupId, {
				name,
				...(formString(data, 'project') ? { project: formString(data, 'project') } : {})
			});
			redirect(303, `/databases/${encodeURIComponent(restored.name)}`);
		} catch (caught) {
			if (caught instanceof CoreError) return fail(caught.status, { message: caught.message });
			throw caught;
		}
	},

	attach: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const slug = formString(data, 'project');
		// Empty: the engine's default prefix (DATABASE, MONGODB or REDIS).
		const envPrefix = formString(data, 'envPrefix').toUpperCase() || undefined;
		if (!slug)
			return fail(400, {
				message: 'Choose a project.',
				fieldErrors: { project: 'Choose a project.' }
			});
		const parsed = databaseAttachSchema.safeParse({ database: params.name, envPrefix });
		if (!parsed.success) {
			return fail(400, {
				message: parsed.error.issues[0]?.message ?? 'Check the env prefix.',
				fieldErrors: fieldErrorsFrom(parsed.error.issues)
			});
		}
		try {
			const { attachment, warning } = core.databases.attach(
				principal,
				projectRow(principal, slug),
				parsed.data
			);
			return {
				success: `Attached to ${attachment.projectSlug} as ${attachment.envPrefix}_URL. The app restarts with the new env.`,
				warning
			};
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	detach: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const slug = formString(await request.formData(), 'project');
		if (!slug) return fail(400, { message: 'Missing project.' });
		try {
			core.databases.detach(principal, projectRow(principal, slug), params.name);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		return { success: `Detached from ${slug}. The app restarts without the database env.` };
	},

	delete: async ({ locals, params }) => {
		const principal = locals.principal!;
		try {
			core.databases.delete(principal, params.name);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		return {
			success: `“${params.name}” moved to the trash. Its data stays on the node for 7 days.`
		};
	},

	restore: async ({ locals, params }) => {
		const principal = locals.principal!;
		try {
			core.databases.restore(principal, params.name);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		return { success: `“${params.name}” restored. Its node starts it on the next reconcile.` };
	},

	purge: async ({ locals, params }) => {
		const principal = locals.principal!;
		try {
			core.databases.purgeNow(principal, params.name);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		redirect(303, '/databases?view=trash');
	}
};
