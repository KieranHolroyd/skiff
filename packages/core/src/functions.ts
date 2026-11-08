import { and, eq, isNull } from 'drizzle-orm';
import { projects, workloads } from '@skiff/db';
import {
	FUNCTION_DEFAULT_IDLE_STOP_SECONDS,
	FUNCTION_DEFAULT_COMPATIBILITY_DATE,
	FUNCTION_DEFAULT_MEMORY_MB,
	FUNCTION_PYTHON_COMPAT_FLAG,
	FUNCTION_PYTHON_DEFAULT_MEMORY_MB,
	FUNCTION_PYTHON_MIN_MEMORY_MB,
	functionIsPython,
	FUNCTION_HEALTH_PATH,
	FUNCTION_MANIFEST_FILE,
	WORKERD_PINNED_VERSION,
	compatibilityDateProblem,
	functionBindingSummary,
	functionManifestSchema,
	functionRuntimeSpecSchema,
	workloadSpecSchema,
	type FunctionManifest,
	type FunctionModule,
	type FunctionQueueConsumer,
	type FunctionRuntimeBinding,
	type FunctionRuntimeQueueConsumer,
	type FunctionRuntimeSpec,
	type FunctionView,
	type Principal,
	type SecretRef,
	type WorkloadSpec,
} from '@skiff/contracts';
import { entryMap, type FileEntry } from './artifact.ts';
import { featureEnabled } from './config.ts';
import type { CoreContext } from './context.ts';
import type {
	FunctionInvocationQuery,
	FunctionInvocationRow,
	FunctionInvocationSummary,
	TimeInput,
} from './telemetry.ts';
import { ConflictError, ValidationError } from './errors.ts';
import { bindingResolver } from './function-bindings/index.ts';
import { resolveQueueBroker } from './function-bindings/queue.ts';
import type { ProjectRow } from './projects.ts';
import { effectiveRuntime } from './runtime-tier.ts';
import { parseCron } from './cron.ts';
import { parseJson, sha256Hex } from './util.ts';

/**
 * Functions (D110): validates a `skiff-function.json` bundle, resolves bindings against the org
 * and exposes the function view.
 *
 * The control plane validates and never bundles (D2): a client uploads the modules plus the
 * manifest, this service checks them against the org's resources and records the resolved spec on
 * the project. The agent renders workerd's config from that spec; secret values only ever travel
 * through the activation endpoint.
 */
export class FunctionService {
	constructor(private readonly ctx: CoreContext) {}

	/** Validate a bundle and persist the resolved spec. Null when the bundle has no manifest. */
	async applyBundle(
		principal: Principal,
		project: ProjectRow,
		entries: FileEntry[],
	): Promise<FunctionRuntimeSpec | null> {
		const manifestEntry = entries.find((entry) => entry.path === FUNCTION_MANIFEST_FILE);
		if (!manifestEntry) {
			if (effectiveRuntime(project) !== 'function') return null;
			// A redeploy of a prebuilt Worker (for example `skif deploy ./dist`) carries no
			// manifest. Reuse the project's existing function spec for compatibility, bindings and
			// assets, and infer the modules from the uploaded files. A first deploy still needs the
			// generated manifest because there is nothing to infer from.
			this.ctx.iam.require(principal, 'deployment:create', { type: 'project', id: project.id });
			if (!featureEnabled(this.ctx.config, 'FUNCTIONS'))
				throw new ValidationError('Functions are not enabled on this platform (SKIFF_FEATURE_FUNCTIONS).');
			return this.applyInferredBundle(principal, project, entries);
		}
		this.ctx.iam.require(principal, 'deployment:create', { type: 'project', id: project.id });
		if (!featureEnabled(this.ctx.config, 'FUNCTIONS'))
			throw new ValidationError('Functions are not enabled on this platform (SKIFF_FEATURE_FUNCTIONS).');

		const manifest = parseManifest(manifestEntry.data);
		if (effectiveRuntime(project) !== 'function')
			throw new ValidationError(
				`Project "${project.slug}" is not a function project; deploy this bundle to a project created with runtime "function".`,
			);

		// Every module must be exactly the bytes the manifest names (FN8). Checked before anything is
		// stored so a tampered or stale bundle can never be recorded as good.
		const files = entryMap(entries);
		for (const module of manifest.modules) {
			const data = files.get(module.name);
			if (!data) throw new ValidationError(`Module "${module.name}" is missing from the bundle.`);
			const digest = sha256Hex(data);
			if (digest !== module.sha256)
				throw new ValidationError(
					`Module "${module.name}" has SHA-256 ${digest}, but ${FUNCTION_MANIFEST_FILE} declares ${module.sha256}.`,
				);
		}

		// The schema already caps this, but a direct caller (tests, CLI) bypasses the schema's defaults.
		const dateProblem = compatibilityDateProblem(manifest.compatibilityDate);
		if (dateProblem) throw new ValidationError(dateProblem);

		if (manifest.assets) checkAssets(manifest.assets.directory, entries);
		if (
			manifest.bindings.some((binding) => binding.type === 'd1') &&
			manifest.compatibilityFlags.includes('d1_binding_jsrpc')
		)
			throw new ValidationError(
				'D1 bindings on Skiff use the HTTP binding path; remove the d1_binding_jsrpc compatibility flag.',
			);

		const { bindings, secrets } = await this.resolveBindings(project, manifest.bindings, manifest);

		// Cron triggers ride desired state and fire on the node (FN9). Validate every expression here,
		// at deploy time: a bad schedule must fail the deploy, not silently never run.
		for (const cron of manifest.triggers.crons) parseCron(cron);
		const queues = this.resolveQueueConsumers(project, manifest.triggers.queues ?? []);

		// A deploy must not silently scale a function back to one host: the project's configured
		// replica count is orthogonal to the bundle (phase 4). The contract refine refuses a newly
		// added stateful binding under >1 replica.
		const configuredReplicas = this.ctx.workloads.projectSpec(project)?.replicas ?? 1;
		// Python Workers (D121) need workerd's `python_workers` flag; add it rather than make every
		// bundle repeat it, and give the heavier Pyodide host a larger default reservation.
		const python = functionIsPython(manifest);
		const compatibilityFlags =
			python && !manifest.compatibilityFlags.includes(FUNCTION_PYTHON_COMPAT_FLAG)
				? [...manifest.compatibilityFlags, FUNCTION_PYTHON_COMPAT_FLAG]
				: manifest.compatibilityFlags;
		const memoryMb = manifest.memoryMb ?? (python ? FUNCTION_PYTHON_DEFAULT_MEMORY_MB : FUNCTION_DEFAULT_MEMORY_MB);
		if (python && memoryMb < FUNCTION_PYTHON_MIN_MEMORY_MB)
			throw new ValidationError(
				`A Python function needs at least ${FUNCTION_PYTHON_MIN_MEMORY_MB} MB: Pyodide alone is about 230 MB resident (skiff.memoryMb).`,
			);
		const resolved = functionRuntimeSpecSchema.parse({
			main: manifest.main,
			modules: manifest.modules,
			compatibilityDate: manifest.compatibilityDate,
			compatibilityFlags,
			bindings,
			triggers: { crons: manifest.triggers.crons, queues },
			assets: manifest.assets ?? null,
			idleStopSeconds: manifest.idleStopSeconds ?? FUNCTION_DEFAULT_IDLE_STOP_SECONDS,
			workerdVersion: WORKERD_PINNED_VERSION,
		});
		const spec = workloadSpecSchema.parse({
			runtime: 'function',
			function: resolved,
			memoryMb,
			cpus: manifest.cpus ?? 1,
			port: 3000,
			healthPath: FUNCTION_HEALTH_PATH,
			socketActivation: true,
			ingress: 'http',
			replicas: configuredReplicas,
			// Variables live in the manifest as text/json bindings; only secret *references* go here.
			env: {},
			secrets,
		});

		// Mirror WorkloadService.setSpec without its `project:update` requirement: a deploy is
		// `deployment:create`, and the deployment itself records the resolved workload.
		const workloadJson = JSON.stringify(spec);
		this.ctx.db
			.update(projects)
			.set({ workloadJson, updatedAt: this.ctx.now() })
			.where(eq(projects.id, project.id))
			.run();
		// The deploy path holds the row it read before this call; keep it in step so the workload
		// plan later in the same deploy sees the spec just persisted.
		project.workloadJson = workloadJson;
		this.ctx.projects.bump(project.orgId);
		return resolved;
	}

	/**
	 * Resolve `triggers.queues` against the project's broker attachments (D112) and enforce one
	 * consumer per queue per broker, as on Cloudflare: two consumers on a work-queue stream would
	 * silently split its messages.
	 */
	private resolveQueueConsumers(project: ProjectRow, consumers: FunctionQueueConsumer[]): FunctionRuntimeQueueConsumer[] {
		const seen = new Set<string>();
		const resolved = consumers.map((consumer) => {
			const { broker, envPrefix } = resolveQueueBroker(this.ctx, project, consumer.broker, `Queue consumer ${consumer.queue}`);
			const key = `${broker}\n${consumer.queue}`;
			if (seen.has(key)) throw new ValidationError(`Queue ${consumer.queue} on broker ${broker} is consumed twice.`);
			seen.add(key);
			if (consumer.deadLetterQueue === consumer.queue)
				throw new ValidationError(`Queue ${consumer.queue}: the dead-letter queue must be a different queue.`);
			return { ...consumer, broker, envPrefix };
		});
		if (resolved.length === 0) return resolved;
		const others = this.ctx.db
			.select({ slug: projects.slug, workloadJson: projects.workloadJson })
			.from(projects)
			.where(and(eq(projects.orgId, project.orgId), isNull(projects.deletedAt)))
			.all()
			.filter((row) => row.slug !== project.slug);
		for (const other of others) {
			const spec = parseJson<{ function?: { triggers?: { queues?: Array<{ broker?: string; queue?: string }> } } } | null>(
				other.workloadJson,
				null,
			);
			for (const theirs of spec?.function?.triggers?.queues ?? []) {
				const clash = resolved.find((mine) => mine.broker === theirs.broker && mine.queue === theirs.queue);
				if (clash)
					throw new ConflictError(
						`Queue ${clash.queue} on broker ${clash.broker} already has a consumer: "${other.slug}". A queue has one consumer; remove it there first.`,
					);
			}
		}
		return resolved;
	}

	/**
	 * Redeploy a prebuilt Worker without `skiff-function.json`. The previous deployment's resolved
	 * spec supplies the compatibility date, bindings and assets directory; only the modules and
	 * asset bytes are taken from this upload. This keeps `skif deploy ./dist` working for projects
	 * that already deployed once, while a first deploy still uses the generated manifest.
	 */
	private async applyInferredBundle(
		principal: Principal,
		project: ProjectRow,
		entries: FileEntry[],
	): Promise<FunctionRuntimeSpec> {
		const previous = this.ctx.workloads.projectSpec(project);
		const fn = previous?.function;
		const files = entryMap(entries);
		const extensionOf = (path: string): string => {
			const match = /\.[A-Za-z0-9]+$/.exec(path);
			return match ? match[0].toLowerCase() : '';
		};
		const candidate = entries
			.map((entry) => entry.path)
			.filter((path) => !path.startsWith('node_modules/') && !path.startsWith('.git/'))
			.filter((path) => ['.js', '.mjs', '.cjs', '.wasm'].includes(extensionOf(path)));
		if (candidate.length === 0)
			throw new ValidationError(
				'No built Worker module was found in this upload. Run the build first (or keep wrangler.jsonc at the project root and use skif deploy from there).',
			);
		const preferred = ['index.js', 'index.mjs', 'worker.js', '_worker.js', 'main.js', 'main.mjs'];
		const main = fn && files.has(fn.main)
			? fn.main
			: (preferred.find((path) => files.has(path)) ??
				(candidate.length === 1 ? candidate[0]! : null));
		if (!main)
			throw new ValidationError(
				'The previous entrypoint is not in this upload and no index.js/worker.js was found; deploy from the project root with wrangler.jsonc instead.',
			);
		const modules = candidate
			.map((name) => {
				const data = files.get(name)!;
				const extension = extensionOf(name);
				return {
					name,
					type: (extension === '.wasm'
						? 'wasm'
						: extension === '.cjs'
							? 'cjs'
							: 'esm') as FunctionModule['type'],
					sha256: sha256Hex(data),
				};
			})
			.sort((a, b) => a.name.localeCompare(b.name));
		if (!modules.some((module) => module.name === main))
			throw new ValidationError(`Entrypoint "${main}" is not a built module in this upload.`);
		// A first deploy with no manifest is still accepted when the upload is an already-built
		// Worker: use conservative defaults, auto-bind the project's own secrets and serve a
		// public/ directory when one is present. Richer configuration still comes from the
		// generated manifest (or the previous deployment's spec).
		let base: WorkloadSpec;
		if (previous && fn) {
			if (fn.assets) checkAssets(fn.assets.directory, entries);
			base = previous;
		} else {
			const assetsDir = entries.some((entry) => entry.path.startsWith('public/')) ? 'public' : null;
			const secretNames = this.ctx.secrets
				.list(principal, { projectId: project.id })
				.map((secret) => secret.name);
			base = workloadSpecSchema.parse({
				runtime: 'function',
				function: {
					main,
					modules,
					compatibilityDate: FUNCTION_DEFAULT_COMPATIBILITY_DATE,
					compatibilityFlags: [],
					bindings: secretNames.map((name) => ({ name, type: 'secret' })),
					triggers: { crons: [], queues: [] },
					assets: assetsDir ? { directory: assetsDir, runWorkerFirst: [] } : null,
					idleStopSeconds: FUNCTION_DEFAULT_IDLE_STOP_SECONDS,
					workerdVersion: WORKERD_PINNED_VERSION,
				},
				memoryMb: FUNCTION_DEFAULT_MEMORY_MB,
				cpus: 1,
				port: 3000,
				healthPath: FUNCTION_HEALTH_PATH,
				socketActivation: true,
				ingress: 'http',
				replicas: 1,
				env: {},
				secrets: secretNames.map((name) => ({ name, delivery: 'env' as const })),
			});
		}
		const resolved = functionRuntimeSpecSchema.parse({
			...base.function!,
			main,
			modules,
		});
		const spec = workloadSpecSchema.parse({ ...base, function: resolved });
		const workloadJson = JSON.stringify(spec);
		this.ctx.db
			.update(projects)
			.set({ workloadJson, updatedAt: this.ctx.now() })
			.where(eq(projects.id, project.id))
			.run();
		project.workloadJson = workloadJson;
		this.ctx.projects.bump(project.orgId);
		return resolved;
	}

	/** The function view, or null when the project is not a function. */
	view(principal: Principal, project: ProjectRow): FunctionView | null {
		this.ctx.iam.require(principal, 'deployment:read', { type: 'project', id: project.id });
		// The workload row is the active deployment's snapshot (promote/rollback re-points it), so
		// read that first: the project-level spec is only what the *next* deploy would use (D17).
		const workload = this.ctx.db
			.select({ deploymentId: workloads.deploymentId, specJson: workloads.specJson })
			.from(workloads)
			.where(eq(workloads.projectId, project.id))
			.get();
		const parsed = workloadSpecSchema.safeParse(
			parseJson<unknown>(workload?.specJson ?? project.workloadJson, null),
		);
		if (!parsed.success || parsed.data.runtime !== 'function') return null;
		const spec = parsed.data.function;
		if (!spec) return null;
		return {
			projectId: project.id,
			projectSlug: project.slug,
			runtime: 'function',
			deploymentId: workload?.deploymentId ?? null,
			main: spec.main,
			moduleCount: spec.modules.length,
			compatibilityDate: spec.compatibilityDate,
			compatibilityFlags: spec.compatibilityFlags,
			bindings: spec.bindings.map((binding) => ({
				name: binding.name,
				type: binding.type,
				summary: functionBindingSummary(binding),
			})),
			triggers: {
				crons: spec.triggers.crons,
				queues: (spec.triggers.queues ?? []).map((consumer) => ({ queue: consumer.queue, broker: consumer.broker })),
			},
			assets: spec.assets,
			idleStopSeconds: spec.idleStopSeconds,
			workerdVersion: spec.workerdVersion,
		};
	}

	/**
	 * Recent invocations (tail-worker items, phase 3) for the console. Needs `logs:read`: the items
	 * carry console output. `available` is false when the telemetry store is down or absent, so
	 * the UI can say so instead of showing an empty list as if nothing ran.
	 */
	async invocations(
		principal: Principal,
		project: ProjectRow,
		query: Omit<FunctionInvocationQuery, 'projectId'>,
	): Promise<{ available: boolean; rows: FunctionInvocationRow[] }> {
		this.ctx.iam.require(principal, 'logs:read', { type: 'project', id: project.id });
		const telemetry = this.ctx.telemetry;
		if (!telemetry || !(await telemetry.ready())) return { available: false, rows: [] };
		return { available: true, rows: await telemetry.functionInvocations({ ...query, projectId: project.id }) };
	}

	/** Invocation counts by outcome over a window; same permission and availability as above. */
	async invocationSummary(
		principal: Principal,
		project: ProjectRow,
		window: { from: TimeInput; to: TimeInput },
	): Promise<{ available: boolean; summary: FunctionInvocationSummary }> {
		this.ctx.iam.require(principal, 'logs:read', { type: 'project', id: project.id });
		const telemetry = this.ctx.telemetry;
		const empty = { total: 0, byOutcome: {} };
		if (!telemetry || !(await telemetry.ready())) return { available: false, summary: empty };
		return {
			available: true,
			summary: await telemetry.functionInvocationSummary({ ...window, projectId: project.id }),
		};
	}

	/**
	 * Resolve each manifest binding against the org, in manifest order. Phase-1 kinds become runtime
	 * bindings; later phases are rejected with the phase that will serve them rather than dropped.
	 */
	private async resolveBindings(
		project: ProjectRow,
		manifestBindings: FunctionManifest['bindings'],
		manifest?: FunctionManifest,
	): Promise<{ bindings: FunctionRuntimeBinding[]; secrets: SecretRef[] }> {
		const bindings: FunctionRuntimeBinding[] = [];
		const secrets: SecretRef[] = [];
		const seenSecrets = new Set<string>();
		let cacheBindings = 0;
		for (const binding of manifestBindings) {
			if (binding.type === 'cache') {
				cacheBindings += 1;
				if (cacheBindings > 1)
					throw new ValidationError(
						'A function host can declare at most one cache binding: workerd has a single cacheApiOutbound per Worker.',
					);
			}
			switch (binding.type) {
				case 'text':
					bindings.push({ name: binding.name, type: 'text', value: binding.value });
					break;
				case 'json':
					bindings.push({ name: binding.name, type: 'json', value: binding.value });
					break;
				case 'secret': {
					const secretName = binding.secret ?? binding.name;
					if (!this.ctx.secrets.resolve(project.orgId, project.id, secretName))
						throw new ValidationError(
							`Binding ${binding.name}: secret ${secretName} does not exist for this project or the organisation.`,
						);
					bindings.push({
						name: binding.name,
						type: 'secret',
						...(binding.secret ? { secret: binding.secret } : {}),
					});
					if (!seenSecrets.has(secretName)) {
						seenSecrets.add(secretName);
						secrets.push({ name: secretName, delivery: 'env' });
					}
					break;
				}
				case 'service':
					// Same-bundle entrypoint: workerd resolves it inside the one host, no IPC to set up.
					// A binding with no entrypoint would point the Worker's default export at itself, so
					// phase 1 requires the named entrypoint the matrix promises.
					if (!binding.entrypoint)
						throw new ValidationError(
							`Binding ${binding.name}: same-project service bindings need an entrypoint (Functions phase 1).`,
						);
					bindings.push({
						name: binding.name,
						type: 'service',
						...(binding.entrypoint ? { entrypoint: binding.entrypoint } : {}),
					});
					break;
				case 'app': {
					const target = this.ctx.db
						.select()
						.from(projects)
						.where(
							and(
								eq(projects.orgId, project.orgId),
								eq(projects.slug, binding.project),
								isNull(projects.deletedAt),
							),
						)
						.get() as ProjectRow | undefined;
					if (!target)
						throw new ValidationError(
							`Binding ${binding.name}: project "${binding.project}" does not exist in this organisation.`,
						);
					if (effectiveRuntime(target) === 'static')
						throw new ValidationError(
							`Binding ${binding.name}: project "${binding.project}" is static; it has no workload to reach.`,
						);
					const workload = this.ctx.workloads.view(target);
					if (!workload?.upstream)
						throw new ValidationError(
							`Binding ${binding.name}: project "${binding.project}" has no workload yet; deploy it first.`,
						);
					bindings.push({
						name: binding.name,
						type: 'app',
						project: binding.project,
						...(binding.entrypoint ? { entrypoint: binding.entrypoint } : {}),
						upstream: workload.upstream,
					});
					break;
				}
				case 'durable_object':
				case 'hyperdrive':
				case 'kv':
				case 'cache':
				case 'r2':
				case 'd1':
				case 'queue':
				case 'analytics_engine':
				case 'assets': {
					if (binding.type === 'assets' && !manifest?.assets?.directory)
						throw new ValidationError(
							`Binding ${binding.name}: an assets binding needs the manifest's assets directory.`,
						);
					// Phase-2 bindings. The resolver proves the backing resource and returns no secret
					// values; Hyperdrive credentials come from the activation env, KV/Cache are
					// node-local Durable Object storage.
					const resolver = bindingResolver(binding.type);
					if (!resolver)
						throw new ValidationError(
							`Binding ${binding.name}: ${binding.type} bindings are not supported by this Skiff build yet.`,
						);
					bindings.push(await resolver({ core: this.ctx, project }, binding));
					break;
				}
				default: {
					// Every manifest type is handled above; this only catches a caller bypassing the
					// contract with a type this build does not know.
					const unknown = binding as unknown as { name: string; type: string };
					throw new ValidationError(
						`Binding ${unknown.name}: ${unknown.type} is not a supported function binding.`,
					);
				}
			}
		}
		return { bindings, secrets };
	}
}

/** Parse and schema-check `skiff-function.json`, naming the file and the first few bad fields. */
function parseManifest(data: Uint8Array): FunctionManifest {
	let raw: unknown;
	try {
		raw = JSON.parse(new TextDecoder().decode(data)) as unknown;
	} catch {
		throw new ValidationError(`${FUNCTION_MANIFEST_FILE} is not valid JSON.`);
	}
	const parsed = functionManifestSchema.safeParse(raw);
	if (parsed.success) return parsed.data;
	const issues = parsed.error.issues.map(
		(issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`,
	);
	const shown = issues.slice(0, 5).join('; ');
	throw new ValidationError(
		`Invalid ${FUNCTION_MANIFEST_FILE}: ${shown}${issues.length > 5 ? ` (and ${issues.length - 5} more)` : ''}`,
		issues,
	);
}

/**
 * A served assets directory must hold files, must not be the bundle root (that would publish the
 * worker source) and must never contain the manifest itself.
 */
function checkAssets(directory: string, entries: FileEntry[]): void {
	if (directory === '.' || directory === '')
		throw new ValidationError(
			`Assets directory "${directory}" cannot be the bundle root; it would expose the worker source.`,
		);
	const prefix = `${directory}/`;
	if (!entries.some((entry) => entry.path.startsWith(prefix)))
		throw new ValidationError(`Assets directory "${directory}" has no files in this bundle.`);
	if (
		entries.some(
			(entry) =>
				entry.path === `${prefix}${FUNCTION_MANIFEST_FILE}` ||
				entry.path.startsWith(`${prefix}${FUNCTION_MANIFEST_FILE}/`),
		)
	)
		throw new ValidationError(
			`Assets directory "${directory}" contains ${FUNCTION_MANIFEST_FILE}; keep the worker source out of the served directory.`,
		);
}
