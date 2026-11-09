import * as z from 'zod';

/**
 * Yoal's GitHub App (docs/GITHUB.md, D163–D166).
 *
 * One App per Yoal install, registered by a platform admin (one click through GitHub's manifest
 * flow, or by pasting an existing App's credentials). Each GitHub account that installs it is
 * linked to one Yoal organisation; from then on that organisation's git builds, pipelines,
 * runners and registry trusts use the installation instead of hand-made webhooks and tokens:
 *
 * - events arrive on one App webhook, so no per-project or per-repository webhook is needed;
 * - build nodes clone private repositories with a one-hour, single-repository, read-only token;
 * - builds and pipeline runs report commit statuses, and promoted git builds GitHub deployments;
 * - runner pools mint JIT configs with the installation instead of a PAT or pasted App key;
 * - forms offer the installation's repositories instead of free-text URLs.
 *
 * The App's private key, webhook secret and OAuth client secret are sealed with the master key
 * and never leave the control plane.
 */

/** Permissions the manifest asks for; an installation may grant fewer (see `missingPermissions`). */
export const GITHUB_APP_PERMISSIONS = {
	/** Clone repositories and read workflow files. */
	contents: 'read',
	metadata: 'read',
	/** `pull_request` events for pipelines. */
	pull_requests: 'read',
	/** Commit statuses for builds and pipeline runs. */
	statuses: 'write',
	/** GitHub deployments for promoted git builds. */
	deployments: 'write',
	/** Repository self-hosted runners (JIT configs). */
	administration: 'write',
	/** Organisation self-hosted runners (JIT configs). */
	organization_self_hosted_runners: 'write',
	/** Sign in with GitHub through the App (Better Auth reads the verified address). */
	emails: 'read',
} as const satisfies Record<string, 'read' | 'write'>;

export type GithubAppPermission = keyof typeof GITHUB_APP_PERMISSIONS;

export const GITHUB_APP_EVENTS = ['push', 'pull_request'] as const;

/** What each Yoal feature needs from an installation, for the dashboard's "missing" hints. */
export const GITHUB_FEATURE_PERMISSIONS: Record<string, Partial<Record<GithubAppPermission, 'read' | 'write'>>> = {
	clone: { contents: 'read' },
	statuses: { statuses: 'write' },
	deployments: { deployments: 'write' },
	pullRequests: { pull_requests: 'read' },
	repoRunners: { administration: 'write' },
	orgRunners: { organization_self_hosted_runners: 'write' },
};

/** Permissions the manifest wants that `granted` lacks (or grants read where write is wanted). */
export function missingPermissions(granted: Record<string, string>): GithubAppPermission[] {
	const missing: GithubAppPermission[] = [];
	for (const [name, level] of Object.entries(GITHUB_APP_PERMISSIONS) as Array<[GithubAppPermission, string]>) {
		if (name === 'emails') continue; // a user permission; installations never list it
		const have = granted[name];
		if (!have || (level === 'write' && have !== 'write' && have !== 'admin')) missing.push(name);
	}
	return missing;
}

export interface GithubAppManifestOptions {
	/** Platform origin, e.g. `https://control.example.com`. */
	origin: string;
	name: string;
	/** Public apps can be installed by any account; private apps only by the owner. */
	public: boolean;
}

/**
 * The manifest posted to `github.com/settings/apps/new` (or an organisation's equivalent).
 * GitHub then redirects to `redirect_url?code=…&state=…` and the control plane converts the code
 * into the App's id, private key, webhook secret and OAuth credentials.
 */
export function githubAppManifest(options: GithubAppManifestOptions) {
	const origin = options.origin.replace(/\/+$/, '');
	return {
		name: options.name,
		url: origin,
		description: 'Deploys and CI for this Yoal install.',
		hook_attributes: { url: `${origin}/api/webhooks/github-app`, active: true },
		redirect_url: `${origin}/settings/github/created`,
		// With `request_oauth_on_install`, GitHub sends the installing user to the FIRST callback URL
		// with an OAuth code (no setup URL), so Yoal can check they can really see the installation
		// before linking it. Better Auth's GitHub sign-in reuses the same client and second URL.
		callback_urls: [`${origin}/settings/github/installed`, `${origin}/api/auth/callback/github`],
		request_oauth_on_install: true,
		public: options.public,
		default_permissions: { ...GITHUB_APP_PERMISSIONS },
		default_events: [...GITHUB_APP_EVENTS],
	};
}

export type GithubAppManifest = ReturnType<typeof githubAppManifest>;

/** Where the manifest form posts: a personal account, or an organisation the admin owns. */
export function githubAppManifestUrl(owner: string | null, state: string): string {
	const base = owner
		? `https://github.com/organizations/${encodeURIComponent(owner)}/settings/apps/new`
		: 'https://github.com/settings/apps/new';
	return `${base}?state=${encodeURIComponent(state)}`;
}

const pemSchema = z
	.string()
	.trim()
	.min(64, 'Paste the whole private key, including the BEGIN and END lines.')
	.max(16_384)
	.refine((value) => /-----BEGIN (?:RSA )?PRIVATE KEY-----/.test(value), 'Paste the PEM private key GitHub generated for the app.');

export const githubAppManifestStartSchema = z.object({
	name: z
		.string()
		.trim()
		.min(3)
		.max(34, 'GitHub App names are at most 34 characters.')
		.regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/, 'Use letters, digits, spaces, ".", "_" and "-".'),
	/** GitHub organisation to own the App; blank registers it on the admin's personal account. */
	owner: z
		.string()
		.trim()
		.max(39)
		.regex(/^$|^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/, 'Enter a GitHub organisation name.')
		.optional()
		.transform((value) => value || undefined),
	public: z.boolean().default(false),
});
export type GithubAppManifestStart = z.input<typeof githubAppManifestStartSchema>;

/** An App created by hand on GitHub. The webhook secret is required: unsigned events are refused. */
export const githubAppManualSchema = z.object({
	appId: z.coerce.number().int().positive(),
	privateKey: pemSchema,
	webhookSecret: z.string().min(16, 'Use a webhook secret of at least 16 characters.').max(256),
	clientId: z.string().trim().max(64).optional().transform((value) => value || undefined),
	clientSecret: z.string().trim().max(128).optional().transform((value) => value || undefined),
});
export type GithubAppManual = z.input<typeof githubAppManualSchema>;

export interface GithubAppView {
	configured: boolean;
	appId: number | null;
	slug: string | null;
	name: string | null;
	/** `https://github.com/apps/<slug>`. */
	htmlUrl: string | null;
	/** The account that owns the App registration. */
	owner: string | null;
	/** Platform admins only. */
	clientId: string | null;
	hasClientSecret: boolean;
	/** `manifest` (created from Yoal) or `manual` (credentials pasted). */
	source: 'manifest' | 'manual' | null;
	/** Absolute URL of the App webhook receiver. */
	webhookUrl: string;
	/** Absolute callback URL to give GitHub for a manual App (with "Request user authorization during installation"). */
	setupUrl: string;
	/** `https://github.com/apps/<slug>/installations/new`, when the slug is known. */
	installUrl: string | null;
	/** The App can also be used for "Sign in with GitHub" (needs OAuth client credentials). */
	signInReady: boolean;
	/** Sign-in uses `GITHUB_CLIENT_ID` from the environment instead of the App. */
	signInFromEnv: boolean;
	createdAt: string | null;
}

export interface GithubInstallationView {
	/** GitHub's installation id. */
	id: number;
	account: { login: string; type: 'User' | 'Organization' | string; avatarUrl: string | null };
	repositorySelection: 'all' | 'selected' | string;
	permissions: Record<string, string>;
	/** Manifest permissions this installation has not granted. */
	missingPermissions: GithubAppPermission[];
	suspended: boolean;
	/** The Yoal organisation it is linked to; null while unclaimed (platform admins see these). */
	orgId: string | null;
	orgName?: string | null;
	/** `https://github.com/settings/installations/<id>` (or the organisation's equivalent). */
	settingsUrl: string;
	linkedAt: string | null;
	updatedAt: string;
}

export interface GithubRepositoryView {
	id: number;
	/** `owner/name`. */
	fullName: string;
	owner: string;
	name: string;
	private: boolean;
	archived: boolean;
	defaultBranch: string;
	cloneUrl: string;
	htmlUrl: string;
	installationId: number;
	pushedAt: string | null;
}

/** Repositories listed for a form; `error` is set when GitHub could not be asked. */
export interface GithubRepositoryList {
	connected: boolean;
	repositories: GithubRepositoryView[];
	/** An installation lists more repositories than were fetched. */
	truncated: boolean;
	error: string | null;
	/** Where to add more repositories (the org's first installation, or the install page). */
	manageUrl: string | null;
}

/** What GitHub integration a repository URL gets in an org, for "connected via GitHub App" hints. */
export interface GithubRepositoryLink {
	/** `owner/name` when the URL is a github.com repository. */
	fullName: string | null;
	/** The org has an installation on the repository's owner. */
	installationId: number | null;
}

/** `https://github.com/acme/app(.git)`, `git@github.com:acme/app.git` → `{owner, repo}`. */
export function parseGithubRepoUrl(url: string): { owner: string; repo: string } | null {
	const match =
		/^https:\/\/(?:[^@/]+@)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(url.trim()) ??
		/^(?:ssh:\/\/)?git@github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(url.trim());
	return match ? { owner: match[1]!, repo: match[2]! } : null;
}

/** `owner/repo` compare as GitHub does: case-insensitively. */
export function sameGithubRepo(a: string, b: string): boolean {
	return a.toLowerCase() === b.toLowerCase();
}
