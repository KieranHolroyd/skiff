import { ApiClient, type DeploymentView, type FinalizeOutcome } from '../api.ts';
import { resolveConfig, type ResolvedConfig } from '../config.ts';
import { UsageError } from '../errors.ts';
import { formatTime, indent, renderTable, truncate } from '../output.ts';

export async function authenticatedContext(): Promise<{
	client: ApiClient;
	config: ResolvedConfig;
}> {
	const config = await resolveConfig();
	const client = new ApiClient({
		baseUrl: config.url,
		token: config.token,
		origin: config.origin,
		userAgent: 'skif-cli',
	});
	return { client, config };
}

export async function authenticatedClient(): Promise<ApiClient> {
	return (await authenticatedContext()).client;
}

/** Build a deployment URL from `<slug>--<id>.<contentDomain>` when the API omits it (D14). */
export function deploymentUrl(
	projectSlug: string,
	deployment: DeploymentView,
	contentDomain: string | undefined,
): string | undefined {
	if (deployment.previewUrl) return deployment.previewUrl;
	const id = deployment.shortId ?? deployment.id;
	if (!id || !contentDomain) return undefined;
	return `https://${projectSlug}--${id}.${contentDomain}`;
}

/** Same shape as the server's slug derivation (DESIGN §5.1): lowercase, single hyphens. */
export function slugifyProjectName(value: string): string {
	let slug = value
		.normalize('NFKD')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 40)
		.replace(/-+$/g, '');
	if (!slug) slug = 'site';
	if (slug.length < 3) slug = `site-${slug}`.slice(0, 40).replace(/-+$/g, '');
	return slug;
}

export function assertProjectSlug(slug: string): void {
	if (!/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(slug) || slug.includes('--'))
		throw new UsageError(
			`"${slug}" is not a valid project slug. Use 3-40 lowercase letters, digits and single hyphens.`,
		);
}

export function printProgress(message: string): void {
	process.stderr.write(`${message}\n`);
}

export function printOutcome(outcome: FinalizeOutcome, projectSlug: string): void {
	const deployment = outcome.deployment;
	const slug = outcome.project?.slug ?? projectSlug;
	const preview = outcome.previewUrl ?? deployment?.previewUrl;
	const production = outcome.productionUrl ?? outcome.project?.productionUrl;
	const deploymentUrl = outcome.deploymentUrl ?? deployment?.url;

	console.log(`Project     ${slug}`);
	if (deployment?.id) console.log(`Deployment  ${deployment.id}`);
	if (deploymentUrl && deploymentUrl !== preview && deploymentUrl !== production)
		console.log(`URL         ${deploymentUrl}`);
	if (preview) console.log(`Preview     ${preview}`);
	if (production)
		console.log(`Production  ${production}${outcome.promoted ? '  (promoted)' : '  (unchanged)'}`);
	if (deployment?.message) console.log(`Message     ${deployment.message}`);

	const nextSteps =
		outcome.nextSteps.length > 0
			? outcome.nextSteps
			: outcome.promoted
				? [
						`Roll back:   skif rollback ${slug}`,
						`View logs:   skif logs ${slug}`,
						`Open:        skif open ${slug}`,
					]
				: [
						`Preview:     ${preview ?? 'see the deployment in the dashboard'}`,
						`Promote:     skif promote ${slug} ${deployment?.id ?? '<deployment-id>'}`,
					];
	if (nextSteps.length > 0) console.log(`\nNext steps:\n${indent(nextSteps)}`);
}

export function deploymentTable(deployments: DeploymentView[], productionId?: string | null): string {
	if (deployments.length === 0) return 'No deployments yet.';
	const rows = deployments.map((deployment) => [
		`${deployment.id ?? deployment.shortId ?? '-'}${
			deployment.production || (productionId && deployment.id === productionId) ? ' *' : ''
		}`,
		deployment.status ?? '-',
		truncate(deployment.message ?? '-', 40),
		formatTime(deployment.createdAt),
		deployment.previewUrl ?? '-',
	]);
	return `${renderTable(['ID', 'STATUS', 'MESSAGE', 'CREATED', 'PREVIEW'], rows)}\n\n* current production deployment`;
}
