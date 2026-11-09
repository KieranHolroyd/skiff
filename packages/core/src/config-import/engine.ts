import type {
	ConfigImportManual,
	ConfigImportStatus,
	ConfigImportStep,
	ConfigImportView,
} from '@skiff/contracts';
import { CoreError } from '../errors.ts';

/**
 * The plan/apply machinery behind config import (docs/OPERATIONS.md §14). Section planners add
 * steps in dependency order; each `create` step carries the closure that makes it. Apply runs the
 * steps in order, and a step whose dependency failed (or was skipped) is skipped too, so one
 * broken project never stops the rest of the migration.
 */

export interface PlannedStep extends ConfigImportStep {
	run?: () => unknown | Promise<unknown>;
}

export class ImportPlan {
	readonly steps: PlannedStep[] = [];
	readonly manual: ConfigImportManual[] = [];
	readonly warnings: string[] = [];
	readonly #byKey = new Map<string, PlannedStep>();

	/** A resource that will be created on apply. */
	create(step: { key: string; section: string; kind: string; name: string; dependsOn?: (string | null | undefined)[] }, run: () => unknown | Promise<unknown>): void {
		this.#add({ ...step, action: 'create', status: 'planned', reason: null, run });
	}

	/** A resource that is already here under the same name; it is left exactly as it is. */
	exists(step: { key: string; section: string; kind: string; name: string }, reason = 'already exists; left as it is'): void {
		this.#add({ ...step, action: 'exists', status: 'exists', reason });
	}

	/** Something in the file the importer will not touch, with the reason. */
	skip(step: { key: string; section: string; kind: string; name: string }, reason: string): void {
		this.#add({ ...step, action: 'skip', status: 'skipped', reason });
	}

	manualStep(section: string, item: string, what: string): void {
		this.manual.push({ section, item, what });
	}

	has(key: string): boolean {
		return this.#byKey.has(key);
	}

	/** True when the key exists already or will be created by this plan. */
	available(key: string): boolean {
		const step = this.#byKey.get(key);
		return step !== undefined && (step.action === 'create' || step.action === 'exists');
	}

	#add(step: Omit<PlannedStep, 'dependsOn'> & { dependsOn?: (string | null | undefined)[] }): void {
		if (this.#byKey.has(step.key)) return;
		const dependsOn = (step.dependsOn ?? []).filter((key): key is string => typeof key === 'string' && key.length > 0);
		const full: PlannedStep = { ...step, dependsOn };
		this.steps.push(full);
		this.#byKey.set(step.key, full);
	}

	get(key: string): PlannedStep | undefined {
		return this.#byKey.get(key);
	}
}

/** Run every `create` step in order. Never throws for a failed step; the view says what happened. */
export async function runPlan(plan: ImportPlan): Promise<void> {
	for (const step of plan.steps) {
		if (step.action !== 'create' || !step.run) continue;
		const blocker = step.dependsOn
			.map((key) => plan.get(key))
			.find((dep) => dep !== undefined && (dep.status === 'failed' || dep.status === 'skipped' || dep.status === 'planned'));
		if (blocker) {
			step.status = 'skipped';
			step.reason = `${blocker.key} ${blocker.status === 'failed' ? 'failed' : 'was not created'}`;
			continue;
		}
		try {
			await step.run();
			step.status = 'done';
		} catch (error) {
			step.status = 'failed';
			step.reason = errorMessage(error);
		}
	}
}

export function errorMessage(error: unknown): string {
	if (error instanceof CoreError) return error.message;
	if (error && typeof error === 'object' && 'issues' in error && Array.isArray((error as { issues: unknown[] }).issues)) {
		// A zod error from a create schema: name the fields.
		const issues = (error as { issues: { path?: unknown[]; message?: string }[] }).issues;
		return issues.map((issue) => `${(issue.path ?? []).join('.') || 'input'}: ${issue.message ?? 'invalid'}`).join('; ');
	}
	return error instanceof Error ? error.message : String(error);
}

export function viewOf(plan: ImportPlan, mode: 'plan' | 'apply', source: ConfigImportView['source']): ConfigImportView {
	const summary = { planned: 0, done: 0, exists: 0, skipped: 0, failed: 0 } satisfies Record<ConfigImportStatus, number>;
	for (const step of plan.steps) summary[step.status] += 1;
	return {
		mode,
		source,
		steps: plan.steps.map(({ run: _run, ...step }) => step),
		manual: plan.manual,
		warnings: plan.warnings,
		summary,
	};
}
