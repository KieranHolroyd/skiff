import { fail, type ActionFailure } from '@sveltejs/kit';
import { core } from '#lib/server/core.js';
import { failStatus, toFormFailure } from '../../routes/(dashboard)/_lib/errors.js';
import { json } from '#lib/server/api.js';
import { nodeTaskLimits, type NodeTaskKind, type NodeTaskView, type Principal } from '@yoal/contracts';

/**
 * Answer a node task (D124) over REST: wait up to `?wait=` seconds (default 20) for the node's
 * result, then 200 with the task when it succeeded, 502 when the node reported a failure, or 202
 * with a `location` to poll while it is still running.
 */
export async function nodeTaskResponse<K extends NodeTaskKind>(
	principal: Principal,
	task: NodeTaskView<K>,
	url: URL
): Promise<Response> {
	const raw = url.searchParams.get('wait');
	const seconds = raw === null ? nodeTaskLimits.waitMs / 1000 : Math.min(Math.max(Number(raw) || 0, 0), 25);
	const done = await core.nodeTasks.wait(principal, task, seconds * 1000);
	const location = `/api/v1/node-tasks/${encodeURIComponent(done.id)}`;
	if (done.status === 'succeeded') return json({ task: done });
	if (done.status === 'failed')
		return json({ error: 'node_task_failed', message: done.error ?? 'The task failed.', task: done }, 502);
	return json({ task: done }, 202, { location });
}

/**
 * Run a node task from a dashboard form action: queue it, wait for the node, and return
 * `{ task }` (the client polls when it is still running) or a form failure with the reason.
 * `success` turns a finished task into the standard toast payload.
 */
export async function nodeTaskAction<K extends NodeTaskKind>(
	principal: Principal,
	start: () => NodeTaskView<K>,
	success?: (task: NodeTaskView<K>) => string
): Promise<{ task: NodeTaskView<K>; success?: string } | ActionFailure<{ message: string }>> {
	let task: NodeTaskView<K>;
	try {
		task = await core.nodeTasks.wait(principal, start());
	} catch (caught) {
		return fail(failStatus(caught), toFormFailure(caught));
	}
	if (task.status === 'failed') return fail(502, { message: task.error ?? 'The node could not run that.' });
	return task.status === 'succeeded' && success ? { task, success: success(task) } : { task };
}
