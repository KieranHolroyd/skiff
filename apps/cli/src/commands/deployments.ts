import { parseArgs, rejectExtraPositionals, requirePositional, type FlagSpec } from '../args.ts';
import { printJson } from '../output.ts';
import { authenticatedClient, deploymentTable } from './common.ts';

const flags: FlagSpec = {
	json: { type: 'boolean' },
	help: { type: 'boolean', short: 'h' },
};

const usage = 'Usage: skif deployments <project> [--json]\n\nList a project\'s deployments, newest first.';

export async function deploymentsCommand(argv: string[]): Promise<void> {
	const args = parseArgs(argv, flags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 1, usage);
	const projectSlug = requirePositional(args, 0, 'project slug');

	const client = await authenticatedClient();
	const [{ project, raw: projectRaw }, { deployments, raw: deploymentsRaw }] = await Promise.all([
		client.getProject(projectSlug),
		client.listDeployments(projectSlug),
	]);

	if (args.boolean('json')) {
		printJson({ project: projectRaw, deployments: deploymentsRaw });
		return;
	}

	console.log(`Project     ${project.slug}`);
	if (project.productionUrl) console.log(`URL         ${project.productionUrl}`);
	console.log(`Production  ${project.productionDeploymentId ?? 'none'}`);
	console.log('');
	console.log(deploymentTable(deployments, project.productionDeploymentId));
}
