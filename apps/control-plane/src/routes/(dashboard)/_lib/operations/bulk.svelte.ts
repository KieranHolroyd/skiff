import {
	isTerminalOperation,
	operationActions,
	type OperationActionInfo,
	type OperationItemView,
	type OperationView
} from '@skiff/contracts';
import { toast } from 'svelte-sonner';
import {
	applyOperation,
	cancelOperation,
	createOperation,
	errorMessage,
	listItems,
	streamOperation,
	waitForPlan
} from './client.js';
import { countLabel } from './copy.js';

export interface BulkPlan {
	info: OperationActionInfo;
	operation: OperationView;
	items: OperationItemView[];
}

export interface BulkRun {
	info: OperationActionInfo;
	operation: OperationView;
	failures: OperationItemView[];
}

/** Past-tense result lines for the toast once a bulk action finishes. */
const doneText: Partial<Record<OperationActionInfo['id'], (n: number) => string>> = {
	'project.delete': (n) => `Moved ${countLabel(n)} to the trash.`,
	'project.restore': (n) => `Restored ${countLabel(n)}.`,
	'project.purge': (n) => `Permanently deleted ${countLabel(n)}.`
};

/**
 * Drives a bulk action through plan → confirm → apply → result (docs/OPERATIONS.md §2.1, §6.4).
 * The confirm dialog is built from the server's plan, never from what the client guessed.
 */
export class BulkController {
	/** Action id while its plan is being created. */
	planning = $state<string | null>(null);
	plan = $state<BulkPlan | null>(null);
	run = $state<BulkRun | null>(null);
	private closeStream: (() => void) | null = null;

	constructor(
		private readonly options: {
			/** Can the viewer restore projects (offers Undo after a delete)? */
			canUndo: () => boolean;
			/** Refresh page data after a run settles. */
			onSettled: () => Promise<void> | void;
			/** Link to an operation's detail page, for failure toasts. */
			detailHref: (id: string) => string;
			navigate: (href: string) => void;
			/** Called once a plan is applied (e.g. to clear the selection). */
			onApplied?: () => void;
		}
	) {}

	get busy(): boolean {
		return this.planning !== null || this.plan !== null || this.run !== null;
	}

	async start(info: OperationActionInfo, targets: string[]): Promise<void> {
		if (this.busy || targets.length === 0) return;
		this.planning = info.id;
		try {
			let operation = await createOperation({ action: info.id, targets, stage: 'plan' }, 10);
			if (operation.status !== 'planned' && !isTerminalOperation(operation.status))
				operation = await waitForPlan(operation.id);
			if (operation.status !== 'planned') {
				toast.error(`Could not plan that (${operation.status}).`, {
					description: operation.phase ?? undefined
				});
				return;
			}
			const page = await listItems(operation.id, { limit: 1000 });
			this.plan = { info, operation: page.operation, items: page.items };
		} catch (error) {
			toast.error(errorMessage(error));
		} finally {
			this.planning = null;
		}
	}

	/** Close the confirm dialog without applying; the plan is cancelled on the server. */
	dismiss(): void {
		const plan = this.plan;
		this.plan = null;
		if (plan) void cancelOperation(plan.operation.id).catch(() => undefined);
	}

	async confirm(): Promise<boolean> {
		const plan = this.plan;
		if (!plan) return false;
		try {
			const operation = await applyOperation(plan.operation.id);
			this.plan = null;
			this.options.onApplied?.();
			this.follow(plan.info, operation);
			return true;
		} catch (error) {
			toast.error(errorMessage(error));
			return false;
		}
	}

	/** Show progress for a running operation until it finishes. */
	follow(info: OperationActionInfo, operation: OperationView): void {
		this.closeStream?.();
		this.run = { info, operation, failures: [] };
		if (isTerminalOperation(operation.status)) {
			void this.finish(operation);
			return;
		}
		this.closeStream = streamOperation(
			operation.id,
			{
				onProgress: (next) => {
					if (this.run?.operation.id === next.id) this.run.operation = next;
				},
				onItems: (items) => {
					if (!this.run) return;
					const failed = items.filter((item) => item.status === 'failed');
					if (failed.length) this.run.failures = [...this.run.failures, ...failed];
				},
				onDone: (next) => void this.finish(next),
				onError: (message) => {
					toast.error(message);
					this.run = null;
					void this.options.onSettled();
				}
			},
			{ untilDone: true }
		);
	}

	destroy(): void {
		this.closeStream?.();
		this.closeStream = null;
	}

	private async finish(operation: OperationView): Promise<void> {
		const run = this.run;
		this.closeStream = null;
		this.run = null;
		await this.options.onSettled();
		if (!run) return;
		const info = run.info;
		const succeeded = operation.summary.statuses.succeeded;
		const failed = operation.summary.statuses.failed;
		const text =
			doneText[info.id]?.(succeeded) ?? `${info.verb}: ${countLabel(succeeded, 'item')} done.`;
		const firstFailure = run.failures[0];
		const failureLine = failed
			? `${failed} failed${firstFailure ? ` — ${firstFailure.label ?? firstFailure.targetId}: ${firstFailure.error ?? 'unknown error'}` : ''}.`
			: undefined;
		const undo =
			info.id === 'project.delete' && succeeded > 0 && this.options.canUndo()
				? { label: 'Undo', onClick: () => void this.undo(operation.id) }
				: undefined;
		const details = {
			label: 'Details',
			onClick: () => this.options.navigate(this.options.detailHref(operation.id))
		};

		if (operation.status === 'succeeded')
			toast.success(succeeded ? text : 'Nothing needed changing.', {
				action: undo,
				duration: undo ? 10_000 : undefined
			});
		else if (operation.status === 'partial')
			toast.warning(text, { description: failureLine, action: undo ?? details, duration: 10_000 });
		else if (operation.status === 'cancelled')
			toast.message(`Stopped. ${countLabel(succeeded)} finished before it was cancelled.`, {
				action: undo
			});
		else toast.error(`${info.label} failed.`, { description: failureLine, action: details });
	}

	/** Restore exactly the projects a delete operation moved to the trash. */
	private async undo(deleteId: string): Promise<void> {
		if (this.busy) {
			toast.error('Wait for the current action to finish, then try again.');
			return;
		}
		try {
			const page = await listItems(deleteId, { status: 'succeeded', limit: 1000 });
			const targets = page.items.map((item) => item.targetId);
			if (!targets.length) return;
			const operation = await createOperation(
				{ action: 'project.restore', targets, stage: 'apply' },
				0
			);
			this.follow(operationActions['project.restore'], operation);
		} catch (error) {
			toast.error(errorMessage(error));
		}
	}
}
