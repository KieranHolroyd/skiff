import { parseArgs, rejectExtraPositionals, type FlagSpec } from '../args.ts';
import { formatTime, printJson, renderTable } from '../output.ts';
import { authenticatedClient } from './common.ts';

const flags: FlagSpec = {
	json: { type: 'boolean' },
	help: { type: 'boolean', short: 'h' },
};

export async function projectsCommand(argv: string[]): Promise<void> {
	const args = parseArgs(argv, flags);
	if (args.boolean('help')) {
		console.log('Usage: skif projects [--json]\n\nList projects and their production URLs.');
		return;
	}
	rejectExtraPositionals(args, 0, 'Usage: skif projects [--json]');

	const client = await authenticatedClient();
	const { projects, raw } = await client.listProjects();
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	if (projects.length === 0) {
		console.log('No projects yet. Deploy one with `skif deploy`.');
		return;
	}
	const rows = projects.map((project) => [
		project.slug,
		project.name ?? '-',
		project.productionUrl ?? '-',
		`${project.productionAccess ?? '-'} / ${project.previewAccess ?? '-'}`,
		formatTime(project.createdAt),
	]);
	console.log(renderTable(['SLUG', 'NAME', 'PRODUCTION URL', 'ACCESS (PROD/PREVIEW)', 'CREATED'], rows));
}
