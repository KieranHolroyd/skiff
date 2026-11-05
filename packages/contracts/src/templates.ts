import * as z from 'zod';
import {
	GITHUB_RUNNER_BASE_LABELS,
	GITHUB_RUNNER_DEFAULT_IMAGE,
	githubOwnerSchema,
	githubRepoSchema,
	githubRunnerLabelSchema,
	githubRunnerScopes,
	type GithubRunner,
} from './github-runner.ts';
import { SLUG_PATTERN } from './slugs.ts';
import { MAX_WORKLOAD_REPLICAS, type WorkloadSpec } from './workload.ts';

/**
 * First-party app templates (plan 21, D92).
 *
 * A template turns a short form into the same objects a user could create by hand: a project,
 * project secrets, a workload spec and a first deployment. It is pure data plus a pure `build`
 * function, so REST, MCP, CLI and the dashboard all run the same plan through `packages/core`.
 * There is no third-party registry (FEATURE-RESEARCH "not doing": template marketplace).
 */

export const templateCategories = ['ci', 'worker'] as const;
export type TemplateCategory = (typeof templateCategories)[number];

/** One choice of a `select` field; `description` is shown when the choices render as cards. */
export interface TemplateFieldOption {
	value: string;
	label: string;
	description?: string;
}

/**
 * A form field the dashboard renders; `showWhen` hides it unless another field has a value.
 * Everything past `kind` is presentation: clients that ignore it still produce a valid request.
 */
export interface TemplateField {
	key: string;
	label: string;
	kind: 'text' | 'number' | 'select' | 'secret' | 'textarea' | 'labels';
	/** Must be filled whenever the field is shown (the template's schema has the final say). */
	required?: boolean;
	help?: string;
	placeholder?: string;
	options?: TemplateFieldOption[];
	default?: string | number;
	min?: number;
	max?: number;
	step?: number;
	showWhen?: { key: string; equals: string };
	/** The `TemplateGroup.id` this field is shown under; ungrouped fields go in a default group. */
	group?: string;
	/** Unit shown beside a number (`MB`, `CPU`). */
	unit?: string;
	/** Quick-pick values for a number field. */
	presets?: number[];
	/** For a textarea: file types that may be dropped or picked to fill it (`.pem`). */
	accept?: string;
	/** For a labels field: labels that are always added, shown but not editable. */
	fixed?: readonly string[];
	/**
	 * This field is an alternative to the named fields (for example an existing secret instead of
	 * a pasted credential): fill one or the other, never both.
	 */
	replaces?: string[];
	/** Offer the organisation's existing secret names as suggestions. */
	suggest?: 'secrets';
}

/** A titled section of a template's form, in display order. */
export interface TemplateGroup {
	id: string;
	title: string;
	description?: string;
	/** Collapsed until opened; for fields whose defaults suit almost everyone. */
	advanced?: boolean;
}

/** A secret the template creates on the new project. The value never leaves `packages/core`. */
export interface TemplateSecret {
	name: string;
	value: string;
}

/** What `build` returns; `core` executes it in one audited operation. */
export interface TemplatePlan {
	project: { name: string; slug?: string; runtime: 'process' | 'container'; placement: string };
	/** New project secrets (values from the form). */
	secrets: TemplateSecret[];
	/** Existing secrets the spec references; each must resolve before anything is created. */
	requiredSecrets: string[];
	spec: WorkloadSpec;
	/** Recorded as `skiff-template.json` in the first release, so the deployment is reproducible. */
	manifest: { template: string; version: number; values: Record<string, unknown> };
}

export interface AppTemplate {
	id: string;
	version: number;
	name: string;
	summary: string;
	category: TemplateCategory;
	/** A lucide icon name the dashboard maps to a component. */
	icon: string;
	docsUrl?: string;
	/** Short selling points for the catalog card. */
	highlights?: string[];
	/** What the user needs to have ready before filling the form. */
	requirements?: string[];
	groups?: TemplateGroup[];
	fields: TemplateField[];
}

/** Catalog entry as returned by `GET /api/v1/templates`. */
export type AppTemplateView = AppTemplate;

// ----------------------------------------------------------------- GitHub Actions runner

export const GITHUB_RUNNER_TEMPLATE_ID = 'github-actions-runner';

/** Names the runner template gives the secrets it creates. */
export const GITHUB_RUNNER_PAT_SECRET = 'GITHUB_RUNNER_TOKEN';
export const GITHUB_RUNNER_APP_KEY_SECRET = 'GITHUB_APP_PRIVATE_KEY';

const pemSchema = z
	.string()
	.trim()
	.min(64, 'Paste the whole private key, including the BEGIN and END lines.')
	.max(16_384)
	.refine((value) => /-----BEGIN (?:RSA )?PRIVATE KEY-----/.test(value), 'Paste the PEM private key GitHub generated for the app.');

const existingSecretSchema = z
	.string()
	.trim()
	.regex(/^[A-Z][A-Z0-9_]*$/, 'Secret names are UPPER_SNAKE_CASE.')
	.max(128);

/** Accept `"a, b c"` from a form as well as an array from the API. */
const labelsInputSchema = z
	.union([z.array(z.string()), z.string()])
	.transform((value) =>
		(Array.isArray(value) ? value : value.split(/[\s,]+/))
			.map((label) => label.trim())
			.filter((label) => label.length > 0),
	)
	.pipe(z.array(githubRunnerLabelSchema).max(20));

const positiveIntFromForm = (min: number, max: number) =>
	z.coerce.number().int().min(min).max(max);

export const githubRunnerTemplateInputSchema = z
	.object({
		name: z.string().trim().min(1).max(120),
		slug: z
			.string()
			.trim()
			.regex(SLUG_PATTERN, 'Use 3–40 lowercase letters, digits and hyphens.')
			.optional()
			.or(z.literal('').transform(() => undefined)),
		placement: z.string().trim().min(1).max(64).default('auto'),
		scope: z.enum(githubRunnerScopes).default('repo'),
		owner: githubOwnerSchema,
		repo: githubRepoSchema.optional().or(z.literal('').transform(() => undefined)),
		labels: labelsInputSchema.default([]),
		runnerGroupId: positiveIntFromForm(1, 1_000_000).default(1),
		replicas: positiveIntFromForm(1, MAX_WORKLOAD_REPLICAS).default(2),
		memoryMb: positiveIntFromForm(256, 8192).default(2048),
		cpus: z.coerce.number().positive().max(8).default(2),
		image: z.string().trim().min(1).max(512).default(GITHUB_RUNNER_DEFAULT_IMAGE),
		auth: z.enum(['pat', 'app']).default('pat'),
		/** PAT value to store as a new project secret. */
		token: z.string().trim().max(512).optional().or(z.literal('').transform(() => undefined)),
		/** Or the name of an existing project/org secret holding the PAT or the App key. */
		existingSecret: existingSecretSchema.optional().or(z.literal('').transform(() => undefined)),
		appId: positiveIntFromForm(1, Number.MAX_SAFE_INTEGER).optional(),
		installationId: positiveIntFromForm(1, Number.MAX_SAFE_INTEGER).optional(),
		privateKey: pemSchema.optional().or(z.literal('').transform(() => undefined)),
	})
	.superRefine((input, ctx) => {
		if (input.scope === 'repo' && !input.repo)
			ctx.addIssue({ code: 'custom', path: ['repo'], message: 'Choose the repository the runners serve.' });
		if (input.scope === 'org' && input.repo)
			ctx.addIssue({ code: 'custom', path: ['repo'], message: 'Organisation runners do not name a repository.' });
		if (input.scope === 'repo' && input.runnerGroupId !== 1)
			ctx.addIssue({ code: 'custom', path: ['runnerGroupId'], message: 'Repository runners use the default group.' });
		if (input.auth === 'pat') {
			if (Boolean(input.token) === Boolean(input.existingSecret))
				ctx.addIssue({
					code: 'custom',
					path: ['token'],
					message: 'Paste a token or name an existing secret (one of the two).',
				});
		} else {
			if (!input.appId) ctx.addIssue({ code: 'custom', path: ['appId'], message: 'Enter the GitHub App ID.' });
			if (!input.installationId)
				ctx.addIssue({ code: 'custom', path: ['installationId'], message: 'Enter the installation ID.' });
			if (Boolean(input.privateKey) === Boolean(input.existingSecret))
				ctx.addIssue({
					code: 'custom',
					path: ['privateKey'],
					message: 'Paste the private key or name an existing secret (one of the two).',
				});
		}
		if (input.token && input.auth !== 'pat')
			ctx.addIssue({ code: 'custom', path: ['token'], message: 'A token is only used with PAT authentication.' });
		if (input.privateKey && input.auth !== 'app')
			ctx.addIssue({ code: 'custom', path: ['privateKey'], message: 'A private key is only used with GitHub App authentication.' });
	});
export type GithubRunnerTemplateInput = z.input<typeof githubRunnerTemplateInputSchema>;

export const githubRunnerTemplate: AppTemplate = {
	id: GITHUB_RUNNER_TEMPLATE_ID,
	version: 1,
	name: 'GitHub Actions runner',
	summary:
		'A pool of ephemeral self-hosted runners for a repository or organisation. Each runner takes one job, then is replaced by a fresh one.',
	category: 'ci',
	icon: 'workflow',
	docsUrl: 'https://docs.github.com/actions/hosting-your-own-runners',
	highlights: [
		'One fresh container per job, so no job sees another job’s files.',
		'The token or App key stays on the control plane; nodes only get a single-use JIT config.',
		'Finished runners are replaced within seconds; GitHub sees a steady pool.',
	],
	requirements: [
		'A fine-grained token with Administration: write on the repository (or Self-hosted runners: write on the organisation), or a GitHub App with the same permission.',
		'Room on a node for every runner’s memory: the whole pool runs on one node.',
	],
	groups: [
		{ id: 'project', title: 'Project', description: 'The Skiff project that owns the runner pool.' },
		{ id: 'github', title: 'Repository', description: 'Where the runners register and which jobs they pick up.' },
		{ id: 'credential', title: 'GitHub credential', description: 'Used by the control plane to mint a single-use runner config per job.' },
		{ id: 'capacity', title: 'Capacity', description: 'Memory and CPU apply per runner; admission reserves memory for every runner.' },
		{ id: 'advanced', title: 'Advanced', advanced: true },
	],
	fields: [
		{ key: 'name', label: 'Name', kind: 'text', required: true, placeholder: 'CI runners', group: 'project' },
		{
			key: 'scope',
			label: 'Runners for',
			kind: 'select',
			default: 'repo',
			group: 'github',
			options: [
				{ value: 'repo', label: 'One repository', description: 'Jobs from a single repository.' },
				{ value: 'org', label: 'A whole organisation', description: 'Shared by every repository in a runner group.' },
			],
		},
		{ key: 'owner', label: 'Owner', kind: 'text', required: true, placeholder: 'my-org', help: 'User or organisation that owns the repository.', group: 'github' },
		{ key: 'repo', label: 'Repository', kind: 'text', required: true, placeholder: 'my-repo', showWhen: { key: 'scope', equals: 'repo' }, group: 'github' },
		{
			key: 'runnerGroupId',
			label: 'Runner group ID',
			kind: 'number',
			default: 1,
			min: 1,
			help: '1 is the Default group.',
			showWhen: { key: 'scope', equals: 'org' },
			group: 'github',
		},
		{
			key: 'labels',
			label: 'Extra labels',
			kind: 'labels',
			placeholder: 'gpu, X64',
			help: 'Add these to runs-on to target this pool.',
			fixed: GITHUB_RUNNER_BASE_LABELS,
			group: 'github',
		},
		{
			key: 'auth',
			label: 'Authenticate with',
			kind: 'select',
			default: 'pat',
			group: 'credential',
			options: [
				{ value: 'pat', label: 'Personal access token', description: 'Quickest to set up. Fine-grained tokens are scoped to the repository or organisation.' },
				{ value: 'app', label: 'GitHub App', description: 'Not tied to a person; GitHub issues short-lived tokens.' },
			],
		},
		{
			key: 'token',
			label: 'Personal access token',
			kind: 'secret',
			required: true,
			placeholder: 'github_pat_…',
			showWhen: { key: 'auth', equals: 'pat' },
			help: 'Fine-grained: Administration (write) on the repository, or Self-hosted runners (write) on the organisation. Stored as a project secret.',
			group: 'credential',
		},
		{ key: 'appId', label: 'App ID', kind: 'number', required: true, min: 1, showWhen: { key: 'auth', equals: 'app' }, group: 'credential' },
		{
			key: 'installationId',
			label: 'Installation ID',
			kind: 'number',
			required: true,
			min: 1,
			help: 'The number at the end of the installation’s settings URL.',
			showWhen: { key: 'auth', equals: 'app' },
			group: 'credential',
		},
		{
			key: 'privateKey',
			label: 'App private key',
			kind: 'textarea',
			required: true,
			accept: '.pem',
			placeholder: '-----BEGIN RSA PRIVATE KEY-----',
			showWhen: { key: 'auth', equals: 'app' },
			help: 'Stored as a project secret; only the control plane reads it.',
			group: 'credential',
		},
		{
			key: 'existingSecret',
			label: 'Existing secret',
			kind: 'text',
			required: true,
			placeholder: 'ORG_RUNNER_TOKEN',
			help: 'Name of a project or organisation secret holding the token or key, instead of pasting it.',
			replaces: ['token', 'privateKey'],
			suggest: 'secrets',
			group: 'credential',
		},
		{ key: 'replicas', label: 'Runners', kind: 'number', default: 2, min: 1, max: MAX_WORKLOAD_REPLICAS, help: 'How many jobs can run at once.', group: 'capacity' },
		{
			key: 'memoryMb',
			label: 'Memory per runner',
			kind: 'number',
			default: 2048,
			min: 256,
			max: 8192,
			step: 256,
			unit: 'MB',
			presets: [1024, 2048, 4096, 8192],
			group: 'capacity',
		},
		{ key: 'cpus', label: 'CPUs per runner', kind: 'number', default: 2, min: 1, max: 8, unit: 'CPU', presets: [1, 2, 4], group: 'capacity' },
		{
			key: 'image',
			label: 'Runner image',
			kind: 'text',
			default: GITHUB_RUNNER_DEFAULT_IMAGE,
			help: 'Must be based on actions/runner (runs /home/runner/run.sh). Pulled again each time a runner is replaced.',
			group: 'advanced',
		},
	],
};

/**
 * Secret names are unique per org on older control planes, so the secrets a template creates are
 * suffixed with the project slug (`GITHUB_RUNNER_TOKEN_CI_RUNNERS`). Core builds once to validate,
 * creates the project, then builds again with the final slug's suffix.
 */
export function templateSecretSuffix(slug: string): string {
	return slug.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

export interface TemplateBuildOptions {
	/** Appended as `_<SUFFIX>` to every secret the template creates (not to existing ones). */
	secretSuffix?: string;
}

function suffixed(name: string, options: TemplateBuildOptions): string {
	return options.secretSuffix ? `${name}_${options.secretSuffix}` : name;
}

export function buildGithubRunnerTemplate(raw: unknown, options: TemplateBuildOptions = {}): TemplatePlan {
	const input = githubRunnerTemplateInputSchema.parse(raw);
	const secrets: TemplateSecret[] = [];
	const requiredSecrets: string[] = [];
	let auth: GithubRunner['auth'];
	if (input.auth === 'pat') {
		const tokenSecret = input.existingSecret ?? suffixed(GITHUB_RUNNER_PAT_SECRET, options);
		if (input.token) secrets.push({ name: tokenSecret, value: input.token });
		else requiredSecrets.push(tokenSecret);
		auth = { method: 'pat', tokenSecret };
	} else {
		const privateKeySecret = input.existingSecret ?? suffixed(GITHUB_RUNNER_APP_KEY_SECRET, options);
		if (input.privateKey) secrets.push({ name: privateKeySecret, value: `${input.privateKey.trim()}\n` });
		else requiredSecrets.push(privateKeySecret);
		auth = { method: 'app', appId: input.appId!, installationId: input.installationId!, privateKeySecret };
	}
	const runner: GithubRunner = {
		provider: 'github',
		scope: input.scope,
		owner: input.owner,
		...(input.scope === 'repo' ? { repo: input.repo } : {}),
		labels: input.labels,
		runnerGroupId: input.scope === 'org' ? input.runnerGroupId : 1,
		auth,
	};
	const spec: WorkloadSpec = {
		runtime: 'container',
		image: input.image,
		port: 3000,
		memoryMb: input.memoryMb,
		cpus: input.cpus,
		healthPath: '/',
		socketActivation: false,
		env: {},
		secrets: [],
		ingress: 'none',
		replicas: input.replicas,
		runner,
	};
	// Never record credential values (or that a value was pasted) in the release manifest.
	const { token: _token, privateKey: _privateKey, ...values } = input;
	return {
		project: {
			name: input.name,
			...(input.slug ? { slug: input.slug } : {}),
			runtime: 'container',
			placement: input.placement,
		},
		secrets,
		requiredSecrets,
		spec,
		manifest: { template: GITHUB_RUNNER_TEMPLATE_ID, version: githubRunnerTemplate.version, values },
	};
}

// ----------------------------------------------------------------- catalog

interface TemplateEntry {
	template: AppTemplate;
	build: (input: unknown, options?: TemplateBuildOptions) => TemplatePlan;
}

const catalog: Record<string, TemplateEntry> = {
	[GITHUB_RUNNER_TEMPLATE_ID]: { template: githubRunnerTemplate, build: buildGithubRunnerTemplate },
};

export function listAppTemplates(): AppTemplateView[] {
	return Object.values(catalog).map((entry) => entry.template);
}

export function getAppTemplate(id: string): AppTemplateView | null {
	return catalog[id]?.template ?? null;
}

/** Validate a template's form input and return its plan; throws a ZodError on bad input. */
export function buildAppTemplate(id: string, input: unknown, options: TemplateBuildOptions = {}): TemplatePlan | null {
	const entry = catalog[id];
	return entry ? entry.build(input, options) : null;
}

export const templateInstantiateSchema = z.object({
	/** Template-specific values; validated by the template's own schema. */
	values: z.record(z.string(), z.unknown()),
});
export type TemplateInstantiate = z.infer<typeof templateInstantiateSchema>;
