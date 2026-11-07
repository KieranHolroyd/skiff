import { error, fail, redirect } from '@sveltejs/kit';
import { CoreError, featureEnabled } from '@skiff/core';
import {
	databaseAttachSchema,
	databaseCredentialCreateSchema,
	databaseEngineRegistry,
	databasePublicUrlUpdateSchema,
	pitrUnsupportedReason,
	type DatabasePitrStatus,
	databaseUpdateSchema,
	hasPermission,
	type DatabaseCredentialView,
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

	// Read replicas (docs/CLUSTERING.md §9.2): Postgres only; the primary's own node is a valid
	// (read-scaling) target, so it is offered too.
	let replicas: Awaited<ReturnType<typeof core.databaseReplicas.list>> = [];
	let failovers: Awaited<ReturnType<typeof core.databaseReplicas.failovers>> = [];
	try {
		replicas = core.databaseReplicas.list(principal, params.name);
		failovers = core.databaseReplicas.failovers(principal, params.name);
	} catch {
		replicas = [];
		failovers = [];
	}
	let replicaTargets: NodeCapacityView[] = [];
	if (dbCan.update && database.engine === 'postgres' && !database.deletedAt) {
		try {
			replicaTargets = core.workloads.capacity(principal).filter((node) => node.status === 'online');
		} catch {
			replicaTargets = [];
		}
	}

	// Named credentials (docs/DATABASES.md §16): metadata only; a password needs an audited reveal.
	let credentials: DatabaseCredentialView[] = [];
	if (database.capabilities.namedCredentials) {
		try {
			credentials = core.databases.listCredentials(principal, params.name);
		} catch {
			credentials = [];
		}
	}

	// Point-in-time recovery (docs/PITR.md): only offered while SKIFF_FEATURE_PITR is on.
	const pitrFeature = featureEnabled(core.ctx.config, 'PITR') && database.capabilities.pitr;
	let pitr: DatabasePitrStatus | null = null;
	let pitrError: string | null = null;
	if (pitrFeature) {
		try {
			pitr = core.databases.pitrStatus(principal, params.name);
		} catch (caught) {
			// Typically the pgBackRest repository is not configured on the control plane.
			pitrError = caught instanceof Error ? caught.message : String(caught);
		}
	}

	return {
		database,
		credentials,
		pitrFeature,
		pitr,
		pitrError,
		pitrUnsupported: pitrFeature
			? pitrUnsupportedReason(database.engine, database.version, database.variant)
			: null,
		replicas,
		failovers,
		replicaTargets,
		move,
		moveTargets,
		backups: core.databases.listBackups(principal, params.name, { includeDeleted: true }),
		metrics,
		telemetryAvailable: (await core.ctx.telemetry?.ready()) ?? false,
		telemetryInstalled: core.ctx.telemetry?.installed ?? false,
		telemetryReason: core.ctx.telemetry?.error?.message ?? null,
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
	addReplica: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		try {
			core.databaseReplicas.add(principal, params.name, { node: formString(data, 'node') });
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		return { success: 'Replica added. It copies the primary first, then streams.' };
	},

	promoteReplica: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const generation = Number(formString(data, 'generation'));
		try {
			core.databaseReplicas.promote(
				principal,
				params.name,
				formString(data, 'id'),
				{ confirm: true, acceptDataLoss: formString(data, 'acceptDataLoss') === 'on' },
				{ ifMatch: Number.isInteger(generation) ? generation : null },
			);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		return { success: 'Promotion started: the old primary stops first, then the replica takes over.' };
	},

	removeReplica: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		try {
			core.databaseReplicas.remove(principal, params.name, formString(data, 'id'));
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		return { success: 'Removing the replica: its node deletes the copy and the primary drops its slot.' };
	},

	credentials: async ({ locals, params }) => {
		const principal = locals.principal!;
		try {
			const credentials = core.databases.credentials(principal, params.name);
			return { credentials };
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	'credential-create': async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const purpose = formString(data, 'purpose');
		// A date input: the credential stops working at the end of that day (UTC).
		const expires = formString(data, 'expires');
		const expiresMs = expires ? Date.parse(`${expires}T23:59:59Z`) : undefined;
		if (expiresMs !== undefined && Number.isNaN(expiresMs))
			return fail(400, { message: 'Check the expiry date.', fieldErrors: { expires: 'Pick a date.' } });
		const parsed = databaseCredentialCreateSchema.safeParse({
			role: formString(data, 'role') || 'app',
			...(purpose ? { purpose } : {}),
			...(expiresMs !== undefined ? { expiresAt: new Date(expiresMs).toISOString() } : {})
		});
		if (!parsed.success)
			return fail(400, {
				message: parsed.error.issues[0]?.message ?? 'Check the credential.',
				fieldErrors: fieldErrorsFrom(parsed.error.issues)
			});
		try {
			const credential = core.databases.createCredential(principal, params.name, parsed.data);
			return {
				success: `Created ${credential.role} credential ${credential.username}. The node creates the role on its next pull; reveal or attach it once it is ready.`
			};
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	'credential-rotate': async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const id = formString(await request.formData(), 'id');
		if (!id) return fail(400, { message: 'Missing credential id.' });
		try {
			const credential = core.databases.rotateNamedCredential(principal, params.name, id);
			return {
				success: `Rotating ${credential.username}. The node applies the new password first; apps attached with it then restart.`
			};
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	'credential-revoke': async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const id = formString(await request.formData(), 'id');
		if (!id) return fail(400, { message: 'Missing credential id.' });
		try {
			const credential = core.databases.revokeCredential(principal, params.name, id);
			return {
				success: `Revoking ${credential.username}. The node disables its login on its next pull.`
			};
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	'credential-reveal': async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const id = formString(await request.formData(), 'id');
		if (!id) return fail(400, { message: 'Missing credential id.' });
		try {
			return { credential: core.databases.revealCredential(principal, params.name, id) };
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

	'pitr-policy': async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const enabled = formString(await request.formData(), 'enabled') === 'on';
		try {
			core.databases.setPitrPolicy(principal, params.name, { enabled });
			return {
				success: enabled
					? 'Point-in-time recovery is on. The database restarts on the PITR image and takes its first full backup.'
					: 'Point-in-time recovery is off. WAL is no longer archived.'
			};
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	'pitr-backup': async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const type = formString(await request.formData(), 'type') || 'full';
		try {
			const task = core.databases.pitrBackup(principal, params.name, { type });
			return { success: `Base backup ${task.id} queued. The node runs it on its next pull.` };
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	'pitr-restore': async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const name = formString(data, 'name');
		const targetTime = formString(data, 'targetTime');
		if (!name || !targetTime)
			return fail(400, { message: 'Choose a moment to restore to and a new database name.' });
		if (Number.isNaN(Date.parse(targetTime)) || !/(Z|[+-]\d{2}:\d{2})$/.test(targetTime))
			return fail(400, { message: 'The restore time must be a full timestamp with a time zone.' });
		let restored: DatabaseView;
		try {
			restored = core.databases.restoreToTimestamp(principal, params.name, { name, targetTime });
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		redirect(303, `/databases/${encodeURIComponent(restored.name)}`);
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
		// Empty: connect as the built-in owner.
		const credential = formString(data, 'credential') || undefined;
		const parsed = databaseAttachSchema.safeParse({ database: params.name, envPrefix, credential });
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
				success: `Attached to ${attachment.projectSlug} as ${attachment.envPrefix}_URL${attachment.credentialRole ? `, connecting as the ${attachment.credentialRole} credential` : ''}. The app restarts with the new env.`,
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
			success: `“${params.name}” moved to the trash. Its data stays on the node for ${core.policies.get().trashDays} days.`
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
