import * as z from 'zod';
import { accessModes } from './model.ts';

/**
 * Deploy from GitHub (docs/GITHUB.md §9, D172).
 *
 * Pick a repository the org's GitHub App can reach, let Skiff guess how to build it, adjust, and
 * deploy: one step creates the project, its git source and the first build, and (when the
 * repository has `.skiff/workflows`) a pipeline repository. Pushes then build through the App's
 * webhook; there is nothing to set up on GitHub.
 */

export const frameworkIds = [
	'vite',
	'astro',
	'sveltekit-static',
	'sveltekit-node',
	'nextjs',
	'nuxt',
	'gatsby',
	'create-react-app',
	'docusaurus',
	'vitepress',
	'eleventy',
	'hugo',
	'bun-server',
	'node-server',
	'static-html',
	'other',
] as const;
export type FrameworkId = (typeof frameworkIds)[number];

export type ImportRuntime = 'static' | 'process';

export interface FrameworkPreset {
	id: FrameworkId;
	label: string;
	runtime: ImportRuntime;
	buildCommand: string;
	/** Relative to the root directory; its contents become the release. */
	outputDir: string;
	/** Process apps: the start command (argv, run inside the release). Absent = `bun run start`. */
	command?: string[];
	engine?: 'bun' | 'node';
	port?: number;
}

const INSTALL = 'bun install';

/**
 * Presets the dashboard offers. Every one installs and builds with Bun, which every Builder node
 * has (it ships with Skiff); Bun reads npm, Yarn and pnpm lockfiles and stands in for `node` when
 * a script needs it.
 */
export const FRAMEWORK_PRESETS: Record<FrameworkId, FrameworkPreset> = {
	vite: { id: 'vite', label: 'Vite', runtime: 'static', buildCommand: `${INSTALL} && bun run build`, outputDir: 'dist' },
	astro: { id: 'astro', label: 'Astro', runtime: 'static', buildCommand: `${INSTALL} && bun run build`, outputDir: 'dist' },
	'sveltekit-static': {
		id: 'sveltekit-static',
		label: 'SvelteKit (static)',
		runtime: 'static',
		buildCommand: `${INSTALL} && bun run build`,
		outputDir: 'build',
	},
	'sveltekit-node': {
		id: 'sveltekit-node',
		label: 'SvelteKit (Node adapter)',
		runtime: 'process',
		buildCommand: `${INSTALL} && bun run build`,
		outputDir: '.',
		command: ['bun', 'build/index.js'],
		port: 3000,
	},
	nextjs: {
		id: 'nextjs',
		label: 'Next.js',
		runtime: 'process',
		buildCommand: `${INSTALL} && bun run build`,
		outputDir: '.',
		engine: 'node',
		port: 3000,
	},
	nuxt: {
		id: 'nuxt',
		label: 'Nuxt (static)',
		runtime: 'static',
		buildCommand: `${INSTALL} && bunx nuxi generate`,
		outputDir: '.output/public',
	},
	gatsby: { id: 'gatsby', label: 'Gatsby', runtime: 'static', buildCommand: `${INSTALL} && bun run build`, outputDir: 'public' },
	'create-react-app': {
		id: 'create-react-app',
		label: 'Create React App',
		runtime: 'static',
		buildCommand: `${INSTALL} && bun run build`,
		outputDir: 'build',
	},
	docusaurus: { id: 'docusaurus', label: 'Docusaurus', runtime: 'static', buildCommand: `${INSTALL} && bun run build`, outputDir: 'build' },
	vitepress: {
		id: 'vitepress',
		label: 'VitePress',
		runtime: 'static',
		buildCommand: `${INSTALL} && bunx vitepress build docs`,
		outputDir: 'docs/.vitepress/dist',
	},
	eleventy: { id: 'eleventy', label: 'Eleventy', runtime: 'static', buildCommand: `${INSTALL} && bunx @11ty/eleventy`, outputDir: '_site' },
	hugo: { id: 'hugo', label: 'Hugo', runtime: 'static', buildCommand: 'hugo --minify', outputDir: 'public' },
	'bun-server': { id: 'bun-server', label: 'Bun server', runtime: 'process', buildCommand: INSTALL, outputDir: '.', port: 3000 },
	'node-server': {
		id: 'node-server',
		label: 'Node.js server',
		runtime: 'process',
		buildCommand: INSTALL,
		outputDir: '.',
		engine: 'node',
		port: 3000,
	},
	'static-html': { id: 'static-html', label: 'Plain HTML', runtime: 'static', buildCommand: 'true', outputDir: '.' },
	other: { id: 'other', label: 'Other', runtime: 'static', buildCommand: `${INSTALL} && bun run build`, outputDir: 'dist' },
};

interface PackageJsonLike {
	scripts?: Record<string, unknown>;
	dependencies?: Record<string, unknown>;
	devDependencies?: Record<string, unknown>;
}

/**
 * Guess the framework from a directory listing (file names at the root directory) and its
 * `package.json`, if any. Pure, so the dashboard, REST and MCP agree and it is unit tested.
 */
export function detectFramework(input: { files: string[]; packageJson: unknown }): FrameworkPreset {
	const files = new Set(input.files.map((name) => name.toLowerCase()));
	const pkg = (input.packageJson && typeof input.packageJson === 'object' ? input.packageJson : null) as PackageJsonLike | null;
	const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
	const has = (name: string) => Object.hasOwn(deps, name);
	const scripts = pkg?.scripts ?? {};
	const script = (name: string) => (typeof scripts[name] === 'string' ? (scripts[name] as string) : null);

	if (pkg) {
		if (has('next')) return FRAMEWORK_PRESETS.nextjs;
		if (has('nuxt')) return FRAMEWORK_PRESETS.nuxt;
		if (has('@sveltejs/kit'))
			return has('@sveltejs/adapter-node') || has('svelte-adapter-bun')
				? FRAMEWORK_PRESETS['sveltekit-node']
				: FRAMEWORK_PRESETS['sveltekit-static'];
		if (has('astro')) return FRAMEWORK_PRESETS.astro;
		if (has('gatsby')) return FRAMEWORK_PRESETS.gatsby;
		if (has('@docusaurus/core')) return FRAMEWORK_PRESETS.docusaurus;
		if (has('vitepress')) return FRAMEWORK_PRESETS.vitepress;
		if (has('@11ty/eleventy')) return FRAMEWORK_PRESETS.eleventy;
		if (has('react-scripts')) return FRAMEWORK_PRESETS['create-react-app'];
		if (has('vite')) return FRAMEWORK_PRESETS.vite;
		// A server without a build step: run it as a process app.
		if (!script('build') && (script('start') || files.has('index.ts') || files.has('server.ts'))) {
			const bunFirst = files.has('bun.lock') || files.has('bun.lockb') || has('@types/bun') || has('bun-types');
			return bunFirst ? FRAMEWORK_PRESETS['bun-server'] : FRAMEWORK_PRESETS['node-server'];
		}
		return FRAMEWORK_PRESETS.other;
	}
	if (files.has('hugo.toml') || files.has('hugo.yaml') || (files.has('config.toml') && files.has('content')))
		return FRAMEWORK_PRESETS.hugo;
	if (files.has('index.html')) return FRAMEWORK_PRESETS['static-html'];
	return FRAMEWORK_PRESETS.other;
}

/** `owner/name` as GitHub spells it. */
export const githubFullNameSchema = z
	.string()
	.min(3)
	.max(201)
	.regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'Use owner/name');

const relativeDir = (label: string) =>
	z
		.string()
		.max(512)
		.refine((value) => !value.startsWith('/') && !value.split('/').includes('..'), `${label} must stay inside the repository`);

export const githubImportDetectSchema = z.object({
	repository: githubFullNameSchema,
	/** Branch to read; the repository's default branch when absent. */
	branch: z.string().min(1).max(255).optional(),
	rootDir: relativeDir('rootDir').default('.'),
});
export type GithubImportDetectInput = z.input<typeof githubImportDetectSchema>;

export interface GithubImportDetection {
	repository: {
		fullName: string;
		cloneUrl: string;
		htmlUrl: string;
		defaultBranch: string;
		private: boolean;
	};
	branch: string;
	rootDir: string;
	/** What Skiff would use; every field can be changed before deploying. */
	preset: FrameworkPreset;
	/** Directories at the root directory, for choosing a monorepo package. */
	directories: string[];
	/** `.skiff/workflows/*.yml` at the repository root (pipelines run them on push). */
	workflows: string[];
	hasDockerfile: boolean;
	/** A project name suggestion (the package name or the repository name). */
	suggestedName: string;
}

export const githubImportSchema = z
	.object({
		repository: githubFullNameSchema,
		branch: z.string().min(1).max(255).optional(),
		name: z.string().min(1).max(120).optional(),
		slug: z
			.string()
			.regex(/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/, 'Use 3–40 lowercase letters, digits and single hyphens')
			.optional(),
		framework: z.enum(frameworkIds).optional(),
		runtime: z.enum(['static', 'process']).default('static'),
		rootDir: relativeDir('rootDir').default('.'),
		buildCommand: z.string().min(1).max(2048),
		outputDir: relativeDir('outputDir').min(1).default('dist'),
		/** Process apps: argv run inside the release. Absent runs the package.json `start` script. */
		command: z.array(z.string().min(1).max(1024)).min(1).max(64).optional(),
		engine: z.enum(['bun', 'node']).optional(),
		port: z.number().int().min(1).max(65535).optional(),
		/** Plain environment variables for process apps. */
		env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(16_384)).optional(),
		productionAccess: z.enum(accessModes).default('public'),
		previewAccess: z.enum(accessModes).default('platform'),
		/** Also add the repository to Pipelines when it has `.skiff/workflows`. */
		pipelines: z.boolean().default(true),
	})
	.refine((value) => value.runtime === 'process' || (!value.command && !value.env), {
		message: 'A start command and variables only apply to process apps',
		path: ['command'],
	})
	.refine((value) => value.productionAccess !== 'password' && value.previewAccess !== 'password' && value.productionAccess !== 'access' && value.previewAccess !== 'access', {
		message: 'Set password and Skiff Access protection from the project after importing',
		path: ['productionAccess'],
	});
export type GithubImportInput = z.input<typeof githubImportSchema>;

export interface GithubImportResult {
	project: { id: string; slug: string; name: string };
	/** The first build, queued on the chosen branch and promoted when it succeeds. */
	build: { id: string } | null;
	/** The pipeline repository created alongside, when the repository has workflows. */
	pipelineRepository: string | null;
	/** Steps that did not happen (the project exists either way), e.g. a build quota refusal. */
	warnings: string[];
}

/** Org setting: add App-covered repositories with `.skiff/workflows` to Pipelines on push (D172). */
export interface PipelineAutoSetupView {
	enabled: boolean;
	/** `owner/name` of repositories removed from Pipelines, which are not added back. */
	ignored: string[];
}

export const pipelineAutoSetupSchema = z.object({
	enabled: z.boolean().optional(),
	/** Forget an ignored repository so its next push adds it again. */
	unignore: githubFullNameSchema.optional(),
});
export type PipelineAutoSetupInput = z.infer<typeof pipelineAutoSetupSchema>;
