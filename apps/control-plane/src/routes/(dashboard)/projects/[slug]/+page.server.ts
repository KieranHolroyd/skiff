import { error, fail, redirect } from '@sveltejs/kit';
import { CoreError, entriesFromZip, isFunctionTier } from '@yoal/core';
import {
	accessModes,
	appErrorListQuerySchema,
	appVolumeAttachSchema,
	appVolumeCreateSchema,
	appVolumeDetachSchema,
	appVolumeRestoreSchema,
	appVolumeSnapshotCreateSchema,
	databaseAttachSchema,
	hasPermission,
	placementSpecSchema,
	storageAttachSchema,
	storageAttachmentUpdateSchema,
	userPoolAttachSchema,
	workloadSpecSchema,
	workloadVariablesSchema,
	type BuildView,
	type DatabaseAttachmentView,
	type DomainView,
	type EnvironmentView,
	type GitSourceView,
	type NodeCapacityView,
	type Permission,
	type StorageAttachmentView,
	type StorageView,
	type UserPoolAttachmentView,
	type WorkloadView
} from '@yoal/contracts';
import type { SecretView } from '@yoal/core';
import { auth } from '#lib/server/auth.js';
import { core } from '#lib/server/core.js';
import { authErrorMessage } from '#lib/server/user-settings.js';
import { parseTrafficRange, trafficRangeHref, trafficRanges } from '#lib/server/traffic-range.js';
import {
	failStatus,
	formBoolean,
	formOptionalPositiveInt,
	formOptionalString,
	formRawString,
	formString,
	toFormFailure
} from '../../_lib/errors.js';
import { grantsFromForm } from '../../storage/_lib/forms.server.js';
import {
	FUNCTION_DEFAULT_TAB,
	functionTabFromProjectTab
} from '../../functions/_lib/function-tabs.js';
import type { Actions, PageServerLoad } from './$types';

const FUNCTION_SPEC_MESSAGE =
	"A function's runtime comes from its bundle's yoal-function.json. Change it there and deploy again.";

/** Run a read that a viewer may not be allowed to make without taking the page down. */
function safely<T>(read: () => T, fallback: T): T {
	try {
		return read();
	} catch {
		return fallback;
	}
}

function numberField(data: FormData, key: string, fallback: number): number {
	const raw = formString(data, key);
	if (!raw) return fallback;
	return Number(raw);
}

/** Commands are argv arrays, never shell strings: split on whitespace, keep quotes literal. */
function commandArgs(value: string): string[] {
	return value.trim().split(/\s+/).filter(Boolean);
}

function accessMode(value: string): (typeof accessModes)[number] | null {
	return (accessModes as readonly string[]).includes(value)
		? (value as (typeof accessModes)[number])
		: null;
}

function fieldErrorsFrom(issues: Array<{ path: PropertyKey[]; message: string }>) {
	const fieldErrors: Record<string, string> = {};
	for (const issue of issues) {
		const key = issue.path.map(String).join('.');
		if (key && !fieldErrors[key]) fieldErrors[key] = issue.message;
	}
	return fieldErrors;
}

/** People with a direct project-scope binding, including guests (IAM.md §8.2). */
interface ProjectMemberRow {
	id: string;
	userId: string;
	name: string | null;
	email: string | null;
	role: string;
	memberRole: string | null;
	joinedAt: string | null;
}

function projectMembers(orgId: string, projectId: string): ProjectMemberRow[] {
	try {
		return core.ctx.sqlite
			.query<ProjectMemberRow, [string, string]>(
				`SELECT b.id AS id, b.principal_id AS userId, b.role_id AS role,
				        u.name AS name, u.email AS email, m.role AS memberRole, m.createdAt AS joinedAt
				   FROM iam_bindings b
				   LEFT JOIN user u ON u.id = b.principal_id
				   LEFT JOIN member m ON m.userId = b.principal_id AND m.organizationId = b.org_id
				  WHERE b.org_id = ? AND b.principal_type = 'user'
				    AND b.scope_type = 'project' AND b.scope_id = ?
				  ORDER BY u.name ASC`
			)
			.all(orgId, projectId);
	} catch {
		return [];
	}
}

export const load: PageServerLoad = async ({ locals, params, url }) => {
	const principal = locals.principal!;
	try {
		const project = await core.projects.get(principal, params.slug);
		// Functions have their own console (D110); old project links land in the matching section.
		if (project.runtime === 'function' && url.searchParams.get('tab') !== 'errors') {
			const tab = functionTabFromProjectTab(url.searchParams.get('tab'));
			redirect(
				307,
				`/functions/${encodeURIComponent(project.slug)}${tab === FUNCTION_DEFAULT_TAB ? '' : `?tab=${tab}`}`
			);
		}
		const row = core.projects.requireRow(principal, params.slug);
		// Permissions in this page are project-scoped: a guest or a project-bound custom role gets
		// the same actions on this project as an org-wide principal with the same role (IAM.md §8.2).
		const canAt = (permission: Permission) =>
			core.ctx.iam.can(principal, permission, { type: 'project', id: row.id });
		const showGuestEmails = canAt('iam:read');
		const membersWithAccess = projectMembers(principal.orgId, row.id).map((member) => ({
			id: member.id,
			userId: member.userId,
			name: member.name || member.email?.split('@')[0] || member.userId,
			email: showGuestEmails ? member.email : null,
			role: member.role,
			guest: member.memberRole === 'guest' || member.memberRole === null,
			joinedAt: member.joinedAt
		}));
		const consoleOn = project.runtime === 'container' && core.containerConsole.enabled();
		const trafficRange = parseTrafficRange(url.searchParams.get('range'));
		const traffic = await core.metrics.trafficForProject(principal, params.slug, {
			from: trafficRange.from,
			to: trafficRange.to,
			interval: trafficRange.interval
		});
		const trafficLinks = Object.fromEntries(
			trafficRanges.map((range) => [
				range.key,
				trafficRangeHref(url, range.key, { tab: 'traffic' })
			])
		);
		const deployments = core.deployments.list(principal, row, { limit: 100 });
		let shareLinks: Awaited<ReturnType<typeof core.access.listShareLinks>> = [];
		let siteSessions: ReturnType<typeof core.access.listSessions> = [];
		if (canAt('shareLink:read')) {
			try {
				shareLinks = core.access.listShareLinks(principal, row);
				siteSessions = core.access.listSessions(principal, row);
			} catch {
				// The project can still be inspected without share-link visibility.
			}
		}

		const environments: EnvironmentView[] = safely(
			() => core.environments.list(principal, row),
			[]
		);
		const domains: DomainView[] = safely(() => core.domains.list(principal, row), []);
		const builds: BuildView[] = safely(() => core.builds.list(principal, row, { limit: 50 }), []);
		const gitSource: GitSourceView | null = safely(
			() => core.builds.gitSource(principal, row),
			null
		);
		const workload: WorkloadView | null = safely(() => core.workloads.get(principal, row), null);
		const workloadSpec = safely(() => core.workloads.projectSpec(row), null);
		// Plan 21: GitHub's view of a runner pool. Streamed so a slow GitHub never blocks the page.
		const runnerPool = workloadSpec?.runner
			? core.workloads.runnerPool(principal, row).catch(() => null)
			: Promise.resolve(null);
		const secrets: SecretView[] = safely(
			() => core.secrets.list(principal, { visibleTo: row.id }),
			[]
		);
		const capacity: NodeCapacityView[] =
			core.ctx.platformIam.canView(principal) ? safely(() => core.workloads.capacity(principal), []) : [];
		// Managed databases (D56): only process/container projects can attach one.
		const databaseAttachments: DatabaseAttachmentView[] =
			row.runtime === 'static' ? [] : safely(() => core.databases.attachments(principal, row), []);
		const attachableDatabases =
			row.runtime === 'static'
				? []
				: safely(() => core.databases.list(principal), [])
						.filter((db) => !databaseAttachments.some((item) => item.databaseId === db.id))
						.map((db) => ({
							name: db.name,
							engine: db.engine,
							version: db.version,
							engineLabel: db.engineLabel,
							nodeName: db.nodeName ?? db.nodeId
						}));
		// Managed object storage (S4): same rule, process/container projects only.
		const storageAttachments: StorageAttachmentView[] =
			row.runtime === 'static' ? [] : safely(() => core.storage.attachments(principal, row), []);
		const storageInstances: StorageView[] =
			row.runtime === 'static' ? [] : safely(() => core.storage.list(principal), []);
		const readyBuckets = (item: StorageView) =>
			item.buckets.filter((bucket) => bucket.state === 'ready').map((bucket) => bucket.name);
		const attachableStorage = storageInstances
			.filter((item) => !storageAttachments.some((attached) => attached.storageId === item.id))
			.map((item) => ({
				name: item.name,
				engineLabel: item.engineLabel,
				version: item.version,
				nodeName: item.nodeName ?? item.nodeId,
				public: item.public,
				buckets: readyBuckets(item)
			}))
			.filter((item) => item.buckets.length > 0);
		const storageBuckets: Record<string, string[]> = Object.fromEntries(
			storageInstances
				.filter((item) => storageAttachments.some((attached) => attached.storageId === item.id))
				.map((item) => [item.name, readyBuckets(item)])
		);
		// Managed user pools (IAM.md I28): the same process/container/function rule as databases.
		const userPoolAttachments: UserPoolAttachmentView[] =
			row.runtime === 'static' ? [] : safely(() => core.userPools.attachments(principal, row), []);
		const attachableUserPools =
			row.runtime === 'static'
				? []
				: safely(
						() =>
							core.userPools
								.list(principal)
								.filter(
									(pool) => !userPoolAttachments.some((attached) => attached.poolId === pool.id)
								)
								.map((pool) => ({
									name: pool.name,
									issuer: pool.issuer,
									disabled: pool.disabled,
									clients: safely(() => core.userPools.listClients(principal, pool.id), [])
										.filter((client) => !client.public)
										.map((client) => ({ name: client.name, clientId: client.clientId }))
								}))
								.filter((pool) => !pool.disabled && pool.clients.length > 0),
						[]
					);
		// App volumes (plan 07) are project-owned and only meaningful for runtime projects.
		const appVolumesEnabled = core.appVolumes.enabled();
		const appVolumes =
			appVolumesEnabled && row.runtime !== 'static'
				? safely(() => core.appVolumes.list(principal, row), [])
				: [];
		// Image picker suggestions from the platform registry (docs/REGISTRY.md G2); never fails the page.
		const registryImages: string[] =
			row.runtime === 'container' && canAt('image:pull')
				? safely(() => {
						const registry = core.registry.view(principal);
						if (!registry.enabled) return [];
						return core.registry
							.listRepositories(principal)
							.filter((repo) => repo.lastTag)
							.map((repo) => `${registry.host}/${repo.name}:${repo.lastTag}`);
					}, [])
				: [];

		const appErrorQuery = appErrorListQuerySchema.safeParse({
			status: url.searchParams.get('status')?.trim() || undefined,
			environment: url.searchParams.get('environment')?.trim() || undefined,
			release: url.searchParams.get('release')?.trim() || undefined,
			q: url.searchParams.get('q')?.trim() || undefined,
			range: url.searchParams.get('range')?.trim() || undefined,
			before: url.searchParams.get('before')?.trim() || undefined
		});
		const appErrorFilters = appErrorQuery.success
			? {
					status: appErrorQuery.data.status,
					environment: appErrorQuery.data.environment ?? '',
					release: appErrorQuery.data.release ?? '',
					q: appErrorQuery.data.q ?? '',
					range: appErrorQuery.data.range,
					before: appErrorQuery.data.before ?? null
				}
			: { status: 'unresolved', environment: '', release: '', q: '', range: 'all' as const, before: null };
		const appErrorSettings = safely(() => core.appErrors.settings(principal, row), null);
		const appErrorList = safely(
			() => core.appErrors.list(principal, row, appErrorQuery.success ? appErrorQuery.data : {}),
			null
		);
		const appErrorIssueId = url.searchParams.get('issue');
		const appErrorDetail = appErrorIssueId
			? safely(() => core.appErrors.get(principal, row, appErrorIssueId), null)
			: null;

		return {
			project,
			traffic,
			trafficRange,
			trafficRanges,
			trafficLinks,
			deployments,
			shareLinks,
			siteSessions,
			environments,
			domains,
			builds,
			gitSource,
			workload,
			workloadSpec,
			registryImages,
			runnerPool,
			secrets,
			capacity,
			databaseAttachments,
			attachableDatabases,
			storageAttachments,
			attachableStorage,
			storageBuckets,
			userPoolAttachments,
			attachableUserPools,
			appVolumesEnabled,
			/** Storage targets the volume form offers (docs/STORAGE.md §2.2). */
			appVolumeStorage: appVolumesEnabled ? core.disks.choices('app-volumes') : null,
			appVolumes,
			appErrors: appErrorList ? { unresolved: appErrorList.summary.unresolved } : null,
			appErrorSettings,
			appErrorList,
			appErrorDetail,
			appErrorFilters,
			/** Policies assignable to this project's scopes (IAM.md I25). */
			accessPolicies: safely(() => core.accessPolicies.list(principal, { projectId: row.id }), []),
			// Jobs (plan 09): the tab hides unless YOAL_FEATURE_JOBS is on.
			jobsEnabled: core.jobs.enabled(),
			/** Direct project-scope members, including guests (IAM.md §8.2). */
			projectMembers: membersWithAccess,
			can: {
				update: canAt('project:update'),
				// Better Auth's invite endpoint checks the caller's org role, so the button also needs
				// the org-level permission; a project-only custom inviter would be refused there.
				inviteGuest: canAt('member:invite') && hasPermission(principal, 'member:invite'),
				updateGuest: canAt('member:update-role'),
				removeGuest: canAt('member:remove'),
				deleteProject: canAt('project:delete'),
				createDeployment: canAt('deployment:create'),
				promote: canAt('deployment:promote'),
				rollback: canAt('deployment:rollback'),
				deleteDeployment: canAt('deployment:delete'),
				createShare: canAt('shareLink:create'),
				revokeShare: canAt('shareLink:revoke'),
				manageEnvironments: canAt('project:update'),
				promoteEnvironment: canAt('deployment:promote'),
				rollbackEnvironment: canAt('deployment:rollback'),
				createBuild: canAt('build:create'),
				cancelBuild: canAt('build:cancel'),
				readLogs: canAt('logs:read'),
				createDomain: canAt('domain:create'),
				deleteDomain: canAt('domain:delete'),
				createSecret: canAt('secret:create'),
				updateSecret: canAt('secret:update'),
				deleteSecret: canAt('secret:delete'),
				manageWorkload: canAt('project:update'),
				// Container console (D127): only for container projects while the feature is on.
				inspectContainer: consoleOn && canAt('container:inspect'),
				containerFiles: consoleOn && principal.credential === 'session' && canAt('container:files'),
				containerExec: consoleOn && principal.credential === 'session' && canAt('container:exec'),
				restartContainer: consoleOn && canAt('project:update'),
				viewCapacity: core.ctx.platformIam.canView(principal),
				readDatabases: canAt('database:read'),
				createDatabase: canAt('database:create'),
				attachDatabase:
					canAt('database:update') && canAt('project:update'),
				readStorage: canAt('storage:read'),
				createStorage: canAt('storage:create'),
				attachStorage:
					canAt('storage:update') && canAt('project:update'),
				readUserPools: canAt('userPool:read'),
				attachUserPool:
					canAt('userPool:update') && canAt('project:update'),
				manageVolumes: appVolumesEnabled && canAt('project:update'),
				manageErrors: canAt('project:update')
			}
		};
	} catch (caught) {
		if (caught instanceof CoreError)
			error(caught.status === 404 ? 404 : caught.status, caught.message);
		throw caught;
	}
};

export const actions: Actions = {
	/**
	 * Invite a guest to this project only (IAM.md §8.2). The org invitation creates the `member`
	 * row that sign-in needs; `projectId`/`projectRole` turn acceptance into a project binding.
	 */
	inviteGuest: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const email = formString(data, 'email').toLowerCase();
		const role = formString(data, 'role');
		const fieldErrors: Record<string, string> = {};
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
			fieldErrors.email = 'Enter a valid email address.';
		if (role !== 'deployer' && role !== 'viewer')
			fieldErrors.role = 'Choose deployer or viewer for this project.';
		if (Object.keys(fieldErrors).length > 0)
			return fail(400, { message: 'Check the invitation.', fieldErrors });

		let project: ReturnType<typeof core.projects.requireRow> | undefined;
		try {
			project = core.projects.requireRow(principal, params.slug);
			core.ctx.iam.require(principal, 'member:invite', { type: 'project', id: project.id });
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		if (!project) return fail(404, { message: 'That project no longer exists.' });

		try {
			await auth.api.createInvitation({
				body: {
					email,
					// The org role stays empty; access is the project binding recorded below.
					role: 'guest',
					organizationId: principal.orgId,
					resend: true,
					projectId: project.id,
					projectRole: role
				},
				headers: request.headers
			});
		} catch (caught) {
			return fail(400, { message: authErrorMessage(caught) });
		}
		core.audit.record({
			principal,
			action: 'member.invite',
			resource: 'invitation',
			args: { email, role, projectId: project.id, scope: 'project' },
			result: 'ok'
		});
		return { success: `Invitation sent to ${email} for ${project.name}.` };
	},

	/** Change a guest's role on this project (deployer or viewer). */
	updateGuestRole: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const bindingId = formString(data, 'bindingId');
		const role = formString(data, 'role');
		if (!bindingId) return fail(400, { message: 'Missing the project member.' });
		if (role !== 'deployer' && role !== 'viewer')
			return fail(400, { message: 'Choose deployer or viewer for this project.' });
		try {
			const project = core.projects.requireRow(principal, params.slug);
			core.ctx.iam.updateProjectBindingRole(principal, bindingId, project.id, role);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		return { success: `Project role changed to ${role}.` };
	},

	/** Remove someone's access to this project; their org guest membership stays until removed there. */
	removeGuest: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const bindingId = formString(await request.formData(), 'bindingId');
		if (!bindingId) return fail(400, { message: 'Missing the project member.' });
		try {
			const project = core.projects.requireRow(principal, params.slug);
			core.ctx.iam.removeProjectBinding(principal, bindingId, project.id);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		return { success: 'Project access removed.' };
	},

	setAccess: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const scope = formString(data, 'scope');
		const mode = formString(data, 'mode');
		const password = formRawString(data, 'password');
		const policyId = formString(data, 'policyId');

		const fieldErrors: Record<string, string> = {};
		if (scope !== 'production' && scope !== 'previews')
			fieldErrors.scope = 'Choose production or previews.';
		if (!(accessModes as readonly string[]).includes(mode))
			fieldErrors.mode = 'Choose a valid access mode.';
		if (mode === 'access' && !policyId)
			fieldErrors.policyId = 'Choose a Yoal Access policy.';
		// A blank password keeps the scope's current one; core refuses it when there is none.
		if (mode === 'password' && password.length > 0 && password.length < 8) {
			fieldErrors.password = 'Use at least 8 characters for password mode.';
		}
		if (Object.keys(fieldErrors).length > 0) {
			return fail(400, { message: 'Check the access settings.', fieldErrors });
		}

		try {
			const project = core.projects.requireRow(principal, params.slug);
			await core.projects.setAccess(principal, project.slug, {
				scope: scope as 'production' | 'previews',
				mode: mode as (typeof accessModes)[number],
				password: mode === 'password' && password ? password : undefined,
				policyId: mode === 'access' ? policyId : undefined
			});
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}

		return {
			success: `${scope === 'production' ? 'Production' : 'Preview'} access set to ${mode}; agents converge within seconds.`
		};
	},

	updateProject: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const name = formString(data, 'name');
		const slug = formString(data, 'slug');
		const placement = formString(data, 'placement');
		const placementSpecText = formString(data, 'placementSpec');

		const fieldErrors: Record<string, string> = {};
		let placementSpec: ReturnType<typeof placementSpecSchema.parse> | null = null;
		if (placementSpecText) {
			try {
				placementSpec = placementSpecSchema.parse(JSON.parse(placementSpecText));
			} catch (error) {
				fieldErrors.placementSpec =
					error instanceof Error
						? `Placement constraints: ${error.message}`
						: 'Invalid placement constraints.';
			}
		}
		if (!name) fieldErrors.name = 'Give the project a name.';
		else if (name.length > 120) fieldErrors.name = 'Keep the name to 120 characters or fewer.';
		if (slug && !/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(slug)) {
			fieldErrors.slug =
				'Use 3–40 lowercase letters, digits and single hyphens; start and end with a letter or digit.';
		}
		if (Object.keys(fieldErrors).length > 0) {
			return fail(400, { message: 'Check the project details.', fieldErrors });
		}

		try {
			const project = core.projects.requireRow(principal, params.slug);
			const renamed = Boolean(slug && slug !== project.slug);
			await core.projects.update(principal, project.slug, {
				name,
				...(renamed ? { slug } : {}),
				...(placement ? { placement } : {}),
				placementSpec: placementSpecText ? placementSpec : null
			});
			if (renamed) redirect(303, `/projects/${slug}`);
			return { success: 'Project details saved. Agent routes converge within seconds.' };
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	deploy: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const artifact = data.get('artifact');

		if (!artifact || typeof artifact === 'string' || artifact.size === 0) {
			return fail(400, {
				message: 'Choose a .zip archive to deploy.',
				fieldErrors: { artifact: 'Choose a .zip archive containing the built site.' }
			});
		}
		if (!artifact.name.toLowerCase().endsWith('.zip')) {
			return fail(400, {
				message: 'The artifact must be a .zip archive.',
				fieldErrors: { artifact: 'Only .zip archives are accepted.' }
			});
		}

		const environment = formString(data, 'environment') || 'production';
		const message = formOptionalString(data, 'message');
		const promote = formBoolean(data, 'promote');
		if (message && message.length > 500) {
			return fail(400, {
				message: 'Keep the deploy message to 500 characters or fewer.',
				fieldErrors: { message: 'Use 500 characters or fewer.' }
			});
		}

		let entries: ReturnType<typeof entriesFromZip>;
		try {
			entries = entriesFromZip(new Uint8Array(await artifact.arrayBuffer()));
		} catch (caught) {
			return fail(400, {
				message:
					caught instanceof CoreError
						? caught.message
						: 'That file could not be read as a zip archive.',
				fieldErrors: { artifact: 'Upload a valid .zip archive.' }
			});
		}

		try {
			const project = core.projects.requireRow(principal, params.slug);
			const view = await core.deployments.deployEntries(principal, project, entries, {
				promote,
				environment,
				message: message || undefined,
				precompress: true
			});
			return {
				success: `Deployed ${view.shortId} to ${view.environmentName}.`,
				deploymentId: view.id
			};
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	promote: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const id = formString(data, 'deploymentId');
		if (!id) return fail(400, { message: 'Missing deployment id.' });

		try {
			const project = core.projects.requireRow(principal, params.slug);
			await core.deployments.promote(principal, project, id);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}

		return { success: 'Production pointer moved. Traffic switches on the next reconcile.' };
	},

	move: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const node = formString(data, 'node');
		if (!node) return fail(400, { message: 'Choose a node to move to.' });
		try {
			const moved = core.moves.moveApp(principal, params.slug, { node });
			return {
				success: `Moving to ${moved.to.name ?? node}. ${moved.from.name ?? 'The old node'} stops the app and ${moved.to.name ?? 'the target'} starts it on its next reconcile.`
			};
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	rollback: async ({ locals, params }) => {
		const principal = locals.principal!;
		try {
			const project = core.projects.requireRow(principal, params.slug);
			const deployment = await core.deployments.rollback(principal, project);
			return { success: `Rolled back to ${deployment.shortId}.` };
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	pin: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const id = formString(data, 'deploymentId');
		const pinned = formString(data, 'pinned') === 'true';
		if (!id) return fail(400, { message: 'Missing deployment id.' });

		try {
			const project = core.projects.requireRow(principal, params.slug);
			await core.deployments.setPinned(principal, project, id, pinned);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}

		return {
			success: pinned ? 'Deployment pinned; retention will keep it.' : 'Deployment unpinned.'
		};
	},

	deleteDeployment: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const id = formString(data, 'deploymentId');
		if (!id) return fail(400, { message: 'Missing deployment id.' });

		try {
			const project = core.projects.requireRow(principal, params.slug);
			await core.deployments.delete(principal, project, id);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}

		return { success: 'Deployment deleted. Its preview URL stops working on the next reconcile.' };
	},

	createShare: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const expiresRaw = formString(data, 'expiresAt') || formString(data, 'expiresAtLocal');
		const maxRedemptions = formOptionalPositiveInt(data, 'maxRedemptions');
		const note = formOptionalString(data, 'note');
		const deploymentId = formOptionalString(data, 'deploymentId');

		let expiresAt: string | undefined;
		if (expiresRaw) {
			const timestamp = Date.parse(expiresRaw);
			if (!Number.isFinite(timestamp)) {
				return fail(400, {
					message: 'Choose a valid expiry date.',
					fieldErrors: { expiresAt: 'Invalid date and time.' }
				});
			}
			if (timestamp <= Date.now()) {
				return fail(400, {
					message: 'Expiry must be in the future.',
					fieldErrors: { expiresAt: 'Choose a future date.' }
				});
			}
			expiresAt = new Date(timestamp).toISOString();
		}
		if (maxRedemptions === null) {
			return fail(400, {
				message: 'Maximum redemptions must be a positive whole number.',
				fieldErrors: { maxRedemptions: 'Enter a positive whole number.' }
			});
		}

		try {
			const project = core.projects.requireRow(principal, params.slug);
			const share = await core.access.createShareLink(principal, project, {
				deploymentId,
				expiresAt,
				maxRedemptions,
				note
			});
			return {
				success: 'Share link created. Copy it now — the token is shown only once.',
				shareUrl: share.url,
				shareHost: share.host
			};
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	revokeShare: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const id = formString(data, 'shareId');
		if (!id) return fail(400, { message: 'Missing share link id.' });

		try {
			const project = core.projects.requireRow(principal, params.slug);
			await core.access.revokeShareLink(principal, project, id);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}

		return { success: 'Share link revoked. Sessions are pushed to agents within seconds.' };
	},

	revokeSiteSession: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const id = formString(data, 'sessionId');
		if (!id) return fail(400, { message: 'Missing session id.' });

		try {
			const project = core.projects.requireRow(principal, params.slug);
			await core.access.revokeSession(principal, project, id);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}

		return { success: 'Session revoked. Agents refuse its cookie within seconds.' };
	},

	signOutVisitors: async ({ locals, params }) => {
		const principal = locals.principal!;
		try {
			const project = core.projects.requireRow(principal, params.slug);
			await core.access.signOutEveryone(principal, project);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}

		return { success: 'Everyone is signed out. Visitors have to sign in again within seconds.' };
	},

	// --- Environments (D13) -------------------------------------------------

	createEnvironment: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const name = formString(data, 'name');
		const slug = formString(data, 'slug');
		const access = accessMode(formString(data, 'access') || 'platform');
		const password = formRawString(data, 'password');
		const policyId = formString(data, 'policyId');

		if (!name)
			return fail(400, {
				message: 'Give the environment a name.',
				fieldErrors: { name: 'Required.' }
			});
		if (!access)
			return fail(400, {
				message: 'Choose a valid access mode.',
				fieldErrors: { access: 'Invalid access mode.' }
			});
		if (access === 'access' && !policyId)
			return fail(400, {
				message: 'Choose a Yoal Access policy.',
				fieldErrors: { policyId: 'Required for Yoal Access.' }
			});
		if (access === 'password' && password.length < 8)
			return fail(400, {
				message: 'Use at least 8 characters for password mode.',
				fieldErrors: { password: 'At least 8 characters.' }
			});

		try {
			const project = core.projects.requireRow(principal, params.slug);
			const environment = core.environments.create(principal, project, {
				name,
				slug: slug || undefined,
				access,
				...(access === 'password' ? { password } : {}),
				...(access === 'access' ? { policyId } : {})
			});
			return { success: `Environment "${environment.name}" created at ${environment.host}.` };
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	updateEnvironment: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const environmentSlug = formString(data, 'environmentSlug');
		const name = formString(data, 'name');
		const access = accessMode(formString(data, 'access') || 'platform');
		const password = formRawString(data, 'password');
		const policyId = formString(data, 'policyId');

		if (!environmentSlug) return fail(400, { message: 'Missing environment.' });
		if (access === 'access' && !policyId)
			return fail(400, {
				message: 'Choose a Yoal Access policy.',
				fieldErrors: { policyId: 'Required for Yoal Access.' }
			});
		if (access === 'password' && password.length > 0 && password.length < 8)
			return fail(400, {
				message: 'Use at least 8 characters for password mode.',
				fieldErrors: { password: 'At least 8 characters.' }
			});
		if (!name)
			return fail(400, {
				message: 'Give the environment a name.',
				fieldErrors: { name: 'Required.' }
			});
		if (!access)
			return fail(400, {
				message: 'Choose a valid access mode.',
				fieldErrors: { access: 'Invalid access mode.' }
			});

		try {
			const project = core.projects.requireRow(principal, params.slug);
			const environment = core.environments.update(principal, project, environmentSlug, {
				name,
				access,
				...(access === 'password' && password ? { password } : {}),
				...(access === 'access' ? { policyId } : {})
			});
			return { success: `Environment "${environment.name}" updated.` };
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	deleteEnvironment: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const environmentSlug = formString(data, 'environmentSlug');
		if (!environmentSlug) return fail(400, { message: 'Missing environment.' });

		try {
			const project = core.projects.requireRow(principal, params.slug);
			core.environments.remove(principal, project, environmentSlug);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}

		return { success: 'Environment removed. Its host stops serving on the next reconcile.' };
	},

	promoteEnvironment: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const environmentSlug = formString(data, 'environmentSlug');
		const deploymentId = formString(data, 'deploymentId');
		if (!environmentSlug) return fail(400, { message: 'Missing environment.' });
		if (!deploymentId) return fail(400, { message: 'Choose a deployment to promote.' });

		try {
			const project = core.projects.requireRow(principal, params.slug);
			const deployment = await core.environments.promote(
				principal,
				project,
				environmentSlug,
				deploymentId
			);
			return { success: `${deployment.shortId} now serves ${environmentSlug}.` };
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	rollbackEnvironment: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const environmentSlug = formString(data, 'environmentSlug');
		if (!environmentSlug) return fail(400, { message: 'Missing environment.' });

		try {
			const project = core.projects.requireRow(principal, params.slug);
			const deployment = await core.environments.rollback(principal, project, environmentSlug);
			return { success: `Rolled ${environmentSlug} back to ${deployment.shortId}.` };
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	// --- Custom domains (D31) ------------------------------------------------

	addDomain: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const hostname = formString(data, 'hostname');
		const redirectWww = formBoolean(data, 'redirectWww');
		if (!hostname)
			return fail(400, {
				message: 'Enter a hostname to attach.',
				fieldErrors: { hostname: 'Required.' }
			});

		try {
			const project = core.projects.requireRow(principal, params.slug);
			const domain = await core.domains.create(principal, {
				project: project.slug,
				hostname,
				redirectWww
			});
			return {
				success: `${domain.hostname} attached. Add the verification TXT record, then check DNS.`,
				domainId: domain.id
			};
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	checkDomain: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const domainId = formString(data, 'domainId');
		if (!domainId) return fail(400, { message: 'Missing domain id.' });

		try {
			const result = await core.domains.check(principal, domainId);
			return {
				success: result.detail,
				status: result.domain.status,
				records: result.records
			};
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	deleteDomain: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const domainId = formString(data, 'domainId');
		if (!domainId) return fail(400, { message: 'Missing domain id.' });

		try {
			await core.domains.remove(principal, domainId);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}

		return { success: 'Custom domain removed. Managed Cloudflare records were cleaned up.' };
	},

	// --- Git builds (D2, D3) -------------------------------------------------

	saveGitSource: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const repoUrl = formString(data, 'repoUrl');
		const branch = formString(data, 'branch') || 'main';
		const rootDir = formString(data, 'rootDir') || '.';
		const buildCommand = formString(data, 'buildCommand') || 'bun install && bun run build';
		const outputDir = formString(data, 'outputDir') || 'dist';
		const webhookSecret = formRawString(data, 'webhookSecret');
		const enabled = formBoolean(data, 'enabled');

		if (!repoUrl)
			return fail(400, {
				message: 'Enter the repository URL the Builder should clone.',
				fieldErrors: { repoUrl: 'Required.' }
			});
		if (webhookSecret && webhookSecret.length < 16)
			return fail(400, {
				message: 'Webhook secrets need at least 16 characters.',
				fieldErrors: { webhookSecret: 'Use at least 16 characters.' }
			});

		try {
			const project = core.projects.requireRow(principal, params.slug);
			core.builds.upsertGitSource(principal, project, {
				repoUrl,
				branch,
				rootDir,
				buildCommand,
				outputDir,
				...(webhookSecret ? { webhookSecret } : {}),
				enabled
			});
			return { success: 'Git source saved. The Builder reads it when it claims the next job.' };
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	removeGitSource: async ({ locals, params }) => {
		const principal = locals.principal!;
		try {
			const project = core.projects.requireRow(principal, params.slug);
			core.builds.removeGitSource(principal, project);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		return { success: 'Git source removed. Existing builds and deployments are kept.' };
	},

	triggerBuild: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const ref = formOptionalString(data, 'ref');
		const promote = formBoolean(data, 'promote');

		try {
			const project = core.projects.requireRow(principal, params.slug);
			const build = core.builds.enqueue(principal, project, {
				...(ref ? { ref } : {}),
				promote
			});
			return {
				success: `Build ${build.id} queued. A Builder claims it within a few seconds.`
			};
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	cancelBuild: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const buildId = formString(data, 'buildId');
		if (!buildId) return fail(400, { message: 'Missing build id.' });

		try {
			const project = core.projects.requireRow(principal, params.slug);
			core.builds.cancel(principal, project, buildId);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		return { success: 'Build cancelled. The artifact upload was discarded.' };
	},

	buildLog: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const buildId = formString(data, 'buildId');
		if (!buildId) return fail(400, { message: 'Missing build id.' });

		try {
			const project = core.projects.requireRow(principal, params.slug);
			const build = core.builds.get(principal, project, buildId);
			return {
				success: 'Build log loaded.',
				buildId,
				ref: build.ref,
				status: build.status,
				log: build.logTail ?? ''
			};
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	// --- Workload runtime + secrets (D18, D41) -------------------------------

	/** Plan 21: worker ingress and replicas, and a runner pool's labels. */
	saveWorker: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const project = core.projects.requireRow(principal, params.slug);
		if (project.runtime === 'static')
			return fail(400, { message: 'Static projects have no workload to scale.' });
		if (isFunctionTier(project)) return fail(400, { message: FUNCTION_SPEC_MESSAGE });
		const existing = safely(() => core.workloads.projectSpec(project), null);
		if (!existing)
			return fail(400, {
				message: 'Save the runtime configuration first, then choose worker settings.'
			});
		const ingress = formString(data, 'ingress') === 'none' || existing.runner ? 'none' : 'http';
		const input: Record<string, unknown> = {
			...existing,
			ingress,
			replicas: ingress === 'none' ? numberField(data, 'replicas', existing.replicas) : 1
		};
		// A worker has no requests to wake it, so becoming one turns scale to zero off (D121).
		if (ingress === 'none') delete input.idleStopSeconds;
		if (existing.runner) {
			const labels = formString(data, 'labels')
				.split(/[\s,]+/)
				.map((label) => label.trim())
				.filter(Boolean);
			input.runner = { ...existing.runner, labels };
		}
		const parsed = workloadSpecSchema.safeParse(input);
		if (!parsed.success)
			return fail(400, {
				message: parsed.error.issues[0]?.message ?? 'Check the worker settings.',
				fieldErrors: fieldErrorsFrom(parsed.error.issues)
			});
		try {
			core.workloads.setSpec(principal, project, parsed.data);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		return {
			success:
				ingress === 'none'
					? `Worker settings saved: ${parsed.data.replicas} ${parsed.data.replicas === 1 ? 'copy' : 'copies'}, no public route.`
					: 'Worker settings saved. The app gets its route back on the next reconcile.'
		};
	},

	saveWorkload: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const project = core.projects.requireRow(principal, params.slug);
		if (project.runtime === 'static')
			return fail(400, {
				message:
					'Static projects serve files and have no workload. Create a project with runtime "process" or "container" to run an app.'
			});
		// The manifest is a function's spec (FN8); a process-shaped form must never overwrite it.
		if (isFunctionTier(project)) return fail(400, { message: FUNCTION_SPEC_MESSAGE });

		const command = formString(data, 'command');
		const image = formString(data, 'image');
		const dataEnabled = formBoolean(data, 'dataEnabled');
		// Variables are edited on their own tab; the runtime form keeps whatever is saved.
		const current = safely(() => core.workloads.projectSpec(project), null);
		const input: Record<string, unknown> = {
			runtime: project.runtime,
			port: numberField(data, 'port', 3000),
			memoryMb: numberField(data, 'memoryMb', 256),
			cpus: numberField(data, 'cpus', 1),
			healthPath: formString(data, 'healthPath') || '/',
			env: current?.env ?? {},
			secrets: current?.secrets ?? [],
			...(dataEnabled ? { data: { sizeMb: numberField(data, 'dataSizeMb', 256) } } : {})
		};
		if (project.runtime === 'process') {
			if (command) input.command = commandArgs(command);
			// Bun stays implicit (no field), so a Bun spec saves exactly as it did before engines (D125).
			if (formString(data, 'engine') === 'node') input.engine = 'node';
			input.socketActivation = formBoolean(data, 'socketActivation');
			// Scale to zero (D121) needs the socket; without it the field is dropped, not refused.
			const idleStopSeconds = numberField(data, 'idleStopSeconds', 0);
			if (input.socketActivation && idleStopSeconds > 0) input.idleStopSeconds = idleStopSeconds;
		} else {
			input.image = image;
		}
		// Worker settings and a runner profile (plan 21) are edited on the Worker card; this form
		// does not carry them, so keep what the project already has.
		if (current) {
			input.ingress = current.ingress;
			input.replicas = current.replicas;
			if (current.runner) {
				input.runner = current.runner;
				delete input.data;
			}
		}

		const parsed = workloadSpecSchema.safeParse(input);
		if (!parsed.success) {
			return fail(400, {
				message: parsed.error.issues[0]?.message ?? 'Check the runtime settings.',
				fieldErrors: fieldErrorsFrom(parsed.error.issues)
			});
		}

		try {
			core.workloads.setSpec(principal, project, parsed.data);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		return {
			success:
				'Runtime configuration saved. A deployed workload picks it up on the next reconcile; otherwise it applies at the next deployment.'
		};
	},

	restartContainer: async ({ locals, params }) => {
		const principal = locals.principal!;
		try {
			core.containerConsole.restart(principal, params.slug);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		return { success: 'Restart requested. The node restarts the container on its next reconcile.' };
	},

	removeWorkload: async ({ locals, params }) => {
		const principal = locals.principal!;
		try {
			const project = core.projects.requireRow(principal, params.slug);
			core.workloads.remove(principal, project);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		return { success: 'Workload stopped and runtime configuration cleared.' };
	},

	saveVariables: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		let payload: unknown;
		try {
			payload = JSON.parse(formRawString(data, 'variables'));
		} catch {
			return fail(400, { message: 'The variables could not be read. Reload and try again.' });
		}
		const parsed = workloadVariablesSchema.safeParse(payload);
		if (!parsed.success) {
			return fail(400, {
				message: parsed.error.issues[0]?.message ?? 'Check the variables.',
				fieldErrors: fieldErrorsFrom(parsed.error.issues)
			});
		}
		try {
			const project = core.projects.requireRow(principal, params.slug);
			// Replacing a function's secret refs here would drop ones its bindings need (FN8).
			if (isFunctionTier(project)) return fail(400, { message: FUNCTION_SPEC_MESSAGE });
			const workload = await core.workloads.setVariables(principal, project, parsed.data);
			return {
				success: workload
					? 'Variables saved. The app restarts with them on the next reconcile.'
					: 'Variables saved. They apply when the app is next deployed.'
			};
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	// --- Managed databases (D56) ------------------------------------------------

	attachDatabase: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const parsed = databaseAttachSchema.safeParse({
			database: formString(data, 'database'),
			// Empty: the database engine's default prefix (DATABASE, MONGODB or REDIS).
			envPrefix: formString(data, 'envPrefix').toUpperCase() || undefined
		});
		if (!parsed.success) {
			return fail(400, {
				message: parsed.error.issues[0]?.message ?? 'Check the attachment.',
				fieldErrors: fieldErrorsFrom(parsed.error.issues)
			});
		}
		try {
			const project = core.projects.requireRow(principal, params.slug);
			const { attachment, warning } = core.databases.attach(principal, project, parsed.data);
			return {
				success: `${attachment.databaseName} attached as ${attachment.envPrefix}_URL. The app restarts with the new env.`,
				databaseWarning: warning
			};
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	detachDatabase: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const name = formString(await request.formData(), 'database');
		if (!name) return fail(400, { message: 'Missing database name.' });
		try {
			const project = core.projects.requireRow(principal, params.slug);
			core.databases.detach(principal, project, name);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		return { success: `${name} detached. The app restarts without its env.` };
	},

	// --- Managed user pools (IAM.md I28) -----------------------------------------

	attachUserPool: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const parsed = userPoolAttachSchema.safeParse({
			pool: formString(data, 'pool'),
			client: formString(data, 'client'),
			envPrefix: formString(data, 'envPrefix').toUpperCase() || undefined
		});
		if (!parsed.success) {
			return fail(400, {
				message: parsed.error.issues[0]?.message ?? 'Check the attachment.',
				fieldErrors: fieldErrorsFrom(parsed.error.issues)
			});
		}
		try {
			const project = core.projects.requireRow(principal, params.slug);
			const { attachment } = core.userPools.attach(principal, project, parsed.data);
			return {
				success: `${attachment.poolName} attached as ${attachment.envPrefix}_ISSUER, ${attachment.envPrefix}_CLIENT_ID and ${attachment.envPrefix}_CLIENT_SECRET. The app restarts with the new env.`
			};
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	detachUserPool: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const name = formString(await request.formData(), 'pool');
		if (!name) return fail(400, { message: 'Missing user pool name.' });
		try {
			const project = core.projects.requireRow(principal, params.slug);
			core.userPools.detach(principal, project, name);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		return { success: `${name} detached. The app restarts without its pool env.` };
	},

	// --- Managed object storage (S4) ---------------------------------------------

	attachStorage: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const parsed = storageAttachSchema.safeParse({
			storage: formString(data, 'storage'),
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
			const project = core.projects.requireRow(principal, params.slug);
			const { attachment, warning } = core.storage.attach(principal, project, parsed.data);
			return {
				success: `${attachment.storageName} attached as ${attachment.envPrefix}_*. The app restarts with the new env.`,
				storageWarning: warning
			};
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	updateStorageGrants: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const name = formString(data, 'storage');
		if (!name) return fail(400, { message: 'Missing storage name.' });
		const parsed = storageAttachmentUpdateSchema.safeParse({ grants: grantsFromForm(data) });
		if (!parsed.success) {
			return fail(400, {
				message: parsed.error.issues[0]?.message ?? 'Check the grants.',
				fieldErrors: fieldErrorsFrom(parsed.error.issues)
			});
		}
		try {
			const project = core.projects.requireRow(principal, params.slug);
			core.storage.updateAttachment(principal, project, name, parsed.data);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		return { success: `Grants on ${name} saved. The app restarts with its updated key policy.` };
	},

	detachStorage: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const name = formString(await request.formData(), 'storage');
		if (!name) return fail(400, { message: 'Missing storage name.' });
		try {
			const project = core.projects.requireRow(principal, params.slug);
			core.storage.detach(principal, project, name);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		return { success: `${name} detached. Its key is deleted and the app restarts without it.` };
	},

	// --- App volumes (plan 07) -------------------------------------------------

	createVolume: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		// Storage: `system`, `fast` or `bulk` (empty follows the app-volumes default), or `__disk`
		// to name one disk (docs/STORAGE.md §2.2).
		const choice = formString(data, 'storage');
		const storage = choice === '__disk' ? formOptionalString(data, 'disk') : choice || undefined;
		const parsed = appVolumeCreateSchema.safeParse({
			name: formString(data, 'name'),
			sizeMb: numberField(data, 'sizeMb', 1024),
			...(storage ? { storage } : {}),
			singleWriter: formBoolean(data, 'singleWriter')
		});
		if (!parsed.success) {
			return fail(400, {
				message: parsed.error.issues[0]?.message ?? 'Check the volume settings.',
				fieldErrors: fieldErrorsFrom(parsed.error.issues)
			});
		}
		try {
			const project = core.projects.requireRow(principal, params.slug);
			const volume = core.appVolumes.create(principal, project, parsed.data);
			return {
				success: `Volume "${volume.name}" created (${volume.sizeMb} MB). Attach it to a mount path to use it.`
			};
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	attachVolume: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const parsed = appVolumeAttachSchema.safeParse({
			workload: formString(data, 'workload') || params.slug,
			environment: formString(data, 'environment') || 'production',
			mountPath: formString(data, 'mountPath'),
			readOnly: formBoolean(data, 'readOnly')
		});
		if (!parsed.success) {
			return fail(400, {
				message: parsed.error.issues[0]?.message ?? 'Check the mount path.',
				fieldErrors: fieldErrorsFrom(parsed.error.issues)
			});
		}
		const volumeName = formString(data, 'volume');
		try {
			const project = core.projects.requireRow(principal, params.slug);
			core.appVolumes.attach(principal, project, volumeName, parsed.data);
			return {
				success: `Volume "${volumeName}" mounted at ${parsed.data.mountPath}; the workload restarts with it.`
			};
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	detachVolume: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const volumeName = formString(data, 'volume');
		const parsed = appVolumeDetachSchema.safeParse({
			workload: formString(data, 'workload') || params.slug,
			environment: formString(data, 'environment') || 'production'
		});
		if (!parsed.success)
			return fail(400, { message: parsed.error.issues[0]?.message ?? 'Check the attachment.' });
		try {
			const project = core.projects.requireRow(principal, params.slug);
			core.appVolumes.detach(principal, project, volumeName, parsed.data);
			return { success: `Volume "${volumeName}" detached. The data is untouched.` };
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	deleteVolume: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const volumeName = formString(await request.formData(), 'volume');
		try {
			const project = core.projects.requireRow(principal, params.slug);
			const result = core.appVolumes.delete(principal, project, volumeName);
			return {
				success: `Volume "${volumeName}" deleted. Its data is kept until ${new Date(result.purgeAt).toISOString().slice(0, 10)}.`
			};
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	snapshotVolume: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const volumeName = formString(data, 'volume');
		const label = formOptionalString(data, 'label');
		const parsed = appVolumeSnapshotCreateSchema.safeParse({
			...(label ? { label } : {}),
			// The checkbox is "copy without pausing"; quiescing is the default.
			quiesce: !formBoolean(data, 'live')
		});
		if (!parsed.success)
			return fail(400, {
				message: parsed.error.issues[0]?.message ?? 'Check the snapshot settings.',
				fieldErrors: fieldErrorsFrom(parsed.error.issues)
			});
		try {
			const project = core.projects.requireRow(principal, params.slug);
			const snapshot = core.appVolumes.lifecycle.createSnapshot(principal, project, volumeName, parsed.data);
			return {
				success: `Snapshot of "${volumeName}" queued to ${snapshot.target?.name ?? 'the platform object store'}.${
					snapshot.quiesce ? '' : ' The app is not paused, so the copy may be inconsistent.'
				}`
			};
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	restoreVolumeSnapshot: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const volumeName = formString(data, 'volume');
		const snapshotId = formString(data, 'snapshotId');
		const sizeMb = formOptionalString(data, 'sizeMb');
		const parsed = appVolumeRestoreSchema.safeParse({
			name: formString(data, 'name'),
			...(sizeMb ? { sizeMb: numberField(data, 'sizeMb', 0) } : {})
		});
		if (!parsed.success)
			return fail(400, {
				message: parsed.error.issues[0]?.message ?? 'Check the new volume name.',
				fieldErrors: fieldErrorsFrom(parsed.error.issues)
			});
		try {
			const project = core.projects.requireRow(principal, params.slug);
			const volume = core.appVolumes.lifecycle.restore(principal, project, volumeName, snapshotId, parsed.data);
			return {
				success: `Restoring into new volume "${volume.name}". Mount it once the restore finishes.`
			};
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	deleteVolumeSnapshot: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const volumeName = formString(data, 'volume');
		const snapshotId = formString(data, 'snapshotId');
		try {
			const project = core.projects.requireRow(principal, params.slug);
			await core.appVolumes.lifecycle.deleteSnapshot(principal, project, volumeName, snapshotId);
			return { success: `Snapshot ${snapshotId} deleted.` };
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	deleteSecret: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const secretId = formString(data, 'secretId');
		if (!secretId) return fail(400, { message: 'Missing secret id.' });

		try {
			await core.secrets.delete(principal, secretId);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		return {
			success:
				'Secret deleted. Running workloads keep the value they activated with until they restart.'
		};
	},

	// --- App errors (docs/APP-ERRORS.md) -------------------------------------------------------

	enableAppErrors: async ({ locals, params }) => {
		const principal = locals.principal!;
		try {
			const project = core.projects.requireRow(principal, params.slug);
			core.appErrors.enable(principal, project);
			return { success: 'Error tracking is on. Copy the DSN or the snippet into the app.' };
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	disableAppErrors: async ({ locals, params }) => {
		const principal = locals.principal!;
		try {
			const project = core.projects.requireRow(principal, params.slug);
			core.appErrors.updateSettings(principal, project, { enabled: false });
			return { success: 'Error tracking is off. Existing issues are kept until you delete them.' };
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	updateAppErrorSettings: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const sampleRateText = formString(data, 'sampleRate');
		const sampleRate = sampleRateText ? Number(sampleRateText) : undefined;
		try {
			const project = core.projects.requireRow(principal, params.slug);
			core.appErrors.updateSettings(principal, project, {
				...(sampleRate === undefined ? {} : { sampleRate }),
				notify: formBoolean(data, 'notify')
			});
			return { success: 'Error tracking settings saved.' };
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	rotateAppErrorKey: async ({ locals, params }) => {
		const principal = locals.principal!;
		try {
			const project = core.projects.requireRow(principal, params.slug);
			core.appErrors.rotateKey(principal, project);
			return { success: 'New key created. The old key works for another 24 hours.' };
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	updateAppErrorStatus: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const ids = formString(data, 'ids')
			.split(',')
			.map((id) => id.trim())
			.filter(Boolean);
		const status = formString(data, 'status');
		if (ids.length === 0) return fail(400, { message: 'Missing the issue ids.' });
		if (status !== 'unresolved' && status !== 'resolved' && status !== 'ignored')
			return fail(400, { message: 'Choose unresolved, resolved or ignored.' });
		try {
			const project = core.projects.requireRow(principal, params.slug);
			const changed = core.appErrors.setStatus(principal, project, { ids, status });
			return { success: `${changed} issue${changed === 1 ? '' : 's'} updated.` };
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	deleteAppErrorIssue: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const issueId = formString(data, 'issueId');
		if (!issueId) return fail(400, { message: 'Missing the issue id.' });
		try {
			const project = core.projects.requireRow(principal, params.slug);
			core.appErrors.deleteIssue(principal, project, issueId);
			return { success: 'Issue deleted.' };
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	deleteAllAppErrors: async ({ locals, params }) => {
		const principal = locals.principal!;
		try {
			const project = core.projects.requireRow(principal, params.slug);
			const count = core.appErrors.deleteAll(principal, project);
			return { success: `Deleted ${count} issue${count === 1 ? '' : 's'} and their events.` };
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	testAppError: async ({ locals, params }) => {
		const principal = locals.principal!;
		try {
			const project = core.projects.requireRow(principal, params.slug);
			const result = core.appErrors.testEvent(principal, project);
			return { success: `Test event sent (issue ${result.issueId}).` };
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	}

};
