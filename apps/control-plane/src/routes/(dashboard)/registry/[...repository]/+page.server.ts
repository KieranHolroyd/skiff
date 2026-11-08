import { error, fail } from '@sveltejs/kit';
import { hasPermission, type RegistryTagView } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { CoreError } from '@skiff/core';
import type { Actions, PageServerLoad } from './$types';

/** One registry repository: its tags, the deployments pinning it, deploy on push (docs/REGISTRY.md). */
export const load: PageServerLoad = async ({ locals, params }) => {
	const principal = locals.principal!;
	if (!hasPermission(principal, 'image:pull'))
		error(403, 'You need permission to pull images to see this repository.');
	const registry = core.registry.view(principal);
	if (!registry.enabled) error(404, 'The registry is off.');
	let repository;
	try {
		repository = core.registry.repository(principal, params.repository);
	} catch (cause) {
		if (cause instanceof CoreError)
			error(
				cause.status,
				cause.status === 404 ? `No repository ${params.repository}.` : cause.message
			);
		throw cause;
	}
	let tags: RegistryTagView[] = [];
	let tagsError: string | null = null;
	try {
		tags = await core.registry.tags(principal, repository.name);
	} catch (cause) {
		tagsError = (cause as Error).message;
	}
	const canDeploy = hasPermission(principal, 'deployment:create');
	const canAutoDeploy = canDeploy && hasPermission(principal, 'image:push');
	return {
		registry,
		repository,
		tags,
		tagsError,
		pins: core.registry.pins(principal, repository.name),
		canDeploy,
		canAutoDeploy,
		canDeleteTags: hasPermission(principal, 'image:delete'),
		/** Container projects a tag can deploy to. */
		containerProjects: canDeploy
			? core.projects
					.list(principal)
					.filter((project) => project.runtime === 'container')
					.map((project) => ({ slug: project.slug, name: project.name }))
			: []
	};
};

function string(data: FormData, name: string): string {
	return String(data.get(name) ?? '').trim();
}

export const actions: Actions = {
	autodeploy: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const project = data.get('off') === '1' ? null : string(data, 'project') || null;
		const tag = string(data, 'tag') || 'latest';
		try {
			core.registry.setAutoDeploy(principal, params.repository, {
				project,
				...(project ? { tag } : {})
			});
			return {
				success: project
					? `Every push of ${params.repository}:${tag} now deploys to ${project}.`
					: `Deploy on push is off for ${params.repository}.`
			};
		} catch (cause) {
			return fail(400, { message: (cause as Error).message });
		}
	},

	deploy: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const tag = string(data, 'tag');
		try {
			const project = core.projects.requireRow(principal, string(data, 'project'));
			const deployment = await core.deployments.deployImage(principal, project, {
				image: `${core.registry.view(principal).host}/${params.repository}:${tag}`,
				promote: data.get('promote') === 'on',
				message: `Deployed ${params.repository}:${tag} from the registry`
			});
			return {
				success: `Deploying ${params.repository}:${tag} to ${project.slug} (${deployment.shortId}).`
			};
		} catch (cause) {
			return fail(400, { message: (cause as Error).message });
		}
	},

	untag: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const tag = string(await request.formData(), 'tag');
		try {
			await core.registry.deleteTag(principal, params.repository, tag);
			return { success: `Deleted ${params.repository}:${tag}.` };
		} catch (cause) {
			return fail(400, { message: (cause as Error).message });
		}
	}
};
