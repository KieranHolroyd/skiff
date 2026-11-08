import * as z from 'zod';

/**
 * Git providers other than GitHub's App: GitLab, Gitea and Forgejo (docs/FORGES.md, D173–D178).
 *
 * An organisation connects a forge with its base URL and an API token. Skiff then does with that
 * token what the GitHub App does on GitHub: lists repositories for pickers, creates the webhooks
 * itself, clones private repositories with the narrowest credential the forge offers, posts commit
 * statuses (and GitLab deployments), and reads files for Deploy from Git.
 */

export const forgeKinds = ['gitlab', 'gitea', 'forgejo'] as const;
export type ForgeKind = (typeof forgeKinds)[number];

/** Every provider a repository can come from; `generic` is any other git server. */
export const gitProviderKinds = ['github', 'gitlab', 'gitea', 'forgejo', 'generic'] as const;
export type GitProviderKind = (typeof gitProviderKinds)[number];

export const FORGE_LABELS: Record<GitProviderKind, string> = {
	github: 'GitHub',
	gitlab: 'GitLab',
	gitea: 'Gitea',
	forgejo: 'Forgejo',
	generic: 'Git',
};

/** Hosted instances offered as presets in the connection form. */
export const FORGE_PRESETS: Record<ForgeKind, { baseUrl: string; label: string }> = {
	gitlab: { baseUrl: 'https://gitlab.com', label: 'gitlab.com' },
	gitea: { baseUrl: 'https://gitea.com', label: 'gitea.com' },
	forgejo: { baseUrl: 'https://codeberg.org', label: 'Codeberg' },
};

/** What each token needs, shown beside the form. */
export const FORGE_TOKEN_HELP: Record<ForgeKind, { api: string; clone: string; tokenPage: string }> = {
	gitlab: {
		api: 'A group or project access token (role Maintainer, scope api) or a personal access token with the api scope. Maintainer lets Skiff mint per-repository deploy tokens for clones.',
		clone: 'Optional. A token with read_repository only, used for clones when Skiff cannot mint a deploy token.',
		tokenPage: '/-/user_settings/personal_access_tokens',
	},
	gitea: {
		api: 'An access token with write:repository and read:user (add write:organization to create organisation webhooks).',
		clone: 'Optional. A token with read:repository only, ideally of a bot account that can read just the repositories Skiff builds. Build nodes receive it.',
		tokenPage: '/user/settings/applications',
	},
	forgejo: {
		api: 'An access token with write:repository and read:user (add write:organization to create organisation webhooks).',
		clone: 'Optional. A token with read:repository only, ideally of a bot account that can read just the repositories Skiff builds. Build nodes receive it.',
		tokenPage: '/user/settings/applications',
	},
};

// ------------------------------------------------------------------------------- repository URLs

export interface ParsedRepoUrl {
	/** Lower-case host, with a port when one is given (`git.example.com:8443`). */
	host: string;
	/** Path without leading slash or `.git`: `acme/app`, `group/sub/app`, `gitea/acme/app`. */
	path: string;
}

/**
 * `https://host[:port]/a/b(.git)`, `git@host:a/b.git` or `ssh://git@host[:port]/a/b.git` → host and
 * path. Null for anything else (local paths, `git://`, URLs with fewer than two path segments).
 */
export function parseRepoUrl(url: string): ParsedRepoUrl | null {
	const value = url.trim();
	let host: string;
	let path: string;
	const scp = /^[A-Za-z0-9._-]+@([^/:\s]+):(?!\/)(.+)$/.exec(value);
	if (scp) {
		host = scp[1]!;
		path = scp[2]!;
	} else {
		let parsed: URL;
		try {
			parsed = new URL(value);
		} catch {
			return null;
		}
		if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:' && parsed.protocol !== 'ssh:') return null;
		if (parsed.search || parsed.hash) return null;
		// SSH ports are not HTTP ports: an ssh URL's port never names the web instance.
		host = parsed.protocol === 'ssh:' ? parsed.hostname : parsed.host;
		path = decodeURIComponent(parsed.pathname);
	}
	path = path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
	const segments = path.split('/');
	if (segments.length < 2 || segments.some((segment) => !/^[A-Za-z0-9_.~-]+$/.test(segment) || segment === '.' || segment === '..'))
		return null;
	return { host: host.toLowerCase(), path };
}

/** `host/path`, lower case: the key repositories are matched by across providers. */
export function repoKey(url: string): string | null {
	const parsed = parseRepoUrl(url);
	return parsed ? `${parsed.host}/${parsed.path}`.toLowerCase() : null;
}

/** The key of a GitHub `owner/repo`. */
export function githubRepoKey(fullName: string): string {
	return `github.com/${fullName}`.toLowerCase();
}

/** A connection's base URL as host + path prefix (`git.example.com/gitea`). */
export function forgeBaseKey(baseUrl: string): string | null {
	try {
		const url = new URL(baseUrl);
		if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
		const path = url.pathname.replace(/\/+$/, '');
		return `${url.host}${path}`.toLowerCase();
	} catch {
		return null;
	}
}

/**
 * The repository's full name relative to a connection (`group/sub/app`), or null when the URL is
 * not on that connection. SSH URLs match on host alone; their path never carries the base path.
 */
export function forgeFullName(baseUrl: string, repoUrl: string): string | null {
	const parsed = parseRepoUrl(repoUrl);
	const base = forgeBaseKey(baseUrl);
	if (!parsed || !base) return null;
	const [baseHost, ...baseSegments] = base.split('/');
	const baseHostname = baseHost!.replace(/:\d+$/, '');
	const isHttp = /^https?:\/\//i.test(repoUrl.trim());
	const hostMatches = isHttp ? parsed.host === baseHost : parsed.host.replace(/:\d+$/, '') === baseHostname;
	if (!hostMatches) return null;
	const segments = parsed.path.split('/');
	if (isHttp && baseSegments.length) {
		const prefix = segments.slice(0, baseSegments.length).map((segment) => segment.toLowerCase());
		if (prefix.join('/') !== baseSegments.join('/')) return null;
		const rest = segments.slice(baseSegments.length);
		return rest.length >= 2 ? rest.join('/') : null;
	}
	return segments.join('/');
}

// --------------------------------------------------------------------------------- connections

const baseUrlSchema = z
	.string()
	.trim()
	.max(512)
	.transform((value) => value.replace(/\/+$/, ''))
	.refine((value) => {
		try {
			const url = new URL(value);
			return (url.protocol === 'https:' || url.protocol === 'http:') && !url.search && !url.hash && !url.username && !url.password;
		} catch {
			return false;
		}
	}, 'Enter the instance URL, e.g. https://gitlab.com or https://git.example.com');

const tokenSchema = z.string().trim().min(8, 'Paste the whole token.').max(512);

export const forgeConnectionCreateSchema = z.object({
	kind: z.enum(forgeKinds),
	baseUrl: baseUrlSchema,
	/** Shown in pickers; defaults to the instance host. */
	name: z.string().trim().max(80).optional().transform((value) => value || undefined),
	token: tokenSchema,
	cloneToken: tokenSchema.optional().or(z.literal('').transform(() => undefined)),
});
export type ForgeConnectionCreate = z.input<typeof forgeConnectionCreateSchema>;

export const forgeConnectionUpdateSchema = z.object({
	name: z.string().trim().max(80).optional(),
	token: tokenSchema.optional(),
	/** Explicit null removes the clone token. */
	cloneToken: tokenSchema.nullable().optional(),
});
export type ForgeConnectionUpdate = z.input<typeof forgeConnectionUpdateSchema>;

export const forgeWebhookCreateSchema = z
	.object({
		/** Full name on the connection (`group/app`) or a clone URL. */
		repository: z.string().trim().min(3).max(512).optional(),
		/** A GitLab group (`acme` or `acme/platform`) or Gitea/Forgejo organisation. */
		namespace: z.string().trim().min(1).max(255).optional(),
	})
	.refine((value) => Boolean(value.repository) !== Boolean(value.namespace), 'Name a repository or a namespace, not both.');
export type ForgeWebhookCreate = z.input<typeof forgeWebhookCreateSchema>;

export interface ForgeWebhookView {
	id: string;
	scope: 'repository' | 'namespace';
	/** Full name of the repository, or the namespace path. */
	path: string;
	/** The forge's hook id; null while creating it failed. */
	hookId: string | null;
	error: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface ForgeConnectionView {
	id: string;
	kind: ForgeKind;
	name: string;
	baseUrl: string;
	/** The account the API token belongs to. */
	accountLogin: string | null;
	hasCloneToken: boolean;
	/** The account the clone token belongs to. */
	cloneLogin: string | null;
	/** Absolute URL of this connection's webhook receiver. */
	webhookUrl: string;
	webhooks: ForgeWebhookView[];
	createdAt: string;
	updatedAt: string;
}

// -------------------------------------------------------------------------------- repositories

/** One repository from any provider, for pickers. */
export interface GitRepositoryView {
	provider: Exclude<GitProviderKind, 'generic'>;
	/** The forge connection it came through; null for the GitHub App. */
	connectionId: string | null;
	/** `owner/name` (`group/sub/name` on GitLab). */
	fullName: string;
	owner: string;
	name: string;
	private: boolean;
	archived: boolean;
	defaultBranch: string;
	cloneUrl: string;
	htmlUrl: string;
	pushedAt: string | null;
	/** `host/full name`, lower case. */
	key: string;
}

export interface GitRepositoryList {
	repositories: GitRepositoryView[];
	/** Providers that could not be asked, with the reason. */
	errors: Array<{ provider: GitProviderKind; connectionId: string | null; name: string; error: string }>;
	/** At least one source listed more repositories than were fetched. */
	truncated: boolean;
	/** The GitHub App is connected for this org. */
	github: boolean;
	connections: Array<{ id: string; kind: ForgeKind; name: string; baseUrl: string }>;
}

/** How a repository URL is served in an org, for "delivered by …" hints on views. */
export interface GitProviderLink {
	kind: GitProviderKind;
	/** The forge connection serving it; null for GitHub and generic URLs. */
	connectionId: string | null;
	/** Name of the connection or `GitHub App`. */
	via: string | null;
	/** Events arrive without a hand-made webhook (App installation or Skiff-created hook). */
	delivered: boolean;
}

/** `owner/repo` or a nested GitLab path; used where any provider's full name is accepted. */
export const gitFullNameSchema = z
	.string()
	.trim()
	.min(3)
	.max(512)
	.regex(/^[A-Za-z0-9_.~-]+(?:\/[A-Za-z0-9_.~-]+)+$/, 'Use owner/name (or group/subgroup/name).');
