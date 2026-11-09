import {
	PIPELINE_WORKFLOW_DIR,
	PipelineWorkflowError,
	type PipelineJobSpec,
	type PipelineWorkflow,
	type PipelineWorkflowCall,
	type TemplateMap,
} from '@yoal/contracts';

/**
 * Reusable workflows (docs/PIPELINES.md WP4). A job with `uses: ./.yoal/workflows/x.yml` is
 * replaced, when the run is created, by the called workflow's jobs under keys `<caller>--<callee>`.
 * The caller key stays addressable: `needs: caller` waits for every inlined job, and
 * `needs.caller.outputs.*` comes from the callee's `on.workflow_call.outputs`, evaluated over the
 * callee's `jobs` context. That keeps the engine's DAG flat: nothing new to claim or schedule.
 */

/** Calls GitHub allows nested (a caller of a caller of …). */
const MAX_DEPTH = 4;

export interface PipelineCallInfo {
	/** Inlined job keys that make up this call (all levels). */
	jobs: string[];
	/** Inlined key → the callee's own job key, for the `jobs` context of the outputs. */
	keyMap: Record<string, string>;
	/** `on.workflow_call.outputs.<name>.value` templates over `jobs.<callee key>`. */
	outputs: Record<string, string>;
	/** The callee's declared inputs, for coercing `with:` at expansion. */
	inputs: PipelineWorkflowCall['inputs'];
	path: string;
}

/** Extra fields the engine keeps on inlined job specs (stored in `spec_json`, never sent as is). */
export interface InlinedJobSpec extends PipelineJobSpec {
	/** The caller's raw `with:` templates; evaluated against the caller's context at expansion. */
	callWith?: TemplateMap;
	/** The caller key this job was inlined for (innermost). */
	callKey?: string;
	/** `inherit`, or inlined secret name → caller secret name. Absent = no secrets (GitHub). */
	callSecretMap?: 'inherit' | Record<string, string>;
}

export interface WorkflowWithCalls extends PipelineWorkflow {
	calls?: Record<string, PipelineCallInfo>;
}

function stripWrap(expression: string | null): string | null {
	if (!expression) return null;
	const match = /^\s*\$\{\{([\s\S]*)\}\}\s*$/.exec(expression);
	return (match ? match[1]! : expression).trim() || null;
}

/** `./.yoal/workflows/x.yml` → `.yoal/workflows/x.yml`; anything else is unsupported. */
export function localWorkflowPath(uses: string): string | null {
	const match = /^\.\/(.+)$/.exec(uses.trim());
	if (!match) return null;
	const path = match[1]!.replace(/\/+/g, '/');
	if (!path.startsWith(`${PIPELINE_WORKFLOW_DIR}/`) || path.split('/').includes('..')) return null;
	return path;
}

/**
 * `secrets:` of a call → how the callee's secrets map onto the caller's. A map entry must be a
 * plain `${{ secrets.NAME }}` reference: secret values never pass through the engine.
 */
export function callSecretMap(secrets: PipelineJobSpec['secrets']): 'inherit' | Record<string, string> {
	if (secrets === 'inherit') return 'inherit';
	const out: Record<string, string> = {};
	for (const [name, template] of Object.entries(secrets ?? {})) {
		const match = /^\s*\$\{\{\s*secrets\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}\s*$/.exec(template);
		if (!match) throw new PipelineWorkflowError([{ path: `secrets.${name}`, message: 'Pass a secret as `${{ secrets.NAME }}` only' }]);
		out[name] = match[1]!;
	}
	return out;
}

/** Compose an outer secret map with an inner one (a callee that calls again). */
function composeSecrets(
	outer: 'inherit' | Record<string, string> | undefined,
	inner: 'inherit' | Record<string, string>,
): 'inherit' | Record<string, string> {
	if (outer === undefined) return {};
	if (inner === 'inherit') return outer;
	if (outer === 'inherit') return inner;
	return Object.fromEntries(
		Object.entries(inner).flatMap(([name, source]) => (outer[source] ? [[name, outer[source]!]] : [])),
	);
}

/**
 * Replace every reusable-workflow call in `workflow` with the called jobs. `files` maps workflow
 * paths at the run's commit to their parsed workflows. Throws `PipelineWorkflowError` for a
 * missing file, a callee without `on.workflow_call`, a matrix on a caller, or a cycle.
 */
export function inlineWorkflowCalls(workflow: PipelineWorkflow, files: Map<string, PipelineWorkflow>): WorkflowWithCalls {
	if (!Object.values(workflow.jobs).some((job) => job.uses)) return workflow;
	const calls: Record<string, PipelineCallInfo> = {};

	const expandJobs = (
		jobs: Record<string, PipelineJobSpec>,
		prefix: string,
		depth: number,
		stack: string[],
	): Record<string, InlinedJobSpec> => {
		const out: Record<string, InlinedJobSpec> = {};
		for (const job of Object.values(jobs)) {
			const key = `${prefix}${job.key}`;
			if (!job.uses) {
				out[key] = { ...job, key, needs: job.needs.map((need) => `${prefix}${need}`) };
				continue;
			}
			const where = `jobs.${key}.uses`;
			if (depth >= MAX_DEPTH)
				throw new PipelineWorkflowError([{ path: where, message: `Reusable workflows nest at most ${MAX_DEPTH} levels` }]);
			const path = localWorkflowPath(job.uses);
			if (!path)
				throw new PipelineWorkflowError([
					{ path: where, message: `Only local reusable workflows (./${PIPELINE_WORKFLOW_DIR}/<file>.yml) are supported` },
				]);
			if (stack.includes(path))
				throw new PipelineWorkflowError([{ path: where, message: `Reusable workflow cycle: ${[...stack, path].join(' → ')}` }]);
			const callee = files.get(path);
			if (!callee) throw new PipelineWorkflowError([{ path: where, message: `${path} does not exist at this commit` }]);
			if (!callee.on.workflowCall)
				throw new PipelineWorkflowError([{ path: where, message: `${path} has no on.workflow_call trigger` }]);
			if (job.strategy.matrix)
				throw new PipelineWorkflowError([{ path: `jobs.${key}.strategy`, message: 'A matrix on a reusable-workflow call is not supported yet' }]);

			const inner = expandJobs(callee.jobs, `${key}--`, depth + 1, [...stack, path]);
			const secrets = callSecretMap(job.secrets ?? null);
			const callerIf = stripWrap(job.if);
			const needs = job.needs.map((need) => `${prefix}${need}`);
			const innerKeys = Object.keys(inner);
			for (const [innerKey, spec] of Object.entries(inner)) {
				// Every inlined job also waits for the caller's needs, so `with:` (which may read
				// `needs.*` of the caller) can be evaluated wherever it is expanded.
				const isRoot = spec.needs.every((need) => !innerKeys.includes(need));
				const ownIf = stripWrap(spec.if);
				out[innerKey] = {
					...spec,
					name: `${job.name} / ${spec.name}`,
					needs: [...new Set([...spec.needs, ...needs])],
					if: isRoot && callerIf ? `(${callerIf}) && (${ownIf ?? 'success()'})` : spec.if,
					// The innermost call decides `inputs`; secrets compose outwards.
					callWith: spec.callKey ? spec.callWith : (job.with ?? {}),
					callKey: spec.callKey ?? key,
					callSecretMap: spec.callKey ? composeSecrets(secrets, spec.callSecretMap ?? {}) : secrets,
					concurrency: spec.concurrency ?? job.concurrency,
				};
			}
			calls[key] = {
				jobs: innerKeys,
				keyMap: Object.fromEntries(innerKeys.filter((k) => !k.slice(key.length + 2).includes('--')).map((k) => [k, k.slice(key.length + 2)])),
				outputs: Object.fromEntries(Object.entries(callee.on.workflowCall.outputs).map(([name, output]) => [name, output.value])),
				inputs: callee.on.workflowCall.inputs,
				path,
			};
		}
		return out;
	};

	const jobs = expandJobs(workflow.jobs, '', 0, [workflow.path]);
	return { ...workflow, jobs, calls };
}
