import { fail } from '@sveltejs/kit';
import {
	appErrorListQuerySchema,
	appErrorStatusUpdateSchema,
	appErrorTargetCreateSchema,
	appErrorTargetUpdateSchema
} from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { failStatus, formBoolean, formString, toFormFailure } from '../_lib/errors.js';
import { readErrorsTab } from './_lib/subnav.js';
import type { Actions, PageServerLoad } from './$types';

/** Read something a viewer may not be allowed to see without taking the page down. */
function safely<T>(read: () => T, fallback: T): T {
	try {
		return read();
	} catch {
		return fallback;
	}
}

function queryValue(url: URL, name: string): string | undefined {
	const value = url.searchParams.get(name)?.trim();
	return value ? value : undefined;
}

export const load: PageServerLoad = ({ locals, url }) => {
	const principal = locals.principal!;
	const canManage = safely(
		() => core.ctx.iam.can(principal, 'project:update', { type: 'org' }),
		false
	);
	const service = safely(() => core.appErrors.serviceView(principal), null);

	const parsed = appErrorListQuerySchema.safeParse({
		status: queryValue(url, 'status'),
		level: queryValue(url, 'level'),
		environment: queryValue(url, 'environment'),
		release: queryValue(url, 'release'),
		target: queryValue(url, 'target'),
		q: queryValue(url, 'q'),
		range: queryValue(url, 'range'),
		sort: queryValue(url, 'sort'),
		offset: queryValue(url, 'offset') ?? '0'
	});
	const filters = parsed.success
		? {
				status: parsed.data.status,
				level: parsed.data.level ?? '',
				environment: parsed.data.environment ?? '',
				release: parsed.data.release ?? '',
				target: parsed.data.target ?? '',
				q: parsed.data.q ?? '',
				range: parsed.data.range,
				sort: parsed.data.sort,
				offset: parsed.data.offset ?? 0,
				before: parsed.data.before ?? null
			}
		: {
				status: 'unresolved',
				level: '',
				environment: '',
				release: '',
				target: '',
				q: '',
				range: 'all' as const,
				sort: 'last_seen' as const,
				offset: 0,
				before: null
			};
	const tab = readErrorsTab(url.searchParams.get('tab'), service ? service.targets.length : null);
	// The list and an open issue are only read on the Issues tab.
	const list =
		tab === 'issues'
			? safely(() => core.appErrors.orgList(principal, parsed.success ? parsed.data : {}), null)
			: null;
	const issueId = tab === 'issues' ? url.searchParams.get('issue') : null;
	const detail = issueId ? safely(() => core.appErrors.orgGet(principal, issueId), null) : null;
	const linked = new Set(
		(service?.targets ?? []).map((target) => target.projectId).filter(Boolean)
	);
	const unlinkedProjects = safely(
		() =>
			core.projects
				.list(principal)
				.filter((project) => !linked.has(project.id))
				.map((project) => ({ slug: project.slug, name: project.name })),
		[]
	);

	return {
		tab,
		service,
		list,
		detail,
		missingIssue: Boolean(issueId) && detail === null,
		filters,
		canManage,
		unlinkedProjects
	};
};

export const actions: Actions = {
	setAutoLink: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		try {
			core.appErrors.setAutoLink(principal, formBoolean(data, 'enabled'));
			return {
				success: formBoolean(data, 'enabled')
					? 'Automatic linking is on. Every project has a DSN, and new projects will get one.'
					: 'Automatic linking is off. Targets created by it are disabled; data is kept.'
			};
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	createTarget: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const parsed = appErrorTargetCreateSchema.safeParse({ name: formString(data, 'name') });
		if (!parsed.success) return fail(400, { message: 'Give the off-platform project a name.' });
		try {
			const target = core.appErrors.createStandaloneTarget(principal, parsed.data);
			return { success: `Created ${target.name}. Copy its DSN into the app.` };
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	linkProject: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const slug = formString(data, 'project');
		if (!slug) return fail(400, { message: 'Choose a project to link.' });
		try {
			const project = core.projects.requireRow(principal, slug);
			const target = core.appErrors.createProjectTarget(principal, project);
			return { success: `Linked ${target.name}. Its DSN is ready.` };
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	updateTarget: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const targetId = formString(data, 'targetId');
		if (!targetId) return fail(400, { message: 'Missing the target.' });
		const sampleRateRaw = formString(data, 'sampleRate');
		const parsed = appErrorTargetUpdateSchema.safeParse({
			...(formString(data, 'name') ? { name: formString(data, 'name') } : {}),
			...(sampleRateRaw ? { sampleRate: Number(sampleRateRaw) } : {}),
			notify: formBoolean(data, 'notify')
		});
		if (!parsed.success) return fail(400, { message: 'Check the target settings.' });
		try {
			core.appErrors.updateTarget(principal, targetId, parsed.data);
			return { success: 'Target settings saved.' };
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	toggleTarget: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const targetId = formString(data, 'targetId');
		if (!targetId) return fail(400, { message: 'Missing the target.' });
		const enabled = formBoolean(data, 'enabled');
		try {
			core.appErrors.updateTarget(principal, targetId, { enabled });
			return { success: enabled ? 'Target enabled.' : 'Target disabled. Its data is kept.' };
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	rotateTargetKey: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const targetId = formString(data, 'targetId');
		if (!targetId) return fail(400, { message: 'Missing the target.' });
		try {
			core.appErrors.rotateTargetKey(principal, targetId);
			return { success: 'New key created. The old key works for another 24 hours.' };
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	testTarget: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const targetId = formString(data, 'targetId');
		if (!targetId) return fail(400, { message: 'Missing the target.' });
		try {
			core.appErrors.testTarget(principal, targetId);
			return { success: 'Test error sent through the real ingest path.' };
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	deleteTarget: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const targetId = formString(data, 'targetId');
		if (!targetId) return fail(400, { message: 'Missing the target.' });
		try {
			core.appErrors.deleteTarget(principal, targetId);
			return { success: 'Target and its errors deleted.' };
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	updateIssueStatus: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const ids = formString(data, 'ids')
			.split(',')
			.map((id) => id.trim())
			.filter(Boolean);
		const status = formString(data, 'status');
		if (ids.length === 0) return fail(400, { message: 'Missing the issue ids.' });
		const parsed = appErrorStatusUpdateSchema.safeParse({ ids, status });
		if (!parsed.success) return fail(400, { message: 'Choose unresolved, resolved or ignored.' });
		try {
			const changed = core.appErrors.orgSetStatus(principal, parsed.data);
			return { success: `${changed} issue${changed === 1 ? '' : 's'} updated.` };
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	deleteIssue: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const issueId = formString(data, 'issueId');
		if (!issueId) return fail(400, { message: 'Missing the issue.' });
		try {
			core.appErrors.orgDeleteIssue(principal, issueId);
			return { success: 'Issue deleted.' };
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	deleteIssues: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const ids = formString(data, 'ids')
			.split(',')
			.map((id) => id.trim())
			.filter(Boolean);
		if (ids.length === 0) return fail(400, { message: 'Select at least one issue.' });
		try {
			const deleted = core.appErrors.orgDeleteIssues(principal, ids);
			return { success: `${deleted} issue${deleted === 1 ? '' : 's'} deleted.` };
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	}
};
