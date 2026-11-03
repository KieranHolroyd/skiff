import { parseArgs, rejectExtraPositionals, requirePositional, type FlagSpec } from '../args.ts';
import { openExternal } from '../browser.ts';
import { CliError } from '../errors.ts';
import { printJson } from '../output.ts';
import { authenticatedContext, deploymentUrl } from './common.ts';

const flags: FlagSpec = {
	preview: { type: 'boolean' },
	json: { type: 'boolean' },
	help: { type: 'boolean', short: 'h' },
};

const usage = `Usage: skif open <project> [--preview] [--json]

Open the production site (or the latest preview with --preview) in your browser.
Preview URLs are built from the configured contentDomain when the API omits them.`;

export async function openCommand(argv: string[]): Promise<void> {
	const args = parseArgs(argv, flags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 1, usage);
	const projectSlug = requirePositional(args, 0, 'project slug');
	const { client, config } = await authenticatedContext();
	const { project } = await client.getProject(projectSlug);

	let url: string | undefined;
	if (args.boolean('preview')) {
		const { deployments } = await client.listDeployments(projectSlug);
		url = deployments
			.map((deployment) => deploymentUrl(projectSlug, deployment, config.contentDomain))
			.find((candidate): candidate is string => Boolean(candidate));
		if (!url) throw new CliError(`No preview deployments for ${projectSlug}.`, { code: 'not_found' });
	} else {
		url = project.productionUrl;
		if (!url && project.productionDeploymentId) {
			const { deployments } = await client.listDeployments(projectSlug);
			const production = deployments.find(
				(deployment) => deployment.id === project.productionDeploymentId,
			);
			if (production) url = deploymentUrl(projectSlug, production, config.contentDomain);
		}
		if (!url)
			throw new CliError(`Project ${projectSlug} has no production deployment yet.`, {
				code: 'not_found',
			});
	}

	const opened = await openExternal(url);
	if (args.boolean('json')) {
		printJson({ project: projectSlug, url, opened });
		return;
	}
	if (opened) {
		console.log(`Opening ${url}`);
	} else {
		console.log(url);
		console.error('Could not launch a browser automatically.');
	}
}
