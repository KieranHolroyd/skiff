import { fail, redirect } from '@sveltejs/kit';
import { githubImportSchema, hasPermission, parseGithubRepoUrl } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { fieldErrorsFrom } from '../../databases/_lib/forms.server.js';
import { failStatus, formString, toFormFailure } from '../../_lib/errors.js';
import type { Actions, PageServerLoad } from './$types';

/**
 * Deploy from GitHub (docs/GITHUB.md §9): pick a repository the org's GitHub App reaches, adjust
 * the detected build settings, deploy. The repository list and detection are fetched by the page
 * (`/api/v1/github/repositories`, `/api/v1/github/detect`); the import is a form action.
 */
export const load: PageServerLoad = ({ locals, url }) => {
	const principal = locals.principal!;
	const app = core.githubApp.view(principal);
	let connected = false;
	try {
		connected = core.githubApp
			.installations(principal)
			.some((entry) => entry.orgId === principal.orgId && !entry.suspended);
	} catch {
		// No build:read: the page explains below.
	}
	// Repositories that already deploy a project, so the list can say where they went.
	const imported: Record<string, string> = {};
	for (const project of core.projects.list(principal)) {
		try {
			const source = core.builds.gitSource(
				principal,
				core.projects.requireRow(principal, project.slug)
			);
			const parsed = source ? parseGithubRepoUrl(source.repoUrl) : null;
			if (parsed) imported[`${parsed.owner}/${parsed.repo}`.toLowerCase()] ??= project.slug;
		} catch {
			// A project the viewer cannot read builds of is simply not marked.
		}
	}
	const repo = url.searchParams.get('repo');
	return {
		app: {
			configured: app.configured,
			installUrl: app.configured ? core.githubApp.installUrl(principal) : null
		},
		connected,
		canInstall:
			principal.kind === 'user' && (principal.role === 'owner' || principal.role === 'admin'),
		canImport:
			hasPermission(principal, 'project:create') && hasPermission(principal, 'build:create'),
		repo: repo && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ? repo : null,
		imported
	};
};

function lines(value: string): Record<string, string> | undefined {
	const env: Record<string, string> = {};
	for (const raw of value.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) continue;
		const at = line.indexOf('=');
		if (at <= 0) continue;
		env[line.slice(0, at).trim()] = line.slice(at + 1);
	}
	return Object.keys(env).length ? env : undefined;
}

export const actions: Actions = {
	import: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const runtime = formString(data, 'runtime') === 'process' ? 'process' : 'static';
		const values = {
			repository: formString(data, 'repository'),
			branch: formString(data, 'branch'),
			name: formString(data, 'name'),
			slug: formString(data, 'slug'),
			framework: formString(data, 'framework'),
			runtime,
			rootDir: formString(data, 'rootDir') || '.',
			buildCommand: formString(data, 'buildCommand'),
			outputDir: formString(data, 'outputDir') || '.',
			command: formString(data, 'command'),
			engine: formString(data, 'engine'),
			port: formString(data, 'port'),
			env: String(data.get('env') ?? ''),
			productionAccess: formString(data, 'productionAccess') || 'public',
			previewAccess: formString(data, 'previewAccess') || 'platform',
			pipelines: data.get('pipelines') !== null
		};
		const command = values.command.split(/\s+/).filter(Boolean);
		const parsed = githubImportSchema.safeParse({
			repository: values.repository,
			branch: values.branch || undefined,
			name: values.name || undefined,
			slug: values.slug || undefined,
			framework: values.framework || undefined,
			runtime,
			rootDir: values.rootDir,
			buildCommand: values.buildCommand,
			outputDir: values.outputDir,
			...(runtime === 'process'
				? {
						command: command.length ? command : undefined,
						engine: values.engine === 'node' ? 'node' : values.engine === 'bun' ? 'bun' : undefined,
						port: values.port ? Number(values.port) : undefined,
						env: lines(values.env)
					}
				: {}),
			productionAccess: values.productionAccess,
			previewAccess: values.previewAccess,
			pipelines: values.pipelines
		});
		if (!parsed.success)
			return fail(400, {
				message: 'Check the highlighted fields.',
				fieldErrors: fieldErrorsFrom(parsed.error.issues),
				values
			});
		let slug: string;
		try {
			const result = await core.githubImport.importRepository(principal, parsed.data);
			slug = result.project.slug;
		} catch (error) {
			return fail(failStatus(error), { ...toFormFailure(error), values });
		}
		redirect(303, `/projects/${encodeURIComponent(slug)}?tab=builds`);
	}
};
