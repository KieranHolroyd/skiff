/**
 * The documentation's information architecture: sections in reading order, each listing its
 * pages by slug. A slug is the page's path under `content/` without `.md`. Every content file must
 * appear here exactly once, and every slug here must have a file (enforced by the tests).
 *
 * `icon` is a hint for renderers that show one (the dashboard maps it to a Lucide icon); the
 * standalone site ignores it.
 */

export interface DocsSection {
	id: string;
	title: string;
	icon: string;
	pages: string[];
}

export const SECTIONS: DocsSection[] = [
	{
		id: 'getting-started',
		title: 'Getting started',
		icon: 'rocket',
		pages: [
			'getting-started/introduction',
			'getting-started/quickstart',
			'getting-started/concepts'
		]
	},
	{
		id: 'deploying',
		title: 'Deploying',
		icon: 'upload',
		pages: [
			'deploying/static-sites',
			'deploying/site-config',
			'deploying/access-and-sharing',
			'deploying/domains-and-environments',
			'deploying/git-builds',
			'deploying/pipelines'
		]
	},
	{
		id: 'compute',
		title: 'Compute',
		icon: 'cpu',
		pages: [
			'compute/functions',
			'compute/apps-and-containers',
			'compute/volumes',
			'compute/scheduled-jobs'
		]
	},
	{
		id: 'data',
		title: 'Data services',
		icon: 'database',
		pages: [
			'data/databases',
			'data/database-studio',
			'data/backups-and-pitr',
			'data/object-storage',
			'data/brokers-and-events',
			'data/email'
		]
	},
	{
		id: 'observe',
		title: 'Observe',
		icon: 'chart',
		pages: ['observe/dashboards-and-logs', 'observe/metrics', 'observe/alerts']
	},
	{
		id: 'clients',
		title: 'CLI, API & agents',
		icon: 'terminal',
		pages: ['clients/cli', 'clients/rest-api', 'clients/mcp', 'clients/assistant']
	},
	{
		id: 'accounts',
		title: 'Accounts & security',
		icon: 'shield',
		pages: [
			'accounts/sign-in-and-2fa',
			'accounts/organizations-and-roles',
			'accounts/api-keys-and-tokens',
			'accounts/security-model'
		]
	},
	{
		id: 'self-hosting',
		title: 'Self-hosting',
		icon: 'server',
		pages: [
			'self-hosting/installation',
			'self-hosting/configuration',
			'self-hosting/nodes-and-fleet',
			'self-hosting/clustering',
			'self-hosting/platform-backups',
			'self-hosting/upgrades',
			'self-hosting/quotas-and-limits',
			'self-hosting/troubleshooting'
		]
	}
];

export const ALL_SLUGS: string[] = SECTIONS.flatMap((section) => section.pages);

/** The page a bare `/docs` opens. */
export const HOME_SLUG = 'getting-started/introduction';
