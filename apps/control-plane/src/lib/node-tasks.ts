import { invalidateAll } from '$app/navigation';
import { toast } from 'svelte-sonner';
import { nodeTaskDone, type NodeTaskKind, type NodeTaskView } from '@yoal/contracts';
import { fetchJson } from '#lib/query.js';
import { runAction } from '#lib/actions.js';

/**
 * Run a node-task form action (D124) and resolve with the finished task, or null when it failed
 * (the reason is toasted). The action waits up to 20 s on the server; a slower node is polled here.
 */
export async function runNodeTask<K extends NodeTaskKind>(
	action: string,
	fields: Record<string, string>,
	options: { refresh?: boolean } = {}
): Promise<NodeTaskView<K> | null> {
	const outcome = await runAction(action, fields, { apply: false });
	if (outcome.type !== 'success') return null;
	let task = (outcome.data as { task?: NodeTaskView<K> } | undefined)?.task ?? null;
	const deadline = Date.now() + 2 * 60_000;
	while (task && !nodeTaskDone(task) && Date.now() < deadline) {
		try {
			task = (await fetchJson<{ task: NodeTaskView<K> }>(`/api/v1/node-tasks/${encodeURIComponent(task.id)}?wait=20`)).task;
		} catch (caught) {
			toast.error(caught instanceof Error ? caught.message : 'Lost track of the task.');
			return null;
		}
	}
	if (!task || !nodeTaskDone(task)) {
		toast.error('The node has not answered yet. Check back in a moment.');
		return null;
	}
	if (task.status === 'failed') {
		toast.error(task.error ?? 'The node could not run that.');
		return null;
	}
	if (options.refresh) await invalidateAll();
	return task;
}
